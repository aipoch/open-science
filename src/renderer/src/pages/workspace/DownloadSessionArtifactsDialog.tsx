import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Download, LoaderCircle, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { Button } from '@/components/ui/button'
import {
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogOverlayClassName,
  dialogPanelClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import type { ChatSession } from '@/stores/session-store'
import { formatBytes } from '../../../../shared/update'
import type { ProjectFileItem } from '../../../../shared/project-files'
import { listAllSessionArtifacts } from './session-artifact-download-data'

type DownloadSessionArtifactsDialogProps = {
  session: ChatSession | undefined
  onClose: () => void
}

type ArtifactListStatus = 'loading' | 'ready' | 'error'

type SettledArtifactList = {
  requestKey: string
  status: Exclude<ArtifactListStatus, 'loading'>
  artifacts: ProjectFileItem[]
  loadError?: string
}

type DownloadError =
  | { kind: 'partial'; downloaded: number; total: number; failed: number }
  | { kind: 'raw'; message: string }

const EMPTY_ARTIFACTS: ProjectFileItem[] = []

const getArtifactType = (artifact: ProjectFileItem): string => {
  const dotIndex = artifact.name.lastIndexOf('.')
  if (dotIndex >= 0 && dotIndex < artifact.name.length - 1) {
    return artifact.name.slice(dotIndex + 1).toLowerCase()
  }
  return artifact.mimeType?.split('/').at(-1) ?? 'file'
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const DownloadSessionArtifactsDialog = ({
  session,
  onClose
}: DownloadSessionArtifactsDialogProps): React.JSX.Element => {
  const { t } = useTranslation()

  const dialogSession = useRetainedDialogValue(session)
  const [settledArtifactList, setSettledArtifactList] = useState<SettledArtifactList>()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [downloadError, setDownloadError] = useState<DownloadError>()
  const [isDownloading, setIsDownloading] = useState(false)
  const [retryVersion, setRetryVersion] = useState(0)
  const projectId = session?.projectId
  const sessionId = session?.id
  const requestKey =
    projectId && sessionId ? `${projectId}\u0000${sessionId}\u0000${retryVersion}` : undefined
  const currentArtifactList =
    settledArtifactList?.requestKey === requestKey ? settledArtifactList : undefined
  const artifacts = currentArtifactList?.artifacts ?? EMPTY_ARTIFACTS
  const status: ArtifactListStatus = currentArtifactList?.status ?? 'loading'
  const loadError = currentArtifactList?.loadError

  useEffect(() => {
    if (!projectId || !sessionId || !requestKey) return
    let isCurrent = true

    void listAllSessionArtifacts({
      getOverview: window.api.projectFiles.getOverview,
      listFiles: window.api.projectFiles.listFiles,
      repairIndex: window.api.projectFiles.repairIndex,
      projectId,
      sessionId
    }).then(
      (nextArtifacts) => {
        if (!isCurrent) return
        setSettledArtifactList({
          requestKey,
          status: 'ready',
          artifacts: nextArtifacts
        })
        setSelectedIds(new Set(nextArtifacts.map((artifact) => artifact.id)))
        setDownloadError(undefined)
      },
      (error: unknown) => {
        if (!isCurrent) return
        setSettledArtifactList({
          requestKey,
          status: 'error',
          artifacts: [],
          loadError: getErrorMessage(error)
        })
      }
    )

    return () => {
      isCurrent = false
    }
  }, [projectId, requestKey, sessionId])

  const selectedArtifacts = useMemo(
    () => artifacts.filter((artifact) => selectedIds.has(artifact.id)),
    [artifacts, selectedIds]
  )
  const allSelected = artifacts.length > 0 && selectedArtifacts.length === artifacts.length

  const toggleArtifact = (artifactId: string): void => {
    setDownloadError(undefined)
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(artifactId)) next.delete(artifactId)
      else next.add(artifactId)
      return next
    })
  }

  const toggleAll = (): void => {
    setDownloadError(undefined)
    setSelectedIds(allSelected ? new Set() : new Set(artifacts.map((artifact) => artifact.id)))
  }

  const downloadSelected = async (): Promise<void> => {
    if (!session || selectedArtifacts.length === 0 || isDownloading) return
    setIsDownloading(true)
    setDownloadError(undefined)
    try {
      const result = await window.api.saveSessionArtifacts({
        projectId: session.projectId,
        sessionId: session.id,
        files: selectedArtifacts.map((artifact) => ({
          fileId: artifact.sourceFileId,
          versionId: artifact.sourceVersionId,
          suggestedName: artifact.name
        }))
      })
      if (!result.saved) return
      if (result.failures?.length) {
        const failedFileIds = new Set(result.failures.map((failure) => failure.fileId))
        setSelectedIds(
          new Set(
            artifacts
              .filter((artifact) => failedFileIds.has(artifact.sourceFileId))
              .map((artifact) => artifact.id)
          )
        )
        setDownloadError({
          kind: 'partial',
          downloaded: result.filePaths.length,
          total: selectedArtifacts.length,
          failed: result.failures.length
        })
        return
      }
      onClose()
    } catch (error) {
      setDownloadError({ kind: 'raw', message: getErrorMessage(error) })
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <Dialog.Root
      open={Boolean(session)}
      onOpenChange={(open) => {
        if (!open && !isDownloading) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[80svh] w-[min(640px,calc(100vw-2rem))] flex-col overflow-hidden p-0'
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
                  {t('Download session artifacts')}
                </Dialog.Title>
                <Dialog.Description className="truncate text-xs text-muted-foreground">
                  {dialogSession?.title ?? t('Session')}
                </Dialog.Description>
              </div>
              {status === 'ready' ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {t('{{selected}} of {{total}} selected', {
                    selected: selectedArtifacts.length,
                    total: artifacts.length
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
                  {loadError ?? t('Could not load session artifacts.')}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRetryVersion((v) => v + 1)}
                >
                  {t('Retry')}
                </Button>
              </div>
            ) : artifacts.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                {t('No downloadable artifacts in this session.')}
              </div>
            ) : (
              <div role="group" aria-label={t('Session artifacts')}>
                {artifacts.map((artifact) => (
                  <label
                    key={artifact.id}
                    className="flex cursor-pointer items-center gap-3 px-5 py-2 transition-colors hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(artifact.id)}
                      onChange={() => toggleArtifact(artifact.id)}
                      className="size-4 cursor-pointer accent-primary"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {artifact.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {getArtifactType(artifact)}
                    </span>
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {formatBytes(artifact.size)}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-300/90 px-5 py-3.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={status !== 'ready' || artifacts.length === 0 || isDownloading}
              onClick={toggleAll}
            >
              {allSelected ? t('Uncheck all') : t('Check all')}
            </Button>
            <div className="flex min-w-0 items-center gap-3">
              {status === 'ready' && downloadError ? (
                <p role="alert" className="truncate text-xs text-danger-000">
                  {downloadError.kind === 'partial'
                    ? t(
                        'Downloaded {{downloaded}} of {{total}} artifacts. {{failed}} failed.',
                        downloadError
                      )
                    : downloadError.message}
                </p>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={dialogCancelButtonClassName}
                disabled={isDownloading}
                onClick={onClose}
              >
                {t('Cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="download-session-artifacts-confirm"
                disabled={status !== 'ready' || selectedArtifacts.length === 0 || isDownloading}
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
                      count: selectedArtifacts.length,
                      defaultValue_one: 'Download {{count}} artifact'
                    })}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { DownloadSessionArtifactsDialog }
export type { DownloadSessionArtifactsDialogProps }
