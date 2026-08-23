import {
  ChevronLeft,
  ChevronRight,
  Eye,
  GitBranch,
  Maximize2,
  MoreHorizontal,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
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
import {
  createPreviewFileItemForArtifactVersion,
  resolveArtifactVersionDescriptor
} from './preview-file-item'
import { PreviewFileContent } from './previews/PreviewFileContent'
import { ArtifactProvenancePanel } from './ArtifactProvenancePanel'

type PreviewFileSurfaceProps = {
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
  provenanceEntry?: 'menu' | 'leading' | 'trailing'
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
  provenanceEntry = 'menu'
}: PreviewFileSurfaceProps): React.JSX.Element => {
  const [provenanceTarget, setProvenanceTarget] = useState<string>()
  // Bumping this token remounts the content tree so a local file is re-read from disk.
  const [reloadToken, setReloadToken] = useState(0)
  const [versionOverride, setVersionOverride] = useState<{
    key: string
    item: PreviewFileItem
  }>()
  const [lineageResult, setLineageResult] = useState<{
    key: string
    value?: ArtifactLineageProvenance
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
  const lineage = lineageResult?.key === lineageRequestKey ? lineageResult.value : undefined
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
        if (active) setLineageResult({ key: lineageRequestKey, value })
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [
    lineageKey,
    lineageRequestKey,
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

  return (
    <div className="flex size-full min-h-0 flex-col overflow-hidden">
      <PreviewFileHeader
        item={resolvedPreviewItem}
        onClose={onClose}
        onOpenFullScreen={onOpenFullScreen}
        onReload={() => setReloadToken((token) => token + 1)}
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
      {!showProvenance && lineage ? (
        <ArtifactVersionNavigation
          lineage={lineage}
          selectedVersionId={selectedVersionId}
          onSelect={selectPreviewVersion}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto bg-bg-000">
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
          />
        ) : null}
      </div>
    </div>
  )
}

export { PreviewFileSurface }
