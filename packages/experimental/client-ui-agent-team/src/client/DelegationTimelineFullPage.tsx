import { useMemo, useState, useEffect, useRef, type ReactElement } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { DelegationTimelineView, type TimelineViewInjected } from './DelegationTimelineView.tsx'
import { NS } from './locales.ts'
import css from './DelegationTimelineFullPage.module.css'

export interface DelegationTimelineFullPageInjected extends TimelineViewInjected {
  /** Return to the primary conversation view. */
  readonly onBackToChat: () => void
  /** Resolve lead session ID from currently active session or binding. */
  readonly resolveLeadSessionId?: ((sessionId?: SessionId) => SessionId | undefined) | undefined
  /** Toggle the right sidebar open or closed. */
  readonly onToggleSidebarRight?: (() => void) | undefined
  /** Select and open a project session to sync rightbar folder and workspace. */
  readonly onSelectProject?: ((sessionId: SessionId) => void) | undefined
  /** Create a new project session and return its id. */
  readonly onCreateProject?: ((title?: string) => Promise<SessionId>) | undefined
  /** Retrieve current workspace items. */
  readonly getWorkspaces?: (() => readonly WorkspaceView[]) | undefined
}

export type DelegationTimelineFullPageProps =
  & PropsRuntime<'main'>
  & InjectFace<DelegationTimelineFullPageInjected>
  & PropsLocale<typeof NS>

function classes(...args: Array<string | boolean | undefined | null>): string {
  return args.filter(Boolean).join(' ')
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return ''
  const diffSec = Math.floor((Date.now() - timestamp) / 1000)
  if (diffSec < 60) return 'Just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d`
  const diffMonths = Math.floor(diffDays / 30)
  return `${diffMonths}mo`
}

interface ProjectItem {
  readonly id: SessionId
  readonly title: string
  readonly updatedAt: number | undefined
  readonly subagents: number
}

interface WorkspaceProjectGroup {
  readonly key: string
  readonly title: string
  readonly path?: string | undefined
  readonly projects: readonly ProjectItem[]
}

/**
 * Render the dedicated full-page central panel view with an isolated project sidebar
 * and the Agent Teams execution timeline.
 * @param props - Slot runtime props, injected navigation callbacks, and locale.
 * @returns React element.
 */
