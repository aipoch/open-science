import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { useSettingsStore } from '@/stores/settings-store'
import type {
  ArtifactGroupItem,
  ProjectFileItem,
  ProjectFileOriginSession,
  ProjectFilesChangedEvent
} from '../../../../shared/project-files'
import type { ProjectFilesFilterPreference } from '../../../../shared/settings'

import {
  FILE_PAGE_SIZE,
  useProjectFilesIndex,
  type PageState,
  type ProjectFilesIndexState,
  type ProjectFilesIndexScope
} from './use-project-files-index'

type ProjectFilesFilterOption = {
  id: string
  label: string
  count: number
  kind: 'all' | 'uploads' | 'session'
  originSession?: ProjectFileOriginSession
}

type ProjectFilesQueryModel = {
  indexes: Record<'catalogIndex' | 'index' | 'sessionOptionsIndex', ProjectFilesIndexState>
  filter: {
    effectiveFilterId: string
    filterOptions: ProjectFilesFilterOption[]
    isAllFilter: boolean
    selectFilter(filterId: string): void
    selectedFilterOption: ProjectFilesFilterOption
    setShowAllSessionOptions: Dispatch<SetStateAction<boolean>>
    showAllSessionOptions: boolean
  }
  pagination: {
    allUploadVisibleItemLimit: number
    allVisibleItemLimits: Record<string, number>
    collapsedSectionIds: Set<string>
    groupsSentinelRef: RefObject<HTMLDivElement | null>
    revealNextAllPage(
      sectionId: string,
      visibleItemLimit: number,
      page: PageState<ProjectFileItem> | undefined,
      loadMore: () => Promise<void>
    ): void
    supportsIntersectionObserver: boolean
    toggleSection(sectionId: string): void
    uploadSentinelRef: RefObject<HTMLDivElement | null>
    uploadsCollapsed: boolean
  }
  search: {
    debouncedSearchQuery: string
    isSearchActive: boolean
    searchQuery: string
    setSearchQuery: Dispatch<SetStateAction<string>>
  }
  sessions: {
    getArtifactGroupTitle(group: ArtifactGroupItem): string
    sessionById: Map<string, ChatSession>
  }
  visible: {
    hasLoadedInitialPages: boolean
    hasPageError: boolean
    showsUploadsSection: boolean
    visibleArtifactFiles: ProjectFileItem[]
    visibleArtifactGroups: ArtifactGroupItem[]
    visibleFileCount: number
    visibleUploadFiles: ProjectFileItem[]
  }
}

// Converts one stable sentinel into guarded infinite loading. The root margin starts the next page
// shortly before it becomes visible; environments without IntersectionObserver retain manual UI.
const useProjectFileInfiniteLoad = (
  enabled: boolean,
  loadMore: () => void | Promise<void>
): RefObject<HTMLDivElement | null> => {
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!enabled || !sentinel) return

    if (typeof IntersectionObserver === 'undefined') {
      void loadMore()
      return
    }

    let active = true
    const observer = new IntersectionObserver(
      (entries) => {
        if (active && entries.some((entry) => entry.isIntersecting)) void loadMore()
      },
      { rootMargin: '160px 0px' }
    )
    observer.observe(sentinel)

    return () => {
      active = false
      observer.disconnect()
    }
  }, [enabled, loadMore])

  return sentinelRef
}

// Reads the persisted Files-tab filter; the settings store is loaded before the workspace mounts.
const readPersistedProjectFilesFilter = (): ProjectFilesFilterPreference | undefined =>
  useSettingsStore.getState().projectFilesFilter

/**
 * Owns ProjectFilesView's query scopes and their presentation-neutral selection/pagination state.
 *
 * Catalog, expanded filter options, and scoped search remain separate index instances so advancing
 * one cursor never advances another. The view receives only the resulting collections, states, and
 * commands; local browsing, preview reads, and grid/list rendering stay outside this owner.
 */
