import type { LiteratureCatalogSearchRequest, LiteratureItemView } from '../contracts.js'
import { oversizedLiteratureReference } from '../export.js'
import type { createLiteratureClient } from './pages.js'
import type { LibraryClientApi, LibraryPage } from './ports.js'
import { reconcileLiteraturePage } from './reconcile.js'
const PAGE_CACHE_SIZE = 12
export type LiteratureEntriesSnapshot = {
  oversizedItemId?: string
  loading: boolean
  loadedKey?: string
  failedKey?: string
  cachedKeys: ReadonlySet<string>
}
export type LiteratureEntriesOptions<Page extends LibraryPage> = Readonly<{
  enabled?: boolean
  request: LiteratureCatalogSearchRequest
  scopeKey: string
  onPage: (
    page: Page,
    request: LiteratureCatalogSearchRequest,
    fromCache: boolean,
    preservePosition?: boolean
  ) => void
  onItems?: (items: LiteratureItemView[]) => void
  onEmptyPage: (offset: number) => void
  onError: (failed: boolean) => void
}>
export type LiteratureEntries<Page extends LibraryPage> = {
  bind: ({
    enabled,
    request,
    scopeKey,
    onPage,
    onEmptyPage,
    onItems,
    onError
  }: LiteratureEntriesOptions<Page>) => {
    reload: (force?: boolean, preservePage?: boolean) => Promise<boolean | undefined>
    refreshItems: (
      itemIds: string[],
      updatedItems?: LiteratureItemView[],
      includeHidden?: boolean
    ) => Promise<void>
  }
  getSnapshot: () => LiteratureEntriesSnapshot
  subscribe: (listener: () => void) => () => void
  invalidate: () => void
  mount: () => void
  unmount: () => void
}

