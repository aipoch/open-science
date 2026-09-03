/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import { MessageScrollerItem, useMessageScroller } from '@/components/ui/message-scroller'
import { cn } from '@/lib/utils'
import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { JobSummary } from '../../../../shared/compute'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import { RemoteJobRow } from '@/components/RemoteJobRow'
import { extractJobIdFromActivity } from '@/components/job-binding-utils'
import { WorkspaceToolActivityRow } from './WorkspaceToolActivityRow'
import { WorkspaceCollapsiblePanel } from './WorkspaceCollapsiblePanel'
import { WorkspaceToolDetailsRow } from './WorkspaceToolDetailsRow'
import { WorkspaceSkillActivityRow } from './WorkspaceSkillActivityRow'
import { WorkspaceSkillLoadRow } from './WorkspaceSkillLoadRow'
import { WorkspaceManagePackagesActivityRow } from './WorkspaceManagePackagesActivityRow'
import { WorkspaceWebSearchActivityRow } from './WorkspaceWebSearchActivityRow'
import {
  buildToolActivityDetails,
  getSkillLoadDocument,
  isSkillActivity
} from './workspace-tool-activity-details'
import { getLoadedSkillName, isSkillLoadActivity } from './workspace-skill-load'
import {
  formatActivityGroupElapsed,
  formatActivityGroupPresentationTitle,
  formatStepCount,
  getActivityGroupElapsedMs,
  getRenderableActivityEntries,
  isSearchActivity
} from './workspace-tool-activity-groups'
import type {
  ActivityExpansionOverrides,
  ConversationActivityGroupItem
} from './workspace-tool-activity-groups'
import { formatWebSearchDetails } from './workspace-web-search-details'
import { getCorrelatedNotebookRun, getToolExecutionPhase } from './tool-execution-phase'
import type { SessionPermissionRuntimeContext } from '../../../../shared/session-persistence'
import { isNotebookManagePackagesToolName } from './notebook-tool-names'
import type { AnnotationPort } from './annotations/annotation-port'

const isManagePackagesActivity = (
  activity: ConversationActivityGroupItem['activities'][number]
): boolean =>
  isNotebookManagePackagesToolName(activity.providerToolName) ||
  isNotebookManagePackagesToolName(activity.title)

type WorkspaceActivityGroupProps = {
  group: ConversationActivityGroupItem
  isExpanded: boolean
  onToggleGroup: (groupId: string) => void
  expansionOverrides: ActivityExpansionOverrides
  onToggleRow: (activityId: string, nextExpanded: boolean) => void
  // Full runs are an ephemeral local projection keyed by the compact transcript runId.
  notebookRunsById?: ReadonlyMap<string, NotebookRunRecord>
  onNotebookRunNearViewport?: (runId: string, isNearViewport: boolean) => void
  // Embedded transcript surfaces can supply their own horizontal gutter without changing live chat.
  contentPaddingClassName?: string
  // Map of job_id → JobSummary for jobs bound to activities in this group.
  jobsByActivityId?: Map<string, JobSummary>
  onOpenJobDetail?: (job: JobSummary) => void
  permission?: SessionPermissionRuntimeContext
  annotationPort?: AnnotationPort
  revealRequest?: Readonly<{ requestId: number; itemId: string; sectionId?: string }>
}

const ACTIVE_ELAPSED_TICK_MS = 100

// Isolates the ticking clock so active tools do not re-render the group's expanded detail rows.
const ActivityGroupElapsed = ({
  activities,
  permission,
  notebookRunsById
}: {
  activities: ConversationActivityGroupItem['activities']
  permission?: SessionPermissionRuntimeContext
  notebookRunsById?: ReadonlyMap<string, NotebookRunRecord>
}): React.JSX.Element => {
  const isExecuting = (activity: (typeof activities)[number]): boolean =>
    getToolExecutionPhase(activity, permission, notebookRunsById) === 'executing'
  const isActive = activities.some(isExecuting)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isActive) return undefined

    const timer = setInterval(() => setNow(Date.now()), ACTIVE_ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [isActive])

  return <>{formatActivityGroupElapsed(getActivityGroupElapsedMs(activities, now, isExecuting))}</>
}

