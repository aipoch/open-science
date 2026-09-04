// Hallmark · pre-emit critique: P5 H5 E4 S5 R5 V4
import type { TFunction } from 'i18next'
import { ChevronDown, LayoutGrid, List, Maximize2, Minimize2, Search, X } from 'lucide-react'
import { ToggleGroup } from 'radix-ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ActionToast } from '@/components/ActionToast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { errorDetail } from '@/lib/error-detail'
import { relativeTimeParts, type RelativeTimeUnit } from '@/lib/format-relative-time'
import { cn } from '@/lib/utils'
import { useGrantedFoldersStore } from '@/stores/granted-folders-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSettingsStore } from '@/stores/settings-store'
import {
  PROJECT_FILES_PREVIEW_ID,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type { ArtifactGroupItem, ProjectFileItem } from '../../../../shared/project-files'
import type { GrantedLocalRoot } from '../../../../shared/local-fs'
import type { ProjectFilesFilterPreference } from '../../../../shared/settings'

import { createPreviewFileItem } from './preview-file-item'
import { FileBrowserModal } from '../settings/FileBrowserModal'
import { GrantFolderAccessDialog } from './GrantFolderAccessDialog'
import { LocalFileBrowser } from './LocalFileBrowser'
import {
  useProjectFilePreviewReader,
  useProjectFilePreviews,
  type ProjectFilePreviewReader
} from './project-files-preview-owner'
import {
  ProjectFileItems,
  ProjectFilesFilterMenu,
  type ProjectFilesViewMode
} from './project-files-presentation-owner'
import {
  readPersistedProjectFilesFilter,
  useProjectFileInfiniteLoad,
  useProjectFilesQueryModel
} from './project-files-query-model'
import { FILE_PAGE_SIZE, type PageState } from './use-project-files-index'

type FilePageLoadMode = 'manual' | 'scroll'
type GrantedRootMutationKind = 'change' | 'remove'

type GrantedRootMutationError = {
  kind: GrantedRootMutationKind
  detail?: string
  retry: () => Promise<unknown>
}

// Keeps manual pagination recognizable without the outline competing with the surrounding file tiles.
const loadMoreButtonClassName = 'bg-bg-200 text-text-100 hover:bg-bg-300 hover:text-text-000'
// Shares count grammar between the toolbar summary and independently paginated section headers.
const formatFileCount = (count: number, t: TFunction): string =>
  t('{{count}} files', { defaultValue_one: '{{count}} file', count })

// Compact elapsed labels that keep the trailing "ago", unlike the home page's bare `{{count}}d`: a
// section header shows this next to a file count, so the suffix is what marks it as a timestamp.
// Each bucket names its own English text because a natural-language key has to be a literal — the
// unit cannot be interpolated into it. `satisfies` turns a new RelativeTimeUnit into a compile error
// rather than an undefined label.
const ELAPSED_AGO = {
  minute: '{{count}}m ago',
  hour: '{{count}}h ago',
  day: '{{count}}d ago',
  week: '{{count}}w ago',
  month: '{{count}}mo ago',
  year: '{{count}}y ago'
} as const satisfies Record<Exclude<RelativeTimeUnit, 'now'>, string>

const formatElapsedAgo = (timestamp: number, t: TFunction): string => {
  const { unit, count } = relativeTimeParts(timestamp)
  return unit === 'now' ? t('now') : t(ELAPSED_AGO[unit], { count })
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
      id.startsWith('session:') && 'cursor-default',
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
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      aria-atomic="true"
      className="flex items-start justify-between gap-3 px-4 py-3 text-[11px] text-danger-000"
    >
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</span>
      <Button type="button" variant="outline" className="h-7 shrink-0 px-2.5" onClick={onRetry}>
        {t('Retry')}
      </Button>
    </div>
  )
}

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
  const { t } = useTranslation()

  if (!page?.isLoaded || page.error || page.items.length === 0) return null

  const hasMore = visibleItemCount < page.items.length || Boolean(page.nextCursor)

  if (!hasMore && !page.isLoading) {
    return (
      <div
        data-testid="project-files-end"
        className="px-4 py-2 text-center text-[11px] text-text-000"
      >
        {t('No more')}
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
        {t(page.isLoading ? 'Loading...' : 'Load more')}
      </Button>
    </div>
  )
}

