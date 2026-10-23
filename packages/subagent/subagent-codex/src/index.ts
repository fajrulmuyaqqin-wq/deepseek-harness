/**
 * Profile-named Codex one-shot subagent provider. Every accepted run starts a
 * fresh official package-local Codex wrapper with `app-server --stdio` in the
 * delegating Session's workspace and publishes only after an ephemeral thread exists.
 *
 * @module @deepseek-ai/dsh-subagent-codex
 */

import type {} from '@deepseek-ai/dsh-settings'
import { resolve } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  assertUsableCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  CODEX_PERMISSION_MODES,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  codexStartupFailure,
  startCodexRun,
  type CodexPermissionMode,
  type CodexRunSpec,
} from './run.ts'

export const name = 'subagent-codex'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'codex'

/** Deployment-owned model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `codex`). */
  providerName?: string
  /** Native Codex model fixed for this instance; omitted to inherit Codex settings. */
  model?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Native non-interactive permission mode fixed for this Provider instance. */
  permissionMode?: CodexPermissionMode
  /** Grace in milliseconds between app-server managed-range termination tiers. */
  disposeGraceMs?: number
  /** Unix domain socket path for direct socket connection (e.g. /tmp/codex-engine.sock). */
  socketPath?: string
  /** TCP socket host (e.g. 127.0.0.1). */
  socketHost?: string
  /** TCP socket port (e.g. 4500). */
  socketPort?: number
  /** Whether to automatically launch the background daemon if the socket is unreachable (default true). */
  autoStartDaemon?: boolean
  /** Custom engine binary path (omitted to use bundled binary in bin/). */
  binaryPath?: string
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...CODEX_PERMISSION_MODES])
    .default(DEFAULT_CODEX_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  socketPath: z.string(),
  socketHost: z.string(),
  socketPort: z.number().min(1).max(65535),
  autoStartDaemon: z.boolean().default(true),
  binaryPath: z.string(),
})

interface ResolvedConfig {
  providerName: string
  model?: Volatile<string | undefined> | string | undefined
  env: Record<string, string>
  permissionMode: Volatile<CodexPermissionMode> | CodexPermissionMode
  disposeGraceMs: number
  socketPath?: Volatile<string | undefined> | string | undefined
  socketHost?: Volatile<string | undefined> | string | undefined
  socketPort?: Volatile<number | undefined> | number | undefined
  autoStartDaemon?: Volatile<boolean> | boolean | undefined
  binaryPath?: Volatile<string | undefined> | string | undefined
}

import { ensureCodexDaemon, type DaemonHandle } from './daemon.ts'

class CodexProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  private readonly daemons: DaemonHandle[] = []

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async dispose(): Promise<void> {
    for (const d of this.daemons) {
      try {
        await d.dispose()
      } catch (err: unknown) {
        this.ctx.logger.warn(`subagent-codex: error terminating daemon: ${(err as Error).message}`)
      }
    }
    this.daemons.length = 0
  }

  async start(request: ResolvedSubagentStartRequest) {
    let cwd: string
    try {
      cwd = assertUsableCwd('subagent-codex', 'child cwd', request.cwd)
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-codex: request was aborted before app-server startup',
        )
      }
      throw codexStartupFailure(error)
    }

    function readVolatile<T>(val: Volatile<T> | T | undefined, fallback: T): T {
      if (val !== null && typeof val === 'object' && 'get' in (val as object) && typeof (val as { get?: unknown }).get === 'function') {
        return ((val as Volatile<T>).get() ?? fallback) as T
      }
      return ((val as T | undefined) ?? fallback) as T
    }

    const currentModel = readVolatile(this.config.model, undefined)
    const currentPermission = readVolatile(this.config.permissionMode, DEFAULT_CODEX_PERMISSION_MODE)
    const currentSocketPath = readVolatile(this.config.socketPath, undefined)
    const currentSocketHost = readVolatile(this.config.socketHost, undefined)
    const currentSocketPort = readVolatile(this.config.socketPort, undefined)
    const autoStart = readVolatile(this.config.autoStartDaemon, false)
    const binaryPath = readVolatile(this.config.binaryPath, undefined)

    const subagentEnv: Record<string, string> = {
      ...this.config.env,
    }
    if (process.env.DEEPSEEK_API_KEY && !subagentEnv.OPENAI_API_KEY) {
      subagentEnv.OPENAI_API_KEY = process.env.DEEPSEEK_API_KEY
      if (!subagentEnv.OPENAI_BASE_URL) {
        subagentEnv.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
      }
      if (!subagentEnv.CODEX_HOME) {
        const codexHome = resolve(process.env.HOME ?? '/tmp', '.dsh/codex')
        try {
          const { mkdirSync } = await import('node:fs')
          mkdirSync(codexHome, { recursive: true })
        } catch {}
        subagentEnv.CODEX_HOME = codexHome
      }
    }

    const isExplicitSocketMode = currentSocketPath !== undefined || currentSocketPort !== undefined
    if (autoStart && isExplicitSocketMode) {
      try {
        const daemon = await ensureCodexDaemon({
          socketPath: currentSocketPath,
          socketHost: currentSocketHost,
          socketPort: currentSocketPort,
          binaryPath,
          env: subagentEnv,
        })
        if (daemon.pid) {
          this.ctx.logger.info(`subagent-codex: automatically spawned daemon (pid ${daemon.pid})`)
          this.daemons.push(daemon)
        }
      } catch (err: unknown) {
        this.ctx.logger.warn(`subagent-codex: auto-spawn daemon notice: ${(err as Error).message}`)
      }
    }

    const spec: CodexRunSpec = {
      cwd,
      ...currentModel === undefined ? {} : { model: currentModel },
      permissionMode: currentPermission,
      env: subagentEnv,
      disposeGraceMs: this.config.disposeGraceMs,
      ...binaryPath === undefined ? {} : { binaryPath },
      ...currentSocketPath === undefined ? {} : { socketPath: currentSocketPath },
      ...currentSocketHost === undefined ? {} : { socketHost: currentSocketHost },
      ...currentSocketPort === undefined ? {} : { socketPort: currentSocketPort },
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-codex "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startCodexRun(request, spec)
  }
}

/**
 * Register one Profile-named Codex provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const disposeGraceMs = config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS
  assertPositiveFinite(
    'subagent-codex',
    'disposeGraceMs',
    disposeGraceMs,
  )
  if (disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-codex: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    model: config.model,
    env: (config.env ?? {}) as Record<string, string>,
    permissionMode: config.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
    disposeGraceMs,
    socketPath: config.socketPath,
    socketHost: config.socketHost,
    socketPort: config.socketPort,
    autoStartDaemon: config.autoStartDaemon,
    binaryPath: config.binaryPath,
  }
  const provider = new CodexProvider(
    resolved.providerName,
    ctx,
    resolved,
  )
  ctx.subagents.registerProvider(provider)
  ctx.effect(() => () => {
    void provider.dispose()
  })
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}

