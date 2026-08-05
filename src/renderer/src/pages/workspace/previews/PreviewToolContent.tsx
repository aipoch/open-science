import { selectProjectSessionReviews, useReviewStore } from '@/stores/review-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { type PreviewToolItem, usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'

import { NotebookPreview } from '../NotebookPreview'
import type { NotebookPreviewItem } from '../NotebookPreview'
import { ProjectFilesView } from '../ProjectFilesView'
import { SessionReviewerPanel } from '../SessionReviewerPanel'
import { respondToSessionPlan } from '../session-plan/respond-to-session-plan'
import { PlanPreviewSurface } from '../session-plan/SessionPlanSurfaces'

const isNotebookPreviewItem = (item: PreviewToolItem): item is NotebookPreviewItem =>
  item.toolKind === 'notebook' && Boolean(item.notebook)

// Renders the Session reviewer panel from persisted review data for the tool item's session.
const SessionReviewerContent = ({
  item,
  projectId
}: {
  item: PreviewToolItem
  projectId?: string
}): React.JSX.Element | null => {
  const sessionId = item.reviewerSessionId ?? ''
  const reviews = useReviewStore((state) =>
    selectProjectSessionReviews(state.reviewsBySession, projectId, sessionId)
  )
  // Select the review the finding actually points at; fall back to the newest when the item carries
  // no reviewId (e.g. a session-level entry point) or that review is gone.
  const review = reviews.find((r) => r.id === item.reviewerReviewId) ?? reviews[0]

  if (!review) {
    return (
      <div className="flex size-full items-center justify-center text-[12px] text-text-300">
        No review available for this session.
      </div>
    )
  }

  return <SessionReviewerPanel review={review} activeFindingId={item.reviewerActiveFindingId} />
}

export const PreviewToolContent = ({
  item
}: {
  item: PreviewToolItem
}): React.JSX.Element | null => {
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const planSession = useSessionStore((state) =>
    state.sessions.find((session) => session.id === item.sessionId)
  )
  const isPlanExpanded = usePreviewWorkbenchStore((state) => state.expandedToolItemId === item.id)
  const setToolItemExpanded = usePreviewWorkbenchStore((state) => state.setToolItemExpanded)
  const activePlanProjection = planSession?.activePlanProjection
  const planProjection = item.planArtifactVersionId
    ? (planSession?.planHistoryProjections?.find(
        (projection) => projection.artifactVersionId === item.planArtifactVersionId
      ) ??
      (activePlanProjection?.artifactVersionId === item.planArtifactVersionId
        ? activePlanProjection
        : undefined))
    : activePlanProjection

  const respondPlan = async (decision: 'approved' | 'rejected'): Promise<void> => {
    if (!planProjection || !item.projectId) return
    await respondToSessionPlan(
      { projectId: item.projectId, sessionId: item.sessionId, projection: planProjection },
      { decision }
    )
  }
  const canRespondToPlan =
    planSession?.status === 'waiting-plan-approval' && planSession.activeRun !== undefined

  // Remount the Files tool per project so its transient dialog cannot outlive the project it opened.
  if (item.toolKind === 'files') {
    return <ProjectFilesView key={activeProjectId ?? 'no-active-project'} />
  }

  if (item.toolKind === 'reviewer') {
    return <SessionReviewerContent item={item} projectId={activeProjectId} />
  }

  if (item.toolKind === 'plan') {
    if (!planProjection || !planSession) return null
    const stale = planProjection.artifactVersionId !== activePlanProjection?.artifactVersionId
    return (
      <PlanPreviewSurface
        projection={planProjection}
        stale={stale}
        isFullScreen={isPlanExpanded}
        onRespond={canRespondToPlan ? respondPlan : undefined}
        onToggleFullScreen={() => setToolItemExpanded(isPlanExpanded ? null : item.id)}
      />
    )
  }

  if (!isNotebookPreviewItem(item)) return null

  return <NotebookPreview item={item} />
}
