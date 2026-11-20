const localProviderPresetIds = ['llamacpp', 'lmstudio', 'ollama', 'vllm'] as const

export type LocalProviderPresetId = (typeof localProviderPresetIds)[number]

export const isLocalProviderPresetId = (value: unknown): value is LocalProviderPresetId =>
  localProviderPresetIds.some((id) => id === value)

type LocalProviderCredentialScope = {
  localPresetId?: LocalProviderPresetId
  baseUrl?: string
}

/** 本地预设改用另一地址时，只在原服务器的凭据作用域内保留旧密钥。 */
export function sameLocalProviderCredentialScope(
  left: LocalProviderCredentialScope,
  right: LocalProviderCredentialScope
): boolean {
  if (!left.localPresetId && !right.localPresetId) return true
  const origin = URL.parse(left.baseUrl ?? '')?.origin
  return origin !== undefined && origin === URL.parse(right.baseUrl ?? '')?.origin
}
