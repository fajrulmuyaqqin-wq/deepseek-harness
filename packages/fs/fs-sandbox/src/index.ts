/**
 * `SandboxedFileSystem`: the sandbox-enforcing implementation of the
 * `@deepseek-ai/dsh-fs` Service Definition. It extends `LocalFileSystem` so all
 * underlying text-storage mechanics — resolve, the atomic write, and the
 * read-match-write edit critical section — are the local implementation's, verbatim.
 * This package adds per-call policy fences on mutations, reads, listings, and metadata
 * probes to enforce workspace containment and protect sensitive credentials.
 *
 * Under `read-only` and `workspace-write`, reads, listings, and writes are confined
 * to the workspace root and platform temporary directories; access to protected
 * credential stores and secret files (such as `.env`, private keys, and git configs)
 * is denied. Under `danger-full-access`, operations delegate unfenced. Denials
 * throw the structured `FS_SANDBOX_DENIED` error.
 *
 * @module @deepseek-ai/dsh-fs-sandbox
 */

import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isPathUnder } from './containment.ts'
import { isSensitivePath } from './sensitive-blacklist.ts'

export { isSensitivePath } from './sensitive-blacklist.ts'

/**
 * Plugin config: the local backend's knobs verbatim (`cwd` resolution default
 * and `diffBasisMaxBytes` overwrite-presentation bound). The sandbox default
 * (mode + `workspace-write` fallback root) is NOT here — `ctx.sandboxPolicy`
 * resolves each calling session for every enforcing capability.
 */
export type Config = LocalConfig

/**
 * Sandbox-enforcing filesystem backend. Registers as `ctx.fs` (loading it
 * INSTEAD OF `dsh-fs-local`, together with a `ctx.sandboxPolicy`, is the whole
 * swap — the model-facing tools are untouched). Its configured default mode is
 * the capability fact exposed by {@link sandboxMode}; `dsh-tool-fs` resolves
 * each session's mode and cwd into a policy for every mutation, while an
 * approved escalation may stamp a strictly wider mode for one call.
 */
export class SandboxedFileSystem extends LocalFileSystem {
  static inject = ['sandboxPolicy']

