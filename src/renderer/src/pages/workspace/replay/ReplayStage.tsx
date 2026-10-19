import { NotebookTextOutput } from '../NotebookRunOutputs'
import { GeneratedFileCard, artifactGalleryClassName } from '../GeneratedFileCard'
import { formatByteSize } from '@/lib/utils'
import { isReviewerCorrectionAttribution } from '../../../../../shared/session-persistence'
import { ReplayReviewRecord } from './ReplayReviewRecord'
import { ReplayCurrentContext } from './ReplayCurrentContext'
import { ReplayExecutionState } from './ReplayExecutionState'
import { ReplayResearchLayout, type ResearchReplayLayout } from './ReplayResearchLayout'
import type { RecordedExecutionState } from '@/lib/replay/recorded-execution'
import {
  lazy,
  Suspense,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parse } from 'papaparse'
import type {
  ReplayDocument,
  ReplayResource,
  ReplayRunIndex,
  ReplayScene,
  ReplayStep,
  ReplayNotebookRunDetails
} from '../../../../../shared/replay'
import type { NotebookRunRecord } from '../../../../../shared/notebook'
import { ArrowLeft, ChevronUp, ChevronDown, X, BookOpen, Files as FilesIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { getPreviewFormatForFile } from '../preview-support'
import { FileTypeIcon } from '../file-type-icon'
import { ExtensionPreservingFileName } from '../ExtensionPreservingFileName'
import {
  WorkspaceUserMessageBubble,
  WorkspaceAssistantMessageSurface,
  WorkspaceMessageTimestamp
} from '../WorkspaceTranscriptSurface'
import { HighlightedCodeLines } from '../HighlightedCodeLines'
import { NotebookRecordCell } from '../NotebookRecordCell'
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
import { useFollowScrollBottom } from '../use-follow-scroll-bottom'
import { ReplayFileRow } from './ReplayFileRow'
import { ReplayToolRecord, ReplayRecordedText, ReplayActivityGroup } from './ReplayToolRecord'
import { prepareReplayFrame, type ReplayFrameReadiness } from './replay-readiness'
import {
  ReplayPresentationContext,
  createReplayPresentation,
  replayPresentationStyle,
  useReplayTranslation,
  type ReplayPresentationConfig
} from './replay-presentation'

const ReplayFilePreview = lazy(() => import('./ReplayFilePreview'))

export const REPLAY_VIEWPORT = { width: 1280, height: 720 } as const
export type ReplayStageReadiness = ReplayFrameReadiness & {
  frameKey: string
  positionMs: number
  resourcesReady: boolean
  retryable: boolean
}
export type ReplayMaterialView = {
  id: string
  label: string
  content:
    React.ReactNode | ((active: boolean, playback?: ReplayMaterialPlayback) => React.ReactNode)
}

/** Read-only material adapters share the owning Replay's clock, never each other's state. */
export type ReplayMaterialPlayback = {
  branchId?: string
  positionMs?: number
  recordedAt?: number
  /** A compressed conversation step is an anchor, not an elapsed video clock. */
  continuous?: boolean
  playing: boolean
  speed: number
  /** Media failure pauses the owning research clock without changing its position. */
  onPause?: () => void
  onSeekRecordedAt: (recordedAt: number) => void
}

export type ReplayStageProps = {
  presentationMode?: 'research'
  researchLayout?: ResearchReplayLayout
  researchMaterialTabs?: React.ReactNode
  researchTabPanelId?: string
  focusedPaneId?: string
  onFocusPane?: (id: string) => void
  renderMaterialPane?: (id: string, content: React.ReactNode) => React.ReactNode
  selectedContentByPane?: Partial<
    Record<'conversation' | 'notebook', ReplayStageProps['selectedContent']>
  >
  selectedResourcePaneId?: string
  onBrowsePane?: (id: 'conversation' | 'notebook') => void
  onFollowPane?: (id: 'conversation' | 'notebook') => void
  selectedContent?: {
    kind: 'conversation' | 'notebook'
    stepId: string
    runId?: string
    savedHistory?: boolean
  }
  onSelectContent?: (selection: {
    kind: 'conversation' | 'notebook'
    stepId: string
    runId?: string
    savedHistory?: boolean
  }) => void
  materialPlayback?: ReplayMaterialPlayback
  executionStates?: readonly RecordedExecutionState[]
  executionNotice?: React.ReactNode
  materialViews?: readonly ReplayMaterialView[]
  materialsActive?: boolean
  materialViewId?: string
  onMaterialViewChange?: (id: string) => void
  document: ReplayDocument
  sourceIdentity?: string
  // The interactive pane uses readable responsive layout; standalone capture stays canonical.
  fitContainer?: boolean
  // Inject immutable observed evidence while retaining the shared material/file panes.
  primaryContent?: React.ReactNode
  primaryLabel?: string
  followPrimary?: boolean
  primaryMode?: 'record' | 'project'
  // Only the host following a running project can exempt its whole viewport from inspection.
  liveProjectActive?: boolean
  renderResource?: (resource: ReplayResource, onClose: () => void) => React.ReactNode
  wide?: boolean
  followNotebook?: boolean
  // Explicit play/seek restores the current conversation without persisting reader state.
  conversationFocusRequest?: number
  materialsOpen?: boolean
  materialsId?: string
  filesOpen?: boolean
  filesId?: string
  onOpenFiles?: () => void
  onCloseFiles?: () => void
  onCloseMaterials?: () => void
  onSeek?: (positionMs: number) => void
  notebookRuns?: ReplayRunIndex[]
  fileResources?: ReplayResource[]
  notebookHistoryControl?: React.ReactNode
  filesPagination?: React.ReactNode
  scene: ReplayScene
  resources?: ReplayResourceMap
  reducedMotion?: boolean
  presentation?: ReplayPresentationConfig
  preparationId?: number
  runDetails?: Readonly<Record<string, ReplayNotebookRunDetails>>
  onInspect?: () => void
  selectedResource?: ReplayResource
  onSelectResource?: (id?: string) => void
  onReady?: (readiness: ReplayStageReadiness) => void
  readinessTimeoutMs?: number
}

// Keep injected preview renderers behind a component boundary. Closing is an event action,
// never something that the stage invokes while projecting a frame.
const ReplayResourceSlot = ({
  renderResource,
  resource,
  onClose
}: {
  renderResource: NonNullable<ReplayStageProps['renderResource']>
  resource: ReplayResource
  onClose: () => void
}): React.JSX.Element => <>{renderResource(resource, onClose)}</>

// Keep simple frozen image/text/table inspection; use workspace renderers for richer formats.
const usesRichPreview = (resource: ReplayResource): boolean =>
  !['image', 'text', 'code', 'csv'].includes(getPreviewFormatForFile(resource))

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
export const ReplayMarkdown = memo(function ReplayMarkdown({
  complete = false,
  content
}: {
  content: string
  complete?: boolean
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const excerpt = complete ? content : replayExcerpt(content, 8192)
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

const ReplayCode = memo(function ReplayCode({
  code,
  language
}: {
  code: string
  language?: string
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const excerpt = replayExcerpt(code)
  return (
    <div className="space-y-2">
      <pre className="m-0 overflow-hidden rounded-lg bg-bg-200 p-4 font-mono text-[13px] leading-5">
        <code>
          <HighlightedCodeLines
            code={excerpt}
            language={language}
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
})

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

const ReplayNotebook = memo(function ReplayNotebook({
  run,
  showOutput,
  unavailableImages,
  interactive,
  index = 0
}: {
  index?: number
  interactive: boolean
  run: NotebookRunRecord
  showOutput: boolean
  unavailableImages: ReadonlySet<string>
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const figures = useMemo(() => resolveNotebookRunFigures(run), [run])
  const output = useMemo(() => notebookText(run), [run])
  const outputContent = showOutput ? (
    <>
      {interactive ? (
        output.length ? (
          <NotebookTextOutput>
            {output.slice(0, 12).map((text, index) => (
              <ReplayRecordedText key={index} text={text} scrollable />
            ))}
          </NotebookTextOutput>
        ) : null
      ) : (
        <>
          <div className="text-xs font-medium text-text-300">{t('Saved output')}</div>
          {output.slice(0, 12).map((text, index) => (
            <ReplayRecordedText key={index} text={text} />
          ))}
        </>
      )}
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
  ) : null
  return (
    <article className="space-y-3" data-replay-notebook-run={run.runId}>
      {interactive ? (
        <NotebookRecordCell
          run={run}
          index={index}
          code={replayExcerpt(run.script)}
          showResult={showOutput}
        >
          <div className="mt-3 space-y-3">{outputContent}</div>
        </NotebookRecordCell>
      ) : (
        <>
          <div className="flex items-center justify-between text-sm text-text-300">
            <span>{t('Notebook')}</span>
            <span>{run.kernelKind}</span>
          </div>
          <ReplayCode code={run.script} />
          {outputContent}
        </>
      )}
      {interactive && replayExcerpt(run.script).length < run.script.length ? (
        <p className="px-4 text-xs text-text-300">
          {t('Preview is truncated. Open the evidence for the complete record.')}
        </p>
      ) : null}
    </article>
  )
})

export const ResourceTable = ({
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
  showResults,
  interactive,
  selectable = false,
  selected = false,
  runDetails,
  artifactResources,
  resources,
  visibleResourceIds,
  onSelectResource
}: {
  resources: ReplayResourceMap
  visibleResourceIds: readonly string[]
  artifactResources: ReplayResource[]
  onSelectResource?: (id: string, element?: HTMLElement) => void
  runDetails: Readonly<Record<string, ReplayNotebookRunDetails>>
  interactive: boolean
  selectable?: boolean
  selected?: boolean
  step: ReplayStep
  active: boolean
  messageCharacters: number
  showResults: boolean
}): React.JSX.Element {
  const { t } = useReplayTranslation()
  const stepResources = useMemo(
    () =>
      artifactResources
        .filter((resource) => step.resourceIds.includes(resource.id))
        .slice(
          0,
          interactive
            ? REPLAY_TRANSCRIPT_STEP_LIMIT * REPLAY_MATERIAL_RESOURCE_LIMIT
            : REPLAY_MATERIAL_RESOURCE_LIMIT
        ),
    [artifactResources, step.resourceIds, interactive]
  )
  const message = step.message
  const content = message?.content ?? ''
  // Reconstruction is explicit. Reveal rate derives exclusively from logical scene time.
  const visible = active ? content.slice(0, messageCharacters) : content
  return (
    <article
      data-replay-step={step.id}
      data-replay-active={active || undefined}
      tabIndex={selectable ? 0 : interactive ? -1 : undefined}
      data-replay-selected={selected || undefined}
      className={
        interactive
          ? `min-w-0 py-2 outline-none focus-visible:keyboard-focus ${selected ? 'rounded-lg ring-1 ring-inset ring-border-100' : ''}`
          : `rounded-xl border p-4 ${active ? 'border-border-100 bg-bg-000' : 'border-border-200 bg-bg-10'}`
      }
    >
      {!interactive ? (
        <div className="mb-2 flex items-center justify-between text-xs text-text-300">
          <span>
            {message
              ? message.role === 'user'
                ? t('User')
                : t('Agent')
              : step.kind === 'review'
                ? t('Session Reviewer')
                : step.kind === 'notebook'
                  ? t('Notebook')
                  : step.kind === 'artifact'
                    ? t('Files')
                    : t('Tool activity')}
          </span>
          <span>{archivedTime(step.recordedAt) ?? t('Time not recorded')}</span>
        </div>
      ) : null}
      {step.review ? <ReplayReviewRecord review={step.review} showResults={showResults} /> : null}
      {message && isReviewerCorrectionAttribution(message.attribution) ? (
        <p className="mb-1 text-xs font-medium text-text-300">
          {t('Reviewer requested corrections')}
        </p>
      ) : null}
      {message ? (
        interactive ? (
          message.role === 'user' ? (
            <div className="flex min-w-0 flex-col items-end">
              <WorkspaceUserMessageBubble>
                <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {replayExcerpt(visible, 8192)}
                </div>
                {visible.length > replayExcerpt(visible, 8192).length ? (
                  <p className="mt-1 text-xs text-text-300">
                    {t('Preview is truncated. Open the evidence for the complete record.')}
                  </p>
                ) : null}
              </WorkspaceUserMessageBubble>
              {step.recordedAt !== undefined && archivedTime(step.recordedAt) ? (
                <div className="mt-1 flex min-h-6 w-full items-center justify-end text-[11px] leading-4 text-text-000/70 tabular-nums">
                  <WorkspaceMessageTimestamp label={t('Sent')} date={new Date(step.recordedAt)} />
                </div>
              ) : null}
            </div>
          ) : (
            <WorkspaceAssistantMessageSurface>
              <ReplayMarkdown content={visible} />
            </WorkspaceAssistantMessageSurface>
          )
        ) : (
          <ReplayMarkdown content={visible} />
        )
      ) : null}
      {interactive && step.activities.length ? (
        <ReplayActivityGroup step={step} showResults={showResults} runDetails={runDetails} />
      ) : (
        step.activities
          .slice(0, REPLAY_ACTIVITY_LIMIT)
          .map((activity) => (
            <ReplayToolRecord key={activity.id} activity={activity} showResults={showResults} />
          ))
      )}
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
      {interactive && step.kind === 'artifact' && stepResources.length ? (
        <div className="mt-3 border-t border-border-200 pt-3">
          <div className="mb-2 text-[11px] font-medium uppercase text-text-300">
            {t('GENERATED · {{count}}', { count: stepResources.length })}
          </div>
          <div className={artifactGalleryClassName}>
            {stepResources.map((resource) => {
              const prepared = resources[resource.id]
              const revealed = visibleResourceIds.includes(resource.id)
              const name =
                resource.versionNumber === undefined
                  ? resource.name
                  : `${resource.name} (${t('Version {{version}}', { version: resource.versionNumber })})`
              return (
                <GeneratedFileCard
                  key={resource.id}
                  name={resource.name}
                  sizeLabel={formatByteSize(resource.size)}
                  label={t('Preview generated file {{name}}', { name })}
                  title={name}
                  disabled={!revealed || !onSelectResource}
                  onClick={(event) => onSelectResource?.(resource.id, event.currentTarget)}
                  preview={
                    revealed && prepared?.status === 'ready' && prepared.kind === 'image' ? (
                      <img
                        src={prepared.content}
                        alt={resource.name}
                        className="size-full object-contain"
                        decoding="async"
                      />
                    ) : (
                      <span className="flex size-full items-center justify-center">
                        <FileTypeIcon name={resource.name} mimeType={resource.mimeType} />
                      </span>
                    )
                  }
                />
              )
            })}
          </div>
        </div>
      ) : !message && !step.activities.length && !step.review ? (
        <p className="text-sm">
          {step.title ??
            (step.runs.length ? t('Saved Notebook execution') : t('Recorded file version'))}
        </p>
      ) : null}
    </article>
  )
})

// Keep the visible record stable through prepending and asynchronous run/figure layout.
// Release the anchor as soon as the reader starts another interaction.
const usePrependAnchor = (
  getViewport: () => HTMLDivElement | null,
  selector: string,
  resetKey: string
): readonly [() => void, () => void] => {
  const anchor = useRef<{ element: HTMLElement; top: number }>(undefined)
  useLayoutEffect(() => {
    anchor.current = undefined
  }, [resetKey])
  useLayoutEffect(() => {
    const restore = (): void => {
      const saved = anchor.current
      const viewport = getViewport()
      if (saved?.element.isConnected && viewport)
        viewport.scrollTop += saved.element.getBoundingClientRect().top - saved.top
    }
    restore()
    if (!anchor.current) return
    const content = getViewport()?.firstElementChild
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(restore)
    if (content) observer?.observe(content)
    return () => observer?.disconnect()
  })
  return [
    () => {
      const container = getViewport()
      if (!container) return
      const top = container.getBoundingClientRect().top
      const element = Array.from(container.querySelectorAll<HTMLElement>(selector)).find(
        (record) => record.getBoundingClientRect().bottom > top
      )
      if (element) anchor.current = { element, top: element.getBoundingClientRect().top }
    },
    () => {
      anchor.current = undefined
    }
  ]
}

const ReplayStageContent = ({
  document: replayDocument,
  fitContainer = false,
  presentationMode,
  researchLayout,
  researchMaterialTabs,
  researchTabPanelId,
  focusedPaneId,
  onFocusPane,
  renderMaterialPane,
  selectedContentByPane,
  selectedResourcePaneId,
  onBrowsePane,
  onFollowPane,
  onSelectContent,
  selectedContent,
  primaryContent,
  primaryLabel,
  followPrimary = true,
  primaryMode,
  liveProjectActive = false,
  renderResource,
  scene,
  resources = {},
  reducedMotion = false,
  presentation = createReplayPresentation(),
  preparationId = 0,
  runDetails = {},
  onInspect,
  selectedResource,
  wide = false,
  followNotebook = false,
  conversationFocusRequest = 0,
  materialsOpen = false,
  materialsId,
  materialViews,
  materialPlayback,
  executionStates,
  executionNotice,
  materialsActive = true,
  materialViewId = 'notebook',
  onMaterialViewChange,
  filesOpen = false,
  filesId,
  onOpenFiles,
  onCloseFiles,
  onCloseMaterials,
  onSeek,
  notebookRuns,
  fileResources,
  notebookHistoryControl,
  filesPagination,
  onSelectResource,
  onReady,
  readinessTimeoutMs
}: ReplayStageProps): React.JSX.Element => {
  const { t } = useReplayTranslation()
  const researchPresentation = presentationMode === 'research' && fitContainer && !primaryContent
  const effectiveResearchLayout: ResearchReplayLayout = researchLayout ?? {
    mode: 'tabs',
    visiblePaneIds: [materialViewId]
  }
  const isPaneVisible = (id: string): boolean => effectiveResearchLayout.visiblePaneIds.includes(id)
  const conversationSelection = selectedContentByPane?.conversation ?? selectedContent
  const notebookSelection = selectedContentByPane?.notebook ?? selectedContent
  const stage = useRef<HTMLDivElement>(null)
  const captureTranscript = useRef<HTMLDivElement>(null)
  const material = useRef<HTMLDivElement>(null)
  const notebookViewport = useRef<HTMLDivElement>(null)
  const filesViewport = useRef<HTMLDivElement>(null)
  const filesPane = useRef<HTMLElement>(null)
  const [resourceOrigin, setResourceOrigin] = useState<{
    kind: 'conversation' | 'materials' | 'files'
    paneId?: string
    element?: HTMLElement
    scrollTop: number
    notebookScrollTop: number
    filesScrollTop: number
  }>()
  const resourcePaneId =
    selectedResourcePaneId ?? resourceOrigin?.paneId ?? focusedPaneId ?? 'results'
  const [preparation, setPreparation] = useState<{ key: string; result: ReplayFrameReadiness }>()
  const [paintedFrame, setPaintedFrame] = useState<{
    key: string
    preparation: typeof preparation
  }>()
  const [failedImages, setFailedImages] = useState(new Set<string>())
  const readyCallback = useRef(onReady)
  useLayoutEffect(() => {
    readyCallback.current = onReady
  }, [onReady])
  const [fullHistory, setFullHistory] = useState(false)
  const [historyPage, setHistoryPage] = useState(0)
  const [historyStart, setHistoryStart] = useState<number>()
  const [browsingConversation, setBrowsingConversation] = useState(false)
  const [returnRequest, setReturnRequest] = useState(0)
  const focusKey = `${scene.branchId}:${conversationFocusRequest}`
  const [previousFocusKey, setPreviousFocusKey] = useState(focusKey)
  if (previousFocusKey !== focusKey) {
    setPreviousFocusKey(focusKey)
    setHistoryStart(undefined)
    setBrowsingConversation(false)
    setFullHistory(false)
  }
  const followingTranscript = useFollowScrollBottom(
    fitContainer &&
      followPrimary &&
      (researchPresentation
        ? isPaneVisible('conversation') && !(selectedResource && resourcePaneId === 'conversation')
        : wide || !materialsOpen) &&
      historyStart === undefined &&
      !fullHistory,
    {
      onFollowingChange: (following) => {
        setBrowsingConversation(!following)
        if (primaryContent && !following) onInspect?.()
        else if (researchPresentation && !following) onBrowsePane?.('conversation')
      },
      resetKey: `${focusKey}:${returnRequest}`
    }
  )
  const transcript = fitContainer ? followingTranscript : captureTranscript
  useLayoutEffect(() => {
    if (primaryMode === 'project' && transcript.current) transcript.current.scrollTop = 0
  }, [primaryMode, transcript])
  const [rememberConversationAnchor, releaseConversationAnchor] = usePrependAnchor(
    () => transcript.current,
    '[data-replay-step]',
    `${focusKey}:${returnRequest}`
  )
  const [rememberNotebookAnchor, releaseNotebookAnchor] = usePrependAnchor(
    () => notebookViewport.current,
    '[data-replay-run-item]',
    focusKey
  )
  const transcriptStart = fitContainer
    ? (historyStart ?? Math.max(0, scene.visibleSteps.length - REPLAY_TRANSCRIPT_STEP_LIMIT))
    : Math.max(0, scene.visibleSteps.length - REPLAY_TRANSCRIPT_STEP_LIMIT)
  const notebookIndices = useMemo(() => {
    const indices = new Map<string, number>()
    for (const branch of replayDocument.branches)
      for (const step of branch.steps)
        for (const run of step.runs)
          if (!indices.has(run.runId)) indices.set(run.runId, indices.size)
    return indices
  }, [replayDocument])
  const branchMaterials = useMemo(() => {
    const steps =
      replayDocument.branches.find((branch) => branch.id === scene.branchId)?.steps ?? []
    return {
      notebook: steps.some((step) => step.runs.length > 0),
      files: steps.some((step) => step.resourceIds.length > 0),
      first: steps.find((step) => step.runs.length || step.resourceIds.length)
    }
  }, [replayDocument, scene.branchId])
  const active = scene.step
  const branchSteps = useMemo(
    () => replayDocument.branches.find((item) => item.id === scene.branchId)?.steps ?? [],
    [replayDocument, scene.branchId]
  )
  const historicalMessages = useMemo(
    () => branchSteps.filter((step) => step.message),
    [branchSteps]
  )
  const lastHistoryPage = Math.max(
    0,
    Math.ceil(historicalMessages.length / REPLAY_TRANSCRIPT_STEP_LIMIT) - 1
  )
  const effectiveHistoryPage = Math.min(historyPage, lastHistoryPage)
  const transcriptSteps = useMemo(() => {
    const rows: ReplayStep[] = []
    const isGallery = (step: ReplayStep): boolean =>
      fitContainer &&
      step.kind === 'artifact' &&
      !step.message &&
      !step.review &&
      !step.activities.length &&
      !step.runs.length &&
      !step.issues.length
    const visible = fullHistory
      ? historicalMessages.slice(
          effectiveHistoryPage * REPLAY_TRANSCRIPT_STEP_LIMIT,
          (effectiveHistoryPage + 1) * REPLAY_TRANSCRIPT_STEP_LIMIT
        )
      : scene.visibleSteps.slice(transcriptStart)
    for (const step of visible) {
      const previous = rows.at(-1)
      if (previous && isGallery(previous) && isGallery(step)) {
        // A view-only grouping, preserving the active step's identity and reveal boundary.
        rows[rows.length - 1] = {
          ...step,
          resourceIds: [...new Set([...previous.resourceIds, ...step.resourceIds])]
        }
      } else rows.push(step)
    }
    return rows
  }, [
    fitContainer,
    transcriptStart,
    scene.visibleSteps,
    fullHistory,
    effectiveHistoryPage,
    historicalMessages
  ])
  const materialStep = [...scene.visibleSteps]
    .reverse()
    .find((step) => step.runs.length || step.resourceIds.length)
  const inspecting = Boolean(selectedResource)
  const notebookInspecting = inspecting && (!researchPresentation || resourcePaneId === 'notebook')
  const hasMaterial = Boolean(materialStep) || inspecting
  const showMaterialPane = materialsOpen && (researchPresentation || !fullHistory)
  const materialRuns =
    selectedResource && !fitContainer
      ? []
      : fitContainer
        ? (notebookRuns ??
          scene.visibleSteps
            .flatMap((step) => step.runs.slice(0, REPLAY_MATERIAL_RUN_LIMIT))
            .slice(-REPLAY_MATERIAL_RUN_LIMIT))
        : (materialStep?.runs.slice(0, REPLAY_MATERIAL_RUN_LIMIT) ?? [])
  const noMaterials =
    fitContainer &&
    !materialRuns.length &&
    !(fileResources?.length ?? scene.visibleResourceIds.length)
  const notebookVisible = isPaneVisible('notebook')
  const latestNotebookRunId = materialRuns.at(-1)?.runId
  const contextRunId = scene.step?.runs.length === 1 ? scene.step.runs[0].runId : undefined
  const contextExecution = contextRunId
    ? executionStates?.find((state) => state.track.runId === contextRunId)
    : undefined
  const resourceIds = (materialStep?.resourceIds ?? [])
    .slice(0, REPLAY_MATERIAL_RESOURCE_LIMIT)
    .filter((id) => scene.visibleResourceIds.includes(id))
  const selectedResources = selectedResource
    ? [selectedResource]
    : fitContainer
      ? []
      : replayDocument.resources.filter((resource) => resourceIds.includes(resource.id))
  const readinessResources = selectedResources.filter(
    (resource) => !fitContainer || !usesRichPreview(resource)
  )
  const resourcesSettled = readinessResources.every(
    (resource) => resources[resource.id] !== undefined
  )
  const runsSettled = materialRuns.every((run) => runDetails[run.runId] !== undefined)
  const showOutput = inspecting || materialStep?.id !== active?.id || scene.showResults
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
  const frameReady =
    readiness.ready &&
    (fitContainer || (paintedFrame?.key === frameKey && paintedFrame.preparation === preparation))
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
          ...readinessResources
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
    const element = captureTranscript.current
    if (element && !fitContainer) {
      const current = element.querySelector<HTMLElement>('[data-replay-active]')
      const start = current ? Math.max(0, current.offsetTop - element.offsetTop - 16) : 0
      const overflow = current ? Math.max(0, current.scrollHeight - element.clientHeight + 32) : 0
      element.scrollTop = Math.min(
        element.scrollHeight - element.clientHeight,
        start + overflow * (reducedMotion ? 1 : scene.stepProgress)
      )
    }
    const viewport = fitContainer ? notebookViewport.current : material.current
    if (!viewport) return
    if (!fitContainer) {
      viewport.scrollTop =
        Math.max(0, viewport.scrollHeight - viewport.clientHeight) *
        (reducedMotion ? 0 : scene.stepProgress)
      return
    }
    // Follow the recorded Notebook cell, not the Files list below it. Manual inspection
    // suspends this in the owner; explicit play/seek resumes without moving pane chrome.
    if (
      (researchPresentation ? !notebookVisible : !wide || !materialsOpen) ||
      !followNotebook ||
      notebookInspecting
    )
      return
    const current = Array.from(
      viewport.querySelectorAll<HTMLElement>('[data-replay-notebook-run]')
    ).find((node) => node.dataset.replayNotebookRun === latestNotebookRunId)
    if (!current || current.closest('details')?.open === false) return
    const start = Math.max(
      0,
      current.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop -
        16
    )
    const overflow = Math.max(0, current.scrollHeight - viewport.clientHeight + 32)
    const progress = active?.runs.some((run) => run.runId === latestNotebookRunId)
      ? scene.stepProgress
      : 1
    viewport.scrollTop = Math.min(
      viewport.scrollHeight - viewport.clientHeight,
      start + overflow * progress
    )
  }, [
    scene.positionMs,
    scene.stepProgress,
    frameKey,
    reducedMotion,
    preparation,
    fitContainer,
    showMaterialPane,
    selectedResource,
    inspecting,
    notebookInspecting,
    notebookVisible,
    wide,
    researchPresentation,
    materialsOpen,
    followNotebook,
    latestNotebookRunId,
    active?.runs
  ])

  useLayoutEffect(() => {
    // Interactive playback needs settled resources, not the export compositor barrier.
    if (fitContainer || !readiness.ready) return
    let committed = 0
    // Native capturePage can otherwise return the previous scroll compositor frame even after
    // React layout effects finish. Cross a paint boundary after the exact frame's layout and any
    // timeout placeholders commit. A subsequent seek cancels both callbacks and invalidates ready.
    const paint = requestAnimationFrame(() => {
      committed = requestAnimationFrame(() => setPaintedFrame({ key: frameKey, preparation }))
    })
    return () => {
      cancelAnimationFrame(paint)
      cancelAnimationFrame(committed)
    }
  }, [fitContainer, frameKey, preparation, readiness.ready])

  useLayoutEffect(() => {
    readyCallback.current?.({
      ...readiness,
      ready: frameReady,
      resourcesReady: readiness.ready,
      retryable:
        readiness.diagnostics.some((item) => /^(?:timeout|unavailable):/.test(item)) ||
        selectedResources.some((resource) => {
          const value = resources[resource.id]
          return (
            value?.status === 'timeout' ||
            (value?.status === 'unavailable' && value.reason === 'read-failed')
          )
        }) ||
        materialRuns.some((run) => {
          const value = runDetails[run.runId]
          return value?.status === 'unavailable' && value.reason === 'load-failed'
        }),
      frameKey,
      positionMs: scene.positionMs
    })
    // Playback needs resource readiness; capture additionally needs the committed paint boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey, preparation, frameReady])

  const selectResource = useCallback(
    (id: string, originElement?: HTMLElement): void => {
      const element = originElement ?? stage.current?.ownerDocument.activeElement
      const fromConversation =
        element instanceof HTMLElement && transcript.current?.contains(element)
      if (!inspecting)
        setResourceOrigin({
          kind: fromConversation
            ? 'conversation'
            : filesPane.current?.contains(element ?? null)
              ? 'files'
              : 'materials',
          paneId:
            element instanceof HTMLElement
              ? element.closest<HTMLElement>('[data-replay-pane]')?.dataset.replayPane
              : undefined,
          element: element instanceof HTMLElement ? element : undefined,
          scrollTop: (fromConversation ? transcript.current : material.current)?.scrollTop ?? 0,
          notebookScrollTop: notebookViewport.current?.scrollTop ?? 0,
          filesScrollTop: filesViewport.current?.scrollTop ?? 0
        })
      onSelectResource?.(id)
    },
    [onSelectResource, transcript, inspecting]
  )
  const closeResource = (): void => {
    onSelectResource?.()
    if (!researchPresentation || resourceOrigin?.kind === 'files') onOpenFiles?.()
    if (resourceOrigin && resourceOrigin.kind !== 'conversation')
      requestAnimationFrame(() => {
        if (material.current) material.current.scrollTop = resourceOrigin.scrollTop
        if (notebookViewport.current)
          notebookViewport.current.scrollTop = resourceOrigin.notebookScrollTop
        if (filesViewport.current) filesViewport.current.scrollTop = resourceOrigin.filesScrollTop
        if (resourceOrigin.element?.isConnected)
          resourceOrigin.element.focus({ preventScroll: true })
      })
  }
  useLayoutEffect(() => {
    if (!researchPresentation && inspecting && material.current) {
      material.current.scrollTop = 0
      material.current.focus()
    }
  }, [selectedResource, inspecting, researchPresentation])
  const returnToOrigin = (): void => {
    if (resourceOrigin?.kind !== 'conversation') {
      closeResource()
      return
    }
    onSelectResource?.()
    requestAnimationFrame(() => {
      const origin = resourceOrigin
      if (origin && transcript.current) transcript.current.scrollTop = origin.scrollTop
      if (origin && notebookViewport.current)
        notebookViewport.current.scrollTop = origin.notebookScrollTop
      ;(origin?.element?.isConnected ? origin.element : transcript.current)?.focus({
        preventScroll: true
      })
    })
  }
  const style = replayPresentationStyle(presentation)
  const isLiveInteraction = (target: EventTarget): boolean =>
    target instanceof Element && Boolean(target.closest('[data-replay-live-interaction]'))
  const isMaterialViewInteraction = (target: EventTarget): boolean =>
    target instanceof Element && Boolean(target.closest('button[data-replay-material-view]'))
  const isLayoutInteraction = (target: EventTarget): boolean =>
    target instanceof Element &&
    Boolean(target.closest('[data-replay-layout-control], [data-replay-layout-chrome]'))
  const browseResearchPane = (target: EventTarget): void => {
    if (!(target instanceof Element)) return
    const pane = target.closest<HTMLElement>('[data-replay-pane]')?.dataset.replayPane
    if (pane === 'conversation') releaseConversationAnchor()
    if (pane === 'notebook') {
      releaseNotebookAnchor()
      onBrowsePane?.('notebook')
    }
  }
  // Viewport padding must still handle host dismissal while leaving the project live.
  const isLiveProjectViewportInteraction = (target: EventTarget): boolean =>
    liveProjectActive && target instanceof Node && Boolean(transcript.current?.contains(target))
  const conversationHistoryControl = (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-200 px-3 py-1 text-xs">
      <span>{t('Browsing saved history; playback position is unchanged.')}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={effectiveHistoryPage === 0}
        onClick={() => {
          setHistoryPage(effectiveHistoryPage - 1)
        }}
      >
        {t('Previous page')}
      </Button>
      <span>
        {t('Page {{current}} of {{total}}', {
          current: effectiveHistoryPage + 1,
          total: lastHistoryPage + 1
        })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={effectiveHistoryPage === lastHistoryPage}
        onClick={() => {
          setHistoryPage(effectiveHistoryPage + 1)
        }}
      >
        {t('Next page')}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setFullHistory(false)
          setHistoryStart(undefined)
          setBrowsingConversation(false)
          setReturnRequest((request) => request + 1)
          onFollowPane?.('conversation')
        }}
      >
        {t('Follow playback')}
      </Button>
    </div>
  )
  const conversationPane = (
    <section
      key={fullHistory ? `history:${historyPage}` : 'following'}
      ref={transcript}
      aria-label={primaryLabel ?? t('Historical conversation')}
      data-replay-following={
        researchPresentation ? !browsingConversation && !fullHistory : undefined
      }
      tabIndex={0}
      className={
        fitContainer
          ? `relative min-h-0 min-w-0 flex-1 overflow-auto border-border-200 bg-bg-000 ${primaryMode === 'project' ? 'px-3 py-1' : 'px-4 py-3'} ${!researchPresentation && ((showMaterialPane && !wide) || inspecting) ? 'hidden' : 'block'}`
          : 'relative space-y-3 overflow-auto border-r border-border-200 bg-bg-10 p-5'
      }
      // Interactive history has its own follow and prepend anchors. Native anchoring can
      // pull the viewport upward when older rows leave the bounded playback window.
      style={{
        scrollbarWidth: fitContainer ? undefined : 'none',
        overflowAnchor: fitContainer ? 'none' : undefined
      }}
    >
      {primaryContent ?? (
        <div className={fitContainer ? 'space-y-1' : 'space-y-3'}>
          {fitContainer && !fullHistory && transcriptStart > 0 ? (
            <div className="flex justify-center py-2 [overflow-anchor:none]">
              <Button
                variant="secondary"
                data-replay-load-messages
                className="max-w-full gap-1.5"
                onClick={() => {
                  rememberConversationAnchor()
                  if (researchPresentation) onBrowsePane?.('conversation')
                  else onInspect?.()
                  setBrowsingConversation(true)
                  setHistoryStart(Math.max(0, transcriptStart - REPLAY_TRANSCRIPT_STEP_LIMIT))
                  requestAnimationFrame(() => {
                    const viewport = transcript.current
                    ;(
                      viewport?.querySelector<HTMLElement>('[data-replay-load-messages]') ??
                      viewport?.querySelector<HTMLElement>('[data-replay-step]')
                    )?.focus({ preventScroll: true })
                  })
                }}
              >
                <ChevronUp size={14} aria-hidden="true" />
                {t('Load earlier messages')}
              </Button>
            </div>
          ) : null}
          {transcriptSteps.map((step) => (
            <StepConversation
              interactive={fitContainer}
              selectable={researchPresentation}
              selected={
                researchPresentation &&
                conversationSelection?.kind === 'conversation' &&
                conversationSelection.stepId === step.id
              }
              artifactResources={replayDocument.resources}
              resources={resources}
              visibleResourceIds={scene.visibleResourceIds}
              onSelectResource={onSelectResource ? selectResource : undefined}
              runDetails={runDetails}
              key={step.id}
              step={step}
              active={!fullHistory && step.id === active?.id}
              messageCharacters={
                !fullHistory && step.id === active?.id ? scene.messageCharacters : 0
              }
              showResults={
                fullHistory
                  ? true
                  : materialPlayback?.continuous && materialPlayback.recordedAt !== undefined
                    ? step.recordedEndAt === undefined ||
                      step.recordedEndAt <= materialPlayback.recordedAt
                    : step.id !== active?.id || scene.showResults
              }
            />
          ))}
          {fitContainer && browsingConversation && !fullHistory ? (
            <div className="sticky bottom-0 flex justify-center py-2 [overflow-anchor:none]">
              <Button
                variant="secondary"
                className="max-w-full gap-1.5 shadow-sm"
                onClick={() => {
                  setHistoryStart(undefined)
                  setBrowsingConversation(false)
                  setReturnRequest((request) => request + 1)
                  onFollowPane?.('conversation')
                  requestAnimationFrame(() => {
                    transcript.current
                      ?.querySelector<HTMLElement>('[data-replay-active]')
                      ?.focus({ preventScroll: true })
                  })
                }}
              >
                <ChevronDown size={14} aria-hidden="true" />
                {t('Return to current step')}
              </Button>
            </div>
          ) : null}
          {!scene.visibleSteps.length ? (
            <p className="p-4 text-text-300">{t('No recorded steps are available.')}</p>
          ) : null}
        </div>
      )}
    </section>
  )
  const notebookPane = (
    <div
      className={
        fitContainer
          ? researchPresentation || materialViewId === 'notebook' || inspecting
            ? 'flex min-h-0 flex-1 flex-col'
            : 'hidden'
          : 'contents'
      }
    >
      {researchPresentation && !followNotebook && materialRuns.length ? (
        <div className="flex shrink-0 justify-center border-b border-border-200 p-1">
          <Button variant="secondary" size="sm" onClick={() => onFollowPane?.('notebook')}>
            {t('Follow playback')}
          </Button>
        </div>
      ) : null}
      {!fitContainer &&
      !inspecting &&
      materialStep?.id === active?.id &&
      scene.phase === 'activity' ? (
        <div className="space-y-2 text-xs text-text-300" data-replay-reconstructed-activity="true">
          <span>{t('Reconstructed activity')}</span>
          <div className="h-1 overflow-hidden rounded bg-bg-200">
            <div
              className="h-full bg-text-300"
              style={{ width: `${Math.max(0, Math.min(100, scene.stepProgress * 100))}%` }}
            />
          </div>
        </div>
      ) : null}
      {noMaterials && !inspecting ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-4 text-sm text-text-300">
          <p>
            {branchMaterials.first
              ? t('No materials at this point.')
              : t('No materials recorded in this branch.')}
          </p>
          {branchMaterials.first && onSeek ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const first = branchMaterials.first!
                onSeek(first.endMs)
                requestAnimationFrame(() => {
                  const heading = stage.current?.querySelector<HTMLElement>(
                    first.runs.length
                      ? '[data-replay-notebook-heading]'
                      : '[data-replay-files-heading]'
                  )
                  if (!first.runs.length) onOpenFiles?.()
                  heading?.focus()
                })
              }}
            >
              {t('Jump to first material')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        ref={notebookViewport}
        data-replay-notebook-scroll
        hidden={fitContainer && ((!researchPresentation && inspecting) || noMaterials)}
        className={fitContainer ? 'min-h-0 flex-1 overflow-auto' : 'contents'}
      >
        <div className={fitContainer ? undefined : 'space-y-5'}>
          {fitContainer ? (
            <div onClickCapture={rememberNotebookAnchor}>{notebookHistoryControl}</div>
          ) : null}
          {executionNotice ? <div className="p-3">{executionNotice}</div> : null}
          {materialRuns.map((index, runOffset) => {
            const execution = executionStates?.find((state) => state.track.runId === index.runId)
            const executionContent = execution ? (
              <ReplayExecutionState
                state={execution}
                detail
                waiting={Boolean(
                  execution.snapshot &&
                  materialPlayback?.recordedAt !== undefined &&
                  materialPlayback.recordedAt > execution.snapshot.observedAt
                )}
              />
            ) : executionStates !== undefined ? (
              <p className="text-xs text-text-300">
                {t('No linked intermediate observations are available for this run.')}
              </p>
            ) : null
            const executionComplete =
              materialPlayback?.recordedAt !== undefined &&
              index.endedAt !== undefined &&
              materialPlayback.recordedAt >= index.endedAt
            const detail = runDetails[index.runId]
            const content =
              detail?.status === 'ready' ? (
                <ReplayNotebook
                  interactive={fitContainer}
                  key={index.runId}
                  run={detail.run}
                  index={notebookIndices.get(index.runId) ?? runOffset}
                  showOutput={
                    fullHistory && !researchPresentation
                      ? true
                      : materialPlayback?.continuous && materialPlayback.recordedAt !== undefined
                        ? index.endedAt !== undefined &&
                          index.endedAt <= materialPlayback.recordedAt
                        : fitContainer
                          ? !active?.runs.some((run) => run.runId === index.runId) ||
                            scene.showResults
                          : showOutput
                  }
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
            return fitContainer ? (
              <div
                key={index.runId}
                data-replay-run-item={index.runId}
                tabIndex={researchPresentation ? 0 : undefined}
                className={
                  researchPresentation
                    ? 'outline-none focus-visible:keyboard-focus data-[replay-selected]:ring-1 data-[replay-selected]:ring-inset data-[replay-selected]:ring-border-100'
                    : undefined
                }
                data-replay-selected={
                  (researchPresentation &&
                    notebookSelection?.kind === 'notebook' &&
                    (!notebookSelection.runId || notebookSelection.runId === index.runId) &&
                    branchSteps
                      .find((step) => step.id === notebookSelection.stepId)
                      ?.runs.some((run) => run.runId === index.runId)) ||
                  undefined
                }
              >
                {content}
                {executionContent ? (
                  <div className="border-t border-border-200 px-4 py-3">
                    {executionComplete ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-text-300">
                          {t('Saved execution observations')}
                        </summary>
                        <div className="mt-2">{executionContent}</div>
                      </details>
                    ) : (
                      executionContent
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              content
            )
          })}
          {fitContainer && !materialRuns.length ? (
            <p className="p-4 text-sm text-text-300">
              {replayDocument.issues.some((issue) => issue.code === 'notebook-unavailable')
                ? t('Recorded Notebook details are unavailable.')
                : branchMaterials.notebook
                  ? t('No Notebook runs at this point.')
                  : t('No Notebook runs recorded in this branch.')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
  const resourcePreview = (
    <>
      {selectedResources.map((resource) => {
        const prepared = resources[resource.id]
        return (
          <article
            key={resource.id}
            className={fitContainer ? 'flex min-h-0 flex-1 flex-col' : 'space-y-3'}
            data-replay-artifact-version={resource.versionId}
          >
            <div
              className={
                fitContainer
                  ? 'sticky top-0 z-10 flex h-9 min-w-0 shrink-0 items-center gap-2 border-b border-border-200 bg-bg-000 px-3 text-sm font-medium'
                  : 'flex min-w-0 items-center gap-2 text-sm font-medium'
              }
            >
              {fitContainer && inspecting ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={returnToOrigin}
                        aria-label={
                          resourceOrigin?.kind === 'conversation'
                            ? t('Back to conversation')
                            : t('Back to files')
                        }
                      >
                        <ArrowLeft size={16} aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="start">
                      {resourceOrigin?.kind === 'conversation'
                        ? t('Back to conversation')
                        : t('Back to files')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
              {fitContainer ? (
                <FileTypeIcon name={resource.name} mimeType={resource.mimeType} />
              ) : null}
              {fitContainer ? (
                <span className="min-w-0 flex-1">
                  <ExtensionPreservingFileName name={resource.name} />
                </span>
              ) : (
                <span className="break-all">{resource.name}</span>
              )}
              {resource.versionNumber !== undefined ? (
                <span
                  className={
                    fitContainer
                      ? 'shrink-0 text-xs font-normal text-muted-foreground'
                      : 'shrink-0 text-xs text-text-300'
                  }
                >
                  {t('Version {{version}}', { version: resource.versionNumber })}
                </span>
              ) : null}
              {fitContainer ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('Close preview')}
                        onClick={returnToOrigin}
                      >
                        <X size={16} aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="end">
                      {t('Close preview')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
            </div>
            <div
              className={
                fitContainer
                  ? usesRichPreview(resource)
                    ? 'relative min-h-0 flex-1 overflow-hidden'
                    : 'min-h-0 flex-1 space-y-3 overflow-auto p-4 [&>img]:mx-auto [&>img]:max-h-none'
                  : 'contents'
              }
            >
              {fitContainer &&
              inspecting &&
              usesRichPreview(resource) &&
              resource.availability === 'recorded' &&
              resource.versionId &&
              (resource.locator || renderResource) ? (
                <Suspense
                  fallback={
                    <p className="p-4 text-sm text-text-300">{t('Preparing recorded material…')}</p>
                  }
                >
                  {renderResource ? (
                    <ReplayResourceSlot
                      renderResource={renderResource}
                      resource={resource}
                      onClose={returnToOrigin}
                    />
                  ) : (
                    <ReplayFilePreview resource={resource} onClose={returnToOrigin} />
                  )}
                </Suspense>
              ) : prepared?.status === 'ready' ? (
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
            </div>
          </article>
        )
      })}
    </>
  )
  const researchPane = (id: string, content: React.ReactNode): React.ReactNode => (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className={
          inspecting && resourcePaneId === id
            ? 'hidden'
            : 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
        }
      >
        {content}
      </div>
      {inspecting && resourcePaneId === id ? (
        <div
          data-replay-resource-preview
          className="absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col bg-bg-000"
        >
          {resourcePreview}
        </div>
      ) : null}
    </div>
  )
  const researchPanes = researchPresentation
    ? [
        {
          id: 'conversation',
          label: t('Original conversation'),
          content: researchPane(
            'conversation',
            <>
              {fullHistory ? conversationHistoryControl : null}
              {conversationPane}
            </>
          )
        },
        { id: 'notebook', label: t('Notebook'), content: researchPane('notebook', notebookPane) },
        ...(materialViews ?? []).map((view) => {
          const content = researchPane(
            view.id,
            typeof view.content === 'function'
              ? view.content(
                  materialsActive &&
                    isPaneVisible(view.id) &&
                    !(inspecting && resourcePaneId === view.id),
                  materialPlayback
                )
              : view.content
          )
          return {
            id: view.id,
            label: view.label,
            content: renderMaterialPane ? renderMaterialPane(view.id, content) : content
          }
        })
      ]
    : []
  const filesCatalog = fitContainer ? (
    <aside
      ref={filesPane}
      id={filesId}
      aria-label={t('Files')}
      tabIndex={-1}
      hidden={!filesOpen}
      className={
        wide && !researchPresentation
          ? 'flex min-h-0 min-w-0 flex-col border-l border-border-200 bg-bg-000'
          : 'absolute inset-y-2 right-2 z-20 flex w-80 max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-lg border border-border-200 bg-bg-000 shadow-lg'
      }
    >
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border-200 px-3">
        <h2
          tabIndex={-1}
          data-replay-files-heading
          className="flex items-center gap-2 text-sm font-medium"
        >
          <FilesIcon size={16} aria-hidden="true" />
          {t('Files')}
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label={t('Close files')} onClick={onCloseFiles}>
          <X size={14} aria-hidden="true" />
        </Button>
      </div>
      <div
        ref={filesViewport}
        data-replay-files-scroll
        className="min-h-0 flex-1 space-y-1 overflow-auto p-2"
      >
        {filesPagination}
        {!(fileResources?.length ?? scene.visibleResourceIds.length) ? (
          <p className="p-1 text-sm text-text-300">
            {branchMaterials.files
              ? t('No files at this point.')
              : t('No files recorded in this branch.')}
          </p>
        ) : null}
        {(
          fileResources ??
          replayDocument.resources
            .filter((resource) => scene.visibleResourceIds.includes(resource.id))
            .slice(-REPLAY_MATERIAL_RESOURCE_LIMIT)
        ).map((resource) => (
          <ReplayFileRow
            compact
            selected={selectedResource?.id === resource.id}
            key={resource.id}
            resource={resource}
            onSelect={(event) => selectResource(resource.id, event.currentTarget)}
          />
        ))}
      </div>
    </aside>
  ) : null
  return (
    <div
      ref={stage}
      style={fitContainer ? { ...style, width: '100%', height: '100%' } : style}
      data-replay-layout={
        researchPresentation ? 'research' : fitContainer ? 'interactive' : 'capture'
      }
      data-testid="replay-stage"
      data-replay-frame-ready={frameReady}
      data-replay-frame-key={frameKey}
      data-replay-preparation={preparationId}
      lang={presentation.locale}
      data-replay-position={scene.positionMs}
      data-replay-branch={scene.branchId}
      className="@container/replay flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden bg-bg-000 text-text-100"
      onFocusCapture={(event) => {
        if (
          !researchPresentation ||
          isLayoutInteraction(event.target) ||
          !(event.target instanceof Element) ||
          !event.target.matches(':focus-visible')
        )
          return
        const record = event.target.closest<HTMLElement>('[data-replay-step]')?.dataset.replayStep
        const run =
          event.target.closest<HTMLElement>('[data-replay-run-item]')?.dataset.replayRunItem
        const stepId = run
          ? branchSteps.find((step) => step.runs.some((item) => item.runId === run))?.id
          : record
        if (stepId) {
          onInspect?.()
          onSelectContent?.({
            kind: run ? 'notebook' : 'conversation',
            stepId,
            runId: run,
            savedHistory: !run && fullHistory
          })
        }
      }}
      onWheelCapture={(event) => {
        if (isLiveInteraction(event.target) || isLayoutInteraction(event.target)) return
        if (researchPresentation) {
          browseResearchPane(event.target)
          return
        }
        releaseConversationAnchor()
        releaseNotebookAnchor()
        if (!isLiveProjectViewportInteraction(event.target)) onInspect?.()
      }}
      onPointerDownCapture={(event) => {
        if (isLiveInteraction(event.target) || isLayoutInteraction(event.target)) return
        releaseConversationAnchor()
        releaseNotebookAnchor()
        if (researchPresentation && event.target instanceof Element) {
          const record = event.target.closest<HTMLElement>('[data-replay-step]')?.dataset.replayStep
          const run =
            event.target.closest<HTMLElement>('[data-replay-run-item]')?.dataset.replayRunItem
          const stepId = run
            ? branchSteps.find((step) => step.runs.some((item) => item.runId === run))?.id
            : record
          const selectingFile = Boolean(event.target.closest('button[data-replay-material-item]'))
          if (stepId && !selectingFile) {
            onInspect?.()
            onSelectContent?.({
              kind: run ? 'notebook' : 'conversation',
              stepId,
              runId: run,
              savedHistory: !run && fullHistory
            })
          } else if (event.target === notebookViewport.current) {
            // A scrollbar drag is reading, not a request to stop the research clock.
            browseResearchPane(event.target)
          }
          return
        }
        // A file's click already freezes and selects its exact Version atomically. Freezing
        // on pointerdown adds the inspection banner and moves this row before pointerup,
        // so an ordinary first click can miss the button entirely.
        const selectingFile =
          event.target instanceof Element &&
          Boolean(event.target.closest('button[data-replay-material-item]'))
        // Material tabs only change the visible pane; keep the shared clock running.
        // Do not enter inspection or move their hit targets before the click is handled.
        if (
          !selectingFile &&
          !isMaterialViewInteraction(event.target) &&
          !isLiveProjectViewportInteraction(event.target)
        )
          onInspect?.()
        if (filesOpen && !wide && !filesPane.current?.contains(event.target as Node))
          onCloseFiles?.()
      }}
      onKeyDownCapture={(event) => {
        if (isLiveInteraction(event.target) || isLayoutInteraction(event.target)) return
        releaseConversationAnchor()
        releaseNotebookAnchor()
        if (event.key === 'Escape' && inspecting) {
          event.preventDefault()
          event.stopPropagation()
          returnToOrigin()
        } else if (event.key === 'Escape' && fitContainer && filesOpen) {
          event.preventDefault()
          event.stopPropagation()
          onCloseFiles?.()
        } else if (
          event.key === 'Escape' &&
          fitContainer &&
          materialsOpen &&
          !researchPresentation
        ) {
          event.preventDefault()
          event.stopPropagation()
          onCloseMaterials?.()
        }
        if (researchPresentation) {
          if (
            ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)
          )
            browseResearchPane(event.target)
          return
        }
        if (
          !isLiveProjectViewportInteraction(event.target) &&
          !isMaterialViewInteraction(event.target) &&
          ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)
        )
          onInspect?.()
      }}
    >
      {!fitContainer ? (
        <header className="flex h-16 shrink-0 items-center justify-between gap-6 border-b border-border-200 px-7">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold">{replayDocument.source.title}</div>
            <div className="text-xs text-text-300">{t('Reconstructed from archived records')}</div>
          </div>
          <span className="rounded-full border border-border-200 px-3 py-1 text-xs text-text-300">
            {t('Read-only research history')}
          </span>
        </header>
      ) : null}
      {fitContainer && !primaryContent ? (
        <ReplayCurrentContext
          compact={researchPresentation}
          executionState={contextExecution}
          executionWaiting={Boolean(
            contextExecution?.snapshot &&
            materialPlayback?.recordedAt !== undefined &&
            materialPlayback.recordedAt > contextExecution.snapshot.observedAt
          )}
          scene={scene}
          steps={branchSteps}
          onHistory={() => {
            if (researchPresentation) onBrowsePane?.('conversation')
            else onInspect?.()
            if (researchPresentation) onMaterialViewChange?.('conversation')
            setFullHistory(true)
            setBrowsingConversation(true)
            const index = historicalMessages.findIndex((step) => step.id === scene.step?.id)
            setHistoryPage(Math.floor(Math.max(0, index) / REPLAY_TRANSCRIPT_STEP_LIMIT))
          }}
          onNotebook={
            branchMaterials.notebook
              ? () => {
                  if (!researchPresentation) setFullHistory(false)
                  onMaterialViewChange?.('notebook')
                }
              : undefined
          }
        />
      ) : null}
      {!researchPresentation && fitContainer && fullHistory ? conversationHistoryControl : null}
      {researchPresentation ? (
        <div className="relative flex min-h-0 min-w-0 flex-1">
          <ReplayResearchLayout
            layout={effectiveResearchLayout}
            materialTabs={researchMaterialTabs}
            materialTabPanelId={researchTabPanelId}
            panes={researchPanes}
            focusedPaneId={focusedPaneId}
            onFocusPane={onFocusPane}
          />
          {filesCatalog}
        </div>
      ) : (
        <div
          className={
            fitContainer
              ? `relative grid min-h-0 flex-1 grid-rows-1 ${wide && showMaterialPane && !inspecting ? (filesOpen ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_16rem]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]') : wide && filesOpen ? 'grid-cols-[minmax(0,1fr)_16rem]' : 'grid-cols-1'}`
              : 'grid min-h-0 flex-1 grid-cols-[46%_54%]'
          }
        >
          {conversationPane}
          <section
            ref={material}
            id={materialsId}
            aria-label={fitContainer ? t('Research materials') : t('Historical code and results')}
            tabIndex={0}
            className={
              fitContainer
                ? `min-h-0 min-w-0 flex-col overflow-hidden ${wide ? 'border-l border-border-200' : ''} ${showMaterialPane ? 'flex' : 'hidden'}`
                : 'space-y-5 overflow-auto p-6'
            }
            style={{ scrollbarWidth: fitContainer ? undefined : 'none' }}
          >
            {fitContainer && !researchPresentation && !inspecting ? (
              <div className="flex h-9 min-w-0 shrink-0 items-center justify-between gap-2 border-b border-border-200 px-3">
                {materialViews?.length ? (
                  <div
                    role="group"
                    aria-label={t('Research materials')}
                    className="flex min-w-0 gap-1 overflow-x-auto"
                  >
                    {[{ id: 'notebook', label: t('Notebook') }, ...materialViews].map((view) => (
                      <Button
                        key={view.id}
                        data-replay-material-view={view.id}
                        data-replay-notebook-heading={view.id === 'notebook' ? true : undefined}
                        size="sm"
                        variant={materialViewId === view.id ? 'secondary' : 'ghost'}
                        className="h-7 shrink-0 px-2 text-xs"
                        aria-pressed={materialViewId === view.id}
                        onClick={() => onMaterialViewChange?.(view.id)}
                      >
                        {view.label}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <h2
                          tabIndex={0}
                          data-replay-notebook-heading
                          className="flex items-center gap-2 text-sm font-medium"
                        >
                          <BookOpen size={16} aria-hidden="true" />
                          {t('Notebook')}
                        </h2>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" align="start">
                        {t('Follows playback progress')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close research materials')}
                  onClick={onCloseMaterials}
                >
                  <X size={14} />
                </Button>
              </div>
            ) : null}
            {notebookPane}
            {fitContainer && !inspecting
              ? materialViews?.map((view) => (
                  <div
                    key={view.id}
                    className={
                      materialViewId === view.id
                        ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                        : 'hidden'
                    }
                    hidden={materialViewId !== view.id}
                  >
                    {typeof view.content === 'function'
                      ? view.content(
                          materialsActive && showMaterialPane && materialViewId === view.id,
                          materialPlayback
                        )
                      : view.content}
                  </div>
                ))
              : null}
            {resourcePreview}
            {!fitContainer &&
            !selectedResource &&
            ((materialStep?.runs.length ?? 0) > REPLAY_MATERIAL_RUN_LIMIT ||
              (materialStep?.resourceIds.length ?? 0) > REPLAY_MATERIAL_RESOURCE_LIMIT) ? (
              <p className="text-xs text-text-300">
                {t('Preview is truncated. Open the evidence for the complete record.')}
              </p>
            ) : null}
            {!fitContainer && !hasMaterial ? (
              <div className="flex h-full items-center justify-center text-center text-sm text-text-300">
                {t('Recorded code and results appear here as the research unfolds.')}
              </div>
            ) : null}
          </section>
          {filesCatalog}
        </div>
      )}
      {!fitContainer ? (
        <footer
          className={
            fitContainer
              ? 'flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border-200 px-3 py-2 text-xs text-text-300'
              : 'flex h-10 shrink-0 items-center justify-between border-t border-border-200 px-6 text-xs text-text-300'
          }
        >
          <span>
            {readiness.degraded
              ? t('Some source material is incomplete or unavailable.')
              : t('Presentation timing is reconstructed; recorded results are unchanged.')}
          </span>
          <span>
            {active ? t('Step {{step}}', { step: scene.stepIndex + 1 }) : t('Research replay')}
          </span>
        </footer>
      ) : null}
    </div>
  )
}

export const ReplayStage = (props: ReplayStageProps): React.JSX.Element => {
  const presentation = props.presentation ?? createReplayPresentation('en', props.reducedMotion)
  return (
    <ReplayPresentationContext.Provider value={presentation}>
      <TooltipProvider>
        <ReplayStageContent
          key={JSON.stringify([
            props.document.source.projectId,
            props.document.source.sessionId,
            props.sourceIdentity ?? props.document.source.fingerprint,
            props.preparationId ?? 0
          ])}
          {...props}
          presentation={presentation}
          reducedMotion={presentation.reducedMotion}
        />
      </TooltipProvider>
    </ReplayPresentationContext.Provider>
  )
}
