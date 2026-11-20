import { getProviderDefinition } from '@aipoch/providers'
import { listProviderModels } from '@aipoch/providers/client'
import { IMAGE_VENDOR_CATALOG, isQwenWorkspaceBaseUrl } from '../../shared/image-model-settings'
import type {
  ImageModelCatalogRequest,
  ImageModelCatalogResult,
  ImageModelTestRequest,
  ImageModelTestResult,
  ImageModelBinding,
  ImageModelSettingsMutation,
  ImageModelSettingsSnapshot
} from '../../shared/image-model-settings'
import {
  customProviderRequiresKey,
  getCustomProviderBaseUrlError
} from '../../shared/provider-url-policy'
import { encryptKey, hardenKeyMask, maskKey, tryDecryptKey } from './crypto'
import {
  imageModelCatalogRequestSchema,
  imageModelMutationSchema,
  imageProviderConfiguration,
  imageServiceMatchesProvider
} from '../../shared/image-model-service-policy'
import { isCatalogModelAvailable } from '../../shared/provider-model-catalog'
import { testImageModel } from '../image-model/probe'
import type { ResolvedImageModel } from '../image-model/contract'
import { netFetchWithManualRedirect } from '../network-fetch'
import { PROVIDER_RESOURCE_LIMITS } from './provider-resource-limits'
import type { SettingsRepository } from './repository'
import type { StoredImageService, StoredSettings } from './types'

const credentialsFor = (
  service: StoredImageService,
  settings: StoredSettings
): {
  keyRef?: string
  keyMask?: string
} =>
  service.providerId
    ? (settings.providers.find((provider) => provider.id === service.providerId) ?? {})
    : service

const configured = (service: StoredImageService, settings: StoredSettings): boolean =>
  Boolean(credentialsFor(service, settings).keyRef) ||
  (!service.providerId && !customProviderRequiresKey(service.baseUrl))

const view = (settings: StoredSettings): ImageModelSettingsSnapshot => ({
  services: (settings.imageServices ?? []).map((service) => {
    const { keyRef, keyMask } = credentialsFor(service, settings)
    // Project explicitly: encrypted references must never cross the renderer boundary.
    return {
      id: service.id,
      name: service.name,
      adapter: service.adapter,
      baseUrl: service.baseUrl,
      providerId: service.providerId,
      vendorId: service.vendorId,
      models: service.models,
      configured: configured(service, settings),
      maskedKey: keyRef ? hardenKeyMask(keyMask) : undefined
    }
  }),
  imageModel: settings.imageModel,
  availableProviders: settings.providers.flatMap((provider) => {
    const official = imageProviderConfiguration(provider)
    return official && provider.keyRef
      ? [
          {
            id: provider.id,
            name: provider.name,
            ...official,
            maskedKey: hardenKeyMask(provider.keyMask)
          }
        ]
      : []
  })
})

const resolveService = (
  service: StoredImageService | undefined,
  modelId: string | undefined,
  settings: StoredSettings
): ResolvedImageModel | undefined => {
  const model = service?.models.find((entry) => entry.id === modelId)
  if (!service || !model || !imageServiceMatchesProvider(service, settings.providers))
    return undefined
  const provider = settings.providers.find((entry) => entry.id === service.providerId)
  const baseUrl = service.baseUrl ?? (provider && imageProviderConfiguration(provider)?.baseUrl)
  if (!baseUrl || getCustomProviderBaseUrlError(baseUrl)) return undefined
  const keyRef = credentialsFor(service, settings).keyRef
  const apiKey = keyRef ? tryDecryptKey(keyRef) : undefined
  if ((keyRef && !apiKey) || (!apiKey && customProviderRequiresKey(baseUrl))) return undefined
  return {
    serviceId: service.id,
    serviceName: service.name,
    providerId: service.providerId,
    adapter: service.adapter,
    baseUrl,
    apiKey,
    model: { ...model }
  }
}

