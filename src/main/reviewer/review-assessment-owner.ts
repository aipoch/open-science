// Owns one complete Reviewer assessment from scope resolution through durable submission.

import { homedir } from 'node:os'

import type { ActiveSession } from '@agentclientprotocol/sdk'

import type {
  DelegatedReviewEvidenceScope,
  NewCheck,
  ReviewCheck,
  ReviewerLogEntry,
  ReviewWithChecks,
  TurnScope
} from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createLogger, errorLogFields } from '../logger'
import type { SessionAuxiliaryTurnUsageRecord } from '../session-persistence/auxiliary-turn-usage'
import type { AcpProviderTurnProbe } from '../acp/provider-turn-adapter'
import type { ReviewerAcpRuntime } from './acp-runtime'
import { resolveTurnScopeWithArtifactDigests } from './artifact-digest'
import { ReviewerHostServer, type ArtifactVersionEvidenceResolvers } from './host-sdk'
import { ReviewerMcpServer, serializeReviewerEvidenceCoverage } from './mcp-server'
import type { ReviewRepository } from './repository'
import {
  appendFinalReviewerLogEntry,
  driveReviewerToStop,
  initializeReviewerLogBudget,
  type ReviewerLogDriveCallbacks
} from './reviewer-session-driver'
import {
  INITIAL_REVIEW_CHECKABILITY_GUIDANCE,
  REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND
} from './rubric'
import { buildReviewScopeSnapshot } from './scope-snapshot'
import { assertDelegatedReviewEvidenceScope } from './scope'
import { resolveReviewerTurnEvidence, type ReviewerFileEvidenceResolver } from './turn-evidence'

const log = createLogger('reviewer:orchestrator')

type ReviewMutationRunner = <Result>(mutation: () => Promise<Result>) => Promise<Result>

type CommonAssessmentOptions = {
  session: PersistedChatSession
  sessionId: string
  scopeTurnMessageId: string
  evidenceScope?: DelegatedReviewEvidenceScope
  turnMessageId: string
  projectId: string
  reviewRepository: ReviewRepository
  runSessionMutation?: ReviewMutationRunner
  acpRuntime: ReviewerAcpRuntime
  artifactStorageRoot: string
  artifactVersionResolvers?: ArtifactVersionEvidenceResolvers
  reviewerFileEvidenceResolver?: ReviewerFileEvidenceResolver
  reviewerMcpEntryPath?: string
  model: string
  onReviewUpdate?: (review: ReviewWithChecks) => void
  reviewerTimeoutMs: number
  reviewerMaxUpdates: number
  abortSignal?: AbortSignal
  recordUsage?: (record: SessionAuxiliaryTurnUsageRecord) => Promise<unknown>
}

type InitialAssessmentOptions = CommonAssessmentOptions & {
  mode: 'initial'
  onStarted?: () => void
}

type TrackedAssessmentOptions = CommonAssessmentOptions & {
  mode: 'tracked'
  trackedChecks: readonly ReviewCheck[]
}

type ReviewAssessmentOptions = InitialAssessmentOptions | TrackedAssessmentOptions

export type ReviewAssessmentResult = {
  review: ReviewWithChecks
  submittedChecks: NewCheck[]
}

const runReviewMutation = <Result>(
  runner: ReviewMutationRunner | undefined,
  mutation: () => Promise<Result>
): Promise<Result> => (runner ? runner(mutation) : mutation())

const incompleteReviewMessage = (rejectedToolCalls: number): string =>
  rejectedToolCalls > 0
    ? 'Reviewer stopped without calling submit_findings; ' +
      `${rejectedToolCalls} tool call(s) were also rejected by the permission gate.`
    : 'Reviewer stopped without calling submit_findings.'

const REVIEWER_BRIDGE_SCOPE_ERROR =
  'Reviewer request was not constrained to the reviewer-only tool scope.'

