import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { literatureCandidateInputSchema } from '../../shared/literature'
import { AgentPdfAcquisition } from './agent-pdf-acquisition'

const candidate = literatureCandidateInputSchema.parse({
  item: {
    itemType: 'journalArticle',
    title: 'A paper',
    identifiers: [{ scheme: 'doi', value: '10.1234/example' }]
  },
  source: { provider: 'crossref', rawMetadata: {}, sourceUrl: 'https://doi.org/10.1234/example' },
  origin: { kind: 'agent', projectId: 'p', sessionId: 's' }
})
const setup = (): {
  service: AgentPdfAcquisition
  stageAcquiredPdf: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  discover: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  pageCount: ReturnType<typeof vi.fn>
} => {
  const stageAcquiredPdf = vi.fn(async () => ({
    kind: 'candidate' as const,
    id: 'inbox',
    state: 'pending' as const
  }))
  const publish = vi.fn(async ({ sourcePath }: { sourcePath: string }) => {
    expect((await readFile(sourcePath)).subarray(0, 5).toString()).toBe('%PDF-')
    return {
      id: 'blob',
      path: sourcePath,
      checksum: 'a'.repeat(64),
      sizeBytes: 10n,
      storageKey: 'content/blob',
      contentType: 'application/pdf',
      createdAt: new Date()
    }
  })
  const discover = vi.fn(async () => ({
    mode: 'search' as const,
    candidates: [
      {
        id: 'pdf',
        source: 'PMC',
        provider: 'pmc' as const,
        url: 'https://pmc.ncbi.nlm.nih.gov/pdf/paper.pdf',
        sourceUrl: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/'
      }
    ],
    notices: []
  }))
  const download = vi.fn(async () => Buffer.from('%PDF-1.7\n'))
  const pageCount = vi.fn(async () => 8)
  const service = new AgentPdfAcquisition({
    catalog: { stageAcquiredPdf },
    content: { publish },
    fullText: { discover },
    download,
    pageCount
  })
  return { service, stageAcquiredPdf, publish, discover, download, pageCount }
}
it('stages validated bytes with trusted origin, without adding a library item', async () => {
  const { service, stageAcquiredPdf, publish } = setup()
  await expect(service.acquire({ candidate, origin: candidate.origin })).resolves.toMatchObject({
    status: 'pending-review',
    candidateId: 'inbox',
    filename: 'A paper.pdf'
  })
  expect(stageAcquiredPdf).toHaveBeenCalledWith(
    expect.objectContaining({ origin: candidate.origin }),
    expect.objectContaining({ contentBlobId: 'blob', pageCount: 8 })
  )
  await expect(readFile(publish.mock.calls[0]![0].sourcePath)).rejects.toMatchObject({
    code: 'ENOENT'
  })
})
it('rejects non-PDF responses and invalid PDF documents before publishing', async () => {
  const { service, download, publish, pageCount } = setup()
  download.mockResolvedValueOnce(Buffer.from('<html>Sign in</html>'))
  await expect(service.acquire({ candidate, origin: candidate.origin })).rejects.toThrow(
    'did not return a PDF'
  )
  pageCount.mockRejectedValueOnce(new Error('Invalid PDF'))
  await expect(service.acquire({ candidate, origin: candidate.origin })).rejects.toThrow(
    'Invalid PDF'
  )
  expect(publish).not.toHaveBeenCalled()
})
it('rejects local links and reports unavailable sources without staging metadata', async () => {
  const { service, discover, stageAcquiredPdf, download } = setup()
  await expect(
    service.acquire({ candidate, origin: candidate.origin, pdfUrl: 'file:///tmp/private.pdf' })
  ).rejects.toThrow()
  expect(download).not.toHaveBeenCalled()
  discover.mockResolvedValueOnce({ mode: 'search', candidates: [], notices: [] })
  await expect(service.acquire({ candidate, origin: candidate.origin })).resolves.toEqual({
    status: 'not-found',
    notices: []
  })
  expect(stageAcquiredPdf).not.toHaveBeenCalled()
})
