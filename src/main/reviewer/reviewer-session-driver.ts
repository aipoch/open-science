// Drives one Reviewer ACP session to its terminal update while projecting its streamed action log.

import { extractProviderToolName, extractTerminalMeta } from '../acp/runtime-events'
import type { ReviewerLogEntry } from '../../shared/reviewer'

type ReviewerLogLimits = {
  maxTextEntryBytes: number
  maxToolInputBytes: number
  maxToolOutputBytes: number
  maxLogBytes: number
}

const DEFAULT_REVIEWER_LOG_LIMITS: ReviewerLogLimits = {
  maxTextEntryBytes: 64 * 1_024,
  maxToolInputBytes: 64 * 1_024,
  maxToolOutputBytes: 256 * 1_024,
  maxLogBytes: 1_024 * 1_024
}

const REVIEW_LOG_TRUNCATION_RESERVE_BYTES = 96

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
  signal?: AbortSignal
  logLimits?: Partial<ReviewerLogLimits>
}

type DriveCallbacks = {
  // Called for each update that should be captured into the reviewer log.
  // The caller assembles streaming chunks into whole entries and appends them.
  onUpdate?: (entry: ReviewerLogEntry) => void
  // Reuse one state object when multiple drives append to the same persisted Review log.
  logState?: { budget?: ReviewerLogBudget }
}

// In-flight accumulator for streaming content (thought/message chunks are assembled into whole entries).
// Also tracks in-progress tool entries by toolCallId so tool_call_update can merge into the same entry.
type ChunkAccumulator = {
  thoughtText: string | null
  thoughtTextTruncated: boolean
  messageText: string | null
  messageTextTruncated: boolean
  // Map from toolCallId to the mutable tool log entry (shared reference allows update-in-place).
  pendingTools: Map<string, ReviewerLogEntry & { kind: 'tool' }>
}

const appendWithinUtf8Limit = (
  current: string,
  chunk: string,
  maxBytes: number
): { text: string; truncated: boolean } => {
  let remaining = Math.max(0, maxBytes - Buffer.byteLength(current, 'utf8'))
  let end = 0
  for (const character of chunk) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (characterBytes > remaining) return { text: current + chunk.slice(0, end), truncated: true }
    remaining -= characterBytes
    end += character.length
  }
  return { text: current + chunk, truncated: false }
}

const serializedEntryBytes = (entry: ReviewerLogEntry): number =>
  Buffer.byteLength(JSON.stringify(entry), 'utf8')

class ReviewerLogBudget {
  private readonly entries: ReviewerLogEntry[] = []
  private readonly entryBytes = new Map<ReviewerLogEntry, number>()
  private readonly contentLimit: number
  private totalBytes = 2
  private truncated = false

  constructor(
    private readonly maxBytes: number,
    private readonly onUpdate: (entry: ReviewerLogEntry) => void
  ) {
    this.contentLimit = Math.max(2, maxBytes - REVIEW_LOG_TRUNCATION_RESERVE_BYTES)
  }

  emit(entry: ReviewerLogEntry): void {
    if (this.truncated) return
    const bytes = serializedEntryBytes(entry)
    const separatorBytes = this.entries.length > 0 ? 1 : 0
    if (this.totalBytes + separatorBytes + bytes > this.contentLimit) {
      this.markTruncated()
      return
    }

    this.entries.push(entry)
    this.entryBytes.set(entry, bytes)
    this.totalBytes += separatorBytes + bytes
    this.onUpdate(entry)
  }

  reconcileTool(
    entry: ReviewerLogEntry & { kind: 'tool' },
    changedFields: readonly ('rawInput' | 'rawOutput')[]
  ): void {
    const previousBytes = this.entryBytes.get(entry)
    if (previousBytes === undefined) return

    let nextBytes = serializedEntryBytes(entry)
    const limit = this.truncated ? this.maxBytes : this.contentLimit
    if (this.totalBytes - previousBytes + nextBytes <= limit) {
      this.entryBytes.set(entry, nextBytes)
      this.totalBytes += nextBytes - previousBytes
      return
    }

    for (const field of changedFields) {
      if (field === 'rawInput') {
        delete entry.rawInput
        entry.rawInputTruncated = true
      } else {
        delete entry.rawOutput
        entry.rawOutputTruncated = true
      }
    }
    nextBytes = serializedEntryBytes(entry)
    this.entryBytes.set(entry, nextBytes)
    this.totalBytes += nextBytes - previousBytes
    this.markTruncated(entry)
  }

