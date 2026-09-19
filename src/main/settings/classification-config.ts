import { z } from 'zod'
import { PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'
import { characterCount } from './settings-resource-limits'
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
export const classificationBindingSchema = z.object({ serviceId: id, modelId: model.optional() })
const storedBindingSchema = z.object({ serviceId: id, modelId: model.optional() })
export const classificationServiceSchema = z.object({
  id,
  adapter: z.enum(['typesafe', 'openrouter']),
  name: z.string().trim().min(1).max(80),
  models: z.array(model).min(1).max(16),
  keyRef: z.string().min(1).max(32768).optional(),
  providerId: providerId.optional(),
  keyMask: z.string().trim().max(128).optional()
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
