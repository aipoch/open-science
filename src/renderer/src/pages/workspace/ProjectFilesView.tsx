import { Check, ChevronDown, File, Folder, Paperclip } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { cn, formatByteSize } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type {
  ArtifactGroupItem,
  ProjectFileItem,
  ProjectFilesChangedEvent
} from '../../../../shared/project-files'

import { ArtifactPreview } from './artifact-preview'
import {
  ARTIFACT_IMAGE_PREVIEW_BYTES,
  ARTIFACT_PREVIEW_BYTES,
  getArtifactPreviewFormat
} from './artifact-preview-utils'
import { ManagedFileDownloadButton } from './ManagedFileDownloadButton'
import { createPreviewFileItem } from './preview-file-item'
import type { MessageArtifact } from './preview-file-item'
import { FilePreviewDialog } from './FilePreviewDialog'
import { getPreviewThumbnailReadEncoding } from './preview-support'
import { createKeyedRequestReader } from './project-file-preview-queue'
import { isUnavailableFileError, FILE_MISSING_TAG } from './previews/preview-errors'
import { getPreviewFileReader } from './previews/preview-file-reader'
import { useNearViewport } from './previews/useNearViewport'
import { useUnavailablePreviewProbe } from './previews/useUnavailablePreviewProbe'
import { FILE_PAGE_SIZE, useProjectFilesIndex, type PageState } from './use-project-files-index'

type ProjectFilesFilterOption = {
  id: string
  label: string
  count: number
  kind: 'all' | 'uploads' | 'session'
}

type ProjectFilePreviewTarget = {
  id: string
  path: string
  source: 'artifact' | 'upload'
  artifact: MessageArtifact
  projectId: string
  cacheKey: string
  encoding?: 'utf8' | 'base64'
}

type ReadableProjectFilePreviewTarget = ProjectFilePreviewTarget & {
  encoding: 'utf8' | 'base64'
}

type ProjectFilePreviewEntry = {
  cacheKey: string
  preview: ArtifactPreviewResult | undefined
}

// Each stable file id retains only its current path/version preview entry.
type ProjectFilePreviewState = Record<string, ProjectFilePreviewEntry | undefined>

type ProjectFilePreviewReadResult = ProjectFilePreviewEntry & { id: string }
type FilePageLoadMode = 'manual' | 'scroll'

const PREVIEW_READ_CONCURRENCY = 4
const MAX_PREVIEW_CACHE_ENTRIES = 96

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

const createProjectFilePreviewArtifact = (file: ProjectFileItem): MessageArtifact => ({
  id: file.sourceFileId,
  kind: 'managed-file',
  path: file.path,
  name: file.name,
  mimeType: file.mimeType,
  size: file.size,
  mtimeMs: file.mtimeMs
})

// A moved or rewritten file is a new cache entry even when its stable UI id stays the same.
const getProjectFilePreviewCacheKey = ({
  id,
  path,
  source,
  artifact
}: Pick<ProjectFilePreviewTarget, 'id' | 'path' | 'source' | 'artifact'>): string =>
  JSON.stringify([source, id, path, artifact.size ?? null, artifact.mtimeMs ?? null])

// Builds the source-neutral capability and source-specific read metadata used by File tiles.
const createProjectFilePreviewTarget = (
  target: Pick<ProjectFilePreviewTarget, 'id' | 'path' | 'source' | 'artifact' | 'projectId'>
): ProjectFilePreviewTarget => ({
  ...target,
  cacheKey: getProjectFilePreviewCacheKey(target),
  encoding: getPreviewThumbnailReadEncoding(getArtifactPreviewFormat(target.artifact))
})

// Skips unsupported, cached, and oversized image targets before any IPC reads start.
const getMissingProjectFilePreviewTargets = (
  targets: ProjectFilePreviewTarget[],
  previews: ProjectFilePreviewState
): ReadableProjectFilePreviewTarget[] =>
  targets
    .filter((target): target is ReadableProjectFilePreviewTarget => target.encoding !== undefined)
    .filter((target) => previews[target.id]?.cacheKey !== target.cacheKey)
    .filter(
      (target) =>
        target.encoding !== 'base64' ||
        (typeof target.artifact.size === 'number' &&
          target.artifact.size <= ARTIFACT_IMAGE_PREVIEW_BYTES)
    )

