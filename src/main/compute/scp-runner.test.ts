// Tests for scp-runner.ts pure helpers.
// SystemScpRunner (the real spawner) is not tested here — it's covered by the fake-injection tests
// in compute-service.test.ts, matching the pattern used for SshRunner.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_DOWNLOAD_BYTES,
  MAX_IMPORT_BYTES,
  SCP_UPLOAD_TIMEOUT_MS,
  buildScpArgs,
  buildScpUploadArgs,
  inferMimeType,
  resolveDestFilename,
  runScpUpload,
  shellSingleQuote,
  validateImportPath
} from './scp-runner'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ScpRunner } from './scp-runner'
import type { ResolvedSshTarget } from './ssh-runner'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('size constants', () => {
  it('MAX_DOWNLOAD_BYTES is 2 GiB', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(2 * 1024 * 1024 * 1024)
  })

  it('MAX_IMPORT_BYTES is 50 MB', () => {
    expect(MAX_IMPORT_BYTES).toBe(50 * 1024 * 1024)
  })

  it('SCP_UPLOAD_TIMEOUT_MS is 30 minutes', () => {
    expect(SCP_UPLOAD_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })
})

// ---------------------------------------------------------------------------
// validateImportPath
// ---------------------------------------------------------------------------

describe('validateImportPath', () => {
  it('accepts an absolute path without glob chars', () => {
    expect(validateImportPath('/home/user/data.csv')).toBeUndefined()
  })

  it('rejects a relative path', () => {
    expect(validateImportPath('data.csv')).toBe('outside_roots')
  })

  it('rejects a path with * glob', () => {
    expect(validateImportPath('/home/user/*.csv')).toBe('outside_roots')
  })

  it('rejects a path with ? glob', () => {
    expect(validateImportPath('/home/user/file?.csv')).toBe('outside_roots')
  })

  it('rejects a path with [ glob', () => {
    expect(validateImportPath('/home/user/[abc].csv')).toBe('outside_roots')
  })

  it('rejects a path with { glob', () => {
    expect(validateImportPath('/home/user/{a,b}.csv')).toBe('outside_roots')
  })

  it('accepts a path with spaces', () => {
    expect(validateImportPath('/home/user/my file.csv')).toBeUndefined()
  })

  // Shell-injection guard for the scp remote spec (scp may pass the path through a remote shell,
  // version-dependent). These must be rejected so an agent-supplied path can't run commands.
  it('rejects a path with command substitution $()', () => {
    expect(validateImportPath('/home/user/$(id).csv')).toBe('outside_roots')
  })

  it('rejects a path with backtick command substitution', () => {
    expect(validateImportPath('/home/user/`whoami`.csv')).toBe('outside_roots')
  })

  it('rejects a path with a semicolon', () => {
    expect(validateImportPath('/home/user/a.csv; rm -rf ~')).toBe('outside_roots')
  })

  it('rejects a path with a pipe', () => {
    expect(validateImportPath('/home/user/a.csv | sh')).toBe('outside_roots')
  })

  it('rejects a path with redirection or subshell chars', () => {
    expect(validateImportPath('/home/user/a>b')).toBe('outside_roots')
    expect(validateImportPath('/home/user/(x)')).toBe('outside_roots')
    expect(validateImportPath('/home/user/a&b')).toBe('outside_roots')
  })

  it('rejects a path with a newline', () => {
    expect(validateImportPath('/home/user/a\ncurl evil')).toBe('outside_roots')
  })

  it('rejects a path with a control character', () => {
    expect(validateImportPath('/home/user/a\x01b')).toBe('outside_roots')
  })
})

// ---------------------------------------------------------------------------
// shellSingleQuote
// ---------------------------------------------------------------------------

describe('shellSingleQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(shellSingleQuote('/home/user/data.csv')).toBe(`'/home/user/data.csv'`)
  })

  it('neutralizes command substitution by keeping it literal inside single quotes', () => {
    // Inside single quotes the shell does no expansion, so $() and backticks stay literal.
    expect(shellSingleQuote('/a/$(id)')).toBe(`'/a/$(id)'`)
    expect(shellSingleQuote('/a/`whoami`')).toBe("'/a/`whoami`'")
  })

  it('escapes an embedded single quote via the close/reopen idiom', () => {
    // O'Brien → 'O'\''Brien'
    expect(shellSingleQuote("O'Brien")).toBe(`'O'\\''Brien'`)
  })

  it('preserves spaces without extra escaping', () => {
    expect(shellSingleQuote('/a/my file.csv')).toBe(`'/a/my file.csv'`)
  })
})

// ---------------------------------------------------------------------------
// buildScpArgs
// ---------------------------------------------------------------------------

