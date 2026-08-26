import type { TFunction } from 'i18next'
import {
  ArrowUpRight,
  Boxes,
  Check,
  ChevronDown,
  File,
  Folder,
  Lock,
  LockOpen,
  Monitor,
  Paperclip,
  Plus,
  Server,
  Trash2
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, formatByteSize } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'
import { useGrantedFoldersStore } from '@/stores/granted-folders-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { ArtifactPreviewResult } from '../../../../shared/artifacts'
import type { GrantedLocalRoot } from '../../../../shared/local-fs'
import type { ProjectFileItem } from '../../../../shared/project-files'

import { ArtifactPreview } from './artifact-preview'
import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import { grantedRootAccessBadgeClassName } from './granted-root-access-badge'
import { ManagedFileDownloadButton } from './ManagedFileDownloadButton'
import type { MessageArtifact } from './preview-file-item'
import { createProjectFilePreviewArtifact } from './project-files-preview-owner'
import type { ProjectFilesFilterOption } from './project-files-query-model'
import { FILE_MISSING_TAG_KEY } from './previews/preview-errors'
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

// Each bucket names its own English text: a natural-language key has to be a literal, so the unit
// cannot be interpolated into one shared string. The plural rule then lives in the catalog, where a
// language that inflects differently from English can express it.
const RELATIVE_FILE_TIME = [
  { key: '{{count}} years ago', singular: '{{count}} year ago', ms: YEAR_MS },
  { key: '{{count}} months ago', singular: '{{count}} month ago', ms: MONTH_MS },
  { key: '{{count}} days ago', singular: '{{count}} day ago', ms: DAY_MS },
  { key: '{{count}} hours ago', singular: '{{count}} hour ago', ms: HOUR_MS },
  { key: '{{count}} minutes ago', singular: '{{count}} minute ago', ms: MINUTE_MS }
] as const

