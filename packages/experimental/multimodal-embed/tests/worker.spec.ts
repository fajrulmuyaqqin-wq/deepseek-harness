import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MultimodalEmbeddingService } from '../src/service.ts'
import { Config } from '../src/config.ts'
import { EMBEDDING_DIMENSION } from '../src/worker/embedder.ts'

describe('MultimodalEmbeddingService (Phase 1 Worker & Safeguards)', () => {
  it('generates normalized 768-D text embeddings', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))

    const vec1 = await service.embedText('koneksi database mysql timeout')
    const vec2 = await service.embedText('mysql connection pool error')
    const vec3 = await service.embedText('resep memasak rendang daging padang')

    expect(vec1.length).toBe(EMBEDDING_DIMENSION)
    expect(vec2.length).toBe(EMBEDDING_DIMENSION)

    // Semantic relevance: query MySQL should be closer to MySQL error than to cooking recipe
    const simClose = service.cosineSimilarity(vec1, vec2)
    const simFar = service.cosineSimilarity(vec1, vec3)

    expect(simClose).toBeGreaterThan(simFar)

    service.teardown()
  })

  it('downsamples and extracts semantic hints from image buffers (Layer 4)', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({ maxImageDimension: 384 }))

    // Create a mock PNG buffer (89 50 4E 47 0D 0A 1A 0A) with dark luminance
    const mockImage = new Uint8Array(1024)
    mockImage[0] = 0x89
    mockImage[1] = 0x50
    mockImage[2] = 0x4e
    mockImage[3] = 0x47
    mockImage.fill(40, 24) // Dark pixels

    const result = await service.embedImage(mockImage)

    expect(result.vector.length).toBe(EMBEDDING_DIMENSION)
    expect(result.semanticHints).toContain('dark-theme-palette')

    service.teardown()
  })

  it('clamps audio duration (Layer 4) and extracts intent hints', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({ maxAudioDurationSec: 10 }))

    // 16kHz 16-bit mono = 32,000 bytes/sec -> 5 seconds = 160,000 bytes
    const mockAudio = new Uint8Array(160000)
    mockAudio.fill(128)

    const result = await service.embedAudio(mockAudio)

    expect(result.vector.length).toBe(EMBEDDING_DIMENSION)
    expect(result.durationSec).toBe(5)
    expect(result.intentHint).toContain('voice-audio-clip-5s')

    service.teardown()
  })

  it('stores and retrieves episodic memory with cosine ranking', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({ similarityThreshold: 0.1 }))

    await service.saveEntry('code', 'function createDatabaseConnection() { ... }')
    await service.saveEntry('lesson', 'Fix timeout by increasing acquireTimeout in config')

    const queryVec = await service.embedText('database connection timeout fix')
    const matches = await service.searchSimilar(queryVec, 2, 0.05)

    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]!.score).toBeGreaterThan(0.05)

    service.teardown()
  })
})
