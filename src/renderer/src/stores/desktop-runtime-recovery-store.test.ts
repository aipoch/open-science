import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => vi.resetModules())

it('keeps the current recovery waiter when an older epoch finishes late', async () => {
  const { waitForDesktopSessionRecovery, completeDesktopSessionRecovery } =
    await import('./desktop-runtime-recovery-store')
  const current = waitForDesktopSessionRecovery(20)
  const completed = vi.fn()
  void current.then(completed)
  completeDesktopSessionRecovery(19, false)
  completeDesktopSessionRecovery(20, true)
  await Promise.resolve()
  expect(completed).toHaveBeenCalledOnce()
})

it('settles a superseded waiter and never lets an older wait replace the current epoch', async () => {
  const { waitForDesktopSessionRecovery, completeDesktopSessionRecovery } =
    await import('./desktop-runtime-recovery-store')
  const superseded = vi.fn()
  void waitForDesktopSessionRecovery(20).catch(superseded)
  const current = waitForDesktopSessionRecovery(21)
  await Promise.resolve()
  expect(superseded).toHaveBeenCalledOnce()
  await expect(waitForDesktopSessionRecovery(19)).rejects.toThrow('superseded')
  completeDesktopSessionRecovery(21, true)
  await expect(current).resolves.toBeUndefined()
})

it.each([true, false])(
  'retains completion before the epoch waiter arrives (success: %s)',
  async (success) => {
    const { waitForDesktopSessionRecovery, completeDesktopSessionRecovery } =
      await import('./desktop-runtime-recovery-store')
    completeDesktopSessionRecovery(20, success)
    const pending = waitForDesktopSessionRecovery(20)
    if (success) await expect(pending).resolves.toBeUndefined()
    else await expect(pending).rejects.toThrow('Session recovery failed.')
  }
)
