// Owns the bounded Reviewer correction loop and its durable re-review lifecycle.

import { createLogger } from '../logger'
import type { ReviewCheck, ReviewWithChecks } from '../../shared/reviewer'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  getActiveConversationContext,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import type { ReviewerAcpRuntime } from './acp-runtime'
import { ReviewerCorrectionOwner } from './correction'
import type { ArtifactVersionContentResolver } from './host-sdk'
import type { SessionAuxiliaryTurnUsageRecord } from '../session-persistence/auxiliary-turn-usage'
import { runReviewAssessment } from './review-assessment-owner'
import type { ReviewRepository } from './repository'
import { toErrorMessage } from '../error-message'

const log = createLogger('reviewer:orchestrator')

type SessionProvider = (
  sessionId: string
) => PersistedChatSession | undefined | Promise<PersistedChatSession | undefined>

type ReviewMutationRunner = <Result>(mutation: () => Promise<Result>) => Promise<Result>

const runReviewMutation = <Result>(
  runner: ReviewMutationRunner | undefined,
  mutation: () => Promise<Result>
): Promise<Result> => (runner ? runner(mutation) : mutation())

const SESSION_REFRESH_POLL_MS = 50

// Options for the Phase 3 fix loop.
type ReviewerFixLoopOptions = {
  sessionId: string
  // The original turn's message id (shared across all Review rows in this closure).
  originalTurnMessageId: string
  // The currently-open warn/fail checks to carry forward into each re-review.
  openChecks: ReviewCheck[]
  projectId: string
  mainSessionId: string
  getSession: SessionProvider
  reviewRepository: ReviewRepository
  runSessionMutation?: ReviewMutationRunner
  // Main Agent runtime used for [Auditor] correction turns.
  acpRuntime: ReviewerAcpRuntime
  // Runtime pinned for every scoped Reviewer re-assessment in this chain.
  reviewerAcpRuntime?: ReviewerAcpRuntime
  artifactStorageRoot: string
  artifactVersionContentResolver?: ArtifactVersionContentResolver
  reviewerMcpEntryPath?: string
  model: string
  onReviewUpdate?: (review: ReviewWithChecks) => void
  onCorrectionPrompt?: (text: string) => void
  onCorrectionFailed?: () => void
  reviewerTimeoutMs: number
  reviewerMaxUpdates: number
  maxRounds: number
  sessionRefreshTimeoutMs: number
  // Optional abort signal: when aborted, the loop exits at the next round boundary.
  abortSignal?: AbortSignal
  recordUsage?: (record: SessionAuxiliaryTurnUsageRecord) => Promise<unknown>
}

const waitForCorrectionAgentMessage = async (options: {
  sessionId: string
  correctionPromptMessageId: string
  messageIdsBefore: ReadonlySet<string>
  getSession: SessionProvider
  timeoutMs: number
  abortSignal?: AbortSignal
}): Promise<
  | {
      session: PersistedChatSession
      message: PersistedChatSession['messages'][number]
    }
  | undefined
> => {
  const deadline = Date.now() + options.timeoutMs

  for (;;) {
    if (options.abortSignal?.aborted) return undefined

    const latest = await options.getSession(options.sessionId)
    const correction = latest?.messages.find(
      (message) =>
        !options.messageIdsBefore.has(message.id) &&
        message.role === 'agent' &&
        message.status === 'complete' &&
        message.responseToMessageId === options.correctionPromptMessageId
    )
    if (latest && correction) return { session: latest, message: correction }

    if (Date.now() >= deadline) return undefined
    await new Promise<void>((resolve) => setTimeout(resolve, SESSION_REFRESH_POLL_MS))
  }
}

