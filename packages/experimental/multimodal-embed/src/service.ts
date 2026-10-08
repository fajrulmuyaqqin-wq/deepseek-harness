/**
 * MultimodalEmbedService implementation managing Worker Thread and SQLite vector memory.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/service
 */

import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  MultimodalEmbedService,
  MemoryItem,
  ImageHintResult,
  AudioHintResult,
} from './types.ts'
import type { MultimodalEmbedConfig } from './config.ts'
import type { WorkerRequest, WorkerResponse } from './worker/types.ts'
import { MultimodalEmbedder, cosineSimilarity } from './worker/embedder.ts'
import { VectorDatabase } from './worker/vector-db.ts'

export class MultimodalEmbeddingService extends Service implements MultimodalEmbedService {
  private readonly config: MultimodalEmbedConfig
  private worker: Worker | undefined = undefined
  private localFallback = new MultimodalEmbedder(2)
  private db: VectorDatabase
  private requestId = 0
  private readonly pendingRequests = new Map<
    number,
    {
      resolve: (res: WorkerResponse) => void
      reject: (err: Error) => void
      timer: NodeJS.Timeout
    }
  >()

  constructor(ctx: Context, config: MultimodalEmbedConfig) {
    super(ctx, 'multimodalEmbed')
    this.config = config
    this.localFallback.configure(config.maxCpuThreads, config.modelPath)
    this.db = new VectorDatabase(config.databasePath ?? ':memory:')
    this.initWorker()

    // Dispose worker and close DB on plugin teardown
    ctx.effect(() => () => {
      this.teardown()
    })
  }

  private initWorker(): void {
    try {
      const workerUrl = new URL('./worker/worker-entry.ts', import.meta.url)
      const workerPath = fileURLToPath(workerUrl)
      if (!existsSync(workerPath)) {
        this.worker = undefined
        return
      }
      this.worker = new Worker(workerPath)

      this.worker.on('message', (res: WorkerResponse) => {
        const pending = this.pendingRequests.get(res.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingRequests.delete(res.id)
        pending.resolve(res)
      })

      this.worker.on('error', (err) => {
        this.ctx.logger.warn(`multimodal-embed worker error: ${err.message}`)
        this.worker = undefined
      })

      // Send initial configuration
      this.sendWorkerRequest({
        id: ++this.requestId,
        kind: 'configure',
        threads: this.config.maxCpuThreads,
        modelPath: this.config.modelPath,
      }).catch(() => {
        // Ignored during startup handshake
      })
    } catch {
      this.worker = undefined
    }
  }

  private sendWorkerRequest(req: WorkerRequest, signal?: AbortSignal): Promise<WorkerResponse> {
    const worker = this.worker
    if (!worker) {
      // In-process fallback if worker threads cannot spawn
      return this.executeInProcessFallback(req)
    }

    if (signal?.aborted) {
      return Promise.reject(new Error('Operation aborted by signal'))
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(req.id)
        reject(new Error(`Multimodal worker timeout after ${this.config.watchdogTimeoutMs}ms`))
      }, this.config.watchdogTimeoutMs)

      const onAbort = () => {
        clearTimeout(timer)
        this.pendingRequests.delete(req.id)
        reject(new Error('Operation aborted by signal'))
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      this.pendingRequests.set(req.id, {
        resolve: (res) => {
          if (signal) signal.removeEventListener('abort', onAbort)
          resolve(res)
        },
        reject: (err) => {
          if (signal) signal.removeEventListener('abort', onAbort)
          reject(err)
        },
        timer,
      })

      worker.postMessage(req)
    })
  }

  private async executeInProcessFallback(req: WorkerRequest): Promise<WorkerResponse> {
    switch (req.kind) {
      case 'configure':
        return { id: req.id, ok: true, vector: new Float32Array(0) }
      case 'embed-text': {
        const vector = await this.localFallback.embedText(req.text)
        return { id: req.id, ok: true, vector }
      }
      case 'embed-image': {
        const result = await this.localFallback.embedImage(req.imageBuffer, req.maxDim)
        return {
          id: req.id,
          ok: true,
          vector: result.vector,
          semanticHints: result.semanticHints,
          meta: { width: result.width, height: result.height },
        }
      }
      case 'embed-audio': {
        const result = await this.localFallback.embedAudio(req.audioBuffer, req.maxDurationSec)
        return {
          id: req.id,
          ok: true,
          vector: result.vector,
          semanticHints: [result.intentHint],
          meta: { durationSec: result.durationSec },
        }
      }
    }
  }

  async embedText(text: string, signal?: AbortSignal): Promise<Float32Array> {
    const id = ++this.requestId
    const res = await this.sendWorkerRequest({ id, kind: 'embed-text', text }, signal)
    if (!res.ok) throw new Error(res.error)
    return res.vector
  }

  async embedImage(imageBuffer: Uint8Array, signal?: AbortSignal): Promise<ImageHintResult> {
    const id = ++this.requestId
    const res = await this.sendWorkerRequest(
      { id, kind: 'embed-image', imageBuffer, maxDim: this.config.maxImageDimension },
      signal,
    )
    if (!res.ok) throw new Error(res.error)
    return {
      vector: res.vector,
      semanticHints: res.semanticHints ?? [],
      width: (res.meta?.width as number) ?? this.config.maxImageDimension,
      height: (res.meta?.height as number) ?? this.config.maxImageDimension,
    }
  }

  async embedAudio(audioBuffer: Uint8Array, signal?: AbortSignal): Promise<AudioHintResult> {
    const id = ++this.requestId
    const res = await this.sendWorkerRequest(
      { id, kind: 'embed-audio', audioBuffer, maxDurationSec: this.config.maxAudioDurationSec },
      signal,
    )
    if (!res.ok) throw new Error(res.error)
    return {
      vector: res.vector,
      intentHint: res.semanticHints?.[0] ?? 'voice-audio',
      durationSec: (res.meta?.durationSec as number) ?? 0,
    }
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    return cosineSimilarity(a, b)
  }

  async saveEntry(
    category: MemoryItem['category'],
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const vector = await this.embedText(content)
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this.db.save(id, category, content, vector, metadata)
    return id
  }

  async searchSimilar(
    queryVector: Float32Array,
    limit = this.config.maxRetrievalItems,
    threshold = this.config.similarityThreshold,
  ): Promise<MemoryItem[]> {
    return this.db.search(queryVector, limit, threshold)
  }

  teardown(): void {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer)
      req.reject(new Error('Multimodal embed service disposed'))
      this.pendingRequests.delete(id)
    }
    if (this.worker) {
      this.worker.terminate().catch(() => {})
      this.worker = undefined
    }
    this.db.close()
  }
}
