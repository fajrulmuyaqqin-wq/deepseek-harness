/**
 * Configuration schema for multimodal embedding and tool routing.
 *
 * @module @deepseek-ai/dsh-experimental-multimodal-embed/config
 */

import z from '@deepseek-ai/schemastery'

export interface ToolHeuristicsConfig {
  enabled: boolean
  boostWeight: number
  markovEnabled: boolean
  markovBiasWeight: number
}

export interface ToolBucketingConfig {
  enabled: boolean
  toolPacks: Record<string, string[]>
}

export interface ToolRerankerConfig {
  enabled: boolean
  topKCandidates: number
}

export interface SkillRoutingConfig {
  enabled: boolean
  similarityThreshold: number
  maxActiveSkills: number
  autoPrimeInstructions: boolean
}

export interface ToolRoutingConfig {
  enabled: boolean
  policy: 'turn-boundary' | 'step-boundary'
  coreTools: string[]
  maxDynamicTools: number
  maxDynamicSkills: number
  similarityThreshold: number
  heuristics: ToolHeuristicsConfig
  bucketing: ToolBucketingConfig
  reranker: ToolRerankerConfig
  skillRouting: SkillRoutingConfig
}

export interface MemoryRecallConfig {
  enabled: boolean
  similarityThreshold: number
  maxItems: number
  categories: string[]
}

export interface MultimodalEmbedConfig {
  modelPath?: string | undefined
  databasePath?: string | undefined
  device: 'cpu' | 'directml' | 'cuda'
  maxCpuThreads: number
  watchdogTimeoutMs: number
  maxImageDimension: number
  maxAudioDurationSec: number
  similarityThreshold: number
  maxRetrievalItems: number
  autoCaptureCompacted: boolean
  autoCaptureDirectives: boolean
  autoDistillLessonsFromCompaction: boolean
  recall: MemoryRecallConfig
  toolRouting: ToolRoutingConfig
}

export const toolHeuristicsSchema = z.object({
  enabled: z.boolean().default(true).description('Enable fast lexical regex cues for high-precision intent boost'),
  boostWeight: z.number().min(0).max(1).default(0.4).description('Score boost applied when lexical patterns match'),
  markovEnabled: z.boolean().default(true).description('Enable Markov tool transition temporal prior'),
  markovBiasWeight: z.number().min(0).max(1).default(0.3).description('Score bias applied for expected follow-up tools'),
})

export const toolBucketingSchema = z.object({
  enabled: z.boolean().default(true).description('Enable dynamic domain pack bucketing for KV-cache shielding'),
  toolPacks: z.dict(z.array(z.string())).default({})
    .description('Explicit static pack definitions; dynamic auto-bucketing applies to others'),
})

export const toolRerankerSchema = z.object({
  enabled: z.boolean().default(false).description('Enable Stage-2 Cross-Encoder reranking for precision disambiguation'),
  topKCandidates: z.number().step(1).min(2).max(20).default(8).description('Number of Stage-1 candidates passed to Cross-Encoder'),
})

export const skillRoutingSchema = z.object({
  enabled: z.boolean().default(true).description('Enable intent-driven selective skill routing'),
  similarityThreshold: z.number().min(0).max(1).default(0.70)
    .description('Minimum similarity score to admit a specialized skill'),
  maxActiveSkills: z.number().step(1).min(1).max(5).default(1)
    .description('Maximum number of active skills selected (default: 1)'),
  autoPrimeInstructions: z.boolean().default(false)
    .description('Whether to prime full skill instructions directly into prompt'),
})

