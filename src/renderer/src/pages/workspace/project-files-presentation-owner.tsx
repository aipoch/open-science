import {
  ArrowUpRight,
  Boxes,
  Check,
  ChevronDown,
  File,
  Folder,
  Monitor,
  Paperclip,
  Plus,
  Server
} from 'lucide-react'
import { useEffect } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, formatByteSize } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type { ProjectFileItem } from '../../../../shared/project-files'

import { ArtifactPreview } from './artifact-preview'
import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import { ManagedFileDownloadButton } from './ManagedFileDownloadButton'
import type { MessageArtifact } from './preview-file-item'
import { createProjectFilePreviewArtifact } from './project-files-preview-owner'
import type { ProjectFilesFilterOption } from './project-files-query-model'
import { FILE_MISSING_TAG } from './previews/preview-errors'
import { useNearViewport } from './previews/useNearViewport'
import { useUnavailablePreviewProbe } from './previews/useUnavailablePreviewProbe'

type ProjectFilesViewMode = 'grid' | 'list'

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

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

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

// Hallmark · component: file-actions · genre: modern-minimal · theme: workspace tokens
// states: default · hover · focus · active · disabled · download loading/error/success
const FileActionButtons = ({
  source,
  path,
  name,
  disabled,
  className,
  onOpenInPanel
}: {
  source: 'artifact' | 'upload'
  path: string
  name: string
  disabled: boolean
  className: string
  onOpenInPanel: () => void
}): React.JSX.Element => (
  <div
    className={cn(
      'absolute z-10 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100',
      className
    )}
  >
    <ManagedFileDownloadButton
      source={source}
      path={path}
      suggestedName={name}
      disabled={disabled}
      iconSize="icon-sm"
      className="cursor-pointer border-border bg-bg-000/95 shadow-sm"
    />
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="cursor-pointer bg-bg-000/95 text-text-100 shadow-sm"
            aria-label={`Open ${name} in split view beside the session`}
            disabled={disabled}
            onClick={onOpenInPanel}
          >
            <ArrowUpRight aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open in split view beside the session</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
)

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
  onPreview,
  onOpenInPanel
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
  onOpenInPanel: () => void
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
    <div className="group relative h-[128px] min-w-0 overflow-hidden rounded-lg border border-border-300/50 bg-bg-000 shadow-sm hover:border-border-200 hover:bg-bg-100 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-inset">
      <button
        ref={setTileElement}
        type="button"
        className="flex h-[128px] w-full min-w-0 cursor-pointer flex-col text-left"
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
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0 text-[10px] leading-3 text-text-000">
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
      <FileActionButtons
        source={source}
        path={previewArtifact.path}
        name={name}
        disabled={missing}
        className="right-1.5 top-1.5"
        onOpenInPanel={onOpenInPanel}
      />
    </div>
  )
}

// List mode stays metadata-only: the download action replaces right-side details on hover, while the
// row container owns the single focus ring shared by preview and download controls.
const FileListRow = ({
  file,
  previewLabel,
  onPreview,
  onOpenInPanel
}: {
  file: ProjectFileItem
  previewLabel: string
  onPreview: () => void
  onOpenInPanel: () => void
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
    <div className="group relative flex h-9 min-w-0 items-center rounded-md text-text-000 transition-colors duration-150 hover:bg-bg-200 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-inset motion-reduce:transition-none">
      <button
        ref={setRowElement}
        type="button"
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2 text-left focus-visible:outline-none"
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
      <FileActionButtons
        source={file.source}
        path={file.path}
        name={file.name}
        disabled={missing}
        className="right-2 top-1/2 -translate-y-1/2"
        onOpenInPanel={onOpenInPanel}
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
  onPreview,
  onOpenInPanel
}: {
  files: ProjectFileItem[]
  viewMode: ProjectFilesViewMode
  previewById: Map<string, ArtifactPreviewResult | undefined>
  onPreview: (file: ProjectFileItem) => void
  onOpenInPanel: (file: ProjectFileItem) => void
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
            onOpenInPanel={() => onOpenInPanel(file)}
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
          onOpenInPanel={() => onOpenInPanel(file)}
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
}): React.JSX.Element => (
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
  onBrowseRemoteHost,
  onBrowseLocal,
  localMachineName,
  isLocalSelected
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
  onBrowseLocal: () => void
  localMachineName: string | undefined
  isLocalSelected: boolean
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
          {isLocalSelected ? (
            <Monitor
              className="size-3.5 shrink-0 text-text-300"
              strokeWidth={1.8}
              aria-hidden="true"
            />
          ) : (
            <ProjectFilesFilterIcon
              kind={selectedOptionKind}
              className="size-3.5 shrink-0 text-text-300"
            />
          )}
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

        {/* "This computer" section: browse files on the machine Kiro runs on */}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>This computer</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem
            role="menuitemradio"
            aria-checked={isLocalSelected}
            className="gap-2"
            onSelect={() => onBrowseLocal()}
          >
            <Monitor
              className="size-4 shrink-0 text-text-300"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">{localMachineName || 'This computer'}</span>
            {isLocalSelected ? (
              <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>
          <DropdownMenuItem disabled className="gap-2 text-muted-foreground">
            <Plus className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
            <span>Add local folder…</span>
            <span className="ml-auto shrink-0 text-[11px]">Soon</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        {/* Remote section: SSH compute hosts */}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Remote</DropdownMenuLabel>
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

export { ProjectFileItems, ProjectFilesFilterMenu }
export type { ProjectFilesViewMode }
