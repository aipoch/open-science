// Orchestrator for the auto-review pipeline. `runReview` is called after each turn completes;
// it spawns a fresh-context reviewer ACP session, injects the rubric + reviewer MCP + host SDK,
// drives the reviewer to completion, persists findings, and then disposes the session.
//
// Phase 3: after a review with warn/fail, `runFixLoop` drives the bounded re-review loop:
// inject → correction turn → re-review new blocks → resolve/reflag → repeat (max 3 rounds).
//
// Errors are isolated: reviewer failures set lifecycle='error' and do NOT crash the main session.

import { homedir } from 'node:os'

import type { ActiveSession } from '@agentclientprotocol/sdk'

import type { AcpRuntime } from '../acp/runtime'
import { createLogger } from '../logger'
import { extractProviderToolName, extractTerminalMeta } from '../acp/runtime-events'
import type {
  NewCheck,
  ReviewCheck,
  ReviewerLogEntry,
  ReviewOutcome,
  ReviewWithChecks,
  TurnScope
} from '../../shared/reviewer'
import type { ReviewRepository } from './repository'
import { resolveTurnScope } from './scope'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { ReviewerMcpServer } from './mcp-server'
import { buildReviewerHostPythonBootstrap, ReviewerHostServer } from './host-sdk'
import { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } from './rubric'
import { injectAuditorMessage } from './correction'

const log = createLogger('reviewer:orchestrator')

export type RunReviewOptions = {
  sessionId: string
  // The turn to review: the agent message id (or user message id) for that turn.
  turnMessageId: string
  // The project this session belongs to.
  projectId: string
  // Used to resolve the session's persisted data for turn-scope resolution.
  // For the fix loop, this is called after each correction turn so it must return the LATEST session.
  getSession: (sessionId: string) => PersistedChatSession | undefined
  // Repository for persisting review rows + checks.
  reviewRepository: ReviewRepository
  // The ACP runtime that owns the agent connection (used to spawn the reviewer session).
  acpRuntime: AcpRuntime
  // Storage root for artifact reads (used by the reviewer host SDK).
  artifactStorageRoot: string
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
}

// Default drive-loop guards. The wall-clock timeout is the primary backstop against a reviewer that
// never stops (it is the only guard that catches a reviewer stuck streaming thoughts forever, since
// those do not count toward the update cap — see below). The update cap is a secondary backstop
// against a fast-looping reviewer that spins through discrete actions. Reviews do real multi-step
// verification (several Python cells + reasoning), so the timeout is generous.
const DEFAULT_REVIEWER_TIMEOUT_MS = 900_000
const DEFAULT_REVIEWER_MAX_UPDATES = 1000

// Streaming content deltas are emitted one-per-chunk as the reviewer writes its message/thinking, so
// their count tracks how much it *says*, not how much it *does*. Counting them toward the loop cap
// made a normally-verbose review trip the guard mid-stream before it could call submit_findings. Only
// discrete updates (tool calls, plans, tool-call status changes) count toward maxUpdates; a genuine
// runaway loop shows up there, while a hung/rambling reviewer is caught by the wall-clock timeout.
const STREAMING_CHUNK_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk'
])

// The minimal reviewer-session surface the drive loop needs. `update.sessionUpdate` is the ACP
// SessionUpdate discriminator, present on session_update messages (absent on the stop message).
type DrivableSession = {
  nextUpdate: () => Promise<{
    kind: string
    stopReason?: string
    update?: { sessionUpdate?: string; [key: string]: unknown }
  }>
}

// Options for the driveReviewerToStop log-capture callback.
type DriveOptions = {
  timeoutMs: number
  maxUpdates: number
}

type DriveCallbacks = {
  // Called for each update that should be captured into the reviewer log.
  // The caller assembles streaming chunks into whole entries and appends them.
  onUpdate?: (entry: ReviewerLogEntry) => void
}

// In-flight accumulator for streaming content (thought/message chunks are assembled into whole entries).
// Also tracks in-progress tool entries by toolCallId so tool_call_update can merge into the same entry.
type ChunkAccumulator = {
  thoughtText: string | null
  messageText: string | null
  // Map from toolCallId to the mutable tool log entry (shared reference allows update-in-place).
  pendingTools: Map<string, ReviewerLogEntry & { kind: 'tool' }>
}

