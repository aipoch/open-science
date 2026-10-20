/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import * as journalApi from '@aipoch/journal-catalog'
import { JournalAttributes } from '@aipoch/journal-catalog'
import { readJournalFile, createJournalTemplate } from '@aipoch/journal-catalog/files'
assert.equal('matchJournal' in journalApi, false)
const template = await createJournalTemplate()
assert.ok((await readJournalFile(template, 'template.xlsx')).rows.length > 0)
// A consumer can provide storage without a database engine or application tables.
let state = { journals: [], datasets: [], entries: [] }
const store = (data) => ({
  async listJournals() {
    return structuredClone(data.journals)
  },
  async listDatasets() {
    return data.datasets.map((dataset) => ({
      ...dataset,
      count: data.entries.filter((entry) => entry.datasetId === dataset.id).length
    }))
  },
  async saveDatasetImport(dataset) {
    data.datasets.push({ ...dataset, revision: 1 })
  },
  async saveJournals(journals) {
    data.journals.push(...journals)
  },
  async saveEntries(entries) {
    data.entries.push(...entries)
  },
  async readEntries({ datasetIds, journalIds }) {
    return data.entries.filter(
      (entry) =>
        datasetIds.includes(entry.datasetId) &&
        (!journalIds || journalIds.includes(entry.journalId))
    )
  },
  references: {
    read: async () => [],
    bindings: async () => [],
    bind: async () => {
      throw Error('No host references')
    }
  }
})
const database = {
  async listJournals() {
    return store(state).listJournals()
  },
  async listDatasets() {
    return store(state).listDatasets()
  },
  async readEntries(query) {
    return store(state).readEntries(query)
  },
  async transaction(operation) {
    const draft = structuredClone(state)
    const result = await operation(store(draft))
    state = draft
    return result
  }
}
const service = new JournalAttributes(
  async () => database,
  () => {},
  { warn: () => {} }
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
}