// Renders adjacent tool calls as one collapsible transcript row group.
const WorkspaceActivityGroup = ({
  group,
  isExpanded,
  onToggleGroup,
  expansionOverrides,
  onToggleRow,
  notebookRunsById,
  onNotebookRunNearViewport,
  contentPaddingClassName,
  jobsByActivityId,
  onOpenJobDetail,
  permission,
  annotationPort,
  revealRequest
}: WorkspaceActivityGroupProps): React.JSX.Element => {
  const { t } = useTranslation()
  const { scrollToMessage } = useMessageScroller()
  const groupElementRef = useRef<HTMLDivElement>(null)
  // ToolSearch wrapper rows are hidden when concrete search rows are present.
  const renderableActivityEntries = getRenderableActivityEntries(group.activities)
  const visibleActivities = renderableActivityEntries.map(({ activity }) => activity)

  // A row's detail panel changes this group's height. Leave bottom-follow mode first — exactly
  // like the group header does — so the panel opens strictly downward instead of the transcript
  // snapping to the bottom once content overflows. align:'nearest' is scroll-neutral only when the
  // whole group fits the viewport (a taller group would be scrolled to its top), so restore the
  // scroll offset after the mode escape: the escape must never move the viewport itself.
  const handleToggleRow = (activityId: string, nextExpanded: boolean): void => {
    const viewport = groupElementRef.current?.closest<HTMLElement>(
      '[data-slot="message-scroller-viewport"]'
    )
    const previousScrollTop = viewport?.scrollTop

    scrollToMessage(group.id, { align: 'nearest', behavior: 'auto' })

    if (viewport && previousScrollTop !== undefined) viewport.scrollTop = previousScrollTop
    onToggleRow(activityId, nextExpanded)
  }

  return (
    <MessageScrollerItem key={group.id} messageId={group.id} className="min-w-0">
      <div className={cn('px-4 pb-0.5 pt-2.5 md:px-6', contentPaddingClassName)}>
        <div
          ref={groupElementRef}
          className="w-full overflow-hidden rounded-[14px] bg-bg-200/70 px-1.5 py-1"
          data-testid="tool-group"
        >
          <button
            type="button"
            aria-expanded={isExpanded}
            data-testid="tool-group-header"
            className="flex w-full items-center gap-2 rounded-lg py-[5px] pl-1.5 pr-2.5 text-[13px] transition-colors hover:bg-bg-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            onClick={() => {
              // Leave bottom-follow mode before this row changes height. The scroller then keeps the
              // group in view instead of snapping the expanded content to the transcript bottom.
              scrollToMessage(group.id, { align: 'nearest', behavior: 'auto' })
              onToggleGroup(group.id)
            }}
          >
            <span
              className={cn(
                'inline-flex w-4 shrink-0 items-center justify-center text-text-100 transition-transform duration-200',
                isExpanded ? 'rotate-90' : undefined
              )}
            >
              <ChevronRight className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
            </span>
            <span className="min-w-0 truncate text-left font-medium text-text-000">
              {formatActivityGroupPresentationTitle(
                group.activities,
                group.title,
                permission,
                notebookRunsById,
                t
              )}
            </span>
            <span className="ml-auto shrink-0 whitespace-nowrap text-[12px] tabular-nums text-text-000">
              {formatStepCount(visibleActivities, permission, notebookRunsById, t)} ·{' '}
              <ActivityGroupElapsed
                activities={visibleActivities}
                permission={permission}
                notebookRunsById={notebookRunsById}
              />
            </span>
          </button>
          <WorkspaceCollapsiblePanel isOpen={isExpanded}>
            {renderableActivityEntries.map(({ activity, activityIndex }) => {
              const phase = getToolExecutionPhase(activity, permission, notebookRunsById)
              const correlatedNotebookRun = getCorrelatedNotebookRun(activity, notebookRunsById)
              // Search rows get bespoke query/result details; other tools reuse the shared builder.
              const isSearch = isSearchActivity(activity, group.activities, activityIndex)
              const searchDetails = isSearch ? formatWebSearchDetails(activity) : undefined
              // A completed load_skill expands into its rendered SKILL.md when the output carries
              // the document; without it (payload stripped, running, failed, or old sessions) the
              // IPC-capable skill row resolves the document by invocation name instead of showing
              // the generic input/output JSON.
              const skillLoadDocument = !isSearch ? getSkillLoadDocument(activity) : undefined
              const skillLoadWithoutDocument = !skillLoadDocument && isSkillLoadActivity(activity)
              const toolDetails =
                isSearch || skillLoadDocument || skillLoadWithoutDocument
                  ? undefined
                  : buildToolActivityDetails(activity, t)
              // All tool rows — notebook cells included — default collapsed (meaningful title
              // only); clicking the title reveals the code and output. A user toggle still wins.
              const isRowExpanded = expansionOverrides[activity.id] ?? false
              const showManagePackagesProgress =
                isManagePackagesActivity(activity) &&
                (phase === 'executing' || phase === 'completed' || phase === 'failed')

              return (
                <div key={activity.id} className="w-full overflow-hidden">
                  {showManagePackagesProgress ? (
                    <WorkspaceManagePackagesActivityRow
                      activity={activity}
                      phase={phase}
                      isExpanded={isRowExpanded}
                      onToggle={handleToggleRow}
                      annotationPort={annotationPort}
                      revealRequest={
                        revealRequest?.itemId === activity.id ? revealRequest : undefined
                      }
                    />
                  ) : searchDetails ? (
                    <WorkspaceWebSearchActivityRow
                      activity={activity}
                      phase={phase}
                      details={searchDetails}
                      isExpanded={isRowExpanded}
                      onToggleSearch={handleToggleRow}
                      annotationPort={annotationPort}
                    />
                  ) : skillLoadDocument ? (
                    <WorkspaceSkillLoadRow
                      activity={activity}
                      phase={phase}
                      skillName={getLoadedSkillName(activity)}
                      markdown={skillLoadDocument}
                      isExpanded={isRowExpanded}
                      onToggle={handleToggleRow}
                    />
                  ) : skillLoadWithoutDocument ? (
                    // load_skill without a document payload: the row resolves the SKILL.md from
                    // the skills catalog or the connector-aware resolver, keeping the raw JSON out
                    // of the transcript; it stays compact when no source provides the name.
                    <WorkspaceSkillActivityRow
                      activity={activity}
                      phase={phase}
                      isExpanded={isRowExpanded}
                      onToggle={handleToggleRow}
                    />
                  ) : toolDetails ? (
                    <WorkspaceToolDetailsRow
                      activity={activity}
                      phase={phase}
                      details={toolDetails}
                      notebookRun={
                        correlatedNotebookRun ??
                        (toolDetails.notebookRunId
                          ? notebookRunsById?.get(toolDetails.notebookRunId)
                          : undefined)
                      }
                      isExpanded={isRowExpanded}
                      onNotebookRunNearViewport={onNotebookRunNearViewport}
                      onToggle={handleToggleRow}
                      annotationPort={annotationPort}
                      revealRequest={
                        revealRequest?.itemId === activity.id ? revealRequest : undefined
                      }
                    />
                  ) : isSkillActivity(activity) ? (
                    // Native Skill rows carry no payload; the row resolves the SKILL.md from
                    // the skills catalog on expand (or stays compact when unlisted).
                    <WorkspaceSkillActivityRow
                      activity={activity}
                      phase={phase}
                      isExpanded={isRowExpanded}
                      onToggle={handleToggleRow}
                    />
                  ) : (
                    <WorkspaceToolActivityRow activity={activity} phase={phase} />
                  )}
                  {/* RemoteJobRow: injected below a repl_execute activity that submitted a job */}
                  {(() => {
                    const jobId = extractJobIdFromActivity(activity)
                    const boundJob = jobId ? jobsByActivityId?.get(jobId) : undefined
                    if (!boundJob) return null
                    return (
                      <RemoteJobRow
                        key={`job-row-${boundJob.job_id}`}
                        job={boundJob}
                        onOpen={(job) => onOpenJobDetail?.(job)}
                      />
                    )
                  })()}
                </div>
              )
            })}
          </WorkspaceCollapsiblePanel>
        </div>
      </div>
    </MessageScrollerItem>
  )
}

export { WorkspaceActivityGroup }
