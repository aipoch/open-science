import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import type {
  LiteratureCatalogSearchPage,
  LiteratureCatalogSearchRequest
} from '../../../../shared/literature'

const PAGE_CACHE_SIZE = 12

type LiteratureEntriesOptions = Readonly<{
  enabled?: boolean
  request: LiteratureCatalogSearchRequest
  scopeKey: string
  onPage: (
    page: LiteratureCatalogSearchPage,
    request: LiteratureCatalogSearchRequest,
    fromCache: boolean,
    preservePosition?: boolean
  ) => void
  onEmptyPage: (offset: number) => void
  onError: (failed: boolean) => void
}>

// Own request scheduling, stale-response rejection, and the bounded page cache together.
const useLiteratureEntries = ({
  enabled = true,
  request,
  scopeKey,
  onPage,
  onEmptyPage,
  onError
}: LiteratureEntriesOptions): {
  loading: boolean
  failed: boolean
  pageTransitionLoading: boolean
  reload: (force?: boolean) => Promise<void>
  refreshItems: (itemIds: string[]) => Promise<void>
} => {
  const [loading, setLoading] = useState(true)
  const [loadedKey, setLoadedKey] = useState<string>()
  const [failedKey, setFailedKey] = useState<string>()
  const generationRef = useRef(0)
  const cacheRef = useRef(new Map<string, LiteratureCatalogSearchPage>())
  const dirtyKeys = useRef(new Set<string>())
  const [cachedKeys, setCachedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const appliedPageRef = useRef<{ key: string; page: LiteratureCatalogSearchPage } | undefined>(
    undefined
  )
  const scheduledScopeRef = useRef<string | undefined>(undefined)
  const scheduledQueryRef = useRef(request.query)
  const pageKey = `${scopeKey}:${request.offset ?? 0}`

  const reload = useCallback(
    async (force = false): Promise<void> => {
      if (force) {
        cacheRef.current.clear()
        dirtyKeys.current.clear()
        setCachedKeys(new Set())
        appliedPageRef.current = undefined
        setLoadedKey(undefined)
        setFailedKey(undefined)
      }
      if (!enabled) return
      const generation = ++generationRef.current
      const cached =
        force || dirtyKeys.current.has(pageKey) ? undefined : cacheRef.current.get(pageKey)
      setFailedKey(undefined)
      onError(false)
      if (
        cached &&
        appliedPageRef.current?.key === pageKey &&
        appliedPageRef.current.page === cached
      ) {
        setLoading(false)
        return
      }
      if (!cached) setLoading(true)
      try {
        const page = cached ?? (await window.api.literature.search(request))
        if (generation !== generationRef.current) return
        if (page.entries.length === 0 && (request.offset ?? 0) > 0) {
          onEmptyPage(Math.max(0, (request.offset ?? 0) - (request.limit ?? 50)))
          return
        }
        cacheRef.current.delete(pageKey)
        dirtyKeys.current.delete(pageKey)
        cacheRef.current.set(pageKey, page)
        while (cacheRef.current.size > PAGE_CACHE_SIZE) {
          const oldestKey = cacheRef.current.keys().next().value
          if (oldestKey === undefined) break
          cacheRef.current.delete(oldestKey)
        }
        if (!cached) setCachedKeys(new Set(cacheRef.current.keys()))
        onPage(page, request, Boolean(cached))
        appliedPageRef.current = { key: pageKey, page }
        setLoadedKey(pageKey)
      } catch {
        if (generation === generationRef.current) {
          setFailedKey(pageKey)
          onError(true)
        }
      } finally {
        if (generation === generationRef.current) setLoading(false)
      }
    },
    [enabled, onEmptyPage, onError, onPage, pageKey, request]
  )

  const refreshItems = useCallback(
    async (itemIds: string[]): Promise<void> => {
      const displayed = appliedPageRef.current
      const ids = new Set(itemIds)
      // Invalidate other scopes, but keep the current page and its order while it is being read.
      cacheRef.current.clear()
      dirtyKeys.current.clear()
      if (displayed) cacheRef.current.set(displayed.key, displayed.page)
      if (displayed) dirtyKeys.current.add(displayed.key)
      setCachedKeys(new Set(cacheRef.current.keys()))
      if (!displayed || displayed.key !== pageKey || request.scope !== 'library') return
      const generation = generationRef.current
      const visible = displayed.page.entries.flatMap((entry) =>
        'metadataRevision' in entry && ids.has(entry.id) ? [entry.id] : []
      )
      try {
        const updated = await Promise.all(visible.map((id) => window.api.literature.get(id)))
        if (generation !== generationRef.current || appliedPageRef.current?.key !== pageKey) return
        const replacements = new Map(
          updated.flatMap((entry) => (entry ? [[entry.id, entry] as const] : []))
        )
        const current = appliedPageRef.current.page
        const page = {
          ...current,
          entries: current.entries.map((entry) =>
            'metadataRevision' in entry ? (replacements.get(entry.id) ?? entry) : entry
          )
        }
        cacheRef.current.set(pageKey, page)
        appliedPageRef.current = { key: pageKey, page }
        if (visible.length) onPage(page, request, true, true)
      } catch {
        onError(true)
      }
    },
    [onError, onPage, pageKey, request]
  )

  // Apply cached data before paint; returning to a cached scope must not tear down
  // the table for an intermediate loading frame or display the previous scope.
  useLayoutEffect(() => {
    const immediate =
      (request.offset ?? 0) === 0 ||
      cacheRef.current.has(pageKey) ||
      scheduledScopeRef.current === scopeKey ||
      scheduledQueryRef.current !== request.query
    scheduledScopeRef.current = scopeKey
    scheduledQueryRef.current = request.query
    const timeout = immediate ? undefined : window.setTimeout(() => void reload(), 150)
    if (immediate) void reload()
    return () => {
      window.clearTimeout(timeout)
      generationRef.current += 1
    }
  }, [pageKey, reload, request.offset, request.query, scopeKey])

  const pending =
    failedKey !== pageKey && !cachedKeys.has(pageKey) && (loading || loadedKey !== pageKey)
  return {
    loading: pending,
    failed: failedKey === pageKey,
    pageTransitionLoading: pending && loadedKey?.startsWith(`${scopeKey}:`) === true,
    reload,
    refreshItems
  }
}

export { useLiteratureEntries }
