/** Registers the sidebar shell and global panel navigation. */
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session root standard-props merge.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SidebarPanelMetadata, SidebarRootInjected } from './contract/slots.ts'
import { HeaderLeadingControls } from './HeaderLeadingControls.tsx'
import { SidebarRoot } from './SidebarRoot.tsx'
import { en, zh, type SidebarKey } from './locales.ts'

export type {
  SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps, SidebarFooterActionOwnerProps,
  SidebarPanelIconOwnerProps, SidebarPanelMetadata,
  SidebarRootComponentProps, SidebarRootInjected, SidebarSectionOwnerProps, SidebarSettingsOwnerProps,
} from './contract/slots.ts'
export type { SidebarKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar controls and global panel copy. */
    sidebar: SidebarKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'sidebar'

interface WorkspaceNavigation {
  startSession(workspaceId?: Parameters<SidebarRootInjected['startSession']>[0]): void
}

/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'uiWorkspace', 'locale', 'shortcuts']

/** Registers the sidebar shell and its service callbacks.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar: dictionaries')
  const panels = createSnapshotStore<readonly SidebarPanelMetadata[]>([])
  const sessions = ctx.get('sessions') as ISessions | undefined
  const resolveCurrent = (list?: SessionListState): SessionId | undefined => {
    if (!list) return undefined
    return Object.values(list.byId).find(s => (s.retainedBy?.mainView ?? 0) > 0)?.id
  }
  const currentSessionId = createSnapshotStore<SessionId | undefined>(
    resolveCurrent(sessions?.list.getSnapshot()),
  )
  const activeView = createSnapshotStore<string>('chat')

  if (sessions !== undefined) {
    ctx.effect(() => sessions.list.subscribe(() => {
      const next = resolveCurrent(sessions.list.getSnapshot())
      if (currentSessionId.getSnapshot() !== next) {
        currentSessionId.set(next)
      }
    }), 'ui-sidebar: current session tracker')
  }

  ctx.effect(() => {
    let unbindView: (() => void) | undefined
    const syncForCurrent = (sid: SessionId | undefined) => {
      unbindView?.()
      unbindView = undefined
      const uiConv = ctx.get('uiConversation') as {
        activeView: (sessionId: SessionId) => string
        onViewChange: (sessionId: SessionId, listener: (view: string) => void) => () => void
      } | undefined
      if (sid !== undefined && uiConv !== undefined) {
        activeView.set(uiConv.activeView(sid))
        unbindView = uiConv.onViewChange(sid, (v) => { activeView.set(v) })
      } else {
        activeView.set('chat')
      }
    }
    syncForCurrent(currentSessionId.getSnapshot())
    const disposeSessionSub = currentSessionId.subscribe(() => {
      syncForCurrent(currentSessionId.getSnapshot())
    })
    return () => {
      disposeSessionSub()
      unbindView?.()
    }
  }, 'ui-sidebar: active view tracker')

  const toggleTrajectory = (): void => {
    const sid = currentSessionId.getSnapshot()
    if (sid === undefined) return
    const uiConv = ctx.get('uiConversation') as {
      selectView: (sessionId: SessionId, view: string) => void
    } | undefined
    if (uiConv === undefined) return
    const current = activeView.getSnapshot()
    const next = current === 'trajectory' ? 'chat' : 'trajectory'
    uiConv.selectView(sid, next)
    activeView.set(next)
  }

  const syncPanels = (): void => {
    const next = ctx.slots.entriesOfSlot('sidebar.panellist').map(({ options }) => {
      // The list registration requires an id; StoredEntry erases the slot kind.
      const id = options.id as MainPanelId
      return { id, order: options.order ?? 0, label: resolveSlotLabel(options.label) ?? id }
    }).sort((a, b) => a.order - b.order)
    const previous = panels.getSnapshot()
    if (previous.length === next.length && previous.every((panel, index) => {
      const candidate = next[index] as SidebarPanelMetadata
      return panel.id === candidate.id && panel.order === candidate.order && panel.label === candidate.label
    })) return
    panels.set(next)
  }
  ctx.effect(() => ctx.slots.subscribe('sidebar.panellist', syncPanels), 'ui-sidebar: panel entries')
  ctx.effect(() => ctx.locale.subscribe(syncPanels), 'ui-sidebar: panel labels')

  const injectProps = (): SidebarRootInjected => ({
    // The shell's New Session button rides the Workspace UI's shared action
    // (current Session Workspace, then recent Workspace).
    startSession: (workspaceId) => { workspaceNavigation.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    selectPanel: (id) => {
      if (id === 'plugins' || id === 'schedules') ctx.get('productAnalytics')?.track('sidebar_menu_click', { menu_name: id === 'plugins' ? 'plugin' : 'cron' })
      ctx.layout.selectPanel(id)
    },
    toggleTrajectory,
    hooks: {
      panels,
      shortcuts: ctx.shortcuts.catalog,
      currentSessionId,
      activeView,
    },
  })
  ctx.slots.inject('sidebar', () => ctx.slots.register({
    name: 'sidebar',
    locale: NS,
    children: {
      'sidebar.brand.mark': { kind: 'single', scope: 'root' },
      'sidebar.brand.name': { kind: 'single', scope: 'root' },
      'sidebar.toggle.badge': { kind: 'single', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'sidebar.settings': { kind: 'single', scope: 'root' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
    inject: injectProps,
  }, SidebarRoot))
  // macOS desktop hides the collapsed sidebar entirely, so the open/New
  // Session controls move into the frame's window-chrome seat beside the
  // traffic lights; the occupant reuses the shell's injected actions, and
  // the AppFrame mounts the seat only while the column is fully hidden.
  ctx.slots.inject('shell.leading', () => ctx.slots.register({
    name: 'shell.leading',
    locale: NS,
    inject: injectProps,
  }, HeaderLeadingControls))
  syncPanels()
}
