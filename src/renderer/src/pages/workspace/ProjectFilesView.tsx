import { Check, ChevronDown, File, Folder, Paperclip } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

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

import { ArtifactPreview } from './artifact-preview'
import { ARTIFACT_PREVIEW_BYTES, getArtifactPreviewFormat } from './artifact-preview-utils'
import { FILE_MISSING_TAG, isUnavailableFileError } from './previews/preview-errors'
import {
  buildProjectFileLibrary,
  type ProjectArtifactFileNode,
  type ProjectUploadFileNode
} from './project-files-library'
import {
  createPreviewFileItemFromArtifact,
  createPreviewFileItemFromUpload
} from './preview-file-item'
import type { MessageArtifact } from './preview-file-item'
import { ManagedFileDownloadButton } from './ManagedFileDownloadButton'
import { FilePreviewDialog } from './FilePreviewDialog'
import { getPreviewThumbnailReadEncoding } from './preview-support'
import { getPreviewFileReader } from './previews/preview-file-reader'
import { useNearViewport } from './previews/useNearViewport'
import { useUnavailablePreviewProbe } from './previews/useUnavailablePreviewProbe'

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
  cacheKey: string
  encoding?: 'utf8'
}

type ReadableProjectFilePreviewTarget = Pick<
  ProjectFilePreviewTarget,
  'id' | 'path' | 'source' | 'cacheKey'
> & {
  encoding: 'utf8'
}

type ProjectFilePreviewEntry = {
  cacheKey: string
  preview: ArtifactPreviewResult | undefined
}

type ProjectFilePreviewReadResult = ProjectFilePreviewEntry & { id: string }

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

