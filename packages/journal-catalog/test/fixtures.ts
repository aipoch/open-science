/* Fixture builders preserve inferred mock signatures for behavioral assertions. */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { afterEach, vi } from 'vitest'
import {
  JournalAttributes,
  type JournalDatabase,
  type JournalIntegration,
  type JournalReferenceIdentity
} from '../src/index.js'
import type { JournalImportRow, JournalRequest } from '../src/contracts.js'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.useRealTimers()
})
async function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE Journal(id TEXT PRIMARY KEY,name TEXT NOT NULL,normalizedName TEXT NOT NULL,aliasesJson TEXT NOT NULL DEFAULT '[]',issnsJson TEXT NOT NULL DEFAULT '[]',externalIdsJson TEXT NOT NULL DEFAULT '[]');
 CREATE TABLE JournalDataset(id TEXT PRIMARY KEY,name TEXT,source TEXT NOT NULL,year INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,fieldsJson TEXT NOT NULL,importedAt INTEGER NOT NULL,UNIQUE(source,year));
 CREATE TABLE JournalDatasetEntry(datasetId TEXT NOT NULL REFERENCES JournalDataset(id) ON DELETE CASCADE,journalId TEXT NOT NULL REFERENCES Journal(id) ON DELETE CASCADE,valuesJson TEXT NOT NULL,sourceRow INTEGER NOT NULL,PRIMARY KEY(datasetId,journalId));
 CREATE TABLE TestBinding(itemId TEXT PRIMARY KEY,journalId TEXT NOT NULL REFERENCES Journal(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,revision TEXT NOT NULL);`)
  let queue = Promise.resolve()
  const client: JournalDatabase = {
    async query<T>({ text, values }: import('../src/ports.js').JournalStatement) {
      return db
        .prepare(text)
        .all(
          ...(values.map((value) =>
            value instanceof Date ? value.getTime() : value
          ) as SQLInputValue[])
        ) as T
    },
    async execute({ text, values }) {
      return Number(
        db
          .prepare(text)
          .run(
            ...(values.map((value) =>
              value instanceof Date ? value.getTime() : value
            ) as SQLInputValue[])
          ).changes
      )
    },
    async transaction<T>(operation: (tx: JournalDatabase) => Promise<T>) {
      const preceding = queue
      let release!: () => void
      queue = new Promise<void>((resolve) => {
        release = resolve
      })
      await preceding
      db.exec('BEGIN')
      try {
        const value = await operation(client)
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        release()
      }
    }
  }
  // Domain DTOs supplied by a consumer port, deliberately not Library/Prisma records.
  const references = new Map<
    string,
    JournalReferenceIdentity & { lifecycle: 'active' | 'deleted' }
  >()
  const addReference = (
    id: string,
    identity: JournalReferenceIdentity['identity'] = { name: '', aliases: [], issns: [] },
    extra: Partial<JournalReferenceIdentity> & { lifecycle?: 'active' | 'deleted' } = {}
  ) => {
    const reference = {
      id,
      title: id,
      metadataRevision: 1,
      identity,
      fingerprint: JSON.stringify(identity),
      bindingJournalId: null,
      bindingFingerprint: null,
      bindingRevision: null,
      lifecycle: 'active' as const,
      ...extra
    }
    references.set(id, reference)
    return reference
  }
  const integration: JournalIntegration = {
    warn: vi.fn(),
    references: {
      read: vi.fn<JournalIntegration['references']['read']>(
        async (reader, filter, limit, lifecycle) => {
          const bindings = await reader.query<
            { itemId: string; journalId: string; fingerprint: string; revision: string }[]
          >({ text: 'SELECT * FROM TestBinding', values: [] })
          return [...references.values()]
            .filter(
              (ref) =>
                (lifecycle === 'all' || ref.lifecycle === lifecycle) &&
                (filter.ids ? filter.ids.includes(ref.id) : ref.id > (filter.after ?? ''))
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, limit)
            .map((ref) => {
              const binding = bindings.find((b) => b.itemId === ref.id)
              return {
                ...ref,
                bindingJournalId: binding?.journalId ?? null,
                bindingFingerprint: binding?.fingerprint ?? null,
                bindingRevision: binding?.revision ?? null
              }
            })
        }
      ),
      bindings: async (reader, ids, after) =>
        reader.query({
          text: `SELECT itemId, revision FROM TestBinding WHERE journalId IN (${ids.map(() => '?').join(',')}) AND itemId > ? ORDER BY itemId LIMIT 500`,
          values: [...ids, after]
        }),
      bind: vi.fn<JournalIntegration['references']['bind']>(async (reader, ref, journalId) => {
        if (journalId)
          await reader.execute({
            text: 'INSERT INTO TestBinding VALUES (?, ?, ?, ?) ON CONFLICT(itemId) DO UPDATE SET journalId=excluded.journalId,fingerprint=excluded.fingerprint,revision=excluded.revision',
            values: [ref.id, journalId, ref.fingerprint, randomUUID()]
          })
        else
          await reader.execute({
            text: 'DELETE FROM TestBinding WHERE itemId = ?',
            values: [ref.id]
          })
      })
    }
  }
  const changed = vi.fn()
  const owners: JournalAttributes[] = []
  const createService = (getClient: () => Promise<JournalDatabase> = async () => client) => {
    const owner = new JournalAttributes(getClient, changed, integration)
    owners.push(owner)
    return owner
  }
  const service = createService()
  cleanups.push(async () => {
    for (const owner of owners) await owner.dispose()
    db.close()
  })
  return { service, client, changed, db, integration, references, addReference, createService }
}
// Entirely fictional fixtures, authored independently of user-supplied files and headings.
const fields = [
  { id: 'signal', label: 'Signal index', kind: 'number' as const, colors: {}, visible: true },
  { id: 'band', label: 'Editorial band', kind: 'singleSelect' as const, colors: {}, visible: true }
]
const definition = { source: 'Fictional evaluation', year: 2031, fields }
const row = (overrides: Partial<JournalImportRow> = {}): JournalImportRow => ({
  row: 2,
  name: 'Imaginary Review of Lunar Gardens',
  aliases: ['Imag. Lunar Gard.'],
  issns: ['1234-5679'],
  values: { signal: '<0.5', band: 'Gold' },
  ...overrides
})
async function preview(
  service: JournalAttributes,
  rows = [row()],
  options: Partial<Extract<JournalRequest, { action: 'begin' }>> = {}
): Promise<{ token: string; digest: string }> {
  const { token } = await service.run({ action: 'begin', definition, policy: 'fill', ...options })
  await service.run({ action: 'append', token: token!, offset: 0, rows })
  const result = await service.run({ action: 'preview', token: token!, offset: 0 })
  return { token: token!, digest: result.digest! }
}

export { setup, fields, definition, row, preview }