// Reads one tile through its source-specific IPC while retaining the source-neutral cache identity.
const readProjectFilePreview = async (
  target: ReadableProjectFilePreviewTarget
): Promise<ProjectFilePreviewReadResult> => {
  const readPreview = getPreviewFileReader(target.source)

  try {
    const preview = await readPreview({
      path: target.path,
      maxBytes:
        target.encoding === 'base64' ? ARTIFACT_IMAGE_PREVIEW_BYTES : ARTIFACT_PREVIEW_BYTES,
      encoding: target.encoding
    })

    return { id: target.id, cacheKey: target.cacheKey, preview }
  } catch (error) {
    // Missing or out-of-root files are represented on the tile; only unexpected read failures belong
    // in the console because unavailable files are a normal state after deletion or data-root changes.
    if (!isUnavailableFileError(error)) {
      console.error('Failed to read project file preview', error)
    }
    return { id: target.id, cacheKey: target.cacheKey, preview: undefined }
  }
}

// Merges one completed read batch without dropping cached entries for other visible files.
const mergeProjectFilePreviews = (
  currentPreviews: ProjectFilePreviewState,
  previews: ProjectFilePreviewReadResult[],
  protectedIds: ReadonlySet<string>
): ProjectFilePreviewState => {
  const nextPreviews = previews.reduce<ProjectFilePreviewState>(
    (nextPreviews, item) => {
      // Reinsert completed entries so object insertion order acts as a compact LRU approximation.
      delete nextPreviews[item.id]
      nextPreviews[item.id] = { cacheKey: item.cacheKey, preview: item.preview }
      return nextPreviews
    },
    { ...currentPreviews }
  )

  return trimProjectFilePreviews(nextPreviews, protectedIds)
}

// Current tiles stay protected; retain at most one compact page pool of hidden previews for return
// navigation without letting collapsed or previously paged sections grow the cache indefinitely.
const trimProjectFilePreviews = (
  currentPreviews: ProjectFilePreviewState,
  protectedIds: ReadonlySet<string>
): ProjectFilePreviewState => {
  const keys = Object.keys(currentPreviews)
  const hiddenIds = keys.filter((id) => !protectedIds.has(id))
  if (hiddenIds.length <= MAX_PREVIEW_CACHE_ENTRIES) return currentPreviews

  const nextPreviews = { ...currentPreviews }
  const removeCount = hiddenIds.length - MAX_PREVIEW_CACHE_ENTRIES
  for (const id of hiddenIds.slice(0, removeCount)) {
    delete nextPreviews[id]
  }
  return nextPreviews
}

type ProjectFilePreviewReader = ((
  target: ReadableProjectFilePreviewTarget
) => Promise<ProjectFilePreviewReadResult>) & {
  setActiveKeys?: (keys: ReadonlySet<string>) => void
}

const getProjectFilePreviewRequestKey = (target: ProjectFilePreviewTarget): string =>
  `${target.projectId}:${target.cacheKey}`

// Shares one queue across render batches so preview reads remain capped and deduplicated even when
// pagination, filters, or section expansion update the target list in quick succession.
const createProjectFilePreviewReader = (
  read: ProjectFilePreviewReader = readProjectFilePreview,
  maxConcurrency = PREVIEW_READ_CONCURRENCY
): ProjectFilePreviewReader =>
  createKeyedRequestReader(read, getProjectFilePreviewRequestKey, maxConcurrency, {
    getGenerationKey: (target) => target.projectId,
    createCanceledResult: (target) => ({
      id: target.id,
      cacheKey: target.cacheKey,
      preview: undefined
    })
  })

/**
 * Maintains version-aware tile previews for the currently rendered file targets.
 *
 * Active request keys cancel queued reads for collapsed/filtered files. Attempted keys suppress retry
 * loops for failed reads, but are removed once a target leaves the active set so an evicted preview is
 * eligible for a fresh read when the user returns. Completed batches merge without evicting visible
 * tiles, while hidden entries are bounded separately.
 */