const REVIEWER_PROTOCOL_RECOVERY_PROMPT =
  'Your previous turn ended without calling submit_findings. Continue using only the provided ' +
  'Reviewer MCP tools: call read_turn, then complete the Review with one accepted submit_findings ' +
  'submission. Correct validation errors within this Review Turn. Do not use any other tools or ' +
  'write assistant prose.'

const REVIEWER_COVERAGE_LOG_RESERVE_BYTES = 8 * 1_024

const buildBoundedCoverageLogEntry = (
  coverage: ReturnType<typeof serializeReviewerEvidenceCoverage>,
  maxEntryBytes: number
): ReviewerLogEntry => {
  const entryFor = (value: typeof coverage): ReviewerLogEntry => ({
    kind: 'tool',
    toolName: 'review_coverage',
    rawOutput: JSON.stringify(value),
    status: 'ok'
  })
  const fits = (entry: ReviewerLogEntry): boolean =>
    Buffer.byteLength(JSON.stringify(entry), 'utf8') <= maxEntryBytes
  const full = entryFor(coverage)
  if (fits(full)) return full

  const bounded: typeof coverage = {
    ...coverage,
    executionLogActivityIds: [...coverage.executionLogActivityIds],
    artifactReads: coverage.artifactReads.map((read) => ({
      ...read,
      requestedTargets: [...read.requestedTargets],
      actualTargets: [...read.actualTargets],
      limitations: [...read.limitations]
    })),
    truncation: {
      kind: 'coverage-truncated',
      omittedArtifactReads: 0,
      omittedExecutionLogActivityIds: 0,
      omittedRequestedTargets: 0,
      omittedActualTargets: 0,
      omittedLimitations: 0
    }
  }
  const truncation = bounded.truncation!
  let entry = entryFor(bounded)
  while (!fits(entry)) {
    const read = bounded.artifactReads.findLast((candidate) => candidate.limitations.length > 0)
    if (read) {
      read.limitations = read.limitations.slice(0, -1)
      truncation.omittedLimitations++
    } else {
      const actualRead = bounded.artifactReads.findLast(
        (candidate) => candidate.actualTargets.length > 0
      )
      if (actualRead) {
        actualRead.actualTargets = actualRead.actualTargets.slice(0, -1)
        truncation.omittedActualTargets++
      } else {
        const requestedRead = bounded.artifactReads.findLast(
          (candidate) => candidate.requestedTargets.length > 0
        )
        if (requestedRead) {
          requestedRead.requestedTargets = requestedRead.requestedTargets.slice(0, -1)
          truncation.omittedRequestedTargets++
        } else if (bounded.artifactReads.length > 0) {
          bounded.artifactReads.pop()
          truncation.omittedArtifactReads++
        } else if (bounded.executionLogActivityIds.length > 0) {
          bounded.executionLogActivityIds.pop()
          truncation.omittedExecutionLogActivityIds++
        } else {
          break
        }
      }
    }
    entry = entryFor(bounded)
  }
  return entry
}

type ReviewerCleanupResult = {
  rejectedToolCalls: number
  reviewerBridgeScoped: boolean | undefined
  runtimeCleanupFailed: boolean
  runtimeCleanupError?: unknown
}

