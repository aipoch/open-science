import type { AcpRuntimeEvent } from '../../shared/acp'

type CodeBuddyThinkingState = { insideThink: boolean; pending: string }
type CodeBuddyToolBoundary = Readonly<{
  toolCallId: string
  providerMessageId?: string
  projectedMessageId?: string
}>
type CodeBuddyOutputSegment = Readonly<{
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
  state: CodeBuddyThinkingState,
  chunk: string
): { segments: CodeBuddyOutputSegment[]; changed: boolean } => {
  let source = state.pending + chunk
  const segments: CodeBuddyOutputSegment[] = []
  let changed = state.pending.length > 0 || state.insideThink
  state.pending = ''
  const append = (kind: CodeBuddyOutputSegment['kind'], text: string): void => {
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
      const partial = incompleteTagStart(source, '</think')
      append('thought', partial >= 0 ? source.slice(0, partial) : source)
      if (partial >= 0) state.pending = source.slice(partial)
      return { segments, changed: true }
    }

    const open = /<think\b[^>]*>/i.exec(source)
    if (open) {
      append('message', source.slice(0, open.index))
      source = source.slice(open.index + open[0].length)
      state.insideThink = true
      changed = true
      continue
    }
    const partial = incompleteTagStart(source, '<think')
    if (partial >= 0) {
      append('message', source.slice(0, partial))
      state.pending = source.slice(partial)
      return { segments, changed: true }
    }
    append('message', source)
    source = ''
  }

  return { segments, changed }
}

class CodeBuddyOutputAdapter {
  private readonly thinking = new Map<string, CodeBuddyThinkingState>()
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

  projectAssistantChunk(sessionId: string, event: AcpRuntimeEvent): readonly AcpRuntimeEvent[] {
    if (event.kind !== 'message' || event.role !== 'assistant' || typeof event.text !== 'string') {
      return Object.freeze([event])
    }
    const key = `${sessionId}\0${event.messageId ?? ''}`
    const state = this.thinking.get(key) ?? { insideThink: false, pending: '' }
    this.thinking.set(key, state)
    const split = splitThinking(state, event.text)
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
          messageId: `${event.messageId ?? event.id}:thought`,
          text: segment.text,
          raw: undefined
        }
      })
    )
  }
}

export { CodeBuddyOutputAdapter }
