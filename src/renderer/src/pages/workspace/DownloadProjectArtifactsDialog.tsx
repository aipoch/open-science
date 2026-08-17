import { useEffect, useMemo, useState } from 'react'
import { Archive, Download, LoaderCircle, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { Button } from '@/components/ui/button'
import {
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogOverlayClassName,
  dialogPanelClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { Project } from '../../../../shared/projects'
import { formatBytes } from '../../../../shared/update'
import type { ProjectFileItem } from '../../../../shared/project-files'
import { listAllProjectFiles } from './project-artifact-download-data'

type DownloadProjectArtifactsDialogProps = {
  project: Project | undefined
  onClose: () => void
  // Mirrors the dialog's in-flight download so the sidebar menu item stays disabled meanwhile.
  onDownloadingChange?: (isDownloading: boolean) => void
}

type FileListStatus = 'loading' | 'ready' | 'error'

type SettledFileList = {
  requestKey: string
  status: Exclude<FileListStatus, 'loading'>
  files: ProjectFileItem[]
  loadError?: string
}

type FileGroup = {
  label: string
  files: ProjectFileItem[]
}

const EMPTY_FILES: ProjectFileItem[] = []

const getFileType = (file: ProjectFileItem): string => {
  const dotIndex = file.name.lastIndexOf('.')
  if (dotIndex >= 0 && dotIndex < file.name.length - 1) {
    return file.name.slice(dotIndex + 1).toLowerCase()
  }
  return file.mimeType?.split('/').at(-1) ?? 'file'
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// Paths can collide across sessions and sources, so failures match on the full identity the save
// contract reports back, not on path alone.
const fileKey = (file: Pick<ProjectFileItem, 'source' | 'sessionId' | 'path'>): string =>
  `${file.source}\u0000${file.sessionId}\u0000${file.path}`

// Generated output is the primary product of a Project, so it leads; Uploads follow. Empty groups
// are dropped entirely, and rows stay flat inside a group — no per-session nesting.
const groupFiles = (files: ProjectFileItem[], t: TFunction): FileGroup[] =>
  [
    { label: t('Generated'), files: files.filter((file) => file.source === 'artifact') },
    { label: t('Uploads'), files: files.filter((file) => file.source === 'upload') }
  ].filter((group) => group.files.length > 0)

const DownloadProjectArtifactsDialog = ({
  project,
  onClose,
  onDownloadingChange
}: DownloadProjectArtifactsDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const dialogProject = useRetainedDialogValue(project)
  const [settledFileList, setSettledFileList] = useState<SettledFileList>()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [downloadError, setDownloadError] = useState<string>()
  const [isDownloading, setIsDownloading] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)
  const projectId = project?.id
  const requestKey = projectId ? `${projectId}\u0000${retryVersion}` : undefined
  const currentFileList = settledFileList?.requestKey === requestKey ? settledFileList : undefined
  const files = currentFileList?.files ?? EMPTY_FILES
  const status: FileListStatus = currentFileList?.status ?? 'loading'
  const loadError = currentFileList?.loadError

  useEffect(() => {
    if (!projectId || !requestKey) return
    let isCurrent = true

    void listAllProjectFiles({
      getOverview: window.api.projectFiles.getOverview,
      listFiles: window.api.projectFiles.listFiles,
      repairIndex: window.api.projectFiles.repairIndex,
      projectId
    }).then(
      (nextFiles) => {
        if (!isCurrent) return
        setSettledFileList({
          requestKey,
          status: 'ready',
          files: nextFiles
        })
        setSelectedIds(new Set(nextFiles.map((file) => file.id)))
        setDownloadError(undefined)
      },
      (error: unknown) => {
        if (!isCurrent) return
        setSettledFileList({
          requestKey,
          status: 'error',
          files: [],
          loadError: getErrorMessage(error)
        })
      }
    )

    return () => {
      isCurrent = false
    }
  }, [projectId, requestKey])

  // The dialog stays mounted between opens, so closing wipes the previous run's selection, error
  // and settled list; the next open starts from loading with a fresh snapshot instead of flashing
  // stale state. Render-phase reset mirrors useRetainedDialogValue.
  const [wasOpen, setWasOpen] = useState(Boolean(project))
  const isOpen = Boolean(project)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (!isOpen) {
      setSettledFileList(undefined)
      setSelectedIds(new Set())
      setDownloadError(undefined)
    }
  }

  const groups = useMemo(() => groupFiles(files, t), [files, t])
  const selectedFiles = useMemo(
    () => files.filter((file) => selectedIds.has(file.id)),
    [files, selectedIds]
  )
  const allSelected = files.length > 0 && selectedFiles.length === files.length

  const toggleFile = (fileId: string): void => {
    setDownloadError(undefined)
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }

  const toggleAll = (): void => {
    setDownloadError(undefined)
    setSelectedIds(allSelected ? new Set() : new Set(files.map((file) => file.id)))
  }

  const downloadSelected = async (): Promise<void> => {
    if (!project || selectedFiles.length === 0 || isDownloading) return
    setIsDownloading(true)
    onDownloadingChange?.(true)
    setDownloadError(undefined)
    try {
      const result = await window.api.saveProjectArtifacts({
        projectId: project.id,
        suggestedArchiveName: project.name,
        files: selectedFiles.map((file) => ({
          source: file.source,
          sessionId: file.sessionId,
          path: file.path,
          // A current-version projection can be re-resolved through its logical ID. Legacy rows
          // without an authoritative version keep the validated path compatibility flow.
          ...(file.sourceVersionId ? { fileId: file.sourceFileId } : {}),
          suggestedName: file.name
        }))
      })
      if (!result.saved) return
      if (result.failures?.length) {
        const failedKeys = new Set(result.failures.map((failure) => fileKey(failure)))
        setSelectedIds(
          new Set(files.filter((file) => failedKeys.has(fileKey(file))).map((file) => file.id))
        )
        setDownloadError(
          `Downloaded ${selectedFiles.length - result.failures.length} of ${selectedFiles.length} artifacts. ${result.failures.length} failed.`
        )
        return
      }
      onClose()
    } catch (error) {
      setDownloadError(getErrorMessage(error))
    } finally {
      setIsDownloading(false)
      onDownloadingChange?.(false)
    }
  }

  return (
    <Dialog.Root
      open={Boolean(project)}
      onOpenChange={(open) => {
        // Closing mid-download would strand the in-flight save with no visible progress or result.
        if (!open && !isDownloading) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[90vh] min-h-[16rem] w-[min(640px,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
          onEscapeKeyDown={(event) => {
            if (isDownloading) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            if (isDownloading) event.preventDefault()
          }}
        >
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border-300/90 px-5 py-3.5">
            <div className="flex min-w-0 items-center gap-2">
              <Archive className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0">
                <Dialog.Title className="text-sm font-semibold text-foreground">
                  {t('Download project artifacts')}
                </Dialog.Title>
                <Dialog.Description className="truncate text-xs text-muted-foreground">
                  {dialogProject?.name ?? t('Project')}
                </Dialog.Description>
              </div>
              {status === 'ready' ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {t('{{selected}} of {{total}} selected', {
                    selected: selectedFiles.length,
                    total: files.length
                  })}
                </span>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Close')}
              className={dialogCloseButtonClassName}
              disabled={isDownloading}
              onClick={onClose}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {status === 'loading' ? (
              <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                {t('Loading artifacts…')}
              </div>
            ) : status === 'error' ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-3 px-6 text-center">
                <p role="alert" className="text-sm text-danger-000">
                  {loadError ?? t('Could not load project artifacts.')}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRetryVersion((v) => v + 1)}
                >
                  {t('Retry')}
                </Button>
              </div>
            ) : files.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t('No downloadable artifacts in this project.')}
              </div>
            ) : (
              <div role="group" aria-label={t('Project artifacts')} className="pb-2">
                {groups.map((group) => (
                  <div
                    key={group.label}
                    role="group"
                    aria-label={group.label}
                    data-testid="project-artifacts-group"
                    data-group={group.label}
                  >
                    <div className="px-5 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </div>
                    {group.files.map((file) => (
                      <label
                        key={file.id}
                        className="flex cursor-pointer items-center gap-3 px-5 py-2 transition-colors hover:bg-muted"
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(file.id)}
                          onChange={() => toggleFile(file.id)}
                          className="size-4 cursor-pointer accent-primary"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {file.name}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {getFileType(file)}
                        </span>
                        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {formatBytes(file.size)}
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-300/90 px-5 py-3.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={status !== 'ready' || files.length === 0 || isDownloading}
              onClick={toggleAll}
            >
              {allSelected ? t('Uncheck all') : t('Check all')}
            </Button>
            <div className="flex min-w-0 items-center gap-3">
              {status === 'ready' && downloadError ? (
                <p role="alert" className="truncate text-xs text-danger-000">
                  {downloadError}
                </p>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                className={dialogCancelButtonClassName}
                size="sm"
                disabled={isDownloading}
                onClick={onClose}
              >
                {t('Cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="download-project-artifacts-confirm"
                disabled={status !== 'ready' || selectedFiles.length === 0 || isDownloading}
                onClick={() => void downloadSelected()}
              >
                {isDownloading ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-4" aria-hidden="true" />
                )}
                {isDownloading
                  ? t('Downloading…')
                  : t('Download {{count}} artifacts', {
                      defaultValue_one: 'Download {{count}} artifact',
                      count: selectedFiles.length
                    })}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { DownloadProjectArtifactsDialog }
export type { DownloadProjectArtifactsDialogProps }
