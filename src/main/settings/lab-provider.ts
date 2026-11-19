import { randomUUID } from 'node:crypto'

import {
  isLabDeploymentUrl,
  joinLabBaseUrl,
  labAvailableModels,
  labModelIdFromBootstrap,
  type LabBootstrap,
  type LabModelCapabilities
} from '../../shared/lab'
import { LAB_PROVIDER_ID, labProviderIdentity } from '../../shared/settings-runtime'
import { LAB_RESOURCE_LIMITS } from './lab-resource-limits'
import type { StoredProvider } from './types'

// Pure helpers for the single `builtin-lab` provider record. The record is derived entirely from
// GET /api/me/bootstrap: models are namespaced for the renderer, while the wire model id is the raw
// public id the gateway expects.

export const buildLabProviderRecord = (
  serverUrl: string,
  bootstrap: LabBootstrap
): StoredProvider => {
  if (
    bootstrap.model_base_url?.trim() &&
    /^https?:\/\//iu.test(bootstrap.model_base_url.trim()) &&
    !isLabDeploymentUrl(serverUrl, bootstrap.model_base_url.trim())
  ) {
    throw new Error('Lab model_base_url must stay on the configured deployment.')
  }
  const models = labAvailableModels(bootstrap.models)
    .slice(0, LAB_RESOURCE_LIMITS.maxModels)
    .map((model) => ({ ...model, id: labModelIdFromBootstrap(model.id) }))
  const fetchedModels = models.map(({ id }) => id)
  const defaultModel = bootstrap.default_model_id
    ? labModelIdFromBootstrap(bootstrap.default_model_id)
    : undefined
  const modelProtocols = Object.fromEntries(models.map(({ id, endpoints }) => [id, endpoints]))
  const modelCapabilities: Record<string, LabModelCapabilities> = Object.fromEntries(
    models.flatMap((model) => (model.capabilities ? [[model.id, model.capabilities] as const] : []))
  )
  const modelStreaming: Record<string, boolean> = Object.fromEntries(
    models.flatMap((model) =>
      model.streaming !== undefined ? [[model.id, model.streaming] as const] : []
    )
  )
  return {
    ...labProviderIdentity(),
    type: 'lab',
    baseUrl: joinLabBaseUrl(serverUrl, bootstrap.model_base_url),
    labServerUrl: serverUrl.replace(/\/+$/u, ''),
    labCatalogToken: randomUUID(),
    apiEndpoints: [...new Set(models.flatMap(({ endpoints }) => endpoints))],
    fetchedModels,
    ...(defaultModel && fetchedModels.includes(defaultModel) ? { model: defaultModel } : {}),
    ...(Object.keys(modelProtocols).length > 0 ? { modelProtocols } : {}),
    ...(Object.keys(modelCapabilities).length > 0 ? { modelCapabilities } : {}),
    ...(Object.keys(modelStreaming).length > 0 ? { modelStreaming } : {})
  }
}

export const isLabProviderRecordCurrent = (provider: StoredProvider, serverUrl: string): boolean =>
  provider.id === LAB_PROVIDER_ID &&
  provider.type === 'lab' &&
  provider.baseUrl !== undefined &&
  provider.baseUrl.startsWith(serverUrl.replace(/\/+$/u, ''))
