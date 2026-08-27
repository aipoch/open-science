import {
  ChevronLeft,
  ChevronRight,
  Eye,
  FileDiff,
  GitBranch,
  Maximize2,
  MoreHorizontal,
  Pencil,
  X
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

import { ExtensionPreservingFileName } from './ExtensionPreservingFileName'
import { LocalFileHeaderActions } from './LocalFileHeaderActions'
import { ManagedFileDownloadButton } from './ManagedFileDownloadButton'
import {
  createPreviewFileItemForArtifactVersion,
  createPreviewFileItemForManagedVersion,
  resolveArtifactVersionDescriptor
} from './preview-file-item'
import { PreviewFileContent } from './previews/PreviewFileContent'
import type { PreviewDownloadVersionContext } from './previews/preview-runtime-context'
import { ArtifactProvenancePanel } from './ArtifactProvenancePanel'
import { ManagedVersionDiffContent } from './ManagedVersionDiffContent'
import { useManagedVersionWorkflow, type ManagedVersionMode } from './useManagedVersionWorkflow'

type PreviewFileSurfaceProps = {
  item: PreviewFileItem
  contentKey?: string
  renderContent?: boolean
  tooltipClassName?: string
  onClose: () => void
  onOpenFullScreen?: () => void
  onOpenProvenance?: () => void
  onViewInContextNavigate?: () => void
  onReload?: () => void
  provenanceEntry?: 'menu' | 'leading' | 'trailing'
  leaveGuardScope?: string
  workbenchConnected?: boolean
  onItemChange?: (item: PreviewFileItem) => void
}

const hasManagedTextEditExtension = (filename: string): boolean => {
  const extensionIndex = filename.lastIndexOf('.')
  if (extensionIndex <= 0 || extensionIndex === filename.length - 1) return false
  return MANAGED_TEXT_EDIT_EXTENSIONS.has(filename.slice(extensionIndex + 1).toLowerCase())
}

type PreviewFileSurfaceHandle = {
  confirmLeave: () => boolean
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
  downloadVersionContext
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
              {onOpenProvenance && provenanceEntry === 'menu' ? (
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
                    <DropdownMenuItem onSelect={onOpenProvenance}>
                      <GitBranch className="mr-2 size-4" aria-hidden="true" />
                      {t('Provenance')}
                    </DropdownMenuItem>
                    {onViewInContext ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={viewInContextDisabled}
                          onSelect={onViewInContext}
                        >
                          <Eye className="mr-2 size-4" aria-hidden="true" />
                          {t('View in context')}
                          {viewInContextDisabled
                            ? ` (${t('Source conversation is archived')})`
                            : ''}
                        </DropdownMenuItem>
                      </>
                    ) : null}
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
        disabled={selectedIndex <= 0}
        onClick={() => {
          const id = inspect.versions[selectedIndex - 1]?.id
          if (id) onSelect(id)
        }}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <span className="min-w-8 text-center text-xs font-medium text-text-100">
        v{inspect.versions[selectedIndex]?.versionNumber}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('Next file version')}
        disabled={selectedIndex >= inspect.versions.length - 1}
        onClick={() => {
          const id = inspect.versions[selectedIndex + 1]?.id
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
      onClose,
      onOpenFullScreen,
      onViewInContextNavigate,
      provenanceEntry = 'menu',
      leaveGuardScope,
      workbenchConnected = false,
      onItemChange
    },
    ref
  ): React.JSX.Element => {
    const { t } = useTranslation()
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
    const [mode, setMode] = useState<ManagedVersionMode>('view')
    const [draft, setDraft] = useState('')
    const [editBaseline, setEditBaseline] = useState<{
      text: string
      expectedHeadVersionId: string
    }>()
    const [saving, setSaving] = useState(false)
    const [editError, setEditError] = useState<string>()
    const [conflictHead, setConflictHead] = useState<ManagedFileVersionDescriptor>()
    const saveGenerationRef = useRef(0)
    const acceptedIdentityTransitionRef = useRef<string | undefined>(undefined)
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
      (lineage && !previewItem.managedFileId && !selectionIsNewerThanLoadedLineage
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
    const isDirty = mode === 'edit' && editBaseline !== undefined && draft !== editBaseline.text
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

    const confirmLeave = useCallback(
      (): boolean => !isDirty || window.confirm(t('Discard unsaved changes?')),
      [isDirty, t]
    )
    useImperativeHandle(ref, () => ({ confirmLeave }), [confirmLeave])

    useEffect(
      () =>
        leaveGuardScope ? previewLeaveGuards.register(leaveGuardScope, confirmLeave) : undefined,
      [confirmLeave, leaveGuardScope]
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

    const applyVersionItem = (nextItem: PreviewFileItem, skipWorkbenchGuard = false): boolean => {
      const nextIdentityKey = `${nextItem.projectId ?? ''}:${nextItem.source ?? 'artifact'}:${nextItem.id}:${nextItem.managedFileId ?? ''}:${nextItem.artifactId ?? ''}:${nextItem.selectedVersionId ?? ''}:${nextItem.path}`
      if (workbenchConnected) {
        acceptedIdentityTransitionRef.current = nextIdentityKey
        if (!usePreviewWorkbenchStore.getState().upsertItem(nextItem, skipWorkbenchGuard)) {
          acceptedIdentityTransitionRef.current = undefined
          return false
        }
      } else {
        if (!skipWorkbenchGuard && !confirmLeave()) return false
        if (onItemChange) acceptedIdentityTransitionRef.current = nextIdentityKey
        onItemChange?.(nextItem)
        // Uncontrolled surfaces own their local selection; controlled Dialogs publish through
        // onItemChange and must not retain an origin-keyed override that can become stale.
        if (!onItemChange) setVersionOverride({ key: itemIdentityKey, item: nextItem })
      }
      return true
    }

    const selectPreviewVersion = (versionId: string): void => {
      if (!lineage || !projectId) return
      const version = lineage.versions.find((candidate) => candidate.versionId === versionId)
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
      const opened = useNavigationStore
        .getState()
        .openSession(projectId, previewItem.sessionId, 'user')
      if (opened) onViewInContextNavigate?.()
    }

    const selectProvenanceVersion = (nextItem: PreviewFileItem): boolean => {
      if (!applyVersionItem(nextItem)) return false
      finishVersionSelection(false)
      return true
    }

    const selectManagedVersion = (versionId: string): void => {
      if (!managedNavigationInspect || !projectId) return
      const version = managedNavigationInspect.versions.find(
        (candidate) => candidate.id === versionId
      )
      if (!version) return
      const nextItem = createPreviewFileItemForManagedVersion({
        item: previewItem,
        version,
        projectId,
        sessionId: managedNavigationInspect.sessionId
      })
      if (!applyVersionItem(nextItem)) return
      finishVersionSelection(true)
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
      if (!confirmLeave()) return
      invalidateSave()
      managedWorkflow.startDiff()
    }

    return (
      <div className="flex size-full min-h-0 flex-col overflow-hidden">
        <PreviewFileHeader
          item={resolvedPreviewItem}
          onClose={() => {
            if (workbenchConnected || confirmLeave()) {
              invalidateSave()
              onClose()
            }
          }}
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
                      if (confirmLeave()) {
                        invalidateSave()
                        setMode('view')
                        setDraft('')
                        setEditBaseline(undefined)
                      }
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
                            aria-label={t('Edit {{name}}', { name: resolvedPreviewItem.name })}
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
                          className={mode === 'diff' ? undefined : previewHeaderActionClassName}
                          aria-label={
                            mode === 'diff'
                              ? t('Stop comparing {{name}}', { name: resolvedPreviewItem.name })
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
        {!showProvenance && managedNavigationInspect?.text !== undefined ? (
          <ManagedVersionNavigation
            inspect={managedNavigationInspect}
            onSelect={selectManagedVersion}
          />
        ) : !showProvenance &&
          !managedIdentity &&
          lineage &&
          hasManagedTextEditExtension(resolvedPreviewItem.name) ? (
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
                        if (!applyVersionItem(nextItem)) return
                        finishVersionSelection(false)
                      }}
                    >
                      {t('View latest version')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : mode === 'diff' ? (
            managedInspect && !managedInspect.canDiff && managedWorkflow.isSelectedSourceText ? (
              renderContent ? (
                <PreviewFileContent
                  key={`${contentKey ?? ''}:${previewItem.selectedVersionId ?? ''}:${reloadToken}`}
                  item={resolvedPreviewItem}
                  downloadVersionContext={managedWorkflow.downloadVersionContext}
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
            />
          ) : null}
        </div>
      </div>
    )
  }
)

PreviewFileSurface.displayName = 'PreviewFileSurface'

export { PreviewFileSurface }
export type { PreviewFileSurfaceHandle }
