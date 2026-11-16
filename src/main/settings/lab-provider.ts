import { randomUUID } from 'node:crypto'

import type { ModelProtocol } from '@aipoch/providers'

import type { LabBootstrap } from '../../shared/lab'
import {
  isLabDeploymentUrl,
  joinLabBaseUrl,
  labModelId,
  labProtocolsToEndpoints,
  labProviderApiEndpoints
} from '../../shared/lab'
import { LAB_PROVIDER_ID, labProviderIdentity } from '../../shared/settings'
import type { LabModelCapabilities } from '../../shared/lab'
import type { StoredProvider } from './types'

// Pure helpers for the single `builtin-lab` provider record. The record is derived entirely from
// GET /api/me/bootstrap: models are namespaced for the renderer, while the wire model id is the raw
// public id the gateway expects.

export const labProviderModels = (bootstrap: LabBootstrap): string[] =>
  bootstrap.models
    .filter((model) => model.enabled !== false && model.available !== false)
    .map((model) => labModelId(model.id))
    .slice(0, 500)

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
  const models = bootstrap.models.filter(
    (model) => model.enabled !== false && model.available !== false
  )
  const modelProtocols: Record<string, ModelProtocol[]> = Object.fromEntries(
    models.map((model) => {
      const endpoints = labProtocolsToEndpoints(model)
      return [labModelId(model.id), endpoints.length > 0 ? endpoints : ['chat-completions']]
    })
  )
  const modelCapabilities: Record<string, LabModelCapabilities> = Object.fromEntries(
    models.flatMap((model) =>
      model.capabilities ? [[labModelId(model.id), model.capabilities] as const] : []
    )
  )
  const modelStreaming: Record<string, boolean> = Object.fromEntries(
    models.flatMap((model) =>
      model.streaming !== undefined ? [[labModelId(model.id), model.streaming] as const] : []
    )
  )
  return {
    ...labProviderIdentity(),
    type: 'lab',
    baseUrl: joinLabBaseUrl(serverUrl, bootstrap.model_base_url),
    labServerUrl: serverUrl.replace(/\/+$/u, ''),
    labCatalogToken: randomUUID(),
    apiEndpoints: labProviderApiEndpoints(bootstrap.models),
    fetchedModels: labProviderModels(bootstrap),
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