const useProjectFilesQueryModel = (activeProjectId: string | undefined): ProjectFilesQueryModel => {
  const { t } = useTranslation()
  const allSessions = useSessionStore((state) => state.sessions)
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(() => new Set())
  // Restore the persisted artifact filter as initial state; an option id that no longer exists
  // falls back to the default ('all') via effectiveFilterId.
  const [selectedFilterId, setSelectedFilterId] = useState(() => {
    const persisted = readPersistedProjectFilesFilter()
    return persisted?.sourceMode === 'artifacts' && persisted.optionId ? persisted.optionId : 'all'
  })
  // Keep a restored session filter reachable while its group header is still beyond the loaded page.
  const [selectedSessionFallback, setSelectedSessionFallback] = useState<
    ProjectFilesFilterOption | undefined
  >(() => {
    const persisted = readPersistedProjectFilesFilter()
    if (persisted?.sourceMode !== 'artifacts' || !persisted.optionId?.startsWith('session:')) {
      return undefined
    }
    const sessionId = persisted.optionId.slice('session:'.length)
    const session = useSessionStore
      .getState()
      .sessions.find(
        (candidate) => candidate.projectId === activeProjectId && candidate.id === sessionId
      )
    return session
      ? {
          id: persisted.optionId,
          label: session.title,
          count: session.artifactCount ?? session.artifacts?.length ?? 0,
          kind: 'session'
        }
      : undefined
  })
  const [allVisibleItemLimits, setAllVisibleItemLimits] = useState<Record<string, number>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [showAllSessionOptions, setShowAllSessionOptions] = useState(false)

  const handleIndexChanged = useCallback(
    (event: ProjectFilesChangedEvent): void => {
      const currentSessions = useSessionStore.getState().sessions
      const changedSession = event.sessionId
        ? currentSessions.find(
            (session) => session.projectId === activeProjectId && session.id === event.sessionId
          )
        : undefined
      const changedSessionHasArtifacts = (changedSession?.artifacts ?? []).some(
        (artifact) => artifact.kind === 'managed-file' && Boolean(artifact.path)
      )

      if (
        event.kind === 'delete' &&
        event.sessionId &&
        selectedFilterId === `session:${event.sessionId}`
      ) {
        setSelectedFilterId('all')
        setSelectedSessionFallback(undefined)
      } else if (
        event.kind === 'upsert' &&
        event.sources.includes('artifact') &&
        event.sessionId &&
        changedSession &&
        selectedFilterId === `session:${event.sessionId}` &&
        !changedSessionHasArtifacts
      ) {
        // Removing the final artifact is a session upsert, so clear a selected session only after the
        // authoritative renderer session confirms that no managed artifact references remain.
        setSelectedFilterId('all')
        setSelectedSessionFallback(undefined)
      }
    },
    [activeProjectId, selectedFilterId]
  )

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchQuery(searchQuery.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [searchQuery])

  const archivedSessionIds = useSessionStore(
    useShallow((state) =>
      state.sessions
        .filter(
          (session) => session.projectId === activeProjectId && session.archivedAt !== undefined
        )
        .map((session) => session.id)
        .sort()
    )
  )
  const archivedSessionIdSet = useMemo(() => new Set(archivedSessionIds), [archivedSessionIds])
  const catalogIndex = useProjectFilesIndex(
    activeProjectId,
    handleIndexChanged,
    undefined,
    undefined,
    archivedSessionIds
  )
  // The expanded filter menu owns a separate group cursor so loading every session option does not
  // append hidden groups or trigger artifact-page reads in the visible catalog.
  const sessionOptionsIndex = useProjectFilesIndex(
    showAllSessionOptions ? activeProjectId : undefined,
    undefined,
    undefined,
    { kind: 'artifactGroups' },
    archivedSessionIds
  )
  const isSearchActive = debouncedSearchQuery.length > 0
  const sessionById = useMemo(
    () =>
      new Map(
        allSessions
          .filter(
            (session) => session.projectId === activeProjectId && session.archivedAt === undefined
          )
          .map((session) => [session.id, session] as const)
      ),
    [activeProjectId, allSessions]
  )
  const isVisibleArtifactGroup = useCallback(
    (group: ArtifactGroupItem): boolean => !archivedSessionIdSet.has(group.sessionId),
    [archivedSessionIdSet]
  )
  const getSessionTitle = useCallback(
    (sessionId: string): string =>
      sessionById.get(sessionId)?.title ?? t('Session {{id}}', { id: sessionId.slice(0, 8) }),
    [sessionById, t]
  )
  const filterGroupItems =
    showAllSessionOptions && sessionOptionsIndex.groups.items.length > 0
      ? sessionOptionsIndex.groups.items
      : catalogIndex.groups.items
  const getArtifactGroupTitle = useCallback(
    (group: ArtifactGroupItem): string => {
      const title = group.originSession?.title ?? getSessionTitle(group.sessionId)
      if (group.originSession?.state === 'deleting') {
        return t('{{title}} · Source session is being deleted', { title })
      }
      return group.originSession?.state === 'deleted'
        ? t('{{title}} · Source session deleted', { title })
        : title
    },
    [getSessionTitle, t]
  )
  const filterOptions = useMemo<ProjectFilesFilterOption[]>(() => {
    const options: ProjectFilesFilterOption[] = [
      {
        id: 'all',
        label: t('All artifacts'),
        count: catalogIndex.overview.totalCount,
        kind: 'all'
      },
      {
        id: 'uploads',
        label: t('Your uploads'),
        count: catalogIndex.overview.uploadCount,
        kind: 'uploads'
      },
      ...filterGroupItems.filter(isVisibleArtifactGroup).map((group) => ({
        id: `session:${group.sessionId}`,
        label: getArtifactGroupTitle(group),
        count: group.artifactCount,
        kind: 'session' as const,
        originSession: group.originSession
      }))
    ]

    // Keep a directly selected session reachable while a group first-page refresh is in flight or
    // while that session lies beyond the currently loaded group-header page.
    if (
      selectedSessionFallback &&
      !archivedSessionIdSet.has(selectedSessionFallback.id.slice('session:'.length)) &&
      !options.some((option) => option.id === selectedSessionFallback.id)
    ) {
      const sessionId = selectedSessionFallback.id.slice('session:'.length)
      const sessionPage = catalogIndex.artifactsBySession[sessionId]
      const originSession = sessionPage?.items.find((item) => item.originSession)?.originSession
      const count = sessionPage?.totalCount ?? selectedSessionFallback.count
      options.push({
        ...selectedSessionFallback,
        label: originSession
          ? getArtifactGroupTitle({ sessionId, artifactCount: count, originSession })
          : selectedSessionFallback.label,
        count,
        ...(originSession ? { originSession } : {})
      })
    }

    return options
  }, [
    getArtifactGroupTitle,
    catalogIndex.artifactsBySession,
    catalogIndex.overview,
    filterGroupItems,
    archivedSessionIdSet,
    isVisibleArtifactGroup,
    selectedSessionFallback,
    t
  ])
  const selectedSessionId = selectedFilterId.startsWith('session:')
    ? selectedFilterId.slice('session:'.length)
    : undefined
  const selectedSessionStillExists = selectedSessionId
    ? allSessions.some(
        (session) =>
          session.projectId === activeProjectId &&
          session.id === selectedSessionId &&
          session.archivedAt === undefined
      )
    : false
  const selectedSessionIsLoaded = selectedSessionId
    ? catalogIndex.groups.items.some(
        (group) => group.sessionId === selectedSessionId && isVisibleArtifactGroup(group)
      )
    : false
  const selectedCatalogSessionPage = selectedSessionId
    ? catalogIndex.artifactsBySession[selectedSessionId]
    : undefined
  const loadMoreCatalogArtifacts = catalogIndex.loadMoreArtifacts

  // A selected session outside the catalog's current header page still needs an authoritative first
  // file page. Loading it while collapsed keeps the toolbar count current after index resets.
  useEffect(() => {
    if (!selectedSessionId || selectedSessionIsLoaded) return
    if (selectedCatalogSessionPage?.isLoading || selectedCatalogSessionPage?.isLoaded) return

    void loadMoreCatalogArtifacts(selectedSessionId)
  }, [
    loadMoreCatalogArtifacts,
    selectedCatalogSessionPage,
    selectedSessionId,
    selectedSessionIsLoaded
  ])

  useEffect(() => {
    if (!selectedSessionId || selectedSessionStillExists || selectedSessionIsLoaded) return

    const groupsSettled =
      catalogIndex.groups.isLoaded && !catalogIndex.groups.isLoading && !catalogIndex.groups.error
    const sessionPageSettled =
      selectedCatalogSessionPage?.isLoaded &&
      !selectedCatalogSessionPage.isLoading &&
      !selectedCatalogSessionPage.error
    if (!groupsSettled || !sessionPageSettled || selectedCatalogSessionPage.totalCount > 0) return

    let canceled = false
    // A DB-only session can remain in the selected fallback after reset. Clear it only after both the
    // refreshed group headers and its independent file page confirm that no artifact rows remain.
    void Promise.resolve().then(() => {
      if (canceled) return
      setSelectedFilterId('all')
      setSelectedSessionFallback(undefined)
    })

    return () => {
      canceled = true
    }
  }, [
    catalogIndex.groups,
    selectedCatalogSessionPage,
    selectedSessionId,
    selectedSessionIsLoaded,
    selectedSessionStillExists
  ])

  const effectiveFilterId =
    filterOptions.some((option) => option.id === selectedFilterId) &&
    (!selectedSessionId ||
      selectedSessionStillExists ||
      selectedSessionIsLoaded ||
      selectedSessionFallback?.id === selectedFilterId)
      ? selectedFilterId
      : 'all'
  const selectedFilterOption =
    filterOptions.find((option) => option.id === effectiveFilterId) ?? filterOptions[0]
  const isAllFilter = selectedFilterOption.kind === 'all'
  const isUploadsFilter = selectedFilterOption.kind === 'uploads'
  const effectiveSessionId =
    selectedFilterOption.kind === 'session'
      ? selectedFilterOption.id.slice('session:'.length)
      : undefined
  const searchScope = useMemo<ProjectFilesIndexScope>(
    () =>
      isUploadsFilter
        ? { kind: 'uploads' }
        : effectiveSessionId
          ? { kind: 'sessionArtifacts', sessionId: effectiveSessionId }
          : { kind: 'all' },
    [effectiveSessionId, isUploadsFilter]
  )
  // Search follows the selected collection but leaves catalog cursors mounted, so clearing the query
  // restores the previous grouped view without rebuilding its loaded pages.
  const searchIndex = useProjectFilesIndex(
    isSearchActive ? activeProjectId : undefined,
    undefined,
    isSearchActive ? { filenameContains: debouncedSearchQuery } : undefined,
    searchScope,
    archivedSessionIds
  )
  const index = isSearchActive ? searchIndex : catalogIndex
  const uploadsCollapsed = collapsedSectionIds.has('uploads')
  const allUploadVisibleItemLimit = allVisibleItemLimits.uploads ?? FILE_PAGE_SIZE
  const visibleUploadFiles = useMemo(() => {
    if (isUploadsFilter) return index.uploads.items
    if (isAllFilter) return index.uploads.items.slice(0, allUploadVisibleItemLimit)
    return []
  }, [allUploadVisibleItemLimit, index.uploads.items, isAllFilter, isUploadsFilter])
  const visibleArtifactGroups = useMemo(
    () =>
      isAllFilter
        ? index.groups.items.filter(isVisibleArtifactGroup)
        : effectiveSessionId
          ? [
              index.groups.items.find((group) => group.sessionId === effectiveSessionId) ?? {
                sessionId: effectiveSessionId,
                artifactCount:
                  index.artifactsBySession[effectiveSessionId]?.totalCount ??
                  (isSearchActive ? 0 : selectedFilterOption.count),
                originSession: selectedFilterOption.originSession
              }
            ]
          : [],
    [
      effectiveSessionId,
      index.artifactsBySession,
      index.groups.items,
      isVisibleArtifactGroup,
      isAllFilter,
      isSearchActive,
      selectedFilterOption.count,
      selectedFilterOption.originSession
    ]
  )
  // Catalog counts remain authoritative even when a collapsed section has not loaded its file page.
  // Search counts come from the scoped search index because they describe matches, not the catalog.
  const visibleFileCount = isSearchActive
    ? isAllFilter
      ? index.overview.totalCount
      : isUploadsFilter
        ? index.uploads.totalCount
        : ((effectiveSessionId
            ? index.artifactsBySession[effectiveSessionId]?.totalCount
            : undefined) ?? 0)
    : selectedFilterOption.count
  const visibleArtifactFiles = useMemo(
    () =>
      visibleArtifactGroups.flatMap((group) => {
        if (collapsedSectionIds.has(`session:${group.sessionId}`)) return []
        const items = index.artifactsBySession[group.sessionId]?.items ?? []
        if (!isAllFilter) return items

        const visibleItemLimit =
          allVisibleItemLimits[`session:${group.sessionId}`] ?? FILE_PAGE_SIZE
        return items.slice(0, visibleItemLimit)
      }),
    [
      allVisibleItemLimits,
      collapsedSectionIds,
      index.artifactsBySession,
      isAllFilter,
      visibleArtifactGroups
    ]
  )

  const toggleSection = (sectionId: string): void => {
    setCollapsedSectionIds((currentIds) => {
      const nextIds = new Set(currentIds)
      if (nextIds.has(sectionId)) nextIds.delete(sectionId)
      else nextIds.add(sectionId)
      return nextIds
    })
  }

  const selectFilter = (filterId: string): void => {
    setSelectedFilterId(filterId)
    const option = filterOptions.find((item) => item.id === filterId)
    setSelectedSessionFallback(option?.kind === 'session' ? option : undefined)
  }

  const revealNextAllPage = (
    sectionId: string,
    visibleItemLimit: number,
    page: PageState<ProjectFileItem> | undefined,
    loadMore: () => Promise<void>
  ): void => {
    // Reveal already-fetched rows first. Only cross the DB cursor when the next local batch is not yet
    // present, preserving the requirement that every All-view section advances in explicit steps of 20.
    const nextVisibleItemLimit = visibleItemLimit + FILE_PAGE_SIZE
    setAllVisibleItemLimits((current) => ({
      ...current,
      [sectionId]: Math.max(current[sectionId] ?? FILE_PAGE_SIZE, nextVisibleItemLimit)
    }))

    if ((page?.items.length ?? 0) < nextVisibleItemLimit && page?.nextCursor) void loadMore()
  }

  const supportsIntersectionObserver = typeof IntersectionObserver !== 'undefined'
  const uploadSentinelRef = useProjectFileInfiniteLoad(
    // The upload sentinel is active only in the dedicated category. All mode remains button-driven so
    // scrolling the page cannot silently expand every uploads/session section.
    !uploadsCollapsed &&
      supportsIntersectionObserver &&
      isUploadsFilter &&
      visibleUploadFiles.length > 0 &&
      !index.uploads.isLoading &&
      !index.uploads.error &&
      Boolean(index.uploads.nextCursor),
    index.loadMoreUploads
  )
  const groupsSentinelRef = useProjectFileInfiniteLoad(
    // Group headers have their own cursor because loading another session must not advance any file page.
    isAllFilter &&
      supportsIntersectionObserver &&
      !index.groups.isLoading &&
      !index.groups.error &&
      Boolean(index.groups.nextCursor),
    index.loadMoreGroups
  )
  const selectedSessionPage = effectiveSessionId
    ? index.artifactsBySession[effectiveSessionId]
    : undefined
  const hasLoadedInitialPages = isAllFilter
    ? index.isOverviewLoaded && index.uploads.isLoaded && index.groups.isLoaded
    : isUploadsFilter
      ? index.uploads.isLoaded
      : Boolean(selectedSessionPage?.isLoaded)
  const hasPageError = isAllFilter
    ? Boolean(index.overviewError || index.uploads.error || index.groups.error)
    : isUploadsFilter
      ? Boolean(index.uploads.error)
      : Boolean(selectedSessionPage?.error)
  const showsUploadsSection =
    (isAllFilter || isUploadsFilter) &&
    (index.uploads.totalCount > 0 || Boolean(index.uploads.error))

  return {
    indexes: { catalogIndex, index, sessionOptionsIndex },
    filter: {
      effectiveFilterId,
      filterOptions,
      isAllFilter,
      selectFilter,
      selectedFilterOption,
      setShowAllSessionOptions,
      showAllSessionOptions
    },
    pagination: {
      allUploadVisibleItemLimit,
      allVisibleItemLimits,
      collapsedSectionIds,
      groupsSentinelRef,
      revealNextAllPage,
      supportsIntersectionObserver,
      toggleSection,
      uploadSentinelRef,
      uploadsCollapsed
    },
    search: { debouncedSearchQuery, isSearchActive, searchQuery, setSearchQuery },
    sessions: { getArtifactGroupTitle, sessionById },
    visible: {
      hasLoadedInitialPages,
      hasPageError,
      showsUploadsSection,
      visibleArtifactFiles,
      visibleArtifactGroups,
      visibleFileCount,
      visibleUploadFiles
    }
  }
}

export { readPersistedProjectFilesFilter, useProjectFileInfiniteLoad, useProjectFilesQueryModel }
export type { ProjectFilesFilterOption }
