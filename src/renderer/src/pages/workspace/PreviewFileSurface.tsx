import { useVersionHistoryPages } from './use-version-history-pages'
import { VersionHistoryLoadButton } from './VersionHistoryLoadButton'
import { unwrapProvenanceRead } from '../../../../shared/provenance-read-result'
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileDiff,
  GitBranch,
  Link2,
  Link2Off,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Pencil,
  X
} from 'lucide-react'
import type { TFunction } from 'i18next'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

import { ActionMenuItems, ActionMenuProvider, ActionMenuTarget } from '@/components/action-menu'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { errorDetail } from '@/lib/error-detail'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'
import type { ArtifactLineageProvenance } from '../../../../shared/artifact-provenance'
import {
  MANAGED_TEXT_EDIT_EXTENSIONS,
  type ManagedFileVersionDescriptor,
  type ManagedFileVersionErrorCode,
  type ManagedFileVersionInspectResult
} from '../../../../shared/managed-file-versions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import {
  LocalFileActionErrorToast,
  LocalFileHeaderActions,
  type LocalFileActionFailure,
  type SaveAsArtifactState
} from './LocalFileHeaderActions'
import { ManagedFileDownloadButton } from './ManagedFileDownloadButton'
import {
  useManagedFileDownload,
  type ManagedFileDownloadController
} from './use-managed-file-download'
import { usePdfContextAction, type PdfContextAction } from './use-pdf-context-action'
import {
  createProjectFileResolveRequest,
  createPreviewFileItemForArtifactVersion,
  createPreviewFileItemForManagedVersion,
  refreshPreviewFileItemFromProjectFile,
  resolveArtifactVersionDescriptor
} from './preview-file-item'
import { PreviewFileContent } from './previews/PreviewFileContent'
import type { PreviewDownloadVersionContext } from './previews/preview-runtime-context'
import type { PreviewInteractionPort } from './previews/preview-types'
import { ArtifactProvenancePanel } from './ArtifactProvenancePanel'
import { ManagedVersionDiffContent } from './ManagedVersionDiffContent'
import { PreviewActionMenuAdapterProvider } from './preview-actions/preview-action-adapter'
import { usePreviewActions } from './preview-actions/preview-action-hooks'
import {
  LOCAL_PREVIEW_MENU_RECIPE,
  MANAGED_PDF_PREVIEW_MENU_RECIPE,
  MANAGED_PREVIEW_MENU_RECIPE,
  PREVIEW_CAPABILITY_CATALOG,
  shouldHandlePreviewContextMenu,
  type PreviewActionBindings,
  type PreviewCapabilityId
} from './preview-actions/preview-action-model'
import { useManagedVersionWorkflow, type ManagedVersionMode } from './useManagedVersionWorkflow'

type PreviewFileSurfaceProps = PreviewInteractionPort & {
  item: PreviewFileItem
  contentKey?: string
  renderContent?: boolean
  tooltipClassName?: string
  actionMenuContentClassName?: string
  onClose: () => void
  onOpenFullScreen?: () => void
  onOpenProvenance?: () => void
  onViewInContextNavigate?: () => void
  onReload?: () => void
  onPdfContextError?: (message: string | null) => void
  provenanceEntry?: 'menu' | 'leading' | 'trailing'
  leaveGuardScope?: string
  workbenchConnected?: boolean
  retryResolutionEnabled?: boolean
  onItemChange?: (item: PreviewFileItem) => void
}

type LineageLoadState =
  | { key: string; phase: 'loading' | 'error' }
  | { key: string; phase: 'loaded'; value?: ArtifactLineageProvenance }

const hasManagedTextEditExtension = (filename: string): boolean => {
  const extensionIndex = filename.lastIndexOf('.')
  if (extensionIndex <= 0 || extensionIndex === filename.length - 1) return false
  return MANAGED_TEXT_EDIT_EXTENSIONS.has(filename.slice(extensionIndex + 1).toLowerCase())
}

type PreviewFileSurfaceHandle = {
  requestLeave: (action: () => boolean | void) => boolean
}

const previewHeaderActionClassName = 'text-text-000 hover:text-text-000'

const managedSaveErrorMessage = (code: ManagedFileVersionErrorCode, t: TFunction): string => {
  switch (code) {
    case 'STORAGE_UNAVAILABLE':
      return t('File storage is unavailable. Check the storage location and try again.')
    case 'PERMISSION_DENIED':
      return t('Open Science does not have permission to save this file.')
    case 'OUT_OF_SPACE':
      return t('There is not enough storage space to save this file.')
    // The file operator and service use different integrity codes for the same recovery action.
    case 'INTEGRITY_FAILED':
    case 'CONTENT_INTEGRITY_FAILED':
      return t('The file could not be verified after saving. Reopen it and try again.')
    case 'VERSION_CONFLICT':
      return t('The file changed before your edit could be saved. Reopen it and try again.')
    default:
      return t('Changes could not be saved.')
  }
}

