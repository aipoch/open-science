import { afterEach, expect, it, vi } from 'vitest'
import { ResourceActivity } from './activity'

afterEach(() => vi.useRealTimers())

it('uses foreground OR balanced work, with suspension overriding both and no polling', async () => {
  vi.useFakeTimers()
  const activity = new ResourceActivity()
  const changed = vi.fn()
  const unsubscribe = activity.subscribe(changed)
  expect(activity.state.sampling).toBe(false)
  const endFirst = activity.begin()
  const endSecond = activity.begin()
  endFirst()
  endFirst()
  expect(changed).toHaveBeenCalledTimes(1)
  activity.setDesktop({ foreground: true, suspended: false })
  endSecond()
  expect(activity.state.sampling).toBe(true)
  activity.setDesktop({ foreground: true, suspended: true })
  expect(activity.state).toEqual({ sampling: false, suspended: true })
  activity.setDesktop({ foreground: false, suspended: false })
  expect(activity.state.sampling).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
  expect(changed).toHaveBeenCalledTimes(3)
  unsubscribe()
  activity.begin()()
  expect(changed).toHaveBeenCalledTimes(3)
})

it('releases failed and overlapping tasks without letting observer failure affect work', async () => {
  const activity = new ResourceActivity()
  activity.subscribe(() => {
    throw new Error('observer')
  })
  const pending = Promise.withResolvers<void>()
  const first = activity.run(() => pending.promise)
  await expect(
    activity.run(async () => {
      throw new Error('task')
    })
  ).rejects.toThrow('task')
  expect(activity.state.sampling).toBe(true)
  pending.resolve()
  await first
  expect(activity.state.sampling).toBe(false)
})
