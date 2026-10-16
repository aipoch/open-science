/** Capability selects the invocation contract; provider/model IDs remain opaque wire identities. */
export type ModelCapability = 'text-generation' | 'classification'
export type ModelIdentity<C extends ModelCapability = ModelCapability> = Readonly<{
  providerId: string
  modelId: string
  capability: C
}>
export type ModelDefinition = ModelIdentity &
  Readonly<{
    label: string
    execution: 'remote'
  }>
