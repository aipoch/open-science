// Orchestrator for the auto-review pipeline. `runReview` is called after each turn completes;
// it spawns a fresh-context reviewer ACP session, injects the rubric + scope-bounded reviewer MCP,
// drives the reviewer to completion, persists findings, and then disposes the session.
//
// Phase 3: after a review with warn/fail, `runFixLoop` drives the bounded re-review loop:
// inject → correction turn → re-review new blocks → resolve/reflag → repeat (max 3 rounds).
//
// Errors are isolated: reviewer failures set lifecycle='error' and do NOT crash the main session.

import { withReviewerRuntimeActivity, type ReviewerAcpRuntime } from './acp-runtime'
import { createLogger } from '../logger'
import type { DelegatedReviewEvidenceScope, ReviewWithChecks } from '../../shared/reviewer'
import type { ReviewRepository } from './repository'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { ArtifactVersionEvidenceResolvers } from './host-sdk'
import type { ReviewerFileEvidenceResolver } from './turn-evidence'
import { buildHistoryPreamble } from '../../shared/history-preamble'
import { runReviewAssessment } from './review-assessment-owner'
import { runReviewerFixLoop } from './reviewer-fix-loop-owner'
import type { AcpSessionAgentTarget } from '../../shared/acp'
import type { SessionAuxiliaryTurnUsageRecord } from '../session-persistence/auxiliary-turn-usage'

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
  // Exact child provenance for a delegated turn. Delegated review is evidence-only and may not
  // enter the correction loop.
  evidenceScope?: DelegatedReviewEvidenceScope
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
  // The ACP runtime that owns the main Agent connection and correction turns.
  acpRuntime: ReviewerAcpRuntime
  // Concrete target for lazily resuming the main Session during Reviewer corrections.
  agentTarget?: AcpSessionAgentTarget
  // Optional fixed-model runtime used only for Reviewer sessions. When absent, Reviewer sessions
  // use the scoped main runtime selected at Review-chain start.
  reviewerAcpRuntime?: ReviewerAcpRuntime
  // Storage root for artifact reads (used by the scope-bounded evidence reader).
  artifactStorageRoot: string
  // Native Version resolver for current provenance rows. Tests and legacy callers may omit it and
  // retain the old session-path lookup.
  artifactVersionResolvers?: ArtifactVersionEvidenceResolvers
  reviewerFileEvidenceResolver?: ReviewerFileEvidenceResolver
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
  // AbortSignal for the admitted Review chain. It stops an active initial Reviewer session and also
  // makes the fix loop exit at the next round boundary without further [Auditor] injections.
  fixLoopAbortSignal?: AbortSignal
  // How long the fix loop waits for the correction turn to reach durable session storage. The main
  // agent can finish before the renderer's persistence queue flushes, so a single immediate read races.
  sessionRefreshTimeoutMs?: number
  recordUsage?: (record: SessionAuxiliaryTurnUsageRecord) => Promise<unknown>
}

// Default drive-loop guards. The wall-clock timeout is the primary backstop against a reviewer that
// never stops (it is the only guard that catches a reviewer stuck streaming thoughts forever, since
// those do not count toward the update cap — see below). The update cap is a secondary backstop
// against a fast-looping reviewer that spins through discrete actions. Reviews do real multi-step
// evidence tracing, so the timeout is generous.
const DEFAULT_REVIEWER_TIMEOUT_MS = 900_000
const DEFAULT_REVIEWER_MAX_UPDATES = 1000
const DEFAULT_SESSION_REFRESH_TIMEOUT_MS = 10_000

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
    evidenceScope,
    projectId,
    getSession,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    reviewerAcpRuntime = acpRuntime,
    artifactStorageRoot,
    artifactVersionResolvers,
    reviewerFileEvidenceResolver,
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
    sessionRefreshTimeoutMs = DEFAULT_SESSION_REFRESH_TIMEOUT_MS,
    recordUsage
  } = options

  const assessment = await runReviewAssessment({
    mode: 'initial',
    session,
    sessionId,
    scopeTurnMessageId: scopeTurnMessageId ?? turnMessageId,
    turnMessageId,
    evidenceScope,
    projectId,
    reviewRepository,
    runSessionMutation,
    acpRuntime: reviewerAcpRuntime,
    artifactStorageRoot,
    artifactVersionResolvers,
    reviewerFileEvidenceResolver,
    reviewerMcpEntryPath,
    model,
    onReviewUpdate,
    onStarted,
    reviewerTimeoutMs,
    reviewerMaxUpdates,
    abortSignal: fixLoopAbortSignal,
    recordUsage
  })
  const finalReview = assessment.review
  if (finalReview.lifecycle === 'error') return finalReview

  // Step 5: Phase 3 fix loop. If there are warn/fail checks and a main session is provided,
  // drive the bounded re-review loop: inject → correction → re-review → resolution → repeat.
  const hasWarnOrFail = finalReview.checks.some((c) => c.status === 'warn' || c.status === 'fail')

  if (mainSessionId && hasWarnOrFail) {
    onFixLoopStart?.()
    try {
      await runReviewerFixLoop({
        sessionId,
        originalTurnMessageId: turnMessageId,
        openChecks: finalReview.checks.filter((c) => c.status === 'warn' || c.status === 'fail'),
        projectId,
        mainSessionId,
        getSession,
        reviewRepository,
        runSessionMutation,
        acpRuntime,
        reviewerAcpRuntime,
        artifactStorageRoot,
        artifactVersionResolvers,
        reviewerFileEvidenceResolver,
        reviewerMcpEntryPath,
        model,
        onReviewUpdate,
        onCorrectionPrompt,
        onCorrectionFailed,
        reviewerTimeoutMs,
        reviewerMaxUpdates,
        maxRounds: fixLoopMaxRounds,
        sessionRefreshTimeoutMs,
        abortSignal: fixLoopAbortSignal,
        recordUsage
      })
    } finally {
      onFixLoopEnd?.()
    }

    // Reload checks after the fix loop so the returned object reflects final resolutions.
    const reloadedReviews = await reviewRepository.getReviewsForProjectSession(projectId, sessionId)
    const reloadedReview = reloadedReviews.find((review) => review.id === finalReview.id)
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

  if (
    options.evidenceScope &&
    (turnMessageId !== options.evidenceScope.terminalMessageId ||
      (options.scopeTurnMessageId !== undefined &&
        options.scopeTurnMessageId !== options.evidenceScope.terminalMessageId) ||
      mainSessionId !== undefined)
  ) {
    throw new Error('Delegated Review authority is limited to its exact terminal evidence scope.')
  }

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
    const withFindings: ReviewWithChecks = {
      ...errorReview,
      checks: [],
      submittedChecks: []
    }
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
              projectId: session.projectId,
              permissionProfile: session.permissionProfile,
              memoryEnabled: session.memoryEnabled !== false,
              previousFrameworkId: session.agentFrameworkId,
              previousBackendId: session.agentBackendId,
              specialistId: session.specialistId,
              specialistBindingPending: session.specialistBindingPending,
              providerSessionId: session.providerSessionId,
              providerContinuityToken: session.providerContinuityToken,
              ...(options.agentTarget ? { agentTarget: options.agentTarget } : {}),
              historyPreamble: buildHistoryPreamble(session.messages)
            }
          }
        : {})
    },
    (scopedRuntime) => runReviewWithSession({ ...options, acpRuntime: scopedRuntime }, session)
  )
}
