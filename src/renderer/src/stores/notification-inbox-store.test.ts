// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_SNAPSHOT, useNotificationInboxStore } from './notification-inbox-store'

afterEach(() => {
  useNotificationInboxStore.setState({ ...EMPTY_SNAPSHOT, status: 'idle', error: undefined })
  vi.unstubAllGlobals()
})

describe('notification inbox store', () => {
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
})