  private markTruncated(preferredEntry?: ReviewerLogEntry): void {
    if (this.truncated) return
    this.truncated = true
    const lastEntry =
      preferredEntry && this.entryBytes.has(preferredEntry) ? preferredEntry : this.entries.at(-1)
    if (lastEntry) {
      const previousBytes = this.entryBytes.get(lastEntry) ?? serializedEntryBytes(lastEntry)
      lastEntry.reviewLogTruncated = true
      const nextBytes = serializedEntryBytes(lastEntry)
      this.entryBytes.set(lastEntry, nextBytes)
      this.totalBytes += nextBytes - previousBytes
      return
    }

    const marker: ReviewerLogEntry = {
      kind: 'message',
      text: '',
      reviewLogTruncated: true
    }
    const markerBytes = serializedEntryBytes(marker)
    if (2 + markerBytes <= this.maxBytes) {
      this.entries.push(marker)
      this.entryBytes.set(marker, markerBytes)
      this.totalBytes = 2 + markerBytes
      this.onUpdate(marker)
    }
  }
}

// Extracts a text chunk from an ACP update's content field (may be a { type:'text', text:string } block).
const extractTextContent = (update: { content?: unknown }): string => {
  const content = update.content
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (
    typeof content === 'object' &&
    'text' in content &&
    typeof (content as { text: unknown }).text === 'string'
  ) {
    return (content as { text: string }).text
  }
  return ''
}

const MAX_STRUCTURED_ARRAY_ENTRIES = 200
const MAX_STRUCTURED_OBJECT_ENTRIES = 200
const MAX_STRUCTURED_DEPTH = 12

const OMITTED_RAW_VALUE = Symbol('omitted-raw-value')

type StructuredValueBudget = { remainingBytes: number }
type SanitizedRawValue = {
  value: unknown | typeof OMITTED_RAW_VALUE
  truncated: boolean
}

const boundedJsonString = (
  value: string,
  maxBytes: number
): { value: string; serializedBytes: number; truncated: boolean } | undefined => {
  if (maxBytes < 2) return undefined

  let remainingBytes = maxBytes - 2
  const characters: string[] = []
  for (const character of value) {
    const encodedCharacter = JSON.stringify(character).slice(1, -1)
    const characterBytes = Buffer.byteLength(encodedCharacter, 'utf8')
    if (characterBytes > remainingBytes) {
      return {
        value: characters.join(''),
        serializedBytes: maxBytes - remainingBytes,
        truncated: true
      }
    }
    characters.push(character)
    remainingBytes -= characterBytes
  }

  return {
    value: characters.join(''),
    serializedBytes: maxBytes - remainingBytes,
    truncated: false
  }
}

const consumeBudget = (budget: StructuredValueBudget, bytes: number): boolean => {
  if (bytes > budget.remainingBytes) return false
  budget.remainingBytes -= bytes
  return true
}

