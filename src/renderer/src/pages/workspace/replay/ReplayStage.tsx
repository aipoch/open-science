import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parse } from 'papaparse'
import type {
  ReplayDocument,
  ReplayScene,
  ReplayStep,
  ReplayNotebookRunDetails
} from '../../../../../shared/replay'
import type { NotebookRunRecord } from '../../../../../shared/notebook'
import { HighlightedCodeLines } from '../HighlightedCodeLines'
import { resolveNotebookRunFigures } from '../notebook-run-figures'
import type { ReplayResourceMap } from './replay-resources'
import { replayImageSource } from './replay-svg'
import { replayExcerpt, replayNotebookText as notebookText } from './replay-content'
import {
  REPLAY_TRANSCRIPT_STEP_LIMIT,
  REPLAY_ACTIVITY_LIMIT,
  REPLAY_MATERIAL_RUN_LIMIT,
  REPLAY_MATERIAL_RESOURCE_LIMIT
} from '@/lib/replay/scene'
import { ReplayToolRecord, ReplayRecordedText } from './ReplayToolRecord'
import { prepareReplayFrame, type ReplayFrameReadiness } from './replay-readiness'
import {
  ReplayPresentationContext,
  createReplayPresentation,
  replayPresentationStyle,
  useReplayTranslation,
  type ReplayPresentationConfig
} from './replay-presentation'

export const REPLAY_VIEWPORT = { width: 1280, height: 720 } as const
export type ReplayStageReadiness = ReplayFrameReadiness & { frameKey: string; positionMs: number }
export type ReplayStageProps = {
  document: ReplayDocument
  scene: ReplayScene
  resources?: ReplayResourceMap
  reducedMotion?: boolean
  presentation?: ReplayPresentationConfig
  preparationId?: number
  runDetails?: Readonly<Record<string, ReplayNotebookRunDetails>>
  onInspect?: () => void
  onReady?: (readiness: ReplayStageReadiness) => void
  readinessTimeoutMs?: number
}

const archivedTime = (value: number | undefined): string | undefined => {
  if (value === undefined || !Number.isFinite(value)) return undefined
  try {
    return new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
  } catch {
    return undefined
  }
}

// Static Markdown deliberately disables links, remote media, raw HTML and animated plugins.
// Captured figures are rendered separately and participate in the resource-ready barrier.
const ReplayMarkdown = memo(function ReplayMarkdown({
  content
}: {
  content: string
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const excerpt = replayExcerpt(content, 8192)
  return (
    <div className="prose prose-sm max-w-none break-words text-inherit prose-pre:whitespace-pre-wrap prose-pre:bg-bg-200 prose-pre:text-text-100 prose-headings:text-text-100 prose-strong:text-text-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children }) => <span className="underline">{children}</span>,
          img: ({ alt }) => <span className="text-text-300">{alt}</span>
        }}
      >
        {excerpt}
      </ReactMarkdown>
      {excerpt.length < content.length ? (
        <p className="text-xs text-text-300">
          {t('Preview is truncated. Open the evidence for the complete record.')}
        </p>
      ) : null}
    </div>
  )
})

const ReplayCode = ({ code }: { code: string }): React.JSX.Element => {
  const { t } = useReplayTranslation()
  const excerpt = replayExcerpt(code)
  return (
    <div className="space-y-2">
      <pre className="m-0 overflow-hidden rounded-lg bg-bg-200 p-4 font-mono text-[13px] leading-5">
        <code>
          <HighlightedCodeLines
            code={excerpt}
            rowClassName="flex"
            lineNumberClassName="mr-4 shrink-0"
            contentClassName="min-w-0 flex-1 whitespace-pre-wrap break-words"
          />
        </code>
      </pre>
      {excerpt.length < code.length ? (
        <p className="text-xs text-text-300">
          {t('Preview is truncated. Open the evidence for the complete file.')}
        </p>
      ) : null}
    </div>
  )
}

