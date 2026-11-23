import {
  isReasoningEffortPresetSetting,
  type ReasoningEffortPresetSetting
} from './reasoning-effort'

const localProviderPresetIds = ['llamacpp', 'lmstudio', 'ollama', 'vllm'] as const

export type LocalProviderPresetId = (typeof localProviderPresetIds)[number]

export type LocalProviderModel = Readonly<{
  id: string
  displayName?: string
  contextWindow?: number
  reasoningEffortPreset?: ReasoningEffortPresetSetting
}>

export const LOCAL_PROVIDER_MODEL_LIMIT = 2_000

export function decodeLocalProviderModels(value: unknown): LocalProviderModel[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > LOCAL_PROVIDER_MODEL_LIMIT) return
  const models: LocalProviderModel[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') return
    const { id, displayName, contextWindow, reasoningEffortPreset } = item as Record<
      string,
      unknown
    >
    const modelId = typeof id === 'string' ? id.trim() : ''
    if (!modelId || modelId.length > 512 || ids.has(modelId)) return
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 128))
      return
    if (
      contextWindow !== undefined &&
      (typeof contextWindow !== 'number' ||
        !Number.isSafeInteger(contextWindow) ||
        contextWindow <= 0)
    )
      return
    if (
      reasoningEffortPreset !== undefined &&
      !isReasoningEffortPresetSetting(reasoningEffortPreset)
    )
      return
    ids.add(modelId)
    models.push({
      id: modelId,
      ...(displayName?.trim() && { displayName: displayName.trim() }),
      ...(contextWindow !== undefined && { contextWindow }),
      ...(reasoningEffortPreset !== undefined && { reasoningEffortPreset })
    })
  }
  return models
}

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
