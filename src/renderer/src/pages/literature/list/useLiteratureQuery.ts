import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  LiteratureCatalogSearchPage,
  LiteratureCatalogSearchRequest,
  LiteratureCollectionView,
  LiteratureInboxCandidateView,
  LiteratureItemType,
  LiteratureItemView,
  LiteratureProjectCountView
} from '../../../../../shared/literature'
import type { SmartCollectionView } from '../../../../../shared/literature-smart-collections'
import { type LibrarySection } from './LiteratureLibrarySidebar'
import { useLiteratureEntries } from './useLiteratureEntries'
import { useLiteratureTable } from './useLiteratureTable'
const literatureSorts = {
  updated: { sortBy: 'updated', sortDirection: 'desc' },
  created: { sortBy: 'created', sortDirection: 'desc' },
  'created-asc': { sortBy: 'created', sortDirection: 'asc' },
  title: { sortBy: 'title', sortDirection: 'asc' },
  'title-desc': { sortBy: 'title', sortDirection: 'desc' },
  year: { sortBy: 'year', sortDirection: 'desc' },
  'year-asc': { sortBy: 'year', sortDirection: 'asc' },
  rating: { sortBy: 'rating', sortDirection: 'desc' }
} as const satisfies Record<
  string,
  Pick<LiteratureCatalogSearchRequest, 'sortBy' | 'sortDirection'>
>

const LITERATURE_DEFAULT_PAGE_SIZE = 25

type LiteraturePageSize = 25 | 50 | 100
export type LiteratureSort = keyof typeof literatureSorts

const isItem = (entry: unknown): entry is LiteratureItemView =>
  typeof entry === 'object' && entry !== null && 'item' in entry && 'metadataRevision' in entry

const isCandidate = (entry: unknown): entry is LiteratureInboxCandidateView =>
  typeof entry === 'object' && entry !== null && 'candidate' in entry && 'state' in entry

const isCollection = (entry: unknown): entry is LiteratureCollectionView =>
  typeof entry === 'object' && entry !== null && 'itemCount' in entry && 'name' in entry

const isProjectCount = (entry: unknown): entry is LiteratureProjectCountView =>
  typeof entry === 'object' && entry !== null && 'projectId' in entry && 'itemCount' in entry

import type { LiteratureDetailController } from '../detail/LiteratureDetailController'

