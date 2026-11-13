/** Source-safe Agent Teams browser registration. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { TeamAction, type TeamActionInjected } from './TeamAction.tsx'
import { DelegationTimelineView, type CreateTaskInput, type TimelineViewInjected } from './DelegationTimelineView.tsx'
import { TimelinePanelIcon } from './TimelinePanelIcon.tsx'
import { DelegationTimelineFullPage, type DelegationTimelineFullPageInjected } from './DelegationTimelineFullPage.tsx'
import type { Config } from '../index.ts'
import { AGENT_TEAM_UI_CONFIG_GLOBAL } from '../index.ts'
import { en, ja, es, fr, de, ru, pt, NS, zh, type TeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent Teams roster and task-board copy. */
    'agent-team': TeamKey
  }
}

/** Implementation identity in the panel and tab system. */
export const PANEL_ID = 'agent-team-timeline' as MainPanelId

/** Backward-compatible alias for the panel id. */
export const TAB_ID = PANEL_ID

/** Discriminator for the Timeline tab. */
export const TAB_KIND = PANEL_ID

/** Required browser services for navigation, slots, and localized copy. */
export const inject = ['sessions', 'uiWorkspace', 'slots', 'locale', 'layout', 'sidebarRight']

/** Determine whether the timeline view mode is enabled. */
export function isTimelineEnabled(config?: Config): boolean {
  if (config !== undefined) {
    return config.mode === 'timeline' || config.timeline === true
  }
  const globalConfig = Reflect.get(globalThis, AGENT_TEAM_UI_CONFIG_GLOBAL) as Config | undefined
  return globalConfig?.mode === 'timeline' || globalConfig?.timeline === true
}

/**
 * Register the Team locale dictionaries, conversation-header action, and the left-sidebar Timeline panel.
 * @param ctx - Client Context carrying the injected services.
 * @param config - Optional configuration override.
 */
