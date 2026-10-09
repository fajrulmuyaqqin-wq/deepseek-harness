/**
 * Tests for micro-level permissions, workspace path jail, and sensitive file shielding
 * in SandboxedFileSystem across all permission modes: read-only, workspace-write, and danger-full-access.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { SandboxedFileSystem, isSensitivePath } from '@deepseek-ai/dsh-fs-sandbox'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../../scripts/snapshot-workspace-parent.ts'

let base: string
let workspace: string
let outside: string
let ctx: Context
let fs: SandboxedFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

async function boot(mode: SandboxMode): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  fiber = await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  fs = ctx.fs as SandboxedFileSystem
}

beforeEach(async ({ onTestFinished }) => {
  const directory = await mkdtemp(join(outsideTempWorkspaceParent(), '.dsh-fsmicro-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  base = directory
  assertWorkspaceOutsideTemp(base)
  workspace = join(base, 'ws')
  outside = join(base, 'out')
  await mkdir(workspace)
  await mkdir(outside)
})

afterEach(async () => {
  await fiber?.dispose()
})

function target(path: string): Promise<FsTarget> {
  return fs.resolve(path)
}

describe('sensitive path detector (isSensitivePath)', () => {
  it('identifies environment secret files but permits templates', () => {
    expect(isSensitivePath('.env')).toBe(true)
    expect(isSensitivePath('.env.local')).toBe(true)
    expect(isSensitivePath('.env.production')).toBe(true)
    expect(isSensitivePath('nested/sub/.env')).toBe(true)

    // Templates are explicitly permitted
    expect(isSensitivePath('.env.example')).toBe(false)
    expect(isSensitivePath('.env.sample')).toBe(false)
    expect(isSensitivePath('.env.template')).toBe(false)
  })

  it('identifies private keys and certificates while permitting public keys', () => {
    expect(isSensitivePath('id_rsa')).toBe(true)
    expect(isSensitivePath('id_ed25519')).toBe(true)
    expect(isSensitivePath('id_ecdsa')).toBe(true)
    expect(isSensitivePath('server.pem')).toBe(true)
    expect(isSensitivePath('cert.key')).toBe(true)
    expect(isSensitivePath('auth.pfx')).toBe(true)
    expect(isSensitivePath('id_rsa.pub')).toBe(false)
  })

  it('identifies git config and sensitive credential directories', () => {
    expect(isSensitivePath('.git/config')).toBe(true)
    expect(isSensitivePath('/home/user/.git/config')).toBe(true)
    expect(isSensitivePath('.ssh/id_rsa')).toBe(true)
    expect(isSensitivePath('/home/user/.aws/credentials')).toBe(true)
    expect(isSensitivePath('.bash_history')).toBe(true)
    expect(isSensitivePath('/etc/shadow')).toBe(true)
    expect(isSensitivePath('/etc/sudoers')).toBe(true)

    // Unrelated git files are not blocked by the sensitive detector
    expect(isSensitivePath('.git/HEAD')).toBe(false)
    expect(isSensitivePath('.gitignore')).toBe(false)
  })
})

describe('workspace-write mode (default)', () => {
  beforeEach(() => boot('workspace-write'))

  it('permits reading ordinary text files inside workspace', async () => {
    const file = join(workspace, 'app.ts')
    await writeFile(file, 'console.log("ok")')
    expect(await fs.readText(await target(file))).toBe('console.log("ok")')
  })

  it('refuses reading files outside workspace (path jail)', async () => {
    const file = join(outside, 'secret.txt')
    await writeFile(file, 'classified')
    await expect(fs.readText(await target(file)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('refuses stat probes on files outside workspace', async () => {
    const file = join(outside, 'secret.txt')
    await writeFile(file, 'classified')
    await expect(fs.stat(await target(file)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('refuses directory listings outside workspace', async () => {
    await expect(fs.listDir(await target(outside)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('refuses reading .env file even inside workspace', async () => {
    const envFile = join(workspace, '.env')
    await writeFile(envFile, 'API_KEY=secret_token')
    await expect(fs.readText(await target(envFile)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('refuses reading .git/config inside workspace', async () => {
    const gitDir = join(workspace, '.git')
    await mkdir(gitDir)
    const gitConfig = join(gitDir, 'config')
    await writeFile(gitConfig, '[remote "origin"]\nurl = https://token@github.com/repo')
    await expect(fs.readText(await target(gitConfig)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('permits reading .env.example inside workspace', async () => {
    const exampleFile = join(workspace, '.env.example')
    await writeFile(exampleFile, 'API_KEY=your_key_here')
    expect(await fs.readText(await target(exampleFile))).toBe('API_KEY=your_key_here')
  })

  it('refuses writing or modifying sensitive files inside workspace', async () => {
    const envFile = join(workspace, '.env')
    await expect(fs.writeText(await target(envFile), 'INJECTED=bad'))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })
})

describe('read-only mode', () => {
  beforeEach(() => boot('read-only'))

  it('permits reading ordinary text files inside workspace', async () => {
    const file = join(workspace, 'index.ts')
    await writeFile(file, 'export const a = 1')
    expect(await fs.readText(await target(file))).toBe('export const a = 1')
  })

  it('refuses reading files outside workspace', async () => {
    const file = join(outside, 'outside.txt')
    await writeFile(file, 'data')
    await expect(fs.readText(await target(file)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('refuses reading .env or private key files inside workspace', async () => {
    const envFile = join(workspace, '.env.local')
    await writeFile(envFile, 'SECRET=abc')
    await expect(fs.readText(await target(envFile)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })

    const keyFile = join(workspace, 'id_ed25519')
    await writeFile(keyFile, 'PRIVATE KEY DATA')
    await expect(fs.readText(await target(keyFile)))
      .rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })
})

describe('danger-full-access mode', () => {
  beforeEach(() => boot('danger-full-access'))

  it('permits reading and writing outside workspace', async () => {
    const file = join(outside, 'admin.txt')
    await fs.writeText(await target(file), 'admin data')
    expect(await fs.readText(await target(file))).toBe('admin data')
  })

  it('permits reading .env and sensitive files when explicitly authorized', async () => {
    const envFile = join(workspace, '.env')
    await writeFile(envFile, 'ADMIN_KEY=xyz')
    expect(await fs.readText(await target(envFile))).toBe('ADMIN_KEY=xyz')
  })
})
