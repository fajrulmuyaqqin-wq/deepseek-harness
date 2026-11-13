/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * Model catalogs above four entries show search, which retains focus while
 * ↑/↓ cycle the highlighted result; Enter and Tab accept it. Smaller model
 * catalogs, root panes, and effort panes move focus between rows. Escape and Shift+Tab leave a drilled pane first and otherwise close
 * back to the trigger. A drilled pane focuses the current effort or model
 * search field. Provider headings paint their background only while pinned
 * by scrolling. Clearing a query restores the full list and search focus.
 * Selecting restores trigger focus without a ring until the trigger loses focus
 * or the menu reopens. Mobile devices restore button focus when opening or
 * drilling; model search takes focus only after explicit user input.
 * Model names match a case-insensitive ordered subsequence
 * within each provider group, ranked by
 * prefix, alignment score, then catalog order. Returning to the root pane
 * hands focus back to the cell that opened it. Data and submission ride the
 * same per-session ModelDirectory as the /model popup; exact-model reasoning
 * metadata and the selected effort come from the Host rather than a
 * client-owned vocabulary. A rejected selection announces through the shared
 * transient Toast anchored to the composer card; the in-menu strip with
 * Retry remains the catalog-load surface. While the directory's pending
 * selection is unsettled, the trigger shows a spinner in place of its
 * chevron, and each row whose value that selection carries shows one in place
 * of its check mark.
 */
import { MenuGroup, MenuSurface, observeStickyMenuGroups } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseFillRegular,
  IconCodeOutlineRegular,
  IconDataOutlineRegular,
  IconSettingsOutlineRegular,
  IconWarningOutlineRegular,
  Input,
  isMobileDevice,
  rankByName,
  StateDot,
  Tag,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelLabelOwner, ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'
import { orderModelProviders } from './provider-order.ts'

/** Which pane the dropdown shows: the two-row root or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort' | 'agent-cli'

/** CliAgent metadata from /api/agent-runner/agents */
interface CliAgentInfo {
  readonly id: string
  readonly name: string
  readonly bin: string
  readonly installed?: boolean
  readonly version?: string
  readonly supportsAcp?: boolean
}

interface AgentListApiResponse {
  readonly ok?: boolean
  readonly agents?: readonly CliAgentInfo[]
}

const DEFAULT_CLI_AGENTS: readonly CliAgentInfo[] = [
  { id: 'agy', name: 'Google Antigravity', bin: 'agy', version: 'v1.5.5' },
  { id: 'claude', name: 'Claude Code', bin: 'claude', version: 'v2.1.322' },
  { id: 'codex', name: 'OpenAI Codex', bin: 'codex', version: 'v0.167.2' },
  { id: 'opencode', name: 'OpenCode CLI', bin: 'opencode', version: 'v2.2.7' },
  { id: 'cursor-agent', name: 'Cursor Agent', bin: 'cursor-agent', version: 'v2026.11' },
]

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
}

/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

interface ParsedCliModelInfo {
  readonly id: string
  readonly cliArg: string
  readonly displayLabel: string
  readonly badge?: string
}

