import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  killAndConfirmExit,
  md5File,
  micromambaDiagnosticText,
  runMicromamba,
  verifyExecutable
} from './provisioner-runtime'
import { condaActivatedPath } from './runtime-paths'

describe('verifyExecutable', () => {
  it('resolves for a real interpreter that answers --version', async () => {
    // node itself answers `--version`; use it as a stand-in executable.
    await expect(verifyExecutable(process.execPath)).resolves.toBeUndefined()
  })

  it('rejects for a missing executable', async () => {
    await expect(verifyExecutable('/no/such/binary-xyz')).rejects.toThrow()
  })

  it('rejects an executable R whose home and libraries still resolve to a previous prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'os-relocated-r-'))
    const prefix = join(dir, 'runtime', 'envs', 'default-r')
    const bin = join(prefix, 'bin', 'R')
    const oldPrefix = join(dir, 'old-runtime', 'envs', 'default-r')
    mkdirSync(join(prefix, 'bin'), { recursive: true })
    writeFileSync(
      bin,
      `#!${process.execPath}\n` +
        `process.stdout.write([` +
        `'OPEN_SCIENCE_R_HOME=${join(oldPrefix, 'lib', 'R')}',` +
        `'OPEN_SCIENCE_R_BASE_LIBRARY=${join(oldPrefix, 'lib', 'R', 'library')}',` +
        `'OPEN_SCIENCE_R_LIBRARY=${join(oldPrefix, 'lib', 'R', 'library')}'` +
        `].join('\\n') + '\\n')\n`
    )
    chmodSync(bin, 0o755)

    await expect(verifyExecutable(bin, { prefix })).rejects.toThrow(/outside.*prefix|relocat/i)
  })

  it.skipIf(process.platform === 'win32')(
    'passes the activated Windows conda PATH to the interpreter process',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'os-r-path-'))
      const bin = join(dir, 'R.exe')
      const prefix = 'C:\\runtime\\envs\\default-r'
      const expectedPath = condaActivatedPath(prefix, 'C:\\Windows', 'win32')
      writeFileSync(
        bin,
        `#!${process.execPath}\n` +
          `if (process.env.PATH !== process.env.EXPECTED_PATH) process.exit(19)\n` +
          `process.stdout.write([` +
          `'OPEN_SCIENCE_R_HOME=C:\\\\runtime\\\\envs\\\\default-r\\\\lib\\\\R',` +
          `'OPEN_SCIENCE_R_BASE_LIBRARY=C:\\\\runtime\\\\envs\\\\default-r\\\\lib\\\\R\\\\library',` +
          `'OPEN_SCIENCE_R_LIBRARY=C:\\\\runtime\\\\envs\\\\default-r\\\\lib\\\\R\\\\library'` +
          `].join('\\n') + '\\n')\n`
      )
      chmodSync(bin, 0o755)

      await expect(
        verifyExecutable(bin, {
          prefix,
          platform: 'win32',
          env: { PATH: 'C:\\Windows', EXPECTED_PATH: expectedPath }
        })
      ).resolves.toBeUndefined()
    }
  )
})

describe('md5File', () => {
  it('computes the md5 hex of file contents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'os-md5-'))
    const file = join(dir, 'f')
    writeFileSync(file, 'abc')
    // md5("abc") = 900150983cd24fb0d6963f7d28e17f72
    await expect(md5File(file)).resolves.toBe('900150983cd24fb0d6963f7d28e17f72')
  })
})

