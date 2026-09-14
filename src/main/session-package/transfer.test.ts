import { afterEach, expect, it, vi } from 'vitest'
import { paceFileIo } from '../file-io-pacing'
import { withPackageTransfer } from './transfer'

afterEach(() => vi.useRealTimers())

it('shares a rate budget across streams without slowing unrelated work', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let finished = false
  const transfer = withPackageTransfer(
    async () => {
      await Promise.all([paceFileIo(1024), paceFileIo(1024)])
      finished = true
    },
    () => 1024
  )
  expect(paceFileIo(1024)).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1999)
  expect(finished).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await transfer
  expect(finished).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('allows steady progress beyond ten minutes but cancels a stalled stage', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  await withPackageTransfer(
    async (transfer) => {
      for (let step = 0; step < 12; step++) {
        await vi.advanceTimersByTimeAsync(60_000)
        const progress = paceFileIo(1024)
        await vi.advanceTimersByTimeAsync(1000)
        await progress
        expect(transfer.signal.aborted).toBe(false)
      }
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(transfer.signal.aborted).toBe(true)
    },
    () => 1024
  )
})

it('pauses the idle deadline during human confirmation and restarts it afterwards', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  await withPackageTransfer(async (transfer) => {
    await transfer.waitForUser(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(transfer.signal.aborted).toBe(false)
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(transfer.signal.aborted).toBe(true)
  })
})

it('interrupts a pacing wait on cancellation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const controller = new AbortController()
  const transfer = withPackageTransfer(
    async () => {
      const pending = paceFileIo(1024, controller.signal)!
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    },
    () => 1024
  )
  await transfer
  expect(vi.getTimerCount()).toBe(0)
})
