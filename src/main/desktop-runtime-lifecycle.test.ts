import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopRuntimeLifecycle,
  type DesktopShutdownWork
} from './desktop-runtime-lifecycle'
import { trackLifecycleSettlement, waitForLifecycleSettlement } from './lifecycle-settlement'
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const release = vi.fn()
  const deps = {
    detectActiveSessions: vi.fn(() => []),
    hasActiveReviewerWork: vi.fn(() => false),
    getActiveSettingsInstallId: vi.fn((): string | undefined => undefined),
    isMigrationInProgress: vi.fn(() => false),
    hasActivePackageTransfer: vi.fn(() => false),
    holdSettingsInstallAdmission: vi.fn(() => release),
    prepareForQuit: vi.fn(async () => 'completed' as const),
    abortQuitPreparation: vi.fn()
  }
  return { deps, release, owner: createDesktopRuntimeLifecycle(deps) }
}
describe('Node desktop quit coordination', () => {
  it('revalidates the observed work before stopping any producer', async () => {
    const { owner, deps, release } = fixture()
    const observed = (await owner.request({ operation: 'inspect' })) as DesktopShutdownWork
    deps.getActiveSettingsInstallId.mockReturnValue('new-install')
    await expect(
      owner.request({ operation: 'prepare', fingerprint: observed.fingerprint })
    ).rejects.toThrow('changed after quit confirmation')
    expect(deps.prepareForQuit).not.toHaveBeenCalled()
    expect(deps.holdSettingsInstallAdmission).not.toHaveBeenCalled()
    const current = (await owner.request({ operation: 'inspect' })) as DesktopShutdownWork
    await owner.request({ operation: 'hold' })
    await expect(
      owner.request({ operation: 'prepare', fingerprint: current.fingerprint })
    ).resolves.toBe('completed')
    expect(deps.holdSettingsInstallAdmission).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    await owner.request({ operation: 'abort' })
    expect(deps.abortQuitPreparation).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })
  it.each(['isMigrationInProgress', 'hasActivePackageTransfer'] as const)(
    'preserves the %s guard in Node',
    async (kind) => {
      const { owner, deps } = fixture()
      deps[kind].mockReturnValue(true)
      const observed = (await owner.request({ operation: 'inspect' })) as DesktopShutdownWork
      await expect(
        owner.request({ operation: 'prepare', fingerprint: observed.fingerprint })
      ).rejects.toThrow('finish before quitting')
      expect(deps.prepareForQuit).not.toHaveBeenCalled()
    }
  )
  it('reopens only its own admission on disconnect and never requests server shutdown', async () => {
    const { owner, deps, release } = fixture()
    const observed = (await owner.request({ operation: 'inspect' })) as DesktopShutdownWork
    let finish!: (value: 'completed') => void
    deps.prepareForQuit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = owner.request({ operation: 'prepare', fingerprint: observed.fingerprint })
    const disconnected = owner.disconnect()
    finish('completed')
    await expect(pending).rejects.toThrow('disconnected')
    await disconnected
    expect(release).toHaveBeenCalledOnce()
    expect(deps.abortQuitPreparation).toHaveBeenCalled()
    await expect(owner.request({ operation: 'inspect' })).rejects.toThrow('closed')
  })

  it('rolls back preparation that throws after closing admission', async () => {
    const { owner, deps, release } = fixture()
    const observed = (await owner.request({ operation: 'inspect' })) as DesktopShutdownWork
    deps.prepareForQuit.mockRejectedValueOnce(
      new Error('preparation failed after admission closed')
    )
    await owner.request({ operation: 'hold' })
    await expect(
      owner.request({ operation: 'prepare', fingerprint: observed.fingerprint })
    ).rejects.toThrow('preparation failed')
    await owner.request({ operation: 'abort' })
    await owner.request({ operation: 'abort' })
    await owner.request({ operation: 'release' })
    expect(deps.abortQuitPreparation).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it.each(['abort', 'release'] as const)(
    'accepts %s without reopening installation admission before late cleanup settles',
    async (operation) => {
      const { owner, deps, release } = fixture()
      const cleanup = Promise.withResolvers<void>()
      const releaseNewHold = vi.fn()
      deps.holdSettingsInstallAdmission.mockReturnValueOnce(release).mockReturnValue(releaseNewHold)
      await owner.request({ operation: 'hold' })
      trackLifecycleSettlement(cleanup.promise)
      try {
        await owner.request({ operation })
        await owner.request({ operation: 'release' })
        expect(release).not.toHaveBeenCalled()
        // A delayed release belongs only to its captured hold, never to a subsequent hold.
        await owner.request({ operation: 'hold' })
      } finally {
        cleanup.resolve()
        await waitForLifecycleSettlement()
      }
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
      expect(releaseNewHold).not.toHaveBeenCalled()
      await owner.request({ operation: 'release' })
      expect(releaseNewHold).toHaveBeenCalledOnce()
    }
  )
})
