import {
  createLiteratureEntries,
  type LiteratureEntries,
  type LiteratureEntriesOptions
} from '@aipoch/literature-library/client'
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LiteratureCatalogSearchPage } from '../../../../../shared/literature'
import { literatureClient } from '../literature-read-pages'
export function useLiteratureEntries(
  options: LiteratureEntriesOptions<LiteratureCatalogSearchPage>
): ReturnType<LiteratureEntries<LiteratureCatalogSearchPage>['bind']> & {
  oversizedItemId?: string
  loading: boolean
  failed: boolean
  pageTransitionLoading: boolean
} {
  const { enabled = true, request, scopeKey, onPage, onEmptyPage, onItems, onError } = options
  const [owner] = useState(() =>
    createLiteratureEntries(literatureClient, (id) => window.api.literature.get(id))
  )
  const { oversizedItemId, loading, loadedKey, failedKey, cachedKeys } = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot
  )
  const { reload, refreshItems } = useMemo(
    () => owner.bind({ enabled, request, scopeKey, onPage, onEmptyPage, onItems, onError }),
    [owner, enabled, request, scopeKey, onPage, onEmptyPage, onItems, onError]
  )
  const scheduledScopeRef = useRef<string | undefined>(undefined)
  const scheduledQueryRef = useRef(request.query)
  const pageKey = `${scopeKey}:${request.offset ?? 0}`
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
