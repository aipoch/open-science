/*
 * Hallmark · component: Plan approval card · genre: modern-minimal · theme: existing semantic tokens
 * pre-emit critique: P5 · H5 · E5 · S5 · R5 · V4
 * states: default · hover · focus · active · disabled · loading · error · success
 * contrast: inherited from the shared Button, Textarea, and workspace surface tokens
 * slop test: pass · component scope, existing workspace chrome and tokens preserved
 */
import { useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import {
  CornerDownLeft,
  Download,
  Info,
  ListChecks,
  Maximize2,
  Minimize2,
  Pencil
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import {
  parsePlanDocumentV1,
  type ActivePlanProjection,
  type PlanDocumentV1
} from '../../../../../shared/session-plan/contract'

import { planConfidenceLabelKey } from './plan-confidence-label'
import type { PlanDocumentProjection } from './plan-file-projection'

type PlanSurfaceProps = Readonly<{ projection: ActivePlanProjection; stale?: boolean }>

// Notice strip shared by every Plan preview surface: stale, pending, and snapshot notices all
// render with the same chrome directly above the document body.
const PlanNoticeBanner = ({
  children
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element => (
  <div className="border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground">
    {children}
  </div>
)

type RestoredPlanResponder = Readonly<{
  sessionId?: string
  enabled: boolean
  respond: (response: { decision: 'approved' | 'rejected' }) => Promise<void>
  canRespondToSession?: (sessionId: string) => boolean
  onSessionSizeLimit?: (sessionId: string) => void
}>

const lifecycleLabel = (projection: ActivePlanProjection, t: TFunction): string => {
  switch (projection.lifecycle) {
    case 'awaiting_approval':
      return t('Plan ready for review')
    case 'completed':
      return t('Plan completed')
    case 'blocked':
      return t('Plan blocked')
    case 'rejected':
      return t('Plan rejected')
    case 'approved':
      return t('Plan approved')
    default:
      return t('Plan in progress')
  }
}

// The projection's status is a protocol value (`in_progress`); these are its display forms.
const stepStatusLabel = (
  status: ActivePlanProjection['stepStates'][string]['status'],
  t: TFunction
): string => {
  switch (status) {
    case 'completed':
      return t('completed')
    case 'in_progress':
      return t('in progress')
    case 'blocked':
      return t('blocked')
    case 'skipped':
      return t('skipped')
    case 'not_run':
      return t('not run')
    case 'not_started':
      return t('not started')
  }
}

type StepProjectionStatus = ActivePlanProjection['stepStates'][string]['status']

const STEP_STATUS_PRESENTATION: Record<
  StepProjectionStatus,
  Readonly<{ mark: string; className: string }>
> = {
  completed: { mark: '✓', className: 'border-primary bg-primary text-primary-foreground' },
  in_progress: {
    mark: '●',
    className: 'rounded-full border-primary/30 bg-primary/10 text-primary'
  },
  blocked: {
    mark: '!',
    className: 'border-destructive/30 bg-destructive/10 text-destructive'
  },
  skipped: { mark: '–', className: 'bg-muted text-muted-foreground' },
  not_run: { mark: '', className: 'bg-muted text-muted-foreground' },
  not_started: { mark: '', className: 'border-border text-muted-foreground' }
}

const WorkspacePlanCard = ({
  projection,
  stale = false,
  enabled = true,
  embedded = false,
  className = '',
  onOpen,
  onRespond,
  onSubmitResponse,
  onResolved
}: PlanSurfaceProps &
  Readonly<{
    onOpen: () => void
    onRespond: (decision: 'approved' | 'rejected') => Promise<void>
    onSubmitResponse?: (text: string) => Promise<void>
    onResolved?: () => void
    enabled?: boolean
    embedded?: boolean
    className?: string
  }>): React.JSX.Element => {
  const { t } = useTranslation()

  const decisionPending = projection.approval === 'pending' && !stale && enabled
  const [responseText, setResponseText] = useState('')
  const [decisionBusy, setDecisionBusy] = useState(false)
  const [decisionError, setDecisionError] = useState<string>()
  const projectionKey = `${projection.artifactVersionId}:${projection.revision}`
  const [resolvedProjectionKey, setResolvedProjectionKey] = useState<string>()
  const respond = async (decision: 'approved' | 'rejected'): Promise<void> => {
    if (decisionBusy) return
    setDecisionBusy(true)
    setDecisionError(undefined)
    try {
      await onRespond(decision)
      setResolvedProjectionKey(projectionKey)
      onResolved?.()
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : t('Unable to update the Plan.'))
    } finally {
      setDecisionBusy(false)
    }
  }
  if (resolvedProjectionKey === projectionKey) return <></>
  return (
    <article
      className={`overflow-hidden bg-card ${
        embedded
          ? 'rounded-none border-0 shadow-none'
          : 'rounded-lg border border-border shadow-card'
      } ${className}`}
      aria-busy={decisionBusy}
    >
      {stale ? (
        <div className="border-b border-border bg-muted px-3.5 py-2 text-xs text-muted-foreground">
          {t('⚠ A newer plan is active. This plan can no longer be approved.')}
        </div>
      ) : null}
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-56 flex-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ListChecks className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              <span>{lifecycleLabel(projection, t)}</span>
            </div>
            <div className="mt-1 min-w-0 break-words text-[17px] font-semibold leading-6 text-foreground">
              {projection.document.task_summary}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="[@media(pointer:coarse)]:h-11"
              onClick={onOpen}
            >
              {t('Open')}
            </Button>
            {decisionPending ? (
              <Button
                type="button"
                className="[@media(pointer:coarse)]:h-11"
                disabled={decisionBusy}
                onClick={() => void respond('approved')}
              >
                {t('Approve')}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-bg-200 px-2 py-1 text-[11px] font-medium text-text-100">
          <span className="size-1.5 rounded-full bg-text-300" aria-hidden="true" />
          {t(planConfidenceLabelKey(projection.document.feasibility.confidence))}
        </div>
        {decisionPending ? (
          <form
            className="mt-3 border-t border-border pt-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (decisionBusy) return
              const text = responseText.trim()
              if (!text) return
              setDecisionBusy(true)
              setDecisionError(undefined)
              void (
                onSubmitResponse?.(text) ??
                Promise.reject(new Error(t('Unable to send Plan feedback.')))
              )
                .then(() => {
                  setResponseText('')
                  setResolvedProjectionKey(projectionKey)
                  onResolved?.()
                })
                .catch((error: unknown) =>
                  setDecisionError(
                    error instanceof Error ? error.message : t('Unable to update the Plan.')
                  )
                )
                .finally(() => setDecisionBusy(false))
            }}
          >
            <label className="sr-only" htmlFor={`plan-response-${projection.artifactVersionId}`}>
              {t('Respond to Plan')}
            </label>
            <div className="flex items-start gap-2">
              <span
                className="grid size-9 shrink-0 place-items-center rounded-lg bg-bg-100 text-text-300"
                aria-hidden="true"
              >
                <Pencil className="size-4" strokeWidth={1.75} />
              </span>
              <Textarea
                id={`plan-response-${projection.artifactVersionId}`}
                rows={1}
                aria-invalid={decisionError ? true : undefined}
                aria-describedby={
                  decisionError ? `plan-response-error-${projection.artifactVersionId}` : undefined
                }
                className="max-h-40 min-h-9 min-w-0 flex-1 resize-none border-0 bg-transparent px-0 py-1.5 text-[15px] leading-6 shadow-none focus-visible:border-transparent dark:bg-transparent"
                placeholder={t('Describe changes to the Plan…')}
                value={responseText}
                disabled={decisionBusy}
                onChange={(event) => setResponseText(event.target.value)}
              />
              <Button
                type="submit"
                variant="outline"
                size="icon-lg"
                aria-label={t('Send Plan feedback')}
                disabled={decisionBusy || responseText.trim().length === 0}
              >
                <CornerDownLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </Button>
            </div>
            {decisionError ? (
              <p
                id={`plan-response-error-${projection.artifactVersionId}`}
                role="alert"
                className="mt-1 pl-11 text-xs text-destructive"
              >
                {decisionError}
              </p>
            ) : null}
          </form>
        ) : null}
      </div>
    </article>
  )
}

const PlanProgressChip = ({
  projection,
  onOpen
}: PlanSurfaceProps & Readonly<{ onOpen: () => void }>): React.JSX.Element => {
  const { t } = useTranslation()
  const running = projection.counts.inProgress
  const isRunning = projection.lifecycle === 'in_progress' && running > 0
  const accessibleName = isRunning
    ? t('Open plan, step {{completed}} of {{steps}}, {{running}} running', {
        completed: projection.counts.completed,
        steps: projection.counts.steps,
        running
      })
    : t('Open plan, step {{completed}} of {{steps}}', {
        completed: projection.counts.completed,
        steps: projection.counts.steps
      })
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-[12px] font-normal text-text-100 hover:bg-bg-300 hover:text-text-000"
      aria-label={accessibleName}
      onClick={onOpen}
    >
      {isRunning ? (
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse"
        />
      ) : null}
      <ListChecks className="size-3.5" strokeWidth={2} aria-hidden="true" />
      {t('step {{completed}}/{{steps}}', {
        completed: projection.counts.completed,
        steps: projection.counts.steps
      })}
      {isRunning ? (
        <span className="font-medium text-primary">
          {t('· {{count}} running', { count: running })}
        </span>
      ) : null}
    </Button>
  )
}

type PlanPreviewSurfaceProps = PlanSurfaceProps &
  Readonly<{
    isFullScreen?: boolean
    // Real on-disk artifact filename, offered as selectable text so users can copy it.
    planFilename?: string
    onDownload?: () => Promise<void>
    onRespond?: (decision: 'approved' | 'rejected') => Promise<void>
    onToggleFullScreen?: () => void
  }>

const validatedPreviewDocument = (value: unknown): PlanDocumentV1 | null => {
  try {
    return parsePlanDocumentV1(value)
  } catch {
    return null
  }
}

// The document-only core of the Plan preview: title, phases with step states, desired outputs, and
// feasibility. Extracted from PlanPreviewSurface so the JSON file preview can embed the same
// rendering without the in-chat surface's header and approval banners. An invalid document renders
// nothing; the embedding surface owns that error presentation.
const PlanDocumentBody = ({
  projection,
  compactSummary = false
}: Readonly<{
  projection: PlanDocumentProjection
  compactSummary?: boolean
}>): React.JSX.Element => {
  const { t } = useTranslation()

  const planDocument = validatedPreviewDocument(projection.document)
  if (!planDocument) return <></>
  const summaryHeading = (
    <h1
      className={
        compactSummary
          ? 'line-clamp-3 break-words text-[22px] leading-7 font-semibold'
          : 'text-[22px] font-semibold'
      }
    >
      {planDocument.task_summary}
    </h1>
  )
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="px-8 py-8">
        {compactSummary ? (
          <TooltipProvider delayDuration={1_200}>
            <Tooltip>
              <TooltipTrigger asChild>{summaryHeading}</TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="start"
                sideOffset={8}
                className="max-w-[min(28rem,calc(100vw-1rem))] px-3 py-2 leading-5"
              >
                {planDocument.task_summary}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          summaryHeading
        )}
        {/* One sentence, one key. It used to be assembled from three pieces — a spelled-out
            count, a hand-picked 'phase'/'phases', and a bare tail — which pins English word
            order and leaves the tail untranslatable. The count is now a number so i18next
            selects the plural form, and zh, having one plural category, needs a single entry. */}
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            'Complete {{count}} phases in order. Delegations within a phase may run in parallel.',
            {
              count: planDocument.phases.length,
              defaultValue_one:
                'Complete {{count}} phase in order. Delegations within a phase may run in parallel.'
            }
          )}
        </p>
        {planDocument.phases.map((phase, phaseIndex) => (
          <section key={`${phaseIndex}:${phase.name}`} className="mt-7 border-t border-border pt-6">
            <div className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground">
              {t('PHASE {{number}}', { number: phaseIndex + 1 })}
            </div>
            <h2 className="mt-1 text-lg font-medium">{phase.name}</h2>
            {phase.delegations.map((delegation, delegationIndex) => (
              <div
                key={`${delegationIndex}:${delegation.name}`}
                className="relative mt-4 border-l border-border pl-5"
              >
                <span
                  aria-hidden="true"
                  className="absolute left-[-4px] top-2 size-[7px] rounded-full bg-foreground"
                />
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{delegation.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {phase.delegations.length === 1 ? t('primary agent') : t('runs in parallel')}
                  </span>
                </div>
                {delegation.steps.map((step) => {
                  const runtime = Object.hasOwn(projection.stepStatuses, step.title)
                    ? projection.stepStatuses[step.title]
                    : undefined
                  const projectedState = Object.hasOwn(projection.stepStates, step.title)
                    ? projection.stepStates[step.title]
                    : undefined
                  const state = projectedState ?? {
                    status: runtime?.status ?? ('not_started' as const),
                    ...(runtime?.notes ? { notes: runtime.notes } : {})
                  }
                  const presentation = STEP_STATUS_PRESENTATION[state.status]
                  return (
                    <div key={step.title} className="mt-3 grid grid-cols-[18px_1fr] gap-2">
                      <span
                        aria-label={t('{{step}} status: {{status}}', {
                          step: step.title,
                          status: stepStatusLabel(state.status, t)
                        })}
                        className={`mt-0.5 grid size-4 place-items-center rounded border text-[10px] ${presentation.className}`}
                      >
                        {presentation.mark}
                      </span>
                      <div>
                        <div className="text-sm font-medium">{step.title}</div>
                        <div className="text-xs text-muted-foreground">{step.description}</div>
                        {state.notes &&
                        (state.status === 'blocked' || state.status === 'skipped') ? (
                          <div className="mt-1.5 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
                            {state.notes}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </section>
        ))}
        <section className="mt-7 border-t border-border pt-6">
          <h2 className="text-sm font-medium">{t('Desired outputs')}</h2>
          {planDocument.desired_outputs.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {planDocument.desired_outputs.map((output) => (
                <li key={output}>{output}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('No desired outputs specified.')}
            </p>
          )}
        </section>
        <div className="mt-7 rounded-lg bg-muted p-4">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground">
            <Info className="size-3 shrink-0" aria-hidden="true" />
            {t('SCOPE & FEASIBILITY')} ·{' '}
            {t(planConfidenceLabelKey(planDocument.feasibility.confidence))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{planDocument.feasibility.rationale}</p>
        </div>
        {compactSummary ? (
          <p
            aria-hidden="true"
            className="mt-7 select-text break-words border-t border-border pt-4 text-xs leading-5 text-muted-foreground"
          >
            {planDocument.task_summary}
          </p>
        ) : null}
      </div>
    </ScrollArea>
  )
}

const PlanPreviewSurface = ({
  projection,
  stale = false,
  isFullScreen = false,
  planFilename,
  onDownload,
  onRespond,
  onToggleFullScreen
}: PlanPreviewSurfaceProps): React.JSX.Element => {
  const { t } = useTranslation()

  const planDocument = validatedPreviewDocument(projection.document)
  const decisionInFlightRef = useRef(false)
  const [decisionBusy, setDecisionBusy] = useState(false)
  const projectionKey = `${projection.artifactVersionId}:${projection.revision}`
  const [resolvedProjectionKey, setResolvedProjectionKey] = useState<string>()

  const respond = async (decision: 'approved' | 'rejected'): Promise<void> => {
    if (!onRespond || decisionInFlightRef.current) return
    decisionInFlightRef.current = true
    setDecisionBusy(true)
    try {
      await onRespond(decision)
      setResolvedProjectionKey(projectionKey)
    } finally {
      decisionInFlightRef.current = false
      setDecisionBusy(false)
    }
  }

  const download =
    onDownload ??
    (async (): Promise<void> => {
      const bytes = new TextEncoder().encode(
        JSON.stringify(planDocument ?? projection.document, null, 2)
      )
      await window.api.saveBlobFile({
        suggestedName: `plan-${projection.artifactVersionId}.json`,
        mimeType: 'application/json',
        data: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer
      })
    })

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-10 text-foreground" aria-busy={decisionBusy}>
      {/* Mirrors the artifact preview header: the real artifact filename as selectable text,
          separated from the content by the header border. Never a fabricated name — the
          Artifact Version id is not the on-disk file name. Falls back to the document label
          when the artifact entry has not been loaded. */}
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span
          className="min-w-0 flex-1 select-text truncate text-[12px] font-medium text-text-000"
          title={planFilename}
        >
          {planFilename ?? t('Session Plan')}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            aria-label={t('Download Plan')}
            variant="ghost"
            onClick={() => void download()}
          >
            <Download className="size-4" aria-hidden="true" />
            {t('Download')}
          </Button>
          {planDocument &&
          !stale &&
          projection.approval === 'pending' &&
          resolvedProjectionKey !== projectionKey &&
          onRespond ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={decisionBusy}
                onClick={() => void respond('rejected')}
              >
                {t('Dismiss')}
              </Button>
              <Button
                type="button"
                disabled={decisionBusy}
                onClick={() => void respond('approved')}
              >
                {t('Approve')}
              </Button>
            </>
          ) : null}
          {onToggleFullScreen ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    aria-label={isFullScreen ? t('Exit full screen') : t('Enter full screen')}
                    variant="ghost"
                    size="icon-sm"
                    onClick={onToggleFullScreen}
                  >
                    {isFullScreen ? (
                      <Minimize2 className="size-4" aria-hidden="true" />
                    ) : (
                      <Maximize2 className="size-4" aria-hidden="true" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="z-[70]">
                  {isFullScreen ? t('Exit full screen') : t('Enter full screen')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
      </header>
      {stale ? (
        <PlanNoticeBanner>
          {t('⚠ This plan has been replaced by another plan and is no longer current.')}
        </PlanNoticeBanner>
      ) : null}
      {planDocument ? (
        <PlanDocumentBody projection={projection} compactSummary />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div
            role="alert"
            className="max-w-sm rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {t('Invalid Plan document. This preview cannot be displayed.')}
          </div>
        </div>
      )}
    </div>
  )
}

export {
  PlanDocumentBody,
  PlanNoticeBanner,
  PlanPreviewSurface,
  PlanProgressChip,
  WorkspacePlanCard
}
export type { RestoredPlanResponder }
