// Drives one Reviewer ACP session to its terminal update while projecting its streamed action log.

import { extractProviderToolName, extractTerminalMeta } from '../acp/runtime-events'
import type { ReviewerLogEntry } from '../../shared/reviewer'

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
  const { onUpdate } = callbacks ?? {}
  const deadline = Date.now() + timeoutMs
  let updates = 0

  // In-flight accumulator for streaming text chunks (assembled into whole entries on transition).
  const acc: ChunkAccumulator = { thoughtText: null, messageText: null, pendingTools: new Map() }

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
      if (signal && abortListener) signal.removeEventListener('abort', abortListener)
    }
  }
}
