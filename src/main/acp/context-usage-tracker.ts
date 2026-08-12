import { getTokenizer as getAnthropicTokenizer } from '@anthropic-ai/tokenizer'
import type { ContentBlock, SessionNotification } from '@agentclientprotocol/sdk'
import { resolve } from 'node:path'
import { Tiktoken } from 'js-tiktoken/lite'
import cl100kBase from 'js-tiktoken/ranks/cl100k_base'
import o200kBase from 'js-tiktoken/ranks/o200k_base'

import type {
  AcpContextUsage,
  AcpContextUsageBreakdown,
  AcpContextUsageCategory,
  AcpContextUsageCategoryKey,
  AcpContextWindowSampleSource
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
  toolObservations: Map<string, SessionUpdateObservation>
  skillSectionsByToolOccurrence: Map<string, string>
  canonicalRawOutputSections: Set<string>
  promptSkillSectionIds: Set<string>
  promptSequence: number
  pendingAssistantText: string
  pendingAssistantTokens: number
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
  usage?: AcpContextUsage
  usageRevision: number
}

type SessionUpdateObservation = {
  toolCategory?: Extract<EstimatedCategoryKey, 'tools' | 'mcp' | 'skills'>
  skillFilePath?: string
}

const contextWindowTurnHandleKey = Symbol('context-window-turn-handle')

type ContextWindowTurnHandle = Readonly<{
  readonly [contextWindowTurnHandleKey]: symbol
  captureTerminal: (providerResponseObserved?: boolean) => ContextWindowTerminalCapture | undefined
  // Completion reports whether the transient preflight usage projection was restored, so the caller
  // can publish that one observable change. Other terminal operations are state-owner cleanup only.
  complete: () => boolean
  fail: () => void
  supersede: () => void
}>

type ContextWindowTerminalCapture = Readonly<{
  contextWindow: AcpContextUsage
  source: AcpContextWindowSampleSource
}>

type ContextUsageTurnOutcome =
  'completed' | 'rejected-before-provider-data' | 'partially-observed-failure' | 'superseded'

type ContextUsageTurn = {
  readonly sessionId: string
  readonly revision: number
  readonly checkpoint: SessionEstimateCheckpoint
  providerDataObserved: boolean
  providerUsageObserved: boolean
  outcome?: ContextUsageTurnOutcome
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
  keyedSections: new Map(state.keyedSections),
  toolObservations: new Map(state.toolObservations),
  skillSectionsByToolOccurrence: new Map(state.skillSectionsByToolOccurrence),
  canonicalRawOutputSections: new Set(state.canonicalRawOutputSections),
  promptSkillSectionIds: new Set(state.promptSkillSectionIds),
  promptSequence: state.promptSequence,
  pendingAssistantText: state.pendingAssistantText,
  pendingAssistantTokens: state.pendingAssistantTokens
})

