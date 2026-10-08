/**
 * Types and Cordis context merging for the multimodal embedding service.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/types
 */

export type MemoryCategory = 'code' | 'lesson' | 'asset' | 'summary' | 'rule' | 'catalog_tool' | 'catalog_skill'

export interface MemoryItem {
  readonly id: string
  readonly category: MemoryCategory
  readonly content: string
  readonly score: number
  readonly metadata?: Record<string, unknown> | undefined
  readonly createdAt: number
}

export interface ImageHintResult {
  readonly vector: Float32Array
  readonly semanticHints: string[]
  readonly width: number
  readonly height: number
}

export interface AudioHintResult {
  readonly vector: Float32Array
  readonly intentHint: string
  readonly durationSec: number
}

export interface MultimodalEmbedService {
  /** Embed text input (query or code) into a 768-D vector. */
  embedText(text: string, signal?: AbortSignal): Promise<Float32Array>

  /** Downsample, preprocess, and embed an image into vector + semantic hints. */
  embedImage(imageBuffer: Uint8Array, signal?: AbortSignal): Promise<ImageHintResult>

  /** Chunk, preprocess, and embed an audio clip into vector + intent hint. */
  embedAudio(audioBuffer: Uint8Array, signal?: AbortSignal): Promise<AudioHintResult>

  /** Search similar memories in the local vector store with optional category filter. */
  searchSimilar(
    vector: Float32Array,
    limit?: number,
    threshold?: number,
    category?: MemoryCategory | MemoryCategory[],
  ): Promise<MemoryItem[]>

  /** Retrieve recent memory entries by category without requiring vector search. */
  getEntriesByCategory(category: MemoryCategory, limit?: number): Promise<MemoryItem[]>

  /** Save a new memory entry to the vector store. */
  saveEntry(
    category: MemoryCategory,
    content: string,
    metadata?: Record<string, unknown>,
    id?: string,
  ): Promise<string>

  /** Delete a memory entry by ID. */
  deleteEntry(id: string): Promise<boolean>

  /** Delete memories by category and/or query keyword match. */
  deleteEntriesByQuery(query?: string, category?: MemoryCategory): Promise<{ deletedCount: number; deletedIds: string[] }>

  /** Calculate cosine similarity between two 768-D vectors. */
  cosineSimilarity(a: Float32Array, b: Float32Array): number
}