// Extracts a text chunk from an ACP update's content field (may be a { type:'text', text:string } block).
const extractTextContent = (update: { content?: unknown }): string => {
  const c = update.content
  if (!c) return ''
  if (typeof c === 'string') return c
  if (
    typeof c === 'object' &&
    c !== null &&
    'text' in c &&
    typeof (c as { text: unknown }).text === 'string'
  ) {
    return (c as { text: string }).text
  }
  return ''
}

// Serializes an ACP raw tool input/output value to a display string. Strings pass through unchanged;
// objects are JSON-encoded (never String()'d, which would produce "[object Object]"). Falls back to
// String() only when the value cannot be serialized (e.g. a circular reference).
const stringifyRaw = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// Flushes any in-flight thought/message accumulator and returns the emitted entry (or null if nothing to flush).
const flushAccumulator = (
  acc: ChunkAccumulator,
  onUpdate: ((entry: ReviewerLogEntry) => void) | undefined
): void => {
  if (acc.thoughtText !== null && acc.thoughtText.length > 0) {
    onUpdate?.({ kind: 'thought', text: acc.thoughtText })
    acc.thoughtText = null
  }
  if (acc.messageText !== null && acc.messageText.length > 0) {
    onUpdate?.({ kind: 'message', text: acc.messageText })
    acc.messageText = null
  }
}

// Sentinel used to distinguish the timeout branch from a real reviewer update in Promise.race.
const TIMEOUT = Symbol('reviewer-drive-timeout')