// Disposal and MCP shutdown are independent: a broken ACP adapter must not strand the MCP server.
const cleanupReviewerResources = async (
  acpRuntime: ReviewerAcpRuntime,
  reviewerSession: ActiveSession | undefined,
  mcpServer: ReviewerMcpServer | undefined
): Promise<ReviewerCleanupResult> => {
  let rejectedToolCalls = 0
  let reviewerBridgeScoped: boolean | undefined
  let runtimeCleanupFailed = false
  let runtimeCleanupError: unknown

  if (reviewerSession) {
    try {
      const disposition = acpRuntime.disposeReviewerSession(reviewerSession)
      rejectedToolCalls = disposition.rejectedToolCalls
      reviewerBridgeScoped = disposition.reviewerBridgeScoped
    } catch (error) {
      runtimeCleanupFailed = true
      runtimeCleanupError = error
    }
  }

  try {
    await mcpServer?.stop()
  } catch (error) {
    log.error('reviewer MCP server cleanup failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }

  return {
    rejectedToolCalls,
    reviewerBridgeScoped,
    runtimeCleanupFailed,
    ...(runtimeCleanupError === undefined ? {} : { runtimeCleanupError })
  }
}

// Runs either an initial assessment or a tracked fix-loop assessment. The discriminant changes only
// the durable grouping/allowlist and publication contract; all remote lifecycle behavior is shared.
export const runReviewAssessment = async (
  options: ReviewAssessmentOptions
): Promise<ReviewAssessmentResult> => {
  const {
    session,
    sessionId,
    scopeTurnMessageId,
    evidenceScope,
    turnMessageId,
    projectId,
    reviewRepository,
    runSessionMutation,
    acpRuntime,
    artifactStorageRoot,
    artifactVersionResolvers,
    reviewerFileEvidenceResolver,
    reviewerMcpEntryPath,
    model,
    onReviewUpdate,
    reviewerTimeoutMs,
    reviewerMaxUpdates,
    abortSignal,
    recordUsage
  } = options
  const trackedChecks = options.mode === 'tracked' ? options.trackedChecks : []

  const scope = await resolveTurnScopeWithArtifactDigests(
    session,
    scopeTurnMessageId,
    artifactStorageRoot,
    artifactVersionResolvers?.content,
    evidenceScope?.messageBranchId
  )
  if (evidenceScope) assertDelegatedReviewEvidenceScope(session, scope, evidenceScope)
  const turnEvidence = await resolveReviewerTurnEvidence(
    session,
    scope,
    reviewerFileEvidenceResolver
  )
  const enrichedScope: TurnScope = {
    ...scope,
    ...(turnEvidence.sourceDocumentVersionIds.length > 0
      ? { sourceDocumentVersionIds: turnEvidence.sourceDocumentVersionIds }
      : {})
  }
  const scopeSnapshot = buildReviewScopeSnapshot(session, enrichedScope, turnEvidence)
  let review = await runReviewMutation(runSessionMutation, () =>
    reviewRepository.createReview({
      projectId,
      sessionId,
      turnMessageId,
      scope: enrichedScope,
      lifecycle: 'running',
      model,
      scopeSnapshot
    })
  )

  const runningReview: ReviewWithChecks = { ...review, checks: [], submittedChecks: [] }
  onReviewUpdate?.(runningReview)
  if (options.mode === 'initial') options.onStarted?.()

  log.info(options.mode === 'tracked' ? 'scoped re-review created' : 'review created', {
    reviewId: review.id,
    blocks: scope.blocks.length
  })

  let reviewerSession: ActiveSession | undefined
  let mcpServer: ReviewerMcpServer | undefined
  let checksReceived: NewCheck[] = []
  let checksSubmitted = false
  let rejectedToolCalls = 0
  let reviewerBridgeScoped: boolean | undefined
  let reviewerSessionFailed = false
  let reviewerSessionError: unknown
  const capturedLog: ReviewerLogEntry[] = []
  const reviewerLogDriveCallbacks: ReviewerLogDriveCallbacks = {
    onUpdate: (entry: ReviewerLogEntry): void => {
      capturedLog.push(entry)
    },
    logState: {}
  }
  initializeReviewerLogBudget(reviewerLogDriveCallbacks, {
    finalLogEntryReserveBytes: REVIEWER_COVERAGE_LOG_RESERVE_BYTES
  })

  try {
    const evidence = new ReviewerHostServer(
      session,
      enrichedScope,
      artifactStorageRoot,
      artifactVersionResolvers?.content,
      scopeSnapshot,
      {},
      artifactVersionResolvers?.trace,
      artifactVersionResolvers?.pagedContent,
      turnEvidence.sourceDocumentEvidence
    )
    mcpServer = new ReviewerMcpServer(
      enrichedScope,
      async (checks: NewCheck[]) => {
        checksReceived = checks
        checksSubmitted = true
        if (options.mode === 'initial') {
          log.info('submit_findings received by MCP handler', { count: checks.length })
        }
      },
      evidence,
      options.mode,
      trackedChecks.map((check) => check.id),
      {
        command: process.execPath,
        entryPath: reviewerMcpEntryPath,
        // The Reviewer backend is captured after its session is built but before it can invoke a
        // tool, so capability is resolved lazily at the content-read boundary.
        supportsImageInput: () => acpRuntime.captureBackend?.()?.context.supportsImageInput === true
      }
    )
    await mcpServer.start()

    const reviewerPrompt = buildReviewerPrompt(enrichedScope, options.mode, trackedChecks)
    const reviewerCwd = session.cwd || homedir()
    const built = await acpRuntime.buildReviewerSession({
      cwd: reviewerCwd,
      mcpServers: [mcpServer.toAcpMcpServerConfig()],
      systemPromptAppend: REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND
    })
    reviewerSession = built.session
    const backend = acpRuntime.captureBackend?.()
    // Codex bridge Sessions intentionally advertise a catalog-only model (currently gpt-5.4) so
    // Codex enables classic function tools. The bridge rewrites requests to the configured upstream
    // model, which is retained as the context model. Persisting the catalog alias here makes Review
    // attribution claim GPT ran the audit even when the actual Reviewer was GLM or another provider.
    const runtimeModel =
      backend?.modelRoute === 'codex-bridge'
        ? (backend.context.model ?? model)
        : (backend?.session.model ?? backend?.context.model)
    if (runtimeModel && runtimeModel !== review.model) {
      review = await runReviewMutation(runSessionMutation, () =>
        reviewRepository.updateReview(review.id, { model: runtimeModel })
      )
      onReviewUpdate?.({ ...review, checks: [] })
    }
    if (options.mode === 'initial') {
      log.info('reviewer session started', { sessionId: reviewerSession.sessionId })
    }

    const reviewerPromptText = built.promptPrefix
      ? `${built.promptPrefix}\n\n${reviewerPrompt}`
      : reviewerPrompt
    const runReviewerTurn = async (
      prompt: string,
      eventId: string
    ): Promise<string | undefined> => {
      let probe: AcpProviderTurnProbe | undefined
      let response: Parameters<AcpProviderTurnProbe['finalize']>[0]['response'] | undefined
      try {
        probe = await acpRuntime.beginProviderTurnObservation?.({
          providerSessionId: reviewerSession!.sessionId,
          cwd: built.cwd
        })
        const promptRequest = reviewerSession!.prompt([{ type: 'text', text: prompt }])
        void Promise.resolve(promptRequest).catch(() => undefined)
        const stopReason = await driveReviewerToStop(
          reviewerSession!,
          { timeoutMs: reviewerTimeoutMs, maxUpdates: reviewerMaxUpdates, signal: abortSignal },
          {
            ...reviewerLogDriveCallbacks,
            onNotification: (notification) => probe?.observe?.(notification),
            onStop: (value) => {
              response = value
            }
          }
        )
        if (probe && response) {
          const facts = await probe.finalize({ response })
          probe = undefined
          if (facts.turnUsage && recordUsage && backend) {
            await recordUsage({
              projectId,
              sessionId,
              eventId,
              source: 'reviewer',
              frameworkId: backend.framework.id,
              ...(backend.providerId ? { providerId: backend.providerId } : {}),
              model: runtimeModel ?? (review.model || undefined),
              completedAtMs: Date.now(),
              usage: {
                ...facts.turnUsage,
                ...(facts.modelTurnCount === undefined ? {} : { turnCount: facts.modelTurnCount })
              }
            }).catch((error) =>
              log.warn('Reviewer Usage persistence failed', errorLogFields(error))
            )
          }
        }
        return stopReason
      } finally {
        await Promise.resolve(probe?.cancel()).catch(() => undefined)
      }
    }
    const stopReason = await runReviewerTurn(reviewerPromptText, `${review.id}:initial`)
    if (options.mode === 'initial') {
      log.info('reviewer session stopped', { reviewId: review.id, stopReason })
    }
    if (stopReason === 'end_turn' && !checksSubmitted && !mcpServer.submissionAttempted) {
      log.warn('reviewer protocol incomplete; requesting one recovery turn', {
        reviewId: review.id,
        stopReason
      })
      const recoveryStopReason = await runReviewerTurn(
        REVIEWER_PROTOCOL_RECOVERY_PROMPT,
        `${review.id}:recovery`
      )
      log.info('reviewer recovery session stopped', {
        reviewId: review.id,
        stopReason: recoveryStopReason
      })
    }
  } catch (error) {
    reviewerSessionFailed = true
    reviewerSessionError = error
  } finally {
    if (mcpServer) {
      const coverage = serializeReviewerEvidenceCoverage(mcpServer.evidenceCoverage)
      appendFinalReviewerLogEntry(reviewerLogDriveCallbacks, (maxEntryBytes) =>
        buildBoundedCoverageLogEntry(coverage, maxEntryBytes)
      )
    }
    const cleanup = await cleanupReviewerResources(acpRuntime, reviewerSession, mcpServer)
    rejectedToolCalls = cleanup.rejectedToolCalls
    reviewerBridgeScoped = cleanup.reviewerBridgeScoped
    if (cleanup.runtimeCleanupFailed) {
      if (reviewerSessionFailed) {
        log.error(
          options.mode === 'tracked'
            ? 'scoped re-review session cleanup also failed'
            : 'reviewer session cleanup also failed',
          {
            reviewId: review.id,
            error:
              cleanup.runtimeCleanupError instanceof Error
                ? cleanup.runtimeCleanupError.message
                : String(cleanup.runtimeCleanupError)
          }
        )
      } else {
        reviewerSessionFailed = true
        reviewerSessionError = cleanup.runtimeCleanupError
      }
    }
  }

  const fail = async (
    errorMessage: string,
    includeReviewerLog = true
  ): Promise<ReviewAssessmentResult> => {
    review = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.updateReview(review.id, {
        lifecycle: 'error',
        errorMessage,
        ...(includeReviewerLog ? { reviewerLog: capturedLog } : {})
      })
    )
    const errorReview: ReviewWithChecks = { ...review, checks: [], submittedChecks: [] }
    onReviewUpdate?.(errorReview)
    return { review: errorReview, submittedChecks: [] }
  }

  if (reviewerSessionFailed) {
    const errorMessage =
      reviewerSessionError instanceof Error
        ? reviewerSessionError.message
        : String(reviewerSessionError)
    log.error(
      options.mode === 'tracked' ? 'scoped re-review session failed' : 'reviewer session failed',
      { reviewId: review.id, ...errorLogFields(reviewerSessionError) }
    )
    return fail(errorMessage)
  }

  if (reviewerBridgeScoped === false) {
    log.error(
      options.mode === 'tracked'
        ? 'scoped re-review bridge isolation failed'
        : 'reviewer bridge isolation failed',
      { reviewId: review.id }
    )
    return fail(REVIEWER_BRIDGE_SCOPE_ERROR)
  }

  if (!checksSubmitted) {
    const errorMessage = incompleteReviewMessage(rejectedToolCalls)
    log.error(
      options.mode === 'tracked'
        ? 'scoped re-review protocol incomplete'
        : 'review protocol incomplete',
      { reviewId: review.id, error: errorMessage }
    )
    return fail(errorMessage)
  }

  let finalReview: ReviewWithChecks
  try {
    finalReview = await runReviewMutation(runSessionMutation, () =>
      reviewRepository.commitScopedSubmission({
        mode: options.mode,
        reviewId: review.id,
        checks: checksReceived,
        expectedSourceFindingIds: trackedChecks.map((check) => check.id),
        reviewerLog: capturedLog
      })
    )
    review = finalReview
    log.info(options.mode === 'tracked' ? 'scoped re-review complete' : 'review complete', {
      reviewId: review.id,
      outcome: finalReview.outcome,
      checkCount: checksReceived.length,
      model: finalReview.model,
      assessmentKind:
        options.mode === 'initial' && checksReceived.length === 0
          ? 'no_checkable_claims'
          : 'assessed'
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log.error(
      options.mode === 'tracked'
        ? 'scoped re-review persistence failed'
        : 'review persistence failed',
      { reviewId: review.id, error: errorMessage }
    )
    return fail(errorMessage, options.mode === 'tracked')
  }

  if (options.mode === 'tracked') {
    const trackedById = new Map(trackedChecks.map((check) => [check.id, check]))
    const mutatedSourceReviewIds = new Set(
      checksReceived.flatMap((check) => {
        const source = check.sourceFindingId ? trackedById.get(check.sourceFindingId) : undefined
        return source ? [source.reviewId] : []
      })
    )
    if (mutatedSourceReviewIds.size > 0) {
      const allReviews = await reviewRepository.getReviewsForProjectSession(projectId, sessionId)
      for (const sourceReview of allReviews) {
        if (mutatedSourceReviewIds.has(sourceReview.id)) onReviewUpdate?.(sourceReview)
      }
    }
    onReviewUpdate?.(finalReview)
  }

  return { review: finalReview, submittedChecks: checksReceived }
}

export const buildReviewerPrompt = (
  scope: TurnScope,
  mode: ReviewAssessmentOptions['mode'],
  trackedChecks: readonly ReviewCheck[] = []
): string => {
  const blockSummary =
    scope.blocks.length === 0
      ? 'This turn has no blocks (it may be empty).'
      : `This turn has ${scope.blocks.length} block(s): ` +
        scope.blocks
          .map((block) => `[${block.blockIndex}] ${block.kind}:${block.sourceId}`)
          .slice(0, 10)
          .join(', ') +
        (scope.blocks.length > 10 ? ', ...' : '')

  const artifactSummary =
    scope.artifactVersionIds.length === 0
      ? 'No artifacts in this turn.'
      : `Artifact version ids: ${scope.artifactVersionIds.join(', ')}`

  const trackedSummary =
    mode === 'initial'
      ? []
      : [
          '',
          'This is a fix-loop re-review. Disposition every tracked check exactly once by copying',
          '`sourceFindingId` unchanged into its check. Use pass if fixed, warn/fail if it remains:',
          JSON.stringify(
            trackedChecks.map((check) => ({
              sourceFindingId: check.id,
              previousStatus: check.status,
              claim: check.claim,
              evidence: check.evidence
            }))
          ),
          'You may report a newly discovered issue without sourceFindingId, but omission of any',
          'tracked check or reuse of an unknown/duplicate id is rejected.'
        ]

  const submissionInstruction =
    mode === 'tracked'
      ? 'This tracked re-review must submit a non-empty checks array that dispositions every tracked check.'
      : `${INITIAL_REVIEW_CHECKABILITY_GUIDANCE} Do not create a pass check merely because you ` +
        'read the turn or the agent replied.'

  return [
    `You are reviewing turn: ${scope.turnMessageId}`,
    '',
    blockSummary,
    artifactSummary,
    ...trackedSummary,
    '',
    'Use only the reviewer MCP tools: read_turn, query_execution_log, and read_artifact.',
    'They expose only this audited scope. Do not use Bash, filesystem, network, or other tools.',
    '',
    'After reading the turn data, apply the rubric, then call submit_findings once with your findings.',
    submissionInstruction
  ].join('\n')
}
