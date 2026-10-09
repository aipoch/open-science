import type { ReactNode } from 'react'
import { useLayoutEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type {
  RunObservationExecutionContext,
  RunObservationSnapshot
} from '../../../../../shared/run-observation'
import { useObservationPhaseLabel } from './replay-observation-labels'
import { isObservationTerminal, type ReplayObservationMode } from '@/lib/replay/live-source'

export type ReplayRuntimeSurface = {
  runId: string
  activationId?: string
  content: ReactNode
}

export type ReplayProjectActivation = {
  opening: boolean
  onOpen: () => void
}

/** Read-only presentation. All runtime page capabilities are supplied by the host adapter. */
export const ReplayLiveRecord = ({
  snapshot,
  latestSnapshot = snapshot,
  executionContext,
  mode,
  runtimeSurface,
  projectActivation,
  recordedSurface,
  historyTruncated,
  historicalOnly = false,
  onProjectActiveChange
}: {
  snapshot: RunObservationSnapshot
  latestSnapshot?: RunObservationSnapshot
  executionContext?: RunObservationExecutionContext
  mode: ReplayObservationMode
  runtimeSurface?: ReplayRuntimeSurface
  projectActivation?: ReplayProjectActivation
  recordedSurface?: ReactNode
  historyTruncated?: boolean
  historicalOnly?: boolean
  onProjectActiveChange?: (active: boolean) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const phaseLabel = useObservationPhaseLabel()
  const [tab, setTab] = useState<'record' | 'project'>(() =>
    runtimeSurface?.activationId ? 'project' : 'record'
  )
  const [activationId, setActivationId] = useState(runtimeSurface?.activationId)
  if (runtimeSurface?.activationId && runtimeSurface.activationId !== activationId) {
    setActivationId(runtimeSurface.activationId)
    setTab('project')
  }
  useLayoutEffect(() => {
    onProjectActiveChange?.(tab === 'project')
  }, [tab, onProjectActiveChange])
  const livePage =
    mode === 'follow' &&
    snapshot.phase === 'running' &&
    snapshot.run?.status === 'running' &&
    runtimeSurface?.runId === snapshot.run.runId
  const ended =
    isObservationTerminal(latestSnapshot) ||
    Boolean(latestSnapshot.run && !['queued', 'running'].includes(latestSnapshot.run.status))
  const endReason =
    executionContext?.purpose === 'offline-demo'
      ? executionContext.demoViewing?.endReason
      : undefined
  const endStatus = latestSnapshot.run?.status ?? latestSnapshot.phase
  const endLabel =
    endReason === 'time-limit'
      ? t('The viewing time limit was reached.')
      : !endReason && endStatus === 'timeout'
        ? t('The run timed out.')
        : endReason === 'stopped' || (!endReason && endStatus === 'cancelled')
          ? t('The run was stopped.')
          : endReason === 'failed' || (!endReason && endStatus === 'failed')
            ? t('The run failed.')
            : endReason === 'interrupted' || (!endReason && endStatus === 'interrupted')
              ? t('The run was interrupted.')
              : t('The run has ended.')
  const recordEvidence = (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words text-xs">
        <dt>{t('Status')}</dt>
        <dd data-testid="observation-phase">{phaseLabel(snapshot.phase)}</dd>
        <dt>{t('Observed at')}</dt>
        <dd>{new Date(snapshot.observedAt).toISOString()}</dd>
        {snapshot.run ? (
          <>
            <dt>{t('Run ID')}</dt>
            <dd>{snapshot.run.runId}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-xs text-muted-foreground">
        {historyTruncated
          ? t('Earlier observed records are no longer available in this view.')
          : t('Only observed records are shown. Earlier activity may not have been captured.')}
      </p>
      {snapshot.run ? (
        (['stdout', 'stderr', 'traceback'] as const).map((key) => {
          const log = snapshot.run!.logs[key]
          return log.text || log.truncated || log.redacted ? (
            <section key={key} aria-label={key}>
              <h3 className="text-xs font-medium">{key}</h3>
              {log.truncated ? (
                <p className="text-xs text-status-warning-foreground">
                  {t('Earlier log output was truncated.')}
                </p>
              ) : null}
              {log.redacted ? (
                <p className="text-xs text-muted-foreground">
                  {t('Sensitive log content was redacted.')}
                </p>
              ) : null}
              <pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-bg-100 p-3 font-mono text-xs">
                {log.text}
              </pre>
            </section>
          ) : null
        })
      ) : (
        <p className="text-sm text-muted-foreground">{t('Waiting for the execution record.')}</p>
      )}
      {tab === 'project' ? (
        <section aria-label={t('Result files recorded at this step')}>
          <h3 className="text-xs font-medium">{t('Result files recorded at this step')}</h3>
          {snapshot.artifacts.length ? (
            <ul className="mt-1 space-y-1 break-words text-xs">
              {snapshot.artifacts.map((artifact) => (
                <li key={artifact.versionId}>{artifact.name}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('No result files were recorded at this step.')}
            </p>
          )}
        </section>
      ) : null}
      {snapshot.artifactsTruncated ? (
        <p className="text-xs text-status-warning-foreground">
          {t('Some result files are outside this observation window.')}
        </p>
      ) : null}
    </>
  )
  return (
    <div
      className={`flex min-h-0 flex-col ${tab === 'project' ? 'h-full gap-2' : 'gap-3'}`}
      data-testid="replay-live-record"
      data-observation-record={`${snapshot.cursor.epoch}:${snapshot.cursor.sequence}`}
    >
      {!historicalOnly ? (
        <div
          className="sticky top-0 z-10 flex shrink-0 flex-wrap gap-1 bg-bg-000"
          role="group"
          aria-label={t('Run view')}
          data-replay-live-interaction
        >
          <Button
            variant={tab === 'record' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTab('record')}
            aria-pressed={tab === 'record'}
          >
            {t('Execution record')}
          </Button>
          <Button
            variant={tab === 'project' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => {
              setTab('project')
              if (!livePage && mode === 'follow' && !projectActivation?.opening)
                projectActivation?.onOpen()
            }}
            aria-pressed={tab === 'project'}
            title={
              mode === 'follow' && projectActivation && !livePage
                ? t('Open project interface')
                : undefined
            }
          >
            {t('Project interface')}
          </Button>
        </div>
      ) : null}
      <div
        inert={tab !== 'project'}
        hidden={tab !== 'project'}
        className={`min-h-0 flex-1${livePage ? '' : ' overflow-auto'}`}
        data-replay-live-interaction
      >
        <div hidden={!livePage} inert={!livePage} className="flex h-full min-h-0 flex-col">
          {runtimeSurface && runtimeSurface.runId === snapshot.run?.runId && mode !== 'history' ? (
            <>
              <p className="mb-1 shrink-0 text-xs text-status-warning-foreground">
                {t('This page controls the current run. Interactions can change its results.')}
              </p>
              {runtimeSurface.content}
            </>
          ) : null}
        </div>
        {!livePage && tab === 'project' ? (
          <div className="space-y-3 p-3">
            {ended ? (
              <div role="status" className="space-y-1 text-sm" data-testid="project-run-ended">
                <p>{endLabel}</p>
                <p className="text-muted-foreground">{t('The live project page is closed.')}</p>
              </div>
            ) : null}
            {mode === 'follow' && projectActivation?.opening ? (
              <p role="status" className="p-4 text-sm text-muted-foreground">
                {t('Opening project interface…')}
              </p>
            ) : (
              (recordedSurface ?? (
                <p role="status" className="p-4 text-sm text-muted-foreground">
                  {mode === 'inspect' || mode === 'history'
                    ? t(
                        'No project screen was recorded for this step. The current live page is not historical evidence.'
                      )
                    : t('The project interface is not available for this run yet.')}
                </p>
              ))
            )}
            <section className="space-y-3" aria-label={t('Evidence from the selected step')}>
              <h3 className="text-sm font-medium">{t('Evidence from the selected step')}</h3>
              {recordEvidence}
            </section>
          </div>
        ) : null}
      </div>
      {tab === 'record' ? recordEvidence : null}
    </div>
  )
}
