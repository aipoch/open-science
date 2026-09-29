import { memo, useMemo } from 'react'
import type { PersistedToolActivity } from '../../../../../shared/session-persistence'
import { replayExcerpt, replayText, replayToolOutputs } from './replay-content'
import { useReplayTranslation } from './replay-presentation'

export const ReplayRecordedText = ({ text }: { text: string }): React.JSX.Element => {
  const { t } = useReplayTranslation()
  const excerpt = replayExcerpt(text)
  return (
    <div className="space-y-1">
      <pre className="whitespace-pre-wrap break-words rounded bg-bg-200 p-2 font-mono text-xs leading-5">
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
export const ReplayToolRecord = memo(function ReplayToolRecord({
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