// Renders one independently paginated artifact collection. All mode reveals local batches of 20 with
// a compact button, while a selected session consumes its cursor through the intersection sentinel.
const ProjectArtifactGroupSection = ({
  group,
  title,
  timestamp,
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
  onPreview,
  onOpenInPanel
}: {
  group: ArtifactGroupItem
  title: string
  timestamp: number | undefined
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
  onOpenInPanel: (file: ProjectFileItem) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const sectionId = `session:${group.sessionId}`
  const elapsedLabel = timestamp === undefined ? undefined : formatElapsedAgo(timestamp, t)
  const loadPage = useCallback(() => loadMore(group.sessionId), [group.sessionId, loadMore])
  const supportsIntersectionObserver = typeof IntersectionObserver !== 'undefined'
  const effectiveLoadMode =
    loadMode === 'scroll' && !supportsIntersectionObserver ? 'manual' : loadMode
  const canAutoLoad =
    !isCollapsed &&
    !page?.isLoading &&
    !page?.error &&
    (!page?.isLoaded || (effectiveLoadMode === 'scroll' && !!page.nextCursor))
  const sentinelRef = useProjectFileInfiniteLoad(canAutoLoad, loadPage)
  const visibleItems =
    loadMode === 'manual'
      ? (page?.items.slice(0, manualVisibleItemLimit) ?? [])
      : (page?.items ?? [])

  return (
    <section>
      <SectionHeader
        id={sectionId}
        title={title}
        countLabel={
          elapsedLabel
            ? `${group.artifactCount} · ${elapsedLabel}`
            : formatFileCount(group.artifactCount, t)
        }
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
              onOpenInPanel={onOpenInPanel}
            />
          ) : null}
          {page?.error ? (
            <PageLoadError message={page.error} onRetry={() => void loadPage()} />
          ) : null}
          <FilePageFooter
            page={page}
            mode={effectiveLoadMode}
            visibleItemCount={visibleItems.length}
            loadMoreLabel={t('Load more files from {{title}}', { title })}
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
  const { t } = useTranslation()
  const isFilesExpanded = usePreviewWorkbenchStore(
    (state) => state.expandedToolItemId === PROJECT_FILES_PREVIEW_ID
  )
  const setToolItemExpanded = usePreviewWorkbenchStore((state) => state.setToolItemExpanded)
  const [viewMode, setViewMode] = useState<ProjectFilesViewMode>('grid')
  const openFileDialog = usePreviewWorkbenchStore((state) => state.openFileDialog)
  const fileDialogCleanupState = useRef({ version: 0 })

  useEffect(() => {
    const cleanupState = fileDialogCleanupState.current
    const cleanupVersion = ++cleanupState.version

    return () => {
      // StrictMode immediately remounts effects; defer so that pass can cancel this cleanup.
      queueMicrotask(() => {
        if (cleanupState.version !== cleanupVersion) return

        const workbench = usePreviewWorkbenchStore.getState()
        if (workbench.fileDialogItem?.projectId === activeProjectId) {
          workbench.closeFileDialog()
        }
      })
    }
  }, [activeProjectId])

  // Remote file browser modal state — set to a providerId when a REMOTE host is selected.
  const [browseProviderId, setBrowseProviderId] = useState<string | undefined>(undefined)
  // Device name for the "this computer" source entry; undefined until roots resolve.
  const [localMachineName, setLocalMachineName] = useState<string | undefined>(undefined)
  // Which container the tab body shows: the artifacts list or the local ("this computer") browser.
  // A persisted local filter only applies where localFs exists (Electron).
  const [sourceMode, setSourceMode] = useState<'artifacts' | 'local'>(() => {
    const persisted = readPersistedProjectFilesFilter()
    return persisted?.sourceMode === 'local' && window.api?.localFs ? 'local' : 'artifacts'
  })
  // Entry count reported by the local browser, so the header count tracks the visible container.
  const [localEntryCount, setLocalEntryCount] = useState<number | undefined>(undefined)
  // One-shot navigation request for the local browser, set when a granted folder is picked in the
  // filter menu. The nonce makes repeated picks of the same folder observable.
  const [localRequestedPath, setLocalRequestedPath] = useState<
    { path: string; nonce: number } | undefined
  >(undefined)
  // Granted folder the local browser is scoped to; undefined means the machine itself.
  const [selectedLocalRootId, setSelectedLocalRootId] = useState<string | undefined>(undefined)
  const [grantDialogOpen, setGrantDialogOpen] = useState(false)
  const [grantedRootMutationError, setGrantedRootMutationError] =
    useState<GrantedRootMutationError>()

  const runGrantedRootMutation = (
    kind: GrantedRootMutationKind,
    mutation: () => Promise<unknown>
  ): Promise<void> => {
    setGrantedRootMutationError(undefined)
    return mutation().then(
      () => undefined,
      (error: unknown) => {
        setGrantedRootMutationError({
          kind,
          detail: errorDetail(error),
          retry: mutation
        })
      }
    )
  }

  // Load the granted folders once so the filter menu can list them; localFs is absent outside
  // Electron, where the section just shows the machine entry and "Add folder…" stays inert. A
  // persisted granted-folder filter is re-applied only when its root survives this refresh; a
  // revoked folder degrades to plain machine local mode.
  useEffect(() => {
    if (!window.api?.localFs) return
    void useGrantedFoldersStore
      .getState()
      .refresh()
      .then((roots) => {
        const persisted = useSettingsStore.getState().projectFilesFilter
        if (persisted?.sourceMode !== 'local' || persisted.localRootId === undefined) return
        const root = roots.find((candidate) => candidate.id === persisted.localRootId)
        if (!root) return
        setSelectedLocalRootId(root.id)
        setLocalRequestedPath({ path: root.path, nonce: 1 })
      })
      .catch(() => undefined)
  }, [])

  // Persists the Files-tab source filter so the tab restores it on the next launch. Called only
  // from user actions, never during mount restoration, so a restore can never trigger a write loop.
  const persistFilter = useCallback((filter: ProjectFilesFilterPreference): void => {
    void useSettingsStore.getState().setProjectFilesFilter(filter)
  }, [])

  // Picking a granted folder (or granting a new one) switches to the local browser at that path.
  const handleSelectGrantedRoot = useCallback(
    (root: GrantedLocalRoot): void => {
      setSourceMode('local')
      setSelectedLocalRootId(root.id)
      setLocalRequestedPath((previous) => ({ path: root.path, nonce: (previous?.nonce ?? 0) + 1 }))
      persistFilter({ sourceMode: 'local', localRootId: root.id })
    },
    [persistFilter]
  )

  // Picking the machine itself returns to the default Home landing; a stale requestedPath must not
  // re-trigger afterwards.
  const handleBrowseLocal = useCallback((): void => {
    setSourceMode('local')
    setSelectedLocalRootId(undefined)
    setLocalRequestedPath(undefined)
    persistFilter({ sourceMode: 'local' })
  }, [persistFilter])

  // Resolve the device name once so the dropdown entry reads as the machine it browses.
  // localFs is absent in non-Electron test/build contexts, so guard the surface before calling it.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const fetchedRoots = await window.api?.localFs?.getRoots()
        if (!cancelled && fetchedRoots) setLocalMachineName(fetchedRoots.machineName)
      } catch {
        // Leave the name undefined; the entry falls back to "This computer".
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const queryModel = useProjectFilesQueryModel(activeProjectId)
  const { catalogIndex, index, sessionOptionsIndex } = queryModel.indexes
  const {
    effectiveFilterId,
    filterOptions,
    isAllFilter,
    selectFilter: selectQueryFilter,
    selectedFilterOption,
    setShowAllSessionOptions,
    showAllSessionOptions
  } = queryModel.filter
  const {
    allUploadVisibleItemLimit,
    allVisibleItemLimits,
    collapsedSectionIds,
    groupsSentinelRef,
    revealNextAllPage,
    supportsIntersectionObserver,
    toggleSection,
    uploadSentinelRef,
    uploadsCollapsed
  } = queryModel.pagination
  const { debouncedSearchQuery, isSearchActive, searchQuery, setSearchQuery } = queryModel.search
  const { getArtifactGroupTitle, sessionById } = queryModel.sessions
  const {
    hasLoadedInitialPages,
    hasPageError,
    showsUploadsSection,
    visibleArtifactFiles,
    visibleArtifactGroups,
    visibleFileCount,
    visibleUploadFiles
  } = queryModel.visible

  const previewFiles = useMemo<ProjectFileItem[]>(
    // Collapsed sections are intentionally absent: they neither protect cache entries nor enqueue new
    // thumbnail reads. List rows use only the lightweight availability probe and need no thumbnails.
    () =>
      viewMode === 'grid'
        ? [...(uploadsCollapsed ? [] : visibleUploadFiles), ...visibleArtifactFiles]
        : [],
    [uploadsCollapsed, viewMode, visibleArtifactFiles, visibleUploadFiles]
  )
  const currentFilePreviewById = useProjectFilePreviews(previewFiles, previewReader)

  // Picking any artifact scope also returns the body to the artifacts container.
  const selectFilter = (filterId: string): void => {
    selectQueryFilter(filterId)
    setSourceMode('artifacts')
    setSelectedLocalRootId(undefined)
    persistFilter({ sourceMode: 'artifacts', optionId: filterId })
  }

  // Keep the indexed file identity and source so both destinations use the same bounded preview path.
  const toPreviewFile = (file: ProjectFileItem): ReturnType<typeof createPreviewFileItem> =>
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
      managedFileId: file.sourceFileId,
      originSession: file.originSession
    })

  const previewFile = (file: ProjectFileItem): void => {
    openFileDialog(toPreviewFile(file))
  }

  const openFileInPanel = (file: ProjectFileItem): void => {
    const workbench = usePreviewWorkbenchStore.getState()
    workbench.upsertAndActivateItem(toPreviewFile(file))
    workbench.openPanel()
  }

  const grantedRoots = useGrantedFoldersStore((state) => state.roots)
  const isLocalMode = sourceMode === 'local'
  // The granted folder the local browser is scoped to; a revoked root reads as the machine itself.
  const selectedLocalRoot = selectedLocalRootId
    ? grantedRoots.find((root) => root.id === selectedLocalRootId)
    : undefined
  const filesExpansionLabel = isFilesExpanded ? t('Exit full screen files') : t('Expand files')
  const grantedRootMutationErrorTitle = grantedRootMutationError
    ? grantedRootMutationError.kind === 'change'
      ? t('Could not change folder access.')
      : t('Could not remove folder access.')
    : undefined

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
          label={
            isLocalMode
              ? (selectedLocalRoot?.name ?? localMachineName ?? t('This computer'))
              : isAllFilter
                ? t('Artifacts')
                : selectedFilterOption.label
          }
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
          onBrowseLocal={handleBrowseLocal}
          onAddFolder={() => setGrantDialogOpen(true)}
          onSelectGrantedRoot={handleSelectGrantedRoot}
          onGrantedRootMutation={runGrantedRootMutation}
          localMachineName={localMachineName}
          isLocalSelected={isLocalMode}
          selectedLocalRootId={selectedLocalRoot?.id}
        />
        <TooltipProvider delayDuration={200}>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Local mode has no search row, so its file count stays in the header. */}
            {isLocalMode ? (
              <div className="text-[11px] tabular-nums text-text-000">
                {formatFileCount(localEntryCount ?? 0, t)}
              </div>
            ) : (
              <ToggleGroup.Root
                type="single"
                value={viewMode}
                aria-label={t('File view')}
                className="flex h-8 shrink-0 items-center rounded-lg border border-border bg-card p-0.5"
                onValueChange={(value) => {
                  if (value === 'grid' || value === 'list') setViewMode(value)
                }}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ToggleGroup.Item
                      value="grid"
                      aria-label={t('Grid view')}
                      className="flex size-7 items-center justify-center rounded-md text-text-300 outline-none hover:bg-muted hover:text-text-000 focus-visible:ring-3 focus-visible:ring-ring/50 aria-checked:bg-bg-400 aria-checked:text-text-000 aria-checked:shadow-sm aria-checked:hover:bg-bg-400"
                    >
                      <LayoutGrid className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
                    </ToggleGroup.Item>
                  </TooltipTrigger>
                  <TooltipContent className="z-[70]">{t('Grid view')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ToggleGroup.Item
                      value="list"
                      aria-label={t('List view')}
                      className="flex size-7 items-center justify-center rounded-md text-text-300 outline-none hover:bg-muted hover:text-text-000 focus-visible:ring-3 focus-visible:ring-ring/50 aria-checked:bg-bg-400 aria-checked:text-text-000 aria-checked:shadow-sm aria-checked:hover:bg-bg-400"
                    >
                      <List className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
                    </ToggleGroup.Item>
                  </TooltipTrigger>
                  <TooltipContent className="z-[70]">{t('List view')}</TooltipContent>
                </Tooltip>
              </ToggleGroup.Root>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="rounded-md text-text-000 hover:bg-muted"
                  aria-label={filesExpansionLabel}
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
              <TooltipContent className="z-[70]">{filesExpansionLabel}</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>

      {/* The search row filters managed artifacts, so local mode hides it. */}
      {!isLocalMode ? (
        <div className="flex shrink-0 items-center gap-3 border-y border-border-300/60 px-4 py-2">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-300"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label={t('Search project files')}
              placeholder={t('Search artifacts...')}
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
                      aria-label={t('Clear file search')}
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-text-100 hover:bg-bg-200 hover:text-text-100"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setSearchQuery('')}
                    >
                      <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="z-[70]">{t('Clear file search')}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
          <div className="shrink-0 text-[11px] tabular-nums text-text-000">
            {formatFileCount(visibleFileCount, t)}
          </div>
        </div>
      ) : null}

      {isLocalMode ? (
        <LocalFileBrowser
          onEntryCountChange={setLocalEntryCount}
          requestedPath={localRequestedPath}
        />
      ) : (
        <div data-testid="project-files-scroll" className="min-h-0 flex-1 overflow-y-auto pb-4">
          {!catalogIndex.overview.isIndexComplete ? (
            <div className="mx-4 mb-2 flex items-center justify-between gap-3 border-l-2 border-warning-000 px-3 py-2 text-[11px] text-text-200">
              <span className="min-w-0 flex-1">
                {catalogIndex.repairError ?? t('Some files could not be indexed yet.')}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label={t('Retry indexing project files')}
                disabled={catalogIndex.isRepairing}
                onClick={() => void catalogIndex.repairIndex()}
              >
                {t(catalogIndex.isRepairing ? 'Retrying...' : 'Retry')}
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
              {isSearchActive
                ? t('No files match “{{query}}”', { query: debouncedSearchQuery })
                : t('No files yet')}
            </div>
          ) : null}

          {showsUploadsSection ? (
            <section>
              <SectionHeader
                id="uploads"
                title={t('Your uploads')}
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
                      onOpenInPanel={openFileInPanel}
                    />
                  ) : null}
                  <div
                    ref={uploadSentinelRef}
                    data-testid="upload-page-sentinel"
                    className="h-px"
                  />
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
                    loadMoreLabel={t('Load more uploaded files')}
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
            <PageLoadError
              message={index.groups.error}
              onRetry={() => void index.loadMoreGroups()}
            />
          ) : null}

          {visibleArtifactGroups.length > 0 ? (
            <section>
              {isAllFilter ? (
                <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-normal text-text-300">
                  {t('Generated files')}
                </div>
              ) : null}
              {visibleArtifactGroups.map((group, groupIndex) => (
                <ProjectArtifactGroupSection
                  key={group.sessionId}
                  group={group}
                  title={getArtifactGroupTitle(group)}
                  timestamp={sessionById.get(group.sessionId)?.updatedAt}
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
                  onOpenInPanel={openFileInPanel}
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
                    {t('Load more sessions')}
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      )}
      <FileBrowserModal
        open={browseProviderId !== undefined}
        onClose={() => setBrowseProviderId(undefined)}
        initialProviderId={browseProviderId}
      />
      <GrantFolderAccessDialog
        open={grantDialogOpen}
        onOpenChange={setGrantDialogOpen}
        onGranted={handleSelectGrantedRoot}
      />
      {grantedRootMutationError ? (
        <ActionToast
          title={grantedRootMutationErrorTitle!}
          detail={grantedRootMutationError.detail}
          actionLabel={t('Retry')}
          dismissLabel={t('Close')}
          onAction={() =>
            void runGrantedRootMutation(
              grantedRootMutationError.kind,
              grantedRootMutationError.retry
            )
          }
          onDismiss={() => setGrantedRootMutationError(undefined)}
          testId="granted-root-error-toast"
        />
      ) : null}
    </div>
  )
}

const ProjectFilesView = (): React.JSX.Element => {
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const previewReader = useProjectFilePreviewReader()

  return (
    <ProjectFilesViewContent
      key={activeProjectId ?? 'no-project'}
      activeProjectId={activeProjectId}
      previewReader={previewReader}
    />
  )
}

export { ProjectFilesView }
