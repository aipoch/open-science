import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pit = it.skipIf(process.platform === 'win32')

import { parseProbeOutput } from './compute-service'
import {
  CappedOutput,
  SystemSshRunner,
  controlMasterArgs,
  readEffectiveConfig,
  resolveSshBinary,
  resolveSshTarget
} from './ssh-runner'

// ---------------------------------------------------------------------------
// Hoisted doubles (must exist before vi.mock factories run)
// ---------------------------------------------------------------------------

// execFile double — drives SystemSshRunner's child event lifecycle and the
// default readEffectiveConfig path (ssh -G) without spawning a real process.
//
// Node's real execFile exposes a custom promisified wrapper via
// `Symbol.for('nodejs.util.promisify.custom')` so util.promisify(execFile)
// resolves with `{ stdout, stderr }` on success. We attach the same symbol to
// our mock so resolveSshTarget's default readEffectiveConfig path
// (`const { stdout } = await execFileAsync(...)`) works exactly like production.
const { execFileMock } = vi.hoisted(() => {
  const CUSTOM_PROMISIFY = Symbol.for('nodejs.util.promisify.custom')
  const mock = vi.fn()
  ;(mock as unknown as Record<symbol, unknown>)[CUSTOM_PROMISIFY] = (
    ...args: unknown[]
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      mock(...args, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err)
        else resolve({ stdout, stderr })
      })
    })
  return { execFileMock: mock }
})

// platform double — lets us simulate Windows for controlMasterArgs and
// resolveSshTarget without actually running on Windows. Defaults to the real
// platform so existing platform-conditional skip guards keep matching reality.
const { platformMock } = vi.hoisted(() => ({
  platformMock: vi.fn(() => process.platform)
}))

// Mock only mkdirSync so we can assert the ~/.ssh/ctrl dir is created; everything else stays real.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  mkdirSync: vi.fn()
}))

// Mock execFile so SystemSshRunner and the default readEffectiveConfig path
// (when no fake readConfig is injected) can be driven by tests.
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

// Mock platform() while keeping the rest of node:os real (homedir etc.).
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: platformMock
}))

// Controllable ChildProcess double matching execFile's surface used by
// SystemSshRunner: stdout/stderr are EventEmitters, kill() records the signal.
class FakeChild extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  kill = vi.fn(() => true)
  unref = vi.fn(() => this)
}

// ---------------------------------------------------------------------------
// resolveSshBinary — on the current platform
// ---------------------------------------------------------------------------

describe('resolveSshBinary', () => {
  it('returns "ssh" on non-Windows platforms', () => {
    if (platform() === 'win32') return // skip on actual Windows CI
    expect(resolveSshBinary()).toBe('ssh')
  })
})

// ---------------------------------------------------------------------------
// controlMasterArgs — ControlPath injection + ctrl dir creation
// (regression guard for the "unix_listener: cannot bind ... No such file" bug)
// ---------------------------------------------------------------------------

