import { useLiteratureHost } from '../renderer-host'
import {
  createLiteratureEntries,
  type LiteratureEntries,
  type LiteratureEntriesOptions
} from '@aipoch/literature-library/client'
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type { LiteratureCatalogSearchPage } from '../../../../../shared/literature'
import { useLiteratureClient } from '../literature-read-pages'
export function useLiteratureEntries(
  options: LiteratureEntriesOptions<LiteratureCatalogSearchPage>
): ReturnType<LiteratureEntries<LiteratureCatalogSearchPage>['bind']> & {
  oversizedItemId?: string
  loading: boolean
  failed: boolean
  pageTransitionLoading: boolean
} {
  const literatureClient = useLiteratureClient()

  const { api: hostApi } = useLiteratureHost()

  const { enabled = true, request, scopeKey, onPage, onEmptyPage, onItems, onError } = options
  const [owner] = useState(() =>
    createLiteratureEntries(literatureClient, (id) => hostApi.literature.get(id))
  )
  const { oversizedItemId, loading, loadedKey, failedKey, cachedKeys } = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot
  )
  const { reload: reloadBound, refreshItems } = useMemo(
    () => owner.bind({ enabled, request, scopeKey, onPage, onEmptyPage, onItems, onError }),
    [owner, enabled, request, scopeKey, onPage, onEmptyPage, onItems, onError]
  )
  const scheduledScopeRef = useRef<string | undefined>(undefined)
  const scheduledQueryRef = useRef(request.query)
  const pageKey = `${scopeKey}:${request.offset ?? 0}`
  // Reject retained reloads before the owner changes the current cache or generation.
  const context = useMemo(() => ({ pageKey, request, enabled }), [pageKey, request, enabled])
  const currentContext = useRef<typeof context | undefined>(context)
  useLayoutEffect(() => {
    currentContext.current = context
    return () => {
      currentContext.current = undefined
    }
  }, [context])
  const reload = useCallback(
    async (force = false, preservePage = false): Promise<boolean | undefined> => {
      if (currentContext.current !== context) return
      return reloadBound(force, preservePage)
    },
    [context, reloadBound]
  )
  useLayoutEffect(() => {
    owner.mount()
    return () => owner.unmount()
  }, [owner])
  useLayoutEffect(() => {
    const immediate =
      (request.offset ?? 0) === 0 ||
      owner.getSnapshot().cachedKeys.has(pageKey) ||
      scheduledScopeRef.current === scopeKey ||
      scheduledQueryRef.current !== request.query
    scheduledScopeRef.current = scopeKey
    scheduledQueryRef.current = request.query
    const timeout = immediate ? undefined : window.setTimeout(() => void reload(), 150)
    if (immediate) void reload()
    return () => {
      window.clearTimeout(timeout)
      owner.invalidate()
    }
  }, [owner, pageKey, reload, request.offset, request.query, scopeKey])
  const pending =
    failedKey !== pageKey && !cachedKeys.has(pageKey) && (loading || loadedKey !== pageKey)
  return {
    oversizedItemId,
    loading: pending,
    failed: failedKey === pageKey,
    pageTransitionLoading: pending && loadedKey?.startsWith(`${scopeKey}:`) === true,
    reload,
    refreshItems
  }
}