const FrozenImage = ({
  id,
  src,
  alt,
  unavailable
}: {
  id: string
  src: string
  alt: string
  unavailable: boolean
}): React.JSX.Element => {
  const { t } = useReplayTranslation()
  const [failed, setFailed] = useState(false)
  return failed || unavailable ? (
    <div
      className="rounded-lg border border-border-200 bg-bg-200 p-6 text-text-300"
      data-replay-image-missing={id}
    >
      {t('Recorded image unavailable')}
    </div>
  ) : (
    <img
      src={src}
      alt={alt}
      data-replay-resource-id={id}
      className="block max-h-[420px] max-w-full rounded-lg object-contain"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}

const ReplayNotebook = ({
  run,
  showOutput,
  unavailableImages
}: {
  run: NotebookRunRecord
  showOutput: boolean
  unavailableImages: ReadonlySet<string>
}): React.JSX.Element => {
  const { t } = useReplayTranslation()
  const figures = useMemo(() => resolveNotebookRunFigures(run), [run])
  const output = useMemo(() => notebookText(run), [run])
  return (
    <article className="space-y-3" data-replay-notebook-run={run.runId}>
      <div className="flex items-center justify-between text-sm text-text-300">
        <span>{t('Notebook')}</span>
        <span>{run.kernelKind}</span>
      </div>
      <ReplayCode code={run.script} />
      {showOutput ? (
        <>
          <div className="text-xs font-medium text-text-300">{t('Saved output')}</div>
          {output.slice(0, 12).map((text, index) => (
            <ReplayRecordedText key={index} text={text} />
          ))}
          {figures.slice(0, 6).map((figure) => {
            const id = `${run.runId}:${figure.key}`
            // Animated image formats do not share the replay clock; keep a fixed placeholder.
            const source = replayImageSource(figure.mimeType, figure.payload)
            return source ? (
              <FrozenImage
                key={id}
                id={id}
                src={source}
                alt={t('Figure {{index}}', { index: figure.index })}
                unavailable={unavailableImages.has(id)}
              />
            ) : (
              <p key={id} className="rounded-lg bg-bg-200 p-3 text-xs text-text-300">
                {t('Open the original evidence to inspect this format.')}
              </p>
            )
          })}
          {output.length > 12 || figures.length > 6 ? (
            <p className="text-xs text-text-300">
              {t('Preview is truncated. Open the evidence for the complete record.')}
            </p>
          ) : null}
          {run.truncated ? (
            <p className="text-xs text-text-300">{t('Archived output is truncated.')}</p>
          ) : null}
        </>
      ) : null}
    </article>
  )
}

const ResourceTable = ({
  content,
  delimiter
}: {
  content: string
  delimiter?: string
}): React.JSX.Element => {
  const { t } = useReplayTranslation()
  const parsed = useMemo(
    () => parse<string[]>(content, { delimiter, preview: 80, skipEmptyLines: true }),
    [content, delimiter]
  )
  const rows = parsed.data
  return (
    <div>
      <table className="w-full border-collapse text-left text-xs">
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className={index === 0 ? 'bg-bg-300 font-semibold' : ''}>
              {row.slice(0, 12).map((cell, column) => (
                <td key={column} className="max-w-48 break-words border border-border-200 p-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {parsed.meta.truncated || rows.some((row) => row.length > 12) ? (
        <p className="mt-2 text-xs text-text-300">
          {t('Preview is truncated. Open the evidence for the complete file.')}
        </p>
      ) : null}
    </div>
  )
}

const StepConversation = memo(function StepConversation({
  step,
  active,
  messageCharacters,
  showResults
}: {
  step: ReplayStep
  active: boolean
  messageCharacters: number
  showResults: boolean
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const message = step.message
  const content = message?.content ?? ''
  // Reconstruction is explicit. Reveal rate derives exclusively from logical scene time.
  const visible = active ? content.slice(0, messageCharacters) : content
  return (
    <article
      data-replay-step={step.id}
      data-replay-active={active || undefined}
      className={`rounded-xl border p-4 ${active ? 'border-border-100 bg-bg-000' : 'border-border-200 bg-bg-10'}`}
    >
      <div className="mb-2 flex items-center justify-between text-xs text-text-300">
        <span>
          {message
            ? message.role === 'user'
              ? t('User')
              : t('Agent')
            : step.kind === 'notebook'
              ? t('Notebook')
              : step.kind === 'artifact'
                ? t('Files')
                : t('Tool activity')}
        </span>
        <span>{archivedTime(step.recordedAt) ?? t('Time not recorded')}</span>
      </div>
      {message ? <ReplayMarkdown content={visible} /> : null}
      {step.activities.slice(0, REPLAY_ACTIVITY_LIMIT).map((activity) => (
        <ReplayToolRecord key={activity.id} activity={activity} showResults={showResults} />
      ))}
      {step.activities.length > REPLAY_ACTIVITY_LIMIT ? (
        <p className="text-xs text-text-300">
          {t('Preview is truncated. Open the evidence for the complete record.')}
        </p>
      ) : null}
      {step.issues.length ? (
        <div className="mt-2 space-y-1 text-xs text-text-300">
          {step.issues.some((issue) => issue.code === 'missing-environment') ? (
            <p>{t('The recorded execution environment is unavailable.')}</p>
          ) : null}
          {step.issues.some((issue) => issue.code === 'incomplete-history') ? (
            <p>{t('Recorded history is incomplete.')}</p>
          ) : null}
          {step.issues.some(
            (issue) =>
              !['missing-environment', 'incomplete-history', 'missing-time'].includes(issue.code)
          ) ? (
            <p>{t('Some source material is incomplete or unavailable.')}</p>
          ) : null}
        </div>
      ) : null}
      {!message && !step.activities.length ? (
        <p className="text-sm">
          {step.title ??
            (step.runs.length ? t('Saved Notebook execution') : t('Recorded file version'))}
        </p>
      ) : null}
    </article>
  )
})

const ReplayStageContent = ({
  document: replayDocument,
  scene,
  resources = {},
  reducedMotion = false,
  presentation = createReplayPresentation(),
  preparationId = 0,
  runDetails = {},
  onInspect,
  onReady,
  readinessTimeoutMs
}: ReplayStageProps): React.JSX.Element => {
  const { t } = useReplayTranslation()
  const stage = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const material = useRef<HTMLDivElement>(null)
  const [preparation, setPreparation] = useState<{ key: string; result: ReplayFrameReadiness }>()
  const [failedImages, setFailedImages] = useState(new Set<string>())
  const readyCallback = useRef(onReady)
  useLayoutEffect(() => {
    readyCallback.current = onReady
  }, [onReady])
  const active = scene.step
  const materialStep = [...scene.visibleSteps]
    .reverse()
    .find((step) => step.runs.length || step.resourceIds.length)
  const materialRuns = materialStep?.runs.slice(0, REPLAY_MATERIAL_RUN_LIMIT) ?? []
  const resourceIds = (materialStep?.resourceIds ?? [])
    .slice(0, REPLAY_MATERIAL_RESOURCE_LIMIT)
    .filter((id) => scene.visibleResourceIds.includes(id))
  const selectedResources = replayDocument.resources.filter((resource) =>
    resourceIds.includes(resource.id)
  )
  const resourcesSettled = selectedResources.every(
    (resource) => resources[resource.id] !== undefined
  )
  const runsSettled = materialRuns.every((run) => runDetails[run.runId] !== undefined)
  const showOutput = materialStep?.id !== active?.id || scene.showResults
  const preparationKey = JSON.stringify([
    replayDocument.source.projectId,
    replayDocument.source.sessionId,
    replayDocument.source.fingerprint,
    presentation,
    preparationId,
    scene.branchId,
    active?.id,
    showOutput,
    selectedResources.map((resource) => [resource.id, resources[resource.id]?.status]),
    materialRuns.map((run) => [run.runId, runDetails[run.runId]?.status])
  ])
  const readiness =
    preparation?.key === preparationKey
      ? preparation.result
      : { ready: false, degraded: false, diagnostics: [] }
  const frameKey = JSON.stringify([preparationKey, scene.positionMs])
  const unavailableImages = useMemo(
    () =>
      new Set([
        ...failedImages,
        ...readiness.diagnostics
          .filter((item) => /^(?:timeout|unavailable):image:/u.test(item))
          .map((item) => item.replace(/^(?:timeout|unavailable):image:/u, ''))
      ]),
    [readiness.diagnostics, failedImages]
  )

  useEffect(() => {
    const controller = new AbortController()
    if (!stage.current || !resourcesSettled || !runsSettled) return () => controller.abort()
    void prepareReplayFrame(stage.current, {
      signal: controller.signal,
      timeoutMs: readinessTimeoutMs
    }).then((result) => {
      if (!controller.signal.aborted) {
        const imageFailures = result.diagnostics
          .filter((item) => /^(?:timeout|unavailable):image:/u.test(item))
          .map((item) => item.replace(/^(?:timeout|unavailable):image:/u, ''))
        if (imageFailures.length)
          setFailedImages((existing) => new Set([...existing, ...imageFailures]))
        const missing = [
          ...selectedResources
            .filter((resource) => resources[resource.id]?.status !== 'ready')
            .map((resource) => `material:${resource.id}`),
          ...materialRuns
            .filter((run) => runDetails[run.runId]?.status !== 'ready')
            .map((run) => `run:${run.runId}`)
        ]
        setPreparation({
          key: preparationKey,
          result: {
            ...result,
            degraded: result.degraded || missing.length > 0,
            diagnostics: [...result.diagnostics, ...missing]
          }
        })
      }
    })
    return () => controller.abort()
    // The preparation key includes only material dependencies. Logical time never resets IO.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preparationKey, resourcesSettled, runsSettled, readinessTimeoutMs])

  useLayoutEffect(() => {
    // Absolute target scroll positions make direct seeks and sequential playback identical.
    const element = transcript.current
    if (element) {
      const current = element.querySelector<HTMLElement>('[data-replay-active]')
      const start = current ? Math.max(0, current.offsetTop - element.offsetTop - 16) : 0
      const overflow = current ? Math.max(0, current.scrollHeight - element.clientHeight + 32) : 0
      element.scrollTop = Math.min(
        element.scrollHeight - element.clientHeight,
        start + overflow * (reducedMotion ? 1 : scene.stepProgress)
      )
    }
    if (material.current)
      material.current.scrollTop =
        Math.max(0, material.current.scrollHeight - material.current.clientHeight) *
        (reducedMotion ? 0 : scene.stepProgress)
  }, [scene.positionMs, scene.stepProgress, frameKey, reducedMotion, preparation])

  useLayoutEffect(() => {
    readyCallback.current?.({ ...readiness, frameKey, positionMs: scene.positionMs })
    // This runs after deterministic scroll/layout and placeholder commits for this exact frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey, preparation])

  const style = replayPresentationStyle(presentation)
  return (
    <div
      ref={stage}
      style={style}
      data-testid="replay-stage"
      data-replay-frame-ready={readiness.ready}
      data-replay-frame-key={frameKey}
      data-replay-preparation={preparationId}
      lang={presentation.locale}
      data-replay-position={scene.positionMs}
      data-replay-branch={scene.branchId}
      className="flex shrink-0 flex-col overflow-hidden bg-bg-000 text-text-100"
      onWheelCapture={onInspect}
      onPointerDownCapture={onInspect}
      onKeyDownCapture={(event) => {
        if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key))
          onInspect?.()
      }}
    >
      <header className="flex h-16 shrink-0 items-center justify-between gap-6 border-b border-border-200 px-7">
        <div className="min-w-0">
          <div className="truncate text-lg font-semibold">{replayDocument.source.title}</div>
          <div className="text-xs text-text-300">{t('Reconstructed from archived records')}</div>
        </div>
        <span className="rounded-full border border-border-200 px-3 py-1 text-xs text-text-300">
          {t('Read-only research history')}
        </span>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[46%_54%]">
        <section
          ref={transcript}
          aria-label={t('Historical conversation')}
          tabIndex={0}
          className="relative space-y-3 overflow-auto border-r border-border-200 bg-bg-10 p-5"
          style={{ scrollbarWidth: 'none' }}
        >
          {scene.visibleSteps.slice(-REPLAY_TRANSCRIPT_STEP_LIMIT).map((step) => (
            <StepConversation
              key={step.id}
              step={step}
              active={step.id === active?.id}
              messageCharacters={step.id === active?.id ? scene.messageCharacters : 0}
              showResults={step.id !== active?.id || scene.showResults}
            />
          ))}
          {!scene.visibleSteps.length ? (
            <p className="p-4 text-text-300">{t('No recorded steps are available.')}</p>
          ) : null}
        </section>
        <section
          ref={material}
          aria-label={t('Historical code and results')}
          tabIndex={0}
          className="space-y-5 overflow-auto p-6"
          style={{ scrollbarWidth: 'none' }}
        >
          {materialStep?.id === active?.id && scene.phase === 'activity' ? (
            <div
              className="space-y-2 text-xs text-text-300"
              data-replay-reconstructed-activity="true"
            >
              <span>{t('Reconstructed activity')}</span>
              <div className="h-1 overflow-hidden rounded bg-bg-200">
                <div
                  className="h-full bg-text-300"
                  style={{ width: `${Math.max(0, Math.min(100, scene.stepProgress * 100))}%` }}
                />
              </div>
            </div>
          ) : null}
          {materialRuns.map((index) => {
            const detail = runDetails[index.runId]
            return detail?.status === 'ready' ? (
              <ReplayNotebook
                key={index.runId}
                run={detail.run}
                showOutput={showOutput}
                unavailableImages={unavailableImages}
              />
            ) : (
              <p
                key={index.runId}
                aria-label={detail ? t('Recorded Notebook details are unavailable.') : undefined}
                className="rounded-lg bg-bg-200 p-5 text-sm text-text-300"
              >
                {detail
                  ? detail.reason === 'not-recorded'
                    ? t('This material was not saved in the source records.')
                    : t('Could not read the recorded material.')
                  : t('Preparing recorded material…')}
              </p>
            )
          })}
          {selectedResources.map((resource) => {
            const prepared = resources[resource.id]
            return (
              <article
                key={resource.id}
                className="space-y-3"
                data-replay-artifact-version={resource.versionId}
              >
                <div className="flex items-center justify-between gap-3 text-sm font-medium">
                  <span className="break-all">{resource.name}</span>
                  {resource.versionNumber !== undefined ? (
                    <span className="shrink-0 text-xs text-text-300">
                      {t('Version {{version}}', { version: resource.versionNumber })}
                    </span>
                  ) : null}
                </div>
                {prepared?.status === 'ready' ? (
                  <>
                    {prepared.kind === 'image' ? (
                      <FrozenImage
                        key={resource.id}
                        id={resource.id}
                        src={prepared.content}
                        alt={resource.name}
                        unavailable={unavailableImages.has(resource.id)}
                      />
                    ) : prepared.kind === 'table' ? (
                      <ResourceTable
                        content={prepared.content}
                        delimiter={resource.name.endsWith('.tsv') ? '\t' : undefined}
                      />
                    ) : (
                      <ReplayCode code={prepared.content} />
                    )}
                    {prepared.truncated ? (
                      <p className="text-xs text-text-300">
                        {t('Preview is truncated. Open the evidence for the complete file.')}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <div className="rounded-xl border border-dashed border-border-200 bg-bg-10 p-5 text-sm text-text-300">
                    {!prepared
                      ? t('Preparing recorded material…')
                      : prepared.status === 'unsupported'
                        ? t('Open the original evidence to inspect this format.')
                        : prepared.status === 'timeout'
                          ? t('This material did not become ready in time.')
                          : prepared.status === 'unavailable' && prepared.reason === 'not-recorded'
                            ? t('This material was not saved in the source records.')
                            : t('Could not read the recorded material.')}
                  </div>
                )}
              </article>
            )
          })}
          {(materialStep?.runs.length ?? 0) > REPLAY_MATERIAL_RUN_LIMIT ||
          (materialStep?.resourceIds.length ?? 0) > REPLAY_MATERIAL_RESOURCE_LIMIT ? (
            <p className="text-xs text-text-300">
              {t('Preview is truncated. Open the evidence for the complete record.')}
            </p>
          ) : null}
          {!materialStep ? (
            <div className="flex h-full items-center justify-center text-center text-sm text-text-300">
              {t('Recorded code and results appear here as the research unfolds.')}
            </div>
          ) : null}
        </section>
      </div>
      <footer className="flex h-10 shrink-0 items-center justify-between border-t border-border-200 px-6 text-xs text-text-300">
        <span>
          {readiness.degraded
            ? t('Some source material is incomplete or unavailable.')
            : t('Presentation timing is reconstructed; recorded results are unchanged.')}
        </span>
        <span>
          {active ? t('Step {{step}}', { step: scene.stepIndex + 1 }) : t('Research replay')}
        </span>
      </footer>
    </div>
  )
}

export const ReplayStage = (props: ReplayStageProps): React.JSX.Element => {
  const presentation = props.presentation ?? createReplayPresentation('en', props.reducedMotion)
  return (
    <ReplayPresentationContext.Provider value={presentation}>
      <ReplayStageContent
        key={JSON.stringify([
          props.document.source.projectId,
          props.document.source.sessionId,
          props.document.source.fingerprint,
          props.preparationId ?? 0
        ])}
        {...props}
        presentation={presentation}
        reducedMotion={presentation.reducedMotion}
      />
    </ReplayPresentationContext.Provider>
  )
}
