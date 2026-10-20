import type { TranslationUsageContext } from './inference.js'
export type TranslationUsageUpdate = {
  status: 'completed' | 'failed' | 'interrupted'
  completedAt: Date
  model?: string
  inputTokens: bigint | null
  cacheTokens: bigint | null
  cachedReadTokens: bigint | null
  cachedWriteTokens: bigint | null
  outputTokens: bigint | null
  usageIncomplete: boolean
}
export interface TranslationUsageRepository {
  recoverStarted(): Promise<unknown>
  createAttempt(
    input: TranslationUsageContext & { eventId: string; occurredAt: Date; status: 'started' }
  ): Promise<unknown>
  /** Atomically update only started/interrupted attempts; repeated completion is a no-op. */
  completeAttempt(eventId: string, data: TranslationUsageUpdate): Promise<{ count: number }>
  hasAttempt(eventId: string): Promise<boolean>
}
