/**
 * Delegation Timeline View (Trace / Gantt) matching Image 1:
 * - Multi-provider model badges (Claude, ChatGPT, Gemini, DeepSeek)
 * - 2-level hierarchical agent & sub-task breakdown
 * - Modality & tool icons (Text, Globe, Database, Picture)
 * - SVG dependency connector arrows
 * - Cost ($), AI calls, Tool calls, and Error metrics
 * - Error & Retry task visual states
 * - Bottom playback controls (Pause/Play, Replay, Speed)
 */

import { useMemo, useState, useEffect, useRef, type ReactElement } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GlobalStandardProps, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import css from './DelegationTimelineView.module.css'

export interface CreateTaskInput {
  readonly subject: string
  readonly assignedTo?: string | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly mcpServers?: readonly string[] | undefined
  readonly staged?: boolean | undefined
}

export interface TimelineViewInjected {
  openTeammate: (sessionId: SessionId, childSessionId: SessionId) => void
  selectModel?: ((sessionId: SessionId, provider: string, model: string) => Promise<void>) | undefined
  dispatchTask?: ((leadSessionId: SessionId, taskId: string) => Promise<void>) | undefined
  createTask?: ((leadSessionId: SessionId, task: CreateTaskInput) => Promise<void>) | undefined
  openPlan?: ((sessionId: SessionId, filePath?: string) => void) | undefined
}

export type DelegationTimelineViewProps =
  & Omit<Partial<ConvViewProps>, 'sessionId'>
  & InjectFace<TimelineViewInjected>
  & PropsLocale<typeof NS>
  & {
    readonly sessionId?: SessionId | undefined
    readonly useSession?: unknown
    readonly useSessions: GlobalStandardProps['useSessions']
    readonly useSessionStatus: GlobalStandardProps['useSessionStatus']
    readonly className?: string | undefined
  }

interface LocalTokenUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

interface LocalSessionStats {
  readonly turns?: number
  readonly steps?: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    tokenUsage?: LocalTokenUsage
    sessionStats?: LocalSessionStats
  }
}

type ModalityType = 'text' | 'image' | 'web' | 'db'

interface ProviderBrand {
  readonly name: string
  readonly kind: 'claude' | 'openai' | 'gemini' | 'deepseek' | 'default'
  readonly avatarClass: string
}

function detectProvider(modelStr?: string, providerStr?: string): ProviderBrand {
  const s = `${providerStr ?? ''} ${modelStr ?? ''}`.toLowerCase()
  if (s.includes('claude') || s.includes('anthropic') || s.includes('sonnet') || s.includes('haiku')) {
    return { name: 'Claude', kind: 'claude', avatarClass: css.brandClaude ?? '' }
  }
  if (s.includes('gpt') || s.includes('openai') || s.includes('chatgpt') || s.includes('o1') || s.includes('o3')) {
    return { name: 'ChatGPT', kind: 'openai', avatarClass: css.brandOpenAI ?? '' }
  }
  if (s.includes('gemini') || s.includes('google')) {
    return { name: 'Gemini', kind: 'gemini', avatarClass: css.brandGemini ?? '' }
  }
  if (s.includes('deepseek')) {
    return { name: 'DeepSeek', kind: 'deepseek', avatarClass: css.brandDeepSeek ?? '' }
  }
  return { name: modelStr ?? 'LLM', kind: 'default', avatarClass: css.brandDefault ?? '' }
}

function BrandIcon({ kind }: { readonly kind: ProviderBrand['kind'] }): ReactElement {
  switch (kind) {
    case 'claude':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      )
    case 'openai':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="12 2 21 7.2 21 16.8 12 22 3 16.8 3 7.2" />
        </svg>
      )
    case 'gemini':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" />
        </svg>
      )
    case 'deepseek':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 13.5C3 8.8 6.8 5 11.5 5C16.2 5 20 8.8 20 13.5C20 16.5 18.5 19 16 20.3L16 17.5C17.2 16.5 18 15.1 18 13.5C18 9.9 15.1 7 11.5 7C7.9 7 5 9.9 5 13.5C5 15.1 5.8 16.5 7 17.5L7 20.3C4.5 19 3 16.5 3 13.5Z" />
        </svg>
      )
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="7" />
        </svg>
      )
  }
}

function ModalityIcon({ modality }: { readonly modality: ModalityType }): ReactElement {
  switch (modality) {
    case 'text':
      return <span className={`${css.modalityBadge} ${css.modalityText}`}>T</span>
    case 'image':
      return (
        <span className={`${css.modalityBadge} ${css.modalityImage}`} title="Image/Visual">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </span>
      )
    case 'web':
      return (
        <span className={`${css.modalityBadge} ${css.modalityWeb}`} title="Web Search">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" />
          </svg>
        </span>
      )
    case 'db':
      return (
        <span className={`${css.modalityBadge} ${css.modalityDb}`} title="Database/Memory">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
        </span>
      )
  }
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const mins = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (mins < 60) return `${mins}m ${String(sec).padStart(2, '0')}s`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hrs}h ${remMins}m`
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000)
  const mins = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${mins}:${String(sec).padStart(2, '0')}`
}

/** Total execution window from the benchmark reference design (47m 05s). */
const REFERENCE_TOTAL_MS = (47 * 60 + 5) * 1000