/** Own catalog snapshots, query generations and paging while keeping the shared entries cache authoritative. */
export function useLiteratureQuery({
  pendingDecisionsRef,
  collectionId,
  smartView,
  section,
  inboxState,
  smartFilter,
  smartDecisionSource,
  projectId,
  query,
  tagId,
  sortBy,
  filterItemType,
  filterYearFrom,
  filterYearTo,
  filterHasPdf,
  journalAttributeFilters,
  tableScrollRef,
  setError,
  detailController,
  duplicatesOpen
}: {
  pendingDecisionsRef: React.RefObject<Set<string>>
  collectionId: string | undefined
  smartView: SmartCollectionView | undefined
  section: LibrarySection
  inboxState: 'pending' | 'dismissed'
  smartFilter: 'review' | 'match' | 'no-match' | 'pending'
  smartDecisionSource: 'ai' | 'manual' | 'all'
  projectId: string | undefined
  query: string
  tagId: string
  sortBy:
    'title' | 'rating' | 'year' | 'updated' | 'created' | 'created-asc' | 'title-desc' | 'year-asc'
  filterItemType: LiteratureItemType | 'all'
  filterYearFrom: string
  filterYearTo: string
  filterHasPdf: 'with' | 'all' | 'without'
  journalAttributeFilters: ReturnType<typeof useLiteratureTable>['journalAttributeFilters']
  tableScrollRef: React.RefObject<HTMLDivElement | null>
  setError: React.Dispatch<React.SetStateAction<string | undefined>>
  detailController: LiteratureDetailController
  duplicatesOpen: boolean
}): {
  items: LiteratureItemView[]
  setItems: React.Dispatch<React.SetStateAction<LiteratureItemView[]>>
  candidates: LiteratureInboxCandidateView[]
  setCandidates: React.Dispatch<React.SetStateAction<LiteratureInboxCandidateView[]>>
  inboxPendingCount: number | undefined
  setInboxPendingCount: React.Dispatch<React.SetStateAction<number | undefined>>
  inboxDismissedCount: number | undefined
  setInboxDismissedCount: React.Dispatch<React.SetStateAction<number | undefined>>
  collections: LiteratureCollectionView[]
  setCollections: React.Dispatch<React.SetStateAction<LiteratureCollectionView[]>>
  projectItemCounts: Record<string, number>
  setProjectItemCounts: React.Dispatch<React.SetStateAction<Record<string, number>>>
  entriesPageSize: 100 | 25 | 50
  setEntriesPageSize: React.Dispatch<React.SetStateAction<100 | 25 | 50>>
  entriesOffset: number
  setEntriesOffset: React.Dispatch<React.SetStateAction<number>>
  rowNumbers: Map<string, number>
  entriesTotalCount: number
  setEntriesTotalCount: React.Dispatch<React.SetStateAction<number>>
  nextEntriesOffset: number | undefined
  collectionsGenerationRef: React.RefObject<number>
  loadCollections: () => Promise<LiteratureCollectionView[] | undefined>
  loadInboxCounts: () => Promise<void>
  loadProjectCounts: () => Promise<void>
  selectedCollection: LiteratureCollectionView | undefined
  smartSetup: boolean
  entriesKey: string
  linkScopeRef: React.RefObject<string>
  buildEntriesRequest: (offset?: number) => LiteratureCatalogSearchRequest
  oversizedItemId: string | undefined
  entriesLoading: boolean
  entriesFailed: boolean
  entriesPageTransitionLoading: boolean
  reloadEntries: (force?: boolean, preservePage?: boolean) => Promise<boolean | undefined>
  refreshItems: (
    itemIds: string[],
    updatedItems?: LiteratureItemView[],
    includeHidden?: boolean
  ) => Promise<void>
} {
  const { t } = useTranslation()
  const [items, setItems] = useState<LiteratureItemView[]>([])
  const [candidates, setCandidates] = useState<LiteratureInboxCandidateView[]>([])
  const [inboxPendingCount, setInboxPendingCount] = useState<number>()
  const [inboxDismissedCount, setInboxDismissedCount] = useState<number>()
  const [collections, setCollections] = useState<LiteratureCollectionView[]>([])
  const [projectItemCounts, setProjectItemCounts] = useState<Record<string, number>>({})
  const [entriesPageSize, setEntriesPageSize] = useState<LiteraturePageSize>(
    LITERATURE_DEFAULT_PAGE_SIZE
  )
  const [entriesOffset, setEntriesOffset] = useState(0)
  const rowNumbers = useMemo(
    () => new Map(items.map((item, index) => [item.id, entriesOffset + index + 1])),
    [items, entriesOffset]
  )
  const [entriesTotalCount, setEntriesTotalCount] = useState(0)
  const [nextEntriesOffset, setNextEntriesOffset] = useState<number>()
  const collectionsGenerationRef = useRef(0)
  const loadCollections = useCallback(async (): Promise<LiteratureCollectionView[] | undefined> => {
    if (pendingDecisionsRef.current.size) return
    const generation = ++collectionsGenerationRef.current
    const collections: LiteratureCollectionView[] = []
    let offset: number | undefined = 0
    do {
      const page = await window.api.literature.search({ scope: 'collections', limit: 100, offset })
      if (generation !== collectionsGenerationRef.current) return
      collections.push(...page.entries.filter(isCollection))
      offset = page.nextOffset
    } while (offset !== undefined)
    setCollections(collections)
    return collections
  }, [pendingDecisionsRef])
  const inboxCountGeneration = useRef(0)
  const loadInboxCounts = useCallback(async (): Promise<void> => {
    const generation = ++inboxCountGeneration.current
    await Promise.all(
      (['pending', 'dismissed'] as const).map(async (state) => {
        const page = await window.api.literature.search({
          scope: 'inbox',
          inboxState: state,
          limit: 1
        })
        if (generation !== inboxCountGeneration.current) return
        const count = page.totalCount ?? page.entries.length
        if (state === 'pending') setInboxPendingCount(count)
        else setInboxDismissedCount(count)
      })
    )
  }, [])
  const projectCountsGenerationRef = useRef(0)
  const loadProjectCounts = useCallback(async (): Promise<void> => {
    const generation = ++projectCountsGenerationRef.current
    const page = await window.api.literature.search({ scope: 'project-counts' })
    if (generation !== projectCountsGenerationRef.current) return
    setProjectItemCounts(
      Object.fromEntries(
        page.entries
          .filter(isProjectCount)
          .map(({ projectId, itemCount }) => [projectId, itemCount])
      )
    )
  }, [])
  const selectedCollection = useMemo(
    () => collections.find((collection) => collection.id === collectionId),
    [collectionId, collections]
  )
  const smartSetup = Boolean(
    selectedCollection?.smart && !smartView?.configured && !smartView?.run && !smartView?.matches
  )
  const entriesKey = useMemo(
    () =>
      JSON.stringify({
        section,
        inboxState,
        collectionId,
        smartFilter,
        smartDecisionSource,
        projectId,
        query,
        tagId,
        sortBy,
        filterItemType,
        filterYearFrom,
        filterYearTo,
        filterHasPdf,
        journalAttributeFilters,
        entriesPageSize
      }),
    [
      collectionId,
      smartFilter,
      smartDecisionSource,
      filterHasPdf,
      journalAttributeFilters,
      entriesPageSize,
      filterItemType,
      filterYearFrom,
      filterYearTo,
      inboxState,
      query,
      projectId,
      section,
      sortBy,
      tagId
    ]
  )
  const linkScopeRef = useRef(entriesKey)
  useLayoutEffect(() => {
    linkScopeRef.current = entriesKey
    return () => {
      linkScopeRef.current = ''
    }
  }, [entriesKey])
  const buildEntriesRequest = useCallback(
    (offset = entriesOffset): LiteratureCatalogSearchRequest =>
      section === 'inbox'
        ? {
            scope: 'inbox',
            inboxState,
            query,
            offset,
            limit: entriesPageSize
          }
        : {
            scope: 'library',
            collectionId: section === 'library' ? collectionId : undefined,
            smartFilter: selectedCollection?.smart ? smartFilter : undefined,
            ...(selectedCollection?.smart && smartDecisionSource !== 'all'
              ? { smartDecisionSource }
              : {}),
            projectId: section === 'library' ? projectId : undefined,
            query,
            lifecycle: section === 'trash' ? 'deleted' : 'active',
            ...literatureSorts[sortBy],
            tagId: tagId === 'all' ? undefined : tagId,
            filter: {
              ...(filterItemType !== 'all' ? { itemTypes: [filterItemType] } : {}),
              ...(filterYearFrom ? { yearFrom: Number(filterYearFrom) } : {}),
              ...(filterYearTo ? { yearTo: Number(filterYearTo) } : {}),
              ...(filterHasPdf !== 'all' ? { hasFullText: filterHasPdf === 'with' } : {}),
              ...(journalAttributeFilters.length
                ? { journalAttributes: journalAttributeFilters }
                : {})
            },
            offset,
            limit: entriesPageSize
          },
    [
      collectionId,
      selectedCollection?.smart,
      smartFilter,
      smartDecisionSource,
      entriesOffset,
      entriesPageSize,
      filterHasPdf,
      journalAttributeFilters,
      filterItemType,
      filterYearFrom,
      filterYearTo,
      inboxState,
      query,
      projectId,
      section,
      sortBy,
      tagId
    ]
  )
  const receiveEntries = useCallback(
    (
      page: LiteratureCatalogSearchPage,
      request: LiteratureCatalogSearchRequest,
      _fromCache: boolean,
      preservePosition = false
    ): void => {
      if (request.scope === 'inbox') setCandidates(page.entries.filter(isCandidate))
      else setItems(page.entries.filter(isItem))
      setNextEntriesOffset(page.nextOffset)
      const totalCount =
        page.totalCount ??
        (request.offset ?? 0) + page.entries.length + (page.nextOffset === undefined ? 0 : 1)
      setEntriesTotalCount(totalCount)
      if (request.scope === 'inbox' && !request.query) {
        if (request.inboxState === 'pending') setInboxPendingCount(totalCount)
        else if (request.inboxState === 'dismissed') setInboxDismissedCount(totalCount)
      }
      if (
        request.scope === 'library' &&
        request.projectId &&
        !request.collectionId &&
        !request.query &&
        request.lifecycle === 'active' &&
        !request.tagId &&
        (!request.filter || Object.keys(request.filter).length === 0)
      ) {
        setProjectItemCounts((current) => ({ ...current, [request.projectId!]: totalCount }))
      }
      if (!preservePosition && tableScrollRef.current) tableScrollRef.current.scrollTop = 0
    },
    [tableScrollRef]
  )
  const receiveEntriesError = useCallback(
    (failed: boolean): void => setError(failed ? t('Literature could not be loaded.') : undefined),
    [t, setError]
  )
  const receiveItems = useCallback(
    (updated: LiteratureItemView[]): void => {
      updated.forEach((item) => detailController.replace(item))
    },
    [detailController]
  )
  const entriesRequest = useMemo(() => buildEntriesRequest(), [buildEntriesRequest])
  const {
    oversizedItemId,
    loading: entriesLoading,
    failed: entriesFailed,
    pageTransitionLoading: entriesPageTransitionLoading,
    reload: reloadEntries,
    refreshItems
  } = useLiteratureEntries({
    enabled: !duplicatesOpen,
    request: entriesRequest,
    scopeKey: entriesKey,
    onPage: receiveEntries,
    onItems: receiveItems,
    onEmptyPage: setEntriesOffset,
    onError: receiveEntriesError
  })
  return {
    items,
    setItems,
    candidates,
    setCandidates,
    inboxPendingCount,
    setInboxPendingCount,
    inboxDismissedCount,
    setInboxDismissedCount,
    collections,
    setCollections,
    projectItemCounts,
    setProjectItemCounts,
    entriesPageSize,
    setEntriesPageSize,
    entriesOffset,
    setEntriesOffset,
    rowNumbers,
    entriesTotalCount,
    setEntriesTotalCount,
    nextEntriesOffset,
    collectionsGenerationRef,
    loadCollections,
    loadInboxCounts,
    loadProjectCounts,
    selectedCollection,
    smartSetup,
    entriesKey,
    linkScopeRef,
    buildEntriesRequest,
    oversizedItemId,
    entriesLoading,
    entriesFailed,
    entriesPageTransitionLoading,
    reloadEntries,
    refreshItems
  }
}
