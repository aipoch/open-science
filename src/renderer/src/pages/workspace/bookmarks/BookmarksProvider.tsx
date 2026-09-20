import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Bookmark, BookmarkTarget } from '../../../../../shared/bookmarks'
import { BookmarksContext, unavailableError, type BookmarkPort } from './bookmark-context'

type BookmarksApi = Pick<Window['api'], 'bookmarks'>['bookmarks']

const sortBookmarks = (bookmarks: readonly Bookmark[]): Bookmark[] =>
  [...bookmarks].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  )

type ScopeState = Readonly<{
  key: string
  bookmarks: readonly Bookmark[]
  total: number
  loading: boolean
  loadError?: string
}>

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : 'Bookmarks could not be loaded.'

const BookmarksProvider = ({
  projectId,
  sessionId,
  writable = true,
  persistSessionTextSource,
  children
}: React.PropsWithChildren<{
  projectId?: string
  sessionId?: string
  writable?: boolean
  persistSessionTextSource?: (projectId: string, sessionId: string) => Promise<void>
}>): React.JSX.Element => {
  const scopeKey = projectId && sessionId ? `${projectId}\u0000${sessionId}` : ''
  const [state, setState] = useState<ScopeState>({
    key: scopeKey,
    bookmarks: [],
    total: 0,
    loading: Boolean(scopeKey)
  })
  if (state.key !== scopeKey) {
    setState({ key: scopeKey, bookmarks: [], total: 0, loading: Boolean(scopeKey) })
  }
  const [loadAttempt, setLoadAttempt] = useState(0)
  const scopeRevisionRef = useRef(0)
  const overlaysRef = useRef(new Map<string, Bookmark | null>())

  useEffect(() => {
    const scopeRevision = ++scopeRevisionRef.current
    return () => {
      scopeRevisionRef.current = scopeRevision + 1
    }
  }, [scopeKey])

  useEffect(() => {
    // A read retry supersedes only the previous read, not writes still committing in this Session.
    let active = true
    overlaysRef.current = new Map()
    if (!projectId || !sessionId) return

    const load = async (): Promise<void> => {
      const api = window.api.bookmarks as BookmarksApi
      let cursor: { createdAt: string; id: string } | undefined
      const loaded: Bookmark[] = []
      let total = 0
      do {
        const result = await api.list({ projectId, sessionId, cursor })
        if (!active) return
        loaded.push(...result.items)
        total = result.total
        cursor = result.nextCursor
      } while (cursor)

      const merged = new Map(loaded.map((bookmark) => [bookmark.id, bookmark]))
      for (const [id, overlay] of overlaysRef.current) {
        const existed = merged.has(id)
        if (overlay) {
          merged.set(id, overlay)
          if (!existed) total += 1
        } else if (existed) {
          merged.delete(id)
          total = Math.max(0, total - 1)
        }
      }
      setState({
        key: scopeKey,
        bookmarks: sortBookmarks([...merged.values()]),
        total,
        loading: false
      })
    }

    void load().catch((error: unknown) => {
      if (!active) return
      setState((current) => {
        const sameScope = current.key === scopeKey
        return {
          key: scopeKey,
          bookmarks: sameScope ? current.bookmarks : [],
          total: sameScope ? current.total : 0,
          loading: false,
          loadError: errorMessage(error)
        }
      })
    })
    return () => {
      active = false
    }
  }, [loadAttempt, projectId, scopeKey, sessionId])

  const retryLoad = useCallback(() => {
    setState((current) =>
      current.key === scopeKey
        ? { ...current, loading: Boolean(scopeKey), loadError: undefined }
        : current
    )
    setLoadAttempt((attempt) => attempt + 1)
  }, [scopeKey])

  const create = useCallback(
    async (id: string, target: BookmarkTarget, note: string): Promise<Bookmark> => {
      if (!projectId || !sessionId || !writable) throw unavailableError()
      const scopeRevision = scopeRevisionRef.current
      // A displayed response can precede the renderer's coalesced Session write. Publish its
      // source through the Session owner before main validates the durable message identity.
      if (target.kind === 'text' && target.source.kind !== 'project-file') {
        await persistSessionTextSource?.(projectId, sessionId)
      }
      const created = await (window.api.bookmarks as BookmarksApi).create({
        id,
        projectId,
        sessionId,
        target,
        note
      })
      if (scopeRevisionRef.current === scopeRevision) {
        overlaysRef.current.set(id, created)
        setState((current) => {
          if (current.key !== scopeKey) return current
          const existed = current.bookmarks.some((item) => item.id === id)
          return {
            ...current,
            bookmarks: sortBookmarks([
              ...current.bookmarks.filter((item) => item.id !== id),
              created
            ]),
            total: existed ? current.total : current.total + 1
          }
        })
      }
      return created
    },
    [persistSessionTextSource, projectId, scopeKey, sessionId, writable]
  )

  const updateNote = useCallback(
    async (id: string, note: string): Promise<Bookmark> => {
      if (!projectId || !sessionId || !writable) throw unavailableError()
      const scopeRevision = scopeRevisionRef.current
      const updated = await (window.api.bookmarks as BookmarksApi).updateNote({
        projectId,
        sessionId,
        id,
        note
      })
      if (scopeRevisionRef.current === scopeRevision) {
        overlaysRef.current.set(id, updated)
        setState((current) =>
          current.key !== scopeKey
            ? current
            : {
                ...current,
                bookmarks: sortBookmarks([
                  ...current.bookmarks.filter((item) => item.id !== id),
                  updated
                ])
              }
        )
      }
      return updated
    },
    [projectId, scopeKey, sessionId, writable]
  )

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      if (!projectId || !sessionId || !writable) throw unavailableError()
      const scopeRevision = scopeRevisionRef.current
      const result = await (window.api.bookmarks as BookmarksApi).delete({
        projectId,
        sessionId,
        id
      })
      if (result.deleted && scopeRevisionRef.current === scopeRevision) {
        overlaysRef.current.set(id, null)
        setState((current) => {
          if (current.key !== scopeKey) return current
          const existed = current.bookmarks.some((item) => item.id === id)
          return {
            ...current,
            bookmarks: current.bookmarks.filter((item) => item.id !== id),
            total: existed ? Math.max(0, current.total - 1) : current.total
          }
        })
      }
      return result.deleted
    },
    [projectId, scopeKey, sessionId, writable]
  )

  const value = useMemo<BookmarkPort>(() => {
    const visibleState: ScopeState =
      state.key === scopeKey
        ? state
        : { key: scopeKey, bookmarks: [], total: 0, loading: Boolean(scopeKey) }
    return {
      scoped: Boolean(scopeKey),
      sessionId,
      available: Boolean(scopeKey) && writable,
      bookmarks: visibleState.bookmarks,
      total: visibleState.total,
      loading: visibleState.loading,
      loadError: visibleState.loadError,
      retryLoad,
      create,
      updateNote,
      remove
    }
  }, [create, remove, retryLoad, scopeKey, sessionId, state, updateNote, writable])

  return <BookmarksContext.Provider value={value}>{children}</BookmarksContext.Provider>
}

export { BookmarksProvider }
