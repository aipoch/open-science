import { readPackageWebEvidence } from './workspace-package-web-evidence'
import { WorkspacePackageWebActivityRow } from './WorkspacePackageWebActivityRow'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
import { MessageScrollerItem, useMessageScroller } from '@/components/ui/message-scroller'
import { cn } from '@/lib/utils'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { JobSummary } from '../../../../shared/compute'
import type { NotebookRunRecord } from '../../../../shared/notebook'
import { RemoteJobRow } from '@/components/RemoteJobRow'
import { extractJobIdFromActivity } from '@/components/job-binding-utils'
import { WorkspaceActivityIcon } from './WorkspaceActivityIcon'
import { WorkspaceToolActivityRow } from './WorkspaceToolActivityRow'
import { WorkspaceActivityGroupSurface } from './WorkspaceTranscriptSurface'
import { WorkspaceToolDetailsRow } from './WorkspaceToolDetailsRow'
import { WorkspaceSkillActivityRow } from './WorkspaceSkillActivityRow'
import { WorkspaceSkillLoadRow } from './WorkspaceSkillLoadRow'
import { WorkspaceManagePackagesActivityRow } from './WorkspaceManagePackagesActivityRow'
import { WorkspaceWebSearchActivityRow } from './WorkspaceWebSearchActivityRow'
import { WorkspaceWebFetchActivityRow } from './WorkspaceWebFetchActivityRow'
import { isBuiltinWebFetchActivity, readWebFetchResult } from './workspace-web-fetch-details'
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
import {
  formatWebSearchDetails,
  isBuiltinWebSearchActivity,
  readWebSearchResult
} from './workspace-web-search-details'
import {
  getCorrelatedNotebookRun,
  getToolExecutionPhase,
  isNotebookCodeReviewActivity
} from './tool-execution-phase'
import type { SessionPermissionRuntimeContext } from '../../../../shared/session-persistence'
import { isNotebookManagePackagesToolName } from './notebook-tool-names'
import type { AnnotationPort } from './annotations/annotation-port'

const isManagePackagesActivity = (
  activity: ConversationActivityGroupItem['activities'][number]
): boolean =>
  isNotebookManagePackagesToolName(activity.providerToolName) ||
  isNotebookManagePackagesToolName(activity.title)

type WorkspaceActivityGroupProps = {
  allowFolderAccess?: boolean
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
  const awaitingApproval = activities.some(
    (activity) =>
      getToolExecutionPhase(activity, permission, notebookRunsById) === 'awaiting-approval'
  )
  const isActive = !awaitingApproval && activities.some(isExecuting)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isActive) return undefined

    const timer = setInterval(() => setNow(Date.now()), ACTIVE_ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [isActive])

  if (awaitingApproval) return <></>
  return (
    <>
      {formatActivityGroupElapsed(
        getActivityGroupElapsedMs(activities, now, isExecuting, notebookRunsById)
      )}
    </>
  )
}