function parseCliModel(
  agentId: string,
  modelId: string = 'byok',
  byokChoice?: { providerId: string; modelId: string; modelName?: string },
): ParsedCliModelInfo {
  if (modelId === 'byok') {
    if (!byokChoice) {
      return { id: 'byok', cliArg: 'default', displayLabel: 'Model BYOK (Parsed ke CLI)' }
    }
    const { providerId, modelId: bModelId, modelName } = byokChoice
    const name = modelName || bModelId

    if (agentId === 'opencode') {
      const cleanArg = bModelId.includes('/') ? bModelId : `${providerId}/${bModelId}`
      return {
        id: 'byok',
        cliArg: cleanArg,
        displayLabel: `${name} (Parsed ke CLI)`,
        badge: cleanArg,
      }
    }

    if (agentId === 'agy') {
      let mapped = 'gpt-oss-120b-medium'
      const mLow = bModelId.toLowerCase()
      const pLow = providerId.toLowerCase()
      if (pLow === 'google' || mLow.includes('gemini') || mLow.includes('flash')) {
        mapped = 'gemini-3.8-flash-high'
      } else if (pLow === 'anthropic' || mLow.includes('claude')) {
        mapped = 'claude-sonnet-4-6'
      }
      return {
        id: 'byok',
        cliArg: mapped,
        displayLabel: `${name} (Parsed: ${mapped})`,
        badge: mapped,
      }
    }

    if (agentId === 'claude') {
      let mapped = 'sonnet'
      const mLow = bModelId.toLowerCase()
      if (mLow.includes('opus')) mapped = 'opus'
      else if (mLow.includes('haiku')) mapped = 'haiku'
      return {
        id: 'byok',
        cliArg: mapped,
        displayLabel: `${name} (Parsed: ${mapped})`,
        badge: mapped,
      }
    }

    if (agentId === 'codex') {
      let mapped = 'gpt-4o'
      const mLow = bModelId.toLowerCase()
      if (mLow.includes('o3') || mLow.includes('mini') || mLow.includes('reasoning')) mapped = 'o3-mini'
      return {
        id: 'byok',
        cliArg: mapped,
        displayLabel: `${name} (Parsed: ${mapped})`,
        badge: mapped,
      }
    }

    return {
      id: 'byok',
      cliArg: bModelId,
      displayLabel: `${name} (Parsed ke CLI)`,
      badge: bModelId,
    }
  }

  if (modelId === 'default') {
    return { id: 'default', cliArg: 'default', displayLabel: 'Default Model (CLI Auto)' }
  }

  // Predefined models for opencode
  if (agentId === 'opencode') {
    if (modelId === 'opencode-go') return { id: 'opencode-go', cliArg: 'opencode-go', displayLabel: 'OpenCode Go', badge: 'Official' }
    if (modelId === 'opencode') return { id: 'opencode', cliArg: 'opencode', displayLabel: 'OpenCode Console', badge: 'Console' }
    if (modelId === 'openai/gpt-4o') return { id: 'openai/gpt-4o', cliArg: 'openai/gpt-4o', displayLabel: 'OpenAI GPT-4o', badge: 'openai' }
    if (modelId === 'openai/o3-mini') return { id: 'openai/o3-mini', cliArg: 'openai/o3-mini', displayLabel: 'OpenAI o3-mini', badge: 'openai' }
    if (modelId === 'anthropic/claude-3-5-sonnet') return { id: 'anthropic/claude-3-5-sonnet', cliArg: 'anthropic/claude-3-5-sonnet', displayLabel: 'Claude 3.5 Sonnet', badge: 'anthropic' }
    if (modelId === 'google/gemini-2.5-pro') return { id: 'google/gemini-2.5-pro', cliArg: 'google/gemini-2.5-pro', displayLabel: 'Gemini 2.5 Pro', badge: 'google' }
    if (modelId === 'github-copilot') return { id: 'github-copilot', cliArg: 'github-copilot', displayLabel: 'GitHub Copilot', badge: 'copilot' }
    if (modelId === 'deepseek/deepseek-chat') return { id: 'deepseek/deepseek-chat', cliArg: 'deepseek/deepseek-chat', displayLabel: 'DeepSeek Chat', badge: 'deepseek' }
  }

  // Predefined models for agy
  if (agentId === 'agy') {
    if (modelId === 'gemini-3.8-flash-high') return { id: 'gemini-3.8-flash-high', cliArg: 'gemini-3.8-flash-high', displayLabel: 'Gemini 3.8 Flash (High)', badge: 'Google' }
    if (modelId === 'gemini-3.8-flash-medium') return { id: 'gemini-3.8-flash-medium', cliArg: 'gemini-3.8-flash-medium', displayLabel: 'Gemini 3.8 Flash (Med)', badge: 'Google' }
    if (modelId === 'gemini-3.8-flash-low') return { id: 'gemini-3.8-flash-low', cliArg: 'gemini-3.8-flash-low', displayLabel: 'Gemini 3.8 Flash (Low)', badge: 'Google' }
    if (modelId === 'gemini-3.8-pro') return { id: 'gemini-3.8-pro', cliArg: 'gemini-3.8-pro', displayLabel: 'Gemini 3.8 Pro', badge: 'Google' }
    if (modelId === 'claude-sonnet-4-6') return { id: 'claude-sonnet-4-6', cliArg: 'claude-sonnet-4-6', displayLabel: 'Claude Sonnet 4.6 (Thinking)', badge: 'Anthropic' }
    if (modelId === 'claude-opus-4-6-thinking') return { id: 'claude-opus-4-6-thinking', cliArg: 'claude-opus-4-6-thinking', displayLabel: 'Claude Opus 4.6 (Thinking)', badge: 'Anthropic' }
    if (modelId === 'gpt-oss-120b-medium') return { id: 'gpt-oss-120b-medium', cliArg: 'gpt-oss-120b-medium', displayLabel: 'GPT-OSS 120B (Medium)', badge: 'OpenAI' }
  }

  // Predefined models for claude
  if (agentId === 'claude') {
    if (modelId === 'sonnet') return { id: 'sonnet', cliArg: 'sonnet', displayLabel: 'Claude 3.7 Sonnet', badge: 'Anthropic' }
    if (modelId === 'opus') return { id: 'opus', cliArg: 'opus', displayLabel: 'Claude 3.5 Opus', badge: 'Anthropic' }
    if (modelId === 'haiku') return { id: 'haiku', cliArg: 'haiku', displayLabel: 'Claude 3.5 Haiku', badge: 'Anthropic' }
  }

  // Predefined models for codex
  if (agentId === 'codex') {
    if (modelId === 'gpt-4o') return { id: 'gpt-4o', cliArg: 'gpt-4o', displayLabel: 'GPT-4o', badge: 'OpenAI' }
    if (modelId === 'o3-mini') return { id: 'o3-mini', cliArg: 'o3-mini', displayLabel: 'o3-mini', badge: 'OpenAI' }
  }

  if (byokChoice) {
    return parseCliModel(agentId, 'byok', byokChoice)
  }
  return { id: modelId, cliArg: modelId, displayLabel: modelId }
}

interface CliModelOption {
  readonly id: string
  readonly label: string
  readonly badge?: string | undefined
  readonly desc?: string | undefined
  readonly isParsedByok?: boolean | undefined
}

