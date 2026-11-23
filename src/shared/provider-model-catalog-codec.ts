import { z } from 'zod'
import type { CatalogSnapshot, CatalogStatus } from '@aipoch/providers'

const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const text = z.string().max(512)
const route = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = URL.parse(value)
    return (
      url !== null &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  })
const model = z.object({
  id: text.min(1),
  name: text.optional(),
  contextWindow: count.optional(),
  maxInputTokens: count.optional(),
  maxOutputTokens: count.optional(),
  supportsImageInput: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  supportsAnonymousAccess: z.boolean().optional(),
  lifecycle: text.optional(),
  source: z.string().max(2048).optional(),
  routes: z
    .object({
      messages: route.optional(),
      responses: route.optional(),
      'chat-completions': route.optional()
    })
    .optional(),
  reasoningEffort: z
    .discriminatedUnion('supported', [
      z.object({ supported: z.literal(false) }),
      z.object({
        supported: z.literal(true),
        values: z
          .array(z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']))
          .min(1)
          .max(8)
      })
    ])
    .optional()
})
const snapshot = z.object({ fetchedAt: count, models: z.array(model).min(1).max(2000) })
const status = z.object({
  attemptedAt: count,
  ok: z.boolean(),
  status: z.number().int().min(100).max(599).optional(),
  code: z
    .enum([
      'unsupported',
      'missing-key',
      'missing-parameter',
      'authentication',
      'permission',
      'rate-limit',
      'service',
      'not-found',
      'network',
      'timeout',
      'invalid-response',
      'resource-limit',
      'stale'
    ])
    .optional()
})
export const decodeModelCatalog = (value: unknown): CatalogSnapshot | undefined =>
  snapshot.safeParse(value).data
export const decodeModelCatalogStatus = (value: unknown): CatalogStatus | undefined =>
  status.safeParse(value).data
export const decodeCatalogParameters = (value: unknown): Record<string, string> | undefined =>
  z
    .record(
      z.string().max(64),
      z
        .string()
        .max(128)
        .regex(/^[a-zA-Z0-9_-]*$/)
    )
    .refine((v) => Object.keys(v).length <= 8)
    .safeParse(value).data

export type ProviderCatalogState = {
  modelCatalog?: CatalogSnapshot
  modelCatalogStatus?: CatalogStatus
  fetchedModels?: string[]
}

export const providerCatalogState = (provider?: ProviderCatalogState): ProviderCatalogState => ({
  modelCatalog: provider?.modelCatalog,
  modelCatalogStatus: provider?.modelCatalogStatus,
  fetchedModels: provider?.fetchedModels
})