// The timeline rebuilds group arrays on session updates. Keep each tool's detail work keyed
// to its own record and presentation inputs; fresh receipt records still render normally.
const WorkspaceActivityGroupRow = memo(function WorkspaceActivityGroupRow({
  activity,
  phase,
  legacyIsSearch,
  expansionOverride,
  allowFolderAccess,
  notebookRunsById,
  onNotebookRunNearViewport,
  onToggleRow,
  annotationPort,
  revealRequest,
  boundJob,
  onOpenJobDetail
}: Pick<
  WorkspaceActivityGroupProps,
  | 'allowFolderAccess'
  | 'notebookRunsById'
  | 'onNotebookRunNearViewport'
  | 'onToggleRow'
  | 'annotationPort'
  | 'revealRequest'
  | 'onOpenJobDetail'
> & {
  activity: ConversationActivityGroupItem['activities'][number]
  phase: ReturnType<typeof getToolExecutionPhase>
  legacyIsSearch: boolean
  expansionOverride?: boolean
  boundJob?: JobSummary
}): React.JSX.Element {
  const { t } = useTranslation()
  const correlatedNotebookRun = getCorrelatedNotebookRun(activity, notebookRunsById)
  const packageEvidence = readPackageWebEvidence(activity)
  const ownedWebFetch = isBuiltinWebFetchActivity(activity)
  const fetchResult = ownedWebFetch ? readWebFetchResult(activity) : undefined
  const terminal = phase === 'completed' || phase === 'failed'
  const isWebFetch = ownedWebFetch && (fetchResult !== undefined || !terminal)
  const ownedWebSearch = isBuiltinWebSearchActivity(activity)
  const isSearch =
    !isWebFetch &&
    (ownedWebSearch ? readWebSearchResult(activity) !== undefined || !terminal : legacyIsSearch)
  const searchDetails = useMemo(
    () => (isSearch ? formatWebSearchDetails(activity) : undefined),
    [activity, isSearch]
  )
  // A completed load_skill expands into its rendered SKILL.md when the output carries
  // the document; without it (payload stripped, running, failed, or old sessions) the
  // IPC-capable skill row resolves the document by invocation name instead of showing
  // the generic input/output JSON.
  const skillLoadDocument = useMemo(
    () => (!isSearch && !isWebFetch ? getSkillLoadDocument(activity) : undefined),
    [activity, isSearch, isWebFetch]
  )
  const skillLoadWithoutDocument = !skillLoadDocument && isSkillLoadActivity(activity)
  const toolDetails = useMemo(
    () =>
      packageEvidence || isWebFetch || isSearch || skillLoadDocument || skillLoadWithoutDocument
        ? undefined
        : buildToolActivityDetails(activity, t),
    [
      activity,
      t,
      packageEvidence,
      isWebFetch,
      isSearch,
      skillLoadDocument,
      skillLoadWithoutDocument
    ]
  )
  // Detail presenters own their defaults; explicit user toggles always win.
  const isRowExpanded = expansionOverride ?? toolDetails?.defaultExpanded ?? false
  const showManagePackagesProgress =
    isManagePackagesActivity(activity) &&
    (phase === 'executing' || phase === 'completed' || phase === 'failed')

  return (
    <div key={activity.id} className="w-full overflow-hidden">
      {packageEvidence ? (
        <WorkspacePackageWebActivityRow
          activity={activity}
          evidence={packageEvidence}
          isExpanded={isRowExpanded}
          onToggle={onToggleRow}
        />
      ) : isWebFetch ? (
        <WorkspaceWebFetchActivityRow
          activity={activity}
          phase={phase}
          result={fetchResult}
          isExpanded={isRowExpanded}
          onToggle={onToggleRow}
        />
      ) : showManagePackagesProgress ? (
        <WorkspaceManagePackagesActivityRow
          activity={activity}
          phase={phase}
          isExpanded={isRowExpanded}
          onToggle={onToggleRow}
          annotationPort={annotationPort}
          revealRequest={revealRequest?.itemId === activity.id ? revealRequest : undefined}
        />
      ) : searchDetails ? (
        <WorkspaceWebSearchActivityRow
          activity={activity}
          phase={phase}
          details={searchDetails}
          isExpanded={isRowExpanded}
          onToggleSearch={onToggleRow}
          annotationPort={annotationPort}
        />
      ) : skillLoadDocument ? (
        <WorkspaceSkillLoadRow
          activity={activity}
          phase={phase}
          skillName={getLoadedSkillName(activity)}
          markdown={skillLoadDocument}
          isExpanded={isRowExpanded}
          onToggle={onToggleRow}
        />
      ) : skillLoadWithoutDocument ? (
        // load_skill without a document payload: the row resolves the SKILL.md from
        // the skills catalog or the connector-aware resolver, keeping the raw JSON out
        // of the transcript; it stays compact when no source provides the name.
        <WorkspaceSkillActivityRow
          activity={activity}
          phase={phase}
          isExpanded={isRowExpanded}
          onToggle={onToggleRow}
        />
      ) : toolDetails ? (
        <WorkspaceToolDetailsRow
          allowFolderAccess={allowFolderAccess}
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
          onToggle={onToggleRow}
          annotationPort={annotationPort}
          revealRequest={revealRequest?.itemId === activity.id ? revealRequest : undefined}
        />
      ) : isSkillActivity(activity) ? (
        // Native Skill rows carry no payload; the row resolves the SKILL.md from
        // the skills catalog on expand (or stays compact when unlisted).
        <WorkspaceSkillActivityRow
          activity={activity}
          phase={phase}
          isExpanded={isRowExpanded}
          onToggle={onToggleRow}
        />
      ) : (
        <WorkspaceToolActivityRow activity={activity} phase={phase} />
      )}
      {/* RemoteJobRow: injected below a repl_execute activity that submitted a job */}
      {boundJob ? (
        <RemoteJobRow
          key={`job-row-${boundJob.job_id}`}
          job={boundJob}
          onOpen={(job) => onOpenJobDetail?.(job)}
        />
      ) : null}
    </div>
  )
})

