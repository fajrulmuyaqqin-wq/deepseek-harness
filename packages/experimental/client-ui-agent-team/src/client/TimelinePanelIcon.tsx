/** Left sidebar navigation icon for the Team Timeline panel. */

import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the Timeline / Gantt icon in the left sidebar at the size requested by ui-sidebar.
 * @param props - size and active state from sidebar.panellist.
 * @returns React SVG element.
 */
export function TimelinePanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="6" x2="16" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="5" y1="18" x2="18" y2="18" />
      <circle cx="3" cy="6" r="1.5" fill="currentColor" />
      <circle cx="8" cy="12" r="1.5" fill="currentColor" />
      <circle cx="5" cy="18" r="1.5" fill="currentColor" />
    </svg>
  )
}
