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

export type ClassificationUsageContext = {
  collectionId?: string
  runId?: string
  scenario:
    | 'literature-live-preview'
    | 'literature-trial'
    | 'literature-update'
    | 'literature-reevaluate'
    | 'literature-automatic'
}
export type ClassifyLiterature = (input: {
  description: string
  title: string
  abstract: string
  signal: AbortSignal
  evidence?: {
    coverage: string
    passages: { pageStart: number; pageEnd: number; content: string }[]
  }
  usageContext?: ClassificationUsageContext
  observeUsage?: (value: {
    eventId: string
    providerId: string
    model: string
    usage: { inputTokens: number; outputTokens: number; cacheTokens: number; turnCount?: number }
  }) => void
}) => Promise<{
  verdict: 'match' | 'no-match' | 'uncertain'
  model: string
  confidence: number
  probabilities: Record<'match' | 'no-match' | 'uncertain', number>
  evidenceIndex?: number
}>
export type ScreeningClassifier = {
  policy(): Promise<{ key: string; configured: boolean; model?: string }>
  classifyLiterature: ClassifyLiterature
  subscribe?: (listener: () => void) => () => void
}
