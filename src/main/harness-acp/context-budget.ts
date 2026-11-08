import { createHash } from 'node:crypto'
import type { AgentMessage, ModelRequest, ModelUsage } from '@aipoch/agent-harness'

// Built-in Agent context accounting. The provider's reported input tokens are the authority; this
// meter only predicts the next request before dispatch:
// - after a reported request, reuse its exact token count for the unchanged prefix and estimate only
//   the appended messages, conservatively (DELTA_SAFETY);
// - otherwise estimate the whole request from the session's observed bytes-per-token ratio;
// - a provider context-overflow rejection lowers that ratio so the retried request compacts.

type Snapshot = { fixed: string; hashes: string[]; bytes: number[] }
type Anchor = Snapshot & { tokens: number }

// UTF-8 bytes per token before any provider report. English/JSON prompts measure ~4.9 (cl100k);
// CJK text measures lower, so the first report replaces this value.
const DEFAULT_BYTES_PER_TOKEN = 4
// A report outside this range is not a whole-request count (e.g. an adapter omitting cached input);
// it cannot calibrate the estimate.
const MIN_BYTES_PER_TOKEN = 1
const MAX_BYTES_PER_TOKEN = 8
// Appended content is estimated with a 25% smaller ratio, i.e. a larger token count.
const DELTA_SAFETY = 0.8
const ENVELOPE_TOKENS = 64

const hash = (text: string): string => createHash('sha256').update(text).digest('base64')

const snapshot = (request: Pick<ModelRequest, 'instructions' | 'tools' | 'messages'>): Snapshot => {
  const texts = request.messages.map((message) => JSON.stringify(message))
  return {
    fixed: hash(JSON.stringify([request.instructions, request.tools])),
    hashes: texts.map(hash),
    bytes: texts.map((text) => Buffer.byteLength(text, 'utf8'))
  }
}

const fixedBytes = (request: Pick<ModelRequest, 'instructions' | 'tools'>): number =>
  Buffer.byteLength(JSON.stringify([request.instructions, request.tools]), 'utf8')

export type ContextMeter = {
  /** Estimated input tokens for a complete request. */
  measure(request: ModelRequest): number
  /** Estimated input tokens for messages with the last admitted instructions and tools. */
  measureMessages(messages: AgentMessage[]): number | undefined
  /** Records a main request immediately before dispatch. */
  admitted(request: ModelRequest): void
  /** Applies the provider's report for an admitted request. */
  reported(requestId: string, usage: ModelUsage): void
  /** The provider rejected the last admitted request as too large for its context window. */
  overflowed(contextWindow: number): void
  /** Estimated tokens for one message, using the current ratio. */
  messageTokens(message: AgentMessage): number
}

export function createContextMeter(): ContextMeter {
  let ratio = DEFAULT_BYTES_PER_TOKEN
  let anchor: Anchor | undefined
  let last: ModelRequest | undefined
  const pending = new Map<string, { snapshot: Snapshot; bytes: number }>()
  const total = (request: ModelRequest, current: Snapshot): number =>
    fixedBytes(request) + current.bytes.reduce((sum, bytes) => sum + bytes, 0)
  const measure = (request: ModelRequest): number => {
    const current = snapshot(request)
    const prefix =
      anchor &&
      anchor.fixed === current.fixed &&
      anchor.hashes.length <= current.hashes.length &&
      anchor.hashes.every((value, index) => current.hashes[index] === value)
    if (prefix) {
      const appended = current.bytes
        .slice(anchor!.hashes.length)
        .reduce((sum, bytes) => sum + bytes, 0)
      return anchor!.tokens + Math.ceil(appended / (ratio * DELTA_SAFETY))
    }
    return Math.ceil(total(request, current) / ratio) + ENVELOPE_TOKENS
  }
  return {
    measure,
    measureMessages: (messages) => (last ? measure({ ...last, messages }) : undefined),
    admitted(request) {
      const current = snapshot(request)
      last = request
      pending.set(request.requestId, { snapshot: current, bytes: total(request, current) })
    },
    reported(requestId, usage) {
      const entry = pending.get(requestId)
      pending.clear()
      if (!entry || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 1) return
      const observed = entry.bytes / usage.inputTokens
      if (observed < MIN_BYTES_PER_TOKEN || observed > MAX_BYTES_PER_TOKEN) return
      ratio = observed
      anchor = { ...entry.snapshot, tokens: usage.inputTokens }
    },
    overflowed(contextWindow) {
      const rejected = [...pending.values()].at(-1)
      pending.clear()
      anchor = undefined
      // The rejected request needed more than contextWindow tokens. Price it just above the window:
      // the retry must compact, and compacting it by the 10% safety margin can fit again.
      if (rejected)
        ratio = Math.max(
          MIN_BYTES_PER_TOKEN,
          Math.min(ratio, rejected.bytes / (contextWindow + 1 - ENVELOPE_TOKENS))
        )
    },
    messageTokens(message) {
      return Math.ceil(Buffer.byteLength(JSON.stringify(message), 'utf8') / ratio)
    }
  }
}

// Old tool results are the bulk of a long session. Above SOFT of the input budget, replace the
// model-facing content of older large results with a reference to the stored original until the
// estimate is below TARGET. Stored history is unchanged; read_tool_result returns the original.
const SOFT = 0.5
const TARGET = 0.4
const KEEP_RECENT_RESULTS = 6
const MIN_CLEARED_TOKENS = 500

export type ToolResultClearing = {
  project(messages: readonly AgentMessage[]): AgentMessage[]
}

const cleared = (message: AgentMessage): AgentMessage => {
  const text = message.content.reduce(
    (sum, block) => sum + (block.type === 'text' ? block.text.length : 0),
    0
  )
  const media = message.content.filter((block) => block.type !== 'text').length
  const original = { ...message }
  // The stored preview, if any, describes the original result, not this reference.
  delete original.modelContent
  return {
    ...original,
    content: [
      {
        type: 'text',
        text: `[Earlier tool result cleared to save context (${text} characters${media ? `, ${media} media blocks` : ''}). If it is needed again, call read_tool_result with invocationId=${JSON.stringify(message.invocationId)}; do not repeat the original tool.]`
      }
    ]
  }
}

export function createToolResultClearing(
  inputBudget: number,
  meter: ContextMeter
): ToolResultClearing {
  // Sticky: once cleared, a result stays cleared, so the projected prefix only changes per batch.
  const ids = new Set<string>()
  return {
    project(messages) {
      const view = messages.map((message) =>
        message.role === 'tool' && message.invocationId && ids.has(message.invocationId)
          ? cleared(message)
          : message
      )
      let tokens = meter.measureMessages(view)
      if (tokens === undefined || tokens <= inputBudget * SOFT) return view
      const results = view.flatMap((message, index) =>
        message.role === 'tool' && message.invocationId ? [index] : []
      )
      for (const index of results.slice(0, -KEEP_RECENT_RESULTS)) {
        if (tokens <= inputBudget * TARGET) break
        const message = view[index]
        if (ids.has(message.invocationId!)) continue
        const replacement = cleared(message)
        const saved = meter.messageTokens(message) - meter.messageTokens(replacement)
        if (saved < MIN_CLEARED_TOKENS) continue
        ids.add(message.invocationId!)
        view[index] = replacement
        tokens -= saved
      }
      return view
    }
  }
}
