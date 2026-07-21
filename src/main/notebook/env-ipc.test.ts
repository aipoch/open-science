import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture ipcMain.handle registrations so registerNotebookEnvIpcHandlers can be exercised headless.
const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: never) => registered.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [] }
}))

import type { ProvisionProgress, RuntimeProvisioner } from './provisioner'
import {
  createNotebookEnvHandlers,
  registerNotebookEnvIpcHandlers,
  runStartupGate
} from './env-ipc'

const fakeProvisioner = (over: Partial<RuntimeProvisioner> = {}): RuntimeProvisioner => ({
  status: vi
    .fn()
    .mockReturnValue({ pythonReady: false, rReady: false, version: 0, provisioning: false }),
  provisionPython: vi.fn().mockResolvedValue(undefined),
  provisionR: vi.fn().mockResolvedValue(undefined),
  upgradeIfNeeded: vi.fn().mockResolvedValue(undefined),
  repair: vi.fn().mockResolvedValue(undefined),
  restoreRelocatedEnvs: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn(),
  ...over
})

describe('createNotebookEnvHandlers', () => {
  it('status returns the provisioner status', () => {
    const provisioner = fakeProvisioner()
    const handlers = createNotebookEnvHandlers(provisioner)
    expect(handlers.status()).toEqual({
      pythonReady: false,
      rReady: false,
      version: 0,
      provisioning: false
    })
    expect(provisioner.status).toHaveBeenCalledOnce()
  })

  it('provision dispatches python vs R by language and forwards progress', async () => {
    const provisioner = fakeProvisioner({
      provisionPython: vi.fn().mockImplementation(async (cb: (p: ProvisionProgress) => void) => {
        cb({ phase: 'done', message: 'ok', progress: 1 })
      })
    })
    const emitted: ProvisionProgress[] = []
    const handlers = createNotebookEnvHandlers(provisioner)
    await handlers.provision('python', (p) => emitted.push(p))
    expect(provisioner.provisionPython).toHaveBeenCalledOnce()
    expect(emitted).toEqual([{ phase: 'done', message: 'ok', progress: 1 }])
    await handlers.provision('r', () => {})
    expect(provisioner.provisionR).toHaveBeenCalledOnce()
  })

  it('repair delegates by language', async () => {
    const provisioner = fakeProvisioner()
    const handlers = createNotebookEnvHandlers(provisioner)
    await handlers.repair('r', () => {})
    expect(provisioner.repair).toHaveBeenCalledWith('r', expect.any(Function))
  })

  it('UI provision awaits recovery BEFORE touching a prefix (barrier)', async () => {
    // A UI-triggered provision must wait for crash recovery to finish reconciling, or recovery's prefix
    // cleanup could race the rebuild the user just started.
    const order: string[] = []
    const provisioner = fakeProvisioner({
      provisionPython: vi.fn().mockImplementation(async () => {
        order.push('provision')
      })
    })
    const waitForRecovery = vi.fn().mockImplementation(async () => {
      await Promise.resolve()
      order.push('recovery')
    })
    const handlers = createNotebookEnvHandlers(provisioner, waitForRecovery)
    await handlers.provision('python', () => {})
    expect(waitForRecovery).toHaveBeenCalledOnce()
    expect(order).toEqual(['recovery', 'provision'])
  })

  it('UI repair awaits recovery BEFORE touching a prefix (barrier)', async () => {
    const order: string[] = []
    const provisioner = fakeProvisioner({
      repair: vi.fn().mockImplementation(async () => {
        order.push('repair')
      })
    })
    const waitForRecovery = vi.fn().mockImplementation(async () => {
      await Promise.resolve()
      order.push('recovery')
    })
    const handlers = createNotebookEnvHandlers(provisioner, waitForRecovery)
    await handlers.repair('python', () => {})
    expect(order).toEqual(['recovery', 'repair'])
  })

  it('UI provision/repair refuses when the default env is recovery-blocked', async () => {
    // After recovery leaves the default prefix blocked (an unknown-liveness orphan may still hold it),
    // a UI provision/repair must refuse rather than materialize over it. The guard runs AFTER
    // waitForRecovery so the blocked set is populated.
    const provisioner = fakeProvisioner()
    const assertProvisionAllowed = vi.fn((lang: string) => {
      if (lang === 'python') throw new Error('RUNTIME_RECOVERY_BLOCKED: python is recovering')
    })
    const handlers = createNotebookEnvHandlers(provisioner, async () => {}, assertProvisionAllowed)

    await expect(handlers.provision('python', () => {})).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    await expect(handlers.repair('python', () => {})).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    // The provisioner is never touched when blocked.
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
    expect(provisioner.repair).not.toHaveBeenCalled()
    // A non-blocked language still provisions.
    await handlers.provision('r', () => {})
    expect(provisioner.provisionR).toHaveBeenCalledOnce()
  })

  it('serializes concurrent provisioning calls so a second call does not start a conflicting run', async () => {
    let resolveFirst: (() => void) | undefined
    const started: string[] = []
    const provisioner = fakeProvisioner({
      provisionPython: vi.fn().mockImplementation(async () => {
        started.push('python')
        await new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
      }),
      provisionR: vi.fn().mockImplementation(async () => {
        started.push('r')
      })
    })
    const handlers = createNotebookEnvHandlers(provisioner)

    const first = handlers.provision('python', () => {})
    // Second call fires while the first is still in flight (before resolveFirst is called).
    const second = handlers.provision('r', () => {})

    // The second call must not start provisionR until the first finishes.
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['python'])
    expect(provisioner.provisionR).not.toHaveBeenCalled()

    resolveFirst?.()
    await Promise.all([first, second])

    expect(started).toEqual(['python', 'r'])
    expect(provisioner.provisionPython).toHaveBeenCalledOnce()
    expect(provisioner.provisionR).toHaveBeenCalledOnce()
  })

  it('serializes provision and repair calls against each other', async () => {
    let resolveFirst: (() => void) | undefined
    const started: string[] = []
    const provisioner = fakeProvisioner({
      provisionPython: vi.fn().mockImplementation(async () => {
        started.push('provision-python')
        await new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
      }),
      repair: vi.fn().mockImplementation(async () => {
        started.push('repair')
      })
    })
    const handlers = createNotebookEnvHandlers(provisioner)

    const first = handlers.provision('python', () => {})
    const second = handlers.repair('python', () => {})

    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['provision-python'])
    expect(provisioner.repair).not.toHaveBeenCalled()

    resolveFirst?.()
    await Promise.all([first, second])

    expect(started).toEqual(['provision-python', 'repair'])
  })
})

