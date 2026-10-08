import { describe, it, expect } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionFailure, ToolExecutionSuccess } from '@deepseek-ai/dsh-tools'
import type { PromptAssembly, AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { MultimodalEmbeddingService } from '../src/service.ts'
import { Config } from '../src/config.ts'
import { registerToolRouterHook } from '../src/hooks/on-assemble.ts'
import { createSaveRuleTool, type SaveRuleResult } from '../src/tools/save-rule.ts'
import { createSaveLessonTool } from '../src/tools/save-lesson.ts'
import { createManageMemoryTool, type ManageMemoryResult } from '../src/tools/manage-memory.ts'
import { extractDirectiveCandidate, extractRevocationCandidate, autoSniffAndRevokeDirective } from '../src/directive-sniffer.ts'
import { distillCompactedSummary, registerCompactionListener } from '../src/hooks/on-compaction.ts'

describe('Turn-Boundary Tool-RAG & Passive Memory Recall (on-assemble)', () => {
  it('auto-injects high confidence long-term memories (> 0.65) into assembly sections', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    // Save a known lesson
    await service.saveEntry('code', 'Optimize SQLite performance under high concurrent load with pooling')

    registerToolRouterHook(ctx, service, Config({}))

    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [],
      variables: {
        userPrompt: 'Optimize SQLite performance under high concurrent load',
      },
    }

    const context: AssembleContext = {}

    await ctx.parallel('system-prompt/assemble', assembly, context, async () => assembly)

    const recallSection = assembly.sections.find(s => s.name === 'multimodal-memory-recall')
    expect(recallSection).toBeDefined()
    expect(recallSection?.text).toContain('## Relevant Long-Term Memory')
    expect(recallSection?.text).toContain('with pooling')

    service.teardown()
  })

  it('preserves sticky active tools executed in previous turn across turn boundary', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    const config = Config({
      toolRouting: {
        enabled: true,
        policy: 'turn-boundary',
        coreTools: ['read_file'],
        maxDynamicTools: 1,
        maxDynamicSkills: 0,
        similarityThreshold: 0.1,
      },
    })

    registerToolRouterHook(ctx, service, config)

    const toolBlender: ToolSchema = {
      name: 'blender_render',
      description: '3D rendering mesh modeling raytrace visual asset',
      parameters: {},
    }
    const toolLsp: ToolSchema = {
      name: 'lsp_definition',
      description: 'Find typescript symbol AST definition',
      parameters: {},
    }
    const toolCore: ToolSchema = {
      name: 'read_file',
      description: 'Read file contents from disk',
      parameters: {},
    }

    // Turn 1: Intent targets blender
    const assemblyTurn1: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [toolCore, toolBlender, toolLsp],
      variables: { userPrompt: 'Render 3D mesh objek cangkir kopi' },
    }
    const context: AssembleContext = {}

    await ctx.parallel('system-prompt/assemble', assemblyTurn1, context, async () => assemblyTurn1)
    expect(assemblyTurn1.tools.map(t => t.name)).toContain('blender_render')

    // Simulate execution of blender_render in Turn 1
    ctx.emit('session/event', {} as never, {
      type: 'tool/call',
      seq: 1 as never,
      time: Date.now(),
      data: {
        turn: 1,
        step: 0,
        callId: 'call_1' as never,
        name: 'blender_render',
        arguments: '{}',
      },
    })

    // Turn 1 ends
    ctx.emit('session/event', {} as never, {
      type: 'turn/end',
      seq: 2 as never,
      time: Date.now(),
      data: {
        turn: 1,
        reason: 'completed' as never,
      },
    })

    // Turn 2: Vague follow-up intent that alone would NOT score high enough
    const assemblyTurn2: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [toolCore, toolBlender, toolLsp],
      variables: { userPrompt: 'Ubah warnanya jadi biru' },
    }

    await ctx.parallel('system-prompt/assemble', assemblyTurn2, context, async () => assemblyTurn2)

    // Because blender_render was executed in Turn 1, it remains sticky active in Turn 2!
    expect(assemblyTurn2.tools.map(t => t.name)).toContain('blender_render')

    service.teardown()
  })

  it('dynamically activates tools on-demand mid-turn via activator', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    const config = Config({
      toolRouting: {
        enabled: true,
        policy: 'turn-boundary',
        coreTools: ['read_file'],
        maxDynamicTools: 1,
        maxDynamicSkills: 0,
        similarityThreshold: 0.8, // high threshold to prune toolLsp
      },
    })

    const activator = registerToolRouterHook(ctx, service, config)

    const toolLsp: ToolSchema = {
      name: 'lsp_definition',
      description: 'Find typescript symbol AST definition',
      parameters: {},
    }
    const toolCore: ToolSchema = {
      name: 'read_file',
      description: 'Read file contents from disk',
      parameters: {},
    }

    const dummyTools: ToolSchema[] = Array.from({ length: 5 }, (_, i) => ({
      name: `dummy_tool_${i}`,
      description: `Irrelevant dummy tool ${i}`,
      parameters: {},
    }))

    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [toolCore, toolLsp, ...dummyTools],
      variables: { userPrompt: 'Tulis dokumen baru' },
    }
    const context: AssembleContext = {
      agent: { session: { id: 'test-session-1' } } as never,
    }

    // Step 1: lsp_definition is pruned due to low similarity
    await ctx.parallel('system-prompt/assemble', assembly, context, async () => assembly)
    expect(assembly.tools.map(t => t.name)).not.toContain('lsp_definition')

    // Mid-turn: Model discovers and activates lsp_definition
    const activationResult = await activator.activateTool(['lsp_definition'], 'test-session-1')
    expect(activationResult.activated).toEqual(['lsp_definition'])

    // Step 2 in same turn: assembly now includes dynamically activated tool!
    const assemblyStep2: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [toolCore, toolLsp, ...dummyTools],
      variables: { userPrompt: 'Tulis dokumen baru' },
    }
    await ctx.parallel('system-prompt/assemble', assemblyStep2, context, async () => assemblyStep2)
    expect(assemblyStep2.tools.map(t => t.name)).toContain('lsp_definition')

    service.teardown()
  })

  it('excludes catalog_tool and catalog_skill from passive recall', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    // Save a catalog tool and a regular lesson
    await service.saveEntry('catalog_tool', '[TOOL: git_status]\nDescription: Check working tree status', { toolName: 'git_status' })
    await service.saveEntry('lesson', 'Always check git status before committing changes')

    registerToolRouterHook(ctx, service, Config({}))

    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [],
      variables: { userPrompt: 'Bagaimana cara cek git status sebelum commit?' },
    }
    const context: AssembleContext = {}

    await ctx.parallel('system-prompt/assemble', assembly, context, async () => assembly)

    const recallSection = assembly.sections.find(s => s.name === 'multimodal-memory-recall')
    expect(recallSection).toBeDefined()
    expect(recallSection?.text).toContain('[LESSON]')
    expect(recallSection?.text).not.toContain('[CATALOG_TOOL]')

    service.teardown()
  })

  it('auto-recovers and activates known catalog tools on error via tools/post-execute', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    registerToolRouterHook(ctx, service, Config({}))

    const toolBlender: ToolSchema = {
      name: 'blender_render',
      description: 'Render 3D scene in Blender',
      parameters: {},
    }

    // Register tool into assembly so it becomes known
    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [toolBlender],
      variables: {},
    }
    await ctx.parallel('system-prompt/assemble', assembly, {}, async () => assembly)

    // Simulate an execution error for an unpruned/inactive tool call
    const exec = {
      name: 'blender_render',
      agent: { session: { id: 'test-session-recovery' } },
    } as never
    const errResult: ToolExecutionFailure = {
      isError: true,
      error: { message: 'Unknown tool: blender_render' },
      content: [],
    }

    const decision = await ctx.waterfall(
      'tools/post-execute',
      exec,
      errResult,
      async () => ({ kind: 'accept' as const, value: [] as never }),
    )

    // Check that auto-recovery notice was added to additionalContexts
    expect(decision.additionalContexts).toBeDefined()
    expect(decision.additionalContexts?.some(ctxMsg =>
      ctxMsg.content.some(c => c.type === 'text' && c.text.includes('[Tool Catalog Auto-Recovery]')),
    )).toBe(true)

    service.teardown()
  })

  it('injects anti-loop warning on 3 consecutive tool execution errors', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    registerToolRouterHook(ctx, service, Config({}))

    const exec = {
      name: 'failing_tool',
      agent: { session: { id: 'test-session-loop' } },
    } as never
    const errResult: ToolExecutionFailure = {
      isError: true,
      error: { message: 'Command failed' },
      content: [],
    }

    // Failure 1
    const d1 = await ctx.waterfall('tools/post-execute', exec, errResult, async () => ({ kind: 'accept' as const }))
    expect(d1.additionalContexts?.some(c => c.content.some(b => b.type === 'text' && b.text.includes('[Anti-Loop Warning]')))).toBeFalsy()

    // Failure 2
    const d2 = await ctx.waterfall('tools/post-execute', exec, errResult, async () => ({ kind: 'accept' as const }))
    expect(d2.additionalContexts?.some(c => c.content.some(b => b.type === 'text' && b.text.includes('[Anti-Loop Warning]')))).toBeFalsy()

    // Failure 3 -> triggers warning
    const d3 = await ctx.waterfall('tools/post-execute', exec, errResult, async () => ({ kind: 'accept' as const }))
    expect(d3.additionalContexts?.some(c => c.content.some(b => b.type === 'text' && b.text.includes('[Anti-Loop Warning]')))).toBe(true)

    // Success -> resets counter
    const successResult: ToolExecutionSuccess = { isError: false, content: [], value: null }
    await ctx.waterfall('tools/post-execute', exec, successResult, async () => ({ kind: 'accept' as const }))

    // Failure 4 (counter reset to 1) -> no warning
    const d4 = await ctx.waterfall('tools/post-execute', exec, errResult, async () => ({ kind: 'accept' as const }))
    expect(d4.additionalContexts?.some(c => c.content.some(b => b.type === 'text' && b.text.includes('[Anti-Loop Warning]')))).toBeFalsy()

    service.teardown()
  })

  it('sniffs referenced media paths and injects sensory preview into assemble sections', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    registerToolRouterHook(ctx, service, Config({}))

    const tempImagePath = join(tmpdir(), `test_sniff_${Date.now()}.png`)
    // Write valid minimal PNG bytes (8 bytes header + chunks)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])
    writeFileSync(tempImagePath, pngHeader)

    try {
      const assembly: PromptAssembly = {
        sections: [],
        contexts: [],
        tools: [],
        variables: {
          userPrompt: `Tolong periksa diagram arsitektur di ${tempImagePath}`,
        },
      }

      await ctx.parallel('system-prompt/assemble', assembly, {}, async () => assembly)

      const snifferSection = assembly.sections.find(s => s.name === 'multimodal-sensory-sniffer')
      expect(snifferSection).toBeDefined()
      expect(snifferSection?.text).toContain('## Sensory Preview (Multimodal Sniffer)')
      expect(snifferSection?.text).toContain(`[IMAGE: ${tempImagePath}]`)
    } finally {
      unlinkSync(tempImagePath)
      service.teardown()
    }
  })

  it('protects non-vision model by injecting sensory fallback on read_image failure', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    registerToolRouterHook(ctx, service, Config({}))

    const tempImagePath = join(tmpdir(), `test_fallback_${Date.now()}.png`)
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52])
    writeFileSync(tempImagePath, pngHeader)

    try {
      const exec = {
        name: 'read_image',
        arguments: { file_path: tempImagePath },
        agent: { session: { id: 'session-vision-fallback' } },
      } as never

      const errResult: ToolExecutionFailure = {
        isError: true,
        error: { message: 'cannot read: model does not declare image input' },
        content: [{ type: 'text', text: 'cannot read: model does not declare image input' }],
      }

      const decision = await ctx.waterfall(
        'tools/post-execute',
        exec,
        errResult,
        async () => ({ kind: 'accept' as const }),
      )

      expect(decision.additionalContexts).toBeDefined()
      expect(decision.additionalContexts?.some(ctxMsg =>
        ctxMsg.content.some(c => c.type === 'text' && c.text.includes('[Non-Vision Fallback Protector]')),
      )).toBe(true)
    } finally {
      unlinkSync(tempImagePath)
      service.teardown()
    }
  })

  it('saves operational rule via save_rule tool and retrieves it via getEntriesByCategory', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    const saveRuleTool = createSaveRuleTool(service)
    const result = (await saveRuleTool.execute(
      { rule: 'Target git branch selalu development, jangan push ke master', scope: 'workflow' },
      { signal: new AbortController().signal } as never,
    )) as SaveRuleResult

    expect(result.ok).toBe(true)
    expect(result.rule).toBe('Target git branch selalu development, jangan push ke master')
    expect(result.id).toMatch(/^mem_/)

    const savedRules = await service.getEntriesByCategory('rule')
    expect(savedRules.length).toBe(1)
    expect(savedRules[0]?.content).toContain('[WORKFLOW] Target git branch selalu development, jangan push ke master')
    expect(savedRules[0]?.metadata?.scope).toBe('workflow')

    service.teardown()
  })

  it('injects active project rules at top priority and preserves domain separation from passive recall', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    // Save a rule and a lesson
    await service.saveEntry('rule', '[WORKFLOW] Target branch selalu development', { scope: 'workflow' })
    await service.saveEntry('lesson', 'Gunakan pnpm run test:unit untuk memvalidasi komponen')

    registerToolRouterHook(ctx, service, Config({}))

    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [],
      variables: {
        userPrompt: 'Bagaimana alur kerja git branch dan pengujian kita?',
      },
    }

    await ctx.parallel('system-prompt/assemble', assembly, {}, async () => assembly)

    // Verify Active Project Rules is at top priority
    const rulesSection = assembly.sections.find(s => s.name === 'active-project-rules')
    expect(rulesSection).toBeDefined()
    expect(assembly.sections[0]?.name).toBe('active-project-rules')
    expect(rulesSection?.text).toContain('## Active Project Rules & Guidelines')
    expect(rulesSection?.text).toContain('[WORKFLOW] Target branch selalu development')

    // Verify Passive Recall exists for lessons, but does not duplicate rules
    const recallSection = assembly.sections.find(s => s.name === 'multimodal-memory-recall')
    if (recallSection) {
      expect(recallSection.text).not.toContain('[RULE]')
    }

    service.teardown()
  })

  it('sniffs background job settlement event and injects Active Background Task Event section', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    registerToolRouterHook(ctx, service, Config({}))

    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [],
      variables: {
        userPrompt: 'background job job_test_42 (bash: pnpm run test) finished [status: completed]. Read its output with job_output.',
      },
    }

    await ctx.parallel('system-prompt/assemble', assembly, {}, async () => assembly)

    const jobSection = assembly.sections.find(s => s.name === 'active-background-job-event')
    expect(jobSection).toBeDefined()
    expect(jobSection?.text).toContain('## Active Background Task Event')
    expect(jobSection?.text).toContain('job_test_42')
    expect(jobSection?.text).toContain('status `completed`')
    expect(jobSection?.text).toContain('job_output({ job_id: "job_test_42" })')

    service.teardown()
  })

  it('sniffs interval schedule reminder and injects Scheduled Check-in Event section', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    registerToolRouterHook(ctx, service, Config({}))

    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [],
      variables: {
        userPrompt: '[SCHEDULE REMINDER]\nschedule_id_json: "sched_01"\noccurrence_at: "2026-10-09T00:00:00Z"\nreminder_prompt_json: "Cek kesehatan port 3080 dan memory leak"',
      },
    }

    await ctx.parallel('system-prompt/assemble', assembly, {}, async () => assembly)

    const schedSection = assembly.sections.find(s => s.name === 'scheduled-checkin-event')
    expect(schedSection).toBeDefined()
    expect(schedSection?.text).toContain('## Scheduled Check-in Event (Interval Trigger)')
    expect(schedSection?.text).toContain('Cek kesehatan port 3080 dan memory leak')

    service.teardown()
  })

  it('extractDirectiveCandidate detects Indonesian and English directives and rejects noise/questions', () => {
    // Valid Indonesian directives
    const idRule1 = extractDirectiveCandidate('aturan kita: target branch selalu development')
    expect(idRule1).toBeDefined()
    expect(idRule1?.rule).toContain('target branch selalu development')
    expect(idRule1?.scope).toBe('workflow')

    const idRule2 = extractDirectiveCandidate('ingat ya, jangan pernah push ke master')
    expect(idRule2).toBeDefined()
    expect(idRule2?.rule.toLowerCase()).toContain('jangan pernah push ke master')
    expect(idRule2?.scope).toBe('workflow')

    const idRule3 = extractDirectiveCandidate('wajib jalankan oxlint sebelum commit')
    expect(idRule3).toBeDefined()
    expect(idRule3?.rule.toLowerCase()).toContain('jalankan oxlint sebelum commit')
    expect(idRule3?.scope).toBe('project')

    // Valid English directives
    const enRule1 = extractDirectiveCandidate('rule: always use development branch')
    expect(enRule1).toBeDefined()
    expect(enRule1?.rule).toContain('always use development branch')
    expect(enRule1?.scope).toBe('workflow')

    const enRule2 = extractDirectiveCandidate('remember to never push to main')
    expect(enRule2).toBeDefined()
    expect(enRule2?.rule).toContain('never push to main')
    expect(enRule2?.scope).toBe('workflow')

    // Rejected questions & noise
    expect(extractDirectiveCandidate('apakah kita harus push ke master?')).toBeUndefined()
    expect(extractDirectiveCandidate('why did this command fail?')).toBeUndefined()
    expect(extractDirectiveCandidate('baca file packages/core/src/index.ts')).toBeUndefined()
    expect(extractDirectiveCandidate('lanjut')).toBeUndefined()
    expect(extractDirectiveCandidate('ok')).toBeUndefined()
  })

  it('auto-sniffs explicit user directives and immediately injects them into active project rules during assemble', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    ctx.set('multimodalEmbed', service)

    registerToolRouterHook(ctx, service, Config({
      autoCaptureDirectives: true,
    }))

    const assembly: PromptAssembly = {
      sections: [],
      contexts: [],
      tools: [],
      variables: {
        userPrompt: 'aturan kita: target branch selalu development, jangan push ke master',
      },
    }

    await ctx.parallel('system-prompt/assemble', assembly, {}, async () => assembly)

    // Verify the directive was automatically sniffed, saved, and injected on the very same assemble turn
    const rulesSection = assembly.sections.find(s => s.name === 'active-project-rules')
    expect(rulesSection).toBeDefined()
    expect(rulesSection?.text).toContain('## Active Project Rules & Guidelines')
    expect(rulesSection?.text).toContain('[WORKFLOW] target branch selalu development, jangan push ke master')

    // Verify it is persisted in the database
    const savedRules = await service.getEntriesByCategory('rule', 10)
    expect(savedRules.length).toBeGreaterThan(0)
    expect(savedRules[0]?.content).toContain('target branch selalu development')

    service.teardown()
  })

  it('deduplicates direct save_rule and save_lesson tool invocations', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))

    const saveRuleTool = createSaveRuleTool(service)
    const saveLessonTool = createSaveLessonTool(service)

    // Save rule once
    const resRule1 = (await saveRuleTool.execute({ rule: 'Target git branch selalu development', scope: 'workflow' }, {} as never)) as { ok: boolean; id: string }
    expect(resRule1.ok).toBe(true)

    // Save identical rule again -> should return existing id without duplicate insertion
    const resRule2 = (await saveRuleTool.execute({ rule: 'Target git branch selalu development', scope: 'workflow' }, {} as never)) as { ok: boolean; id: string }
    expect(resRule2.ok).toBe(true)
    expect(resRule2.id).toBe(resRule1.id)

    const rules = await service.getEntriesByCategory('rule', 10)
    expect(rules.length).toBe(1)

    // Save lesson once
    const resLesson1 = (await saveLessonTool.execute({ topic: 'SQLite WAL', lesson: 'WAL mode enables high concurrency' }, {} as never)) as { ok: boolean; id: string }
    expect(resLesson1.ok).toBe(true)

    // Save identical lesson again -> should return existing id without duplicate insertion
    const resLesson2 = (await saveLessonTool.execute({ topic: 'SQLite WAL', lesson: 'WAL mode enables high concurrency' }, {} as never)) as { ok: boolean; id: string }
    expect(resLesson2.ok).toBe(true)
    expect(resLesson2.id).toBe(resLesson1.id)

    const lessons = await service.getEntriesByCategory('lesson', 10)
    expect(lessons.length).toBe(1)

    service.teardown()
  })

  it('distills lessons and operational rules from compacted summary sections', async () => {
    const sampleSummary = [
      '## Primary Request and Intent',
      '- Implement long-running reactive pipeline',
      '',
      '## Key Technical Concepts',
      '- Cordis expert waterfalls and declaration merging for extensible agent composition',
      '',
      '## Files and Code',
      '- packages/experimental/multimodal-embed/src/index.ts: registered tools',
      '',
      '## Errors and Fixes',
      '- TypeError on exactOptionalPropertyTypes: resolved using conditional spread ...val !== undefined ? { val } : {}',
      '',
      '## Critical Context',
      '- Operational constraint: Target git branch must always remain development; never push directly to master',
      '- Architecture decision: Native node:sqlite with WAL mode avoids external binary dependencies',
    ].join('\n')

    const distilled = distillCompactedSummary(sampleSummary, 'compaction-test-42')

    // Expect: 1 from Errors and Fixes (lesson), 1 from Key Technical Concepts (lesson),
    // 1 constraint from Critical Context (rule), 1 decision from Critical Context (lesson)
    const lessons = distilled.filter(d => d.category === 'lesson')
    const rules = distilled.filter(d => d.category === 'rule')

    expect(lessons.length).toBeGreaterThanOrEqual(2)
    expect(rules.length).toBeGreaterThanOrEqual(1)

    // Validate distilled bugfix
    const bugfix = lessons.find(l => l.content.includes('exactOptionalPropertyTypes'))
    expect(bugfix).toBeDefined()
    expect(bugfix?.content).toContain('[COMPACTED BUGFIX]')
    expect(bugfix?.metadata.compactionId).toBe('compaction-test-42')

    // Validate distilled rule
    const rule = rules.find(r => r.content.includes('Target git branch must always remain development'))
    expect(rule).toBeDefined()
    expect(rule?.content).toContain('[PROJECT]')

    // Test registerCompactionListener captures and persists both summary and distilled items
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))

    registerCompactionListener(ctx, service, Config({
      autoCaptureCompacted: true,
      autoDistillLessonsFromCompaction: true,
    }))

    const fakeSession = { id: 'test-session-compact' }
    const fakeEvent = {
      type: 'compaction/summary',
      data: {
        compactionId: 'compaction-event-1',
        summary: [{ type: 'text', text: sampleSummary }],
        shadowedTokenCount: 1500,
      },
    }

    await ctx.parallel('session/event', fakeSession as never, fakeEvent as never)

    // Wait a brief tick for async handler to settle
    await new Promise(r => setTimeout(r, 100))

    const storedSummaries = await service.getEntriesByCategory('summary', 10)
    expect(storedSummaries.length).toBe(1)
    expect(storedSummaries[0]?.metadata?.compactionId).toBe('compaction-event-1')

    const storedLessons = await service.getEntriesByCategory('lesson', 10)
    expect(storedLessons.length).toBeGreaterThan(0)
    expect(storedLessons.some(l => l.content.includes('exactOptionalPropertyTypes'))).toBe(true)

    const storedRules = await service.getEntriesByCategory('rule', 10)
    expect(storedRules.length).toBeGreaterThan(0)
    expect(storedRules.some(r => r.content.includes('development'))).toBe(true)

    service.teardown()
  })

  it('executes full CRUD lifecycle through manage_memory unified sub-tools schema', async () => {
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))
    const manageTool = createManageMemoryTool(service)

    // 1. SAVE - Rule with scope
    const saveRuleRes = (await manageTool.execute({
      action: 'save',
      category: 'rule',
      content: 'Branch tujuan pull request harus development',
      scope: 'workflow',
    }, {} as never)) as ManageMemoryResult

    expect(saveRuleRes.ok).toBe(true)
    expect(saveRuleRes.action).toBe('save')
    expect(saveRuleRes.id).toBeDefined()
    expect(saveRuleRes.category).toBe('rule')

    // SAVE - Duplicate rule should return existing ID
    const saveRuleDup = (await manageTool.execute({
      action: 'save',
      category: 'rule',
      content: 'Branch tujuan pull request harus development',
      scope: 'workflow',
    }, {} as never)) as ManageMemoryResult
    expect(saveRuleDup.ok).toBe(true)
    expect(saveRuleDup.id).toBe(saveRuleRes.id)

    // 2. SAVE - Lesson
    const saveLessonRes = (await manageTool.execute({
      action: 'save',
      category: 'lesson',
      content: 'Optimasi vite bundle dengan rolldown codeSplitting: false',
    }, {} as never)) as ManageMemoryResult

    expect(saveLessonRes.ok).toBe(true)
    expect(saveLessonRes.category).toBe('lesson')
    const lessonId = saveLessonRes.id!

    // 3. LIST - Category rule
    const listRules = (await manageTool.execute({
      action: 'list',
      category: 'rule',
    }, {} as never)) as ManageMemoryResult
    expect(listRules.ok).toBe(true)
    expect(listRules.results?.length).toBe(1)
    expect(listRules.results?.[0]?.content).toContain('development')

    // 4. SEARCH - Semantic vector search
    const searchRes = (await manageTool.execute({
      action: 'search',
      query: 'optimasi bundling vite',
      category: 'lesson',
    }, { signal: new AbortController().signal } as never)) as ManageMemoryResult

    expect(searchRes.ok).toBe(true)
    expect(searchRes.results?.length).toBeGreaterThan(0)
    expect(searchRes.results?.[0]?.content).toContain('vite bundle')

    // 5. DELETE - By specific ID
    const deleteIdRes = (await manageTool.execute({
      action: 'delete',
      id: lessonId,
    }, {} as never)) as ManageMemoryResult
    expect(deleteIdRes.ok).toBe(true)
    expect(deleteIdRes.deletedCount).toBe(1)

    // Verify deletion in DB
    const lessonsAfter = await service.getEntriesByCategory('lesson', 10)
    expect(lessonsAfter.some(l => l.id === lessonId)).toBe(false)

    // 6. DELETE - By query string
    const deleteQueryRes = (await manageTool.execute({
      action: 'delete',
      category: 'rule',
      query: 'Branch tujuan pull request',
    }, {} as never)) as ManageMemoryResult
    expect(deleteQueryRes.ok).toBe(true)
    expect(deleteQueryRes.deletedCount).toBe(1)

    const rulesAfter = await service.getEntriesByCategory('rule', 10)
    expect(rulesAfter.length).toBe(0)

    service.teardown()
  })

  it('extracts revocation candidates and auto-revokes obsolete rules/memories', async () => {
    // 1. Regex candidate extraction tests
    const rev1 = extractRevocationCandidate('hapus aturan tentang target git branch')
    expect(rev1).toBeDefined()
    expect(rev1?.query).toBe('target git branch')
    expect(rev1?.category).toBe('rule')

    const rev2 = extractRevocationCandidate('lupakan ingatan mengenai perbaikan exactOptionalPropertyTypes')
    expect(rev2).toBeDefined()
    expect(rev2?.query).toBe('perbaikan exactOptionalPropertyTypes')
    expect(rev2?.category).toBe('lesson')

    const rev3 = extractRevocationCandidate('delete rule about workflow branch')
    expect(rev3).toBeDefined()
    expect(rev3?.query).toBe('workflow branch')
    expect(rev3?.category).toBe('rule')

    // Questions should be rejected
    expect(extractRevocationCandidate('apakah aturan branch sudah dihapus?')).toBeUndefined()

    // 2. Integration with service: save then auto-revoke
    const ctx = new Context()
    const service = new MultimodalEmbeddingService(ctx, Config({}))

    await service.saveEntry('rule', '[WORKFLOW] Jangan pernah push langsung ke master')
    const beforeRules = await service.getEntriesByCategory('rule', 10)
    expect(beforeRules.length).toBe(1)

    const revokeSettlement = await autoSniffAndRevokeDirective(service, 'hapus aturan tentang jangan pernah push langsung ke master')
    expect(revokeSettlement.revoked).toBe(true)
    expect(revokeSettlement.deletedCount).toBe(1)

    const afterRules = await service.getEntriesByCategory('rule', 10)
    expect(afterRules.length).toBe(0)

    service.teardown()
  })
})
