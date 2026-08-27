import { MessageScrollerItem } from '@/components/ui/message-scroller'
import type { ToolActivity } from '@/stores/session-store'
import {
  AlertCircle,
  Check,
  ChevronRight,
  Circle,
  LoaderCircle,
  TriangleAlert,
  X
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AnnotationValidationError, TextAnnotation } from '../../../../shared/annotations'
import { TextAnnotationSurface } from './annotations/TextAnnotationSurface'
import { projectGeneratePlanActivity } from './generate-plan-activity-projection'
import { planConfidenceLabelKey } from './session-plan/plan-confidence-label'
import { WorkspaceToolDetailsRow } from './WorkspaceToolDetailsRow'
import { buildToolActivityDetails } from './workspace-tool-activity-details'

type PlanAnnotationPort = Readonly<{
  sessionId: string
  activeAnnotations: readonly TextAnnotation[]
  onAdd: (annotation: TextAnnotation) => AnnotationValidationError | undefined
  onUpdateNote?: (id: string, note: string) => AnnotationValidationError | undefined
  onError: (error: AnnotationValidationError) => void
}>

type WorkspacePlanActivityRecordProps = Readonly<{
  activity: ToolActivity
  hasDurablePlanAuthority?: boolean
  contentPaddingClassName?: string
  annotationPort?: PlanAnnotationPort
  revealRequest?: Readonly<{ requestId: number; itemId: string; sectionId?: string }>
}>

const domToken = (value: string): string => value.replace(/[^A-Za-z0-9_-]/gu, '_') || 'plan'
const COMPACT_STEP_COUNT = 5

const PlanTextAnnotationSurface = ({
  activityId,
  sectionId,
  annotationPort,
  children
}: {
  activityId: string
  sectionId: string
  annotationPort?: PlanAnnotationPort
  children: React.ReactNode
}): React.JSX.Element =>
  annotationPort ? (
    <TextAnnotationSurface
      source={{
        kind: 'session-item',
        sessionId: annotationPort.sessionId,
        itemId: activityId,
        itemType: 'plan',
        sectionId
      }}
      activeAnnotations={annotationPort.activeAnnotations}
      onAdd={annotationPort.onAdd}
      onUpdateNote={annotationPort.onUpdateNote}
      onError={annotationPort.onError}
    >
      {children}
    </TextAnnotationSurface>
  ) : (
    <>{children}</>
  )

