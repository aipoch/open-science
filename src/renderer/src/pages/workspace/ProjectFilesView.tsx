import {
  Boxes,
  Check,
  ChevronDown,
  File,
  Folder,
  LayoutGrid,
  List,
  Maximize2,
  Minimize2,
  Paperclip,
  Plus,
  Search,
  Server,
  X
} from 'lucide-react'
import { ToggleGroup } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, formatByteSize } from '@/lib/utils'
import { useNavigationStore } from '@/stores/navigation-store'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import {
  PROJECT_FILES_PREVIEW_ID,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'
import { useComputeStore } from '@/stores/compute-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type {
  ArtifactGroupItem,
  ProjectFileItem,
  ProjectFileOriginSession,
  ProjectFilesChangedEvent
} from '../../../../shared/project-files'

import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
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
import { FileBrowserModal } from '../settings/FileBrowserModal'
import { getPreviewThumbnailReadEncoding } from './preview-support'
import { createKeyedRequestReader } from './project-file-preview-queue'
import { isUnavailableFileError, FILE_MISSING_TAG } from './previews/preview-errors'
import { createPreviewRequestScope, getPreviewFileReader } from './previews/preview-file-reader'
import { useNearViewport } from './previews/useNearViewport'
import { useUnavailablePreviewProbe } from './previews/useUnavailablePreviewProbe'
import {
  FILE_PAGE_SIZE,
  useProjectFilesIndex,
  type PageState,
  type ProjectFilesIndexScope
} from './use-project-files-index'

type ProjectFilesFilterOption = {
  id: string
  label: string
  count: number
  kind: 'all' | 'uploads' | 'session'
  originSession?: ProjectFileOriginSession
}

// Keeps collection semantics visible in both the menu rows and the currently selected trigger.
const ProjectFilesFilterIcon = ({
  kind,
  className
}: {
  kind: ProjectFilesFilterOption['kind']
  className: string
}): React.JSX.Element => {
  if (kind === 'uploads') {
    return <Paperclip className={className} strokeWidth={1.8} aria-hidden="true" />
  }
  if (kind === 'session') {
    return <Folder className={className} strokeWidth={1.8} aria-hidden="true" />
  }
  return <Boxes className={className} strokeWidth={1.8} aria-hidden="true" />
}

const COLLAPSED_SESSION_OPTION_COUNT = 5

// Caps the collapsed menu at five sessions while reserving the final slot for an active session
// that lies later in the independently paginated option catalog.
const getCollapsedSessionOptions = (
  options: ProjectFilesFilterOption[],
  selectedOptionId: string
): ProjectFilesFilterOption[] => {
  const firstOptions = options.slice(0, COLLAPSED_SESSION_OPTION_COUNT)
  const selectedOption = options.find((option) => option.id === selectedOptionId)
  if (!selectedOption || firstOptions.some((option) => option.id === selectedOptionId)) {
    return firstOptions
  }

  return [...firstOptions.slice(0, COLLAPSED_SESSION_OPTION_COUNT - 1), selectedOption]
}

