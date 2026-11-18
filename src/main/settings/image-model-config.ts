import { resolveProviderImageBaseUrl } from '@aipoch/providers'
import { z } from 'zod'
import {
  IMAGE_MODEL_PRESET_ADAPTERS,
  IMAGE_VENDOR_CATALOG,
  isQwenWorkspaceBaseUrl,
  type ImageAdapterKind,
  type ImageVendorId,
  type ImageServiceModel
} from '../../shared/image-model-settings'
import { getCustomProviderBaseUrlError } from '../../shared/provider-url-policy'
import type { StoredImageService, StoredProvider, StoredSettings } from './types'

const id = z.string().trim().min(1).max(128)
const model = z
  .object({
    id,
    presetId: z.enum(
      Object.keys(IMAGE_MODEL_PRESET_ADAPTERS) as [
        keyof typeof IMAGE_MODEL_PRESET_ADAPTERS,
        ...Array<keyof typeof IMAGE_MODEL_PRESET_ADAPTERS>
      ]
    ),
    wireModelId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9._:/-]+$/),
    label: z.string().trim().min(1).max(128).optional()
  })
  .strict()
const serviceFields = {
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  adapter: z.enum(['minimax', 'openai-images', 'qwen-images', 'seedream']),
  baseUrl: z.string().trim().min(1).max(2048).optional(),
  providerId: id.optional(),
  vendorId: z.enum(['minimax', 'openai', 'bailian', 'volcengine']).optional(),
  models: z.array(model).min(1).max(16)
}
const usesQwenWorkspace = (service: z.infer<typeof serviceShape>): boolean =>
  service.vendorId === 'bailian' &&
  service.adapter === 'qwen-images' &&
  isQwenWorkspaceBaseUrl(service.baseUrl)

const validService = (service: z.infer<typeof serviceShape>): boolean =>
  (!service.vendorId ||
    IMAGE_VENDOR_CATALOG.some(
      (vendor) =>
        vendor.id === service.vendorId &&
        vendor.adapter === service.adapter &&
        (service.providerId ||
          usesQwenWorkspace(service) ||
          vendor.regions.some((region) => region.baseUrl === service.baseUrl)) &&
        service.models.every((model) =>
          vendor.models.some(
            (entry) => entry.wireModelId === model.wireModelId && entry.presetId === model.presetId
          )
        )
    )) &&
  new Set(service.models.map((model) => model.id)).size === service.models.length &&
  service.models.every(
    (model) => IMAGE_MODEL_PRESET_ADAPTERS[model.presetId] === service.adapter
  ) &&
  (service.providerId !== undefined
    ? service.baseUrl === undefined || usesQwenWorkspace(service)
    : Boolean(service.baseUrl && !getCustomProviderBaseUrlError(service.baseUrl)))
const serviceShape = z.object(serviceFields)
const storedService = serviceShape
  .extend({
    keyRef: z.string().min(1).max(32768).optional(),
    keyMask: z.string().max(128).optional()
  })
  .strict()
  .refine(validService)
  .refine(
    (service) =>
      !service.providerId || (service.keyRef === undefined && service.keyMask === undefined)
  )
const bindingSchema = z.object({ serviceId: z.string().uuid(), modelId: id }).strict()
export const imageModelMutationSchema = z.union([
  serviceShape
    .extend({ kind: z.literal('save'), apiKey: z.string().trim().max(16384).optional() })
    .strict()
    .refine(validService)
    .refine((service) => !service.providerId || service.apiKey === undefined),
  z.object({ kind: z.literal('remove'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('bind'), binding: bindingSchema.optional() }).strict()
])

export const imageProviderConfiguration = (
  provider: StoredProvider
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
  service: StoredImageService,
  providers: StoredProvider[]
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

export const sanitizeImageSettings = (
  value: { imageServices?: unknown; imageModel?: unknown },
  providers: StoredProvider[]
): Pick<StoredSettings, 'imageServices' | 'imageModel'> => {
  const services: StoredImageService[] = []
  if (Array.isArray(value.imageServices)) {
    for (const candidate of value.imageServices.slice(0, 16)) {
      const parsed = storedService.safeParse(candidate)
      if (
        parsed.success &&
        !services.some((entry) => entry.id === parsed.data.id) &&
        imageServiceMatchesProvider(parsed.data, providers)
      )
        services.push(parsed.data)
    }
  }
  const binding = bindingSchema.safeParse(value.imageModel).data
  const imageModel =
    binding &&
    services.some(
      (service) =>
        service.id === binding.serviceId &&
        service.models.some((model) => model.id === binding.modelId)
    )
      ? binding
      : undefined
  return {
    ...(services.length ? { imageServices: services } : {}),
    ...(imageModel ? { imageModel } : {})
  }
}
