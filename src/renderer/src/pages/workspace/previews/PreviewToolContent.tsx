import { LoaderCircle } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  selectProjectSessionReviewLoadError,
  selectProjectSessionReviewSnapshot,
  useReviewStore
} from '@/stores/review-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { type PreviewToolItem, usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionStore } from '@/stores/session-store'

import { NotebookPreview } from '../NotebookPreview'
import type { NotebookPreviewItem } from '../NotebookPreview'
import { ProjectFilesView } from '../ProjectFilesView'
import { SessionReviewerPanel } from '../SessionReviewerPanel'
import { SubagentPreview } from '../SubagentReleaseSurfaces'
import { respondToSessionPlan } from '../session-plan/respond-to-session-plan'
import { PlanPreviewSurface, type RestoredPlanResponder } from '../session-plan/SessionPlanSurfaces'
import { useIsSideChatOpenForSession } from '../use-side-chat-controller'

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
  const { t } = useTranslation()
  const sessionId = item.reviewerSessionId ?? ''
  const reviews = useReviewStore((state) =>
    selectProjectSessionReviewSnapshot(
      state.reviewsBySession,
      projectId,
      sessionId,
      state.loadedReviewSessions
    )
  )
  const loadError = useReviewStore((state) =>
    selectProjectSessionReviewLoadError(state.loadErrorsBySession, projectId, sessionId)
  )
  const loadReviewsForSession = useReviewStore((state) => state.loadReviewsForSession)

  useEffect(() => {
    if (!sessionId || reviews !== undefined || loadError) return
    void loadReviewsForSession(sessionId, projectId)
  }, [loadError, loadReviewsForSession, projectId, reviews, sessionId])

  if (sessionId && reviews === undefined) {
    if (loadError) {
      return (
        <div className="flex size-full items-center justify-center px-6 py-8">
          <div role="alert" className="text-center">
            <p className="text-[12px] text-danger-000">{t('Could not load review history.')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => void loadReviewsForSession(sessionId, projectId)}
            >
              {t('Retry')}
            </Button>
          </div>
        </div>
      )
    }

    return (
      <div
        role="status"
        aria-live="polite"
        className="flex size-full items-center justify-center gap-2 text-[12px] text-text-300"
      >
        <LoaderCircle
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        {t('Loading review history…')}
      </div>
    )
  }

  const loadedReviews = reviews ?? []
  // Select the review the finding actually points at; fall back to the newest when the item carries
  // no reviewId (e.g. a session-level entry point) or that review is gone.
  const review =
    loadedReviews.find((candidate) => candidate.id === item.reviewerReviewId) ?? loadedReviews[0]

  if (!review) {
    return (
      <div className="flex size-full items-center justify-center text-[12px] text-text-300">
        {t('No review available for this session.')}
      </div>
    )
  }

  return <SessionReviewerPanel review={review} activeFindingId={item.reviewerActiveFindingId} />
}

export const PreviewToolContent = ({
  item,
  restoredPlanResponder
}: {
  item: PreviewToolItem
  restoredPlanResponder?: RestoredPlanResponder
}): React.JSX.Element | null => {
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)
  const isSideChatOpen = useIsSideChatOpenForSession(item.sessionId)
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
    if (planSession?.activeRun) {
      await respondToSessionPlan(
        { projectId: item.projectId, sessionId: item.sessionId, projection: planProjection },
        { decision }
      )
      return
    }
    if (restoredPlanResponder?.sessionId !== item.sessionId) return
    await restoredPlanResponder.respond({ decision })
  }
  const hasPlanResponsePath =
    planSession?.activeRun !== undefined || restoredPlanResponder?.sessionId === item.sessionId
  const canRespondToPlan =
    planSession?.status === 'waiting-plan-approval' && hasPlanResponsePath && !isSideChatOpen

  // Remount the Files tool per project so its transient dialog cannot outlive the project it opened.
  if (item.toolKind === 'files') {
    return <ProjectFilesView key={activeProjectId ?? 'no-active-project'} />
  }

  if (item.toolKind === 'reviewer') {
    return <SessionReviewerContent item={item} projectId={activeProjectId} />
  }

  if (item.toolKind === 'subagents') {
    return <SubagentPreview item={item} />
  }

  if (item.toolKind === 'plan') {
    if (!planProjection || !planSession) return null
    const stale = planProjection.artifactVersionId !== activePlanProjection?.artifactVersionId
    // The Plan's real artifact filename from the Session's artifact metadata; absent when the
    // artifact entry has not been loaded, in which case the header shows the label only.
    const planFilename = planSession.artifacts?.find(
      (artifact) => artifact.versionId === planProjection.artifactVersionId
    )?.name
    return (
      <PlanPreviewSurface
        projection={planProjection}
        stale={stale}
        isFullScreen={isPlanExpanded}
        planFilename={planFilename}
        onRespond={canRespondToPlan ? respondPlan : undefined}
        onToggleFullScreen={() => setToolItemExpanded(isPlanExpanded ? null : item.id)}
      />
    )
  }

  if (!isNotebookPreviewItem(item)) return null

  return <NotebookPreview item={item} />
}
