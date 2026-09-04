import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from 'radix-ui'

import type { SessionCatalogRecovery } from '@/lib/session-persistence/session-persistence'
import { Button } from '@/components/ui/button'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { SessionPersistenceAlert } from './SessionPersistenceAlert'

type SessionCatalogRecoveryAlertProps = {
  recovery: SessionCatalogRecovery
  inline?: boolean
  onRetry?: () => void
  onOpenRecoveryFolder?: (request: { projectId: string }) => Promise<void>
}

// Catalog recovery is a storage concern shown before a Project command is attempted. Keep it
// distinct from command failures and from the Project Files index, which cannot restore Session JSON.
const SessionCatalogRecoveryAlert = ({
  recovery,
  inline,
  onRetry,
  onOpenRecoveryFolder
}: SessionCatalogRecoveryAlertProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [isOverlayDismissed, setIsOverlayDismissed] = useState(false)
  const [areRecoveryDetailsOpen, setAreRecoveryDetailsOpen] = useState(false)
  const [recoveryFolderErrorProjectId, setRecoveryFolderErrorProjectId] = useState<string | null>(
    null
  )

  if (recovery.kind === 'ready') return null
  if (!inline && isOverlayDismissed) return null

  // Overlay dismissal is session-local: archive remains blocked and Settings still shows the
  // inline reminder. Restarting the app re-derives catalog recovery and shows the overlay again.
  const onDismiss = inline ? undefined : () => setIsOverlayDismissed(true)
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
          'Open Science could not finish recovering a previous project deletion. Retry recovery before archiving or deleting projects.'
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
        title={t('Open Science update required')}
        message={t(
          '{{count}} saved conversations require a newer version of Open Science. Update the app before creating or saving conversations so those files stay unchanged.',
          {
            count: recovery.affectedFileCount,
            defaultValue_one:
              'A saved conversation requires a newer version of Open Science. Update the app before creating or saving conversations so those files stay unchanged.'
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
          message={
            isOversized
              ? t(
                  'One or more saved conversations exceed the 256 MiB storage limit. They were left unchanged and cannot be opened. Review the affected files before retrying.'
                )
              : t(
                  '{{count}} damaged saved conversations were moved aside. Project archive stays unavailable because their state cannot be verified. You can still permanently delete the project.',
                  {
                    count: recovery.affectedFiles.length,
                    defaultValue_one:
                      'A damaged saved conversation was moved aside. Project archive stays unavailable because its state cannot be verified. You can still permanently delete the project.'
                  }
                )
          }
          variant="warning"
          inline={inline}
          onAction={() => setAreRecoveryDetailsOpen(true)}
          actionLabel={t('View affected conversations')}
          onDismiss={onDismiss}
        />
        <Dialog.Root open={areRecoveryDetailsOpen} onOpenChange={setAreRecoveryDetailsOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className={dialogOverlayClassName} />
            <Dialog.Content
              className={dialogPanelClassName(
                'w-[min(520px,calc(100vw-2rem))] overflow-hidden p-0'
              )}
              data-testid="session-recovery-details-dialog"
            >
              <div className="border-b border-border px-5 py-4">
                <Dialog.Title className="text-base font-semibold text-foreground">
                  {t('Affected saved conversations')}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted-foreground">
                  {isOversized
                    ? t(
                        'These files were left unchanged. Move them out of the Session folder before retrying, or use an older app version to export them.'
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
                        <li key={fileName} className="break-all font-mono text-xs text-foreground">
                          {fileName}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <div className="flex justify-end border-t border-border px-5 py-3">
                <Dialog.Close asChild>
                  <Button type="button" variant="outline" size="sm">
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

export { SessionCatalogRecoveryAlert }