describe('controlMasterArgs', () => {
  afterEach(() => {
    vi.mocked(mkdirSync).mockReset()
    // Restore platform mock so platform-conditional skip guards keep matching reality.
    platformMock.mockReturnValue(process.platform)
  })

  it('creates ~/.ssh/ctrl (0700) and injects a per-alias ControlPath on non-Windows', () => {
    if (platform() === 'win32') return // Windows returns [] — asserted separately below
    const args = controlMasterArgs('myhost')
    const ctrlDir = join(homedir(), '.ssh', 'ctrl')

    expect(mkdirSync).toHaveBeenCalledWith(ctrlDir, { recursive: true, mode: 0o700 })
    expect(args).toEqual([
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${join(ctrlDir, '%r@%h:%p.myhost')}`,
      '-o',
      'ControlPersist=60'
    ])
  })

  it('still returns control args when mkdir fails (best-effort)', () => {
    if (platform() === 'win32') return
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    const args = controlMasterArgs('h')
    expect(args).toContain('ControlMaster=auto')
    expect(args.some((a) => a.startsWith('ControlPath='))).toBe(true)
  })

  it('returns no args and creates no dir on Windows', () => {
    if (platform() !== 'win32') return // only meaningful on real Windows (see learnings.md)
    expect(controlMasterArgs('h')).toEqual([])
    expect(mkdirSync).not.toHaveBeenCalled()
  })

  // Simulates the win32 branch without a real Windows runner — covers the
  // `if (platform() === 'win32') return []` short-circuit that the platform-
  // conditional skip above leaves untested on macOS / Linux.
  it('returns an empty array and does not mkdir when platform() reports win32', () => {
    platformMock.mockReturnValue('win32')
    expect(controlMasterArgs('anyalias')).toEqual([])
    expect(mkdirSync).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// CappedOutput — accumulates stream chunks up to maxBytes and records when any
// bytes were dropped, so the ExecResult.truncated flag actually fires (design.md
// §5 "cap-exceeded → truncated=true"). Regression guard for the dead-flag bug where the
// stream handler capped bytes but truncation was re-checked against the already-
// capped buffer (which can never exceed maxBytes).
// ---------------------------------------------------------------------------

describe('CappedOutput', () => {
  it('keeps content and reports no truncation when total stays within the cap', () => {
    const out = new CappedOutput(10)
    out.push(Buffer.from('abc'))
    out.push(Buffer.from('def'))
    expect(out.toString()).toBe('abcdef')
    expect(out.wasTruncated()).toBe(false)
  })

  it('reports no truncation when total exactly equals the cap', () => {
    const out = new CappedOutput(6)
    out.push(Buffer.from('abc'))
    out.push(Buffer.from('def'))
    expect(out.toString()).toBe('abcdef')
    expect(out.wasTruncated()).toBe(false)
  })

  it('caps content and sets truncated when a single chunk exceeds the cap', () => {
    const out = new CappedOutput(4)
    out.push(Buffer.from('abcdefgh'))
    expect(out.toString()).toBe('abcd')
    expect(out.wasTruncated()).toBe(true)
  })

  it('caps content and sets truncated when a later chunk crosses the cap', () => {
    const out = new CappedOutput(5)
    out.push(Buffer.from('abc'))
    out.push(Buffer.from('defgh')) // only 'de' fits; the rest is dropped
    expect(out.toString()).toBe('abcde')
    expect(out.wasTruncated()).toBe(true)
  })

  it('drops chunks that arrive after the cap is already reached', () => {
    const out = new CappedOutput(3)
    out.push(Buffer.from('abc'))
    out.push(Buffer.from('def'))
    expect(out.toString()).toBe('abc')
    expect(out.wasTruncated()).toBe(true)
  })

  // Exact-fit across multiple pushes: covers the `chunk.length === remaining` boundary
  // where remaining > 0 and remaining is the entire new chunk (no truncation).
  it('does not truncate when a final chunk exactly fills the remaining capacity', () => {
    const out = new CappedOutput(10)
    out.push(Buffer.from('abcde'))
    out.push(Buffer.from('fghij'))
    expect(out.toString()).toBe('abcdefghij')
    expect(out.wasTruncated()).toBe(false)
  })

  // Overflow by exactly 1 byte: 3 already buffered, cap=5, push 3 → keep 2, drop 1.
  it('truncates by exactly one byte when an overflow chunk is one longer than remaining', () => {
    const out = new CappedOutput(5)
    out.push(Buffer.from('abc')) // 3 bytes; 2 remaining
    out.push(Buffer.from('defg')) // 4 bytes; only 'de' fits
    expect(out.toString()).toBe('abcde')
    expect(out.wasTruncated()).toBe(true)
  })

  // Many tiny pushes after the cap: the stream keeps emitting but the buffer is
  // full and every subsequent chunk is dropped, leaving truncated stuck on true.
  it('keeps truncated=true and discards every chunk pushed after the cap is full', () => {
    const out = new CappedOutput(4)
    for (const ch of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      out.push(Buffer.from(ch))
    }
    expect(out.toString()).toBe('abcd')
    expect(out.wasTruncated()).toBe(true)
  })

  // Single chunk equal to the cap exactly: not truncated.
  it('does not truncate when a single chunk equals the cap exactly', () => {
    const out = new CappedOutput(4)
    out.push(Buffer.from('abcd'))
    expect(out.toString()).toBe('abcd')
    expect(out.wasTruncated()).toBe(false)
  })

  // Overflow of an empty buffer: remaining === cap, push a huge chunk, keep cap bytes.
  it('caps to the full cap when an empty buffer receives a chunk larger than the cap', () => {
    const out = new CappedOutput(4)
    out.push(Buffer.from('abcdefghij'))
    expect(out.toString()).toBe('abcd')
    expect(out.wasTruncated()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseProbeOutput contract stability (probe output format must stay stable
// across ssh-runner and compute-service)
// ---------------------------------------------------------------------------

describe('parseProbeOutput probe output contract', () => {
  it('parses all fields from a complete Linux/Slurm probe output', () => {
    const out = [
      'os=Linux',
      'cpus=32',
      'mem_mib=128000',
      'gpus=A100 80GB;A100 80GB;',
      'sbatch=yes',
      'qsub=no',
      'bsub=no',
      'scratch=/scratch/user'
    ].join('\n')

    expect(parseProbeOutput(out)).toMatchObject({
      os: 'Linux',
      cpus: 32,
      memMib: 128000,
      gpus: [{ type: 'A100 80GB', count: 2 }],
      detectedScheduler: 'slurm',
      scratchEnv: '/scratch/user'
    })
  })

  it('parses a macOS direct-ssh host (no scheduler, no GPUs)', () => {
    const out = [
      'os=Darwin',
      'cpus=16',
      'mem_mib=65536',
      'gpus=',
      'sbatch=no',
      'qsub=no',
      'bsub=no',
      'scratch='
    ].join('\n')

    const result = parseProbeOutput(out)
    expect(result.detectedScheduler).toBe('none')
    expect(result.gpus).toEqual([])
    expect(result.scratchEnv).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveSshTarget — host must be the alias (not the resolved IP) so that the
// ~/.ssh/config "Host <alias>" block is applied by ssh/scp, including a
// non-default IdentityFile. Regression guard for the "Permission denied
// (publickey,password)" bug where the resolved hostname was passed instead,
// silently dropping the IdentityFile directive.
// ---------------------------------------------------------------------------

describe('resolveSshTarget', () => {
  // Pretend `ssh -G aliyun-xt-test` output — non-default identityfile is the key detail.
  const fakeSshG = (): Record<string, string> => ({
    user: 'ewen',
    hostname: '47.98.96.100',
    port: '22',
    identityfile: '~/.ssh/aliyun-xt-test.pem'
  })

  it('rejects an option-like alias before consulting ssh -G', async () => {
    const readConfig = vi.fn(async () => fakeSshG())

    await expect(
      resolveSshTarget('-oProxyCommand=touch /tmp/not-approved', undefined, readConfig)
    ).rejects.toThrow(/alias/i)
    expect(readConfig).not.toHaveBeenCalled()
  })

  it.each([
    'host/name',
    '../host',
    'host\\name',
    'host%h',
    'host name',
    '\ncluster',
    'host\nname',
    'host\x00name',
    'a'.repeat(256)
  ])('rejects an alias that cannot be passed to OpenSSH safely: %j', async (alias) => {
    const readConfig = vi.fn(async () => fakeSshG())

    await expect(resolveSshTarget(alias, undefined, readConfig)).rejects.toThrow(/alias/i)
    expect(readConfig).not.toHaveBeenCalled()
  })

  it('accepts and trims a 255-character alias', async () => {
    const alias = 'a'.repeat(255)
    const target = await resolveSshTarget(` ${alias} `, undefined, async () => ({}))

    expect(target.host).toBe(alias)
  })

  it('rejects an option-like alias before spawning ssh -G directly', async () => {
    execFileMock.mockClear()

    await expect(
      readEffectiveConfig('-oProxyCommand=touch /tmp/not-approved', 'ssh')
    ).rejects.toThrow(/alias/i)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('returns the alias as host, NOT the resolved hostname', async () => {
    const target = await resolveSshTarget('aliyun-xt-test', undefined, async () => fakeSshG())
    expect(target.host).toBe('aliyun-xt-test')
    expect(target.host).not.toBe('47.98.96.100')
  })

  it('does not pass -i when identityFile override is absent (config handles it via alias)', async () => {
    const target = await resolveSshTarget('aliyun-xt-test', undefined, async () => fakeSshG())
    expect(target.extraArgs).not.toContain('-i')
  })

  it('passes -i <path> when an explicit identityFile override is provided', async () => {
    const target = await resolveSshTarget(
      'aliyun-xt-test',
      { identityFile: '/keys/custom.pem' },
      async () => fakeSshG()
    )
    const iIdx = target.extraArgs.indexOf('-i')
    expect(iIdx).toBeGreaterThan(-1)
    expect(target.extraArgs[iIdx + 1]).toBe('/keys/custom.pem')
  })

  it('always sets BatchMode and ConnectTimeout', async () => {
    const target = await resolveSshTarget('aliyun-xt-test', undefined, async () => fakeSshG())
    expect(target.extraArgs).toContain('BatchMode=yes')
    expect(target.extraArgs).toContain('ConnectTimeout=10')
  })

  it('applies user override from ssh -G', async () => {
    const target = await resolveSshTarget('aliyun-xt-test', undefined, async () => fakeSshG())
    expect(target.extraArgs).toContain('User=ewen')
  })

  it('passes non-default port from ssh -G', async () => {
    const target = await resolveSshTarget('aliyun-xt-test', undefined, async () => ({
      ...fakeSshG(),
      port: '2222'
    }))
    expect(target.extraArgs).toContain('-p')
    expect(target.extraArgs).toContain('2222')
  })

  it('does not pass -p when port is the default 22', async () => {
    const target = await resolveSshTarget('aliyun-xt-test', undefined, async () => fakeSshG())
    expect(target.extraArgs).not.toContain('-p')
  })

  it('falls back to the bare alias when ssh -G returns empty config', async () => {
    const target = await resolveSshTarget('bare-host', undefined, async () => ({}))
    expect(target.host).toBe('bare-host')
    expect(target.extraArgs).toContain('BatchMode=yes')
  })

  it('falls back to the bare alias when ssh -G process rejects', async () => {
    const target = await resolveSshTarget('bare-host', undefined, async () => {
      throw new Error('Command failed: ssh -G bare-host')
    })
    expect(target.host).toBe('bare-host')
    expect(target.extraArgs).toContain('BatchMode=yes')
  })

  // When ssh -G resolves to the same user as the alias, the explicit -o User=
  // would be redundant with what ssh already applies via the alias; resolveSshTarget
  // skips it. This guards the `resolvedUser !== alias` branch.
  it('does not emit -o User= when ssh -G user equals the alias', async () => {
    const target = await resolveSshTarget('aliyun-xt-test', undefined, async () => ({
      user: 'aliyun-xt-test', // same as alias
      hostname: '47.98.96.100',
      port: '22'
    }))
    expect(target.extraArgs.some((a) => a.startsWith('User='))).toBe(false)
  })

  // Explicit overrides take precedence over ssh -G and also skip the redundant
  // -o User= when the override equals the alias.
  it('does not emit -o User= when an explicit user override equals the alias', async () => {
    const target = await resolveSshTarget('aliyun-xt-test', { user: 'aliyun-xt-test' }, async () =>
      fakeSshG()
    )
    expect(target.extraArgs.some((a) => a.startsWith('User='))).toBe(false)
  })

  // Trims whitespace from explicit user override before comparing with alias.
  it('trims whitespace from an explicit user override', async () => {
    const target = await resolveSshTarget('aliyun-xt-test', { user: '  ewen  ' }, async () =>
      fakeSshG()
    )
    expect(target.extraArgs).toContain('User=ewen')
  })

  // Default readEffectiveConfig path (ssh -G) — covers the readConfig-throws /
  // parseSshG-empty branches when execFile fails. The injected mock invokes the
  // promisified callback with an error so readEffectiveConfig catches and returns {}.
  it('falls back to defaults when the default readConfig rejects (ssh -G failure)', async () => {
    execFileMock.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        cb(new Error('ssh binary not found'), '', '')
        return new FakeChild()
      }
    )
    const target = await resolveSshTarget('bare-host', undefined) // no injected readConfig
    expect(target.host).toBe('bare-host')
    expect(target.extraArgs).toContain('BatchMode=yes')
    expect(target.extraArgs).toContain('ConnectTimeout=10')
    expect(target.extraArgs.some((a) => a.startsWith('User='))).toBe(false)
  })

  // parseSshG edge cases — driven through the default readConfig path (no injected
  // fake), so the mocked execFile stdout flows through parseSshG:
  //   - line with no space → skipped
  //   - empty line → skipped
  //   - line with only spaces → key/value both empty → skipped
  //   - normal "key value" line → kept
  it('ignores non-key-value lines in ssh -G output via the default readConfig path', async () => {
    execFileMock.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        cb(
          null,
          [
            'no-space-line', // no space → skipped
            '', // empty → skipped
            ' ', // space-only → key empty + value empty → skipped
            'user alice',
            'hostname foo',
            'port 22'
          ].join('\n'),
          ''
        )
        return new FakeChild()
      }
    )
    const target = await resolveSshTarget('myhost', undefined)
    expect(target.extraArgs).toContain('User=alice')
    expect(target.extraArgs).not.toContain('-p') // port 22 is the default
    expect(target.extraArgs.some((a) => a.startsWith('User='))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SystemSshRunner — real ssh spawner. Drives the child lifecycle via a fake
// execFile so we can assert the close/error/timeout branches without a real ssh.
// ---------------------------------------------------------------------------

describe('SystemSshRunner', () => {
  let runner: SystemSshRunner

  beforeEach(() => {
    runner = new SystemSshRunner()
    execFileMock.mockReset()
  })

  afterEach(() => {
    execFileMock.mockReset()
    vi.useRealTimers()
  })

  const target = (): { sshBinary: string; host: string; extraArgs: string[] } => ({
    sshBinary: '/usr/bin/ssh',
    host: 'aliyun-xt-test',
    extraArgs: []
  })

  it('does not place a large remote command in the local process arguments', async () => {
    const child = new FakeChild()
    execFileMock.mockImplementationOnce((_file: string, args: string[]) => {
      queueMicrotask(() => {
        if (args.join(' ').length > 20_000) {
          child.emit('error', new Error('spawn ENAMETOOLONG'))
        } else {
          child.emit('close', 0)
        }
      })
      return child as unknown as ReturnType<typeof execFileMock>
    })
    const command = `# ${'x'.repeat(24_000)}\nprintf 'ok\\n' > long-command-ok.txt`

    const result = await runner.run(target(), command, { timeoutMs: 5000 })

    expect(result).toMatchObject({ exitCode: 0, stderr: '' })
    expect(execFileMock.mock.calls[0]?.[1]).not.toContain(command)
    expect(child.stdin.end).toHaveBeenCalledWith(command)
  })

  it('captures stdout/stderr and reports exitCode on a clean child close', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.run(target(), 'echo hello', { timeoutMs: 5000 })

    child.stdout.emit('data', Buffer.from('hello\n'))
    child.stderr.emit('data', Buffer.from('warn\n'))
    child.emit('close', 0)

    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello\n')
    expect(result.stderr).toBe('warn\n')
    expect(result.truncated).toBe(false)
    expect(result.timedOut).toBe(false)
  })

  it('forwards child.on("error") as exitCode=null and stderr=err.message', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.run(target(), 'echo hello', { timeoutMs: 5000 })

    child.emit('error', new Error('spawn ENOENT ssh'))

    const result = await promise
    expect(result.exitCode).toBeNull()
    expect(result.stderr).toBe('spawn ENOENT ssh')
    expect(result.stdout).toBe('')
    expect(result.truncated).toBe(false)
    expect(result.timedOut).toBe(false)
  })

  it('marks timedOut=true and kills the child when the timeout fires before close', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.run(target(), 'long-running', { timeoutMs: 1000 })

    // Advance past the 1000ms timeout — the timer should fire and SIGTERM the child.
    await vi.advanceTimersByTimeAsync(1000)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')

    // Now let the child close (ssh exited on SIGTERM).
    child.emit('close', null)

    const result = await promise
    expect(result.timedOut).toBe(true)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('settles after a bounded grace period when a timed-out child never closes', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)
    const settled = vi.fn()

    void runner.run(target(), 'ignores-signals', { timeoutMs: 1000 }).then(settled, settled)

    await vi.advanceTimersByTimeAsync(1000)
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)

    expect(settled).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ timedOut: true }))
    expect(child.stdout.destroy).toHaveBeenCalledOnce()
    expect(child.stderr.destroy).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('kills the child and preserves AbortSignal cancellation', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)
    const controller = new AbortController()

    const promise = runner.run(target(), 'long-running', {
      timeoutMs: 5000,
      signal: controller.signal
    })
    const settled = vi.fn()
    void promise.then(settled, settled)
    controller.abort()

    child.emit('exit', null)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()

    child.emit('close', null)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('does not reject an aborted run until the child has closed', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)
    const controller = new AbortController()
    const settled = vi.fn()

    const promise = runner.run(target(), 'long-running', {
      timeoutMs: 5000,
      signal: controller.signal
    })
    void promise.then(settled, settled)

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()

    child.emit('close', null)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('keeps a final boundary when an aborted child exits but its streams never close', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)
    const controller = new AbortController()
    const settled = vi.fn()

    void runner
      .run(target(), 'leaves-streams-open', { timeoutMs: 5000, signal: controller.signal })
      .then(settled, settled)

    controller.abort()
    child.emit('exit', null)
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveBeenCalledOnce()
    expect(settled.mock.calls[0]?.[0]).toMatchObject({ name: 'AbortError' })
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
  })

  it('rejects after a bounded grace period when an aborted child never closes', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)
    const controller = new AbortController()
    const settled = vi.fn()

    void runner
      .run(target(), 'ignores-signals', { timeoutMs: 5000, signal: controller.signal })
      .then(settled, settled)

    controller.abort()
    await vi.advanceTimersByTimeAsync(2000)
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)

    expect(settled).toHaveBeenCalledOnce()
    expect(settled.mock.calls[0]?.[0]).toMatchObject({ name: 'AbortError' })
  })

  it('wraps the command in bash -lc when loginShell=true', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.run(target(), 'echo $PATH', {
      timeoutMs: 5000,
      loginShell: true
    })

    child.emit('close', 0)
    await promise

    const callArgs = execFileMock.mock.calls[0]
    expect(callArgs).toBeDefined()
    // The remote command must be the last positional argument and wrapped so login profiles and
    // a readable .bashrc load before the user command runs.
    const lastArg = callArgs?.[1]?.[callArgs[1].length - 1] as string
    expect(lastArg.startsWith('bash -lc ')).toBe(true)
    expect(lastArg).toContain('echo $PATH')
    // Single-quoted, not double-quoted: a double-quoted layer would expand $PATH in the OUTER shell
    // before bash -lc ever ran it (see the injection test below).
    expect(lastArg).toBe(
      "bash -lc 'if [ -r ~/.bashrc ]; then . ~/.bashrc || exit $?; fi; echo $PATH'"
    )
  })

  pit('initializes a readable remote .bashrc before the command when loginShell=true', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)
    const home = await mkdtemp(join(tmpdir(), 'open-science-ssh-runner-'))

    try {
      await writeFile(join(home, '.bashrc'), 'export COMPUTE_BASHRC_MARKER=from-bashrc\n')
      const promise = runner.run(target(), 'printf %s "$COMPUTE_BASHRC_MARKER"', {
        timeoutMs: 5000,
        loginShell: true
      })

      child.emit('close', 0)
      await promise

      const callArgs = execFileMock.mock.calls[0]
      const remoteCommand = callArgs?.[1]?.[callArgs[1].length - 1] as string
      const { execFileSync } =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      const stdout = execFileSync('/bin/sh', ['-c', remoteCommand], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home }
      })

      expect(stdout).toBe('from-bashrc')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  pit('treats a missing remote .bashrc as a successful no-op when loginShell=true', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)
    const home = await mkdtemp(join(tmpdir(), 'open-science-ssh-runner-'))

    try {
      const promise = runner.run(target(), 'printf no-bashrc', {
        timeoutMs: 5000,
        loginShell: true
      })

      child.emit('close', 0)
      await promise

      const callArgs = execFileMock.mock.calls[0]
      const remoteCommand = callArgs?.[1]?.[callArgs[1].length - 1] as string
      const { execFileSync } =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      const stdout = execFileSync('/bin/sh', ['-c', remoteCommand], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home }
      })

      expect(stdout).toBe('no-bashrc')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  pit('continues when remote .bashrc returns early for a non-interactive shell', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)
    const home = await mkdtemp(join(tmpdir(), 'open-science-ssh-runner-'))

    try {
      await writeFile(
        join(home, '.bashrc'),
        'case $- in *i*) ;; *) return ;; esac\nexport COMPUTE_BASHRC_MARKER=from-bashrc\n'
      )
      const promise = runner.run(target(), 'printf %s "${COMPUTE_BASHRC_MARKER-unset}"', {
        timeoutMs: 5000,
        loginShell: true
      })

      child.emit('close', 0)
      await promise

      const callArgs = execFileMock.mock.calls[0]
      const remoteCommand = callArgs?.[1]?.[callArgs[1].length - 1] as string
      const { execFileSync } =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      const stdout = execFileSync('/bin/sh', ['-c', remoteCommand], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home }
      })

      expect(stdout).toBe('unset')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  pit('returns a .bashrc initialization failure as the remote command exit status', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)
    const home = await mkdtemp(join(tmpdir(), 'open-science-ssh-runner-'))

    try {
      await writeFile(join(home, '.bashrc'), 'return 23\n')
      const promise = runner.run(target(), 'printf command-must-not-run', {
        timeoutMs: 5000,
        loginShell: true
      })

      child.emit('close', 23)
      const result = await promise

      const callArgs = execFileMock.mock.calls[0]
      const remoteCommand = callArgs?.[1]?.[callArgs[1].length - 1] as string
      const { spawnSync } =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      const execution = spawnSync('/bin/sh', ['-c', remoteCommand], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home }
      })

      expect(execution.status).toBe(23)
      expect(execution.stdout).toBe('')
      expect(result.exitCode).toBe(23)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not initialize a shell when loginShell=false', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.run(target(), 'printf no-initialization', {
      timeoutMs: 5000,
      loginShell: false
    })

    child.emit('close', 0)
    await promise

    const callArgs = execFileMock.mock.calls[0]
    expect(callArgs?.[1]?.[callArgs[1].length - 1]).toBe('printf no-initialization')
  })

  pit(
    'single-quotes the loginShell wrapper so an inner quoted path cannot be re-expanded',
    async () => {
      // Regression: the wrapper used to be JSON.stringify (double quotes), which leaves $(...), backticks
      // and $VAR live for the outer shell. That silently defeated inner single-quoting done by callers
      // (quoteRemotePath in the provisioning witness), so a spec-supplied cache path could execute a
      // second command. With single-quoting, the payload stays literal for the outer layer.
      const child = new FakeChild()
      execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

      const malicious = '/data/cache/$(touch /tmp/pwned)/`id`'
      const promise = runner.run(target(), `test -d '${malicious}'`, {
        timeoutMs: 5000,
        loginShell: true
      })

      child.emit('close', 0)
      await promise

      const callArgs = execFileMock.mock.calls[0]
      const lastArg = callArgs?.[1]?.[callArgs[1].length - 1] as string
      // The whole command is wrapped in single quotes, so the outer shell expands nothing.
      expect(lastArg.startsWith("bash -lc '")).toBe(true)
      expect(lastArg.endsWith("'")).toBe(true)
      // No double-quoted wrapper remains (that was the vector).
      expect(lastArg.startsWith('bash -lc "')).toBe(false)
      // Strongest check: hand the quoted argument to a REAL shell with `bash -lc` swapped for `printf`.
      // What printf receives is exactly what bash -lc would have received, so if the payload survives
      // byte-for-byte with no expansion, the quoting held.
      // node:child_process is mocked module-wide (execFile only), so pull the real execFileSync.
      const { execFileSync } =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      const asPrintf = lastArg.replace(/^bash -lc /, 'printf %s ')
      const echoed = execFileSync('/bin/sh', ['-c', asPrintf], { encoding: 'utf8' })
      expect(echoed).toBe(
        `if [ -r ~/.bashrc ]; then . ~/.bashrc || exit $?; fi; test -d '${malicious}'`
      )
    }
  )

  it('truncates stream buffers independently when maxOutputBytes is small', async () => {
    const child = new FakeChild()
    execFileMock.mockReturnValueOnce(child as unknown as ReturnType<typeof execFileMock>)

    const promise = runner.run(target(), 'big', { timeoutMs: 5000, maxOutputBytes: 4 })

    child.stdout.emit('data', Buffer.from('abcdefgh'))
    child.stderr.emit('data', Buffer.from('12345678'))
    child.emit('close', 0)

    const result = await promise
    expect(result.stdout).toBe('abcd')
    expect(result.stderr).toBe('1234')
    expect(result.truncated).toBe(true)
  })
})
