import type { LiteratureFullTextIndex, LiteratureIndexChunk } from '@aipoch/literature-reading'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createIndex,
  sql as migrationSqlExecutor,
  openDatabase
} from './full-text-index-sqlite-fixture'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

describe('LiteratureFullTextIndex', () => {
  let root: string
  let owner: ReturnType<typeof createIndex>
  let index: LiteratureFullTextIndex

  beforeEach(async () => {
    owner = undefined!
    root = await mkdtemp(join(tmpdir(), 'literature-index-'))
    owner ??= createIndex(root)
    index = await owner.open()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await owner.flushPendingAccesses()
    await index.close()
    await rm(root, { recursive: true, force: true })
  })

  const setLastAccessed = async (value: string): Promise<void> => {
    const client = openDatabase(root)
    await client.execute(
      `UPDATE "LiteratureIndexDocument" SET "lastAccessedAt" = datetime('now', ?)`,
      value
    )
    await client.close()
  }

  const lastAccessedEpoch = async (): Promise<number> => {
    const client = openDatabase(root)
    const rows = await client.query<Array<{ value: bigint | number }>>(
      `SELECT CAST(strftime('%s', "lastAccessedAt") AS INTEGER) AS "value" FROM "LiteratureIndexDocument" LIMIT 1`
    )
    await client.close()
    return Number(rows[0]?.value ?? 0)
  }

  it('retains selected matches when unrelated documents enter or leave the shared index', async () => {
    const chunks = (contents: string[]): LiteratureIndexChunk[] =>
      contents.map((content, index) => ({
        pageStart: index + 1,
        pageEnd: index + 1,
        textStart: index * 100,
        textEnd: index * 100 + content.length,
        content
      }))
    await index.replace({
      extractionId: 'selected',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: chunks(['alpha', 'beta'])
    })
    const query = { extractionIds: ['selected'], query: 'alpha beta' }
    const before = await index.search(query)
    expect(before.map(({ content }) => content).sort()).toEqual(['alpha', 'beta'])
    await index.replace({
      extractionId: 'unselected',
      documentChecksum: HASH_B,
      extractorFingerprint: HASH_B,
      chunks: chunks(Array.from({ length: 30 }, () => 'alpha'))
    })
    const during = await index.search(query)
    expect(during.every(({ extractionId }) => extractionId === 'selected')).toBe(true)
    expect.soft(during.map(({ content }) => content).sort()).toEqual(['alpha', 'beta'])
    await index.deleteExtraction('unselected')
    const after = await index.search(query)
    expect(after.map(({ content }) => content).sort()).toEqual(['alpha', 'beta'])
  })

  it('replaces PDF chunks and retrieves matching passages with page locators', async () => {
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 45,
          sectionTitle: 'Introduction',
          content: 'Prior work discussed unrelated observations.'
        },
        {
          pageStart: 3,
          pageEnd: 3,
          textStart: 46,
          textEnd: 102,
          sectionTitle: 'Methods',
          content: 'The cohort used a randomized controlled study design.'
        }
      ]
    })

    await expect(
      index.search({ extractionIds: ['extraction-1'], query: 'randomized study' })
    ).resolves.toEqual([
      expect.objectContaining({
        extractionId: 'extraction-1',
        pageStart: 3,
        sectionTitle: 'Methods',
        content: 'The cohort used a randomized controlled study design.'
      })
    ])
  })

  it('deletes stale FTS rows when an extraction is replaced', async () => {
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 13,
          content: 'legacy phrase'
        }
      ]
    })
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 2,
          pageEnd: 2,
          textStart: 0,
          textEnd: 11,
          content: 'current text'
        }
      ]
    })

    await expect(
      index.search({ extractionIds: ['extraction-1'], query: 'legacy' })
    ).resolves.toEqual([])
    await expect(
      index.search({ extractionIds: ['extraction-1'], query: 'current' })
    ).resolves.toHaveLength(1)

    await index.deleteExtraction('extraction-1')
    await expect(
      index.search({ extractionIds: ['extraction-1'], query: 'current' })
    ).resolves.toEqual([])
  })

  it('does not run retention work on the ordinary search open path', async () => {
    await index.replace({
      extractionId: 'expired-extraction',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 12,
          content: 'expired text'
        }
      ]
    })
    await index.close()

    await setLastAccessed('-2 days')

    index = await owner.open()
    await expect(index.hasExtraction('expired-extraction')).resolves.toBe(true)
  })

  it('sweeps an existing idle sidecar without waiting for another search', async () => {
    await index.replace({
      extractionId: 'expired-extraction',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 12,
          content: 'expired text'
        }
      ]
    })
    await setLastAccessed('-2 days')
    await index.close()

    await owner.sweepExpired()
    index = await owner.open()

    await expect(index.hasExtraction('expired-extraction')).resolves.toBe(false)
  })

  it('batches access timestamps instead of writing on every search', async () => {
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 14,
          content: 'retrieval text'
        }
      ]
    })
    await setLastAccessed('-12 hours')
    const beforeSearch = await lastAccessedEpoch()

    await index.search({ extractionIds: ['extraction-1'], query: 'retrieval' })
    expect(await lastAccessedEpoch()).toBe(beforeSearch)

    await owner.flushPendingAccesses()
    expect(await lastAccessedEpoch()).toBeGreaterThan(beforeSearch)
  })

  it('flushes pending accesses before removing idle indexes', async () => {
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 14,
          content: 'retrieval text'
        }
      ]
    })
    await setLastAccessed('-2 days')
    await index.search({ extractionIds: ['extraction-1'], query: 'retrieval' })

    await owner.sweepExpired()

    await expect(index.hasExtraction('extraction-1')).resolves.toBe(true)
  })

  it('does not purge an idle index while a search is using it', async () => {
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 14,
          content: 'retrieval text'
        }
      ]
    })
    await setLastAccessed('-2 days')

    let releaseSearch!: () => void
    const searchRelease = new Promise<void>((resolve) => {
      releaseSearch = resolve
    })
    let searchRead!: () => void
    const searchReadStarted = new Promise<void>((resolve) => {
      searchRead = resolve
    })
    const originalQuery = migrationSqlExecutor.query.bind(migrationSqlExecutor)
    vi.spyOn(migrationSqlExecutor, 'query').mockImplementation(async (...args) => {
      const rows = await originalQuery(...args)
      if (String(args[1]).includes('FROM "LiteratureIndexChunkFts"')) {
        searchRead()
        await searchRelease
      }
      return rows
    })

    const search = index.search({ extractionIds: ['extraction-1'], query: 'retrieval' })
    await searchReadStarted
    const sweep = owner.sweepExpired()
    setTimeout(releaseSearch, 50)
    await Promise.all([search, sweep])

    await expect(index.hasExtraction('extraction-1')).resolves.toBe(true)
  })

  it('creates sidecars with incremental auto-vacuum enabled', async () => {
    const client = openDatabase(root)
    const rows = await client.query<Array<{ autoVacuum: bigint | number }>>(
      `SELECT "auto_vacuum" AS "autoVacuum" FROM pragma_auto_vacuum`
    )
    await client.close()

    expect(Number(rows[0]?.autoVacuum)).toBe(2)
  })

  it('flushes hourly and sweeps every three hours until stopped', async () => {
    vi.useFakeTimers()
    const sweep = vi.spyOn(owner, 'sweepExpired').mockResolvedValue(undefined)
    const flush = vi.spyOn(owner, 'flushPendingAccesses').mockResolvedValue(undefined)
    const stop = owner.startRetentionSweep(vi.fn())

    await Promise.resolve()
    expect(sweep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(flush).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)
    expect(sweep).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenCalledTimes(4)

    await stop()
    expect(flush).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)
    expect(sweep).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenCalledTimes(5)
  })

  it('ranks weaker matches after stronger evidence without excluding them', async () => {
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 66,
          content: 'corrective retrieval augmented generation retrieval corrective generation'
        },
        {
          pageStart: 2,
          pageEnd: 2,
          textStart: 67,
          textEnd: 91,
          content: 'corrective background note'
        },
        {
          pageStart: 3,
          pageEnd: 3,
          textStart: 92,
          textEnd: 119,
          content: 'unrelated control material'
        }
      ]
    })

    const results = await index.search({
      extractionIds: ['extraction-1'],
      query: 'corrective retrieval augmented generation'
    })

    expect(results).toEqual([
      expect.objectContaining({
        pageStart: 1,
        relativeScore: 1
      }),
      expect.objectContaining({ pageStart: 2 })
    ])
  })

  it('removes substantially overlapping candidates from the final result set', async () => {
    await index.replace({
      extractionId: 'extraction-1',
      documentChecksum: HASH_A,
      extractorFingerprint: HASH_B,
      chunks: [
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 0,
          textEnd: 80,
          content: 'retrieval evaluator identifies incorrect documents and corrects retrieval'
        },
        {
          pageStart: 1,
          pageEnd: 1,
          textStart: 20,
          textEnd: 100,
          content: 'retrieval evaluator identifies incorrect documents before generation'
        },
        {
          pageStart: 2,
          pageEnd: 2,
          textStart: 101,
          textEnd: 170,
          content: 'retrieval evaluation also improves generation on benchmark datasets'
        }
      ]
    })

    const results = await index.search({
      extractionIds: ['extraction-1'],
      query: 'retrieval evaluator generation'
    })

    expect(results.filter(({ pageStart }) => pageStart === 1)).toHaveLength(1)
    expect(results.some(({ pageStart }) => pageStart === 2)).toBe(true)
  })
})