function getAvailableCliModels(
  agentId: string,
  byokChoice?: { providerId: string; modelId: string; modelName?: string },
): readonly CliModelOption[] {
  const byokParsed = parseCliModel(agentId, 'byok', byokChoice)
  const list: CliModelOption[] = [
    {
      id: 'byok',
      label: byokChoice ? `Gunakan Model BYOK: ${byokChoice.modelName || byokChoice.modelId}` : 'Gunakan Model BYOK',
      badge: 'Parsed ke CLI',
      desc: byokChoice ? `--model ${byokParsed.cliArg}` : undefined,
      isParsedByok: true,
    },
  ]

  if (agentId === 'opencode') {
    list.push(
      { id: 'opencode-go', label: 'OpenCode Go', badge: 'Official', desc: 'API Khusus OpenCode Go' },
      { id: 'opencode', label: 'OpenCode Console', badge: 'Console', desc: 'Akun / Service Account' },
      { id: 'openai/gpt-4o', label: 'OpenAI GPT-4o', badge: 'openai', desc: '--model openai/gpt-4o' },
      { id: 'anthropic/claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', badge: 'anthropic', desc: '--model anthropic/claude-3-5-sonnet' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', badge: 'google', desc: '--model google/gemini-2.5-pro' },
      { id: 'default', label: 'Default Model (CLI Auto)', badge: 'CLI' },
    )
  } else if (agentId === 'agy') {
    list.push(
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', badge: 'Google', desc: '--model gemini-3.8-flash-high' },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Med)', badge: 'Google', desc: '--model gemini-3.8-flash-medium' },
      { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', badge: 'Google', desc: '--model gemini-3.8-flash-low' },
      { id: 'gemini-3.8-pro', label: 'Gemini 3.8 Pro', badge: 'Google', desc: '--model gemini-3.8-pro' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', badge: 'Anthropic', desc: '--model claude-sonnet-4-6' },
      { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', badge: 'Anthropic', desc: '--model claude-opus-4-6-thinking' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', badge: 'OpenAI', desc: '--model gpt-oss-120b-medium' },
      { id: 'default', label: 'Default Model (dari CLI)', badge: 'CLI' },
    )
  } else if (agentId === 'claude') {
    list.push(
      { id: 'sonnet', label: 'Claude 3.7 Sonnet', badge: 'Anthropic', desc: '--model sonnet' },
      { id: 'opus', label: 'Claude 3.5 Opus', badge: 'Anthropic', desc: '--model opus' },
      { id: 'haiku', label: 'Claude 3.5 Haiku', badge: 'Anthropic', desc: '--model haiku' },
      { id: 'default', label: 'Default (Claude Sonnet 3.7)', badge: 'CLI' },
    )
  } else if (agentId === 'codex') {
    list.push(
      { id: 'gpt-4o', label: 'GPT-4o', badge: 'OpenAI', desc: '--model gpt-4o' },
      { id: 'o3-mini', label: 'o3-mini', badge: 'OpenAI', desc: '--model o3-mini' },
      { id: 'default', label: 'Default Codex', badge: 'CLI' },
    )
  } else {
    list.push({ id: 'default', label: 'Default Model (dari CLI)', badge: 'CLI' })
  }

  return list
}

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, resolveText, t, renderSlot }:
  ModelSelectInjected & Pick<PropsRuntime<'conversation.input.model'>, 'locked'> & PropsLocale<'model'>
    & Omit<PropsRenderSlots<'conversation.input.model.label'>, 'SessionProvider'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null)
  const [selectionFocus, setSelectionFocus] = useState(false)
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const groupsRef = useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const [cliAgents, setCliAgents] = useState<readonly CliAgentInfo[]>(DEFAULT_CLI_AGENTS)
  const [activeCliAgent, setActiveCliAgent] = useState<string | null>(() => {
    try {
      return localStorage.getItem('dsh_active_cli_agent')
    } catch {
      return null
    }
  })
  const [activeTab, setActiveTab] = useState<'cli' | 'byok'>(() => {
    try {
      const stored = localStorage.getItem('dsh_model_mode')
      return stored === 'byok' ? 'byok' : 'cli'
    } catch {
      return 'cli'
    }
  })
  const [activeCliModel, setActiveCliModel] = useState<string>(() => {
    try {
      return localStorage.getItem('dsh_active_cli_model') || 'byok'
    } catch {
      return 'byok'
    }
  })
  const [showAgentSettingsModal, setShowAgentSettingsModal] = useState(false)

  useEffect(() => {
    let mounted = true
    if (typeof fetch === 'function') {
      fetch('/api/agent-runner/agents')
        .then(async (res): Promise<AgentListApiResponse | undefined> => {
          if (!res.ok) return undefined
          return (await res.json()) as AgentListApiResponse
        })
        .then((data) => {
          if (mounted && data?.ok === true && Array.isArray(data.agents) && data.agents.length > 0) {
            const list: readonly CliAgentInfo[] = data.agents
            setCliAgents(list)
            setActiveCliAgent((prev) => {
              if (prev !== null) return prev
              const stored = localStorage.getItem('dsh_active_cli_agent')
              const fallback: string = list[0]?.id ?? 'agy'
              return stored !== null && stored.length > 0 ? stored : fallback
            })
          }
        })
        .catch(() => {})
    }
    const handleCliChanged = (event: Event) => {
      const custom = event as CustomEvent<{ agent: string }>
      if (custom.detail.agent) {
        setActiveCliAgent(custom.detail.agent)
      }
    }
    const handleCliModelChanged = (event: Event) => {
      const custom = event as CustomEvent<{ model: string }>
      if (custom.detail.model) {
        setActiveCliModel(custom.detail.model)
      }
    }
    const handleModeChanged = (event: Event) => {
      const custom = event as CustomEvent<{ mode: 'cli' | 'byok' }>
      setActiveTab(custom.detail.mode)
    }
    window.addEventListener('dsh:agent-cli-changed', handleCliChanged)
    window.addEventListener('dsh:agent-cli-model-changed', handleCliModelChanged)
    window.addEventListener('dsh:model-mode-changed', handleModeChanged)
    return () => {
      mounted = false
      window.removeEventListener('dsh:agent-cli-changed', handleCliChanged)
      window.removeEventListener('dsh:agent-cli-model-changed', handleCliModelChanged)
      window.removeEventListener('dsh:model-mode-changed', handleModeChanged)
    }
  }, [])

  useEffect(() => {
    if (state.current) {
      const cliProviders = ['agy', 'opencode', 'claude', 'codex', 'cursor-agent']
      if (cliProviders.includes(state.current.provider)) {
        setActiveTab('cli')
        setActiveCliAgent(state.current.provider)
        setActiveCliModel(state.current.model)
        try {
          localStorage.setItem('dsh_model_mode', 'cli')
          localStorage.setItem('dsh_active_cli_agent', state.current.provider)
          localStorage.setItem('dsh_active_cli_model', state.current.model)
        } catch {}
      }
    }
  }, [state.current])

  const activeAgent = activeCliAgent !== null ? cliAgents.find(a => a.id === activeCliAgent) : undefined

  const openCliSettings = (): void => {
    setOpen(false)
    setShowAgentSettingsModal(true)
  }

  const accountProviderName = t('provider.account')
  const groups = useMemo(() => orderModelProviders(state.groups).map(group => ({
    ...group,
    provider: {
      id: group.id,
      name: group.id === 'deepseek-account' ? accountProviderName : group.name,
    },
  })), [state.groups, accountProviderName])
  const choices = useMemo(() => groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [groups])
  const showSearch = choices.length > 4
  const filteredGroups = useMemo(() => groups.map(group => ({
    ...group, models: rankByName(group.models, showSearch ? query.trim() : ''),
  })).filter(group => group.models.length > 0), [groups, query, showSearch])
  const visibleModels = useMemo(() => filteredGroups.flatMap(group => group.models.map(model => ({
    provider: group.id, model: model.id,
  }))), [filteredGroups])
  const currentVisibleIndex = visibleModels.findIndex(model =>
    model.provider === state.current?.provider && model.model === state.current.model)
  const activeModelIndex = Math.min(highlightedIndex ?? Math.max(0, currentVisibleIndex), visibleModels.length - 1)
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = currentChoice === undefined
    ? undefined
    : reasoning === undefined
      ? state.retainedEffort
      : effectiveEffort === undefined
        ? t('effort.providerDefault')
        : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const { pending } = state
  const busy = pending !== null

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  const chooseCliAgent = (agentId: string, shouldClose = false): void => {
    setActiveCliAgent(agentId)
    setActiveTab('cli')
    let nextModel = activeCliModel
    try {
      localStorage.setItem('dsh_active_cli_agent', agentId)
      localStorage.setItem('dsh_model_mode', 'cli')
      const byok = currentChoice ? {
        providerId: currentChoice.group.provider.id,
        modelId: currentChoice.model.id,
        modelName: currentChoice.model.name,
      } : undefined
      const availableModels = getAvailableCliModels(agentId, byok)
      const isModelValid = availableModels.some(m => m.id === activeCliModel)
      nextModel = isModelValid ? activeCliModel : (agentId === 'agy' ? 'gemini-3.8-flash-high' : 'byok')
      if (!isModelValid) {
        setActiveCliModel(nextModel)
        localStorage.setItem('dsh_active_cli_model', nextModel)
      }
      const parsed = parseCliModel(agentId, nextModel, byok)
      localStorage.setItem('dsh_active_cli_model_arg', parsed.cliArg)
      window.dispatchEvent(new CustomEvent('dsh:agent-cli-changed', { detail: { agent: agentId } }))
      window.dispatchEvent(new CustomEvent('dsh:model-mode-changed', { detail: { mode: 'cli' } }))
    } catch {}
    submit({
      provider: agentId,
      model: nextModel || 'byok',
    })
    if (shouldClose) {
      closeAfterSelection()
    }
  }

  const chooseCliModel = (modelId: string): void => {
    setActiveCliModel(modelId)
    const agentId = activeCliAgent || 'agy'
    try {
      localStorage.setItem('dsh_active_cli_model', modelId)
      const byok = currentChoice ? {
        providerId: currentChoice.group.provider.id,
        modelId: currentChoice.model.id,
        modelName: currentChoice.model.name,
      } : undefined
      const parsed = parseCliModel(agentId, modelId, byok)
      localStorage.setItem('dsh_active_cli_model_arg', parsed.cliArg)
      window.dispatchEvent(new CustomEvent('dsh:agent-cli-model-changed', {
        detail: { agent: agentId, model: modelId, cliArg: parsed.cliArg },
      }))
    } catch {}
    submit({
      provider: agentId,
      model: modelId,
    })
    closeAfterSelection()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      // The portaled card is outside the trigger subtree; check both.
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useLayoutEffect(() => {
    if (!showSearch) {
      setQuery('')
      setHighlightedIndex(null)
    }
  }, [showSearch])

  // Pane switches unmount the focused row; restore focus inside the menu so
  // keyboard navigation remains available.
  const paneFocus = useRef<'drill' | 'model' | 'effort' | 'agent-cli' | null>(null)
  const previousShowSearch = useRef(showSearch)
  useEffect(() => {
    const changedSearchMode = previousShowSearch.current !== showSearch
    previousShowSearch.current = showSearch
    const intent = paneFocus.current ?? (changedSearchMode && pane === 'model' ? 'drill' : null)
    paneFocus.current = null
    if (!open || intent === null) return
    if (intent === 'drill') {
      if (pane === 'model' && showSearch && !isMobileDevice()) {
        searchRef.current?.focus()
        return
      }
      // The checked row is the value in use; a pane without one opens on its
      // first row.
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      const target = checked ?? itemRefs.current.find(item => item !== null && !item.disabled)
      // Rows a selection in flight disabled cannot take the keyboard; the
      // trigger does, so the card's keys still reach the menu.
      ;(target ?? triggerRef.current)?.focus()
      return
    }
    const agentCliIndex = reasoning !== undefined ? 2 : 1
    const cell = itemRefs.current[intent === 'effort' ? 1 : intent === 'agent-cli' ? agentCliIndex : 0]
    ;(cell !== null && cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus()
  }, [open, pane, showSearch])

  useEffect(() => {
    const viewport = groupsRef.current
    if (viewport === null) return
    return observeStickyMenuGroups(viewport)
  }, [available, open, pane, filteredGroups])

  useLayoutEffect(() => {
    if (open && pane === 'model' && activeModelIndex >= 0) {
      itemRefs.current[activeModelIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, pane, activeModelIndex, visibleModels])

  // The portal needs viewport coordinates from the trigger and the menu's
  // measured size before paint. Slot content can resize without parent renders.
  useLayoutEffect(() => {
    if (!available || !open) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN)
      setMenuPos({ left: x, top: y })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const menu = menuRef.current
    const observer = typeof ResizeObserver !== 'undefined' && menu !== null
      ? new ResizeObserver(place)
      : null
    if (menu !== null) observer?.observe(menu)
    return () => {
      observer?.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [available, open, pane, state, query])

  if (!available) return null

  const show = (): void => {
    setSelectionFocus(false)
    triggerRef.current?.focus()
    setQuery('')
    setHighlightedIndex(null)
    if (currentChoice === undefined) paneFocus.current = 'drill'
    setPane(currentChoice === undefined ? 'model' : 'root')
    setOpen(true)
    reload()
  }

  const changeQuery = (next: string): void => {
    setQuery(next)
    setHighlightedIndex(0)
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const closeAfterSelection = (): void => {
    setSelectionFocus(true)
    close(true)
  }

  const drill = (next: Pane): void => {
    setQuery('')
    setHighlightedIndex(null)
    paneFocus.current = 'drill'
    setPane(next)
  }

  /** Leave a drilled pane for the root one, handing the keyboard back to its cell. */
  const back = (from: Exclude<Pane, 'root'>): void => {
    paneFocus.current = from
    if (from === 'model' || from === 'effort') {
      setActiveTab('byok')
    } else {
      setActiveTab('cli')
    }
    setPane('root')
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    // Focus outside the rows (the trigger, which keeps it while the menu
    // opens) enters at the end the step comes from: the first row forward,
    // the last row backward.
    const next = active === -1
      ? (offset > 0 ? 0 : items.length - 1)
      : (active + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      // Escape backs out of a drilled pane first, then closes.
      if (pane !== 'root' && currentChoice !== undefined) back(pane)
      else close(true)
      return
    }
    if (!open) return
    if (pane === 'model' && showSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!busy && visibleModels.length > 0) {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setHighlightedIndex((activeModelIndex + direction + visibleModels.length) % visibleModels.length)
        searchRef.current?.focus()
      }
      return
    }
    if (pane === 'model' && showSearch && event.target instanceof HTMLInputElement
      && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
      if (event.key === 'Tab' && visibleModels.length === 0) return
      event.preventDefault()
      const highlighted = visibleModels[activeModelIndex]
      if (!busy && highlighted !== undefined) choose(highlighted)
      return
    }
    // Tab settles like Enter and Shift+Tab leaves like Escape, so the menu's
    // keys mean what they mean in the composer. Both are consumed: the card
    // keeps the browser's focus traversal out while it is open.
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        event.preventDefault()
        if (pane !== 'root' && currentChoice !== undefined) back(pane)
        else close(true)
        return
      }
      // Settling activates the row the keyboard is on; with focus still on the
      // trigger, Tab enters the menu at the value in use instead. Any other
      // control inside the card (a retry button) keeps the browser's traversal,
      // so the keystroke stays unconsumed there.
      const focused = document.activeElement
      const rows = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null)
      if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
        event.preventDefault()
        focused.click()
        return
      }
      if (focused !== triggerRef.current) return
      event.preventDefault()
      if (pane === 'model' && showSearch) {
        setHighlightedIndex(null)
        searchRef.current?.focus()
        return
      }
      const checked = menuRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]:not([disabled])')
      ;(checked ?? rows.find(item => !item.disabled))?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }

  const settleSelection = (result: Awaited<ReturnType<ModelSelectInjected['select']>>): void => {
    if (result === undefined) return
    if (result.ok) {
      if (rootRef.current !== null) closeAfterSelection()
      return
    }
    const { error } = result
    toastSeq.current += 1
    setToast({
      seq: toastSeq.current,
      text: error.code === 'session/writer-held'
        ? t('error.sessionInUse')
        : t('error.action', { message: `${error.code}: ${error.message}` }),
    })
  }

  const submit = (selection: ModelSelection): void => {
    lastActionRef.current = 'select'
    // Disabled option rows cannot retain focus while a selection is pending.
    setSelectionFocus(true)
    triggerRef.current?.focus()
    void select(selection).then(settleSelection)
  }

  const choose = (selection: ModelSelection): void => {
    setActiveTab('byok')
    try {
      localStorage.setItem('dsh_model_mode', 'byok')
      window.dispatchEvent(new CustomEvent('dsh:model-mode-changed', { detail: { mode: 'byok' } }))
    } catch {}
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      closeAfterSelection()
      return
    }
    submit(selection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      closeAfterSelection()
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    submit(selection)
  }

  const waiting = currentChoice === undefined && state.status === 'loading'
  const modelLabel = waiting
    ? t('trigger.loading')
    : currentChoice?.model.name
      ?? t('trigger.fallback')
  const currentCliParsed = cliAgents.length > 0 && activeTab === 'cli' && activeAgent !== undefined
    ? parseCliModel(activeAgent.id, activeCliModel, currentChoice ? {
      providerId: currentChoice.group.provider.id,
      modelId: currentChoice.model.id,
      modelName: currentChoice.model.name,
    } : undefined)
    : undefined
  const triggerLabel = currentCliParsed !== undefined
    ? `CLI · ${activeAgent?.name ?? activeCliAgent}: ${currentCliParsed.displayLabel}`
    : effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? t('trigger.loading')
    : currentChoice === undefined
      ? t('trigger.selectAria')
      : effortLabel === undefined
        ? t('trigger.aria', { model: modelLabel })
        : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
  const renderModelLabel = (
    provider: ModelLabelOwner['provider'], model: ModelLabelOwner['model'],
    placement: ModelLabelOwner['placement'], selected: boolean,
  ) => (
    <span data-provider-id={provider.id} data-model-id={model.id}>
      {renderSlot('conversation.input.model.label', {
        provider, model, placement, selected,
      }, {
        fallback: model.badge === undefined ? model.name : (
          <span className={css.badgedName}>
            {placement === 'trigger' ? <><Tag className={css.badge} tone={model.badge.tone}>{resolveText(model.badge.text)}</Tag>{' '}</> : null}
            <span className={css.badgedNameText}>{model.name}</span>
            {placement === 'trigger' ? null : <>{' '}<Tag className={css.badge} tone={model.badge.tone}>{resolveText(model.badge.text)}</Tag></>}
          </span>
        ),
      })}
    </span>
  )
  let itemIndex = 0
  let modelIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div
      ref={rootRef}
      className={css.root}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
      onMouseDown={(event) => {
        // WebKit blurs a focused row before click unless the button's mousedown keeps focus.
        if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        aria-busy={busy}
        data-selection-focus={selectionFocus ? '' : undefined}
        onBlur={() => { setSelectionFocus(false) }}
        disabled={locked}
        onClick={() => {
          if (open) {
            close(true)
          } else {
            show()
          }
        }}
      >
        <IconDataOutlineRegular className={css.triggerIcon} size={16} />
        {cliAgents.length > 0 && (
          activeTab === 'cli' && activeAgent !== undefined ? (
            <span className={css.cliTriggerBadge}>
              CLI · {activeAgent.bin.toUpperCase()}
            </span>
          ) : (
            <span className={css.byokTriggerBadge}>
              BYOK
            </span>
          )
        )}
        <span className={css.triggerLabel}>
          {currentCliParsed !== undefined
            ? currentCliParsed.displayLabel
            : currentChoice === undefined
              ? modelLabel
              : renderModelLabel(currentChoice.group.provider, currentChoice.model, 'trigger', true)}
        </span>
        {currentCliParsed === undefined && effortLabel !== undefined && <span className={css.triggerEffort}>{effortLabel}</span>}
        {busy
          ? <StateDot state="ongoing" />
          : <IconChevronDownOutlineRegular className={clsx(css.chevron, open && css.chevronOpen)} />}
      </button>

      {/* Portaled to body (Menu primitive's portal mode) so the sidebar and
          column overflow clips cannot crop the card; synthetic events still
          bubble through this React subtree, keeping onKeyDown/onBlur live. */}
      {open && createPortal(
        <MenuSurface
          ref={menuRef}
          id={`${id}-menu`}
          className={css.menu}
          style={menuPos ?? MEASURE_STYLE}
          role={pane === 'model' ? 'group' : 'menu'}
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
        >
          {pane === 'root' && (
            <>
              {cliAgents.length > 0 && (
                <div className={css.tabSplit}>
                  <button
                    type="button"
                    className={clsx(css.tabSplitBtn, activeTab === 'cli' && css.tabSplitBtnActive)}
                    onClick={() => {
                      setActiveTab('cli')
                      const agentId = activeCliAgent || 'agy'
                      const modelId = activeCliModel || 'gemini-3.8-flash-high'
                      try {
                        localStorage.setItem('dsh_model_mode', 'cli')
                        window.dispatchEvent(new CustomEvent('dsh:model-mode-changed', { detail: { mode: 'cli' } }))
                      } catch {}
                      submit({
                        provider: agentId,
                        model: modelId,
                      })
                    }}
                  >
                    <IconCodeOutlineRegular size={13} />
                    <span>Agent CLI</span>
                  </button>
                  <button
                    type="button"
                    className={clsx(css.tabSplitBtn, activeTab === 'byok' && css.tabSplitBtnActive)}
                    onClick={() => {
                      setActiveTab('byok')
                      try {
                        localStorage.setItem('dsh_model_mode', 'byok')
                        window.dispatchEvent(new CustomEvent('dsh:model-mode-changed', { detail: { mode: 'byok' } }))
                      } catch {}
                      if (currentChoice && !['agy', 'opencode', 'claude', 'codex', 'cursor-agent'].includes(currentChoice.group.provider.id)) {
                        submit({
                          provider: currentChoice.group.provider.id,
                          model: currentChoice.model.id,
                          ...(currentChoice.model.reasoning?.defaultEffort === undefined
                            ? {}
                            : { reasoningEffort: currentChoice.model.reasoning.defaultEffort }),
                        })
                      }
                    }}
                  >
                    <IconDataOutlineRegular size={13} />
                    <span>BYOK</span>
                  </button>
                </div>
              )}

              {activeTab === 'byok' || cliAgents.length === 0 ? (
                <>
                  <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('model') }}>
                    <span className={css.cellLabel}>{t('menu.model')}</span>
                    <span className={css.cellValue}>
                      {currentChoice === undefined ? modelLabel : renderModelLabel(currentChoice.group.provider, currentChoice.model, 'menu', true)}
                    </span>
                    <IconChevronRightOutlineRegular className={css.cellChevron} />
                  </button>
                  {reasoning !== undefined && (
                    <button ref={itemRef()} type="button" role="menuitem" className={css.cell} onClick={() => { drill('effort') }}>
                      <span className={css.cellLabel}>{t('menu.effort')}</span>
                      <span className={css.cellValue}>{effortLabel}</span>
                      <IconChevronRightOutlineRegular className={css.cellChevron} />
                    </button>
                  )}
                </>
              ) : (
                <div className={css.cliPane}>
                  <div className={clsx(css.cliList, 'scrollable')}>
                    {cliAgents.map((agent) => {
                      const selected = agent.id === activeCliAgent
                      return (
                        <button
                          key={agent.id}
                          ref={itemRef()}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          className={clsx(css.option, selected && css.selected)}
                          onClick={() => { chooseCliAgent(agent.id, selected) }}
                        >
                          <span className={css.optionCopy}>
                            <span className={css.cliNameRow}>
                              <span className={css.modelName}>{agent.name}</span>
                              <span className={css.cliBadge}>{agent.bin}</span>
                            </span>
                            {agent.version && <span className={css.cliMeta}>{agent.version}</span>}
                          </span>
                          <span className={css.check}>
                            {selected ? <IconCheckOutlineRegular /> : null}
                          </span>
                        </button>
                      )
                    })}

                    {activeAgent !== undefined && (
                      <>
                        <div className={css.cliSectionDivider}>
                          <div className={css.cliSectionTitle}>
                            Penyedia LLM / Model CLI ({activeAgent.bin})
                          </div>
                        </div>
                        {getAvailableCliModels(
                          activeAgent.id,
                          currentChoice ? {
                            providerId: currentChoice.group.provider.id,
                            modelId: currentChoice.model.id,
                            modelName: currentChoice.model.name,
                          } : undefined,
                        ).map((m) => {
                          const isSelected = activeCliModel === m.id
                          return (
                            <button
                              key={m.id}
                              ref={itemRef()}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isSelected}
                              className={clsx(css.option, isSelected && css.selected)}
                              onClick={() => { chooseCliModel(m.id) }}
                            >
                              <span className={css.optionCopy}>
                                <span className={css.cliNameRow}>
                                  <span className={css.modelName}>{m.label}</span>
                                  {m.badge && (
                                    <span className={clsx(css.cliModelBadge, m.isParsedByok && css.cliModelBadgeParsed)}>
                                      {m.badge}
                                    </span>
                                  )}
                                </span>
                                {m.desc && <span className={css.cliModelDesc}>{m.desc}</span>}
                              </span>
                              <span className={css.check}>
                                {isSelected ? <IconCheckOutlineRegular /> : null}
                              </span>
                            </button>
                          )
                        })}
                      </>
                    )}
                  </div>
                  <div className={css.cliSettingsFooter}>
                    <button
                      type="button"
                      className={css.cliSettingsBtn}
                      onClick={openCliSettings}
                    >
                      <IconSettingsOutlineRegular size={14} />
                      <span>Pengaturan CLI (Agent Runner)...</span>
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {pane === 'model' && (
            <>
              {showSearch && <div className={css.searchRow}>
                <Input
                  ref={searchRef}
                  className={clsx(css.search, query !== '' && css.searchWithQuery)}
                  type="text"
                  role="searchbox"
                  aria-label={t('search.placeholder')}
                  aria-controls={`${id}-models`}
                  aria-activedescendant={activeModelIndex < 0 ? undefined : `${id}-model-${activeModelIndex}`}
                  placeholder={t('search.placeholder')}
                  value={query}
                  readOnly={busy}
                  onChange={(event) => { changeQuery(event.target.value) }}
                />
                {query !== '' && (
                  <button
                    type="button"
                    className={css.searchClear}
                    aria-label={t('search.clear')}
                    disabled={busy}
                    onClick={() => {
                      changeQuery('')
                      searchRef.current?.focus()
                    }}
                  >
                    <IconCloseFillRegular />
                  </button>
                )}
              </div>}
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.id === 'deepseek-account' ? t('provider.account') : failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div
                ref={groupsRef}
                id={`${id}-models`}
                className={clsx(css.groups, 'scrollable')}
                role="menu"
                aria-label={t('menu.model')}
                hidden={filteredGroups.length === 0}
              >
                {filteredGroups.map((group) => {
                  return (
                    <MenuGroup key={group.id} label={group.provider.name}>
                      {group.models.map((model) => {
                        const index = modelIndex++
                        const selected = state.current?.provider === group.id && state.current.model === model.id
                        return (
                          <button
                            ref={itemRef()}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            id={`${id}-model-${index}`}
                            tabIndex={showSearch ? -1 : 0}
                            onFocus={() => { setHighlightedIndex(index) }}
                            data-highlighted={index === activeModelIndex ? '' : undefined}
                            className={clsx(
                              css.option, css.modelOption, selected && css.selected, index === activeModelIndex && css.optionActive,
                            )}
                            onMouseMove={busy || index === activeModelIndex ? undefined : () => {
                              if (showSearch) setHighlightedIndex(index)
                              else itemRefs.current[index]?.focus()
                            }}
                            key={model.id}
                            title={model.name}
                            disabled={busy}
                            onClick={() => { choose({ provider: group.id, model: model.id }) }}
                          >
                            <span className={css.optionCopy}>
                              <span className={css.modelName}>{renderModelLabel(group.provider, model, 'option', selected)}</span>
                            </span>
                            <span className={css.check}>
                              {pending?.provider === group.id && pending.model === model.id
                                ? <StateDot state="ongoing" />
                                : selected ? <IconCheckOutlineRegular /> : null}
                            </span>
                          </button>
                        )
                      })}
                    </MenuGroup>
                  )
                })}
              </div>
              {state.status === 'ready' && filteredGroups.length === 0 && (
                <div className={css.empty} role="status">{t(choices.length === 0 ? 'empty.models' : 'search.empty')}</div>
              )}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveEffort === level.effort}
                    className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                    </span>
                    <span className={css.check}>
                      {pending !== null && pending.provider === state.current?.provider
                        && pending.model === state.current.model && pending.reasoningEffort === level.effort
                        ? <StateDot state="ongoing" />
                        : effectiveEffort === level.effort ? <IconCheckOutlineRegular /> : null}
                    </span>
                  </button>
                ))}
            </>
          )}

          {pane === 'agent-cli' && (
            <div className={css.cliPane}>
              <div className={css.cliPaneHeader}>
                <button
                  type="button"
                  className={css.cliBackBtn}
                  aria-label="Kembali"
                  onClick={() => { back('agent-cli') }}
                >
                  <IconChevronLeftOutlineRegular size={14} />
                </button>
                <span className={css.cliPaneTitle}>Pilih Agent CLI</span>
              </div>
              <div className={clsx(css.cliList, 'scrollable')}>
                {cliAgents.map((agent) => {
                  const selected = agent.id === activeCliAgent
                  return (
                    <button
                      key={agent.id}
                      ref={itemRef()}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={clsx(css.option, selected && css.selected)}
                      onClick={() => { chooseCliAgent(agent.id, selected) }}
                    >
                      <span className={css.optionCopy}>
                        <span className={css.cliNameRow}>
                          <span className={css.modelName}>{agent.name}</span>
                          <span className={css.cliBadge}>{agent.bin}</span>
                        </span>
                        {agent.version && <span className={css.cliMeta}>{agent.version}</span>}
                      </span>
                      <span className={css.check}>
                        {selected ? <IconCheckOutlineRegular /> : null}
                      </span>
                    </button>
                  )
                })}

                {activeAgent !== undefined && (
                  <>
                    <div className={css.cliSectionDivider}>
                      <div className={css.cliSectionTitle}>
                        Penyedia LLM / Model CLI ({activeAgent.bin})
                      </div>
                    </div>
                    {getAvailableCliModels(
                      activeAgent.id,
                      currentChoice ? {
                        providerId: currentChoice.group.provider.id,
                        modelId: currentChoice.model.id,
                        modelName: currentChoice.model.name,
                      } : undefined,
                    ).map((m) => {
                      const isSelected = activeCliModel === m.id
                      return (
                        <button
                          key={m.id}
                          ref={itemRef()}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          className={clsx(css.option, isSelected && css.selected)}
                          onClick={() => { chooseCliModel(m.id) }}
                        >
                          <span className={css.optionCopy}>
                            <span className={css.cliNameRow}>
                              <span className={css.modelName}>{m.label}</span>
                              {m.badge && (
                                <span className={clsx(css.cliModelBadge, m.isParsedByok && css.cliModelBadgeParsed)}>
                                  {m.badge}
                                </span>
                              )}
                            </span>
                            {m.desc && <span className={css.cliModelDesc}>{m.desc}</span>}
                          </span>
                          <span className={css.check}>
                            {isSelected ? <IconCheckOutlineRegular /> : null}
                          </span>
                        </button>
                      )
                    })}
                  </>
                )}
              </div>
              <div className={css.cliSettingsFooter}>
                <button
                  type="button"
                  className={css.cliSettingsBtn}
                  onClick={openCliSettings}
                >
                  <IconSettingsOutlineRegular size={14} />
                  <span>Pengaturan CLI (Agent Runner)...</span>
                </button>
              </div>
            </div>
          )}
        </MenuSurface>,
        document.body,
      )}
      {showAgentSettingsModal && createPortal(
        <div
          className={css.agentModalOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Pengaturan Agent CLI"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowAgentSettingsModal(false)
          }}
        >
          <div className={css.agentModalCard}>
            <div className={css.agentModalHeader}>
              <div className={css.agentModalTitleGroup}>
                <span className={css.agentModalIcon}>
                  <IconSettingsOutlineRegular size={18} />
                </span>
                <div>
                  <h2 className={css.agentModalTitle}>Pengaturan Agent CLI</h2>
                  <p className={css.agentModalSubtitle}>
                    Kelola autentikasi, akun login, dan konfigurasi CLI runner ({activeAgent?.name ?? activeCliAgent})
                  </p>
                </div>
              </div>
              <button
                type="button"
                className={css.agentModalClose}
                aria-label="Tutup"
                onClick={() => { setShowAgentSettingsModal(false) }}
              >
                <IconCloseFillRegular size={16} />
              </button>
            </div>
            <div className={css.agentModalBody}>
              <iframe
                src="/api/agent-runner/ui"
                title="Agent Runner Settings"
                className={css.agentModalIframe}
              />
            </div>
          </div>
        </div>,
        document.body,
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutlineRegular />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
