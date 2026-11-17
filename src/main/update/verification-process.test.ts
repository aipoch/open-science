import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as processTree from '../process-tree'
import {
  runVerificationProcess,
  VerificationProcessExitError,
  VerificationProcessUnsettledError,
  verificationDirectoryIsSettled
} from './verification-process'

// Keep the OS tests on real spawn; the admission protocol cases temporarily supply a child fixture.
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

describe('bounded verification subprocess', () => {
  it.skipIf(process.platform === 'win32')(
    'does not signal an unrelated group that reuses an exited verifier group ID',
    async () => {
      const victim = spawn(
        process.execPath,
        ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
      )
      const victimExit = once(victim, 'close')
      const originalKill = process.kill.bind(process)
      const terminate = processTree.terminateProcessTree
      let exitedGroup: number | undefined
      const delivered: NodeJS.Signals[] = []
      const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        // Model only kernel PGID reuse; all delivered signals reach our real fixture group.
        if (exitedGroup !== undefined && pid === -exitedGroup) {
          if (signal !== 0) delivered.push(signal as NodeJS.Signals)
          return originalKill(-victim.pid!, signal)
        }
        return originalKill(pid, signal)
      })
      const cleanup = vi
        .spyOn(processTree, 'terminateProcessTree')
        .mockImplementation(async (child, ...args) => {
          expect(child.exitCode).toBe(0)
          expect(() => originalKill(-child.pid!, 0)).toThrow()
          exitedGroup = child.pid
          return terminate(child, ...args)
        })
      try {
        await once(victim.stdout!, 'data')
        const outcome = await runVerificationProcess(process.execPath, [
          '-e',
          'process.exit(0)'
        ]).catch((error: unknown) => error)
        expect(() => originalKill(victim.pid!, 0)).not.toThrow()
        expect(outcome).toBeInstanceOf(VerificationProcessUnsettledError)
        expect(delivered).toEqual([])
      } finally {
        cleanup.mockRestore()
        kill.mockRestore()
        try {
          originalKill(-victim.pid!, 'SIGKILL')
        } catch {
          // The pre-fix regression kills only this fixture group.
        }
        await victimExit
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reaps a descendant after its verification leader exits',
    async () => {
      let descendant: number | undefined
      const root = await mkdtemp(join(tmpdir(), 'verification-leaderless-'))
      const pidPath = join(root, 'descendant.pid')
      const terminate = processTree.terminateProcessTree
      const cleanup = vi
        .spyOn(processTree, 'terminateProcessTree')
        .mockImplementation(async (child, ...args) => {
          expect(child.exitCode).toBe(0)
          descendant = Number(await readFile(pidPath, 'utf8'))
          return terminate(child, ...args)
        })
      try {
        const output = await runVerificationProcess(process.execPath, [
          '-e',
          `
          const child = require('node:child_process').spawn(process.execPath,
            ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
          require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
          process.stdout.write(String(child.pid), () => process.exit(0));
        `
        ]).then((value) => {
          descendant = Number(value.stdout)
          return value
        })
        expect(Number(output.stdout)).toBeGreaterThan(0)
        expect(() => process.kill(descendant!, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' })
        )
      } finally {
        cleanup.mockRestore()
        // Retain the real descendant PID even when the production result rejects.
        if (descendant) {
          try {
            process.kill(descendant, 'SIGKILL')
          } catch {
            // Successful production teardown already reaped this fixture.
          }
        }
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform === 'linux')(
    'retains birth proof when a Linux target exits before synchronous registration',
    async () => {
      const track = processTree.trackOwnedPosixProcessTree
      const root = await mkdtemp(join(tmpdir(), 'verification-linux-zombie-'))
      let observedState: string | undefined
      let expectedBirthToken: string | undefined
      let exitCodeAtCapture: number | null | undefined
      let birthToken: string | undefined
      const registration = vi
        .spyOn(processTree, 'trackOwnedPosixProcessTree')
        .mockImplementation((child, token) => {
          // Hold this JS turn until the real target has exited. Linux retains its /proc identity
          // as a zombie until libuv can process SIGCHLD on a subsequent event-loop turn.
          const pause = new Int32Array(new SharedArrayBuffer(4))
          const deadline = Date.now() + 2000
          while (Date.now() < deadline) {
            const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8')
            const fields = stat
              .slice(stat.lastIndexOf(')') + 1)
              .trim()
              .split(/\s+/u)
            observedState = fields[0]
            if (observedState === 'Z') {
              expectedBirthToken = `linux-proc-starttime:${fields[19]}`
              break
            }
            Atomics.wait(pause, 0, 0, 5)
          }
          exitCodeAtCapture = child.exitCode
          track(child, token)
          birthToken = processTree.capturePosixProcessTreeIdentity(child)?.birthToken
        })
      try {
        await expect(
          runVerificationProcess(process.execPath, ['-e', "process.stdout.write('completed')"], {
            cwd: root
          })
        ).resolves.toEqual({ stdout: 'completed', stderr: '' })
        expect(observedState).toBe('Z')
        expect(exitCodeAtCapture).toBeNull()
        expect(expectedBirthToken).toMatch(/^linux-proc-starttime:\d+$/u)
        expect(birthToken).toBe(expectedBirthToken)
        expect(verificationDirectoryIsSettled(root)).toBe(true)
      } finally {
        registration.mockRestore()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform === 'darwin')(
    'captures ownership before fast POSIX commands execute',
    async () => {
      for (let attempt = 0; attempt < 5; attempt += 1)
        await expect(
          runVerificationProcess('/bin/ps', ['-p', String(process.pid), '-o', 'pid='])
        ).resolves.toMatchObject({
          stdout: expect.stringContaining(String(process.pid)),
          stderr: ''
        })
      await expect(
        runVerificationProcess('/usr/bin/printf', ['%s', 'literal $(echo not-expanded); "quoted"'])
      ).resolves.toEqual({ stdout: 'literal $(echo not-expanded); "quoted"', stderr: '' })
      await expect(
        runVerificationProcess('printf', ['shell-gate'], { shell: true })
      ).resolves.toEqual({ stdout: 'shell-gate', stderr: '' })
    }
  )

  it.runIf(process.platform === 'darwin')(
    'keeps command input separate from the launch ownership pipe',
    async () => {
      const track = processTree.trackOwnedPosixProcessTree
      const registration = vi
        .spyOn(processTree, 'trackOwnedPosixProcessTree')
        .mockImplementation((child, token) => {
          track(child, token)
          child.stdin!.end('command-input')
        })
      try {
        await expect(
          runVerificationProcess(
            process.execPath,
            [
              '-e',
              `process.stdin.on('data', chunk => process.stdout.write(chunk)); process.stdin.resume()`
            ],
            { stdin: 'pipe' }
          )
        ).resolves.toEqual({ stdout: 'command-input', stderr: '' })
      } finally {
        registration.mockRestore()
      }
    }
  )

  it.runIf(process.platform === 'darwin')(
    'closes an unreleased launch pipe after unconfirmed cancellation',
    async () => {
      const controller = new AbortController()
      const track = processTree.trackOwnedPosixProcessTree
      const terminate = processTree.terminateProcessTree
      let child: import('node:child_process').ChildProcess | undefined
      const registration = vi
        .spyOn(processTree, 'trackOwnedPosixProcessTree')
        .mockImplementation((ownedChild, token) => {
          child = ownedChild
          track(ownedChild, token)
          controller.abort(new Error('cancel before launch'))
        })
      const cleanup = vi
        .spyOn(processTree, 'terminateProcessTree')
        .mockResolvedValue({ reaped: false })
      try {
        await expect(
          runVerificationProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            signal: controller.signal
          })
        ).rejects.toBeInstanceOf(VerificationProcessUnsettledError)
        await vi.waitFor(() => expect(child!.exitCode).not.toBeNull(), { timeout: 1000 })
        expect(child!.exitCode).toBe(125)
        expect(() => process.kill(child!.pid!, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' })
        )
      } finally {
        cleanup.mockRestore()
        registration.mockRestore()
        if (child) await terminate(child)
      }
    }
  )

  it.runIf(process.platform === 'darwin')(
    'never starts a target without registered launch identity',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'verification-no-identity-'))
      const marker = join(root, 'must-not-run')
      const identity = vi
        .spyOn(processTree, 'capturePosixProcessTreeIdentity')
        .mockReturnValue(undefined)
      try {
        await expect(
          runVerificationProcess(process.execPath, [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`
          ])
        ).rejects.toThrow('ownership could not be registered')
        await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        identity.mockRestore()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('preserves spawn failure evidence when the working directory is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-missing-cwd-'))
    try {
      await expect(
        runVerificationProcess(process.execPath, ['-e', 'process.exit(0)'], {
          cwd: join(root, 'missing')
        })
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a missing target promptly and settles its working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-missing-'))
    try {
      await expect(
        runVerificationProcess(join(root, 'missing-command'), [], { cwd: root, timeoutMs: 1000 })
      ).rejects.toThrow()
      expect(verificationDirectoryIsSettled(root)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns both output streams after successful verification with an input pipe', async () => {
    await expect(
      runVerificationProcess(
        process.execPath,
        ['-e', "process.stdout.write('verified'); process.stderr.write('diagnostic')"],
        { stdin: 'pipe' }
      )
    ).resolves.toEqual({ stdout: 'verified', stderr: 'diagnostic' })
  })

  it.each([0, 1])('preserves a browser after natural CLI exit %i', async (exitCode) => {
    const root = await mkdtemp(join(tmpdir(), 'verification-preserve-'))
    // A response to a post-exit request proves the browser is still running, even on hosts
    // where a dead process remains visible as a zombie. Removing the request directory ends it.
    const browser = `
      const fs = require('node:fs');
      const root = process.argv[1];
      const timer = setInterval(() => {
        if (!fs.existsSync(root)) return clearInterval(timer);
        if (fs.existsSync(root + '/request')) {
          fs.writeFileSync(root + '/response', 'alive');
          clearInterval(timer);
        }
      }, 25);
      setTimeout(() => process.exit(), 30000).unref();
    `
    try {
      const cli = `
        require('node:child_process').spawn(process.execPath,
          ['-e', ${JSON.stringify(browser)}, ${JSON.stringify(root)}], {
            cwd: '..',
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          }).unref();
        process.stderr.write('auth diagnostic');
        process.exitCode = ${exitCode};
      `
      const result = runVerificationProcess(process.execPath, ['-e', cli], {
        cwd: root,
        stdin: 'pipe',
        preserveChildrenOnExit: true
      })
      if (exitCode === 0)
        await expect(result).resolves.toEqual({ stdout: '', stderr: 'auth diagnostic' })
      else {
        await expect(result).rejects.toBeInstanceOf(VerificationProcessExitError)
        await expect(result).rejects.toMatchObject({ exitCode, stderr: 'auth diagnostic' })
      }
      expect(verificationDirectoryIsSettled(root)).toBe(true)
      await writeFile(join(root, 'request'), '')
      await vi.waitFor(
        async () => expect(await readFile(join(root, 'response'), 'utf8')).toBe('alive'),
        { timeout: 3000 }
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('blocks cleanup of an unconfirmed working directory and its parents, but not siblings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-unsettled-'))
    const directory = join(root, 'candidate')
    const terminate = processTree.terminateProcessTree
    const cleanup = vi
      .spyOn(processTree, 'terminateProcessTree')
      .mockImplementation(async (...args) => {
        // Reap the real fixture before simulating an unconfirmed cleanup receipt.
        await terminate(...args)
        return { reaped: false }
      })
    try {
      await mkdir(directory)
      expect(verificationDirectoryIsSettled(directory)).toBe(true)
      const pending = runVerificationProcess(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: directory
      })
      await expect(pending).rejects.toBeInstanceOf(VerificationProcessUnsettledError)
      await expect(pending).rejects.toMatchObject({ directory })
      expect(verificationDirectoryIsSettled(directory)).toBe(false)
      expect(verificationDirectoryIsSettled(root)).toBe(false)
      expect(verificationDirectoryIsSettled(`${directory}-sibling`)).toBe(true)
    } finally {
      cleanup.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { exitCode: 2, signal: null, terminate: 'process.exit(2)' },
    ...(process.platform === 'win32'
      ? []
      : [{ exitCode: null, signal: 'SIGKILL', terminate: "process.kill(process.pid, 'SIGKILL')" }])
  ])(
    'retains stderr and exit evidence ($exitCode, $signal) without exposing it in the display message',
    async ({ exitCode, signal, terminate }) => {
      const stderr = 'Cannot inspect 安装目录: EACCES\n' + 'detail\n'.repeat(3000)
      const error = await runVerificationProcess(process.execPath, [
        '-e',
        `process.stderr.write(${JSON.stringify(stderr)}, () => { ${terminate} })`
      ]).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(VerificationProcessExitError)
      expect(error).toMatchObject({ exitCode, signal, stderr })
      expect((error as Error).message).not.toContain('EACCES')
    }
  )

  it('cancels a running process and waits for its exit', async () => {
    const controller = new AbortController()
    const pending = runVerificationProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { signal: controller.signal }
    )
    setTimeout(() => controller.abort(new Error('explicit cancellation')), 30)
    await expect(pending).rejects.toThrow('explicit cancellation')
  })
  it('terminates descendants holding inherited pipes within its deadline', async () => {
    const started = Date.now()
    await expect(
      runVerificationProcess(
        process.execPath,
        [
          '-e',
          "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)"
        ],
        { timeoutMs: 100 }
      )
    ).rejects.toThrow('time limit')
    expect(Date.now() - started).toBeLessThan(3000)
  })
  it('ends hung commands without relying on installation age', async () => {
    await expect(
      runVerificationProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeoutMs: 30
      })
    ).rejects.toThrow('time limit')
  })
  it('refuses oversized output while keeping UI timers responsive', async () => {
    let ticked = false
    setTimeout(() => {
      ticked = true
    }, 5)
    await expect(
      runVerificationProcess(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000)"],
        { maxBytes: 100 }
      )
    ).rejects.toThrow('output exceeded')
    expect(ticked).toBe(true)
  })
})

// Exercise the admission protocol on every CI host. Real Darwin process/identity cases above remain
// authoritative for OS behavior; these fixtures isolate runner decisions from the native binding.
describe('Darwin verification admission boundary', () => {
  class Child extends EventEmitter {
    pid: number | undefined = 43210
    stdin = new PassThrough()
    stdout = new PassThrough()
    stderr = new PassThrough()
    gate = new PassThrough()
    stdio: (PassThrough | undefined)[] = [this.stdin, this.stdout, this.stderr, this.gate]
    unref = vi.fn()
  }
  let child: Child
  let platform: PropertyDescriptor
  let restore: () => void = () => undefined
  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    child = new Child()
    const previousSpawn = vi.mocked(spawn).getMockImplementation()!
    vi.mocked(spawn).mockClear()
    const spies = [
      vi.mocked(spawn).mockReturnValue(child as never),
      vi.spyOn(processTree, 'createPosixProcessTreeOwnership').mockImplementation((env) => ({
        env: { ...(env ?? process.env), OPEN_SCIENCE_PROCESS_TREE_ID: 'fixture-owner' },
        token: 'fixture-owner'
      })),
      vi.spyOn(processTree, 'trackOwnedPosixProcessTree').mockImplementation(() => undefined),
      vi.spyOn(processTree, 'capturePosixProcessTreeIdentity').mockReturnValue({
        pid: child.pid!,
        ppid: process.pid,
        pgid: child.pid!,
        sid: child.pid!,
        birthToken: 'fixture-birth',
        parentBirthToken: undefined,
        birthOrder: undefined
      }),
      vi.spyOn(processTree, 'terminateProcessTree').mockResolvedValue({ reaped: true })
    ]
    restore = () => {
      for (const spy of spies) spy.mockRestore()
      vi.mocked(spawn).mockImplementation(previousSpawn)
    }
  })
  afterEach(async () => {
    // Settle even a failed assertion while termination is still mocked; never hand a fixture PID
    // to the real process owner after restoring the boundary.
    child.emit('close', 0)
    await new Promise<void>((resolve) => setImmediate(resolve))
    restore()
    Object.defineProperty(process, 'platform', platform)
    for (const stream of [child.stdin, child.stdout, child.stderr, child.gate]) stream.destroy()
  })

  it.each([false, true])(
    'admits a proven target with separate stdin (shell: %s)',
    async (shell) => {
      const output = runVerificationProcess('printf', ['literal'], {
        shell,
        stdin: 'pipe',
        env: { VERIFICATION_FIXTURE: 'present' }
      })
      expect(child.gate.read()?.toString()).toBe('start\n')
      expect(child.stdin.read()).toBeNull()
      expect(child.stdin.destroyed).toBe(false)
      const [command, args, options] = vi.mocked(spawn).mock.calls[0]
      expect(command).toBe('/bin/sh')
      expect(args).toEqual([
        '-c',
        'IFS= read -r start <&3 && [ "$start" = start ] || exit 125; exec 3<&-; exec "$@"',
        'open-science-verification-start',
        ...(shell ? ['/bin/sh', '-c', 'printf literal'] : ['printf', 'literal'])
      ])
      expect(options).toMatchObject({
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: { VERIFICATION_FIXTURE: 'present', OPEN_SCIENCE_PROCESS_TREE_ID: 'fixture-owner' }
      })
      expect(processTree.trackOwnedPosixProcessTree).toHaveBeenCalledExactlyOnceWith(
        child,
        'fixture-owner'
      )
      child.stdout.write('verified')
      child.stderr.write('diagnostic')
      child.emit('close', 0)
      await expect(output).resolves.toEqual({ stdout: 'verified', stderr: 'diagnostic' })
      expect(child.gate.destroyed).toBe(true)
      expect(child.stdin.destroyed).toBe(true)
    }
  )

  it.each(['identity', 'pipe'])(
    'withholds admission when the %s proof is unavailable',
    async (missing) => {
      if (missing === 'identity')
        vi.mocked(processTree.capturePosixProcessTreeIdentity).mockReturnValue(undefined)
      else child.stdio[3] = undefined
      await expect(runVerificationProcess('target', [])).rejects.toThrow(
        'ownership could not be registered'
      )
      expect(child.gate.read()).toBeNull()
      expect(processTree.terminateProcessTree).toHaveBeenCalledExactlyOnceWith(child, 'SIGKILL')
    }
  )

  it('revokes admission when cancellation arrives during registration', async () => {
    const controller = new AbortController()
    const cancelled = new Error('cancelled during registration')
    vi.mocked(processTree.trackOwnedPosixProcessTree).mockImplementation(() =>
      controller.abort(cancelled)
    )
    await expect(runVerificationProcess('target', [], { signal: controller.signal })).rejects.toBe(
      cancelled
    )
    expect(child.gate.read()).toBeNull()
    expect(child.gate.destroyed).toBe(true)
  })

  it('settles a launch-pipe error without retaining the admission stream', async () => {
    const output = runVerificationProcess('target', [])
    const failure = new Error('launch pipe failed')
    child.gate.emit('error', failure)
    await expect(output).rejects.toBe(failure)
    expect(child.gate.destroyed).toBe(true)
    expect(processTree.terminateProcessTree).toHaveBeenCalledOnce()
  })

  it('preserves outer spawn errno when no process was created', async () => {
    child.pid = undefined
    const output = runVerificationProcess('target', [])
    child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }))
    child.emit('close', -2)
    await expect(output).rejects.toMatchObject({ code: 'ENOENT' })
    expect(processTree.capturePosixProcessTreeIdentity).not.toHaveBeenCalled()
    expect(child.gate.read()).toBeNull()
    expect(child.gate.destroyed).toBe(true)
  })
})
