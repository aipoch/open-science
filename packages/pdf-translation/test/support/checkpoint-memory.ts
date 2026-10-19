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
                (r) => r.contentId === contentId && (key === undefined || r.checkpoint.key === key)
              )
            return row ? structuredClone(row) : null
          },
          async list(contentId) {
            return [...working.values()]
              .filter((r) => r.contentId === contentId)
              .map((r) => {
                const p = r.checkpoint
                return {
                  id: r.id,
                  key: p.key,
                  language: p.language,
                  glossary: p.glossary,
                  concurrency: p.concurrency ?? 1,
                  model: p.model,
                  updatedAt: Date.now()
                }
              })
          },
          async delete(id, contentId) {
            return working.get(id)?.contentId === contentId && working.delete(id)
          },
          async insert(row) {
            working.set(row.id, structuredClone(row))
          },
          async readHeader(id) {
            return working.has(id) ? structuredClone(get(id)) : null
          },
          async readMetadata(id) {
            return working.has(id) ? structuredClone(get(id).checkpoint) : null
          },
          async readLayoutReports(id) {
            return structuredClone(get(id).checkpoint.layoutReports)
          },
          async pinLayout(id, snapshot) {
            get(id).checkpoint.layoutSnapshot ??= structuredClone(snapshot)
          },
          async updateLayoutReports(id, reports) {
            get(id).checkpoint.layoutReports = structuredClone(reports)
          },
          async commit(id, revision, change) {
            const row = get(id)
            if (row.checkpoint.revision !== revision) return false
            // This consumer stores complete objects and ignores the incremental write hint.
            const checkpoint = structuredClone(change.checkpoint)
            if (change.changedBlock) {
              checkpoint.layoutSnapshot = structuredClone(row.checkpoint.layoutSnapshot)
              checkpoint.layoutReports = structuredClone(
                change.layoutReports ?? row.checkpoint.layoutReports
              )
            }
            row.checkpoint = checkpoint
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
