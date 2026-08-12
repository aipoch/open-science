// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_SNAPSHOT, useNotificationInboxStore } from './notification-inbox-store'

afterEach(() => {
  useNotificationInboxStore.setState({ ...EMPTY_SNAPSHOT, status: 'idle', error: undefined })
  vi.unstubAllGlobals()
})

describe('notification inbox store', () => {
  it('marks all completions for normalized session ids and refreshes the snapshot', async () => {
    const markSessionCompletionsRead = vi.fn(async () => undefined)
    const getSnapshot = vi.fn(async () => ({
      revision: 2,
      unreadCount: 0,
      latestSequence: 3,
      items: []
    }))
    vi.stubGlobal('window', {
      api: { notifications: { getSnapshot, markSessionCompletionsRead } }
    })

    await useNotificationInboxStore
      .getState()
      .markSessionCompletionsRead([' session-1 ', 'session-1', ''])

    expect(markSessionCompletionsRead).toHaveBeenCalledWith({ sessionIds: ['session-1'] })
    expect(getSnapshot).toHaveBeenCalledOnce()
  })

  it('accepts a lower revision from a restarted backend as authoritative', async () => {
    const snapshot = { revision: 1, unreadCount: 0, latestSequence: 0, items: [] }
    vi.stubGlobal('window', {
      api: { notifications: { getSnapshot: vi.fn(async () => snapshot) } }
    })
    useNotificationInboxStore.setState({ revision: 9, unreadCount: 4, latestSequence: 12 })

    await useNotificationInboxStore.getState().refresh()

    expect(useNotificationInboxStore.getState()).toMatchObject({
      ...snapshot,
      status: 'ready',
      error: undefined
    })
  })

  it('refreshes after the Web event socket opens and removes the listener on cleanup', async () => {
    const getSnapshot = vi.fn(async () => ({
      revision: 2,
      unreadCount: 1,
      latestSequence: 3,
      items: []
    }))
    const removeChanged = vi.fn()
    const webWindow = Object.assign(new EventTarget(), {
      api: {
        notifications: {
          getSnapshot,
          onChanged: vi.fn(() => removeChanged)
        }
      }
    })
    vi.stubGlobal('window', webWindow)

    const cleanup = useNotificationInboxStore.getState().listen()
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce())
    getSnapshot.mockClear()

    webWindow.dispatchEvent(new Event('open-science:web-events-open'))
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce())

    cleanup()
    getSnapshot.mockClear()
    webWindow.dispatchEvent(new Event('open-science:web-events-open'))
    await Promise.resolve()

    expect(getSnapshot).not.toHaveBeenCalled()
    expect(removeChanged).toHaveBeenCalledOnce()
  })
})
