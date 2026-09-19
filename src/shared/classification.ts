import type { ValidateProviderResult } from './settings'

/** Classification endpoints are not chat providers and never enter conversation model catalogs. */
export const TYPESAFE_MODEL_ID = 'jev-latest'
export type ClassificationAdapter = 'typesafe' | 'openrouter'
export const CLASSIFICATION_MODELS = {
  typesafe: [{ id: TYPESAFE_MODEL_ID, label: 'Jev Latest' }],
  openrouter: [{ id: 'typesafe/jev-1.13', label: 'Jev 1.13' }]
} satisfies Record<ClassificationAdapter, { id: string; label: string }[]>
export type ClassificationBinding = { serviceId: string; modelId?: string }
export type ClassificationServiceView = {
  id: string
  adapter: ClassificationAdapter
  name: string
  providerId?: string
  configured: boolean
  maskedKey?: string
  needsKey?: boolean
}
export type ClassificationSnapshot = {
  revision: number
  services: ClassificationServiceView[]
  capabilitySelection?: ClassificationBinding
  availableProviders: { id: string; name: string; maskedKey?: string }[]
}
export type ClassificationMutation = { revision: number } & (
  | {
      kind: 'save'
      id: string
      adapter: ClassificationAdapter
      name: string
      apiKey?: string
      providerId?: string
    }
  | { kind: 'remove'; id: string }
  | {
      kind: 'bind'
      binding?: ClassificationBinding
    }
)
// Validation failures leave the snapshot unchanged; the outcome is never persisted.
export type ClassificationMutationResult = ClassificationSnapshot & {
  validation?: ValidateProviderResult
}
export type ClassificationProbe = { serviceId: string; revision: number }
export type ClassificationProbeResult = { ok: boolean }

/** Main-process classification port; this callable is never exposed through renderer IPC. */
export type ClassificationUsage = {
  eventId: string
  providerId: string
  model: string
  usage: { inputTokens: number; cacheTokens: number; outputTokens: number; turnCount?: number }
}
export type ClassificationCandidate = {
  name: string
  description: string
  path: string
  source?: 'connector'
}
export type ClassifySkills = (input: {
  text: string
  catalog: ClassificationCandidate[]
  signal: AbortSignal
  observeUsage?: (value: ClassificationUsage) => void
}) => Promise<{ name: string; path: string }[] | undefined>