const formatRelativeFileTime = (
  timestamp: number | undefined,
  t: TFunction
): string | undefined => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined

  const elapsedMs = Math.max(0, Date.now() - timestamp)
  const unit =
    RELATIVE_FILE_TIME.find((item) => elapsedMs >= item.ms) ??
    RELATIVE_FILE_TIME[RELATIVE_FILE_TIME.length - 1]
  const value = Math.max(1, Math.floor(elapsedMs / unit.ms))

  return t(unit.key, { defaultValue_one: unit.singular, count: value })
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
}): React.JSX.Element => {
  const { t } = useTranslation()
  const openLabel = t('Open {{name}} in split view beside the session', { name })

  return (
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
              aria-label={openLabel}
              disabled={disabled}
              onClick={onOpenInPanel}
            >
              <ArrowUpRight aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{openLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
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
  const { t } = useTranslation()
  const sizeLabel = formatByteSize(size)
  const relativeTimeLabel = formatRelativeFileTime(timestamp, t)
  const [setTileElement, isNearViewport] = useNearViewport<HTMLButtonElement>()
  const missing = useUnavailablePreviewProbe({
    enabled: isNearViewport,
    projectId,
    sessionId,
    path: previewArtifact.path,
    source,
    size,
    mtimeMs: timestamp
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
              {t(FILE_MISSING_TAG_KEY)}
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
  const { t } = useTranslation()
  const [setRowElement, isNearViewport] = useNearViewport<HTMLButtonElement>()
  const missing = useUnavailablePreviewProbe({
    enabled: isNearViewport,
    projectId: file.projectId,
    sessionId: file.sessionId,
    path: file.path,
    source: file.source,
    size: file.size,
    mtimeMs: file.mtimeMs
  })
  const sizeLabel = formatByteSize(file.size)
  const relativeTimeLabel = formatRelativeFileTime(file.mtimeMs ?? file.sortAtMs, t)

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
            {t(FILE_MISSING_TAG_KEY)}
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
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <div
      data-view-mode={viewMode}
      className={cn(
        viewMode === 'grid'
          ? 'grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2 px-4 py-3'
          : 'px-4 py-2'
      )}
    >
      {files.map((file) => {
        const previewLabel =
          file.source === 'upload'
            ? t('Preview uploaded file {{name}}', { name: file.name })
            : t('Preview generated file {{name}}', { name: file.name })
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
}

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

const GrantedRootMenuRow = ({
  root,
  isSelected,
  onSelect,
  onCloseMenu
}: {
  root: GrantedLocalRoot
  isSelected: boolean
  onSelect: (root: GrantedLocalRoot) => void
  onCloseMenu: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const setAccess = useGrantedFoldersStore((state) => state.setAccess)
  const remove = useGrantedFoldersStore((state) => state.remove)

  // The whole row is the submenu trigger: hovering it opens the manage submenu (Radix hover
  // intent), while clicking still selects the folder. Clicking a sub-trigger would normally open
  // the submenu instead, so the click is default-prevented and the menu closed manually.
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger asChild>
        <div
          role="menuitemradio"
          aria-checked={isSelected}
          className="gap-2"
          data-testid={`granted-root-${root.id}`}
          onClick={(event) => {
            event.preventDefault()
            onSelect(root)
            onCloseMenu()
          }}
        >
          <Folder
            className="mt-0.5 size-4 shrink-0 self-start text-text-300"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{root.name}</span>
            <span title={root.path} className="block truncate font-mono text-[11px] text-text-300">
              {root.path}
            </span>
          </span>
          {/* Trailing cluster: badge and check sit 2px apart. */}
          <span className="flex shrink-0 items-center gap-0.5">
            <span className={grantedRootAccessBadgeClassName(root.access)}>{root.access}</span>
            {isSelected ? (
              <Check
                className="size-4 shrink-0 text-primary"
                strokeWidth={2}
                aria-hidden="true"
                data-testid={`granted-root-check-${root.id}`}
              />
            ) : null}
          </span>
        </div>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="z-[70] w-[220px]">
        <DropdownMenuLabel
          title={root.path}
          className="truncate font-mono text-[11px] text-text-300"
        >
          {root.path}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {root.access === 'ro' ? (
          <DropdownMenuItem
            className="gap-2"
            data-testid={`granted-root-allow-writes-${root.id}`}
            onSelect={() => void setAccess(root.id, 'rw').catch(() => undefined)}
          >
            <LockOpen
              className="size-4 shrink-0 text-text-300"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span>{t('Allow writes')}</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            className="gap-2"
            data-testid={`granted-root-make-read-only-${root.id}`}
            onSelect={() => void setAccess(root.id, 'ro').catch(() => undefined)}
          >
            <Lock className="size-4 shrink-0 text-text-300" strokeWidth={1.8} aria-hidden="true" />
            <span>{t('Make read-only')}</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="gap-2 text-danger-000 data-[highlighted]:text-danger-000"
          data-testid={`granted-root-remove-${root.id}`}
          onSelect={() => void remove(root.id).catch(() => undefined)}
        >
          <Trash2 className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
          <span>{t('Remove access')}</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
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
  onBrowseRemoteHost,
  onBrowseLocal,
  onAddFolder,
  onSelectGrantedRoot,
  localMachineName,
  isLocalSelected,
  selectedLocalRootId
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
  onAddFolder: () => void
  onSelectGrantedRoot: (root: GrantedLocalRoot) => void
  localMachineName: string | undefined
  isLocalSelected: boolean
  // Id of the granted folder the local browser is scoped to; undefined means the machine itself.
  selectedLocalRootId: string | undefined
}): React.JSX.Element => {
  const { t } = useTranslation()
  const hosts = useComputeStore((state) => state.hosts)
  const openSettingsToCompute = useSettingsStore((state) => state.openSettingsToCompute)
  const grantedRoots = useGrantedFoldersStore((state) => state.roots)
  const fixedOptions = options.filter((option) => option.kind !== 'session')
  const sessionOptions = options.filter((option) => option.kind === 'session')
  const visibleSessionOptions = showAllSessions
    ? sessionOptions
    : getCollapsedSessionOptions(sessionOptions, selectedOptionId)
  const showSessionOptionsToggle = sessionOptionCount > COLLAPSED_SESSION_OPTION_COUNT
  const selectedOptionKind = options.find((option) => option.id === selectedOptionId)?.kind ?? 'all'
  // A revoked folder can leave a stale selection id behind; only a root that still exists counts.
  const selectedLocalRoot = selectedLocalRootId
    ? grantedRoots.find((root) => root.id === selectedLocalRootId)
    : undefined
  // The machine row is checked only when the local browser is not scoped to a granted folder.
  const isMachineSelected = isLocalSelected && selectedLocalRoot === undefined

  useEffect(() => {
    // Expanded menus consume one existing cursor page per render until every session is available.
    if (showAllSessions && canLoadMoreOptions) onLoadMoreOptions()
  }, [canLoadMoreOptions, onLoadMoreOptions, showAllSessions])

  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="max-w-[220px] gap-1.5"
          aria-label={t('Filter project files')}
        >
          {isLocalSelected ? (
            selectedLocalRoot ? (
              <Folder
                className="size-3.5 shrink-0 text-text-300"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            ) : (
              <Monitor
                className="size-3.5 shrink-0 text-text-300"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            )
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
        <DropdownMenuLabel>{t('Artifacts')}</DropdownMenuLabel>
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
              {t('Retry loading sessions')}
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
              {showAllSessions
                ? t('Show fewer')
                : t('Show all {{count}} sessions', {
                    defaultValue_one: 'Show all {{count}} session',
                    count: sessionOptionCount
                  })}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>

        {/* "This computer" section: browse files on the machine Kiro runs on */}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('This computer')}</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem
            role="menuitemradio"
            aria-checked={isMachineSelected}
            className="gap-2"
            onSelect={() => onBrowseLocal()}
          >
            <Monitor
              className="size-4 shrink-0 text-text-300"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">
              {localMachineName || t('This computer')}
            </span>
            {isMachineSelected ? (
              <Check className="size-4 shrink-0 text-primary" strokeWidth={2} aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>
          {grantedRoots.map((root) => (
            <GrantedRootMenuRow
              key={root.id}
              root={root}
              isSelected={root.id === selectedLocalRootId}
              onSelect={onSelectGrantedRoot}
              onCloseMenu={() => setMenuOpen(false)}
            />
          ))}
          <DropdownMenuItem
            className="gap-2 text-muted-foreground"
            data-testid="add-local-folder"
            onSelect={() => onAddFolder()}
          >
            <Plus className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
            <span>{t('Add folder…')}</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        {/* Remote section: SSH compute hosts */}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('Remote')}</DropdownMenuLabel>
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
                  <span className="shrink-0 text-[11px] text-text-300">
                    {t('Host unreachable')}
                  </span>
                )}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuItem
            className="gap-2 text-muted-foreground"
            onSelect={() => openSettingsToCompute()}
          >
            <Plus className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
            <span>{t('Add SSH host…')}</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { ProjectFileItems, ProjectFilesFilterMenu }
export type { ProjectFilesViewMode }