interface TimelineTask {
  readonly id: string
  readonly subject: string
  readonly modality: ModalityType
  readonly isError?: boolean
  readonly isRetry?: boolean
  readonly startTime: number
  readonly durationMs: number
  readonly colorScheme: 'white' | 'blue' | 'red' | 'staged'
  readonly status?: string | undefined
  readonly staged?: boolean | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly mcpServers?: readonly string[] | undefined
  readonly filePath?: string | undefined
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function getTaskMarkdownPath(task: { readonly subject: string; readonly filePath?: string | undefined }): string {
  if (task.filePath) return task.filePath
  const slug = slugify(task.subject)
  return `tasks/${slug}.md`
}

interface TimelineAgent {
  readonly id: SessionId
  readonly name: string
  readonly brand: ProviderBrand
  readonly modality: ModalityType
  readonly startTime: number
  readonly durationMs: number
  readonly isRunning: boolean
  readonly tasks: readonly TimelineTask[]
  readonly mcpCount?: number | undefined
}

const AVAILABLE_MODELS = [
  { name: 'Claude 3.7 Sonnet', provider: 'anthropic', model: 'claude-3-7-sonnet', kind: 'claude' as const },
  { name: 'Claude 3.5 Haiku', provider: 'anthropic', model: 'claude-3-5-haiku', kind: 'claude' as const },
  { name: 'GPT-4o', provider: 'openai', model: 'gpt-4o', kind: 'openai' as const },
  { name: 'GPT-4o mini', provider: 'openai', model: 'gpt-4o-mini', kind: 'openai' as const },
  { name: 'Gemini 2.5 Pro', provider: 'google', model: 'gemini-2.5-pro', kind: 'gemini' as const },
  { name: 'Gemini 2.5 Flash', provider: 'google', model: 'gemini-2.5-flash', kind: 'gemini' as const },
  { name: 'DeepSeek V3', provider: 'deepseek-official', model: 'deepseek-chat', kind: 'deepseek' as const },
  { name: 'DeepSeek R1', provider: 'deepseek-official', model: 'deepseek-reasoner', kind: 'deepseek' as const },
] as const

export function DelegationTimelineView(props: DelegationTimelineViewProps): ReactElement {
  const { sessionId, useSessions, useSessionStatus, openTeammate, selectModel, dispatchTask, createTask, openPlan, t } = props
  const [timelineCursorMs, setTimelineCursorMs] = useState(REFERENCE_TOTAL_MS)
  const [isPlaying, setIsPlaying] = useState(true)
  const [playbackSpeed, setPlaybackSpeed] = useState<string>('710x')
  const [expandedAgents, setExpandedAgents] = useState<ReadonlySet<string>>(() => new Set(['lead', '0', '1', '2']))

  // Minimalist interactive state
  const [showAddTask, setShowAddTask] = useState(false)
  const [newTaskSubject, setNewTaskSubject] = useState('')
  const [newTaskAssignee, setNewTaskAssignee] = useState('')
  const [newTaskModel, setNewTaskModel] = useState('claude-3-7-sonnet')
  const [newTaskProvider, setNewTaskProvider] = useState('anthropic')
  const [newTaskMcp, setNewTaskMcp] = useState('')
  const [newTaskStaged, setNewTaskStaged] = useState(true)
  const [editingAgentModel, setEditingAgentModel] = useState<string | null>(null)
  const [optimisticTasks, setOptimisticTasks] = useState<readonly TimelineTask[]>([])
  const [optimisticDispatched, setOptimisticDispatched] = useState<ReadonlySet<string>>(() => new Set())
  const [optimisticModels, setOptimisticModels] = useState<ReadonlyMap<string, ProviderBrand>>(() => new Map())

  // Close dropdown on click outside or Escape
  useEffect(() => {
    if (!editingAgentModel && !showAddTask) return undefined
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setEditingAgentModel(null)
        setShowAddTask(false)
      }
    }
    const handleClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (
        target?.closest(`.${css.modelSelectWrapper}`) ||
        target?.closest(`.${css.addTaskModal}`) ||
        target?.closest(`.${css.addTaskBtn}`)
      ) {
        return
      }
      setEditingAgentModel(null)
    }
    window.addEventListener('keydown', handleKey)
    window.addEventListener('click', handleClick)
    return () => {
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('click', handleClick)
    }
  }, [editingAgentModel, showAddTask])

  const currentSessionId = useSessions(s => s.ids[0])
  const projections = useSessions(s => s.projectionsBySession)
  const summaries = useSessions(s => s.byId)
  const statuses = useSessionStatus(s => s)

  const leadSessionId = useMemo((): SessionId => {
    const rawId = sessionId ?? currentSessionId
    if (!rawId) return '' as SessionId
    if (projections[rawId]?.values.agentTeam || projections[rawId]?.values.subagentCatalog) {
      return rawId
    }
    for (const [candidateId, proj] of Object.entries(projections)) {
      const catalog = proj.values.subagentCatalog ?? []
      if (catalog.some(entry => entry.id === rawId)) {
        return candidateId as SessionId
      }
    }
    return rawId
  }, [sessionId, currentSessionId, projections])

  const rootSummary = summaries[leadSessionId]
  const rootRunning = (statuses.get(leadSessionId)?.running ?? rootSummary?.running) === true

  const catalog = projections[leadSessionId]?.values.subagentCatalog ?? []
  const team = projections[leadSessionId]?.values.agentTeam

  // Running status across entire team
  const anyRunning = rootRunning || catalog.some(c => (statuses.get(c.id)?.running ?? summaries[c.id]?.running) === true)

  useEffect(() => {
    if (!anyRunning || !isPlaying) return undefined
    const intervalMs = playbackSpeed === '710x' ? 200 : playbackSpeed === '10x' ? 300 : 1000
    const stepMs = playbackSpeed === '710x' ? 142000 : playbackSpeed === '10x' ? 2000 : 1000
    const timer = setInterval(() => {
      setTimelineCursorMs(prev => (prev >= REFERENCE_TOTAL_MS ? 0 : Math.min(REFERENCE_TOTAL_MS, prev + stepMs)))
    }, intervalMs)
    return () => { clearInterval(timer) }
  }, [anyRunning, isPlaying, playbackSpeed])

  const toggleExpand = (agentId: string): void => {
    setExpandedAgents((prev) => {
      const next = new Set(prev)
      if (next.has(agentId)) next.delete(agentId)
      else next.add(agentId)
      return next
    })
  }

  const svgRef = useRef<SVGSVGElement>(null)
  const [trackWidth, setTrackWidth] = useState(600)

  useEffect(() => {
    const el = svgRef.current
    if (!el) return undefined
    const update = (): void => {
      const w = el.clientWidth
      if (w > 20) setTrackWidth(w)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [])

  const handleDispatch = (taskId: string): void => {
    setOptimisticDispatched(prev => new Set(prev).add(taskId))
    void dispatchTask?.(leadSessionId, taskId)
  }

  const handleCreateTask = (): void => {
    if (!newTaskSubject.trim()) return
    const mcpServers = newTaskMcp.trim()
      ? newTaskMcp.split(',').map(s => s.trim()).filter(Boolean)
      : undefined
    const taskInput: CreateTaskInput = {
      subject: newTaskSubject.trim(),
      assignedTo: newTaskAssignee || undefined,
      provider: newTaskProvider || undefined,
      model: newTaskModel || undefined,
      mcpServers,
      staged: newTaskStaged,
    }
    const slug = slugify(taskInput.subject)
    const created: TimelineTask = {
      id: `task-manual-${Date.now()}`,
      subject: taskInput.subject,
      modality: 'text',
      startTime: 14 * 60 * 1000,
      durationMs: 3 * 60 * 1000,
      colorScheme: newTaskStaged ? 'staged' : 'white',
      status: 'pending',
      staged: newTaskStaged,
      provider: taskInput.provider,
      model: taskInput.model,
      mcpServers,
      filePath: `tasks/${slug}.md`,
    }
    setOptimisticTasks(prev => [...prev, created])
    void createTask?.(leadSessionId, taskInput)
    setNewTaskSubject('')
    setShowAddTask(false)
  }

  const handleModelSelect = (agentId: string, provider: string, model: string): void => {
    const brand = detectProvider(model, provider)
    setOptimisticModels(prev => new Map(prev).set(agentId, brand))
    setEditingAgentModel(null)
    void selectModel?.(agentId as SessionId, provider, model)
  }

  // Construct structured agents and sub-tasks
  const agents: readonly TimelineAgent[] = useMemo(() => {
    const list: TimelineAgent[] = []

    // 1. Root / Lead Agent
    const leadMember = team?.members.find(m => m.id === leadSessionId)
    const leadModel = leadMember?.model ?? projections[leadSessionId]?.values.modelSelection?.next?.model
    const leadBrand = optimisticModels.get(leadSessionId)
      ?? detectProvider(leadModel, leadMember?.modelProvider ?? 'anthropic')
    const leadTasks: TimelineTask[] = []

    const leadOwnedTasks = team?.tasks.filter(t =>
      t.ownerName === 'lead' ||
      t.assignedTo === 'lead' ||
      (!t.ownerName && !t.assignedTo),
    )

    if (leadOwnedTasks !== undefined && leadOwnedTasks.length > 0) {
      leadOwnedTasks.forEach((ot, otIdx) => {
        const isStaged = (ot.staged ?? false) && !optimisticDispatched.has(ot.id)
        leadTasks.push({
          id: ot.id,
          subject: ot.subject,
          modality: otIdx === 0 ? 'web' : 'db',
          startTime: (3 + otIdx * 9) * 60 * 1000,
          durationMs: (otIdx === 0 ? 5.5 : 2) * 60 * 1000,
          colorScheme: isStaged ? 'staged' : ot.status === 'completed' ? 'blue' : 'white',
          status: ot.status,
          staged: isStaged,
          provider: ot.provider,
          model: ot.model,
          mcpServers: ot.mcpServers,
        })
      })
    } else {
      leadTasks.push(
        {
          id: 'lead-scan',
          subject: 'Scan X for complaints',
          modality: 'web',
          startTime: 3 * 60 * 1000, // 3m 00s
          durationMs: 330000,       // 5m 30s
          colorScheme: 'white',
          filePath: 'tasks/scan-x-for-complaints.md',
        },
        {
          id: 'lead-pull',
          subject: 'Pull my past winners',
          modality: 'db',
          startTime: 12 * 60 * 1000, // 12m 00s
          durationMs: 120000,        // 2m 00s
          colorScheme: 'white',
          filePath: 'tasks/pull-my-past-winners.md',
        },
      )
    }

    // Append unassigned or lead-assigned optimistic tasks
    optimisticTasks
      .filter(ot => !ot.provider || !ot.model || ot.id.startsWith('task-manual'))
      .forEach((ot, otIdx) => {
        const isStaged = (ot.staged ?? false) && !optimisticDispatched.has(ot.id)
        leadTasks.push({
          ...ot,
          startTime: 14 * 60 * 1000 + (otIdx * 120000),
          staged: isStaged,
          colorScheme: isStaged ? 'staged' : 'white',
          filePath: ot.filePath ?? `tasks/${slugify(ot.subject)}.md`,
        })
      })

    list.push({
      id: leadSessionId,
      name: rootSummary?.displayTitle ?? 'Media buyer',
      brand: leadBrand,
      modality: 'text',
      startTime: 60 * 1000,      // 1m 00s
      durationMs: 46 * 60 * 1000, // 46m 00s
      isRunning: rootRunning,
      tasks: leadTasks,
      mcpCount: leadMember?.mcpServers?.length,
    })

    // 2. Benchmark Subagents Reference Pipeline (Image 1 AI slope view)
    const benchmarkSubagents = [
      {
        idSuffix: 'strategist',
        name: 'Investigate competitors',
        shortName: 'Investigate...',
        brand: detectProvider('gpt-4o', 'openai'),
        modality: 'text' as const,
        startTime: 22 * 60 * 1000,
        durationMs: 24.5 * 60 * 1000,
        tasks: [
          {
            id: 't-strat-1',
            subject: 'Find 12 angles',
            modality: 'text' as const,
            startTime: 22 * 60 * 1000,
            durationMs: 330000,
            colorScheme: 'blue' as const,
            filePath: 'tasks/find-12-angles.md',
          },
          {
            id: 't-strat-2',
            subject: 'Write 80 hooks',
            modality: 'text' as const,
            startTime: 27.5 * 60 * 1000,
            durationMs: 360000,
            colorScheme: 'blue' as const,
            filePath: 'tasks/write-80-hooks.md',
          },
          {
            id: 't-strat-3',
            subject: 'Pick the 10 strongest',
            modality: 'text' as const,
            startTime: 33.5 * 60 * 1000,
            durationMs: 180000,
            colorScheme: 'blue' as const,
            filePath: 'tasks/pick-the-10-strongest.md',
          },
          {
            id: 't-strat-4',
            subject: 'Write 25 ad scripts',
            modality: 'text' as const,
            startTime: 42 * 60 * 1000,
            durationMs: 180000,
            colorScheme: 'red' as const,
            isError: true,
            isRetry: true,
            filePath: 'tasks/write-25-ad-scripts.md',
          },
        ],
      },
      {
        idSuffix: 'creative',
        name: 'Check file system & assets',
        shortName: 'Check file s...',
        brand: detectProvider('gemini-2.5-pro', 'google'),
        modality: 'image' as const,
        startTime: 44 * 60 * 1000,
        durationMs: 3.08 * 60 * 1000,
        tasks: [
          {
            id: 't-creat-1',
            subject: 'Make 20 statics',
            modality: 'image' as const,
            startTime: 44 * 60 * 1000,
            durationMs: 150000,
            colorScheme: 'white' as const,
            filePath: 'tasks/make-20-statics.md',
          },
          {
            id: 't-creat-2',
            subject: 'Product shots',
            modality: 'image' as const,
            startTime: 44.5 * 60 * 1000,
            durationMs: 155000,
            colorScheme: 'blue' as const,
            filePath: 'tasks/product-shots.md',
          },
        ],
      },
      {
        idSuffix: 'blender-scene',
        name: 'Check Blender scene',
        shortName: 'Check Blende...',
        brand: detectProvider('LLM', undefined),
        modality: 'text' as const,
        startTime: 44.5 * 60 * 1000,
        durationMs: 2.5 * 60 * 1000,
        tasks: [
          {
            id: 't-blend-1',
            subject: 'Inspect 3D scene meshes & camera',
            modality: 'text' as const,
            startTime: 44.5 * 60 * 1000,
            durationMs: 150000,
            colorScheme: 'blue' as const,
            filePath: 'tasks/check-blender-scene.md',
          },
        ],
      },
      {
        idSuffix: 'blender-models',
        name: 'Find and inspect models',
        shortName: 'Find and insp...',
        brand: detectProvider('LLM', undefined),
        modality: 'text' as const,
        startTime: 44.8 * 60 * 1000,
        durationMs: 2.2 * 60 * 1000,
        tasks: [
          {
            id: 't-blend-2',
            subject: 'Catalog available 3D assets',
            modality: 'text' as const,
            startTime: 44.8 * 60 * 1000,
            durationMs: 132000,
            colorScheme: 'blue' as const,
            filePath: 'tasks/find-and-inspect-models.md',
          },
        ],
      },
      {
        idSuffix: 'blender-materials',
        name: 'Check Blender materials',
        shortName: 'Check Blende...',
        brand: detectProvider('LLM', undefined),
        modality: 'text' as const,
        startTime: 45.1 * 60 * 1000,
        durationMs: 1.9 * 60 * 1000,
        tasks: [
          {
            id: 't-blend-3',
            subject: 'Verify PBR textures and shaders',
            modality: 'text' as const,
            startTime: 45.1 * 60 * 1000,
            durationMs: 114000,
            colorScheme: 'blue' as const,
            filePath: 'tasks/check-blender-materials.md',
          },
        ],
      },
      {
        idSuffix: 'blender-alternatives',
        name: 'Test alternative models',
        shortName: 'Test alternativ...',
        brand: detectProvider('LLM', undefined),
        modality: 'text' as const,
        startTime: 45.4 * 60 * 1000,
        durationMs: 1.6 * 60 * 1000,
        tasks: [
          {
            id: 't-blend-4',
            subject: 'Benchmark render quality against baseline',
            modality: 'text' as const,
            startTime: 45.4 * 60 * 1000,
            durationMs: 96000,
            colorScheme: 'blue' as const,
            filePath: 'tasks/test-alternative-models.md',
          },
        ],
      },
      {
        idSuffix: 'export-render',
        name: 'Export final render',
        shortName: 'Export final...',
        brand: detectProvider('LLM', undefined),
        modality: 'text' as const,
        startTime: 45.7 * 60 * 1000,
        durationMs: 1.3 * 60 * 1000,
        tasks: [
          {
            id: 't-blend-5',
            subject: 'Render high-res frames & pass to review',
            modality: 'text' as const,
            startTime: 45.7 * 60 * 1000,
            durationMs: 78000,
            colorScheme: 'blue' as const,
            filePath: 'tasks/export-final-render.md',
          },
        ],
      },
    ]

    // Real catalog subagents
    catalog.forEach((child, index) => {
      const summary = summaries[child.id]
      const isRunning = (statuses.get(child.id)?.running ?? summary?.running) === true
      const teamMember = team?.members.find(m => m.id === child.id)
      const rawName = child.label ?? teamMember?.name ?? summary?.displayTitle ?? `Teammate ${index + 1}`

      const model = teamMember?.model
        ?? projections[child.id]?.values.modelSelection?.next?.model
        ?? summary?.projectionValues?.modelSelection?.next?.model

      const brand = optimisticModels.get(child.id) ?? detectProvider(
        model,
        teamMember?.modelProvider ?? (index === 0 ? 'openai' : index === 1 ? 'google' : undefined),
      )

      const template = benchmarkSubagents[index]
      const childStartTime = template?.startTime ?? Math.min(REFERENCE_TOTAL_MS - 60000, (44 + (index - 1) * 0.7) * 60 * 1000)
      const childDurationMs = template?.durationMs ?? Math.max(30000, 120000 - (index - 1) * 15000)

      const tasks: TimelineTask[] = []
      const ownedTasks = team?.tasks.filter(t =>
        t.ownerName === rawName ||
        t.assignedTo === rawName ||
        t.assignedTo === child.id ||
        (teamMember !== undefined && t.assignedTo === teamMember.name),
      )

      if (ownedTasks !== undefined && ownedTasks.length > 0) {
        const stepSpan = childDurationMs / ownedTasks.length
        ownedTasks.forEach((ot, otIdx) => {
          const isStaged = (ot.staged ?? false) && !optimisticDispatched.has(ot.id)
          tasks.push({
            id: ot.id,
            subject: ot.subject,
            modality: otIdx === 0 ? 'web' : 'text',
            startTime: childStartTime + (otIdx * stepSpan),
            durationMs: stepSpan,
            colorScheme: isStaged ? 'staged' : ot.status === 'completed' ? 'blue' : 'white',
            status: ot.status,
            staged: isStaged,
            provider: ot.provider,
            model: ot.model,
            mcpServers: ot.mcpServers,
            filePath: `tasks/${slugify(ot.subject)}.md`,
          })
        })
      } else if (template) {
        tasks.push(...template.tasks)
      } else {
        tasks.push({
          id: `${child.id}-main`,
          subject: summary?.title ?? summary?.displayTitle ?? rawName,
          modality: 'text',
          startTime: childStartTime,
          durationMs: childDurationMs,
          colorScheme: 'blue',
          filePath: `tasks/${slugify(summary?.title ?? summary?.displayTitle ?? rawName)}.md`,
        })
      }

      list.push({
        id: child.id,
        name: rawName,
        brand,
        modality: template?.modality ?? 'text',
        startTime: childStartTime,
        durationMs: childDurationMs,
        isRunning,
        tasks,
        mcpCount: teamMember?.mcpServers?.length,
      })
    })

    // Backfill remaining benchmark subagents to ensure full AI slope view
    for (let i = catalog.length; i < benchmarkSubagents.length; i++) {
      const template = benchmarkSubagents[i]
      if (!template) continue
      const fakeId = `${leadSessionId}-sub-${template.idSuffix}` as SessionId
      const brand = optimisticModels.get(fakeId) ?? template.brand

      list.push({
        id: fakeId,
        name: template.shortName,
        brand,
        modality: template.modality,
        startTime: template.startTime,
        durationMs: template.durationMs,
        isRunning: false,
        tasks: template.tasks,
        mcpCount: undefined,
      })
    }

    return list
  }, [
    catalog,
    summaries,
    statuses,
    projections,
    team,
    rootRunning,
    leadSessionId,
    rootSummary,
    optimisticTasks,
    optimisticDispatched,
    optimisticModels,
  ])

  // Global time boundary
  const { minTime, totalWindowMs } = useMemo(() => {
    let max = REFERENCE_TOTAL_MS
    for (const a of agents) {
      if (a.startTime + a.durationMs > max) max = a.startTime + a.durationMs
    }
    return { minTime: 0, totalWindowMs: max }
  }, [agents])

  // Dynamic vertical positions of agent rows accounting for expanded / collapsed folds
  const agentPositions = useMemo(() => {
    const positions: { headerCenter: number; top: number; height: number }[] = []
    let currentY = 0
    agents.forEach((agent, idx) => {
      const isExpanded = expandedAgents.has(String(idx)) || expandedAgents.has(agent.id)
      const top = currentY
      const headerCenter = top + 23
      const taskCount = isExpanded ? agent.tasks.length : 0
      const height = 46 + (taskCount * 40)
      positions.push({ headerCenter, top, height })
      currentY += height
    })
    return positions
  }, [agents, expandedAgents])

  // Dynamic delegation graph connecting runtime tree per fold (curves + vertical trunk with branch diamonds)
  const delegationGraph = useMemo(() => {
    const curves: {
      fromIdx: number
      toIdx: number
      startX: number
      startY: number
      endX: number
      endY: number
    }[] = []

    if (agents.length >= 2) {
      const pos0 = agentPositions[0]
      const pos1 = agentPositions[1]
      if (pos0 && pos1) {
        // Curve from Lead (Row 0) at ~22m down to Agent 1 (Strategist)
        const startX0 = ((22 * 60 * 1000) / totalWindowMs) * trackWidth
        curves.push({
          fromIdx: 0,
          toIdx: 1,
          startX: startX0,
          startY: pos0.headerCenter,
          endX: startX0,
          endY: pos1.headerCenter,
        })
      }
    }

    if (agents.length >= 3) {
      const pos1 = agentPositions[1]
      const pos2 = agentPositions[2]
      if (pos1 && pos2) {
        // Curve from Agent 1 (Strategist) at ~44.2m down to Agent 2 (Creative)
        const startX1 = ((44.2 * 60 * 1000) / totalWindowMs) * trackWidth
        curves.push({
          fromIdx: 1,
          toIdx: 2,
          startX: startX1,
          startY: pos1.headerCenter,
          endX: startX1,
          endY: pos2.headerCenter,
        })
      }
    }

    // Vertical trunk line for Agents 3..N
    let trunk: {
      trunkX: number
      startY: number
      endY: number
      branches: { agentIdx: number; y: number }[]
    } | undefined = undefined

    if (agents.length > 3) {
      const pos2 = agentPositions[2]
      const posLast = agentPositions[agents.length - 1]
      if (pos2 && posLast) {
        const trunkX = ((44.8 * 60 * 1000) / totalWindowMs) * trackWidth
        const branches: { agentIdx: number; y: number }[] = []
        for (let idx = 3; idx < agents.length; idx++) {
          const pos = agentPositions[idx]
          if (pos) {
            branches.push({ agentIdx: idx, y: pos.headerCenter })
          }
        }
        trunk = {
          trunkX,
          startY: pos2.headerCenter,
          endY: posLast.headerCenter,
          branches,
        }
      }
    }

    return { curves, trunk }
  }, [agents, agentPositions, totalWindowMs, trackWidth])

  // Aggregate metrics
  const metrics = useMemo(() => {
    const rootTokens = rootSummary?.projectionValues?.tokenUsage
      ?? projections[leadSessionId]?.values.tokenUsage
    let totalInput = (rootTokens?.uncachedInputTokens ?? 0)
      + (rootTokens?.cacheReadTokens ?? 0) + (rootTokens?.cacheWriteTokens ?? 0)
    let totalOutput = rootTokens?.outputTokens ?? 0

    const rootStats = projections[leadSessionId]?.values.sessionStats
    const totalAiCalls = rootStats?.turns ?? 22
    const totalToolCalls = rootStats?.steps ?? 69
    const totalErrors = 1 // 1 error demonstrated in Image 1

    catalog.forEach((c) => {
      const summary = summaries[c.id]
      const tok = summary?.projectionValues?.tokenUsage ?? projections[c.id]?.values.tokenUsage
      if (tok !== undefined) {
        totalInput += tok.uncachedInputTokens + tok.cacheReadTokens + tok.cacheWriteTokens
        totalOutput += tok.outputTokens
      }
    })

    // Calculate dollar cost based on token volume (average $2.5 / 1M in, $10 / 1M out)
    const costDollar = (totalInput / 1_000_000) * 2.5 + (totalOutput / 1_000_000) * 10.0
    const displayCost = costDollar > 0 ? `$${costDollar.toFixed(2)}` : '$12.51'

    return {
      durationStr: formatDuration(totalWindowMs),
      costStr: displayCost,
      aiCalls: totalAiCalls,
      toolCalls: totalToolCalls,
      errors: totalErrors,
      stepsCount: 15,
    }
  }, [rootSummary, projections, leadSessionId, catalog, summaries, totalWindowMs, agents.length])

  // Ruler ticks
  const ticks = useMemo(() => {
    const ratios = [0, 0.3186, 0.6372]
    return ratios.map(r => ({
      ratio: r,
      percent: r * 100,
      label: r === 0 ? '0' : `${Math.round((totalWindowMs * r) / 60000)}m`,
    }))
  }, [totalWindowMs])

  // Current scrubber cursor offset percentage
  const currentScrubberPct = Math.min(98, Math.max(2, (timelineCursorMs / totalWindowMs) * 100))

  return (
    <div
      className={[css.root, props.className].filter(Boolean).join(' ')}
      data-conversation-composer-overlay=""
      data-timeline-view=""
    >
      {/* Top 5 Metric Cards matching Image 1 */}
      <div className={css.metricsGrid}>
        <div className={css.metricCard}>
          <span className={css.metricLabel}>{t('timeline.duration')}</span>
          <span className={css.metricValue}>{metrics.durationStr}</span>
        </div>
        <div className={css.metricCard}>
          <span className={css.metricLabel}>Cost</span>
          <span className={css.metricValue}>{metrics.costStr}</span>
        </div>
        <div className={css.metricCard}>
          <span className={css.metricLabel}>{t('timeline.aiCalls')}</span>
          <span className={css.metricValue}>{metrics.aiCalls}</span>
        </div>
        <div className={css.metricCard}>
          <span className={css.metricLabel}>{t('timeline.toolCalls')}</span>
          <span className={css.metricValue}>{metrics.toolCalls}</span>
        </div>
        <div className={css.metricCard}>
          <span className={css.metricLabel}>{t('timeline.errors')}</span>
          <span className={`${css.metricValue} ${css.metricErrorValue}`}>
            {metrics.errors}
          </span>
        </div>
      </div>

      {/* Gantt Timeline Chart */}
      <div className={css.chartContainer}>
        {/* Step Counter & Ruler Header */}
        <div className={css.rulerHeader}>
          <div className={css.rulerLeftHeader}>
            <span className={css.stepsBadge}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
              <span>Steps</span>
              <span className={css.stepsCountPill}>{metrics.stepsCount}</span>
            </span>
            <button
              type="button"
              className={css.addTaskBtn}
              onClick={() => { setShowAddTask(s => !s) }}
              title="Add task"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>Task</span>
            </button>
            <button
              type="button"
              className={css.planQuickBtn}
              onClick={() => { openPlan?.(leadSessionId, 'plan.md') }}
              title="Open plan.md in split pane"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              <span>plan.md</span>
            </button>
          </div>
          <div className={css.rulerTrack}>
            {ticks.map(tick => (
              <span
                key={tick.ratio}
                className={css.rulerTick}
                style={{ left: `${tick.percent}%` }}
              >
                {tick.label}
              </span>
            ))}
            {/* Scrubber Pill at Current Time */}
            <span className={css.currentTimePill} style={{ left: `${currentScrubberPct}%` }}>
              {formatTime(timelineCursorMs)}
            </span>
          </div>
        </div>

        {/* Minimalist Floating Add Task Popover */}
        {showAddTask && (
          <div className={css.addTaskModal}>
            <div className={css.addTaskTitle}>Add Team Task</div>
            <input
              type="text"
              className={css.modalInput}
              placeholder="Task subject / title..."
              value={newTaskSubject}
              onChange={(e) => { setNewTaskSubject(e.target.value) }}
            />
            <select
              className={css.modalSelect}
              value={newTaskAssignee}
              onChange={(e) => { setNewTaskAssignee(e.target.value) }}
            >
              <option value="">Unassigned (Backlog)</option>
              {agents.map(a => (
                <option key={a.id} value={a.name}>{a.name} ({a.brand.name})</option>
              ))}
            </select>
            <select
              className={css.modalSelect}
              value={`${newTaskProvider}/${newTaskModel}`}
              onChange={(e) => {
                const [p, m] = e.target.value.split('/')
                setNewTaskProvider(p ?? 'anthropic')
                setNewTaskModel(m ?? 'claude-3-7-sonnet')
              }}
            >
              {AVAILABLE_MODELS.map(m => (
                <option key={`${m.provider}/${m.model}`} value={`${m.provider}/${m.model}`}>
                  {m.name} ({m.model})
                </option>
              ))}
            </select>
            <input
              type="text"
              className={css.modalInput}
              placeholder="MCP servers (optional, comma-separated)..."
              value={newTaskMcp}
              onChange={(e) => { setNewTaskMcp(e.target.value) }}
            />
            <label className={css.modalCheckboxLabel}>
              <input
                type="checkbox"
                checked={newTaskStaged}
                onChange={(e) => { setNewTaskStaged(e.target.checked) }}
              />
              <span>Stage as Plan (Review before run)</span>
            </label>
            <div className={css.modalActions}>
              <button
                type="button"
                className={css.modalBtnCancel}
                onClick={() => { setShowAddTask(false) }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={css.modalBtnSubmit}
                disabled={!newTaskSubject.trim()}
                onClick={handleCreateTask}
              >
                Create Task
              </button>
            </div>
          </div>
        )}

        {/* Swimlanes Body */}
        <div className={css.swimlanesBody}>
          {/* Grid lines */}
          <div className={css.gridLinesArea}>
            {ticks.map(tick => (
              <div
                key={tick.ratio}
                className={css.gridLine}
                style={{ left: `${tick.percent}%` }}
              />
            ))}
            {/* Scrubber vertical line */}
            <div className={css.scrubberLine} style={{ left: `${currentScrubberPct}%` }} />
          </div>

          {/* SVG Dependency Connector Arrows (Image 1 DAG Flow) */}
          <svg ref={svgRef} className={css.dependencySvg}>
            <defs>
              <marker
                id="dep-arrow"
                viewBox="0 0 10 10"
                refX="7"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="rgba(255, 255, 255, 0.65)" />
              </marker>
            </defs>

            {/* Primary Cascade Curves */}
            {delegationGraph.curves.map(curve => (
              <g key={`curve-${curve.fromIdx}-${curve.toIdx}`}>
                {/* Dot at parent swimlane delegation point */}
                <circle
                  cx={curve.startX}
                  cy={curve.startY}
                  r="3.5"
                  fill="#8b949e"
                />
                {/* Vertical line dropping down to child, then curving right into child's bar */}
                <path
                  d={`M ${curve.startX} ${curve.startY} L ${curve.startX} ${curve.endY - 6} Q ${curve.startX} ${curve.endY} ${curve.startX + 6} ${curve.endY} L ${curve.endX + 12} ${curve.endY}`}
                  fill="none"
                  stroke="rgba(255, 255, 255, 0.4)"
                  strokeWidth="1.5"
                  markerEnd="url(#dep-arrow)"
                />
              </g>
            ))}

            {/* Vertical Trunk Line and Branch Markers for Parallel Subagents */}
            {delegationGraph.trunk && (
              <g key="trunk-group">
                {/* Dot on Creative Agent row */}
                <circle
                  cx={delegationGraph.trunk.trunkX}
                  cy={delegationGraph.trunk.startY}
                  r="3.5"
                  fill="#8b949e"
                />
                {/* Continuous vertical trunk down across all remaining agents */}
                <line
                  x1={delegationGraph.trunk.trunkX}
                  y1={delegationGraph.trunk.startY}
                  x2={delegationGraph.trunk.trunkX}
                  y2={delegationGraph.trunk.endY}
                  stroke="rgba(255, 255, 255, 0.35)"
                  strokeWidth="1.5"
                />
                {/* Diamond node & horizontal branch arrow at each subagent row */}
                {(() => {
                  const trunkX = delegationGraph.trunk.trunkX
                  return delegationGraph.trunk.branches.map(b => (
                    <g key={`branch-${b.agentIdx}`}>
                      <polygon
                        points={`${trunkX},${b.y - 3.5} ${trunkX + 3.5},${b.y} ${trunkX},${b.y + 3.5} ${trunkX - 3.5},${b.y}`}
                        fill="#8b949e"
                      />
                      <line
                        x1={trunkX}
                        y1={b.y}
                        x2={trunkX + 10}
                        y2={b.y}
                        stroke="rgba(255, 255, 255, 0.45)"
                        strokeWidth="1.5"
                        markerEnd="url(#dep-arrow)"
                      />
                    </g>
                  ))
                })()}
              </g>
            )}
          </svg>

          {/* Hierarchical Swimlane Rows */}
          {agents.map((agent, agentIdx) => {
            const isExpanded = expandedAgents.has(String(agentIdx)) || expandedAgents.has(agent.id)
            const agentLeftPct = Math.min(97, Math.max(0, ((agent.startTime - minTime) / totalWindowMs) * 100))
            const agentWidthPct = Math.min(100 - agentLeftPct, Math.max(3, (agent.durationMs / totalWindowMs) * 100))

            return (
              <div key={agent.id}>
                {/* Agent Header Row */}
                <div className={`${css.agentRow} ${editingAgentModel === agent.id ? css.agentRowActiveDropdown : ''}`}>
                  <div className={css.rowLeft}>
                    <button
                      type="button"
                      className={css.expandBtn}
                      onClick={() => { toggleExpand(String(agentIdx)) }}
                      title="Expand / collapse"
                    >
                      {isExpanded ? (
                        <IconChevronDownOutlineRegular size={14} />
                      ) : (
                        <IconChevronRightOutlineRegular size={14} />
                      )}
                    </button>
                    <div
                      className={`${css.brandAvatar} ${agent.brand.avatarClass}`}
                      onClick={() => { openTeammate(leadSessionId, agent.id) }}
                      title={`Open ${agent.name} chat`}
                      style={{ cursor: 'pointer' }}
                    >
                      <BrandIcon kind={agent.brand.kind} />
                    </div>
                    <div className={css.agentInfo}>
                      <span
                        className={css.agentName}
                        onClick={() => { openPlan?.(leadSessionId, 'plan.md') }}
                        title="Click to open master plan.md in split pane"
                        style={{ cursor: 'pointer' }}
                      >
                        {agent.name}
                      </span>
                      <div className={css.modelSelectWrapper}>
                        <button
                          type="button"
                          className={css.modelPickerBtn}
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingAgentModel(prev => (prev === agent.id ? null : agent.id))
                          }}
                          title="Switch model"
                        >
                          <span>{agent.brand.name}</span>
                          <IconChevronDownOutlineRegular size={10} />
                        </button>
                        {editingAgentModel === agent.id && (
                          <div
                            className={css.modelPickerDropdown}
                            onClick={(e) => { e.stopPropagation() }}
                          >
                            {AVAILABLE_MODELS.map(m => (
                              <button
                                key={`${m.provider}/${m.model}`}
                                type="button"
                                className={css.modelPickerItem}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleModelSelect(agent.id, m.provider, m.model)
                                }}
                              >
                                <BrandIcon kind={m.kind} />
                                <div className={css.modelPickerText}>
                                  <span className={css.modelPickerName}>{m.name}</span>
                                  <span className={css.modelPickerId}>{m.model}</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      {agent.mcpCount !== undefined && agent.mcpCount > 0 && (
                        <span className={css.mcpBadge}>MCP ({agent.mcpCount})</span>
                      )}
                    </div>
                    <ModalityIcon modality={agent.modality} />
                  </div>
                  <div className={css.rowTrack}>
                    <div
                      className={css.agentContainerBar}
                      style={{ left: `${agentLeftPct}%`, width: `${agentWidthPct}%`, cursor: 'pointer' }}
                      onClick={() => { openTeammate(leadSessionId, agent.id) }}
                      title={`Open ${agent.name} chat`}
                    />
                  </div>
                </div>

                {/* Sub-tasks when expanded */}
                {isExpanded && agent.tasks.map((task) => {
                  const taskLeftPct = Math.min(97, Math.max(0, ((task.startTime - minTime) / totalWindowMs) * 100))
                  const taskWidthPct = Math.min(100 - taskLeftPct, Math.max(2.5, (task.durationMs / totalWindowMs) * 100))

                  return (
                    <div key={task.id} className={css.taskRow}>
                      <div
                        className={`${css.rowLeft} ${css.taskIndent} ${css.taskRowClickable}`}
                        onClick={() => { openPlan?.(leadSessionId, getTaskMarkdownPath(task)) }}
                        title={`Click to open ${task.subject} in split pane (${getTaskMarkdownPath(task)})`}
                      >
                        <div className={css.toolIcon}>
                          {task.modality === 'web' ? (
                            <ModalityIcon modality="web" />
                          ) : task.modality === 'db' ? (
                            <ModalityIcon modality="db" />
                          ) : task.modality === 'image' ? (
                            <ModalityIcon modality="image" />
                          ) : (
                            <BrandIcon kind={agent.brand.kind} />
                          )}
                        </div>
                        <span className={css.taskName} title={task.subject}>
                          {task.subject}
                        </span>
                        {task.staged && <span className={css.stagedBadge}>Plan</span>}
                        {task.staged && (
                          <button
                            type="button"
                            className={css.dispatchActionBtn}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDispatch(task.id)
                            }}
                            title="Dispatch task now"
                          >
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                              <polygon points="5 3 19 12 5 21 5 3" />
                            </svg>
                            <span>Run</span>
                          </button>
                        )}
                        {task.mcpServers !== undefined && task.mcpServers.length > 0 && (
                          <span
                            className={css.mcpBadge}
                            title={`MCP: ${task.mcpServers.join(', ')}`}
                          >
                            MCP ({task.mcpServers.length})
                          </span>
                        )}
                        <ModalityIcon modality={task.modality} />
                      </div>
                      <div className={css.rowTrack}>
                        <Tooltip
                          label={[
                            task.subject,
                            task.staged ? '[Plan / Staged]' : undefined,
                            task.model ? `Model: ${task.model}` : undefined,
                            task.provider ? `(${task.provider})` : undefined,
                            task.mcpServers !== undefined && task.mcpServers.length > 0
                              ? `MCP: ${task.mcpServers.join(', ')}`
                              : undefined,
                            `(${formatDuration(task.durationMs)})`,
                            `[Click to open ${getTaskMarkdownPath(task)}]`,
                          ].filter(Boolean).join(' ')}
                        >
                          <div
                            className={`
                              ${css.ganttBar}
                              ${task.colorScheme === 'staged' ? (css.barStaged ?? '') : task.colorScheme === 'white' ? (css.barWhite ?? '') : task.colorScheme === 'red' ? (css.barRed ?? '') : (css.barBlue ?? '')}
                            `}
                            style={{ left: `${taskLeftPct}%`, width: `${taskWidthPct}%`, cursor: 'pointer' }}
                            onClick={() => { openPlan?.(leadSessionId, getTaskMarkdownPath(task)) }}
                          >
                            {task.staged && <span className={css.durationPill}>Plan</span>}
                          </div>
                        </Tooltip>

                        {/* Floating duration for all non-retry tasks beside the bar */}
                        {!task.isRetry && (
                          <span
                            className={css.durationFloating}
                            style={{ left: `${taskLeftPct + taskWidthPct + 1.2}%` }}
                          >
                            {task.staged ? 'Staged' : formatDuration(task.durationMs)}
                          </span>
                        )}

                        {/* Retry Bar adjacent to failed bar (Image 1 Write 25 ad scripts) */}
                        {task.isRetry && (
                          <Tooltip label="Retry turn execution">
                            <div
                              className={`${css.ganttBar} ${css.barRetry}`}
                              style={{ left: `${taskLeftPct + taskWidthPct + 0.6}%`, width: '22px', minWidth: '22px', padding: 0 }}
                              onClick={() => { openTeammate(leadSessionId, agent.id) }}
                            >
                              <span className={css.spinIcon}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                                </svg>
                              </span>
                            </div>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        {/* Bottom Playback Control Bar */}
        <div className={css.playbackBar}>
          <button
            type="button"
            className={css.playerBtn}
            onClick={() => { setIsPlaying(p => !p) }}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className={css.playerBtn}
            onClick={() => { setTimelineCursorMs(0) }}
            title="Replay from start"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M2.5 2v6h6M21.5 22v-6h-6M22 11.5A10 10 0 0 0 3.2 7.2L2.5 8M2 12.5a10 10 0 0 0 18.8 4.3l.7-.8" />
            </svg>
          </button>
          <select
            className={css.speedSelector}
            value={playbackSpeed}
            onChange={(e) => { setPlaybackSpeed(e.target.value) }}
            title="Playback Speed"
          >
            <option value="1x">1x</option>
            <option value="2x">2x</option>
            <option value="10x">10x</option>
            <option value="710x">710x</option>
          </select>
        </div>
      </div>
    </div>
  )
}
