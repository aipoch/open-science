import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import type {
  ReplayResource,
  ReplayRunIndex,
  ReplaySourceIdentity,
  ReplayStep
} from '../../../../shared/replay'
import { resolveNotebookRunFigures } from './notebook-run-figures'
import { replayImageSource } from './replay/replay-svg'

const recordText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
const textClass =
  'whitespace-pre-wrap break-words rounded-lg bg-bg-200 p-3 font-mono text-xs leading-5'
const buttonClass =
  'rounded-md border border-border-200 px-3 py-1.5 text-sm hover:bg-bg-200 focus-visible:outline-2 focus-visible:outline-ring'

const RecordedData = ({ value }: { value: unknown }): React.JSX.Element => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {t('Recorded data')}
      </summary>
      {open ? <pre className={textClass}>{recordText(value)}</pre> : null}
    </details>
  )
}

const RecordedNotebook = ({
  source,
  index
}: {
  source: ReplaySourceIdentity
  index: ReplayRunIndex
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [run, setRun] = useState<NotebookRunRecord>()
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      cancelled = true
      setError(true)
    }, 10_000)
    const read = async (): Promise<void> => {
      const request = {
        projectId: source.projectId,
        sessionId: source.sessionId,
        // Imported history has no live workspace; the persisted reference establishes presence.
        workspaceCwd: source.workspaceCwd ?? ''
      }
      if (!(await window.api.notebook.getReference(request)))
        throw new Error('Notebook not recorded')
      if (cancelled) return
      // Read an already recorded run only. This never mounts a Notebook workspace or attaches a kernel.
      const state = await window.api.notebook.state({ ...request, runIds: [index.runId] })
      if (cancelled) return
      const record = state.runs.find((candidate) => candidate.runId === index.runId)
      const fields = [
        'agentFrameId',
        'messageBranchId',
        'promptMessageId',
        'executionInvocationId',
        'startedAt',
        'endedAt',
        'status',
        'cellId',
        'kernelKind'
      ] as const
      if (!record || fields.some((field) => record[field] !== index[field]))
        throw new Error('Notebook identity mismatch')
      setRun(record)
    }
    void read()
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => window.clearTimeout(timer))
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [source.projectId, source.sessionId, source.workspaceCwd, source.fingerprint, index, attempt])
  if (error)
    return (
      <div role="status" className="space-y-2">
        <p>{t('The recorded evidence is unavailable.')}</p>
        <button
          type="button"
          className={buttonClass}
          onClick={() => {
            setRun(undefined)
            setError(false)
            setAttempt((value) => value + 1)
          }}
        >
          {t('Retry')}
        </button>
      </div>
    )
  if (!run) return <p role="status">{t('Loading recorded evidence…')}</p>
  return (
    <article className="space-y-3" data-recorded-notebook-run={run.runId}>
      <p className="text-xs text-muted-foreground">
        {t('Recorded status: {{status}}', { status: run.status })}
      </p>
      <pre className={textClass}>{run.script}</pre>
      <h3 className="text-sm font-medium">{t('Saved output')}</h3>
      {[run.text.stdout, run.text.stderr, run.text.traceback, ...run.text.plain]
        .filter(Boolean)
        .map((text, index) => (
          <pre key={index} className={textClass}>
            {text}
          </pre>
        ))}
      {resolveNotebookRunFigures(run).map((figure) => {
        const image = replayImageSource(figure.mimeType, figure.payload)
        return image ? (
          <img
            key={figure.key}
            src={image}
            alt={t('Figure {{index}}', { index: figure.index })}
            className="max-w-full object-contain"
          />
        ) : null
      })}
      {run.truncated ? (
        <p className="text-xs text-muted-foreground">{t('Archived output is truncated.')}</p>
      ) : null}
      <RecordedData value={run} />
    </article>
  )
}

// A normal scrollable evidence reader, separate from the clock-driven presentation stage. It reads
// immutable records on demand and renders no live conversation, execution, approval or input widgets.
export const ResearchReplayEvidence = ({
  source,
  step,
  resources,
  onBack,
  onOpenResource
}: {
  source: ReplaySourceIdentity
  step: ReplayStep
  resources: ReplayResource[]
  onBack: () => void
  onOpenResource: (resource: ReplayResource) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [selectedRunId, setSelectedRunId] = useState(step.runs[0]?.runId)
  const selectedRun = step.runs.find((run) => run.runId === selectedRunId)
  return (
    <section
      aria-label={t('Original recorded evidence')}
      className="min-h-0 flex-1 overflow-auto p-4"
    >
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-medium">{t('Original recorded evidence')}</h2>
        <button type="button" className={buttonClass} onClick={onBack}>
          {t('Back to replay')}
        </button>
      </header>
      <div className="space-y-5">
        {step.message ? (
          <article className="space-y-2">
            <h3 className="text-sm font-medium">
              {step.message.role === 'user' ? t('User') : t('Agent')}
            </h3>
            <pre className="whitespace-pre-wrap break-words text-sm leading-6">
              {step.message.content}
            </pre>
            <RecordedData value={step.message} />
          </article>
        ) : null}
        {step.activities.map((activity) => (
          <article key={activity.id} className="space-y-2">
            <h3 className="text-sm font-medium">{activity.title || t('Tool activity')}</h3>
            <p className="text-xs text-muted-foreground">
              {t('Recorded status: {{status}}', { status: activity.status })}
            </p>
            {activity.rawInput !== undefined ? (
              <pre className={textClass}>{recordText(activity.rawInput)}</pre>
            ) : null}
            {activity.terminalOutput ? (
              <pre className={textClass}>{activity.terminalOutput}</pre>
            ) : null}
            {activity.rawOutput !== undefined ? (
              <pre className={textClass}>{recordText(activity.rawOutput)}</pre>
            ) : null}
            <RecordedData value={activity} />
          </article>
        ))}
        {step.runs.length ? (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">{t('Notebook')}</h3>
            {step.runs.length > 1 ? (
              <select
                aria-label={t('Notebook')}
                value={selectedRunId}
                onChange={(event) => setSelectedRunId(event.target.value)}
              >
                {step.runs.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {run.runId}
                  </option>
                ))}
              </select>
            ) : null}
            {selectedRun ? (
              <RecordedNotebook
                key={JSON.stringify([
                  source.projectId,
                  source.sessionId,
                  source.fingerprint,
                  selectedRun.runId
                ])}
                source={source}
                index={selectedRun}
              />
            ) : null}
          </section>
        ) : null}
        {resources
          .filter((resource) => step.resourceIds.includes(resource.id))
          .map((resource) => (
            <button
              key={resource.id}
              type="button"
              className={buttonClass}
              onClick={() => onOpenResource(resource)}
            >
              {resource.name}
            </button>
          ))}
        <RecordedData value={{ source, step }} />
      </div>
    </section>
  )
}