// Renders adjacent tool calls as one collapsible transcript row group.
const WorkspaceActivityGroup = ({
  allowFolderAccess = false,
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
}: WorkspaceActivityGroupProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const { stopAutoScroll } = useMessageScroller()
  // Review receipts stay in history for approval state and timing, but do not render as steps.
  const renderableActivityEntries = getRenderableActivityEntries(group.activities)
  const visibleActivities = renderableActivityEntries.map(({ activity }) => activity)

  const phases = [
    ...visibleActivities,
    ...group.activities.filter(isNotebookCodeReviewActivity)
  ].map((activity) => ({
    activity,
    phase: getToolExecutionPhase(activity, permission, notebookRunsById)
  }))
  // Keep approval and abnormal outcomes visible even when all detail rows are hidden.
  const summary = [
    'executing',
    'awaiting-approval',
    'failed',
    'limit-reached',
    'interrupted',
    'cancelled',
    'declined',
    'prepared',
    'closed',
    'completed'
  ]
    .map((phase) => phases.find((entry) => entry.phase === phase))
    .find((entry) => entry !== undefined)
  const visiblePhases = visibleActivities.map((activity) =>
    getToolExecutionPhase(activity, permission, notebookRunsById)
  )
  const remainingCount = visiblePhases.filter(
    (phase) => phase === 'executing' || phase === 'awaiting-approval'
  ).length
  const failedCount = visiblePhases.filter((phase) => phase === 'failed').length

  // Expanding or collapsing is a reading interaction, not message navigation.
  const handleToggleRow = useCallback(
    (activityId: string, nextExpanded: boolean): void => {
      stopAutoScroll()
      onToggleRow(activityId, nextExpanded)
    },
    [stopAutoScroll, onToggleRow]
  )

  if (visibleActivities.length === 0) return null

  return (
    <MessageScrollerItem key={group.id} messageId={group.id} className="min-w-0">
      <div className={cn('px-4 pb-0.5 pt-2.5 md:px-6', contentPaddingClassName)}>
        <WorkspaceActivityGroupSurface
          icon={
            summary ? (
              <WorkspaceActivityIcon activity={summary.activity} phase={summary.phase} />
            ) : undefined
          }
          isExpanded={isExpanded}
          onToggle={() => {
            stopAutoScroll()
            onToggleGroup(group.id)
          }}
          title={formatActivityGroupPresentationTitle(
            group.activities,
            group.title,
            permission,
            notebookRunsById,
            t
          )}
          meta={
            <>
              {remainingCount > 0
                ? t('{{count}} steps remaining', {
                    count: remainingCount,
                    defaultValue_one: '{{count}} step remaining'
                  })
                : formatStepCount(visibleActivities, permission, notebookRunsById, t)}
              {remainingCount > 0 && failedCount > 0
                ? ` · ${t('{{count}} failed', { count: failedCount })}`
                : null}
              {(isExpanded || remainingCount === 0) &&
              !phases.some(({ phase }) => phase === 'awaiting-approval') ? (
                <>
                  {' '}
                  ·{' '}
                  <ActivityGroupElapsed
                    activities={[
                      ...visibleActivities,
                      ...group.activities.filter(isNotebookCodeReviewActivity)
                    ]}
                    permission={permission}
                    notebookRunsById={notebookRunsById}
                  />
                </>
              ) : null}
            </>
          }
        >
          {renderableActivityEntries.map(({ activity, activityIndex }) => {
            const jobId = extractJobIdFromActivity(activity)
            return (
              <WorkspaceActivityGroupRow
                key={activity.id}
                activity={activity}
                phase={getToolExecutionPhase(activity, permission, notebookRunsById)}
                legacyIsSearch={isSearchActivity(activity, group.activities, activityIndex)}
                expansionOverride={expansionOverrides[activity.id]}
                allowFolderAccess={allowFolderAccess}
                notebookRunsById={notebookRunsById}
                onNotebookRunNearViewport={onNotebookRunNearViewport}
                onToggleRow={handleToggleRow}
                annotationPort={annotationPort}
                revealRequest={revealRequest?.itemId === activity.id ? revealRequest : undefined}
                boundJob={jobId ? jobsByActivityId?.get(jobId) : undefined}
                onOpenJobDetail={onOpenJobDetail}
              />
            )
          })}
        </WorkspaceActivityGroupSurface>
      </div>
    </MessageScrollerItem>
  )
}

export { WorkspaceActivityGroup }