describe('registerNotebookEnvIpcHandlers (no provisioner)', () => {
  beforeEach(() => registered.clear())
  afterEach(() => registered.clear())

  it('still registers every channel when the provisioner could not be built', () => {
    registerNotebookEnvIpcHandlers(undefined, '/tmp/nope')
    expect([...registered.keys()].sort()).toEqual([
      'notebook-env:cancel',
      'notebook-env:provision',
      'notebook-env:repair',
      'notebook-env:status'
    ])
  })

  it('status reports not-ready and provision/repair reject with an actionable reason', async () => {
    registerNotebookEnvIpcHandlers(undefined, '/tmp/nope')
    const status = registered.get('notebook-env:status')?.({})
    expect(status).toMatchObject({ pythonReady: false, rReady: false, provisioning: false })
    await expect(registered.get('notebook-env:provision')?.({}, 'python')).rejects.toThrow(
      /micromamba/i
    )
    await expect(registered.get('notebook-env:repair')?.({}, 'python')).rejects.toThrow(
      /micromamba/i
    )
  })
})

describe('runStartupGate', () => {
  it('is detect-only on a fresh empty root: restores relocated envs but does not provision python', async () => {
    const provisioner = fakeProvisioner()
    const dir = mkdtempSync(join(tmpdir(), 'os-gate-'))
    await runStartupGate(provisioner, dir, () => {})
    // Fresh envs are built lazily on first notebook use, not eagerly here.
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
    expect(provisioner.upgradeIfNeeded).not.toHaveBeenCalled()
    expect(provisioner.repair).not.toHaveBeenCalled()
    // restoreRelocatedEnvs still runs (needed for data-root relocations).
    expect(provisioner.restoreRelocatedEnvs).toHaveBeenCalledOnce()
  })

  it('does nothing when already ready', async () => {
    const { writeReadyMarker, envPrefix, pythonBin, DEFAULT_ENV_VERSION, DEFAULT_PY_ENV } =
      await import('./runtime-paths')
    const dir = mkdtempSync(join(tmpdir(), 'os-gate2-'))
    const bin = pythonBin(envPrefix(dir, DEFAULT_PY_ENV))
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x')
    writeReadyMarker(dir, DEFAULT_ENV_VERSION, 't')
    const provisioner = fakeProvisioner()
    await runStartupGate(provisioner, dir, () => {})
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
    expect(provisioner.upgradeIfNeeded).not.toHaveBeenCalled()
    expect(provisioner.repair).not.toHaveBeenCalled()
  })

  it('upgrades when an older-version marker with an existing python bin is found', async () => {
    const { writeReadyMarker, envPrefix, pythonBin, DEFAULT_PY_ENV } =
      await import('./runtime-paths')
    const dir = mkdtempSync(join(tmpdir(), 'os-gate3-'))
    const bin = pythonBin(envPrefix(dir, DEFAULT_PY_ENV))
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x')
    writeReadyMarker(dir, 0, 't')
    const provisioner = fakeProvisioner()
    await runStartupGate(provisioner, dir, () => {})
    expect(provisioner.upgradeIfNeeded).toHaveBeenCalledOnce()
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
    expect(provisioner.repair).not.toHaveBeenCalled()
  })

  it('repairs when a marker exists but the python bin is missing', async () => {
    const { writeReadyMarker } = await import('./runtime-paths')
    const dir = mkdtempSync(join(tmpdir(), 'os-gate4-'))
    writeReadyMarker(dir, 0, 't')
    const provisioner = fakeProvisioner()
    await runStartupGate(provisioner, dir, () => {})
    expect(provisioner.repair).toHaveBeenCalledWith('python', expect.any(Function))
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
    expect(provisioner.upgradeIfNeeded).not.toHaveBeenCalled()
  })

  it('never provisions R at startup', async () => {
    const provisioner = fakeProvisioner()
    const dir = mkdtempSync(join(tmpdir(), 'os-gate5-'))
    await runStartupGate(provisioner, dir, () => {})
    expect(provisioner.provisionR).not.toHaveBeenCalled()
  })

  it('does NOT eagerly repair Python for an R-first user (residual default-r, no marker, no python)', async () => {
    // A user who ran R first has a lazily-built default-r dir but no Python and no ready marker
    // (provisionR never writes it). needsRepair keys off the residual default-r, so the action is
    // 'repair' — but there is no Python to repair, so startup must stay detect-only (no eager DL).
    const { rBin, envPrefix, DEFAULT_R_ENV } = await import('./runtime-paths')
    const dir = mkdtempSync(join(tmpdir(), 'os-gate-rfirst-'))
    const rbin = rBin(envPrefix(dir, DEFAULT_R_ENV))
    mkdirSync(join(rbin, '..'), { recursive: true })
    writeFileSync(rbin, 'x')
    const provisioner = fakeProvisioner()
    await runStartupGate(provisioner, dir, () => {})
    expect(provisioner.repair).not.toHaveBeenCalled()
    expect(provisioner.provisionPython).not.toHaveBeenCalled()
  })

  it('reports failure via broadcast instead of throwing', async () => {
    // restoreRelocatedEnvs always runs, so failing it exercises the gate's try/catch on a fresh root.
    const provisioner = fakeProvisioner({
      restoreRelocatedEnvs: vi.fn().mockRejectedValue(new Error('boom'))
    })
    const dir = mkdtempSync(join(tmpdir(), 'os-gate6-'))
    const broadcast = vi.fn()
    await expect(runStartupGate(provisioner, dir, broadcast)).resolves.toBeUndefined()
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'error', message: expect.stringContaining('boom') })
    )
  })

  it('awaits recovery BEFORE touching any prefix (restore/upgrade/repair)', async () => {
    // The barrier must resolve before the gate's first prefix op, or recovery's cleanup could race a
    // rebuild. Use an existing-but-stale marker so the gate would call upgradeIfNeeded, and assert
    // recovery settled first.
    const { writeReadyMarker, envPrefix, pythonBin, DEFAULT_PY_ENV } =
      await import('./runtime-paths')
    const dir = mkdtempSync(join(tmpdir(), 'os-gate-barrier-'))
    const bin = pythonBin(envPrefix(dir, DEFAULT_PY_ENV))
    mkdirSync(join(bin, '..'), { recursive: true })
    writeFileSync(bin, 'x')
    writeReadyMarker(dir, 0, 't')

    const order: string[] = []
    const provisioner = fakeProvisioner({
      restoreRelocatedEnvs: vi.fn().mockImplementation(async () => {
        order.push('restore')
      }),
      upgradeIfNeeded: vi.fn().mockImplementation(async () => {
        order.push('upgrade')
      })
    })
    let recovered = false
    const waitForRecovery = vi.fn().mockImplementation(async () => {
      await Promise.resolve()
      recovered = true
      order.push('recovery')
    })

    await runStartupGate(provisioner, dir, () => {}, waitForRecovery)

    expect(waitForRecovery).toHaveBeenCalledOnce()
    // Recovery ran, and it ran before ANY provisioner prefix op.
    expect(recovered).toBe(true)
    expect(order[0]).toBe('recovery')
    expect(order).toEqual(['recovery', 'restore', 'upgrade'])
  })
})