const sanitizeRawValue = (
  value: unknown,
  budget: StructuredValueBudget,
  depth = 0,
  ancestors = new WeakSet<object>()
): SanitizedRawValue => {
  if (typeof value === 'string') {
    const bounded = boundedJsonString(value, budget.remainingBytes)
    if (!bounded) return { value: OMITTED_RAW_VALUE, truncated: true }
    consumeBudget(budget, bounded.serializedBytes)
    return { value: bounded.value, truncated: bounded.truncated }
  }
  if (typeof value !== 'object' || value === null) {
    let serialized: string | undefined
    try {
      serialized = JSON.stringify(value)
    } catch {
      serialized = JSON.stringify(String(value))
    }
    if (serialized === undefined) serialized = 'null'
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (!consumeBudget(budget, bytes)) {
      return { value: OMITTED_RAW_VALUE, truncated: true }
    }
    return { value: JSON.parse(serialized) as unknown, truncated: false }
  }
  if (depth > MAX_STRUCTURED_DEPTH) {
    const omitted = sanitizeRawValue('[omitted: nesting limit]', budget, depth, ancestors)
    return { value: omitted.value, truncated: true }
  }
  if (ancestors.has(value)) {
    const omitted = sanitizeRawValue('[omitted: circular reference]', budget, depth, ancestors)
    return { value: omitted.value, truncated: true }
  }
  if (!consumeBudget(budget, 2)) return { value: OMITTED_RAW_VALUE, truncated: true }

  ancestors.add(value)
  let truncated = false
  if (Array.isArray(value)) {
    const bounded: unknown[] = []
    let index = 0
    for (; index < Math.min(value.length, MAX_STRUCTURED_ARRAY_ENTRIES); index++) {
      const snapshot = budget.remainingBytes
      if (!consumeBudget(budget, bounded.length > 0 ? 1 : 0) || budget.remainingBytes < 1) {
        budget.remainingBytes = snapshot
        truncated = true
        break
      }
      const sanitized = sanitizeRawValue(value[index], budget, depth + 1, ancestors)
      if (sanitized.value === OMITTED_RAW_VALUE) {
        budget.remainingBytes = snapshot
        truncated = true
        break
      }
      bounded.push(sanitized.value)
      truncated ||= sanitized.truncated
    }
    if (index < value.length) {
      const omittedEntries = value.length - index
      const snapshot = budget.remainingBytes
      if (consumeBudget(budget, bounded.length > 0 ? 1 : 0)) {
        const marker = sanitizeRawValue(
          `[omitted: ${omittedEntries} array entries]`,
          budget,
          depth + 1,
          ancestors
        )
        if (marker.value !== OMITTED_RAW_VALUE && !marker.truncated) bounded.push(marker.value)
        else budget.remainingBytes = snapshot
      }
      truncated = true
    }
    ancestors.delete(value)
    return { value: bounded, truncated }
  }

  const bounded: Record<string, unknown> = {}
  let entries = 0
  let entryLimitReached = false
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (entries >= MAX_STRUCTURED_OBJECT_ENTRIES) {
      truncated = true
      entryLimitReached = true
      break
    }

    const snapshot = budget.remainingBytes
    const separatorBytes = entries > 0 ? 1 : 0
    const boundedKey = boundedJsonString(key, budget.remainingBytes - separatorBytes - 2)
    if (
      !boundedKey ||
      boundedKey.truncated ||
      !consumeBudget(budget, separatorBytes + boundedKey.serializedBytes + 1)
    ) {
      budget.remainingBytes = snapshot
      truncated = true
      break
    }
    const sanitized = sanitizeRawValue(
      (value as Record<string, unknown>)[key],
      budget,
      depth + 1,
      ancestors
    )
    if (sanitized.value === OMITTED_RAW_VALUE) {
      budget.remainingBytes = snapshot
      truncated = true
      break
    }
    bounded[key] = sanitized.value
    truncated ||= sanitized.truncated
    entries++
  }
  if (entryLimitReached) {
    const snapshot = budget.remainingBytes
    const key = '__omitted_entries__'
    const keyBytes = Buffer.byteLength(JSON.stringify(key), 'utf8')
    if (consumeBudget(budget, 1 + keyBytes + 1)) {
      const marker = sanitizeRawValue('additional object entries', budget, depth + 1, ancestors)
      if (marker.value !== OMITTED_RAW_VALUE && !marker.truncated) bounded[key] = marker.value
      else budget.remainingBytes = snapshot
    }
    truncated = true
  }
  ancestors.delete(value)
  return { value: bounded, truncated }
}

const stringifyRawWithinLimit = (
  value: unknown,
  maxBytes: number
): { text: string; truncated: boolean } => {
  if (typeof value === 'string') return appendWithinUtf8Limit('', value, maxBytes)
  const sanitized = sanitizeRawValue(value, { remainingBytes: Math.max(0, maxBytes) })
  if (sanitized.value === OMITTED_RAW_VALUE) return { text: '', truncated: true }
  let serialized: string
  try {
    serialized = JSON.stringify(sanitized.value) ?? String(sanitized.value)
  } catch {
    serialized = String(sanitized.value)
    sanitized.truncated = true
  }
  const bounded = appendWithinUtf8Limit('', serialized, maxBytes)
  return { text: bounded.text, truncated: sanitized.truncated || bounded.truncated }
}

