import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { resultId, type SearchCategory, type SearchResult } from './search-result'
import type {
  LiteratureCollectionView,
  LiteratureItemView,
  LiteratureAnnotationSearchView
} from '../../../../shared/literature'
import type { SearchFileFormat, SearchSort } from '../../../../shared/search-text'
import { readLiteratureSelectionPage } from '@/pages/literature/literature-read-pages'
import { useLiteratureChanges } from '@/pages/literature/useLiteratureChanges'

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
type SearchScope = {
  category?: SearchCategory | 'all'
  projectIds: string[]
  excludedSessionIds: string[]
  projectId?: string
  updatedAfter?: number
  sort?: SearchSort
  role?: 'user' | 'agent'
  format?: SearchFileFormat
  entryKind?: 'paper' | 'collection' | 'pdf' | 'note'
}
// Displaying a different category does not change the other categories' queries or cursors.
const categoryScope = (category: RemoteCategory, scope: SearchScope): string =>
  JSON.stringify({
    ...(category === 'library'
      ? { projectId: scope.projectId }
      : { projectIds: scope.projectIds, excludedSessionIds: scope.excludedSessionIds }),
    updatedAfter: scope.updatedAfter,
    sort: scope.sort,
    ...(category === 'messages' ? { role: scope.role } : {}),
    ...(category === 'uploads' || category === 'generated'
      ? { format: scope.category === category ? scope.format : undefined }
      : {}),
    ...(category === 'library' ? { entryKind: scope.entryKind } : {})
  })
const isLibraryEntry = (
  entry: unknown
): entry is LiteratureItemView | LiteratureCollectionView | LiteratureAnnotationSearchView =>
  typeof entry === 'object' &&
  entry !== null &&
  ('annotation' in entry ||
    'metadataRevision' in entry ||
    ('itemCount' in entry && 'name' in entry))

export const hasMoreSearchResults = (category: SearchCategory, page: SearchPage): boolean =>
  isRemoteCategory(category)
    ? page.cursor !== undefined || page.offset !== undefined
    : page.items.length < page.totalCount

const useSearchPage = (
  category: RemoteCategory,
  open: boolean,
  ready: boolean,
  query: string,
  scopeKey: string,
  clientId: string
): { page: SearchPage; load: (append?: boolean) => Promise<void>; refresh: () => void } => {
  const identity = JSON.stringify([open, ready, query, scopeKey])
  const [activeIdentity, setActiveIdentity] = useState(identity)
  const [page, setPage] = useState(() => ({ ...emptySearchPage(), loading: open && ready }))
  if (identity !== activeIdentity) {
    setActiveIdentity(identity)
    setPage({ ...emptySearchPage(), loading: open && ready })
  }
  const pageRef = useRef(page)
  useLayoutEffect(() => {
    pageRef.current = page
  }, [page])
  const generation = useRef(0)
  const pending = useRef(false)
  useLayoutEffect(() => {
    const version = generation
    version.current++
    pending.current = false
    return () => {
      version.current++
    }
  }, [identity])

  const load = useCallback(
    async (append = false) => {
      if (!open || !ready || pending.current) return
      const version = generation.current
      const isCurrent = (): boolean => generation.current === version
      const previous = append ? pageRef.current : emptySearchPage()
      if (append && !hasMoreSearchResults(category, previous)) return
      pending.current = true
      setPage({ ...previous, loading: true, error: false })
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
        } = JSON.parse(scopeKey) as SearchScope
        let page: SearchPage = emptySearchPage()
        if (category === 'library') {
          const result = await readLiteratureSelectionPage(
            {
              scope: 'global-search',
              query,
              projectId,
              updatedAfter,
              searchSort: sort,
              entryKind,
              limit: 10,
              offset: append ? previous.offset : undefined
            },
            isCurrent
          )
          page = {
            ...page,
            items: result.entries.filter(isLibraryEntry).map((item) => ({ kind: 'library', item })),
            totalCount: result.totalCount ?? result.entries.length,
            offset: result.nextOffset
          }
        } else if (projectIds.length > 0 && category === 'messages') {
          const result = await window.api.sessions.searchMessages({
            clientId,
            projectIds,
            excludedSessionIds,
            updatedAfter,
            sort,
            role,
            query,
            limit: 10,
            cursor: append ? previous.cursor : undefined
          })
          page = {
            ...page,
            items: result.items.map((item) => ({ kind: 'messages', item })),
            totalCount: result.totalCount,
            cursor: result.nextCursor,
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
        if (!isCurrent()) return
        const previousIds = new Set(previous.items.map(resultId))
        setPage({
          ...page,
          items: append
            ? [...previous.items, ...page.items.filter((item) => !previousIds.has(resultId(item)))]
            : page.items
        })
      } catch {
        if (isCurrent()) setPage({ ...previous, loading: false, error: true })
      } finally {
        if (isCurrent()) pending.current = false
      }
    },
    [category, open, ready, query, scopeKey, clientId]
  )

  useEffect(() => {
    if (!open || !ready) return
    const timer = window.setTimeout(() => void load(), query ? 150 : 0)
    return () => window.clearTimeout(timer)
  }, [open, ready, query, load])

  const refresh = useCallback(() => {
    generation.current++
    pending.current = false
    void load()
  }, [load])
  return { page, load, refresh }
}

export const useSearchResults = (
  open: boolean,
  ready: boolean,
  query: string,
  scopeKey: string
): {
  pages: Record<RemoteCategory, SearchPage>
  load: (category: RemoteCategory, append?: boolean) => Promise<void>
} => {
  const [clientId] = useState(() => crypto.randomUUID())
  const scope = JSON.parse(scopeKey) as SearchScope
  const messages = useSearchPage(
    'messages',
    open,
    ready,
    query,
    categoryScope('messages', scope),
    clientId
  )
  const uploads = useSearchPage(
    'uploads',
    open,
    ready,
    query,
    categoryScope('uploads', scope),
    clientId
  )
  const generated = useSearchPage(
    'generated',
    open,
    ready,
    query,
    categoryScope('generated', scope),
    clientId
  )
  const library = useSearchPage(
    'library',
    open,
    ready,
    query,
    categoryScope('library', scope),
    clientId
  )
  useLiteratureChanges(library.refresh)
  useEffect(() => {
    if (!open) return undefined
    return window.api.pdfAnnotations?.onChanged?.(library.refresh)
  }, [open, library.refresh])
  const loads = useMemo(
    () => ({
      messages: messages.load,
      uploads: uploads.load,
      generated: generated.load,
      library: library.load
    }),
    [messages.load, uploads.load, generated.load, library.load]
  )
  const load = useCallback(
    (category: RemoteCategory, append = false) => loads[category](append),
    [loads]
  )
  const pages = useMemo(
    () => ({
      messages: messages.page,
      uploads: uploads.page,
      generated: generated.page,
      library: library.page
    }),
    [messages.page, uploads.page, generated.page, library.page]
  )
  return { pages, load }
}
export const isRemoteCategory = (category: SearchCategory): category is RemoteCategory =>
  remoteCategories.some((value) => value === category)
