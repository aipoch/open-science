import type { ModelIdentity } from './types'
import { z } from 'zod'
import { fetchProviderRequest } from '../transport/request'
import { readBoundedResponseText, ResponseBodyLimitError } from '../transport/body'

const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().safe(),
  output_tokens: z.number().int().nonnegative().safe()
})
const measuredSchema = z.object({
  model: z.string().trim().min(1).optional(),
  usage: usageSchema
})
const resultSchema = z.object({
  model: z.string().trim().min(1).max(128),
  usage: usageSchema,
  answers: z.record(
    z.string(),
    z.union([
      z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
      z.object({
        type: z.literal('choice'),
        choice: z.string(),
        confidence: z.number().min(0).max(1).optional(),
        probabilities: z.record(z.string(), z.number().min(0).max(1)).optional()
      })
    ])
  )
})
type ClassificationPayload = z.infer<typeof resultSchema>
export type ClassificationResult = ClassificationPayload & Readonly<{ responseStatus: number }>
export type ClassificationMeasurement = Readonly<{
  model: string
  inputTokens: number
  outputTokens: number
}>
/** Prepared PNG assets. Image authorization, decoding and normalization belong to the caller. */
export type ClassificationImage = Readonly<{ type: 'image'; format: 'png'; data_base64: string }>
export type ClassificationInput = Readonly<{
  state: string
  images?: Readonly<Record<string, ClassificationImage>>
  questions: Readonly<Record<string, unknown>>
  signal?: AbortSignal
}>
export class ClassificationResponseError extends Error {
  readonly code = 'invalid-response'
  constructor(cause: unknown) {
    super('Invalid classification response.', { cause })
  }
}
export class ClassificationHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string
  ) {
    super(`Classification request failed (${status}).`)
  }
}
type ClassificationExchange = Readonly<{
  status: number
  ok: boolean
  cancel(): Promise<void>
  read(onUsage?: (measurement: ClassificationMeasurement) => void): Promise<ClassificationPayload>
}>

export type ClassificationCallOptions = Readonly<{
  onUsage?: (measurement: ClassificationMeasurement) => void
  /** A caller scheduling a retry may discard transient error bodies when no usage observer is needed. */
  retryableErrors?: 'read' | 'discard'
}>
export type ClassificationModel = ModelIdentity<'classification'> &
  Readonly<{
    classify(
      input: ClassificationInput,
      options?: ClassificationCallOptions
    ): Promise<ClassificationResult>
  }>

/** One bound model and HTTP attempt; retry admission and answer policy belong to the caller. */
export const createClassificationAttempt = (
  providerId: string,
  modelId: string,
  url: string,
  key: string | undefined,
  fetchImpl: typeof fetch,
  maxResponseBytes = 128 * 1024,
  imageEndpoint = url,
  maxRequestBytes = 16 * 1024 * 1024
): ModelIdentity<'classification'> & {
  request(input: ClassificationInput): Promise<ClassificationExchange>
} => {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1)
    throw new RangeError('Classification response limit must be a positive safe integer.')
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1)
    throw new RangeError('Classification request limit must be a positive safe integer.')
  return Object.freeze({
    providerId,
    modelId,
    capability: 'classification' as const,
    async request(input: ClassificationInput) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (key) headers.Authorization = `Bearer ${key}`
      const imageIds = Object.keys(input.images ?? {})
      const hasImages = imageIds.length > 0
      if (hasImages) headers['TypeSafe-Danger-Zone-Images'] = 'true'
      const body = JSON.stringify({
        model: modelId,
        state: hasImages ? { text: input.state, images: imageIds } : input.state,
        questions: input.questions,
        ...(hasImages ? { assets: input.images } : {})
      })
      if (hasImages && Buffer.byteLength(body, 'utf8') > maxRequestBytes)
        throw new Error('Classification image request exceeds the body budget.')
      const response = await fetchProviderRequest(fetchImpl, hasImages ? imageEndpoint : url, {
        method: 'POST',
        headers,
        signal: input.signal,
        body
      })
      return {
        status: response.status,
        ok: response.ok,
        async cancel() {
          await response.body?.cancel()
        },
        async read(onUsage) {
          // Complete billed usage remains observable even for invalid answers or late cancellation.
          const text = await readBoundedResponseText(
            response,
            maxResponseBytes,
            'Classification response'
          )
          let payload: unknown
          try {
            payload = JSON.parse(text)
          } catch {
            /* Valid usage requires a JSON envelope. */
          }
          const measured = measuredSchema.safeParse(payload)
          if (measured.success)
            onUsage?.({
              model: measured.data.model ?? modelId,
              inputTokens: measured.data.usage.input_tokens,
              outputTokens: measured.data.usage.output_tokens
            })
          if (!response.ok) throw new ClassificationHttpError(response.status, text)
          return resultSchema.parse(payload)
        }
      }
    }
  })
}

/** Complete single-attempt invocation. The caller owns retry admission and accounting. */
export const createClassificationModel = (
  ...args: Parameters<typeof createClassificationAttempt>
): ClassificationModel => {
  const attempt = createClassificationAttempt(...args)
  return Object.freeze({
    providerId: attempt.providerId,
    modelId: attempt.modelId,
    capability: attempt.capability,
    async classify(input: ClassificationInput, options: ClassificationCallOptions = {}) {
      const exchange = await attempt.request(input)
      if (
        options.retryableErrors === 'discard' &&
        !options.onUsage &&
        (exchange.status === 429 || exchange.status === 529)
      ) {
        await exchange.cancel()
        throw new ClassificationHttpError(exchange.status, '')
      }
      try {
        const result = await exchange.read(options.onUsage)
        input.signal?.throwIfAborted()
        return { ...result, responseStatus: exchange.status }
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason
        if (error instanceof z.ZodError || error instanceof ResponseBodyLimitError)
          throw new ClassificationResponseError(error)
        throw error
      }
    }
  })
}
