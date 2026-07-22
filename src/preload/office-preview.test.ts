import { describe, expect, it, vi } from 'vitest'

import {
  OFFICE_PREVIEW_RUNTIME_START_CHANNEL,
  OFFICE_PREVIEW_RUNTIME_STATE_CHANNEL
} from '../shared/office-preview'

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: {
    on: mocks.on,
    removeListener: mocks.removeListener,
    send: mocks.send
  }
}))

await import('./office-preview')

describe('Office preview preload bridge', () => {
  it('keeps its self-contained channels aligned with the shared protocol', () => {
    const bridge = mocks.exposeInMainWorld.mock.calls[0]?.[1] as {
      onStart: (listener: (value: unknown) => void) => () => void
      reportState: (state: unknown) => void
    }
    const listener = vi.fn()
    const removeListener = bridge.onStart(listener)
    const wrapped = mocks.on.mock.calls[0]?.[1]
    const state = { sessionId: 'session-1', phase: 'ready' }

    expect(mocks.on).toHaveBeenCalledWith(OFFICE_PREVIEW_RUNTIME_START_CHANNEL, wrapped)
    wrapped({}, { sessionId: 'session-1' })
    expect(listener).toHaveBeenCalledWith({ sessionId: 'session-1' })

    bridge.reportState(state)
    expect(mocks.send).toHaveBeenCalledWith(OFFICE_PREVIEW_RUNTIME_STATE_CHANNEL, state)

    removeListener()
    expect(mocks.removeListener).toHaveBeenCalledWith(OFFICE_PREVIEW_RUNTIME_START_CHANNEL, wrapped)
  })
})