describe('buildScpArgs', () => {
  const target: ResolvedSshTarget = {
    sshBinary: '/usr/bin/ssh',
    host: 'biowulf.nih.gov',
    extraArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
  }

  it('builds a basic scp arg list', () => {
    const args = buildScpArgs(target, '/remote/data.csv', '/local/data.csv')
    expect(args).toContain('-o')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('biowulf.nih.gov:/remote/data.csv')
    expect(args).toContain('/local/data.csv')
  })

  it('translates -p <port> to -o Port=<port>', () => {
    const targetWithPort: ResolvedSshTarget = {
      sshBinary: '/usr/bin/ssh',
      host: 'biowulf.nih.gov',
      extraArgs: ['-o', 'BatchMode=yes', '-p', '2222']
    }
    const args = buildScpArgs(targetWithPort, '/remote/data.csv', '/local/data.csv')
    expect(args).not.toContain('-p')
    expect(args).toContain('Port=2222')
  })

  it('passes ControlMaster args through unchanged', () => {
    const targetWithMux: ResolvedSshTarget = {
      sshBinary: '/usr/bin/ssh',
      host: 'biowulf.nih.gov',
      extraArgs: [
        '-o',
        'ControlMaster=auto',
        '-o',
        'ControlPath=/home/user/.ssh/ctrl/%r@%h:%p.biowulf',
        '-o',
        'ControlPersist=60'
      ]
    }
    const args = buildScpArgs(targetWithMux, '/remote/data.csv', '/tmp/data.csv')
    expect(args).toContain('ControlMaster=auto')
    expect(args).toContain('ControlPersist=60')
  })

  it('places remoteSpec before localPath', () => {
    const args = buildScpArgs(target, '/remote/file.txt', '/tmp/file.txt')
    const remoteIdx = args.indexOf('biowulf.nih.gov:/remote/file.txt')
    const localIdx = args.indexOf('/tmp/file.txt')
    expect(remoteIdx).toBeLessThan(localIdx)
    expect(remoteIdx).toBeGreaterThan(-1)
    expect(localIdx).toBeGreaterThan(-1)
  })
})

// ---------------------------------------------------------------------------
// resolveSshTarget → buildScpArgs integration
// Locks the contract that the alias (not the resolved IP) flows into the scp
// remote spec and that ControlMaster args from resolveSshTarget are preserved.
// ---------------------------------------------------------------------------

