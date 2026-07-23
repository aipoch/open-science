import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type {
  ArtifactGroupItem,
  ProjectFileItem,
  ProjectFilesChangedEvent,
  ProjectFilesOverview
} from '../../../../shared/project-files'

const FILE_PAGE_SIZE = 20
const GROUP_PAGE_SIZE = 10

// Each cursor layer owns its loading and retry state. failedCursor distinguishes retrying the first
// page (replace) from retrying a continuation page (append) without coupling the three collections.
type PageState<Item> = {
  items: Item[]
  nextCursor?: string
  totalCount: number
  isLoading: boolean
  isLoaded: boolean
  error?: string
  failedCursor?: string
}

type ProjectFilesIndexState = {
  overview: ProjectFilesOverview
  overviewError?: string
  isRepairing: boolean
  repairError?: string
  uploads: PageState<ProjectFileItem>
  groups: PageState<ArtifactGroupItem>
  artifactsBySession: Record<string, PageState<ProjectFileItem> | undefined>
  loadMoreUploads(): Promise<void>
  loadMoreGroups(): Promise<void>
  loadMoreArtifacts(sessionId: string): Promise<void>
  repairIndex(): Promise<void>
  reload(): void
}

type IndexRepairState = {
  projectId?: string
  isRepairing: boolean
  error?: string
}

const EMPTY_OVERVIEW: ProjectFilesOverview = {
  totalCount: 0,
  uploadCount: 0,
  artifactCount: 0,
  artifactGroupCount: 0,
  isIndexComplete: true
}

const emptyPage = <Item>(): PageState<Item> => ({
  items: [],
  totalCount: 0,
  isLoading: false,
  isLoaded: false
})

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Could not load project files.'

type RequestLimiter = <Result>(task: () => Promise<Result>) => Promise<Result>

// Bounds aggregate Files IPC pressure when several expanded session groups request pages together.
// Tasks remain FIFO, and completion immediately pumps the next queued request.
const createRequestLimiter = (maxConcurrency: number): RequestLimiter => {
  let activeCount = 0
  const pending: Array<() => void> = []

  const pump = (): void => {
    while (activeCount < maxConcurrency) {
      const run = pending.shift()
      if (!run) return
      activeCount += 1
      run()
    }
  }

  return <Result>(task: () => Promise<Result>): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      pending.push(() => {
        void task()
          .then(resolve, reject)
          .finally(() => {
            activeCount -= 1
            pump()
          })
      })
      pump()
    })
}

const appendUnique = <Item>(
  current: Item[],
  incoming: Item[],
  getId: (item: Item) => string
): Item[] => {
  const ids = new Set(current.map(getId))
  return [...current, ...incoming.filter((item) => !ids.has(getId(item)))]
}

type InitialProjectFilesLoad = {
  projectId: string
  requestLimiter: RequestLimiter
  isOverviewCurrent: () => boolean
  isUploadsCurrent: () => boolean
  isGroupsCurrent: () => boolean
  setOverview: Dispatch<SetStateAction<ProjectFilesOverview>>
  setOverviewError: Dispatch<SetStateAction<string | undefined>>
  setUploads: Dispatch<SetStateAction<PageState<ProjectFileItem>>>
  setGroups: Dispatch<SetStateAction<PageState<ArtifactGroupItem>>>
}

// Runs overview, uploads, and artifact-group first pages independently. Lifecycle predicates are
// supplied by the owning hook so a project switch can discard each response without cancelable IPC.
const startInitialProjectFilesLoad = ({
  projectId,
  requestLimiter,
  isOverviewCurrent,
  isUploadsCurrent,
  isGroupsCurrent,
  setOverview,
  setOverviewError,
  setUploads,
  setGroups
}: InitialProjectFilesLoad): void => {
  void window.api.projectFiles
    .getOverview({ projectId })
    .then((nextOverview) => {
      if (isOverviewCurrent()) setOverview(nextOverview)
    })
    .catch((error: unknown) => {
      if (isOverviewCurrent()) setOverviewError(getErrorMessage(error))
    })

  void requestLimiter(() =>
    isUploadsCurrent()
      ? window.api.projectFiles.listFiles({
          projectId,
          collection: { kind: 'uploads' },
          limit: FILE_PAGE_SIZE
        })
      : Promise.reject(new Error('Stale project files request.'))
  )
    .then((page) => {
      if (!isUploadsCurrent()) return
      setUploads({ ...page, isLoading: false, isLoaded: true, failedCursor: undefined })
    })
    .catch((error: unknown) => {
      if (!isUploadsCurrent()) return
      setUploads({ ...emptyPage(), isLoaded: true, error: getErrorMessage(error) })
    })

  void requestLimiter(() =>
    isGroupsCurrent()
      ? window.api.projectFiles.listArtifactGroups({ projectId, limit: GROUP_PAGE_SIZE })
      : Promise.reject(new Error('Stale project files request.'))
  )
    .then((page) => {
      if (!isGroupsCurrent()) return
      setGroups({ ...page, isLoading: false, isLoaded: true, failedCursor: undefined })
    })
    .catch((error: unknown) => {
      if (!isGroupsCurrent()) return
      setGroups({ ...emptyPage(), isLoaded: true, error: getErrorMessage(error) })
    })
}