// Consumes reviewer session updates until it stops, returning the stop reason. Throws if the
// reviewer does not stop within timeoutMs, or if it emits more than maxUpdates discrete updates —
// either way the caller sets lifecycle='error' and disposes the session + servers. Prevents a hung
// or runaway reviewer from pinning the host/MCP servers open and leaving the review row 'running'.
//
// The optional `onUpdate` callback in `callbacks` is called once per assembled log entry:
// streaming chunks (agent_thought_chunk, agent_message_chunk) are assembled into whole entries before
// the callback fires; tool_call and tool_result updates are emitted immediately. The loop-guard
// behavior is unchanged: streaming chunks still don't count toward maxUpdates.
export const driveReviewerToStop = async (
  session: DrivableSession,
  options: DriveOptions,
  callbacks?: DriveCallbacks
): Promise<string | undefined> => {
  const { timeoutMs, maxUpdates } = options
  const { onUpdate } = callbacks ?? {}
  const deadline = Date.now() + timeoutMs
  let updates = 0

  // In-flight accumulator for streaming text chunks (assembled into whole entries on transition).
  const acc: ChunkAccumulator = { thoughtText: null, messageText: null, pendingTools: new Map() }

  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('reviewer session timed out before stopping')

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), remaining)
    })

    try {
      const result = await Promise.race([session.nextUpdate(), timeout])
      if (result === TIMEOUT) throw new Error('reviewer session timed out before stopping')

      if (result.kind === 'stop') {
        // Flush any in-flight streaming chunks before returning.
        flushAccumulator(acc, onUpdate)
        return result.stopReason
      }

      const sessionUpdate = result.update?.sessionUpdate ?? ''

      // Only discrete updates count toward the loop cap; streaming content chunks do not (they scale
      // with output length, not work, and would trip the guard on a normal verbose review).
      if (!STREAMING_CHUNK_UPDATES.has(sessionUpdate)) {
        updates++
        if (updates >= maxUpdates) {
          throw new Error(`reviewer session exceeded max updates (${maxUpdates})`)
        }
      }

      // --- Log capture: assemble chunks into entries and emit discrete events ---
      if (onUpdate && result.update) {
        const u = result.update

        if (sessionUpdate === 'agent_thought_chunk') {
          // Flush any in-progress message accumulator first (content type switched).
          if (acc.messageText !== null && acc.messageText.length > 0) {
            onUpdate({ kind: 'message', text: acc.messageText })
            acc.messageText = null
          }
          // Accumulate into thought buffer.
          acc.thoughtText = (acc.thoughtText ?? '') + extractTextContent(u as { content?: unknown })
        } else if (sessionUpdate === 'agent_message_chunk') {
          // Flush any in-progress thought accumulator first (content type switched).
          if (acc.thoughtText !== null && acc.thoughtText.length > 0) {
            onUpdate({ kind: 'thought', text: acc.thoughtText })
            acc.thoughtText = null
          }
          // Accumulate into message buffer.
          acc.messageText = (acc.messageText ?? '') + extractTextContent(u as { content?: unknown })
        } else if (sessionUpdate === 'tool_call') {
          // Flush any in-flight streaming content before a discrete tool call.
          flushAccumulator(acc, onUpdate)
          // Extract the real tool name from ACP provider metadata (_meta.claudeCode.toolName etc.).
          // The top-level `toolName` field is absent in ACP; only the _meta path carries the name.
          const realToolName =
            extractProviderToolName(u as { _meta?: unknown }) ??
            (u.toolName as string | undefined) ??
            ''
          const toolCallId = (u.toolCallId as string | undefined) ?? ''
          const entry: ReviewerLogEntry & { kind: 'tool' } = {
            kind: 'tool',
            toolName: realToolName,
            title: u.title as string | undefined,
            rawInput: u.rawInput !== undefined ? stringifyRaw(u.rawInput) : undefined
          }
          // Remember by toolCallId so tool_call_update can mutate the same object in-place.
          if (toolCallId) {
            acc.pendingTools.set(toolCallId, entry)
          }
          onUpdate(entry)
        } else if (sessionUpdate === 'tool_call_update') {
          // ACP never emits tool_result — updates arrive as tool_call_update carrying rawOutput,
          // terminal stdout, exit code, and the final status. Mutate the in-flight entry in-place
          // so the already-appended log entry (shared reference) is updated without re-emit.
          const toolCallId = (u.toolCallId as string | undefined) ?? ''
          let entry = toolCallId ? acc.pendingTools.get(toolCallId) : undefined
          if (!entry) {
            // Defensive: no prior tool_call seen — create a fresh tool entry now.
            const realToolName =
              extractProviderToolName(u as { _meta?: unknown }) ??
              (u.toolName as string | undefined) ??
              ''
            entry = {
              kind: 'tool',
              toolName: realToolName,
              title: u.title as string | undefined
            }
            if (toolCallId) acc.pendingTools.set(toolCallId, entry)
            onUpdate(entry)
          }
          // Merge input/output fields into the existing entry. Claude Code seeds the initial
          // tool_call with an empty {} input and supplies the real arguments here, so a defined
          // rawInput on the update overrides the seed (mirrors the main-agent `rawInput ?? old` merge).
          if (u.rawInput !== undefined) {
            entry.rawInput = stringifyRaw(u.rawInput)
          }
          if (u.rawOutput !== undefined) {
            entry.rawOutput = stringifyRaw(u.rawOutput)
          }
          const { terminalOutput, terminalExitCode } = extractTerminalMeta(
            u as Parameters<typeof extractTerminalMeta>[0]
          )
          if (terminalOutput !== undefined) {
            // Terminal stdout/stderr replaces rawOutput if it arrives via _meta.terminal_output.data
            entry.rawOutput = terminalOutput
          }
          if (terminalExitCode !== undefined) {
            entry.exitCode = terminalExitCode
          }
          // Normalize ACP status to 'ok' | 'error'.
          const statusRaw = u.status as string | undefined
          if (statusRaw === 'completed') {
            entry.status = 'ok'
          } else if (statusRaw === 'failed' || statusRaw === 'error') {
            entry.status = 'error'
          } else if (statusRaw === 'ok' || statusRaw === 'error') {
            entry.status = statusRaw
          }
        }
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

// Options for the Phase 3 fix loop.
type FixLoopOptions = {
  sessionId: string
  // The original turn's message id (shared across all Review rows in this closure).
  originalTurnMessageId: string
  // The reviewId whose warn/fail checks are being tracked.
  originalReviewId: string
  // The currently-open warn/fail checks to carry forward into each re-review.
  openChecks: ReviewCheck[]
  projectId: string
  mainSessionId: string
  getSession: (sessionId: string) => PersistedChatSession | undefined
  reviewRepository: ReviewRepository
  acpRuntime: AcpRuntime
  artifactStorageRoot: string
  model: string
  onReviewUpdate?: (review: ReviewWithChecks) => void
  onCorrectionPrompt?: (text: string) => void
  onCorrectionFailed?: () => void
  reviewerTimeoutMs: number
  reviewerMaxUpdates: number
  maxRounds: number
  // Optional abort signal: when aborted, the loop exits at the next round boundary.
  abortSignal?: AbortSignal
}

// Runs the Phase 3 bounded re-review loop. For each round (up to maxRounds):
// 1. Injects [Auditor] with the still-open warn/fail checks.
// 2. The main agent produces a correction turn.
// 3. Re-reviews the correction turn's new blocks.
// 4. Updates resolutions on the original review's checks from re-review results:
//    - claim passes in re-review → resolved
//    - same claim flagged again → incrementReflagCount on original check; stays open
//    - claim not mentioned in re-review → stays open
// 5. If all resolved or cap reached, stops.
// Cap termination marks remaining open warn/fail checks as 'unaddressed'.
const runFixLoop = async (options: FixLoopOptions): Promise<void> => {
  const {
    sessionId,
    originalTurnMessageId,
    originalReviewId,
    projectId,
    mainSessionId,
    getSession,
    reviewRepository,
    acpRuntime,
    artifactStorageRoot,
    model,
    onReviewUpdate,
    onCorrectionPrompt,
    onCorrectionFailed,
    reviewerTimeoutMs,
    reviewerMaxUpdates,
    maxRounds,
    abortSignal
  } = options

  let openChecks = [...options.openChecks]

  for (let round = 0; round < maxRounds; round++) {
    if (openChecks.length === 0) break

    // Abort check: if the user cancelled during the loop, exit without further [Auditor] injections.
    if (abortSignal?.aborted) {
      log.info('fix loop: aborted by user', { sessionId, round, openCount: openChecks.length })
      return
    }

    // Step A: record the last known message id before the correction prompt, so we can detect
    // the correction turn's new agent message after sendPrompt returns.
    const sessionBefore = getSession(sessionId)
    const messagesBefore = sessionBefore?.messages ?? []
    const lastMessageIdBefore =
      messagesBefore.length > 0 ? messagesBefore[messagesBefore.length - 1]!.id : null

    // Step B: inject [Auditor] with the currently-open warn/fail checks.
    let correctionFailed = false
    await injectAuditorMessage({
      sessionId,
      mainSessionId,
      findings: openChecks,
      acpRuntime,
      onCorrectionPrompt,
      onCorrectionFailed: () => {
        correctionFailed = true
        onCorrectionFailed?.()
      }
    })

    // Error handling: a failed correction counts as a round (prevents infinite loop) but we
    // cannot re-review (there's no correction turn). Mark remaining as unaddressed and stop.
    if (correctionFailed) {
      log.warn('correction failed in fix loop — marking remaining checks unaddressed', {
        sessionId,
        round,
        openCount: openChecks.length
      })
      await reviewRepository.updateFindingResolutions(originalReviewId, 'unaddressed')
      return
    }

    // Step C: reload the session to see the correction turn's new messages.
    const sessionAfter = getSession(sessionId)
    if (!sessionAfter) {
      log.warn('session not found after correction in fix loop', { sessionId, round })
      await reviewRepository.updateFindingResolutions(originalReviewId, 'unaddressed')
      return
    }

    // Find the first new agent message added after the correction prompt. This is the
    // correction turn's response — use it as the turnMessageId for the re-review scope.
    const messagesAfter = sessionAfter.messages ?? []
    const newMessages = lastMessageIdBefore
      ? (() => {
          const cutoffIndex = messagesAfter.findIndex((m) => m.id === lastMessageIdBefore)
          return cutoffIndex >= 0 ? messagesAfter.slice(cutoffIndex + 1) : messagesAfter
        })()
      : messagesAfter

    const correctionAgentMsg = newMessages.find((m) => m.role === 'agent')
    if (!correctionAgentMsg) {
      log.warn(
        'no new agent message after correction in fix loop — using auditor msg as scope marker',
        {
          sessionId,
          round,
          newMessageCount: newMessages.length
        }
      )
      // Fall back to re-reviewing the whole session's last agent message.
    }

    const correctionTurnMessageId = correctionAgentMsg?.id ?? originalTurnMessageId

    // Step D: run a re-review scoped to the correction turn's new blocks.
    // This creates a new Review row sharing the original turnMessageId.
    log.info('fix loop: running re-review', { sessionId, round, correctionTurnMessageId })

    const reReviewResult = await runScopedReview({
      sessionId,
      turnMessageId: correctionTurnMessageId,
      originalTurnMessageId,
      projectId,
      getSession,
      reviewRepository,
      acpRuntime,
      artifactStorageRoot,
      model,
      onReviewUpdate,
      reviewerTimeoutMs,
      reviewerMaxUpdates
    })

    // Step E: compute resolution transitions for the original review's open checks.
    // - If the re-review errored: count as a round but mark remaining unaddressed and stop.
    // - If the re-review has no warn/fail (all pass or empty): all open checks → resolved.
    // - If the re-review flags the same claim: incrementReflagCount; stays open.
    // - If the re-review flags a different claim: original open check stays open.

    if (reReviewResult.lifecycle === 'error') {
      log.warn('fix loop: re-review errored — marking remaining checks unaddressed', {
        sessionId,
        round,
        openCount: openChecks.length
      })
      for (const openCheck of openChecks) {
        await reviewRepository.updateFindingResolutionForClaim(
          originalReviewId,
          openCheck.claim,
          'unaddressed'
        )
      }
      return
    }

    const reReviewWarnFail = reReviewResult.checks.filter(
      (c) => c.status === 'warn' || c.status === 'fail'
    )
    const reReviewWarnFailClaims = new Set(reReviewWarnFail.map((c) => c.claim))

    const stillOpenChecks: ReviewCheck[] = []

    for (const openCheck of openChecks) {
      if (reReviewWarnFailClaims.has(openCheck.claim)) {
        // Same claim flagged again → over-correction; increment reflagCount and keep open.
        await reviewRepository.incrementReflagCount(originalReviewId, openCheck.claim)
        log.info('fix loop: claim re-flagged (over-correction)', {
          sessionId,
          round,
          claim: openCheck.claim
        })
        stillOpenChecks.push(openCheck)
      } else {
        // Claim not flagged in re-review → resolved.
        await reviewRepository.updateFindingResolutionForClaim(
          originalReviewId,
          openCheck.claim,
          'resolved'
        )
        log.info('fix loop: claim resolved', { sessionId, round, claim: openCheck.claim })
      }
    }

    openChecks = stillOpenChecks

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
    for (const openCheck of openChecks) {
      await reviewRepository.updateFindingResolutionForClaim(
        originalReviewId,
        openCheck.claim,
        'unaddressed'
      )
    }
  }
}

// Runs one scoped re-review for a correction turn. Creates a new Review row under the same
// original turnMessageId so all iterations are grouped. Returns the completed review.
// Never throws — errors are captured as lifecycle='error'.
const runScopedReview = async (options: {
  sessionId: string
  turnMessageId: string // the correction turn's agent message id
  originalTurnMessageId: string // shared across all Review rows in this fix-loop closure
  projectId: string
  getSession: (sessionId: string) => PersistedChatSession | undefined
  reviewRepository: ReviewRepository
  acpRuntime: AcpRuntime
  artifactStorageRoot: string
  model: string
  onReviewUpdate?: (review: ReviewWithChecks) => void
  reviewerTimeoutMs: number
  reviewerMaxUpdates: number
}): Promise<ReviewWithChecks> => {
  const {
    sessionId,
    turnMessageId,
    originalTurnMessageId,
    projectId,
    getSession,
    reviewRepository,
    acpRuntime,
    artifactStorageRoot,
    model,
    onReviewUpdate,
    reviewerTimeoutMs,
    reviewerMaxUpdates
  } = options

  const session = getSession(sessionId)

  if (!session) {
    log.warn('session not found for scoped re-review', { sessionId })
    const errorReview = await reviewRepository.createReview({
      projectId,
      sessionId,
      turnMessageId: originalTurnMessageId,
      scope: { turnMessageId: originalTurnMessageId, blocks: [], artifactVersionIds: [] },
      lifecycle: 'error',
      errorMessage: `Session ${sessionId} not found during re-review`,
      model
    })
    return { ...errorReview, checks: [] }
  }

  // Resolve the correction turn's scope.
  const scope = resolveTurnScope(session, turnMessageId)

  // Create a new Review row sharing the originalTurnMessageId (not the correction turn's id),
  // so all iterations are grouped under the same original turn.
  let review = await reviewRepository.createReview({
    projectId,
    sessionId,
    turnMessageId: originalTurnMessageId,
    scope,
    lifecycle: 'running',
    model
  })

  const initialWithChecks: ReviewWithChecks = { ...review, checks: [] }
  onReviewUpdate?.(initialWithChecks)

  log.info('scoped re-review created', { reviewId: review.id, blocks: scope.blocks.length })

  // Run the reviewer session (same flow as the initial review).
  let reviewerSession: ReturnType<typeof Object.create> | undefined
  let hostServer: ReviewerHostServer | undefined
  let mcpServer: ReviewerMcpServer | undefined
  let checksReceived: NewCheck[] = []
  let checksSubmitted = false
  const capturedLog: ReviewerLogEntry[] = []

  try {
    hostServer = new ReviewerHostServer(session, scope, artifactStorageRoot)
    const { endpoint: hostEndpoint, token: hostToken } = await hostServer.start()

    mcpServer = new ReviewerMcpServer(scope, async (checks: NewCheck[]) => {
      checksReceived = checks
      checksSubmitted = true
    })
    await mcpServer.start()

    const reviewerPrompt = buildReviewerPrompt(scope, hostEndpoint, hostToken)
    const systemPromptAppend = REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND
    const cwd = session.cwd || homedir()

    const built = await acpRuntime.buildReviewerSession({
      cwd,
      mcpServers: [mcpServer.toAcpMcpServerConfig()],
      systemPromptAppend
    })
    reviewerSession = built.session

    // opencode has no system-prompt preset, so the rubric rides back as a prompt prefix; Claude gets
    // it via _meta and returns no prefix. Prepend it so the reviewer rubric reaches either framework.
    const reviewerPromptText = built.promptPrefix
      ? `${built.promptPrefix}\n\n${reviewerPrompt}`
      : reviewerPrompt
    reviewerSession.prompt([{ type: 'text', text: reviewerPromptText }])

    await driveReviewerToStop(
      reviewerSession,
      { timeoutMs: reviewerTimeoutMs, maxUpdates: reviewerMaxUpdates },
      { onUpdate: (entry) => capturedLog.push(entry) }
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('scoped re-review session failed', { reviewId: review.id, error: errorMsg })

    review = await reviewRepository.updateReview(review.id, {
      lifecycle: 'error',
      errorMessage: errorMsg
    })
    const errorWithChecks: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithChecks)
    return errorWithChecks
  } finally {
    if (reviewerSession) acpRuntime.disposeReviewerSession(reviewerSession)
    await mcpServer?.stop().catch(() => undefined)
    await hostServer?.stop().catch(() => undefined)
  }

  // Persist checks and complete the review.
  try {
    if (!checksSubmitted) {
      log.warn('re-reviewer did not call submit_findings; treating as pass', {
        reviewId: review.id
      })
    }

    await reviewRepository.addChecks(review.id, checksReceived)

    const hasWarnOrFailCheck = checksReceived.some(
      (c) => c.status === 'warn' || c.status === 'fail'
    )
    const outcome: ReviewOutcome = hasWarnOrFailCheck ? 'flagged' : 'pass'
    review = await reviewRepository.updateReview(review.id, {
      lifecycle: 'complete',
      outcome,
      reviewerLog: capturedLog
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('scoped re-review persistence failed', { reviewId: review.id, error: errorMsg })
    review = await reviewRepository.updateReview(review.id, {
      lifecycle: 'error',
      errorMessage: errorMsg
    })
    const errorWithChecks: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithChecks)
    return errorWithChecks
  }

  // Load the final review with checks.
  const allReviews = await reviewRepository.getReviewsForSession(sessionId)
  const finalReview = allReviews.find((r) => r.id === review.id) ?? {
    ...review,
    checks: checksReceived.map((c, i): ReviewCheck => ({
      id: `check-${i}`,
      reviewId: review.id,
      status: c.status,
      resolution: 'open',
      claim: c.claim,
      evidence: c.evidence,
      locator: c.locator,
      artifactVersionId: c.artifactVersionId,
      sortIndex: c.sortIndex ?? i,
      reflagCount: 0
    }))
  }

  onReviewUpdate?.(finalReview)
  return finalReview
}

// Drives one complete auto-review cycle: scope resolution → DB record → reviewer session →
// submit_findings → lifecycle update. Returns the final review (with checks) for the caller
// to broadcast. Never throws — errors are captured as lifecycle='error'.
export const runReview = async (options: RunReviewOptions): Promise<ReviewWithChecks> => {
  const {
    sessionId,
    turnMessageId,
    projectId,
    getSession,
    reviewRepository,
    acpRuntime,
    artifactStorageRoot,
    model = '',
    onReviewUpdate,
    mainSessionId,
    onCorrectionPrompt,
    onCorrectionFailed,
    reviewerTimeoutMs = DEFAULT_REVIEWER_TIMEOUT_MS,
    reviewerMaxUpdates = DEFAULT_REVIEWER_MAX_UPDATES,
    fixLoopMaxRounds = 3,
    onFixLoopStart,
    onFixLoopEnd,
    fixLoopAbortSignal
  } = options

  log.info('runReview started', { sessionId, turnMessageId })

  // Step 1: resolve the turn scope.
  const session = getSession(sessionId)

  if (!session) {
    log.warn('session not found for review', { sessionId })
    const errorReview = await reviewRepository.createReview({
      projectId,
      sessionId,
      turnMessageId,
      scope: { turnMessageId, blocks: [], artifactVersionIds: [] },
      lifecycle: 'error',
      errorMessage: `Session ${sessionId} not found`,
      model
    })
    const withFindings: ReviewWithChecks = { ...errorReview, checks: [] }
    onReviewUpdate?.(withFindings)
    return withFindings
  }

  const scope = resolveTurnScope(session, turnMessageId)

  // Step 2: create the Review row (lifecycle='running') immediately so the renderer shows a spinner.
  let review = await reviewRepository.createReview({
    projectId,
    sessionId,
    turnMessageId,
    scope,
    lifecycle: 'running',
    model
  })

  const initialWithFindings: ReviewWithChecks = { ...review, checks: [] }
  onReviewUpdate?.(initialWithFindings)

  log.info('review created', { reviewId: review.id, blocks: scope.blocks.length })

  // Step 3: run the reviewer session. All failures inside are caught and set lifecycle='error'.
  let reviewerSession: ActiveSession | undefined
  let hostServer: ReviewerHostServer | undefined
  let mcpServer: ReviewerMcpServer | undefined
  let checksReceived: NewCheck[] = []
  let checksSubmitted = false
  const capturedLog: ReviewerLogEntry[] = []

  try {
    // Start the host SDK server (provides read_turn / query_execution_log / read_artifact).
    hostServer = new ReviewerHostServer(session, scope, artifactStorageRoot)
    const { endpoint: hostEndpoint, token: hostToken } = await hostServer.start()

    // Start the submit_findings MCP server.
    mcpServer = new ReviewerMcpServer(scope, async (checks: NewCheck[]) => {
      checksReceived = checks
      checksSubmitted = true
      log.info('submit_findings received by MCP handler', { count: checks.length })
    })
    // The endpoint/token are consumed via mcpServer.toAcpMcpServerConfig() below.
    await mcpServer.start()

    // Build the reviewer prompt: passes the turn scope metadata and host SDK endpoint.
    const reviewerPrompt = buildReviewerPrompt(scope, hostEndpoint, hostToken)

    // Combine the rubric with the host SDK Python setup instructions.
    const systemPromptAppend = REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND

    // Spawn the reviewer ACP session (clean context, reviewer-only tools).
    const cwd = session.cwd || homedir()

    const built = await acpRuntime.buildReviewerSession({
      cwd,
      mcpServers: [mcpServer.toAcpMcpServerConfig()],
      systemPromptAppend
    })
    reviewerSession = built.session

    log.info('reviewer session started', { sessionId: reviewerSession.sessionId })

    // Send the prompt and drive the session to completion. A timeout / update cap guards against a
    // hung or fast-looping reviewer that never stops: on expiry this throws, the catch below sets
    // lifecycle='error', and the finally disposes the session + host/MCP servers.
    // opencode gets the rubric via a prompt prefix (Claude via _meta, prefix empty).
    const reviewerPromptText = built.promptPrefix
      ? `${built.promptPrefix}\n\n${reviewerPrompt}`
      : reviewerPrompt
    reviewerSession.prompt([{ type: 'text', text: reviewerPromptText }])

    const stopReason = await driveReviewerToStop(
      reviewerSession,
      {
        timeoutMs: reviewerTimeoutMs,
        maxUpdates: reviewerMaxUpdates
      },
      {
        onUpdate: (entry) => capturedLog.push(entry)
      }
    )
    log.info('reviewer session stopped', { reviewId: review.id, stopReason })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('reviewer session failed', { reviewId: review.id, error: errorMsg })

    review = await reviewRepository.updateReview(review.id, {
      lifecycle: 'error',
      errorMessage: errorMsg
    })
    const errorWithFindings: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithFindings)

    return errorWithFindings
  } finally {
    // Always dispose the reviewer session and shut down the servers.
    if (reviewerSession) acpRuntime.disposeReviewerSession(reviewerSession)
    await mcpServer?.stop().catch(() => undefined)
    await hostServer?.stop().catch(() => undefined)
  }

  // Step 4: persist checks and set lifecycle='complete'.
  // outcome = flagged iff at least one check is warn or fail; otherwise pass.
  try {
    if (!checksSubmitted) {
      log.warn('reviewer did not call submit_findings; treating as pass', { reviewId: review.id })
    }

    await reviewRepository.addChecks(review.id, checksReceived)

    const hasWarnOrFailCheck = checksReceived.some(
      (c) => c.status === 'warn' || c.status === 'fail'
    )
    const outcome: ReviewOutcome = hasWarnOrFailCheck ? 'flagged' : 'pass'
    review = await reviewRepository.updateReview(review.id, {
      lifecycle: 'complete',
      outcome,
      reviewerLog: capturedLog
    })

    log.info('review complete', {
      reviewId: review.id,
      outcome,
      checkCount: checksReceived.length
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    log.error('review persistence failed', { reviewId: review.id, error: errorMsg })

    review = await reviewRepository.updateReview(review.id, {
      lifecycle: 'error',
      errorMessage: errorMsg
    })
    const errorWithFindings: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithFindings)
    return errorWithFindings
  }

  // Load the final review + checks to return.
  const allReviews = await reviewRepository.getReviewsForSession(sessionId)
  const finalReview = allReviews.find((r) => r.id === review.id) ?? {
    ...review,
    checks: checksReceived.map((c, i): ReviewCheck => ({
      id: `check-${i}`,
      reviewId: review.id,
      status: c.status,
      resolution: 'open',
      claim: c.claim,
      evidence: c.evidence,
      locator: c.locator,
      artifactVersionId: c.artifactVersionId,
      sortIndex: c.sortIndex ?? i,
      reflagCount: 0
    }))
  }

  // Step 5: Phase 3 fix loop. If there are warn/fail checks and a main session is provided,
  // drive the bounded re-review loop: inject → correction → re-review → resolution → repeat.
  const hasWarnOrFail = finalReview.checks.some((c) => c.status === 'warn' || c.status === 'fail')

  if (mainSessionId && hasWarnOrFail) {
    onFixLoopStart?.()
    try {
      await runFixLoop({
        sessionId,
        originalTurnMessageId: turnMessageId,
        originalReviewId: review.id,
        openChecks: finalReview.checks.filter((c) => c.status === 'warn' || c.status === 'fail'),
        projectId,
        mainSessionId,
        getSession,
        reviewRepository,
        acpRuntime,
        artifactStorageRoot,
        model,
        onReviewUpdate,
        onCorrectionPrompt,
        onCorrectionFailed,
        reviewerTimeoutMs,
        reviewerMaxUpdates,
        maxRounds: fixLoopMaxRounds,
        abortSignal: fixLoopAbortSignal
      })
    } finally {
      onFixLoopEnd?.()
    }

    // Reload checks after the fix loop so the returned object reflects final resolutions.
    const reloadedReviews = await reviewRepository.getReviewsForSession(sessionId)
    const reloadedReview = reloadedReviews.find((r) => r.id === review.id)
    if (reloadedReview) {
      onReviewUpdate?.(reloadedReview)
      return reloadedReview
    }
  }

  onReviewUpdate?.(finalReview)
  return finalReview
}

// Builds the initial prompt sent to the reviewer session. It passes the turn scope as structured
// context and provides the host client via the single-sourced bootstrap (see host-sdk.ts) — the
// reviewer runs Python through Bash, so each fresh process must re-run this setup; there is no
// pre-loaded `host` object.
export const buildReviewerPrompt = (
  scope: TurnScope,
  hostEndpoint: string,
  hostToken: string
): string => {
  const blockSummary =
    scope.blocks.length === 0
      ? 'This turn has no blocks (it may be empty).'
      : `This turn has ${scope.blocks.length} block(s): ` +
        scope.blocks
          .map((b) => `[${b.blockIndex}] ${b.kind}:${b.sourceId}`)
          .slice(0, 10)
          .join(', ') +
        (scope.blocks.length > 10 ? ', ...' : '')

  const artifactSummary =
    scope.artifactVersionIds.length === 0
      ? 'No artifacts in this turn.'
      : `Artifact version ids: ${scope.artifactVersionIds.join(', ')}`

  return [
    `You are reviewing turn: ${scope.turnMessageId}`,
    '',
    blockSummary,
    artifactSummary,
    '',
    'To read the turn data, run Python via Bash. Each invocation is a fresh process, so include this',
    'host client setup at the top of every snippet — there is no pre-loaded `host`:',
    '',
    '```python',
    buildReviewerHostPythonBootstrap(hostEndpoint, hostToken),
    '# Then read the turn:',
    'blocks = host.read_turn()',
    '```',
    '',
    'After reading the turn data, apply the rubric, then call submit_findings once with your findings.',
    'Call submit_findings with an empty array if you find no issues.'
  ].join('\n')
}
