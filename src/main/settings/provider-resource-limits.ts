import type { ProviderDraft } from '../../shared/settings'

const PROVIDER_RESOURCE_LIMITS = Object.freeze({
  providers: 64,
  nameCharacters: 128,
  baseUrlCharacters: 2_048,
  modelIdCharacters: 512,
  apiKeyBytes: 16 * 1024,
  fetchedModels: 2_000,
  modelListResponseBytes: 2 * 1024 * 1024,
  validationResponseBytes: 1024 * 1024
})

const characterCount = (value: string): number => Array.from(value).length

const assertCharacterLimit = (value: string | undefined, limit: number, label: string): void => {
  if (value !== undefined && characterCount(value) > limit) {
    throw new Error(`${label} must not exceed ${limit} characters.`)
  }
}

const assertProviderDraftLimits = (draft: ProviderDraft): void => {
  assertCharacterLimit(draft.name, PROVIDER_RESOURCE_LIMITS.nameCharacters, 'Provider name')
  assertCharacterLimit(draft.baseUrl, PROVIDER_RESOURCE_LIMITS.baseUrlCharacters, 'Base URL')
  assertCharacterLimit(draft.model, PROVIDER_RESOURCE_LIMITS.modelIdCharacters, 'Model ID')

  if (
    draft.key !== undefined &&
    Buffer.byteLength(draft.key, 'utf8') > PROVIDER_RESOURCE_LIMITS.apiKeyBytes
  ) {
    throw new Error(`API key must not exceed ${PROVIDER_RESOURCE_LIMITS.apiKeyBytes} bytes.`)
  }
}

const assertProviderModelLimit = (model: string | undefined): void => {
  assertCharacterLimit(model, PROVIDER_RESOURCE_LIMITS.modelIdCharacters, 'Model ID')
}

const assertProviderCapacity = (providerCount: number, editingExisting: boolean): void => {
  if (!editingExisting && providerCount >= PROVIDER_RESOURCE_LIMITS.providers) {
    throw new Error(`Provider limit of ${PROVIDER_RESOURCE_LIMITS.providers} reached.`)
  }
}

export {
  PROVIDER_RESOURCE_LIMITS,
  assertProviderCapacity,
  assertProviderDraftLimits,
  assertProviderModelLimit
}
