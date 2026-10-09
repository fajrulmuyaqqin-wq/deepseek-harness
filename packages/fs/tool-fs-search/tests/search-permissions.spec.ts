/**
 * Comprehensive verification of micro-level permissions, workspace path boundaries,
 * and sensitive credential shielding across search tools (glob and grep).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import { isAllowedSearchTarget, isSensitiveSearchTarget } from '../src/search-core.ts'

const testSignal = new AbortController().signal

let dir: string
let ctx: Context
let callId = 0

function call(name: string, args: unknown, agentObj?: object) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: ToolCallId(`perm-${++callId}`),
    name,
    arguments: args,
    ...agentObj ? { agent: agentObj as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

const agent = () => ({
  session: Session.create(SessionId('session-search-perm'), undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('session-search-perm'),
    createdAt: Date.now(),
    isSeeded: false,
    cwd: dir,
  }),
})

describe('search micro-permissions and sensitive shielding', () => {
  describe('isSensitiveSearchTarget pattern testing', () => {
    it('identifies environment secrets as sensitive', () => {
      expect(isSensitiveSearchTarget('.env')).toBe(true)
      expect(isSensitiveSearchTarget('.env.local')).toBe(true)
      expect(isSensitiveSearchTarget('.env.production')).toBe(true)
      expect(isSensitiveSearchTarget('.env.development')).toBe(true)
      expect(isSensitiveSearchTarget('sub/dir/.env.staging')).toBe(true)
    })

    it('permits safe environment templates', () => {
      expect(isSensitiveSearchTarget('.env.example')).toBe(false)
      expect(isSensitiveSearchTarget('.env.sample')).toBe(false)
      expect(isSensitiveSearchTarget('.env.template')).toBe(false)
      expect(isSensitiveSearchTarget('configs/.env.example')).toBe(false)
    })

    it('identifies private keys, certificates, and stores as sensitive', () => {
      expect(isSensitiveSearchTarget('id_rsa')).toBe(true)
      expect(isSensitiveSearchTarget('id_ed25519')).toBe(true)
      expect(isSensitiveSearchTarget('server.pem')).toBe(true)
      expect(isSensitiveSearchTarget('cert.key')).toBe(true)
      expect(isSensitiveSearchTarget('keystore.p12')).toBe(true)
    })

    it('identifies VCS config and host credential directories', () => {
      expect(isSensitiveSearchTarget('.git/config')).toBe(true)
      expect(isSensitiveSearchTarget('project/.git/config')).toBe(true)
      expect(isSensitiveSearchTarget('.ssh/id_rsa')).toBe(true)
      expect(isSensitiveSearchTarget('.aws/credentials')).toBe(true)
      expect(isSensitiveSearchTarget('.config/gh/hosts.yml')).toBe(true)
      expect(isSensitiveSearchTarget('/etc/shadow')).toBe(true)
      expect(isSensitiveSearchTarget('/etc/sudoers')).toBe(true)
    })

    it('identifies shell history files', () => {
      expect(isSensitiveSearchTarget('.bash_history')).toBe(true)
      expect(isSensitiveSearchTarget('.zsh_history')).toBe(true)
    })

    it('permits normal source and configuration files', () => {
      expect(isSensitiveSearchTarget('src/index.ts')).toBe(false)
      expect(isSensitiveSearchTarget('package.json')).toBe(false)
      expect(isSensitiveSearchTarget('README.md')).toBe(false)
      expect(isSensitiveSearchTarget('config.yaml')).toBe(false)
      expect(isSensitiveSearchTarget('')).toBe(false)
    })
  })

  describe('isAllowedSearchTarget path boundary testing', () => {
    it('permits relative and absolute paths within workspace', () => {
      expect(isAllowedSearchTarget('src', '/workspaces/proj')).toBe(true)
      expect(isAllowedSearchTarget('src/index.ts', '/workspaces/proj')).toBe(true)
      expect(isAllowedSearchTarget('/workspaces/proj/src', '/workspaces/proj')).toBe(true)
      expect(isAllowedSearchTarget('.', '/workspaces/proj')).toBe(true)
    })

    it('permits temporary directories', () => {
      expect(isAllowedSearchTarget('/tmp/scratch.txt', '/workspaces/proj')).toBe(true)
      expect(isAllowedSearchTarget(join(tmpdir(), 'scratch.txt'), '/workspaces/proj')).toBe(true)
    })

    it('rejects targets escaping outside the workspace', () => {
      expect(isAllowedSearchTarget('/etc/passwd', '/workspaces/proj')).toBe(false)
      expect(isAllowedSearchTarget('../outside.txt', '/workspaces/proj')).toBe(false)
      expect(isAllowedSearchTarget('/var/log', '/workspaces/proj')).toBe(false)
    })
  })

  describe('real ripgrep search tool enforcement', () => {
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'dsh-search-perm-'))
      await mkdir(join(dir, 'src'), { recursive: true })
      await mkdir(join(dir, '.git'), { recursive: true })

      await writeFile(join(dir, 'src', 'app.ts'), 'export const app = "healthy"\nconst SECRET_API_KEY = "dummy_token"\n')
      await writeFile(join(dir, '.env'), 'SECRET_API_KEY=top_secret_12345\n')
      await writeFile(join(dir, '.env.local'), 'LOCAL_SECRET=local_secret_value\n')
      await writeFile(join(dir, '.env.example'), 'SECRET_API_KEY=your_key_here\n')
      await writeFile(join(dir, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret_bytes\n')
      await writeFile(join(dir, 'cert.key'), '-----BEGIN PRIVATE KEY-----\nkey_bytes\n')
      await writeFile(join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
      await writeFile(join(dir, 'public.txt'), 'hello world\n')

      ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
    })

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    describe('workspace-write mode', () => {
      beforeEach(async () => {
        await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: dir })
      })

      it('glob automatically excludes .env, private keys, and certificates', async () => {
        const result = await call('glob', { pattern: '**/*' }, agent())
        expect(result.isError).toBe(false)
        const discovered = text(result).split('\n')

        expect(discovered).toContain(join('src', 'app.ts'))
        expect(discovered).toContain('public.txt')
        expect(discovered).toContain('.env.example')

        expect(discovered).not.toContain('.env')
        expect(discovered).not.toContain('.env.local')
        expect(discovered).not.toContain('id_rsa')
        expect(discovered).not.toContain('cert.key')
        expect(discovered).not.toContain(join('.git', 'config'))
      })

      it('glob rejects explicit search targeting sensitive file', async () => {
        const result = await call('glob', { pattern: '*', path: '.env' }, agent())
        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/sensitive credential file access denied/i)
      })

      it('glob rejects explicit search targeting path outside workspace', async () => {
        const result = await call('glob', { pattern: '*', path: '/etc' }, agent())
        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/path is outside workspace/i)
      })

      it('grep automatically excludes matches in sensitive files', async () => {
        const result = await call('grep', { pattern: 'SECRET_API_KEY' }, agent())
        expect(result.isError).toBe(false)
        const output = text(result)

        // Matches src/app.ts
        expect(output).toContain('app.ts')
        expect(output).toContain('dummy_token')

        // Does NOT match .env
        expect(output).not.toContain('top_secret_12345')
      })

      it('grep rejects explicit search targeting sensitive file', async () => {
        const result = await call('grep', { pattern: 'SECRET', path: '.env' }, agent())
        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/sensitive credential file access denied/i)
      })

      it('grep rejects explicit search targeting path outside workspace', async () => {
        const result = await call('grep', { pattern: 'root', path: '/etc' }, agent())
        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/path is outside workspace/i)
      })
    })

    describe('read-only mode', () => {
      beforeEach(async () => {
        await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: dir })
      })

      it('glob enforces sensitive file shield under read-only mode', async () => {
        const result = await call('glob', { pattern: '**/*' }, agent())
        expect(result.isError).toBe(false)
        const discovered = text(result).split('\n')

        expect(discovered).toContain('public.txt')
        expect(discovered).not.toContain('.env')
        expect(discovered).not.toContain('id_rsa')
      })

      it('grep blocks targeting sensitive files under read-only mode', async () => {
        const result = await call('grep', { pattern: 'SECRET', path: '.env' }, agent())
        expect(result.isError).toBe(true)
        expect(text(result)).toMatch(/sensitive credential file access denied under read-only mode/i)
      })
    })

    describe('danger-full-access mode', () => {
      beforeEach(async () => {
        await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: dir })
      })

      it('glob allows discovering sensitive files when full access is granted', async () => {
        const result = await call('glob', { pattern: '**/*' }, agent())
        expect(result.isError).toBe(false)
        const discovered = text(result).split('\n')

        expect(discovered).toContain('.env')
        expect(discovered).toContain('.env.local')
        expect(discovered).toContain('id_rsa')
        expect(discovered).toContain('cert.key')
      })

      it('grep allows searching inside sensitive files under full access', async () => {
        const result = await call('grep', { pattern: 'top_secret', path: '.env' }, agent())
        expect(result.isError).toBe(false)
        expect(text(result)).toContain('top_secret_12345')
      })
    })
  })
})
