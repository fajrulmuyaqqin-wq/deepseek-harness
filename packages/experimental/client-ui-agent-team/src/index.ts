/** Pure host half for the browser-discovered Agent Teams UI plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'

/** Configuration options for the Agent Teams UI plugin. */
export interface Config {
  /**
   * Operating mode for Agent Teams UI:
   * - 'timeline': enables the Timeline conversation view, left sidebar icon, and full-page timeline view.
   * - 'classic': standard mode (only the header action modal dialog).
   * @default 'classic'
   */
  readonly mode?: 'timeline' | 'classic'
  /** Convenience boolean flag to enable timeline view (equivalent to `mode: 'timeline'`). */
  readonly timeline?: boolean
}

/** Loader schema for the Agent Teams UI plugin. */
export const Config: z<Config> = z.object({
  mode: z.union([z.const('timeline'), z.const('classic')]).default('classic'),
  timeline: z.boolean().default(false),
})

/** Window global identifier for injecting Agent Teams UI config into browser pages. */
export const AGENT_TEAM_UI_CONFIG_GLOBAL = '__DSH_AGENT_TEAM_UI_CONFIG__'

/**
 * Host plugin body; publishes Agent Teams UI preferences to browser pages.
 * @param ctx - Host context serving browser pages.
 * @param config - Validated plugin preferences.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: AGENT_TEAM_UI_CONFIG_GLOBAL,
      value: config,
    })
  })
}
