import type { ModelIdentity } from './types'
import { fetchProviderRequest } from '../transport/request'
import { readBoundedResponseText, ResponseBodyLimitError } from '../transport/body'
import { ProviderTextGenerationError, providerErrorDetails, providerHttpFailure } from '../errors'
import { chatCompletionsTextCodec } from '../protocols/chat-completions/text'
import { responsesTextCodec } from '../protocols/responses/text'
import { messagesTextCodec } from '../protocols/messages/text'
import type {
  ProviderTextGenerationRequest,
  ProviderTextGenerationTarget,
  TextCodec
} from '../protocols/text-types'

const codecs = {
  'chat-completions': chatCompletionsTextCodec,
  responses: responsesTextCodec,
  messages: messagesTextCodec
} satisfies Record<string, TextCodec>
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type TextGenerationInput = Readonly<
  { prompt: string } & Partial<Omit<ProviderTextGenerationRequest, 'target' | 'prompt'>>
>
export type TextGenerationModel = ModelIdentity<'text-generation'> &
  Readonly<{
    generate(input: TextGenerationInput): Promise<{ text: string; stopReason: 'end_turn' }>
  }>

export function createTextGenerationModel(
  providerId: string,
  configuration: ProviderTextGenerationTarget,
  fetchImpl: typeof fetch
): TextGenerationModel {
  const target = Object.freeze({ ...configuration })
  return Object.freeze({
    providerId,
    modelId: target.model,
    capability: 'text-generation' as const,
    async generate(request: TextGenerationInput) {
      const input = {
        ...request,
        target,
        systemPrompt: request.systemPrompt ?? '',
        signal: request.signal ?? new AbortController().signal,
        maxOutputTokens: request.maxOutputTokens ?? 4096,
        outputLimitBytes: request.outputLimitBytes ?? 1024 * 1024
      }
      input.signal.throwIfAborted()
      const codec = codecs[target.protocol]
      if (!codec || !target.model || !target.url)
        throw new ProviderTextGenerationError(
          'unsupported-target',
          'Text generation is unavailable.'
        )
      if (
        !Number.isSafeInteger(input.maxOutputTokens) ||
        input.maxOutputTokens <= 0 ||
        !Number.isSafeInteger(input.outputLimitBytes) ||
        input.outputLimitBytes <= 0 ||
        (target.maxOutputTokens !== undefined &&
          (!Number.isSafeInteger(target.maxOutputTokens) || target.maxOutputTokens <= 0))
      )
        throw new ProviderTextGenerationError('invalid-request', 'Invalid text generation limits.')
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(target.protocol === 'messages'
          ? {
              'anthropic-version': '2023-06-01',
              ...(target.key
                ? target.messagesApiKeyHeader === false
                  ? { authorization: 'Bearer ' + target.key }
                  : { 'x-api-key': target.key }
                : {})
            }
          : target.key
            ? { authorization: 'Bearer ' + target.key }
            : {})
      }
      let response: Response
      let raw: string
      try {
        response = await fetchProviderRequest(fetchImpl, target.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(codec.encode(input)),
          signal: input.signal
        })
        // Preserve complete billing already received before caller cancellation. The injected
        // fetch owns network cancellation; the bounded payload is accounted before throwing.
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
          providerErrorDetails(error, [target.key ?? '']),
          undefined,
          { kind: 'network' }
        )
      }
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        /* Invalid JSON follows the same bounded answer validation below. */
      }
      const usage = codec.usage(isRecord(payload) ? payload.usage : undefined)
      if (usage) input.onUsage?.(usage)
      input.signal.throwIfAborted()
      if (!response.ok)
        throw new ProviderTextGenerationError(
          'http-error',
          `Provider returned HTTP ${response.status}.\n${providerErrorDetails(isRecord(payload) && payload.error !== undefined ? JSON.stringify(payload.error, null, 2) : raw, [target.key ?? ''])}`,
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
        text = codec.text(payload)
        if (!text.trim()) throw new Error('Empty output')
      } catch {
        throw new ProviderTextGenerationError(
          'incomplete-output',
          'The model did not return a complete text response.'
        )
      }
      return { text: text.trim(), stopReason: 'end_turn' as const }
    }
  })
}