it('closes a connection when schema admission fails', async () => {
  const { openSqliteLiteratureIndex } = await import('./full-text-index-storage')
  const root = await mkdtemp(join(tmpdir(), 'index-schema-failure-'))
  const db = openDatabase(root)
  const close = vi.spyOn(db, 'close')
  try {
    await db.execute('PRAGMA user_version = 999')
    await expect(openSqliteLiteratureIndex(db, () => {})).rejects.toThrow('not supported')
    expect(close).toHaveBeenCalledOnce()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rolls back replacement after a chunk insertion fails and keeps searchable prior content', async () => {
  const { openSqliteLiteratureIndex } = await import('./full-text-index-storage')
  const root = await mkdtemp(join(tmpdir(), 'index-rollback-'))
  const db = openDatabase(root)
  const store = await openSqliteLiteratureIndex(db, () => {})
  const input = {
    extractionId: 'extraction',
    documentChecksum: HASH_A,
    extractorFingerprint: HASH_B,
    chunks: [{ pageStart: 1, pageEnd: 1, textStart: 0, textEnd: 8, content: 'original' }]
  }
  try {
    await store.replace(input)
    const execute = db.execute.bind(db)
    vi.spyOn(db, 'execute').mockImplementation(async (statement, ...values) => {
      if (statement.startsWith('INSERT INTO "LiteratureIndexChunk"')) throw new Error('disk full')
      return execute(statement, ...values)
    })
    await expect(
      store.replace({ ...input, chunks: [{ ...input.chunks[0], content: 'replaced' }] })
    ).rejects.toThrow('disk full')
    expect(
      await store.search({ extractionIds: ['extraction'], terms: ['original'], limit: 3 })
    ).toEqual([expect.objectContaining({ content: 'original' })])
    expect(
      await store.search({ extractionIds: ['extraction'], terms: ['replaced'], limit: 3 })
    ).toEqual([])
  } finally {
    await store.close()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})
