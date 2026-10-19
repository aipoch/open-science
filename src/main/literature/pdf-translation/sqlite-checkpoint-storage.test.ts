import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import {
  createSqliteTranslationTransaction,
  PDF_TRANSLATION_SQLITE_SCHEMA_VERSION,
  type TranslationPayloadCodec,
  type TranslationSqliteExecutor,
  type TranslationSqliteStatement
} from './sqlite-checkpoint-storage'
import {
  PdfTranslationCheckpoints,
  type TranslationDatabase
} from '@aipoch/pdf-translation/storage'
import type { PdfTranslationLayoutSnapshot } from '@aipoch/pdf-translation/contracts'

const connections: DatabaseSync[] = []
afterEach(() => connections.splice(0).forEach((connection) => connection.close()))

// Exercise the host adapter against real SQLite, including its historical on-disk format.
function setup(codec?: TranslationPayloadCodec): {
  database: TranslationDatabase
  connection: DatabaseSync
  revoke(): void
} {
  const connection = new DatabaseSync(':memory:')
  connections.push(connection)
  connection.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE PdfTranslation (
      id TEXT PRIMARY KEY, pdfDocumentId TEXT NOT NULL, checksum TEXT NOT NULL,
      sizeBytes INTEGER NOT NULL, revision INTEGER NOT NULL, payloadJson TEXT NOT NULL,
      layoutSnapshotJson TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE PdfTranslationBlock (
      translationId TEXT NOT NULL REFERENCES PdfTranslation(id) ON DELETE CASCADE,
      sourceIndex INTEGER NOT NULL, revision INTEGER NOT NULL, translation TEXT,
      PRIMARY KEY (translationId, sourceIndex)
    );`)
  let authorized = true
  const prepare = (statement: TranslationSqliteStatement): ReturnType<DatabaseSync['prepare']> =>
    connection.prepare(statement.strings.join('?'))
  const values = (statement: TranslationSqliteStatement): (string | number | bigint | null)[] =>
    statement.values.map((value) => (value instanceof Date ? value.getTime() : value))
  const executor: TranslationSqliteExecutor = {
    async query<T>(statement: TranslationSqliteStatement): Promise<T> {
      const rows = prepare(statement).all(...values(statement))
      // SQLite drivers may return INTEGER as numbers; sizeBytes is the port's bigint field.
      return rows.map((row) =>
        'sizeBytes' in row ? { ...row, sizeBytes: BigInt(row.sizeBytes as number) } : row
      ) as T
    },
    async execute(statement) {
      return Number(prepare(statement).run(...values(statement)).changes)
    }
  }
  const database: TranslationDatabase = {
    canPersist: async () => true,
    async transaction(operation) {
      connection.exec('BEGIN')
      try {
        const value = await operation(
          createSqliteTranslationTransaction(
            executor,
            {
              async requireSource() {
                if (!authorized) throw new Error('denied')
                return { sizeBytes: 12n }
              },
              async requireDocument() {
                return 'document'
              }
            },
            codec
          )
        )
        connection.exec('COMMIT')
        return value
      } catch (error) {
        connection.exec('ROLLBACK')
        throw error
      }
    }
  }
  return {
    database,
    connection,
    revoke: () => {
      authorized = false
    }
  }
}
const input = {
  resourceRequestKey: 'reader',
  sourceId: 'external:paper',
  fingerprint: 'fp',
  language: 'Chinese',
  glossary: [],
  sources: ['ATP increased.', 'The result was 12.']
}
const model = { frameworkId: 'external', modelId: 'model' }
const store = (database: TranslationDatabase): PdfTranslationCheckpoints =>
  new PdfTranslationCheckpoints({
    getClient: async () => database,
    resolveSource: async (sourceId) => ({ sourceId, checksum: 'a'.repeat(64) })
  })

it('reopens SQLite editions, fences stale block writers and scopes reads/deletes to content', async () => {
  expect(PDF_TRANSLATION_SQLITE_SCHEMA_VERSION).toBe(1)
  const h = setup(),
    checkpoints = store(h.database)
  const base = (await checkpoints.open(input, 'b'.repeat(64), model))!
  await checkpoints.append(base, 0, 'ATP 增加。', new AbortController().signal)
  expect(await store(h.database).read(input.sourceId)).toMatchObject({
    translatedSourceIndices: [0],
    translations: ['ATP 增加。']
  })
  await expect(
    checkpoints.append(base, 0, 'ATP 增加。', new AbortController().signal)
  ).rejects.toThrow('another window')
  const [edition] = await checkpoints.list(input.sourceId)
  expect(edition).toMatchObject({ language: 'Chinese', concurrency: 1, glossary: [] })
  await h.database.transaction(async (tx) => {
    expect(await tx.read(edition.id, 'other')).toBeNull()
    expect(await tx.findLatest('document', "' OR 1=1 --")).toBeNull()
    expect(await tx.delete(edition.id, 'other')).toBe(false)
  })
  h.revoke()
  await expect(checkpoints.read(input.sourceId)).rejects.toThrow('denied')
  await h.database.transaction(async (tx) => {
    expect(await tx.delete(edition.id, 'document')).toBe(true)
  })
  expect(h.connection.prepare('SELECT * FROM PdfTranslationBlock').all()).toEqual([])
})

it('preserves legacy identity encoding, pinned layouts, incremental reports and rollback', async () => {
  const codec: TranslationPayloadCodec = {
    encode(payload) {
      const { sourceId, ...rest } = JSON.parse(payload)
      return JSON.stringify({ ...rest, externalFile: sourceId })
    },
    decode(payload) {
      const { externalFile, ...rest } = JSON.parse(payload)
      return JSON.stringify({ ...rest, sourceId: externalFile })
    }
  }
  const h = setup(codec),
    checkpoints = store(h.database)
  const base = (await checkpoints.open(input, 'b'.repeat(64), model))!
  const [edition] = await checkpoints.list(input.sourceId)
  const stored = h.connection.prepare('SELECT payloadJson FROM PdfTranslation').get()!
  expect(JSON.parse(stored.payloadJson as string)).toMatchObject({ externalFile: input.sourceId })
  expect(await store(h.database).read(input.sourceId)).toMatchObject({ sourceId: input.sourceId })
  const next = await checkpoints.append(base, 0, 'ATP 增加。', new AbortController().signal)
  await h.database.transaction(async (tx) => {
    const snapshot: PdfTranslationLayoutSnapshot = {
      version: 1,
      parserVersion: 'test',
      fingerprint: input.fingerprint,
      pages: [{ width: 612, height: 792 }],
      units: input.sources.map((source, index) => ({
        id: `unit-${index}`,
        source,
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 0.1, y: 0.1 + index * 0.2, width: 0.8, height: 0.1 },
            items: [{ index, text: source }]
          }
        ]
      })),
      coverage: {
        pageCount: 1,
        textItemCount: 2,
        includedItemCount: 2,
        excludedItemCount: 0,
        pagesWithoutText: [],
        exclusions: [],
        warnings: []
      }
    }
    await tx.pinLayout(edition.id, snapshot)
    await tx.pinLayout(edition.id, { ...snapshot, parserVersion: 'replacement' })
    expect((await tx.readMetadata(edition.id))?.layoutSnapshot).toEqual(snapshot)
    const reports = [
      {
        sourceIndex: 1,
        sourceHash: 'a'.repeat(64),
        translationHash: 'b'.repeat(64),
        generatedAt: 1
      }
    ]
    expect(
      await tx.commit(edition.id, next.revision, {
        checkpoint: {
          ...next,
          revision: next.revision + 1,
          translatedSourceIndices: [0, 1],
          translations: [...next.translations, '结果为 12。']
        },
        changedBlock: { sourceIndex: 1, translation: '结果为 12。' },
        layoutReports: reports
      })
    ).toBe(true)
    expect(await tx.readLayoutReports(edition.id)).toEqual(reports)
    expect((await tx.read(edition.id))?.checkpoint.sourceId).toBe(input.sourceId)
  })
  const before = h.connection
    .prepare('SELECT * FROM PdfTranslationBlock ORDER BY sourceIndex')
    .all()
  await expect(
    h.database.transaction(async (tx) => {
      await tx.commit(edition.id, next.revision + 1, {
        checkpoint: { ...next, revision: next.revision + 2 },
        changedBlock: { sourceIndex: 1, translation: null }
      })
      throw new Error('cancelled before commit')
    })
  ).rejects.toThrow('cancelled before commit')
  expect(
    h.connection.prepare('SELECT * FROM PdfTranslationBlock ORDER BY sourceIndex').all()
  ).toEqual(before)
})
