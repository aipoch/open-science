import { expect, it, vi } from 'vitest'
import { WebSessionSlots } from './limits'

it('shares three slots across operations while isolating sessions and cancelling queued calls', async () => {
  const slots = new WebSessionSlots()
  const signal = new AbortController().signal
  const releases = await Promise.all([0, 1, 2].map(() => slots.acquire('research', signal)))
  const queued = new AbortController()
  const admitted = vi.fn()
  const waiting = slots.acquire('research', queued.signal).then(admitted)
  const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  const releaseOther = await slots.acquire('another-research', signal)
  expect(admitted).not.toHaveBeenCalled()
  queued.abort()
  await rejected
  releaseOther()
  releases.forEach((release) => {
    release()
    release()
  })
  const next = await Promise.all([0, 1, 2].map(() => slots.acquire('research', signal)))
  let fourth = false
  const final = slots.acquire('research', signal).then((release) => {
    fourth = true
    return release
  })
  await Promise.resolve()
  expect(fourth).toBe(false)
  next[0]()
  const releaseFinal = await final
  expect(fourth).toBe(true)
  next.forEach((release) => release())
  releaseFinal()
})
