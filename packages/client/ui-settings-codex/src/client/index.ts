/**
 * The Codex subagent settings page, browser half: socket connection,
 * permissions, and model override over the `subagent-codex` namespace.
 * The page registers into the Plugins page's `plugins.item` slot while
 * the Host serves that namespace.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { CodexCard } from './CodexCard.tsx'
import { CODEX_NS, CodexCardController } from './codex-card-controller.ts'
import { en, zh, type CodexSettingsLocaleKey } from './locales.ts'

export type { CodexCardProps } from './CodexCard.tsx'
export type { CodexCardFace, CodexCardState, CodexSettings } from './codex-card-controller.ts'
export type { CodexSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Codex settings page copy. */
    'settings.codex': CodexSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.codex'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the codex subagent settings page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-codex: dictionaries')
  const card = new CodexCardController(ctx.configForms.get(CODEX_NS))
  ctx.effect(() => () => { card.dispose() }, 'ui-settings-codex: form subscription')
  ctx.effect(() => ctx.configForms.whileServed([CODEX_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'subagent-codex', order: 25, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, CodexCard))), 'ui-settings-codex: page')
}