const useProjectFilePreviews = (
  previewTargets: ProjectFilePreviewTarget[],
  previewReader: ProjectFilePreviewReader
): ProjectFilePreviewState => {
  const [filePreviews, setFilePreviews] = useState<ProjectFilePreviewState>({})
  const attemptedCacheKeyByIdRef = useRef(new Map<string, string>())

  useEffect(() => {
    const activeCacheKeys = new Map(
      previewTargets.map((target) => [target.id, target.cacheKey] as const)
    )
    const protectedIds = new Set(activeCacheKeys.keys())
    const attemptedCacheKeys = attemptedCacheKeyByIdRef.current
    let canceled = false
    previewReader.setActiveKeys?.(new Set(previewTargets.map(getProjectFilePreviewRequestKey)))

    // Attempts only suppress cache-eviction loops for the current render set. Hidden evicted files
    // must be eligible for a fresh read when the user returns to them.
    for (const [id, cacheKey] of attemptedCacheKeys) {
      if (activeCacheKeys.get(id) !== cacheKey) attemptedCacheKeys.delete(id)
    }
    void Promise.resolve().then(() => {
      if (!canceled) {
        setFilePreviews((current) => trimProjectFilePreviews(current, protectedIds))
      }
    })

    const missingTargets = getMissingProjectFilePreviewTargets(previewTargets, filePreviews).filter(
      (target) => attemptedCacheKeys.get(target.id) !== target.cacheKey
    )
    if (missingTargets.length === 0) {
      return () => {
        canceled = true
        previewReader.setActiveKeys?.(new Set())
      }
    }

    let completed = false
    for (const target of missingTargets) {
      attemptedCacheKeys.set(target.id, target.cacheKey)
    }

    void Promise.all(missingTargets.map(previewReader)).then((previews) => {
      completed = true
      if (canceled) return
      setFilePreviews((current) => mergeProjectFilePreviews(current, previews, protectedIds))
    })

    return () => {
      canceled = true
      previewReader.setActiveKeys?.(new Set())
      if (!completed) {
        for (const target of missingTargets) {
          if (attemptedCacheKeys.get(target.id) === target.cacheKey) {
            attemptedCacheKeys.delete(target.id)
          }
        }
      }
    }
  }, [filePreviews, previewReader, previewTargets])

  return filePreviews
}

// Converts one stable sentinel into guarded infinite loading. The root margin starts the next page
// shortly before it becomes visible; environments without IntersectionObserver fall back to manual UI.
const useInfiniteLoad = (
  enabled: boolean,
  loadMore: () => void | Promise<void>
): React.RefObject<HTMLDivElement | null> => {
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

const formatMiddleEllipsisName = (name: string): string => {
  if (name.length < 26) return name

  const headLength = 12
  const tailLength = 11

  if (name.length < headLength + tailLength + 3) return name

  return `${name.slice(0, headLength)}...${name.slice(-tailLength)}`
}

const formatRelativeFileTime = (timestamp: number | undefined): string | undefined => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined

  const elapsedMs = Math.max(0, Date.now() - timestamp)
  const units = [
    { label: 'year', ms: YEAR_MS },
    { label: 'month', ms: MONTH_MS },
    { label: 'day', ms: DAY_MS },
    { label: 'hour', ms: HOUR_MS },
    { label: 'minute', ms: MINUTE_MS }
  ]
  const unit = units.find((item) => elapsedMs >= item.ms) ?? units[units.length - 1]
  const value = Math.max(1, Math.floor(elapsedMs / unit.ms))

  return `${value} ${unit.label}${value === 1 ? '' : 's'} ago`
}

const SectionHeader = ({
  id,
  title,
  countLabel,
  isCollapsed,
  onToggle
}: {
  id: string
  title: string
  countLabel: string
  isCollapsed: boolean
  onToggle: (id: string) => void
}): React.JSX.Element => (
  <button
    type="button"
    className="flex w-full min-w-0 items-center gap-1.5 border-t border-border-300/40 px-4 py-2 text-left text-sm text-text-000 hover:bg-bg-100"
    aria-expanded={!isCollapsed}
    onClick={() => onToggle(id)}
  >
    <ChevronDown
      className={cn(
        'size-3 shrink-0 text-text-300 transition-transform motion-reduce:transition-none',
        isCollapsed && '-rotate-90'
      )}
      strokeWidth={2}
      aria-hidden="true"
    />
    <span className="min-w-0 flex-1 truncate">{title}</span>
    <span className="shrink-0 text-[11px] text-text-300">{countLabel}</span>
  </button>
)

