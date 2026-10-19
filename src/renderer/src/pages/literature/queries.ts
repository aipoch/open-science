import { createLiteratureClient } from '@aipoch/literature-library/client'
import type { LiteratureCatalogSearchPage } from '../../../../shared/literature'
import type { OpenScienceAPI } from '../../../../shared/renderer-contract-catalog'

export function createLiteratureQueries(
  api: () => Pick<OpenScienceAPI, 'literature' | 'saveBlobFile'>
): ReturnType<typeof createLiteratureClient<LiteratureCatalogSearchPage>> & {
  downloadLiteratureRecord(itemId: string): Promise<void>
} {
  const client = createLiteratureClient({
    search: (request) => api().literature.search(request),
    get: (id) => api().literature.get(id),
    exportRecord: (request) => api().literature.exportRecord(request),
    jobs: (request) => api().literature.jobs(request),
    formatReferences: (request) => api().literature.formatReferences(request)
  })
  return {
    ...client,
    async downloadLiteratureRecord(itemId) {
      const data = new TextEncoder().encode(await client.readLiteratureRecord(itemId))
      await api().saveBlobFile({
        suggestedName: 'reference.json',
        mimeType: 'application/json',
        data: data.buffer
      })
    }
  }
}
