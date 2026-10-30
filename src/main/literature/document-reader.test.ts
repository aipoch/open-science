import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { PdfProseRegion } from '../../shared/pdf-text'
import type { NotebookRunInputFile } from '../../shared/notebook'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { MAX_AUTO_EXTRACT_PDF_BYTES } from '../uploads/attachment-media'
import { extractPdfText } from '../uploads/pdf-text-extraction'
import { literatureIndex } from './full-text-index'
import { LiteratureDocumentReader } from './document-reader'
import type { SessionPdfSourceResolver } from './session-pdf-source-resolver'

import { createLiteratureMcpServer, LITERATURE_READ_DOCUMENT_TOOL_NAME } from './mcp-server'

vi.mock('../uploads/pdf-text-extraction', () => ({ extractPdfText: vi.fn() }))

const checksum = 'a'.repeat(64)
const secondChecksum = 'b'.repeat(64)
const input = {
  inputFileVersionId: 'version-1',
  sourceKind: 'upload-version',
  sourceFileId: 'upload-1',
  sourceVersionNumber: 1,
  sourceProjectId: 'project-1',
  sourceSessionId: 'session-1',
  filename: 'paper.pdf',
  contentType: 'application/pdf',
  sizeBytes: 42,
  checksum,
  storageKey: 'uploads/version-1.pdf',
  association: 'turn-attached'
} satisfies NotebookRunInputFile
const secondInput = {
  ...input,
  inputFileVersionId: 'version-2',
  sourceFileId: 'upload-2',
  filename: 'second.pdf',
  checksum: secondChecksum,
  storageKey: 'uploads/version-2.pdf'
} satisfies NotebookRunInputFile

const sessionPdfSources = (inputs: {
  resolveVersion: (request: {
    projectId: string
    sourceKind: 'artifact-version' | 'upload-version'
    inputFileVersionId: string
    expectedSourceFileId?: string
  }) => Promise<NotebookRunInputFile | undefined>
  resolveContent: (input: NotebookRunInputFile) => Promise<string>
}): Pick<SessionPdfSourceResolver, 'resolveVersion'> => ({
  resolveVersion: async (request: {
    projectId: string
    sourceKind: 'artifact-version' | 'upload-version' | 'literature-attachment-version'
    sourceVersionId: string
    expectedSourceFileId?: string
  }) => {
    if (request.sourceKind === 'literature-attachment-version') return undefined
    const input = await inputs.resolveVersion({
      projectId: request.projectId,
      sourceKind: request.sourceKind,
      inputFileVersionId: request.sourceVersionId,
      expectedSourceFileId: request.expectedSourceFileId
    })
    if (!input) return undefined
    return {
      sourceKind: input.sourceKind,
      sourceFileId: input.sourceFileId,
      sourceVersionId: input.inputFileVersionId,
      sourceSessionId: input.sourceSessionId,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
      path: await inputs.resolveContent(input)
    }
  }
})

const session = (
  withContext = true,
  secondBindingChecksum = secondChecksum
): PersistedChatSession =>
  ({
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'Summarize the paper.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        ...(withContext
          ? {
              pdfContext: {
                version: 1,
                bindings: [
                  {
                    version: 1,
                    bindingId: 'binding-1',
                    sourceKind: 'upload-version',
                    sourceFileId: 'upload-1',
                    sourceVersionId: 'version-1',
                    sourceSessionId: 'session-1',
                    name: 'paper.pdf',
                    mimeType: 'application/pdf',
                    sizeBytes: 42,
                    checksum,
                    linkedAt: 1
                  },
                  {
                    version: 1,
                    bindingId: 'binding-2',
                    sourceKind: 'upload-version',
                    sourceFileId: 'upload-2',
                    sourceVersionId: 'version-2',
                    sourceSessionId: 'session-1',
                    name: 'second.pdf',
                    mimeType: 'application/pdf',
                    sizeBytes: 42,
                    checksum: secondBindingChecksum,
                    linkedAt: 2
                  }
                ],
                activeBindingId: 'binding-1',
                readingPosition: { pageNumber: 3, pageCount: 3 }
              }
            }
          : {})
      }
    ]
  }) as unknown as PersistedChatSession

