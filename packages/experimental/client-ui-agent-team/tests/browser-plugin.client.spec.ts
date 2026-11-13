import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TeamAction, type TeamActionInjected } from '../src/client/TeamAction.tsx'
import { DelegationTimelineView } from '../src/client/DelegationTimelineView.tsx'
import { DelegationTimelineFullPage, type DelegationTimelineFullPageInjected } from '../src/client/DelegationTimelineFullPage.tsx'
import { apply, inject, type Config } from '../src/client/index.ts'
import { PANEL_ID } from '../src/client/mount.ts'
import { apply as nodeApply } from '../src/index.ts'

const SESSION = 'team-session' as SessionId
const CHILD = 'team-child' as SessionId

async function bench(options: { addressed?: boolean; config?: Config } = {}) {
  const ctx = new Context()
  const navigation: unknown[] = []
  let mainSessionId = options.addressed === true ? CHILD : SESSION
  ctx.provide('sessions', {
    binding: (id: SessionId) => options.addressed === true && id === CHILD
      ? { session: { getSnapshot: () => ({
        subagent: {
          address: {
            parentSessionId: SESSION,
            childSessionId: CHILD,
            mode: 'continuable' as const,
          },
        },
      }) } }
      : undefined,
    refreshProjections: (id: SessionId) => {
      navigation.push(['refresh', id])
      return Promise.resolve()
    },
    retainInfo: (id: SessionId) => ({
      getSnapshot: () => ({
        referenceCount: id === mainSessionId ? 1 : 0,
        retainedBy: id === mainSessionId ? { mainView: 1 } : {},
      }),
      subscribe: () => () => {},
    }),
    list: {
      getSnapshot: () => ({
        ids: [mainSessionId],
        byId: {},
        phase: 'ready' as const,
        projectionsBySession: {},
      }),
    },
  })
  ctx.provide('uiWorkspace', {
    openSession: (target: unknown) => { navigation.push(['open', target]) },
  } as never)
  ctx.provide('conversation', {})
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('layout', {
    selectPanel: (id: string | null) => { navigation.push(['selectPanel', id]) },
  } as never)
  ctx.provide('sidebarRight', {
    toggleExpanded: () => { navigation.push(['toggleExpanded']) },
  } as never)

  await ctx.plugin(SlotRegistry).await()
  const collapseHeader = ctx.slots.register({
    name: 'root',
    children: {
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'conversation.view': { kind: 'list', scope: 'session' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'main': { kind: 'keyed', scope: 'root' },
    },
  } as never, () => null)
  const fiber = ctx.plugin({
    inject: [...inject],
    apply: (scope: Context) => {
      apply(scope, options.config)
    },
  })
  await fiber.await()
  const entry = () => ctx.slots.entries('conversation.session.header.actions')
    .find(candidate => candidate.component === TeamAction)
  const conversationViewEntry = () => ctx.slots.entries('conversation.view')
    .find(candidate => candidate.options.id === 'timeline' && candidate.component === DelegationTimelineView)
  const sidebarEntry = () => ctx.slots.entries('sidebar.panellist')
    .find(candidate => candidate.options.id === PANEL_ID)
  const mainEntry = () => ctx.slots.entries('main')
    .find(candidate => candidate.options.key === PANEL_ID && candidate.component === DelegationTimelineFullPage)
  const actions = (): TeamActionInjected => {
    const injected = entry()!.inject!()
    const { openTeammate } = injected
    if (typeof openTeammate !== 'function') {
      throw new Error('Team header action lacks its injected callbacks')
    }
    return {
      openTeammate: openTeammate as TeamActionInjected['openTeammate'],
    }
  }
  return {
    ctx,
    fiber,
    navigation,
    entry,
    conversationViewEntry,
    sidebarEntry,
    mainEntry,
    actions,
    collapseHeader,
    select: (sessionId: SessionId) => { mainSessionId = sessionId },
  }
}

describe('ui-team browser plugin', () => {
  it('registers one disposable header action without a Team Remote namespace', async () => {
    const b = await bench()
    expect(inject).toEqual(['sessions', 'uiWorkspace', 'slots', 'locale', 'layout', 'sidebarRight'])
    expect(b.entry()).toMatchObject({
      options: { id: 'agent-team', order: -20 },
      locale: 'agent-team',
    })
    const t = b.ctx.locale.bind('agent-team')
    expect(t('trigger')).toBe('Agent team')

    expect(b.navigation).toEqual([])

    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(t('empty')).toBe('empty')
  })

  it('opens a continuable teammate address without touching the parent catalog', async () => {
    const b = await bench()
    b.actions().openTeammate(SESSION, CHILD)
    expect(b.navigation).toEqual([['open', {
      parentSessionId: SESSION,
      childSessionId: CHILD,
      mode: 'continuable',
    }]])
  })

  it('routes teammate navigation from an addressed teammate conversation back through its Lead', async () => {
    const b = await bench({ addressed: true })
    b.actions().openTeammate(CHILD, CHILD)
    expect(b.navigation).toEqual([['open', {
      parentSessionId: SESSION,
      childSessionId: CHILD,
      mode: 'continuable',
    }]])
  })

  it('opens the Lead from an addressed teammate conversation', async () => {
    const b = await bench({ addressed: true })
    b.actions().openTeammate(CHILD, SESSION)
    expect(b.navigation).toEqual([['open', SESSION]])
  })

  it('does not open a teammate from a conversation outside the main view', async () => {
    const b = await bench()
    b.select('other' as SessionId)
    b.actions().openTeammate(SESSION, CHILD)
    expect(b.navigation).toEqual([])
  })

  it('re-registers after the conversation header slot is collapsed and declared again', async () => {
    const b = await bench()
    b.collapseHeader()
    expect(b.entry()).toBeUndefined()

    b.ctx.slots.register({
      name: 'root',
      children: { 'conversation.session.header.actions': { kind: 'list', scope: 'session' } },
    } as never, () => null)
    await Promise.resolve()
    expect(b.entry()).toBeDefined()
  })

  it('isolates the timeline in default classic mode (does not register timeline views)', async () => {
    const b = await bench()
    expect(b.entry()).toBeDefined()
    expect(b.conversationViewEntry()).toBeUndefined()
    expect(b.sidebarEntry()).toBeUndefined()
    expect(b.mainEntry()).toBeUndefined()
  })

  it('registers the timeline panel in conversation.view, sidebar.panellist and main slot when mode is timeline', async () => {
    const b = await bench({ config: { mode: 'timeline' } })
    expect(b.conversationViewEntry()).toBeDefined()
    expect(b.conversationViewEntry()!.options).toMatchObject({
      id: 'timeline',
      order: 25,
    })
    const t = b.ctx.locale.bind('agent-team')
    const convLabel = b.conversationViewEntry()!.options.label
    expect(typeof convLabel === 'function' ? convLabel() : convLabel).toBe(t('view.timeline'))

    expect(b.sidebarEntry()).toBeDefined()
    expect(b.sidebarEntry()!.options).toMatchObject({
      id: PANEL_ID,
      order: 2,
    })
    const sidebarLabel = b.sidebarEntry()!.options.label
    expect(typeof sidebarLabel === 'function' ? sidebarLabel() : sidebarLabel).toBe(t('view.timeline'))

    expect(b.mainEntry()).toBeDefined()
    expect(b.mainEntry()!.options).toMatchObject({
      key: PANEL_ID,
    })

    const mainInjected = b.mainEntry()!.inject!() as unknown as DelegationTimelineFullPageInjected
    expect(typeof mainInjected.onBackToChat).toBe('function')
    mainInjected.onBackToChat()
    expect(b.navigation).toContainEqual(['selectPanel', null])

    expect(typeof mainInjected.onToggleSidebarRight).toBe('function')
    mainInjected.onToggleSidebarRight!()
    expect(b.navigation).toContainEqual(['toggleExpanded'])
  })

  it('registers the timeline panel when timeline boolean config is true', async () => {
    const b = await bench({ config: { timeline: true } })
    expect(b.conversationViewEntry()).toBeDefined()
    expect(b.sidebarEntry()).toBeDefined()
    expect(b.mainEntry()).toBeDefined()
  })

  it('publishes config to webserver/index-inject on the host', () => {
    const hostCtx = new Context()
    const table: { kind: string; name: string; value: unknown }[] = []
    nodeApply(hostCtx, { mode: 'timeline' })
    hostCtx.emit('webserver/index-inject' as never, table)
    expect(table).toEqual([{
      kind: 'global',
      name: '__DSH_AGENT_TEAM_UI_CONFIG__',
      value: { mode: 'timeline' },
    }])
  })
})
