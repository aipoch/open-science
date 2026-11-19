import { describe, expect, it, vi } from 'vitest'
import type { WindowsResourceSample } from '@aipoch/process-tree-native'
import { MemoryPolicyService } from './memory-policy'
import { DarwinMemoryPolicyAdapter, WindowsMemoryPolicyAdapter } from './memory-policy-platform'

const windowsSample = (system: WindowsResourceSample['system']): WindowsResourceSample => ({
  supported: true,
  complete: true,
  startedAt: 1000,
  endedAt: 1001,
  system,
  processes: []
})

describe('WindowsMemoryPolicyAdapter', () => {
  it('uses the same native physical and commit snapshot, including boundary hysteresis', async () => {
    let current = windowsSample({
      totalPhysicalBytes: 1000,
      availableBytes: 100,
      commitLimitBytes: 1000,
      committedBytes: 300
    })
    const sampleWindowsResources = vi.fn(async () => current)
    const service = new MemoryPolicyService({
      adapter: new WindowsMemoryPolicyAdapter({ sampleWindowsResources }),
      now: () => 1000
    })
    await expect(service.getState()).resolves.toMatchObject({
      status: 'pressured',
      reason: { code: 'windows-physical-low' }
    })
    expect(sampleWindowsResources).toHaveBeenCalledWith(false, [])
    current = windowsSample({
      totalPhysicalBytes: 1000,
      availableBytes: 201,
      commitLimitBytes: 1000,
      committedBytes: 800
    })
    await expect(service.getState({ force: true })).resolves.toMatchObject({
      status: 'pressured',
      reason: { code: 'windows-commit-low' }
    })
    current = windowsSample({
      totalPhysicalBytes: 1000,
      availableBytes: 201,
      commitLimitBytes: 1000,
      committedBytes: 799
    })
    await expect(service.getState({ force: true })).resolves.toMatchObject({ status: 'healthy' })
  })

  it('distinguishes an old native component and refuses an unknown execution domain', async () => {
    const adapter = new WindowsMemoryPolicyAdapter({
      sampleWindowsResources: async () =>
        windowsSample({ availableBytes: 100, commitLimitBytes: 1000, committedBytes: 100 })
    })
    await expect(adapter.sample(new AbortController().signal)).rejects.toMatchObject({
      code: 'memory-component-unavailable'
    })
    for (const executionScope of ['wsl:', 'linux:pid:1', 'unknown:scope']) {
      await expect(
        new WindowsMemoryPolicyAdapter().sample(new AbortController().signal, executionScope)
      ).rejects.toMatchObject({ code: 'execution-domain-unavailable' })
    }
  })

  it('never authorizes a WSL domain with Windows host facts alone', async () => {
    const native = {
      sampleWindowsResources: vi.fn(async () =>
        windowsSample({
          totalPhysicalBytes: 1000,
          availableBytes: 800,
          commitLimitBytes: 1000,
          committedBytes: 200
        })
      )
    }
    const service = new MemoryPolicyService({
      adapter: new WindowsMemoryPolicyAdapter(native),
      now: () => 1000
    })

    await expect(service.getState({ executionScope: 'wsl:profile-1' })).resolves.toMatchObject({
      status: 'unavailable',
      reason: { code: 'execution-domain-unavailable' }
    })
    expect(native.sampleWindowsResources).not.toHaveBeenCalled()
  })
})

describe('DarwinMemoryPolicyAdapter', () => {
  it('requires a current pressure query even when the event source has emitted nothing', async () => {
    const service = new MemoryPolicyService({
      adapter: new DarwinMemoryPolicyAdapter({
        sampleDarwinMemoryPressure: async () => ({
          supported: true,
          complete: false,
          error: 1,
          eventSequence: 0,
          pressureEventSequence: 0
        }),
        subscribeDarwinMemoryPressure: () => ({}),
        stopDarwinMemoryPressureSubscription: () => undefined,
        darwinMemoryPressureEventSequence: () => 0
      })
    })
    await expect(service.getState()).resolves.toMatchObject({
      status: 'unavailable',
      reason: { code: 'mac-memory-unavailable' }
    })
  })

  it('keeps pressure latched until a complete NORMAL observation window and invalidates on events', async () => {
    let now = 1000
    let pressureLevel: 1 | 2 | 4 = 1
    let sequence = 0
    let callback: ((event: { pressureLevel: number; eventSequence: number }) => void) | undefined
    const adapter = new DarwinMemoryPolicyAdapter({
      sampleDarwinMemoryPressure: async () => ({
        supported: true,
        complete: true,
        pressureLevel,
        eventSequence: sequence,
        pressureEventSequence: sequence
      }),
      subscribeDarwinMemoryPressure: (listener) => {
        callback = listener
        return {}
      },
      stopDarwinMemoryPressureSubscription: () => undefined,
      darwinMemoryPressureEventSequence: () => sequence
    })
    const service = new MemoryPolicyService({ adapter, now: () => now })
    await expect(service.getState()).resolves.toMatchObject({ status: 'healthy' })
    pressureLevel = 2
    sequence++
    callback?.({ pressureLevel, eventSequence: sequence })
    expect(service.currentState().status).toBe('unavailable')
    await expect(service.getState()).resolves.toMatchObject({ status: 'pressured' })
    pressureLevel = 1
    for (now = 6000; now <= 21_000; now += 5000) {
      await expect(service.getState({ force: true })).resolves.toMatchObject({
        status: 'pressured',
        reason: { code: 'mac-memory-recovering' }
      })
    }
    now = 26_000
    await expect(service.getState({ force: true })).resolves.toMatchObject({ status: 'healthy' })
  })

  it('cannot accept a NORMAL snapshot that raced with a newer native event', async () => {
    const service = new MemoryPolicyService({
      adapter: new DarwinMemoryPolicyAdapter({
        sampleDarwinMemoryPressure: async () => ({
          supported: true,
          complete: true,
          pressureLevel: 1,
          eventSequence: 0,
          pressureEventSequence: 0
        }),
        subscribeDarwinMemoryPressure: () => ({}),
        stopDarwinMemoryPressureSubscription: () => undefined,
        darwinMemoryPressureEventSequence: () => 1
      })
    })
    await expect(service.getState()).resolves.toMatchObject({
      status: 'unavailable',
      reason: { code: 'mac-memory-event-race' }
    })
  })

  it('retains a coalesced pressure event even if the next current level is already NORMAL', async () => {
    const service = new MemoryPolicyService({
      adapter: new DarwinMemoryPolicyAdapter({
        sampleDarwinMemoryPressure: async () => ({
          supported: true,
          complete: true,
          pressureLevel: 1,
          eventSequence: 2,
          pressureEventSequence: 1
        }),
        subscribeDarwinMemoryPressure: () => ({}),
        stopDarwinMemoryPressureSubscription: () => undefined,
        darwinMemoryPressureEventSequence: () => 2
      }),
      now: () => 1000
    })
    await expect(service.getState()).resolves.toMatchObject({
      status: 'pressured',
      reason: { code: 'mac-memory-recovering', recoveryRemainingMs: 20_000 }
    })
  })
})
