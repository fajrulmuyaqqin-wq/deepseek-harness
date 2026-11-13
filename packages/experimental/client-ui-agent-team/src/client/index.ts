/** Browser entry registering the Agent Teams conversation-header action. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { registerAgentTeamUi } from './mount.ts'
import type { Config } from '../index.ts'

export { inject } from './mount.ts'
export type { TeamActionInjected, TeamActionProps } from './TeamAction.tsx'
export type { TeamKey } from './locales.ts'
export type { Config } from '../index.ts'

/**
 * Register the Team locale dictionaries, header action, and optional timeline on the Client Context.
 * @param ctx - Client Context with the declared `inject` services available.
 * @param config - Optional configuration overrides.
 */
export function apply(ctx: ClientContext, config?: Config): void {
  registerAgentTeamUi(ctx, config)
}
