// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberProjection, TeamProjection, TeamTaskId, TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionListState, SessionSnapshot, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  DelegationTimelineView, type DelegationTimelineViewProps, type TimelineViewInjected,
} from '../src/client/DelegationTimelineView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const LEAD_ID = 'lead-session' as SessionId
const WORKER_ID = 'worker-session' as SessionId
const STAGED_TASK_ID = 'task-staged-1' as TeamTaskId

const stagedTask: TeamTask = {
  id: STAGED_TASK_ID,
  revision: 1,
  subject: 'Draft marketing copy',
  description: 'Write draft copy',
  status: 'pending',
  ownerName: 'lead',
  blockedBy: [],
  writeScopes: [],
  writeScopeWarnings: [],
  ready: false,
  staged: true,
  provider: 'anthropic',
  model: 'claude-3-7-sonnet',
  mcpServers: ['github', 'web'],
}

const leadMember: TeamMemberProjection = {
  id: LEAD_ID,
  name: 'Media buyer',
  role: 'lead',
  phase: 'active',
  model: 'claude-3-7-sonnet',
  modelProvider: 'anthropic',
  mcpServers: ['github'],
}

const workerMember: TeamMemberProjection = {
  id: WORKER_ID,
  name: 'Strategist',
  role: 'teammate',
  phase: 'active',
  model: 'gpt-4o',
  modelProvider: 'openai',
  mcpServers: ['fetch'],
}

const team: TeamProjection = {
  members: [leadMember, workerMember],
  tasks: [stagedTask],
}

function summary(id: SessionId, title: string, running: boolean): SessionSummary {
  return { id, displayTitle: title, running, retainedBy: {}, blank: false, updatedAt: Date.now() - 60000 }
}

function createTestHarness() {
  const byId: Record<SessionId, SessionSummary> = {
    [LEAD_ID]: summary(LEAD_ID, 'Media buyer', true),
    [WORKER_ID]: summary(WORKER_ID, 'Strategist', false),
  }
  const sessions = createSnapshotStore<SessionListState>({
    ids: [LEAD_ID, WORKER_ID],
    byId,
    phase: 'ready',
    projectionsBySession: {
      [LEAD_ID]: {
        state: 'ready',
        error: null,
        values: {
          agentTeam: team,
          subagentCatalog: [
            { id: WORKER_ID, label: 'Strategist', createdAt: Date.now() - 30000, mode: 'unknown' },
          ],
        },
      },
    },
  })

  const statuses = createSnapshotStore<SessionStatusSnapshot>(new Map([
    [LEAD_ID, { running: true, phase: 'active', pendingInteraction: undefined, completionUnread: false }],
    [WORKER_ID, { running: false, phase: 'idle', pendingInteraction: undefined, completionUnread: false }],
  ]))

  const session = createSnapshotStore<SessionSnapshot>({
    sessionId: LEAD_ID,
    pendingSubmissions: [],
    running: true,
    subagent: null,
    removed: false,
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: false,
    awaitingFirstTurn: false,
  })

  const injected: TimelineViewInjected = {
    openTeammate: vi.fn(),
    selectModel: vi.fn(),
    dispatchTask: vi.fn(),
    createTask: vi.fn(),
    openPlan: vi.fn(),
  }

  const props: DelegationTimelineViewProps = {
    sessionId: LEAD_ID,
    useSession: bindSnapshotSelector(session),
    useProjection: () => undefined,
    useSessions: bindSnapshotSelector(sessions),
    useSessionStatus: bindSnapshotSelector(statuses),
    ...injected,
    t: makeTranslate(zh, commonZh),
  }

  return { props, injected }
}

