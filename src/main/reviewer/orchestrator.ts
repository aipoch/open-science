// Orchestrator for the auto-review pipeline. `runReview` is called after each turn completes;
// it spawns a fresh-context reviewer ACP session, injects the rubric + scope-bounded reviewer MCP,
// drives the reviewer to completion, persists findings, and then disposes the session.
//
// Phase 3: after a review with warn/fail, `runFixLoop` drives the bounded re-review loop:
// inject → correction turn → re-review new blocks → resolve/reflag → repeat (max 3 rounds).
//
// Errors are isolated: reviewer failures set lifecycle='error' and do NOT crash the main session.

import { randomUUID } from 'node:crypto'

import { withReviewerRuntimeActivity, type ReviewerAcpRuntime } from './acp-runtime'
import { createLogger } from '../logger'
import type { ReviewCheck, ReviewWithChecks } from '../../shared/reviewer'
import type { ReviewRepository } from './repository'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { ArtifactVersionContentResolver } from './host-sdk'
import { injectAuditorMessage } from './correction'
import { buildHistoryPreamble } from '../../shared/history-preamble'
import { getActiveConversationContext } from '../../shared/conversation-graph'
import { runReviewAssessment, type ReviewAssessmentResult } from './review-assessment-owner'

export { buildReviewerPrompt } from './review-assessment-owner'
export { driveReviewerToStop } from './reviewer-session-driver'

const log = createLogger('reviewer:orchestrator')

type SessionProvider = (
  sessionId: string
) => PersistedChatSession | undefined | Promise<PersistedChatSession | undefined>

type ReviewMutationRunner = <Result>(mutation: () => Promise<Result>) => Promise<Result>

const runReviewMutation = <Result>(
  runner: ReviewMutationRunner | undefined,
  mutation: () => Promise<Result>
): Promise<Result> => (runner ? runner(mutation) : mutation())

export type RunReviewOptions = {
  sessionId: string
  // The turn to review: the agent message id (or user message id) for that turn. This is also the
  // grouping id stored on the Review row.
  turnMessageId: string
  // Turn whose content is audited when it differs from turnMessageId (e.g. re-running a fix-loop
  // review). The scope is resolved from this turn; the row is still grouped under turnMessageId.
  // Defaults to turnMessageId.
  scopeTurnMessageId?: string
  // Called once the running Review row has been created and pushed — i.e. the review is confirmed to
  // have started. A failure before this point (scope resolution, the DB insert) throws without calling
  // it, so the caller can report started:false and leave the turn retriable.
  onStarted?: () => void
  // The project this session belongs to.
  projectId: string
  // Used to resolve the session's persisted data for turn-scope resolution.
  // For the fix loop, this is called after each correction turn so it must return the LATEST session.
  getSession: SessionProvider
  // Repository for persisting review rows + checks.
  reviewRepository: ReviewRepository
  // Joins every durable Review write to the Session deletion/save ordering boundary without holding
  // the lock while the remote reviewer model is running.
  runSessionMutation?: ReviewMutationRunner
  // The ACP runtime that owns the agent connection (used to spawn the reviewer session).
  acpRuntime: ReviewerAcpRuntime
  // Storage root for artifact reads (used by the scope-bounded evidence reader).
  artifactStorageRoot: string
  // Native Version resolver for current provenance rows. Tests and legacy callers may omit it and
  // retain the old session-path lookup.
  artifactVersionContentResolver?: ArtifactVersionContentResolver
  // Main-process entry reused by the Windows-only Reviewer stdio proxy.
  reviewerMcpEntryPath?: string
  // The model/provider tag to record on the Review row.
  model?: string
  // Called when the review lifecycle changes, so the IPC layer can broadcast updates.
  onReviewUpdate?: (review: ReviewWithChecks) => void
  // The main session id to inject the [Auditor] correction message into (if warn/fail checks).
  // When omitted, correction injection is skipped.
  mainSessionId?: string
  // Optional hook called with the auditor message text before it is sent. Used in tests.
  onCorrectionPrompt?: (text: string) => void
  // Optional hook called if the correction sendPrompt fails, so the caller can clear the pre-emptive
  // auto-review suppression it set before the correction turn (the failed turn emits no stop).
  onCorrectionFailed?: () => void
  // Optional hook called when runReview is invoked externally; used in tests to assert no
  // recursive re-review is triggered by the correction path.
  onRunReviewCalled?: () => void
  // Wall-clock budget for the reviewer session drive loop before it is aborted as an error.
  reviewerTimeoutMs?: number
  // Hard cap on reviewer session updates before the drive loop aborts (guards a fast-looping agent).
  reviewerMaxUpdates?: number
  // Maximum number of fix-loop iterations (whole-loop counter cap). Defaults to 3.
  fixLoopMaxRounds?: number
  // Called just before the fix loop starts (after initial review finds warn/fail). Used to lock
  // the session composer in the renderer.
  onFixLoopStart?: () => void
  // Called when the fix loop ends (all pass, cap reached, or aborted). Used to unlock the session
  // composer in the renderer.
  onFixLoopEnd?: () => void
  // AbortSignal to stop the fix loop early (e.g. when the user presses cancel). When aborted,
  // the loop exits at the next round boundary without further [Auditor] injections.
  fixLoopAbortSignal?: AbortSignal
  // How long the fix loop waits for the correction turn to reach durable session storage. The main
  // agent can finish before the renderer's persistence queue flushes, so a single immediate read races.
  sessionRefreshTimeoutMs?: number
}

