import { describe, expect, it } from 'vitest'

import { EnvironmentLeaseManager } from './environment-lease-manager'

describe('EnvironmentLeaseManager', () => {
  it('serializes exclusive leases for the same environment', async () => {
    const manager = new EnvironmentLeaseManager()
    const first = await manager.acquire('analysis', 'exclusive').granted
    const secondAcquisition = manager.acquire('analysis', 'exclusive')
    let secondGranted = false
    void secondAcquisition.granted.then(() => {
      secondGranted = true
    })

    await Promise.resolve()
    expect(secondGranted).toBe(false)

    expect(first.release()).toBe(true)
    expect(first.release()).toBe(false)
    const second = await secondAcquisition.granted
    expect(secondGranted).toBe(true)

    second.release()
    expect(manager.snapshot().environments).toEqual([])
  })

  it('shares an environment between runs while an exclusive waiter blocks later runs', async () => {
    const manager = new EnvironmentLeaseManager()
    const firstRun = await manager.acquire('analysis', 'shared').granted
    const secondRunAcquisition = manager.acquire('analysis', 'shared')
    let secondRunGranted = false
    void secondRunAcquisition.granted.then(() => {
      secondRunGranted = true
    })

    await Promise.resolve()
    expect(secondRunGranted).toBe(true)
    const secondRun = await secondRunAcquisition.granted

    const installAcquisition = manager.acquire('analysis', 'exclusive')
    const laterRunAcquisition = manager.acquire('analysis', 'shared')
    let installGranted = false
    let laterRunGranted = false
    void installAcquisition.granted.then(() => {
      installGranted = true
    })
    void laterRunAcquisition.granted.then(() => {
      laterRunGranted = true
    })

    firstRun.release()
    secondRun.release()
    const install = await installAcquisition.granted
    expect(installGranted).toBe(true)
    expect(laterRunGranted).toBe(false)

    install.release()
    const laterRun = await laterRunAcquisition.granted
    expect(laterRunGranted).toBe(true)
    laterRun.release()
  })

  it('grants leases for different environments independently', async () => {
    const manager = new EnvironmentLeaseManager()
    const first = await manager.acquire('analysis-a', 'exclusive').granted

    const second = await manager.acquire('analysis-b', 'exclusive').granted
    expect(manager.snapshot().environments).toEqual([
      {
        environment: 'analysis-a',
        holders: { shared: 0, exclusive: 1 },
        waiters: { shared: 0, exclusive: 0 }
      },
      {
        environment: 'analysis-b',
        holders: { shared: 0, exclusive: 1 },
        waiters: { shared: 0, exclusive: 0 }
      }
    ])

    first.release()
    second.release()
  })

  it('cancels only a pending acquisition and unblocks compatible waiters', async () => {
    const manager = new EnvironmentLeaseManager()
    const firstRun = await manager.acquire('analysis', 'shared').granted
    const installAcquisition = manager.acquire('analysis', 'exclusive')
    const cancelledInstall = expect(installAcquisition.granted).rejects.toThrow(/cancelled/)
    const laterRunAcquisition = manager.acquire('analysis', 'shared')
    let laterRunGranted = false
    void laterRunAcquisition.granted.then(() => {
      laterRunGranted = true
    })

    expect(installAcquisition.cancel()).toBe(true)
    expect(installAcquisition.cancel()).toBe(false)
    await cancelledInstall
    await Promise.resolve()
    expect(laterRunGranted).toBe(true)

    const laterRun = await laterRunAcquisition.granted
    expect(laterRunAcquisition.cancel()).toBe(false)
    firstRun.release()
    laterRun.release()
    expect(manager.snapshot().environments).toEqual([])
  })

  it('disposes every holder and waiter without leaving reusable lease state', async () => {
    const manager = new EnvironmentLeaseManager()
    const holder = await manager.acquire('analysis', 'exclusive').granted
    const pending = manager.acquire('analysis', 'shared')
    const pendingResult = expect(pending.granted).rejects.toThrow(/disposed/)

    manager.dispose()

    await pendingResult
    expect(holder.release()).toBe(false)
    expect(pending.cancel()).toBe(false)
    expect(manager.snapshot()).toEqual({ disposed: true, environments: [] })

    const afterDispose = manager.acquire('analysis', 'exclusive')
    await expect(afterDispose.granted).rejects.toThrow(/disposed/)
    expect(afterDispose.cancel()).toBe(false)
    manager.dispose()
  })
})
