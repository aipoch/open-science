import { expect, it, vi } from 'vitest'
const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, request: unknown) => Promise<unknown>>()
)
const state = vi.hoisted(() => ({
  surface: 'electron',
  location: 'local',
  current: true,
  controller: new AbortController()
}))
vi.mock('../ipc-handler-registry', () => ({
  ipcMainHandle: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>
  ) => handlers.set(channel, handler)
}))
vi.mock('../caller-context', () => ({ callerContextForEvent: () => state }))
vi.mock('../caller-lifecycle', () => ({
  callerLeaseForEvent: () => ({ isCurrent: () => state.current, signal: state.controller.signal })
}))
import { registerResearchExecutionProfileIpc } from './ipc'

it('keeps credential writes desktop-local and never propagates secret-bearing parser errors', async () => {
  const preflight = vi.fn(async () => ({}))
  const saveExecutionProfile = vi.fn(async () => {
    throw new Error('raw secret supplied in an invalid request')
  })
  const removeExecutionProfile = vi.fn(async () => undefined)
  registerResearchExecutionProfileIpc({
    preflight,
    saveExecutionProfile,
    removeExecutionProfile
  } as never)
  state.surface = 'web'
  await expect(handlers.get('research-execution-profiles:save')!({}, {})).rejects.toThrow(
    'unauthorized'
  )
  expect(saveExecutionProfile).not.toHaveBeenCalled()
  state.surface = 'electron'
  state.location = 'remote'
  await expect(handlers.get('research-execution-profiles:save')!({}, {})).rejects.toThrow(
    'unauthorized'
  )
  state.location = 'local'
  await expect(handlers.get('research-execution-profiles:save')!({}, {})).rejects.toThrow(
    'research-profile-operation-failed'
  )
  expect(saveExecutionProfile).toHaveBeenCalledTimes(1)
  state.current = false
  await expect(handlers.get('research-execution-profiles:inspect')!({}, {})).rejects.toThrow(
    'unauthorized'
  )
  expect(preflight).not.toHaveBeenCalled()
})
