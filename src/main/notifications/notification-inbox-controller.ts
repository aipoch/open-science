import { randomUUID } from 'node:crypto'

import type {
  NotificationActionState,
  NotificationInboxChanged,
  NotificationInboxSnapshot,
  NotificationSource,
  UnreadTaskViewState
} from '../../shared/notifications'
import type {
  NotificationInboxDbRepository,
  NotificationRecordInput,
  NotificationRepositoryState
} from './notification-inbox-repository'

type NotificationInboxRecord = Omit<NotificationRecordInput, 'id' | 'readAt'>

type NotificationInboxBadge = Readonly<{ setCount(count: number): void }>

type NotificationInboxDesktopRuntime = Readonly<{
  isAppFocused: () => boolean
  confirmSessionVisible?: (sessionId: string) => Promise<boolean>
  badge: NotificationInboxBadge
}>

type NotificationInboxControllerDependencies = Readonly<{
  headless: boolean
  repository: NotificationInboxDbRepository
  onChanged: (event: NotificationInboxChanged) => void
  createId?: () => string
  now?: () => number
  onError?: (error: unknown) => void
}>

type NotificationInboxController = Readonly<{
  restore(): Promise<void>
  getSnapshot(limit?: number): Promise<NotificationInboxSnapshot>
  record(input: NotificationInboxRecord): Promise<void>
  settleAuthorization(
    source: NotificationSource,
    originId: string,
    actionState: NotificationActionState
  ): Promise<void>
  settleAction(dedupeKey: string, actionState: NotificationActionState): Promise<void>
  markRead(ids: readonly string[]): Promise<void>
  markAllRead(throughSequence: number): Promise<void>
  markSessionsRead(sessionIds: readonly string[]): Promise<void>
  markSessionCompletionsRead(sessionIds: readonly string[]): Promise<void>
  markSessionUnread(sessionIds: readonly string[]): Promise<void>
  invalidateSessions(sessionIds: readonly string[]): Promise<void>
  reconcileSessionCatalog(existingSessionIds: readonly string[]): Promise<void>
  syncViewState(state: UnreadTaskViewState): Promise<void>
  handleAppFocus(): Promise<void>
  handleWindowCreated(): void
  configureDesktop(runtime: NotificationInboxDesktopRuntime): void
  setSessionAvailability(check: (sessionId: string) => Promise<boolean>): void
  refreshBadge(): void
}>

type WireNotificationInboxControllerDependencies = Readonly<{
  app: {
    on(event: 'browser-window-focus' | 'browser-window-created', listener: () => void): unknown
  }
  controller: Pick<
    NotificationInboxController,
    'handleAppFocus' | 'handleWindowCreated' | 'refreshBadge'
  >
}>

const authorizationDedupeKey = (source: NotificationSource, originId: string): string =>
  `authorization:${source}:${originId}`

const agentQuestionDedupeKey = (originId: string): string => `input:agent-question:${originId}`

