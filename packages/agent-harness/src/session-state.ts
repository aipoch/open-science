import type { AgentCheckpoint, AgentMessage, ContentBlock, Json, ModelUsage } from './session-types'
import type { ContextItem } from './compaction'

export function json(value: unknown): asserts value is Json {
  const visiting = new Set<object>()
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || visiting.has(item))
      throw new Error('Expected acyclic JSON')
    if (validatedJson.has(item)) return
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new Error('Expected plain JSON')
    if (Object.getOwnPropertySymbols(item).length) throw new Error('Expected JSON without symbols')
    if (
      Array.isArray(item) &&
      (Object.keys(item).length !== item.length ||
        Object.keys(item).some((key, index) => key !== String(index)))
    )
      throw new Error('Expected dense JSON array')
    if (
      Object.values(Object.getOwnPropertyDescriptors(item)).some(
        (descriptor) => descriptor.get || descriptor.set
      )
    )
      throw new Error('Expected JSON without accessors')
    visiting.add(item)
    for (const child of Object.values(item)) visit(child)
    visiting.delete(item)
    // Only package-owned immutable graphs can retain a successful validation across revisions.
    if (owned.has(item)) validatedJson.add(item)
  }
  visit(value)
}

const owned = new WeakSet<object>()
const validatedJson = new WeakSet<object>()
/** Internal owned graphs only. Never infer deep immutability from Object.isFrozen on host input. */
export function seal<Value>(value: Value): Value {
  if (value && typeof value === 'object' && !owned.has(value)) {
    for (const child of Object.values(value)) seal(child)
    Object.freeze(value)
    owned.add(value)
  }
  return value
}

export function frozen<Value>(value: Value): Value {
  return seal(structuredClone(value))
}

export function immutableCheckpoint(value: AgentCheckpoint, sessionId: string): AgentCheckpoint {
  checkState(value, sessionId)
  return owned.has(value) ? value : frozen(value)
}

/** History is append-only inside the session; only pending/request/run metadata is mutated. */
export function draftCheckpoint(value: AgentCheckpoint): AgentCheckpoint {
  return {
    ...value,
    messages: [...value.messages],
    compactions: [...value.compactions],
    requests: value.requests.map((request) => ({ ...request })),
    pending: structuredClone(value.pending),
    inbox: [...(value.inbox ?? [])],
    ...(value.run ? { run: { ...value.run } } : {})
  }
}

export function content(value: ContentBlock[]): void {
  json(value)
  if (!Array.isArray(value)) throw new Error('Expected content blocks')
  for (const block of value) {
    if (block.type === 'text' && typeof block.text === 'string') continue
    if (
      ['image', 'file', 'audio', 'video'].includes(block.type) &&
      'mimeType' in block &&
      typeof block.mimeType === 'string' &&
      block.mimeType.trim() &&
      'source' in block
    )
      continue
    throw new Error('Invalid content block')
  }
}

export function usage(value: ModelUsage): void {
  json(value)
  for (const count of [
    value.inputTokens,
    value.outputTokens,
    value.cacheReadTokens ?? 0,
    value.cacheWriteTokens ?? 0
  ])
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid model usage')
}

const encodedMessage = (message: AgentMessage): string => JSON.stringify(message)

export function contextItems(
  messages: readonly AgentMessage[],
  encode = encodedMessage
): ContextItem[] {
  return messages.flatMap((message): ContextItem[] => {
    if (message.role === 'tool')
      return [
        {
          id: message.id,
          kind: 'tool-result',
          callId: message.invocationId!,
          text: encode(message)
        }
      ]
    if (message.calls?.length)
      return message.calls.map((call, index) => ({
        id: `${message.id}:call:${index}`,
        kind: 'tool-call',
        callId: `${message.id}/${call.id}`,
        text: index === 0 ? encode(message) : ''
      }))
    if (message.role === 'summary')
      return [{ id: message.id, kind: 'summary', text: encode(message) }]
    return [{ id: message.id, kind: 'message', role: message.role, text: encode(message) }]
  })
}

/** Resolve persisted compaction boundaries without serializing the archived message bodies. */
export function projectedMessages(state: AgentCheckpoint): AgentMessage[] {
  let cursor = 0
  let retained: AgentMessage[] = []
  const history = (function* () {
    for (const message of state.messages) {
      const items = contextItems([message], () => '')
      for (let i = 0; i < items.length; i++) {
        if (i === items.length - 1) cursor++
        yield items[i]
      }
    }
  })()
  for (const compacted of state.compactions) {
    if (!compacted.sourceIds.length) throw new Error('Invalid compaction prefix')
    const prefix = retained[Symbol.iterator]()
    const pending = new Set<string>()
    for (const id of compacted.sourceIds) {
      const retainedMessage = prefix.next().value
      const item = retainedMessage
        ? contextItems([retainedMessage], () => '')[0]
        : history.next().value
      if (!item || item.id !== id) throw new Error('Invalid compaction prefix')
      if (item.kind === 'tool-call') pending.add(item.callId)
      if (item.kind === 'tool-result' && !pending.delete(item.callId))
        throw new Error('Orphan compacted tool')
    }
    if (pending.size) throw new Error('Compaction splits a tool exchange')
    retained = [compacted.summary, ...(compacted.preservedUserMessages ?? []), ...prefix]
  }
  return [...retained, ...state.messages.slice(cursor)].map((message) => {
    if (!message.modelContent) return message
    const { modelContent, ...original } = message
    return { ...original, content: modelContent }
  })
}

export function projectedItems(state: AgentCheckpoint): ContextItem[] {
  return contextItems(projectedMessages(state))
}