type ProjectFilePreviewTarget = {
  id: string
  path: string
  source: 'artifact' | 'upload'
  artifact: MessageArtifact
  projectId: string
  sessionId: string
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
type ProjectFilesViewMode = 'grid' | 'list'

const PREVIEW_READ_CONCURRENCY = 4
const MAX_PREVIEW_CACHE_ENTRIES = 96
// Keeps manual pagination recognizable without the outline competing with the surrounding file tiles.
const loadMoreButtonClassName = 'bg-bg-200 text-text-100 hover:bg-bg-300 hover:text-text-000'
// Shares count grammar between the toolbar summary and independently paginated section headers.
const formatFileCount = (count: number): string => `${count} file${count === 1 ? '' : 's'}`

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

const createProjectFilePreviewArtifact = (file: ProjectFileItem): MessageArtifact => ({
  id: file.sourceVersionId ?? file.sourceFileId,
  artifactId: file.source === 'artifact' ? file.sourceFileId : undefined,
  versionId: file.sourceVersionId,
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
  target: Pick<
    ProjectFilePreviewTarget,
    'id' | 'path' | 'source' | 'artifact' | 'projectId' | 'sessionId'
  >
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
      ...createPreviewRequestScope({
        projectId: target.projectId,
        sessionId: target.sessionId,
        source: target.source,
        path: target.path
      }),
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
  hideTopBorder = false,
  onToggle
}: {
  id: string
  title: string
  countLabel: string
  isCollapsed: boolean
  hideTopBorder?: boolean
  onToggle: (id: string) => void
}): React.JSX.Element => (
  <button
    type="button"
    data-testid="project-file-section-header"
    className={cn(
      'flex w-full min-w-0 items-center gap-1.5 px-4 py-2 text-left text-sm text-text-000 hover:bg-bg-100',
      !hideTopBorder && 'border-t border-border-300/40'
    )}
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
        variant="ghost"
        size="xs"
        className={loadMoreButtonClassName}
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
  projectId,
  sessionId,
  size,
  timestamp,
  previewLabel,
  onPreview
}: {
  name: string
  previewArtifact: MessageArtifact
  preview?: ArtifactPreviewResult
  source: 'artifact' | 'upload'
  projectId: string
  sessionId: string
  size?: number
  timestamp?: number
  previewLabel: string
  onPreview: () => void
}): React.JSX.Element => {
  const sizeLabel = formatByteSize(size)
  const relativeTimeLabel = formatRelativeFileTime(timestamp)
  const [setTileElement, isNearViewport] = useNearViewport<HTMLButtonElement>()
  const missing = useUnavailablePreviewProbe({
    enabled: isNearViewport,
    projectId,
    sessionId,
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
          <ArtifactPreview
            artifact={previewArtifact}
            preview={preview}
            source={source}
            projectId={projectId}
            sessionId={sessionId}
            isVisible={isNearViewport}
          />
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
          <ExtensionPreservingFileName
            name={name}
            className="text-[11px] leading-5 text-text-000"
          />
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

// List mode stays metadata-only: the download action replaces right-side details on hover, while the
// row container owns the single focus ring shared by preview and download controls.
const FileListRow = ({
  file,
  previewLabel,
  onPreview
}: {
  file: ProjectFileItem
  previewLabel: string
  onPreview: () => void
}): React.JSX.Element => {
  const [setRowElement, isNearViewport] = useNearViewport<HTMLButtonElement>()
  const missing = useUnavailablePreviewProbe({
    enabled: isNearViewport,
    projectId: file.projectId,
    sessionId: file.sessionId,
    path: file.path,
    source: file.source
  })
  const sizeLabel = formatByteSize(file.size)
  const relativeTimeLabel = formatRelativeFileTime(file.mtimeMs ?? file.sortAtMs)

  return (
    <div className="group relative flex h-9 min-w-0 items-center rounded-md text-text-000 transition-colors duration-150 hover:bg-bg-200 focus-within:ring-3 focus-within:ring-ring/50 focus-within:ring-inset motion-reduce:transition-none">
      <button
        ref={setRowElement}
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-2 text-left focus-visible:outline-none"
        aria-label={previewLabel}
        title={file.name}
        onClick={onPreview}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded bg-bg-200 text-text-300">
          <File className="size-4" strokeWidth={1.7} aria-hidden="true" />
        </span>
        <ExtensionPreservingFileName
          name={file.name}
          className={cn('flex-1 text-[12px]', missing && 'opacity-50')}
        />
        {missing ? (
          <span className="shrink-0 text-[9px] font-semibold uppercase text-text-300">
            {FILE_MISSING_TAG}
          </span>
        ) : null}
        {sizeLabel || relativeTimeLabel ? (
          <span
            data-testid="project-file-list-meta"
            className="hidden shrink-0 items-center gap-1 text-[10px] tabular-nums text-text-300 group-hover:invisible sm:flex"
          >
            {sizeLabel ? <span>{sizeLabel}</span> : null}
            {sizeLabel && relativeTimeLabel ? <span aria-hidden="true">·</span> : null}
            {relativeTimeLabel ? <span>{relativeTimeLabel}</span> : null}
          </span>
        ) : null}
      </button>
      <ManagedFileDownloadButton
        source={file.source}
        path={file.path}
        suggestedName={file.name}
        disabled={missing}
        revealOnParentHover
        wrapperClassName="absolute right-2 top-1/2 z-10 -translate-y-1/2"
      />
    </div>
  )
}

// Switches presentation without changing file identity or pagination; only grid mode consumes the
// bounded thumbnail cache supplied by previewById.
const ProjectFileItems = ({
  files,
  viewMode,
  previewById,
  onPreview
}: {
  files: ProjectFileItem[]
  viewMode: ProjectFilesViewMode
  previewById: Map<string, ArtifactPreviewResult | undefined>
  onPreview: (file: ProjectFileItem) => void
}): React.JSX.Element => (
  <div
    data-view-mode={viewMode}
    className={cn(
      viewMode === 'grid'
        ? 'grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2 px-4 py-3'
        : 'px-4 py-2'
    )}
  >
    {files.map((file) => {
      const previewLabel = `Preview ${file.source === 'upload' ? 'uploaded' : 'generated'} file ${file.name}`
      if (viewMode === 'list') {
        return (
          <FileListRow
            key={file.id}
            file={file}
            previewLabel={previewLabel}
            onPreview={() => onPreview(file)}
          />
        )
      }

      return (
        <FileTile
          key={file.id}
          name={file.name}
          previewArtifact={createProjectFilePreviewArtifact(file)}
          preview={previewById.get(file.id)}
          source={file.source}
          projectId={file.projectId}
          sessionId={file.sessionId}
          size={file.size}
          timestamp={file.mtimeMs ?? file.sortAtMs}
          previewLabel={previewLabel}
          onPreview={() => onPreview(file)}
        />
      )
    })}
  </div>
)

const FilterMenuItem = ({
  option,
  isSelected,
  onSelect
}: {
  option: ProjectFilesFilterOption
  isSelected: boolean
  onSelect: (optionId: string) => void
}): React.JSX.Element => {
  return (
    <DropdownMenuItem
      role="menuitemradio"
      aria-checked={isSelected}
      data-filter-id={option.id}
      className="gap-2"
      onSelect={() => onSelect(option.id)}
    >
      <ProjectFilesFilterIcon kind={option.kind} className="size-4 shrink-0 text-text-300" />
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {isSelected ? (
        <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
      ) : null}
      <span className="shrink-0 text-[11px] text-text-300">{option.count}</span>
    </DropdownMenuItem>
  )
}

// Keeps all/uploads filters fixed while session choices expand through their own group-header cursor,
// preventing menu exploration from advancing any file collection shown in the content area.
const ProjectFilesFilterMenu = ({
  label,
  options,
  selectedOptionId,
  onSelect,
  showAllSessions,
  onShowAllSessionsChange,
  sessionOptionCount,
  canLoadMoreOptions,
  optionsLoadError,
  onLoadMoreOptions,
  onBrowseRemoteHost
}: {
  label: string
  options: ProjectFilesFilterOption[]
  selectedOptionId: string
  onSelect: (optionId: string) => void
  showAllSessions: boolean
  onShowAllSessionsChange: (showAll: boolean) => void
  sessionOptionCount: number
  canLoadMoreOptions: boolean
  optionsLoadError?: string
  onLoadMoreOptions: () => void
  onBrowseRemoteHost: (providerId: string) => void
}): React.JSX.Element => {
  const hosts = useComputeStore((state) => state.hosts)
  const openSettingsToCompute = useSettingsStore((state) => state.openSettingsToCompute)
  const fixedOptions = options.filter((option) => option.kind !== 'session')
  const sessionOptions = options.filter((option) => option.kind === 'session')
  const visibleSessionOptions = showAllSessions
    ? sessionOptions
    : getCollapsedSessionOptions(sessionOptions, selectedOptionId)
  const showSessionOptionsToggle = sessionOptionCount > COLLAPSED_SESSION_OPTION_COUNT
  const selectedOptionKind = options.find((option) => option.id === selectedOptionId)?.kind ?? 'all'

  useEffect(() => {
    // Expanded menus consume one existing cursor page per render until every session is available.
    if (showAllSessions && canLoadMoreOptions) onLoadMoreOptions()
  }, [canLoadMoreOptions, onLoadMoreOptions, showAllSessions])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="max-w-[220px] gap-1.5"
          aria-label="Filter project files"
        >
          <ProjectFilesFilterIcon
            kind={selectedOptionKind}
            className="size-3.5 shrink-0 text-text-300"
          />
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
        // The expanded files modal stacks at z-[56]; keep portaled popovers above it.
        className="z-[70] max-h-[360px] w-[320px] overflow-y-auto"
      >
        <DropdownMenuLabel>Artifacts</DropdownMenuLabel>
        <DropdownMenuGroup>
          {fixedOptions.map((option) => (
            <FilterMenuItem
              key={option.id}
              option={option}
              isSelected={option.id === selectedOptionId}
              onSelect={onSelect}
            />
          ))}
          {visibleSessionOptions.map((option) => (
            <FilterMenuItem
              key={option.id}
              option={option}
              isSelected={option.id === selectedOptionId}
              onSelect={onSelect}
            />
          ))}
          {showAllSessions && optionsLoadError ? (
            <DropdownMenuItem
              data-testid="session-options-retry"
              className="min-h-7 py-1 text-[11px] text-muted-foreground"
              onSelect={(event) => {
                event.preventDefault()
                onLoadMoreOptions()
              }}
            >
              Retry loading sessions
            </DropdownMenuItem>
          ) : null}
          {showSessionOptionsToggle ? (
            <DropdownMenuItem
              data-testid="session-options-toggle"
              className="min-h-7 py-1 text-[11px] text-muted-foreground"
              onSelect={(event) => {
                event.preventDefault()
                onShowAllSessionsChange(!showAllSessions)
              }}
            >
              {showAllSessions ? 'Show fewer' : `Show all ${sessionOptionCount} sessions`}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>

        {/* REMOTE section: SSH compute hosts */}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>REMOTE</DropdownMenuLabel>
        <DropdownMenuGroup>
          {hosts.map((host) => {
            const reachable = host.probeResult?.ok === true
            return (
              <DropdownMenuItem
                key={host.providerId}
                disabled={!reachable}
                onSelect={() => {
                  if (reachable) onBrowseRemoteHost(host.providerId)
                }}
                className={cn('gap-2', !reachable && 'opacity-50 cursor-not-allowed')}
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    reachable ? 'bg-emerald-400' : 'bg-muted-foreground/40'
                  )}
                  aria-hidden="true"
                />
                <Server
                  className="size-4 shrink-0 text-text-300"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{host.displayName}</span>
                {!reachable && (
                  <span className="shrink-0 text-[11px] text-text-300">Host unreachable</span>
                )}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuItem
            className="gap-2 text-muted-foreground"
            onSelect={() => openSettingsToCompute()}
          >
            <Plus className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
            <span>Add SSH host…</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Renders one independently paginated artifact collection. All mode reveals local batches of 20 with
// a compact button, while a selected session consumes its cursor through the intersection sentinel.
const ProjectArtifactGroupSection = ({
  group,
  title,
  page,
  loadMode,
  manualVisibleItemLimit,
  isCollapsed,
  hideTopBorder,
  onToggle,
  loadMore,
  onManualLoadMore,
  viewMode,
  previewById,
  onPreview
}: {
  group: ArtifactGroupItem
  title: string
  page: PageState<ProjectFileItem> | undefined
  loadMode: FilePageLoadMode
  manualVisibleItemLimit: number
  isCollapsed: boolean
  hideTopBorder: boolean
  onToggle: (id: string) => void
  loadMore: (sessionId: string) => Promise<void>
  onManualLoadMore: () => void
  viewMode: ProjectFilesViewMode
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
        countLabel={formatFileCount(group.artifactCount)}
        isCollapsed={isCollapsed}
        hideTopBorder={hideTopBorder}
        onToggle={onToggle}
      />
      {!isCollapsed ? (
        <>
          {visibleItems.length ? (
            <ProjectFileItems
              files={visibleItems}
              viewMode={viewMode}
              previewById={previewById}
              onPreview={onPreview}
            />
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
  const isFilesExpanded = usePreviewWorkbenchStore(
    (state) => state.expandedToolItemId === PROJECT_FILES_PREVIEW_ID
  )
  const setToolItemExpanded = usePreviewWorkbenchStore((state) => state.setToolItemExpanded)
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(() => new Set())
  const [selectedFilterId, setSelectedFilterId] = useState('all')
  const [selectedSessionFallback, setSelectedSessionFallback] = useState<ProjectFilesFilterOption>()
  const [allVisibleItemLimits, setAllVisibleItemLimits] = useState<Record<string, number>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState<ProjectFilesViewMode>('grid')
  const [showAllSessionOptions, setShowAllSessionOptions] = useState(false)
  // Files-tab previews are transient dialog state; opening a file must not create a workbench tab.
  const [dialogItem, setDialogItem] = useState<PreviewFileItem | undefined>(undefined)

  // Remote file browser modal state — set to a providerId when a REMOTE host is selected.
  const [browseProviderId, setBrowseProviderId] = useState<string | undefined>(undefined)
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

  const catalogIndex = useProjectFilesIndex(activeProjectId, handleIndexChanged)
  // The expanded filter menu owns a separate group cursor so loading every session option does not
  // append hidden groups or trigger artifact-page reads in the visible catalog.
  const sessionOptionsIndex = useProjectFilesIndex(
    showAllSessionOptions ? activeProjectId : undefined,
    undefined,
    undefined,
    { kind: 'artifactGroups' }
  )
  const isSearchActive = debouncedSearchQuery.length > 0
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
  const filterGroupItems =
    showAllSessionOptions && sessionOptionsIndex.groups.items.length > 0
      ? sessionOptionsIndex.groups.items
      : catalogIndex.groups.items
  const getArtifactGroupTitle = useCallback(
    (group: ArtifactGroupItem): string => {
      const title = group.originSession?.title ?? getSessionTitle(group.sessionId)
      return group.originSession?.state === 'deleted' ? `${title} · Source session deleted` : title
    },
    [getSessionTitle]
  )
  const filterOptions = useMemo<ProjectFilesFilterOption[]>(() => {
    const options: ProjectFilesFilterOption[] = [
      {
        id: 'all',
        label: 'All artifacts',
        count: catalogIndex.overview.totalCount,
        kind: 'all'
      },
      {
        id: 'uploads',
        label: 'Your uploads',
        count: catalogIndex.overview.uploadCount,
        kind: 'uploads'
      },
      ...filterGroupItems.map((group) => ({
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
      !options.some((option) => option.id === selectedSessionFallback.id)
    ) {
      const sessionId = selectedSessionFallback.id.slice('session:'.length)
      options.push({
        ...selectedSessionFallback,
        count:
          catalogIndex.artifactsBySession[sessionId]?.totalCount ?? selectedSessionFallback.count
      })
    }

    return options
  }, [
    getArtifactGroupTitle,
    catalogIndex.artifactsBySession,
    catalogIndex.overview,
    filterGroupItems,
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
    ? catalogIndex.groups.items.some((group) => group.sessionId === selectedSessionId)
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
          ? {
              kind: 'sessionArtifacts',
              sessionId: effectiveSessionId
            }
          : { kind: 'all' },
    [effectiveSessionId, isUploadsFilter]
  )
  // Search follows the selected collection but leaves catalog cursors mounted, so clearing the query
  // restores the previous grouped view without rebuilding its loaded pages.
  const searchIndex = useProjectFilesIndex(
    isSearchActive ? activeProjectId : undefined,
    undefined,
    isSearchActive ? { filenameContains: debouncedSearchQuery } : undefined,
    searchScope
  )
  const index = isSearchActive ? searchIndex : catalogIndex
  const uploadsCollapsed = collapsedSectionIds.has('uploads')
  const allUploadVisibleItemLimit = allVisibleItemLimits.uploads ?? FILE_PAGE_SIZE
  const visibleUploadFiles = useMemo(() => {
    if (isUploadsFilter) return index.uploads.items
    if (isAllFilter) {
      return index.uploads.items.slice(0, allUploadVisibleItemLimit)
    }
    return []
  }, [allUploadVisibleItemLimit, index.uploads.items, isAllFilter, isUploadsFilter])
  const visibleArtifactGroups = useMemo(
    () =>
      isAllFilter
        ? index.groups.items
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
  const previewTargets = useMemo<ProjectFilePreviewTarget[]>(
    // Collapsed sections are intentionally absent: they neither protect cache entries nor enqueue new
    // thumbnail reads. List rows use only the lightweight availability probe and need no thumbnails.
    () =>
      viewMode === 'grid'
        ? [...(uploadsCollapsed ? [] : visibleUploadFiles), ...visibleArtifactFiles].map((file) =>
            createProjectFilePreviewTarget({
              id: file.id,
              path: file.path,
              source: file.source,
              artifact: createProjectFilePreviewArtifact(file),
              projectId: file.projectId,
              sessionId: file.sessionId
            })
          )
        : [],
    [uploadsCollapsed, viewMode, visibleArtifactFiles, visibleUploadFiles]
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
        projectId: activeProjectId,
        sessionId: file.sessionId,
        path: file.path,
        name: file.name,
        mimeType: file.mimeType,
        source: file.source === 'upload' ? 'upload' : undefined,
        size: file.size,
        mtimeMs: file.mtimeMs,
        artifactId: file.source === 'artifact' ? file.sourceFileId : undefined,
        selectedVersionId: file.source === 'artifact' ? file.sourceVersionId : undefined,
        originSession: file.originSession
      })
    )
  }

  const supportsIntersectionObserver = typeof IntersectionObserver !== 'undefined'
  const uploadSentinelRef = useInfiniteLoad(
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
  const groupsSentinelRef = useInfiniteLoad(
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

  return (
    <div data-testid="files-view" className="flex h-full min-h-0 w-full flex-col bg-bg-10">
      <div
        className={cn(
          'flex shrink-0 items-center justify-between gap-3 px-4 pb-2',
          // In the expanded modal the toolbar's top gap matches its distance to the search row.
          isFilesExpanded ? 'pt-2' : 'pt-1'
        )}
      >
        <ProjectFilesFilterMenu
          label={isAllFilter ? 'Artifacts' : selectedFilterOption.label}
          options={filterOptions}
          selectedOptionId={effectiveFilterId}
          onSelect={selectFilter}
          showAllSessions={showAllSessionOptions}
          onShowAllSessionsChange={setShowAllSessionOptions}
          sessionOptionCount={catalogIndex.overview.artifactGroupCount}
          canLoadMoreOptions={
            Boolean(sessionOptionsIndex.groups.nextCursor) &&
            !sessionOptionsIndex.groups.isLoading &&
            !sessionOptionsIndex.groups.error
          }
          optionsLoadError={sessionOptionsIndex.groups.error}
          onLoadMoreOptions={() => void sessionOptionsIndex.loadMoreGroups()}
          onBrowseRemoteHost={(providerId) => setBrowseProviderId(providerId)}
        />
        <TooltipProvider delayDuration={200}>
          <div className="flex shrink-0 items-center gap-1.5">
            <ToggleGroup.Root
              type="single"
              value={viewMode}
              aria-label="File view"
              className="flex h-8 shrink-0 items-center rounded-lg border border-border bg-card p-0.5"
              onValueChange={(value) => {
                if (value === 'grid' || value === 'list') setViewMode(value)
              }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <ToggleGroup.Item
                    value="grid"
                    aria-label="Grid view"
                    className="flex size-7 items-center justify-center rounded-md text-text-300 outline-none hover:bg-muted hover:text-text-000 focus-visible:ring-3 focus-visible:ring-ring/50 aria-checked:bg-bg-400 aria-checked:text-text-000 aria-checked:shadow-sm aria-checked:hover:bg-bg-400"
                  >
                    <LayoutGrid className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
                  </ToggleGroup.Item>
                </TooltipTrigger>
                <TooltipContent className="z-[70]">Grid view</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ToggleGroup.Item
                    value="list"
                    aria-label="List view"
                    className="flex size-7 items-center justify-center rounded-md text-text-300 outline-none hover:bg-muted hover:text-text-000 focus-visible:ring-3 focus-visible:ring-ring/50 aria-checked:bg-bg-400 aria-checked:text-text-000 aria-checked:shadow-sm aria-checked:hover:bg-bg-400"
                  >
                    <List className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
                  </ToggleGroup.Item>
                </TooltipTrigger>
                <TooltipContent className="z-[70]">List view</TooltipContent>
              </Tooltip>
            </ToggleGroup.Root>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="rounded-md text-text-000 hover:bg-muted"
                  aria-label={isFilesExpanded ? 'Exit full screen files' : 'Expand files'}
                  onClick={() =>
                    setToolItemExpanded(isFilesExpanded ? null : PROJECT_FILES_PREVIEW_ID)
                  }
                >
                  {isFilesExpanded ? (
                    <Minimize2 className="size-4" strokeWidth={1.8} aria-hidden="true" />
                  ) : (
                    <Maximize2 className="size-4" strokeWidth={1.8} aria-hidden="true" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent className="z-[70]">
                {isFilesExpanded ? 'Exit full screen' : 'Expand files'}
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>
      <div className="flex shrink-0 items-center gap-3 border-y border-border-300/60 px-4 py-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-300"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search project files"
            placeholder="Search artifacts..."
            value={searchQuery}
            maxLength={256}
            className="h-[30px] border-0 bg-transparent pl-8 pr-8 shadow-none [&::-webkit-search-cancel-button]:hidden"
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchQuery ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Clear file search"
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-text-100 hover:bg-bg-200 hover:text-text-100"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setSearchQuery('')}
                  >
                    <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="z-[70]">Clear search</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
        <div className="shrink-0 text-[11px] tabular-nums text-text-300">
          {formatFileCount(visibleFileCount)}
        </div>
      </div>

      <div data-testid="project-files-scroll" className="min-h-0 flex-1 overflow-y-auto pb-4">
        {!catalogIndex.overview.isIndexComplete ? (
          <div className="mx-4 mb-2 flex items-center justify-between gap-3 border-l-2 border-warning-000 px-3 py-2 text-[11px] text-text-200">
            <span className="min-w-0 flex-1">
              {catalogIndex.repairError ?? 'Some files could not be indexed yet.'}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label="Retry indexing project files"
              disabled={catalogIndex.isRepairing}
              onClick={() => void catalogIndex.repairIndex()}
            >
              {catalogIndex.isRepairing ? 'Retrying...' : 'Retry'}
            </Button>
          </div>
        ) : null}

        {catalogIndex.overviewError ? (
          <PageLoadError message={catalogIndex.overviewError} onRetry={catalogIndex.reload} />
        ) : null}

        {isSearchActive && isAllFilter && index.overviewError ? (
          <PageLoadError message={index.overviewError} onRetry={index.reload} />
        ) : null}

        {hasLoadedInitialPages &&
        catalogIndex.overview.isIndexComplete &&
        visibleFileCount === 0 &&
        !hasPageError ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-text-300">
            {isSearchActive ? `No files match “${debouncedSearchQuery}”` : 'No files yet'}
          </div>
        ) : null}

        {showsUploadsSection ? (
          <section>
            <SectionHeader
              id="uploads"
              title="Your uploads"
              countLabel={`${index.uploads.totalCount}`}
              isCollapsed={uploadsCollapsed}
              hideTopBorder
              onToggle={toggleSection}
            />
            {!uploadsCollapsed ? (
              <>
                {visibleUploadFiles.length > 0 ? (
                  <ProjectFileItems
                    files={visibleUploadFiles}
                    viewMode={viewMode}
                    previewById={currentFilePreviewById}
                    onPreview={previewFile}
                  />
                ) : null}
                <div ref={uploadSentinelRef} data-testid="upload-page-sentinel" className="h-px" />
                {index.uploads.error ? (
                  <PageLoadError
                    message={index.uploads.error}
                    onRetry={() => void index.loadMoreUploads()}
                  />
                ) : null}
                <FilePageFooter
                  page={index.uploads}
                  mode={isAllFilter || !supportsIntersectionObserver ? 'manual' : 'scroll'}
                  visibleItemCount={visibleUploadFiles.length}
                  loadMoreLabel="Load more uploaded files"
                  onLoadMore={() =>
                    isAllFilter
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

        {isAllFilter && index.groups.error ? (
          <PageLoadError message={index.groups.error} onRetry={() => void index.loadMoreGroups()} />
        ) : null}

        {visibleArtifactGroups.length > 0 ? (
          <section>
            {isAllFilter ? (
              <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-normal text-text-300">
                Generated files
              </div>
            ) : null}
            {visibleArtifactGroups.map((group, groupIndex) => (
              <ProjectArtifactGroupSection
                key={group.sessionId}
                group={group}
                title={getArtifactGroupTitle(group)}
                page={index.artifactsBySession[group.sessionId]}
                loadMode={isAllFilter ? 'manual' : 'scroll'}
                manualVisibleItemLimit={
                  allVisibleItemLimits[`session:${group.sessionId}`] ?? FILE_PAGE_SIZE
                }
                isCollapsed={collapsedSectionIds.has(`session:${group.sessionId}`)}
                hideTopBorder={!showsUploadsSection && groupIndex === 0}
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
                viewMode={viewMode}
                previewById={currentFilePreviewById}
                onPreview={previewFile}
              />
            ))}
            <div ref={groupsSentinelRef} data-testid="group-page-sentinel" className="h-px" />
            {!supportsIntersectionObserver &&
            isAllFilter &&
            index.groups.nextCursor &&
            !index.groups.isLoading &&
            !index.groups.error ? (
              <div className="flex justify-center px-4 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className={loadMoreButtonClassName}
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
      <FileBrowserModal
        open={browseProviderId !== undefined}
        onClose={() => setBrowseProviderId(undefined)}
        initialProviderId={browseProviderId}
      />
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
