import { z } from 'zod'
import { PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'
import { characterCount } from './settings-resource-limits'
import { getCustomProviderBaseUrlError } from '../../shared/provider-base-url'
const id = z.string().uuid()
const providerId = z
  .string()
  .min(1)
  .refine((value) => characterCount(value) <= PROVIDER_RESOURCE_LIMITS.idCharacters)
const model = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:/-]+$/)
const baseUrl = z.string().trim().min(1).max(2048)
export const classificationBindingSchema = z.object({ serviceId: id, modelId: model.optional() })
const storedBindingSchema = z.object({ serviceId: id, modelId: model.optional() })
export const classificationServiceSchema = z
  .object({
    id,
    adapter: z.enum(['typesafe', 'openrouter', 'custom']),
    name: z.string().trim().min(1).max(80),
    models: z.array(model).min(1).max(16),
    baseUrl: baseUrl.optional(),
    keyRef: z.string().min(1).max(32768).optional(),
    providerId: providerId.optional(),
    keyMask: z.string().trim().max(128).optional()
  })
  .superRefine((service, ctx) => {
    if (service.adapter !== 'custom') return
    if (!service.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: 'Custom endpoint is required.'
      })
    } else if (getCustomProviderBaseUrlError(service.baseUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: 'Invalid custom endpoint.'
      })
    }
    if (service.models.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models'],
        message: 'Custom services use one model.'
      })
    }
    if (service.providerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['providerId'],
        message: 'Custom services cannot link a provider.'
      })
    }
  })
export const classificationSettingsSchema = z.object({
  revision: z.number().int().nonnegative().safe(),
  services: z.array(classificationServiceSchema).max(16),
  capabilitySelection: classificationBindingSchema.optional(),
  skillSelection: storedBindingSchema.optional(),
  connectorSelection: storedBindingSchema.optional()
})
export const classificationMutationSchema = z.intersection(
  z.object({ revision: z.number().int().nonnegative().safe() }),
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('save'),
      id,
      adapter: classificationServiceSchema.shape.adapter,
      name: classificationServiceSchema.shape.name,
      baseUrl: baseUrl.optional(),
      modelId: model.optional(),
      providerId: providerId.optional(),
      apiKey: z.string().trim().min(1).max(8192).optional()
    }),
    z.object({ kind: z.literal('remove'), id }),
    z.object({
      kind: z.literal('bind'),
      binding: classificationBindingSchema.optional()
    })
  ])
)
