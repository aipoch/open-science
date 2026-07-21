import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { killAndConfirmExit, md5File, runMicromamba, verifyExecutable } from './provisioner-runtime'
import { condaActivatedPath } from './runtime-paths'

describe('verifyExecutable', () => {
  it('resolves for a real interpreter that answers --version', async () => {
    // node itself answers `--version`; use it as a stand-in executable.
    await expect(verifyExecutable(process.execPath)).resolves.toBeUndefined()
  })

  it('rejects for a missing executable', async () => {
    await expect(verifyExecutable('/no/such/binary-xyz')).rejects.toThrow()
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
        `#!${process.execPath}\nprocess.exit(process.env.PATH === process.env.EXPECTED_PATH ? 0 : 19)\n`
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

  it('rejects with a stderr summary on non-zero exit', async () => {
    await expect(
      runMicromamba(
        [
          process.execPath,
          '-e',
          'process.stdout.write(process.env.MM_STDOUT); process.stderr.write(process.env.MM_STDERR); process.exit(3)'
        ],
        { MM_STDOUT: 'stdout-only-token', MM_STDERR: 'stderr-only-token' }
      )
    ).rejects.toThrow(/exit 3[^]*stdout-only-token[^]*stderr-only-token/)
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
