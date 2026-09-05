import type { ChatSession } from '@/stores/session-store'

import type {
  ActivePlanProjection,
  PlanDocumentV1
} from '../../../../../shared/session-plan/contract'
import { planStepTitles } from '../../../../../shared/session-plan/contract'

// The resolution only consults a Session's Plan projections, so the narrow pick keeps the seam
// testable without constructing a whole ChatSession.
export type PlanProjectionSource = Readonly<
  Pick<ChatSession, 'planHistoryProjections' | 'activePlanProjection'> & {
    runtimeContext?: Readonly<{
      plan?: Readonly<{ artifactVersionId: string }>
    }>
  }
>

// The projection fields the Plan document body renders. Narrower than ActivePlanProjection so a
// file snapshot never fabricates approval/lifecycle metadata the rendering never reads.
export type PlanDocumentProjection = Readonly<
  Pick<ActivePlanProjection, 'document' | 'stepStatuses' | 'stepStates'>
>

export type PlanFileProjectionResolution = Readonly<{
  projection: ActivePlanProjection
  // True when the Session already runs a different (newer) Plan than the previewed file.
  stale: boolean
}>

// Mirrors the projection lookup the in-chat Plan tool preview performs: prefer the active
// projection when it matches the exact Artifact Version because it carries the latest runtime
// progress, then fall back to the persisted plan history for older versions.
export const resolvePlanFileProjection = (
  session: PlanProjectionSource | undefined,
  artifactVersionId: string | undefined
): PlanFileProjectionResolution | undefined => {
  if (!session || !artifactVersionId) return undefined
  const active = session.activePlanProjection
  const currentArtifactVersionId =
    active?.artifactVersionId ?? session.runtimeContext?.plan?.artifactVersionId
  const projection =
    (active?.artifactVersionId === artifactVersionId ? active : undefined) ??
    session.planHistoryProjections?.find(
      (candidate) => candidate.artifactVersionId === artifactVersionId
    )
  if (!projection) return undefined
  return {
    projection,
    stale: Boolean(
      currentArtifactVersionId && currentArtifactVersionId !== projection.artifactVersionId
    )
  }
}

// A previewed Plan file is a bare document: it carries no runtime state of its own. When no stored
// projection matches, this projects a read-only snapshot whose steps are all not started.
export const snapshotPlanProjection = (document: PlanDocumentV1): PlanDocumentProjection => {
  const stepTitles = planStepTitles(document)
  return {
    document,
    stepStatuses: {},
    stepStates: Object.fromEntries(
      stepTitles.map((title) => [title, { status: 'not_started' as const }])
    )
  }
}
