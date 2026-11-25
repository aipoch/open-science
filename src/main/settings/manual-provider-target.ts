import {
  configuredProviderConnectionKind,
  configuredProviderModelError,
  resolveConfiguredProviderConnection,
  type ConfiguredProviderConnectionInput,
  type ResolvedConfiguredProviderConnection,
  type OfficialVendorId
} from '@aipoch/providers'
import type { ResolvedProvider } from './provider-env'

/** Map provider validation results to errors used by the settings service. */
export function requireConfiguredProviderConnection(
  vendorId: OfficialVendorId,
  input: ConfiguredProviderConnectionInput,
  models: readonly (string | undefined)[]
): ResolvedConfiguredProviderConnection {
  const connection = resolveConfiguredProviderConnection(vendorId, input)
  if (!connection) {
    throw new Error(
      configuredProviderConnectionKind(vendorId) === 'cloudflare'
        ? 'Cloudflare Account ID and Gateway ID are required.'
        : 'Enter a valid provider endpoint.'
    )
  }
  for (const model of models) {
    const problem = configuredProviderModelError(connection, model)
    if (problem === 'model-required') throw new Error('Model is required.')
    if (problem === 'incompatible-model')
      throw new Error('A model ID is incompatible with the selected Cloudflare connection mode.')
  }
  return connection
}

export function resolveConfiguredProviderTarget(
  vendorId: OfficialVendorId,
  input: ConfiguredProviderConnectionInput,
  model?: string,
  key?: string,
  modelIds?: readonly string[]
): ResolvedProvider {
  const { protocol, baseUrl, cloudflare, requestPolicy } = requireConfiguredProviderConnection(
    vendorId,
    input,
    modelIds ? [model, ...modelIds] : [model]
  )
  return {
    type: 'custom',
    vendorId,
    baseUrl,
    ...(protocol === 'chat-completions' && { chatCompletionsBaseUrl: baseUrl }),
    ...(protocol === 'responses' && { responsesBaseUrl: baseUrl }),
    ...(requestPolicy && { requestPolicy }),
    ...(cloudflare && { cloudflareMode: cloudflare.mode }),
    model: model?.trim(),
    apiEndpoints: [protocol],
    key: key?.trim()
  }
}
