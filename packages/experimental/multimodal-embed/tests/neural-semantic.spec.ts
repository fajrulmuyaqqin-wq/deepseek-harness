import { describe, it, expect } from 'vitest'
import { MultimodalEmbedder, cosineSimilarity } from '../src/worker/embedder.ts'

describe('EmbeddingGemma-2 Neural Semantic Understanding', () => {
  it('correctly maps abstract synonyms without keyword overlap (3D visual vs Blender)', async () => {
    const embedder = new MultimodalEmbedder(2)

    const promptIntent = 'Gimana cara bikin model visual tiga dimensi?'
    const toolBlender = 'blender_render: 3D mesh rendering visual modeling blender asset'
    const toolMysql = 'mysql_query: execute SQL relational database query tables'
    const toolDocker = 'docker_manage: container docker compose service orchestration'

    const vecPrompt = await embedder.embedText(promptIntent)
    const vecBlender = await embedder.embedText(toolBlender)
    const vecMysql = await embedder.embedText(toolMysql)
    const vecDocker = await embedder.embedText(toolDocker)

    const simBlender = cosineSimilarity(vecPrompt, vecBlender)
    const simMysql = cosineSimilarity(vecPrompt, vecMysql)
    const simDocker = cosineSimilarity(vecPrompt, vecDocker)

    // Neural embedding understands that "tiga dimensi" and "model visual" belong to 3D modeling/Blender
    expect(simBlender).toBeGreaterThan(0.70)
    expect(simBlender).toBeGreaterThan(simMysql)
    expect(simBlender).toBeGreaterThan(simDocker)
    // Margin over irrelevant tools must be significant (> 10%)
    expect(simBlender - simMysql).toBeGreaterThan(0.10)
  })

  it('correctly bridges cross-lingual gap (Indonesian prompt to English tool description)', async () => {
    const embedder = new MultimodalEmbedder(2)

    const indonesianPrompt = 'Buka dan baca isi berkas README.md'
    const toolReadFile = 'read_file: read file contents text from disk filesystem'
    const toolBlender = 'blender_render: 3D mesh rendering visual modeling blender asset'

    const vecIndo = await embedder.embedText(indonesianPrompt)
    const vecRead = await embedder.embedText(toolReadFile)
    const vecBlender = await embedder.embedText(toolBlender)

    const simRead = cosineSimilarity(vecIndo, vecRead)
    const simBlender = cosineSimilarity(vecIndo, vecBlender)

    expect(simRead).toBeGreaterThan(0.65)
    expect(simRead).toBeGreaterThan(simBlender)
  })

  it('accurately routes database query intent in Indonesian to SQL tool', async () => {
    const embedder = new MultimodalEmbedder(2)

    const prompt = 'Jalankan kueri data pelanggan di tabel database'
    const toolMysql = 'mysql_query: execute SQL relational database query tables'
    const toolDocker = 'docker_manage: container docker compose service orchestration'

    const vecPrompt = await embedder.embedText(prompt)
    const vecMysql = await embedder.embedText(toolMysql)
    const vecDocker = await embedder.embedText(toolDocker)

    const simMysql = cosineSimilarity(vecPrompt, vecMysql)
    const simDocker = cosineSimilarity(vecPrompt, vecDocker)

    expect(simMysql).toBeGreaterThan(0.70)
    expect(simMysql).toBeGreaterThan(simDocker)
  })
})
