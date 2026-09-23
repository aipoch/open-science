import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { JobSummary } from '../../../shared/compute'
import { useSessionStore } from '@/stores/session-store'
import { useWorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'
import { Button } from './ui/button'
import * as Dialog from './ui/dialog'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from './ui/dialog-chrome'

export function JobCancellationAgentDialog({
  job,
  onClose
}: {
  job: JobSummary
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const runtime = useWorkspaceAgentRuntime()
  const [reviewed] = useState(job)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const submitted = useRef(false)
  const session = useSessionStore((state) =>
    state.sessions.find((item) => item.id === job.session_id)
  )
  const current =
    job.job_id === reviewed.job_id &&
    job.cancellation?.updatedAt === reviewed.cancellation?.updatedAt &&
    job.cancellation_status === 'cancel_failed'
  const diagnostics = JSON.stringify(
    {
      providerId: reviewed.provider_id,
      jobId: reviewed.job_id,
      cancellationStatus: reviewed.cancellation_status,
      failureCode: reviewed.cancellation?.failureCode,
      attemptCount: reviewed.cancellation?.attemptCount
    },
    null,
    2
  )
  const prompt = [
    t(
      'Inspect this remote job via SSH and attempt to stop it. Authorization applies only to this job.'
    ),
    t('Verify process ownership before sending termination signals.'),
    t(
      'Deleting files, changing settings or permissions, and restarting services or the host require separate approval.'
    ),
    t(
      'After intervention, retry cancellation through Open-Science and verify that the app confirms the job stopped.'
    ),
    diagnostics
  ].join('\n\n')
  const ready =
    current &&
    !!session &&
    session.projectId === reviewed.project_id &&
    session.contentLoaded !== false &&
    (session.status === 'idle' || session.status === 'error') &&
    !session.activeRun
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={`${dialogOverlayClassName} z-[80]`} />
        <Dialog.Content
          className={dialogPanelClassName('z-[80] max-w-xl max-h-[85vh] overflow-auto p-6')}
          aria-describedby={undefined}
        >
          <Dialog.Title className={dialogTitleClassName}>
            {t('Allow agent inspection?')}
          </Dialog.Title>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t('Review the exact request below. This does not change the agent’s permissions.')}
          </p>
          <div
            className="mt-5 whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/30 p-5 text-sm leading-6"
            data-testid="job-agent-payload"
          >
            {prompt.slice(0, -diagnostics.length)}
            <span className="font-mono text-xs leading-5 text-muted-foreground">{diagnostics}</span>
          </div>
          {!ready ? (
            <p role="status" className="mt-2 text-sm leading-6 text-muted-foreground">
              {t(
                'Open the original session and wait for it to become idle. Reopen this dialog if the job state changes.'
              )}
            </p>
          ) : null}
          {failed ? (
            <p role="alert" className="mt-3 text-sm text-status-failure-foreground">
              {t('Unable to send the inspection request.')}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="outline" disabled={pending} onClick={onClose}>
              {t('Back')}
            </Button>
            <Button
              data-testid="job-agent-confirm"
              disabled={!ready || pending}
              onClick={async () => {
                if (!ready || submitted.current) return
                submitted.current = true
                setPending(true)
                setFailed(false)
                try {
                  const result = await runtime.sendMessage({
                    sessionId: reviewed.session_id,
                    projectId: reviewed.project_id,
                    cwd: session?.cwd,
                    text: prompt,
                    requireExistingSession: true,
                    preserveSelection: true
                  })
                  if (!result) throw new Error('Message not admitted')
                  onClose()
                } catch {
                  submitted.current = false
                  setFailed(true)
                } finally {
                  setPending(false)
                }
              }}
            >
              {t('Confirm and send to agent')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
