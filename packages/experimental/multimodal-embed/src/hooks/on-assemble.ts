/**
 * Turn-Boundary Semantic Tool & Skill Router (Tool-RAG) (Fase 4 & 5).
 * Hooks into system-prompt/assemble expert waterfall to dynamically prune unused tools and skills,
 * saving ~80% input tokens while preserving LLM prefix caching and per-session isolation.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/hooks/on-assemble
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly, AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MultimodalEmbedService, MemoryCategory } from '../types.ts'
import type { MultimodalEmbedConfig } from '../config.ts'
import type { ToolActivator } from '../tools/activate-tool.ts'

type ToolSchema = PromptAssembly['tools'][number]

interface SessionState {
  readonly stickyTools: Set<string>
  readonly currentTurnExecutedTools: Set<string>
  readonly dynamicallyActivatedTools: Set<string>
  consecutiveErrors: number
  turnLock?: { key: string; activeToolNames: Set<string> } | undefined
}

export function registerToolRouterHook(
  ctx: Context,
  service: MultimodalEmbedService,
  config: MultimodalEmbedConfig,
): ToolActivator {
  const coreToolsSet = new Set(config.toolRouting.coreTools)
  // Ensure essential tools are always part of core tools
  coreToolsSet.add('search_memory')
  coreToolsSet.add('save_lesson')
  coreToolsSet.add('activate_tool')

  // Cache for tool vector representations
  const toolVectorCache = new Map<string, Float32Array>()

  // All known tools seen across assemblies
  const allKnownTools = new Set<string>()

  // Per-session router state map: Map<sessionId, SessionState>
  const sessionStates = new Map<string, SessionState>()
  let lastActiveSessionId: string | undefined

  function getOrCreateSessionState(sessionId: string): SessionState {
    let state = sessionStates.get(sessionId)
    if (!state) {
      state = {
        stickyTools: new Set<string>(),
        currentTurnExecutedTools: new Set<string>(),
        dynamicallyActivatedTools: new Set<string>(),
        consecutiveErrors: 0,
      }
      sessionStates.set(sessionId, state)
    }
    return state
  }

  // Set of indexed catalog entries
  const indexedCatalog = new Set<string>()

  const activator: ToolActivator = {
    activateTool(toolNames: string[], sessionId?: string): Promise<{ activated: string[]; notFound: string[] }> {
      const targetSid = sessionId ?? lastActiveSessionId
      const state = targetSid ? getOrCreateSessionState(targetSid) : undefined
      const activated: string[] = []
      const notFound: string[] = []

      for (const name of toolNames) {
        if (allKnownTools.has(name) || coreToolsSet.has(name)) {
          if (state) {
            state.dynamicallyActivatedTools.add(name)
            state.stickyTools.add(name)
            if (state.turnLock) {
              state.turnLock.activeToolNames.add(name)
            }
          }
          activated.push(name)
        } else {
          notFound.push(name)
        }
      }

      return Promise.resolve({ activated, notFound })
    },
    getAvailableCatalogTools(): string[] {
      return Array.from(allKnownTools.values())
    },
  }

  if (!config.toolRouting.enabled) {
    return activator
  }

  ctx.on('system-prompt/assemble', async (
    assembly: PromptAssembly,
    context: AssembleContext,
    next: () => Promise<PromptAssembly>,
  ): Promise<PromptAssembly> => {
    try {
      const sessionId = context.agent?.session.id ? String(context.agent.session.id) : undefined
      if (sessionId) {
        lastActiveSessionId = sessionId
      }

      // Extract turn intent from variables or context
      const intentText = assembly.variables.userPrompt ?? assembly.variables.topic ?? ''

      // 1. Passive RAG: Auto-inject relevant memories if confidence > recall.similarityThreshold
      if (config.recall.enabled && intentText.trim().length > 0) {
        try {
          const intentVec = await service.embedText(intentText)
          const recallThreshold = config.recall.similarityThreshold
          const maxMemories = config.recall.maxItems
          const eligibleCategories = config.recall.categories as MemoryCategory[]
          const memories = await service.searchSimilar(intentVec, maxMemories, recallThreshold, eligibleCategories)

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
      for (const t of allTools) {
        allKnownTools.add(t.name)
      }

      // Index available skills into catalog_skill if skills service is available
      const skillsService = ctx.get('skills') as {
        list?: (scope?: unknown) => Promise<Array<{ name: string; description?: string }>> | Array<{ name: string; description?: string }>
      } | undefined
      if (skillsService && typeof skillsService.list === 'function') {
        try {
          const skills = await Promise.resolve(skillsService.list(context.scope))
          if (Array.isArray(skills)) {
            for (const skill of skills) {
              const skillId = `skill_${skill.name}`
              if (!indexedCatalog.has(skillId)) {
                indexedCatalog.add(skillId)
                const doc = `[SKILL: ${skill.name}]\nDescription: ${skill.description ?? ''}`
                service.saveEntry('catalog_skill', doc, { skillName: skill.name }, skillId).catch((err: unknown) => {
                  ctx.logger.warn(`multimodal-embed: failed to index catalog skill ${skill.name}: ${String(err)}`)
                })
              }
            }
          }
        } catch (err: unknown) {
          ctx.logger.warn(`multimodal-embed: skills list query failed: ${String(err)}`)
        }
      }

      const sessionState = sessionId ? getOrCreateSessionState(sessionId) : undefined

      if (allTools.length <= config.toolRouting.maxDynamicTools + coreToolsSet.size) {
        // Tool count already small, no pruning needed
        return await next()
      }

      // Check Turn-Boundary Lock for this specific session
      if (config.toolRouting.policy === 'turn-boundary' && sessionState?.turnLock) {
        const lock = sessionState.turnLock
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

      const stickySet = sessionState?.stickyTools ?? new Set<string>()
      const activatedSet = sessionState?.dynamicallyActivatedTools ?? new Set<string>()

      for (const tool of allTools) {
        if (coreToolsSet.has(tool.name)) {
          coreTools.push(tool)
        } else if (stickySet.has(tool.name) || activatedSet.has(tool.name)) {
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
          const textToEmbed = `${tool.name} ${tool.description}`
          toolVec = await service.embedText(textToEmbed)
          toolVectorCache.set(tool.name, toolVec)
        }

        // Index candidate tools into vector catalog (category: 'catalog_tool') for search_memory
        if (!indexedCatalog.has(`tool_${tool.name}`)) {
          indexedCatalog.add(`tool_${tool.name}`)
          const toolDoc = `[TOOL: ${tool.name}]\nDescription: ${tool.description}`
          service.saveEntry('catalog_tool', toolDoc, { toolName: tool.name }, `tool_${tool.name}`).catch((err: unknown) => {
            ctx.logger.warn(`multimodal-embed: failed to index catalog tool ${tool.name}: ${String(err)}`)
          })
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

      // Lock for this session's turn boundary
      if (sessionState) {
        sessionState.turnLock = { key: intentText.slice(0, 30), activeToolNames: activeNames }
      }

      assembly.tools = activeTools
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.logger.warn(`tool router assembly failed: ${msg}; falling back to unpruned tools`)
    }

    return await next()
  })

  // Track executed tools per session and update sticky set upon turn completion
  ctx.on('session/event', (session, event) => {
    const sid = String(session.id)
    lastActiveSessionId = sid
    const state = sessionStates.get(sid)
    if (!state) return

    if (event.type === 'tool/call') {
      const toolName = event.data.name
      if (typeof toolName === 'string') {
        state.currentTurnExecutedTools.add(toolName)
      }
    } else if (event.type === 'turn/end') {
      state.consecutiveErrors = 0
      state.turnLock = undefined
      state.stickyTools.clear()
      for (const name of state.currentTurnExecutedTools) {
        state.stickyTools.add(name)
      }
      for (const name of state.dynamicallyActivatedTools) {
        state.stickyTools.add(name)
      }
      state.currentTurnExecutedTools.clear()
    } else if (event.type === 'user/message') {
      state.consecutiveErrors = 0
    }
  })

  // Auto-recovery for catalog tools and anti-loop consecutive error guard
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const sid = exec.agent?.session.id ? String(exec.agent.session.id) : lastActiveSessionId
    const state = sid ? getOrCreateSessionState(sid) : undefined

    let autoRecoveryNotice: string | undefined
    if (result.isError && (allKnownTools.has(exec.name) || indexedCatalog.has(`tool_${exec.name}`))) {
      if (sid) {
        await activator.activateTool([exec.name], sid).catch(() => {})
        autoRecoveryNotice = `[Tool Catalog Auto-Recovery] Tool "${exec.name}" has been automatically activated for your session. You can now invoke it with valid arguments.`
      }
    }

    if (state) {
      if (result.isError) {
        state.consecutiveErrors += 1
      } else {
        state.consecutiveErrors = 0
      }
    }

    const downstream = await next()

    const additionalContexts: UserMessage[] = [...(downstream.additionalContexts ?? [])]

    if (autoRecoveryNotice) {
      additionalContexts.push(createUserMessage({
        content: [{ type: 'text', text: autoRecoveryNotice }],
        source: { kind: 'repeat-tool-reminder' as never, form: 'notice', summary: `auto-activated: ${exec.name}` },
      }))
    }

    if (state && state.consecutiveErrors >= 3) {
      additionalContexts.push(createUserMessage({
        content: [{
          type: 'text',
          text: `[Anti-Loop Warning] ${state.consecutiveErrors} consecutive tool calls have failed. Stop repeating the current strategy. Carefully analyze the error messages, check paths/parameters, or use an alternative approach.`,
        }],
        source: { kind: 'repeat-tool-reminder' as never, form: 'notice', summary: `consecutive errors x ${state.consecutiveErrors}` },
      }))
    }

    if (additionalContexts.length > (downstream.additionalContexts?.length ?? 0)) {
      return {
        ...downstream,
        additionalContexts,
      }
    }

    return downstream
  })

  // Clean up session state on session disposal
  ctx.on('session/disposed', (session) => {
    sessionStates.delete(String(session.id))
  })

  return activator
}
