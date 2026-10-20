// Reconstruct a stopped correction's ownership from its durable prompt and Review rows.
// Completion notifications are hints only: callers reload Main's current Session before admission.
import {
  isReviewerCorrectionAttribution,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
import type { ReviewCheck, ReviewWithChecks } from '../../shared/reviewer'
import { isTurnScopeStale } from './scope'
import { resolveTurnScopeWithArtifactDigests } from './artifact-digest'
import type { ArtifactVersionContentResolver } from './host-sdk'

type CorrectionCheckpoint = { round: number; maxRounds: number; findingIds: string[] }
export type CorrectionResume = {
  sourceReview: ReviewWithChecks
  reviewedSession: PersistedChatSession
  openChecks: ReviewCheck[]
  maxRounds: number
  resumeCorrection: { promptMessageId: string; turnMessageId: string; round: number }
}

// Older correction prompts predate the explicit budget checkpoint. Follow their persisted
// cause/scope links back to the initial Review; production used a three-round cap. Refuse
// incomplete or cyclic history rather than guessing a fresh budget.
const legacyCheckpoint = (
  source: ReviewWithChecks,
  messages: PersistedChatSession['messages'],
  reviews: ReviewWithChecks[]
): CorrectionCheckpoint | undefined => {
  let current = source
  let round = 0
  const visited = new Set<string>()
  while (current.scope.turnMessageId !== current.turnMessageId) {
    if (visited.has(current.id) || round >= 2) return undefined
    visited.add(current.id)
    const answer = messages.find((message) => message.id === current.scope.turnMessageId)
    const prompt = messages.find((message) => message.id === answer?.responseToMessageId)
    const attribution = prompt?.attribution
    if (!isReviewerCorrectionAttribution(attribution)) return undefined
    const previous = reviews.find(
      (review) =>
        review.id === attribution.causeReviewId && review.turnMessageId === source.turnMessageId
    )
    if (!previous) return undefined
    current = previous
    round++
  }
  const findingIds = [
    ...new Set([
      ...source.checks
        .filter((check) => check.status === 'warn' || check.status === 'fail')
        .map((check) => check.id),
      ...(source.submittedChecks ?? []).flatMap((check) =>
        check.kind === 'tracked' && check.dispositionOutcome === 'still_open'
          ? [check.sourceFindingId]
          : []
      )
    ])
  ]
  return findingIds.length ? { round, maxRounds: 3, findingIds } : undefined
}

export const resolveCorrectionResume = (
  session: PersistedChatSession,
  reviews: ReviewWithChecks[]
): CorrectionResume | undefined => {
  const run = session.runtimeTranscriptLastRun
  if (
    !run ||
    session.activeRun ||
    session.resumeRecovery ||
    session.status !== 'idle' ||
    session.autoReviewEnabled !== true ||
    session.packageOrigin
  )
    return undefined
  const messages = session.conversationGraph
    ? resolveActiveConversationMessages(session.conversationGraph)
    : session.messages
  const prompt = messages.find((message) => message.id === run.promptMessageId)
  if (!isReviewerCorrectionAttribution(prompt?.attribution)) return undefined
  const attribution = prompt.attribution
  const answer = messages.findLast(
    (message) => message.role === 'agent' && message.responseToMessageId === prompt.id
  )
  if (
    !answer ||
    answer.status !== 'complete' ||
    reviews.some((review) => review.scope.turnMessageId === answer.id)
  )
    return undefined
  const sourceReview = reviews.find((review) => review.id === attribution.causeReviewId)
  if (!sourceReview) return undefined
  const checkpoint = attribution.continuation ?? legacyCheckpoint(sourceReview, messages, reviews)
  if (!checkpoint) return undefined
  const graph = session.conversationGraph
  if (graph) {
    const frame = graph.frames.find((frame) => frame.id === graph.activeFrameId)
    if (
      frame?.id !== sourceReview.scope.agentFrameId ||
      frame?.activeBranchId !== sourceReview.scope.messageBranchId
    )
      return undefined
  }
  const openChecks: ReviewCheck[] = []
  for (const id of checkpoint.findingIds) {
    const check = reviews.flatMap((review) => review.checks).find((check) => check.id === id)
    if (!check || check.resolution === 'resolved' || !['warn', 'fail'].includes(check.status))
      return undefined
    openChecks.push(check)
  }
  // The correction context starts at the previously reviewed tail, not at the recovered answer.
  const promptIndex = messages.findIndex((message) => message.id === prompt.id)
  const before = messages.slice(0, promptIndex)
  const reviewedSession: PersistedChatSession = {
    ...session,
    messages: before,
    ...(graph
      ? {
          conversationGraph: {
            ...graph,
            branches: graph.branches.map((branch) =>
              branch.id === sourceReview.scope.messageBranchId
                ? { ...branch, headMessageId: before.at(-1)?.id }
                : branch
            )
          }
        }
      : {})
  }
  return {
    sourceReview,
    reviewedSession,
    openChecks,
    maxRounds: checkpoint.maxRounds,
    resumeCorrection: {
      promptMessageId: prompt.id,
      turnMessageId: answer.id,
      round: checkpoint.round
    }
  }
}

export const isCorrectionResumeScopeCurrent = async (
  resume: CorrectionResume,
  artifactStorageRoot: string,
  resolveArtifactVersion?: ArtifactVersionContentResolver
): Promise<boolean> => {
  const scope = resume.sourceReview.scope
  const current = await resolveTurnScopeWithArtifactDigests(
    resume.reviewedSession,
    scope.turnMessageId,
    artifactStorageRoot,
    resolveArtifactVersion,
    scope.messageBranchId
  )
  return !isTurnScopeStale(scope, current)
}
