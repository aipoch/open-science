import {
  SESSION_HISTORY_CURSOR_STALE,
  SessionHistoryCursorStaleError,
  type LoadSessionHistoryPageRequest,
  type SessionHistoryPage
} from '../../../../shared/session-history'
import type {
  LoadSessionRequest,
  PersistedChatSession
} from '../../../../shared/session-persistence'
import { hydrateSession, useSessionStore, type ChatSession } from '../../stores/session-store'

type HistoryApi = {
  loadHistoryPage?: (
    request: LoadSessionHistoryPageRequest
  ) => Promise<SessionHistoryPage | undefined>
  loadOne: (request: LoadSessionRequest) => Promise<PersistedChatSession | undefined>
}

const pendingPages = new Map<string, Promise<void>>()
const pendingAuthorities = new Map<string, Promise<ChatSession | undefined>>()
const keyFor = (request: LoadSessionRequest): string =>
  JSON.stringify([request.projectId, request.sessionId])
const findSession = (request: LoadSessionRequest): ChatSession | undefined =>
  useSessionStore
    .getState()
    .sessions.find(
      (session) => session.id === request.sessionId && session.projectId === request.projectId
    )

const mergeRows = <T extends { id: string; createdAt: number }>(
  earlier: readonly T[],
  current: readonly T[]
): T[] =>
  [...new Map([...earlier, ...current].map((row) => [row.id, row])).values()].sort(
    (left, right) => left.createdAt - right.createdAt
  )

const needsRuntimeAuthority = (session: ChatSession | PersistedChatSession): boolean =>
  !session.packageOrigin &&
  Boolean(
    session.activeRun || session.status === 'running' || session.status.startsWith('waiting-')
  )

// Indexed pages remain display-only even after their last page. Only an explicit complete response
// contains the authority (including inactive branches) and can clear the store's contentLoaded guard.
const installHistoryPage = (
  page: SessionHistoryPage,
  source: ChatSession,
  append: boolean
): void => {
  const acceptsPage = (current: ChatSession): boolean => {
    const pending =
      current.id === source.id &&
      current.projectId === source.projectId &&
      current.contentLoaded === false &&
      current.historyPage === source.historyPage &&
      page.sessionId === current.id &&
      page.projectId === current.projectId &&
      page.session.id === current.id &&
      page.session.projectId === current.projectId
    // A metadata receipt may advance the revision while this read is pending. Surface the stale
    // response through the existing retry UI instead of leaving a first-page skeleton forever.
    if (pending && page.revision < (current.revision ?? 0))
      throw new SessionHistoryCursorStaleError()
    return pending
  }
  if (page.complete === true) {
    const current = findSession({ projectId: source.projectId, sessionId: source.id })
    // Use the authority hydrator so the saver acknowledges this read instead of echoing a write.
    if (current && acceptsPage(current))
      useSessionStore.getState().upsertPersistedSession(page.session)
    return
  }
  useSessionStore.setState((state) => ({
    sessions: state.sessions.map((current) => {
      if (!acceptsPage(current)) return current
      const display = hydrateSession(page.session)
      const groups = append
        ? [
            ...new Map(
              [...(display.activityGroups ?? []), ...(current.activityGroups ?? [])].map(
                (group) => [group.id, group]
              )
            ).values()
          ].map((group) => ({
            ...group,
            activityIds: [
              ...new Set([
                ...(display.activityGroups?.find(({ id }) => id === group.id)?.activityIds ?? []),
                ...(current.activityGroups?.find(({ id }) => id === group.id)?.activityIds ?? [])
              ])
            ]
          }))
        : display.activityGroups
      return {
        ...display,
        conversationGraph: undefined,
        number: current.number ?? display.number,
        title: current.title,
        pinned: current.pinned,
        ...(current.unsavedTitle ? { title: current.title, unsavedTitle: true as const } : {}),
        contentLoaded: false,
        messages: append ? mergeRows(display.messages, current.messages) : display.messages,
        activities: append
          ? mergeRows(display.activities ?? [], current.activities ?? [])
          : display.activities,
        activityGroups: groups,
        artifacts: append
          ? [
              ...new Map(
                [...(display.artifacts ?? []), ...(current.artifacts ?? [])].map((artifact) => [
                  artifact.id,
                  artifact
                ])
              ).values()
            ]
          : display.artifacts,
        activeMessageCount: current.activeMessageCount,
        artifactCount: current.artifactCount,
        historyPage: {
          revision: page.revision,
          messageBranchId: page.messageBranchId,
          beforeCursor: page.beforeCursor,
          hasMore: page.hasMore,
          totalItems: page.totalItems
        }
      }
    })
  }))
}

export const ensureSessionContentLoaded = (
  request: LoadSessionRequest,
  api: Pick<HistoryApi, 'loadOne'> = window.api.sessions
): Promise<ChatSession | undefined> => {
  const source = findSession(request)
  if (!source || source.contentLoaded !== false) return Promise.resolve(source)
  const key = keyFor(request)
  const pending = pendingAuthorities.get(key)
  if (pending) return pending
  const load = api
    .loadOne(request)
    .then((authority) => {
      if (
        !authority ||
        authority.id !== request.sessionId ||
        authority.projectId !== request.projectId
      )
        throw new Error('Session content could not be loaded.')
      const current = findSession(request)
      if (current && (authority.revision ?? 0) < (current.revision ?? 0))
        throw new Error('Session history changed. Reload its first page.')
      if (current?.contentLoaded === false)
        useSessionStore.getState().upsertPersistedSession(authority)
      return findSession(request)
    })
    .finally(() => pendingAuthorities.delete(key))
  pendingAuthorities.set(key, load)
  return load
}

export const loadSessionHistoryPage = (
  request: LoadSessionRequest,
  earlier = false,
  api: HistoryApi = window.api.sessions
): Promise<void> => {
  const source = findSession(request)
  if (
    !source ||
    source.contentLoaded !== false ||
    (!earlier && source.historyPage) ||
    (earlier && !source.historyPage?.hasMore)
  )
    return Promise.resolve()
  if (!api.loadHistoryPage) return ensureSessionContentLoaded(request, api).then(() => undefined)
  if (needsRuntimeAuthority(source))
    return ensureSessionContentLoaded(request, api).then(() => undefined)
  const key = keyFor(request)
  const pending = pendingPages.get(key)
  if (pending) return pending
  const beforeCursor = earlier ? source.historyPage?.beforeCursor : undefined
  const load = (async (): Promise<void> => {
    let page: SessionHistoryPage | undefined
    let append = earlier
    try {
      page = await api.loadHistoryPage!({ ...request, ...(beforeCursor ? { beforeCursor } : {}) })
    } catch (error) {
      const stale =
        error &&
        typeof error === 'object' &&
        (('code' in error && error.code === SESSION_HISTORY_CURSOR_STALE) ||
          ('message' in error &&
            typeof error.message === 'string' &&
            error.message.includes(SESSION_HISTORY_CURSOR_STALE)))
      if (!beforeCursor || !stale) throw error
      page = await api.loadHistoryPage!(request)
      append = false
    }
    if (!page) throw new Error('Session content could not be loaded.')
    if (!page.complete && needsRuntimeAuthority(page.session)) {
      await ensureSessionContentLoaded(request, api)
      return
    }
    if (append && page.revision !== source.historyPage?.revision)
      throw new Error('Session history changed. Reload its first page.')
    installHistoryPage(page, source, append)
  })().finally(() => pendingPages.delete(key))
  pendingPages.set(key, load)
  return load
}