export function createLiteratureEntries<Page extends LibraryPage>(
  client: Pick<ReturnType<typeof createLiteratureClient<Page>>, 'readLiteratureDisplayPage'>,
  getItem: LibraryClientApi<Page>['get']
): LiteratureEntries<Page> {
  let snapshot: LiteratureEntriesSnapshot = { loading: true, cachedKeys: new Set() }
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<LiteratureEntriesSnapshot>): void => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const setOversizedItemId = (oversizedItemId?: string): void => publish({ oversizedItemId })
  const setLoading = (loading: boolean): void => publish({ loading })
  const setLoadedKey = (loadedKey?: string): void => publish({ loadedKey })
  const setFailedKey = (failedKey?: string): void => publish({ failedKey })
  const setCachedKeys = (cachedKeys: ReadonlySet<string>): void => publish({ cachedKeys })
  const generationRef = { current: 0 },
    dataRevisionRef = { current: 0 },
    mounted = { current: true }
  const itemReads = { current: new Map<string, object>() },
    cacheRef = { current: new Map<string, Page>() },
    dirtyKeys = { current: new Set<string>() }
  const appliedPageRef: { current: { key: string; page: Page } | undefined } = {
    current: undefined
  }
  const bind = ({
    enabled = true,
    request,
    scopeKey,
    onPage,
    onEmptyPage,
    onItems,
    onError
  }: LiteratureEntriesOptions<Page>): ReturnType<LiteratureEntries<Page>['bind']> => {
    const pageKey = `${scopeKey}:${request.offset ?? 0}`
    const reload = async (force = false, preservePage = false): Promise<boolean | undefined> => {
      const retained =
        preservePage && appliedPageRef.current?.key === pageKey ? appliedPageRef.current : undefined
      if (force) {
        itemReads.current.clear()
        cacheRef.current.clear()
        dirtyKeys.current.clear()
        if (retained) {
          cacheRef.current.set(pageKey, retained.page)
          dirtyKeys.current.add(pageKey)
        }
        setCachedKeys(new Set(cacheRef.current.keys()))
        if (!retained) {
          appliedPageRef.current = undefined
          setLoadedKey(undefined)
        }
        setFailedKey(undefined)
      }
      if (!enabled) return
      const generation = ++generationRef.current
      let dataRevision = dataRevisionRef.current
      const cached =
        force || dirtyKeys.current.has(pageKey) ? undefined : cacheRef.current.get(pageKey)
      setFailedKey(undefined)
      onError(false)
      setOversizedItemId(undefined)
      if (
        cached &&
        appliedPageRef.current?.key === pageKey &&
        appliedPageRef.current.page === cached
      ) {
        setLoading(false)
        return true
      }
      if (!cached) setLoading(true)
      try {
        let page =
          cached ??
          (await client.readLiteratureDisplayPage(
            request,
            () => generation === generationRef.current
          ))
        while (generation === generationRef.current && dataRevision !== dataRevisionRef.current) {
          dataRevision = dataRevisionRef.current
          page = await client.readLiteratureDisplayPage(
            request,
            () => generation === generationRef.current
          )
        }
        if (generation !== generationRef.current) return
        if (page.entries.length === 0 && (request.offset ?? 0) > 0) {
          onEmptyPage(Math.max(0, (request.offset ?? 0) - (request.limit ?? 50)))
          return
        }
        // Reconcile only the same query/page: never reuse a decision from another collection.
        page = reconcileLiteraturePage(
          appliedPageRef.current?.key === pageKey ? appliedPageRef.current.page : undefined,
          page
        )
        cacheRef.current.delete(pageKey)
        dirtyKeys.current.delete(pageKey)
        cacheRef.current.set(pageKey, page)
        while (cacheRef.current.size > PAGE_CACHE_SIZE) {
          const oldestKey = cacheRef.current.keys().next().value
          if (oldestKey === undefined) break
          cacheRef.current.delete(oldestKey)
        }
        if (!cached) setCachedKeys(new Set(cacheRef.current.keys()))
        if (retained) onPage(page, request, Boolean(cached), true)
        else onPage(page, request, Boolean(cached))
        appliedPageRef.current = { key: pageKey, page }
        setLoadedKey(pageKey)
        return true
      } catch (error) {
        if (generation === generationRef.current) {
          setOversizedItemId(oversizedLiteratureReference(error))
          if (!retained) setFailedKey(pageKey)
          onError(true)
          return false
        }
      } finally {
        if (generation === generationRef.current) setLoading(false)
      }
      return undefined
    }

    const refreshItems = async (
      itemIds: string[],
      updatedItems?: LiteratureItemView[],
      includeHidden = false
    ): Promise<void> => {
      dataRevisionRef.current += 1
      const displayed = appliedPageRef.current
      const ids = new Set(itemIds)
      // Invalidate other scopes, but keep the current page and its order while it is being read.
      cacheRef.current.clear()
      dirtyKeys.current.clear()
      if (displayed) cacheRef.current.set(displayed.key, displayed.page)
      if (displayed) dirtyKeys.current.add(displayed.key)
      setCachedKeys(new Set(cacheRef.current.keys()))
      const generation = generationRef.current
      const visible = (displayed?.page.entries ?? []).flatMap((entry) =>
        'metadataRevision' in entry &&
        'id' in entry &&
        typeof entry.id === 'string' &&
        ids.has(entry.id)
          ? [entry.id]
          : []
      )
      const reading = includeHidden ? itemIds : visible
      const tickets = new Map(reading.map((id) => [id, {}]))
      for (const id of itemIds) itemReads.current.delete(id)
      for (const [id, ticket] of tickets) itemReads.current.set(id, ticket)
      try {
        const results = updatedItems
          ? []
          : await Promise.allSettled(
              reading.map(async (id) => {
                const item = await getItem(id)
                return itemReads.current.get(id) === tickets.get(id) ? item : undefined
              })
            )
        const updated =
          updatedItems ??
          results.flatMap((result) =>
            result.status === 'fulfilled' && result.value ? [result.value] : []
          )
        // Recheck at publication: a sibling response may have arrived while the batch waited.
        const accepted = updated.filter(
          (entry) => updatedItems || itemReads.current.get(entry.id) === tickets.get(entry.id)
        )
        if (!mounted.current) return
        onItems?.(accepted)
        if (generation !== generationRef.current) return
        if (results.some((result) => result.status === 'rejected')) onError(true)
        if (!displayed || appliedPageRef.current?.key !== pageKey || request.scope !== 'library')
          return
        const replacements = new Map(accepted.map((entry) => [entry.id, entry]))
        const current = appliedPageRef.current.page
        const page = reconcileLiteraturePage(current, {
          ...current,
          entries: current.entries.map((entry) =>
            'metadataRevision' in entry &&
            typeof entry.metadataRevision === 'number' &&
            'id' in entry &&
            typeof entry.id === 'string' &&
            (replacements.get(entry.id)?.metadataRevision ?? -1) >= entry.metadataRevision
              ? replacements.get(entry.id)!
              : entry
          )
        } as Page)
        cacheRef.current.set(pageKey, page)
        appliedPageRef.current = { key: pageKey, page }
        if (visible.length) onPage(page, request, true, true)
      } catch {
        onError(true)
      } finally {
        for (const [id, ticket] of tickets) {
          if (itemReads.current.get(id) === ticket) itemReads.current.delete(id)
        }
      }
    }

    return { reload, refreshItems }
  }
  return {
    bind,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    invalidate: () => {
      generationRef.current++
    },
    mount: () => {
      mounted.current = true
    },
    unmount: () => {
      mounted.current = false
      generationRef.current++
      itemReads.current.clear()
    }
  }
}
