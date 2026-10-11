import type {
  TranslationDatabase,
  TranslationTransaction,
  TranslationStoredCheckpoint
} from '../../src/storage.js'
/** Standalone transactional consumer. No SQL, application schema, source taxonomy or host imports. */
export function memoryCheckpoints(): {
  database: TranslationDatabase
  rows: () => Map<string, TranslationStoredCheckpoint>
  revoke: () => void
} {
  let rows = new Map<string, TranslationStoredCheckpoint>()
  let queue = Promise.resolve<unknown>(undefined)
  let authorized = true
  const database: TranslationDatabase = {
    canPersist: async () => true,
    transaction(operation) {
      const result = queue.then(async () => {
        const working = structuredClone(rows)
        const get = (id: string): TranslationStoredCheckpoint => {
          const row = working.get(id)
          if (!row) throw Error('missing row')
          return row
        }
        const tx: TranslationTransaction = {
          async requireSource() {
            if (!authorized) throw Error('denied')
            return { sizeBytes: 12n }
          },
          async requireDocument(identity, source) {
            await tx.requireSource(identity)
            return `${identity.checksum}:${source.sizeBytes}`
          },
          async read(id, contentId) {
            const row = working.get(id)
            return row && (contentId === undefined || row.contentId === contentId)
              ? structuredClone(row)
              : null
          },
          async findLatest(contentId, key) {
            const row = [...working.values()]
              .reverse()
              .find(
                (r) =>
                  r.contentId === contentId &&
                  (key === undefined || JSON.parse(r.payloadJson).key === key)
              )
            return row ? structuredClone(row) : null
          },
          async list(contentId) {
            return [...working.values()]
              .filter((r) => r.contentId === contentId)
              .map((r) => {
                const p = JSON.parse(r.payloadJson)
                return {
                  id: r.id,
                  key: p.key,
                  language: p.language,
                  glossary: JSON.stringify(p.glossary),
                  concurrency: p.concurrency ?? 1,
                  model: JSON.stringify(p.model),
                  updatedAt: Date.now()
                }
              })
          },
          async delete(id, contentId) {
            return working.get(id)?.contentId === contentId && working.delete(id)
          },
          async insert(row) {
            working.set(row.id, { ...structuredClone(row), blocks: [] })
          },
          async readHeader(id) {
            return working.has(id) ? structuredClone(get(id)) : null
          },
          async readBase(id) {
            return working.has(id) ? structuredClone(get(id)) : null
          },
          async readLayoutReports(id) {
            const reports = JSON.parse(get(id).payloadJson).layoutReports
            return reports ? JSON.stringify(reports) : null
          },
          async pinLayout(id, snapshot) {
            get(id).layoutSnapshotJson ??= snapshot
          },
          async updatePayload(id, payload) {
            get(id).payloadJson = payload
          },
          async commit(id, revision, change) {
            const row = get(id),
              state = row.blocks.find((b) => b.sourceIndex === -1)
            if ((state?.revision ?? row.revision) !== revision) return false
            if (change.base) {
              Object.assign(row, change.base, {
                revision: change.revision,
                blocks: [{ sourceIndex: -1, revision: change.revision, translation: null }]
              })
            } else if (change.block && state) {
              state.revision = change.revision
              row.blocks = row.blocks.filter((b) => b.sourceIndex !== change.block!.sourceIndex)
              row.blocks.push({ ...change.block, revision: change.revision })
              if (change.layoutReportsJson !== undefined)
                row.payloadJson = JSON.stringify({
                  ...JSON.parse(row.payloadJson),
                  layoutReports: JSON.parse(change.layoutReportsJson)
                })
            } else throw Error('invalid commit')
            return true
          }
        }
        const value = await operation(tx)
        rows = working
        return value
      })
      queue = result.catch(() => undefined)
      return result
    }
  }
  return {
    database,
    rows: () => structuredClone(rows),
    revoke: () => {
      authorized = false
    }
  }
}