export const createNotificationInboxController = (
  dependencies: NotificationInboxControllerDependencies
): NotificationInboxController => {
  const createId = dependencies.createId ?? randomUUID
  const now = dependencies.now ?? Date.now
  const deletedSessionIds = new Set<string>()
  const pendingActionRecords = new Map<string, Promise<void>>()
  let revision = 1
  let unreadCount = 0
  let latestSequence = 0
  let visibleSessionId: string | undefined
  let desktop: NotificationInboxDesktopRuntime | undefined
  let isSessionAvailable: ((sessionId: string) => Promise<boolean>) | undefined

  const reportError = (error: unknown): void => dependencies.onError?.(error)

  const isAppFocused = (): boolean => {
    if (!desktop) return false
    try {
      return desktop.isAppFocused()
    } catch (error) {
      reportError(error)
      return false
    }
  }

  const refreshBadge = (): void => {
    if (dependencies.headless || !desktop) return
    try {
      desktop.badge.setCount(unreadCount)
    } catch (error) {
      reportError(error)
    }
  }

  const publish = (state: NotificationRepositoryState): void => {
    unreadCount = state.unreadCount
    latestSequence = state.latestSequence
    refreshBadge()
    if (!state.changed) return
    revision += 1
    try {
      dependencies.onChanged({ revision, unreadCount, latestSequence })
    } catch (error) {
      reportError(error)
    }
  }

  const mutate = async (operation: () => Promise<NotificationRepositoryState>): Promise<void> => {
    try {
      publish(await operation())
    } catch (error) {
      reportError(error)
      throw error
    }
  }

  const confirmVisibleSession = async (sessionId: string): Promise<boolean> => {
    if (!desktop?.confirmSessionVisible) return visibleSessionId === sessionId
    try {
      return await desktop.confirmSessionVisible(sessionId)
    } catch (error) {
      reportError(error)
      return false
    }
  }

  const restore = async (): Promise<void> => {
    try {
      const restoredAt = now()
      await dependencies.repository.migrateLegacyUnread(createId, restoredAt)
      await dependencies.repository.expireTransientPendingAuthorizations(restoredAt)
      const snapshot = await dependencies.repository.snapshot(1)
      unreadCount = snapshot.unreadCount
      latestSequence = snapshot.latestSequence
      refreshBadge()
    } catch (error) {
      reportError(error)
    }
  }

  const getSnapshot = async (limit?: number): Promise<NotificationInboxSnapshot> => {
    const snapshot = await dependencies.repository.snapshot(limit)
    unreadCount = snapshot.unreadCount
    latestSequence = snapshot.latestSequence
    refreshBadge()
    return { revision, ...snapshot }
  }

  const recordNow = async (input: NotificationInboxRecord): Promise<void> => {
    const sessionId = input.sessionId?.trim() || undefined
    if (sessionId && deletedSessionIds.has(sessionId)) return
    if (sessionId && isSessionAvailable && !(await isSessionAvailable(sessionId))) return

    let readAt: number | undefined
    if (sessionId && isAppFocused()) {
      const visible = await confirmVisibleSession(sessionId)
      if (isAppFocused() && visible) readAt = now()
    }
    if (sessionId && deletedSessionIds.has(sessionId)) return

    await mutate(() =>
      dependencies.repository.record({
        ...input,
        id: createId(),
        ...(sessionId ? { sessionId } : {}),
        ...(readAt === undefined ? {} : { readAt })
      })
    )
  }

  const record = (input: NotificationInboxRecord): Promise<void> => {
    const operation = recordNow(input)
    if (input.actionState !== 'pending') return operation

    const previous = pendingActionRecords.get(input.dedupeKey)
    const barrier = previous
      ? Promise.allSettled([previous, operation]).then(() => undefined)
      : operation.catch(() => undefined)
    pendingActionRecords.set(input.dedupeKey, barrier)
    void barrier.finally(() => {
      if (pendingActionRecords.get(input.dedupeKey) === barrier) {
        pendingActionRecords.delete(input.dedupeKey)
      }
    })
    return operation
  }

  const settleAction = async (
    dedupeKey: string,
    actionState: NotificationActionState
  ): Promise<void> => {
    await pendingActionRecords.get(dedupeKey)
    await mutate(() => dependencies.repository.settle(dedupeKey, actionState, now()))
  }

  const settleAuthorization = (
    source: NotificationSource,
    originId: string,
    actionState: NotificationActionState
  ): Promise<void> => settleAction(authorizationDedupeKey(source, originId), actionState)

  const markRead = (ids: readonly string[]): Promise<void> =>
    mutate(() => dependencies.repository.markRead(ids, now()))

  const markAllRead = (throughSequence: number): Promise<void> =>
    mutate(() => dependencies.repository.markAllRead(throughSequence, now()))

  const markSessionsRead = (sessionIds: readonly string[]): Promise<void> =>
    mutate(() => dependencies.repository.markSessionsRead(sessionIds, now()))

  const markVisibleSessionNotificationsRead = (sessionIds: readonly string[]): Promise<void> =>
    mutate(() => dependencies.repository.markSessionsRead(sessionIds, now()))

  const markSessionCompletionsRead = (sessionIds: readonly string[]): Promise<void> =>
    mutate(() => dependencies.repository.markSessionCompletionsRead(sessionIds, now()))

  const markSessionUnread = (sessionIds: readonly string[]): Promise<void> =>
    mutate(() => dependencies.repository.markSessionUnread(sessionIds))

  const invalidateSessions = async (sessionIds: readonly string[]): Promise<void> => {
    for (const sessionId of sessionIds) {
      const normalized = sessionId.trim()
      if (normalized) deletedSessionIds.add(normalized)
    }
    await mutate(() => dependencies.repository.invalidateSessions(sessionIds, now()))
  }

  const reconcileSessionCatalog = (existingSessionIds: readonly string[]): Promise<void> =>
    mutate(() => dependencies.repository.reconcileSessionCatalog(existingSessionIds, now()))

  const syncViewState = async (state: UnreadTaskViewState): Promise<void> => {
    visibleSessionId = state.visibleSessionId?.trim() || undefined
    if (isAppFocused() && visibleSessionId) {
      await markVisibleSessionNotificationsRead([visibleSessionId])
    } else refreshBadge()
  }

  const handleAppFocus = async (): Promise<void> => {
    if (!isAppFocused() || !visibleSessionId) {
      refreshBadge()
      return
    }
    const candidate = visibleSessionId
    const visible = await confirmVisibleSession(candidate)
    if (isAppFocused() && visible) await markVisibleSessionNotificationsRead([candidate])
    else refreshBadge()
  }

  return {
    restore,
    getSnapshot,
    record,
    settleAuthorization,
    settleAction,
    markRead,
    markAllRead,
    markSessionsRead,
    markSessionCompletionsRead,
    markSessionUnread,
    invalidateSessions,
    reconcileSessionCatalog,
    syncViewState,
    handleAppFocus,
    handleWindowCreated: () => {
      visibleSessionId = undefined
      refreshBadge()
    },
    configureDesktop: (runtime) => {
      desktop = runtime
      refreshBadge()
    },
    setSessionAvailability: (check) => {
      isSessionAvailable = check
    },
    refreshBadge
  }
}

export const wireNotificationInboxController = (
  dependencies: WireNotificationInboxControllerDependencies
): void => {
  dependencies.app.on('browser-window-focus', () => void dependencies.controller.handleAppFocus())
  dependencies.app.on('browser-window-created', () =>
    queueMicrotask(dependencies.controller.handleWindowCreated)
  )
}

export { agentQuestionDedupeKey, authorizationDedupeKey }
export type {
  NotificationInboxBadge,
  NotificationInboxController,
  NotificationInboxControllerDependencies,
  NotificationInboxDesktopRuntime,
  NotificationInboxRecord
}
