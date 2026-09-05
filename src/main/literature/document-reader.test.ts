import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunInputFile } from '../../shared/notebook'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { extractPdfText, MAX_AUTO_EXTRACT_PDF_BYTES } from '../uploads/attachment-media'
import { LiteratureDocumentReader } from './document-reader'
import { LiteratureFullTextIndex, literatureIndexPath } from './full-text-index'
import type { SessionPdfSourceResolver } from './session-pdf-source-resolver'

import { createLiteratureMcpServer, LITERATURE_READ_DOCUMENT_TOOL_NAME } from './mcp-server'

vi.mock('../uploads/attachment-media', () => ({
  extractPdfText: vi.fn(),
  MAX_AUTO_EXTRACT_PDF_BYTES: 50 * 1024 * 1024
}))

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
        inputs: {
          resolveVersion: vi.fn(async () => input),
          resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
        }
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
      inputs: {
        resolveVersion: vi.fn(async ({ inputFileVersionId }) =>
          inputFileVersionId === 'version-2' ? secondInput : input
        ),
        resolveContent: vi.fn(async (resolved) =>
          join(root, resolved.inputFileVersionId === 'version-2' ? 'second.pdf' : 'paper.pdf')
        )
      }
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

  it('preserves every linked binding when PDFs share the same extracted content', async () => {
    const duplicateInput = { ...secondInput, checksum }
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session(true, checksum)) },
      sources: sessionPdfSources({
        resolveVersion: vi.fn(async ({ inputFileVersionId }) =>
          inputFileVersionId === 'version-2' ? duplicateInput : input
        ),
        resolveContent: vi.fn(async (resolved) =>
          join(root, resolved.inputFileVersionId === 'version-2' ? 'second.pdf' : 'paper.pdf')
        )
      })
    })

    const result = await reader.readCurrent({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: { query: 'incorrect retrieved documents' }
    })

    expect(result).toMatchObject({ scope: 'relevant-passages', retrievalMode: 'bm25' })
    expect(
      new Set(
        (result as { passages: Array<{ documentId: string }> }).passages.map(
          ({ documentId }) => documentId
        )
      )
    ).toEqual(new Set(['binding-1', 'binding-2']))
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

  it('falls back to bounded in-memory retrieval when the BM25 sidecar is unavailable', async () => {
    vi.spyOn(LiteratureFullTextIndex, 'open').mockRejectedValueOnce(new Error('sqlite unavailable'))
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
      sources: sessionPdfSources({
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      })
    })

    const result = await reader.readCurrent({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: { documentIds: ['binding-1'], query: 'retrieval evaluator' }
    })

    expect(result).toMatchObject({
      scope: 'relevant-passages',
      retrievalMode: 'fallback'
    })
    expect((result as { passages: unknown[] }).passages).toEqual(
      expect.arrayContaining([expect.objectContaining({ pageStart: 2 })])
    )
  })

  it('falls back to CJK bigram retrieval when unicode61 returns no BM25 match', async () => {
    vi.mocked(extractPdfText).mockResolvedValue({
      text: [
        '--- Page 1 ---',
        '背景介绍。',
        '--- Page 2 ---',
        '本研究的主要结论是检索评估器能够提高可靠性。'
      ].join('\n'),
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

    const result = await reader.readCurrent({
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: { documentIds: ['binding-1'], query: '这篇论文的主要结论是什么' }
    })

    expect(result).toMatchObject({ scope: 'relevant-passages', retrievalMode: 'fallback' })
    expect((result as { passages: unknown[] }).passages).toEqual(
      expect.arrayContaining([expect.objectContaining({ pageStart: 2 })])
    )
  })

  it('rebuilds an expired BM25 index automatically on the next query', async () => {
    const replace = vi.spyOn(LiteratureFullTextIndex.prototype, 'replace')
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
      sources: sessionPdfSources({
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      })
    })
    const request = {
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: { documentIds: ['binding-1'], query: 'retrieval evaluator' }
    } as const

    await reader.readCurrent(request)
    expect(replace).toHaveBeenCalledTimes(1)
    await LiteratureFullTextIndex.flushPendingAccesses(root)

    const client = new PrismaClient({
      datasources: { db: { url: `file:${literatureIndexPath(root)}?connection_limit=1` } }
    })
    await client.$executeRawUnsafe(
      `UPDATE "LiteratureIndexDocument" SET "lastAccessedAt" = datetime('now', '-2 days')`
    )
    await client.$disconnect()
    await LiteratureFullTextIndex.sweepExpired(root)

    await expect(reader.readCurrent(request)).resolves.toMatchObject({ retrievalMode: 'bm25' })
    expect(replace).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent rebuilds for the same extracted document', async () => {
    let releaseBuild: (() => void) | undefined
    let reportBuildStarted: (() => void) | undefined
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve
    })
    const buildStarted = new Promise<void>((resolve) => {
      reportBuildStarted = resolve
    })
    const originalReplace = LiteratureFullTextIndex.prototype.replace
    const replace = vi
      .spyOn(LiteratureFullTextIndex.prototype, 'replace')
      .mockImplementation(async function (this: LiteratureFullTextIndex, request) {
        reportBuildStarted?.()
        await buildGate
        await originalReplace.call(this, request)
      })
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
      sources: sessionPdfSources({
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      })
    })
    const request = {
      projectId: 'project-1',
      sessionId: 'session-1',
      promptMessageId: 'message-1',
      input: { documentIds: ['binding-1'], query: 'retrieval evaluator' }
    } as const

    const first = reader.readCurrent(request)
    await buildStarted
    const second = reader.readCurrent(request)
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseBuild?.()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ retrievalMode: 'bm25' }),
      expect.objectContaining({ retrievalMode: 'bm25' })
    ])
    expect(replace).toHaveBeenCalledTimes(1)
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

  it('indexes long pages with a small overlap between adjacent chunks', async () => {
    vi.mocked(extractPdfText).mockResolvedValue({
      text: `--- Page 1 ---\n${'a'.repeat(5_200)}\n--- Page 2 ---\ncontinuation`,
      pageCount: 2,
      truncated: false
    })
    const replace = vi.spyOn(LiteratureFullTextIndex.prototype, 'replace')
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
      input: { documentIds: ['binding-1'], query: 'aaaa' }
    })

    const chunks = (replace.mock.calls[0]?.[0].chunks ?? []).filter(
      ({ pageStart }) => pageStart === 1
    )
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.textEnd - (chunks[1]?.textStart ?? 0)).toBe(250)
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
    expect(extractPdfText).toHaveBeenCalledWith(join(root, 'library-paper.pdf'), undefined, {
      maxChars: 24 * 1024 * 1024
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
