// Orchestrator for the auto-review pipeline. `runReview` is called after each turn completes;
// it spawns a fresh-context reviewer ACP session, injects the rubric + scope-bounded reviewer MCP,
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
import { resolveTurnScopeWithArtifactDigests } from './artifact-digest'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { ReviewerMcpServer } from './mcp-server'
import { ReviewerHostServer } from './host-sdk'
import { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } from './rubric'
import { injectAuditorMessage } from './correction'

const log = createLogger('reviewer:orchestrator')

type SessionProvider = (
  sessionId: string
) => PersistedChatSession | undefined | Promise<PersistedChatSession | undefined>

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
  // The ACP runtime that owns the agent connection (used to spawn the reviewer session).
  acpRuntime: AcpRuntime
  // Storage root for artifact reads (used by the scope-bounded evidence reader).
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
  // The currently-open warn/fail checks to carry forward into each re-review.
  openChecks: ReviewCheck[]
  projectId: string
  mainSessionId: string
  getSession: SessionProvider
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
    acpRuntime,
    artifactStorageRoot,
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
  const markOpenChecksUnaddressed = async (): Promise<void> => {
    for (const openCheck of openChecks) {
      await reviewRepository.updateFindingResolution(
        openCheck.reviewId,
        openCheck.id,
        'unaddressed'
      )
    }
  }

  for (let round = 0; round < maxRounds; round++) {
    if (openChecks.length === 0) break

    // Abort check: if the user cancelled during the loop, exit without further [Auditor] injections.
    if (abortSignal?.aborted) {
      log.info('fix loop: aborted by user', { sessionId, round, openCount: openChecks.length })
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
      await markOpenChecksUnaddressed()
      return
    }
    if (!sessionBefore) {
      log.warn('fix loop: durable session disappeared before correction', { sessionId, round })
      await markOpenChecksUnaddressed()
      return
    }
    const messagesBefore = sessionBefore.messages
    const messageIdsBefore = new Set(messagesBefore.map((message) => message.id))

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
      await markOpenChecksUnaddressed()
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
      await markOpenChecksUnaddressed()
      return
    }
    if (!correctionState) {
      if (abortSignal?.aborted) {
        log.info('fix loop: aborted while waiting for durable correction turn', {
          sessionId,
          round
        })
        return
      }
      log.warn('correction turn did not reach durable session storage; refusing stale re-review', {
        sessionId,
        round,
        timeoutMs: sessionRefreshTimeoutMs
      })
      await markOpenChecksUnaddressed()
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
      acpRuntime,
      artifactStorageRoot,
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
      await markOpenChecksUnaddressed()
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
        await reviewRepository.incrementReflagCount(openCheck.reviewId, openCheck.id)
        log.info('fix loop: finding re-flagged', {
          sessionId,
          round,
          findingId: openCheck.id
        })
        stillOpenChecks.push(openCheck)
      } else {
        await reviewRepository.updateFindingResolution(openCheck.reviewId, openCheck.id, 'resolved')
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
    await markOpenChecksUnaddressed()
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
  getSession: SessionProvider
  reviewRepository: ReviewRepository
  acpRuntime: AcpRuntime
  artifactStorageRoot: string
  model: string
  onReviewUpdate?: (review: ReviewWithChecks) => void
  reviewerTimeoutMs: number
  reviewerMaxUpdates: number
  trackedChecks: ReviewCheck[]
  sessionSnapshot?: PersistedChatSession
}): Promise<{ review: ReviewWithChecks; submittedChecks: NewCheck[] }> => {
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
    reviewerMaxUpdates,
    trackedChecks,
    sessionSnapshot
  } = options

  // Use the exact durable snapshot that proved the correction message exists. A second independent
  // read could regress to an older file during concurrent persistence and reintroduce stale auditing.
  const session = sessionSnapshot ?? (await getSession(sessionId))

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
    return { review: { ...errorReview, checks: [] }, submittedChecks: [] }
  }

  // Resolve the correction turn's scope, pinning each artifact to a digest of its current bytes.
  const scope = await resolveTurnScopeWithArtifactDigests(
    session,
    turnMessageId,
    artifactStorageRoot
  )

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
  let reviewerSession: ActiveSession | undefined
  let mcpServer: ReviewerMcpServer | undefined
  let checksReceived: NewCheck[] = []
  let checksSubmitted = false
  const capturedLog: ReviewerLogEntry[] = []

  try {
    const evidence = new ReviewerHostServer(session, scope, artifactStorageRoot)

    mcpServer = new ReviewerMcpServer(
      scope,
      async (checks: NewCheck[]) => {
        checksReceived = checks
        checksSubmitted = true
      },
      evidence,
      trackedChecks.map((check) => check.id)
    )
    await mcpServer.start()

    const reviewerPrompt = buildReviewerPrompt(scope, trackedChecks)
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
      errorMessage: errorMsg,
      reviewerLog: capturedLog
    })
    const errorWithChecks: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithChecks)
    return { review: errorWithChecks, submittedChecks: [] }
  } finally {
    if (reviewerSession) acpRuntime.disposeReviewerSession(reviewerSession)
    await mcpServer?.stop().catch(() => undefined)
  }

  if (!checksSubmitted) {
    const errorMessage = 'Reviewer stopped without calling submit_findings.'
    log.error('scoped re-review protocol incomplete', { reviewId: review.id, error: errorMessage })
    review = await reviewRepository.updateReview(review.id, {
      lifecycle: 'error',
      errorMessage,
      reviewerLog: capturedLog
    })
    const errorWithChecks: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithChecks)
    return { review: errorWithChecks, submittedChecks: [] }
  }

  // Persist checks and complete the review.
  try {
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
      errorMessage: errorMsg,
      reviewerLog: capturedLog
    })
    const errorWithChecks: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithChecks)
    return { review: errorWithChecks, submittedChecks: [] }
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
  return { review: finalReview, submittedChecks: checksReceived }
}