// Default drive-loop guards. The wall-clock timeout is the primary backstop against a reviewer that
// never stops (it is the only guard that catches a reviewer stuck streaming thoughts forever, since
// those do not count toward the update cap — see below). The update cap is a secondary backstop
// against a fast-looping reviewer that spins through discrete actions. Reviews do real multi-step
// evidence tracing, so the timeout is generous.
const DEFAULT_REVIEWER_TIMEOUT_MS = 900_000
const DEFAULT_REVIEWER_MAX_UPDATES = 1000
const DEFAULT_SESSION_REFRESH_TIMEOUT_MS = 10_000
const SESSION_REFRESH_POLL_MS = 50

// Options for the Phase 3 fix loop.
type FixLoopOptions = {
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
  acpRuntime: ReviewerAcpRuntime
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
}

const waitForCorrectionAgentMessage = async (options: {
  sessionId: string
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
        message.status === 'complete'
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
const runFixLoop = async (options: FixLoopOptions): Promise<void> => {
  const {
    sessionId,
    originalTurnMessageId,
    projectId,
    mainSessionId,
    getSession,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
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
    abortSignal
  } = options

  let openChecks = [...options.openChecks]
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
        error: error instanceof Error ? error.message : String(error)
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
    try {
      const provenanceContext = getActiveConversationContext(
        materializeSessionConversationGraph(sessionBefore).conversationGraph!,
        `prompt-${randomUUID()}`
      )
      await injectAuditorMessage({
        sessionId,
        mainSessionId,
        findings: openChecks,
        acpRuntime,
        provenanceContext,
        onCorrectionPrompt,
        onCorrectionFailed: () => {
          correctionFailed = true
          onCorrectionFailed?.()
        }
      })
    } catch (error) {
      correctionFailed = true
      log.warn('fix loop: failed to derive correction provenance', {
        sessionId,
        round,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    // Error handling: a failed correction counts as a round (prevents infinite loop) but we
    // cannot re-review (there's no correction turn). Mark remaining as unaddressed and stop.
    if (correctionFailed) {
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
        messageIdsBefore,
        getSession,
        timeoutMs: sessionRefreshTimeoutMs,
        abortSignal
      })
    } catch (error) {
      log.warn('fix loop: failed while refreshing durable correction turn', {
        sessionId,
        round,
        error: error instanceof Error ? error.message : String(error)
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

    const scopedResult = await runScopedReview({
      sessionId,
      turnMessageId: correctionTurnMessageId,
      originalTurnMessageId,
      projectId,
      getSession,
      reviewRepository,
      runSessionMutation,
      acpRuntime,
      artifactStorageRoot,
      artifactVersionContentResolver,
      reviewerMcpEntryPath,
      model,
      onReviewUpdate,
      reviewerTimeoutMs,
      reviewerMaxUpdates,
      trackedChecks: openChecks,
      sessionSnapshot: correctionState.session
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

// Runs one scoped re-review for a correction turn. Creates a new Review row under the same
// original turnMessageId so all iterations are grouped. Returns the completed review.
// Never throws — errors are captured as lifecycle='error'.
const runScopedReview = async (options: {
  sessionId: string
  turnMessageId: string
  originalTurnMessageId: string
  projectId: string
  getSession: SessionProvider
  reviewRepository: ReviewRepository
  runSessionMutation?: ReviewMutationRunner
  acpRuntime: ReviewerAcpRuntime
  artifactStorageRoot: string
  artifactVersionContentResolver?: ArtifactVersionContentResolver
  reviewerMcpEntryPath?: string
  model: string
  onReviewUpdate?: (review: ReviewWithChecks) => void
  reviewerTimeoutMs: number
  reviewerMaxUpdates: number
  trackedChecks: ReviewCheck[]
  sessionSnapshot?: PersistedChatSession
}): Promise<ReviewAssessmentResult> => {
  const {
    sessionId,
    turnMessageId,
    originalTurnMessageId,
    projectId,
    getSession,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    artifactStorageRoot,
    artifactVersionContentResolver,
    reviewerMcpEntryPath,
    model,
    onReviewUpdate,
    reviewerTimeoutMs,
    reviewerMaxUpdates,
    trackedChecks,
    sessionSnapshot
  } = options

  // Keep missing-session handling in the facade: the assessment owner always receives a durable
  // snapshot and therefore never invents lifecycle rows for absent sessions.
  const session = sessionSnapshot ?? (await getSession(sessionId))
  if (!session) {
    log.warn('session not found for scoped re-review', { sessionId })
    const errorReview = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.createReview({
        projectId,
        sessionId,
        turnMessageId: originalTurnMessageId,
        scope: { turnMessageId: originalTurnMessageId, blocks: [], artifactVersionIds: [] },
        lifecycle: 'error',
        errorMessage: `Session ${sessionId} not found during re-review`,
        model
      })
    )
    return { review: { ...errorReview, checks: [] }, submittedChecks: [] }
  }

  return runReviewAssessment({
    mode: 'tracked',
    session,
    sessionId,
    scopeTurnMessageId: turnMessageId,
    turnMessageId: originalTurnMessageId,
    projectId,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    artifactStorageRoot,
    artifactVersionContentResolver,
    reviewerMcpEntryPath,
    model,
    onReviewUpdate,
    reviewerTimeoutMs,
    reviewerMaxUpdates,
    trackedChecks
  })
}

// Drives one complete auto-review cycle and returns the final review (with checks) for the caller
// to broadcast. Never throws — errors are captured as lifecycle='error'.
const runReviewWithSession = async (
  options: RunReviewOptions,
  session: PersistedChatSession
): Promise<ReviewWithChecks> => {
  const {
    sessionId,
    turnMessageId,
    scopeTurnMessageId,
    projectId,
    getSession,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    artifactStorageRoot,
    artifactVersionContentResolver,
    reviewerMcpEntryPath,
    model = '',
    onReviewUpdate,
    onStarted,
    mainSessionId,
    onCorrectionPrompt,
    onCorrectionFailed,
    reviewerTimeoutMs = DEFAULT_REVIEWER_TIMEOUT_MS,
    reviewerMaxUpdates = DEFAULT_REVIEWER_MAX_UPDATES,
    fixLoopMaxRounds = 3,
    onFixLoopStart,
    onFixLoopEnd,
    fixLoopAbortSignal,
    sessionRefreshTimeoutMs = DEFAULT_SESSION_REFRESH_TIMEOUT_MS
  } = options

  const assessment = await runReviewAssessment({
    mode: 'initial',
    session,
    sessionId,
    scopeTurnMessageId: scopeTurnMessageId ?? turnMessageId,
    turnMessageId,
    projectId,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    artifactStorageRoot,
    artifactVersionContentResolver,
    reviewerMcpEntryPath,
    model,
    onReviewUpdate,
    onStarted,
    reviewerTimeoutMs,
    reviewerMaxUpdates
  })
  const finalReview = assessment.review
  if (finalReview.lifecycle === 'error') return finalReview

  // Step 5: Phase 3 fix loop. If there are warn/fail checks and a main session is provided,
  // drive the bounded re-review loop: inject → correction → re-review → resolution → repeat.
  const hasWarnOrFail = finalReview.checks.some((c) => c.status === 'warn' || c.status === 'fail')

  if (mainSessionId && hasWarnOrFail) {
    onFixLoopStart?.()
    try {
      await runFixLoop({
        sessionId,
        originalTurnMessageId: turnMessageId,
        openChecks: finalReview.checks.filter((c) => c.status === 'warn' || c.status === 'fail'),
        projectId,
        mainSessionId,
        getSession,
        reviewRepository,
        runSessionMutation,
        acpRuntime,
        artifactStorageRoot,
        artifactVersionContentResolver,
        reviewerMcpEntryPath,
        model,
        onReviewUpdate,
        onCorrectionPrompt,
        onCorrectionFailed,
        reviewerTimeoutMs,
        reviewerMaxUpdates,
        maxRounds: fixLoopMaxRounds,
        sessionRefreshTimeoutMs,
        abortSignal: fixLoopAbortSignal
      })
    } finally {
      onFixLoopEnd?.()
    }

    // Reload checks after the fix loop so the returned object reflects final resolutions.
    const reloadedReviews = await reviewRepository.getReviewsForProjectSession(projectId, sessionId)
    const reloadedReview = reloadedReviews.find((r) => r.id === finalReview.id)
    if (reloadedReview) {
      onReviewUpdate?.(reloadedReview)
      return reloadedReview
    }
  }

  onReviewUpdate?.(finalReview)
  return finalReview
}

export const runReview = async (options: RunReviewOptions): Promise<ReviewWithChecks> => {
  const {
    sessionId,
    turnMessageId,
    projectId,
    getSession,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    onReviewUpdate,
    mainSessionId,
    model = ''
  } = options

  log.info('runReview started', { sessionId, turnMessageId })

  const session = await getSession(sessionId)
  if (!session) {
    log.warn('session not found for review', { sessionId })
    const errorReview = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.createReview({
        projectId,
        sessionId,
        turnMessageId,
        scope: { turnMessageId, blocks: [], artifactVersionIds: [] },
        lifecycle: 'error',
        errorMessage: `Session ${sessionId} not found`,
        model
      })
    )
    const withFindings: ReviewWithChecks = { ...errorReview, checks: [] }
    onReviewUpdate?.(withFindings)
    return withFindings
  }

  return withReviewerRuntimeActivity(
    acpRuntime,
    {
      ...(mainSessionId
        ? {
            session: {
              sessionId: mainSessionId,
              cwd: session.cwd,
              projectName: session.projectId,
              permissionProfile: session.permissionProfile,
              previousFrameworkId: session.agentFrameworkId,
              previousBackendId: session.agentBackendId,
              providerSessionId: session.providerSessionId,
              providerContinuityToken: session.providerContinuityToken,
              historyPreamble: buildHistoryPreamble(session.messages)
            }
          }
        : {})
    },
    (scopedRuntime) => runReviewWithSession({ ...options, acpRuntime: scopedRuntime }, session)
  )
}