const flushThought = (
  acc: ChunkAccumulator,
  onUpdate: ((entry: ReviewerLogEntry) => void) | undefined
): void => {
  if (acc.thoughtText !== null && acc.thoughtText.length > 0) {
    onUpdate?.({
      kind: 'thought',
      text: acc.thoughtText,
      ...(acc.thoughtTextTruncated ? { textTruncated: true } : {})
    })
    acc.thoughtText = null
    acc.thoughtTextTruncated = false
  }
}

const flushMessage = (
  acc: ChunkAccumulator,
  onUpdate: ((entry: ReviewerLogEntry) => void) | undefined
): void => {
  if (acc.messageText !== null && acc.messageText.length > 0) {
    onUpdate?.({
      kind: 'message',
      text: acc.messageText,
      ...(acc.messageTextTruncated ? { textTruncated: true } : {})
    })
    acc.messageText = null
    acc.messageTextTruncated = false
  }
}

// Flushes any in-flight thought/message accumulators.
const flushAccumulator = (
  acc: ChunkAccumulator,
  onUpdate: ((entry: ReviewerLogEntry) => void) | undefined
): void => {
  flushThought(acc, onUpdate)
  flushMessage(acc, onUpdate)
}

// Sentinel used to distinguish the timeout branch from a real reviewer update in Promise.race.
const TIMEOUT = Symbol('reviewer-drive-timeout')
const ABORTED = Symbol('reviewer-drive-aborted')

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
  const { timeoutMs, maxUpdates, signal } = options
  const logLimits = { ...DEFAULT_REVIEWER_LOG_LIMITS, ...options.logLimits }
  const { onUpdate, logState } = callbacks ?? {}
  let logBudget = logState?.budget
  if (!logBudget && onUpdate) {
    logBudget = new ReviewerLogBudget(logLimits.maxLogBytes, onUpdate)
    if (logState) logState.budget = logBudget
  }
  const emitUpdate = logBudget
    ? (entry: ReviewerLogEntry): void => logBudget.emit(entry)
    : undefined
  const deadline = Date.now() + timeoutMs
  let updates = 0

  // In-flight accumulator for streaming text chunks (assembled into whole entries on transition).
  const acc: ChunkAccumulator = {
    thoughtText: null,
    thoughtTextTruncated: false,
    messageText: null,
    messageTextTruncated: false,
    pendingTools: new Map()
  }

  for (;;) {
    if (signal?.aborted) throw new Error('reviewer session was aborted before stopping')
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('reviewer session timed out before stopping')

    let timer: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), remaining)
    })
    const aborted = new Promise<typeof ABORTED>((resolve) => {
      if (!signal) return
      if (signal.aborted) {
        resolve(ABORTED)
        return
      }
      abortListener = () => resolve(ABORTED)
      signal.addEventListener('abort', abortListener, { once: true })
    })

    try {
      const result = await Promise.race([session.nextUpdate(), timeout, aborted])
      if (result === TIMEOUT) throw new Error('reviewer session timed out before stopping')
      if (result === ABORTED) throw new Error('reviewer session was aborted before stopping')

      if (result.kind === 'stop') {
        // Flush any in-flight streaming chunks before returning.
        flushAccumulator(acc, emitUpdate)
        return result.stopReason
      }

      const sessionUpdate = result.update?.sessionUpdate ?? ''

      // Only discrete updates count toward the loop cap; streaming content chunks do not (they scale
      // with output length, not work, and would trip the guard on a normal verbose review).
      if (!STREAMING_CHUNK_UPDATES.has(sessionUpdate)) {
        updates++
        if (updates > maxUpdates) {
          throw new Error(`reviewer session exceeded max updates (${maxUpdates})`)
        }
      }

      // --- Log capture: assemble chunks into entries and emit discrete events ---
      if (emitUpdate && result.update) {
        const u = result.update

        if (sessionUpdate === 'agent_thought_chunk') {
          // Flush any in-progress message accumulator first (content type switched).
          flushMessage(acc, emitUpdate)
          // Accumulate into thought buffer.
          const appended = appendWithinUtf8Limit(
            acc.thoughtText ?? '',
            extractTextContent(u as { content?: unknown }),
            logLimits.maxTextEntryBytes
          )
          acc.thoughtText = appended.text
          acc.thoughtTextTruncated ||= appended.truncated
        } else if (sessionUpdate === 'agent_message_chunk') {
          // Flush any in-progress thought accumulator first (content type switched).
          flushThought(acc, emitUpdate)
          // Accumulate into message buffer.
          const appended = appendWithinUtf8Limit(
            acc.messageText ?? '',
            extractTextContent(u as { content?: unknown }),
            logLimits.maxTextEntryBytes
          )
          acc.messageText = appended.text
          acc.messageTextTruncated ||= appended.truncated
        } else if (sessionUpdate === 'tool_call') {
          // Flush any in-flight streaming content before a discrete tool call.
          flushAccumulator(acc, emitUpdate)
          // Extract the real tool name from ACP provider metadata (_meta.claudeCode.toolName etc.).
          // The top-level `toolName` field is absent in ACP; only the _meta path carries the name.
          const realToolName =
            extractProviderToolName(u as { _meta?: unknown }) ??
            (u.toolName as string | undefined) ??
            ''
          const toolCallId = (u.toolCallId as string | undefined) ?? ''
          const rawInput =
            u.rawInput !== undefined
              ? stringifyRawWithinLimit(u.rawInput, logLimits.maxToolInputBytes)
              : undefined
          const entry: ReviewerLogEntry & { kind: 'tool' } = {
            kind: 'tool',
            toolName: realToolName,
            title: u.title as string | undefined,
            rawInput: rawInput?.text,
            ...(rawInput?.truncated ? { rawInputTruncated: true } : {})
          }
          // Remember by toolCallId so tool_call_update can mutate the same object in-place.
          if (toolCallId) {
            acc.pendingTools.set(toolCallId, entry)
          }
          emitUpdate(entry)
        } else if (sessionUpdate === 'tool_call_update') {
          // ACP never emits tool_result — updates arrive as tool_call_update carrying rawOutput,
          // terminal stdout, exit code, and the final status. Mutate the in-flight entry in-place
          // so the already-appended log entry (shared reference) is updated without re-emit.
          const toolCallId = (u.toolCallId as string | undefined) ?? ''
          const changedFields: ('rawInput' | 'rawOutput')[] = []
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
            emitUpdate(entry)
          }
          // Merge input/output fields into the existing entry. Claude Code seeds the initial
          // tool_call with an empty {} input and supplies the real arguments here, so a defined
          // rawInput on the update overrides the seed (mirrors the main-agent `rawInput ?? old` merge).
          if (u.rawInput !== undefined) {
            const rawInput = stringifyRawWithinLimit(u.rawInput, logLimits.maxToolInputBytes)
            entry.rawInput = rawInput.text
            if (rawInput.truncated) entry.rawInputTruncated = true
            else delete entry.rawInputTruncated
            changedFields.push('rawInput')
          }
          if (u.rawOutput !== undefined) {
            const rawOutput = stringifyRawWithinLimit(u.rawOutput, logLimits.maxToolOutputBytes)
            entry.rawOutput = rawOutput.text
            if (rawOutput.truncated) entry.rawOutputTruncated = true
            else delete entry.rawOutputTruncated
            changedFields.push('rawOutput')
          }
          const { terminalOutput, terminalExitCode } = extractTerminalMeta(
            u as Parameters<typeof extractTerminalMeta>[0]
          )
          if (terminalOutput !== undefined) {
            // Terminal stdout/stderr replaces rawOutput if it arrives via _meta.terminal_output.data
            const rawOutput = appendWithinUtf8Limit(
              '',
              terminalOutput,
              logLimits.maxToolOutputBytes
            )
            entry.rawOutput = rawOutput.text
            if (rawOutput.truncated) entry.rawOutputTruncated = true
            else delete entry.rawOutputTruncated
            if (!changedFields.includes('rawOutput')) changedFields.push('rawOutput')
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
          logBudget?.reconcileTool(entry, changedFields)
          if (
            toolCallId &&
            (statusRaw === 'completed' ||
              statusRaw === 'failed' ||
              statusRaw === 'error' ||
              statusRaw === 'ok')
          ) {
            acc.pendingTools.delete(toolCallId)
          }
        }
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
    }
  }
}
