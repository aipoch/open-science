import { isDesktopRenderer } from '@/lib/interface-scale'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  Clock3,
  MemoryStick,
  RefreshCw,
  Square
} from 'lucide-react'

import type {
  NotebookProjectResources,
  NotebookPendingDecision,
  NotebookResource,
  NotebookResourceRelease,
  NotebookSessionResources
} from '../../../../shared/notebook-resources'
import type { NotebookProjectBackgroundRunActivity } from '../../../../shared/notebook'
import * as AlertDialog from '@/components/ui/alert-dialog'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { useSessionStore } from '@/stores/session-store'
import { useProjectStore } from '@/stores/project-store'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { ComputePanel } from './ComputePanel'
import { formatComputeUptime } from './compute-monitor-presentation'
import { formatByteSize } from '@/lib/utils'
import { useWorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'
import { useNotebookMemoryContinuation } from './useNotebookMemoryContinuation'

const NotebookContinuation = ({
  decision,
  refresh,
  onError
}: {
  decision: NotebookPendingDecision
  refresh: () => void
  onError: (message: string | undefined) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const runtime = useWorkspaceAgentRuntime()
  const session = useSessionStore((state) =>
    state.sessions.find(
      (session) => session.id === decision.sessionId && session.projectId === decision.projectId
    )
  )
  const projectName = useProjectStore(
    (state) => state.projects.find((project) => project.id === decision.projectId)?.name
  )
  const [sending, setSending] = useState(false)
  const canContinue = isDesktopRenderer()
  const memoryDecision = canContinue && decision.kind === 'memory'
  const recheck = useNotebookMemoryContinuation(
    memoryDecision ? decision : undefined,
    'compute',
    runtime.sendMessage
  )
  const continueWork = async (): Promise<void> => {
    if (!session || sending) return
    setSending(true)
    onError(undefined)
    try {
      const result = await runtime.sendMessage({
        projectId: decision.projectId,
        sessionId: decision.sessionId,
        cwd: session.cwd,
        requireExistingSession: true,
        preserveSelection: true,
        notebookContinuation: {
          refusalId: decision.refusalId,
          messageBranchId: decision.messageBranchId
        },
        text: t(
          'Recheck memory and reconsider the blocked Notebook work. Keep completed results and ask before repeating completed steps.'
        )
      })
      if (!result) {
        throw new Error(
          t('Notebook continuation could not be started. The previous request remains stopped.')
        )
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      refresh()
      setSending(false)
    }
  }
  if (!session || recheck.handedOff) return <></>
  return (
    <div className="space-y-2 rounded-lg border border-border-200 bg-bg-000 p-3 text-xs">
      <p className="font-medium">{session.title}</p>
      <p className="text-text-100">
        {t('Project: {{name}}', { name: projectName ?? decision.projectId })}
      </p>
      <p className="text-text-100">
        {memoryDecision
          ? t('Notebook execution needs your decision.')
          : canContinue
            ? t(
                'Notebook work remains stopped until you explicitly continue. This sends a new guidance message and checks memory again.'
              )
            : t(
                'Open the same Session and branch in the Open-Science desktop app, then choose Continue Notebook work in Compute.'
              )}
      </p>
      {recheck.error && <ErrorNotice inline role="alert" description={recheck.error} />}
      {memoryDecision ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={recheck.busy}
          aria-busy={recheck.busy || undefined}
          onClick={() => void recheck.checkAndContinue().then(refresh)}
        >
          <span key={String(recheck.busy)} className="button-feedback">
            {recheck.busy ? t('Checking…') : t('Check and continue')}
          </span>
        </Button>
      ) : canContinue ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={sending}
          aria-busy={sending}
          onClick={() => void continueWork()}
        >
          <span key={String(sending)} className="button-feedback">
            {t('Continue Notebook work')}
          </span>
        </Button>
      ) : null}
    </div>
  )
}

const resourceLabel = (
  resource: Pick<NotebookResource, 'group' | 'kind'>,
  t: ReturnType<typeof useTranslation>['t']
): string => {
  if (resource.group === 'operation') return t('Pending operation')
  if (resource.group === 'reproduction') return t('Reproduction attempt')
  if (resource.group === 'installer') return t('Environment installer')
  if (resource.group === 'batch') return t('Reproduction batch')
  if (resource.group === 'shell') return t('Shell')
  if (resource.kind === 'repl') return t('JavaScript REPL')
  if (resource.kind === 'r') return 'R'
  return resource.kind === 'python' ? 'Python' : t('Notebook kernel')
}

const releaseBlockedLabel = (reason: string, t: ReturnType<typeof useTranslation>['t']): string => {
  if (reason === 'release-in-progress' || reason === 'cleanup-in-progress')
    return t('Notebook cleanup is already in progress.')
  if (reason === 'session-exporting')
    return t('This Session is being exported. Wait, then review the resources again.')
  if (reason === 'runtime-binding-changing')
    return t('The Notebook environment is changing. Wait, then review the resources again.')
  if (reason === 'application-stopping') return t('Open-Science is shutting down.')
  if (reason === 'application-updating')
    return t('An update is in progress. Wait, then review the resources again.')
  if (reason === 'package-handoff')
    return t('Session files are being transferred. Wait, then review the resources again.')
  if (reason === 'data-migration')
    return t('Data is being moved. Wait, then review the resources again.')
  if (reason === 'session-unavailable')
    return t('This Session is unavailable or you do not have permission to manage it.')
  return t('Notebook release is currently unavailable. Refresh and review the resources again.')
}

const ResourceDetails = ({
  resource,
  observedAt
}: {
  resource: NotebookResource
  observedAt: number
}): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDateTime = useDateTimeFormat()
  const { memory } = resource
  const phase = {
    starting: t('Starting'),
    running: t('Running'),
    idle: t('Idle'),
    ready: t('Ready'),
    'cleanup-pending': t('Cleanup pending')
  }[resource.phase]
  const residentMemory = formatByteSize(
    memory.metric === 'rss' ? memory.rssBytes : memory.workingSetBytes
  )
  const duration =
    resource.startedAt === undefined
      ? undefined
      : formatComputeUptime((observedAt - resource.startedAt) / 1000, t)
  const partial = memory.coverage === 'partial'
  const phaseColor = {
    idle: 'bg-muted-foreground/60',
    ready: 'bg-status-success-foreground dark:bg-status-success-dark-foreground',
    running: 'bg-status-info-foreground dark:bg-status-info-dark-foreground',
    starting: 'bg-status-info-foreground dark:bg-status-info-dark-foreground',
    'cleanup-pending': 'bg-status-warning-foreground dark:bg-status-warning-dark-foreground'
  }[resource.phase]
  return (
    <li className="min-w-0">
      <details className="group/resource">
        <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-1 rounded-md px-2 py-2 outline-none hover:bg-muted/60 focus-visible:keyboard-focus [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden="true"
            className="size-3 self-center text-muted-foreground transition-transform motion-reduce:transition-none group-open/resource:rotate-90"
          />
          <span className="font-medium [overflow-wrap:anywhere]">
            {resourceLabel(resource, t)}
            {resource.environment ? ` · ${resource.environment}` : ''}
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${phaseColor}`} />
            {phase}
          </span>
          {(duration || residentMemory) && (
            <span className="col-span-2 col-start-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
              {residentMemory && (
                <span className="inline-flex items-center gap-1" title={t('Memory usage')}>
                  <MemoryStick aria-hidden="true" className="size-3.5" />
                  <span className="sr-only">{t('Memory usage')} </span>
                  {residentMemory}
                  {partial && <> · {t('Partial data')}</>}
                </span>
              )}
              {duration && (
                <span className="inline-flex items-center gap-1" title={t('Elapsed time')}>
                  <Clock3 aria-hidden="true" className="size-3" />
                  <span className="sr-only">{t('Elapsed time')} </span>
                  {duration}
                </span>
              )}
            </span>
          )}
        </summary>
        <div className="mx-2 mb-2 ml-3.5 space-y-1 border-l border-border pl-4 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {resource.laneKey && <p>{t('Lane: {{lane}}', { lane: resource.laneKey })}</p>}
          {resource.startedAt !== undefined && (
            <p>{t('Started: {{time}}', { time: formatDateTime(resource.startedAt) })}</p>
          )}
          {memory.metric === 'rss' ? (
            <p>{t('RSS: {{value}}', { value: residentMemory ?? t('Unknown') })}</p>
          ) : (
            <>
              <p>{t('Working Set: {{value}}', { value: residentMemory ?? t('Unknown') })}</p>
              <p>
                {t('Private Bytes: {{value}}', {
                  value: formatByteSize(memory.privateBytes) ?? t('Unknown')
                })}
              </p>
            </>
          )}
          <p>
            {memory.coverage === 'complete'
              ? t('Complete data')
              : partial
                ? t('Partial data')
                : t('Unknown')}
          </p>
          {memory.sampledAt !== undefined && (
            <p>{t('Sampled: {{time}}', { time: formatDateTime(memory.sampledAt) })}</p>
          )}
          {memory.metric === 'rss' && residentMemory && (
            <p>
              {t(
                'RSS may include shared pages and does not predict how much memory will be released.'
              )}
            </p>
          )}
        </div>
      </details>
    </li>
  )
}

type NotebookResourcePanelProps = {
  isActive: boolean
  projectId: string
  snapshot: NotebookProjectResources
  observedAt?: number
  readError?: string
  backgroundRuns: readonly NotebookProjectBackgroundRunActivity[]
  refresh: () => void
  goToSession: (sessionId: string) => void
}

const NotebookResourcePanel = ({
  isActive,
  projectId,
  snapshot,
  observedAt,
  readError,
  backgroundRuns,
  refresh,
  goToSession
}: NotebookResourcePanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const sessions = useSessionStore((state) => state.sessions)
  const [confirmation, setConfirmation] = useState<NotebookSessionResources>()
  const [submitting, setSubmitting] = useState(false)
  const [operationResult, setOperationResult] = useState<{
    snapshot: NotebookProjectResources
    release: NotebookResourceRelease
  }>()
  const [progressId, setProgressId] = useState<string>()
  const [error, setError] = useState<{ kind: 'release' | 'continuation'; message: string }>()
  const releases = new Map(snapshot.releases.map((release) => [release.operationId, release]))
  // A command response fills the gap until the next authoritative owner snapshot arrives.
  if (operationResult?.snapshot === snapshot) {
    releases.set(operationResult.release.operationId, operationResult.release)
  }
  const decisions = new Map(
    [
      ...[...releases.values()].flatMap((release) => release.continuations),
      ...snapshot.pendingDecisions
    ].map((decision) => [
      `${decision.projectId}:${decision.sessionId}:${decision.refusalId}`,
      decision
    ])
  )
  const progress = progressId ? releases.get(progressId) : undefined
  const progressBlockedReason = snapshot.groups.find(
    (group) => group.sessionId === progress?.sessionId
  )?.releaseBlockedReason
  const sessionTitle = (sessionId: string): string =>
    sessions.find((session) => session.id === sessionId && session.projectId === projectId)
      ?.title ?? t('Deleted Session')
  const confirm = async (): Promise<void> => {
    if (!confirmation || submitting) return
    setSubmitting(true)
    setError(undefined)
    try {
      const result = await window.api.notebook.releaseSessionResources({
        projectId,
        sessionId: confirmation.sessionId,
        revision: confirmation.revision
      })
      setOperationResult({ snapshot, release: result })
      setProgressId(result.operationId)
    } catch (error) {
      setError({ kind: 'release', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setConfirmation(undefined)
      refresh()
      setSubmitting(false)
    }
  }
  const retry = async (release: NotebookResourceRelease): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    setError(undefined)
    try {
      setOperationResult({
        snapshot,
        release: await window.api.notebook.retryResourceRelease({
          projectId,
          sessionId: release.sessionId,
          operationId: release.operationId
        })
      })
    } catch (error) {
      setError({ kind: 'release', message: error instanceof Error ? error.message : String(error) })
    } finally {
      refresh()
      setSubmitting(false)
    }
  }
  const releaseStatus = (release: NotebookResourceRelease): string =>
    release.status === 'releasing'
      ? t('Releasing Notebook resources')
      : release.status === 'partial'
        ? t('Cleanup incomplete')
        : t('Notebook resources released')

  return (
    <div className="space-y-3">
      {readError !== undefined && (
        <ErrorNotice
          inline
          role="status"
          title={t('Could not refresh {{source}}', { source: t('Notebook resources') })}
          description={
            observedAt !== undefined
              ? t('The last successful sample is shown. Try refreshing again.')
              : undefined
          }
          errorCode={readError}
          diagnosticsLabel={t('Details')}
        />
      )}
      {error !== undefined ? (
        <ErrorNotice
          role="alert"
          title={
            error.kind === 'continuation'
              ? t(
                  'Notebook continuation could not be started. The previous request remains stopped.'
                )
              : t(
                  'Notebook release could not be confirmed. Review the refreshed resources before trying again.'
                )
          }
          errorCode={error.message}
          diagnosticsLabel={t('Details')}
          dismissButton={{ label: t('Dismiss'), onClick: () => setError(undefined) }}
        />
      ) : null}
      <ComputePanel
        title={t('Notebook resources')}
        icon={BookOpen}
        description={
          <>
            {t('Current project')}
            {observedAt !== undefined && (
              <> · {t('Sessions: {{sessions}}', { sessions: snapshot.groups.length })}</>
            )}
          </>
        }
        action={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground"
            aria-label={t('Refresh Notebook resources')}
            title={t('Refresh Notebook resources')}
            onClick={refresh}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        }
      >
        {snapshot.groups.length === 0 && readError === undefined && (
          <p role="status" className="px-3 py-6 text-center text-xs text-text-100">
            {observedAt === undefined ? t('Loading…') : t('No running Notebooks')}
          </p>
        )}
        {snapshot.groups.map((group) => (
          <section
            key={group.sessionId}
            aria-label={sessionTitle(group.sessionId)}
            className="space-y-2 border-b border-border px-4 py-3 text-xs last:border-b-0"
          >
            <div className="flex items-center gap-1">
              <h3
                className="min-w-0 truncate text-sm font-medium"
                title={sessionTitle(group.sessionId)}
              >
                {sessionTitle(group.sessionId)}
              </h3>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={
                  !sessions.some(
                    (session) => session.id === group.sessionId && session.projectId === projectId
                  )
                }
                aria-label={t('Go to Session')}
                title={t('Go to Session')}
                onClick={() => goToSession(group.sessionId)}
              >
                <ArrowUpRight aria-hidden="true" />
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                className="ml-auto"
                title={t('Stop and release Notebook')}
                aria-label={t('Stop and release Notebook')}
                disabled={Boolean(group.releaseBlockedReason)}
                aria-describedby={
                  group.releaseBlockedReason ? `release-blocked-${group.sessionId}` : undefined
                }
                onClick={() => setConfirmation(group)}
              >
                <Square aria-hidden="true" />
                {t('Stop')}
              </Button>
            </div>
            <ul className="divide-y divide-border/60 rounded-md bg-muted/40">
              {group.resources.map((resource) => (
                <ResourceDetails
                  key={resource.id}
                  resource={resource}
                  observedAt={observedAt ?? 0}
                />
              ))}
            </ul>
            {backgroundRuns
              .filter((run) => run.sessionId === group.sessionId)
              .map((run) => (
                <p key={run.runId} className="text-text-100">
                  {t('Background')} · {run.title}
                </p>
              ))}
            {group.releaseBlockedReason ? (
              <p id={`release-blocked-${group.sessionId}`} className="text-text-100">
                {releaseBlockedLabel(group.releaseBlockedReason, t)}
              </p>
            ) : null}
          </section>
        ))}
      </ComputePanel>

      {decisions.size > 0 ? (
        <section aria-labelledby="notebook-decisions-title" className="space-y-2">
          <h2 id="notebook-decisions-title" className="text-sm font-semibold">
            {t('Waiting for your decision')}
          </h2>
          {[...decisions].map(([key, decision]) => (
            <NotebookContinuation
              key={key}
              decision={decision}
              refresh={refresh}
              onError={(message) =>
                setError(message === undefined ? undefined : { kind: 'continuation', message })
              }
            />
          ))}
        </section>
      ) : null}

      {[...releases.values()].map((release) => (
        <div
          key={release.operationId}
          className="rounded-lg border border-border-200 bg-bg-000 p-3 text-xs"
        >
          <p className="font-medium">
            {sessionTitle(release.sessionId)} · {releaseStatus(release)}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setProgressId(release.operationId)}
          >
            {t('View cleanup progress')}
          </Button>
        </div>
      ))}

      <AlertDialog.Root
        open={isActive && Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open && !submitting) setConfirmation(undefined)
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[min(512px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <AlertDialog.Title className={dialogTitleClassName}>
                {t('Stop and release Notebook for "{{title}}"?', {
                  title: confirmation ? sessionTitle(confirmation.sessionId) : ''
                })}
              </AlertDialog.Title>
            </div>
            <div className={dialogBodyClassName}>
              <AlertDialog.Description asChild>
                <div className={`${dialogDescriptionClassName} space-y-2`}>
                  <p>{t('This stops the listed local Notebook tasks and resources.')}</p>
                  <p>{t('Variables and connections will be lost.')}</p>
                  <p>{t('History, saved outputs, files, and installed environments are kept.')}</p>
                  <p>{t('Earlier file writes are not undone.')}</p>
                  <p>{t('Independent remote Compute Jobs are not stopped.')}</p>
                </div>
              </AlertDialog.Description>
              <ul className="mt-3 space-y-2 text-xs">
                {confirmation?.resources.map((resource) => (
                  <ResourceDetails
                    key={resource.id}
                    resource={resource}
                    observedAt={observedAt ?? 0}
                  />
                ))}
              </ul>
            </div>
            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className={dialogCancelButtonClassName}
                  disabled={submitting}
                >
                  {t('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <Button
                type="button"
                variant="destructive"
                disabled={submitting}
                aria-busy={submitting}
                onClick={() => void confirm()}
              >
                <span key={String(submitting)} className="button-feedback">
                  {t('Stop and release')}
                </span>
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <Dialog.Root
        open={isActive && Boolean(progress)}
        onOpenChange={(open) => {
          if (!open) setProgressId(undefined)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content className={dialogPanelClassName('w-[min(512px,calc(100vw-2rem))] p-0')}>
            <div className={dialogHeaderClassName}>
              <Dialog.Title className={dialogTitleClassName}>
                {progress ? releaseStatus(progress) : t('Notebook cleanup')}
              </Dialog.Title>
            </div>
            <div className={`${dialogBodyClassName} space-y-3`}>
              <Dialog.Description className={dialogDescriptionClassName}>
                {t(
                  'Closing this progress view does not cancel cleanup. No Notebook execution starts automatically.'
                )}
              </Dialog.Description>
              <ul className="space-y-2 text-xs" aria-live="polite">
                {progress?.resources.map((resource) => (
                  <li key={resource.id} className="space-y-1 rounded-md bg-bg-10 p-3">
                    <p className="font-medium">
                      {resourceLabel(resource, t)}
                      {resource.environment ? ` · ${resource.environment}` : ''} ·{' '}
                      {resource.status === 'released'
                        ? t('Released')
                        : resource.status === 'pending'
                          ? t('Releasing')
                          : t('Cleanup incomplete')}
                    </p>
                    {resource.laneKey ? (
                      <p>{t('Lane: {{lane}}', { lane: resource.laneKey })}</p>
                    ) : null}
                    {resource.processesTerminated !== undefined ? (
                      <p>
                        {t('Processes terminated: {{result}}', {
                          result: resource.processesTerminated ? t('Yes') : t('No')
                        })}
                      </p>
                    ) : null}
                    {resource.networkClosed !== undefined ? (
                      <p>
                        {t('Network closed: {{result}}', {
                          result: resource.networkClosed ? t('Yes') : t('No')
                        })}
                      </p>
                    ) : null}
                    {resource.temporaryResourcesRemoved !== undefined ? (
                      <p>
                        {t('Temporary resources removed: {{result}}', {
                          result: resource.temporaryResourcesRemoved ? t('Yes') : t('No')
                        })}
                      </p>
                    ) : null}
                    {resource.projection === 'failed' ? (
                      <p className="text-status-failure-foreground dark:text-status-failure-dark-foreground">
                        {t('Saved Notebook state could not be updated.')}
                      </p>
                    ) : null}
                    {resource.error ? (
                      <pre className="whitespace-pre-wrap break-words text-text-100">
                        {resource.error}
                      </pre>
                    ) : null}
                  </li>
                ))}
              </ul>
              {progressBlockedReason ? (
                <p id="notebook-retry-blocked" className="text-xs text-text-100">
                  {releaseBlockedLabel(progressBlockedReason, t)}
                </p>
              ) : null}
            </div>
            <div className={dialogFooterClassName}>
              <Button type="button" variant="ghost" onClick={() => setProgressId(undefined)}>
                {t('Close progress')}
              </Button>
              {progress?.status === 'partial' ? (
                <Button
                  type="button"
                  disabled={submitting || Boolean(progressBlockedReason)}
                  aria-busy={submitting}
                  aria-describedby={progressBlockedReason ? 'notebook-retry-blocked' : undefined}
                  onClick={() => void retry(progress)}
                >
                  <span key={String(submitting)} className="button-feedback">
                    {t('Retry cleanup')}
                  </span>
                </Button>
              ) : null}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

export { NotebookResourcePanel }
