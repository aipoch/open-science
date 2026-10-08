import {
  providerErrorDetails,
  providerHttpFailure,
  type ProviderTextGenerationFailure
} from '../../shared/provider-text-generation-failure'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { customProviderRequiresKey } from '../../shared/provider-base-url'
import { fetchProviderRequest } from './provider-fetch'
import { netFetchStandard } from '../skills/net-fetch'
import type { ResolvedProvider } from './provider-env'
import { anthropicMessagesUrl, openAiChatCompletionsUrl, openAiResponsesUrl } from './base-url'
import type { ResolvedReasoningEffort } from '../../shared/reasoning-effort'
import { resolveChatReasoningTransport } from './reasoning-transport'
import { readBoundedResponseText, ResponseBodyLimitError } from './bounded-response'
import { normalizeOpenAiChatModelStepUsage } from './openai-chat-usage'
import { sanitizeAcpTurnTokenUsage, type AcpTurnTokenUsage } from '../../shared/acp'
import { isRecord } from '../value-guards'

export type ProviderTextGenerationTarget = Readonly<{
  providerId: string
  model?: string
  reasoningEffort?: ResolvedReasoningEffort
  provider: ResolvedProvider
}>

export type ProviderTextGenerationRequest = Readonly<{
  target: ProviderTextGenerationTarget
  systemPrompt: string
  prompt: string
  signal: AbortSignal
  maxOutputTokens: number
  outputLimitBytes: number
  onUsage?: (usage: AcpTurnTokenUsage) => void
}>

const textBlock = z.object({ type: z.literal('text'), text: z.string() })
const tokenCount = z.number().int().nonnegative().safe()
const anthropicUsage = z.object({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_read_input_tokens: tokenCount.default(0),
  cache_creation_input_tokens: tokenCount.default(0)
})
const chatResponse = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('stop'),
        message: z.object({
          content: z.union([z.string(), z.array(textBlock)]),
          function_call: z.null().optional(),
          tool_calls: z.array(z.unknown()).max(0).optional(),
          refusal: z.null().optional()
        })
      })
    )
    .length(1)
})
const anthropicResponse = z.object({
  stop_reason: z.literal('end_turn'),
  content: z.array(
    z.union([
      textBlock,
      z.object({ type: z.literal('thinking'), thinking: z.string() }),
      z.object({ type: z.literal('redacted_thinking'), data: z.string() })
    ])
  )
})

const responsesResponse = z.object({
  status: z.literal('completed'),
  error: z.null().optional(),
  incomplete_details: z.null().optional(),
  output: z.array(
    z.union([
      z.object({ type: z.literal('reasoning') }),
      z.object({
        type: z.literal('message'),
        role: z.literal('assistant'),
        status: z.literal('completed'),
        phase: z.enum(['final_answer', 'commentary']).nullish(),
        content: z.array(z.object({ type: z.literal('output_text'), text: z.string() }))
      })
    ])
  )
})

export class ProviderTextGenerationError extends Error {
  constructor(
    readonly code:
      | 'unsupported-target'
      | 'invalid-request'
      | 'http-error'
      | 'network-error'
      | 'incomplete-output',
    message: string,
    readonly status?: number,
    readonly failure: ProviderTextGenerationFailure | undefined = code === 'http-error' &&
    status !== undefined
      ? providerHttpFailure(status)
      : undefined
  ) {
    super(
      `[provider-text-generation:${code}]${failure ? ` [provider-failure:${failure.kind}:${failure.status ?? 0}]` : ''} ${message}`
    )
  }
}

