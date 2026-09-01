import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  GitBranch,
  Link2,
  Link2Off,
  Loader2,
  Maximize2,
  MoreHorizontal,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { usePreviewWorkbenchStore, type PreviewFileItem } from '@/stores/preview-workbench-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import type { ArtifactLineageProvenance } from '../../../../shared/artifact-provenance'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import { LocalFileHeaderActions } from './LocalFileHeaderActions'
import { ManagedFileDownloadButton } from './ManagedFileDownloadButton'
import { usePdfContextAction, type PdfContextAction } from './use-pdf-context-action'
import {
  createPreviewFileItemForArtifactVersion,
  resolveArtifactVersionDescriptor
} from './preview-file-item'
import { PreviewFileContent } from './previews/PreviewFileContent'
import type { PreviewInteractionPort } from './previews/preview-types'
import { ArtifactProvenancePanel } from './ArtifactProvenancePanel'

type PreviewFileSurfaceProps = PreviewInteractionPort & {
  item: PreviewFileItem
  contentKey?: string
  renderContent?: boolean
  tooltipClassName?: string
  onClose: () => void
  onOpenFullScreen?: () => void
  onOpenProvenance?: () => void
  // Notified after the View in context action navigates to the artifact's origin session; the
  // full-screen dialog uses this to exit so the switched conversation is actually visible.
  onViewInContextNavigate?: () => void
  onReload?: () => void
  onPdfContextError?: (message: string | null) => void
  provenanceEntry?: 'menu' | 'leading' | 'trailing'
}

