import { OFFICIAL_VENDORS } from './data'
import { classificationProviders, type ClassificationProviderDefinition } from './classification'
import { QWEN3_LOCAL_TEXT_GENERATION_MODEL } from './local-model'
import { getVendorModelIds } from './lookup'
import type { OfficialVendor } from './types'
import type { ModelCapability, ModelDefinition } from '../models/types'

export type ProviderDefinition = Readonly<{
  id: string
  label: string
  textGeneration?: OfficialVendor
  classification?: ClassificationProviderDefinition
  localTextGeneration?: typeof QWEN3_LOCAL_TEXT_GENERATION_MODEL
}>

// A gateway is one provider with several capabilities, not separate competing registries.
const definitions = new Map<string, ProviderDefinition>(
  OFFICIAL_VENDORS.map((text) => [
    text.id,
    Object.freeze({
      id: text.id,
      label: text.label,
      textGeneration: text,
      classification: classificationProviders[text.id]
    })
  ])
)
definitions.set(
  'typesafe',
  Object.freeze({
    id: 'typesafe',
    label: 'TypeSafe',
    classification: classificationProviders.typesafe
  })
)
definitions.set(
  'local',
  Object.freeze({
    id: 'local',
    label: 'Local',
    localTextGeneration: QWEN3_LOCAL_TEXT_GENERATION_MODEL
  })
)

export const getProviderDefinition = (id: string): ProviderDefinition | undefined =>
  definitions.get(id)

/** Bundled suggestions, not an allowlist. Unknown remote model IDs remain usable with explicit configuration. */
export const getProviderModels = (
  providerId: string,
  capability: ModelCapability,
  regionId?: string
): readonly ModelDefinition[] => {
  const definition = definitions.get(providerId)
  if (!definition) return []
  const models =
    capability === 'classification'
      ? (definition.classification?.models ?? []).map((model) => ({
          modelId: model.id,
          label: model.label,
          execution: 'remote' as const
        }))
      : definition.localTextGeneration
        ? [
            {
              modelId: definition.localTextGeneration.id,
              label: 'Qwen3 0.6B q8',
              execution: 'local-worker' as const
            }
          ]
        : definition.textGeneration
          ? getVendorModelIds(definition.textGeneration.id, regionId).map((modelId) => ({
              modelId,
              label: modelId,
              execution: 'remote' as const
            }))
          : []
  return Object.freeze(models.map((model) => Object.freeze({ providerId, capability, ...model })))
}
