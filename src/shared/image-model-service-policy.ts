import { resolveProviderImageBaseUrl } from '@aipoch/providers'
import type { ProviderView } from './settings'
import { z } from 'zod'
import {
  IMAGE_MODEL_PRESET_ADAPTERS,
  IMAGE_VENDOR_CATALOG,
  isQwenWorkspaceBaseUrl,
  type ImageAdapterKind,
  type ImageVendorId,
  type ImageServiceConfiguration,
  type ImageServiceModel
} from './image-model-settings'
import { getCustomProviderBaseUrlError } from './provider-url-policy'

const imageOptionId = z.string().trim().min(1).max(128)
const imageWireModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._:/-]+$/)
const model = z
  .object({
    id: imageOptionId,
    presetId: z.enum(
      Object.keys(IMAGE_MODEL_PRESET_ADAPTERS) as [
        keyof typeof IMAGE_MODEL_PRESET_ADAPTERS,
        ...Array<keyof typeof IMAGE_MODEL_PRESET_ADAPTERS>
      ]
    ),
    wireModelId: imageWireModelIdSchema,
    label: z.string().trim().min(1).max(128).optional()
  })
  .strict()
const targetFields = {
  id: z.string().uuid(),
  adapter: z.enum(['minimax', 'openai-images', 'qwen-images', 'seedream']),
  baseUrl: z.string().trim().min(1).max(2048).optional(),
  providerId: imageOptionId.optional(),
  vendorId: z.enum(['minimax', 'openai', 'bailian', 'volcengine']).optional()
}
const apiKey = z.string().trim().max(16384).optional()
type ImageServiceTarget = z.infer<z.ZodObject<typeof targetFields>>
const usesQwenWorkspace = (service: ImageServiceTarget): boolean =>
  service.vendorId === 'bailian' &&
  service.adapter === 'qwen-images' &&
  isQwenWorkspaceBaseUrl(service.baseUrl)

const validTarget = (service: ImageServiceTarget): boolean =>
  (!service.vendorId ||
    IMAGE_VENDOR_CATALOG.some(
      (vendor) =>
        vendor.id === service.vendorId &&
        vendor.adapter === service.adapter &&
        (service.providerId ||
          usesQwenWorkspace(service) ||
          vendor.regions.some((region) => region.baseUrl === service.baseUrl))
    )) &&
  (service.providerId !== undefined
    ? service.baseUrl === undefined || usesQwenWorkspace(service)
    : Boolean(service.baseUrl && !getCustomProviderBaseUrlError(service.baseUrl)))

const validService = (service: ImageServiceConfiguration): boolean =>
  validTarget(service) &&
  (!service.vendorId ||
    service.models.every((model) =>
      IMAGE_VENDOR_CATALOG.find((vendor) => vendor.id === service.vendorId)?.models.some(
        (entry) => entry.wireModelId === model.wireModelId && entry.presetId === model.presetId
      )
    )) &&
  new Set(service.models.map((model) => model.id)).size === service.models.length &&
  service.models.every((model) => IMAGE_MODEL_PRESET_ADAPTERS[model.presetId] === service.adapter)
export const imageServiceSchema = z
  .strictObject({
    ...targetFields,
    name: z.string().trim().min(1).max(80),
    models: z.array(model).min(1).max(16)
  })
  .refine(validService)
export const imageModelCatalogRequestSchema = z
  .strictObject({ ...targetFields, apiKey })
  .refine(
    (service) =>
      Boolean(service.vendorId || service.providerId) &&
      validTarget(service) &&
      (!service.providerId || service.apiKey === undefined)
  )
export const imageModelBindingSchema = z
  .object({ serviceId: z.string().uuid(), modelId: imageOptionId })
  .strict()
export const imageModelMutationSchema = z.union([
  imageServiceSchema
    .safeExtend({ kind: z.literal('save'), apiKey })
    .refine((service) => !service.providerId || service.apiKey === undefined),
  z.object({ kind: z.literal('remove'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('bind'), binding: imageModelBindingSchema.optional() }).strict()
])

export const imageProviderConfiguration = (
  provider: Pick<ProviderView, 'type' | 'vendorId' | 'region'>
):
  | {
      baseUrl: string
      adapter: ImageAdapterKind
      vendorId: ImageVendorId
      models: ImageServiceModel[]
    }
  | undefined => {
  if (provider.type !== 'official') return undefined
  const vendor = IMAGE_VENDOR_CATALOG.find((entry) => entry.id === provider.vendorId)
  if (!vendor) return undefined
  const baseUrl = resolveProviderImageBaseUrl(vendor.id, provider.region)
  if (!baseUrl) return undefined
  return { baseUrl, adapter: vendor.adapter, vendorId: vendor.id, models: vendor.models }
}

export const imageServiceMatchesProvider = (
  service: ImageServiceConfiguration,
  providers: readonly Pick<ProviderView, 'id' | 'type' | 'vendorId' | 'region'>[]
): boolean => {
  if (!service.providerId) return true
  const provider = providers.find((provider) => provider.id === service.providerId)
  const official = provider && imageProviderConfiguration(provider)
  return Boolean(
    official &&
    service.adapter === official.adapter &&
    (!service.vendorId || service.vendorId === official.vendorId) &&
    service.models.every((model) =>
      official.models.some(
        (entry) => entry.wireModelId === model.wireModelId && entry.presetId === model.presetId
      )
    )
  )
}