type LineageLoadState =
  | { key: string; phase: 'loading' | 'error' }
  | { key: string; phase: 'loaded'; value?: ArtifactLineageProvenance }

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
        {/* The preview dialog auto-focuses this first header button on open, and Radix opens
            tooltips on any focus — only real keyboard focus (":focus-visible") may open it. */}
        <TooltipTrigger
          asChild
          onFocus={(event) => {
            if (!event.currentTarget.matches(':focus-visible')) {
              event.preventDefault()
            }
          }}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-text-100 hover:text-text-000"
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
          {/* A disabled button swallows pointer events, so the trigger spans it to keep the
              archived-session hint hoverable. */}
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-text-100 hover:text-text-000"
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
  pdfContextAction,
  provenanceEntry = 'menu',
  tooltipClassName
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
  // Undefined hides the entry; disabled keeps it visible with the archived-session hint.
  onViewInContext?: () => void
  viewInContextDisabled?: boolean
  pdfContextAction?: PdfContextAction
}): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <header
      data-testid="preview-card-header"
      className={`flex shrink-0 items-center gap-1 border-b border-border-300/50 px-2 ${
        // The local header carries the file path on a second line, so it grows past one row.
        item.source === 'local' ? 'min-h-8 py-0.5' : 'h-8'
      }`}
    >
      {onOpenProvenance && provenanceEntry === 'leading' ? (
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
      {pdfContextAction ? (
        pdfContextAction.active ? (
          // The linked state doubles as the status badge: one tinted pill carries both the
          // "In session context" signal and the Remove command.
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
          // The primary reading-context entry: a labeled pill next to the download action.
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A disabled button swallows pointer events, so the trigger spans it to keep the
                    unavailable hint hoverable. */}
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
          onReload={onReload}
          tooltipClassName={tooltipClassName}
        />
      ) : (
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
            suggestedName={item.name}
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
          {/* The PDF link action lives on the header pill above; this overflow only carries the
              managed-artifact extras. */}
          {onOpenProvenance && provenanceEntry === 'menu' ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-text-100 hover:text-text-000"
                  aria-label={t('File actions for {{title}}', { title: item.title })}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[70] min-w-36">
                <DropdownMenuItem onSelect={onOpenProvenance}>
                  <GitBranch className="mr-2 size-4" aria-hidden="true" />
                  {t('Provenance')}
                </DropdownMenuItem>
                {onViewInContext ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={viewInContextDisabled} onSelect={onViewInContext}>
                      <Eye className="mr-2 size-4" aria-hidden="true" />
                      {t('View in context')}
                      {viewInContextDisabled ? ` (${t('Source conversation is archived')})` : ''}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      )}
      {onOpenFullScreen ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
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
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-text-100 hover:text-text-000"
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
  if (selectedIndex < 0) return null

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
        disabled={selectedIndex <= 0}
        onClick={() => {
          const versionId = lineage.versions[selectedIndex - 1]?.versionId
          if (versionId) onSelect(versionId)
        }}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <span className="text-xs font-medium text-text-100">
        v{lineage.versions[selectedIndex]?.versionNumber}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('Next Artifact version')}
        disabled={selectedIndex >= lineage.versions.length - 1}
        onClick={() => {
          const versionId = lineage.versions[selectedIndex + 1]?.versionId
          if (versionId) onSelect(versionId)
        }}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  )
}

// The content slot is shared by both presentations so every supported file type follows the same
// renderer path. Callers can temporarily suppress it while another surface owns the preview.
const PreviewFileSurface = ({
  item,
  contentKey,
  renderContent = true,
  tooltipClassName,
  onClose,
  onOpenFullScreen,
  onViewInContextNavigate,
  provenanceEntry = 'menu',
  activeAnnotations,
  onAddAnnotation,
  onUpdateAnnotationNote,
  onRemoveAnnotation,
  onUndoAnnotation,
  onRedoAnnotation,
  onPdfContextError,
  onAnnotationError,
  onLinkReadingContext,
  onUnlinkReadingContext
}: PreviewFileSurfaceProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [provenanceTarget, setProvenanceTarget] = useState<string>()
  // Bumping this token remounts the content tree so a local file is re-read from disk.
  const [reloadToken, setReloadToken] = useState(0)
  const [versionOverride, setVersionOverride] = useState<{
    key: string
    item: PreviewFileItem
  }>()
  const [lineageLoadState, setLineageLoadState] = useState<LineageLoadState>()
  const [lineageRetryToken, setLineageRetryToken] = useState(0)
  const [pdfContextMenu, setPdfContextMenu] = useState<{
    itemKey: string
    x: number
    y: number
  }>()
  const projectId = usePreviewWorkbenchStore((state) => state.activeProjectId)
  const storedItem = usePreviewWorkbenchStore((state) =>
    state.items.find((candidate) => candidate.id === item.id)
  )
  const itemIdentityKey = `${item.id}:${item.artifactId ?? ''}`
  const previewItem =
    storedItem?.type === 'file' && storedItem.artifactId === item.artifactId
      ? storedItem
      : versionOverride?.key === itemIdentityKey
        ? versionOverride.item
        : item
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
  // A GENERATED-card click or origin lifecycle refresh can update the stable preview tab while its
  // Artifact identity stays unchanged. Refetch and stop consuming the prior snapshot until the
  // matching lineage resolves.
  const lineageRequestKey = `${lineageKey}:${sessionFilesRevision}:${previewItem.selectedVersionId ?? ''}:${previewItem.originSession?.state ?? ''}`
  const lineage =
    lineageLoadState?.key === lineageRequestKey && lineageLoadState.phase === 'loaded'
      ? lineageLoadState.value
      : undefined
  const lineageFailed =
    lineageLoadState?.key === lineageRequestKey && lineageLoadState.phase === 'error'
  const exactSelectedVersion = lineage?.versions.find(
    (version) => version.versionId === previewItem.selectedVersionId
  )
  const newestLoadedVersion = lineage?.versions.at(-1)
  const selectionIsNewerThanLoadedLineage =
    typeof previewItem.versionNumber === 'number' &&
    typeof newestLoadedVersion?.versionNumber === 'number' &&
    previewItem.versionNumber > newestLoadedVersion.versionNumber
  const selectedVersion =
    exactSelectedVersion ??
    (lineage && !selectionIsNewerThanLoadedLineage
      ? resolveArtifactVersionDescriptor(lineage, previewItem.selectedVersionId)
      : undefined)
  const selectedVersionId = selectedVersion?.versionId ?? previewItem.selectedVersionId
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
  const pdfContextMenuItemKey = `${resolvedPreviewItem.id}:${selectedVersionId ?? ''}`
  const reportPdfReadingPosition = useCallback(
    (position: { pageNumber: number; pageCount: number }): void => {
      if (!readingContextBindingId) return
      usePreviewWorkbenchStore.getState().setPdfReadingPosition(readingContextBindingId, position)
    },
    [readingContextBindingId]
  )

  useEffect(() => {
    let active = true
    if (!projectId || !previewItem.artifactId || previewItem.source === 'upload') return

    void window.api.artifacts
      .getLineage({
        projectId,
        appSessionId: previewItem.sessionId,
        artifactId: previewItem.artifactId
      })
      .then((value) => {
        if (active) setLineageLoadState({ key: lineageRequestKey, phase: 'loaded', value })
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
    previewItem.source,
    projectId
  ])

  const applyVersionItem = (nextItem: PreviewFileItem): void => {
    setVersionOverride({ key: itemIdentityKey, item: nextItem })
    if (storedItem?.type === 'file' && storedItem.artifactId === item.artifactId) {
      usePreviewWorkbenchStore.getState().upsertItem(nextItem)
    }
  }

  const selectPreviewVersion = (versionId: string): void => {
    if (!lineage || !projectId) return
    const version = lineage.versions.find((candidate) => candidate.versionId === versionId)
    if (!version) return

    applyVersionItem(
      createPreviewFileItemForArtifactVersion({ item: previewItem, version, projectId })
    )
  }

  // View in context needs the same managed-artifact identity as Provenance, plus a live origin
  // session. Deleted is terminal, so either signal fails closed. Deleting can be compensated;
  // there, the refetched lineage is authoritative over the item's creation-time snapshot.
  const originSessionDeleted =
    lineage?.originSession.state === 'deleted' || previewItem.originSession?.state === 'deleted'
  const currentOriginSessionState =
    lineage?.originSession.state ?? previewItem.originSession?.state ?? 'active'
  const originSessionUnavailable = originSessionDeleted || currentOriginSessionState === 'deleting'
  const canViewInContext =
    previewItem.source !== 'upload' &&
    previewItem.artifactId !== undefined &&
    projectId !== undefined &&
    !originSessionUnavailable
  // Archive is reversible, so the entry stays visible but inert rather than disappearing.
  const originSessionArchived = useSessionStore(
    (state) =>
      state.sessions.find((session) => session.id === previewItem.sessionId)?.archivedAt !==
      undefined
  )
  const viewInContext = (): void => {
    if (!projectId) return
    const opened = useNavigationStore
      .getState()
      .openSession(projectId, previewItem.sessionId, 'user')
    // A guard rejection (session vanished mid-flight) must not close the full-screen dialog on a
    // navigation that never happened.
    if (opened) onViewInContextNavigate?.()
  }
  const downloadPreviewFile = (): void => {
    setPdfContextMenu(undefined)
    void window.api
      .saveManagedFile({
        source: resolvedPreviewItem.source ?? 'artifact',
        path: resolvedPreviewItem.path,
        suggestedName: resolvedPreviewItem.name
      })
      .catch((error: unknown) => {
        console.error(`Failed to download ${resolvedPreviewItem.name} from the PDF preview`, error)
      })
  }

  return (
    <div className="flex size-full min-h-0 flex-col overflow-hidden">
      <PreviewFileHeader
        item={resolvedPreviewItem}
        onClose={onClose}
        onOpenFullScreen={onOpenFullScreen}
        onReload={() => setReloadToken((token) => token + 1)}
        pdfContextAction={pdfContextAction}
        provenanceEntry={provenanceEntry}
        onOpenProvenance={
          previewItem.source !== 'upload' && previewItem.artifactId && projectId
            ? () => setProvenanceTarget(surfaceKey)
            : undefined
        }
        onViewInContext={canViewInContext ? viewInContext : undefined}
        viewInContextDisabled={originSessionArchived}
        tooltipClassName={tooltipClassName}
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
      ) : !showProvenance && lineage ? (
        <ArtifactVersionNavigation
          lineage={lineage}
          selectedVersionId={selectedVersionId}
          onSelect={selectPreviewVersion}
        />
      ) : null}
      <div
        data-testid="preview-file-content-surface"
        className="min-h-0 flex-1 overflow-y-auto bg-bg-000"
        onContextMenu={(event) => {
          if (
            resolvedPreviewItem.format !== 'pdf' ||
            !pdfContextAction ||
            showProvenance ||
            !renderContent
          )
            return
          event.preventDefault()
          setPdfContextMenu({
            itemKey: pdfContextMenuItemKey,
            x: event.clientX,
            y: event.clientY
          })
        }}
      >
        {showProvenance && projectId ? (
          <ArtifactProvenancePanel
            item={resolvedPreviewItem}
            projectId={projectId}
            onClose={() => setProvenanceTarget(undefined)}
            onVersionChange={applyVersionItem}
          />
        ) : renderContent ? (
          <PreviewFileContent
            key={`${contentKey ?? ''}:${previewItem.selectedVersionId ?? ''}:${reloadToken}`}
            item={resolvedPreviewItem}
            activeAnnotations={activeAnnotations}
            onAddAnnotation={onAddAnnotation}
            onUpdateAnnotationNote={onUpdateAnnotationNote}
            onRemoveAnnotation={onRemoveAnnotation}
            onUndoAnnotation={onUndoAnnotation}
            onRedoAnnotation={onRedoAnnotation}
            onAnnotationError={onAnnotationError}
            onPdfReadingPositionChange={
              readingContextBindingId ? reportPdfReadingPosition : undefined
            }
          />
        ) : null}
      </div>
      {pdfContextMenu?.itemKey === pdfContextMenuItemKey && pdfContextAction ? (
        <DropdownMenu
          open
          onOpenChange={(open) => {
            if (!open) setPdfContextMenu(undefined)
          }}
        >
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden="true"
              className="pointer-events-none fixed size-0"
              style={{ left: pdfContextMenu.x, top: pdfContextMenu.y }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="z-[70] min-w-[9.5rem] p-1"
            data-testid="pdf-preview-context-menu"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuItem
              className="min-h-0 h-6 gap-2 rounded-md px-2 py-0 text-[12px]"
              disabled={pdfContextAction.pending || pdfContextAction.disabled}
              onSelect={() => {
                setPdfContextMenu(undefined)
                pdfContextAction.run()
              }}
            >
              {pdfContextAction.state === 'remove' ? (
                <Link2Off className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <BookOpen className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              {pdfContextAction.label}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="min-h-0 h-6 gap-2 rounded-md px-2 py-0 text-[12px]"
              onSelect={downloadPreviewFile}
            >
              <Download className="size-3.5 shrink-0" aria-hidden="true" />
              {t('Download')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

export { PreviewFileSurface }