describe('LiteratureDocumentReader', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'literature-reader-'))
    vi.mocked(extractPdfText).mockClear()
    vi.mocked(extractPdfText).mockResolvedValue({
      text: [
        '--- Page 1 ---',
        'Prior work discussed unrelated observations.',
        '--- Page 2 ---',
        'The method uses a retrieval evaluator.',
        '--- Page 3 ---',
        'The evaluator identifies incorrect retrieved documents.'
      ].join('\n'),
      pageCount: 3,
      truncated: false
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const regions: readonly PdfProseRegion[] = [
    { page: 1, left: 0.1, top: 0.2, right: 0.9, bottom: 0.8, split: 0.5 },
    { page: 2, left: 0.1, top: 0.2, right: 0.9, bottom: 0.8, split: 0.5 }
  ]
  const readRequest = {
    projectId: 'project-1',
    sessionId: 'session-1',
    promptMessageId: 'message-1'
  }
  const makeReader = (current = session()): LiteratureDocumentReader =>
    new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => current) },
      sources: sessionPdfSources({
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      })
    })

  const confirmedSession = (
    proseRegionsByBindingId: Readonly<Record<string, readonly PdfProseRegion[]>>
  ): PersistedChatSession => {
    const current = session()
    const message = current.messages[0]!
    // Reopening a persisted message must carry its own selection, independent of UI state.
    return JSON.parse(
      JSON.stringify({
        ...current,
        messages: [{ ...message, pdfContext: { ...message.pdfContext!, proseRegionsByBindingId } }]
      })
    ) as PersistedChatSession
  }

  it('automatically reuses persisted confirmed regions for active reads and cursor continuation', async () => {
    vi.mocked(extractPdfText).mockResolvedValue({
      text: 'a'.repeat(17000),
      pageCount: 2,
      truncated: false
    })
    const reader = makeReader(confirmedSession({ 'binding-1': regions }))
    const first = (await reader.readCurrent({ ...readRequest, input: {} })) as {
      nextCursor: string
    }
    await expect(
      reader.readCurrent({ ...readRequest, input: { cursor: first.nextCursor } })
    ).resolves.toMatchObject({
      nextCursor: null,
      reading: { order: 'explicit-prose-regions', proseRegions: regions }
    })
    expect(extractPdfText).toHaveBeenCalledExactlyOnceWith(join(root, 'paper.pdf'), undefined, {
      maxChars: 24 * 1024 * 1024,
      proseRegions: regions
    })
  })

  it.each([undefined, [{ ...regions[0]!, split: 0.6 }]])(
    'searches each linked PDF with its own confirmed or automatic strategy: %j',
    async (secondRegions) => {
      vi.mocked(extractPdfText).mockImplementation(async (path, _source, options) => ({
        text: `--- Page 1 ---\ncohort ${path.includes('second') ? 'second' : 'first'} ${options?.proseRegions?.[0]?.split ?? 'native'}`,
        pageCount: 2,
        truncated: false
      }))
      const current = confirmedSession({
        'binding-1': regions,
        ...(secondRegions ? { 'binding-2': secondRegions } : {})
      })
      const reader = new LiteratureDocumentReader({
        storageRoot: root,
        sessions: { loadSessionForContinuation: vi.fn(async () => current) },
        sources: sessionPdfSources({
          resolveVersion: vi.fn(async (request) =>
            request.inputFileVersionId === 'version-1' ? input : secondInput
          ),
          resolveContent: vi.fn(async (file) => join(root, file.filename))
        })
      })
      await expect(
        reader.readCurrent({ ...readRequest, input: { query: 'cohort' } })
      ).resolves.toMatchObject({
        reading: {
          order: 'per-document',
          documents: [
            { documentId: 'binding-1', order: 'explicit-prose-regions', proseRegions: regions },
            {
              documentId: 'binding-2',
              ...(secondRegions
                ? { order: 'explicit-prose-regions', proseRegions: secondRegions }
                : { order: 'automatic' })
            }
          ]
        },
        passages: expect.arrayContaining([
          expect.objectContaining({
            documentId: 'binding-1',
            content: expect.stringContaining('first 0.5')
          }),
          expect.objectContaining({
            documentId: 'binding-2',
            content: expect.stringContaining(secondRegions ? 'second 0.6' : 'second native')
          })
        ])
      })
      expect(extractPdfText).toHaveBeenCalledTimes(2)
    }
  )

  it('rejects invalid or foreign snapshot regions even when an in-memory session bypasses persistence', async () => {
    const invalidSelections: Record<string, readonly PdfProseRegion[]>[] = [
      { unknown: regions },
      { 'binding-1': [] },
      { 'binding-1': [regions[0]!, regions[0]!] }
    ]
    for (const selections of invalidSelections) {
      await expect(
        makeReader(confirmedSession(selections)).readCurrent({ ...readRequest, input: {} })
      ).rejects.toThrow('PDF_READING_REGION_INVALID')
    }
    expect(extractPdfText).not.toHaveBeenCalled()
  })

  it('isolates native and explicit region text and search indexes while canonicalizing region order', async () => {
    vi.mocked(extractPdfText).mockImplementation(async (_path, _source, options) => ({
      text: options?.proseRegions
        ? '--- Page 1 ---\nexplicit cohort evidence\n--- Page 2 ---\nconclusion'
        : '--- Page 1 ---\nnative cohort evidence\n--- Page 2 ---\nconclusion',
      pageCount: 2,
      truncated: false
    }))
    const current = confirmedSession({ 'binding-1': [...regions].reverse() })
    current.messages.push({ ...session().messages[0]!, id: 'message-native' })
    const reader = makeReader(current)
    await expect(
      reader.readCurrent({
        ...readRequest,
        promptMessageId: 'message-native',
        input: { query: 'cohort', documentIds: ['binding-1'] }
      })
    ).resolves.toMatchObject({
      reading: { order: 'automatic' },
      retrievalMode: 'bm25',
      passages: [expect.objectContaining({ content: expect.stringContaining('native cohort') })]
    })
    await expect(
      reader.readCurrent({
        ...readRequest,
        input: { query: 'cohort', documentIds: ['binding-1'] }
      })
    ).resolves.toMatchObject({
      reading: { order: 'explicit-prose-regions', proseRegions: regions },
      retrievalMode: 'bm25',
      passages: [expect.objectContaining({ content: expect.stringContaining('explicit cohort') })]
    })
    await expect(
      reader.readCurrent({
        ...readRequest,
        input: { documentId: 'binding-1' }
      })
    ).resolves.toMatchObject({
      reading: { order: 'explicit-prose-regions', proseRegions: regions },
      passage: { text: expect.stringContaining('explicit cohort') }
    })
    await expect(
      reader.readCurrent({
        ...readRequest,
        promptMessageId: 'message-native',
        input: { query: 'cohort', documentIds: ['binding-1'] }
      })
    ).resolves.toMatchObject({
      reading: { order: 'automatic' },
      passages: [expect.objectContaining({ content: expect.stringContaining('native cohort') })]
    })
    expect(extractPdfText).toHaveBeenCalledTimes(2)
    expect(extractPdfText).toHaveBeenLastCalledWith(join(root, 'paper.pdf'), undefined, {
      maxChars: 24 * 1024 * 1024,
      proseRegions: regions
    })
  })

  it('continues the same extraction after equivalent correction coordinates are serialized in another order', async () => {
    vi.mocked(extractPdfText).mockResolvedValue({
      text: 'a'.repeat(17000),
      pageCount: 2,
      truncated: false
    })
    const current = confirmedSession({ 'binding-1': [...regions].reverse() })
    const reader = makeReader(current)
    const first = (await reader.readCurrent({ ...readRequest, input: {} })) as {
      nextCursor: string
    }
    current.messages[0] = {
      ...current.messages[0]!,
      pdfContext: {
        ...current.messages[0]!.pdfContext!,
        proseRegionsByBindingId: { 'binding-1': regions }
      }
    }
    await expect(
      reader.readCurrent({ ...readRequest, input: { cursor: first.nextCursor } })
    ).resolves.toMatchObject({ nextCursor: null })
    expect(extractPdfText).toHaveBeenCalledOnce()
  })

  it('rejects continuation cursors after changing or clearing a correction', async () => {
    vi.mocked(extractPdfText).mockResolvedValue({
      text: 'cohort ' + 'a'.repeat(17000),
      pageCount: 2,
      truncated: false
    })
    const current = confirmedSession({ 'binding-1': regions })
    current.messages.push({ ...session().messages[0]!, id: 'automatic' })
    current.messages.push({
      ...current.messages[0]!,
      id: 'changed',
      pdfContext: {
        ...current.messages[0]!.pdfContext!,
        proseRegionsByBindingId: { 'binding-1': [{ ...regions[0]!, split: 0.6 }] }
      }
    })
    const reader = makeReader(current)
    const first = (await reader.readCurrent({ ...readRequest, input: {} })) as {
      nextCursor: string
    }
    for (const promptMessageId of ['automatic', 'changed']) {
      await expect(
        reader.readCurrent({ ...readRequest, promptMessageId, input: { cursor: first.nextCursor } })
      ).rejects.toThrow('cursor is invalid')
    }
    const automatic = (await reader.readCurrent({
      ...readRequest,
      promptMessageId: 'automatic',
      input: {}
    })) as { nextCursor: string }
    await expect(
      reader.readCurrent({ ...readRequest, input: { cursor: automatic.nextCursor } })
    ).rejects.toThrow('cursor is invalid')
  })

  it.each([
    'open-science-pdfjs-verified-bytes-native-v4',
    'open-science-pdfjs-automatic-reading-order-v1',
    'open-science-pdfjs-automatic-reading-order-v2',
    `open-science-pdfjs-automatic-with-explicit-prose-v3:${JSON.stringify(regions)}`,
    `open-science-pdfjs-verified-bytes-explicit-prose-regions-v2:${JSON.stringify(regions)}`
  ])('rebuilds old extraction caches and rejects old cursors: %s', async (oldFingerprint) => {
    const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
    const fingerprint = hash(oldFingerprint)
    const oldId = hash(`${checksum}:${fingerprint}`)
    const owner = literatureIndex(root)
    const index = await owner.open()
    try {
      await index.replace({
        extractionId: oldId,
        documentChecksum: checksum,
        extractorFingerprint: fingerprint,
        chunks: [
          { pageStart: 1, pageEnd: 1, textStart: 0, textEnd: 20, content: 'obsolete cohort text' }
        ]
      })
    } finally {
      await index.close()
    }
    vi.mocked(extractPdfText).mockResolvedValue({
      text: 'automatic cohort text',
      pageCount: 2,
      truncated: false
    })
    const reader = makeReader(confirmedSession({ 'binding-1': regions }))
    await expect(
      reader.readCurrent({ ...readRequest, input: { query: 'cohort', documentIds: ['binding-1'] } })
    ).resolves.toMatchObject({
      passages: [expect.objectContaining({ content: 'automatic cohort text' })]
    })
    const cursor = Buffer.from(
      JSON.stringify({ documentId: 'binding-1', extractionId: oldId, offset: 1 })
    ).toString('base64url')
    await expect(
      reader.readCurrent({ ...readRequest, input: { documentId: 'binding-1', cursor } })
    ).rejects.toThrow('cursor is invalid')
    expect(extractPdfText).toHaveBeenCalledOnce()
  })

  it('honors historical regions in verified content leases and closes them after extraction failure', async () => {
    const close = vi.fn(async () => {})
    const verifyUnchanged = vi.fn(async () => {})
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: {
        loadSessionForContinuation: vi.fn(async () => confirmedSession({ 'binding-1': regions }))
      },
      sources: {
        resolveVersion: vi.fn(async () => ({
          sourceKind: 'upload-version' as const,
          sourceSessionId: 'session-1',
          sourceFileId: 'upload-1',
          sourceVersionId: 'version-1',
          filename: 'paper.pdf',
          contentType: 'application/pdf',
          sizeBytes: 42,
          checksum,
          path: join(root, 'paper.pdf'),
          openContent: async () => ({
            path: join(root, 'verified.pdf'),
            size: 42,
            readRange: vi.fn(),
            verifyUnchanged,
            close
          })
        }))
      }
    })
    vi.mocked(extractPdfText).mockRejectedValue(
      new Error('PDF_READING_REGION_INVALID: ambiguous geometry')
    )
    await expect(
      reader.readCurrent({
        ...readRequest,
        input: { documentId: 'binding-1' }
      })
    ).rejects.toThrow('PDF_READING_REGION_INVALID')
    expect(extractPdfText).toHaveBeenCalledWith(
      join(root, 'verified.pdf'),
      expect.objectContaining({ size: 42, readBytes: expect.any(Function) }),
      { maxChars: 24 * 1024 * 1024, proseRegions: regions }
    )
    expect(close).toHaveBeenCalledOnce()
    expect(verifyUnchanged).not.toHaveBeenCalled()
  })

  it.each([
    { query: 'DNA', pages: [1] },
    { query: '修复机制', pages: [2] },
    { query: 'DNA 修复机制', pages: [1, 2] }
  ])(
    'retrieves the matching pages for "$query" in the same bilingual PDF',
    async ({ query, pages }) => {
      vi.mocked(extractPdfText).mockResolvedValue({
        text: '--- Page 1 ---\nDNA background discussion.\n--- Page 2 ---\n本研究的主要结论是修复机制显著提高可靠性。',
        pageCount: 2,
        truncated: false
      })
      const reader = new LiteratureDocumentReader({
        storageRoot: root,
        sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
        sources: sessionPdfSources({
          resolveVersion: vi.fn(async () => input),
          resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
        })
      })
      const result = (await reader.readCurrent({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'message-1',
        input: { documentIds: ['binding-1'], query }
      })) as { passages: Array<{ documentId: string; pageStart: number }> }

      expect(result.passages.every(({ documentId }) => documentId === 'binding-1')).toBe(true)
      expect(result.passages.map(({ pageStart }) => pageStart).sort()).toEqual(pages)
    }
  )

  it('does not silently broaden a singular document search through the MCP boundary', async () => {
    vi.mocked(extractPdfText).mockImplementation(async (path) => ({
      text:
        path === join(root, 'second.pdf')
          ? '--- Page 1 ---\nneedle\n--- Page 2 ---\nconclusion'
          : '--- Page 1 ---\nbackground\n--- Page 2 ---\nunrelated',
      pageCount: 2,
      truncated: false
    }))
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
      sources: sessionPdfSources({
        resolveVersion: vi.fn(async ({ inputFileVersionId }) =>
          inputFileVersionId === 'version-2' ? secondInput : input
        ),
        resolveContent: vi.fn(async (resolved) =>
          join(root, resolved.inputFileVersionId === 'version-2' ? 'second.pdf' : 'paper.pdf')
        )
      })
    })
    const server = createLiteratureMcpServer({
      readDocument: (request) =>
        reader.readCurrent({
          projectId: 'project-1',
          sessionId: 'session-1',
          promptMessageId: 'message-1',
          input: request
        })
    })
    const client = new Client({ name: 'literature-scope-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    try {
      const scoped = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: { documentIds: ['binding-1'], query: 'needle' }
      })
      expect(scoped.structuredContent).toMatchObject({ passages: [] })
      const all = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: { query: 'needle' }
      })
      expect(all.structuredContent).toMatchObject({
        documents: [{ id: 'binding-1' }, { id: 'binding-2' }],
        passages: [expect.objectContaining({ documentId: 'binding-2' })]
      })
      const invalidCursor = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: { documentId: 'binding-1', cursor: 'not-a-cursor' }
      })
      expect(invalidCursor).toMatchObject({
        isError: true,
        content: [
          expect.objectContaining({
            type: 'text',
            text: expect.any(String)
          })
        ]
      })
      const cursorDiagnostic = JSON.stringify(invalidCursor.content)
      expect(cursorDiagnostic).toContain('cursor is invalid')
      expect(cursorDiagnostic).toContain('read_document')
      expect(cursorDiagnostic).toContain('documentId')
      expect(cursorDiagnostic).toContain('without cursor')
      expect(cursorDiagnostic).toContain('nextCursor')
      const ambiguous = await client.callTool({
        name: LITERATURE_READ_DOCUMENT_TOOL_NAME,
        arguments: { documentId: 'binding-1', query: 'needle' }
      })
      expect(ambiguous).toMatchObject({ isError: true })
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('reads only the current message PDF snapshot and uses BM25 for a query', async () => {
    const loadSessionForContinuation = vi.fn(async () => session())
    const resolveVersion = vi.fn(async ({ inputFileVersionId }) =>
      inputFileVersionId === 'version-2' ? secondInput : input
    )
    const resolveContent = vi.fn(async (resolved) =>
      join(root, resolved.inputFileVersionId === 'version-2' ? 'second.pdf' : 'paper.pdf')
    )
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation },
      sources: sessionPdfSources({ resolveVersion, resolveContent })
    })

    const result = await reader.readCurrent({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: { query: 'incorrect retrieved documents' }
    })

    expect(result).toMatchObject({
      scope: 'relevant-passages',
      documents: [
        { id: 'binding-1', name: 'paper.pdf', pageCount: 3 },
        { id: 'binding-2', name: 'second.pdf', pageCount: 3 }
      ]
    })
    expect((result as { passages: unknown[] }).passages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: 'binding-1', pageStart: 3 }),
        expect.objectContaining({ documentId: 'binding-2', pageStart: 3 })
      ])
    )
    expect(resolveVersion).toHaveBeenCalledWith(
      expect.objectContaining({ inputFileVersionId: 'version-1' })
    )
  })

  it('searches one Library attachment version on demand and reuses its extraction', async () => {
    const resolveVersion = vi.fn(async () => ({
      sourceKind: 'literature-attachment-version' as const,
      sourceFileId: 'attachment-1',
      sourceVersionId: 'attachment-version-1',
      filename: 'library-paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: 42,
      checksum,
      path: join(root, 'library-paper.pdf')
    }))
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn() },
      sources: { resolveVersion }
    })
    const request = {
      projectId: 'project-1',
      attachmentId: 'attachment-1',
      attachmentVersionId: 'attachment-version-1',
      filename: 'library-paper.pdf',
      sizeBytes: 42,
      checksum,
      query: 'retrieval evaluator'
    }

    const first = await reader.searchAttachment(request)
    const second = await reader.searchAttachment(request)

    expect(first).toMatchObject({
      scope: 'relevant-passages',
      documents: [{ id: 'attachment-version-1', name: 'library-paper.pdf' }]
    })
    expect(second).toMatchObject({ scope: 'relevant-passages' })
    expect(resolveVersion).toHaveBeenCalledTimes(2)
    expect(extractPdfText).toHaveBeenCalledTimes(1)
    await expect(
      reader.searchAttachment({ ...request, sizeBytes: MAX_AUTO_EXTRACT_PDF_BYTES + 1 })
    ).rejects.toThrow('PDF_SIZE_LIMIT_EXCEEDED')
    expect(resolveVersion).toHaveBeenCalledTimes(2)
  })

  it('revalidates immutable Version authority before reusing extracted bytes', async () => {
    const resolveVersion = vi.fn().mockResolvedValueOnce(input).mockResolvedValue(undefined)
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
      sources: sessionPdfSources({
        resolveVersion,
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      })
    })
    const request = {
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: { documentId: 'binding-1' }
    } as const

    await expect(reader.readCurrent(request)).resolves.toMatchObject({ scope: 'full-document' })
    await expect(reader.readCurrent(request)).rejects.toThrow('LINKED_PDF_UNAVAILABLE')
    expect(resolveVersion).toHaveBeenCalledTimes(2)
    expect(extractPdfText).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'rejects checksum substitution before fresh extraction or cached reuse (manual=%s)',
    async (manual) => {
      const resolveVersion = vi
        .fn()
        .mockResolvedValueOnce(input)
        .mockResolvedValue({ ...input, checksum: secondChecksum })
      const current = manual ? confirmedSession({ 'binding-1': regions }) : session()
      const reader = new LiteratureDocumentReader({
        storageRoot: root,
        sessions: { loadSessionForContinuation: vi.fn(async () => current) },
        sources: sessionPdfSources({
          resolveVersion,
          resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
        })
      })
      await expect(reader.readCurrent({ ...readRequest, input: {} })).resolves.toMatchObject({
        scope: 'full-document'
      })
      await expect(reader.readCurrent({ ...readRequest, input: {} })).rejects.toThrow(
        'LINKED_PDF_UNAVAILABLE'
      )
      const fresh = new LiteratureDocumentReader({
        storageRoot: root,
        sessions: { loadSessionForContinuation: vi.fn(async () => current) },
        sources: sessionPdfSources({
          resolveVersion,
          resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
        })
      })
      await expect(fresh.readCurrent({ ...readRequest, input: {} })).rejects.toThrow(
        'LINKED_PDF_UNAVAILABLE'
      )
      expect(extractPdfText).toHaveBeenCalledOnce()
    }
  )

  it('bounds complete extraction before Literature batching and indexing', async () => {
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
      sources: sessionPdfSources({
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      })
    })

    await reader.readCurrent({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: { documentId: 'binding-1' }
    })

    expect(extractPdfText).toHaveBeenCalledWith(join(root, 'paper.pdf'), undefined, {
      maxChars: 24 * 1024 * 1024
    })
  })

  it('rejects a document that exceeds the bounded Literature extraction limit', async () => {
    vi.mocked(extractPdfText).mockResolvedValue({
      text: '--- Page 1 ---\npartial text',
      pageCount: 2,
      truncated: true
    })
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
      sources: sessionPdfSources({
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      })
    })

    await expect(
      reader.readCurrent({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'message-1',
        input: { documentId: 'binding-1' }
      })
    ).rejects.toThrow('PDF_TEXT_LIMIT_EXCEEDED')
  })

  it('reads sequential batches from the active document and binds the cursor to it', async () => {
    vi.mocked(extractPdfText).mockResolvedValue({
      text: `--- Page 1 ---\n${'a'.repeat(17_000)}\n--- Page 2 ---\nend`,
      pageCount: 2,
      truncated: false
    })
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
      sources: sessionPdfSources({
        resolveVersion: vi.fn(async ({ inputFileVersionId }) =>
          inputFileVersionId === 'version-2' ? secondInput : input
        ),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      })
    })

    const first = (await reader.readCurrent({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: {}
    })) as {
      document: { id: string }
      passage: { pageStart: number; pageEnd: number }
      nextCursor: string
    }

    expect(first.document.id).toBe('binding-1')
    expect(first.passage).toMatchObject({ pageStart: 1, pageEnd: 1 })
    const second = (await reader.readCurrent({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: { cursor: first.nextCursor }
    })) as { passage: { pageStart: number; pageEnd: number } }
    expect(second.passage).toMatchObject({ pageStart: 1, pageEnd: 2 })
    await expect(
      reader.readCurrent({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'message-1',
        input: { documentId: 'binding-2', cursor: first.nextCursor }
      })
    ).rejects.toThrow('cursor is invalid')
  })

  it('reads a Literature Attachment Version from the immutable message snapshot', async () => {
    const literatureSession = session()
    const message = literatureSession.messages[0]!
    const snapshot = message.pdfContext!
    const sourceBinding = snapshot.bindings[0]!
    const literatureBinding = {
      version: sourceBinding.version,
      bindingId: sourceBinding.bindingId,
      sourceKind: 'literature-attachment-version' as const,
      sourceFileId: 'attachment-1',
      sourceVersionId: 'attachment-version-1',
      name: 'library-paper.pdf',
      mimeType: sourceBinding.mimeType,
      sizeBytes: sourceBinding.sizeBytes,
      checksum: sourceBinding.checksum,
      linkedAt: sourceBinding.linkedAt
    }
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: {
        loadSessionForContinuation: vi.fn(async () => ({
          ...literatureSession,
          messages: [
            {
              ...message,
              pdfContext: {
                ...snapshot,
                bindings: [literatureBinding],
                activeBindingId: literatureBinding.bindingId
              }
            }
          ]
        }))
      },
      sources: {
        resolveVersion: vi.fn(async () => ({
          sourceKind: 'literature-attachment-version' as const,
          sourceFileId: 'attachment-1',
          sourceVersionId: 'attachment-version-1',
          filename: 'library-paper.pdf',
          contentType: 'application/pdf',
          sizeBytes: 42,
          checksum,
          path: join(root, 'library-paper.pdf')
        }))
      }
    })

    await expect(
      reader.readCurrent({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'message-1',
        input: { documentId: literatureBinding.bindingId }
      })
    ).resolves.toMatchObject({
      scope: 'full-document',
      document: { name: 'library-paper.pdf' }
    })
    await expect(
      reader.classificationEvidence({
        attachmentId: 'attachment-1',
        attachmentVersionId: 'attachment-version-1',
        filename: 'library-paper.pdf',
        sizeBytes: 42,
        checksum,
        query: 'retrieval evaluator'
      })
    ).resolves.toMatchObject({
      coverage: 'full-text',
      passages: [
        expect.objectContaining({ pageStart: 1 }),
        expect.objectContaining({ pageStart: 2 }),
        expect.objectContaining({ pageStart: 3 })
      ]
    })
    expect(extractPdfText).toHaveBeenCalledWith(join(root, 'library-paper.pdf'), undefined, {
      maxChars: 24 * 1024 * 1024
    })
  })

  describe('classificationEvidence availability', () => {
    const request = {
      attachmentId: 'attachment-1',
      attachmentVersionId: 'attachment-version-1',
      filename: 'library-paper.pdf',
      sizeBytes: 42,
      checksum,
      query: 'retrieval evaluator'
    }
    const createReader = (): {
      resolveVersion: Mock<SessionPdfSourceResolver['resolveVersion']>
      reader: LiteratureDocumentReader
    } => {
      const resolveVersion = vi.fn<SessionPdfSourceResolver['resolveVersion']>(async (source) => {
        const version = {
          sourceFileId: source.expectedSourceFileId!,
          sourceVersionId: source.sourceVersionId,
          filename: 'library-paper.pdf',
          contentType: 'application/pdf',
          sizeBytes: 42,
          checksum,
          path: join(root, 'library-paper.pdf')
        }
        if (source.sourceKind === 'literature-attachment-version')
          return { ...version, sourceKind: 'literature-attachment-version' }
        return { ...version, sourceKind: source.sourceKind, sourceSessionId: 'session-1' }
      })
      return {
        resolveVersion,
        reader: new LiteratureDocumentReader({
          storageRoot: root,
          sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
          sources: { resolveVersion }
        })
      }
    }

    it.each([
      {
        name: 'empty text in a two-page PDF',
        extraction: { text: '', pageCount: 2, truncated: false },
        code: 'PDF_TEXT_UNAVAILABLE'
      },
      {
        name: 'a single-page PDF',
        extraction: { text: 'selectable text', pageCount: 1, truncated: false },
        code: 'PDF_PAGE_COUNT_UNSUPPORTED'
      },
      {
        name: 'text exceeding the extraction limit',
        extraction: { text: 'partial text', pageCount: 2, truncated: true },
        code: 'PDF_TEXT_LIMIT_EXCEEDED'
      }
    ])(
      'returns unavailable for $name while reading tools remain strict',
      async ({ extraction, code }) => {
        vi.mocked(extractPdfText).mockResolvedValue(extraction)
        const { reader } = createReader()

        await expect(reader.classificationEvidence(request)).resolves.toEqual({
          coverage: 'unavailable',
          passages: []
        })
        await expect(
          reader.readCurrent({
            projectId: 'project-1',
            sessionId: 'session-1',
            promptMessageId: 'message-1',
            input: { documentId: 'binding-1' }
          })
        ).rejects.toThrow(code)
        await expect(
          reader.searchAttachment({ ...request, projectId: 'project-1' })
        ).rejects.toThrow(code)
      }
    )

    it('returns unavailable for an oversized PDF without resolving or extracting it', async () => {
      const { reader, resolveVersion } = createReader()
      const oversized = { ...request, sizeBytes: MAX_AUTO_EXTRACT_PDF_BYTES + 1 }

      await expect(reader.classificationEvidence(oversized)).resolves.toEqual({
        coverage: 'unavailable',
        passages: []
      })
      await expect(
        reader.searchAttachment({ ...oversized, projectId: 'project-1' })
      ).rejects.toThrow('PDF_SIZE_LIMIT_EXCEEDED')
      expect(resolveVersion).not.toHaveBeenCalled()
      expect(extractPdfText).not.toHaveBeenCalled()
    })

    it.each([
      'PDF_TEXT_UNAVAILABLE',
      'PDF_PAGE_COUNT_UNSUPPORTED',
      'PDF_SIZE_LIMIT_EXCEEDED',
      'PDF_TEXT_LIMIT_EXCEEDED'
    ])('returns unavailable for a deterministic %s extraction error', async (code) => {
      vi.mocked(extractPdfText).mockRejectedValue(new Error(`${code}: extraction rejected`))
      const { reader } = createReader()

      await expect(reader.classificationEvidence(request)).resolves.toEqual({
        coverage: 'unavailable',
        passages: []
      })
    })

    it.each([
      'EIO: temporary read failure',
      'LINKED_PDF_UNAVAILABLE: immutable bytes changed',
      'unknown extraction error',
      'PDF_TEXT_UNAVAILABLE_RETRY: temporary failure'
    ])('preserves the failed read for %s', async (message) => {
      const error = new Error(message)
      vi.mocked(extractPdfText).mockRejectedValue(error)
      const { reader } = createReader()

      await expect(reader.classificationEvidence(request)).rejects.toBe(error)
    })

    it('preserves a temporary source-resolution failure', async () => {
      const { reader, resolveVersion } = createReader()
      const error = new Error('EIO: source read failed')
      resolveVersion.mockRejectedValue(error)

      await expect(reader.classificationEvidence(request)).rejects.toBe(error)
      expect(extractPdfText).not.toHaveBeenCalled()
    })

    it('preserves an unavailable immutable source', async () => {
      const reader = new LiteratureDocumentReader({
        storageRoot: root,
        sessions: { loadSessionForContinuation: vi.fn() },
        sources: { resolveVersion: vi.fn(async () => undefined) }
      })

      await expect(reader.classificationEvidence(request)).rejects.toThrow('LINKED_PDF_UNAVAILABLE')
      expect(extractPdfText).not.toHaveBeenCalled()
    })
  })

  it('fails closed when the active message has no linked PDF snapshot', async () => {
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session(false)) },
      sources: sessionPdfSources({ resolveVersion: vi.fn(), resolveContent: vi.fn() })
    })

    await expect(
      reader.readCurrent({
        projectId: 'project-1',
        sessionId: 'session-1',
        promptMessageId: 'message-1',
        input: {}
      })
    ).rejects.toThrow('NO_LINKED_PDF_CONTEXT')
  })
})