// Tokenizers are stateless and intentionally shared across tracker/runtime instances; constructing
// their encoding tables per session would add avoidable startup and memory cost.
let o200kTokenizer: Tiktoken | undefined
let cl100kTokenizer: Tiktoken | undefined
// Anthropic documents its public tokenizer as a rough approximation for Claude 3+. Keep category
// values explicitly estimated and let the Agent-reported total remain authoritative.
let anthropicTokenizer: ReturnType<typeof getAnthropicTokenizer> | undefined

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
        ? (anthropicTokenizer ??= getAnthropicTokenizer()).encode(text.normalize('NFKC'), 'all')
            .length
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
  const normalized = model?.trim().toLowerCase().split('/').filter(Boolean).at(-1) ?? ''
  // The framework describes the ACP transport, not necessarily the upstream model. Claude Code can
  // drive DeepSeek/GLM/Kimi through an Anthropic-compatible endpoint, while Codex can bridge those
  // same models through Responses. Therefore an explicit model always wins; framework defaults are
  // only safe when the agent did not expose or receive a model id.
  if (normalized) {
    // Provider-qualified ids are not uniform: OpenRouter commonly uses a slash, Azure a colon, and
    // Bedrock a dotted vendor prefix. Match a supported family only at one of those boundaries so an
    // unrelated model containing the same word does not silently select the wrong encoding.
    if (/(?:^|[.:])claude(?:[-_.]|$)/.test(normalized)) return 'anthropic'
    if (
      /(?:^|[.:])(?:gpt-(?:4(?:[.o-]|$)|5(?:[.-]|$))|chatgpt-4o(?:-|$)|o[134](?:-|$)|codex(?:[-_.]|$))/.test(
        normalized
      )
    ) {
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
  private readonly usageBySession = new Map<string, AcpContextUsage>()
  private readonly usageRevisions = new Map<string, number>()
  private readonly activeTurnsBySession = new Map<string, ContextUsageTurn>()
  private nextTurnRevision = 0

  constructor(private readonly counter: TokenCounter = defaultTokenCounter) {}

  beginTurn(sessionId: string): ContextWindowTurnHandle {
    this.supersedeActiveTurn(sessionId)
    const turn: ContextUsageTurn = {
      sessionId,
      revision: ++this.nextTurnRevision,
      checkpoint: this.checkpointSession(sessionId),
      providerDataObserved: false,
      providerUsageObserved: false
    }
    this.activeTurnsBySession.set(sessionId, turn)
    return Object.freeze({
      [contextWindowTurnHandleKey]: Symbol(),
      captureTerminal: (providerResponseObserved = false) =>
        this.captureTerminal(turn, providerResponseObserved),
      complete: () => this.completeTurn(turn),
      fail: () => this.failTurn(turn),
      supersede: () => this.supersedeTurn(turn)
    })
  }

  private captureTerminal(
    turn: ContextUsageTurn,
    providerResponseObserved: boolean
  ): ContextWindowTerminalCapture | undefined {
    if (turn.outcome || this.activeTurnsBySession.get(turn.sessionId)?.revision !== turn.revision) {
      return undefined
    }
    const current = this.usageBySession.get(turn.sessionId)
    if (!current) return undefined

    if (providerResponseObserved || turn.providerUsageObserved) {
      return {
        contextWindow: this.cloneUsage(current),
        source: providerResponseObserved ? 'provider-response' : 'provider-update'
      }
    }

    if (current.breakdown?.status !== 'preflight') return undefined
    return {
      contextWindow: {
        used: current.breakdown.estimatedTokens,
        ...(current.size === undefined ? {} : { size: current.size }),
        breakdown: {
          ...current.breakdown,
          categories: current.breakdown.categories.map((category) => ({ ...category }))
        }
      },
      source: 'local-estimate'
    }
  }

  private completeTurn(turn: ContextUsageTurn): boolean {
    if (turn.outcome || this.activeTurnsBySession.get(turn.sessionId)?.revision !== turn.revision) {
      return false
    }
    turn.outcome = 'completed'
    this.activeTurnsBySession.delete(turn.sessionId)
    this.finalizeAssistantOutput(turn.sessionId)
    return this.restorePreflightUsage(turn.sessionId, turn.checkpoint)
  }

  private failTurn(turn: ContextUsageTurn): void {
    if (turn.outcome || this.activeTurnsBySession.get(turn.sessionId)?.revision !== turn.revision) {
      return
    }
    turn.outcome = turn.providerDataObserved
      ? 'partially-observed-failure'
      : 'rejected-before-provider-data'
    this.activeTurnsBySession.delete(turn.sessionId)
    if (turn.providerDataObserved) {
      this.finalizeAssistantOutput(turn.sessionId)
      this.restorePreflightUsage(turn.sessionId, turn.checkpoint)
    } else {
      this.restoreSession(turn.sessionId, turn.checkpoint)
    }
  }

  private observeActiveTurn(sessionId: string): void {
    const turn = this.activeTurnsBySession.get(sessionId)
    if (turn && !turn.outcome) turn.providerDataObserved = true
  }

  private supersedeTurn(turn: ContextUsageTurn): void {
    if (turn.outcome || this.activeTurnsBySession.get(turn.sessionId)?.revision !== turn.revision) {
      return
    }
    turn.outcome = 'superseded'
    this.activeTurnsBySession.delete(turn.sessionId)
  }

  private supersedeActiveTurn(sessionId: string): void {
    const turn = this.activeTurnsBySession.get(sessionId)
    if (turn) this.supersedeTurn(turn)
  }

  beginSession(sessionId: string, input: SessionEstimateInput): void {
    const profile = tokenizerProfileFor(input.frameworkId, input.model)
    const current = this.sessions.get(sessionId)
    // Static sections and the persistent system prompt are creation-scoped; reset the session to
    // apply replacements instead of treating this idempotent guard as a refresh.
    if (current && current.profile === profile && current.model === input.model) return

    const state: SessionEstimate = {
      profile,
      ...(input.model ? { model: input.model } : {}),
      totals: emptyTotals(),
      keyedSections: new Map(),
      toolObservations: new Map(),
      skillSectionsByToolOccurrence: new Map(),
      canonicalRawOutputSections: new Set(),
      promptSkillSectionIds: new Set(),
      promptSequence: 0,
      pendingAssistantText: '',
      pendingAssistantTokens: 0
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
    this.supersedeActiveTurn(sessionId)
    this.sessions.delete(sessionId)
    this.beginSession(sessionId, input)
  }

  checkpointSession(sessionId: string): SessionEstimateCheckpoint {
    // A public checkpoint belongs to a control turn such as compaction. It supersedes any prompt
    // handle first so delayed prompt cleanup cannot restore over the control turn or its successor.
    this.supersedeActiveTurn(sessionId)
    const state = this.sessions.get(sessionId)
    const usage = this.usageBySession.get(sessionId)
    return {
      ...(state ? { state: cloneSessionEstimate(state) } : {}),
      ...(usage ? { usage: this.cloneUsage(usage) } : {}),
      usageRevision: this.usageRevisions.get(sessionId) ?? 0
    }
  }

  restoreSession(sessionId: string, checkpoint: SessionEstimateCheckpoint): void {
    if (checkpoint.state) this.sessions.set(sessionId, cloneSessionEstimate(checkpoint.state))
    else this.sessions.delete(sessionId)
    if (checkpoint.usage) this.replaceUsage(sessionId, checkpoint.usage)
    else this.deleteUsage(sessionId)
  }

  usage(sessionId: string): AcpContextUsage | undefined {
    const usage = this.usageBySession.get(sessionId)
    return usage ? this.cloneUsage(usage) : undefined
  }

  hasUsage(): boolean {
    return this.usageBySession.size > 0
  }

  usageSnapshot(): Record<string, AcpContextUsage> {
    return Object.fromEntries(
      Array.from(this.usageBySession, ([sessionId, usage]) => [sessionId, this.cloneUsage(usage)])
    )
  }

  reconcileProviderUsage(
    sessionId: string,
    usage: AcpContextUsage,
    selectedContextWindow?: number
  ): void {
    this.observeActiveTurn(sessionId)
    const activeTurn = this.activeTurnsBySession.get(sessionId)
    if (activeTurn && !activeTurn.outcome) activeTurn.providerUsageObserved = true
    const breakdown = this.compare(sessionId, usage.used, 'reconciled')
    this.replaceUsage(sessionId, {
      ...usage,
      size: selectedContextWindow ?? usage.size,
      ...(breakdown ? { breakdown } : {})
    })
  }

  reconcileUsed(sessionId: string, used: number): boolean {
    const current = this.usageBySession.get(sessionId)
    if (!current || !Number.isSafeInteger(used)) return false
    this.observeActiveTurn(sessionId)
    const activeTurn = this.activeTurnsBySession.get(sessionId)
    if (activeTurn && !activeTurn.outcome) activeTurn.providerUsageObserved = true
    if (current.used === used && current.breakdown?.status === 'reconciled') return false

    this.replaceUsage(sessionId, {
      used,
      ...(current.size === undefined ? {} : { size: current.size }),
      breakdown: this.compare(sessionId, used, 'reconciled')
    })
    return true
  }

  refreshUsage(
    sessionId: string,
    status: AcpContextUsageBreakdown['status'],
    size?: number
  ): boolean {
    const current = this.usageBySession.get(sessionId)
    if (status === 'preflight') {
      const breakdown = this.estimate(sessionId)
      if (!breakdown) return false
      const agentUsed =
        current?.breakdown?.status === 'preflight' ? current.agentUsed : current?.used
      this.replaceUsage(sessionId, {
        used: agentUsed ?? breakdown.estimatedTokens,
        ...(agentUsed === undefined ? {} : { agentUsed }),
        ...(size === undefined ? {} : { size }),
        breakdown
      })
      return true
    }

    if (!current) return false
    const breakdown = this.compare(sessionId, current.used, status)
    if (!breakdown) return false
    this.replaceUsage(sessionId, { ...current, breakdown })
    return true
  }

  restorePreflightUsage(sessionId: string, checkpoint: SessionEstimateCheckpoint): boolean {
    if (this.usageBySession.get(sessionId)?.breakdown?.status !== 'preflight') return false

    if (checkpoint.usage && checkpoint.usage.breakdown?.status !== 'preflight') {
      this.replaceUsage(sessionId, checkpoint.usage)
    } else {
      this.deleteUsage(sessionId)
    }
    return true
  }

  resetAfterCompaction(
    sessionId: string,
    input: SessionEstimateInput,
    checkpoint: SessionEstimateCheckpoint,
    size?: number
  ): void {
    this.resetSession(sessionId, input)
    if ((this.usageRevisions.get(sessionId) ?? 0) === checkpoint.usageRevision) {
      this.deleteUsage(sessionId)
    } else {
      this.refreshUsage(sessionId, 'reconciled', size)
    }
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
    // Runtime calls this exactly once for each outbound user prompt; use that boundary to namespace
    // later tool events without exposing a second lifecycle method that callers could forget.
    state.promptSequence += 1

    const text = typeof content === 'string' ? content : content.map(contentBlockText).join('\n')
    const tokens = Math.max(
      0,
      this.counter.count(text, state.profile) - this.counter.count(excludedPrefix, state.profile)
    )
    state.totals.messages += tokens
  }

  // Completion text is not part of the current request's context. Keep streamed output aside and
  // promote it only when the next user turn makes that completed answer part of the model input.
  finalizeAssistantOutput(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state?.pendingAssistantText) return
    state.pendingAssistantTokens += this.counter.count(state.pendingAssistantText, state.profile)
    state.pendingAssistantText = ''
  }

  commitPendingAssistantOutput(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state) return
    this.finalizeAssistantOutput(sessionId)
    state.totals.messages += state.pendingAssistantTokens
    state.pendingAssistantTokens = 0
  }

  private recordSkillDocument(
    sessionId: string,
    toolOccurrence: string,
    path: string,
    text: string,
    canonical: boolean
  ): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    const promptSectionId = skillFileSectionId(path)
    const sectionId =
      state.skillSectionsByToolOccurrence.get(toolOccurrence) ??
      (state.promptSkillSectionIds.has(promptSectionId)
        ? promptSectionId
        : `tool:${toolOccurrence}:document`)
    state.skillSectionsByToolOccurrence.set(toolOccurrence, sectionId)
    if (!canonical && state.canonicalRawOutputSections.has(sectionId)) return
    if (canonical) state.canonicalRawOutputSections.add(sectionId)
    this.replaceText(sessionId, sectionId, 'skills', text)
    state.promptSkillSectionIds.delete(promptSectionId)
  }

  replacePromptSkillDocuments(
    sessionId: string,
    documents: ReadonlyArray<{ path: string; text: string }>
  ): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    for (const sectionId of state.promptSkillSectionIds) this.deleteSection(state, sectionId)
    state.promptSkillSectionIds.clear()
    for (const document of documents) {
      const sectionId = skillFileSectionId(document.path)
      // A prior explicit file read promoted this document into persistent conversation history.
      // Re-attaching the same Skill for one turn must not make that persistent section removable.
      if (state.keyedSections.has(sectionId)) continue
      this.replaceText(sessionId, sectionId, 'skills', document.text)
      state.promptSkillSectionIds.add(sectionId)
    }
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

  private deleteSection(state: SessionEstimate, sectionId: string): void {
    const previous = state.keyedSections.get(sectionId)
    if (!previous) return
    state.totals[previous.category] -= previous.tokens
    state.keyedSections.delete(sectionId)
  }

  observeSessionUpdate(
    sessionId: string,
    notification: SessionNotification,
    observation: SessionUpdateObservation = {}
  ): void {
    const update = notification.update
    if (
      update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      this.observeActiveTurn(sessionId)
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      const state = this.sessions.get(sessionId)
      if (state) state.pendingAssistantText += contentBlockText(update.content)
      return
    }
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    const state = this.sessions.get(sessionId)
    if (!state) return
    // ACP toolCallId values are opaque and may be reused by a later user turn. Namespace every
    // lifecycle with the local prompt sequence so incremental updates still replace one occurrence
    // without allowing a reused raw id to inherit metadata or overwrite older context history.
    const toolOccurrence = `${state.promptSequence}:${update.toolCallId}`
    if (observation.toolCategory || observation.skillFilePath) {
      state.toolObservations.set(toolOccurrence, observation)
    }
    const effectiveObservation = state.toolObservations.get(toolOccurrence) ?? observation
    // An assistant segment emitted before a tool call becomes input to the Agent's next internal
    // model request in this same user turn. Commit it at the observable tool boundary; the final
    // assistant segment remains buffered until the next user prompt.
    this.commitPendingAssistantOutput(sessionId)

    const nativeSkill = isNativeSkillToolUpdate(update)
    const skillLoad = nativeSkill || Boolean(effectiveObservation.skillFilePath)
    const skillLoadCompleted = skillLoad && update.status === 'completed'
    const skillLoadFailed = skillLoad && update.status === 'failed'
    const category: EstimatedCategoryKey = skillLoadFailed
      ? 'tools'
      : nativeSkill
        ? 'skills'
        : (effectiveObservation.toolCategory ?? 'tools')
    const budget: ToolTextBudget = {
      chars: MAX_TOOL_ESTIMATE_CHARS,
      nodes: MAX_TOOL_ESTIMATE_NODES
    }
    const prefix = `tool:${toolOccurrence}`
    if (update.rawInput !== undefined) {
      this.replaceText(
        sessionId,
        `${prefix}:input`,
        category,
        boundedJsonText(update.rawInput, budget)
      )
    }
    // Only a successful terminal update proves that the payload is a Skill document. Partial
    // payloads remain provisional, while failed payloads become ordinary tool output so neither can
    // replace an already loaded document with an error message. A later success replaces the
    // provisional output.
    const outputSectionId = `${prefix}:output`
    if (skillLoadCompleted) {
      this.deleteSection(state, outputSectionId)
      state.canonicalRawOutputSections.delete(outputSectionId)
    } else if (skillLoadFailed) {
      state.canonicalRawOutputSections.delete(outputSectionId)
    }
    if (effectiveObservation.skillFilePath && skillLoadCompleted) {
      if (update.rawOutput !== undefined) {
        this.recordSkillDocument(
          sessionId,
          toolOccurrence,
          effectiveObservation.skillFilePath,
          boundedJsonText(update.rawOutput, budget),
          true
        )
      } else if (update.content !== undefined) {
        this.recordSkillDocument(
          sessionId,
          toolOccurrence,
          effectiveObservation.skillFilePath,
          toolContentText(update.content, budget),
          false
        )
      }
      return
    }

    // Native Skill adapters may mirror the same instruction document in rawOutput and content. The
    // request input is distinct metadata, but the document itself must occupy one stable section.
    if (nativeSkill && skillLoadCompleted) {
      const sectionId = `${prefix}:document`
      if (update.rawOutput !== undefined) {
        state.canonicalRawOutputSections.add(sectionId)
        this.replaceText(sessionId, sectionId, category, boundedJsonText(update.rawOutput, budget))
      } else if (update.content !== undefined && !state.canonicalRawOutputSections.has(sectionId)) {
        this.replaceText(sessionId, sectionId, category, toolContentText(update.content, budget))
      }
      return
    }
    // ACP content is the displayable projection of the same result represented by rawOutput. Prefer
    // the raw model-side value across partial updates; content is only a fallback until raw appears.
    const sectionId = outputSectionId
    if (update.rawOutput !== undefined) {
      state.canonicalRawOutputSections.add(sectionId)
      this.replaceText(sessionId, sectionId, category, boundedJsonText(update.rawOutput, budget))
    } else if (update.content !== undefined && !state.canonicalRawOutputSections.has(sectionId)) {
      this.replaceText(sessionId, sectionId, category, toolContentText(update.content, budget))
    }
  }

  compare(
    sessionId: string,
    authoritativeTokens: number,
    status: AcpContextUsageBreakdown['status']
  ): AcpContextUsageBreakdown | undefined {
    const local = this.localBreakdown(sessionId)
    if (!local) return undefined

    const { state, categories: localCategories, estimatedTokens } = local
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

  estimate(sessionId: string): AcpContextUsageBreakdown | undefined {
    const local = this.localBreakdown(sessionId)
    if (!local) return undefined

    const { state, categories, estimatedTokens } = local
    return {
      source: 'estimated',
      tokenizer: state.profile,
      ...(state.model ? { model: state.model } : {}),
      estimatedTokens,
      difference: 0,
      status: 'preflight',
      categories
    }
  }

  private localBreakdown(sessionId: string):
    | {
        state: SessionEstimate
        categories: AcpContextUsageCategory[]
        estimatedTokens: number
      }
    | undefined {
    const state = this.sessions.get(sessionId)
    if (!state) return undefined

    const categories: AcpContextUsageCategory[] = ESTIMATED_CATEGORY_KEYS.flatMap((key) => {
      const tokens = Math.max(0, Math.round(state.totals[key]))
      return tokens > 0 ? [{ key, tokens, estimated: true }] : []
    })
    return {
      state,
      categories,
      estimatedTokens: categories.reduce((sum, category) => sum + category.tokens, 0)
    }
  }

  private cloneUsage(usage: AcpContextUsage): AcpContextUsage {
    return {
      ...usage,
      ...(usage.breakdown
        ? {
            breakdown: {
              ...usage.breakdown,
              categories: usage.breakdown.categories.map((category) => ({ ...category }))
            }
          }
        : {})
    }
  }

  private replaceUsage(sessionId: string, usage: AcpContextUsage): void {
    this.usageBySession.set(sessionId, this.cloneUsage(usage))
    this.usageRevisions.set(sessionId, (this.usageRevisions.get(sessionId) ?? 0) + 1)
  }

  private deleteUsage(sessionId: string): void {
    if (!this.usageBySession.delete(sessionId)) return
    this.usageRevisions.set(sessionId, (this.usageRevisions.get(sessionId) ?? 0) + 1)
  }

  deleteSession(sessionId: string): void {
    this.supersedeActiveTurn(sessionId)
    this.sessions.delete(sessionId)
    this.deleteUsage(sessionId)
    this.usageRevisions.delete(sessionId)
  }

  clear(): void {
    for (const turn of this.activeTurnsBySession.values()) turn.outcome = 'superseded'
    this.activeTurnsBySession.clear()
    this.sessions.clear()
    this.usageBySession.clear()
    this.usageRevisions.clear()
  }
}

export { ContextUsageTracker, MAX_TOOL_ESTIMATE_CHARS, tokenizerProfileFor }
export type {
  ContextWindowTerminalCapture,
  ContextWindowTurnHandle,
  EstimatedCategoryKey,
  SessionEstimateInput,
  SessionUpdateObservation,
  TokenCounter
}
