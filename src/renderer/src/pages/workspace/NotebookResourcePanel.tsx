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
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { ComputePanel } from './ComputePanel'
import { ComputeOpenSessionButton } from './ComputeResourceActions'
import {
  formatComputeUptime,
  releaseBlockedLabel,
  resourceReleaseStatus
} from './compute-monitor-presentation'
import { formatByteSize } from '@/lib/utils'

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

const releaseFailureDetails = (
  release: NotebookResourceRelease,
  t: ReturnType<typeof useTranslation>['t']
): string =>
  release.resources
    .filter((resource) => resource.status === 'incomplete')
    .map((resource) =>
      [
        resourceLabel(resource, t),
        resource.environment,
        resource.laneKey && t('Lane: {{lane}}', { lane: resource.laneKey }),
        resource.processesTerminated === false &&
          t('Processes terminated: {{result}}', { result: t('No') }),
        resource.networkClosed === false && t('Network closed: {{result}}', { result: t('No') }),
        resource.temporaryResourcesRemoved === false &&
          t('Temporary resources removed: {{result}}', { result: t('No') }),
        resource.projection === 'failed' && t('Saved Notebook state could not be updated.'),
        resource.error
      ]
        .filter(Boolean)
        .join(' · ')
    )
    .join('\n')

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
  goToSession?: (sessionId: string) => void
  desktop?: {
    hidden: boolean
    confirmation?: NotebookSessionResources
    closeConfirmation: () => void
    sessionTitles: ReadonlyMap<string, string>
    restoreConfirmationFocus: (event: Event) => void
  }
}

