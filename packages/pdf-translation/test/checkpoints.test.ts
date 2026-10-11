/* Fixture builders preserve inferred mock signatures for behavioral assertions. */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { sqltag, type Sql } from '@prisma/client/runtime/library'
import { expect, it } from 'vitest'
import { PdfTranslationCheckpoints } from '../src/checkpoints.js'
import type { TranslationDatabase, TranslationTransaction } from '../src/storage.js'

function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE PdfTranslation(id TEXT PRIMARY KEY,pdfDocumentId TEXT NOT NULL,checksum TEXT NOT NULL,sizeBytes BIGINT NOT NULL,revision INTEGER NOT NULL,payloadJson TEXT NOT NULL,layoutSnapshotJson TEXT,createdAt DATETIME NOT NULL,updatedAt DATETIME NOT NULL);
    CREATE TABLE PdfTranslationBlock(translationId TEXT NOT NULL REFERENCES PdfTranslation(id) ON DELETE CASCADE,sourceIndex INTEGER NOT NULL,revision INTEGER NOT NULL,translation TEXT,PRIMARY KEY(translationId,sourceIndex));`)
  let authorized = true
  const statement = (query: TemplateStringsArray | Sql, values: unknown[]) => {
    const sql = 'sql' in query ? query : sqltag(query, ...values)
    return {
      prepared: db.prepare(sql.sql),
      values: sql.values.map((value) =>
        value instanceof Date ? value.getTime() : value
      ) as SQLInputValue[]
    }
  }
  const tx: TranslationTransaction = {
    async $queryRaw<T>(query: TemplateStringsArray | Sql, ...values: unknown[]): Promise<T> {
      const sql = statement(query, values)
      return sql.prepared.all(...sql.values).map((row) => ({
        ...row,
        ...('sizeBytes' in row ? { sizeBytes: BigInt(row.sizeBytes as number) } : {})
      })) as T
    },
    async $executeRaw(query, ...values) {
      const sql = statement(query, values)
      return Number(sql.prepared.run(...sql.values).changes)
    },
    async requireSource(identity) {
      if (!authorized || identity.checksum !== 'a'.repeat(64)) throw new Error('denied')
      return { sizeBytes: 12n }
    },
    async requireDocument(identity, source) {
      await tx.requireSource(identity)
      return `${identity.checksum}:${source.sizeBytes}`
    }
  }
  let queue = Promise.resolve<unknown>(undefined)
  const database: TranslationDatabase = {
    async hasAttachment(id) {
      return id === 'version'
    },
    $transaction(operation) {
      const result = queue.then(async () => {
        db.exec('BEGIN')
        try {
          const value = await operation(tx)
          db.exec('COMMIT')
          return value
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      })
      queue = result.catch(() => undefined)
      return result
    }
  }
  const create = () =>
    new PdfTranslationCheckpoints({
      getClient: async () => database,
      authority: {
        resolveVersion: async (id) =>
          id === 'version' ? { attachmentId: 'attachment', checksum: 'a'.repeat(64) } : undefined
      }
    })
  return {
    create,
    db,
    revoke: () => {
      authorized = false
    }
  }
}
const input = {
  resourceRequestKey: 'reader',
  attachmentVersionId: 'version',
  fingerprint: 'fp',
  language: 'Chinese',
  concurrency: 2,
  glossary: [],
  sources: ['ATP increased.', 'The result was 12.']
}
const model = { frameworkId: 'opencode', modelId: 'model' }
it('persists an edition before inference, resumes sparse progress and fences stale revisions', async () => {
  const h = setup()
  try {
    const store = h.create(),
      checkpoint = (await store.open(input, 'b'.repeat(64), model))!
    expect((await h.create().read('version'))?.key).toBe(checkpoint.key)
    const updated = await store.append(checkpoint, 1, '结果为 12。', new AbortController().signal)
    const reopened = await h.create().read('version', checkpoint.key)
    expect(reopened).toMatchObject({
      revision: updated.revision,
      translatedSourceIndices: [1],
      translations: ['结果为 12。']
    })
    await expect(
      store.append(checkpoint, 0, 'ATP 增加。', new AbortController().signal)
    ).rejects.toThrow('another window')
    expect((await h.create().read('version'))?.translations).toEqual(['结果为 12。'])
    const editions = await store.list('version')
    expect(editions).toHaveLength(1)
    await store.delete({ source: 'version', translationId: editions[0].id })
    expect(await store.read('version')).toBeNull()
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM PdfTranslationBlock').get()?.n).toBe(0)
  } finally {
    h.db.close()
  }
})
it('rechecks source authority inside every transaction and rolls back denied changes', async () => {
  const h = setup()
  try {
    const store = h.create(),
      checkpoint = (await store.open(input, 'b'.repeat(64), model))!
    h.revoke()
    await expect(
      store.append(checkpoint, 0, 'ATP 增加。', new AbortController().signal)
    ).rejects.toThrow('denied')
    await expect(store.read('version')).rejects.toThrow('denied')
    expect(h.db.prepare('SELECT revision FROM PdfTranslation').get()?.revision).toBe(1)
  } finally {
    h.db.close()
  }
})