// Drives one complete auto-review cycle: scope resolution → DB record → reviewer session →
// submit_findings → lifecycle update. Returns the final review (with checks) for the caller
// to broadcast. Never throws — errors are captured as lifecycle='error'.
export const runReview = async (options: RunReviewOptions): Promise<ReviewWithChecks> => {
  const {
    sessionId,
    turnMessageId,
    scopeTurnMessageId,
    projectId,
    getSession,
    reviewRepository,
    acpRuntime,
    artifactStorageRoot,
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

  log.info('runReview started', { sessionId, turnMessageId })

  // Step 1: resolve the turn scope.
  const session = await getSession(sessionId)

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

  // Audit the scope turn (defaults to the grouping turn) but keep the row grouped under turnMessageId.
  const scope = await resolveTurnScopeWithArtifactDigests(
    session,
    scopeTurnMessageId ?? turnMessageId,
    artifactStorageRoot
  )

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
  // The running row now exists and has been pushed to the renderer — this is the point a caller can
  // treat the review as genuinely "started". Anything that failed before here (scope resolution, the
  // createReview insert) threw instead, so `started` is never reported for a run that never appeared.
  onStarted?.()

  log.info('review created', { reviewId: review.id, blocks: scope.blocks.length })

  // Step 3: run the reviewer session. All failures inside are caught and set lifecycle='error'.
  let reviewerSession: ActiveSession | undefined
  let mcpServer: ReviewerMcpServer | undefined
  let checksReceived: NewCheck[] = []
  let checksSubmitted = false
  const capturedLog: ReviewerLogEntry[] = []

  try {
    // Evidence reads and submission share one authenticated MCP server. The evidence object enforces
    // turn/artifact scope server-side; no host token or Bash bootstrap is exposed to the model.
    const evidence = new ReviewerHostServer(session, scope, artifactStorageRoot)

    mcpServer = new ReviewerMcpServer(
      scope,
      async (checks: NewCheck[]) => {
        checksReceived = checks
        checksSubmitted = true
        log.info('submit_findings received by MCP handler', { count: checks.length })
      },
      evidence
    )
    await mcpServer.start()

    const reviewerPrompt = buildReviewerPrompt(scope)

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
    // lifecycle='error', and the finally disposes the session + MCP server.
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
      errorMessage: errorMsg,
      reviewerLog: capturedLog
    })
    const errorWithFindings: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithFindings)

    return errorWithFindings
  } finally {
    // Always dispose the reviewer session and shut down the servers.
    if (reviewerSession) acpRuntime.disposeReviewerSession(reviewerSession)
    await mcpServer?.stop().catch(() => undefined)
  }

  if (!checksSubmitted) {
    const errorMessage = 'Reviewer stopped without calling submit_findings.'
    log.error('review protocol incomplete', { reviewId: review.id, error: errorMessage })
    review = await reviewRepository.updateReview(review.id, {
      lifecycle: 'error',
      errorMessage,
      reviewerLog: capturedLog
    })
    const errorWithFindings: ReviewWithChecks = { ...review, checks: [] }
    onReviewUpdate?.(errorWithFindings)
    return errorWithFindings
  }

  // Step 4: persist checks and set lifecycle='complete'.
  // outcome = flagged iff at least one check is warn or fail; otherwise pass.
  try {
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
        sessionRefreshTimeoutMs,
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

// Builds the prompt sent to the isolated reviewer session. All evidence is available only through the
// scope-bounded reviewer MCP; no executable bootstrap, filesystem path, or bearer token enters the prompt.
export const buildReviewerPrompt = (
  scope: TurnScope,
  trackedChecks: readonly ReviewCheck[] = []
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

  const trackedSummary =
    trackedChecks.length === 0
      ? []
      : [
          '',
          'This is a fix-loop re-review. Disposition every tracked finding exactly once by copying',
          '`sourceFindingId` unchanged into its check. Use pass if fixed, warn/fail if it remains:',
          JSON.stringify(
            trackedChecks.map((check) => ({
              sourceFindingId: check.id,
              previousStatus: check.status,
              claim: check.claim,
              evidence: check.evidence
            }))
          ),
          'You may report a newly discovered issue without sourceFindingId, but omission of any tracked',
          'finding or reuse of an unknown/duplicate id is rejected.'
        ]

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
    'Call submit_findings with an empty array if you find no issues.'
  ].join('\n')
}
