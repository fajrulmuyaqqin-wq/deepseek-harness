/**
 * save_lesson tool definition (Fase 3).
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/tools/save-lesson
 */

import type { MultimodalEmbedService } from '../types.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'

export function createSaveLessonTool(service: MultimodalEmbedService) {
  return defineTool({
    name: 'save_lesson',
    description: 'Simpan wawasan, solusi masalah, keputusan arsitektur, atau trik konfigurasi penting ke dalam memori jangka panjang agar diingat di masa depan.',
    parameters: {
      topic: { type: 'string', required: true, description: 'Topik atau judul pelajaran' },
      lesson: { type: 'string', required: true, description: 'Detail penjelasan solusi, trik, atau fakta yang dipelajari' },
      category: {
        type: 'string',
        enum: ['code', 'lesson', 'asset'],
        description: 'Kategori memori (default: lesson)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          topic: { type: 'string', required: true },
        },
      },
      render: (args, value) => [
        { type: 'text', text: `Berhasil menyimpan pelajaran "${args.topic}" ke memori jangka panjang (ID: ${value.id}).` },
      ],
    },
    async execute(args) {
      const category = (args.category as 'code' | 'lesson' | 'asset') || 'lesson'
      const content = `[${args.topic}]\n${args.lesson}`
      const id = await service.saveEntry(category, content, {
        topic: args.topic,
      })

      return {
        id,
        ok: true,
        topic: args.topic,
      }
    },
  })
}
