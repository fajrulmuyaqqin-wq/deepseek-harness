/**
 * search_memory tool definition (Fase 3).
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/tools/search-memory
 */

import type { MultimodalEmbedService } from '../types.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'

export function createSearchMemoryTool(service: MultimodalEmbedService) {
  return defineTool({
    name: 'search_memory',
    description: 'Cari ingatan masa lalu, solusi bug, trik arsitektur, katalog tools tambahan (catalog_tool), atau katalog skills (catalog_skill).',
    parameters: {
      query: { type: 'string', required: true, description: 'Pertanyaan, konsep semantik, atau nama tools/skill yang ingin dicari' },
      category: {
        type: 'string',
        description: 'Kategori pencarian opsional: "catalog_tool" (katalog tools tambahan), "catalog_skill", "lesson", "code", "asset", "summary".',
      },
      limit: { type: 'number', description: 'Jumlah hasil maksimal yang dikembalikan (default: 3)' },
      threshold: { type: 'number', description: 'Skor ambang batas kemiripan (0.0 sampai 1.0)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                category: { type: 'string', required: true },
                content: { type: 'string', required: true },
                score: { type: 'number', required: true },
                createdAt: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const items = value.results
        if (items.length === 0) {
          return [{ type: 'text', text: 'Tidak ditemukan memori yang cocok dengan kueri tersebut.' }]
        }
        const formatted = items.map(
          (item, idx) => `${idx + 1}. [${item.category.toUpperCase()}] (Skor: ${(item.score * 100).toFixed(1)}%)\n${item.content}`,
        ).join('\n\n')
        return [{ type: 'text', text: `Ditemukan ${items.length} memori relevan:\n\n${formatted}` }]
      },
    },
    async execute(args, exec) {
      const vector = await service.embedText(args.query, exec.signal)
      const matches = await service.searchSimilar(
        vector,
        args.limit ?? 3,
        args.threshold,
        args.category,
      )

      return {
        results: matches.map(m => ({
          id: m.id,
          category: m.category,
          content: m.content,
          score: Math.round(m.score * 1000) / 1000,
          createdAt: m.createdAt,
        })),
      }
    },
  })
}
