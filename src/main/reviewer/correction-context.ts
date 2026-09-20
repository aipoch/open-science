import { isDeepStrictEqual } from 'node:util'

import {
  getActiveConversationContext,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  type PersistedChatMessage,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { REVIEW_CORRECTION_CONTEXT_CHANGED, type TurnScope } from '../../shared/reviewer'
import {
  isReviewTurnStartingMessage,
  isTurnScopeStale,
  resolveReviewTurnProjection,
  resolveTurnScope
} from './scope'

type ContextChangeReason =
  | 'reviewed-turn-unavailable'
  | 'frame-or-branch-changed'
  | 'conversation-path-changed'
  | 'requirements-changed'
  | 'reviewed-evidence-changed'
  | 'plan-requirements-changed'
  | 'unexpected-correction-turn'

export class ReviewerCorrectionContextChangedError extends Error {
  constructor(readonly reason: ContextChangeReason) {
    super(REVIEW_CORRECTION_CONTEXT_CHANGED)
    this.name = 'ReviewerCorrectionContextChangedError'
  }
}

const reject = (reason: ContextChangeReason): never => {
  throw new ReviewerCorrectionContextChangedError(reason)
}

type RequestRequirements = Pick<
  PersistedChatMessage,
  | 'id'
  | 'role'
  | 'content'
  | 'responseToMessageId'
  | 'attribution'
  | 'uploads'
  | 'images'
  | 'annotations'
  | 'parts'
  | 'pdfContext'
  | 'turnIntent'
  | 'delegatedTask'
  | 'delegatedInputVersionIds'
  | 'relayedFrom'
>
type PlanRequirement = {
  versionId: string
  checksum: string
  approval: 'pending' | 'approved' | 'rejected'
}
type ReviewedTurn = {
  evidenceScope: TurnScope
  frameId: string
  branchId: string
  promptId: string
  pathIds: string[]
  requests: RequestRequirements[]
}
type ConversationGraph = NonNullable<PersistedChatSession['conversationGraph']>

// Preserve user intent and inputs, not runtime timestamps, usage or publication metadata. Keep this
// snapshot private: neither request text nor attachment data belongs in rejection diagnostics.
const requirements = (message: PersistedChatMessage): RequestRequirements => ({
  id: message.id,
  role: message.role,
  content: message.content,
  responseToMessageId: message.responseToMessageId,
  attribution: message.attribution,
  uploads: message.uploads,
  images: message.images,
  annotations: message.annotations,
  parts: message.parts,
  pdfContext: message.pdfContext,
  turnIntent: message.turnIntent,
  delegatedTask: message.delegatedTask,
  delegatedInputVersionIds: message.delegatedInputVersionIds,
  relayedFrom: message.relayedFrom
})

// Progress/delivery receipts may advance while review runs. A different Plan Version or approval
// changes the requirements. Historical authorities keep the original task pinned across corrections.
const planRequirement = (
  session: PersistedChatSession,
  promptId: string
): PlanRequirement | undefined => {
  const current = session.runtimeContext?.plan
  const plan =
    current?.originatingPromptMessageId === promptId
      ? current
      : session.planHistoryProjections?.findLast(
          (candidate) => candidate.originatingPromptMessageId === promptId
        )
  return plan
    ? {
        versionId: plan.artifactVersionId,
        checksum: plan.artifactChecksum,
        approval: plan.approval
      }
    : undefined
}

const reviewedTurn = (session: PersistedChatSession, scope: TurnScope): ReviewedTurn => {
  const materialized = session.conversationGraph
    ? session
    : materializeSessionConversationGraph(session)
  const projection = resolveReviewTurnProjection(
    materialized,
    scope.turnMessageId,
    scope.messageBranchId
  )
  const ids = new Set(
    scope.blocks.filter((block) => block.kind === 'message').map((block) => block.sourceId)
  )
  const messages = projection.messages.filter((message) => ids.has(message.id))
  const prompt = messages.find(isReviewTurnStartingMessage)
  if (
    !prompt ||
    messages.length !== ids.size ||
    !messages.some((message) => message.id === scope.turnMessageId)
  ) {
    return reject('reviewed-turn-unavailable')
  }
  const start = projection.messages.findIndex((message) => message.id === prompt.id)
  const path = projection.messages.slice(start)
  // No message that arrived after the frozen review may become an implicit part of its correction.
  if (path.some((message) => !ids.has(message.id))) return reject('conversation-path-changed')
  return {
    // Artifact bytes were frozen by the review's evidence resolver. This structural witness checks
    // transcript/tool edits and Version identities without re-reading every immutable Artifact.
    evidenceScope: resolveTurnScope(
      materialized,
      scope.turnMessageId,
      new Map(),
      scope.messageBranchId
    ),
    frameId: projection.agentFrameId!,
    branchId: projection.messageBranchId!,
    promptId: prompt.id,
    pathIds: path.map((message) => message.id),
    requests: messages.filter((message) => message.role === 'user').map(requirements)
  }
}

// One correction chain owns the original requirements plus each actually reviewed correction turn.
// A later re-review advances the eligible tail; it never silently refreshes the original requirements.
export class ReviewerCorrectionContext {
  private readonly frameId: string
  private readonly branchId: string
  private readonly originId: string
  private promptId: string
  private pathIds: string[]
  private requests: ReturnType<typeof requirements>[]
  private evidenceScope: TurnScope
  private readonly plans = new Map<string, ReturnType<typeof planRequirement>>()

  constructor(session: PersistedChatSession, scope: TurnScope) {
    const reviewed = reviewedTurn(session, scope)
    this.frameId = reviewed.frameId
    this.branchId = reviewed.branchId
    this.originId = reviewed.promptId
    this.promptId = reviewed.promptId
    this.pathIds = reviewed.pathIds
    this.requests = structuredClone(reviewed.requests)
    this.evidenceScope = reviewed.evidenceScope
    this.plans.set(reviewed.promptId, planRequirement(session, reviewed.promptId))
  }

  private activePath(session: PersistedChatSession): {
    graph: ConversationGraph
    path: ConversationGraph['messages']
  } {
    const graph =
      session.conversationGraph ?? materializeSessionConversationGraph(session).conversationGraph!
    const frame = graph.frames.find((candidate) => candidate.id === graph.activeFrameId)
    if (frame?.id !== this.frameId || frame.activeBranchId !== this.branchId) {
      return reject('frame-or-branch-changed')
    }
    const messages = resolveActiveConversationMessages(graph)
    const start = messages.findIndex((message) => message.id === this.originId)
    if (start < 0) return reject('reviewed-turn-unavailable')
    const path = messages.slice(start)
    for (const expected of this.requests) {
      const current = path.find((message) => message.id === expected.id)
      if (
        !current ||
        current.status !== 'complete' ||
        !isDeepStrictEqual(requirements(current), expected)
      ) {
        return reject('requirements-changed')
      }
    }
    for (const [promptId, expected] of this.plans) {
      if (!isDeepStrictEqual(planRequirement(session, promptId), expected)) {
        return reject('plan-requirements-changed')
      }
    }
    return { graph, path }
  }

  resolve(session: PersistedChatSession): ReturnType<typeof getActiveConversationContext> {
    const { graph, path } = this.activePath(session)
    if (
      !isDeepStrictEqual(
        path.map((message) => message.id),
        this.pathIds
      )
    ) {
      return reject('conversation-path-changed')
    }
    const currentScope = resolveTurnScope(
      { ...session, conversationGraph: graph },
      this.evidenceScope.turnMessageId,
      new Map(),
      this.branchId
    )
    if (isTurnScopeStale(this.evidenceScope, currentScope))
      return reject('reviewed-evidence-changed')
    return getActiveConversationContext(graph, this.promptId)
  }

  advance(session: PersistedChatSession, scope: TurnScope, correctionPromptId: string): void {
    const { path } = this.activePath(session)
    const next = reviewedTurn(session, scope)
    if (
      next.frameId !== this.frameId ||
      next.branchId !== this.branchId ||
      next.promptId !== correctionPromptId
    ) {
      return reject('unexpected-correction-turn')
    }
    if (
      !isDeepStrictEqual(
        path.map((message) => message.id),
        [...this.pathIds, ...next.pathIds]
      )
    ) {
      return reject('conversation-path-changed')
    }
    this.pathIds = [...this.pathIds, ...next.pathIds]
    this.promptId = next.promptId
    this.evidenceScope = next.evidenceScope
    this.plans.set(next.promptId, planRequirement(session, next.promptId))
    this.requests.push(...structuredClone(next.requests))
  }
}
