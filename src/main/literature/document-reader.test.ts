import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunInputFile } from '../../shared/notebook'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { extractPdfText } from '../uploads/attachment-media'
import { LiteratureDocumentReader } from './document-reader'
import { LiteratureFullTextIndex, literatureIndexPath } from './full-text-index'

vi.mock('../uploads/attachment-media', () => ({ extractPdfText: vi.fn() }))

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
      inputs: { resolveVersion, resolveContent }
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
      inputs: {
        resolveVersion: vi.fn(async ({ inputFileVersionId }) =>
          inputFileVersionId === 'version-2' ? duplicateInput : input
        ),
        resolveContent: vi.fn(async (resolved) =>
          join(root, resolved.inputFileVersionId === 'version-2' ? 'second.pdf' : 'paper.pdf')
        )
      }
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

  it('falls back to bounded in-memory retrieval when the BM25 sidecar is unavailable', async () => {
    vi.spyOn(LiteratureFullTextIndex, 'open').mockRejectedValueOnce(new Error('sqlite unavailable'))
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session()) },
      inputs: {
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      }
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
      inputs: {
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      }
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
      inputs: {
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      }
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
      inputs: {
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      }
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
      inputs: {
        resolveVersion,
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      }
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
      inputs: {
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      }
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
      inputs: {
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      }
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
      inputs: {
        resolveVersion: vi.fn(async () => input),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      }
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
      inputs: {
        resolveVersion: vi.fn(async ({ inputFileVersionId }) =>
          inputFileVersionId === 'version-2' ? secondInput : input
        ),
        resolveContent: vi.fn(async () => join(root, 'paper.pdf'))
      }
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

  it('fails closed when the active message has no linked PDF snapshot', async () => {
    const reader = new LiteratureDocumentReader({
      storageRoot: root,
      sessions: { loadSessionForContinuation: vi.fn(async () => session(false)) },
      inputs: { resolveVersion: vi.fn(), resolveContent: vi.fn() }
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
