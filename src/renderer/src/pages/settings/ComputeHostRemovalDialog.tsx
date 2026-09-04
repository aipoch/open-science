import { X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertDialog } from 'radix-ui'

import type {
  ComputeHost,
  ComputeHostDeletionBlocker,
  ComputeHostDeletionStatus
} from '../../../../shared/compute'
import { JobStatusBadge } from '@/components/JobStatusBadge'
import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useComputeStore } from '@/stores/compute-store'

type ComputeHostRemovalDialogProps = {
  host: ComputeHost
  onRemoved: () => void
}

const ACTIVE_JOB_STATUSES = new Set(['queued', 'submitted', 'running'])
const HARVESTABLE_TERMINAL_STATUSES = new Set(['success', 'failed', 'timeout'])
const canCleanRemoteFiles = (job: ComputeHostDeletionBlocker): boolean =>
  ACTIVE_JOB_STATUSES.has(job.status) ||
  !HARVESTABLE_TERMINAL_STATUSES.has(job.status) ||
  job.harvested === true

export function ComputeHostRemovalDialog({
  host,
  onRemoved
}: ComputeHostRemovalDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const deleteHost = useComputeStore((state) => state.deleteHost)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [deletionStatus, setDeletionStatus] = useState<ComputeHostDeletionStatus | undefined>()
  const [showJobs, setShowJobs] = useState(false)
  const blockingJobs = deletionStatus?.blockingJobs ?? []

  const openConfirmation = (): void => {
    setOpen(true)
    setError(undefined)
    setDeletionStatus(undefined)
    setShowJobs(false)
    void window.api.compute
      .deletionStatus({ providerId: host.providerId })
      .then(setDeletionStatus)
      .catch(() => setError(t('Could not check whether this Host can be removed.')))
  }

  const settleRemoteCleanup = async (
    job: ComputeHostDeletionBlocker,
    disposition: 'cleaned' | 'abandoned'
  ): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await window.api.compute.jobsSetRemoteCleanup({
        jobId: job.jobId,
        providerId: host.providerId,
        projectId: job.projectId,
        sessionId: job.sessionId,
        disposition
      })
      setDeletionStatus((current) => {
        const blockingJobs = (current?.blockingJobs ?? []).filter(
          (candidate) => candidate.jobId !== job.jobId
        )
        return { blockedByJobs: blockingJobs.length > 0, blockingJobs }
      })
    } catch {
      setError(t('Could not update remote cleanup for this Compute Job.'))
    } finally {
      setBusy(false)
    }
  }

  const cleanJob = (job: ComputeHostDeletionBlocker): void => {
    const active = ACTIVE_JOB_STATUSES.has(job.status)
    if (
      active &&
      !window.confirm(t('This Compute Job is active. Cancel it and remove its remote files?'))
    ) {
      return
    }
    void settleRemoteCleanup(job, 'cleaned')
  }

  const abandonJob = (job: ComputeHostDeletionBlocker): void => {
    if (
      !window.confirm(
        t(
          'Abandon remote cleanup? The Job history stays local, but its remote files may remain permanently.'
        )
      )
    ) {
      return
    }
    void settleRemoteCleanup(job, 'abandoned')
  }

  const cleanAllJobs = async (): Promise<void> => {
    if (
      blockingJobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status)) &&
      !window.confirm(t('Cancel active Compute Jobs and remove all listed remote files?'))
    ) {
      return
    }
    for (const job of blockingJobs) await settleRemoteCleanup(job, 'cleaned')
  }

  const removeHost = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await deleteHost(host.providerId)
      setOpen(false)
      onRemoved()
    } catch {
      setError(t('Could not remove this Compute Host.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          asChild
          onFocus={(event) => {
            if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
          }}
        >
          <AlertDialog.Trigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={openConfirmation}
              aria-label={t('Remove {{name}}', { name: host.displayName })}
              className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </AlertDialog.Trigger>
        </TooltipTrigger>
        <TooltipContent>{t('Remove host')}</TooltipContent>
      </Tooltip>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className={dialogOverlayClassName} />
        <AlertDialog.Content
          className={dialogPanelClassName('w-[min(460px,calc(100vw-2rem))] p-0')}
        >
          <div className={dialogHeaderClassName}>
            <AlertDialog.Title className={dialogTitleClassName}>
              {t('Remove Compute Host?')}
            </AlertDialog.Title>
          </div>
          <div className={dialogBodyClassName}>
            <AlertDialog.Description className={dialogDescriptionClassName}>
              {host.authentication?.mode === 'password'
                ? t(
                    'The local Compute Host and encrypted password will be deleted. The remote SSH account is unchanged, and the password cannot be recovered.'
                  )
                : t('The local Compute Host will be deleted. The remote SSH account is unchanged.')}
            </AlertDialog.Description>
            {deletionStatus?.blockedByJobs ? (
              <div className="mt-3 space-y-3">
                <p role="alert" className="text-sm text-destructive">
                  {t('This Host cannot be removed while Compute Jobs still need remote cleanup.')}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setShowJobs((visible) => !visible)}
                >
                  {showJobs ? t('Hide blocking jobs') : t('View blocking jobs')}
                </Button>
                {showJobs ? (
                  <div className="max-h-64 space-y-2 overflow-y-auto">
                    {(deletionStatus.blockingJobs ?? []).map((job) => (
                      <div key={job.jobId} className="rounded-md border p-3 text-sm">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{job.intent || job.jobId}</p>
                            <p className="truncate text-xs text-muted-foreground">{job.jobId}</p>
                          </div>
                          <JobStatusBadge
                            status={job.status}
                            cancellationStatus={job.cancellationStatus}
                          />
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            disabled={busy || !canCleanRemoteFiles(job)}
                            onClick={() => cleanJob(job)}
                          >
                            {t('Clean up remote files')}
                          </Button>
                          {!['queued', 'submitted', 'running'].includes(job.status) ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => abandonJob(job)}
                            >
                              {t('Abandon remote cleanup')}
                            </Button>
                          ) : null}
                        </div>
                        {!canCleanRemoteFiles(job) ? (
                          <p className="mt-2 text-xs text-muted-foreground">
                            {t('Finish harvesting before cleaning up remote files.')}
                          </p>
                        ) : null}
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || blockingJobs.some((job) => !canCleanRemoteFiles(job))}
                      onClick={() => void cleanAllJobs()}
                    >
                      {t('Clean up all remote files')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <div className={dialogFooterClassName}>
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" disabled={busy}>
                {t('Cancel')}
              </Button>
            </AlertDialog.Cancel>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || deletionStatus?.blockedByJobs !== false}
              onClick={() => void removeHost()}
            >
              {busy ? t('Removing…') : t('Remove Host')}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
