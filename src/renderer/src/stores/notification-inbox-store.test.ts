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

  it('coalesces a burst of notification changes into one snapshot refresh', async () => {
    let changed: (() => void) | undefined
    const getSnapshot = vi.fn(async () => ({
      revision: 2,
      unreadCount: 1,
      latestSequence: 3,
      items: []
    }))
    const webWindow = Object.assign(new EventTarget(), {
      api: {
        notifications: {
          getSnapshot,
          onChanged: vi.fn((listener: () => void) => {
            changed = listener
            return () => undefined
          })
        }
      }
    })
    vi.stubGlobal('window', webWindow)

    const cleanup = useNotificationInboxStore.getState().listen()
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce())
    getSnapshot.mockClear()

    changed?.()
    changed?.()
    changed?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(getSnapshot).toHaveBeenCalledOnce()
    cleanup()
  })

  it('performs one trailing refresh when changes arrive during a snapshot request', async () => {
    let resolveFirst: ((snapshot: typeof EMPTY_SNAPSHOT) => void) | undefined
    const getSnapshot = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof EMPTY_SNAPSHOT>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValue({ ...EMPTY_SNAPSHOT, revision: 2 })
    vi.stubGlobal('window', { api: { notifications: { getSnapshot } } })

    const first = useNotificationInboxStore.getState().refresh()
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce())
    const second = useNotificationInboxStore.getState().refresh()
    const third = useNotificationInboxStore.getState().refresh()

    resolveFirst?.({ ...EMPTY_SNAPSHOT, revision: 1 })
    await Promise.all([first, second, third])

    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(useNotificationInboxStore.getState().revision).toBe(2)
  })

  it('reports snapshot failures without rejecting refresh callers', async () => {
    const getSnapshot = vi
      .fn()
      .mockRejectedValueOnce('offline')
      .mockRejectedValueOnce(new Error('network unavailable'))
    vi.stubGlobal('window', { api: { notifications: { getSnapshot } } })

    await useNotificationInboxStore.getState().refresh()
    expect(useNotificationInboxStore.getState()).toMatchObject({
      status: 'error',
      error: 'Messages could not be loaded.'
    })

    await useNotificationInboxStore.getState().refresh()
    expect(useNotificationInboxStore.getState()).toMatchObject({
      status: 'error',
      error: 'network unavailable'
    })
  })
})
