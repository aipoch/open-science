import type {
  TranslationUsageRepository,
  TranslationUsageUpdate
} from '../../src/public-storage.js'

type Attempt = Parameters<TranslationUsageRepository['createAttempt']>[0]
type Row = Omit<Attempt, 'status'> &
  Partial<Omit<TranslationUsageUpdate, 'status'>> & {
    status: 'started' | TranslationUsageUpdate['status']
  }

export function memoryUsage(): { repository: TranslationUsageRepository; rows: Map<string, Row> } {
  const rows = new Map<string, Row>()
  const repository: TranslationUsageRepository = {
    async recoverStarted() {
      for (const row of rows.values()) if (row.status === 'started') row.status = 'interrupted'
    },
    async createAttempt(input) {
      rows.set(input.eventId, {
        ...input,
        inputTokens: null,
        outputTokens: null,
        usageIncomplete: true
      })
    },
    async completeAttempt(eventId, update) {
      const row = rows.get(eventId)
      if (!row || !['started', 'interrupted'].includes(row.status)) return { count: 0 }
      Object.assign(row, update)
      return { count: 1 }
    },
    async hasAttempt(eventId) {
      return rows.has(eventId)
    }
  }
  return { repository, rows }
}