export const toolRoutingSchema = z.object({
  enabled: z.boolean().default(true).description('Enable semantic tool and skill pruning'),
  policy: z.union(['turn-boundary' as const, 'step-boundary' as const]).default('turn-boundary')
    .description('Turn-boundary preserves LLM prompt prefix cache; step-boundary filters every step'),
  coreTools: z.array(z.string()).default(['read_file', 'ask_question', 'view_file'])
    .description('Tools that are always available and never pruned'),
  maxDynamicTools: z.number().step(1).min(1).default(5)
    .description('Maximum number of domain tools admitted per turn'),
  maxDynamicSkills: z.number().step(1).min(0).default(1)
    .description('Maximum number of specialized skills admitted per turn'),
  similarityThreshold: z.number().min(0).max(1).default(0.65)
    .description('Minimum cosine similarity required to admit a dynamic tool or skill'),
  heuristics: toolHeuristicsSchema.default({
    enabled: true,
    boostWeight: 0.4,
    markovEnabled: true,
    markovBiasWeight: 0.3,
  }),
  bucketing: toolBucketingSchema.default({
    enabled: true,
    toolPacks: {},
  }),
  reranker: toolRerankerSchema.default({
    enabled: false,
    topKCandidates: 8,
  }),
  skillRouting: skillRoutingSchema.default({
    enabled: true,
    similarityThreshold: 0.70,
    maxActiveSkills: 1,
    autoPrimeInstructions: false,
  }),
})

export const memoryRecallSchema = z.object({
  enabled: z.boolean().default(true).description('Enable automatic passive memory recall during prompt assembly'),
  similarityThreshold: z.number().min(0).max(1).default(0.35)
    .description('Minimum cosine similarity required to inject a memory entry into assembly'),
  maxItems: z.number().step(1).min(1).max(10).default(3)
    .description('Maximum number of memory items injected per turn'),
  categories: z.array(z.string()).default(['lesson', 'code', 'summary', 'asset'])
    .description('Memory categories eligible for passive recall; rules are separately injected at highest priority'),
})

export const Config = z.object({
  modelPath: z.union([z.string(), z.const(undefined)]).description('Optional path to local ONNX EmbeddingGemma model file'),
  databasePath: z.union([z.string(), z.const(undefined)]).description('Optional path to local vector database SQLite file'),
  device: z.union(['cpu' as const, 'directml' as const, 'cuda' as const]).default('cpu'),
  maxCpuThreads: z.number().step(1).min(1).max(8).default(2)
    .description('Clamped CPU core threads for tensor operations (prevents host throttling)'),
  watchdogTimeoutMs: z.number().step(100).min(500).default(5000)
    .description('Hard timeout for worker tensor execution in milliseconds'),
  maxImageDimension: z.number().step(16).min(128).max(1024).default(384)
    .description('Maximum width/height for downsampled image tensors'),
  maxAudioDurationSec: z.number().step(1).min(5).max(120).default(30)
    .description('Maximum duration in seconds per audio chunk'),
  similarityThreshold: z.number().min(0).max(1).default(0.78)
    .description('Default threshold for episodic memory recall'),
  maxRetrievalItems: z.number().step(1).min(1).max(20).default(3)
    .description('Maximum memory items returned per query'),
  autoCaptureCompacted: z.boolean().default(true)
    .description('Automatically capture summaries pruned by compaction-basic into vector store'),
  autoCaptureDirectives: z.boolean().default(true)
    .description('Automatically sniff and capture explicit user directives and project rules into vector store'),
  autoDistillLessonsFromCompaction: z.boolean().default(true)
    .description('Automatically distill bugfixes, technical lessons, and constraints from compacted checkpoint sections into vector store'),
  recall: memoryRecallSchema.default({
    enabled: true,
    similarityThreshold: 0.35,
    maxItems: 3,
    categories: ['lesson', 'code', 'summary', 'asset'],
  }),
  toolRouting: toolRoutingSchema.default({
    enabled: true,
    policy: 'turn-boundary',
    coreTools: ['read_file', 'ask_question', 'view_file'],
    maxDynamicTools: 5,
    maxDynamicSkills: 1,
    similarityThreshold: 0.65,
  }),
})
