import { MessageScrollerItem } from '@/components/ui/message-scroller'
import type { ToolActivity } from '@/stores/session-store'
import { AlertCircle, Check, ChevronRight, LoaderCircle, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'

import { projectGeneratePlanActivity } from './generate-plan-activity-projection'
import { WorkspaceToolDetailsRow } from './WorkspaceToolDetailsRow'
import { buildToolActivityDetails } from './workspace-tool-activity-details'

type WorkspacePlanActivityRecordProps = Readonly<{
  activity: ToolActivity
  contentPaddingClassName?: string
}>

const domToken = (value: string): string => value.replace(/[^A-Za-z0-9_-]/gu, '_') || 'plan'
const COMPACT_STEP_COUNT = 5

const WorkspacePlanActivityRecord = ({
  activity,
  contentPaddingClassName = 'px-4 md:px-6'
}: WorkspacePlanActivityRecordProps): React.JSX.Element => {
  const projection = projectGeneratePlanActivity(activity)
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(() => new Set())
  const [showAllSteps, setShowAllSteps] = useState(false)
  const [taskSummaryExpanded, setTaskSummaryExpanded] = useState(false)
  const [taskSummaryOverflows, setTaskSummaryOverflows] = useState(false)
  const [failureDetailsExpanded, setFailureDetailsExpanded] = useState(false)
  const taskSummaryRef = useRef<HTMLParagraphElement>(null)
  const isActive = activity.status === 'pending' || activity.status === 'in_progress'
  const failureDetails =
    projection.kind === 'failed' ? buildToolActivityDetails(activity) : undefined
  const projectedTaskSummary = projection.kind === 'content' ? projection.taskSummary : undefined

  const toggleStep = (stepNumber: number): void => {
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
  const visibleSteps = contentProjection
    ? showAllSteps
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
    showAllSteps &&
    allDescriptionsExpanded &&
    (!taskSummaryOverflows || taskSummaryExpanded)
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
  ) : projection.kind === 'rejected' ? (
    <X className="size-3.5" aria-hidden="true" />
  ) : (
    <Check className="size-3.5" aria-hidden="true" />
  )

  return (
    <MessageScrollerItem messageId={`plan-activity-${activity.id}`} className="min-w-0">
      <div className={`${contentPaddingClassName} pb-1 pt-5`}>
        <section
          aria-label="Plan call record"
          aria-live={isActive ? 'polite' : undefined}
          className="w-full overflow-hidden rounded-[12px] border border-border-200 bg-bg-200/70"
          data-testid="plan-call-record"
        >
          <div className="flex min-h-10 items-center gap-2 px-3 py-2 text-[12px] text-text-100">
            <span className="inline-flex size-[17px] shrink-0 items-center justify-center text-text-100">
              {statusIcon}
            </span>
            <span>{projection.heading}</span>
            {projection.kind === 'content' ? (
              <>
                <span className="ml-auto shrink-0 tabular-nums text-text-300">
                  {projection.steps.length} {projection.steps.length === 1 ? 'step' : 'steps'}
                </span>
                <button
                  type="button"
                  data-testid="plan-expand-all"
                  aria-expanded={everythingExpanded}
                  aria-controls={`plan-content-${domToken(activity.id)}`}
                  className="rounded-[5px] px-1.5 py-0.5 text-[11px] text-text-100 transition-colors duration-150 hover:bg-bg-000/70 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none"
                  onClick={toggleAll}
                >
                  {everythingExpanded ? 'Collapse all' : 'Expand all'}
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
                <p
                  ref={taskSummaryRef}
                  id={`plan-task-summary-${domToken(activity.id)}`}
                  data-testid="plan-task-summary"
                  className={`m-0 text-[13px] font-semibold leading-[1.45] text-text-000 ${taskSummaryOverflows && !taskSummaryExpanded ? 'line-clamp-3' : ''}`}
                >
                  {projection.taskSummary}
                </p>
                {taskSummaryOverflows ? (
                  <button
                    type="button"
                    data-testid="plan-task-summary-toggle"
                    aria-expanded={taskSummaryExpanded}
                    aria-controls={`plan-task-summary-${domToken(activity.id)}`}
                    className="mt-1 rounded-[4px] p-0 text-[11px] text-text-300 transition-colors duration-150 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none"
                    onClick={() => setTaskSummaryExpanded((expanded) => !expanded)}
                  >
                    {taskSummaryExpanded ? 'Show less' : 'Show full task'}
                  </button>
                ) : null}
              </div>
              <ol className="grid list-none gap-[7px] p-0">
                {visibleSteps.map((step) => {
                  const expanded = expandedSteps.has(step.number)
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
                        {expanded ? (
                          <p
                            id={detailsId}
                            className="mb-[3px] mr-[18px] mt-[5px] text-[10.5px] leading-[1.5] text-text-300"
                          >
                            {step.description}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ol>
              {remainingStepCount > 0 ? (
                <div className="ml-5 mt-[7px] text-[11px] text-text-300">
                  + {remainingStepCount} more {remainingStepCount === 1 ? 'step' : 'steps'}
                </div>
              ) : null}
              <div className="mt-3 flex items-start gap-2 border-t border-border-200 pt-[9px] text-[11px] text-text-300">
                <span className="shrink-0 whitespace-nowrap rounded-[5px] bg-accent/10 px-1.5 py-0.5 text-[10px] text-text-100">
                  {projection.feasibility.confidence} confidence
                </span>
                <span>{projection.feasibility.summary}</span>
              </div>
            </div>
          ) : projection.kind === 'unavailable' ? (
            <div className="mb-[7px] ml-[31px] mr-[7px] rounded-[9px] border border-border-200 bg-bg-000 px-[13px] py-[11px] text-[12px] text-text-300">
              Plan details unavailable
            </div>
          ) : projection.kind === 'failed' && failureDetails ? (
            <div className="mb-1.5 px-1.5">
              <WorkspaceToolDetailsRow
                activity={activity}
                details={failureDetails}
                isExpanded={failureDetailsExpanded}
                onToggle={(_activityId, nextExpanded) => setFailureDetailsExpanded(nextExpanded)}
              />
            </div>
          ) : null}
        </section>
      </div>
    </MessageScrollerItem>
  )
}

export { WorkspacePlanActivityRecord }
