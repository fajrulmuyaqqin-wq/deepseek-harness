/**
 * Plugin entrypoint for @deepseek-ai/dsh-experimental-multimodal-embed.
 * Integrates MultimodalEmbedService, tools (search_memory, save_lesson, inspect_multimodal),
 * Turn-Boundary Tool-RAG router, and Compaction episodic capture.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed
 */

import { Context } from '@deepseek-ai/cordis'
import type { MultimodalEmbedConfig } from './config.ts'
import { MultimodalEmbeddingService } from './service.ts'
import { createSearchMemoryTool } from './tools/search-memory.ts'
import { createSaveLessonTool } from './tools/save-lesson.ts'
import { createInspectMultimodalTool } from './tools/inspect-multimodal.ts'
import { registerToolRouterHook } from './hooks/on-assemble.ts'
import { registerCompactionListener } from './hooks/on-compaction.ts'

export * from './types.ts'
export * from './config.ts'
export * from './service.ts'

export const name = 'multimodal-embed'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx: Context, config: MultimodalEmbedConfig): void {
  // 1. Fase 1 & 2: Register Global Service
  const service = new MultimodalEmbeddingService(ctx, config)

  // 2. Fase 3: Register Agent Tools (Zero-collision, defineTool)
  ctx.effect(() => {
    const unregisterSearch = ctx.tools.register(createSearchMemoryTool(service))
    const unregisterSave = ctx.tools.register(createSaveLessonTool(service))
    const unregisterInspect = ctx.tools.register(createInspectMultimodalTool(service))

    return () => {
      unregisterSearch()
      unregisterSave()
      unregisterInspect()
    }
  })

  // 3. Fase 4: Register Turn-Boundary Tool Router (Tool-RAG)
  registerToolRouterHook(ctx, service, config)

  // 4. Fase 5: Register Symbiotic Compaction Listener
  registerCompactionListener(ctx, service, config)

  ctx.logger.info(
    `multimodal-embed active (threads: ${config.maxCpuThreads}, timeout: ${config.watchdogTimeoutMs}ms, toolRouting: ${config.toolRouting.enabled})`,
  )
}