  private readonly defaultMode: SandboxMode
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.defaultMode = ctx.sandboxPolicy.defaultMode
  }

  /** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
  override get sandboxMode(): SandboxMode {
    return this.defaultMode
  }

  /**
   * Observe one file or directory after validating sandbox containment.
   * @param target - resolved file or directory target.
   * @param changed - change invalidation callback.
   * @param signal - watcher cancellation signal.
   * @returns an asynchronous close disposer function.
   */
  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    return super.watch(await this.checkedTarget(target, 'read'), changed, signal)
  }

  /**
   * Return target metadata after validating sandbox containment and sensitive paths.
   * @param target - resolved file or directory target.
   * @param signal - cancellation signal.
   * @param sandboxPolicy - optional per-call policy override.
   * @returns metadata or undefined for an absent target.
   */
  override async stat(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsInfo | undefined> {
    return super.stat(await this.checkedTarget(target, 'stat', sandboxPolicy), signal)
  }

  /**
   * Fence the text read by the per-call policy, then delegate to the inherited text read.
   * @param target - resolved target to read.
   * @param signal - cancellation signal.
   * @param sandboxPolicy - optional per-call policy override.
   * @returns the decoded UTF-8 content.
   */
  override async readText(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<string> {
    return super.readText(await this.checkedTarget(target, 'read', sandboxPolicy), signal)
  }

  /**
   * Fence the text stream by the per-call policy, then delegate to the inherited text stream.
   * @param target - resolved target to stream.
   * @param signal - cancellation signal.
   * @param sandboxPolicy - optional per-call policy override.
   * @returns the async text chunk iterable.
   */
  override async streamText(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<AsyncIterable<string>> {
    return super.streamText(await this.checkedTarget(target, 'read', sandboxPolicy), signal)
  }

  /**
   * Fence the raw byte read by the per-call policy, then delegate to the inherited byte read.
   * @param target - resolved target to read.
   * @param signal - cancellation signal.
   * @param maxBytes - maximum permitted bytes.
   * @param sandboxPolicy - optional per-call policy override.
   * @returns raw bytes buffer.
   */
  override async readBytes(
    target: FsTarget,
    signal: AbortSignal | undefined,
    maxBytes: number,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<Uint8Array> {
    return super.readBytes(await this.checkedTarget(target, 'read', sandboxPolicy), signal, maxBytes)
  }

  /**
   * Fence the byte window read by the per-call policy, then delegate to the inherited range read.
   * @param target - resolved target to read.
   * @param range - offset and length window.
   * @param signal - cancellation signal.
   * @param sandboxPolicy - optional per-call policy override.
   * @returns window bytes.
   */
  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<Uint8Array> {
    return super.readByteRange(await this.checkedTarget(target, 'read', sandboxPolicy), range, signal)
  }

  /**
   * Fence directory listing by the per-call policy, then delegate to the inherited listing.
   * @param target - resolved directory target.
   * @param signal - cancellation signal.
   * @param sandboxPolicy - optional per-call policy override.
   * @returns list of directory entries.
   */
  override async listDir(
    target: FsTarget,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsDirEntry[]> {
    return super.listDir(await this.checkedTarget(target, 'list', sandboxPolicy), signal)
  }

  /**
   * Fence the write by the per-call policy, then delegate to the inherited
   * atomic write. See {@link checkedTarget}.
   * @param target - the resolved target to write.
   * @param content - the full new file content.
   * @param expected - the write intent guarding the write; omit for unconditional.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the write outcome from the inherited backend.
   */
  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    return super.writeText(await this.checkedTarget(target, 'write', sandboxPolicy), content, expected, signal)
  }

  /**
   * Fence the edit by the per-call policy, then delegate to the inherited
   * atomic edit. See {@link checkedTarget}.
   * @param target - the resolved target to edit.
   * @param edit - the literal search/replace request.
   * @param expected - the version guard; omit for an unconditional edit.
   * @param signal - aborts before atomic publication takes effect.
   * @param sandboxPolicy - the per-call mode and workspace root; omit to use
   *   the deployment fallback.
   * @returns the edit outcome from the inherited backend.
   */
  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    return super.editText(await this.checkedTarget(target, 'write', sandboxPolicy), edit, expected, signal)
  }

  /**
   * Enforce the per-call policy against `target` and return the EXACT target the
   * operation must use, so the checked identity is the accessed one.
   * Under `danger-full-access`, delegates unfenced. Under `read-only` and `workspace-write`,
   * checks sensitive file blacklists and canonical containment under permitted roots.
   */
  private async checkedTarget(
    target: FsTarget,
    operation: 'write' | 'read' | 'list' | 'stat',
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const { mode } = policy
    if (mode === 'danger-full-access') return target

    // Sensitive files (.env, id_rsa, .git/config, etc.) are strictly protected under confined modes
    if (isSensitivePath(target.displayPath) || isSensitivePath(String(target.targetKey))) {
      throw new FsError(
        `cannot access "${target.displayPath}": sensitive credential file access denied under ${mode} mode`,
        'FS_SANDBOX_DENIED',
      )
    }

    if (operation === 'write') {
      if (mode === 'read-only') {
        throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
      }
      // workspace-write: containment on the FRESH canonical path
      const fresh = await this.resolve(target.displayPath)
      if (isSensitivePath(fresh.displayPath) || isSensitivePath(String(fresh.targetKey))) {
        throw new FsError(
          `cannot write "${target.displayPath}": sensitive credential file access denied under ${mode} mode`,
          'FS_SANDBOX_DENIED',
        )
      }
      let contained = false
      for (const root of writableRoots(policy)) {
        if (await isPathUnder(fresh.targetKey, root)) {
          contained = true
          break
        }
      }
      if (!contained) {
        throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
      }
      return fresh
    }

    // For read, list, and stat under read-only or workspace-write:
    const fresh = await this.resolve(target.displayPath)
    if (isSensitivePath(fresh.displayPath) || isSensitivePath(String(fresh.targetKey))) {
      throw new FsError(
        `cannot access "${target.displayPath}": sensitive credential file access denied under ${mode} mode`,
        'FS_SANDBOX_DENIED',
      )
    }
    let contained = false
    const allowedRoots = [...new Set([policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath))]
    for (const root of allowedRoots) {
      if (await isPathUnder(fresh.targetKey, root)) {
        contained = true
        break
      }
    }
    if (!contained) {
      throw new FsError(
        `cannot access "${target.displayPath}": file access denied under ${mode} mode`,
        'FS_SANDBOX_DENIED',
      )
    }
    return fresh
  }
}

export default SandboxedFileSystem
