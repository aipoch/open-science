import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  derivePlanLifecycle,
  planStepTitles,
  projectPlanStepStates,
  type ActivePlanProjection
} from '../../../../../shared/session-plan/contract'
import { Button } from '@/components/ui/button'
import {
  selectProjectSessionReviewLoadError,
  selectProjectSessionReviewSnapshot,
  useReviewStore
} from '@/stores/review-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { type PreviewToolItem, usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { type ChatSession, type SessionStore, useSessionStore } from '@/stores/session-store'

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

const resolvePlanProjection = (
  session: ChatSession | undefined,
  planArtifactVersionId: string | undefined
): ActivePlanProjection | undefined => {
  const activePlanProjection = session?.activePlanProjection
  if (!planArtifactVersionId) return activePlanProjection

  return (
    (activePlanProjection?.artifactVersionId === planArtifactVersionId
      ? activePlanProjection
      : undefined) ??
    session?.planHistoryProjections?.find(
      (projection) => projection.artifactVersionId === planArtifactVersionId
    )
  )
}

type RuntimePlan = NonNullable<NonNullable<ChatSession['runtimeContext']>['plan']>

const projectionMatchesRuntimeIdentity = (
  projection: ActivePlanProjection,
  runtimePlan: RuntimePlan,
  planArtifactVersionId: string | undefined
): boolean =>
  projection.artifactVersionId === runtimePlan.artifactVersionId &&
  projection.artifactId === runtimePlan.artifactId &&
  projection.artifactChecksum === runtimePlan.artifactChecksum &&
  (!runtimePlan.originatingPromptMessageId ||
    projection.originatingPromptMessageId === runtimePlan.originatingPromptMessageId) &&
  (runtimePlan.materializedAt === undefined ||
    projection.materializedAt === runtimePlan.materializedAt) &&
  (!planArtifactVersionId || projection.artifactVersionId === planArtifactVersionId)

const projectRuntimePlan = (
  projection: ActivePlanProjection,
  runtimePlan: RuntimePlan,
  revision: number
): ActivePlanProjection => {
  const titles = planStepTitles(projection.document)
  return {
    ...projection,
    revision,
    approval: runtimePlan.approval,
    lifecycle: derivePlanLifecycle(
      projection.document,
      runtimePlan.approval,
      runtimePlan.stepStatuses
    ),
    stepStatuses: runtimePlan.stepStatuses,
    stepStates: projectPlanStepStates(projection.document, runtimePlan.stepStatuses),
    counts: {
      phases: projection.document.phases.length,
      delegations: projection.document.phases.reduce(
        (sum, phase) => sum + phase.delegations.length,
        0
      ),
      steps: titles.length,
      completed: titles.filter((title) => {
        const status = runtimePlan.stepStatuses[title]?.status
        return status === 'completed' || status === 'skipped'
      }).length,
      inProgress: titles.filter(
        (title) => runtimePlan.stepStatuses[title]?.status === 'in_progress'
      ).length
    }
  }
}

// Durable progress updates can invalidate the full projection while WorkspacePage reloads it.
// Keep the matching document visible for that short gap so the preview viewport stays mounted.
const createVisiblePlanProjectionSelector = (
  sessionId: string,
  planArtifactVersionId: string | undefined
): ((state: SessionStore) => ActivePlanProjection | undefined) => {
  let retainedProjection: ActivePlanProjection | undefined
  let projectedBase: ActivePlanProjection | undefined
  let projectedRuntimePlan: RuntimePlan | undefined
  let projectedRuntimeRevision: number | undefined
  let runtimeProjection: ActivePlanProjection | undefined

  return (state) => {
    const session = state.sessions.find((candidate) => candidate.id === sessionId)
    const projection = resolvePlanProjection(session, planArtifactVersionId)
    const activeProjection = session?.activePlanProjection
    if (projection && projection === activeProjection) {
      retainedProjection = projection
      return projection
    }

    const runtimePlan = session?.runtimeContext?.plan
    const runtimeRevision = session?.runtimeContext?.revision
    const candidate = projection ?? retainedProjection
    const retainedMatchesRuntime =
      candidate &&
      runtimePlan &&
      runtimeRevision !== undefined &&
      projectionMatchesRuntimeIdentity(candidate, runtimePlan, planArtifactVersionId)

    if (retainedMatchesRuntime) {
      if (projection) retainedProjection = projection
      if (
        candidate === projectedBase &&
        runtimePlan === projectedRuntimePlan &&
        runtimeRevision === projectedRuntimeRevision
      ) {
        return runtimeProjection
      }
      projectedBase = candidate
      projectedRuntimePlan = runtimePlan
      projectedRuntimeRevision = runtimeRevision
      runtimeProjection = projectRuntimePlan(candidate, runtimePlan, runtimeRevision)
      return runtimeProjection
    }
    if (projection) {
      retainedProjection = projection
      return projection
    }
    retainedProjection = undefined
    return undefined
  }
}

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