describe('DelegationTimelineView Component & Interactivity Tests', () => {
  it('renders metric cards, ruler header, and agent swimlanes with provider badges', () => {
    const { props } = createTestHarness()
    render(<DelegationTimelineView {...props} />)

    // Metric headers
    expect(screen.getByText('Cost')).toBeDefined()

    // Agent names & brands
    expect(screen.getAllByText('Media buyer').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Strategist').length).toBeGreaterThan(0)

    // Staged task with Plan badge
    expect(screen.getByText('Draft marketing copy')).toBeDefined()
    expect(screen.getAllByText('Plan').length).toBeGreaterThan(0)
  })

  it('toggles the minimalist + Task popover and creates a task optimistically', () => {
    const { props, injected } = createTestHarness()
    render(<DelegationTimelineView {...props} />)

    // Verify + Task button is present
    const addBtn = screen.getByTitle('Add task')
    expect(addBtn).toBeDefined()

    // Click + Task to open modal
    fireEvent.click(addBtn)
    expect(screen.getByText('Add Team Task')).toBeDefined()

    // Fill form
    const input = screen.getByPlaceholderText('Task subject / title...')
    fireEvent.change(input, { target: { value: 'Analyze Competitor Ads' } })

    const mcpInput = screen.getByPlaceholderText('MCP servers (optional, comma-separated)...')
    fireEvent.change(mcpInput, { target: { value: 'github, web' } })

    // Click Create Task
    const submitBtn = screen.getByText('Create Task')
    fireEvent.click(submitBtn)

    // Verify callback was called
    expect(injected.createTask).toHaveBeenCalledWith(LEAD_ID, expect.objectContaining({
      subject: 'Analyze Competitor Ads',
      staged: true,
      mcpServers: ['github', 'web'],
    }))

    // Verify task is added to UI optimistically
    expect(screen.getByText('Analyze Competitor Ads')).toBeDefined()
  })

  it('dispatches a staged task when clicking Run', () => {
    const { props, injected } = createTestHarness()
    render(<DelegationTimelineView {...props} />)

    // Find the Run dispatch button
    const runBtn = screen.getByTitle('Dispatch task now')
    expect(runBtn).toBeDefined()

    // Click Run
    fireEvent.click(runBtn)

    // Verify dispatch callback called
    expect(injected.dispatchTask).toHaveBeenCalledWith(LEAD_ID, STAGED_TASK_ID)
  })

  it('switches model using the minimalist model picker dropdown', () => {
    const { props, injected } = createTestHarness()
    render(<DelegationTimelineView {...props} />)

    // Find model switch buttons on agent rows
    const switchBtns = screen.getAllByTitle('Switch model')
    expect(switchBtns.length).toBeGreaterThan(0)

    // Click the first model switch button (Lead)
    fireEvent.click(switchBtns[0]!)

    // Dropdown should be open with available models
    expect(screen.getByText('DeepSeek V3')).toBeDefined()

    // Click DeepSeek V3
    fireEvent.click(screen.getByText('DeepSeek V3'))

    // Verify selectModel callback called with deepseek provider & model
    expect(injected.selectModel).toHaveBeenCalledWith(
      LEAD_ID,
      'deepseek-official',
      'deepseek-chat',
    )
  })

  it('opens teammate session when clicking agent avatar or bar', () => {
    const { props, injected } = createTestHarness()
    render(<DelegationTimelineView {...props} />)

    // Click the agent avatar
    const avatars = document.querySelectorAll('[class*="brandAvatar"]')
    expect(avatars.length).toBeGreaterThan(0)
    fireEvent.click(avatars[0]!)
    expect(injected.openTeammate).toHaveBeenCalledWith(LEAD_ID, LEAD_ID)
  })

  it('opens synchronized task markdown or plan.md when clicking tasks or buttons', () => {
    const { props, injected } = createTestHarness()
    render(<DelegationTimelineView {...props} />)

    // Click the plan.md button in toolbar
    const planBtn = screen.getByTitle('Open plan.md in split pane')
    expect(planBtn).toBeDefined()
    fireEvent.click(planBtn)
    expect(injected.openPlan).toHaveBeenCalledWith(LEAD_ID, 'plan.md')

    // Click a task row item in the left list
    const taskItem = screen.getByText('Draft marketing copy')
    expect(taskItem).toBeDefined()
    fireEvent.click(taskItem)
    expect(injected.openPlan).toHaveBeenCalledWith(LEAD_ID, 'tasks/draft-marketing-copy.md')

    // Click a task gantt bar
    const planPills = screen.getAllByText('Plan')
    const ganttBar = planPills[0]?.closest('[class*="ganttBar"]') ?? planPills[1]?.closest('[class*="ganttBar"]')
    expect(ganttBar).not.toBeNull()
    if (ganttBar) {
      fireEvent.click(ganttBar)
      expect(injected.openPlan).toHaveBeenCalledWith(LEAD_ID, 'tasks/draft-marketing-copy.md')
    }
  })
})
