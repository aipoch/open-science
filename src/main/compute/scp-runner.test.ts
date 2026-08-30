// Tests for scp-runner.ts pure helpers and the real SystemScpRunner spawner
// (driven via a fake execFile so no real scp is invoked).

import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_DOWNLOAD_BYTES,
  MAX_IMPORT_BYTES,
  SCP_UPLOAD_TIMEOUT_MS,
  SystemScpRunner,
  buildScpArgs,
  buildScpUploadArgs,
  inferMimeType,
  resolveDestFilename,
  runScpUpload,
  shellSingleQuote,
  validateImportPath
} from './scp-runner'

import type { ScpRunner } from './scp-runner'
import type { ResolvedSshTarget } from './ssh-runner'

// ---------------------------------------------------------------------------
// Hoisted execFile double — drives SystemScpRunner's child event lifecycle.
// ---------------------------------------------------------------------------

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ execFile: execFileMock, spawn: spawnMock }))

// Controllable ChildProcess double matching execFile's surface used by
// SystemScpRunner: stderr is an EventEmitter, kill() records the signal.
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  kill = vi.fn(() => true)
  unref = vi.fn(() => this)
}

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
  it('passes the alias as the scp remote spec and preserves supported SSH options', async () => {
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

    // ControlMaster is unavailable on Windows; on supported platforms its args must survive the
    // -p → Port translation.
    if (process.platform === 'win32') {
      expect(args).not.toContain('ControlMaster=auto')
    } else {
      expect(args).toContain('ControlMaster=auto')
      expect(args.some((a) => a.startsWith('ControlPath='))).toBe(true)
    }
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

// ---------------------------------------------------------------------------
// validateImportPath — remaining branches (GLOB_CHARS and SHELL_UNSAFE_CHARS
// edge cases not covered by the test block above)
// ---------------------------------------------------------------------------

describe('validateImportPath — remaining dangerous-character branches', () => {
  it('rejects a path with a } glob char', () => {
    expect(validateImportPath('/home/user/{a,b}.csv}')).toBe('outside_roots')
  })

  it('rejects a path with a backslash glob char', () => {
    expect(validateImportPath('/home/user/back\\slash.csv')).toBe('outside_roots')
  })

  it('rejects a path with a backtick command substitution', () => {
    expect(validateImportPath('/home/user/`id`.csv')).toBe('outside_roots')
  })

  it('rejects a path with an input redirection (<)', () => {
    expect(validateImportPath('/home/user/a<b')).toBe('outside_roots')
  })

  it('rejects a path with a double quote', () => {
    expect(validateImportPath('/home/user/a"b.csv')).toBe('outside_roots')
  })

  it('rejects a path with a single quote', () => {
    expect(validateImportPath("/home/user/a'b.csv")).toBe('outside_roots')
  })

  it('rejects a path with a DEL control char (0x7f)', () => {
    expect(validateImportPath('/home/user/a\x7fb.csv')).toBe('outside_roots')
  })

  it('rejects a path with an empty string', () => {
    expect(validateImportPath('')).toBe('outside_roots')
  })
})

// ---------------------------------------------------------------------------
// SystemScpRunner — real scp spawner. Drives the child lifecycle via a fake
// execFile so we can assert the close/error/timeout branches without spawning
// real scp. Mirrors the SystemSshRunner test style in ssh-runner.test.ts.
// ---------------------------------------------------------------------------

describe('SystemScpRunner', () => {
  let runner: SystemScpRunner

  beforeEach(() => {
    runner = new SystemScpRunner()
    execFileMock.mockReset()
    spawnMock.mockReset()
  })

  afterEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
    vi.useRealTimers()
  })

  it('writes at most maxBytes and terminates a remote file that grows past the limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scp-bounded-test-'))
    const localPath = join(dir, 'bounded.bin')
    try {
      const child = new FakeChild()
      spawnMock.mockReturnValueOnce(child as unknown as ReturnType<typeof spawnMock>)
      const target: ResolvedSshTarget = {
        sshBinary: '/usr/bin/ssh',
        host: 'cluster',
        extraArgs: []
      }

      const promise = runner.copyFromRemoteBounded(
        target,
        '~/.openscience/jobs/job-1/growing.log',
        localPath,
        3
      )
      child.stdout.emit('data', Buffer.from('abcd'))
      child.stdout.emit('end')
      child.emit('close', null)

      const result = await promise
      expect(result).toMatchObject({ bytesWritten: 3, exceeded: true })
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      await expect(readFile(localPath, 'utf8')).resolves.toBe('abc')
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/bin/ssh',
        ['cluster', "head -c 4 -- ~/'.openscience/jobs/job-1/growing.log'"],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns exitCode 0 and the captured stderr on a clean child close', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.copy('/usr/bin/scp', ['biowulf:/remote/x.csv', '/tmp/x.csv'])

    child.stderr.emit('data', Buffer.from('progress noise\n'))
    child.emit('close', 0)

    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('progress noise\n')
    expect(result.timedOut).toBe(false)
  })

  it('returns a non-zero exitCode and the error message from stderr on failure', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.copy('/usr/bin/scp', ['biowulf:/remote/missing.csv', '/tmp/x.csv'])

    child.stderr.emit('data', Buffer.from('scp: /remote/missing.csv: No such file or directory\n'))
    child.emit('close', 1)

    const result = await promise
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('scp: /remote/missing.csv: No such file or directory\n')
    expect(result.timedOut).toBe(false)
  })

  it('marks timedOut=true and kills the child when the timer fires before close', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.copy('/usr/bin/scp', ['biowulf:/remote/big.bin', '/tmp/big.bin'], 1000)

    // Advance past the 1000ms timeout — the timer should SIGTERM the child.
    await vi.advanceTimersByTimeAsync(1000)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    // Now let the child close (scp exited on SIGTERM, code is null).
    child.emit('close', null)

    const result = await promise
    expect(result.timedOut).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('force-kills and settles when a timed-out child ignores SIGTERM and never closes', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)
    const settled = vi.fn()

    void runner
      .copy('/usr/bin/scp', ['biowulf:/remote/big.bin', '/tmp/big.bin'], 1000)
      .then(settled, settled)

    await vi.advanceTimersByTimeAsync(1000)
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ timedOut: true }))
  })

  it('force-kills and settles when a size-limited download ignores SIGTERM', async () => {
    vi.useFakeTimers()
    const dir = await mkdtemp(join(tmpdir(), 'scp-bounded-test-'))
    const child = new FakeChild()
    spawnMock.mockReturnValueOnce(child as unknown as ReturnType<typeof spawnMock>)
    const settled = vi.fn()

    try {
      void runner
        .copyFromRemoteBounded(
          { sshBinary: '/usr/bin/ssh', host: 'cluster', extraArgs: [] },
          '/remote/growing.log',
          join(dir, 'bounded.log'),
          3
        )
        .then(settled, settled)

      child.stdout.emit('data', Buffer.from('abcd'))
      expect(child.kill.mock.calls).toEqual([['SIGTERM']])

      await vi.advanceTimersByTimeAsync(2000)
      expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
      expect(settled).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1000)
      expect(settled).toHaveBeenCalledWith(expect.objectContaining({ exceeded: true }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('forwards child.on("error") as exitCode=null and stderr=err.message', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.copy('/usr/bin/scp', ['biowulf:/remote/x', '/tmp/x'])

    child.emit('error', new Error('spawn ENOENT scp'))

    const result = await promise
    expect(result.exitCode).toBeNull()
    expect(result.stderr).toBe('spawn ENOENT scp')
    expect(result.timedOut).toBe(false)
  })

  it('propagates in-flight cancellation as AbortError instead of a transfer failure', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)
    const controller = new AbortController()

    const promise = runner.copy('/usr/bin/scp', ['biowulf:/remote/x', '/tmp/x'], 10_000, {
      signal: controller.signal
    })
    controller.abort()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', null)

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('drops stderr chunks once the running total is already over the 8 KB cap', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.copy('/usr/bin/scp', ['biowulf:/remote/x', '/tmp/x'])

    // Two 5 KB chunks push the total past 8 KB (10 KB). The implementation only
    // checks "total < 8 KB" *before* pushing, so both fit. The cap is best-effort:
    // it stops appending once we're already over.
    child.stderr.emit('data', Buffer.alloc(5 * 1024, 'a'))
    child.stderr.emit('data', Buffer.alloc(5 * 1024, 'b'))
    // This third chunk sees total=10 KB, which is >= 8 KB, so it gets dropped.
    child.stderr.emit('data', Buffer.alloc(1024, 'c'))
    child.emit('close', 1)

    const result = await promise
    expect(result.stderr.length).toBe(10 * 1024)
    expect(result.exitCode).toBe(1)
  })

  it('clears the timer on a normal close so a later SIGTERM never fires', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.copy('/usr/bin/scp', ['biowulf:/remote/x', '/tmp/x'], 1000)

    child.emit('close', 0)
    const result = await promise
    expect(result.timedOut).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()

    // Advance well past the timeout — the cleared timer must not fire a stale kill.
    await vi.advanceTimersByTimeAsync(5000)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('uses the default SCP_TIMEOUT_MS when no timeout is provided', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.copy('/usr/bin/scp', ['biowulf:/remote/x', '/tmp/x'])

    child.emit('close', 0)
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })
})
