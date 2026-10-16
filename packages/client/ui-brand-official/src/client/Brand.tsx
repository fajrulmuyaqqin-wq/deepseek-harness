import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the Boson quantum orbital mark.
 * @param props - Host-supplied mark presentation (size).
 * @returns the Boson quantum particle mark.
 */
export function BosonBrandMark({ size = 24 }: SidebarBrandMarkOwnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
      <ellipse
        cx="12"
        cy="12"
        rx="9.6"
        ry="3.8"
        transform="rotate(30 12 12)"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <ellipse
        cx="12"
        cy="12"
        rx="9.6"
        ry="3.8"
        transform="rotate(-30 12 12)"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <ellipse
        cx="12"
        cy="12"
        rx="9.6"
        ry="3.8"
        transform="rotate(90 12 12)"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="19.2" cy="7.8" r="1.2" fill="currentColor" />
      <circle cx="4.8" cy="16.2" r="1.2" fill="currentColor" />
      <circle cx="12" cy="2.4" r="1.2" fill="currentColor" />
    </svg>
  )
}

/**
 * Render the Boson Studio typographic wordmark.
 * Uses exact viewBox="26 0 156 24" to match standard brand slot dimensions.
 * @returns the Boson Studio wordmark.
 */
export function BosonBrandName() {
  return (
    <svg
      width={156}
      height={24}
      viewBox="26 0 156 24"
      fill="none"
      aria-hidden="true"
    >
      <text
        x="32"
        y="17"
        fill="currentColor"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        fontWeight="800"
        fontSize="14.5"
        letterSpacing="0.08em"
      >
        BOSON
      </text>
      <rect
        x="98"
        y="5"
        width="54"
        height="14"
        rx="3"
        fill="currentColor"
        fillOpacity="0.16"
      />
      <text
        x="125"
        y="15.5"
        fill="currentColor"
        fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        fontWeight="700"
        fontSize="8.5"
        letterSpacing="0.14em"
        textAnchor="middle"
      >
        STUDIO
      </text>
    </svg>
  )
}

/**
 * Render the hero mark for the empty chat screen (size 34).
 * @param props - Presentation props including size and className.
 * @returns the hero quantum mark.
 */
export function BosonHeroMark({ size = 34, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.6" fill="currentColor" />
      <ellipse
        cx="12"
        cy="12"
        rx="10"
        ry="4"
        transform="rotate(30 12 12)"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <ellipse
        cx="12"
        cy="12"
        rx="10"
        ry="4"
        transform="rotate(-30 12 12)"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <ellipse
        cx="12"
        cy="12"
        rx="10"
        ry="4"
        transform="rotate(90 12 12)"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="19.5" cy="7.7" r="1.3" fill="currentColor" />
      <circle cx="4.5" cy="16.3" r="1.3" fill="currentColor" />
      <circle cx="12" cy="2" r="1.3" fill="currentColor" />
    </svg>
  )
}

/** Official brand mark occupant alias. */
export const OfficialBrandMark = BosonBrandMark

/** Official brand name occupant alias. */
export const OfficialBrandName = BosonBrandName