export function DelegationTimelineFullPage(props: DelegationTimelineFullPageProps): ReactElement {
  const {
    onBackToChat,
    resolveLeadSessionId,
    onToggleSidebarRight,
    onSelectProject,
    onCreateProject,
    getWorkspaces,
    useSessions,
    useSessionStatus,
    useWorkspaces,
    t,
    ...timelineInjected
  } = props

  const sessionList = useSessions(s => s)
  const allIds = sessionList.ids
  const summaries = sessionList.byId

  // Filter top-level project sessions (sessions that are not subagents)
  const projects = useMemo<readonly ProjectItem[]>(() => {
    return allIds.filter((id) => {
      const summary = summaries[id]
      return summary !== undefined && summary.origin !== 'subagent' && summary.parentId === undefined
    }).map((id) => {
      const summary = summaries[id]
      const childCount = allIds.filter(cid => summaries[cid]?.parentId === id).length
      return {
        id,
        title: summary?.title || summary?.displayTitle || 'Untitled Project',
        updatedAt: summary?.updatedAt,
        subagents: childCount,
      }
    })
  }, [allIds, summaries])

  // Track currently selected project ID
  const [selectedProjectId, setSelectedProjectId] = useState<SessionId | undefined>(() => {
    const firstId = allIds[0]
    return firstId !== undefined ? (resolveLeadSessionId?.(firstId) ?? firstId) : undefined
  })

  // Synchronize initial selection if empty
  useEffect(() => {
    if (selectedProjectId === undefined && projects.length > 0) {
      const firstId = projects[0]?.id
      if (firstId !== undefined) {
        setSelectedProjectId(firstId)
        onSelectProject?.(firstId)
      }
    }
  }, [selectedProjectId, projects, onSelectProject])

  // Search filter
  const [searchQuery, setSearchQuery] = useState('')
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects
    const q = searchQuery.toLowerCase()
    return projects.filter(p => p.title.toLowerCase().includes(q))
  }, [projects, searchQuery])

  // Workspace items from standard useWorkspaces hook or injected accessor
  const workspaceSnapshot = typeof useWorkspaces === 'function' ? useWorkspaces(s => s) : undefined
  const workspaceItems = workspaceSnapshot?.items ?? getWorkspaces?.() ?? []

  // Group filtered projects by workspace folder
  const workspaceGroups = useMemo<WorkspaceProjectGroup[]>(() => {
    const accounted = new Set<SessionId>()
    const groups: WorkspaceProjectGroup[] = []

    for (const ws of workspaceItems) {
      const sessionSet = new Set(ws.sessionIds)
      const matched = filteredProjects.filter((p) => {
        if (accounted.has(p.id)) return false
        if (sessionSet.has(p.id)) return true
        const cwd = summaries[p.id]?.cwd
        if (cwd && ws.path && (cwd === ws.path || cwd.startsWith(ws.path + '/'))) return true
        return false
      })

      matched.forEach(p => accounted.add(p.id))

      const displayTitle = ws.title || ws.path.split('/').filter(Boolean).pop() || ws.workspaceId

      // When searching, only show folders with matches; otherwise show all folders
      if (matched.length > 0 || !searchQuery.trim()) {
        groups.push({
          key: ws.workspaceId,
          title: displayTitle,
          path: ws.path,
          projects: matched,
        })
      }
    }

    // Sessions that don't belong to any accounted workspace
    const ungrouped = filteredProjects.filter(p => !accounted.has(p.id))
    if (ungrouped.length > 0) {
      groups.push({
        key: '__ungrouped__',
        title: groups.length > 0 ? t('timeline.otherProjects') : t('timeline.projects'),
        projects: ungrouped,
      })
    }

    // Fallback if no workspaces matched or existed at all
    if (groups.length === 0 && filteredProjects.length > 0) {
      groups.push({
        key: 'default',
        title: t('timeline.projects'),
        projects: filteredProjects,
      })
    }

    return groups
  }, [workspaceItems, filteredProjects, summaries, searchQuery, t])

  // Folding state: set of open workspace folder keys
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set())
  const [hasInitializedFolders, setHasInitializedFolders] = useState(false)

  // Initialize open folders
  useEffect(() => {
    if (!hasInitializedFolders && workspaceGroups.length > 0) {
      const initial = new Set<string>()
      for (const g of workspaceGroups) {
        if (g.projects.length > 0) {
          initial.add(g.key)
        }
      }
      if (initial.size === 0 && workspaceGroups[0]) {
        initial.add(workspaceGroups[0].key)
      }
      setOpenFolders(initial)
      setHasInitializedFolders(true)
    }
  }, [hasInitializedFolders, workspaceGroups])

  // Auto-expand folder only when selectedProjectId actually changes
  const prevSelectedProjectIdRef = useRef<SessionId | undefined>(undefined)
  useEffect(() => {
    if (!selectedProjectId) return
    if (prevSelectedProjectIdRef.current !== selectedProjectId) {
      prevSelectedProjectIdRef.current = selectedProjectId
      const containingGroup = workspaceGroups.find(g => g.projects.some(p => p.id === selectedProjectId))
      if (containingGroup) {
        setOpenFolders(prev => new Set(prev).add(containingGroup.key))
      }
    }
  }, [selectedProjectId, workspaceGroups])

  const isSearching = searchQuery.trim() !== ''
  const isExpanded = (key: string): boolean => {
    if (isSearching) return true
    return openFolders.has(key)
  }

  const toggleFolder = (key: string): void => {
    setOpenFolders((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  // Creating new project state
  const [isCreating, setIsCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [creatingBusy, setCreatingBusy] = useState(false)

  const handleSelectProject = (id: SessionId): void => {
    setSelectedProjectId(id)
    onSelectProject?.(id)
  }

  const handleCreateProject = async (): Promise<void> => {
    const title = newTitle.trim() || 'New Project'
    setCreatingBusy(true)
    try {
      if (onCreateProject) {
        const newId = await onCreateProject(title)
        setSelectedProjectId(newId)
        setIsCreating(false)
        setNewTitle('')
      }
    } catch (err) {
      console.warn('Failed to create project:', err)
    } finally {
      setCreatingBusy(false)
    }
  }

  // Resizable projects sidebar width
  const [sidebarWidth, setSidebarWidth] = useState(270)
  const isResizingSidebar = useRef(false)
  const resizeStartX = useRef(0)
  const resizeStartWidth = useRef(270)

  const handleSidebarResizeStart = (e: React.PointerEvent): void => {
    e.preventDefault()
    isResizingSidebar.current = true
    resizeStartX.current = e.clientX
    resizeStartWidth.current = sidebarWidth
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }

  const handleSidebarResizeMove = (e: React.PointerEvent): void => {
    if (!isResizingSidebar.current) return
    const dx = e.clientX - resizeStartX.current
    const newWidth = Math.max(180, Math.min(500, resizeStartWidth.current + dx))
    setSidebarWidth(newWidth)
  }

  const handleSidebarResizeEnd = (e: React.PointerEvent): void => {
    if (!isResizingSidebar.current) return
    isResizingSidebar.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }

  const activeProject = selectedProjectId ? summaries[selectedProjectId] : undefined

  return (
    <div className={css.fullPageRoot} data-panel="agent-team-timeline">
      {/* LEFT COLUMN: Isolated Timeline Projects Bar */}
      <aside
        className={css.projectsSidebar}
        style={{ width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px`, maxWidth: `${sidebarWidth}px` }}
        aria-label={t('timeline.projects')}
      >
        <div className={css.sidebarHeader}>
          <div className={css.sidebarTitleRow}>
            <div className={css.sidebarTitleGroup}>
              <svg className={css.projectsIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
              </svg>
              <span className={css.sidebarTitleText}>{t('timeline.projects')}</span>
              <span className={css.projectCountBadge}>{projects.length}</span>
            </div>
            <button
              type="button"
              className={css.newProjectBtn}
              onClick={() => { setIsCreating(v => !v) }}
              title={t('timeline.newProject')}
              aria-label={t('timeline.newProject')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>{t('timeline.newProject')}</span>
            </button>
          </div>

          <div className={css.searchBox}>
            <input
              type="text"
              className={css.searchInput}
              placeholder={t('timeline.searchProjects')}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value) }}
            />
          </div>

          {isCreating && (
            <div className={css.createProjectForm}>
              <input
                type="text"
                className={css.createInput}
                autoFocus
                placeholder="Project name..."
                value={newTitle}
                onChange={(e) => { setNewTitle(e.target.value) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreateProject()
                  if (e.key === 'Escape') setIsCreating(false)
                }}
                disabled={creatingBusy}
              />
              <div className={css.createActions}>
                <button
                  type="button"
                  className={css.createSubmitBtn}
                  onClick={() => void handleCreateProject()}
                  disabled={creatingBusy}
                >
                  {creatingBusy ? '...' : t('timeline.createProject')}
                </button>
                <button
                  type="button"
                  className={css.createCancelBtn}
                  onClick={() => { setIsCreating(false) }}
                  disabled={creatingBusy}
                >
                  {t('timeline.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className={css.projectsList}>
          {workspaceGroups.length === 0 ? (
            <div className={css.emptyProjects}>{t('timeline.noProjects')}</div>
          ) : (
            workspaceGroups.map((group) => {
              const expanded = isExpanded(group.key)
              return (
                <div key={group.key} className={css.workspaceGroup}>
                  <button
                    type="button"
                    className={css.workspaceHeader}
                    onClick={() => { toggleFolder(group.key) }}
                    aria-expanded={expanded}
                    title={group.path || group.title}
                  >
                    <div className={css.workspaceTitleGroup}>
                      <span className={css.workspaceChevron}>
                        {expanded ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        )}
                      </span>
                      <span className={css.workspaceFolderIcon}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      </span>
                      <span className={css.workspaceTitle}>{group.title}</span>
                    </div>
                    <span className={css.workspaceCountBadge}>{group.projects.length}</span>
                  </button>

                  {expanded && (
                    <div className={css.workspaceSessionsList}>
                      {group.projects.length === 0 ? (
                        <div className={css.emptyFolder}>{t('timeline.emptyFolder')}</div>
                      ) : (
                        group.projects.map((project) => {
                          const isActive = project.id === selectedProjectId
                          return (
                            <button
                              key={project.id}
                              type="button"
                              className={classes(css.projectCard, isActive && css.projectCardActive)}
                              onClick={() => { handleSelectProject(project.id) }}
                            >
                              <div className={css.projectCardTop}>
                                <span className={css.projectCardTitle} title={project.title}>
                                  {project.title}
                                </span>
                              </div>
                              <div className={css.projectCardBottom}>
                                <span className={css.subagentBadge}>
                                  {project.subagents > 0 ? `${project.subagents} subagents` : 'Single agent'}
                                </span>
                                {project.updatedAt && (
                                  <span className={css.projectTime}>
                                    {formatRelativeTime(project.updatedAt)}
                                  </span>
                                )}
                              </div>
                            </button>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className={css.sidebarFooter}>
          <button
            type="button"
            className={css.backToChatBtn}
            onClick={onBackToChat}
            title={t('timeline.backToChat')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span>{t('timeline.backToChat')}</span>
          </button>
        </div>
      </aside>

      <div
        className={css.sidebarResizeHandle}
        onPointerDown={handleSidebarResizeStart}
        onPointerMove={handleSidebarResizeMove}
        onPointerUp={handleSidebarResizeEnd}
        onPointerCancel={handleSidebarResizeEnd}
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={sidebarWidth}
        title="Drag to resize projects sidebar"
      />

      {/* CENTER COLUMN: Timeline Main View */}
      <section className={css.centerMainArea}>
        <header className={css.topBar}>
          <div className={css.leftGroup}>
            <span className={css.pageTitle}>{activeProject?.title || activeProject?.displayTitle || t('timeline.fullPageTitle')}</span>
            <div className={css.liveBadge}>
              <span className={css.liveDot} />
              <span>Agent team</span>
            </div>
            <div className={css.modeBadge}>
              <span>PTC mode</span>
            </div>
            <div className={css.subagentsBadge} title="8 subagents in multi-agent team">
              <span>8 subagents</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </div>
          <div className={css.rightGroup}>
            {timelineInjected.openPlan && selectedProjectId && (
              <button
                type="button"
                className={css.planMdBtn}
                onClick={() => { timelineInjected.openPlan?.(selectedProjectId, 'plan.md') }}
                title="Open plan.md in right viewer"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span>plan.md</span>
              </button>
            )}
            {onToggleSidebarRight && (
              <button
                type="button"
                className={css.toggleRightbarBtn}
                onClick={onToggleSidebarRight}
                title={t('timeline.toggleSidebarRight')}
                aria-label={t('timeline.toggleSidebarRight')}
                data-sidebar-right-toggle
              >
                <IconPanelLeftOutlineRegular className={css.toggleRightbarIcon} />
              </button>
            )}
          </div>
        </header>

        <main className={css.contentArea}>
          {selectedProjectId ? (
            <DelegationTimelineView
              key={selectedProjectId}
              sessionId={selectedProjectId}
              useSessions={useSessions}
              useSessionStatus={useSessionStatus}
              t={t}
              {...timelineInjected}
            />
          ) : (
            <div className={css.noProjectSelected}>Select or create a project to view its timeline.</div>
          )}
        </main>
      </section>
    </div>
  )
}
