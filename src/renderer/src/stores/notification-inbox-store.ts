import { create } from 'zustand'

import type { NotificationInboxSnapshot } from '../../../shared/notifications'

type NotificationInboxStore = NotificationInboxSnapshot & {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  refresh: () => Promise<void>
  markRead: (ids: readonly string[]) => Promise<void>
  markAllRead: () => Promise<void>
  markSessionCompletionsRead: (sessionIds: readonly string[]) => Promise<void>
  listen: () => () => void
}

const EMPTY_SNAPSHOT: NotificationInboxSnapshot = {
  revision: 0,
  unreadCount: 0,
  latestSequence: 0,
  items: []
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Messages could not be loaded.'

let refreshTail: Promise<void> | undefined
let refreshInFlight = false
let trailingRefreshRequested = false

// Mirrors the backend-owned snapshot. Every renderer subscribes before its first read. Synchronous
// bursts share one request; changes observed during that request schedule one authoritative follow-up.
export const useNotificationInboxStore = create<NotificationInboxStore>((set, get) => ({
  ...EMPTY_SNAPSHOT,
  status: 'idle',

  refresh: () => {
    if (refreshTail) {
      if (refreshInFlight) trailingRefreshRequested = true
      return refreshTail
    }

    refreshTail = Promise.resolve()
      .then(async () => {
        do {
          trailingRefreshRequested = false
          refreshInFlight = true
          const api = window.api?.notifications
          if (!api?.getSnapshot) return
          if (get().status === 'idle') set({ status: 'loading', error: undefined })
          try {
            const snapshot = await api.getSnapshot()
            set({ ...snapshot, status: 'ready', error: undefined })
          } catch (error) {
            set({ status: 'error', error: errorMessage(error) })
          } finally {
            refreshInFlight = false
          }
        } while (trailingRefreshRequested)
      })
      .finally(() => {
        refreshInFlight = false
        refreshTail = undefined
      })

    return refreshTail
  },

  markRead: async (ids) => {
    const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    if (normalized.length === 0) return
    const mark = window.api?.notifications?.markRead
    if (!mark) return
    await mark({ ids: normalized })
    await get().refresh()
  },

  markAllRead: async () => {
    const throughSequence = get().latestSequence
    if (throughSequence <= 0 || get().unreadCount === 0) return
    const mark = window.api?.notifications?.markAllRead
    if (!mark) return
    await mark({ throughSequence })
    await get().refresh()
  },

  markSessionCompletionsRead: async (sessionIds) => {
    const normalized = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))]
    if (normalized.length === 0) return
    const mark = window.api?.notifications?.markSessionCompletionsRead
    if (!mark) return
    await mark({ sessionIds: normalized })
    await get().refresh()
  },

  listen: () => {
    const api = window.api?.notifications
    if (!api?.onChanged || !api.getSnapshot) return () => undefined
    const refresh = (): void => void get().refresh()
    const remove = api.onChanged(refresh)
    window.addEventListener('open-science:web-events-open', refresh)
    void get().refresh()
    return () => {
      remove()
      window.removeEventListener('open-science:web-events-open', refresh)
    }
  }
}))

export { EMPTY_SNAPSHOT }
