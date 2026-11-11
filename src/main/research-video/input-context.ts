import { getTokenizer } from '@anthropic-ai/tokenizer'
import { get_encoding, type Tiktoken } from 'tiktoken'
import type { ResearchVideoSessionSource } from '@aipoch/research-film'
import {
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  isXaiSubscriptionProvider,
  type ProviderView
} from '../../shared/settings'
import {
  DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW,
  resolveCustomModelContextWindow,
  resolveModelContextWindow
} from '../../shared/provider-model-policy'
import { tokenizerProfileFor } from '../acp/context-usage-tracker'
import type { ExplicitAgentBackendTarget } from '../settings/backend-target'

const omission = '\n[Source text omitted for model input budget.]\n'
const contextNote =
  'This is an excerpt of the frozen source. Original message indices and retained Artifact IDs are unchanged. Omitted text or messages are not evidence; do not infer their contents or invent quotations.'
const encodings = new Map<string, Tiktoken>()
let anthropic: ReturnType<typeof getTokenizer> | undefined

/** Chunk tokenization keeps long unbroken tool-like text from blocking the main process. */
export function researchFilmTokenCounter(
  target: Pick<ExplicitAgentBackendTarget, 'frameworkId' | 'model'>
): (text: string) => number {
  const profile = tokenizerProfileFor(
    target.frameworkId,
    target.model.kind === 'required' ? target.model.id : undefined
  )
  return (text) => {
    let total = 0
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 2048, text.length)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      const chunk = text.slice(start, end)
      if (profile === 'anthropic') {
        anthropic ??= getTokenizer()
        total += anthropic.encode(chunk.normalize('NFKC'), 'all').length
      } else {
        let encoding = encodings.get(profile)
        if (!encoding) {
          encoding = get_encoding(profile)
          encodings.set(profile, encoding)
        }
        total += encoding.encode(chunk, [], []).length
      }
      start = end
    }
    return total
  }
}

/** Use the captured provider/model's limits; estimates leave room for adapter framing and output. */
export function researchFilmInputBudget(provider: ProviderView, model?: string): number {
  const vendor =
    provider.vendorId ??
    (isClaudeSubscriptionProvider(provider.type)
      ? 'anthropic'
      : isCodexSubscriptionProvider(provider.type)
        ? 'openai'
        : isXaiSubscriptionProvider(provider.type)
          ? 'xai'
          : undefined)
  const context =
    provider.type === 'custom'
      ? resolveCustomModelContextWindow(provider.contextWindow)
      : isClaudeSubscriptionProvider(provider.type) && /\[1m\]$/i.test(model ?? '')
        ? 1_000_000
        : (vendor && resolveModelContextWindow(vendor, model)) ||
          DEFAULT_CUSTOM_MODEL_CONTEXT_WINDOW
  const available = Math.min(
    provider.maxInputTokens ?? context,
    context - (provider.maxOutputTokens ?? 8192)
  )
  // Provider tokenizers and adapter-added messages differ. This is a preparation estimate, not a
  // claim to exactly predict provider token accounting.
  return Math.max(0, Math.floor(available * 0.85) - 2048)
}

function excerpt(
  text: string,
  budget: number,
  count: (text: string) => number,
  retainFiles = false
): string {
  const cost = count(text)
  if (cost <= budget) return text
  // Staged Artifact links remain atomic even when they occurred in an omitted middle section.
  const links = retainFiles ? [...new Set(text.match(/!?\[[^\]]*\]\(files\/[^)\s]+\)/g) ?? [])] : []
  const marker = omission + (links.length ? links.join('\n') + '\n' : '')
  let length = Math.floor((text.length * Math.max(0, budget - count(marker))) / cost / 2)
  while (length > 0) {
    const candidate =
      text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '') +
      marker +
      text.slice(-length).replace(/^[\uDC00-\uDFFF]/, '')
    if (count(candidate) <= budget) return candidate
    length = Math.floor(length * 0.8)
  }
  return marker.trim()
}

/** Only the request projection is shortened. The frozen source and citation identities are intact. */
export function prepareResearchFilmPrompt(
  payload: unknown,
  systemPrompt: string,
  inputBudget: number,
  count: (text: string) => number
): string {
  const serialized = JSON.stringify(payload)
  const budget = inputBudget - count(systemPrompt)
  if (count(serialized) <= budget) return serialized
  const envelope = payload as {
    source?: ResearchVideoSessionSource
    correction?: { draft: string; error: string }
  }
  const source = envelope.source ?? (payload as ResearchVideoSessionSource)
  const wrapper = envelope.source
    ? {
        ...envelope,
        ...(envelope.correction
          ? {
              correction: {
                ...envelope.correction,
                draft: excerpt(
                  envelope.correction.draft,
                  Math.max(64, Math.floor(budget / 8)),
                  count
                )
              }
            }
          : {})
      }
    : undefined
  const format = (messages: typeof source.messages): string => {
    const projected = { ...source, messages, contextNote }
    return JSON.stringify(wrapper ? { ...wrapper, source: projected } : projected)
  }
  let remaining = budget - count(format([]))
  const firstQuestion = source.messages.find((message) => message.role === 'user')
  const latestQuestion = source.messages.findLast((message) => message.role === 'user')
  const latestAnswer = source.messages.findLast((message) => message.role !== 'user')
  const priority = [
    ...new Set(
      [
        firstQuestion,
        latestQuestion,
        latestAnswer,
        ...source.messages.filter((message) => message.artifactIds.length > 0).reverse(),
        ...source.messages.toReversed()
      ].filter((message) => message !== undefined)
    )
  ]
  const selected = new Map<number, (typeof source.messages)[number]>()
  // Give priority evidence a readable excerpt before spending the remainder on full messages.
  for (const message of priority) {
    const candidate = { ...message, md: excerpt(message.md, 256, count, true) }
    const cost = count(JSON.stringify(candidate)) + 2
    if (cost > remaining) continue
    selected.set(message.i, candidate)
    remaining -= cost
  }
  for (const message of priority) {
    const candidate = selected.get(message.i)
    if (!candidate || remaining <= 0) continue
    const md = excerpt(message.md, count(candidate.md) + remaining, count, true)
    const cost = count(JSON.stringify({ ...candidate, md })) - count(JSON.stringify(candidate))
    if (cost > remaining) continue
    selected.set(message.i, { ...candidate, md })
    remaining -= Math.max(0, cost)
  }
  const messages = source.messages
    .filter((message) => selected.has(message.i))
    .map((message) => selected.get(message.i)!)
  // Framing is counted separately during selection; verify the actual final JSON as well.
  while (messages.length && count(format(messages)) > budget) {
    const leastImportant = priority.findLast((message) =>
      messages.some((entry) => entry.i === message.i)
    )!
    messages.splice(
      messages.findIndex((message) => message.i === leastImportant.i),
      1
    )
  }
  if (!messages.length)
    throw new Error(
      'The selected model input limit cannot fit the research film instructions. Select a model with a larger input limit.'
    )
  return format(messages)
}
