import type { ResponsesReplyReasoning } from './types'
const DEFAULT_REASONING_CACHE_MAX_ENTRIES = 4096
const DEFAULT_REASONING_CACHE_MAX_CHARACTERS = 8 * 1024 * 1024
export class ReasoningReplay {
  private readonly reasoningByPromptCacheKey = new Map<
    string,
    Map<string, ResponsesReplyReasoning>
  >()
  private reasoningCacheEntryCount = 0
  private reasoningCacheCharacterCount = 0

  constructor(
    private readonly options: {
      reasoningCacheMaxEntries?: number
      reasoningCacheMaxCharacters?: number
    }
  ) {}
  clear(): void {
    this.reasoningByPromptCacheKey.clear()
    this.reasoningCacheEntryCount = 0
    this.reasoningCacheCharacterCount = 0
  }

  forRequest(promptCacheKey: string | undefined): Map<string, ResponsesReplyReasoning> | undefined {
    if (!promptCacheKey) return undefined
    return this.reasoningByPromptCacheKey.get(promptCacheKey)
  }

  reconcile(promptCacheKey: string | undefined, input: unknown): void {
    if (!promptCacheKey) return
    const reasoningByItemId = this.reasoningByPromptCacheKey.get(promptCacheKey)
    if (!reasoningByItemId) return

    const retainedItemIds = new Set<string>()
    if (Array.isArray(input)) {
      for (const item of input) {
        if (!item || typeof item !== 'object' || !('type' in item)) continue
        if (item.type === 'function_call') {
          const callId = 'call_id' in item ? item.call_id : 'id' in item ? item.id : undefined
          if (callId !== undefined && callId !== null) {
            retainedItemIds.add(JSON.stringify(['function_call', String(callId)]))
          }
        } else if (
          item.type === 'message' &&
          'role' in item &&
          item.role === 'assistant' &&
          'id' in item &&
          typeof item.id === 'string'
        ) {
          retainedItemIds.add(JSON.stringify(['message', item.id]))
        }
      }
    }

    for (const [callId, reasoning] of reasoningByItemId) {
      if (retainedItemIds.has(callId)) continue
      reasoningByItemId.delete(callId)
      this.reasoningCacheEntryCount -= 1
      this.reasoningCacheCharacterCount -= reasoning.text.length
    }
    if (reasoningByItemId.size === 0) {
      this.reasoningByPromptCacheKey.delete(promptCacheKey)
      return
    }

    // Refresh this Session's insertion order so overflow evicts the least recently used scope.
    this.reasoningByPromptCacheKey.delete(promptCacheKey)
    this.reasoningByPromptCacheKey.set(promptCacheKey, reasoningByItemId)
  }

  // Records this turn's reasoning against its Session-scoped text and tool ids so the next request can
  // pass it back to thinking-mode providers. Missing prompt_cache_key fails closed: without a stable
  // Session boundary, cached reasoning cannot be replayed safely.
  record(
    promptCacheKey: string | undefined,
    reasoning: string,
    callIds: string[],
    messageId?: string
  ): void {
    if (!promptCacheKey || !reasoning || (callIds.length === 0 && !messageId)) return
    let reasoningByItemId = this.reasoningByPromptCacheKey.get(promptCacheKey)
    if (!reasoningByItemId) {
      reasoningByItemId = new Map()
    } else {
      this.reasoningByPromptCacheKey.delete(promptCacheKey)
    }
    this.reasoningByPromptCacheKey.set(promptCacheKey, reasoningByItemId)

    const replyReasoning: ResponsesReplyReasoning = { text: reasoning }
    const itemIds = callIds.map((callId) => JSON.stringify(['function_call', callId]))
    if (messageId) itemIds.push(JSON.stringify(['message', messageId]))
    for (const itemId of itemIds) {
      const previous = reasoningByItemId.get(itemId)
      if (previous !== undefined) {
        this.reasoningCacheCharacterCount -= previous.text.length
      } else {
        this.reasoningCacheEntryCount += 1
      }
      reasoningByItemId.set(itemId, replyReasoning)
      this.reasoningCacheCharacterCount += reasoning.length
    }
    this.enforceReasoningCacheLimits()
  }

  private enforceReasoningCacheLimits(): void {
    const maxEntries = Math.max(
      1,
      Math.floor(this.options.reasoningCacheMaxEntries ?? DEFAULT_REASONING_CACHE_MAX_ENTRIES)
    )
    const maxCharacters = Math.max(
      1,
      Math.floor(this.options.reasoningCacheMaxCharacters ?? DEFAULT_REASONING_CACHE_MAX_CHARACTERS)
    )
    while (
      this.reasoningByPromptCacheKey.size > 0 &&
      (this.reasoningCacheEntryCount > maxEntries ||
        this.reasoningCacheCharacterCount > maxCharacters)
    ) {
      const oldestPromptCacheKey = this.reasoningByPromptCacheKey.keys().next().value
      if (typeof oldestPromptCacheKey !== 'string') break
      const oldest = this.reasoningByPromptCacheKey.get(oldestPromptCacheKey)
      this.reasoningByPromptCacheKey.delete(oldestPromptCacheKey)
      if (!oldest) continue
      for (const reasoning of oldest.values()) {
        this.reasoningCacheEntryCount -= 1
        this.reasoningCacheCharacterCount -= reasoning.text.length
      }
    }
  }
}
