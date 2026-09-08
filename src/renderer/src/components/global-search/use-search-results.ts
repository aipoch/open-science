import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { resultId, type SearchCategory, type SearchResult } from './search-result'
import type { LiteratureCollectionView, LiteratureItemView } from '../../../../shared/literature'
import type { SearchFileFormat, SearchSort } from '../../../../shared/search-text'

export type SearchPage = {
  items: SearchResult[]
  totalCount: number
  cursor?: string
  offset?: number
  loading: boolean
  error: boolean
  incomplete: boolean
}
export const emptySearchPage = (): SearchPage => ({
  items: [],
  totalCount: 0,
  loading: false,
  error: false,
  incomplete: false
})
const remoteCategories = ['messages', 'uploads', 'generated', 'library'] as const
export type RemoteCategory = (typeof remoteCategories)[number]
const emptyPages = (loading = false): Record<RemoteCategory, SearchPage> =>
  Object.fromEntries(
    remoteCategories.map((key) => [key, { ...emptySearchPage(), loading }])
  ) as Record<RemoteCategory, SearchPage>
const isLibraryEntry = (entry: unknown): entry is LiteratureItemView | LiteratureCollectionView =>
  typeof entry === 'object' &&
  entry !== null &&
  ('metadataRevision' in entry || ('itemCount' in entry && 'name' in entry))

export const hasMoreSearchResults = (category: SearchCategory, page: SearchPage): boolean =>
  isRemoteCategory(category)
    ? page.cursor !== undefined || page.offset !== undefined
    : page.items.length < page.totalCount

export const useSearchResults = (
  open: boolean,
  ready: boolean,
  query: string,
  scopeKey: string
): {
  pages: Record<RemoteCategory, SearchPage>
  load: (category: RemoteCategory, append?: boolean) => Promise<void>
} => {
  const identity = JSON.stringify([open, ready, query, scopeKey])
  const [activeIdentity, setActiveIdentity] = useState(identity)
  const [pages, setPages] = useState(() => emptyPages(open && ready))
  if (identity !== activeIdentity) {
    setActiveIdentity(identity)
    setPages(emptyPages(open && ready))
  }
  const pagesRef = useRef(pages)
  useLayoutEffect(() => {
    pagesRef.current = pages
  }, [pages])
  const generation = useRef(0)
  const pending = useRef(new Set<RemoteCategory>())
  useLayoutEffect(() => {
    const version = generation
    version.current++
    pending.current = new Set()
    return () => {
      version.current++
    }
  }, [open, ready, query, scopeKey])

  const load = useCallback(
    async (category: RemoteCategory, append = false) => {
      if (!open || !ready || pending.current.has(category)) return
      const version = generation.current
      const previous = append ? pagesRef.current[category] : emptySearchPage()
      if (append && !hasMoreSearchResults(category, previous)) return
      pending.current.add(category)
      setPages((state) => ({ ...state, [category]: { ...previous, loading: true, error: false } }))
      try {
        const {
          projectIds,
          excludedSessionIds,
          projectId,
          updatedAfter,
          sort,
          role,
          format,
          entryKind
        } = JSON.parse(scopeKey) as {
          projectIds: string[]
          excludedSessionIds: string[]
          projectId?: string
          updatedAfter?: number
          sort?: SearchSort
          role?: 'user' | 'agent'
          format?: SearchFileFormat
          entryKind?: 'paper' | 'collection' | 'pdf'
        }
        let page: SearchPage = emptySearchPage()
        if (category === 'library') {
          const result = await window.api.literature.search({
            scope: 'global-search',
            query,
            projectId,
            updatedAfter,
            searchSort: sort,
            entryKind,
            limit: 10,
            offset: append ? previous.offset : undefined
          })
          page = {
            ...page,
            items: result.entries.filter(isLibraryEntry).map((item) => ({ kind: 'library', item })),
            totalCount: result.totalCount ?? result.entries.length,
            offset: result.nextOffset
          }
        } else if (projectIds.length > 0 && category === 'messages') {
          const result = await window.api.sessions.searchMessages({
            projectIds,
            excludedSessionIds,
            updatedAfter,
            sort,
            role,
            query,
            limit: 10,
            offset: append ? previous.offset : undefined
          })
          page = {
            ...page,
            items: result.items.map((item) => ({ kind: 'messages', item })),
            totalCount: result.totalCount,
            offset: result.nextOffset,
            incomplete: !result.isComplete
          }
        } else if (projectIds.length > 0 && (category === 'uploads' || category === 'generated')) {
          const result = await window.api.projectFiles.searchArtifacts({
            primaryProjectIds: projectIds,
            otherProjectIds: [],
            excludedSessionIds,
            filenameContains: query,
            searchContent: category === 'uploads',
            updatedAfter,
            sort,
            format,
            source: category === 'uploads' ? 'upload' : 'artifact',
            primaryLimit: 10,
            primaryCursor: append ? previous.cursor : undefined,
            otherLimit: 0
          })
          page = {
            ...page,
            items: result.primary.items.map((item) => ({ kind: category, item })),
            totalCount: result.primary.totalCount,
            cursor: result.primary.nextCursor,
            incomplete: !result.isIndexComplete
          }
        }
        if (generation.current !== version) return
        const previousIds = new Set(previous.items.map(resultId))
        setPages((state) => ({
          ...state,
          [category]: {
            ...page,
            items: append
              ? [
                  ...previous.items,
                  ...page.items.filter((item) => !previousIds.has(resultId(item)))
                ]
              : page.items
          }
        }))
      } catch {
        if (generation.current === version)
          setPages((state) => ({
            ...state,
            [category]: { ...previous, loading: false, error: true }
          }))
      } finally {
        if (generation.current === version) pending.current.delete(category)
      }
    },
    [open, ready, query, scopeKey]
  )

  useEffect(() => {
    if (!open || !ready) return
    const timer = window.setTimeout(
      () => {
        for (const category of remoteCategories) void load(category)
      },
      query ? 150 : 0
    )
    return () => window.clearTimeout(timer)
  }, [open, ready, query, scopeKey, load])
  return { pages, load }
}
export const isRemoteCategory = (category: SearchCategory): category is RemoteCategory =>
  remoteCategories.some((value) => value === category)
