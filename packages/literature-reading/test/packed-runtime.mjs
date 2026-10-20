import assert from 'node:assert/strict'
import { LiteratureIndex, LiteratureReader } from '@aipoch/literature-reading'
const documents = new Map()
const db = {
  hasExtraction: async (id) => documents.has(id),
  deleteExtraction: async (id) => {
    documents.delete(id)
  },
  replace: async (input) => {
    documents.set(input.extractionId, structuredClone(input))
  },
  search: async ({ extractionIds, terms, limit }) =>
    extractionIds
      .flatMap((extractionId) =>
        (documents.get(extractionId)?.chunks ?? [])
          .filter((chunk) =>
            terms.some((term) => chunk.content.toLowerCase().includes(term.toLowerCase()))
          )
          .map((chunk) => ({ ...chunk, extractionId, rank: -1 }))
      )
      .slice(0, limit),
  touch: async () => {},
  purgeExpired: async () => {},
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
const result = await reader.searchDocuments([reference], 'trial')
assert.equal(result.retrievalMode, 'bm25')
assert.ok(result.passages[0].content.includes('randomized trial'))
await index.flushPendingAccesses()
console.log('Packed reader and typed in-memory index: authorization, cache and search passed.')