const PreviewProvenanceButton = ({
  item,
  onOpenProvenance,
  tooltipClassName
}: {
  item: PreviewFileItem
  onOpenProvenance: () => void
  tooltipClassName?: string
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={previewHeaderActionClassName}
            aria-label={t('Open Provenance for {{title}}', { title: item.title })}
            onClick={onOpenProvenance}
          >
            <GitBranch aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent className={tooltipClassName}>{t('Provenance')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const PreviewViewInContextButton = ({
  item,
  onViewInContext,
  disabled,
  tooltipClassName
}: {
  item: PreviewFileItem
  onViewInContext: () => void
  disabled: boolean
  tooltipClassName?: string
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={previewHeaderActionClassName}
              disabled={disabled}
              aria-label={t('View in context for {{title}}', { title: item.title })}
              onClick={onViewInContext}
            >
              <Eye aria-hidden="true" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className={tooltipClassName}>
          {disabled ? t('Source conversation is archived') : t('View in context')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// The optional callback makes the maximize action available only in the compact workbench panel;
// the dialog reuses this header without exposing a nested full-screen action.
const PreviewFileHeader = ({
  item,
  onClose,
  onOpenFullScreen,
  onOpenProvenance,
  onViewInContext,
  viewInContextDisabled,
  onReload,
  provenanceEntry = 'menu',
  tooltipClassName,
  managedControls,
  managedControlsOnly = false,
  downloadVersionContext,
  pdfContextAction,
  saveAsArtifactState,
  managedDownload
}: Pick<
  PreviewFileSurfaceProps,
  | 'item'
  | 'onClose'
  | 'onOpenFullScreen'
  | 'onOpenProvenance'
  | 'onReload'
  | 'provenanceEntry'
  | 'tooltipClassName'
> & {
  onViewInContext?: () => void
  viewInContextDisabled?: boolean
  managedControls?: React.ReactNode
  managedControlsOnly?: boolean
  downloadVersionContext?: PreviewDownloadVersionContext
  pdfContextAction?: PdfContextAction
  saveAsArtifactState: SaveAsArtifactState
  managedDownload: ManagedFileDownloadController
}): React.JSX.Element => {
  const { t } = useTranslation()
  const previewActions = usePreviewActions()
  // The header overflow stays scoped to provenance/context while the content menu owns the full
  // capability recipe, including download, full-screen, and close.
  const provenanceActionEntry = previewActions.entries.find(
    (entry) => entry.kind === 'action' && entry.action === 'provenance'
  )
  const viewInContextEntry = previewActions.entries.find(
    (entry) => entry.kind === 'action' && entry.action === 'view-in-context'
  )
  const managedMenuEntries = [
    ...(provenanceActionEntry ? [provenanceActionEntry] : []),
    ...(provenanceActionEntry && viewInContextEntry ? [{ kind: 'separator' as const }] : []),
    ...(viewInContextEntry ? [viewInContextEntry] : [])
  ]

  return (
    <header
      data-testid="preview-card-header"
      className={`flex shrink-0 items-center gap-1 border-b border-border-300/50 px-2 ${
        // The local header carries the file path on a second line, so it grows past one row.
        item.source === 'local' ? 'min-h-8 py-0.5' : 'h-8'
      }`}
    >
      {!managedControlsOnly && onOpenProvenance && provenanceEntry === 'leading' ? (
        <PreviewProvenanceButton
          item={item}
          onOpenProvenance={onOpenProvenance}
          tooltipClassName={tooltipClassName}
        />
      ) : null}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 flex-1 text-[12px] font-medium text-text-000">
              <ExtensionPreservingFileName name={item.name} className="flex-1" />
              {item.source === 'local' ? (
                <span
                  data-testid="local-file-path"
                  className="flex min-w-0 items-center gap-1 text-[10px] font-normal leading-tight text-text-100"
                >
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-px">
                    {t('This computer')}
                  </span>
                  <span className="truncate">{item.path}</span>
                </span>
              ) : null}
            </span>
          </TooltipTrigger>
          <TooltipContent className={tooltipClassName}>
            {item.source === 'local' ? item.path : item.title}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {!managedControlsOnly && pdfContextAction ? (
        pdfContextAction.active ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                data-testid="pdf-context-status"
                className="rounded-full bg-primary/10 px-2 text-[11px] font-medium text-primary hover:bg-primary/15 hover:text-primary"
                aria-live="polite"
              >
                {pdfContextAction.pending ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                ) : (
                  <Link2 className="size-3" aria-hidden="true" />
                )}
                {t('In session context')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="z-[70] min-w-36">
              <DropdownMenuItem disabled={pdfContextAction.pending} onSelect={pdfContextAction.run}>
                <Link2Off className="mr-2 size-4" aria-hidden="true" />
                {pdfContextAction.label}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    data-testid="pdf-context-action"
                    className="rounded-full px-2 text-[11px] font-medium text-primary hover:bg-surface-control-hover hover:text-primary"
                    disabled={pdfContextAction.pending || pdfContextAction.disabled}
                    onClick={pdfContextAction.run}
                  >
                    {pdfContextAction.pending ? (
                      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                    ) : (
                      <BookOpen className="size-3" aria-hidden="true" />
                    )}
                    {pdfContextAction.label}
                  </Button>
                </span>
              </TooltipTrigger>
              {pdfContextAction.disabled ? (
                <TooltipContent className={tooltipClassName}>
                  {`${pdfContextAction.label} (${t('Unavailable')})`}
                </TooltipContent>
              ) : null}
            </Tooltip>
          </TooltipProvider>
        )
      ) : null}
      {/* A local file has no managed provenance or origin Session, so it takes the reload/copy/open
        actions in place of the whole managed action row. */}
      {item.source === 'local' ? (
        <LocalFileHeaderActions
          path={item.path}
          name={item.name}
          saveAsArtifactState={saveAsArtifactState}
          onReload={onReload}
          tooltipClassName={tooltipClassName}
        />
      ) : (
        <>
          {managedControls}
          {!managedControlsOnly ? (
            <>
              {onOpenProvenance && provenanceEntry === 'trailing' ? (
                <PreviewProvenanceButton
                  item={item}
                  onOpenProvenance={onOpenProvenance}
                  tooltipClassName={tooltipClassName}
                />
              ) : null}
              {onViewInContext && provenanceEntry === 'trailing' ? (
                <PreviewViewInContextButton
                  item={item}
                  onViewInContext={onViewInContext}
                  disabled={viewInContextDisabled ?? false}
                  tooltipClassName={tooltipClassName}
                />
              ) : null}
              <ManagedFileDownloadButton
                source={item.source ?? 'artifact'}
                path={item.path}
                {...(item.projectId && item.managedFileId
                  ? {
                      projectId: item.projectId,
                      fileId: item.managedFileId,
                      ...(downloadVersionContext ??
                        (item.selectedVersionId ? { versionId: item.selectedVersionId } : {}))
                    }
                  : {})}
                suggestedName={item.name}
                download={managedDownload}
                tone="strong"
                className="bg-transparent shadow-none"
              />
              {item.originSession?.state === 'deleted' ? (
                <span
                  data-testid="deleted-origin-session"
                  className="shrink-0 rounded bg-warning-100 px-1.5 py-0.5 text-[10px] text-warning-900"
                >
                  {t('Source session deleted')}
                </span>
              ) : null}
              {provenanceEntry === 'menu' && managedMenuEntries.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className={previewHeaderActionClassName}
                      aria-label={t('File actions for {{title}}', { title: item.title })}
                    >
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="z-[70] min-w-36">
                    <ActionMenuItems
                      entries={managedMenuEntries}
                      onSelect={previewActions.execute}
                      compact={false}
                      renderLabel={(entry, translatedLabel) =>
                        entry.action === 'view-in-context' && viewInContextDisabled
                          ? `${translatedLabel} (${t('Source conversation is archived')})`
                          : translatedLabel
                      }
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </>
          ) : null}
        </>
      )}
      {!managedControlsOnly && onOpenFullScreen ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={previewHeaderActionClassName}
                aria-label={t('Open full screen preview of {{title}}', { title: item.title })}
                onClick={onOpenFullScreen}
              >
                <Maximize2 aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className={tooltipClassName}>
              {t('Open full screen preview')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      {!managedControlsOnly ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={previewHeaderActionClassName}
                aria-label={t('Close preview of {{title}}', { title: item.title })}
                onClick={onClose}
              >
                <X aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className={tooltipClassName}>
              {t('Close preview of {{title}}', { title: item.title })}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </header>
  )
}

const ArtifactVersionNavigation = ({
  lineage,
  selectedVersionId,
  onSelect
}: {
  lineage: ArtifactLineageProvenance
  selectedVersionId: string | undefined
  onSelect: (versionId: string) => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const selectedIndex = lineage.versions.findIndex(
    (version) => version.versionId === selectedVersionId
  )
  const selected = resolveArtifactVersionDescriptor(lineage, selectedVersionId)
  if (!selected) return null

  return (
    <div
      data-testid="artifact-preview-version-navigation"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border-300/60 px-2"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('Previous Artifact version')}
        disabled={selectedIndex <= 0 && !lineage.previousVersion}
        onClick={() => {
          const versionId = (
            selectedIndex > 0 ? lineage.versions[selectedIndex - 1] : lineage.previousVersion
          )?.versionId
          if (versionId) onSelect(versionId)
        }}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <span className="text-xs font-medium text-text-100">v{selected.versionNumber}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('Next Artifact version')}
        disabled={
          (selectedIndex < 0 || selectedIndex >= lineage.versions.length - 1) &&
          !lineage.nextVersion
        }
        onClick={() => {
          const versionId = (
            selectedIndex >= 0
              ? (lineage.versions[selectedIndex + 1] ?? lineage.nextVersion)
              : lineage.nextVersion
          )?.versionId
          if (versionId) onSelect(versionId)
        }}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  )
}

const ManagedVersionNavigation = ({
  inspect,
  onSelect
}: {
  inspect: ManagedFileVersionInspectResult
  onSelect: (versionId: string) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const selectedIndex = inspect.versions.findIndex(
    (version) => version.id === inspect.selectedVersionId
  )
  return (
    <div
      data-testid="managed-preview-version-navigation"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border-300/60 px-2"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('Previous file version')}
        disabled={selectedIndex <= 0 && !inspect.previousVersion}
        onClick={() => {
          const id = (
            selectedIndex > 0 ? inspect.versions[selectedIndex - 1] : inspect.previousVersion
          )?.id
          if (id) onSelect(id)
        }}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <span className="min-w-8 text-center text-xs font-medium text-text-000">
        v{inspect.selectedVersion?.versionNumber ?? inspect.versions[selectedIndex]?.versionNumber}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('Next file version')}
        disabled={
          (selectedIndex < 0 || selectedIndex >= inspect.versions.length - 1) &&
          !inspect.nextVersion
        }
        onClick={() => {
          const id = (
            selectedIndex >= 0
              ? (inspect.versions[selectedIndex + 1] ?? inspect.nextVersion)
              : inspect.nextVersion
          )?.id
          if (id) onSelect(id)
        }}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  )
}

// The content slot is shared by both presentations so every supported file type follows the same
// renderer path. Callers can temporarily suppress it while another surface owns the preview.
const PreviewFileSurface = forwardRef<PreviewFileSurfaceHandle, PreviewFileSurfaceProps>(
  (
    {
      item,
      contentKey,
      renderContent = true,
      tooltipClassName,
      actionMenuContentClassName,
      onClose,
      onOpenFullScreen,
      onViewInContextNavigate,
      provenanceEntry = 'menu',
      leaveGuardScope,
      workbenchConnected = false,
      retryResolutionEnabled = true,
      onItemChange,
      activeAnnotations,
      onAddAnnotation,
      onUpdateAnnotationNote,
      onRemoveAnnotation,
      onUndoAnnotation,
      onRedoAnnotation,
      onAnnotationError,
      onPdfContextError,
      onLinkReadingContext,
      onUnlinkReadingContext
    },
    ref
  ): React.JSX.Element => {
    const { t } = useTranslation()
    const [provenanceTarget, setProvenanceTarget] = useState<string>()
    // Bumping this token remounts the content tree so a local file is re-read from disk.
    const [reloadToken, setReloadToken] = useState(0)
    const [copied, setCopied] = useState(false)
    const [saveAsArtifactState, setSaveAsArtifactState] = useState<SaveAsArtifactState>('idle')
    const [localActionFailure, setLocalActionFailure] = useState<LocalFileActionFailure>()
    const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
    const contextMenuComposerFocusRequestedRef = useRef(false)
    const [versionOverride, setVersionOverride] = useState<{
      key: string
      item: PreviewFileItem
    }>()
    const [lineageLoadState, setLineageLoadState] = useState<LineageLoadState>()
    const [lineageRetryToken, setLineageRetryToken] = useState(0)
    const [mode, setMode] = useState<ManagedVersionMode>('view')
    const [draft, setDraft] = useState('')
    const [editBaseline, setEditBaseline] = useState<{
      text: string
      expectedHeadVersionId: string
    }>()
    const [saving, setSaving] = useState(false)
    const [editError, setEditError] = useState<string>()
    const [conflictHead, setConflictHead] = useState<ManagedFileVersionDescriptor>()
    const [pendingLeaveAction, setPendingLeaveAction] = useState<() => boolean | void>()
    const saveGenerationRef = useRef(0)
    const acceptedIdentityTransitionRef = useRef<string | undefined>(undefined)
    const mountedRef = useRef(false)
    const retryGenerationRef = useRef(0)
    const retryInFlightRef = useRef<{ generation: number; operation: Promise<void> } | undefined>(
      undefined
    )
    const activeProjectId = usePreviewWorkbenchStore((state) => state.activeProjectId)
    const storedItem = usePreviewWorkbenchStore((state) =>
      workbenchConnected
        ? state.items.find(
            (candidate) =>
              candidate.type === 'file' &&
              candidate.id === item.id &&
              candidate.projectId === (item.projectId ?? activeProjectId)
          )
        : undefined
    )
    const sourceItem = storedItem?.type === 'file' ? storedItem : item
    const itemIdentityKey = `${sourceItem.projectId ?? ''}:${sourceItem.source ?? 'artifact'}:${sourceItem.id}:${sourceItem.managedFileId ?? ''}:${sourceItem.artifactId ?? ''}:${sourceItem.selectedVersionId ?? ''}:${sourceItem.path}`
    const previewItem = versionOverride?.key === itemIdentityKey ? versionOverride.item : sourceItem
    const projectId = previewItem.projectId ?? activeProjectId
    const previewIdentityKey = `${previewItem.projectId ?? ''}:${previewItem.source ?? 'artifact'}:${previewItem.id}:${previewItem.managedFileId ?? ''}:${previewItem.artifactId ?? ''}:${previewItem.selectedVersionId ?? ''}:${previewItem.path}`
    const managedWorkflow = useManagedVersionWorkflow({
      item: previewItem,
      projectId,
      mode,
      setMode,
      t
    })
    const {
      identity: managedIdentity,
      inspect: managedInspect,
      navigationInspect: managedNavigationInspect,
      controlsInspect: managedControlsInspect
    } = managedWorkflow
    // Managed files accept annotations only after inspection confirms the logical DB head.
    const annotationVersionPending = managedIdentity !== undefined && managedInspect === undefined
    const annotationBlockedByHistoricalVersion =
      managedNavigationInspect !== undefined &&
      managedNavigationInspect.selectedVersionId !== managedNavigationInspect.headVersionId
    const surfaceKey = item.id
    const showProvenance = provenanceTarget === surfaceKey
    const lineageKey = `${projectId ?? ''}:${previewItem.sessionId}:${previewItem.artifactId ?? ''}`
    // Finalization increments the owning Session's filesRevision even when this already-open preview
    // remains on an older Version. Include it in the request identity so the version navigator learns
    // about newly finalized Versions without forcing the user's current selection to change.
    const sessionFilesRevision = useSessionStore(
      (state) =>
        state.sessions.find((session) => session.id === previewItem.sessionId)?.filesRevision ?? 0
    )
    const originSessionArchived = useSessionStore(
      (state) =>
        state.sessions.find((session) => session.id === previewItem.sessionId)?.archivedAt !==
        undefined
    )
    // Selection and origin lifecycle changes can update a stable tab without changing its Artifact
    // identity. Keep the response keyed to the full request so stale lineage is never consumed.
    const lineageRequestKey = `${lineageKey}:${sessionFilesRevision}:${previewItem.selectedVersionId ?? ''}:${previewItem.originSession?.state ?? ''}`
    const initialLineage =
      lineageLoadState?.key === lineageRequestKey && lineageLoadState.phase === 'loaded'
        ? lineageLoadState.value
        : undefined
    const historyLineage =
      lineageLoadState?.key.startsWith(lineageKey + ':') && lineageLoadState.phase === 'loaded'
        ? lineageLoadState.value
        : undefined
    const lineageHistory = useVersionHistoryPages({
      historyKey:
        lineageKey +
        ':' +
        (historyLineage?.headVersion?.versionId ??
          historyLineage?.versions.at(-1)?.versionId ??
          ''),
      initial: historyLineage,
      loadPage: async (cursor) => {
        const value = unwrapProvenanceRead(
          await window.api.artifacts.getLineage({
            projectId: projectId!,
            appSessionId: previewItem.sessionId,
            artifactId: previewItem.artifactId!,
            versionId: previewItem.selectedVersionId,
            cursor
          })
        )
        if (!value) throw new Error('Artifact history is unavailable.')
        return value
      }
    })
    const lineage = useMemo(
      () => (initialLineage ? { ...initialLineage, versions: lineageHistory.versions } : undefined),
      [initialLineage, lineageHistory.versions]
    )
    const lineageFailed =
      lineageLoadState?.key === lineageRequestKey && lineageLoadState.phase === 'error'
    const exactSelectedVersion =
      lineage && previewItem.selectedVersionId
        ? resolveArtifactVersionDescriptor(lineage, previewItem.selectedVersionId)
        : undefined
    const newestLoadedVersion = lineage?.versions.at(-1)
    const selectionIsNewerThanLoadedLineage =
      typeof previewItem.versionNumber === 'number' &&
      typeof newestLoadedVersion?.versionNumber === 'number' &&
      previewItem.versionNumber > newestLoadedVersion.versionNumber
    const selectedVersion =
      exactSelectedVersion ??
      (lineage && !previewItem.managedFileId && !selectionIsNewerThanLoadedLineage
        ? resolveArtifactVersionDescriptor(lineage, previewItem.selectedVersionId)
        : undefined)
    const selectedVersionId = selectedVersion?.versionId ?? previewItem.selectedVersionId
    // Default managed previews follow the DB head without pinning the tab, while annotations still
    // need the exact immutable Version that is currently visible.
    const annotationVersionId = managedNavigationInspect?.selectedVersionId ?? selectedVersionId
    const resolvedPreviewItem =
      selectedVersion && projectId
        ? createPreviewFileItemForArtifactVersion({
            item: previewItem,
            version: selectedVersion,
            projectId
          })
        : previewItem
    const { action: pdfContextAction, readingContextBindingId } = usePdfContextAction(
      resolvedPreviewItem,
      onPdfContextError,
      { link: onLinkReadingContext, unlink: onUnlinkReadingContext }
    )
    const downloadVersionContext = managedWorkflow.downloadVersionContext
    const managedDownload = useManagedFileDownload({
      source: resolvedPreviewItem.source ?? 'artifact',
      path: resolvedPreviewItem.path,
      ...(resolvedPreviewItem.projectId && resolvedPreviewItem.managedFileId
        ? {
            projectId: resolvedPreviewItem.projectId,
            fileId: resolvedPreviewItem.managedFileId,
            ...(downloadVersionContext ??
              (resolvedPreviewItem.selectedVersionId
                ? { versionId: resolvedPreviewItem.selectedVersionId }
                : {}))
          }
        : {}),
      suggestedName: resolvedPreviewItem.name
    })
    const reportPdfReadingPosition = useCallback(
      (position: { pageNumber: number; pageCount: number }): void => {
        if (!readingContextBindingId) return
        usePreviewWorkbenchStore.getState().setPdfReadingPosition(readingContextBindingId, position)
      },
      [readingContextBindingId]
    )
    const stageLocalPath = window.api.uploads?.stageLocalPath

    const copyPath = async (): Promise<void> => {
      setLocalActionFailure(undefined)
      if (!navigator.clipboard?.writeText) {
        setLocalActionFailure({
          title: t('Could not copy the file path.'),
          retry: () => void copyPath()
        })
        return
      }

      try {
        await navigator.clipboard.writeText(resolvedPreviewItem.path)
        setCopied(true)
        clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => setCopied(false), 1500)
      } catch (error) {
        setLocalActionFailure({
          title: t('Could not copy the file path.'),
          detail: errorDetail(error),
          retry: () => void copyPath()
        })
      }
    }

    const downloadLocalFile = async (): Promise<void> => {
      setLocalActionFailure(undefined)
      try {
        await window.api.saveManagedFile({
          source: 'local',
          path: resolvedPreviewItem.path,
          suggestedName: resolvedPreviewItem.name
        })
      } catch (error) {
        console.error(`Failed to download local file: ${resolvedPreviewItem.name}`, error)
        setLocalActionFailure({
          title: t('Could not download this file.'),
          detail: errorDetail(error),
          retry: () => void downloadLocalFile()
        })
      }
    }

    const saveLocalFileAsArtifact = async (): Promise<void> => {
      if (!stageLocalPath || saveAsArtifactState === 'saving') return

      setLocalActionFailure(undefined)
      setSaveAsArtifactState('saving')
      try {
        const navigationProjectId = useNavigationStore.getState().activeProjectId
        await stageLocalPath({
          transferId: crypto.randomUUID(),
          name: resolvedPreviewItem.name,
          sourcePath: resolvedPreviewItem.path,
          ...(navigationProjectId ? { projectId: navigationProjectId } : {})
        })
        setSaveAsArtifactState('saved')
      } catch (error) {
        console.error(`Failed to save local file as artifact: ${resolvedPreviewItem.name}`, error)
        setSaveAsArtifactState('idle')
        setLocalActionFailure({
          title: t('Could not save this file as an artifact.'),
          detail: errorDetail(error),
          retry: () => void saveLocalFileAsArtifact()
        })
      }
    }

    // Copy feedback is transient and must not outlive a closed or replaced preview.
    useEffect(() => () => clearTimeout(copiedTimer.current), [])
    const isDirty = mode === 'edit' && editBaseline !== undefined && draft !== editBaseline.text
    const discardEdit = useCallback((): void => {
      saveGenerationRef.current += 1
      setSaving(false)
      setMode('view')
      setDraft('')
      setEditBaseline(undefined)
      setEditError(undefined)
      setConflictHead(undefined)
    }, [])
    const invalidateSave = (): void => {
      saveGenerationRef.current += 1
      setSaving(false)
    }
    const finishVersionSelection = (preserveDiffMode: boolean): void => {
      invalidateSave()
      managedWorkflow.resetForVersionSelection(preserveDiffMode)
      setDraft('')
      setEditBaseline(undefined)
    }

    const guardLeave = useCallback(
      (action: () => boolean | void): boolean => {
        if (!isDirty) return true
        setPendingLeaveAction((current) => current ?? action)
        return false
      },
      [isDirty]
    )
    const requestLeave = useCallback(
      (action: () => boolean | void): boolean => guardLeave(action) && action() !== false,
      [guardLeave]
    )
    useImperativeHandle(ref, () => ({ requestLeave }), [requestLeave])

    useEffect(() => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
      }
    }, [])

    useEffect(
      () =>
        leaveGuardScope ? previewLeaveGuards.register(leaveGuardScope, guardLeave) : undefined,
      [guardLeave, leaveGuardScope]
    )

    useEffect(() => {
      if (acceptedIdentityTransitionRef.current === itemIdentityKey) {
        acceptedIdentityTransitionRef.current = undefined
        return
      }
      const generation = ++saveGenerationRef.current
      setMode('view')
      setDraft('')
      setEditBaseline(undefined)
      setEditError(undefined)
      setConflictHead(undefined)
      setSaving(false)
      return () => {
        if (saveGenerationRef.current === generation) saveGenerationRef.current += 1
      }
    }, [itemIdentityKey])

    useEffect(() => {
      let active = true
      if (!projectId || !previewItem.artifactId || previewItem.source === 'upload') return

      void window.api.artifacts
        .getLineage({
          projectId,
          appSessionId: previewItem.sessionId,
          artifactId: previewItem.artifactId,
          ...(previewItem.selectedVersionId ? { versionId: previewItem.selectedVersionId } : {})
        })
        .then((value) => {
          if (active)
            setLineageLoadState({
              key: lineageRequestKey,
              phase: 'loaded',
              value: unwrapProvenanceRead(value)
            })
        })
        .catch(() => {
          if (active) setLineageLoadState({ key: lineageRequestKey, phase: 'error' })
        })

      return () => {
        active = false
      }
    }, [
      lineageKey,
      lineageRequestKey,
      lineageRetryToken,
      previewItem.artifactId,
      previewItem.sessionId,
      previewItem.selectedVersionId,
      previewItem.source,
      projectId
    ])

    const applyVersionItem = (
      nextItem: PreviewFileItem,
      skipWorkbenchGuard = false,
      onApplied?: () => void
    ): boolean => {
      if (!skipWorkbenchGuard) {
        return requestLeave(() => {
          applyVersionItem(nextItem, true, onApplied)
        })
      }
      const nextIdentityKey = `${nextItem.projectId ?? ''}:${nextItem.source ?? 'artifact'}:${nextItem.id}:${nextItem.managedFileId ?? ''}:${nextItem.artifactId ?? ''}:${nextItem.selectedVersionId ?? ''}:${nextItem.path}`
      if (workbenchConnected) {
        acceptedIdentityTransitionRef.current = nextIdentityKey
        if (!usePreviewWorkbenchStore.getState().upsertItem(nextItem, true)) {
          acceptedIdentityTransitionRef.current = undefined
          return false
        }
      } else {
        if (onItemChange) acceptedIdentityTransitionRef.current = nextIdentityKey
        onItemChange?.(nextItem)
        // Uncontrolled surfaces own their local selection; controlled Dialogs publish through
        // onItemChange and must not retain an origin-keyed override that can become stale.
        if (!onItemChange) setVersionOverride({ key: itemIdentityKey, item: nextItem })
      }
      // Invalidate pending retry lookups synchronously; the following render will advance the
      // generation again if the complete request or selected identity also changed.
      retryGenerationRef.current += 1
      onApplied?.()
      return true
    }

    const managedRetryRequest = createProjectFileResolveRequest(resolvedPreviewItem, projectId)
    const retryGenerationKey = JSON.stringify([
      retryResolutionEnabled,
      previewIdentityKey,
      managedRetryRequest?.projectId,
      managedRetryRequest?.sessionId,
      managedRetryRequest?.source,
      managedRetryRequest?.fileIdHint,
      managedRetryRequest?.identityHint,
      managedRetryRequest?.name
    ])
    useLayoutEffect(() => {
      retryGenerationRef.current += 1
    }, [retryGenerationKey])
    const retryManagedPreview = managedRetryRequest
      ? (): Promise<void> => {
          const requestedGeneration = retryGenerationRef.current
          if (retryInFlightRef.current?.generation === requestedGeneration) {
            return retryInFlightRef.current.operation
          }
          const operation = (async (): Promise<void> => {
            try {
              const file = await window.api.projectFiles.resolveFile(managedRetryRequest)
              if (
                !file ||
                !retryResolutionEnabled ||
                !mountedRef.current ||
                retryGenerationRef.current !== requestedGeneration
              ) {
                return
              }
              // A retry repairs metadata for the same stable tab, so it must not prompt about an
              // unrelated identity transition before the failed preview can remount.
              applyVersionItem(refreshPreviewFileItemFromProjectFile(previewItem, file), true)
            } catch {
              // The runtime still remounts the original request so transient catalog failures do
              // not turn Retry into a no-op.
            }
          })()
          retryInFlightRef.current = { generation: requestedGeneration, operation }
          void operation.finally(() => {
            if (retryInFlightRef.current?.operation === operation) {
              retryInFlightRef.current = undefined
            }
          })
          return operation
        }
      : undefined

    const selectPreviewVersion = (versionId: string): void => {
      if (!lineage || !projectId) return
      const version = resolveArtifactVersionDescriptor(lineage, versionId)
      if (!version) return

      applyVersionItem(
        createPreviewFileItemForArtifactVersion({ item: previewItem, version, projectId })
      )
    }

    const originSessionDeleted =
      lineage?.originSession.state === 'deleted' || previewItem.originSession?.state === 'deleted'
    const currentOriginSessionState =
      lineage?.originSession.state ?? previewItem.originSession?.state ?? 'active'
    const originSessionUnavailable =
      originSessionDeleted || currentOriginSessionState === 'deleting'
    const canViewInContext =
      previewItem.source !== 'upload' &&
      previewItem.artifactId !== undefined &&
      projectId !== undefined &&
      !originSessionUnavailable
    const viewInContext = (): void => {
      if (!projectId) return
      useNavigationStore
        .getState()
        .openSession(projectId, previewItem.sessionId, 'user', onViewInContextNavigate)
    }
    const openProvenance =
      previewItem.source !== 'upload' && previewItem.artifactId && projectId
        ? (): void => setProvenanceTarget(surfaceKey)
        : undefined
    const closePreview = (): void => {
      const close = (): void => {
        invalidateSave()
        onClose()
      }
      if (workbenchConnected) close()
      else requestLeave(close)
    }

    const selectProvenanceVersion = (nextItem: PreviewFileItem): boolean => {
      return applyVersionItem(nextItem, false, () => finishVersionSelection(false))
    }

    const selectManagedVersion = (versionId: string): void => {
      if (!managedNavigationInspect || !projectId) return
      const version = [
        managedNavigationInspect.selectedVersion,
        managedNavigationInspect.headVersion,
        managedNavigationInspect.previousVersion,
        managedNavigationInspect.nextVersion,
        ...managedNavigationInspect.versions
      ].find((candidate) => candidate?.id === versionId)
      if (!version) return
      const nextItem = createPreviewFileItemForManagedVersion({
        item: previewItem,
        version,
        projectId,
        sessionId: managedNavigationInspect.sessionId
      })
      applyVersionItem(nextItem, false, () => finishVersionSelection(true))
    }

    const beginEdit = (): void => {
      if (!managedInspect?.canEdit || managedInspect.text === undefined) return
      setDraft(managedInspect.text)
      setEditBaseline({
        text: managedInspect.text,
        expectedHeadVersionId: managedInspect.headVersionId
      })
      setEditError(undefined)
      setConflictHead(undefined)
      setMode('edit')
    }

    const saveEdit = async (): Promise<void> => {
      if (
        !managedIdentity ||
        !managedInspect ||
        !editBaseline ||
        draft === editBaseline.text ||
        saving
      )
        return
      setSaving(true)
      setEditError(undefined)
      const saveGeneration = saveGenerationRef.current
      let result
      try {
        result = await window.api.managedFileVersions.saveTextEdit({
          ...managedIdentity,
          basedOnVersionId: managedInspect.selectedVersionId,
          expectedHeadVersionId: editBaseline.expectedHeadVersionId,
          content: draft,
          operationId: crypto.randomUUID()
        })
      } catch {
        if (saveGenerationRef.current !== saveGeneration) return
        setSaving(false)
        setEditError(t('Changes could not be saved.'))
        return
      }
      if (saveGenerationRef.current !== saveGeneration) return
      setSaving(false)
      if (!result.ok) {
        setEditError(managedSaveErrorMessage(result.error.code, t))
        return
      }
      if (result.value.kind === 'conflict') {
        setConflictHead(result.value.actualHead)
        setEditError(t('This file has a newer version.'))
        return
      }
      setMode('view')
      setEditBaseline(undefined)
      setDraft('')
      if (result.value.kind === 'created' && projectId) {
        applyVersionItem(
          createPreviewFileItemForManagedVersion({
            item: previewItem,
            version: result.value.version,
            projectId,
            sessionId: managedInspect.sessionId
          }),
          true
        )
      }
      managedWorkflow.refreshInspect()
    }

    const toggleDiff = (): void => {
      if (!managedIdentity) return
      if (mode === 'diff') {
        managedWorkflow.stopDiff()
        return
      }
      if (!managedInspect?.canDiff) return
      requestLeave(() => {
        invalidateSave()
        managedWorkflow.startDiff()
      })
    }

    const managedDownloadUnavailable =
      (resolvedPreviewItem.source === 'artifact' || resolvedPreviewItem.source === 'upload') &&
      (!resolvedPreviewItem.projectId || !resolvedPreviewItem.managedFileId)
    const previewActionBindings: PreviewActionBindings =
      resolvedPreviewItem.source === 'local'
        ? {
            'copy-path': {
              execute: copyPath,
              ...(copied ? { labelKey: 'Copied', icon: Check } : {})
            },
            download: { execute: downloadLocalFile },
            'save-as-artifact': {
              execute: saveLocalFileAsArtifact,
              hidden: !stageLocalPath || saveAsArtifactState === 'saved',
              disabled: saveAsArtifactState === 'saving',
              ...(saveAsArtifactState === 'saving' ? { labelKey: 'Saving…' } : {})
            },
            ...(onOpenFullScreen ? { 'open-fullscreen': { execute: onOpenFullScreen } } : {}),
            close: { execute: closePreview }
          }
        : {
            ...(pdfContextAction
              ? {
                  'pdf-context': {
                    execute: () => {
                      // Linking intentionally moves focus to the composer after the menu closes.
                      contextMenuComposerFocusRequestedRef.current =
                        pdfContextAction.state !== 'remove'
                      return pdfContextAction.run()
                    },
                    disabled: pdfContextAction.disabled || pdfContextAction.pending,
                    labelKey:
                      pdfContextAction.state === 'remove'
                        ? 'Remove PDF from context'
                        : 'Read with agent',
                    icon: pdfContextAction.state === 'remove' ? Link2Off : BookOpen
                  }
                }
              : {}),
            ...(openProvenance ? { provenance: { execute: openProvenance } } : {}),
            ...(canViewInContext
              ? {
                  'view-in-context': {
                    execute: viewInContext,
                    disabled: originSessionArchived
                  }
                }
              : {}),
            download: {
              execute: managedDownload.execute,
              disabled: managedDownload.status === 'saving' || managedDownloadUnavailable
            },
            ...(onOpenFullScreen ? { 'open-fullscreen': { execute: onOpenFullScreen } } : {}),
            close: { execute: closePreview }
          }
    const previewActionIdentityKey = JSON.stringify([
      resolvedPreviewItem.id,
      resolvedPreviewItem.path,
      resolvedPreviewItem.managedFileId ?? null,
      resolvedPreviewItem.selectedVersionId ?? null,
      resolvedPreviewItem.mtimeMs ?? null
    ])
    const previewActionRecipe =
      resolvedPreviewItem.source === 'local'
        ? LOCAL_PREVIEW_MENU_RECIPE
        : resolvedPreviewItem.format === 'pdf'
          ? MANAGED_PDF_PREVIEW_MENU_RECIPE
          : MANAGED_PREVIEW_MENU_RECIPE
    const previewActionTargetId = 'preview-file-content'

    return (
      <ActionMenuProvider
        testId="preview-content-context-menu"
        contentClassName={actionMenuContentClassName}
        onOpenChange={(_targetId, open) => {
          if (open) contextMenuComposerFocusRequestedRef.current = false
        }}
      >
        <PreviewActionMenuAdapterProvider targetId={previewActionTargetId}>
          <ActionMenuTarget<PreviewCapabilityId, undefined>
            targetId={previewActionTargetId}
            identityKey={previewActionIdentityKey}
            catalog={PREVIEW_CAPABILITY_CATALOG}
            recipe={previewActionRecipe}
            bindings={previewActionBindings}
            invocation={undefined}
            resolveInvocation={(event) => {
              if (showProvenance || !renderContent || mode === 'edit') return null
              if (
                !(event.target instanceof Element) ||
                !event.target.closest('[data-preview-action-menu-content]')
              ) {
                return null
              }
              return shouldHandlePreviewContextMenu(event.target) ? undefined : null
            }}
            onRestoreFocus={(restoreDefault) => {
              if (!contextMenuComposerFocusRequestedRef.current) restoreDefault()
            }}
            asChild
          >
            <div className="flex size-full min-h-0 flex-col overflow-hidden">
              <PreviewFileHeader
                item={resolvedPreviewItem}
                onClose={closePreview}
                onOpenFullScreen={onOpenFullScreen}
                onReload={() => setReloadToken((token) => token + 1)}
                pdfContextAction={pdfContextAction}
                saveAsArtifactState={saveAsArtifactState}
                managedDownload={managedDownload}
                provenanceEntry={provenanceEntry}
                onOpenProvenance={openProvenance}
                onViewInContext={canViewInContext ? viewInContext : undefined}
                viewInContextDisabled={originSessionArchived}
                tooltipClassName={tooltipClassName}
                downloadVersionContext={managedWorkflow.downloadVersionContext}
                managedControlsOnly={mode === 'edit'}
                managedControls={
                  managedWorkflow.showTextTools && managedControlsInspect ? (
                    mode === 'edit' ? (
                      <div className="flex h-7 shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-text-000 hover:text-text-000"
                          onClick={() => {
                            requestLeave(() => {
                              invalidateSave()
                              setMode('view')
                              setDraft('')
                              setEditBaseline(undefined)
                            })
                          }}
                        >
                          {t('Cancel')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          aria-label={t('Save changes')}
                          disabled={!isDirty || saving}
                          onClick={() => void saveEdit()}
                        >
                          {t('Save')}
                        </Button>
                      </div>
                    ) : (
                      <>
                        {managedInspect?.canEdit ? (
                          <TooltipProvider delayDuration={200}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  className={previewHeaderActionClassName}
                                  aria-label={t('Edit {{name}}', {
                                    name: resolvedPreviewItem.name
                                  })}
                                  onClick={beginEdit}
                                >
                                  <Pencil aria-hidden="true" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className={tooltipClassName}>
                                {t('Edit content')}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : null}
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                type="button"
                                variant={mode === 'diff' ? 'default' : 'ghost'}
                                size="icon-xs"
                                className={
                                  mode === 'diff' ? undefined : previewHeaderActionClassName
                                }
                                aria-label={
                                  mode === 'diff'
                                    ? t('Stop comparing {{name}}', {
                                        name: resolvedPreviewItem.name
                                      })
                                    : t('Compare {{name}} with its source version', {
                                        name: resolvedPreviewItem.name
                                      })
                                }
                                disabled={mode !== 'diff' && !managedControlsInspect.canDiff}
                                onClick={toggleDiff}
                              >
                                <FileDiff aria-hidden="true" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className={tooltipClassName}>
                              {mode === 'diff'
                                ? t('Stop comparing {{name}}', { name: resolvedPreviewItem.name })
                                : managedControlsInspect.canDiff
                                  ? t('Compare with source version')
                                  : t('No source version to compare')}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </>
                    )
                  ) : undefined
                }
              />
              {!showProvenance && lineageFailed ? (
                <div
                  role="alert"
                  className="flex shrink-0 items-center justify-between gap-2 border-b border-border-300/50 bg-danger-900 px-3 py-1 text-[11px] leading-4 text-danger-000"
                >
                  <span>{t('Could not load version history.')}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setLineageLoadState({ key: lineageRequestKey, phase: 'loading' })
                      setLineageRetryToken((token) => token + 1)
                    }}
                    className="h-5 text-danger-000 hover:bg-danger-000/10 hover:text-danger-000"
                  >
                    {t('Retry')}
                  </Button>
                </div>
              ) : !showProvenance && managedNavigationInspect?.text !== undefined ? (
                <>
                  <ManagedVersionNavigation
                    inspect={managedNavigationInspect}
                    onSelect={selectManagedVersion}
                  />
                  <VersionHistoryLoadButton history={managedWorkflow.history} />
                </>
              ) : !showProvenance &&
                !managedIdentity &&
                lineage &&
                hasManagedTextEditExtension(resolvedPreviewItem.name) ? (
                <>
                  <ArtifactVersionNavigation
                    lineage={lineage}
                    selectedVersionId={selectedVersionId}
                    onSelect={selectPreviewVersion}
                  />
                  <VersionHistoryLoadButton history={lineageHistory} />
                </>
              ) : null}
              <div
                data-testid="preview-file-content-region"
                data-preview-action-menu-content
                className="min-h-0 flex-1 overflow-hidden"
              >
                <div
                  data-testid="preview-file-content-surface"
                  className="size-full min-h-0 overflow-y-auto bg-bg-000"
                >
                  {showProvenance && projectId ? (
                    <ArtifactProvenancePanel
                      item={resolvedPreviewItem}
                      projectId={projectId}
                      onClose={() => setProvenanceTarget(undefined)}
                      onVersionChange={selectProvenanceVersion}
                    />
                  ) : mode === 'edit' ? (
                    <div className="flex size-full min-h-0 flex-col">
                      <textarea
                        autoFocus
                        aria-label={t('Edit {{name}} source', { name: resolvedPreviewItem.name })}
                        className="min-h-0 flex-1 resize-none bg-bg-000 p-4 font-mono text-sm leading-6 text-text-000 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                      {editError ? (
                        <div
                          role="alert"
                          className="flex items-center justify-between border-t border-border-300 px-3 py-2 text-xs text-destructive"
                        >
                          {editError}
                          {conflictHead ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                if (!projectId || !managedInspect) return
                                const nextItem = createPreviewFileItemForManagedVersion({
                                  item: previewItem,
                                  version: conflictHead,
                                  projectId,
                                  sessionId: managedInspect.sessionId
                                })
                                applyVersionItem(nextItem, false, () =>
                                  finishVersionSelection(false)
                                )
                              }}
                            >
                              {t('View latest version')}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : mode === 'diff' ? (
                    managedInspect &&
                    !managedInspect.canDiff &&
                    managedWorkflow.isSelectedSourceText ? (
                      renderContent ? (
                        <PreviewFileContent
                          key={`${contentKey ?? ''}:${previewItem.selectedVersionId ?? ''}:${reloadToken}`}
                          item={resolvedPreviewItem}
                          downloadVersionContext={managedWorkflow.downloadVersionContext}
                          annotationVersionId={annotationVersionId}
                          annotationBlockedByHistoricalVersion={
                            annotationBlockedByHistoricalVersion
                          }
                          annotationVersionPending={annotationVersionPending}
                          activeAnnotations={activeAnnotations}
                          onAddAnnotation={onAddAnnotation}
                          onUpdateAnnotationNote={onUpdateAnnotationNote}
                          onRemoveAnnotation={onRemoveAnnotation}
                          onUndoAnnotation={onUndoAnnotation}
                          onRedoAnnotation={onRedoAnnotation}
                          onAnnotationError={onAnnotationError}
                          onRetry={retryManagedPreview}
                          onPdfReadingPositionChange={
                            readingContextBindingId ? reportPdfReadingPosition : undefined
                          }
                        />
                      ) : null
                    ) : managedWorkflow.diffResult ? (
                      <ManagedVersionDiffContent
                        result={managedWorkflow.diffResult}
                        format={resolvedPreviewItem.format}
                        name={resolvedPreviewItem.name}
                      />
                    ) : (
                      <div className="p-4 text-sm text-text-100">
                        {managedWorkflow.diffError ?? t('Comparing versions...')}
                      </div>
                    )
                  ) : renderContent ? (
                    <PreviewFileContent
                      key={`${contentKey ?? ''}:${previewItem.selectedVersionId ?? ''}:${reloadToken}`}
                      item={resolvedPreviewItem}
                      downloadVersionContext={managedWorkflow.downloadVersionContext}
                      annotationVersionId={annotationVersionId}
                      annotationBlockedByHistoricalVersion={annotationBlockedByHistoricalVersion}
                      annotationVersionPending={annotationVersionPending}
                      activeAnnotations={activeAnnotations}
                      onAddAnnotation={onAddAnnotation}
                      onUpdateAnnotationNote={onUpdateAnnotationNote}
                      onRemoveAnnotation={onRemoveAnnotation}
                      onUndoAnnotation={onUndoAnnotation}
                      onRedoAnnotation={onRedoAnnotation}
                      onAnnotationError={onAnnotationError}
                      onRetry={retryManagedPreview}
                      onPdfReadingPositionChange={
                        readingContextBindingId ? reportPdfReadingPosition : undefined
                      }
                    />
                  ) : null}
                </div>
              </div>
              {localActionFailure ? (
                <LocalFileActionErrorToast
                  failure={localActionFailure}
                  onDismiss={() => setLocalActionFailure(undefined)}
                />
              ) : null}
            </div>
          </ActionMenuTarget>
        </PreviewActionMenuAdapterProvider>
        <ConfirmActionDialog
          open={pendingLeaveAction !== undefined}
          title={t('Discard unsaved changes?')}
          description={t('Your unsaved edits to this file will be lost.')}
          cancelLabel={t('Cancel')}
          confirmLabel={t('Discard changes')}
          destructive
          testId="discard-preview-changes-confirmation"
          onCancel={() => setPendingLeaveAction(undefined)}
          onConfirm={() => {
            const action = pendingLeaveAction
            setPendingLeaveAction(undefined)
            discardEdit()
            if (action) previewLeaveGuards.runApproved(leaveGuardScope, action)
          }}
        />
      </ActionMenuProvider>
    )
  }
)

PreviewFileSurface.displayName = 'PreviewFileSurface'

export { PreviewFileSurface }
export type { PreviewFileSurfaceHandle }