// Runs the Phase 3 bounded re-review loop. For each round (up to maxRounds):
// 1. Injects [Auditor] with the still-open warn/fail checks.
// 2. The main agent produces a correction turn.
// 3. Re-reviews the correction turn's new blocks.
// 4. Updates each original finding by its stable sourceFindingId:
//    - pass → resolved
//    - warn/fail → incrementReflagCount; stays open
//    - missing/unknown/duplicate id → submission rejected, original stays open
// 5. If all resolved or cap reached, stops.
// Cap termination marks remaining open warn/fail checks as 'unaddressed'.
export const runReviewerFixLoop = async (options: ReviewerFixLoopOptions): Promise<void> => {
  const {
    sessionId,
    originalTurnMessageId,
    projectId,
    mainSessionId,
    getSession,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    reviewerAcpRuntime = acpRuntime,
    artifactStorageRoot,
    artifactVersionContentResolver,
    reviewerMcpEntryPath,
    model,
    onReviewUpdate,
    onCorrectionPrompt,
    onCorrectionFailed,
    reviewerTimeoutMs,
    reviewerMaxUpdates,
    maxRounds,
    sessionRefreshTimeoutMs,
    abortSignal,
    recordUsage
  } = options

  let openChecks = [...options.openChecks]
  let causeReviewId = openChecks[0]?.reviewId
  const correctionOwner = new ReviewerCorrectionOwner({ acpRuntime, onCorrectionPrompt })
  const commitDispositionBatch = async (
    inputs: Parameters<ReviewRepository['commitFindingDispositions']>[0]
  ): Promise<void> => {
    if (inputs.length === 0) return
    await runReviewMutation(runSessionMutation, () =>
      reviewRepository.commitFindingDispositions(inputs)
    )

    // Finding/disposition writes change the original Review card without creating a new Review row.
    // Push each mutated row after commit so open Reviewer and Provenance surfaces reload immediately.
    const mutatedReviewIds = new Set(inputs.map((input) => input.reviewId))
    const reviews = await reviewRepository.getReviewsForProjectSession(projectId, sessionId)
    for (const review of reviews) {
      if (mutatedReviewIds.has(review.id)) onReviewUpdate?.(review)
    }
  }
  const markOpenChecksUnaddressed = async (
    trigger: 'loop_terminated' | 'correction_failed' | 'aborted',
    note: string
  ): Promise<void> => {
    await commitDispositionBatch(
      openChecks.map((openCheck) => ({
        reviewId: openCheck.reviewId,
        sourceFindingId: openCheck.id,
        trigger,
        outcome: 'unaddressed',
        note,
        assessedArtifactVersionId: openCheck.artifactVersionId
      }))
    )
  }

  for (let round = 0; round < maxRounds; round++) {
    if (openChecks.length === 0) break

    // Abort check: if the user cancelled during the loop, exit without further [Auditor] injections.
    if (abortSignal?.aborted) {
      log.info('fix loop: aborted by user', { sessionId, round, openCount: openChecks.length })
      await markOpenChecksUnaddressed('aborted', 'The fix loop was aborted by the user.')
      return
    }

    // Step A: record every known message id before the correction prompt. The provider is awaited on
    // every use; production reloads durable storage rather than returning the initial review snapshot.
    let sessionBefore: PersistedChatSession | undefined
    try {
      sessionBefore = await getSession(sessionId)
    } catch (error) {
      log.warn('fix loop: failed to load durable session before correction', {
        sessionId,
        round,
        error: toErrorMessage(error)
      })
      await markOpenChecksUnaddressed('correction_failed', 'Could not load the durable session.')
      return
    }
    if (!sessionBefore) {
      log.warn('fix loop: durable session disappeared before correction', { sessionId, round })
      await markOpenChecksUnaddressed('correction_failed', 'The durable session disappeared.')
      return
    }
    const messagesBefore = sessionBefore.messages
    const messageIdsBefore = new Set(messagesBefore.map((message) => message.id))

    // Step B: inject [Auditor] with the currently-open warn/fail checks.
    let correctionFailed = false
    let correctionPromptMessageId: string | undefined
    try {
      const conversationGraph =
        materializeSessionConversationGraph(sessionBefore).conversationGraph!
      const originatingPrompt = resolveActiveConversationMessages(conversationGraph)
        .toReversed()
        .find((message) => message.role === 'user' && message.status === 'complete')
      if (!originatingPrompt) {
        throw new Error(
          'The active conversation has no complete user prompt for correction provenance.'
        )
      }
      const provenanceContext = getActiveConversationContext(
        conversationGraph,
        originatingPrompt.id
      )
      const correctionResult = await correctionOwner.request({
        projectId,
        sessionId: mainSessionId,
        causeReviewId: causeReviewId ?? openChecks[0].reviewId,
        checks: openChecks,
        provenanceContext
      })
      if (correctionResult.status === 'failed') {
        correctionFailed = true
        onCorrectionFailed?.()
      } else if (correctionResult.status === 'completed') {
        correctionPromptMessageId = correctionResult.promptMessageId
      }
    } catch (error) {
      correctionFailed = true
      log.warn('fix loop: failed to derive correction provenance', {
        sessionId,
        round,
        error: toErrorMessage(error)
      })
    }

    // Error handling: a failed correction counts as a round (prevents infinite loop) but we
    // cannot re-review (there's no correction turn). Mark remaining as unaddressed and stop.
    if (correctionFailed || !correctionPromptMessageId) {
      log.warn('correction failed in fix loop — marking remaining checks unaddressed', {
        sessionId,
        round,
        openCount: openChecks.length
      })
      await markOpenChecksUnaddressed('correction_failed', 'The correction prompt failed.')
      return
    }

    // Step C: wait for the new agent message to reach durable storage. sendPrompt completion and the
    // renderer persistence queue are independent, so an immediate one-shot reload is still racy.
    let correctionState:
      | { session: PersistedChatSession; message: PersistedChatSession['messages'][number] }
      | undefined
    try {
      correctionState = await waitForCorrectionAgentMessage({
        sessionId,
        correctionPromptMessageId,
        messageIdsBefore,
        getSession,
        timeoutMs: sessionRefreshTimeoutMs,
        abortSignal
      })
    } catch (error) {
      log.warn('fix loop: failed while refreshing durable correction turn', {
        sessionId,
        round,
        error: toErrorMessage(error)
      })
      await markOpenChecksUnaddressed(
        'correction_failed',
        'Could not reload the durable correction turn.'
      )
      return
    }
    if (!correctionState) {
      if (abortSignal?.aborted) {
        log.info('fix loop: aborted while waiting for durable correction turn', {
          sessionId,
          round
        })
        await markOpenChecksUnaddressed('aborted', 'The fix loop was aborted by the user.')
        return
      }
      log.warn('correction turn did not reach durable session storage; refusing stale re-review', {
        sessionId,
        round,
        timeoutMs: sessionRefreshTimeoutMs
      })
      await markOpenChecksUnaddressed(
        'correction_failed',
        'The correction turn did not reach durable storage.'
      )
      return
    }

    const correctionTurnMessageId = correctionState.message.id

    // Step D: run a re-review scoped to the correction turn's new blocks.
    // This creates a new Review row sharing the original turnMessageId.
    log.info('fix loop: running re-review', { sessionId, round, correctionTurnMessageId })

    const scopedResult = await runReviewAssessment({
      mode: 'tracked',
      session: correctionState.session,
      sessionId,
      scopeTurnMessageId: correctionTurnMessageId,
      turnMessageId: originalTurnMessageId,
      projectId,
      reviewRepository,
      runSessionMutation,
      acpRuntime: reviewerAcpRuntime,
      artifactStorageRoot,
      artifactVersionContentResolver,
      reviewerMcpEntryPath,
      model,
      onReviewUpdate,
      reviewerTimeoutMs,
      reviewerMaxUpdates,
      trackedChecks: openChecks,
      recordUsage
    })
    const reReviewResult = scopedResult.review

    // Step E: compute resolution transitions for the original review's open checks.
    // - If the re-review errored: count as a round but mark remaining unaddressed and stop.
    // - Each original finding is matched only by sourceFindingId, never by model-generated prose.
    // - A pass disposition resolves it; warn/fail increments reflagCount and keeps it open.
    // - Missing dispositions are rejected by MCP and stay open defensively if one slips through.

    if (reReviewResult.lifecycle === 'error') {
      log.warn('fix loop: re-review errored — marking remaining checks unaddressed', {
        sessionId,
        round,
        openCount: openChecks.length
      })
      await markOpenChecksUnaddressed('correction_failed', 'The scoped re-review failed.')
      return
    }
    causeReviewId = reReviewResult.id

    const dispositionsByFindingId = new Map(
      scopedResult.submittedChecks.flatMap((check) =>
        check.sourceFindingId ? [[check.sourceFindingId, check] as const] : []
      )
    )

    const stillOpenChecks: ReviewCheck[] = []

    for (const openCheck of openChecks) {
      const disposition = dispositionsByFindingId.get(openCheck.id)
      if (!disposition) {
        // The MCP server rejects incomplete submissions, so this is defensive fail-closed behavior.
        log.error('fix loop: scoped re-review omitted a tracked finding disposition', {
          sessionId,
          round,
          findingId: openCheck.id
        })
        stillOpenChecks.push(openCheck)
      } else if (disposition.status === 'warn' || disposition.status === 'fail') {
        log.info('fix loop: finding re-flagged', {
          sessionId,
          round,
          findingId: openCheck.id
        })
        stillOpenChecks.push(openCheck)
      } else {
        log.info('fix loop: finding resolved', { sessionId, round, findingId: openCheck.id })
      }
    }

    const newIssueSortIndexes = new Set(
      scopedResult.submittedChecks
        .filter(
          (check) => !check.sourceFindingId && (check.status === 'warn' || check.status === 'fail')
        )
        .map((check) => check.sortIndex)
    )
    const newlyOpenChecks = reReviewResult.checks.filter(
      (check) =>
        newIssueSortIndexes.has(check.sortIndex) &&
        (check.status === 'warn' || check.status === 'fail')
    )
    if (newlyOpenChecks.length > 0) {
      log.info('fix loop: carrying newly discovered findings into the next round', {
        sessionId,
        round,
        count: newlyOpenChecks.length
      })
    }

    openChecks = [...stillOpenChecks, ...newlyOpenChecks]

    if (openChecks.length === 0) {
      log.info('fix loop: all checks resolved', { sessionId, rounds: round + 1 })
      return
    }

    log.info('fix loop: still-open checks remain', {
      sessionId,
      round,
      stillOpen: openChecks.length
    })
  }

  // Cap reached: mark remaining open warn/fail checks as unaddressed.
  if (openChecks.length > 0) {
    log.info('fix loop: cap reached — marking remaining checks unaddressed', {
      sessionId,
      maxRounds,
      remaining: openChecks.length
    })
    await markOpenChecksUnaddressed(
      'loop_terminated',
      `Fix loop reached its ${maxRounds}-round cap.`
    )
  }
}