describe('resolveSshTarget → buildScpArgs integration', () => {
  it('passes the alias as the scp remote spec and preserves ControlMaster', async () => {
    const { resolveSshTarget } = await import('./ssh-runner')
    const target = await resolveSshTarget('aliyun-xt-test', undefined, async () => ({
      user: 'ewen',
      hostname: '47.98.96.100',
      port: '22',
      identityfile: '~/.ssh/aliyun-xt-test.pem'
    }))
    const args = buildScpArgs(target, '/remote/data.csv', '/local/data.csv')

    // The remote spec must use the alias, NOT the resolved IP — scp matches the
    // ~/.ssh/config "Host" block on the alias to apply IdentityFile etc.
    expect(args).toContain('aliyun-xt-test:/remote/data.csv')
    expect(args).not.toContain('47.98.96.100:/remote/data.csv')

    // ControlMaster args from resolveSshTarget must survive the -p → Port translation.
    expect(args).toContain('ControlMaster=auto')
    expect(args.some((a) => a.startsWith('ControlPath='))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// inferMimeType
// ---------------------------------------------------------------------------

describe('inferMimeType', () => {
  it('returns text/csv for .csv', () => {
    expect(inferMimeType('data.csv')).toBe('text/csv')
  })

  it('returns application/json for .json', () => {
    expect(inferMimeType('config.json')).toBe('application/json')
  })

  it('returns image/png for .png', () => {
    expect(inferMimeType('image.png')).toBe('image/png')
  })

  it('returns application/pdf for .pdf', () => {
    expect(inferMimeType('report.pdf')).toBe('application/pdf')
  })

  it('returns application/octet-stream for unknown extension', () => {
    expect(inferMimeType('data.xyz')).toBe('application/octet-stream')
  })

  it('returns application/octet-stream for no extension', () => {
    expect(inferMimeType('datafile')).toBe('application/octet-stream')
  })

  it('is case-insensitive (uppercased extension)', () => {
    expect(inferMimeType('data.CSV')).toBe('text/csv')
  })

  it('returns application/x-ipynb+json for .ipynb', () => {
    expect(inferMimeType('notebook.ipynb')).toBe('application/x-ipynb+json')
  })
})

// ---------------------------------------------------------------------------
// resolveDestFilename
// ---------------------------------------------------------------------------

describe('resolveDestFilename', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scp-runner-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns the base name when no collision', async () => {
    const name = await resolveDestFilename(tmpDir, 'data.csv')
    expect(name).toBe('data.csv')
  })

  it('appends (1) when base name already exists', async () => {
    await writeFile(join(tmpDir, 'data.csv'), '')
    const name = await resolveDestFilename(tmpDir, 'data.csv')
    expect(name).toBe('data (1).csv')
  })

  it('appends (2) when (1) also exists', async () => {
    await writeFile(join(tmpDir, 'data.csv'), '')
    await writeFile(join(tmpDir, 'data (1).csv'), '')
    const name = await resolveDestFilename(tmpDir, 'data.csv')
    expect(name).toBe('data (2).csv')
  })

  it('handles files without extension', async () => {
    await writeFile(join(tmpDir, 'README'), '')
    const name = await resolveDestFilename(tmpDir, 'README')
    expect(name).toBe('README (1)')
  })
})

// ---------------------------------------------------------------------------
// buildScpUploadArgs
// ---------------------------------------------------------------------------

describe('buildScpUploadArgs', () => {
  const target: ResolvedSshTarget = {
    sshBinary: '/usr/bin/ssh',
    host: 'biowulf.nih.gov',
    extraArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
  }

  it('places localPath before remoteSpec (upload direction)', () => {
    const args = buildScpUploadArgs(target, '/local/data.csv', '/remote/workdir/data.csv')
    const localIdx = args.indexOf('/local/data.csv')
    const remoteIdx = args.indexOf('biowulf.nih.gov:/remote/workdir/data.csv')
    expect(localIdx).toBeGreaterThan(-1)
    expect(remoteIdx).toBeGreaterThan(-1)
    expect(localIdx).toBeLessThan(remoteIdx)
  })

  it('includes remote host:path spec', () => {
    const args = buildScpUploadArgs(target, '/local/file.txt', '/remote/file.txt')
    expect(args).toContain('biowulf.nih.gov:/remote/file.txt')
    expect(args).toContain('/local/file.txt')
  })

  it('translates -p <port> to -o Port=<port>', () => {
    const targetWithPort: ResolvedSshTarget = {
      sshBinary: '/usr/bin/ssh',
      host: 'biowulf.nih.gov',
      extraArgs: ['-o', 'BatchMode=yes', '-p', '2222']
    }
    const args = buildScpUploadArgs(targetWithPort, '/local/file.txt', '/remote/file.txt')
    expect(args).not.toContain('-p')
    expect(args).toContain('Port=2222')
  })

  it('passes ControlMaster args through unchanged', () => {
    const targetWithMux: ResolvedSshTarget = {
      sshBinary: '/usr/bin/ssh',
      host: 'biowulf.nih.gov',
      extraArgs: ['-o', 'ControlMaster=auto', '-o', 'ControlPersist=60']
    }
    const args = buildScpUploadArgs(targetWithMux, '/local/a.csv', '/remote/a.csv')
    expect(args).toContain('ControlMaster=auto')
    expect(args).toContain('ControlPersist=60')
  })
})

// ---------------------------------------------------------------------------
// runScpUpload
// ---------------------------------------------------------------------------

describe('runScpUpload', () => {
  const target: ResolvedSshTarget = {
    sshBinary: '/usr/bin/ssh',
    host: 'biowulf.nih.gov',
    extraArgs: ['-o', 'BatchMode=yes']
  }

  const makeFakeScpRunner = (result: {
    exitCode: number | null
    stderr: string
    timedOut: boolean
  }): ScpRunner => ({
    copy: vi.fn(async () => result)
  })

  it('resolves without throwing on exit code 0', async () => {
    const runner = makeFakeScpRunner({ exitCode: 0, stderr: '', timedOut: false })
    await expect(
      runScpUpload(runner, target, '/local/a.csv', '/remote/a.csv')
    ).resolves.toBeUndefined()
  })

  it('throws with remoteFsError on non-zero exit', async () => {
    const runner = makeFakeScpRunner({ exitCode: 1, stderr: 'permission denied', timedOut: false })
    const err = await runScpUpload(runner, target, '/local/a.csv', '/remote/a.csv').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { remoteFsError?: { remoteKind: string } }).remoteFsError?.remoteKind).toBe(
      'permission'
    )
  })

  it('throws with remoteFsError on timeout', async () => {
    const runner = makeFakeScpRunner({ exitCode: null, stderr: '', timedOut: true })
    const err = await runScpUpload(runner, target, '/local/a.csv', '/remote/a.csv').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { remoteFsError?: { remoteKind: string } }).remoteFsError?.remoteKind).toBe(
      'connection'
    )
    expect(err.message).toContain('timed out')
  })

  it('passes the upload args with localPath before remoteSpec', async () => {
    const copy = vi.fn(async () => ({ exitCode: 0, stderr: '', timedOut: false }))
    const runner: ScpRunner = { copy }
    await runScpUpload(runner, target, '/local/data.csv', '/remote/data.csv')
    const [, args] = (copy as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]]
    const localIdx = args.indexOf('/local/data.csv')
    const remoteIdx = args.indexOf('biowulf.nih.gov:/remote/data.csv')
    expect(localIdx).toBeGreaterThan(-1)
    expect(remoteIdx).toBeGreaterThan(-1)
    expect(localIdx).toBeLessThan(remoteIdx)
  })
})