const savedImageCredential = (
  update: ImageModelCatalogRequest,
  current: StoredSettings
): StoredImageService | undefined => {
  const previous = current.imageServices?.find((service) => service.id === update.id)
  // Reuse saved credentials only when the endpoint and adapter still match.
  return !update.providerId &&
    !previous?.providerId &&
    previous?.adapter === update.adapter &&
    previous?.baseUrl === update.baseUrl
    ? previous
    : undefined
}

const prepareService = (
  update: ImageModelTestRequest,
  current: StoredSettings
): StoredImageService => {
  const saved = savedImageCredential(update, current)
  const apiKey = update.apiKey
  const service: StoredImageService = {
    id: update.id,
    name: update.name,
    adapter: update.adapter,
    baseUrl: update.baseUrl,
    providerId: update.providerId,
    vendorId: update.vendorId,
    models: update.models,
    ...(!update.providerId
      ? {
          keyRef: apiKey ? encryptKey(apiKey) : saved?.keyRef,
          keyMask: apiKey ? maskKey(apiKey) : saved?.keyMask
        }
      : {})
  }
  if (!imageServiceMatchesProvider(service, current.providers))
    throw new Error('Image provider account or model is unavailable.')
  if (!configured(service, current)) throw new Error('An API key is required.')
  return service
}

export class ImageModelOwner {
  private testing = false

  constructor(
    private readonly repository: SettingsRepository,
    private readonly testGeneration: typeof testImageModel = testImageModel
  ) {}