const WorkspacePlanActivityRecord = ({
  activity,
  hasDurablePlanAuthority = false,
  contentPaddingClassName = 'px-4 md:px-6',
  annotationPort,
  revealRequest
}: WorkspacePlanActivityRecordProps): React.JSX.Element => {
  const { t } = useTranslation()

  const projection = projectGeneratePlanActivity(activity, hasDurablePlanAuthority)
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(() => new Set())
  const [showAllSteps, setShowAllSteps] = useState(false)
  const [taskSummaryExpanded, setTaskSummaryExpanded] = useState(false)
  const [taskSummaryOverflows, setTaskSummaryOverflows] = useState(false)
  const [failureDetailsExpanded, setFailureDetailsExpanded] = useState(false)
  const [dismissedRevealRequestId, setDismissedRevealRequestId] = useState<number>()
  const taskSummaryRef = useRef<HTMLParagraphElement>(null)
  const isActive =
    !hasDurablePlanAuthority && (activity.status === 'pending' || activity.status === 'in_progress')
  const failureDetails =
    projection.kind === 'failed' ? buildToolActivityDetails(activity, t) : undefined
  const projectedTaskSummary = projection.kind === 'content' ? projection.taskSummary : undefined
  const revealStepMatch = /^step:(\d+):(title|description)$/u.exec(revealRequest?.sectionId ?? '')
  const revealStepNumber = revealStepMatch ? Number(revealStepMatch[1]) : undefined
  const revealDescriptionStep =
    revealStepMatch?.[2] === 'description' && revealRequest?.requestId !== dismissedRevealRequestId
      ? revealStepNumber
      : undefined
  const revealFailureDetails =
    projection.kind === 'failed' &&
    revealRequest?.itemId === activity.id &&
    revealRequest.requestId !== dismissedRevealRequestId

  const toggleStep = (stepNumber: number): void => {
    if (revealDescriptionStep === stepNumber && revealRequest) {
      setDismissedRevealRequestId(revealRequest.requestId)
      setExpandedSteps((current) => {
        const next = new Set(current)
        next.delete(stepNumber)
        return next
      })
      return
    }
    setExpandedSteps((current) => {
      const next = new Set(current)
      if (next.has(stepNumber)) next.delete(stepNumber)
      else next.add(stepNumber)
      return next
    })
  }

  useLayoutEffect(() => {
    const summary = taskSummaryRef.current
    if (!summary || projectedTaskSummary === undefined) return

    const measureOverflow = (): void => {
      const style = window.getComputedStyle(summary)
      const parsedLineHeight = Number.parseFloat(style.lineHeight)
      const parsedFontSize = Number.parseFloat(style.fontSize)
      const lineHeight =
        Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
          ? parsedLineHeight < 4 && Number.isFinite(parsedFontSize)
            ? parsedLineHeight * parsedFontSize
            : parsedLineHeight
          : undefined
      const previewHeight = lineHeight ? lineHeight * 3 : summary.clientHeight
      const overflows = summary.scrollHeight > previewHeight + 1
      setTaskSummaryOverflows(overflows)
      if (!overflows) setTaskSummaryExpanded(false)
    }

    measureOverflow()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measureOverflow)
    observer.observe(summary)
    return () => observer.disconnect()
  }, [projectedTaskSummary])

  const contentProjection = projection.kind === 'content' ? projection : undefined
  const revealStepIndex = contentProjection?.steps.findIndex(
    (step) => step.number === revealStepNumber
  )
  const revealShowsAllSteps = revealStepIndex !== undefined && revealStepIndex >= COMPACT_STEP_COUNT
  const effectiveShowAllSteps = showAllSteps || revealShowsAllSteps
  const effectiveTaskSummaryExpanded =
    taskSummaryExpanded ||
    (revealRequest?.sectionId === 'task-summary' &&
      revealRequest.requestId !== dismissedRevealRequestId)
  const visibleSteps = contentProjection
    ? effectiveShowAllSteps
      ? contentProjection.steps
      : contentProjection.steps.slice(0, COMPACT_STEP_COUNT)
    : []
  const remainingStepCount = contentProjection
    ? contentProjection.steps.length - visibleSteps.length
    : 0
  const allDescriptionsExpanded = Boolean(
    contentProjection?.steps.every((step) => expandedSteps.has(step.number))
  )
  const everythingExpanded = Boolean(
    contentProjection &&
    effectiveShowAllSteps &&
    allDescriptionsExpanded &&
    (!taskSummaryOverflows || effectiveTaskSummaryExpanded)
  )

  const toggleAll = (): void => {
    if (!contentProjection) return
    if (everythingExpanded) {
      setShowAllSteps(false)
      setTaskSummaryExpanded(false)
      setExpandedSteps(new Set())
      return
    }

    setShowAllSteps(true)
    setTaskSummaryExpanded(taskSummaryOverflows)
    setExpandedSteps(new Set(contentProjection.steps.map((step) => step.number)))
  }

  const statusIcon = isActive ? (
    <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
  ) : projection.kind === 'failed' ? (
    <AlertCircle className="size-3.5" aria-hidden="true" />
  ) : projection.kind === 'revision-conflict' ? (
    <TriangleAlert className="size-3.5 text-warning-900" aria-hidden="true" />
  ) : projection.kind === 'already-pending' ? (
    <Circle className="size-3.5 text-text-300" aria-hidden="true" />
  ) : projection.kind === 'rejected' ? (
    <X className="size-3.5" aria-hidden="true" />
  ) : (
    <Check className="size-3.5" aria-hidden="true" />
  )

  return (
    <MessageScrollerItem messageId={`plan-activity-${activity.id}`} className="min-w-0">
      <div className={`${contentPaddingClassName} pb-1 pt-5`}>
        <section
          aria-label={t('Plan call record')}
          aria-live={isActive ? 'polite' : undefined}
          className="w-full overflow-hidden rounded-[12px] border border-border-200 bg-bg-200/70"
          data-testid="plan-call-record"
        >
          <div className="flex min-h-10 items-center gap-2 px-3 py-2 text-[12px] text-text-100">
            <span className="inline-flex size-[17px] shrink-0 items-center justify-center text-text-100">
              {statusIcon}
            </span>
            <span>{t(projection.heading)}</span>
            {projection.kind === 'content' ? (
              <>
                <span className="ml-auto shrink-0 tabular-nums text-text-300">
                  {t('{{count}} steps', {
                    count: projection.steps.length,
                    defaultValue_one: '{{count}} step'
                  })}
                </span>
                <button
                  type="button"
                  data-testid="plan-expand-all"
                  aria-expanded={everythingExpanded}
                  aria-controls={`plan-content-${domToken(activity.id)}`}
                  className="rounded-[5px] px-1.5 py-0.5 text-[11px] text-text-100 transition-colors duration-150 hover:bg-bg-000/70 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none"
                  onClick={toggleAll}
                >
                  {everythingExpanded ? t('Collapse all') : t('Expand all')}
                </button>
              </>
            ) : null}
          </div>

          {projection.kind === 'content' ? (
            <div
              id={`plan-content-${domToken(activity.id)}`}
              className="mb-[7px] ml-[31px] mr-[7px] rounded-[9px] border border-border-200 bg-bg-000 px-[13px] py-[11px] shadow-sm"
            >
              <div className="mb-[9px]">
                <PlanTextAnnotationSurface
                  activityId={activity.id}
                  sectionId="task-summary"
                  annotationPort={annotationPort}
                >
                  <p
                    ref={taskSummaryRef}
                    id={`plan-task-summary-${domToken(activity.id)}`}
                    data-testid="plan-task-summary"
                    className={`m-0 text-[13px] font-semibold leading-[1.45] text-text-000 ${taskSummaryOverflows && !effectiveTaskSummaryExpanded ? 'line-clamp-3' : ''}`}
                  >
                    {projection.taskSummary}
                  </p>
                </PlanTextAnnotationSurface>
                {taskSummaryOverflows ? (
                  <button
                    type="button"
                    data-testid="plan-task-summary-toggle"
                    aria-expanded={effectiveTaskSummaryExpanded}
                    aria-controls={`plan-task-summary-${domToken(activity.id)}`}
                    className="mt-1 rounded-[4px] p-0 text-[11px] text-text-300 transition-colors duration-150 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none"
                    onClick={() => {
                      if (
                        revealRequest?.sectionId === 'task-summary' &&
                        revealRequest.requestId !== dismissedRevealRequestId
                      ) {
                        setDismissedRevealRequestId(revealRequest.requestId)
                        setTaskSummaryExpanded(false)
                      } else {
                        setTaskSummaryExpanded((expanded) => !expanded)
                      }
                    }}
                  >
                    {effectiveTaskSummaryExpanded ? t('Show less') : t('Show full task')}
                  </button>
                ) : null}
              </div>
              <ol className="grid list-none gap-[7px] p-0">
                {visibleSteps.map((step) => {
                  const expanded =
                    expandedSteps.has(step.number) || revealDescriptionStep === step.number
                  const detailsId = `plan-step-${domToken(activity.id)}-${step.number}`
                  return (
                    <li
                      key={step.number}
                      className="grid grid-cols-[20px_minmax(0,1fr)] items-start text-[12px] text-text-100"
                    >
                      <span className="pt-0.5 text-[10px] font-semibold text-text-300">
                        {step.number}.
                      </span>
                      <div className="min-w-0">
                        <PlanTextAnnotationSurface
                          activityId={activity.id}
                          sectionId={`step:${step.number}:title`}
                          annotationPort={annotationPort}
                        >
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-controls={detailsId}
                            className="flex w-full min-w-0 items-center gap-2 rounded-[5px] text-left text-text-100 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            onClick={() => toggleStep(step.number)}
                          >
                            <span className="min-w-0 flex-1 text-[12px] text-text-000">
                              {step.title}
                            </span>
                            <ChevronRight
                              className={`size-3.5 shrink-0 text-text-300 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
                              aria-hidden="true"
                            />
                          </button>
                        </PlanTextAnnotationSurface>
                        {expanded ? (
                          <PlanTextAnnotationSurface
                            activityId={activity.id}
                            sectionId={`step:${step.number}:description`}
                            annotationPort={annotationPort}
                          >
                            <p
                              id={detailsId}
                              className="mb-[3px] mr-[18px] mt-[5px] text-[10.5px] leading-[1.5] text-text-300"
                            >
                              {step.description}
                            </p>
                          </PlanTextAnnotationSurface>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ol>
              {remainingStepCount > 0 ? (
                <div className="ml-5 mt-[7px] text-[11px] text-text-300">
                  {t('+ {{count}} more steps', {
                    count: remainingStepCount,
                    defaultValue_one: '+ {{count}} more step'
                  })}
                </div>
              ) : null}
              <div className="mt-3 flex items-start gap-2 border-t border-border-200 pt-[9px] text-[11px] text-text-300">
                <span className="shrink-0 whitespace-nowrap rounded-[5px] bg-accent/10 px-1.5 py-0.5 text-[10px] text-text-100">
                  {t(planConfidenceLabelKey(projection.feasibility.confidence))}
                </span>
                <PlanTextAnnotationSurface
                  activityId={activity.id}
                  sectionId="feasibility-summary"
                  annotationPort={annotationPort}
                >
                  <span>{projection.feasibility.summary}</span>
                </PlanTextAnnotationSurface>
              </div>
            </div>
          ) : projection.kind === 'revision-conflict' ? (
            <div className="mb-[7px] ml-[31px] mr-[7px] rounded-[9px] border border-warning-100/50 bg-warning-100/10 px-[13px] py-[11px] text-[12px] text-text-300">
              {t(projection.detail)}
            </div>
          ) : projection.kind === 'unavailable' ? (
            <div className="mb-[7px] ml-[31px] mr-[7px] rounded-[9px] border border-border-200 bg-bg-000 px-[13px] py-[11px] text-[12px] text-text-300">
              {t('Plan details unavailable')}
            </div>
          ) : projection.kind === 'failed' && failureDetails ? (
            <div className="mb-1.5 px-1.5">
              <WorkspaceToolDetailsRow
                activity={activity}
                details={failureDetails}
                isExpanded={failureDetailsExpanded || revealFailureDetails}
                onToggle={(_activityId, nextExpanded) => {
                  if (!nextExpanded && revealFailureDetails && revealRequest) {
                    setDismissedRevealRequestId(revealRequest.requestId)
                  }
                  setFailureDetailsExpanded(nextExpanded)
                }}
                annotationSessionId={annotationPort?.sessionId}
                activeTextAnnotations={annotationPort?.activeAnnotations}
                onAddTextAnnotation={annotationPort?.onAdd}
                onUpdateTextAnnotationNote={annotationPort?.onUpdateNote}
                onAnnotationError={annotationPort?.onError}
                annotationItemType="plan"
                revealRequest={revealFailureDetails ? revealRequest : undefined}
              />
            </div>
          ) : null}
        </section>
      </div>
    </MessageScrollerItem>
  )
}

export { WorkspacePlanActivityRecord }
