import { describe, expect, it, vi } from 'vitest'
import type { RuntimeProvisioner } from './provisioner'
import { serializeProvisioner } from './environment-operation-foundation'

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

describe('serializeProvisioner', () => {
  it('serializes mutations while keeping queued language cancellation immediate', async () => {
    const started: string[] = []
    let releasePython: (() => void) | undefined
    const base = fakeProvisioner({
      provisionPython: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            started.push('python')
            releasePython = resolve
          })
      ),
      provisionR: vi.fn().mockImplementation(async () => {
        started.push('r')
      })
    })
    const provisioner = serializeProvisioner(base)

    const python = provisioner.provisionPython(vi.fn())
    const r = provisioner.provisionR(vi.fn())
    await Promise.resolve()
    await Promise.resolve()

    expect(started).toEqual(['python'])
    provisioner.cancel('r')
    expect(base.cancel).toHaveBeenCalledWith('r')

    releasePython?.()
    await Promise.all([python, r])
    expect(started).toEqual(['python', 'r'])
  })

  it('recovers the queue and pending count when a provisioner throws synchronously', async () => {
    const failure = new Error('synchronous provision failure')
    let attempts = 0
    const base = fakeProvisioner({
      provisionR: vi.fn().mockImplementation(() => {
        attempts += 1
        if (attempts === 1) throw failure
        return Promise.resolve()
      })
    })
    const provisioner = serializeProvisioner(base)

    const failed = provisioner.provisionR(vi.fn())
    const recovered = provisioner.provisionR(vi.fn())

    await expect(failed).rejects.toBe(failure)
    await expect(recovered).resolves.toBeUndefined()
    expect(attempts).toBe(2)

    provisioner.cancel('r')
    expect(base.cancel).not.toHaveBeenCalled()
  })
})
