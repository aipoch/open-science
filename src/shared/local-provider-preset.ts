export {
  decodeProviderModels as decodeLocalProviderModels,
  PROVIDER_MODEL_LIMIT as LOCAL_PROVIDER_MODEL_LIMIT,
  type ProviderModel as LocalProviderModel
} from './configured-provider-model'

const localProviderPresetIds = ['llamacpp', 'lmstudio', 'ollama', 'vllm'] as const

export type LocalProviderPresetId = (typeof localProviderPresetIds)[number]

export const isLocalProviderPresetId = (value: unknown): value is LocalProviderPresetId =>
  localProviderPresetIds.some((id) => id === value)

type LocalProviderCredentialScope = {
  localPresetId?: LocalProviderPresetId
  baseUrl?: string
}

/** Keep a preset API key only when the server origin stays the same. */
export function sameLocalProviderCredentialScope(
  left: LocalProviderCredentialScope,
  right: LocalProviderCredentialScope
): boolean {
  if (!left.localPresetId && !right.localPresetId) return true
  const origin = URL.parse(left.baseUrl ?? '')?.origin
  return origin !== undefined && origin === URL.parse(right.baseUrl ?? '')?.origin
}
