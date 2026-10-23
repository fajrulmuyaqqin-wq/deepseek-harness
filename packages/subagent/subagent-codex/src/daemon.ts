/**
 * Daemon lifecycle manager for bundled or external Codex engine binaries.
 * Automatically probes, spawns, and cleans up the background server so
 * end users experience zero-setup socket connectivity out of the box.
 *
 * @module @deepseek-ai/dsh-subagent-codex/daemon
 */

import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Default Unix domain socket path located in user runtime or home directory. */
export const DEFAULT_SOCKET_PATH = process.env.XDG_RUNTIME_DIR
  ? `${process.env.XDG_RUNTIME_DIR}/codex-engine.sock`
  : `${process.env.HOME ?? '/tmp'}/.dsh/codex/codex-engine.sock`

/** Options to configure the Codex daemon lifecycle. */
export interface DaemonOptions {
  /** Socket path to listen on (Unix Domain Socket). */
  readonly socketPath?: string | undefined
  /** Host to bind if using TCP. */
  readonly socketHost?: string | undefined
  /** Port to bind if using TCP. */
  readonly socketPort?: number | undefined
  /** Custom binary path override; if omitted, checks bundled bin or build targets. */
  readonly binaryPath?: string | undefined
  /** Optional custom environment variables for the child process. */
  readonly env?: Record<string, string> | undefined
  /** Timeout in ms to wait for socket availability after spawning (default: 8000). */
  readonly startupTimeoutMs?: number | undefined
}

/** Active daemon handle. */
export interface DaemonHandle {
  /** Process ID of the spawned daemon, if started by this manager. */
  readonly pid?: number | undefined
  /** Terminate the daemon and release socket resources. */
  dispose(): Promise<void>
}

/**
 * Probe whether a socket (UDS path or TCP host:port) is currently accepting connections.
 * @param options - Socket destination to probe.
 * @returns True if connected successfully, false otherwise.
 */
export async function probeSocket(options: {
  readonly socketPath?: string | undefined
  readonly socketHost?: string | undefined
  readonly socketPort?: number | undefined
}): Promise<boolean> {
  const { socketPath, socketHost, socketPort } = options
  if (!socketPath && socketPort === undefined) {
    return false
  }

  return new Promise<boolean>((resolveProbe) => {
    const s = socketPath !== undefined
      ? net.createConnection({ path: socketPath })
      : net.createConnection({
        host: socketHost ?? '127.0.0.1',
        port: socketPort ?? 4500,
      })

    const finish = (result: boolean): void => {
      s.destroy()
      resolveProbe(result)
    }

    s.once('connect', () => finish(true))
    s.once('error', () => finish(false))
    s.setTimeout(500, () => finish(false))
  })
}

/**
 * Locate the Codex engine executable binary.
 * @param customPath - Explicit path from configuration if provided.
 * @returns Absolute path to binary if found and executable, or undefined.
 */
export function resolveCodexBinary(customPath?: string): string | undefined {
  if (customPath && existsSync(customPath)) {
    return customPath
  }

  const candidatePaths = [
    // 1. Bundled inside plugin's bin directory
    resolve(__dirname, '../bin/codex-app-server'),
    resolve(__dirname, '../bin/codex'),
    resolve(__dirname, '../bin/codex-engine'),
    // 2. Development release/debug build targets in workspace
    resolve(__dirname, '../../../../../codex/codex-rs/target/release/codex-app-server'),
    resolve(__dirname, '../../../../../codex/codex-rs/target/release/codex'),
    resolve(__dirname, '../../../../../codex/codex-rs/target/debug/codex-app-server'),
    resolve(__dirname, '../../../../../codex/codex-rs/target/debug/codex'),
    '/var/home/fazdev/codex/codex-rs/target/release/codex-app-server',
    '/var/home/fazdev/codex/codex-rs/target/release/codex',
  ]

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

/**
 * Ensure a Codex daemon is running for the specified socket target.
 * If the socket is already accepting connections, returns a no-op handle.
 * If not, spawns the resolved binary with `--listen` and waits until ready.
 *
 * @param options - Daemon startup and connection configuration.
 * @returns Daemon handle that disposes the process on shutdown.
 */
export async function ensureCodexDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const isAlive = await probeSocket(options)
  if (isAlive) {
    return {
      dispose: async () => {},
    }
  }

  const binary = resolveCodexBinary(options.binaryPath)
  if (!binary) {
    throw new Error(
      'subagent-codex: no codex engine binary found. Place binary in packages/subagent/subagent-codex/bin/ or configure binaryPath.',
    )
  }

  // Ensure parent directory for socket exists
  if (options.socketPath) {
    try {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(dirname(options.socketPath), { recursive: true })
    } catch {
      // Ignore if exists
    }
  }

  // If stale socket file exists on disk, unlink it before starting
  if (options.socketPath && existsSync(options.socketPath)) {
    try {
      unlinkSync(options.socketPath)
    } catch {
      // Ignore if cannot unlink
    }
  }

  const listenArg = options.socketPath !== undefined
    ? `unix://${options.socketPath}`
    : `ws://${options.socketHost ?? '127.0.0.1'}:${options.socketPort ?? 4500}`

  const isCli = binary.endsWith('/codex') || binary.endsWith('\\codex.exe') || binary === 'codex'
  const spawnArgs = isCli
    ? ['app-server', '--listen', listenArg]
    : ['--listen', listenArg]

  const childEnv: Record<string, string | undefined> = { ...process.env, ...options.env }

  // Use dedicated CODEX_HOME to avoid conflicting with stale ~/.codex/auth.json OAuth tokens
  if (!childEnv.CODEX_HOME) {
    const defaultCodexHome = resolve(process.env.HOME ?? '/tmp', '.dsh/codex')
    try {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(defaultCodexHome, { recursive: true })
    } catch {
      // Ignore if exists
    }
    childEnv.CODEX_HOME = defaultCodexHome
  }

  // Auto-bridge DeepSeek credentials if OpenAI credentials are not explicitly set
  if (!childEnv.OPENAI_API_KEY && childEnv.DEEPSEEK_API_KEY) {
    childEnv.OPENAI_API_KEY = childEnv.DEEPSEEK_API_KEY
    if (!childEnv.OPENAI_BASE_URL) {
      childEnv.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
    }
  }

  const child: ChildProcess = spawn(
    binary,
    spawnArgs,
    {
      env: childEnv as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    },
  )

  const startupTimeoutMs = options.startupTimeoutMs ?? 8_000
  const startTime = Date.now()

  // Wait until socket responds or process exits
  while (Date.now() - startTime < startupTimeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `subagent-codex: engine daemon process exited immediately with code ${child.exitCode}`,
      )
    }
    const reachable = await probeSocket(options)
    if (reachable) {
      break
    }
    await new Promise(r => setTimeout(r, 150))
  }

  const finallyAlive = await probeSocket(options)
  if (!finallyAlive) {
    child.kill('SIGTERM')
    throw new Error(
      `subagent-codex: engine daemon failed to bind socket within ${startupTimeoutMs}ms`,
    )
  }

  return {
    pid: child.pid,
    dispose: async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise(r => setTimeout(r, 500))
        if (child.exitCode === null) {
          child.kill('SIGKILL')
        }
      }
      if (options.socketPath && existsSync(options.socketPath)) {
        try {
          unlinkSync(options.socketPath)
        } catch {
          // ignore cleanup error
        }
      }
    },
  }
}
