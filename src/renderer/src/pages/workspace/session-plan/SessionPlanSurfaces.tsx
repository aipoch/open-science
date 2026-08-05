import { useState } from 'react'
import { Download, Info, ListChecks, Maximize2, Minimize2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import {
  parsePlanDocumentV1,
  type ActivePlanProjection,
  type PlanDocumentV1
} from '../../../../../shared/session-plan/contract'

type PlanSurfaceProps = Readonly<{ projection: ActivePlanProjection; stale?: boolean }>

const plural = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? '' : 's'}`

const lifecycleLabel = (projection: ActivePlanProjection): string => {
  switch (projection.lifecycle) {
    case 'awaiting_approval':
      return 'Plan ready for review'
    case 'completed':
      return 'Plan completed'
    case 'blocked':
      return 'Plan blocked'
    case 'rejected':
      return 'Plan rejected'
    case 'approved':
      return 'Plan approved'
    case 'interrupted':
      return 'Plan interrupted'
    default:
      return 'Plan in progress'
  }
}

const stepStatusLabel = (status: ActivePlanProjection['stepStates'][string]['status']): string =>
  status.replaceAll('_', ' ')

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
    className?: string
  }>): React.JSX.Element => {
  const decisionPending = projection.approval === 'pending' && !stale
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
      setDecisionError(error instanceof Error ? error.message : 'Unable to update the Plan.')
    } finally {
      setDecisionBusy(false)
    }
  }
  if (resolvedProjectionKey === projectionKey) return <></>
  return (
    <article
      className={`overflow-hidden rounded-lg border bg-card shadow-card ${stale ? 'border-amber-300' : 'border-border'} ${className}`}
    >
      {stale ? (
        <div className="border-b border-amber-300 bg-amber-50 px-3.5 py-2 text-xs text-amber-800">
          ⚠ A newer plan is active. This plan can no longer be approved.
        </div>
      ) : null}
      <div className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-56 flex-1">
            <div className="text-xs text-muted-foreground">{lifecycleLabel(projection)}</div>
            <div className="mt-1 text-[17px] font-medium text-foreground">
              {projection.document.task_summary}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {plural(projection.counts.phases, 'phase')} ·{' '}
              {plural(projection.counts.delegations, 'delegation')} ·{' '}
              {plural(projection.counts.steps, 'step')}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="h-8 rounded-lg border border-border bg-card px-2.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={onOpen}
            >
              Open
            </button>
            {decisionPending ? (
              <>
                <button
                  type="button"
                  className="h-8 rounded-lg border border-border bg-card px-2.5 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  disabled={decisionBusy}
                  onClick={() => void respond('rejected')}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="h-8 rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  disabled={decisionBusy}
                  onClick={() => void respond('approved')}
                >
                  Approve
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className="mt-3 inline-flex rounded-full bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
          ● {projection.document.feasibility.confidence} confidence
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
                Promise.reject(new Error('Unable to send Plan feedback.'))
              )
                .then(() => {
                  setResponseText('')
                  setResolvedProjectionKey(projectionKey)
                  onResolved?.()
                })
                .catch((error: unknown) =>
                  setDecisionError(
                    error instanceof Error ? error.message : 'Unable to update the Plan.'
                  )
                )
                .finally(() => setDecisionBusy(false))
            }}
          >
            <label className="sr-only" htmlFor={`plan-response-${projection.artifactVersionId}`}>
              Respond to Plan
            </label>
            <div className="flex items-center gap-2">
              <span aria-hidden="true">✎</span>
              <textarea
                id={`plan-response-${projection.artifactVersionId}`}
                rows={1}
                className="min-h-9 flex-1 resize-none rounded bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                placeholder="Describe changes, or type “approve”…"
                value={responseText}
                disabled={decisionBusy}
                onChange={(event) => setResponseText(event.target.value)}
              />
              <button
                type="submit"
                className="h-8 rounded-lg bg-primary px-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                disabled={decisionBusy || responseText.trim().length === 0}
              >
                Send
              </button>
            </div>
            {decisionError ? (
              <p role="alert" className="mt-1 text-xs text-destructive">
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
  const running = projection.counts.inProgress
  const isRunning = projection.lifecycle === 'in_progress' && running > 0
  const accessibleName = `Open plan, step ${projection.counts.completed} of ${projection.counts.steps}${
    isRunning ? `, ${running} running` : ''
  }`
  return (
    <button
      type="button"
      className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] font-normal text-text-100 transition-colors duration-200 ease-out hover:bg-bg-300 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
      step {projection.counts.completed}/{projection.counts.steps}
      {isRunning ? <span className="font-medium text-primary">· {running} running</span> : null}
    </button>
  )
}

type PlanPreviewSurfaceProps = PlanSurfaceProps &
  Readonly<{
    isFullScreen?: boolean
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

const countLabel = (count: number): string =>
  ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][count] ??
  String(count)

const PlanPreviewSurface = ({
  projection,
  stale = false,
  isFullScreen = false,
  onDownload,
  onRespond,
  onToggleFullScreen
}: PlanPreviewSurfaceProps): React.JSX.Element => {
  const planDocument = validatedPreviewDocument(projection.document)

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
    <div className="flex h-full min-h-0 flex-col bg-bg-10 text-foreground">
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="truncate text-xs text-muted-foreground">
          plan-{projection.artifactVersionId}.json
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            aria-label="Download Plan"
            variant="ghost"
            onClick={() => void download()}
          >
            <Download className="size-4" aria-hidden="true" />
            Download
          </Button>
          {planDocument && !stale && projection.approval === 'pending' && onRespond ? (
            <>
              <Button type="button" variant="outline" onClick={() => void onRespond('rejected')}>
                Dismiss
              </Button>
              <Button type="button" onClick={() => void onRespond('approved')}>
                Approve
              </Button>
            </>
          ) : null}
          {onToggleFullScreen ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    aria-label={isFullScreen ? 'Exit full screen' : 'Enter full screen'}
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
                  {isFullScreen ? 'Exit full screen' : 'Enter full screen'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
      </header>
      {stale ? (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          ⚠ This plan has been replaced by another plan and is no longer current.
        </div>
      ) : null}
      {!stale && projection.approval === 'pending' && !onRespond ? (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          This Plan is still pending, but its original Agent interaction has ended. Send a normal
          message to let the Agent decide how to continue.
        </div>
      ) : null}
      {planDocument ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-8 py-8">
            <h1 className="text-[22px] font-semibold">{planDocument.task_summary}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Complete {countLabel(planDocument.phases.length)}{' '}
              {planDocument.phases.length === 1 ? 'phase' : 'phases'} in order. Delegations within a
              phase may run in parallel.
            </p>
            {planDocument.phases.map((phase, phaseIndex) => (
              <section
                key={`${phaseIndex}:${phase.name}`}
                className="mt-7 border-t border-border pt-6"
              >
                <div className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground">
                  PHASE {phaseIndex + 1}
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
                        {phase.delegations.length === 1 ? 'primary agent' : 'runs in parallel'}
                      </span>
                    </div>
                    {delegation.steps.map((step) => {
                      const runtime = projection.stepStatuses[step.title]
                      const state = projection.stepStates?.[step.title] ?? {
                        status: runtime?.status ?? ('not_started' as const),
                        ...(runtime?.notes ? { notes: runtime.notes } : {})
                      }
                      const presentation = STEP_STATUS_PRESENTATION[state.status]
                      return (
                        <div key={step.title} className="mt-3 grid grid-cols-[18px_1fr] gap-2">
                          <span
                            aria-label={`${step.title} status: ${stepStatusLabel(state.status)}`}
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
              <h2 className="text-sm font-medium">Desired outputs</h2>
              {planDocument.desired_outputs.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                  {planDocument.desired_outputs.map((output) => (
                    <li key={output}>{output}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">No desired outputs specified.</p>
              )}
            </section>
            <div className="mt-7 rounded-lg bg-muted p-4">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground">
                <Info className="size-3 shrink-0" aria-hidden="true" />
                SCOPE &amp; FEASIBILITY · {planDocument.feasibility.confidence} confidence
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {planDocument.feasibility.rationale}
              </p>
            </div>
          </div>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div
            role="alert"
            className="max-w-sm rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            Invalid Plan document. This preview cannot be displayed.
          </div>
        </div>
      )}
    </div>
  )
}

export { PlanPreviewSurface, PlanProgressChip, WorkspacePlanCard }
