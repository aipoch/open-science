import { notebookOutputTextClassName } from '../NotebookRunOutputs'
import { cn } from '@/lib/utils'
import { WorkspaceElicitationCard } from '../WorkspaceElicitationCard'
import { memo, useMemo, useState } from 'react'
import type { PersistedToolActivity } from '../../../../../shared/session-persistence'
import { replayExcerpt, replayText, replayToolOutputs } from './replay-content'
import { useReplayTranslation } from './replay-presentation'
import { WorkspaceToolActivityRow } from '../WorkspaceToolActivityRow'
import { WorkspaceToolDetailsRow } from '../WorkspaceToolDetailsRow'
import { buildToolActivityDetails } from '../workspace-tool-activity-details'
import { getToolExecutionPhase, getCorrelatedNotebookRun } from '../tool-execution-phase'
import type { ToolActivity } from '@/stores/session-store'
import type { NotebookRunRecord } from '../../../../../shared/notebook'
import type { ReplayStep, ReplayNotebookRunDetails } from '../../../../../shared/replay'
import { WorkspaceActivityGroupSurface } from '../WorkspaceTranscriptSurface'
import {
  formatActivityGroupPresentationTitle,
  formatActivityGroupElapsed,
  formatStepCount
} from '../workspace-tool-activity-groups'
import { REPLAY_ACTIVITY_LIMIT, REPLAY_MATERIAL_RUN_LIMIT } from '@/lib/replay/scene'

const projectActivity = (activity: PersistedToolActivity, showResults: boolean): ToolActivity => {
  const { toolKind, toolContent, ...persisted } = activity
  return {
    ...persisted,
    toolKind: toolKind as ToolActivity['toolKind'],
    toolContent: toolContent as ToolActivity['toolContent'],
    id: `replay-${activity.id}`,
    elicitation: undefined,
    ...(showResults
      ? {}
      : {
          status: 'pending',
          rawOutput: undefined,
          terminalOutput: undefined,
          terminalExitCode: undefined,
          toolContent: undefined,
          toolDisposition: undefined
        })
  }
}

