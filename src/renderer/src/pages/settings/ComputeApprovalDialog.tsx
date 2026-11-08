import { PermissionScopeButton } from '@/pages/workspace/PermissionScopeButton'
import { ErrorNotice } from '@/components/error-notice'
import { useState, type ReactNode } from 'react'
import { ShieldAlert, ChevronDown, ChevronUp, X } from 'lucide-react'
import * as Dialog from '@/components/ui/dialog'
import { useTranslation } from 'react-i18next'

import type { ComputeApprovalDecision } from '../../../../shared/compute'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  dialogBodyClassName,
  dialogCloseButtonClassName,
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

function ApprovalRow({
  label,
  children,
  mono
}: {
  label: string
  children: ReactNode
  mono?: boolean
}): React.JSX.Element {
  return (
    <tr>
      <th scope="row" className="py-1 pr-3 text-left font-normal text-muted-foreground">
        {label}
      </th>
      <td className={cn('py-1', mono && 'whitespace-pre-wrap font-mono')}>{children}</td>
    </tr>
  )
}

// Closing releases the UI immediately and denies idle requests through the store.
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
      (candidate) =>
        !candidate.closed && (!candidate.sessionId || !blockedSessionIds?.has(candidate.sessionId))
    )
  )
  const respondApproval = useComputeStore((state) => state.respondApproval)
  const close = useComputeStore((state) => state.closeApproval)
  const [expandedRequestId, setExpandedRequestId] = useState<string | null>(null)
  const [pendingBroadScope, setPendingBroadScope] = useState<PendingBroadScope>()
  const [respondingRequestId, setRespondingRequestId] = useState<string>()
  const [responseErrorRequestId, setResponseErrorRequestId] = useState<string>()

  const dialogRequest = useRetainedDialogValue(request)
  if (!dialogRequest) return null

  const responding = dialogRequest.responding || respondingRequestId === dialogRequest.id

  const submitResponse = (decision: ComputeApprovalDecision): void => {
    if (responding) return
    const requestId = dialogRequest.id
    setRespondingRequestId(requestId)
    setResponseErrorRequestId(undefined)
    void respondApproval(requestId, decision)
      .catch(() => setResponseErrorRequestId(requestId))
      .finally(() =>
        setRespondingRequestId((current) => (current === requestId ? undefined : current))
      )
  }
  const deny = (): void => submitResponse('deny')
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
  const job = dialogRequest.operation === 'submit_job' ? dialogRequest : undefined
  const modal = job?.modal,
    ray = job?.ray,
    hosted = job?.hosted,
    kubernetes = job?.kubernetes
  const files = modal ?? ray ?? hosted ?? kubernetes
  const backendName = modal
    ? t('Modal Sandboxes')
    : ray
      ? t('Ray Jobs')
      : hosted
        ? t('Hugging Face Jobs')
        : kubernetes
          ? t('Kubernetes')
          : undefined

  const description = modal
    ? t(
        'Only declared outputs are archived. After verified publication the job volume and its remaining files are deleted. The volume is retained if collection is incomplete.'
      )
    : ray
      ? t(
          'Declared outputs are archived and originals stay in the shared directory. The driver limits command runtime. The app requests a stop for overdue jobs when connected.'
        )
      : hosted
        ? t(
            'Only declared outputs are archived. After verification, the job files are removed from the bucket.'
          )
        : kubernetes
          ? t(
              'The command runs in the selected Kubernetes namespace. The job volume is retained until results are collected.'
            )
          : dialogRequest.operation === 'download'
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
    <Dialog.Root
      open={active && Boolean(request)}
      onOpenChange={(open) => {
        if (!open) close(dialogRequest.id)
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
        <Dialog.Content
          aria-busy={responding}
          onInteractOutside={(event) => event.preventDefault()}
          className={dialogPanelClassName(
            'z-[60] flex max-h-[calc(100svh-2rem)] w-[min(480px,calc(100vw-2rem))] flex-col overscroll-contain p-0'
          )}
        >
          <div className={cn(dialogHeaderClassName, 'shrink-0 items-start justify-start')}>
            <ShieldAlert
              className="mt-0.5 size-5 shrink-0 text-status-warning-foreground dark:text-status-warning-dark-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <Dialog.Title className={dialogTitleClassName}>{title}</Dialog.Title>
              <Dialog.Description
                className={cn(dialogDescriptionClassName, 'text-xs [text-wrap:pretty]')}
              >
                {description}
              </Dialog.Description>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Close')}
              className={cn(dialogCloseButtonClassName, 'shrink-0')}
              onClick={() => close(dialogRequest.id)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>

          <ScrollArea
            key={dialogRequest.id}
            className="grid min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:h-auto [&>[data-slot=scroll-area-viewport]]:min-h-0"
          >
            <div className={dialogBodyClassName}>
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                <table
                  aria-label={title}
                  className="w-full table-fixed border-collapse text-xs text-foreground [overflow-wrap:anywhere]"
                >
                  <colgroup>
                    <col className="w-[30%]" />
                    <col />
                  </colgroup>
                  <tbody className="[&>tr]:align-top">
                    <ApprovalRow label={t('Host')}>
                      <span className="font-medium">{dialogRequest.providerName}</span>
                    </ApprovalRow>
                    <ApprovalRow label={t('Intent')}>{dialogRequest.intent}</ApprovalRow>
                    {hasCommand ? (
                      <ApprovalRow label={t('Command')}>
                        {showFull ? (
                          <pre
                            role="region"
                            aria-label={t('Command')}
                            tabIndex={0}
                            className="max-h-[min(8rem,25svh)] overflow-y-auto rounded border border-border bg-background p-2 whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            <code>{dialogRequest.commandFull}</code>
                          </pre>
                        ) : (
                          <code className="whitespace-pre-wrap font-mono">
                            {dialogRequest.commandPreview}
                          </code>
                        )}
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
                      </ApprovalRow>
                    ) : (
                      <ApprovalRow label={t('Remote path')} mono>
                        {dialogRequest.remotePath}
                      </ApprovalRow>
                    )}
                    {job?.inputsSummary && (
                      <ApprovalRow label={t('Inputs')}>{job.inputsSummary}</ApprovalRow>
                    )}
                    {job?.executionMode && (
                      <ApprovalRow label={t('Execution mode')}>
                        {backendName ??
                          (job.executionMode === 'slurm' ? t('Slurm') : t('Direct SSH'))}
                      </ApprovalRow>
                    )}
                    {job &&
                      files &&
                      [
                        ...(modal
                          ? [
                              [t('Environment'), modal.environmentName],
                              ['Modal App', modal.appName + ' (' + modal.appId + ')'],
                              [t('Container image'), modal.image],
                              ['CPU / GPU', modal.cpus + ' / ' + (modal.gpu ?? '—')],
                              [t('Memory'), modal.memoryMiB + ' MiB']
                            ]
                          : []),
                        ...(ray
                          ? [
                              [t('Dashboard'), ray.endpoint],
                              [t('Session'), ray.sessionName],
                              ['CPU / GPU', ray.cpus + ' / ' + ray.gpus],
                              [t('Local shared directory'), ray.sharedRoot]
                            ]
                          : []),
                        ...(hosted
                          ? [
                              [t('Billing account'), hosted.namespace],
                              [t('Container image'), hosted.image],
                              [t('Flavor'), hosted.flavor],
                              [
                                t('Compute rate'),
                                `USD ${hosted.rateMicroUsdPerMinute / 1_000_000}/min`
                              ],
                              [
                                t('Estimated compute cost'),
                                `USD ${((Math.ceil(job.timeoutSeconds / 60) * hosted.rateMicroUsdPerMinute) / 1_000_000).toFixed(6)}`
                              ],
                              [
                                t('Bucket'),
                                `hf://buckets/${hosted.bucket}/open-science/${hosted.runId}/`
                              ]
                            ]
                          : []),
                        ...(kubernetes
                          ? [
                              [t('Context'), kubernetes.context],
                              [t('Namespace'), kubernetes.namespace],
                              ['API', kubernetes.endpoint],
                              [t('Container image'), kubernetes.image],
                              [t('Transfer image'), kubernetes.transferImage],
                              ['PVC', kubernetes.sizeMiB + ' MiB']
                            ]
                          : []),
                        [
                          t('Inputs'),
                          files.inputFiles
                            .map(
                              (file) =>
                                `${file.source} → ${file.destination} (${file.sizeBytes} B)\nSHA-256 ${file.sha256}`
                            )
                            .join('\n') || '—'
                        ],
                        [t('Outputs'), files.outputManifest ?? '[]'],
                        ...(files.harvestConfig ? [[t('Harvest'), files.harvestConfig]] : [])
                      ].map(([label, value]) => (
                        <ApprovalRow key={label} label={label} mono>
                          {value}
                        </ApprovalRow>
                      ))}
                    {job?.environment && (
                      <ApprovalRow label={t('Environment')} mono>
                        {job.environment}
                      </ApprovalRow>
                    )}
                    {job?.resources && (
                      <ApprovalRow label={t('Resources')} mono>
                        {job.resources}
                      </ApprovalRow>
                    )}
                    {job && (
                      <>
                        <ApprovalRow label={t('Timeout')}>
                          {t('{{count}} seconds', {
                            count: job.timeoutSeconds,
                            defaultValue_one: '{{count}} second'
                          })}
                        </ApprovalRow>
                        <ApprovalRow
                          label={modal || ray ? t('Output directory') : t('Remote workdir')}
                          mono
                        >
                          {job.remoteWorkdir}
                        </ApprovalRow>
                      </>
                    )}
                  </tbody>
                </table>
              </div>
              {dialogRequest.willPersistUnencrypted ? (
                <ErrorNotice
                  inline
                  role="alert"
                  tone="amber"
                  className="mt-3"
                  description={t(
                    "Secure storage is unavailable. This job's command, paths, and output may be stored without encryption."
                  )}
                />
              ) : null}
              {dialogRequest.responseFailed || responseErrorRequestId === dialogRequest.id ? (
                <ErrorNotice
                  inline
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
            <PermissionScopeButton
              key={dialogRequest.id}
              available={files ? ['once'] : ['once', 'session', 'project', 'global']}
              disabled={responding}
              onAllow={(scope) => {
                if (scope === 'project' || scope === 'global')
                  setPendingBroadScope({ requestId: dialogRequest.id, scope })
                else submitResponse(scope)
              }}
            />
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
