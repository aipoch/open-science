export const TYPESAFE_MODEL_ID = 'jev-latest'
export type ClassificationAdapter = 'typesafe' | 'openrouter' | 'opencode' | 'custom'
export type ClassificationModelDefinition = Readonly<{ id: string; label: string }>
export type ClassificationProviderDefinition = Readonly<{
  endpoint: string
  imageEndpoint?: string
  models: readonly ClassificationModelDefinition[]
}>
const definitions = {
  typesafe: {
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    models: [
      { id: TYPESAFE_MODEL_ID, label: 'Jev Latest' },
      { id: 'jev-preview', label: 'Jev Preview' }
    ]
  },
  openrouter: {
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    imageEndpoint: 'https://openrouter.ai/api/v1/systemone',
    models: [
      { id: 'typesafe/jev-1.13', label: 'Jev 1.13' },
      { id: 'typesafe/jev-1.14', label: 'Jev 1.14' }
    ]
  },
  opencode: {
    endpoint: 'https://opencode.ai/zen/v1/systemone',
    models: [
      { id: 'jev-1.13', label: 'Jev 1.13' },
      { id: 'jev-1.13-free', label: 'Jev 1.13 Free' }
    ]
  }
} satisfies Record<Exclude<ClassificationAdapter, 'custom'>, ClassificationProviderDefinition>

export const classificationProviders: Readonly<
  Record<string, ClassificationProviderDefinition | undefined>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(definitions).map(([id, definition]) => [
      id,
      Object.freeze({
        ...definition,
        models: Object.freeze(definition.models.map((model) => Object.freeze(model)))
      })
    ])
  )
)
