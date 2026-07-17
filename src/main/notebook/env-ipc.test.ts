import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { ProvisionProgress, RuntimeProvisioner } from './provisioner'
import { createNotebookEnvHandlers, runStartupGate } from './env-ipc'

const fakeProvisioner = (over: Partial<RuntimeProvisioner> = {}): RuntimeProvisioner => ({
  status: vi
    .fn()
    .mockReturnValue({ pythonReady: false, rReady: false, version: 0, provisioning: false }),
  provisionPython: vi.fn().mockResolvedValue(undefined),
  provisionR: vi.fn().mockResolvedValue(undefined),
  upgradeIfNeeded: vi.fn().mockResolvedValue(undefined),
  repair: vi.fn().mockResolvedValue(undefined),
  restoreRelocatedEnvs: vi.fn().mockResolvedValue(undefined),
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

describe('runStartupGate', () => {
  it('provisions python fresh on an empty root', async () => {
    const provisioner = fakeProvisioner()
    const dir = mkdtempSync(join(tmpdir(), 'os-gate-'))
    await runStartupGate(provisioner, dir, () => {})
    expect(provisioner.provisionPython).toHaveBeenCalledOnce()
    expect(provisioner.upgradeIfNeeded).not.toHaveBeenCalled()
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

  it('reports failure via broadcast instead of throwing', async () => {
    const provisioner = fakeProvisioner({
      provisionPython: vi.fn().mockRejectedValue(new Error('boom'))
    })
    const dir = mkdtempSync(join(tmpdir(), 'os-gate6-'))
    const broadcast = vi.fn()
    await expect(runStartupGate(provisioner, dir, broadcast)).resolves.toBeUndefined()
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'error', message: expect.stringContaining('boom') })
    )
  })
})