export const ReplayActivityGroup = memo(function ReplayActivityGroup({
  step,
  showResults,
  runDetails
}: {
  step: ReplayStep
  showResults: boolean
  runDetails: Readonly<Record<string, ReplayNotebookRunDetails>>
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const [expanded, setExpanded] = useState(true)
  const activities = useMemo(
    () =>
      step.activities
        .slice(0, REPLAY_ACTIVITY_LIMIT)
        .map((activity) => projectActivity(activity, showResults)),
    [step.activities, showResults]
  )
  const runs = useMemo(
    () =>
      new Map<string, NotebookRunRecord>(
        showResults
          ? step.runs.slice(0, REPLAY_MATERIAL_RUN_LIMIT).flatMap((index) => {
              const detail = runDetails[index.runId]
              return detail?.status === 'ready' ? [[index.runId, detail.run] as const] : []
            })
          : []
      ),
    [step.runs, showResults, runDetails]
  )
  const elapsed =
    showResults &&
    step.recordedAt !== undefined &&
    step.recordedEndAt !== undefined &&
    step.recordedEndAt >= step.recordedAt
      ? formatActivityGroupElapsed(step.recordedEndAt - step.recordedAt)
      : undefined
  return (
    <WorkspaceActivityGroupSurface
      animate={false}
      title={
        showResults
          ? formatActivityGroupPresentationTitle(activities, step.title, undefined, runs, t)
          : t('Reconstructed activity')
      }
      meta={
        <>
          {formatStepCount(activities, undefined, runs, t)}
          {elapsed ? ` · ${elapsed}` : ''}
        </>
      }
      isExpanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      {step.activities.slice(0, REPLAY_ACTIVITY_LIMIT).map((activity) => (
        <ReplayInteractiveToolRecord
          key={activity.id}
          activity={activity}
          showResults={showResults}
          notebookRunsById={runs}
        />
      ))}
    </WorkspaceActivityGroupSurface>
  )
})

// The same read-only detail presenter used by Provenance, with replay's result boundary applied
// before projection. No live hydration, permission, annotation or navigation binding is supplied.
const ReplayInteractiveToolRecord = memo(function ReplayInteractiveToolRecord({
  activity,
  showResults,
  notebookRunsById
}: {
  activity: PersistedToolActivity
  showResults: boolean
  notebookRunsById?: ReadonlyMap<string, NotebookRunRecord>
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const [expanded, setExpanded] = useState(false)
  const visibleActivity = useMemo(
    () => projectActivity(activity, showResults),
    [activity, showResults]
  )
  const details = useMemo(() => {
    const projected = buildToolActivityDetails(visibleActivity, t)
    if (!projected) return undefined
    // Literature cards bind navigation to today's library; archived references stay in evidence.
    return {
      ...projected,
      sections: projected.sections.filter((section) => section.kind !== 'literature')
    }
  }, [visibleActivity, t])
  // Use a static neutral icon for unfinished/declined history; never imply a live run or a
  // decision made by the current viewer. The recorded status and decision remain in evidence.
  const phase = showResults
    ? getToolExecutionPhase(visibleActivity, undefined, notebookRunsById)
    : 'prepared'
  if (activity.elicitation) {
    const recorded = activity.elicitation
    const visible = showResults
      ? recorded
      : {
          ...recorded,
          state: 'pending' as const,
          answers: undefined,
          draftAnswers: undefined,
          respondedAt: undefined
        }
    return (
      <div data-replay-activity={activity.id} className="min-w-0">
        <p className="px-3 pt-2 text-xs text-text-300">{t('Recorded confirmation')}</p>
        <WorkspaceElicitationCard
          key={`${activity.id}:${showResults}`}
          elicitation={visible}
          readOnly
          embedded
          request={{
            requestId: `replay:${activity.id}`,
            sessionId: '',
            toolCallId: activity.id,
            message: recorded.message,
            fields: recorded.fields
          }}
        />
      </div>
    )
  }
  return (
    <div className="min-w-0" data-replay-activity={activity.id}>
      {details ? (
        <WorkspaceToolDetailsRow
          activity={visibleActivity}
          details={details}
          phase={phase === 'executing' || phase === 'declined' ? 'interrupted' : phase}
          notebookRun={
            showResults
              ? (getCorrelatedNotebookRun(visibleActivity, notebookRunsById) ??
                (details.notebookRunId ? notebookRunsById?.get(details.notebookRunId) : undefined))
              : undefined
          }
          isExpanded={expanded}
          onToggle={(_, value) => setExpanded(value)}
        />
      ) : (
        <WorkspaceToolActivityRow
          activity={visibleActivity}
          phase={phase === 'executing' || phase === 'declined' ? 'interrupted' : phase}
        />
      )}
    </div>
  )
})

export const ReplayRecordedText = ({
  text,
  scrollable = false
}: {
  text: string
  scrollable?: boolean
}): React.JSX.Element => {
  const { t } = useReplayTranslation()
  const excerpt = replayExcerpt(text)
  return (
    <div className="space-y-1">
      <pre
        className={
          scrollable
            ? cn(notebookOutputTextClassName, 'overflow-auto whitespace-pre text-text-200')
            : 'whitespace-pre-wrap break-words rounded bg-bg-200 p-2 font-mono text-xs leading-5'
        }
      >
        {excerpt}
      </pre>
      {excerpt.length < text.length ? (
        <p className="text-xs text-text-300">
          {t('Preview is truncated. Open the evidence for the complete record.')}
        </p>
      ) : null}
    </div>
  )
}

// Historical confirmation is evidence, never a live approval control. Memoization also keeps
// large saved tool payloads out of the per-frame serialization path.
const ReplayRawToolRecord = memo(function ReplayRawToolRecord({
  activity,
  showResults
}: {
  activity: PersistedToolActivity
  showResults: boolean
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const input = useMemo(() => replayText(activity.rawInput), [activity.rawInput])
  const outputs = useMemo(() => replayToolOutputs(activity), [activity])
  const confirmation = activity.elicitation
  const request = useMemo(
    () =>
      confirmation
        ? replayText({ message: confirmation.message, fields: confirmation.fields })
        : '',
    [confirmation]
  )
  const answers = useMemo(
    () =>
      confirmation
        ? replayText(
            (confirmation.answers ?? confirmation.draftAnswers ?? []).map((answer) => ({
              field:
                confirmation.fields.find((field) => field.id === answer.fieldId)?.label ??
                answer.fieldId,
              value: answer.value
            }))
          )
        : '',
    [confirmation]
  )
  return (
    <div className="mt-2 space-y-2 text-sm" data-replay-activity={activity.id}>
      <div className="font-medium">{replayExcerpt(activity.title, 512)}</div>
      <div className="text-xs text-text-300">
        {showResults
          ? t('Recorded status: {{status}}', { status: activity.status })
          : t('Reconstructed activity')}
      </div>
      {activity.rawInput !== undefined ? (
        <section>
          <h4 className="text-xs font-medium">{t('Input')}</h4>
          <ReplayRecordedText text={input} />
        </section>
      ) : null}
      {confirmation ? (
        <section className="space-y-2 rounded border border-border-200 p-2">
          <h4 className="text-xs font-medium">{t('Recorded confirmation')}</h4>
          <ReplayRecordedText text={request} />
          {showResults ? (
            <>
              <p className="text-xs">
                {t('Recorded status: {{status}}', { status: confirmation.state })}
              </p>
              {confirmation.answers?.length || confirmation.draftAnswers?.length ? (
                <section>
                  <h4 className="text-xs font-medium">
                    {confirmation.answers?.length
                      ? t('Recorded answers')
                      : t('Saved draft answers')}
                  </h4>
                  <ReplayRecordedText text={answers} />
                </section>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
      {showResults ? (
        <>
          {activity.toolDisposition ? (
            <p className="text-xs font-medium">
              {t('Recorded decision')}:{' '}
              {activity.toolDisposition === 'declined'
                ? t('Request declined')
                : t('Permission request was closed.')}
            </p>
          ) : null}
          {activity.terminalExitCode !== undefined && activity.terminalExitCode !== null ? (
            <p className="text-xs">
              {t('Exit code')}: {activity.terminalExitCode}
            </p>
          ) : null}
          {outputs.map((output) => (
            <section key={output.channel} data-replay-output-channel={output.channel}>
              <h4 className="text-xs font-medium">
                {output.channel === 'terminal'
                  ? t('Recorded terminal output')
                  : output.channel === 'result'
                    ? t('Output')
                    : t('Content')}
              </h4>
              <ReplayRecordedText text={output.text} />
            </section>
          ))}
        </>
      ) : null}
    </div>
  )
})

export const ReplayToolRecord = memo(function ReplayToolRecord({
  activity,
  showResults,
  interactive = false
}: {
  activity: PersistedToolActivity
  showResults: boolean
  interactive?: boolean
}): React.JSX.Element {
  return interactive ? (
    <ReplayInteractiveToolRecord activity={activity} showResults={showResults} />
  ) : (
    <ReplayRawToolRecord activity={activity} showResults={showResults} />
  )
})
