import {
  LOCAL_PROVIDER_MODEL_LIMIT,
  type LocalProviderModel
} from '../../../../shared/local-provider-preset'
import type { ReasoningEffortPresetSetting } from '../../../../shared/reasoning-effort'

export type LocalModelFormRow = {
  rowId: string
  id: string
  displayName?: string
  contextWindow: string
  reasoningEffortPreset: ReasoningEffortPresetSetting
}

export const localModelFormRow = (model?: LocalProviderModel): LocalModelFormRow => ({
  rowId: model?.id || crypto.randomUUID(),
  id: model?.id ?? '',
  displayName: model?.displayName,
  contextWindow: model?.contextWindow?.toString() ?? '',
  reasoningEffortPreset: model?.reasoningEffortPreset ?? 'unsupported'
})

export const localModelsFromForm = (rows: readonly LocalModelFormRow[]): LocalProviderModel[] =>
  rows.map(({ id, displayName, contextWindow, reasoningEffortPreset }) => ({
    id: id.trim(),
    ...(displayName?.trim() && { displayName: displayName.trim() }),
    ...(contextWindow.trim() && { contextWindow: Number(contextWindow) }),
    reasoningEffortPreset
  }))

export function mergeLocalModels(
  rows: LocalModelFormRow[],
  modelIds: readonly string[]
): LocalModelFormRow[] {
  const known = new Set(rows.map(({ id }) => id.trim()).filter(Boolean))
  const additions: LocalModelFormRow[] = []
  for (const rawId of modelIds) {
    const id = rawId.trim()
    if (!id || known.has(id)) continue
    known.add(id)
    additions.push({ ...localModelFormRow(), id })
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
  return [...existing, ...additions].slice(0, LOCAL_PROVIDER_MODEL_LIMIT)
}