const PageLoadError = ({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element => (
  <div className="flex items-center justify-between gap-3 px-4 py-3 text-[11px] text-danger-000">
    <span className="min-w-0 flex-1 truncate">{message}</span>
    <Button type="button" variant="outline" className="h-7 shrink-0 px-2.5" onClick={onRetry}>
      Retry
    </Button>
  </div>
)

// All mode uses a compact per-section button; category mode normally scroll-loads. Both modes share
// the same terminal state so each upload/session section says No more independently.
const FilePageFooter = ({
  page,
  mode,
  visibleItemCount,
  loadMoreLabel,
  onLoadMore
}: {
  page: PageState<ProjectFileItem> | undefined
  mode: FilePageLoadMode
  visibleItemCount: number
  loadMoreLabel: string
  onLoadMore: () => void
}): React.JSX.Element | null => {
  if (!page?.isLoaded || page.error || page.items.length === 0) return null

  const hasMore = visibleItemCount < page.items.length || Boolean(page.nextCursor)

  if (!hasMore && !page.isLoading) {
    return (
      <div
        data-testid="project-files-end"
        className="px-4 py-2 text-center text-[11px] text-text-300"
      >
        No more
      </div>
    )
  }

  if (mode !== 'manual' || !hasMore) return null

  return (
    <div className="flex justify-center px-4 py-2">
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-label={loadMoreLabel}
        disabled={page.isLoading}
        onClick={onLoadMore}
      >
        {page.isLoading ? 'Loading...' : 'Load more'}
      </Button>
    </div>
  )
}

const FileTile = ({
  name,
  previewArtifact,
  preview,
  source,
  size,
  timestamp,
  previewLabel,
  onPreview
}: {
  name: string
  previewArtifact: MessageArtifact
  preview?: ArtifactPreviewResult
  source: 'artifact' | 'upload'
  size?: number
  timestamp?: number
  previewLabel: string
  onPreview: () => void
}): React.JSX.Element => {
  const sizeLabel = formatByteSize(size)
  const displayName = formatMiddleEllipsisName(name)
  const relativeTimeLabel = formatRelativeFileTime(timestamp)
  const [setTileElement, isNearViewport] = useNearViewport<HTMLButtonElement>()
  const missing = useUnavailablePreviewProbe({
    enabled: isNearViewport,
    path: previewArtifact.path,
    source
  })

  return (
    <div className="group relative h-[128px] min-w-0 overflow-hidden rounded-lg border border-border-300/50 bg-bg-000 shadow-sm hover:border-border-200 hover:bg-bg-100 focus-within:ring-2 focus-within:ring-ring/50 focus-within:ring-inset">
      <button
        ref={setTileElement}
        type="button"
        className="flex h-[128px] w-full min-w-0 flex-col text-left"
        aria-label={previewLabel}
        title={name}
        onClick={onPreview}
      >
        <span
          data-testid="project-file-preview"
          className={cn(
            'relative h-[82px] w-full overflow-hidden bg-bg-200',
            missing && 'opacity-40'
          )}
        >
          <ArtifactPreview artifact={previewArtifact} preview={preview} source={source} />
          {missing ? (
            <span className="absolute left-1.5 top-1.5 rounded bg-text-000/75 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-bg-000 shadow-sm">
              {FILE_MISSING_TAG}
            </span>
          ) : null}
        </span>
        <span
          data-testid="project-file-meta"
          className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-2 py-1.5"
        >
          <span className="block min-w-0 truncate text-[11px] leading-5 text-text-000">
            {displayName}
          </span>
          {sizeLabel || relativeTimeLabel ? (
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0 text-[10px] leading-3 text-text-300">
              {sizeLabel ? <span className="shrink-0">{sizeLabel}</span> : null}
              {sizeLabel && relativeTimeLabel ? (
                <span className="shrink-0" aria-hidden="true">
                  ·
                </span>
              ) : null}
              {relativeTimeLabel ? <span className="min-w-0">{relativeTimeLabel}</span> : null}
            </span>
          ) : null}
        </span>
      </button>
      <ManagedFileDownloadButton
        source={source}
        path={previewArtifact.path}
        suggestedName={name}
        disabled={missing}
        revealOnParentHover
        wrapperClassName="absolute right-1.5 top-1.5 z-10"
      />
    </div>
  )
}

const FilterMenuItem = ({
  option,
  isSelected,
  onSelect
}: {
  option: ProjectFilesFilterOption
  isSelected: boolean
  onSelect: (optionId: string) => void
}): React.JSX.Element => {
  const Icon = option.kind === 'uploads' ? Paperclip : option.kind === 'session' ? Folder : File

  return (
    <DropdownMenuItem
      role="menuitemradio"
      aria-checked={isSelected}
      data-filter-id={option.id}
      className="gap-2"
      onSelect={() => onSelect(option.id)}
    >
      <Icon className="size-4 shrink-0 text-text-300" strokeWidth={1.8} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {isSelected ? (
        <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
      ) : null}
      <span className="shrink-0 text-[11px] text-text-300">{option.count}</span>
    </DropdownMenuItem>
  )
}

const ProjectFilesFilterMenu = ({
  label,
  options,
  selectedOptionId,
  onSelect,
  canLoadMoreOptions,
  onLoadMoreOptions
}: {
  label: string
  options: ProjectFilesFilterOption[]
  selectedOptionId: string
  onSelect: (optionId: string) => void
  canLoadMoreOptions: boolean
  onLoadMoreOptions: () => void
}): React.JSX.Element => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="outline"
        className="max-w-[220px] gap-1.5"
        aria-label="Filter project files"
      >
        <File className="size-3.5 shrink-0 text-text-300" strokeWidth={1.8} aria-hidden="true" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown
          className="size-3.5 shrink-0 text-text-300"
          strokeWidth={2}
          aria-hidden="true"
        />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="start"
      className="max-h-[360px] w-[320px] overflow-y-auto"
      onScroll={(event) => {
        const element = event.currentTarget
        if (
          canLoadMoreOptions &&
          element.scrollHeight - element.scrollTop - element.clientHeight < 48
        ) {
          onLoadMoreOptions()
        }
      }}
    >
      <DropdownMenuLabel>Artifacts</DropdownMenuLabel>
      <DropdownMenuGroup>
        {options.map((option) => (
          <FilterMenuItem
            key={option.id}
            option={option}
            isSelected={option.id === selectedOptionId}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
)

// Renders one independently paginated artifact collection. All mode reveals local batches of 20 with
// a compact button, while a selected session consumes its cursor through the intersection sentinel.
const ProjectArtifactGroupSection = ({
  group,
  title,
  page,
  loadMode,
  manualVisibleItemLimit,
  isCollapsed,
  onToggle,
  loadMore,
  onManualLoadMore,
  previewById,
  onPreview
}: {
  group: ArtifactGroupItem
  title: string
  page: PageState<ProjectFileItem> | undefined
  loadMode: FilePageLoadMode
  manualVisibleItemLimit: number
  isCollapsed: boolean
  onToggle: (id: string) => void
  loadMore: (sessionId: string) => Promise<void>
  onManualLoadMore: () => void
  previewById: Map<string, ArtifactPreviewResult | undefined>
  onPreview: (file: ProjectFileItem) => void
}): React.JSX.Element => {
  const sectionId = `session:${group.sessionId}`
  const loadPage = useCallback(() => loadMore(group.sessionId), [group.sessionId, loadMore])
  const supportsIntersectionObserver = typeof IntersectionObserver !== 'undefined'
  const effectiveLoadMode =
    loadMode === 'scroll' && !supportsIntersectionObserver ? 'manual' : loadMode
  const canAutoLoad =
    !isCollapsed &&
    !page?.isLoading &&
    !page?.error &&
    (!page?.isLoaded || (effectiveLoadMode === 'scroll' && !!page.nextCursor))
  const sentinelRef = useInfiniteLoad(canAutoLoad, loadPage)
  const visibleItems =
    loadMode === 'manual'
      ? (page?.items.slice(0, manualVisibleItemLimit) ?? [])
      : (page?.items ?? [])

  return (
    <section>
      <SectionHeader
        id={sectionId}
        title={title}
        countLabel={`${group.artifactCount} files`}
        isCollapsed={isCollapsed}
        onToggle={onToggle}
      />
      {!isCollapsed ? (
        <>
          {visibleItems.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2 px-4 py-3">
              {visibleItems.map((file) => {
                const artifact = createProjectFilePreviewArtifact(file)

                return (
                  <FileTile
                    key={file.id}
                    name={file.name}
                    previewArtifact={artifact}
                    preview={previewById.get(file.id)}
                    source="artifact"
                    size={file.size}
                    timestamp={file.mtimeMs}
                    previewLabel={`Preview generated file ${file.name}`}
                    onPreview={() => onPreview(file)}
                  />
                )
              })}
            </div>
          ) : null}
          {page?.error ? (
            <PageLoadError message={page.error} onRetry={() => void loadPage()} />
          ) : null}
          <FilePageFooter
            page={page}
            mode={effectiveLoadMode}
            visibleItemCount={visibleItems.length}
            loadMoreLabel={`Load more files from ${title}`}
            onLoadMore={loadMode === 'manual' ? onManualLoadMore : () => void loadPage()}
          />
          <div
            ref={sentinelRef}
            data-testid={`artifact-page-sentinel:${group.sessionId}`}
            className="h-px"
          />
        </>
      ) : null}
    </section>
  )
}

// Composes the uploads-first/session-grouped product layout over the layered index hook. Filtering
// changes presentation and loading mode without flattening or rebuilding the underlying cursors.
const ProjectFilesViewContent = ({
  activeProjectId,
  previewReader
}: {
  activeProjectId: string | undefined
  previewReader: ProjectFilePreviewReader
}): React.JSX.Element => {
  const allSessions = useSessionStore((state) => state.sessions)
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(() => new Set())
  const [selectedFilterId, setSelectedFilterId] = useState('all')
  const [selectedSessionFallback, setSelectedSessionFallback] = useState<ProjectFilesFilterOption>()
  const [allVisibleItemLimits, setAllVisibleItemLimits] = useState<Record<string, number>>({})
  // Files-tab previews are transient dialog state; opening a file must not create a workbench tab.
  const [dialogItem, setDialogItem] = useState<PreviewFileItem | undefined>(undefined)
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
  const index = useProjectFilesIndex(activeProjectId, handleIndexChanged)
  const sessionTitleById = useMemo(
    () =>
      new Map(
        allSessions
          .filter((session) => session.projectId === activeProjectId)
          .map((session) => [session.id, session.title] as const)
      ),
    [activeProjectId, allSessions]
  )
  const getSessionTitle = useCallback(
    (sessionId: string): string =>
      sessionTitleById.get(sessionId) ?? `Session ${sessionId.slice(0, 8)}`,
    [sessionTitleById]
  )
  const filterOptions = useMemo<ProjectFilesFilterOption[]>(() => {
    const options: ProjectFilesFilterOption[] = [
      {
        id: 'all',
        label: 'All artifacts',
        count: index.overview.totalCount,
        kind: 'all'
      },
      {
        id: 'uploads',
        label: 'Your uploads',
        count: index.overview.uploadCount,
        kind: 'uploads'
      },
      ...index.groups.items.map((group) => ({
        id: `session:${group.sessionId}`,
        label: getSessionTitle(group.sessionId),
        count: group.artifactCount,
        kind: 'session' as const
      }))
    ]

    // Keep a directly selected session reachable while a group first-page refresh is in flight or
    // while that session lies beyond the currently loaded group-header page.
    if (
      selectedSessionFallback &&
      !options.some((option) => option.id === selectedSessionFallback.id)
    ) {
      const sessionId = selectedSessionFallback.id.slice('session:'.length)
      options.push({
        ...selectedSessionFallback,
        count: index.artifactsBySession[sessionId]?.totalCount ?? selectedSessionFallback.count
      })
    }

    return options
  }, [
    getSessionTitle,
    index.artifactsBySession,
    index.groups.items,
    index.overview,
    selectedSessionFallback
  ])
  const selectedSessionId = selectedFilterId.startsWith('session:')
    ? selectedFilterId.slice('session:'.length)
    : undefined
  const selectedSessionStillExists = selectedSessionId
    ? allSessions.some(
        (session) => session.projectId === activeProjectId && session.id === selectedSessionId
      )
    : false
  const selectedSessionIsLoaded = selectedSessionId
    ? index.groups.items.some((group) => group.sessionId === selectedSessionId)
    : false

  useEffect(() => {
    if (!selectedSessionId || selectedSessionStillExists || selectedSessionIsLoaded) return

    const sessionPage = index.artifactsBySession[selectedSessionId]
    const groupsSettled = index.groups.isLoaded && !index.groups.isLoading && !index.groups.error
    const sessionPageSettled = sessionPage?.isLoaded && !sessionPage.isLoading && !sessionPage.error
    if (!groupsSettled || !sessionPageSettled || sessionPage.totalCount > 0) return

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
    index.artifactsBySession,
    index.groups,
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
  const uploadsCollapsed = collapsedSectionIds.has('uploads')
  const allUploadVisibleItemLimit = allVisibleItemLimits.uploads ?? FILE_PAGE_SIZE
  const visibleUploadFiles = useMemo(() => {
    if (effectiveFilterId === 'uploads') return index.uploads.items
    if (effectiveFilterId === 'all') {
      return index.uploads.items.slice(0, allUploadVisibleItemLimit)
    }
    return []
  }, [allUploadVisibleItemLimit, effectiveFilterId, index.uploads.items])
  const visibleArtifactGroups = useMemo(
    () =>
      effectiveFilterId === 'all'
        ? index.groups.items
        : effectiveFilterId.startsWith('session:')
          ? [
              index.groups.items.find(
                (group) => `session:${group.sessionId}` === effectiveFilterId
              ) ?? {
                sessionId: effectiveFilterId.slice('session:'.length),
                artifactCount:
                  index.artifactsBySession[effectiveFilterId.slice('session:'.length)]
                    ?.totalCount ?? selectedFilterOption.count
              }
            ]
          : [],
    [effectiveFilterId, index.artifactsBySession, index.groups.items, selectedFilterOption.count]
  )
  const visibleFileCount =
    effectiveFilterId === 'all'
      ? index.overview.totalCount
      : effectiveFilterId === 'uploads'
        ? index.overview.uploadCount
        : (visibleArtifactGroups[0]?.artifactCount ?? 0)
  const visibleArtifactFiles = useMemo(
    () =>
      visibleArtifactGroups.flatMap((group) => {
        if (collapsedSectionIds.has(`session:${group.sessionId}`)) return []
        const items = index.artifactsBySession[group.sessionId]?.items ?? []
        if (effectiveFilterId !== 'all') return items

        const visibleItemLimit =
          allVisibleItemLimits[`session:${group.sessionId}`] ?? FILE_PAGE_SIZE
        return items.slice(0, visibleItemLimit)
      }),
    [
      allVisibleItemLimits,
      collapsedSectionIds,
      effectiveFilterId,
      index.artifactsBySession,
      visibleArtifactGroups
    ]
  )
  const previewTargets = useMemo<ProjectFilePreviewTarget[]>(
    // Collapsed sections are intentionally absent: they neither protect cache entries nor enqueue new
    // thumbnail reads. Expanding the section reconstructs targets from the already loaded page.
    () =>
      [...(uploadsCollapsed ? [] : visibleUploadFiles), ...visibleArtifactFiles].map((file) =>
        createProjectFilePreviewTarget({
          id: file.id,
          path: file.path,
          source: file.source,
          artifact: createProjectFilePreviewArtifact(file),
          projectId: activeProjectId ?? ''
        })
      ),
    [activeProjectId, uploadsCollapsed, visibleArtifactFiles, visibleUploadFiles]
  )
  const filePreviews = useProjectFilePreviews(previewTargets, previewReader)
  // A previous version may remain cached while the current path loads; never render it as current.
  const currentFilePreviewById = useMemo(
    () =>
      new Map(
        previewTargets.map((target) => {
          const entry = filePreviews[target.id]
          return [
            target.id,
            entry?.cacheKey === target.cacheKey ? entry.preview : undefined
          ] as const
        })
      ),
    [filePreviews, previewTargets]
  )

  const toggleSection = (sectionId: string): void => {
    setCollapsedSectionIds((currentIds) => {
      const nextIds = new Set(currentIds)

      if (nextIds.has(sectionId)) {
        nextIds.delete(sectionId)
      } else {
        nextIds.add(sectionId)
      }

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

    if ((page?.items.length ?? 0) < nextVisibleItemLimit && page?.nextCursor) {
      void loadMore()
    }
  }

  const previewFile = (file: ProjectFileItem): void => {
    // Keep the indexed file identity and source so the dialog uses the same bounded preview IPC path.
    setDialogItem(
      createPreviewFileItem({
        id: file.id,
        sessionId: file.sessionId,
        path: file.path,
        name: file.name,
        mimeType: file.mimeType,
        source: file.source === 'upload' ? 'upload' : undefined,
        size: file.size,
        mtimeMs: file.mtimeMs
      })
    )
  }

  const supportsIntersectionObserver = typeof IntersectionObserver !== 'undefined'
  const uploadSentinelRef = useInfiniteLoad(
    // The upload sentinel is active only in the dedicated category. All mode remains button-driven so
    // scrolling the page cannot silently expand every uploads/session section.
    !uploadsCollapsed &&
      supportsIntersectionObserver &&
      effectiveFilterId === 'uploads' &&
      visibleUploadFiles.length > 0 &&
      !index.uploads.isLoading &&
      !index.uploads.error &&
      Boolean(index.uploads.nextCursor),
    index.loadMoreUploads
  )
  const groupsSentinelRef = useInfiniteLoad(
    // Group headers have their own cursor because loading another session must not advance any file page.
    effectiveFilterId === 'all' &&
      supportsIntersectionObserver &&
      !index.groups.isLoading &&
      !index.groups.error &&
      Boolean(index.groups.nextCursor),
    index.loadMoreGroups
  )
  const hasLoadedInitialPages = index.uploads.isLoaded && index.groups.isLoaded
  const hasPageError = Boolean(index.overviewError || index.uploads.error || index.groups.error)

  return (
    <div data-testid="files-view" className="flex h-full min-h-0 w-full flex-col bg-bg-10">
      <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-1">
        <ProjectFilesFilterMenu
          label={effectiveFilterId === 'all' ? 'Artifacts' : selectedFilterOption.label}
          options={filterOptions}
          selectedOptionId={effectiveFilterId}
          onSelect={selectFilter}
          canLoadMoreOptions={Boolean(index.groups.nextCursor) && !index.groups.isLoading}
          onLoadMoreOptions={() => void index.loadMoreGroups()}
        />
        <div className="text-[11px] text-text-300">{visibleFileCount} files</div>
      </div>

      <div data-testid="project-files-scroll" className="min-h-0 flex-1 overflow-y-auto pb-4">
        {!index.overview.isIndexComplete ? (
          <div className="mx-4 mb-2 flex items-center justify-between gap-3 border-l-2 border-warning-000 px-3 py-2 text-[11px] text-text-200">
            <span className="min-w-0 flex-1">
              {index.repairError ?? 'Some files could not be indexed yet.'}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label="Retry indexing project files"
              disabled={index.isRepairing}
              onClick={() => void index.repairIndex()}
            >
              {index.isRepairing ? 'Retrying...' : 'Retry'}
            </Button>
          </div>
        ) : null}

        {index.overviewError ? (
          <PageLoadError message={index.overviewError} onRetry={index.reload} />
        ) : null}

        {hasLoadedInitialPages &&
        index.overview.isIndexComplete &&
        visibleFileCount === 0 &&
        !hasPageError ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-text-300">
            No files yet
          </div>
        ) : null}

        {(effectiveFilterId === 'all' || effectiveFilterId === 'uploads') &&
        (index.overview.uploadCount > 0 || Boolean(index.uploads.error)) ? (
          <section>
            <SectionHeader
              id="uploads"
              title="Your uploads"
              countLabel={`${index.overview.uploadCount}`}
              isCollapsed={uploadsCollapsed}
              onToggle={toggleSection}
            />
            {!uploadsCollapsed ? (
              <>
                {visibleUploadFiles.length > 0 ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2 px-4 py-3">
                    {visibleUploadFiles.map((file) => (
                      <FileTile
                        key={file.id}
                        name={file.name}
                        previewArtifact={createProjectFilePreviewArtifact(file)}
                        preview={currentFilePreviewById.get(file.id)}
                        source="upload"
                        size={file.size}
                        timestamp={file.mtimeMs ?? file.sortAtMs}
                        previewLabel={`Preview uploaded file ${file.name}`}
                        onPreview={() => previewFile(file)}
                      />
                    ))}
                    <div
                      ref={uploadSentinelRef}
                      data-testid="upload-page-sentinel"
                      className="col-span-full h-px"
                    />
                  </div>
                ) : null}
                {index.uploads.error ? (
                  <PageLoadError
                    message={index.uploads.error}
                    onRetry={() => void index.loadMoreUploads()}
                  />
                ) : null}
                <FilePageFooter
                  page={index.uploads}
                  mode={
                    effectiveFilterId === 'all' || !supportsIntersectionObserver
                      ? 'manual'
                      : 'scroll'
                  }
                  visibleItemCount={visibleUploadFiles.length}
                  loadMoreLabel="Load more uploaded files"
                  onLoadMore={() =>
                    effectiveFilterId === 'all'
                      ? revealNextAllPage(
                          'uploads',
                          allUploadVisibleItemLimit,
                          index.uploads,
                          index.loadMoreUploads
                        )
                      : void index.loadMoreUploads()
                  }
                />
              </>
            ) : null}
          </section>
        ) : null}

        {effectiveFilterId === 'all' && index.groups.error ? (
          <PageLoadError message={index.groups.error} onRetry={() => void index.loadMoreGroups()} />
        ) : null}

        {visibleArtifactGroups.length > 0 ? (
          <section>
            {effectiveFilterId === 'all' ? (
              <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-normal text-text-300">
                Generated files
              </div>
            ) : null}
            {visibleArtifactGroups.map((group) => (
              <ProjectArtifactGroupSection
                key={group.sessionId}
                group={group}
                title={getSessionTitle(group.sessionId)}
                page={index.artifactsBySession[group.sessionId]}
                loadMode={effectiveFilterId === 'all' ? 'manual' : 'scroll'}
                manualVisibleItemLimit={
                  allVisibleItemLimits[`session:${group.sessionId}`] ?? FILE_PAGE_SIZE
                }
                isCollapsed={collapsedSectionIds.has(`session:${group.sessionId}`)}
                onToggle={toggleSection}
                loadMore={index.loadMoreArtifacts}
                onManualLoadMore={() => {
                  const sectionId = `session:${group.sessionId}`
                  const visibleItemLimit = allVisibleItemLimits[sectionId] ?? FILE_PAGE_SIZE
                  revealNextAllPage(
                    sectionId,
                    visibleItemLimit,
                    index.artifactsBySession[group.sessionId],
                    () => index.loadMoreArtifacts(group.sessionId)
                  )
                }}
                previewById={currentFilePreviewById}
                onPreview={previewFile}
              />
            ))}
            <div ref={groupsSentinelRef} data-testid="group-page-sentinel" className="h-px" />
            {!supportsIntersectionObserver &&
            effectiveFilterId === 'all' &&
            index.groups.nextCursor &&
            !index.groups.isLoading &&
            !index.groups.error ? (
              <div className="flex justify-center px-4 py-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void index.loadMoreGroups()}
                >
                  Load more sessions
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
      <FilePreviewDialog item={dialogItem} onClose={() => setDialogItem(undefined)} />
    </div>
  )
}

const ProjectFilesView = (): React.JSX.Element => {
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const [previewReader] = useState<ProjectFilePreviewReader>(() => createProjectFilePreviewReader())

  return (
    <ProjectFilesViewContent
      key={activeProjectId ?? 'no-project'}
      activeProjectId={activeProjectId}
      previewReader={previewReader}
    />
  )
}

export { ProjectFilesView }
