import type { ValidateProviderResult } from './settings'

/** Classification endpoints are not chat providers and never enter conversation model catalogs. */
export const TYPESAFE_MODEL_ID = 'jev-latest'
export type ClassificationAdapter = 'typesafe' | 'openrouter' | 'custom'
export type ClassificationModel = { id: string; label: string }
export const CLASSIFICATION_MODELS = {
  typesafe: [{ id: TYPESAFE_MODEL_ID, label: 'Jev Latest' }],
  openrouter: [{ id: 'typesafe/jev-1.13', label: 'Jev 1.13' }]
} satisfies Record<Exclude<ClassificationAdapter, 'custom'>, ClassificationModel[]>

export const classificationModelsForService = (service: {
  adapter: ClassificationAdapter
  models?: readonly string[]
  modelId?: string
}): ClassificationModel[] => {
  if (service.adapter !== 'custom') return CLASSIFICATION_MODELS[service.adapter]
  const models = service.models?.length ? service.models : service.modelId ? [service.modelId] : []
  return models.map((id) => ({ id, label: id }))
}
export type ClassificationBinding = { serviceId: string; modelId?: string }
export type ClassificationServiceView = {
  id: string
  adapter: ClassificationAdapter
  name: string
  baseUrl?: string
  modelId?: string
  providerId?: string
  configured: boolean
  maskedKey?: string
  needsKey?: boolean
}
export type ClassificationSnapshot = {
  revision: number
  services: ClassificationServiceView[]
  smartCollections?: ClassificationBinding
  capabilitySelection?: ClassificationBinding
  availableProviders: { id: string; name: string; maskedKey?: string }[]
}
export type ClassificationMutation = { revision: number } & (
  | {
      kind: 'save'
      id: string
      adapter: ClassificationAdapter
      name: string
      baseUrl?: string
      modelId?: string
      apiKey?: string
      providerId?: string
    }
  | { kind: 'remove'; id: string }
  | {
      kind: 'bind'
      feature?: 'capability-selection' | 'smart-collections'
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
  usageContext?: Pick<ClassificationUsageContext, 'projectId' | 'sessionId'>
  observeUsage?: (value: ClassificationUsage) => void
}) => Promise<{ name: string; path: string }[] | undefined>

export type ClassificationReadingRoute = 'full-document' | 'auto'
export type ClassifyReadingRoute = (input: {
  text: string
  signal?: AbortSignal
  usageContext?: Pick<ClassificationUsageContext, 'projectId' | 'sessionId'>
  observeUsage?: (value: ClassificationUsage) => void
}) => Promise<ClassificationReadingRoute | undefined>

/** A closed Literature decision. Probabilities describe the model, not verified truth. */
export type LiteratureClassificationDecision = {
  evidenceIndex?: number
  verdict: 'match' | 'no-match' | 'uncertain'
  confidence: number
  probabilities: Record<'match' | 'no-match' | 'uncertain', number>
  model: string
}
/** One actual provider request, including retries; missing measurements remain unknown. */
export type ClassificationRequestUsage = Readonly<{
  eventId: string
  providerId: string
  model: string
  occurredAt: number
  status: 'started' | 'completed' | 'failed' | 'interrupted'
  inputTokens?: number
  outputTokens?: number
}>
export type ClassificationUsageContext = Readonly<{
  collectionId?: string
  runId?: string
  projectId?: string
  sessionId?: string
  scenario:
    | 'save-validation'
    | 'probe'
    | 'capability-selection'
    | 'reading-route'
    | 'literature-live-preview'
    | 'literature-trial'
    | 'literature-update'
    | 'literature-reevaluate'
    | 'literature-automatic'
}>

export type ClassifyLiterature = (input: {
  evidence?: {
    coverage: string
    passages: { pageStart: number; pageEnd: number; content: string }[]
  }
  description: string
  title: string
  abstract: string
  signal: AbortSignal
  usageContext?: ClassificationUsageContext
  observeUsage?: (value: ClassificationUsage) => void
}) => Promise<LiteratureClassificationDecision>

export const classificationFailureCategories = [
  'auth',
  'rate-limit',
  'timeout',
  'network',
  'invalid-response',
  'configuration',
  'service',
  'unknown'
] as const
export type ClassificationFailureCategory = (typeof classificationFailureCategories)[number]
export class ClassificationEvaluationError extends Error {
  constructor(readonly category: ClassificationFailureCategory) {
    super('Classification evaluation failed.')
  }
}

export const AUTOMATIC_CLASSIFICATION_RUN_LIMIT = 200
export const AUTOMATIC_CLASSIFICATION_DAY_LIMIT = 1000
export const automaticClassificationPauseReasons = [
  'run-limit',
  'daily-limit',
  'storage-error',
  'interrupted'
] as const
export type AutomaticClassificationPauseReason =
  (typeof automaticClassificationPauseReasons)[number]
export class AutomaticClassificationPausedError extends Error {
  constructor(readonly reason: AutomaticClassificationPauseReason) {
    super('Automatic classification paused.')
  }
}
