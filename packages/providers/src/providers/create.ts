import { getProviderDefinition } from './definitions'
import { createTextGenerationModel, type TextGenerationModel } from '../models/text-generation'
import { createClassificationModel, type ClassificationModel } from '../models/classification'
import {
  resolveTextConnection,
  resolveModelDiscoveryUrl,
  type TextGenerationConfiguration
} from './connection'
import {
  listProviderModels,
  type ListModelsOptions,
  type ListModelsResult
} from '../discovery/models'

export type ProviderConfiguration = Readonly<{
  id: string
  key?: string
  fetch?: typeof fetch
  region?: string
  discovery?: Readonly<{ url: string }>
  textGeneration?: TextGenerationConfiguration
  classification?: Readonly<{ url?: string; maxResponseBytes?: number; maxRequestBytes?: number }>
}>
export type Provider = Readonly<{
  id: string
  supportsTextGeneration(modelId: string): boolean
  supportsModelDiscovery: boolean
  listModels(options?: ListModelsOptions): Promise<ListModelsResult>
  textGenerationModel(modelId: string): TextGenerationModel
  classificationModel(modelId: string): ClassificationModel
}>
const requireId = (id: string): void => {
  if (!id.trim()) throw new TypeError('Provider and model IDs must be nonempty.')
}

/** Immutable connection snapshot. Create another provider when credentials or endpoints change. */
export function createProvider(configuration: ProviderConfiguration): Provider {
  const { id, key, region, fetch: fetchImpl = globalThis.fetch } = configuration
  requireId(id)
  const text =
    configuration.textGeneration &&
    Object.freeze({
      ...configuration.textGeneration,
      apiEndpoints:
        configuration.textGeneration.apiEndpoints &&
        Object.freeze([...configuration.textGeneration.apiEndpoints])
    })
  const classification = configuration.classification
    ? Object.freeze({ ...configuration.classification })
    : undefined
  const definition = getProviderDefinition(id)
  const modelsUrl = configuration.discovery?.url ?? resolveModelDiscoveryUrl(id, region)
  return Object.freeze({
    id,
    supportsModelDiscovery: Boolean(modelsUrl),
    listModels(options?: ListModelsOptions) {
      if (!modelsUrl)
        return Promise.resolve({ ok: false, message: 'This provider has no model-list endpoint.' })
      return listProviderModels({ url: modelsUrl, vendorId: id, key }, { ...options, fetchImpl })
    },
    supportsTextGeneration(modelId: string) {
      try {
        requireId(modelId)
        resolveTextConnection(id, modelId, region, text)
        return true
      } catch (error) {
        if (error instanceof TypeError) return false
        throw error
      }
    },
    textGenerationModel(modelId: string) {
      requireId(modelId)
      return createTextGenerationModel(
        id,
        { ...resolveTextConnection(id, modelId, region, text), key },
        fetchImpl
      )
    },
    classificationModel(modelId: string) {
      requireId(modelId)
      const url = classification?.url ?? definition?.classification?.endpoint
      if (!url) throw new TypeError(`Provider ${id} has no classification endpoint.`)
      return createClassificationModel(
        id,
        modelId,
        url,
        key,
        fetchImpl,
        classification?.maxResponseBytes,
        classification?.url ?? definition?.classification?.imageEndpoint ?? url,
        classification?.maxRequestBytes
      )
    }
  })
}
