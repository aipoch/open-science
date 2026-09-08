import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createLiteratureLibraryMcpServer } from './library-mcp-server'
import { readFile } from 'node:fs/promises'
import { expect, it, vi, type Mock } from 'vitest'
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
type AcquisitionOptions = ConstructorParameters<typeof AgentPdfAcquisition>[0]
const setup = (): {
  service: AgentPdfAcquisition
  stageAcquiredPdf: ReturnType<typeof vi.fn>
  publish: Mock<AcquisitionOptions['content']['publish']>
  discover: Mock<AcquisitionOptions['fullText']['discover']>
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
    expect.objectContaining({ contentBlobId: 'blob', pageCount: 8 }),
    undefined
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

it('preserves the arXiv download and article provenance in Inbox', async () => {
  const { service, discover, stageAcquiredPdf } = setup()
  discover.mockResolvedValueOnce({
    mode: 'search',
    candidates: [
      {
        id: 'arxiv-pdf',
        provider: 'arxiv',
        source: 'arXiv',
        url: 'https://arxiv.org/pdf/2401.12345',
        sourceUrl: 'https://arxiv.org/abs/2401.12345'
      }
    ],
    notices: []
  })
  await expect(service.acquire({ candidate, origin: candidate.origin })).resolves.toMatchObject({
    status: 'pending-review',
    sourceUrl: 'https://arxiv.org/abs/2401.12345'
  })
  expect(stageAcquiredPdf).toHaveBeenCalledWith(
    expect.objectContaining({
      source: expect.objectContaining({
        rawMetadata: {
          metadata: {},
          fullText: expect.objectContaining({
            provider: 'arxiv',
            sourceUrl: 'https://arxiv.org/abs/2401.12345',
            downloadUrl: 'https://arxiv.org/pdf/2401.12345'
          })
        }
      })
    }),
    expect.objectContaining({ sourceUrl: 'https://arxiv.org/abs/2401.12345' }),
    undefined
  )
})

it('does not stage a PDF when its MCP request is cancelled before download returns', async () => {
  const { service, download, stageAcquiredPdf, publish } = setup()
  let release!: (bytes: Buffer) => void
  download.mockImplementationOnce(
    () =>
      new Promise<Buffer>((resolve) => {
        release = resolve
      })
  )
  let finished!: () => void
  const settled = new Promise<void>((resolve) => {
    finished = resolve
  })
  const server = createLiteratureLibraryMcpServer({
    searchLibrary: vi.fn(),
    readAbstract: vi.fn(),
    readPdf: vi.fn(),
    saveToInbox: vi.fn(),
    acquirePdf: async (request) => {
      try {
        return await service.acquire({ ...request, origin: candidate.origin })
      } finally {
        finished()
      }
    }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'acquisition-cancellation-test', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const controller = new AbortController()
  try {
    const result = client
      .callTool(
        {
          name: 'acquire_pdf',
          arguments: { candidate: { item: candidate.item, source: candidate.source } }
        },
        undefined,
        { signal: controller.signal }
      )
      .then(
        () => ({ cancelled: false }),
        (error: unknown) => ({ cancelled: true, error })
      )
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    controller.abort(new Error('User cancelled acquisition'))
    expect(await result).toMatchObject({ cancelled: true, error: expect.any(Error) })
    // InMemoryTransport delivers the cancellation notification before this barrier.
    await client.ping()
    release(Buffer.from('%PDF-1.7\n'))
    await settled
    expect(stageAcquiredPdf).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  } finally {
    release?.(Buffer.from('%PDF-1.7\n'))
    await settled
    await client.close()
    await server.close()
  }
})

it('retains the provider manuscript version and license in the staged Inbox source', async () => {
  const { service, discover, stageAcquiredPdf } = setup()
  discover.mockResolvedValueOnce({
    mode: 'search',
    notices: [],
    candidates: [
      {
        id: 'accepted-pdf',
        provider: 'unpaywall',
        source: 'Repository',
        url: 'https://repository.example/manuscript.pdf',
        sourceUrl: 'https://repository.example/article',
        version: 'accepted',
        license: 'cc-by'
      }
    ]
  })
  await service.acquire({ candidate, origin: candidate.origin })
  expect(stageAcquiredPdf).toHaveBeenCalledWith(
    expect.objectContaining({
      source: expect.objectContaining({
        rawMetadata: expect.objectContaining({
          fullText: expect.objectContaining({
            provider: 'unpaywall',
            sourceUrl: 'https://repository.example/article',
            version: 'accepted',
            license: 'cc-by'
          })
        })
      })
    }),
    expect.objectContaining({ pageCount: 8 }),
    undefined
  )
})

it.each(['download', 'inspection', 'publication'] as const)(
  'stops at the next boundary after cancellation during %s and cleans temporary files',
  async (boundary) => {
    const { service, download, pageCount, publish, stageAcquiredPdf } = setup()
    const controller = new AbortController()
    const cancel = (): void => controller.abort(new Error('User cancelled acquisition'))
    if (boundary === 'download')
      download.mockImplementationOnce(async () => {
        cancel()
        return Buffer.from('%PDF-1.7\n')
      })
    if (boundary === 'inspection')
      pageCount.mockImplementationOnce(async () => {
        cancel()
        return 8
      })
    if (boundary === 'publication') {
      const original = publish.getMockImplementation()!
      publish.mockImplementationOnce(async (input) => {
        const result = await original(input)
        cancel()
        return result
      })
    }
    await expect(
      service.acquire({ candidate, origin: candidate.origin, signal: controller.signal })
    ).rejects.toThrow('User cancelled acquisition')
    expect(stageAcquiredPdf).not.toHaveBeenCalled()
    expect(download).toHaveBeenCalledTimes(1)
    const path = pageCount.mock.calls[0]?.[0]
    if (path) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    if (boundary !== 'publication') expect(publish).not.toHaveBeenCalled()
  }
)

it('does not treat cancellation as a reason to try the next source', async () => {
  const { service, discover, download } = setup()
  const first = (await discover(candidate.item)).candidates[0]
  discover.mockResolvedValue({
    mode: 'search',
    notices: [],
    candidates: [first, { ...first, id: 'second', url: 'https://second.example/paper.pdf' }]
  })
  const controller = new AbortController()
  download.mockImplementationOnce(async () => {
    controller.abort(new Error('cancelled'))
    throw new Error('socket closed')
  })
  await expect(
    service.acquire({ candidate, origin: candidate.origin, signal: controller.signal })
  ).rejects.toThrow('cancelled')
  expect(download).toHaveBeenCalledTimes(1)
})

it('returns the committed receipt when cancellation arrives inside staging', async () => {
  const { service, stageAcquiredPdf } = setup()
  const controller = new AbortController()
  stageAcquiredPdf.mockImplementationOnce(async () => {
    controller.abort(new Error('cancelled after commit admission'))
    return { kind: 'candidate', id: 'committed', state: 'pending' }
  })
  await expect(
    service.acquire({ candidate, origin: candidate.origin, signal: controller.signal })
  ).resolves.toMatchObject({ status: 'pending-review', candidateId: 'committed' })
})
