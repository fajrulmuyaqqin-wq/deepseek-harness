// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  DelegationTimelineFullPage, type DelegationTimelineFullPageProps,
} from '../src/client/DelegationTimelineFullPage.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PROJ_1 = 'session-proj-1' as SessionId
const PROJ_2 = 'session-proj-2' as SessionId
const SUBAGENT_1 = 'session-sub-1' as SessionId

const summaries: Record<SessionId, SessionSummary> = {
  [PROJ_1]: {
    id: PROJ_1,
    title: 'Model Visual Project',
    displayTitle: 'Model Visual Project',
    running: false,
    blank: false,
    updatedAt: Date.now() - 1000 * 60 * 5,
    retainedBy: {},
  },
  [PROJ_2]: {
    id: PROJ_2,
    title: 'Website Redesign',
    displayTitle: 'Website Redesign',
    running: false,
    blank: false,
    updatedAt: Date.now() - 1000 * 60 * 60 * 2,
    retainedBy: {},
  },
  [SUBAGENT_1]: {
    id: SUBAGENT_1,
    title: 'Subagent Worker',
    displayTitle: 'Subagent Worker',
    parentId: PROJ_1,
    origin: 'subagent',
    running: true,
    blank: false,
    updatedAt: Date.now(),
    retainedBy: {},
  },
}

function renderFullPage(overrides: Partial<DelegationTimelineFullPageProps> = {}) {
  const store = createSnapshotStore<SessionListState>({
    phase: 'ready',
    ids: [PROJ_1, PROJ_2, SUBAGENT_1],
    byId: summaries,
    projectionsBySession: {},
  })

  const onBackToChat = vi.fn()
  const onToggleSidebarRight = vi.fn()
  const onSelectProject = vi.fn()
  const onCreateProject = vi.fn(async (_title?: string) => 'session-new-proj' as SessionId)
  const openTeammate = vi.fn()

  const statuses = createSnapshotStore<SessionStatusSnapshot>(new Map([
    [PROJ_1, { running: false, phase: 'idle', pendingInteraction: undefined, completionUnread: false }],
    [PROJ_2, { running: false, phase: 'idle', pendingInteraction: undefined, completionUnread: false }],
  ]))

  const props = {
    onBackToChat,
    onToggleSidebarRight,
    onSelectProject,
    onCreateProject,
    openTeammate,
    useSessions: bindSnapshotSelector(store),
    useSessionStatus: bindSnapshotSelector(statuses),
    usePanelInfo: (selector: (p: { activePanelId: string | null }) => unknown) => selector({ activePanelId: null }),
    t: makeTranslate(en, commonZh),
    ...overrides,
  } as unknown as DelegationTimelineFullPageProps

  const result = render(<DelegationTimelineFullPage {...props} />)
  return { ...result, props, store, onBackToChat, onToggleSidebarRight, onSelectProject, onCreateProject }
}

describe('DelegationTimelineFullPage', () => {
  it('renders the isolated left projects sidebar with project items', () => {
    renderFullPage()

    expect(screen.getAllByText('Projects').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('New project')).toBeDefined()
    expect(screen.getAllByText('Model Visual Project').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Website Redesign')).toBeDefined()
    // Subagent should not be listed as top-level project
    expect(screen.queryByText('Subagent Worker')).toBeNull()
  })

  it('filters project list by search query', () => {
    renderFullPage()

    const searchInput = screen.getByPlaceholderText('Search projects…')
    fireEvent.change(searchInput, { target: { value: 'Visual' } })

    expect(screen.getAllByText('Model Visual Project').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText('Website Redesign')).toBeNull()
  })

  it('groups projects by workspace folder and supports folding/unfolding', () => {
    const wsAlpha: WorkspaceView = {
      workspaceId: 'ws-alpha' as WorkspaceId,
      title: 'Workspace Alpha',
      path: '/workspaces/alpha',
      sessionIds: [PROJ_1],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }
    const wsBeta: WorkspaceView = {
      workspaceId: 'ws-beta' as WorkspaceId,
      title: 'Workspace Beta',
      path: '/workspaces/beta',
      sessionIds: [PROJ_2],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }

    renderFullPage({
      getWorkspaces: () => [wsAlpha, wsBeta],
    })

    const alphaHeader = screen.getByRole('button', { name: /Workspace Alpha/i })
    const betaHeader = screen.getByRole('button', { name: /Workspace Beta/i })
    expect(alphaHeader).toBeDefined()
    expect(betaHeader).toBeDefined()

    // Both folders should start expanded since they contain projects
    expect(alphaHeader.getAttribute('aria-expanded')).toBe('true')
    expect(alphaHeader.parentElement!.querySelector('[class*="projectCard"]')).not.toBeNull()

    // Clicking Workspace Alpha header folds it
    fireEvent.click(alphaHeader)
    expect(alphaHeader.getAttribute('aria-expanded')).toBe('false')
    expect(alphaHeader.parentElement!.querySelector('[class*="projectCard"]')).toBeNull()

    // Clicking it again unfolds it
    fireEvent.click(alphaHeader)
    expect(alphaHeader.getAttribute('aria-expanded')).toBe('true')
    expect(alphaHeader.parentElement!.querySelector('[class*="projectCard"]')).not.toBeNull()
  })

  it('triggers onSelectProject when clicking a project item', () => {
    const { onSelectProject } = renderFullPage()

    const proj2Button = screen.getByText('Website Redesign').closest('button')!
    fireEvent.click(proj2Button)

    expect(onSelectProject).toHaveBeenCalledWith(PROJ_2)
  })

  it('allows creating a new project through the left bar', async () => {
    const { onCreateProject } = renderFullPage()

    const newProjectBtn = screen.getByRole('button', { name: 'New project' })
    fireEvent.click(newProjectBtn)

    const input = screen.getByPlaceholderText('Project name...')
    fireEvent.change(input, { target: { value: 'Brand New Project' } })

    const createSubmit = screen.getByText('Create project')
    fireEvent.click(createSubmit)

    expect(onCreateProject).toHaveBeenCalledWith('Brand New Project')
  })

  it('triggers onBackToChat when clicking Back to chat button', () => {
    const { onBackToChat } = renderFullPage()

    const backBtn = screen.getByRole('button', { name: 'Back to chat' })
    fireEvent.click(backBtn)

    expect(onBackToChat).toHaveBeenCalledOnce()
  })

  it('triggers onToggleSidebarRight when toggle button is clicked', () => {
    const { onToggleSidebarRight } = renderFullPage()

    const toggleBtn = screen.getByRole('button', { name: 'Toggle right sidebar' })
    fireEvent.click(toggleBtn)

    expect(onToggleSidebarRight).toHaveBeenCalledOnce()
  })
})
