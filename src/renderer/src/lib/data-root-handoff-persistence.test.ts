import { beforeEach, expect, it, vi } from 'vitest'

const {
  drainWorkspaceRuntimeEventsForPersistence,
  flushSessionPersistence,
  flushPreviewPersistence
} = vi.hoisted(() => ({
  drainWorkspaceRuntimeEventsForPersistence: vi.fn(async () => undefined),
  flushSessionPersistence: vi.fn(async () => undefined),
  flushPreviewPersistence: vi.fn(async () => undefined)
}))

vi.mock('./acp/useWorkspaceAgentRuntime', () => ({ drainWorkspaceRuntimeEventsForPersistence }))
vi.mock('./session-persistence/session-persistence', () => ({ flushSessionPersistence }))
vi.mock('./preview-persistence/preview-persistence', () => ({ flushPreviewPersistence }))

const { flushDataRootHandoffPersistence } = await import('./data-root-handoff-persistence')

beforeEach(() => {
  drainWorkspaceRuntimeEventsForPersistence.mockClear()
  flushSessionPersistence.mockClear()
  flushPreviewPersistence.mockClear()
})

it('drains Web runtime events before flushing Session and Preview state for a data-root handoff', async () => {
  await flushDataRootHandoffPersistence()

  expect(drainWorkspaceRuntimeEventsForPersistence).toHaveBeenCalledOnce()
  expect(flushSessionPersistence).toHaveBeenCalledOnce()
  expect(flushPreviewPersistence).toHaveBeenCalledOnce()
  expect(drainWorkspaceRuntimeEventsForPersistence.mock.invocationCallOrder[0]).toBeLessThan(
    flushSessionPersistence.mock.invocationCallOrder[0]!
  )
  expect(flushSessionPersistence.mock.invocationCallOrder[0]).toBeLessThan(
    flushPreviewPersistence.mock.invocationCallOrder[0]!
  )
})
