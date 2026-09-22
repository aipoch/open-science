import type { AcpRuntimeEvent } from '../../shared/acp'

type ThinkingState = {
  insideThink: boolean
  pending: string
  bodyStarted: boolean
  lastEvent: AcpRuntimeEvent
  thoughtMessageId: string
}
type CodeBuddyToolBoundary = Readonly<{
  toolCallId: string
  providerMessageId?: string
  projectedMessageId?: string
}>
type OutputSegment = Readonly<{
  kind: 'message' | 'thought'
  text: string
}>
const incompleteTagStart = (text: string, marker: string): number => {
  const start = text.lastIndexOf('<')
  if (start < 0) return -1
  const tail = text.slice(start).toLowerCase()
  return marker.startsWith(tail) || (tail.startsWith(marker) && !tail.includes('>')) ? start : -1
}

const splitThinking = (
  state: ThinkingState,
  chunk: string,
  leadingOnly: boolean
): { segments: OutputSegment[]; changed: boolean } => {
  let source = state.pending + chunk
  const segments: OutputSegment[] = []
  let changed = state.pending.length > 0 || state.insideThink
  state.pending = ''
  const append = (kind: OutputSegment['kind'], text: string): void => {
    if (!text) return
    const previous = segments.at(-1)
    if (previous?.kind === kind) {
      segments[segments.length - 1] = { kind, text: previous.text + text }
    } else {
      segments.push({ kind, text })
    }
  }

  while (source) {
    if (state.insideThink) {
      const close = /<\/think\s*>/i.exec(source)
      if (close) {
        append('thought', source.slice(0, close.index))
        source = source.slice(close.index + close[0].length)
        state.insideThink = false
        changed = true
        continue
      }
      const candidate = incompleteTagStart(source, '</think')
      const partial = candidate >= 0 && source.length - candidate <= 64 ? candidate : -1
      append('thought', partial >= 0 ? source.slice(0, partial) : source)
      if (partial >= 0) state.pending = source.slice(partial)
      return { segments, changed: true }
    }

    // OpenCode/MiniMax wraps leading reasoning, not arbitrary tags in the answer.
    // Once prose or a code fence starts, preserve all subsequent tags literally.
    const open = (leadingOnly ? /<think\s*>/i : /<think\b[^>]*>/i).exec(source)
    if (leadingOnly && (state.bodyStarted || (open && source.slice(0, open.index).trim()))) {
      state.bodyStarted = true
      append('message', source)
      break
    }
    if (open) {
      append('message', source.slice(0, open.index))
      source = source.slice(open.index + open[0].length)
      state.insideThink = true
      changed = true
      continue
    }
    const partial = incompleteTagStart(source, '<think')
    if (
      partial >= 0 &&
      source.length - partial <= 64 &&
      (!leadingOnly || !source.slice(0, partial).trim())
    ) {
      append('message', source.slice(0, partial))
      state.pending = source.slice(partial)
      return { segments, changed: true }
    }
    append('message', source)
    if (source.trim()) state.bodyStarted = true
    source = ''
  }

  return { segments, changed }
}

class AcpAssistantOutputAdapter {
  private readonly thinking = new Map<string, ThinkingState>()
  private readonly toolBoundary = new Map<string, CodeBuddyToolBoundary>()

  clear(): void {
    this.thinking.clear()
    this.toolBoundary.clear()
  }

  clearSession(sessionId: string): void {
    this.toolBoundary.delete(sessionId)
    for (const key of this.thinking.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.thinking.delete(key)
    }
  }

  // Flush literal partial tags before a tool/terminal boundary, then retire all
  // parser state so cancellation or a provider-reused message id cannot taint the next turn.
  finishSession(sessionId: string): readonly AcpRuntimeEvent[] {
    const events: AcpRuntimeEvent[] = []
    for (const [key, state] of this.thinking) {
      if (!key.startsWith(`${sessionId}\0`) || !state.pending) continue
      const event = state.lastEvent
      events.push({
        ...event,
        id: `${event.id}:tail`,
        kind: state.insideThink ? 'thought' : 'message',
        messageId: state.insideThink ? state.thoughtMessageId : event.messageId,
        text: state.pending,
        raw: undefined
      } as AcpRuntimeEvent)
    }
    this.clearSession(sessionId)
    return events
  }

  projectToolEvent(
    sessionId: string,
    event: AcpRuntimeEvent,
    opensBoundary: boolean
  ): AcpRuntimeEvent {
    if (event.kind !== 'tool' || !event.toolCallId) return event

    if (opensBoundary) {
      this.toolBoundary.set(sessionId, {
        toolCallId: event.toolCallId,
        ...(event.messageId
          ? {
              providerMessageId: event.messageId,
              projectedMessageId: `${event.messageId}:${event.toolCallId}`
            }
          : {})
      })
    }
    return event
  }

  projectAssistantChunk(
    sessionId: string,
    event: AcpRuntimeEvent,
    leadingOnly = false
  ): readonly AcpRuntimeEvent[] {
    if (
      event.kind !== 'message' ||
      event.role !== 'assistant' ||
      typeof event.text !== 'string' ||
      event.image
    ) {
      return Object.freeze([event])
    }
    let boundary = this.toolBoundary.get(sessionId)
    if (boundary && !boundary.projectedMessageId) {
      boundary = {
        ...boundary,
        providerMessageId: event.messageId,
        projectedMessageId: `${event.messageId ?? event.id}:${boundary.toolCallId}`
      }
      this.toolBoundary.set(sessionId, boundary)
    }
    const boundaryMatches =
      boundary &&
      (boundary.providerMessageId === undefined || event.messageId === boundary.providerMessageId)
    const messageId = boundary && boundaryMatches ? boundary.projectedMessageId : event.messageId
    if (boundary && !boundaryMatches) {
      this.toolBoundary.delete(sessionId)
    }
    const visibleEvent = messageId ? { ...event, messageId } : event
    const key = `${sessionId}\0${event.messageId ?? ''}`
    const state = this.thinking.get(key) ?? {
      insideThink: false,
      pending: '',
      bodyStarted: false,
      lastEvent: visibleEvent,
      thoughtMessageId: `${visibleEvent.messageId ?? event.id}:thought`
    }
    this.thinking.set(key, state)
    const split = splitThinking(state, event.text, leadingOnly)
    state.lastEvent = visibleEvent
    if (!split.changed) return Object.freeze([visibleEvent])

    return Object.freeze(
      split.segments.map((segment, index): AcpRuntimeEvent => {
        const id = `${event.id}:${index + 1}`
        if (segment.kind === 'message') {
          return { ...visibleEvent, id, text: segment.text, raw: undefined }
        }

        return {
          id,
          timestamp: event.timestamp,
          kind: 'thought',
          level: event.level,
          sessionId: event.sessionId,
          runId: event.runId,
          promptMessageId: event.promptMessageId,
          role: 'assistant',
          messageId: state.thoughtMessageId,
          text: segment.text,
          raw: undefined
        }
      })
    )
  }
}

export { AcpAssistantOutputAdapter }
