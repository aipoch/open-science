import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { LiteratureIndex, LiteratureReader } from '@aipoch/literature-reading'
const database = new DatabaseSync('reading.sqlite')
const db = {
  execute: async (sql, ...values) => Number(database.prepare(sql).run(...values).changes),
  query: async (sql, ...values) => database.prepare(sql).all(...values),
  transaction: async (work) => {
    database.exec('BEGIN')
    try {
      const result = await work(db)
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  },
  close: async () => {}
}
const index = new LiteratureIndex({ open: async () => db, exists: async () => true })
let admitted = 0,
  extracted = 0
const reader = new LiteratureReader({
  index,
  authorize: async () => {
    admitted++
    return async () => {
      extracted++
      return {
        text: 'A randomized trial of treatment effectiveness.',
        pageCount: 1,
        truncated: false
      }
    }
  }
})
const reference = {
  bindingId: 'version',
  name: 'trial.pdf',
  checksum: 'a'.repeat(64),
  sizeBytes: 100
}
const page = await reader.readDocument(reference)
assert.ok(page)
await reader.readDocument(reference)
assert.equal(admitted, 2)
assert.equal(extracted, 1)
database.close()