export const itemMessages = (items: readonly ContextItem[]): AgentMessage[] =>
  items.filter((item) => item.text).map((item) => JSON.parse(item.text) as AgentMessage)

/** Reject damaged checkpoints instead of interpreting them as an empty conversation. */
export function checkState(state: AgentCheckpoint, sessionId: string): void {
  json(state)
  if (
    state.version !== 1 ||
    state.sessionId !== sessionId ||
    !sessionId.trim() ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Array.isArray(state.messages) ||
    !Array.isArray(state.pending) ||
    !Array.isArray(state.requests) ||
    !Array.isArray(state.compactions)
  )
    throw new Error('Invalid agent checkpoint')
  if (
    state.inbox !== undefined &&
    (!Array.isArray(state.inbox) ||
      state.inbox.some((entry) => {
        if (!entry.id || !Array.isArray(entry.content)) return true
        content(entry.content)
        return false
      }))
  )
    throw new Error('Invalid agent inbox')
  if (
    state.run &&
    (!state.run.id ||
      !['turn', 'compaction', 'recovery'].includes(state.run.kind) ||
      !['running', 'complete', 'budget', 'cancelled', 'failed', 'waiting', 'blocked'].includes(
        state.run.status
      ))
  )
    throw new Error('Invalid run checkpoint')
  const ids = new Set<string>()
  const users = new Map<string, AgentMessage>()
  const calls = new Map<string, { id: string; name: string; arguments: Json }>()
  const unresolved = new Set<string>()
  for (const message of state.messages) {
    if (
      !message.id ||
      ids.has(message.id) ||
      !['user', 'assistant', 'tool', 'summary'].includes(message.role)
    )
      throw new Error('Invalid message identity')
    ids.add(message.id)
    content(message.content)
    if (message.role === 'user') users.set(message.id, message)
    if (message.modelContent !== undefined) {
      if (message.role !== 'tool') throw new Error('Only tool results can have a model preview')
      content(message.modelContent)
      const media = (blocks: ContentBlock[]): ContentBlock[] =>
        blocks.filter((block) => block.type !== 'text')
      if (JSON.stringify(media(message.content)) !== JSON.stringify(media(message.modelContent)))
        throw new Error('Tool preview must preserve media')
    }
    if (message.providerState && (!message.providerState.adapterId || message.role !== 'assistant'))
      throw new Error('Invalid provider state')
    if (message.role !== 'tool' && unresolved.size) throw new Error('Unsettled tool exchange')
    if (message.calls) {
      if (message.role !== 'assistant' || !Array.isArray(message.calls))
        throw new Error('Invalid assistant calls')
      for (const call of message.calls) {
        const id = `${message.id}/${call.id}`
        if (
          typeof call.id !== 'string' ||
          !call.id.trim() ||
          typeof call.name !== 'string' ||
          !call.name.trim() ||
          calls.has(id)
        )
          throw new Error('Invalid tool identity')
        json(call.arguments)
        calls.set(id, call)
        unresolved.add(id)
      }
    }
    if (
      message.role === 'tool' &&
      (!message.invocationId || !unresolved.delete(message.invocationId))
    )
      throw new Error('Orphan tool result')
  }
  const pendingIds = new Set<string>()
  for (const pending of state.pending) {
    if (
      pendingIds.has(pending.invocationId) ||
      !unresolved.has(pending.invocationId) ||
      JSON.stringify(calls.get(pending.invocationId)) !== JSON.stringify(pending.call) ||
      !['planned', 'started', 'waiting', 'unknown'].includes(pending.status) ||
      (pending.status === 'waiting' && pending.interaction === undefined)
    )
      throw new Error('Invalid pending tool')
    pendingIds.add(pending.invocationId)
  }
  if (unresolved.size !== pendingIds.size) throw new Error('Missing pending tool')
  if (
    state.pending.length &&
    (!state.run || ['complete', 'budget', 'cancelled'].includes(state.run.status))
  )
    throw new Error('Pending tools require an unresolved run')
  const requestIds = new Set<string>()
  for (const request of state.requests) {
    if (
      !request.id ||
      requestIds.has(request.id) ||
      !request.runId ||
      !request.modelId ||
      (request.purpose !== undefined && request.purpose !== 'compaction') ||
      !['started', 'completed', 'failed', 'interrupted'].includes(request.status)
    )
      throw new Error('Invalid request record')
    requestIds.add(request.id)
    if (
      request.status === 'started' &&
      (state.run?.status !== 'running' || state.run.id !== request.runId)
    )
      throw new Error('Request has no active run')
    if (request.usage !== undefined) usage(request.usage)
  }
  for (const compacted of state.compactions) {
    if (
      !Array.isArray(compacted.sourceIds) ||
      compacted.summary.role !== 'summary' ||
      !compacted.summary.id ||
      ids.has(compacted.summary.id)
    )
      throw new Error('Invalid summary')
    ids.add(compacted.summary.id)
    content(compacted.summary.content)
    if (compacted.preservedUserMessages !== undefined) {
      if (!Array.isArray(compacted.preservedUserMessages))
        throw new Error('Invalid preserved user messages')
      const seen = new Set<string>()
      for (const message of compacted.preservedUserMessages) {
        if (
          seen.has(message.id) ||
          !compacted.sourceIds.includes(message.id) ||
          JSON.stringify(users.get(message.id)) !== JSON.stringify(message)
        )
          throw new Error('Invalid preserved user message')
        seen.add(message.id)
      }
    }
  }
  projectedMessages(state)
}
