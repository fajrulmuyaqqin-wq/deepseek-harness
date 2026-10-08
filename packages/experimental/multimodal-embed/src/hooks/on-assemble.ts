/**
 * Turn-Boundary Semantic Tool & Skill Router (Tool-RAG) (Fase 4 & 5).
 * Hooks into system-prompt/assemble expert waterfall to dynamically prune unused tools and skills,
 * saving ~80% input tokens while preserving LLM prefix caching and per-session isolation.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/hooks/on-assemble
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly, AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { UserMessage, Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MultimodalEmbedService, MemoryCategory } from '../types.ts'
import type { MultimodalEmbedConfig } from '../config.ts'
import type { ToolActivator } from '../tools/activate-tool.ts'
import { autoSniffAndSaveDirective, autoSniffAndRevokeDirective } from '../directive-sniffer.ts'
import { extractLexicalBoosts } from '../heuristics/intent-matcher.ts'
import { MarkovTransitionTracker } from '../heuristics/markov-tracker.ts'
import { DynamicPackBucketingEngine } from '../heuristics/pack-bucketing.ts'

type ToolSchema = PromptAssembly['tools'][number]

interface SessionState {
  readonly stickyTools: Set<string>
  readonly currentTurnExecutedTools: Set<string>
  readonly dynamicallyActivatedTools: Set<string>
  consecutiveErrors: number
  turnLock?: { key: string; activeToolNames: Set<string> } | undefined
  latestUserMessage?: { text: string; sourceKind?: string | undefined } | undefined
}

export function registerToolRouterHook(
  ctx: Context,
  service: MultimodalEmbedService,
  config: MultimodalEmbedConfig,
): ToolActivator {
  const coreToolsSet = new Set(config.toolRouting.coreTools)
  // Ensure essential tools are always part of core tools
  coreToolsSet.add('manage_memory')
  coreToolsSet.add('search_memory')
  coreToolsSet.add('save_lesson')
  coreToolsSet.add('save_rule')
  coreToolsSet.add('activate_tool')
  coreToolsSet.add('job_output')
  coreToolsSet.add('job_list')
  coreToolsSet.add('create_goal')
  coreToolsSet.add('update_goal')
  coreToolsSet.add('get_goal')

  // Cache for tool vector representations
  const toolVectorCache = new Map<string, Float32Array>()

  // Heuristic Markov Transition Tracker & Dynamic Pack Bucketing Engine
  const markovTracker = new MarkovTransitionTracker()
  const packBucketing = new DynamicPackBucketingEngine(
    config.toolRouting.bucketing.toolPacks,
    Array.from(coreToolsSet.values()),
  )

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
      const sessionState = sessionId ? getOrCreateSessionState(sessionId) : undefined

      // Extract turn intent from variables, context, or latest session message
      let intentText = assembly.variables.userPrompt ?? assembly.variables.topic ?? ''
      let incomingSourceKind: string | undefined

      if (intentText.trim().length === 0 && sessionState?.latestUserMessage) {
        intentText = sessionState.latestUserMessage.text
        incomingSourceKind = sessionState.latestUserMessage.sourceKind
      }

      // Auto-sniff explicit directives from intentText before querying active rules
      if (config.autoCaptureDirectives && intentText.trim().length > 0) {
        await autoSniffAndRevokeDirective(service, intentText, ctx.logger).catch(() => {})
        await autoSniffAndSaveDirective(service, intentText, ctx.logger).catch((err: unknown) => {
          ctx.logger.debug(`multimodal directive auto-capture deferred: ${String(err)}`)
        })
      }

      // 0. Active Project Rules & Guidelines (Directives Domain)
      // Retrieve operational project rules and inject at highest priority (pinned at top)
      try {
        const activeRules = await service.getEntriesByCategory('rule', 10)
        if (activeRules.length > 0) {
          const rulesText = [
            '## Active Project Rules & Guidelines',
            ...activeRules.map((r, idx) => `${idx + 1}. ${r.content}`),
          ].join('\n')

          assembly.sections.unshift({
            name: 'active-project-rules',
            text: rulesText,
            interpolate: false,
          })
        }
      } catch (ruleErr: unknown) {
        const msg = ruleErr instanceof Error ? ruleErr.message : String(ruleErr)
        ctx.logger.warn(`multimodal active rules retrieval failed: ${msg}`)
      }

      // 1. Passive RAG (Knowledge Domain): Auto-inject relevant memories if confidence > recall.similarityThreshold
      if (config.recall.enabled && intentText.trim().length > 0) {
        try {
          const intentVec = await service.embedText(intentText)
          const recallThreshold = config.recall.similarityThreshold
          const maxMemories = config.recall.maxItems
          const eligibleCategories = (config.recall.categories as MemoryCategory[]).filter(c => c !== 'rule')
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

      // 2. Multimodal Sensory Sniffer (Pre-embed referenced media for instant sensory preview)
      if (intentText.trim().length > 0) {
        const sensoryMediaRegex = /(?:^|[\s"'(])([\w\-./\\]+\.(png|jpe?g|webp|gif|wav|mp3|ogg|m4a))\b/gi
        const mediaMatches = Array.from(intentText.matchAll(sensoryMediaRegex))
        if (mediaMatches.length > 0) {
          const sensoryHints: string[] = []
          for (const match of mediaMatches.slice(0, 3)) {
            const mediaPath = match[1]
            if (mediaPath && existsSync(mediaPath)) {
              try {
                const buffer = await readFile(mediaPath)
                const ext = extname(mediaPath).toLowerCase()
                if (['.wav', '.mp3', '.ogg', '.m4a'].includes(ext)) {
                  const audio = await service.embedAudio(buffer)
                  sensoryHints.push(`• [AUDIO: ${mediaPath}] (${audio.durationSec}s) Acoustic intent: ${audio.intentHint}`)
                } else {
                  const image = await service.embedImage(buffer)
                  sensoryHints.push(`• [IMAGE: ${mediaPath}] (${image.width}x${image.height}) Sensory hints: ${image.semanticHints.join(', ')}`)
                }
              } catch (err: unknown) {
                ctx.logger.debug(`multimodal sniffer: failed to parse ${mediaPath}: ${String(err)}`)
              }
            }
          }
          if (sensoryHints.length > 0) {
            assembly.sections.push({
              name: 'multimodal-sensory-sniffer',
              text: '## Sensory Preview (Multimodal Sniffer)\n' + sensoryHints.join('\n'),
              interpolate: false,
            })
          }
        }
      }

      // 3. Autonomous Woken-Turn Event Sniffer (Dual-Trigger Detection)
      if (intentText.trim().length > 0) {
        // A. Background Job Settlement Event
        const jobMatch = intentText.match(/background job ([\w-]+).*?finished\s+\[(?:status:\s*)?(\w+)(?:,\s*([^\]]+))?\]/i)
        if (jobMatch || incomingSourceKind === 'tool-jobs') {
          const jobId = jobMatch ? jobMatch[1] : undefined
          const status = jobMatch ? jobMatch[2] : 'settled'
          const detail = jobMatch?.[3] ? ` (${jobMatch[3]})` : ''
          const noticeText = jobId
            ? `Notice: Background job \`${jobId}\` has settled with status \`${status}\`${detail}.\nAction: Call \`job_output({ job_id: "${jobId}" })\` immediately to inspect its stdout and stderr before taking next steps.`
            : 'Notice: A background job has settled.\nAction: Call `job_output` or `job_list` to review results.'

          assembly.sections.push({
            name: 'active-background-job-event',
            text: `## Active Background Task Event\n${noticeText}`,
            interpolate: false,
          })

          if (sessionState) {
            sessionState.stickyTools.add('job_output')
            sessionState.stickyTools.add('job_list')
          }
        }

        // B. Schedule Reminder Event
        const isSchedule = intentText.includes('[SCHEDULE REMINDER]') || incomingSourceKind === 'schedule'
        if (isSchedule) {
          let promptDesc = 'Periodic check-in'
          const promptMatch = intentText.match(/reminder_prompt_json:\s*(".*?")/i)
          if (promptMatch && promptMatch[1]) {
            try {
              promptDesc = JSON.parse(promptMatch[1]) as string
            } catch {
              promptDesc = promptMatch[1]
            }
          }

          assembly.sections.push({
            name: 'scheduled-checkin-event',
            text: `## Scheduled Check-in Event (Interval Trigger)\nNotice: An interval reminder timer has triggered.\nPrompt: "${promptDesc}"\nAction: Inspect current background jobs or service status and advance the task.`,
            interpolate: false,
          })

          if (sessionState) {
            sessionState.stickyTools.add('job_list')
            sessionState.stickyTools.add('job_output')
            sessionState.stickyTools.add('schedule_list')
          }
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

      if (!config.toolRouting.enabled) {
        // Tool routing / dynamic pruning is disabled; preserve all registered tools
        return await next()
      }

      const nonCoreToolsCount = allTools.filter(t => !coreToolsSet.has(t.name)).length
      if (nonCoreToolsCount <= config.toolRouting.maxDynamicTools) {
        // Dynamic non-core tool count already within limit, no pruning needed
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

      // Extract zero-latency lexical boosts (Tier 1)
      const lexicalResult = config.toolRouting.heuristics.enabled
        ? extractLexicalBoosts(intentText, config.toolRouting.heuristics.boostWeight)
        : { boosts: new Map<string, number>(), matchedDomains: new Set<string>() }

      // Extract Markov temporal transition boosts (Tier 1)
      const markovBoosts = (config.toolRouting.heuristics.markovEnabled && sessionId)
        ? markovTracker.getBoosts(sessionId)
        : new Map<string, number>()

      // Vectorize intent for tool ranking
      const intentVector = await service.embedText(intentText)

      // Score candidate tools against intent with score fusion (S = S_dense + Δ_heur + Δ_markov)
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

        const baseScore = service.cosineSimilarity(intentVector, toolVec)
        const lexBoost = lexicalResult.boosts.get(tool.name) ?? 0
        const markovBoost = markovBoosts.get(tool.name) ?? 0
        const fusedScore = baseScore + lexBoost + markovBoost

        scoredCandidates.push({ tool, score: fusedScore })
      }

      // Stage 2: Cross-Encoder Reranker if enabled
      if (config.toolRouting.reranker.enabled && scoredCandidates.length > 0) {
        const topK = config.toolRouting.reranker.topKCandidates
        const topCandidates = [...scoredCandidates].sort((a, b) => b.score - a.score).slice(0, topK)
        try {
          const rerankInputs = topCandidates.map(sc => ({
            id: sc.tool.name,
            text: `${sc.tool.name} ${sc.tool.description}`,
          }))
          const rerankResults = await service.rerankCandidates(intentText, rerankInputs)
          const rerankScoreMap = new Map(rerankResults.map(r => [r.id, r.score]))

          for (const sc of scoredCandidates) {
            const crossScore = rerankScoreMap.get(sc.tool.name)
            if (crossScore !== undefined) {
              // Blend Stage-1 fused score with Stage-2 cross-encoder score
              sc.score = (sc.score * 0.5) + (crossScore * 0.5)
            }
          }
        } catch (rerankErr: unknown) {
          const msg = rerankErr instanceof Error ? rerankErr.message : String(rerankErr)
          ctx.logger.debug(`Stage-2 cross-encoder reranking skipped: ${msg}`)
        }
      }

      // Qualifying tools set for admission
      const qualifyingToolNames = new Set<string>()
      for (const tool of coreTools) qualifyingToolNames.add(tool.name)
      for (const tool of stickyActiveTools) qualifyingToolNames.add(tool.name)

      for (const sc of scoredCandidates) {
        if (sc.score >= config.toolRouting.similarityThreshold) {
          qualifyingToolNames.add(sc.tool.name)
        }
      }

      let activeTools: ToolSchema[]

      // Tier 2: Dynamic Pack Bucketing (Cache Shielding)
      if (config.toolRouting.bucketing.enabled) {
        activeTools = packBucketing.resolveAdmittedTools(allTools, qualifyingToolNames, lexicalResult.matchedDomains)
      } else {
        // Fallback: Individual tool selection
        scoredCandidates.sort((a, b) => b.score - a.score)
        const remainingDynamicSlots = Math.max(0, config.toolRouting.maxDynamicTools - stickyActiveTools.length)
        const selectedDynamicTools = scoredCandidates
          .filter(sc => qualifyingToolNames.has(sc.tool.name))
          .slice(0, remainingDynamicSlots)
          .map(sc => sc.tool)

        activeTools = [...coreTools, ...stickyActiveTools, ...selectedDynamicTools]
      }

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
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
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
      if (config.toolRouting.heuristics.markovEnabled) {
        markovTracker.recordTurnEnd(
          sid,
          state.currentTurnExecutedTools,
          config.toolRouting.heuristics.markovBiasWeight,
        )
      }
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
      const text = event.data.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map(c => c.text)
        .join('\n')
      const sourceKind = (event.data.source as { kind?: string } | undefined)?.kind
      state.latestUserMessage = {
        text,
        ...sourceKind !== undefined ? { sourceKind } : {},
      }
      if (config.autoCaptureDirectives && text.trim().length > 0) {
        void autoSniffAndRevokeDirective(service, text, ctx.logger)
        void autoSniffAndSaveDirective(service, text, ctx.logger)
      }
    }
  })

  // Auto-recovery for catalog tools and anti-loop consecutive error guard
  ctx.on('tools/post-execute', async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
    const sid = exec.agent?.session.id ? String(exec.agent.session.id) : lastActiveSessionId
    const state = sid ? getOrCreateSessionState(sid) : undefined

    let autoRecoveryNotice: string | undefined
    if (result.isError && (allKnownTools.has(exec.name) || indexedCatalog.has(`tool_${exec.name}`))) {
      if (sid) {
        await activator.activateTool([exec.name], sid).catch((err: unknown) => {
          ctx.logger.warn(`multimodal-embed: auto-recovery activate failed: ${String(err)}`)
        })
        autoRecoveryNotice = `[Tool Catalog Auto-Recovery] Tool "${exec.name}" has been automatically activated for your session. You can now invoke it with valid arguments.`
      }
    }

    let nonVisionFallbackNotice: string | undefined
    if (result.isError && exec.name === 'read_image') {
      const errText = result.content.map(c => c.type === 'text' ? c.text : '').join(' ')
      if (errText.includes('does not declare image input') || errText.includes('cannot read')) {
        const args = (exec.arguments ?? {}) as { file_path?: string }
        const filePath = args.file_path
        if (filePath && existsSync(filePath)) {
          try {
            const buffer = await readFile(filePath)
            const image = await service.embedImage(buffer)
            nonVisionFallbackNotice = `[Non-Vision Fallback Protector] Current model lacks direct vision decoding. Sensory analysis for "${filePath}":\n` +
              `• Dimensions: ${image.width}x${image.height}\n` +
              `• Visual characteristics: ${image.semanticHints.join(', ')}\n` +
              `You can also invoke inspect_multimodal({ path: "${filePath}" }) for further details.`
          } catch (err: unknown) {
            ctx.logger.warn(`multimodal-embed: vision fallback failed for ${filePath}: ${String(err)}`)
          }
        }
      }
    }

    if (state) {
      if (result.isError) {
        state.consecutiveErrors += 1
      } else {
        state.consecutiveErrors = 0
      }
    }

    const downstream: PostToolDecision = await next()

    const additionalContexts: UserMessage[] = [...(downstream.additionalContexts ?? [])]

    if (autoRecoveryNotice) {
      additionalContexts.push(createUserMessage({
        content: [{ type: 'text', text: autoRecoveryNotice }],
        source: { kind: 'repeat-tool-reminder' as never, form: 'notice', summary: `auto-activated: ${exec.name}` },
      }))
    }

    if (nonVisionFallbackNotice) {
      additionalContexts.push(createUserMessage({
        content: [{ type: 'text', text: nonVisionFallbackNotice }],
        source: { kind: 'repeat-tool-reminder' as never, form: 'notice', summary: `vision-fallback: ${exec.name}` },
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
  ctx.on('session/disposed', (session: Session) => {
    sessionStates.delete(String(session.id))
  })

  return activator
}
