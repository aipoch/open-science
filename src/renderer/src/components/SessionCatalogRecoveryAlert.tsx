import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@/components/ui/dialog'

import type { SessionCatalogRecovery } from '@/lib/session-persistence/session-persistence'
import { Button } from '@/components/ui/button'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { SessionPersistenceAlert } from './SessionPersistenceAlert'
import { ErrorNotice } from './error-notice'
import {
  SESSION_RECOVERY_COMPUTE_JOBS_ERROR,
  type DeleteSessionRecoveryFileRequest
} from '../../../shared/session-persistence'

type SessionCatalogRecoveryAlertProps = {
  recovery: SessionCatalogRecovery
  inline?: boolean
  onRetry?: () => void
  onOpenRecoveryFolder?: (request: { projectId: string }) => Promise<void>
  onDeleteRecoveryFile?: (request: DeleteSessionRecoveryFileRequest) => Promise<void>
}

// Catalog recovery is a storage concern shown before a Project command is attempted. Keep it
// distinct from command failures and from the Project Files index, which cannot restore Session JSON.
const SessionCatalogRecoveryAlertContent = ({
  recovery,
  inline,
  onRetry,
  onOpenRecoveryFolder,
  onDeleteRecoveryFile
}: SessionCatalogRecoveryAlertProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const recoveryKey = JSON.stringify(recovery)
  const [dismissedRecoveryKey, setDismissedRecoveryKey] = useState<string>()
  const [deleteTarget, setDeleteTarget] = useState<DeleteSessionRecoveryFileRequest>()
  const [isDeleting, setIsDeleting] = useState(false)
  const deleting = useRef(false)
  const [deleteFailed, setDeleteFailed] = useState(false)
  const [computeJobsBlockDeletion, setComputeJobsBlockDeletion] = useState(false)
  const [areRecoveryDetailsOpen, setAreRecoveryDetailsOpen] = useState(false)
  const [recoveryFolderErrorProjectId, setRecoveryFolderErrorProjectId] = useState<string | null>(
    null
  )

  if (recovery.kind === 'ready') return null
  if (!inline && dismissedRecoveryKey === recoveryKey) return null

  // Overlay dismissal is session-local: archive remains blocked and Settings still shows the
  // inline reminder. Restarting the app re-derives catalog recovery and shows the overlay again.
  const onDismiss = inline ? undefined : () => setDismissedRecoveryKey(recoveryKey)
  const deleteRecoveryFile = async (): Promise<void> => {
    if (
      !deleteTarget ||
      !onDeleteRecoveryFile ||
      deleting.current ||
      recovery.kind !== 'damaged-authority' ||
      !recovery.affectedFiles.some(
        (file) =>
          file.projectId === deleteTarget.projectId && file.fileName === deleteTarget.fileName
      )
    )
      return
    deleting.current = true
    setIsDeleting(true)
    setDeleteFailed(false)
    setComputeJobsBlockDeletion(false)
    try {
      await onDeleteRecoveryFile(deleteTarget)
      setDeleteTarget(undefined)
    } catch (error) {
      setDeleteFailed(true)
      setComputeJobsBlockDeletion(
        error instanceof Error && error.message.includes(SESSION_RECOVERY_COMPUTE_JOBS_ERROR)
      )
    } finally {
      deleting.current = false
      setIsDeleting(false)
      // Re-read authoritative diagnostics even when only some recovery copies were removed.
      onRetry?.()
    }
  }
  const openRecoveryFolder = async (projectId: string): Promise<void> => {
    if (!onOpenRecoveryFolder) return
    setRecoveryFolderErrorProjectId(null)
    try {
      await onOpenRecoveryFolder({ projectId })
    } catch {
      setRecoveryFolderErrorProjectId(projectId)
    }
  }

  if (recovery.kind === 'project-deletion-recovery') {
    return (
      <SessionPersistenceAlert
        title={t('Project recovery needs attention')}
        message={t(
          'Open-Science could not finish recovering a previous project deletion. Retry recovery before archiving or deleting projects.'
        )}
        inline={inline}
        onRetry={onRetry}
        retryLabel={t('Retry recovery')}
        onDismiss={onDismiss}
      />
    )
  }
  if (recovery.kind === 'unsupported-version') {
    return (
      <SessionPersistenceAlert
        title={t('Open-Science update required')}
        message={t(
          '{{count}} saved conversations require a newer version of Open-Science. Update the app before creating or saving conversations so those files stay unchanged.',
          {
            count: recovery.affectedFileCount,
            defaultValue_one:
              'A saved conversation requires a newer version of Open-Science. Update the app before creating or saving conversations so those files stay unchanged.'
          }
        )}
        variant="warning"
        inline={inline}
        onDismiss={onDismiss}
      />
    )
  }
  if (recovery.kind === 'damaged-authority' || recovery.kind === 'oversized-authority') {
    const isOversized = recovery.kind === 'oversized-authority'
    const filesByProject = new Map<string, string[]>()
    for (const file of recovery.affectedFiles) {
      const fileNames = filesByProject.get(file.projectId) ?? []
      fileNames.push(file.fileName)
      filesByProject.set(file.projectId, fileNames)
    }
    return (
      <>
        <SessionPersistenceAlert
          title={
            isOversized
              ? t('Conversation storage limit reached')
              : t('Project archive needs attention')
          }
          message={`${
            isOversized
              ? t(
                  'One or more saved conversations exceed the 256 MiB storage limit. They were left unchanged and cannot be opened. Review the affected files before retrying.'
                )
              : t(
                  '{{count}} damaged saved conversations were moved aside. Archiving remains unavailable for affected project data because its state cannot be verified. You can still permanently delete the affected project data.',
                  {
                    count: recovery.affectedFiles.length,
                    defaultValue_one:
                      'A damaged saved conversation was moved aside. Archiving remains unavailable for affected project data because its state cannot be verified. You can still permanently delete the affected project data.'
                  }
                )
          } ${t('Compute jobs in affected Sessions may remain queued. Preserve the affected files and recover a valid copy; dispatch retries automatically.')}`}
          variant="warning"
          inline={inline}
          onRetry={onRetry}
          retryLabel={t('Recheck saved conversations')}
          onAction={() => setAreRecoveryDetailsOpen(true)}
          actionLabel={t('View affected conversations')}
          onDismiss={onDismiss}
        />
        <Dialog.Root
          open={areRecoveryDetailsOpen}
          onOpenChange={(open) => {
            if (deleting.current) return
            setAreRecoveryDetailsOpen(open)
            if (!open) {
              setDeleteTarget(undefined)
              setDeleteFailed(false)
            }
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className={dialogOverlayClassName} />
            <Dialog.Content
              className={dialogPanelClassName(
                'w-[min(520px,calc(100vw-2rem))] overflow-hidden p-0'
              )}
              data-testid="session-recovery-details-dialog"
              aria-busy={isDeleting}
            >
              <div className="border-b border-border px-5 py-4">
                <Dialog.Title className={dialogTitleClassName}>
                  {t('Affected saved conversations')}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                  {isOversized
                    ? t(
                        'These files were left unchanged. Move them out of the Session folder before retrying, or use an older app version to export them.'
                      )
                    : onDeleteRecoveryFile
                      ? t(
                          'Inspect or recover these files, or delete their damaged recovery copies here.'
                        )
                      : t(
                          'These files were moved aside so you can inspect or recover them manually.'
                        )}
                </Dialog.Description>
              </div>
              <ul className="max-h-[50vh] space-y-3 overflow-y-auto p-5">
                {[...filesByProject].map(([projectId, fileNames]) => (
                  <li key={projectId} className="rounded-lg border border-border bg-muted/30 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 break-all text-xs text-muted-foreground">
                        {t('Project: {{projectId}}', { projectId })}
                      </p>
                      {onOpenRecoveryFolder ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => void openRecoveryFolder(projectId)}
                        >
                          {t('Open recovery folder')}
                        </Button>
                      ) : null}
                    </div>
                    {recoveryFolderErrorProjectId === projectId ? (
                      <p role="alert" className="mt-2 text-xs text-danger-000">
                        {t('Could not open that folder.')}
                      </p>
                    ) : null}
                    <ul className="mt-2 space-y-1">
                      {fileNames.map((fileName) => (
                        <li key={fileName} className="space-y-2 text-xs text-foreground">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="min-w-0 break-all font-mono">{fileName}</span>
                            {!isOversized && onDeleteRecoveryFile ? (
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                disabled={isDeleting}
                                onClick={() => {
                                  setDeleteTarget({ projectId, fileName })
                                  setDeleteFailed(false)
                                  setComputeJobsBlockDeletion(false)
                                }}
                              >
                                {t('Delete damaged file')}
                              </Button>
                            ) : null}
                          </div>
                          {deleteTarget?.projectId === projectId &&
                          deleteTarget.fileName === fileName ? (
                            <div className="space-y-3 rounded border border-border p-3">
                              <p>
                                {t(
                                  'Permanently delete the recovery copies of "{{fileName}}"? This conversation can no longer be recovered from them. The project and research files are kept. This cannot be undone.',
                                  { fileName }
                                )}
                              </p>
                              {deleteFailed ? (
                                <ErrorNotice
                                  inline
                                  role="alert"
                                  level="error"
                                  description={
                                    computeJobsBlockDeletion
                                      ? t(
                                          'This conversation still has compute jobs. Recover the conversation or delete its jobs before deleting these copies. Their remote files are kept.'
                                        )
                                      : t(
                                          'Could not delete all recovery copies. Check the remaining files and try again.'
                                        )
                                  }
                                />
                              ) : null}
                              <div className="flex justify-end gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={isDeleting}
                                  onClick={() => {
                                    setDeleteTarget(undefined)
                                    setDeleteFailed(false)
                                  }}
                                >
                                  {t('Cancel')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  disabled={isDeleting}
                                  onClick={() => void deleteRecoveryFile()}
                                >
                                  {isDeleting ? t('Deleting…') : t('Permanently delete')}
                                </Button>
                              </div>
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <div className="flex justify-end border-t border-border px-5 py-3">
                <Dialog.Close asChild>
                  <Button type="button" variant="outline" size="sm" disabled={isDeleting}>
                    {t('Close')}
                  </Button>
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </>
    )
  }

  return (
    <SessionPersistenceAlert
      title={t('Project index needs repair')}
      message={
        recovery.reason === 'startup-reconciliation'
          ? t(
              'Saved conversations loaded, but the project index could not be rebuilt. Repair the index before archiving projects.'
            )
          : t(
              'Some saved conversations could not be indexed. Repair the index before archiving projects.'
            )
      }
      inline={inline}
      onRetry={onRetry}
      retryLabel={t('Repair index')}
      onDismiss={onDismiss}
    />
  )
}

const SessionCatalogRecoveryAlert = (
  props: SessionCatalogRecoveryAlertProps
): React.JSX.Element => <SessionCatalogRecoveryAlertContent key={props.recovery.kind} {...props} />

export { SessionCatalogRecoveryAlert }