  /** Previews an official image catalog without changing the saved service configuration. */
  async refreshCatalog(request: ImageModelCatalogRequest): Promise<ImageModelCatalogResult> {
    const parsed = imageModelCatalogRequestSchema.safeParse(request)
    if (!parsed.success) return { ok: false, code: 'unsupported' }
    const target = parsed.data
    const current = await this.repository.getSettings()
    const provider = current.providers.find((entry) => entry.id === target.providerId)
    const official = provider && imageProviderConfiguration(provider)
    if (
      target.providerId &&
      (!official ||
        official.adapter !== target.adapter ||
        (target.vendorId && target.vendorId !== official.vendorId))
    )
      return { ok: false, code: 'stale' }
    const vendorId = target.vendorId ?? official?.vendorId
    const vendor = IMAGE_VENDOR_CATALOG.find((entry) => entry.id === vendorId)
    const options = vendor && getProviderDefinition(vendor.id)?.imageGeneration?.modelsList
    const baseUrl = target.baseUrl ?? official?.baseUrl
    if (!vendor || !options || !baseUrl) return { ok: false, code: 'unsupported' }

    let url = `${baseUrl.replace(/\/+$/, '')}/models`
    if (vendorId === 'bailian') {
      const workspaceId = provider?.catalogParameters?.workspaceId
      const workspace = isQwenWorkspaceBaseUrl(baseUrl)
        ? baseUrl
        : workspaceId && `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
      if (!workspace || !isQwenWorkspaceBaseUrl(workspace))
        return { ok: false, code: 'missing-parameter' }
      const catalogUrl = new URL('/api/v1/models', workspace)
      // Linked Bailian image accounts are scoped to China. Other regions require a separate key.
      if (provider && !catalogUrl.hostname.endsWith('.cn-beijing.maas.aliyuncs.com'))
        return { ok: false, code: 'missing-key' }
      if (catalogUrl.hostname.endsWith('.us-east-1.maas.aliyuncs.com'))
        catalogUrl.hostname = 'dashscope-us.aliyuncs.com'
      url = catalogUrl.href
    }
    const keyRef = provider?.keyRef ?? savedImageCredential(target, current)?.keyRef
    const key = target.apiKey || (keyRef ? tryDecryptKey(keyRef) : undefined)
    if (!key) return { ok: false, code: 'missing-key' }

    const result = await listProviderModels(
      { url, key, options },
      { fetchImpl: netFetchWithManualRedirect, limits: PROVIDER_RESOURCE_LIMITS }
    )
    if (!result.ok) return { ok: false, code: result.code ?? 'invalid-response' }
    const modelIds = (result.catalog ?? [])
      .filter(isCatalogModelAvailable)
      .map(({ id }) => id)
      .filter((id) => vendor.models.some((model) => model.wireModelId === id))
    return modelIds.length
      ? { ok: true, modelIds, fetchedAt: Date.now() }
      : { ok: false, code: 'invalid-response' }
  }

  async test(request: ImageModelTestRequest): Promise<ImageModelTestResult> {
    if (this.testing) return { ok: false, error: { code: 'RATE_LIMITED' } }
    this.testing = true
    try {
      const parsed = imageModelMutationSchema.safeParse(request)
      if (!parsed.success || parsed.data.kind !== 'save')
        return { ok: false, error: { code: 'INVALID_REQUEST' } }
      const current = await this.repository.getSettings()
      const service = prepareService(parsed.data, current)
      const target = resolveService(service, service.models[0].id, current)
      if (!target) return { ok: false, error: { code: 'NOT_CONFIGURED' } }
      return await this.testGeneration(target)
    } catch {
      return { ok: false, error: { code: 'INVALID_REQUEST' } }
    } finally {
      this.testing = false
    }
  }

  async snapshot(): Promise<ImageModelSettingsSnapshot> {
    return view(await this.repository.getSettings())
  }

  async resolve(selection?: ImageModelBinding): Promise<ResolvedImageModel | undefined> {
    const settings = await this.repository.getSettings()
    const binding = selection ?? settings.imageModel
    const service = settings.imageServices?.find((entry) => entry.id === binding?.serviceId)
    return resolveService(service, binding?.modelId, settings)
  }

  async mutate(request: ImageModelSettingsMutation): Promise<ImageModelSettingsSnapshot> {
    const parsed = imageModelMutationSchema.safeParse(request)
    if (!parsed.success) throw new Error('Invalid image model settings.')
    const update = parsed.data
    const settings = await this.repository.mutateImageModels((current) => {
      let services = current.imageServices ?? []
      let imageModel = current.imageModel
      if (update.kind === 'save') {
        const previous = services.find((service) => service.id === update.id)
        if (!previous && services.length >= 16) throw new Error('Too many image services.')
        const service = prepareService(update, current)
        // Preserve a model recently selected in another window for the same official connection.
        if (
          (service.vendorId || service.providerId) &&
          previous &&
          previous.adapter === service.adapter &&
          previous.providerId === service.providerId &&
          previous.baseUrl === service.baseUrl &&
          (previous.vendorId === service.vendorId ||
            (previous.vendorId === undefined && previous.providerId !== undefined)) &&
          imageModel?.serviceId === service.id
        ) {
          const bound = previous.models.find((model) => model.id === imageModel?.modelId)
          if (bound && !service.models.some((model) => model.id === bound.id)) {
            if (service.models.length >= 16) throw new Error('Too many image models.')
            const models = [...service.models, bound]
            if (!imageModelMutationSchema.safeParse({ ...update, models }).success)
              throw new Error('Invalid image model settings.')
            service.models = models
          }
        }
        services = previous
          ? services.map((entry) => (entry.id === service.id ? service : entry))
          : [...services, service]
        if (!previous && !imageModel)
          imageModel = { serviceId: service.id, modelId: service.models[0].id }
      } else if (update.kind === 'remove') {
        services = services.filter((service) => service.id !== update.id)
      } else {
        const service = services.find((service) => service.id === update.binding?.serviceId)
        if (
          update.binding &&
          (!service ||
            !configured(service, current) ||
            !service.models.some((model) => model.id === update.binding?.modelId))
        )
          throw new Error('Image model is unavailable.')
        imageModel = update.binding
      }
      return { imageServices: services, imageModel }
    })
    return view(settings)
  }
}
