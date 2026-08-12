import type {
  DelegatedReviewEvidenceScope,
  ReviewRunRequest,
  ReviewRunResult,
  ReviewSessionRequest,
  ReviewWithChecks
} from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { assertDelegatedReviewEvidenceScope, resolveTurnScope } from '../reviewer/scope'
import type { SessionKey } from './session-records'

type DelegatedReviewScope = Readonly<
  DelegatedReviewEvidenceScope & {
    session: SessionKey
  }
>

type DelegatedReviewOwner = Readonly<{
  run(request: ReviewRunRequest): Promise<ReviewRunResult>
  getForSession(request: ReviewSessionRequest): Promise<ReviewWithChecks[]>
}>

type DelegatedReviewEvidenceOptions = Readonly<{
  loadSession(session: SessionKey): Promise<PersistedChatSession | undefined>
  reviews: DelegatedReviewOwner
}>

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const resolveExactScope = async (
  options: DelegatedReviewEvidenceOptions,
  requested: DelegatedReviewScope
): Promise<ReturnType<typeof resolveTurnScope>> => {
  const session = await options.loadSession(requested.session)
  if (
    !session ||
    session.id !== requested.session.sessionId ||
    session.projectId !== requested.session.projectId
  ) {
    throw new Error('Delegated Review Session is unavailable.')
  }
  const resolved = resolveTurnScope(
    session,
    requested.terminalMessageId,
    new Map(),
    requested.messageBranchId
  )
  assertDelegatedReviewEvidenceScope(session, resolved, requested)
  return resolved
}

const createDelegatedReviewEvidence = (
  options: DelegatedReviewEvidenceOptions
): Readonly<{
  audit(scope: DelegatedReviewScope): Promise<ReviewRunResult>
  project(scope: DelegatedReviewScope): Promise<readonly ReviewWithChecks[]>
}> => ({
  async audit(scope) {
    await resolveExactScope(options, scope)
    const { session, ...evidenceScope } = scope
    return options.reviews.run({
      projectId: session.projectId,
      sessionId: session.sessionId,
      turnMessageId: scope.terminalMessageId,
      evidenceScope: {
        ...evidenceScope,
        artifactVersionIds: [...evidenceScope.artifactVersionIds]
      }
    })
  },
  async project(scope) {
    await resolveExactScope(options, scope)
    const reviews = await options.reviews.getForSession({
      projectId: scope.session.projectId,
      appSessionId: scope.session.sessionId
    })
    return reviews.filter(
      (review) =>
        review.turnMessageId === scope.terminalMessageId &&
        review.scope.turnMessageId === scope.terminalMessageId &&
        review.scope.agentFrameId === scope.agentFrameId &&
        review.scope.messageBranchId === scope.messageBranchId &&
        sameIds(review.scope.artifactVersionIds, scope.artifactVersionIds)
    )
  }
})

export { createDelegatedReviewEvidence }
export type { DelegatedReviewEvidenceOptions, DelegatedReviewOwner, DelegatedReviewScope }
