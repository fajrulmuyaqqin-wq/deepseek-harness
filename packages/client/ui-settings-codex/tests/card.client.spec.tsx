// @vitest-environment jsdom
/** The codex settings page as the Plugins page renders it: fields and resets. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { CodexCard, type CodexCardProps } from '../src/client/CodexCard.tsx'
import type { CodexCardState } from '../src/client/codex-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: SettingsFormShell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

function field(text: string, rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

describe('CodexCard', () => {
  function renderCodex(state: Partial<CodexCardState> = {}) {
    const store = createSnapshotStore<CodexCardState>({
      ...settled,
      binaryPath: field(''),
      socketPath: field('/tmp/codex-engine.sock'),
      socketHost: field(''),
      socketPort: field(''),
      permissionMode: field('never'),
      model: field(''),
      ...state,
    })
    const actions = cardActions()
    const props = { ...actions, view: 'page', t, useCodexCard: bindSnapshotSelector(store) } as CodexCardProps
    render(<CodexCard {...props} />)
    return actions
  }

  it('renders its one-liner alone in the summary view', () => {
    const store = createSnapshotStore<CodexCardState>({
      ...settled,
      binaryPath: field(''),
      socketPath: field('/tmp/codex-engine.sock'),
      socketHost: field(''),
      socketPort: field(''),
      permissionMode: field('never'),
      model: field(''),
    })
    const props = { ...cardActions(), view: 'summary', t, useCodexCard: bindSnapshotSelector(store) } as CodexCardProps
    render(<CodexCard {...props} />)

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.socketPath)).toBeNull()
  })

  it('renders the form fields in page view and binds edit callbacks', () => {
    const actions = renderCodex()

    const socketPathInput = screen.getByLabelText(en.socketPath)
    expect(socketPathInput).toBeTruthy()
    expect((socketPathInput as HTMLInputElement).value).toBe('/tmp/codex-engine.sock')

    fireEvent.change(socketPathInput, { target: { value: '/tmp/new.sock' } })
    expect(actions.edit).toHaveBeenCalledWith('socketPath', '/tmp/new.sock')
  })
})
