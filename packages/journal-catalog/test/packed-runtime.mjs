/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import * as journalApi from '@aipoch/journal-catalog'
import { JournalAttributes } from '@aipoch/journal-catalog'
import { readJournalFile, createJournalTemplate } from '@aipoch/journal-catalog/files'
assert.equal('matchJournal' in journalApi, false)
const template = await createJournalTemplate()
assert.ok((await readJournalFile(template, 'template.xlsx')).rows.length > 0)
const db = new DatabaseSync(':memory:')
db.exec(`CREATE TABLE Journal(id TEXT PRIMARY KEY,name TEXT NOT NULL,normalizedName TEXT NOT NULL,aliasesJson TEXT NOT NULL DEFAULT '[]',issnsJson TEXT NOT NULL DEFAULT '[]',externalIdsJson TEXT NOT NULL DEFAULT '[]');
CREATE TABLE JournalDataset(id TEXT PRIMARY KEY,name TEXT,source TEXT NOT NULL,year INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,fieldsJson TEXT NOT NULL,importedAt INTEGER NOT NULL,UNIQUE(source,year));
CREATE TABLE JournalDatasetEntry(datasetId TEXT NOT NULL REFERENCES JournalDataset(id) ON DELETE CASCADE,journalId TEXT NOT NULL REFERENCES Journal(id) ON DELETE CASCADE,valuesJson TEXT NOT NULL,sourceRow INTEGER NOT NULL,PRIMARY KEY(datasetId,journalId));`)
const parameters = (values) =>
  values.map((value) => (value instanceof Date ? value.getTime() : value))
const database = {
  async query({ text, values }) {
    return db.prepare(text).all(...parameters(values))
  },
  async execute({ text, values }) {
    return Number(db.prepare(text).run(...parameters(values)).changes)
  },
  async transaction(operation) {
    db.exec('BEGIN')
    try {
      const result = await operation(database)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
const service = new JournalAttributes(
  async () => database,
  () => {},
  {
    warn: () => {},
    references: {
      read: async () => [],
      bindings: async () => [],
      bind: async () => {
        throw Error('No host references')
      }
    }
  }
)
try {
  const { token } = await service.run({
    action: 'begin',
    definition: {
      source: 'Packed fixture',
      year: 2025,
      fields: [{ id: 'score', label: 'Score', kind: 'number', colors: {}, visible: true }]
    },
    policy: 'fill'
  })
  await service.run({
    action: 'append',
    token,
    offset: 0,
    rows: [
      {
        row: 2,
        name: 'Fictional Package Journal',
        aliases: [],
        issns: ['1234-5679'],
        values: { score: '3.2' }
      }
    ]
  })
  const preview = await service.run({ action: 'preview', token, offset: 0 })
  assert.equal(
    (await service.run({ action: 'commit', token, digest: preview.digest, skipProblems: false }))
      .imported,
    1
  )
  const result = await service.run({
    action: 'resolve',
    identities: [{ name: '', aliases: [], issns: ['1234-5679'] }]
  })
  assert.equal(result.matches[0].status, 'matched')
} finally {
  await service.dispose()
  db.close()
}
