import { createLiteratureClient } from '@aipoch/literature-library/client'
// Access transport at invocation so reconnects and test/desktop/Web adapters stay current.
export const literatureClient = createLiteratureClient({
  search: (request) => window.api.literature.search(request),
  get: (id) => window.api.literature.get(id),
  exportRecord: (request) => window.api.literature.exportRecord(request),
  jobs: (request) => window.api.literature.jobs(request),
  formatReferences: (request) => window.api.literature.formatReferences(request)
})
export const { readLiteratureDisplayPage, readLiteratureSelectionPage, readLiteratureJobPages } =
  literatureClient
export async function downloadLiteratureRecord(itemId: string): Promise<void> {
  const data = new TextEncoder().encode(await literatureClient.readLiteratureRecord(itemId))
  await window.api.saveBlobFile({
    suggestedName: 'reference.json',
    mimeType: 'application/json',
    data: data.buffer
  })
}
