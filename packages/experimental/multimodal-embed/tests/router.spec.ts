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
})
