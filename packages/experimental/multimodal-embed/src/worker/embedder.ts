/**
 * Multimodal & Neural Embedding Runtime with Thread Clamping (Layer 2 Safeguard).
 * Supports local ONNX INT8 EmbeddingGemma-2 with automatic fallback to fast feature hashing.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/worker/embedder
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { clampText, preprocessImage, preprocessAudio } from './preprocessor.ts'

export const EMBEDDING_DIMENSION = 768

interface OrtModule {
  InferenceSession: {
    create: (path: string, options: Record<string, unknown>) => Promise<{
      run: (feeds: Record<string, unknown>) => Promise<{
        sentence_embedding?: { data?: Float32Array | number[] }
      }>
    }>
  }
  Tensor: new (type: string, data: unknown, dims?: readonly number[]) => unknown
}

interface TokenizerOutput {
  input_ids: { data: Array<number | bigint | string>; dims: number[] }
  attention_mask: { data: Array<number | bigint | string>; dims: number[] }
}

/** Normalize vector to unit length (L2 norm) so dot product equals cosine similarity. */
export function normalizeVector(v: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < v.length; i++) {
    const val = v[i] ?? 0
    norm += val * val
  }
  norm = Math.sqrt(norm)
  if (norm < 1e-9) return v
  const inv = 1 / norm
  for (let i = 0; i < v.length; i++) {
    v[i] = (v[i] ?? 0) * inv
  }
  return v
}

