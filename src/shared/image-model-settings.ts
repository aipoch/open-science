import { getProviderDefinition } from '@aipoch/providers'
import type { CatalogErrorCode } from '@aipoch/providers'
import type { ImageErrorDetail } from './image-model-error'

export const IMAGE_MODEL_PRESET_ADAPTERS = {
  'minimax-h3/official': 'minimax',
  'minimax-h3/sglang': 'openai-images',
  'openai-images/generic': 'openai-images',
  'openai/gpt-image-2.6': 'openai-images',
  'qwen/image-3.0': 'qwen-images',
  'seedream/5.5': 'seedream'
} as const

export type ImageModelPresetId = keyof typeof IMAGE_MODEL_PRESET_ADAPTERS
export type ImageAdapterKind = (typeof IMAGE_MODEL_PRESET_ADAPTERS)[ImageModelPresetId]
export type ImageServiceModel = {
  id: string
  presetId: ImageModelPresetId
  wireModelId: string
  label?: string
}
export type ImageServiceConfiguration = {
  id: string
  name: string
  adapter: ImageAdapterKind
  baseUrl?: string
  providerId?: string
  vendorId?: ImageVendorId
  models: ImageServiceModel[]
}
export type ImageModelBinding = { serviceId: string; modelId: string }
export type ImageModelSettingsSnapshot = {
  services: Array<ImageServiceConfiguration & { configured: boolean; maskedKey?: string }>
  imageModel?: ImageModelBinding
  availableProviders: Array<{
    id: string
    name: string
    vendorId: ImageVendorId
    adapter: ImageAdapterKind
    baseUrl: string
    models: ImageServiceModel[]
    maskedKey?: string
  }>
}
export type ImageModelSettingsMutation =
  | ({ kind: 'save'; apiKey?: string } & ImageServiceConfiguration)
  | { kind: 'remove'; id: string }
  | { kind: 'bind'; binding?: ImageModelBinding }

export type ImageModelTestRequest = Extract<ImageModelSettingsMutation, { kind: 'save' }>
export type ImageModelTestResult = { ok: true } | { ok: false; error: ImageErrorDetail }
export type ImageModelCatalogRequest = Omit<ImageModelTestRequest, 'kind' | 'name' | 'models'>
export type ImageModelCatalogResult =
  { ok: true; modelIds: string[]; fetchedAt: number } | { ok: false; code: CatalogErrorCode }

export const IMAGE_VENDOR_PRESETS = {
  openai: 'openai/gpt-image-2.6',
  minimax: 'minimax-h3/official',
  volcengine: 'seedream/5.5',
  bailian: 'qwen/image-3.0'
} as const satisfies Record<string, ImageModelPresetId>
export type ImageVendorId = keyof typeof IMAGE_VENDOR_PRESETS

// Bailian's OpenAI-compatible image endpoint can be scoped to an official workspace.
export const isQwenWorkspaceBaseUrl = (url: string | undefined): url is string =>
  !!url &&
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:cn-beijing|cn-hongkong|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1)\.maas\.aliyuncs\.com\/compatible-mode\/v1\/?$/.test(
    url
  )

// A display catalog is independent of configured accounts; credentials never enter this object.
export const IMAGE_VENDOR_CATALOG = Object.entries(IMAGE_VENDOR_PRESETS).map(([id, presetId]) => {
  const vendor = getProviderDefinition(id)!
  return {
    id: id as ImageVendorId,
    label: vendor.label,
    adapter: IMAGE_MODEL_PRESET_ADAPTERS[presetId],
    supportsCatalogRefresh: Boolean(vendor.imageGeneration!.modelsList),
    regions: vendor.imageGeneration!.regions,
    models: vendor.imageGeneration!.models.map((model): ImageServiceModel => ({
      id: model.id,
      wireModelId: model.id,
      label: model.label,
      presetId
    }))
  }
})
