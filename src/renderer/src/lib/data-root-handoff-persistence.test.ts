import { beforeEach, expect, it, vi } from 'vitest'

const { flushSessionPersistence, flushPreviewPersistence } = vi.hoisted(() => ({
  flushSessionPersistence: vi.fn(async () => undefined),
  flushPreviewPersistence: vi.fn(async () => undefined)
}))

vi.mock('./session-persistence/session-persistence', () => ({ flushSessionPersistence }))
vi.mock('./preview-persistence/preview-persistence', () => ({ flushPreviewPersistence }))

const { flushDataRootHandoffPersistence } = await import('./data-root-handoff-persistence')

beforeEach(() => {
  flushSessionPersistence.mockClear()
  flushPreviewPersistence.mockClear()
})

it('flushes Web Session state before Preview state for a data-root handoff', async () => {
  await flushDataRootHandoffPersistence()

  expect(flushSessionPersistence).toHaveBeenCalledOnce()
  expect(flushPreviewPersistence).toHaveBeenCalledOnce()
  expect(flushSessionPersistence.mock.invocationCallOrder[0]).toBeLessThan(
    flushPreviewPersistence.mock.invocationCallOrder[0]!
  )
})