const NotebookResourcePanel = ({
  isActive,
  projectId,
  snapshot,
  observedAt,
  readError,
  backgroundRuns,
  refresh,
  goToSession,
  desktop
}: NotebookResourcePanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const sessions = useSessionStore((state) => state.sessions)
  const [localConfirmation, setConfirmation] = useState<NotebookSessionResources>()
  const [comment, setComment] = useState('')
  const confirmation = desktop ? desktop.confirmation : localConfirmation
  const closeConfirmation = (): void => {
    setComment('')
    if (desktop) desktop.closeConfirmation()
    else setConfirmation(undefined)
  }
  const [submission, setSubmission] = useState<{ retryOperationId?: string }>()
  const submitting = submission !== undefined
  const [operationResult, setOperationResult] = useState<{
    snapshot: NotebookProjectResources
    release: NotebookResourceRelease
  }>()
  const [progressId, setProgressId] = useState<string>()
  const [error, setError] = useState<{ kind: 'release'; message: string }>()
  const [desktopReleaseState, setDesktopReleaseState] = useState<{
    observed?: NotebookProjectResources['releases']
    visible: ReadonlyMap<string, NotebookResourceRelease>
  }>(() => ({ visible: new Map() }))
  const desktopReleases = desktopReleaseState.visible
  const [dismissedReleases, setDismissedReleases] = useState<ReadonlySet<string>>(() => new Set())

  // The release outlives the resource rows. Keep visible operations mounted for live announcements,
  // and skip completed history that this panel did not observe.
  if (desktop && desktopReleaseState.observed !== snapshot.releases) {
    let next: Map<string, NotebookResourceRelease> | undefined
    for (const release of snapshot.releases) {
      const { operationId, phase, status } = release
      const current = desktopReleases.get(operationId)
      if (
        !phase ||
        dismissedReleases.has(operationId) ||
        current === release ||
        current?.status === 'released' ||
        (!current && status === 'released')
      )
        continue
      next ??= new Map(desktopReleases)
      next.set(operationId, release)
    }
    setDesktopReleaseState({ observed: snapshot.releases, visible: next ?? desktopReleases })
  }
  const dismissRelease = (operationId: string): void => {
    setDismissedReleases((previous) => new Set(previous).add(operationId))
    setDesktopReleaseState((previous) => {
      const visible = new Map(previous.visible)
      visible.delete(operationId)
      return { ...previous, visible }
    })
  }
  const releases = new Map(
    desktop ? [] : snapshot.releases.map((release) => [release.operationId, release])
  )
  // A command response fills the gap until the next authoritative owner snapshot arrives.
  if (
    operationResult &&
    (operationResult.snapshot === snapshot || !releases.has(operationResult.release.operationId))
  ) {
    releases.set(operationResult.release.operationId, operationResult.release)
  }
  const progress = progressId ? releases.get(progressId) : undefined
  const progressBlockedReason = snapshot.groups.find(
    (group) => group.sessionId === progress?.sessionId
  )?.releaseBlockedReason
  const environmentRecoveryWarning = t(
    'The installer stopped. Recover the affected environment before using it again.'
  )
  const sessionTitle = (sessionId: string): string =>
    desktop?.sessionTitles.get(sessionId) ??
    sessions.find((session) => session.id === sessionId && session.projectId === projectId)
      ?.title ??
    t('Deleted Session')
  const confirm = async (): Promise<void> => {
    if (!confirmation || submitting) return
    setSubmission({})
    setError(undefined)
    try {
      const result = await window.api.notebook.releaseSessionResources({
        projectId,
        sessionId: confirmation.sessionId,
        revision: confirmation.revision,
        ...(desktop ? { stopAll: { comment: comment.trim() } } : {})
      })
      if (desktop) {
        setDesktopReleaseState((previous) => {
          if (previous.visible.has(result.operationId)) return previous
          // A fast release may have finished in the poll before its command receipt arrived.
          const completed = previous.observed?.find(
            (release) => release.operationId === result.operationId && release.status === 'released'
          )
          return {
            ...previous,
            visible: new Map(previous.visible).set(result.operationId, completed ?? result)
          }
        })
      } else {
        setOperationResult({ snapshot, release: result })
        setProgressId(result.operationId)
      }
    } catch (error) {
      setError({ kind: 'release', message: error instanceof Error ? error.message : String(error) })
    } finally {
      closeConfirmation()
      refresh()
      setSubmission(undefined)
    }
  }
  const retry = async (release: NotebookResourceRelease): Promise<void> => {
    if (submitting) return
    setSubmission({ retryOperationId: release.operationId })
    setError(undefined)
    try {
      const result = await window.api.notebook.retryResourceRelease({
        projectId,
        sessionId: release.sessionId,
        operationId: release.operationId
      })
      if (desktop) {
        setDesktopReleaseState((previous) => {
          const current = previous.visible.get(release.operationId)
          // A newer poll may have already observed the retry's progress or final outcome.
          if (current?.status !== 'partial' || current.finishedAt !== release.finishedAt)
            return previous
          return { ...previous, visible: new Map(previous.visible).set(result.operationId, result) }
        })
      } else {
        setOperationResult({ snapshot, release: result })
      }
    } catch (error) {
      setError({ kind: 'release', message: error instanceof Error ? error.message : String(error) })
    } finally {
      refresh()
      setSubmission(undefined)
    }
  }

  return (
    <div hidden={desktop?.hidden} className={desktop ? 'space-y-1' : 'space-y-3'}>
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
          title={t(
            'Notebook release could not be confirmed. Review the refreshed resources before trying again.'
          )}
          errorCode={error.message}
          diagnosticsLabel={t('Details')}
          dismissButton={{ label: t('Dismiss'), onClick: () => setError(undefined) }}
        />
      ) : null}
      {!desktop && (
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
                  onClick={() => goToSession?.(group.sessionId)}
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
      )}

      {desktop &&
        [...desktopReleases.values()].map((release) => {
          const failed = release.status === 'partial'
          const running = release.status === 'releasing'
          const needsEnvironmentRecovery = release.resources.some(
            ({ environmentRecoveryRequired }) => environmentRecoveryRequired
          )
          const openReleasedSession = release.status === 'released' && goToSession
          const name = sessionTitle(release.sessionId)
          const blockedReason = snapshot.groups.find(
            (group) => group.sessionId === release.sessionId
          )?.releaseBlockedReason
          const retrying = submission?.retryOperationId === release.operationId
          return (
            <ErrorNotice
              key={release.operationId}
              inline
              className={openReleasedSession ? 'px-2 py-2' : 'py-2 ps-1 pe-2'}
              role={failed ? 'alert' : 'status'}
              level={failed || needsEnvironmentRecovery ? 'warning' : running ? 'info' : 'success'}
              content={
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-0.5">
                    <p
                      className="min-w-0 truncate text-sm leading-5 font-semibold text-foreground"
                      title={name}
                    >
                      {name}
                    </p>
                    {openReleasedSession && (
                      <ComputeOpenSessionButton
                        className="-my-0.5 shrink-0"
                        onClick={() => openReleasedSession(release.sessionId)}
                      />
                    )}
                  </div>
                  <p className="mt-0.5 text-xs leading-4">{resourceReleaseStatus(release, t)}</p>
                  {needsEnvironmentRecovery && (
                    <p className="mt-0.5 text-xs leading-4">{environmentRecoveryWarning}</p>
                  )}
                </div>
              }
              errorCode={failed ? releaseFailureDetails(release, t) : undefined}
              diagnosticsLabel={failed ? t('Details') : undefined}
              primaryButton={
                failed
                  ? {
                      label: t('Retry cleanup'),
                      disabled: submitting || Boolean(blockedReason),
                      loading: retrying,
                      description: blockedReason
                        ? releaseBlockedLabel(blockedReason, t)
                        : undefined,
                      onClick: () => void retry(release)
                    }
                  : undefined
              }
              dismissButton={
                running || retrying
                  ? undefined
                  : { label: t('Dismiss'), onClick: () => dismissRelease(release.operationId) }
              }
            />
          )
        })}
      {[...releases.values()].map((release) => (
        <div
          key={release.operationId}
          className="rounded-lg border border-border-200 bg-bg-000 p-3 text-xs"
        >
          <p className="font-medium" role="status">
            {sessionTitle(release.sessionId)} · {resourceReleaseStatus(release, t)}
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
        open={isActive && !desktop?.hidden && Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open && !submitting) closeConfirmation()
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            onCloseAutoFocus={desktop?.restoreConfirmationFocus}
            className={dialogPanelClassName('w-[min(512px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <AlertDialog.Title className={dialogTitleClassName}>
                {desktop
                  ? t('Stop all Notebook resources?')
                  : t('Stop and release Notebook for "{{title}}"?', {
                      title: confirmation ? sessionTitle(confirmation.sessionId) : ''
                    })}
              </AlertDialog.Title>
            </div>
            <div className={dialogBodyClassName}>
              <AlertDialog.Description asChild>
                <div className={`${dialogDescriptionClassName} space-y-2`}>
                  {desktop ? (
                    <>
                      <p>
                        {t(
                          'Stopping clears Notebook variables, closes open connections, and may discard unsaved work.'
                        )}
                      </p>
                      <p>{t('Tasks that keep running may be forced to stop.')}</p>
                    </>
                  ) : (
                    <>
                      <p>{t('This stops the listed local Notebook tasks and resources.')}</p>
                      <p>{t('Variables and connections will be lost.')}</p>
                      <p>
                        {t('History, saved outputs, files, and installed environments are kept.')}
                      </p>
                      <p>{t('Earlier file writes are not undone.')}</p>
                      <p>{t('Independent remote Compute Jobs are not stopped.')}</p>
                    </>
                  )}
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
              {desktop && (
                <label className="mt-3 block text-xs">
                  {t('Reason for stopping (optional)')}
                  <textarea
                    className="mt-1 min-h-20 w-full rounded-md border border-border bg-card p-3 text-sm"
                    value={comment}
                    maxLength={2000}
                    disabled={submitting}
                    onChange={(event) => setComment(event.target.value)}
                  />
                  <span className="text-muted-foreground">
                    {t(
                      'A short note helps the agent understand why you stopped and decide what to try next.'
                    )}
                  </span>
                </label>
              )}
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
                  {desktop ? t('Stop') : t('Stop and release')}
                </span>
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {!desktop && (
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
                  {progress ? resourceReleaseStatus(progress, t) : t('Notebook cleanup')}
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
                      {resource.environmentRecoveryRequired ? (
                        <p className="text-status-warning-foreground dark:text-status-warning-dark-foreground">
                          {environmentRecoveryWarning}
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
      )}
    </div>
  )
}

export { NotebookResourcePanel, ResourceDetails }
