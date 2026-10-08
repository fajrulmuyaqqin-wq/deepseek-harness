/**
 * Dedicated Worker Thread Entrypoint (Layer 1, Layer 3 & Layer 4 Safeguards).
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/worker/worker-entry
 */

import { parentPort } from 'node:worker_threads'
import { MultimodalEmbedder } from './embedder.ts'
import type { WorkerRequest, WorkerResponse } from './types.ts'

if (!parentPort) {
  throw new Error('worker-entry must be executed within a Node.js Worker Thread')
}

const embedder = new MultimodalEmbedder(2)

// Layer 3: Sequential FIFO Task Queue
let processing = false
const taskQueue: Array<WorkerRequest> = []

function postResponse(res: WorkerResponse): void {
  if (!parentPort) return
  if (res.ok && res.vector && res.vector.buffer instanceof ArrayBuffer) {
    // Zero-Copy transferable ArrayBuffer transfer
    parentPort.postMessage(res, [res.vector.buffer])
  } else {
    parentPort.postMessage(res)
  }
}

async function processNext(): Promise<void> {
  if (processing || taskQueue.length === 0) return
  const req = taskQueue.shift()
  if (req === undefined) {
    processing = false
    return
  }

  try {
    switch (req.kind) {
      case 'configure': {
        embedder.configure(req.threads, req.modelPath)
        postResponse({
          id: req.id,
          ok: true,
          vector: new Float32Array(0),
        })
        break
      }

      case 'embed-text': {
        const vector = await embedder.embedText(req.text)
        postResponse({
          id: req.id,
          ok: true,
          vector,
        })
        break
      }

      case 'embed-image': {
        const result = await embedder.embedImage(req.imageBuffer, req.maxDim)
        postResponse({
          id: req.id,
          ok: true,
          vector: result.vector,
          semanticHints: result.semanticHints,
          meta: { width: result.width, height: result.height },
        })
        break
      }

      case 'embed-audio': {
        const result = await embedder.embedAudio(req.audioBuffer, req.maxDurationSec)
        postResponse({
          id: req.id,
          ok: true,
          vector: result.vector,
          semanticHints: [result.intentHint],
          meta: { durationSec: result.durationSec },
        })
        break
      }

      case 'rerank': {
        const rerankResults = await embedder.rerank(req.query, req.candidates)
        postResponse({
          id: req.id,
          ok: true,
          rerankResults,
        })
        break
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    postResponse({
      id: req.id,
      ok: false,
      error: message,
    })
  } finally {
    processing = false
    setImmediate(() => {
      void processNext()
    })
  }
}

parentPort.on('message', (req: WorkerRequest) => {
  taskQueue.push(req)
  void processNext()
})
