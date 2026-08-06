import { MAX_UNREAD_TASK_SESSIONS } from './unread-task-repository'
import type { UnreadTaskViewState } from '../../shared/notifications'

export type UnreadTaskRepository = {
  load(): Promise<string[]>
  save(sessionIds: string[]): Promise<void>
}

export type UnreadTaskBadge = {
  setCount(count: number): void
}

export type UnreadTaskController = {
  restore(): Promise<void>
  markUnread(sessionId: string): Promise<void>
  markReadSessions(sessionIds: string[]): Promise<void>
  removeUnreadSessions(sessionIds: string[]): Promise<void>
  syncViewState(state: UnreadTaskViewState): Promise<void>
  handleAppFocus(): Promise<void>
  handleWindowCreated(): void
  refreshBadge(): void
}

type UnreadTaskControllerDeps = {
  headless: boolean
  isAppFocused: () => boolean
  repository: UnreadTaskRepository
  badge: UnreadTaskBadge
  confirmSessionVisible?: (sessionId: string) => Promise<boolean>
  canMarkUnread?: (sessionId: string) => Promise<boolean>
  onError?: (error: unknown) => void
}

type WireUnreadTaskControllerDeps = {
  app: {
    on(event: 'browser-window-focus' | 'browser-window-created', listener: () => void): unknown
  }
  taskNotifications: {
    setUnreadHandler(handler: (sessionId: string) => Promise<void>): void
  }
  controller: UnreadTaskController
}

// Connects unread ownership to task completion and Electron window lifecycle events.
export const wireUnreadTaskController = (deps: WireUnreadTaskControllerDeps): void => {
  deps.taskNotifications.setUnreadHandler(deps.controller.markUnread)
  deps.app.on('browser-window-focus', () => void deps.controller.handleAppFocus())
  // Electron emits browser-window-created from the BrowserWindow constructor, before lifecycle code
  // stores the new main-window reference. Defer one microtask so invalidation and badge reapplication
  // both target the replacement main window.
  deps.app.on('browser-window-created', () => queueMicrotask(deps.controller.handleWindowCreated))
}