/** Compute cosine similarity between two unit-normalized vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0)
  }
  return Math.max(-1, Math.min(1, dot))
}

export class MultimodalEmbedder {
  private maxThreads: number
  private modelPath: string | undefined
  private isLoaded = false
  private ortInstance: OrtModule | null = null
  private session: {
    run: (feeds: Record<string, unknown>) => Promise<{
      sentence_embedding?: { data?: Float32Array | number[] }
    }>
  } | null = null
  private tokenizer: ((text: string) => Promise<TokenizerOutput>) | null = null
  private initPromise: Promise<boolean> | null = null

  constructor(maxThreads = 2, modelPath?: string | undefined) {
    this.maxThreads = maxThreads
    this.modelPath = modelPath
  }

  get threads(): number {
    return this.maxThreads
  }

  get loaded(): boolean {
    return this.isLoaded
  }

  get isNeuralActive(): boolean {
    return this.session !== null && this.tokenizer !== null
  }

  get configuredModelPath(): string | undefined {
    return this.modelPath
  }

  /** Configure runtime parameters (Thread Clamping). */
  configure(threads: number, modelPath?: string | undefined): void {
    this.maxThreads = Math.max(1, Math.min(4, threads))
    if (modelPath !== undefined) {
      this.modelPath = modelPath
      this.session = null
      this.tokenizer = null
      this.initPromise = null
    }
    this.isLoaded = true
  }

  /** Ensure neural model and tokenizer are initialized if weights exist locally. */
  private async ensureNeuralInit(): Promise<boolean> {
    if (this.session && this.tokenizer) return true
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      try {
        const resolvedPath =
          this.modelPath ??
          join(homedir(), '.cache/dsh/models/embeddinggemma-2/onnx/model_quantized.onnx')

        if (!existsSync(resolvedPath)) {
          return false
        }

        const modelDir = dirname(dirname(resolvedPath))
        const { AutoTokenizer } = await import('@huggingface/transformers')
        const ort = await import('onnxruntime-node')
        const ortModule = (((ort as unknown as { default?: OrtModule }).default ?? ort) as unknown) as OrtModule

        const tokenizer = (await AutoTokenizer.from_pretrained(modelDir, {
          local_files_only: true,
        })) as unknown as (text: string) => Promise<TokenizerOutput>
        const session = await ortModule.InferenceSession.create(resolvedPath, {
          executionProviders: ['cpu'],
          intraOpNumThreads: this.maxThreads,
          interOpNumThreads: 1,
        })

        this.ortInstance = ortModule
        this.tokenizer = tokenizer
        this.session = session
        return true
      } catch {
        // Fallback gracefully to feature hashing if neural runtime fails to load
        return false
      }
    })()

    return this.initPromise
  }

  /** Generate 768-D embedding from text using EmbeddingGemma-2 ONNX or fast feature hashing. */
  async embedText(rawText: string): Promise<Float32Array> {
    const text = clampText(rawText)
    const neuralReady = await this.ensureNeuralInit()

    if (neuralReady && this.session && this.tokenizer && this.ortInstance) {
      try {
        const tokens = await this.tokenizer(text)
        const inputIds = new BigInt64Array(tokens.input_ids.data.map((x: number | bigint | string) => BigInt(x)))
        const mask = new BigInt64Array(tokens.attention_mask.data.map((x: number | bigint | string) => BigInt(x)))

        const feeds: Record<string, unknown> = {
          input_ids: new this.ortInstance.Tensor('int64', inputIds, tokens.input_ids.dims),
          attention_mask: new this.ortInstance.Tensor('int64', mask, tokens.attention_mask.dims),
          image_features: new this.ortInstance.Tensor('float32', new Float32Array(0), [0, 512]),
          video_features: new this.ortInstance.Tensor('float32', new Float32Array(0), [0, 512]),
          audio_features: new this.ortInstance.Tensor('float32', new Float32Array(0), [0, 512]),
        }

        const out = await this.session.run(feeds)
        if (out.sentence_embedding?.data) {
          const vec = new Float32Array(out.sentence_embedding.data)
          return normalizeVector(vec)
        }
      } catch {
        // Fall through to hash on execution error
      }
    }

    return this.embedTextHash(text)
  }

  /** Feature hashing fallback (deterministic & zero-dependency). */
  embedTextHash(text: string): Float32Array {
    const lower = text.toLowerCase()
    const vector = new Float32Array(EMBEDDING_DIMENSION)

    // Hash tokens and character n-grams into 768-D space
    const tokens = lower.split(/[\s,._\-:;()[\]{}<>=+*&^%$#@!~?/'"]+/).filter(Boolean)
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t]
      if (token === undefined) continue
      let h = 0x811c9dc5
      for (let i = 0; i < token.length; i++) {
        h = Math.imul(h ^ token.charCodeAt(i), 0x01000193)
      }
      const idx = Math.abs(h) % EMBEDDING_DIMENSION
      const sign = (h & 1) === 0 ? 1 : -1
      vector[idx] = (vector[idx] ?? 0) + sign * 1.5

      // Bigram projection
      if (t > 0) {
        const prev = tokens[t - 1]
        if (prev !== undefined) {
          const biHash = Math.imul(h ^ prev.length, 0x5bd1e995)
          const biIdx = Math.abs(biHash) % EMBEDDING_DIMENSION
          vector[biIdx] = (vector[biIdx] ?? 0) + 0.8
        }
      }
    }

    return normalizeVector(vector)
  }

  /** Generate 768-D embedding and semantic hints from image buffer. */
  async embedImage(rawBuffer: Uint8Array, maxDim = 384): Promise<{
    vector: Float32Array
    semanticHints: string[]
    width: number
    height: number
  }> {
    const prep = preprocessImage(rawBuffer, maxDim)
    const vector = new Float32Array(EMBEDDING_DIMENSION)

    // Project image byte distribution into 768-D embedding
    const bytes = prep.clampedBuffer
    const step = Math.max(1, Math.floor(bytes.length / EMBEDDING_DIMENSION))
    for (let i = 0; i < EMBEDDING_DIMENSION && i * step < bytes.length; i++) {
      const byteVal = bytes[i * step] ?? 128
      vector[i] = (byteVal - 128) / 128
    }

    // Blend in semantic hints into text-compatible space
    const hints = [
      ...prep.visualCharacteristics,
      `resolution-${prep.estimatedWidth}x${prep.estimatedHeight}`,
    ]

    for (const hint of hints) {
      const textVec = await this.embedText(hint)
      for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
        const v = vector[i] ?? 0
        const tv = textVec[i] ?? 0
        vector[i] = v * 0.7 + tv * 0.3
      }
    }

    return {
      vector: normalizeVector(vector),
      semanticHints: hints,
      width: prep.estimatedWidth,
      height: prep.estimatedHeight,
    }
  }

  /** Generate 768-D embedding and intent hints from audio buffer. */
  async embedAudio(rawBuffer: Uint8Array, maxDurationSec = 30): Promise<{
    vector: Float32Array
    intentHint: string
    durationSec: number
  }> {
    const prep = preprocessAudio(rawBuffer, maxDurationSec)
    const vector = new Float32Array(EMBEDDING_DIMENSION)

    // Map audio waveform density
    const bytes = prep.clampedBuffer
    const step = Math.max(1, Math.floor(bytes.length / EMBEDDING_DIMENSION))
    for (let i = 0; i < EMBEDDING_DIMENSION && i * step < bytes.length; i++) {
      const byteVal = bytes[i * step] ?? 128
      vector[i] = (byteVal - 128) / 128
    }

    const intentHint = `voice-audio-clip-${prep.durationSec}s`
    const hintVec = await this.embedText(intentHint)
    for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
      const v = vector[i] ?? 0
      const hv = hintVec[i] ?? 0
      vector[i] = v * 0.6 + hv * 0.4
    }

    return {
      vector: normalizeVector(vector),
      intentHint,
      durationSec: prep.durationSec,
    }
  }
}
