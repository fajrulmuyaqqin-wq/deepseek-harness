/**
 * Symbiotic Compaction Listener (Fase 5).
 * Listens to durable session events ('compaction/summary') to automatically preserve pruned knowledge
 * into the long-term vector store without interfering with compaction-basic.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/hooks/on-compaction
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MultimodalEmbedService } from '../types.ts'
import type { MultimodalEmbedConfig } from '../config.ts'

export function registerCompactionListener(
  ctx: Context,
  service: MultimodalEmbedService,
  config: MultimodalEmbedConfig,
): void {
  if (!config.autoCaptureCompacted) return

  ctx.on('session/event', (_session, event) => {
    void (async () => {
      try {
        const rawEvent = event as {
          type: string
          data?: {
            summary?: Array<{ type?: string; text?: string }>
            compactionId?: string
            shadowedTokenCount?: number
            shadowedSeqs?: unknown[]
          }
        }
        if (rawEvent.type === 'compaction/summary') {
          const data = rawEvent.data
          if (!data || !data.summary) return

          // Extract summary text blocks
          const summaryText = data.summary
            .filter((block): block is { text: string } => typeof block.text === 'string' && block.text.trim().length > 0)
            .map(block => block.text)
            .join('\n\n')

          if (summaryText.length === 0) return

          const id = await service.saveEntry('summary', summaryText, {
            compactionId: data.compactionId,
            shadowedTokenCount: data.shadowedTokenCount,
            shadowedSeqsCount: data.shadowedSeqs?.length ?? 0,
          })

          ctx.logger.info(
            `multimodal-embed: captured compacted summary into vector store (id: ${id}, ~${data.shadowedTokenCount ?? 0} tokens saved)`,
          )
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        ctx.logger.warn(`multimodal-embed compaction capture error: ${msg}`)
      }
    })()
  })
}
