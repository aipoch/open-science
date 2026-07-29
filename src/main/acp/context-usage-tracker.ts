import { countTokens as countAnthropicTokens } from '@anthropic-ai/tokenizer'
import type { ContentBlock, SessionNotification } from '@agentclientprotocol/sdk'
import { Tiktoken } from 'js-tiktoken/lite'
import cl100kBase from 'js-tiktoken/ranks/cl100k_base'
import o200kBase from 'js-tiktoken/ranks/o200k_base'

import type {
  AcpContextUsageBreakdown,
  AcpContextUsageCategory,
  AcpContextUsageCategoryKey
} from '../../shared/acp'
import type { AgentFrameworkId } from '../../shared/settings'
import { isNativeSkillToolUpdate } from './runtime-events'

type EstimatedCategoryKey = Exclude<AcpContextUsageCategoryKey, 'other'>
type TokenizerProfile = NonNullable<AcpContextUsageBreakdown['tokenizer']>

type TokenCounter = {
  count(text: string, profile: TokenizerProfile): number
}

type SessionEstimate = {
  profile: TokenizerProfile
  model?: string
  totals: Record<EstimatedCategoryKey, number>
  keyedSections: Map<string, { category: EstimatedCategoryKey; tokens: number }>
}

type SessionEstimateInput = {
  frameworkId: AgentFrameworkId
  model?: string
  persistentSystemPrompt?: readonly string[]
}

const ESTIMATED_CATEGORY_KEYS: EstimatedCategoryKey[] = [
  'system',
  'tools',
  'messages',
  'mcp',
  'skills'
]

const emptyTotals = (): Record<EstimatedCategoryKey, number> => ({
  system: 0,
  tools: 0,
  messages: 0,
  mcp: 0,
  skills: 0
})

let o200kTokenizer: Tiktoken | undefined
let cl100kTokenizer: Tiktoken | undefined

const tiktoken = (profile: Extract<TokenizerProfile, 'o200k_base' | 'cl100k_base'>): Tiktoken => {
  if (profile === 'o200k_base') {
    o200kTokenizer ??= new Tiktoken(o200kBase)
    return o200kTokenizer
  }

  cl100kTokenizer ??= new Tiktoken(cl100kBase)
  return cl100kTokenizer
}

const defaultTokenCounter: TokenCounter = {
  count(text, profile) {
    if (!text) return 0
    try {
      return profile === 'anthropic'
        ? countAnthropicTokens(text)
        : tiktoken(profile).encode(text).length
    } catch {
      // A malformed string or tokenizer regression must never block a prompt. UTF-8 bytes / 4 is only
      // a last-resort estimate and remains visible as estimated data reconciled against the Agent total.
      return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
    }
  }
}

const tokenizerProfileFor = (
  frameworkId: AgentFrameworkId,
  model: string | undefined
): TokenizerProfile => {
  const normalized = model?.trim().toLowerCase() ?? ''
  if (normalized.startsWith('claude') || frameworkId === 'claude-code') return 'anthropic'
  if (
    /^(gpt-5|gpt-4o|gpt-4\.1|o[134](?:-|$)|codex)/.test(normalized) ||
    (frameworkId === 'codex' && !normalized)
  ) {
    return 'o200k_base'
  }
  return 'cl100k_base'
}

const contentBlockText = (content: ContentBlock): string => {
  switch (content.type) {
    case 'text':
      return content.text
    case 'resource':
      return 'text' in content.resource ? content.resource.text : ''
    case 'resource_link':
      return [content.name, content.title, content.description, content.uri]
        .filter(Boolean)
        .join('\n')
    case 'image':
      return `[image:${content.mimeType}]`
    case 'audio':
      return `[audio:${content.mimeType}]`
    default:
      return ''
  }
}

