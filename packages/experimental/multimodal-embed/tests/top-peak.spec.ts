import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly, AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { MultimodalEmbeddingService } from '../src/service.ts'
import { Config } from '../src/config.ts'
import { registerToolRouterHook } from '../src/hooks/on-assemble.ts'
import { extractLexicalBoosts } from '../src/heuristics/intent-matcher.ts'
import { MarkovTransitionTracker } from '../src/heuristics/markov-tracker.ts'
import { DynamicPackBucketingEngine } from '../src/heuristics/pack-bucketing.ts'

describe('Top-Peak Tool-RAG Heuristics & Dynamic Pack Bucketing', () => {
  describe('Lexical Intent Matcher (Tier 1)', () => {
    it('detects CLI command patterns and boosts terminal tools', () => {
      const match = extractLexicalBoosts('Tolong jalankan pnpm run build dan git status')
      expect(match.matchedDomains.has('dev')).toBe(true)
      expect(match.boosts.get('bash')).toBeGreaterThan(0)
      expect(match.boosts.get('job_output')).toBeGreaterThan(0)
    })

    it('detects filesystem path and editing patterns', () => {
      const match = extractLexicalBoosts('Tolong baca file packages/core/src/index.ts dan edit isinya')
      expect(match.matchedDomains.has('dev')).toBe(true)
      expect(match.boosts.get('read')).toBeGreaterThan(0)
      expect(match.boosts.get('edit')).toBeGreaterThan(0)
    })

    it('detects web and networking patterns', () => {
      const match = extractLexicalBoosts('Cari di web tentang dokumentasi Vitest v4 di https://vitest.dev')
      expect(match.matchedDomains.has('web')).toBe(true)
      expect(match.boosts.get('web_search')).toBeGreaterThan(0)
      expect(match.boosts.get('web_fetch')).toBeGreaterThan(0)
    })

    it('detects memory and directive patterns', () => {
      const match = extractLexicalBoosts('Ingat ini sebagai aturan proyek baru kita')
      expect(match.matchedDomains.has('core')).toBe(true)
      expect(match.boosts.get('save_rule')).toBeGreaterThan(0)
      expect(match.boosts.get('manage_memory')).toBeGreaterThan(0)
    })

    it('detects 3D and media patterns', () => {
      const match = extractLexicalBoosts('Buat model 3D blender dan render scene menjadi file output.png')
      expect(match.matchedDomains.has('media_3d')).toBe(true)
      expect(match.boosts.get('inspect_multimodal')).toBeGreaterThan(0)
    })

    it('detects team and subagent orchestration patterns', () => {
      const match = extractLexicalBoosts('Delegasikan tugas analisis ke subagent dan koordinasi tim bersama')
      expect(match.matchedDomains.has('team')).toBe(true)
      expect(match.boosts.get('subagent')).toBeGreaterThan(0)
      expect(match.boosts.get('team_task_create')).toBeGreaterThan(0)
    })
  })

  describe('Markov Transition Tracker (Tier 1)', () => {
    it('boosts bash and read after edit or write execution', () => {
      const tracker = new MarkovTransitionTracker()
      const sid = 'session_test_1'

      // Turn 1 ends with 'edit' tool executed
      tracker.recordTurnEnd(sid, new Set(['edit']))

      const boosts = tracker.getBoosts(sid)
      expect(boosts.get('bash')).toBeCloseTo(0.35, 2)
      expect(boosts.get('read')).toBeCloseTo(0.20, 2)
    })

    it('boosts save_rule after search_memory', () => {
      const tracker = new MarkovTransitionTracker()
      const sid = 'session_test_2'

      tracker.recordTurnEnd(sid, new Set(['search_memory']))

      const boosts = tracker.getBoosts(sid)
      expect(boosts.get('save_rule')).toBeCloseTo(0.30, 2)
      expect(boosts.get('manage_memory')).toBeCloseTo(0.30, 2)
    })

    it('decays Markov boosts over subsequent turns without matching triggers', () => {
      const tracker = new MarkovTransitionTracker()
      const sid = 'session_test_3'

      tracker.recordTurnEnd(sid, new Set(['edit']))
      expect(tracker.getBoosts(sid).get('bash')).toBeCloseTo(0.35, 2)

      // Turn 2 ends with non-trigger tool
      tracker.recordTurnEnd(sid, new Set(['ask_user_question']))
      expect(tracker.getBoosts(sid).get('bash')).toBeCloseTo(0.175, 2)

      // Turn 3 ends with non-trigger tool
      tracker.recordTurnEnd(sid, new Set(['ask_user_question']))
      expect(tracker.getBoosts(sid).get('bash')).toBeCloseTo(0.0875, 2)
    })
  })

  describe('Dynamic Pack Bucketing Engine (Tier 2)', () => {
    it('dynamically auto-clusters MCP tools into domain pack by server namespace', () => {
      const engine = new DynamicPackBucketingEngine()

      expect(engine.resolvePackId('mcp__blender__generate_3d')).toBe('mcp:blender')
      expect(engine.resolvePackId('mcp__blender__look')).toBe('mcp:blender')
      expect(engine.resolvePackId('mcp__github__create_issue')).toBe('mcp:github')
      expect(engine.resolvePackId('plugin__sql__query')).toBe('plugin:sql')
    })

    it('admits entire domain pack together when one tool in pack qualifies', () => {
      const engine = new DynamicPackBucketingEngine()

      const allTools = [
        { name: 'manage_memory' },
        { name: 'ask_user_question' },
        { name: 'bash' },
        { name: 'read' },
        { name: 'write' },
        { name: 'edit' },
        { name: 'mcp__blender__generate_3d' },
        { name: 'mcp__blender__look' },
        { name: 'mcp__blender__render' },
      ]

      // Only 'mcp__blender__generate_3d' qualifies
      const qualifying = new Set(['mcp__blender__generate_3d'])
      const matchedDomains = new Set<string>()

      const admitted = engine.resolveAdmittedTools(allTools, qualifying, matchedDomains)
      const admittedNames = admitted.map(t => t.name)

      // Core tools always admitted
      expect(admittedNames).toContain('manage_memory')
      expect(admittedNames).toContain('ask_user_question')

      // ALL tools in mcp:blender are admitted together!
      expect(admittedNames).toContain('mcp__blender__generate_3d')
      expect(admittedNames).toContain('mcp__blender__look')
      expect(admittedNames).toContain('mcp__blender__render')

      // Non-qualifying dev tools are not admitted
      expect(admittedNames).not.toContain('bash')
      expect(admittedNames).not.toContain('edit')
    })

    it('preserves deterministic alphabetical ordering within packs to shield KV cache', () => {
      const engine = new DynamicPackBucketingEngine()

      const allTools = [
        { name: 'write' },
        { name: 'bash' },
        { name: 'edit' },
        { name: 'read' },
        { name: 'manage_memory' },
      ]

      const qualifying = new Set(['bash'])
      const admitted = engine.resolveAdmittedTools(allTools, qualifying, new Set(['dev']))
      const admittedNames = admitted.map(t => t.name)

      // Dev tools admitted in deterministic alphabetical order: bash, edit, read, write
      const devIndexBash = admittedNames.indexOf('bash')
      const devIndexEdit = admittedNames.indexOf('edit')
      const devIndexRead = admittedNames.indexOf('read')
      const devIndexWrite = admittedNames.indexOf('write')

      expect(devIndexBash).toBeLessThan(devIndexEdit)
      expect(devIndexEdit).toBeLessThan(devIndexRead)
      expect(devIndexRead).toBeLessThan(devIndexWrite)
    })
  })

  describe('End-to-End System Integration in on-assemble', () => {
    let ctx: Context
    let service: MultimodalEmbeddingService

    it('admits dev pack when prompt has CLI syntax even without explicit keywords', async () => {
      ctx = new Context()
      service = new MultimodalEmbeddingService(ctx, Config({}))
      ctx.set('multimodalEmbed', service)

      const config = Config({
        toolRouting: {
          enabled: true,
          policy: 'turn-boundary',
          coreTools: ['ask_user_question'],
          maxDynamicTools: 2,
          maxDynamicSkills: 2,
          similarityThreshold: 0.80,
          heuristics: {
            enabled: true,
            boostWeight: 0.45,
            markovEnabled: true,
            markovBiasWeight: 0.3,
          },
          bucketing: {
            enabled: true,
            toolPacks: {},
          },
          reranker: {
            enabled: false,
            topKCandidates: 8,
          },
        },
      })

      registerToolRouterHook(ctx, service, config)

      const assembly: PromptAssembly = {
        sections: [],
        contexts: [],
        tools: [
          { name: 'ask_user_question', description: 'Ask question', parameters: {} },
          { name: 'bash', description: 'Execute bash shell command', parameters: {} },
          { name: 'read', description: 'Read file contents', parameters: {} },
          { name: 'write', description: 'Write file contents', parameters: {} },
          { name: 'mcp__blender__generate_3d', description: 'Blender 3D mesh', parameters: {} },
        ],
        variables: {
          userPrompt: 'pnpm run build --filter @deepseek-ai/dsh-core',
        },
      }

      const dummySession = { id: 'sess_cli_integration' }
      const context: AssembleContext = { agent: { session: dummySession } as never }

      await ctx.parallel('system-prompt/assemble', assembly, context, async () => assembly)

      const admittedToolNames = assembly.tools.map(t => t.name)

      // Dev pack should be fully admitted due to CLI lexical boost
      expect(admittedToolNames).toContain('bash')
      expect(admittedToolNames).toContain('read')
      expect(admittedToolNames).toContain('write')

      // Blender should NOT be admitted
      expect(admittedToolNames).not.toContain('mcp__blender__generate_3d')
    })

    it('executes Stage-2 cross-encoder reranking to accurately rank candidates', async () => {
      const candidates = [
        { id: 'bash', text: 'bash: execute shell command scripts' },
        { id: 'web_search', text: 'web_search: search for recent information across the web and news' },
        { id: 'read_image', text: 'read_image: read image files from filesystem' },
      ]

      const results = await service.rerankCandidates('search for latest AI papers on the web', candidates)

      expect(results.length).toBe(3)
      // web_search should be ranked first with highest cross score
      expect(results[0]?.id).toBe('web_search')
      expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0)

      service.teardown()
    })
  })
})