// Main-process source of truth for unread terminal tasks. It coordinates durable state, renderer
// visibility acknowledgements, deletion tombstones, and the platform badge as one ordered policy.
export const createUnreadTaskController = (
  deps: UnreadTaskControllerDeps
): UnreadTaskController => {
  const unreadSessionIds = new Set<string>()
  // A terminal event can race a durable deletion. Process-lifetime tombstones prevent that late
  // event from recreating unread state after the session has disappeared from persistence.
  const deletedSessionIds = new Set<string>()
  let visibleSessionId: string | undefined
  let persistenceReady = false

  const reportError = (error: unknown): void => deps.onError?.(error)

  const isAppFocused = (): boolean => {
    try {
      return deps.isAppFocused()
    } catch (error) {
      // Electron may retain a destroyed BrowserWindow briefly after the last window closes. Treat it
      // as unfocused so a native-handle error cannot make a terminal task lose its unread marker.
      reportError(error)
      return false
    }
  }

  // Badge rendering is derived from memory and best-effort; native failures never affect state.
  const refreshBadge = (): void => {
    if (deps.headless) return

    try {
      deps.badge.setCount(unreadSessionIds.size)
    } catch (error) {
      reportError(error)
    }
  }

  // Persistence failure is observable in logs but must not roll back the in-memory user signal.
  const persist = async (): Promise<void> => {
    // A failed restore leaves the durable baseline unknown. Skipping writes avoids reconciling an
    // assumed-empty snapshot over unread rows that this process never successfully loaded.
    if (!persistenceReady) return

    try {
      await deps.repository.save([...unreadSessionIds])
    } catch (error) {
      reportError(error)
    }
  }

  // Renderer state can change between an earlier projection and a main-process focus event. Ask
  // the current renderer whenever possible so an overlay cannot turn a stale projection into read.
  const confirmVisibleSession = async (sessionId: string): Promise<boolean> => {
    if (!deps.confirmSessionVisible) return visibleSessionId === sessionId

    try {
      return await deps.confirmSessionVisible(sessionId)
    } catch (error) {
      reportError(error)
      return false
    }
  }

  // Restores a bounded snapshot before notification wiring starts, then renders its native count.
  const restore = async (): Promise<void> => {
    if (deps.headless) return

    persistenceReady = false

    try {
      const restored = await deps.repository.load()
      for (const sessionId of restored.slice(-MAX_UNREAD_TASK_SESSIONS)) {
        const normalized = sessionId.trim()
        if (normalized) unreadSessionIds.add(normalized)
      }
      persistenceReady = true
    } catch (error) {
      reportError(error)
    }

    refreshBadge()
  }

  // Marks a terminal task unread unless a focused renderer freshly proves that conversation is
  // actually visible. Focus alone is insufficient because another window or modal may cover it.
  const markUnread = async (sessionId: string): Promise<void> => {
    if (deps.headless) return

    const normalized = sessionId.trim()

    if (!normalized) return
    if (deletedSessionIds.has(normalized)) return
    if (unreadSessionIds.has(normalized)) return
    if (!((await deps.canMarkUnread?.(normalized)) ?? true)) return

    if (isAppFocused()) {
      const isVisible = await confirmVisibleSession(normalized)

      // Focus may change while renderer work is queued. Only a fresh visible ack while the main
      // window remains focused can prove that the terminal result is already being read.
      if (isAppFocused() && isVisible) return
      if (deletedSessionIds.has(normalized)) return
      if (unreadSessionIds.has(normalized)) return
    }

    unreadSessionIds.add(normalized)

    while (unreadSessionIds.size > MAX_UNREAD_TASK_SESSIONS) {
      const oldest = unreadSessionIds.values().next().value
      if (oldest === undefined) break
      unreadSessionIds.delete(oldest)
    }

    refreshBadge()
    await persist()
  }

  // Durable session deletion both clears existing unread markers and blocks racing terminal events.
  const removeUnreadSessions = async (sessionIds: string[]): Promise<void> => {
    if (deps.headless) return

    let changed = false

    for (const sessionId of sessionIds) {
      const normalized = sessionId.trim()
      if (!normalized) continue

      deletedSessionIds.add(normalized)
      if (unreadSessionIds.delete(normalized)) changed = true
    }

    if (!changed) return

    refreshBadge()
    await persist()
  }

  // Archive is an acknowledgement, not a deletion. It clears the current attention signal without
  // leaving a process-lifetime tombstone, so a restored Session can receive future terminal notices.
  const markReadSessions = async (sessionIds: string[]): Promise<void> => {
    if (deps.headless) return

    let changed = false
    for (const sessionId of sessionIds) {
      const normalized = sessionId.trim()
      if (normalized && unreadSessionIds.delete(normalized)) changed = true
    }
    if (!changed) return

    refreshBadge()
    await persist()
  }

  // Applies the renderer's visibility projection; durable absence is reconciled by main's complete
  // Session scan, never by renderer-owned state.
  const syncViewState = async (state: UnreadTaskViewState): Promise<void> => {
    if (deps.headless) return

    visibleSessionId = state.visibleSessionId?.trim() || undefined
    let changed = false

    if (
      isAppFocused() &&
      visibleSessionId !== undefined &&
      unreadSessionIds.delete(visibleSessionId)
    ) {
      changed = true
    }

    // Reapply even when state is unchanged: a Windows window may have been recreated since the
    // previous overlay was rendered.
    refreshBadge()
    if (changed) await persist()
  }

  // Focus clears only a conversation the current renderer freshly confirms as visible. The second
  // focus check protects the async challenge from acknowledging a task after focus moved away.
  const handleAppFocus = async (): Promise<void> => {
    if (deps.headless || !isAppFocused()) return

    const candidateSessionId = visibleSessionId

    if (!candidateSessionId) {
      refreshBadge()
      return
    }

    const isVisible = await confirmVisibleSession(candidateSessionId)
    const changed =
      isAppFocused() && isVisible ? unreadSessionIds.delete(candidateSessionId) : false

    refreshBadge()
    if (changed) await persist()
  }

  // A replacement renderer has not yet proved which conversation is visible. Drop the previous
  // window's projection so its first focus event cannot acknowledge a stale conversation.
  const handleWindowCreated = (): void => {
    visibleSessionId = undefined
    refreshBadge()
  }

  return {
    restore,
    markUnread,
    markReadSessions,
    removeUnreadSessions,
    syncViewState,
    handleAppFocus,
    handleWindowCreated,
    refreshBadge
  }
}