export function registerAgentTeamUi(ctx: ClientContext, config?: Config): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'client-ui-agent-team: dictionaries')
  const t = ctx.locale.bind(NS)
  const sessions = ctx.sessions
  const leadSessionId = (sessionId: SessionId): SessionId => {
    const address = sessions.binding(sessionId)?.session.getSnapshot().subagent?.address
    return address?.parentSessionId ?? sessionId
  }

  const actions: TeamActionInjected & TimelineViewInjected = {
    openTeammate(sessionId: SessionId, childSessionId: SessionId): void {
      const parentSessionId = leadSessionId(sessionId)
      if ((sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) === 0) return
      if (childSessionId === parentSessionId) {
        ctx.uiWorkspace.openSession(parentSessionId)
        return
      }
      ctx.uiWorkspace.openSession({
        parentSessionId,
        childSessionId,
        mode: 'continuable',
      })
    },
    async selectModel(sessionId: SessionId, provider: string, model: string): Promise<void> {
      try {
        const remote = (ctx as unknown as { remote?: { session?: { selectModel?: (req: unknown) => Promise<unknown> } } }).remote
          ?? (ctx.get('remote') as { session?: { selectModel?: (req: unknown) => Promise<unknown> } } | undefined)
        await remote?.session?.selectModel?.({
          sessionId,
          provider,
          model,
        })
      } catch (err) {
        console.warn('Failed to select model via remote RPC:', err)
      }
    },
    async dispatchTask(leadId: SessionId, taskId: string): Promise<void> {
      const binding = sessions.binding(leadId)
      if (binding === undefined) return
      await binding.session.prompt([
        {
          type: 'text',
          text: `[User Action from Timeline] Please dispatch task ${taskId} by calling team_task_update with action "dispatch" and task_id "${taskId}".`,
        },
      ], 'steer')
    },
    async createTask(leadId: SessionId, task: CreateTaskInput): Promise<void> {
      const binding = sessions.binding(leadId)
      if (binding === undefined) return
      const params = [
        `subject: ${JSON.stringify(task.subject)}`,
        task.assignedTo ? `assigned_to: ${JSON.stringify(task.assignedTo)}` : undefined,
        task.provider ? `provider: ${JSON.stringify(task.provider)}` : undefined,
        task.model ? `model: ${JSON.stringify(task.model)}` : undefined,
        task.mcpServers && task.mcpServers.length > 0 ? `mcp_servers: ${JSON.stringify(task.mcpServers)}` : undefined,
        `staged: ${task.staged !== false}`,
      ].filter(Boolean).join(', ')
      await binding.session.prompt([
        {
          type: 'text',
          text: `[User Action from Timeline] Please create a team task by calling team_task_create with { ${params} }.`,
        },
      ], 'steer')
    },
    openPlan(sessionId: SessionId, filePath: string = 'plan.md'): void {
      const parentSessionId = leadSessionId(sessionId)
      const address = `dsh-resource://file/session/${parentSessionId}/${filePath}`
      try {
        ctx.sidebarRight.openResource(address, {
          preferNewPane: true,
        })
      } catch (err) {
        console.warn('Failed to open markdown file in sidebar split:', err)
      }
    },
  }

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agent-team',
      order: -20,
      locale: NS,
      inject: () => actions,
    }, TeamAction),
  )

  if (isTimelineEnabled(config)) {
    ctx.slots.inject(
      'conversation.view',
      () => ctx.slots.register({
        name: 'conversation.view',
        id: 'timeline',
        order: 25,
        locale: NS,
        label: () => t('view.timeline'),
        inject: (): TimelineViewInjected => ({
          openTeammate: actions.openTeammate,
          selectModel: actions.selectModel,
          dispatchTask: actions.dispatchTask,
          createTask: actions.createTask,
          openPlan: actions.openPlan,
        }),
      }, DelegationTimelineView),
    )

    ctx.slots.inject(
      'sidebar.panellist',
      () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 2,
        label: () => t('view.timeline'),
        locale: NS,
      }, TimelinePanelIcon),
    )

    ctx.slots.inject(
      'main',
      () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: (): DelegationTimelineFullPageInjected => ({
          openTeammate: actions.openTeammate,
          selectModel: actions.selectModel,
          dispatchTask: actions.dispatchTask,
          createTask: actions.createTask,
          openPlan: actions.openPlan,
          onBackToChat: () => {
            ctx.layout.selectPanel(null)
          },
          resolveLeadSessionId: (sid?: SessionId): SessionId | undefined => {
            const id = sid ?? sessions.list.getSnapshot().ids[0]
            if (!id) return undefined
            return leadSessionId(id)
          },
          onToggleSidebarRight: () => {
            try {
              ctx.sidebarRight.toggleExpanded()
            } catch (err) {
              console.warn('Failed to toggle right sidebar from timeline:', err)
            }
          },
          onSelectProject: (sessionId: SessionId) => {
            try {
              ctx.uiWorkspace.openSession(sessionId)
              ctx.layout.selectPanel(PANEL_ID)
            } catch (err) {
              console.warn('Failed to open project session in workspace:', err)
            }
            // Open the project's workspace files in the right sidebar so the
            // user can browse the workspace folder associated with this project.
            try {
              const address = `dsh-resource://file/session/${sessionId}/`
              ctx.sidebarRight.openResourceIn(sessionId, address, { preferNewPane: false })
              if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded()
            } catch {
              // openResourceIn may throw if the session surface is not yet mounted;
              // the right sidebar may not have adopted this session yet — silent skip.
            }
          },
          onCreateProject: async (title?: string): Promise<SessionId> => {
            const createdId = await ctx.sessions.create()
            const trimmedTitle = title?.trim()
            if (trimmedTitle) {
              try {
                const remote = (ctx as unknown as { remote?: { session?: { rename?: (req: unknown) => Promise<unknown> } } }).remote
                  ?? (ctx.get('remote') as { session?: { rename?: (req: unknown) => Promise<unknown> } } | undefined)
                await remote?.session?.rename?.({
                  sessionId: createdId,
                  title: trimmedTitle,
                })
              } catch (err) {
                console.warn('Failed to rename new project session via RPC:', err)
              }
            }
            try {
              ctx.uiWorkspace.openSession(createdId)
              ctx.layout.selectPanel(PANEL_ID)
            } catch (err) {
              console.warn('Failed to open new project session in workspace:', err)
            }
            return createdId
          },
          getWorkspaces: (): readonly WorkspaceView[] => {
            return (ctx as unknown as { workspaces?: { list?: { getSnapshot?: () => { items?: readonly WorkspaceView[] } } } })
              .workspaces?.list?.getSnapshot?.()?.items ?? []
          },
        }),
      }, DelegationTimelineFullPage),
    )
  }
}
