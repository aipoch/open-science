import { ArrowLeft } from 'lucide-react'
import { NotebookRecordCell } from './NotebookRecordCell'
import { NotebookRunTextOutputs } from './NotebookRunOutputs'
import { ReplayToolRecord } from './replay/ReplayToolRecord'
import { ReplayMarkdown, ResourceTable } from './replay/ReplayStage'
import { useNearViewport } from './previews/useNearViewport'
import { ReplayFileRow } from './replay/ReplayFileRow'
import { readReplayResource, type ReplayPreparedResource } from './replay/replay-resources'
import { SessionReviewerPanel } from './SessionReviewerPanel'
import { ErrorNotice } from '@/components/error-notice'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { useEffect, useMemo, useState } from 'react'
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

const textClass =
  'max-h-96 overflow-auto whitespace-pre rounded-lg bg-bg-200 p-3 font-mono text-xs leading-5'

const RecordedFile = ({
  resource,
  onOpen
}: {
  resource: ReplayResource
  onOpen: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [prepared, setPrepared] = useState<ReplayPreparedResource>()
  const [setElement, nearViewport] = useNearViewport<HTMLElement>()
  // Keep the loaded preview and its height when scrolling away, just like message images.
  const [requested, setRequested] = useState(false)
  if (nearViewport && !requested) setRequested(true)
  useEffect(() => {
    if (!requested) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      cancelled = true
      setPrepared({ status: 'timeout' })
    }, 10_000)
    void readReplayResource(resource)
      .then((value) => {
        if (!cancelled) setPrepared(value)
      })
      .catch(() => {
        if (!cancelled) setPrepared({ status: 'unavailable' })
      })
      .finally(() => window.clearTimeout(timer))
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [resource, requested])
  return (
    <article ref={setElement} className="space-y-3">
      <ReplayFileRow resource={resource} onSelect={onOpen} />
      {!prepared ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('Loading recorded evidence…')}
        </p>
      ) : prepared.status === 'ready' ? (
        <>
          {prepared.kind === 'image' ? (
            <img
              src={prepared.content}
              alt={resource.name}
              className="max-h-[60vh] max-w-full object-contain"
            />
          ) : prepared.kind === 'table' ? (
            <ResourceTable
              content={prepared.content}
              delimiter={resource.name.endsWith('.tsv') ? '\t' : undefined}
            />
          ) : resource.name.endsWith('.md') ? (
            <ReplayMarkdown content={prepared.content} complete />
          ) : (
            <pre className={textClass}>{prepared.content}</pre>
          )}
          {prepared.truncated ? (
            <p className="text-xs text-muted-foreground">
              {t('Preview is truncated. Open the evidence for the complete file.')}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          {prepared.status === 'unsupported'
            ? t('Open the original evidence to inspect this format.')
            : t('The recorded evidence is unavailable.')}
        </p>
      )}
    </article>
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
      <ErrorNotice
        tone="amber"
        description={t('The recorded evidence is unavailable.')}
        primaryButton={{
          label: t('Retry'),
          onClick: () => {
            setRun(undefined)
            setError(false)
            setAttempt((value) => value + 1)
          }
        }}
      />
    )
  if (!run) return <p role="status">{t('Loading recorded evidence…')}</p>
  return (
    <article className="space-y-3" data-recorded-notebook-run={run.runId}>
      <p className="text-xs text-muted-foreground">
        {t('Recorded status: {{status}}', { status: run.status })}
      </p>
      <NotebookRecordCell run={run} index={0}>
        <NotebookRunTextOutputs run={run} />
      </NotebookRecordCell>
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
    </article>
  )
}

// A normal scrollable evidence reader, separate from the clock-driven presentation stage. It reads
// immutable records on demand and renders no live conversation, execution, approval or input widgets.
export const SessionReplayEvidence = ({
  source,
  step,
  resources,
  onBack,
  backLabel,
  onOpenResource
}: {
  source: ReplaySourceIdentity
  step: ReplayStep
  resources: ReplayResource[]
  onBack: () => void
  backLabel?: string
  onOpenResource: (resource: ReplayResource) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [selectedRunId, setSelectedRunId] = useState(step.runs[0]?.runId)
  const selectedRun = step.runs.find((run) => run.runId === selectedRunId)
  const recordedResources = useMemo(() => {
    const ids = new Set(step.resourceIds)
    return resources.filter((resource) => ids.has(resource.id))
  }, [resources, step.resourceIds])
  return (
    <section
      aria-label={t('Original recorded evidence')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          onBack()
        }
      }}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border-200 px-3 py-2">
        <Button
          data-replay-evidence-back
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1.5"
          onClick={onBack}
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {backLabel ?? t('Back to replay')}
        </Button>
        <h2 className="min-w-0 truncate text-sm font-medium">{t('Original recorded evidence')}</h2>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
        {step.review ? (
          <SessionReviewerPanel review={step.review} activeFindingId={undefined} historical />
        ) : null}
        {step.message ? (
          <article className="space-y-2">
            <h3 className="text-sm font-medium">
              {step.message.role === 'user' ? t('User') : t('Agent')}
            </h3>
            <ReplayMarkdown content={step.message.content} complete />
          </article>
        ) : null}
        {step.activities.map((activity) => (
          <ReplayToolRecord key={activity.id} activity={activity} showResults interactive />
        ))}
        {step.runs.length ? (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">{t('Notebook')}</h3>
            {step.runs.length > 1 ? (
              <Select value={selectedRunId} onValueChange={setSelectedRunId}>
                <SelectTrigger aria-label={t('Notebook')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {step.runs.map((run) => (
                    <SelectItem key={run.runId} value={run.runId}>
                      {t('Notebook')} · {run.kernelKind} · {step.runs.indexOf(run) + 1}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
        {recordedResources.map((resource) => (
          <RecordedFile
            key={resource.id}
            resource={resource}
            onOpen={() => onOpenResource(resource)}
          />
        ))}
      </div>
    </section>
  )
}
