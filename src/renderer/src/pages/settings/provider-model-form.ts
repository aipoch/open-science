import {
  PROVIDER_MODEL_LIMIT,
  type ProviderModel
} from '../../../../shared/configured-provider-model'
import type { ReasoningEffortPresetSetting } from '../../../../shared/reasoning-effort'

export type ProviderModelFormRow = {
  rowId: string
  id: string
  displayName?: string
  contextWindow: string
  reasoningEffortPreset: ReasoningEffortPresetSetting
}

export const providerModelFormRow = (model?: ProviderModel): ProviderModelFormRow => ({
  rowId: model?.id || crypto.randomUUID(),
  id: model?.id ?? '',
  displayName: model?.displayName,
  contextWindow: model?.contextWindow?.toString() ?? '',
  reasoningEffortPreset: model?.reasoningEffortPreset ?? 'unsupported'
})

export const providerModelsFromForm = (rows: readonly ProviderModelFormRow[]): ProviderModel[] =>
  rows.map(({ id, displayName, contextWindow, reasoningEffortPreset }) => ({
    id: id.trim(),
    ...(displayName?.trim() && { displayName: displayName.trim() }),
    ...(contextWindow.trim() && { contextWindow: Number(contextWindow) }),
    reasoningEffortPreset
  }))

export function mergeLocalModels(
  rows: ProviderModelFormRow[],
  modelIds: readonly string[]
): ProviderModelFormRow[] {
  const known = new Set(rows.map(({ id }) => id.trim()).filter(Boolean))
  const additions: ProviderModelFormRow[] = []
  for (const rawId of modelIds) {
    const id = rawId.trim()
    if (!id || known.has(id)) continue
    known.add(id)
    additions.push({ ...providerModelFormRow(), id })
  }
  if (!additions.length) return rows
  // Replace untouched blanks and keep each previously configured row.
  const existing = rows.filter(
    ({ id, displayName, contextWindow, reasoningEffortPreset }) =>
      id.trim() ||
      displayName?.trim() ||
      contextWindow.trim() ||
      reasoningEffortPreset !== 'unsupported'
  )
  return [...existing, ...additions].slice(0, PROVIDER_MODEL_LIMIT)
}
