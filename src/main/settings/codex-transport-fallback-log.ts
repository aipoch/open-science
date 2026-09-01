import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'

import { isCodexSubscriptionProviderId } from '../../shared/settings'

const codexLogDatabasePath = (codexHome: string): string => join(codexHome, 'logs_2.sqlite')

// Native Codex timestamps have one-second precision, so time comparisons cannot distinguish an
// earlier fallback from a prompt that starts later in the same second. Capture the append-only row
// position at prompt start instead. A missing database is position zero; an unreadable existing
// database disables observation for that prompt so old rows cannot be mistaken for new ones.
export const readCodexFallbackLogPosition = (codexHome: string): number | undefined => {
  if (!codexHome.trim()) return undefined
  const databasePath = codexLogDatabasePath(codexHome)
  if (!existsSync(databasePath)) return 0

  let database: NodeDatabaseSync | undefined
  try {
    const sqlite = process.getBuiltinModule('node:sqlite') as
      typeof import('node:sqlite') | undefined
    if (!sqlite) return undefined
    const { DatabaseSync } = sqlite
    database = new DatabaseSync(databasePath, { readOnly: true })
    const row = database.prepare('SELECT MAX(id) AS id FROM logs').get() as
      { id?: number | null } | undefined
    return typeof row?.id === 'number' && Number.isSafeInteger(row.id) ? row.id : 0
  } catch {
    return undefined
  } finally {
    database?.close()
  }
}

// Query only rows appended after the captured prompt boundary and return a boolean; prompt content
// and other diagnostic fields never leave SQLite.
export const hasCodexHttpsFallbackAfter = (codexHome: string, afterId: number): boolean => {
  if (!codexHome.trim() || !Number.isSafeInteger(afterId) || afterId < 0) return false

  let database: NodeDatabaseSync | undefined
  try {
    const sqlite = process.getBuiltinModule('node:sqlite') as
      typeof import('node:sqlite') | undefined
    if (!sqlite) return false
    const { DatabaseSync } = sqlite
    database = new DatabaseSync(codexLogDatabasePath(codexHome), { readOnly: true })
    return (
      database
        .prepare(
          `SELECT 1
             FROM logs
            WHERE id > ?
              AND target = 'codex_core::client'
              AND feedback_log_body LIKE '%falling back to HTTP%'
            LIMIT 1`
        )
        .get(afterId) !== undefined
    )
  } catch {
    // The database does not exist until native Codex emits its first structured log. A locked,
    // unavailable, or older-schema database must not affect an otherwise successful prompt.
    return false
  } finally {
    database?.close()
  }
}

type ObservableBackend = Readonly<{
  framework: Readonly<{ id: string }>
  providerId?: string
  adapter: Readonly<{ codexHome?: string }>
}>

type FallbackReader = (codexHome: string, afterId: number) => boolean
type PositionReader = (codexHome: string) => number | undefined

export class CodexTransportFallbackLogObserver {
  private readonly prompts = new Map<string, { codexHome: string; afterId: number }>()

  constructor(
    private readonly readFallback: FallbackReader = hasCodexHttpsFallbackAfter,
    private readonly readPosition: PositionReader = readCodexFallbackLogPosition
  ) {}

  begin(sessionId: string, backend: ObservableBackend | undefined): void {
    const codexHome = backend?.adapter.codexHome?.trim()
    if (
      backend?.framework.id !== 'codex' ||
      backend.providerId === undefined ||
      !isCodexSubscriptionProviderId(backend.providerId) ||
      !codexHome
    ) {
      this.prompts.delete(sessionId)
      return
    }
    const afterId = this.readPosition(codexHome)
    if (afterId === undefined) {
      this.prompts.delete(sessionId)
      return
    }
    this.prompts.set(sessionId, { codexHome, afterId })
  }

  end(sessionId: string): boolean {
    const prompt = this.prompts.get(sessionId)
    this.prompts.delete(sessionId)
    return prompt ? this.readFallback(prompt.codexHome, prompt.afterId) : false
  }
}
