import { isCurrentInFlight } from '../../../../shared/in-flight-promise'
import type {
  NotebookRunCursor,
  NotebookRunPage,
  NotebookRunRecord,
  NotebookSessionReference,
  NotebookSessionRequest,
  NotebookSessionStateRequest,
  NotebookSessionState
} from '../../../../shared/notebook'

const MAX_CACHED_NOTEBOOK_BYTES = 64 * 1024 * 1024
const MAX_CACHED_NOTEBOOK_SESSIONS = 3

type SessionNotebookData = {
  runs: NotebookRunRecord[]
  runCount: number
  historyPage?: NotebookRunPage
}

type CachedSessionNotebook = {
  pages: Map<string, SessionNotebookData>
  bytes: number
}

const notebookCache = new Map<string, CachedSessionNotebook>()
const pendingPages = new Map<string, { scope: string; promise: Promise<SessionNotebookData> }>()
const cacheGenerations = new Map<string, number>()
let cachedNotebookBytes = 0

const scopeKey = (request: NotebookSessionRequest): string =>
  JSON.stringify([request.projectId, request.sessionId])

const pageKey = (cursor?: NotebookRunCursor): string =>
  cursor ? JSON.stringify([cursor.startedAt, cursor.runId]) : 'latest'

const estimateBytes = (data: SessionNotebookData): number => JSON.stringify(data).length * 2

const removeScope = (key: string): void => {
  const entry = notebookCache.get(key)
  if (!entry) return
  notebookCache.delete(key)
  cachedNotebookBytes -= entry.bytes
}

const pruneCache = (): void => {
  while (
    notebookCache.size > MAX_CACHED_NOTEBOOK_SESSIONS ||
    cachedNotebookBytes > MAX_CACHED_NOTEBOOK_BYTES
  ) {
    const oldest = notebookCache.keys().next().value
    if (oldest === undefined) return
    removeScope(oldest)
  }
}

const retainPage = (
  request: NotebookSessionRequest,
  cursor: NotebookRunCursor | undefined,
  data: SessionNotebookData
): void => {
  const bytes = estimateBytes(data)
  if (bytes > MAX_CACHED_NOTEBOOK_BYTES) return
  const key = scopeKey(request)
  const entry = notebookCache.get(key) ?? { pages: new Map(), bytes: 0 }
  const cursorKey = pageKey(cursor)
  const previous = entry.pages.get(cursorKey)
  if (previous) {
    const previousBytes = estimateBytes(previous)
    entry.bytes -= previousBytes
    cachedNotebookBytes -= previousBytes
  }
  entry.pages.set(cursorKey, data)
  entry.bytes += bytes
  cachedNotebookBytes += bytes
  notebookCache.delete(key)
  notebookCache.set(key, entry)
  pruneCache()
}

const invalidateSessionNotebookCache = (request: NotebookSessionRequest): void => {
  const key = scopeKey(request)
  removeScope(key)
  cacheGenerations.set(key, (cacheGenerations.get(key) ?? 0) + 1)
  for (const [pendingKey, pending] of pendingPages) {
    if (pending.scope === key) pendingPages.delete(pendingKey)
  }
}

// Minimal read-only slice of window.api.notebook the session viewer depends on.
type NotebookLoaderApi = {
  getReference: (request: NotebookSessionRequest) => Promise<NotebookSessionReference | null>
  state: (request: NotebookSessionStateRequest) => Promise<NotebookSessionState>
}

// Loads a session's recent persisted run window without spawning a kernel or creating run.json. Probe the
// read-only reference first: a session that never ran code returns [] here — no runtime is
// registered and no file is created. Only when a reference already exists do we read full state,
// which registers a lazy, un-spawned interpreter and reads the existing run.json (the Python
// process still starts only on execute, which this viewer never calls).
const loadSessionNotebookRuns = async (
  api: NotebookLoaderApi,
  request: NotebookSessionRequest
): Promise<NotebookRunRecord[]> => {
  const reference = await api.getReference(request)

  if (!reference) return []

  const state = await api.state(request)

  return state.runs
}

const loadSessionNotebookData = async (
  api: NotebookLoaderApi,
  request: NotebookSessionRequest,
  historyBefore?: NotebookRunCursor
): Promise<SessionNotebookData> => {
  const key = scopeKey(request)
  const cursorKey = pageKey(historyBefore)
  const cached = notebookCache.get(key)?.pages.get(cursorKey)
  if (cached) {
    const entry = notebookCache.get(key)!
    notebookCache.delete(key)
    notebookCache.set(key, entry)
    return cached
  }
  const pendingKey = `${key}:${cursorKey}`
  const existing = pendingPages.get(pendingKey)?.promise
  if (existing) return existing
  const generation = cacheGenerations.get(key) ?? 0

  const pending = (async (): Promise<SessionNotebookData> => {
    const reference = await api.getReference(request)
    if (!reference) return { runs: [], runCount: 0 }
    const state = await api.state({
      ...request,
      ...(historyBefore ? { historyBefore } : {})
    })
    const data = {
      runs: state.runs,
      runCount: state.runCount,
      ...(state.historyPage ? { historyPage: state.historyPage } : {})
    }
    if ((cacheGenerations.get(key) ?? 0) === generation) retainPage(request, historyBefore, data)
    return data
  })()
  pendingPages.set(pendingKey, { scope: key, promise: pending })
  try {
    return await pending
  } finally {
    if (isCurrentInFlight(pendingPages.get(pendingKey)?.promise, pending)) {
      pendingPages.delete(pendingKey)
    }
  }
}

export { invalidateSessionNotebookCache, loadSessionNotebookData, loadSessionNotebookRuns }
export type { NotebookLoaderApi, SessionNotebookData }
