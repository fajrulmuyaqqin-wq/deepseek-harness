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
import { createActivateToolTool } from './tools/activate-tool.ts'
import { registerToolRouterHook } from './hooks/on-assemble.ts'
import { registerCompactionListener } from './hooks/on-compaction.ts'

export * from './types.ts'
export * from './config.ts'
export * from './service.ts'
export * from './tools/activate-tool.ts'

export const name = 'multimodal-embed'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx: Context, config: MultimodalEmbedConfig): void {
  // 1. Register Global Service
  const service = new MultimodalEmbeddingService(ctx, config)

  // 2. Register Turn-Boundary Tool Router (Tool-RAG)
  const activator = registerToolRouterHook(ctx, service, config)

  // 3. Register Agent Tools (Zero-collision, defineTool)
  ctx.effect(() => {
    const unregisterSearch = ctx.tools.register(createSearchMemoryTool(service))
    const unregisterSave = ctx.tools.register(createSaveLessonTool(service))
    const unregisterInspect = ctx.tools.register(createInspectMultimodalTool(service))
    const unregisterActivate = ctx.tools.register(createActivateToolTool(activator))

    return () => {
      unregisterSearch()
      unregisterSave()
      unregisterInspect()
      unregisterActivate()
    }
  })

  // 4. Register Symbiotic Compaction Listener
  registerCompactionListener(ctx, service, config)

  ctx.logger.info(
    `multimodal-embed active (threads: ${config.maxCpuThreads}, timeout: ${config.watchdogTimeoutMs}ms, toolRouting: ${config.toolRouting.enabled})`,
  )
}