const createUploadPreviewArtifact = (file: ProjectUploadFileNode): MessageArtifact => ({
  id: file.id,
  kind: 'managed-file',
  path: file.attachment.path,
  name: file.name,
  mimeType: file.attachment.mimeType,
  size: file.attachment.size,
  mtimeMs: file.timestamp
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
  target: Pick<ProjectFilePreviewTarget, 'id' | 'path' | 'source' | 'artifact'>
): ProjectFilePreviewTarget => ({
  ...target,
  cacheKey: getProjectFilePreviewCacheKey(target),
  encoding: getPreviewThumbnailReadEncoding(getArtifactPreviewFormat(target.artifact))
})

// Reads one tile through its source-specific IPC while retaining the source-neutral cache identity.
const readProjectFilePreview = async (
  target: ReadableProjectFilePreviewTarget
): Promise<ProjectFilePreviewReadResult> => {
  const readPreview = getPreviewFileReader(target.source)

  try {
    const preview = await readPreview({
      path: target.path,
      maxBytes: ARTIFACT_PREVIEW_BYTES,
      encoding: target.encoding
    })

    return { id: target.id, cacheKey: target.cacheKey, preview }
  } catch (error) {
    // An unavailable file (missing / outside storage) is expected here and badged separately;
    // don't spam the console for it — only genuine read failures warrant an error.
    if (!isUnavailableFileError(error)) {
      console.error('Failed to read project file preview', error)
    }
    return { id: target.id, cacheKey: target.cacheKey, preview: undefined }
  }
}

// Owns the bounded text data for one project tile only while that tile is near the viewport.
const VisibleProjectFilePreview = ({
  artifact,
  target
}: {
  artifact: MessageArtifact
  target: ProjectFilePreviewTarget
}): React.JSX.Element => {
  const [previewEntry, setPreviewEntry] = useState<ProjectFilePreviewEntry | undefined>(undefined)
  const { cacheKey, encoding, id, path, source } = target

  useEffect(() => {
    if (encoding === undefined) return

    let canceled = false
    void readProjectFilePreview({ cacheKey, encoding, id, path, source }).then((result) => {
      if (!canceled) setPreviewEntry({ cacheKey: result.cacheKey, preview: result.preview })
    })

    return () => {
      canceled = true
    }
  }, [cacheKey, encoding, id, path, source])

  const preview = previewEntry?.cacheKey === cacheKey ? previewEntry.preview : undefined
  return <ArtifactPreview artifact={artifact} preview={preview} source={source} isVisible />
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

const FileTile = ({
  name,
  previewArtifact,
  source,
  size,
  timestamp,
  previewLabel,
  onPreview
}: {
  name: string
  previewArtifact: MessageArtifact
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
  const target = createProjectFilePreviewTarget({
    id: previewArtifact.id,
    path: previewArtifact.path,
    source,
    artifact: previewArtifact
  })
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
          className="relative h-[82px] w-full overflow-hidden bg-bg-200"
        >
          <span className={cn('block size-full', missing && 'opacity-40')}>
            {/* Unmount the reader outside the overscan window so tile previews release local data. */}
            {isNearViewport ? (
              <VisibleProjectFilePreview artifact={previewArtifact} target={target} />
            ) : (
              <ArtifactPreview artifact={previewArtifact} source={source} isVisible={false} />
            )}
          </span>
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
  onSelect
}: {
  label: string
  options: ProjectFilesFilterOption[]
  selectedOptionId: string
  onSelect: (optionId: string) => void
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
    <DropdownMenuContent align="start" className="w-[320px]">
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

const ProjectFilesView = (): React.JSX.Element => {
  const allSessions = useSessionStore((state) => state.sessions)
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(() => new Set())
  const [selectedFilterId, setSelectedFilterId] = useState('all')
  // Files-tab previews are transient dialog state rather than workbench tabs.
  const [dialogItem, setDialogItem] = useState<PreviewFileItem | undefined>(undefined)

  // Only the active project's sessions contribute files, so the library never mixes projects.
  const sessions = useMemo(
    () => allSessions.filter((session) => session.projectId === activeProjectId),
    [allSessions, activeProjectId]
  )
  const library = useMemo(() => buildProjectFileLibrary(sessions), [sessions])
  const totalFileCount =
    library.uploadFiles.length +
    library.artifactGroups.reduce((total, group) => total + group.files.length, 0)
  const filterOptions = useMemo<ProjectFilesFilterOption[]>(
    () => [
      {
        id: 'all',
        label: 'All artifacts',
        count: totalFileCount,
        kind: 'all'
      },
      {
        id: 'uploads',
        label: 'Your uploads',
        count: library.uploadFiles.length,
        kind: 'uploads'
      },
      ...library.artifactGroups.map((group) => ({
        id: `session:${group.sessionId}`,
        label: group.title,
        count: group.files.length,
        kind: 'session' as const
      }))
    ],
    [library.artifactGroups, library.uploadFiles.length, totalFileCount]
  )
  const effectiveFilterId = filterOptions.some((option) => option.id === selectedFilterId)
    ? selectedFilterId
    : 'all'
  const selectedFilterOption =
    filterOptions.find((option) => option.id === effectiveFilterId) ?? filterOptions[0]
  const visibleUploadFiles = useMemo(
    () =>
      effectiveFilterId === 'all' || effectiveFilterId === 'uploads' ? library.uploadFiles : [],
    [effectiveFilterId, library.uploadFiles]
  )
  const visibleArtifactGroups = useMemo(
    () =>
      effectiveFilterId === 'all'
        ? library.artifactGroups
        : effectiveFilterId.startsWith('session:')
          ? library.artifactGroups.filter(
              (group) => `session:${group.sessionId}` === effectiveFilterId
            )
          : [],
    [effectiveFilterId, library.artifactGroups]
  )
  const visibleFileCount =
    visibleUploadFiles.length +
    visibleArtifactGroups.reduce((total, group) => total + group.files.length, 0)
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
  }

  const previewUploadFile = (file: ProjectUploadFileNode): void => {
    // Preserve the upload source so the shared renderer and download action use its IPC path.
    setDialogItem(createPreviewFileItemFromUpload(file.attachment, file.sessionId))
  }

  const previewArtifactFile = (file: ProjectArtifactFileNode, sessionId: string): void => {
    // Invalid or deleted artifacts have no preview item and should leave the dialog closed.
    const previewItem = createPreviewFileItemFromArtifact(file.artifact, sessionId)

    if (previewItem) setDialogItem(previewItem)
  }

  const uploadsCollapsed = collapsedSectionIds.has('uploads')

  return (
    <div data-testid="files-view" className="flex h-full min-h-0 w-full flex-col bg-bg-10">
      <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-1">
        <ProjectFilesFilterMenu
          label={effectiveFilterId === 'all' ? 'Artifacts' : selectedFilterOption.label}
          options={filterOptions}
          selectedOptionId={effectiveFilterId}
          onSelect={selectFilter}
        />
        <div className="text-[11px] text-text-300">{visibleFileCount} files</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {visibleFileCount === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-text-300">
            No files yet
          </div>
        ) : null}

        {visibleUploadFiles.length > 0 ? (
          <section>
            <SectionHeader
              id="uploads"
              title="Your uploads"
              countLabel={`${visibleUploadFiles.length}`}
              isCollapsed={uploadsCollapsed}
              onToggle={toggleSection}
            />
            {!uploadsCollapsed ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2 px-4 py-3">
                {visibleUploadFiles.map((file) => (
                  <FileTile
                    key={file.id}
                    name={file.name}
                    previewArtifact={createUploadPreviewArtifact(file)}
                    source="upload"
                    size={file.size}
                    timestamp={file.timestamp}
                    previewLabel={`Preview uploaded file ${file.name}`}
                    onPreview={() => previewUploadFile(file)}
                  />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {visibleArtifactGroups.length > 0 ? (
          <section>
            {effectiveFilterId === 'all' ? (
              <div className="px-4 pb-1 pt-3 text-[11px] font-medium uppercase tracking-normal text-text-300">
                Generated files
              </div>
            ) : null}
            {visibleArtifactGroups.map((group) => {
              const sectionId = `session:${group.sessionId}`
              const isCollapsed = collapsedSectionIds.has(sectionId)

              return (
                <section key={group.sessionId}>
                  <SectionHeader
                    id={sectionId}
                    title={group.title}
                    countLabel={`${group.files.length} files`}
                    isCollapsed={isCollapsed}
                    onToggle={toggleSection}
                  />
                  {!isCollapsed ? (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2 px-4 py-3">
                      {group.files.map((file) => (
                        <FileTile
                          key={file.id}
                          name={file.name}
                          previewArtifact={file.artifact}
                          source="artifact"
                          size={file.size}
                          timestamp={file.artifact.mtimeMs}
                          previewLabel={`Preview generated file ${file.name}`}
                          onPreview={() => previewArtifactFile(file, group.sessionId)}
                        />
                      ))}
                    </div>
                  ) : null}
                </section>
              )
            })}
          </section>
        ) : null}
      </div>
      <FilePreviewDialog item={dialogItem} onClose={() => setDialogItem(undefined)} />
    </div>
  )
}

export { ProjectFilesView }
