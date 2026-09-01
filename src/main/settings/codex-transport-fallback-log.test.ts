import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CodexTransportFallbackLogObserver,
  hasCodexHttpsFallbackAfter,
  readCodexFallbackLogPosition
} from './codex-transport-fallback-log'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const createLogDatabase = async (): Promise<{ codexHome: string; database: DatabaseSync }> => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-transport-log-'))
  roots.push(codexHome)
  const database = new DatabaseSync(join(codexHome, 'logs_2.sqlite'))
  database.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      target TEXT NOT NULL,
      feedback_log_body TEXT
    )
  `)
  return { codexHome, database }
}

describe('Codex transport fallback log cursor', () => {
  it('observes only a Codex client fallback appended after the prompt starts', async () => {
    const { codexHome, database } = await createLogDatabase()
    try {
      const insert = database.prepare(
        'INSERT INTO logs (ts, target, feedback_log_body) VALUES (?, ?, ?)'
      )
      insert.run(100, 'codex_core::client', 'falling back to HTTP')
      const afterId = readCodexFallbackLogPosition(codexHome)
      expect(afterId).toBe(1)

      // These rows deliberately share the previous row's second-resolution timestamp.
      insert.run(100, 'codex_core::responses_retry', 'falling back to HTTP')
      expect(hasCodexHttpsFallbackAfter(codexHome, afterId!)).toBe(false)

      insert.run(100, 'codex_core::client', 'falling back to HTTP')
      expect(hasCodexHttpsFallbackAfter(codexHome, afterId!)).toBe(true)
    } finally {
      database.close()
    }
  })

  it('returns false before Codex has created its log database', () => {
    expect(readCodexFallbackLogPosition('/missing/codex-home')).toBe(0)
    expect(hasCodexHttpsFallbackAfter('/missing/codex-home', 0)).toBe(false)
  })
})

describe('CodexTransportFallbackLogObserver', () => {
  it('checks each completed Codex subscription prompt once from its recorded start time', () => {
    const readFallback = vi.fn(() => true)
    const readPosition = vi.fn(() => 17)
    const observer = new CodexTransportFallbackLogObserver(readFallback, readPosition)
    observer.begin('session-1', {
      framework: { id: 'codex' },
      providerId: 'builtin-codex-subscription',
      adapter: { codexHome: '/codex-home' }
    })

    expect(observer.end('session-1')).toBe(true)
    expect(observer.end('session-1')).toBe(false)
    expect(readFallback).toHaveBeenCalledOnce()
    expect(readPosition).toHaveBeenCalledWith('/codex-home')
    expect(readFallback).toHaveBeenCalledWith('/codex-home', 17)
  })

  it('ignores Codex API providers and non-Codex sessions', () => {
    const readFallback = vi.fn(() => true)
    const observer = new CodexTransportFallbackLogObserver(readFallback)

    observer.begin('official', {
      framework: { id: 'codex' },
      providerId: 'provider-openai',
      adapter: { codexHome: '/codex-home' }
    })
    observer.begin('claude', {
      framework: { id: 'claude-code' },
      providerId: 'builtin-claude-shared',
      adapter: { codexHome: '/codex-home' }
    })

    expect(observer.end('official')).toBe(false)
    expect(observer.end('claude')).toBe(false)
    expect(readFallback).not.toHaveBeenCalled()
  })
})
