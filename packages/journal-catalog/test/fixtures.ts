/* Fixture builders preserve inferred mock signatures for behavioral assertions. */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { randomUUID } from 'node:crypto'
import { afterEach, vi } from 'vitest'
import {
  JournalAttributes,
  type JournalDatabase,
  type JournalStore,
  type JournalRecord,
  type JournalEntry,
  type JournalReferenceIdentity
} from '../src/index.js'
import type { JournalDataset, JournalImportRow, JournalRequest } from '../src/contracts.js'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.useRealTimers()
})
async function setup() {
  // Domain data only. Each transaction owns a copy, published only after success.
  let state = {
    journals: new Map<string, JournalRecord>(),
    datasets: new Map<string, JournalDataset>(),
    entries: new Map<string, JournalEntry>(),
    bindings: new Map<
      string,
      { itemId: string; journalId: string; fingerprint: string; revision: string }
    >()
  }
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
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const store = (getState: () => typeof state): JournalStore => ({
    async listJournals() {
      return structuredClone([...getState().journals.values()])
    },
    async listDatasets() {
      const state = getState()
      return structuredClone(
        [...state.datasets.values()]
          .map((dataset) => ({
            ...dataset,
            count: [...state.entries.values()].filter((entry) => entry.datasetId === dataset.id)
              .length
          }))
          .sort((a, b) => b.year - a.year || byId(a.source, b.source))
      )
    },
    async readEntries({ datasetIds, journalIds, after, limit }) {
      return structuredClone(
        [...getState().entries.values()]
          .filter(
            (entry) =>
              datasetIds.includes(entry.datasetId) &&
              (!journalIds || journalIds.includes(entry.journalId)) &&
              (after === undefined || entry.journalId > after)
          )
          .sort((a, b) => byId(a.journalId, b.journalId) || byId(a.datasetId, b.datasetId))
          .slice(0, limit)
      )
    },
    async readDatasetRows(datasetId, query) {
      const entries = await this.readEntries({ datasetIds: [datasetId], ...query })
      return entries.map((entry) => ({
        ...structuredClone(getState().journals.get(entry.journalId)!),
        values: entry.values,
        row: entry.sourceRow
      }))
    },
    async listExclusiveJournalIds(datasetId, after, limit) {
      const entries = [...getState().entries.values()]
      return [...getState().journals.keys()]
        .filter(
          (id) =>
            id > after &&
            entries.some((e) => e.datasetId === datasetId && e.journalId === id) &&
            !entries.some((e) => e.datasetId !== datasetId && e.journalId === id)
        )
        .sort(byId)
        .slice(0, limit)
    },
    async hasJournal(id) {
      return getState().journals.has(id)
    },
    async saveDatasetImport(dataset) {
      const previous = getState().datasets.get(dataset.id)
      getState().datasets.set(
        dataset.id,
        structuredClone({
          ...dataset,
          count: 0,
          revision: 1,
          ...(previous
            ? {
                name: previous.name,
                source: previous.source,
                year: previous.year,
                revision: previous.revision + 1
              }
            : {})
        })
      )
    },
    async saveJournals(journals) {
      for (const journal of journals) {
        const previous = getState().journals.get(journal.id)
        getState().journals.set(
          journal.id,
          structuredClone({ ...journal, name: previous?.name ?? journal.name })
        )
      }
    },
    async saveEntries(entries) {
      for (const entry of entries)
        getState().entries.set(
          JSON.stringify([entry.datasetId, entry.journalId]),
          structuredClone(entry)
        )
    },
    async updateDataset(id, patch) {
      const previous = getState().datasets.get(id)!
      getState().datasets.set(
        id,
        structuredClone({ ...previous, ...patch, revision: previous.revision + 1 })
      )
    },
    async removeDataset(id) {
      const state = getState()
      state.datasets.delete(id)
      for (const [key, entry] of state.entries)
        if (entry.datasetId === id) state.entries.delete(key)
      for (const journalId of state.journals.keys()) {
        if ([...state.entries.values()].some((entry) => entry.journalId === journalId)) continue
        state.journals.delete(journalId)
        for (const [itemId, binding] of state.bindings)
          if (binding.journalId === journalId) state.bindings.delete(itemId)
      }
    },
    references: {
      read: vi.fn<JournalStore['references']['read']>(async (filter, limit, lifecycle) =>
        [...references.values()]
          .filter(
            (ref) =>
              (lifecycle === 'all' || ref.lifecycle === lifecycle) &&
              (filter.ids ? filter.ids.includes(ref.id) : ref.id > (filter.after ?? ''))
          )
          .sort((a, b) => byId(a.id, b.id))
          .slice(0, limit)
          .map((ref) => {
            const binding = getState().bindings.get(ref.id)
            return structuredClone({
              ...ref,
              bindingJournalId: binding?.journalId ?? null,
              bindingFingerprint: binding?.fingerprint ?? null,
              bindingRevision: binding?.revision ?? null
            })
          })
      ),
      async bindings(ids, after) {
        return [...getState().bindings.values()]
          .filter((binding) => ids.includes(binding.journalId) && binding.itemId > after)
          .sort((a, b) => byId(a.itemId, b.itemId))
          .slice(0, 500)
          .map(({ itemId, revision }) => ({ itemId, revision }))
      },
      async bind(ref, journalId) {
        if (journalId)
          getState().bindings.set(ref.id, {
            itemId: ref.id,
            journalId,
            fingerprint: ref.fingerprint,
            revision: randomUUID()
          })
        else getState().bindings.delete(ref.id)
      }
    }
  })
  let queue = Promise.resolve()
  const client: JournalDatabase = {
    ...store(() => state),
    async transaction(operation) {
      const preceding = queue
      let release!: () => void
      queue = new Promise<void>((resolve) => {
        release = resolve
      })
      await preceding
      const draft = structuredClone(state)
      try {
        const result = await operation(store(() => draft))
        state = draft
        return result
      } finally {
        release()
      }
    }
  }
  const integration = { warn: vi.fn() }
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
  })
  return {
    service,
    client,
    changed,
    integration,
    references,
    addReference,
    createService,
    bindings: () => structuredClone([...state.bindings.values()]),
    entries: () => structuredClone([...state.entries.values()])
  }
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
