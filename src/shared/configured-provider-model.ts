import {
  isReasoningEffortPresetSetting,
  type ReasoningEffortPresetSetting
} from './reasoning-effort'

export type ProviderModel = Readonly<{
  id: string
  displayName?: string
  contextWindow?: number
  reasoningEffortPreset?: ReasoningEffortPresetSetting
}>

export const PROVIDER_MODEL_LIMIT = 2_000

export function decodeProviderModels(value: unknown): ProviderModel[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > PROVIDER_MODEL_LIMIT) return
  const models: ProviderModel[] = []
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
