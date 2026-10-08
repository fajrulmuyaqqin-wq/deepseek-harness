import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
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
})