describe('runMicromamba', () => {
  it('resolves on a zero-exit argv', async () => {
    // node (process.execPath) is a cross-platform zero-exit stand-in for the micromamba binary.
    await expect(
      runMicromamba([process.execPath, '-e', 'process.exit(0)'])
    ).resolves.toBeUndefined()
  })

  it('rejects with a short stderr excerpt on non-zero exit, keeping full tails in data', async () => {
    // The user-facing message prefers the stderr reason (not the package-plan stdout) so the
    // provisioning banner never floods; both full tails stay on the error's structured `data`.
    await expect(
      runMicromamba(
        [
          process.execPath,
          '-e',
          'process.stdout.write(process.env.MM_STDOUT); process.stderr.write(process.env.MM_STDERR); process.exit(3)'
        ],
        { MM_STDOUT: 'stdout-only-token', MM_STDERR: 'stderr-only-token' }
      )
    ).rejects.toMatchObject({
      code: 'MICROMAMBA_EXIT',
      message: expect.stringMatching(/exit 3[^]*stderr-only-token/),
      data: {
        exitCode: 3,
        stderrTail: 'stderr-only-token',
        stdoutTail: 'stdout-only-token'
      }
    })
  })

  it('omits the stdout package plan from the exit message when stderr carries the reason', async () => {
    await expect(
      runMicromamba(
        [
          process.execPath,
          '-e',
          'process.stdout.write(process.env.MM_STDOUT); process.stderr.write(process.env.MM_STDERR); process.exit(1)'
        ],
        { MM_STDOUT: 'plan-noise-token', MM_STDERR: 'the-real-reason' }
      )
    ).rejects.toThrow(/^(?:(?!plan-noise-token)[^])*the-real-reason(?:(?!plan-noise-token)[^])*$/)
  })

  it('caps the exit message excerpt while retaining the full stderr tail in data', async () => {
    // 2 KB of stderr must not reach the message verbatim (the banner-flood bug); the excerpt is
    // bounded and prefixed with an ellipsis, but the full tail is preserved on `data`.
    await expect(
      runMicromamba([
        process.execPath,
        '-e',
        "process.stderr.write('X'.repeat(2048)); process.exit(2)"
      ])
    ).rejects.toMatchObject({
      code: 'MICROMAMBA_EXIT',
      // The ellipsis-prefixed excerpt ends in EXACTLY 500 X's — proof the 2048-char tail was capped.
      message: expect.stringMatching(/…X{500}$/),
      data: { stderrTail: 'X'.repeat(2048) }
    })
  })

  it('distinguishes timeout from an ordinary non-zero exit and keeps output tails', async () => {
    await expect(
      runMicromamba(
        [
          process.execPath,
          '-e',
          'process.stderr.write(process.env.MM_TIMEOUT_TOKEN); setInterval(() => {}, 1000)'
        ],
        { MM_TIMEOUT_TOKEN: 'timeout-stderr-token' },
        undefined,
        undefined,
        undefined,
        200
      )
    ).rejects.toThrow(/timed out[^]*timeout-stderr-token/i)
  })

  it('attaches structured offline-create diagnostics to a timeout', async () => {
    const argv = [
      process.execPath,
      '-e',
      'process.stdout.write(process.env.MM_TIMEOUT_TOKEN); setInterval(() => {}, 1000)',
      '--',
      '--offline'
    ]

    await expect(
      runMicromamba(
        argv,
        {
          MM_TIMEOUT_TOKEN: 'timeout-stdout-token',
          CONDA_PKGS_DIRS: 'C:\\Users\\test\\os12345678'
        },
        undefined,
        undefined,
        undefined,
        200
      )
    ).rejects.toMatchObject({
      code: 'MICROMAMBA_TIMEOUT',
      data: {
        argv,
        cachePath: 'C:\\Users\\test\\os12345678',
        durationMs: expect.any(Number),
        offline: true,
        pid: expect.any(Number),
        stderrTail: '',
        stdoutTail: 'timeout-stdout-token',
        timeoutMs: 200
      }
    })
  })

  it('distinguishes user cancellation from timeout and non-zero exit', async () => {
    const abort = new AbortController()
    const running = runMicromamba(
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      undefined,
      abort.signal
    )
    abort.abort()

    await expect(running).rejects.toThrow(/^Runtime setup cancelled\.$/)
  })

  it('kills the child and rejects (fail-closed) when onChild throws (PID recording failed)', async () => {
    // If recording the child fails, running on would strand an unrecorded orphan. runMicromamba must
    // kill the just-spawned child and reject rather than proceed. A long-lived child proves the kill.
    let killedPid: number | undefined
    await expect(
      runMicromamba(
        [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
        undefined,
        undefined,
        (pid) => {
          killedPid = pid
          throw new Error('sidecar write failed')
        }
      )
    ).rejects.toThrow(/Failed to record the runtime worker/)
    expect(killedPid).toBeGreaterThan(0)
    // The child was signalled to die; poll briefly until it's reaped rather than racing the kill.
    await vi.waitFor(() => expect(() => process.kill(killedPid as number, 0)).toThrow())
  })

  it('calls onBeforeSpawn immediately before spawning (per-spawn intent re-arm)', async () => {
    const order: string[] = []
    await runMicromamba(
      [process.execPath, '-e', 'process.exit(0)'],
      undefined,
      undefined,
      () => order.push('child'),
      () => order.push('before')
    )
    expect(order).toEqual(['before', 'child']) // intent recorded before the PID
  })

  it('fails closed (does NOT spawn) when onBeforeSpawn throws', async () => {
    let childSpawned = false
    await expect(
      runMicromamba(
        [process.execPath, '-e', 'process.exit(0)'],
        undefined,
        undefined,
        () => {
          childSpawned = true
        },
        () => {
          throw new Error('intent write failed')
        }
      )
    ).rejects.toThrow(/spawn intent/)
    expect(childSpawned).toBe(false) // onChild never fired -> nothing was spawned
  })
})

describe('killAndConfirmExit', () => {
  it('resolves true once the child actually exits', async () => {
    const listeners: Record<string, () => void> = {}
    const fake = {
      exitCode: null,
      signalCode: null,
      kill: () => true,
      once: (event: string, cb: () => void) => {
        listeners[event] = cb
      }
    } as never
    const pending = killAndConfirmExit(fake, 1000)
    listeners.exit?.() // the child exits
    expect(await pending).toBe(true)
  })

  it('resolves false when exit cannot be confirmed within the deadline (SIGTERM ignored)', async () => {
    // A child that never emits exit (kill ignored) — the deadline elapses and we report UNconfirmed so
    // the caller retains the recovery evidence rather than clearing it under a possibly-live worker.
    const fake = {
      exitCode: null,
      signalCode: null,
      kill: () => false,
      once: () => undefined // never fires exit
    } as never
    expect(await killAndConfirmExit(fake, 40)).toBe(false)
  })
})

describe('micromambaDiagnosticText', () => {
  it('reconstructs the FULL diagnostics from data tails so recovery parsing survives the short message', () => {
    // The UI message is a capped excerpt; a cache-corruption / MAX_PATH signature or over-budget path
    // can sit only in the full stdout/stderr tails. The reconstructed text must expose both.
    const error = Object.assign(new Error('micromamba failed (exit 1; mm create): …tail-excerpt'), {
      code: 'MICROMAMBA_EXIT',
      data: {
        argv: ['mm', 'create'],
        exitCode: 1,
        stderrTail: "Invalid package cache, 'C:/very/long/path/pkg.conda' is missing",
        stdoutTail: 'plan-line-1\nplan-line-2'
      }
    })
    const text = micromambaDiagnosticText(error)
    expect(text).toContain('micromamba failed (exit 1')
    expect(text).toContain('Invalid package cache')
    expect(text).toContain("'C:/very/long/path/pkg.conda' is missing")
    expect(text).toContain('plan-line-1')
  })

  it('falls back to the plain message for an error without structured data (e.g. spawn failure)', () => {
    expect(micromambaDiagnosticText(new Error('micromamba failed to start (mm): ENOENT'))).toBe(
      'micromamba failed to start (mm): ENOENT'
    )
    expect(micromambaDiagnosticText('not-an-error')).toBe('not-an-error')
  })
})