/** Stable non-secret identity for resuming work with the same provider configuration. */
export function providerTextGenerationTargetKey(target: ProviderTextGenerationTarget): string {
  // Preserve existing persisted keys, including omitted/default reasoning equivalence.
  const identity = [
    'api',
    target.providerId,
    target.model,
    target.provider.apiEndpoints,
    target.provider.baseUrl,
    target.provider.openaiBaseUrl,
    ...(target.reasoningEffort && target.reasoningEffort !== 'default'
      ? [target.reasoningEffort, target.provider.vendorId, target.provider.reasoningEffortTransport]
      : [])
  ]
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** A bounded, tool-less text generation service shared by domain workflows. */
export class ProviderTextGenerationService {
  constructor(private readonly fetchImpl: typeof fetch = netFetchStandard) {}

  supportsTarget(target: ProviderTextGenerationTarget): boolean {
    const provider = target.provider
    const hasKey = typeof provider.key === 'string' && provider.key.length > 0
    const hasModel = typeof target.model === 'string' && target.model.length > 0
    const hasOpenAi =
      provider.apiEndpoints?.includes('openai') && openAiChatCompletionsUrl(provider)
    const hasResponses =
      provider.apiEndpoints?.includes('responses') && openAiResponsesUrl(provider)
    const hasAnthropic = provider.apiEndpoints?.includes('anthropic') && provider.baseUrl
    return (
      (provider.type === 'custom' || provider.type === 'official') &&
      (hasKey || (provider.type === 'custom' && !customProviderRequiresKey(provider.baseUrl))) &&
      hasModel &&
      Boolean(hasOpenAi || hasAnthropic || hasResponses)
    )
  }

  async run(input: ProviderTextGenerationRequest): Promise<{
    text: string
    stopReason: 'end_turn'
  }> {
    input.signal.throwIfAborted()
    if (!this.supportsTarget(input.target))
      throw new ProviderTextGenerationError('unsupported-target', 'Text generation is unavailable.')
    const provider = input.target.provider
    if (
      !Number.isSafeInteger(input.maxOutputTokens) ||
      input.maxOutputTokens <= 0 ||
      !Number.isSafeInteger(input.outputLimitBytes) ||
      input.outputLimitBytes <= 0 ||
      (provider.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(provider.maxOutputTokens) || provider.maxOutputTokens <= 0))
    )
      throw new ProviderTextGenerationError('invalid-request', 'Invalid text generation limits.')
    const apiType: 'openai' | 'anthropic' | 'responses' =
      provider.apiEndpoints?.includes('openai') && openAiChatCompletionsUrl(provider)
        ? 'openai'
        : provider.apiEndpoints?.includes('anthropic') && provider.baseUrl
          ? 'anthropic'
          : 'responses'
    const url =
      apiType === 'openai'
        ? openAiChatCompletionsUrl(provider)!
        : apiType === 'responses'
          ? openAiResponsesUrl(provider)!
          : anthropicMessagesUrl(provider.baseUrl!)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(apiType !== 'anthropic'
        ? provider.key
          ? { authorization: `Bearer ${provider.key}` }
          : {}
        : {
            ...(provider.key ? { 'x-api-key': provider.key } : {}),
            'anthropic-version': '2023-06-01'
          })
    }
    const effort = input.target.reasoningEffort
    const explicitEffort = effort && effort !== 'default' ? effort : undefined
    const reasoning = explicitEffort
      ? resolveChatReasoningTransport(
          provider.vendorId,
          input.target.model,
          explicitEffort,
          provider.reasoningEffortTransport
        )
      : undefined
    // Known Claude models that allow disabling thinking. Unknown / always-on models keep
    // their declared lowest effort instead of receiving an unsupported disable request.
    const disableClaudeThinking =
      provider.vendorId === 'anthropic' &&
      /^claude-(?:opus-(?:4-[5-8]|5)|sonnet-(?:4-[5-6]|5))(?:\[1m\]|-\d{8})?$/.test(
        input.target.model ?? ''
      )
    const maxTokens = Math.min(
      provider.maxOutputTokens ?? input.maxOutputTokens,
      input.maxOutputTokens
    )
    const body =
      apiType === 'responses'
        ? {
            model: input.target.model,
            instructions: input.systemPrompt,
            input: [{ role: 'user', content: input.prompt }],
            max_output_tokens: maxTokens,
            stream: false,
            store: false,
            ...(explicitEffort ? { reasoning: { effort: explicitEffort } } : {})
          }
        : apiType === 'openai'
          ? {
              model: input.target.model,
              messages: [
                { role: 'system', content: input.systemPrompt },
                { role: 'user', content: input.prompt }
              ],
              // Reasoning-capable OpenAI-shaped models use the limit that includes thinking tokens.
              ...(provider.vendorId === 'openai' ||
              (!provider.vendorId &&
                (!provider.reasoningEffortTransport ||
                  provider.reasoningEffortTransport === 'reasoning-effort') &&
                reasoning?.reasoningEffort)
                ? { max_completion_tokens: maxTokens }
                : { max_tokens: maxTokens }),
              ...(reasoning?.reasoningEffort
                ? { reasoning_effort: reasoning.reasoningEffort }
                : {}),
              ...(reasoning?.thinking ? { thinking: reasoning.thinking } : {}),
              ...(reasoning?.reasoning ? { reasoning: reasoning.reasoning } : {}),
              stream: false
            }
          : {
              model: input.target.model,
              max_tokens: maxTokens,
              system: input.systemPrompt,
              messages: [{ role: 'user', content: input.prompt }],
              ...(explicitEffort === 'none' || (explicitEffort === 'low' && disableClaudeThinking)
                ? { thinking: { type: 'disabled' } }
                : explicitEffort
                  ? provider.vendorId === 'minimax' ||
                    provider.reasoningEffortTransport === 'minimax'
                    ? { thinking: { type: 'adaptive' } }
                    : { output_config: { effort: explicitEffort } }
                  : {})
            }
    let response: Response
    let raw: string
    try {
      response = await fetchProviderRequest(this.fetchImpl, url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: input.signal
      })
      raw = await readBoundedResponseText(
        response,
        input.outputLimitBytes,
        'Provider text response'
      )
    } catch (error) {
      input.signal.throwIfAborted()
      if (error instanceof ResponseBodyLimitError) throw error
      throw new ProviderTextGenerationError(
        'network-error',
        providerErrorDetails(error, [provider.key ?? '']),
        undefined,
        { kind: 'network' }
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      // Answer validation below produces the same bounded, non-sensitive error.
    }
    if (isRecord(payload)) {
      const reported = payload.usage
      const anthropic = anthropicUsage.safeParse(reported)
      const usage =
        apiType !== 'anthropic'
          ? normalizeOpenAiChatModelStepUsage(reported)
          : anthropic.success
            ? sanitizeAcpTurnTokenUsage({
                inputTokens: anthropic.data.input_tokens,
                outputTokens: anthropic.data.output_tokens,
                cacheTokens:
                  anthropic.data.cache_read_input_tokens +
                  anthropic.data.cache_creation_input_tokens,
                cachedReadTokens: anthropic.data.cache_read_input_tokens,
                cachedWriteTokens: anthropic.data.cache_creation_input_tokens
              })
            : undefined
      // A rejected or cancelled answer can still have billed usage.
      if (usage) input.onUsage?.(usage)
    }
    input.signal.throwIfAborted()
    // Expose bounded error diagnostics, redacting the configured key even when echoed without a label.
    if (!response.ok)
      throw new ProviderTextGenerationError(
        'http-error',
        `Provider returned HTTP ${response.status}.\n${providerErrorDetails(
          isRecord(payload) && payload.error !== undefined
            ? JSON.stringify(payload.error, null, 2)
            : raw,
          [provider.key ?? '']
        )}`,
        response.status,
        providerHttpFailure(
          response.status,
          isRecord(payload) && isRecord(payload.error)
            ? String(payload.error.code ?? payload.error.type ?? '')
            : undefined
        )
      )
    let text: string
    try {
      if (apiType === 'openai') {
        const content = chatResponse.parse(payload).choices[0].message.content
        text = typeof content === 'string' ? content : content.map((part) => part.text).join('')
      } else if (apiType === 'responses') {
        const result = responsesResponse.parse(payload)
        text = result.output
          .flatMap((item) =>
            item.type === 'message' && item.phase !== 'commentary'
              ? item.content.map((part) => part.text)
              : []
          )
          .join('')
      } else {
        text = anthropicResponse
          .parse(payload)
          .content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('')
      }
      if (!text.trim()) throw new Error('Empty output')
    } catch {
      throw new ProviderTextGenerationError(
        'incomplete-output',
        'The model did not return a complete text response.'
      )
    }
    return { text: text.trim(), stopReason: 'end_turn' }
  }
}
