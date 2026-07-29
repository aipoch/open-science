import { countTokens as countAnthropicTokens } from '@anthropic-ai/tokenizer'
import type { ContentBlock, SessionNotification } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'
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
  persistentSections?: ReadonlyArray<{
    sectionId: string
    category: EstimatedCategoryKey
    text: string
  }>
}

type SessionEstimateCheckpoint = {
  state?: SessionEstimate
}

type SessionUpdateObservation = {
  toolCategory?: Extract<EstimatedCategoryKey, 'tools' | 'mcp' | 'skills'>
  skillFilePath?: string
}

const ESTIMATED_CATEGORY_KEYS: EstimatedCategoryKey[] = [
  'system',
  'tools',
  'messages',
  'mcp',
  'skills'
]

const MAX_TOOL_ESTIMATE_CHARS = 64 * 1024
const MAX_TOOL_ESTIMATE_NODES = 2_048

const emptyTotals = (): Record<EstimatedCategoryKey, number> => ({
  system: 0,
  tools: 0,
  messages: 0,
  mcp: 0,
  skills: 0
})

const cloneSessionEstimate = (state: SessionEstimate): SessionEstimate => ({
  profile: state.profile,
  ...(state.model ? { model: state.model } : {}),
  totals: { ...state.totals },
  keyedSections: new Map(state.keyedSections)
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
  const normalized = model?.trim().toLowerCase().split('/').pop() ?? ''
  // The framework describes the ACP transport, not necessarily the upstream model. Claude Code can
  // drive DeepSeek/GLM/Kimi through an Anthropic-compatible endpoint, while Codex can bridge those
  // same models through Responses. Therefore an explicit model always wins; framework defaults are
  // only safe when the agent did not expose or receive a model id.
  if (normalized) {
    if (normalized.startsWith('claude')) return 'anthropic'
    if (/^(gpt-5|gpt-4o|gpt-4\.1|o[134](?:-|$)|codex)/.test(normalized)) {
      return 'o200k_base'
    }
    return 'cl100k_base'
  }

  if (frameworkId === 'claude-code') return 'anthropic'
  if (frameworkId === 'codex') return 'o200k_base'
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

type ToolTextBudget = {
  chars: number
  nodes: number
}

const appendWithinBudget = (parts: string[], budget: ToolTextBudget, text: string): void => {
  if (budget.chars <= 0 || !text) return
  const retained = text.slice(0, budget.chars)
  parts.push(retained)
  budget.chars -= retained.length
}

const boundedJsonText = (value: unknown, budget: ToolTextBudget): string => {
  if (typeof value === 'string') {
    const parts: string[] = []
    appendWithinBudget(parts, budget, value)
    return parts.join('')
  }

  const parts: string[] = []
  const seen = new WeakSet<object>()
  const visit = (candidate: unknown, depth: number): void => {
    if (budget.chars <= 0 || budget.nodes <= 0) return
    budget.nodes -= 1

    if (candidate === null) {
      appendWithinBudget(parts, budget, 'null')
      return
    }
    if (typeof candidate === 'string') {
      appendWithinBudget(parts, budget, JSON.stringify(candidate.slice(0, budget.chars)) ?? '""')
      return
    }
    if (typeof candidate !== 'object') {
      appendWithinBudget(parts, budget, String(candidate))
      return
    }
    if (seen.has(candidate)) {
      appendWithinBudget(parts, budget, '"[Circular]"')
      return
    }
    if (depth >= 8) {
      appendWithinBudget(parts, budget, '"[Max depth]"')
      return
    }

    seen.add(candidate)
    if (Array.isArray(candidate)) {
      appendWithinBudget(parts, budget, '[')
      const length = Math.min(candidate.length, budget.nodes)
      for (let index = 0; index < length && budget.chars > 0; index += 1) {
        if (index > 0) appendWithinBudget(parts, budget, ',')
        visit(candidate[index], depth + 1)
        if (budget.nodes <= 0) break
      }
      appendWithinBudget(parts, budget, ']')
      return
    }

    appendWithinBudget(parts, budget, '{')
    let entryCount = 0
    try {
      for (const key in candidate) {
        if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue
        if (entryCount > 0) appendWithinBudget(parts, budget, ',')
        appendWithinBudget(parts, budget, JSON.stringify(key.slice(0, budget.chars)) ?? '""')
        appendWithinBudget(parts, budget, ':')
        try {
          visit((candidate as Record<string, unknown>)[key], depth + 1)
        } catch {
          appendWithinBudget(parts, budget, '"[Unreadable]"')
        }
        entryCount += 1
        if (budget.chars <= 0 || budget.nodes <= 0) break
      }
    } catch {
      appendWithinBudget(parts, budget, '"[Unserializable]"')
    }
    appendWithinBudget(parts, budget, '}')
  }

  visit(value, 0)
  return parts.join('')
}

const skillFileSectionId = (path: string): string => `skill-file:${resolve(path)}`

type ToolUpdate = Extract<
  SessionNotification['update'],
  { sessionUpdate: 'tool_call' | 'tool_call_update' }
>

const appendToolContentBlock = (
  parts: string[],
  budget: ToolTextBudget,
  content: ContentBlock
): void => {
  switch (content.type) {
    case 'text':
      appendWithinBudget(parts, budget, content.text)
      return
    case 'resource':
      if ('text' in content.resource) appendWithinBudget(parts, budget, content.resource.text)
      return
    case 'resource_link': {
      let fieldCount = 0
      for (const value of [content.name, content.title, content.description, content.uri]) {
        if (!value || budget.chars <= 0) continue
        if (fieldCount > 0) appendWithinBudget(parts, budget, '\n')
        appendWithinBudget(parts, budget, value)
        fieldCount += 1
      }
      return
    }
    case 'image':
      appendWithinBudget(parts, budget, `[image:${content.mimeType}]`)
      return
    case 'audio':
      appendWithinBudget(parts, budget, `[audio:${content.mimeType}]`)
      return
    default:
      return
  }
}

const toolContentText = (content: ToolUpdate['content'], budget: ToolTextBudget): string => {
  const parts: string[] = []
  for (const item of content ?? []) {
    if (budget.chars <= 0 || budget.nodes <= 0) break
    if (parts.length > 0) appendWithinBudget(parts, budget, '\n')
    if (item.type === 'content') {
      budget.nodes -= 1
      appendToolContentBlock(parts, budget, item.content)
    } else {
      const serialized = boundedJsonText(item, budget)
      if (serialized) parts.push(serialized)
    }
  }
  return parts.join('')
}

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
    for (const section of input.persistentSections ?? []) {
      this.replaceText(sessionId, `persistent:${section.sectionId}`, section.category, section.text)
    }
  }

  resetSession(sessionId: string, input: SessionEstimateInput): void {
    this.sessions.delete(sessionId)
    this.beginSession(sessionId, input)
  }

  checkpointSession(sessionId: string): SessionEstimateCheckpoint {
    const state = this.sessions.get(sessionId)
    return state ? { state: cloneSessionEstimate(state) } : {}
  }

  restoreSession(sessionId: string, checkpoint: SessionEstimateCheckpoint): void {
    if (checkpoint.state) this.sessions.set(sessionId, cloneSessionEstimate(checkpoint.state))
    else this.sessions.delete(sessionId)
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

  recordSkillDocument(sessionId: string, path: string, text: string): void {
    this.replaceText(sessionId, skillFileSectionId(path), 'skills', text)
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
    observation: SessionUpdateObservation = {}
  ): void {
    const update = notification.update
    if (update.sessionUpdate === 'agent_message_chunk') {
      this.appendText(sessionId, 'messages', contentBlockText(update.content))
      return
    }
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return

    const category: EstimatedCategoryKey = isNativeSkillToolUpdate(update)
      ? 'skills'
      : (observation.toolCategory ?? 'tools')
    const budget: ToolTextBudget = {
      chars: MAX_TOOL_ESTIMATE_CHARS,
      nodes: MAX_TOOL_ESTIMATE_NODES
    }
    if (observation.skillFilePath) {
      const output =
        update.content !== undefined
          ? toolContentText(update.content, budget)
          : update.rawOutput !== undefined
            ? boundedJsonText(update.rawOutput, budget)
            : ''
      if (output) {
        this.replaceText(sessionId, skillFileSectionId(observation.skillFilePath), 'skills', output)
      }
      return
    }

    const prefix = `tool:${update.toolCallId}`
    if (update.rawInput !== undefined) {
      this.replaceText(
        sessionId,
        `${prefix}:input`,
        category,
        boundedJsonText(update.rawInput, budget)
      )
    }
    if (update.rawOutput !== undefined) {
      this.replaceText(
        sessionId,
        `${prefix}:output`,
        category,
        boundedJsonText(update.rawOutput, budget)
      )
    }
    if (update.content !== undefined) {
      this.replaceText(
        sessionId,
        `${prefix}:content`,
        category,
        toolContentText(update.content, budget)
      )
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

export { ContextUsageTracker, MAX_TOOL_ESTIMATE_CHARS, tokenizerProfileFor }
export type { EstimatedCategoryKey, SessionEstimateInput, SessionUpdateObservation, TokenCounter }
