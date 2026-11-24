import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight } from 'lucide-react'

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
import { formatDisplayNumber } from '@/lib/locale-format'
import { isDesktopRenderer } from '@/lib/interface-scale'
import { formatByteSize } from '@/lib/utils'
import { useWorkspaceAgentRuntime } from '@/lib/acp/useWorkspaceAgentRuntime'

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
  if (!session) return <></>
  return (
    <div className="space-y-2 rounded-lg border border-border-200 bg-bg-000 p-3 text-xs">
      <p className="font-medium">{session.title}</p>
      <p className="text-text-100">
        {t('Project: {{name}}', { name: projectName ?? decision.projectId })}
      </p>
      <p className="text-text-100">
        {canContinue
          ? t(
              'Notebook work remains stopped until you explicitly continue. This sends a new guidance message and checks memory again.'
            )
          : t(
              'Open the same Session and branch in the Open-Science desktop app, then choose Continue Notebook work in Compute.'
            )}
      </p>
      {canContinue ? (
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
  const bytes = (value: number | undefined): string => formatByteSize(value) ?? t('Unknown')
  return (
    <li className="min-w-0 space-y-1 rounded-md bg-bg-10 px-3 py-2 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {resourceLabel(resource, t)}
          {resource.environment ? ` · ${resource.environment}` : ''}
        </span>
        <span className="rounded bg-bg-100 px-2 py-0.5 text-[10px]">{phase}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-100">
        {resource.laneKey ? <span>{t('Lane: {{lane}}', { lane: resource.laneKey })}</span> : null}
        <span>
          {t('Started: {{time}}', {
            time:
              resource.startedAt === undefined ? t('Unknown') : formatDateTime(resource.startedAt)
          })}
        </span>
        <span>
          {t('Runtime: {{duration}}', {
            duration:
              resource.startedAt === undefined
                ? t('Unknown')
                : formatDisplayNumber(
                    Math.max(0, Math.floor((observedAt - resource.startedAt) / 60_000)),
                    {
                      style: 'unit',
                      unit: 'minute',
                      unitDisplay: 'short'
                    }
                  )
          })}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-100">
        {memory.metric === 'rss' ? (
          <span>{t('RSS: {{value}}', { value: bytes(memory.rssBytes) })}</span>
        ) : (
          <>
            <span>{t('Private Bytes: {{value}}', { value: bytes(memory.privateBytes) })}</span>
            <span>{t('Working Set: {{value}}', { value: bytes(memory.workingSetBytes) })}</span>
          </>
        )}
        <span>
          {memory.coverage === 'complete'
            ? t('Complete data')
            : memory.coverage === 'partial'
              ? t('Partial data')
              : t('Unknown')}
        </span>
        {memory.sampledAt !== undefined && (
          <span>{t('Sampled: {{time}}', { time: formatDateTime(memory.sampledAt) })}</span>
        )}
      </div>
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
      ...snapshot.pendingDecisions,
      ...[...releases.values()].flatMap((release) => release.continuations)
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
    <section aria-labelledby="notebook-resources-title" className="space-y-3">
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
      <div className="overflow-hidden rounded-lg border border-border-200 bg-bg-000">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-200 px-3.5 py-3">
          <h2 id="notebook-resources-title" className="text-sm font-semibold">
            {t('Notebook resources')}
            {observedAt !== undefined && (
              <> · {t('Sessions: {{sessions}}', { sessions: snapshot.groups.length })}</>
            )}
          </h2>
          <Button type="button" size="sm" variant="ghost" onClick={refresh}>
            {t('Refresh')}
          </Button>
        </div>
        <p className="px-3.5 py-2 text-[11px] text-text-100">
          {t(
            'Only Notebooks in the current project are listed. Switch projects to manage other Notebooks.'
          )}
        </p>
        {snapshot.groups.length === 0 && readError === undefined && (
          <p role="status" className="px-3 py-6 text-center text-xs text-text-100">
            {observedAt === undefined ? t('Loading…') : t('No running Notebooks')}
          </p>
        )}
        {snapshot.groups.map((group) => (
          <section
            key={group.sessionId}
            aria-label={sessionTitle(group.sessionId)}
            className="space-y-3 border-t border-border-200 px-3.5 py-3 text-xs first:border-t-0"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="min-w-0 font-semibold">{sessionTitle(group.sessionId)}</h3>
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
            </div>
            <ul className="space-y-2">
              {group.resources.map((resource) => (
                <ResourceDetails
                  key={resource.id}
                  resource={resource}
                  observedAt={observedAt ?? 0}
                />
              ))}
            </ul>
            <p className="text-text-100">
              {t('Interpreters: {{interpreters}}', {
                interpreters: group.resources.filter(
                  (resource) => resource.group === 'kernel' || resource.group === 'shell'
                ).length
              })}
              {' · '}
              {t('Resources: {{resources}}', { resources: group.resources.length })}
            </p>
            {backgroundRuns
              .filter((run) => run.sessionId === group.sessionId)
              .map((run) => (
                <p key={run.runId} className="text-text-100">
                  {t('Background')} · {run.title}
                </p>
              ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-auto max-w-full whitespace-normal text-left"
              disabled={Boolean(group.releaseBlockedReason)}
              aria-describedby={
                group.releaseBlockedReason ? `release-blocked-${group.sessionId}` : undefined
              }
              onClick={() => setConfirmation(group)}
            >
              {t('Stop and release Notebook')}
            </Button>
            {group.releaseBlockedReason ? (
              <p id={`release-blocked-${group.sessionId}`} className="text-text-100">
                {releaseBlockedLabel(group.releaseBlockedReason, t)}
              </p>
            ) : null}
          </section>
        ))}
        <p className="border-t border-border-200 px-3.5 py-2 text-[11px] text-text-100">
          {t('RSS may include shared pages and does not predict how much memory will be released.')}
        </p>
      </div>

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
    </section>
  )
}

export { NotebookResourcePanel }
