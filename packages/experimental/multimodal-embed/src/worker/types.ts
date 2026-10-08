/**
 * Inter-process / worker-thread message contracts.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/worker/types
 */

export type WorkerRequest =
  | { id: number; kind: 'configure'; threads: number; modelPath?: string | undefined }
  | { id: number; kind: 'embed-text'; text: string }
  | { id: number; kind: 'embed-image'; imageBuffer: Uint8Array; maxDim: number }
  | { id: number; kind: 'embed-audio'; audioBuffer: Uint8Array; maxDurationSec: number }

export type WorkerResponse =
  | {
    id: number
    ok: true
    vector: Float32Array
    semanticHints?: string[] | undefined
    meta?: Record<string, unknown> | undefined
  }
  | {
    id: number
    ok: false
    error: string
  }
