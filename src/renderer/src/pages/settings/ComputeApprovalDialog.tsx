import { ErrorNotice } from '@/components/error-notice'
import { useState } from 'react'
import { ShieldAlert, ChevronDown, ChevronUp } from 'lucide-react'
import * as Dialog from '@/components/ui/dialog'
import { useTranslation } from 'react-i18next'

import type { ComputeApprovalDecision } from '../../../../shared/compute'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  dialogBodyClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { cn } from '@/lib/utils'
import {
  PermissionScopeConfirmationDialog,
  type BroadPermissionScope
} from '@/pages/workspace/PermissionScopeConfirmationDialog'
import { useComputeStore } from '@/stores/compute-store'

type PendingBroadScope = Readonly<{
  requestId: string
  scope: BroadPermissionScope
}>

// A modal approval card for a pending compute operation. The card cannot be dismissed without
// a decision — the call is held open in main until the user responds (or a 5-minute timeout fires).
//
// Four approval scopes; Broker persists Session/Project/Global and the compute adapter receives a
// one-call allow decision only after that write succeeds.
//   Once             — approve this call only; card shown every time
//   This session      — approve for (provider, operation) for this persisted session
//   This project      — approve for (provider, operation) for all future calls in this project
//   Always            — approve for (provider, operation) across projects
export function ComputeApprovalDialog({
  active = true,
  blockedSessionIds
}: {
  active?: boolean
  blockedSessionIds?: ReadonlySet<string>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const request = useComputeStore((state) =>
    state.pendingApprovals.find(
      (candidate) => !candidate.sessionId || !blockedSessionIds?.has(candidate.sessionId)
    )
  )
  const respondApproval = useComputeStore((state) => state.respondApproval)
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null)
  const [pendingBroadScope, setPendingBroadScope] = useState<PendingBroadScope>()
  const [responding, setResponding] = useState(false)
  const [responseErrorRequestId, setResponseErrorRequestId] = useState<string>()

  const dialogRequest = useRetainedDialogValue(request)
  if (!dialogRequest) return null

  const submitResponse = (decision: ComputeApprovalDecision): void => {
    if (responding) return
    const requestId = dialogRequest.id
    setResponding(true)
    setResponseErrorRequestId(undefined)
    void respondApproval(requestId, decision)
      .catch(() => setResponseErrorRequestId(requestId))
      .finally(() => setResponding(false))
  }
  const deny = (): void => submitResponse('deny')
  const approveOnce = (): void => submitResponse('once')
  const approveSession = (): void => submitResponse('session')
  const confirmBroadScope = (): void => {
    if (!pendingBroadScope) return
    const { requestId, scope } = pendingBroadScope
    setPendingBroadScope(undefined)
    if (request?.id !== requestId) return
    submitResponse(scope)
  }

  const hasCommand = dialogRequest.operation !== 'download'
  const isLongCommand = hasCommand && dialogRequest.commandPreview !== dialogRequest.commandFull
  const showFull = expandedRequestId === dialogRequest.id
  const title =
    dialogRequest.operation === 'download'
      ? t('Allow remote file download?')
      : dialogRequest.operation === 'submit_job'
        ? t('Allow remote job submission?')
        : t('Allow remote command?')
  const description =
    dialogRequest.operation === 'download'
      ? t(
          "The remote file will be copied into this Session's local cache. Approve only if you trust the source and path."
        )
      : dialogRequest.operation === 'submit_job'
        ? t(
            'This job will run as your account on the host and is not sandboxed. Review the command, resources, remote workdir, and timeout before approving.'
          )
        : t(
            'Remote commands run as your account on the host and are not sandboxed. Approve only if you trust this command.'
          )
  const broadScopeSubject =
    dialogRequest.operation === 'download'
      ? t('remote file downloads from {{host}}', { host: dialogRequest.providerName })
      : dialogRequest.operation === 'submit_job'
        ? t('remote job submissions on {{host}}', { host: dialogRequest.providerName })
        : t('remote commands on {{host}}', { host: dialogRequest.providerName })

  return (
    <Dialog.Root open={active && Boolean(request)}>
      <Dialog.Portal>
        <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
        <Dialog.Content
          aria-busy={responding}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className={dialogPanelClassName(
            'z-[60] flex max-h-[calc(100svh-2rem)] w-[min(480px,calc(100vw-2rem))] flex-col overscroll-contain p-0'
          )}
        >
          <div className={cn(dialogHeaderClassName, 'shrink-0 items-start justify-start')}>
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden="true" />
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>{title}</Dialog.Title>
              <Dialog.Description
                className={cn(dialogDescriptionClassName, 'text-xs [text-wrap:pretty]')}
              >
                {description}
              </Dialog.Description>
            </div>
          </div>

          <ScrollArea
            key={dialogRequest.id}
            className="grid min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:h-auto [&>[data-slot=scroll-area-viewport]]:min-h-0"
          >
            <div className={dialogBodyClassName}>
              <div className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <div className="flex gap-2">
                  <span className="w-16 shrink-0 text-muted-foreground">{t('Host')}</span>
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {dialogRequest.providerName}
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="w-16 shrink-0 text-muted-foreground">{t('Intent')}</span>
                  <span className="min-w-0 break-words text-foreground">
                    {dialogRequest.intent}
                  </span>
                </div>
                {hasCommand ? (
                  <div className="flex gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">{t('Command')}</span>
                    <div className="min-w-0 flex-1">
                      <span className="break-all font-mono text-muted-foreground">
                        {showFull ? dialogRequest.commandFull : dialogRequest.commandPreview}
                      </span>
                      {isLongCommand && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedRequestId((id) =>
                              id === dialogRequest.id ? null : dialogRequest.id
                            )
                          }
                          className="mt-1 flex items-center gap-0.5 text-xs text-primary hover:underline"
                          aria-expanded={showFull}
                        >
                          {showFull ? (
                            <>
                              <ChevronUp className="size-3" aria-hidden="true" /> {t('Show less')}
                            </>
                          ) : (
                            <>
                              <ChevronDown className="size-3" aria-hidden="true" />{' '}
                              {t('Show full command')}
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">{t('Remote path')}</span>
                    <span className="min-w-0 break-all font-mono text-muted-foreground">
                      {dialogRequest.remotePath}
                    </span>
                  </div>
                )}
                {dialogRequest.operation === 'submit_job' && dialogRequest.inputsSummary && (
                  <div className="flex gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">{t('Inputs')}</span>
                    <span className="min-w-0 break-words text-foreground">
                      {dialogRequest.inputsSummary}
                    </span>
                  </div>
                )}
                {dialogRequest.operation === 'submit_job' && dialogRequest.executionMode && (
                  <div className="flex gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">
                      {t('Execution mode')}
                    </span>
                    <span className="min-w-0 text-foreground">
                      {dialogRequest.executionMode === 'slurm' ? t('Slurm') : t('Direct SSH')}
                    </span>
                  </div>
                )}
                {dialogRequest.operation === 'submit_job' && dialogRequest.environment && (
                  <div className="flex gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">{t('Environment')}</span>
                    <span className="min-w-0 break-all font-mono text-muted-foreground">
                      {dialogRequest.environment}
                    </span>
                  </div>
                )}
                {dialogRequest.operation === 'submit_job' && dialogRequest.resources && (
                  <div className="flex gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">{t('Resources')}</span>
                    <span className="min-w-0 break-all font-mono text-muted-foreground">
                      {dialogRequest.resources}
                    </span>
                  </div>
                )}
                {dialogRequest.operation === 'submit_job' && (
                  <>
                    <div className="flex gap-2">
                      <span className="w-20 shrink-0 text-muted-foreground">{t('Timeout')}</span>
                      <span className="min-w-0 text-foreground">
                        {t('{{count}} seconds', {
                          count: dialogRequest.timeoutSeconds,
                          defaultValue_one: '{{count}} second'
                        })}
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <span className="w-20 shrink-0 text-muted-foreground">
                        {t('Remote workdir')}
                      </span>
                      <span className="min-w-0 break-all font-mono text-muted-foreground">
                        {dialogRequest.remoteWorkdir}
                      </span>
                    </div>
                  </>
                )}
              </div>
              {dialogRequest.willPersistUnencrypted ? (
                <ErrorNotice
                  role="alert"
                  tone="amber"
                  className="mt-3"
                  description={t(
                    "Secure storage is unavailable. This job's command, paths, and output may be stored without encryption."
                  )}
                />
              ) : null}
              {responseErrorRequestId === dialogRequest.id ? (
                <ErrorNotice
                  role="alert"
                  tone="amber"
                  className="mt-3"
                  description={t('Could not submit this approval. Try again.')}
                />
              ) : null}
            </div>
          </ScrollArea>
          <div className={cn(dialogFooterClassName, 'shrink-0 flex-wrap')}>
            <Button type="button" variant="destructive" disabled={responding} onClick={deny}>
              {t('Deny')}
            </Button>
            <Button type="button" variant="outline" disabled={responding} onClick={approveOnce}>
              {t('Once')}
            </Button>
            <Button type="button" variant="outline" disabled={responding} onClick={approveSession}>
              {t('This session')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={responding}
              onClick={() =>
                setPendingBroadScope({ requestId: dialogRequest.id, scope: 'project' })
              }
            >
              {t('This project')}
            </Button>
            <Button
              type="button"
              disabled={responding}
              onClick={() => setPendingBroadScope({ requestId: dialogRequest.id, scope: 'global' })}
            >
              {t('Always')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <PermissionScopeConfirmationDialog
        confirmation={
          active && pendingBroadScope && request?.id === pendingBroadScope.requestId
            ? {
                scope: pendingBroadScope.scope,
                subject: broadScopeSubject,
                codeExecution: dialogRequest.operation !== 'download'
              }
            : undefined
        }
        onCancel={() => setPendingBroadScope(undefined)}
        onConfirm={confirmBroadScope}
      />
    </Dialog.Root>
  )
}
