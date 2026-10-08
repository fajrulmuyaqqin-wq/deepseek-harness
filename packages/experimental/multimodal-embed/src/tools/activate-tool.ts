/**
 * activate_tool tool definition (Fase 6).
 * Dynamically activates tools from the catalog into the active turn session.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/tools/activate-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

export interface ToolActivator {
  activateTool(toolNames: string[], sessionId?: string): Promise<{ activated: string[]; notFound: string[] }>
  getAvailableCatalogTools(): string[]
}

export function createActivateToolTool(activator: ToolActivator) {
  return defineTool({
    name: 'activate_tool',
    description: 'Aktifkan tool tambahan dari katalog (catalog_tool) yang sebelumnya tidak tersedia di turn aktif.',
    parameters: {
      tools: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Daftar nama-nama tool yang ingin diaktifkan (misal: ["tool_jobs", "web_search"])',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          activated: { type: 'array', items: { type: 'string' }, required: true },
          notFound: { type: 'array', items: { type: 'string' }, required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.message },
      ],
    },
    async execute(args) {
      const toolNames = args.tools
      const result = await activator.activateTool(toolNames)

      let message = ''
      if (result.activated.length > 0) {
        message += `Tool berikut berhasil diaktifkan: ${result.activated.join(', ')}. Anda dapat langsung memanggilnya di langkah berikutnya.`
      }
      if (result.notFound.length > 0) {
        if (message.length > 0) message += '\n'
        message += `Tool berikut tidak ditemukan dalam katalog yang tersedia: ${result.notFound.join(', ')}.`
      }
      if (result.activated.length === 0 && result.notFound.length === 0) {
        message = 'Tidak ada tool yang diaktifkan.'
      }

      return {
        ok: result.activated.length > 0,
        activated: result.activated,
        notFound: result.notFound,
        message,
      }
    },
  })
}
