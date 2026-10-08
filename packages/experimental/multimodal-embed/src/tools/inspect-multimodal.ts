/**
 * inspect_multimodal tool definition (Fase 3).
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/tools/inspect-multimodal
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { MultimodalEmbedService } from '../types.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'

export function createInspectMultimodalTool(service: MultimodalEmbedService) {
  return defineTool({
    name: 'inspect_multimodal',
    description: 'Bedah berkas gambar (PNG/JPEG) atau audio (WAV/MP3) di workspace untuk mengekstrak intisari semantik visual atau akustik secara hemat token.',
    parameters: {
      path: { type: 'string', required: true, description: 'Jalur absolut atau relatif ke berkas gambar atau audio' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          path: { type: 'string', required: true },
          hints: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
        },
      },
      render: (args, value) => {
        return [
          {
            type: 'text',
            text: `Hasil analisis multimodal [${value.kind.toUpperCase()}] untuk ${args.path}:\n` +
              value.hints.map((h: string) => `• ${h}`).join('\n'),
          },
        ]
      },
    },
    async execute(args, exec) {
      const buffer = await readFile(args.path, { signal: exec.signal })
      const ext = extname(args.path).toLowerCase()

      if (['.wav', '.mp3', '.ogg', '.m4a'].includes(ext)) {
        const audio = await service.embedAudio(buffer, exec.signal)
        return {
          kind: 'audio',
          path: args.path,
          hints: [audio.intentHint, `durasi-${audio.durationSec}s`],
        }
      }

      // Default to image
      const image = await service.embedImage(buffer, exec.signal)
      return {
        kind: 'image',
        path: args.path,
        hints: image.semanticHints,
      }
    },
  })
}