/**
 * Owns the Files tab's layered pagination and invalidation state.
 *
 * Uploads, artifact-group headers, and every session artifact collection retain independent cursors.
 * Monotonic generation/request tokens reject late responses after project changes, resets, deletes,
 * or overlapping events. This preserves uploads-first/session-grouped UI without flattening the DB
 * query into one cursor that could not be resumed per section.
 */
const useProjectFilesIndex = (
  projectId: string | undefined,
  onChanged?: (event: ProjectFilesChangedEvent) => void
): ProjectFilesIndexState => {
  const [overview, setOverview] = useState(EMPTY_OVERVIEW)
  const [overviewError, setOverviewError] = useState<string>()
  const [repairState, setRepairState] = useState<IndexRepairState>({ isRepairing: false })
  const [uploads, setUploads] = useState<PageState<ProjectFileItem>>(emptyPage)
  const [groups, setGroups] = useState<PageState<ArtifactGroupItem>>(emptyPage)
  const [artifactsBySession, setArtifactsBySession] = useState<
    Record<string, PageState<ProjectFileItem> | undefined>
  >({})
  const [refreshVersion, setRefreshVersion] = useState(0)
  // generation invalidates the whole project view; the per-layer counters invalidate only one first
  // page. Per-session versions allow artifact requests for different groups to remain independent.
  const generationRef = useRef(0)
  const overviewRequestRef = useRef(0)
  const uploadsRequestRef = useRef(0)
  const groupsRequestRef = useRef(0)
  const artifactRequestVersionsRef = useRef(new Map<string, number>())
  const loadingArtifactsRef = useRef(new Map<string, string>())
  const loadingUploadsRef = useRef<string | undefined>(undefined)
  const loadingGroupsRef = useRef<string | undefined>(undefined)
  const requestLimiterRef = useRef<RequestLimiter>(createRequestLimiter(4))
  const isRepairing = repairState.projectId === projectId && repairState.isRepairing
  const repairError = repairState.projectId === projectId ? repairState.error : undefined

  useEffect(() => {
    // Reset all renderer-owned cursor state before starting the new project's first-page requests.
    // Queued tasks check these captured tokens again before invoking IPC and before committing state.
    const generation = ++generationRef.current
    const overviewRequest = ++overviewRequestRef.current
    const uploadsRequest = ++uploadsRequestRef.current
    const groupsRequest = ++groupsRequestRef.current
    artifactRequestVersionsRef.current.clear()
    loadingArtifactsRef.current.clear()
    loadingUploadsRef.current = undefined
    loadingGroupsRef.current = undefined
    setOverview(EMPTY_OVERVIEW)
    setOverviewError(undefined)
    setUploads({ ...emptyPage(), isLoading: Boolean(projectId) })
    setGroups({ ...emptyPage(), isLoading: Boolean(projectId) })
    setArtifactsBySession({})

    if (!projectId) return

    startInitialProjectFilesLoad({
      projectId,
      requestLimiter: requestLimiterRef.current,
      isOverviewCurrent: () =>
        generation === generationRef.current && overviewRequest === overviewRequestRef.current,
      isUploadsCurrent: () =>
        generation === generationRef.current && uploadsRequest === uploadsRequestRef.current,
      isGroupsCurrent: () =>
        generation === generationRef.current && groupsRequest === groupsRequestRef.current,
      setOverview,
      setOverviewError,
      setUploads,
      setGroups
    })
  }, [projectId, refreshVersion])

  const handleIndexChanged = useCallback(
    (event: ProjectFilesChangedEvent): void => {
      if (!projectId || event.projectId !== projectId) return

      onChanged?.(event)
      if (event.kind === 'reset' || (event.sources.includes('artifact') && !event.sessionId)) {
        // Scope is unknown, so all three cursor layers must restart together.
        generationRef.current += 1
        setRefreshVersion((version) => version + 1)
        return
      }

      const generation = generationRef.current
      // Overview is cheap and authoritative for counts/completeness, so every scoped mutation refreshes
      // it even when only one collection page needs to be rebuilt.
      const overviewRequest = ++overviewRequestRef.current
      setOverviewError(undefined)
      void window.api.projectFiles
        .getOverview({ projectId })
        .then((nextOverview) => {
          if (
            generation !== generationRef.current ||
            overviewRequest !== overviewRequestRef.current
          ) {
            return
          }
          setOverview(nextOverview)
          setGroups((current) => ({
            ...current,
            totalCount: nextOverview.artifactGroupCount
          }))
        })
        .catch((error: unknown) => {
          if (
            generation === generationRef.current &&
            overviewRequest === overviewRequestRef.current
          ) {
            setOverviewError(getErrorMessage(error))
          }
        })

      if (event.sources.includes('upload')) {
        // Upload mutations replace the first page and cursor. Appending here would retain deleted rows
        // or preserve an order captured before the mutation.
        const uploadsRequest = ++uploadsRequestRef.current
        const requestKey = `${generation}:${uploadsRequest}:first`
        loadingUploadsRef.current = requestKey
        setUploads({ ...emptyPage(), isLoading: true })
        void requestLimiterRef
          .current(() =>
            generation === generationRef.current && uploadsRequest === uploadsRequestRef.current
              ? window.api.projectFiles.listFiles({
                  projectId,
                  collection: { kind: 'uploads' },
                  limit: FILE_PAGE_SIZE
                })
              : Promise.reject(new Error('Stale project files request.'))
          )
          .then((page) => {
            if (
              generation !== generationRef.current ||
              uploadsRequest !== uploadsRequestRef.current
            ) {
              return
            }
            setUploads({ ...page, isLoading: false, isLoaded: true, failedCursor: undefined })
          })
          .catch((error: unknown) => {
            if (
              generation !== generationRef.current ||
              uploadsRequest !== uploadsRequestRef.current
            ) {
              return
            }
            setUploads({ ...emptyPage(), isLoaded: true, error: getErrorMessage(error) })
          })
          .finally(() => {
            if (loadingUploadsRef.current === requestKey) loadingUploadsRef.current = undefined
          })
      }

      if (event.sources.includes('artifact') && event.sessionId) {
        // The group list shares the same DB projection. Invalidate any page captured before this
        // session mutation, then rebuild its first page and cursor from the updated projection.
        const groupsRequest = ++groupsRequestRef.current
        const groupsRequestKey = `${generation}:${groupsRequest}:first`
        loadingGroupsRef.current = groupsRequestKey
        setGroups((current) => ({
          ...current,
          nextCursor: undefined,
          isLoading: true,
          error: undefined,
          failedCursor: undefined
        }))
        void requestLimiterRef
          .current(() =>
            generation === generationRef.current && groupsRequest === groupsRequestRef.current
              ? window.api.projectFiles.listArtifactGroups({
                  projectId,
                  limit: GROUP_PAGE_SIZE
                })
              : Promise.reject(new Error('Stale project files request.'))
          )
          .then((page) => {
            if (
              generation !== generationRef.current ||
              groupsRequest !== groupsRequestRef.current
            ) {
              return
            }
            setGroups({
              ...page,
              isLoading: false,
              isLoaded: true,
              failedCursor: undefined
            })
          })
          .catch((error: unknown) => {
            if (
              generation !== generationRef.current ||
              groupsRequest !== groupsRequestRef.current
            ) {
              return
            }
            setGroups((current) => ({
              ...current,
              isLoading: false,
              isLoaded: true,
              error: getErrorMessage(error),
              failedCursor: undefined
            }))
          })
          .finally(() => {
            if (loadingGroupsRef.current === groupsRequestKey) {
              loadingGroupsRef.current = undefined
            }
          })

        const sessionId = event.sessionId
        // Session files refresh independently from the group list. Their response never edits group
        // ordering; only listArtifactGroups owns groupSortAtMs ordering and its continuation cursor.
        const artifactRequest = (artifactRequestVersionsRef.current.get(sessionId) ?? 0) + 1
        artifactRequestVersionsRef.current.set(sessionId, artifactRequest)
        const requestKey = `${generation}:${artifactRequest}:first`
        loadingArtifactsRef.current.set(sessionId, requestKey)
        setArtifactsBySession((current) => ({
          ...current,
          [sessionId]: { ...emptyPage(), isLoading: true }
        }))
        void requestLimiterRef
          .current(() =>
            generation === generationRef.current &&
            artifactRequest === artifactRequestVersionsRef.current.get(sessionId)
              ? window.api.projectFiles.listFiles({
                  projectId,
                  collection: { kind: 'sessionArtifacts', sessionId },
                  limit: FILE_PAGE_SIZE
                })
              : Promise.reject(new Error('Stale project files request.'))
          )
          .then((page) => {
            if (
              generation !== generationRef.current ||
              artifactRequest !== artifactRequestVersionsRef.current.get(sessionId)
            ) {
              return
            }
            setArtifactsBySession((current) => ({
              ...current,
              [sessionId]: {
                ...page,
                isLoading: false,
                isLoaded: true,
                failedCursor: undefined
              }
            }))
          })
          .catch((error: unknown) => {
            if (
              generation !== generationRef.current ||
              artifactRequest !== artifactRequestVersionsRef.current.get(sessionId)
            ) {
              return
            }
            setArtifactsBySession((current) => ({
              ...current,
              [sessionId]: {
                ...emptyPage(),
                isLoaded: true,
                error: getErrorMessage(error)
              }
            }))
          })
          .finally(() => {
            if (loadingArtifactsRef.current.get(sessionId) === requestKey) {
              loadingArtifactsRef.current.delete(sessionId)
            }
          })
      }
    },
    [onChanged, projectId]
  )

  useEffect(() => {
    if (!projectId) return
    return window.api.projectFiles.onChanged(handleIndexChanged)
  }, [handleIndexChanged, projectId])

  const reload = useCallback((): void => {
    // Advancing generation invalidates all in-flight layer and per-session responses before the next
    // effect starts a clean set of first pages.
    generationRef.current += 1
    setRefreshVersion((version) => version + 1)
  }, [])

  const repairIndex = useCallback(async (): Promise<void> => {
    if (!projectId || isRepairing) return

    setRepairState({ projectId, isRepairing: true })
    try {
      await window.api.projectFiles.repairIndex({ projectId })
    } catch (error) {
      setRepairState({ projectId, isRepairing: false, error: getErrorMessage(error) })
    } finally {
      setRepairState((current) =>
        current.projectId === projectId ? { ...current, isRepairing: false } : current
      )
    }
  }, [isRepairing, projectId])

  const loadMoreUploads = useCallback(async (): Promise<void> => {
    if (
      !projectId ||
      uploads.isLoading ||
      (uploads.isLoaded && !uploads.nextCursor && !uploads.error)
    ) {
      return
    }

    const generation = generationRef.current
    const uploadsRequest = uploadsRequestRef.current
    // Retry the cursor that failed; otherwise advance from the last committed page.
    const cursor = uploads.error ? uploads.failedCursor : uploads.nextCursor
    const requestKey = `${generation}:${cursor ?? 'first'}`
    if (loadingUploadsRef.current) return
    loadingUploadsRef.current = requestKey
    setUploads((page) => ({ ...page, isLoading: true, error: undefined }))

    try {
      const page = await requestLimiterRef.current(() =>
        generation === generationRef.current
          ? window.api.projectFiles.listFiles({
              projectId,
              collection: { kind: 'uploads' },
              cursor,
              limit: FILE_PAGE_SIZE
            })
          : Promise.reject(new Error('Stale project files request.'))
      )
      if (generation !== generationRef.current || uploadsRequest !== uploadsRequestRef.current) {
        return
      }
      setUploads((current) => ({
        ...page,
        items: appendUnique(current.items, page.items, (item) => item.id),
        isLoading: false,
        isLoaded: true,
        error: undefined,
        failedCursor: undefined
      }))
    } catch (error) {
      if (generation !== generationRef.current || uploadsRequest !== uploadsRequestRef.current) {
        return
      }
      setUploads((page) => ({
        ...page,
        isLoading: false,
        error: getErrorMessage(error),
        failedCursor: cursor
      }))
    } finally {
      if (loadingUploadsRef.current === requestKey) loadingUploadsRef.current = undefined
    }
  }, [projectId, uploads])

  const loadMoreGroups = useCallback(async (): Promise<void> => {
    if (
      !projectId ||
      groups.isLoading ||
      (groups.isLoaded && !groups.nextCursor && !groups.error)
    ) {
      return
    }

    const generation = generationRef.current
    const groupsRequest = groupsRequestRef.current
    const cursor = groups.error ? groups.failedCursor : groups.nextCursor
    const requestKey = `${generation}:${cursor ?? 'first'}`
    if (loadingGroupsRef.current) return
    loadingGroupsRef.current = requestKey
    setGroups((page) => ({ ...page, isLoading: true, error: undefined }))

    try {
      const page = await requestLimiterRef.current(() =>
        generation === generationRef.current
          ? window.api.projectFiles.listArtifactGroups({
              projectId,
              cursor,
              limit: GROUP_PAGE_SIZE
            })
          : Promise.reject(new Error('Stale project files request.'))
      )
      if (generation !== generationRef.current || groupsRequest !== groupsRequestRef.current) return
      setGroups((current) => ({
        ...page,
        // A first-page retry is authoritative and must remove stale groups. Continuation pages append
        // by stable session identity so repeated responses cannot duplicate headers.
        items: cursor
          ? appendUnique(current.items, page.items, (item) => item.sessionId)
          : page.items,
        isLoading: false,
        isLoaded: true,
        error: undefined,
        failedCursor: undefined
      }))
    } catch (error) {
      if (generation !== generationRef.current || groupsRequest !== groupsRequestRef.current) return
      setGroups((page) => ({
        ...page,
        isLoading: false,
        error: getErrorMessage(error),
        failedCursor: cursor
      }))
    } finally {
      if (loadingGroupsRef.current === requestKey) loadingGroupsRef.current = undefined
    }
  }, [groups, projectId])

  const loadMoreArtifacts = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!projectId || loadingArtifactsRef.current.has(sessionId)) return

      const currentPage = artifactsBySession[sessionId]
      if (currentPage?.isLoaded && !currentPage.nextCursor && !currentPage.error) return

      const generation = generationRef.current
      const artifactRequest = artifactRequestVersionsRef.current.get(sessionId) ?? 0
      // Each session retries and advances independently, so one failed group never blocks another.
      const cursor = currentPage?.error ? currentPage.failedCursor : currentPage?.nextCursor
      const requestKey = `${generation}:${artifactRequest}:${cursor ?? 'first'}`
      loadingArtifactsRef.current.set(sessionId, requestKey)
      setArtifactsBySession((current) => ({
        ...current,
        [sessionId]: {
          ...(current[sessionId] ?? emptyPage()),
          isLoading: true,
          error: undefined
        }
      }))

      try {
        const page = await requestLimiterRef.current(() =>
          generation === generationRef.current
            ? window.api.projectFiles.listFiles({
                projectId,
                collection: { kind: 'sessionArtifacts', sessionId },
                cursor,
                limit: FILE_PAGE_SIZE
              })
            : Promise.reject(new Error('Stale project files request.'))
        )
        if (
          generation !== generationRef.current ||
          artifactRequest !== (artifactRequestVersionsRef.current.get(sessionId) ?? 0)
        ) {
          return
        }
        setArtifactsBySession((current) => ({
          ...current,
          [sessionId]: {
            ...page,
            items: appendUnique(current[sessionId]?.items ?? [], page.items, (item) => item.id),
            isLoading: false,
            isLoaded: true,
            error: undefined,
            failedCursor: undefined
          }
        }))
      } catch (error) {
        if (
          generation !== generationRef.current ||
          artifactRequest !== (artifactRequestVersionsRef.current.get(sessionId) ?? 0)
        ) {
          return
        }
        setArtifactsBySession((current) => ({
          ...current,
          [sessionId]: {
            ...(current[sessionId] ?? emptyPage()),
            isLoading: false,
            isLoaded: true,
            error: getErrorMessage(error),
            failedCursor: cursor
          }
        }))
      } finally {
        if (loadingArtifactsRef.current.get(sessionId) === requestKey) {
          loadingArtifactsRef.current.delete(sessionId)
        }
      }
    },
    [artifactsBySession, projectId]
  )

  return {
    overview,
    overviewError,
    isRepairing,
    repairError,
    uploads,
    groups,
    artifactsBySession,
    loadMoreUploads,
    loadMoreGroups,
    loadMoreArtifacts,
    repairIndex,
    reload
  }
}

export { FILE_PAGE_SIZE, GROUP_PAGE_SIZE, useProjectFilesIndex }
export type { PageState, ProjectFilesIndexState }