const PlanPreviewToolContent = ({
  item,
  restoredPlanResponder
}: {
  item: PreviewToolItem
  restoredPlanResponder?: RestoredPlanResponder
}): React.JSX.Element | null => {
  const isSideChatOpen = useIsSideChatOpenForSession(item.sessionId)
  const planSession = useSessionStore((state) =>
    state.sessions.find((session) => session.id === item.sessionId)
  )
  const [selectVisiblePlanProjection] = useState(() =>
    createVisiblePlanProjectionSelector(item.sessionId, item.planArtifactVersionId)
  )
  const visiblePlanProjection = useSessionStore(selectVisiblePlanProjection)
  const isPlanExpanded = usePreviewWorkbenchStore((state) => state.expandedToolItemId === item.id)
  const setToolItemExpanded = usePreviewWorkbenchStore((state) => state.setToolItemExpanded)
  const activePlanProjection = planSession?.activePlanProjection
  const runtimePlan = planSession?.runtimeContext?.plan

  const respondPlan = async (decision: 'approved' | 'rejected'): Promise<void> => {
    if (!visiblePlanProjection || !item.projectId) return
    if (planSession?.activeRun) {
      await respondToSessionPlan(
        {
          projectId: item.projectId,
          sessionId: item.sessionId,
          projection: visiblePlanProjection
        },
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
    visiblePlanProjection !== undefined &&
    planSession?.status === 'waiting-plan-approval' &&
    hasPlanResponsePath &&
    !isSideChatOpen

  if (!visiblePlanProjection || !planSession) return null
  const currentPlanArtifactVersionId =
    activePlanProjection?.artifactVersionId ?? runtimePlan?.artifactVersionId
  const stale = visiblePlanProjection.artifactVersionId !== currentPlanArtifactVersionId
  // The Plan's real artifact filename from the Session's artifact metadata; absent when the
  // artifact entry has not been loaded, in which case the header shows the label only.
  const planFilename = planSession.artifacts?.find(
    (artifact) => artifact.versionId === visiblePlanProjection.artifactVersionId
  )?.name
  return (
    <PlanPreviewSurface
      projection={visiblePlanProjection}
      stale={stale}
      isFullScreen={isPlanExpanded}
      planFilename={planFilename}
      onRespond={canRespondToPlan ? respondPlan : undefined}
      onToggleFullScreen={() => setToolItemExpanded(isPlanExpanded ? null : item.id)}
    />
  )
}

export const PreviewToolContent = ({
  item,
  restoredPlanResponder
}: {
  item: PreviewToolItem
  restoredPlanResponder?: RestoredPlanResponder
}): React.JSX.Element | null => {
  const activeProjectId = useNavigationStore((state) => state.activeProjectId)

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
    return (
      <PlanPreviewToolContent
        key={`${item.sessionId}:${item.planArtifactVersionId ?? 'active'}`}
        item={item}
        restoredPlanResponder={restoredPlanResponder}
      />
    )
  }

  if (!isNotebookPreviewItem(item)) return null

  return <NotebookPreview item={item} />
}
