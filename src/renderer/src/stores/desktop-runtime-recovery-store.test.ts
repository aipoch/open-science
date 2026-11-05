import { beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => vi.resetModules())

it.each([true, false])(
  'keeps the current recovery waiter when an older epoch finishes late (success: %s)',
  async (success) => {
    const { waitForDesktopSessionRecovery, completeDesktopSessionRecovery } =
      await import('./desktop-runtime-recovery-store')
    const current = waitForDesktopSessionRecovery(20)
    const completed = vi.fn()
    void current.then(completed, completed)
    completeDesktopSessionRecovery(19, !success)
    await Promise.resolve()
    expect(completed).not.toHaveBeenCalled()
    completeDesktopSessionRecovery(20, success)
    await Promise.resolve()
    expect(completed).toHaveBeenCalledOnce()
    if (success) await expect(current).resolves.toBeUndefined()
    else await expect(current).rejects.toThrow('Session recovery failed.')
  }
)

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

// Vitest reports unhandled rejections even when an assertion attaches a handler later.
it('handles superseded and failed epochs before consumers attach rejection handlers', async () => {
  const { waitForDesktopSessionRecovery, completeDesktopSessionRecovery } =
    await import('./desktop-runtime-recovery-store')
  const superseded = waitForDesktopSessionRecovery(20)
  const current = waitForDesktopSessionRecovery(21)
  completeDesktopSessionRecovery(21, false)
  await new Promise((resolve) => setTimeout(resolve, 0))
  await expect(superseded).rejects.toThrow('superseded')
  await expect(current).rejects.toThrow('Session recovery failed.')
})
