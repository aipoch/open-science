import {
  LiteratureIndex,
  type LiteratureIndexStore,
  type ReplaceLiteratureIndexInput
} from '../src/index.js'

const stores = new Map<
  string,
  {
    documents: Map<string, ReplaceLiteratureIndexInput>
    accessed: Map<string, number>
    store: LiteratureIndexStore
  }
>()
export function memoryIndex(root: string): ReturnType<typeof createMemory> {
  let memory = stores.get(root)
  if (!memory) {
    memory = createMemory()
    stores.set(root, memory)
  }
  return memory
}
function createMemory(): {
  documents: Map<string, ReplaceLiteratureIndexInput>
  accessed: Map<string, number>
  store: LiteratureIndexStore
} {
  const documents = new Map<string, ReplaceLiteratureIndexInput>(),
    accessed = new Map<string, number>()
  const store: LiteratureIndexStore = {
    async hasExtraction(id) {
      return documents.has(id)
    },
    async deleteExtraction(id) {
      documents.delete(id)
      accessed.delete(id)
    },
    async replace(input) {
      documents.set(input.extractionId, structuredClone(input))
      accessed.set(input.extractionId, Date.now())
    },
    async search(input) {
      return input.extractionIds
        .flatMap((extractionId) =>
          (documents.get(extractionId)?.chunks ?? []).map((chunk) => {
            const words = chunk.content.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
            return {
              ...chunk,
              extractionId,
              rank: -words.filter((word) => input.terms.some((term) => term.toLowerCase() === word))
                .length
            }
          })
        )
        .filter((row) => row.rank < 0)
        .sort((a, b) => a.rank - b.rank)
        .slice(0, input.limit)
    },
    async touch(ids) {
      for (const id of ids) accessed.set(id, Date.now())
    },
    async purgeExpired() {
      for (const [id, at] of accessed)
        if (at < Date.now() - 86400000) await store.deleteExtraction(id)
    },
    close: async () => undefined
  }
  return { documents, accessed, store }
}
export function createIndex(root: string): LiteratureIndex {
  return new LiteratureIndex({
    exists: async () => stores.has(root),
    open: async () => memoryIndex(root).store
  })
}
