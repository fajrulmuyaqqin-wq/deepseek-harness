/**
 * Turn-Boundary Semantic Tool & Skill Router (Tool-RAG) (Fase 4).
 * Hooks into system-prompt/assemble expert waterfall to dynamically prune unused tools and skills,
 * saving ~80% input tokens while preserving LLM prefix caching.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/hooks/on-assemble
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly, AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { MultimodalEmbedService } from '../types.ts'
import type { MultimodalEmbedConfig } from '../config.ts'

type ToolSchema = PromptAssembly['tools'][number]

export function registerToolRouterHook(
  ctx: Context,
  service: MultimodalEmbedService,
  config: MultimodalEmbedConfig,
): void {
  if (!config.toolRouting.enabled) return

  const coreToolsSet = new Set(config.toolRouting.coreTools)
  // Ensure memory tools are always part of core tools
  coreToolsSet.add('search_memory')
  coreToolsSet.add('save_lesson')

  // Cache for tool vector representations
  const toolVectorCache = new Map<string, Float32Array>()

  // Turn-boundary lock cache: Map<scopeKey, { key: string; activeToolNames: Set<string> }>
  const turnLockCache = new Map<string, { key: string; activeToolNames: Set<string> }>()

  // Sticky tools from previous turn
  const stickyTools = new Set<string>()
  // Tools executed in the current turn
  const currentTurnExecutedTools = new Set<string>()

  ctx.on('system-prompt/assemble', async (
    assembly: PromptAssembly,
    context: AssembleContext,
    next: () => Promise<PromptAssembly>,
  ): Promise<PromptAssembly> => {
    try {
      if (!service) return await next()

      // Extract turn intent from variables or context
      const intentText = assembly.variables.userPrompt ?? assembly.variables.topic ?? ''

      // 1. Passive RAG: Auto-inject top-3 relevant memories if confidence > 0.65
      if (intentText.trim().length > 0) {
        try {
          const intentVec = await service.embedText(intentText)
          const recallThreshold = 0.65
          const maxMemories = config.maxRetrievalItems ?? 3
          const memories = await service.searchSimilar(intentVec, maxMemories, recallThreshold)

          if (memories.length > 0) {
            const memoryText = [
              '## Relevant Long-Term Memory',
              ...memories.map(
                (m, idx) => `${idx + 1}. [${m.category.toUpperCase()}] (Relevance: ${(m.score * 100).toFixed(1)}%)\n${m.content}`,
              ),
            ].join('\n\n')

            assembly.sections.push({
              name: 'multimodal-memory-recall',
              text: memoryText,
              interpolate: false,
            })
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          ctx.logger.warn(`multimodal memory passive recall failed: ${msg}`)
        }
      }

      const allTools = assembly.tools
      if (allTools.length <= config.toolRouting.maxDynamicTools + coreToolsSet.size) {
        // Tool count already small, no pruning needed
        return await next()
      }

      // Check Turn-Boundary Lock
      const scopeKey = String(context.scope ?? 'global')
      const lock = turnLockCache.get(scopeKey)

      if (config.toolRouting.policy === 'turn-boundary' && lock) {
        // Reuse locked active tools for subsequent steps in this turn
        const filtered = allTools.filter(t => lock.activeToolNames.has(t.name))
        assembly.tools = filtered
        return await next()
      }

      if (intentText.trim().length === 0) {
        // No clear intent signal yet, keep all tools
        return await next()
      }

      // Identify core tools, sticky tools from previous turn, and candidate domain tools
      const coreTools: ToolSchema[] = []
      const stickyActiveTools: ToolSchema[] = []
      const candidateTools: ToolSchema[] = []

      for (const tool of allTools) {
        if (coreToolsSet.has(tool.name)) {
          coreTools.push(tool)
        } else if (stickyTools.has(tool.name)) {
          stickyActiveTools.push(tool)
        } else {
          candidateTools.push(tool)
        }
      }

      // Vectorize intent for tool ranking
      const intentVector = await service.embedText(intentText)

      // Score candidate tools against intent
      const scoredCandidates: Array<{ tool: ToolSchema; score: number }> = []

      for (const tool of candidateTools) {
        let toolVec = toolVectorCache.get(tool.name)
        if (!toolVec) {
          const textToEmbed = `${tool.name} ${tool.description ?? ''}`
          toolVec = await service.embedText(textToEmbed)
          toolVectorCache.set(tool.name, toolVec)
        }

        const score = service.cosineSimilarity(intentVector, toolVec)
        if (score >= config.toolRouting.similarityThreshold) {
          scoredCandidates.push({ tool, score })
        }
      }

      // Sort scored candidates descending
      scoredCandidates.sort((a, b) => b.score - a.score)

      // Available slots for newly dynamic tools after accounting for sticky active tools
      const remainingDynamicSlots = Math.max(0, config.toolRouting.maxDynamicTools - stickyActiveTools.length)
      const selectedDynamicTools = scoredCandidates
        .slice(0, remainingDynamicSlots)
        .map(sc => sc.tool)

      const activeTools = [...coreTools, ...stickyActiveTools, ...selectedDynamicTools]
      const activeNames = new Set(activeTools.map(t => t.name))

      // Lock for this turn boundary
      turnLockCache.set(scopeKey, { key: intentText.slice(0, 30), activeToolNames: activeNames })

      assembly.tools = activeTools
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.logger.warn(`tool router assembly failed: ${msg}; falling back to unpruned tools`)
    }

    return await next()
  })

  // Track executed tools during turn and update sticky set upon turn completion
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/call') {
      const toolName = event.data?.name
      if (typeof toolName === 'string') {
        currentTurnExecutedTools.add(toolName)
      }
    } else if (event.type === 'turn/end') {
      turnLockCache.clear()
      stickyTools.clear()
      for (const name of currentTurnExecutedTools) {
        stickyTools.add(name)
      }
      currentTurnExecutedTools.clear()
    }
  })
}
