import { describe, expect, it } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { stubConfigForm, type StubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { CodexCardController, type CodexSettings } from '../src/client/codex-card-controller.ts'

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubConfigForm<T>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.set.mockImplementation((field: string, value: unknown) => {
    host.publish({ value: { ...section(), [field]: value } as T, user: { ...layer(), [field]: value } })
  })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const value = { ...section() }
    const user = { ...layer() }
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') {
        value[field] = op.value
        user[field] = op.value
      } else {
        Reflect.deleteProperty(user, field)
        value[field] = (host.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
      }
    }
    host.publish({ value: value as T, user })
    return Promise.resolve(true)
  })
  host.unset.mockImplementation((field: string) => {
    const user = Object.fromEntries(Object.entries(layer()).filter(([key]) => key !== field))
    const base = host.scope.getSnapshot().base as Record<string, unknown> | undefined
    host.publish({ value: { ...section(), [field]: base?.[field] } as T, user })
  })
}

describe('CodexCardController', () => {
  it('reads form initial snapshot and stages edits', async () => {
    const host = stubConfigForm<CodexSettings>()
    acceptWrites(host)
    host.publish({
      status: 'ready',
      writable: true,
      value: {
        socketPath: '/tmp/codex-engine.sock',
        socketHost: '127.0.0.1',
        socketPort: 4500,
        permissionMode: 'never',
        model: 'codex-1',
      },
      user: {},
    })

    const controller = new CodexCardController(host.scope)
    const face = controller.inject()
    const state = () => face.hooks.codexCard.getSnapshot()

    expect(state().socketPath.text).toBe('/tmp/codex-engine.sock')
    expect(state().socketHost.text).toBe('127.0.0.1')
    expect(state().socketPort.text).toBe('4500')
    expect(state().permissionMode.text).toBe('never')
    expect(state().model.text).toBe('codex-1')

    // Edit socket path
    face.edit('socketPath', '/tmp/custom.sock')
    expect(state().socketPath.text).toBe('/tmp/custom.sock')
    expect(state().dirty).toBe(true)

    // Save
    await face.save()
    expect(host.mutate).toHaveBeenCalled()
    expect(state().dirty).toBe(false)
    expect(state().socketPath.text).toBe('/tmp/custom.sock')

    controller.dispose()
  })

  it('resets field to default and discards unsaved changes', () => {
    const host = stubConfigForm<CodexSettings>()
    host.publish({
      status: 'ready',
      writable: true,
      value: { socketPath: '/tmp/codex-engine.sock' },
      user: { socketPath: '/tmp/codex-engine.sock' },
      base: { socketPath: '/tmp/default.sock' },
    })

    const controller = new CodexCardController(host.scope)
    const face = controller.inject()
    const state = () => face.hooks.codexCard.getSnapshot()

    face.edit('socketPath', '/tmp/new.sock')
    expect(state().socketPath.text).toBe('/tmp/new.sock')

    face.discard()
    expect(state().socketPath.text).toBe('/tmp/codex-engine.sock')

    controller.dispose()
  })
})
