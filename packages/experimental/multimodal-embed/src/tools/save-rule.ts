/**
 * save_rule tool definition.
 * Saves operational project rules, workflow constraints, or user preferences into long-term memory.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/tools/save-rule
 */

import type { MultimodalEmbedService } from '../types.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isDuplicateRule } from '../directive-sniffer.ts'

export interface SaveRuleResult {
  id: string
  ok: boolean
  rule: string
}

export function createSaveRuleTool(service: MultimodalEmbedService) {
  return defineTool({
    name: 'save_rule',
    description: 'Catat aturan operasional proyek, batasan alur kerja (workflow), atau preferensi pengguna yang wajib dipatuhi.',
    parameters: {
      rule: {
        type: 'string',
        required: true,
        description: 'Pernyataan aturan atau batasan yang wajib dipatuhi (contoh: "Target git branch selalu development")',
      },
      scope: {
        type: 'string',
        enum: ['project', 'workflow', 'user_preference'],
        description: 'Cakupan aturan (default: workflow)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          rule: { type: 'string', required: true },
        },
      },
      render: (args, val) => [{ type: 'text', text: `Aturan proyek tersimpan: "${args.rule}" (ID: ${val.id})` }],
    },
    async execute(args) {
      const scope = args.scope ?? 'workflow'
      const existingRules = await service.getEntriesByCategory('rule', 50).catch(() => [])
      for (const existing of existingRules) {
        if (isDuplicateRule([existing], args.rule)) {
          return { id: existing.id, ok: true, rule: args.rule }
        }
      }

      const content = `[${scope.toUpperCase()}] ${args.rule}`
      const id = await service.saveEntry('rule', content, {
        scope,
        rawRule: args.rule,
      })
      return { id, ok: true, rule: args.rule }
    },
  })
}