const jsonText = (value: unknown): string => {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

type ToolUpdate = Extract<
  SessionNotification['update'],
  { sessionUpdate: 'tool_call' | 'tool_call_update' }
>

const toolContentText = (content: ToolUpdate['content']): string =>
  (content ?? [])
    .map((item) => (item.type === 'content' ? contentBlockText(item.content) : jsonText(item)))
    .filter(Boolean)
    .join('\n')

class ContextUsageTracker {
  private readonly sessions = new Map<string, SessionEstimate>()

  constructor(private readonly counter: TokenCounter = defaultTokenCounter) {}

  beginSession(sessionId: string, input: SessionEstimateInput): void {
    const profile = tokenizerProfileFor(input.frameworkId, input.model)
    const current = this.sessions.get(sessionId)
    if (current && current.profile === profile && current.model === input.model) return

    const state: SessionEstimate = {
      profile,
      ...(input.model ? { model: input.model } : {}),
      totals: emptyTotals(),
      keyedSections: new Map()
    }
    this.sessions.set(sessionId, state)
    this.replaceText(
      sessionId,
      'system:persistent',
      'system',
      (input.persistentSystemPrompt ?? []).join('\n\n')
    )
  }

  resetSession(sessionId: string, input: SessionEstimateInput): void {
    this.sessions.delete(sessionId)
    this.beginSession(sessionId, input)
  }

  appendText(sessionId: string, category: EstimatedCategoryKey, text: string): void {
    const state = this.sessions.get(sessionId)
    if (!state || !text) return
    state.totals[category] += this.counter.count(text, state.profile)
  }

  appendPromptContent(
    sessionId: string,
    content: string | ContentBlock[],
    excludedPrefix = ''
  ): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    const text = typeof content === 'string' ? content : content.map(contentBlockText).join('\n')
    const tokens = Math.max(
      0,
      this.counter.count(text, state.profile) - this.counter.count(excludedPrefix, state.profile)
    )
    state.totals.messages += tokens
  }

  replaceText(
    sessionId: string,
    sectionId: string,
    category: EstimatedCategoryKey,
    text: string
  ): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    const previous = state.keyedSections.get(sectionId)
    if (previous) state.totals[previous.category] -= previous.tokens
    const tokens = this.counter.count(text, state.profile)
    state.keyedSections.set(sectionId, { category, tokens })
    state.totals[category] += tokens
  }

  observeSessionUpdate(
    sessionId: string,
    notification: SessionNotification,
    toolCategory: Extract<EstimatedCategoryKey, 'tools' | 'mcp'> = 'tools'
  ): void {
    const update = notification.update
    if (update.sessionUpdate === 'agent_message_chunk') {
      this.appendText(sessionId, 'messages', contentBlockText(update.content))
      return
    }
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return

    const category: EstimatedCategoryKey = isNativeSkillToolUpdate(update) ? 'skills' : toolCategory
    const prefix = `tool:${update.toolCallId}`
    if (update.rawInput !== undefined) {
      this.replaceText(sessionId, `${prefix}:input`, category, jsonText(update.rawInput))
    }
    if (update.rawOutput !== undefined) {
      this.replaceText(sessionId, `${prefix}:output`, category, jsonText(update.rawOutput))
    }
    if (update.content !== undefined) {
      this.replaceText(sessionId, `${prefix}:content`, category, toolContentText(update.content))
    }
  }

  compare(
    sessionId: string,
    authoritativeTokens: number,
    status: AcpContextUsageBreakdown['status']
  ): AcpContextUsageBreakdown | undefined {
    const state = this.sessions.get(sessionId)
    if (!state) return undefined

    const localCategories: AcpContextUsageCategory[] = ESTIMATED_CATEGORY_KEYS.flatMap((key) => {
      const tokens = Math.max(0, Math.round(state.totals[key]))
      return tokens > 0 ? [{ key, tokens, estimated: true }] : []
    })
    const estimatedTokens = localCategories.reduce((sum, category) => sum + category.tokens, 0)
    const difference = Math.round(authoritativeTokens - estimatedTokens)
    const categories =
      difference > 0
        ? [...localCategories, { key: 'other' as const, tokens: difference, estimated: false }]
        : localCategories

    return {
      source: 'estimated',
      tokenizer: state.profile,
      ...(state.model ? { model: state.model } : {}),
      estimatedTokens,
      difference,
      status,
      categories
    }
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  clear(): void {
    this.sessions.clear()
  }
}

export { ContextUsageTracker, tokenizerProfileFor }
export type { EstimatedCategoryKey, SessionEstimateInput, TokenCounter }
