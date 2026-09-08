import type { PrismaClient } from '@prisma/client'
import { LiteratureAttachmentAuthority } from '../literature/attachment-authority'
import { describe, expect, it, vi, type Mock } from 'vitest'

import type { NotebookRunInputFile } from '../../shared/notebook'
import {
  sessionApplicationCommandContracts,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { SessionPdfSourceResolver } from '../literature/session-pdf-source-resolver'
import { inspectPdfPageCount, MAX_AUTO_EXTRACT_PDF_BYTES } from '../uploads/attachment-media'
import { SessionPdfContextOwner } from './pdf-context-owner'

vi.mock('../uploads/attachment-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../uploads/attachment-media')>()),
  inspectPdfPageCount: vi.fn(async () => 2)
}))

const input = {
  inputFileVersionId: 'version-1',
  sourceKind: 'artifact-version',
  sourceFileId: 'artifact-1',
  sourceVersionNumber: 3,
  sourceProjectId: 'project-1',
  sourceSessionId: 'source-session-1',
  filename: 'paper.pdf',
  contentType: 'application/pdf',
  sizeBytes: 42,
  checksum: 'a'.repeat(64),
  storageKey: 'artifacts/version-1.pdf',
  association: 'turn-attached'
} satisfies NotebookRunInputFile

type SessionPdfContextOwnerHarness = Readonly<{
  owner: SessionPdfContextOwner
  resolveVersion: Mock
  resolveContent: Mock
  readSessionRuntimeContext: Mock
  patchSessionRuntimeContext: Mock
}>

const setup = (resolved: NotebookRunInputFile | null = input): SessionPdfContextOwnerHarness => {
  const resolveVersion: Mock = vi.fn(async () => resolved ?? undefined)
  const resolveContent: Mock = vi.fn(async () => '/managed/paper.pdf')
  const resolvePendingContent = vi.fn(async () => '/managed/pending.pdf')
  const readSessionRuntimeContext = vi.fn<
    (projectId: string, sessionId: string) => Promise<SessionRuntimeContext>
  >(async () => ({ version: 1, revision: 4 }))
  const patchSessionRuntimeContext = vi.fn(async (request) => ({
    version: 1 as const,
    revision: request.expectedRevision + 1,
    ...request.patch
  }))
  const owner = new SessionPdfContextOwner({
    sources: {
      resolveVersion: async (request) => {
        if (request.sourceKind === 'literature-attachment-version') return undefined
        const resolvedInput = await resolveVersion({
          projectId: request.projectId,
          sourceKind: request.sourceKind,
          inputFileVersionId: request.sourceVersionId,
          ...(request.expectedSourceFileId
            ? { expectedSourceFileId: request.expectedSourceFileId }
            : {})
        })
        if (!resolvedInput) return undefined
        return {
          sourceKind: resolvedInput.sourceKind,
          sourceFileId: resolvedInput.sourceFileId,
          sourceVersionId: resolvedInput.inputFileVersionId,
          sourceSessionId: resolvedInput.sourceSessionId,
          filename: resolvedInput.filename,
          contentType: resolvedInput.contentType,
          sizeBytes: resolvedInput.sizeBytes,
          checksum: resolvedInput.checksum,
          path: await resolveContent(resolvedInput)
        }
      }
    },
    pendingUploads: { resolveContent: resolvePendingContent },
    sessions: { readSessionRuntimeContext, patchSessionRuntimeContext }
  })
  return {
    owner,
    resolveVersion,
    resolveContent,
    readSessionRuntimeContext,
    patchSessionRuntimeContext
  }
}

describe('SessionPdfContextOwner', () => {
  it.each(['missing', 'checksum-mismatch', 'authority-mismatch', 'database', 'storage'])(
    'LR-02 isolates attachment failure but preserves service errors (%s)',
    async (failure) => {
      const findUnique = vi.fn(async ({ where: { id } }) => {
        if (failure === 'database') throw new Error('database read failed')
        return {
          id,
          attachmentId: id,
          versionNumber: 1,
          contentBlobId: id,
          filename: `${id}.pdf`,
          contentType: 'application/pdf',
          sizeBytes: 42n,
          checksum: id,
          pageCount: 2,
          attachment: { itemId: id, item: { deletedAt: null } },
          contentBlob: { storageKey: id }
        }
      })
      const verify = vi.fn(async (id: string) => {
        if (failure === 'storage') throw new Error('storage offline')
        if (id === 'bad' && (failure === 'missing' || failure === 'checksum-mismatch')) {
          return { state: 'unavailable', reason: failure } as const
        }
        return {
          state: 'available' as const,
          content: {
            id,
            path: `/managed/${id}.pdf`,
            storageKey: id,
            checksum: id === 'bad' ? 'wrong-checksum' : id,
            sizeBytes: 42n,
            contentType: 'application/pdf'
          }
        }
      })
      const literature = new LiteratureAttachmentAuthority({
        getClient: async () =>
          ({ literatureAttachmentVersion: { findUnique } }) as unknown as PrismaClient,
        content: { verify }
      })
      const owner = new SessionPdfContextOwner({
        sources: new SessionPdfSourceResolver({
          literature,
          inputs: { resolveVersion: vi.fn(), openContent: vi.fn() }
        }),
        sessions: { readSessionRuntimeContext: vi.fn(), patchSessionRuntimeContext: vi.fn() }
      })
      const sources = ['bad', 'good'].map((sourceVersionId) => ({
        sourceKind: 'literature-attachment-version' as const,
        sourceVersionId
      }))
      const result = owner
        .filterCandidates({ projectId: 'project-1', sources })
        .then((result) =>
          sessionApplicationCommandContracts.filterPdfContextCandidates.result.parse(result)
        )
      if (failure === 'database' || failure === 'storage') {
        await expect(result).rejects.toThrow(
          failure === 'database' ? 'database read failed' : 'storage offline'
        )
      } else {
        await expect(result).resolves.toMatchObject({
          sources: [sources[1]],
          unavailableSources: [sources[0]]
        })
        expect(findUnique).toHaveBeenCalledTimes(2)
      }
    }
  )

  it('bounds and validates unavailable sources at the candidate result boundary', () => {
    const parse = sessionApplicationCommandContracts.filterPdfContextCandidates.result.parse
    const source = { sourceKind: 'literature-attachment-version', sourceVersionId: 'missing' }
    const result = { sources: [], pendingAttachmentIds: [] }
    expect(parse(result)).toEqual(result)
    expect(parse({ ...result, unavailableSources: Array(100).fill(source) })).toHaveProperty(
      'unavailableSources.length',
      100
    )
    expect(() => parse({ ...result, unavailableSources: Array(101).fill(source) })).toThrow()
    expect(() =>
      parse({ ...result, unavailableSources: [{ ...source, sourceVersionId: '' }] })
    ).toThrow()
  })

  it('filters PDF context candidates to multi-page immutable Versions', async () => {
    const harness = setup()
    harness.resolveVersion.mockImplementation(async ({ inputFileVersionId }) =>
      inputFileVersionId === 'missing'
        ? undefined
        : {
            ...input,
            inputFileVersionId,
            sourceFileId: inputFileVersionId,
            filename: inputFileVersionId === 'notes' ? 'notes.txt' : `${inputFileVersionId}.pdf`,
            contentType: inputFileVersionId === 'notes' ? 'text/plain' : 'application/pdf',
            checksum: inputFileVersionId === 'single-page' ? 'b'.repeat(64) : 'c'.repeat(64)
          }
    )
    vi.mocked(inspectPdfPageCount).mockResolvedValueOnce(1).mockResolvedValueOnce(8)

    await expect(
      harness.owner.filterCandidates({
        projectId: 'project-1',
        sources: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'single-page',
            sourceVersionId: 'single-page'
          },
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'multi-page',
            sourceVersionId: 'multi-page'
          },
          { sourceKind: 'artifact-version', sourceFileId: 'notes', sourceVersionId: 'notes' },
          { sourceKind: 'artifact-version', sourceFileId: 'missing', sourceVersionId: 'missing' }
        ]
      })
    ).resolves.toEqual({
      sources: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'multi-page',
          sourceVersionId: 'multi-page'
        }
      ],
      pendingAttachmentIds: [],
      unavailableSources: [
        { sourceKind: 'artifact-version', sourceFileId: 'missing', sourceVersionId: 'missing' }
      ]
    })
  })

  it('filters staged PDFs before a provider Session is created', async () => {
    const harness = setup()
    vi.mocked(inspectPdfPageCount).mockResolvedValueOnce(1).mockResolvedValueOnce(5)

    await expect(
      harness.owner.filterCandidates({
        projectId: 'project-1',
        sources: [],
        pendingAttachments: [
          {
            attachmentId: 'single-page',
            path: '/pending/single.pdf',
            name: 'single.pdf',
            mimeType: 'application/pdf'
          },
          {
            attachmentId: 'multi-page',
            path: '/pending/multi.pdf',
            name: 'multi.pdf',
            mimeType: 'application/pdf'
          }
        ]
      })
    ).resolves.toEqual({ sources: [], pendingAttachmentIds: ['multi-page'] })
  })

  it('resolves immutable bytes before installing one revision-fenced PDF binding', async () => {
    const harness = setup()

    const context = await harness.owner.link({
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 4,
      sources: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-1'
        }
      ]
    })

    expect(harness.resolveVersion).toHaveBeenCalledWith({
      projectId: 'project-1',
      sourceKind: 'artifact-version',
      inputFileVersionId: 'version-1',
      expectedSourceFileId: 'artifact-1'
    })
    expect(harness.patchSessionRuntimeContext).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 4,
      patch: {
        pdfContext: {
          version: 1,
          bindings: [
            expect.objectContaining({
              version: 1,
              sourceFileId: 'artifact-1',
              sourceVersionId: 'version-1',
              checksum: 'a'.repeat(64),
              name: 'paper.pdf'
            })
          ]
        }
      }
    })
    expect(context.pdfContext?.bindings[0]?.bindingId).toEqual(expect.any(String))
  })

  it('links a newly finalized upload through its complete immutable Version identity', async () => {
    const openVersion = vi.fn().mockResolvedValue({
      path: '/managed/paper.pdf',
      size: input.sizeBytes,
      logicalFile: {
        source: 'upload',
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        displayName: input.filename,
        currentVersionId: input.inputFileVersionId
      },
      version: {
        id: input.inputFileVersionId,
        fileId: 'upload-1',
        versionNumber: 1,
        contentStorageKey: input.storageKey,
        filename: input.filename,
        originalFilename: input.filename,
        contentType: input.contentType,
        sizeBytes: BigInt(input.sizeBytes),
        checksum: input.checksum,
        createdAt: new Date('2026-09-03T00:00:00.000Z')
      },
      verifyUnchanged: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    })
    const readSessionRuntimeContext = vi.fn(async () => ({ version: 1 as const, revision: 0 }))
    const patchSessionRuntimeContext = vi.fn(async (request) => ({
      version: 1 as const,
      revision: request.expectedRevision + 1,
      ...request.patch
    }))
    const inputs = new ImmutableInputAuthority({
      storageRoot: '/storage',
      managedFileVersions: { openVersion }
    } as never)
    const owner = new SessionPdfContextOwner({
      sources: new SessionPdfSourceResolver({
        inputs,
        literature: { resolveVersion: vi.fn() }
      }),
      sessions: { readSessionRuntimeContext, patchSessionRuntimeContext }
    })
    const source = {
      sourceKind: 'upload-version' as const,
      sourceFileId: 'upload-1',
      sourceVersionId: input.inputFileVersionId
    }

    await expect(
      owner.link({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 0,
        sources: [source],
        excludeSinglePage: true
      })
    ).resolves.toMatchObject({
      revision: 1,
      pdfContext: {
        bindings: [
          expect.objectContaining({
            sourceKind: 'upload-version',
            sourceFileId: 'upload-1',
            sourceVersionId: input.inputFileVersionId
          })
        ]
      }
    })
    expect(openVersion).toHaveBeenCalledWith(
      { source: 'upload', projectId: 'project-1', fileId: 'upload-1' },
      input.inputFileVersionId
    )
  })

  it('rejects unavailable and non-PDF versions without mutating the Session', async () => {
    const unavailable = setup(null)
    await expect(
      unavailable.owner.link({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 4,
        sources: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'missing'
          }
        ]
      })
    ).rejects.toThrow('unavailable')
    expect(unavailable.patchSessionRuntimeContext).not.toHaveBeenCalled()

    const nonPdf = setup({ ...input, filename: 'data.csv', contentType: 'text/csv' })
    await expect(
      nonPdf.owner.link({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 4,
        sources: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'version-1'
          }
        ]
      })
    ).rejects.toThrow('Only PDF')
    expect(nonPdf.patchSessionRuntimeContext).not.toHaveBeenCalled()
  })

  it('does not offer or link PDFs that the Literature reader cannot extract', async () => {
    const harness = setup({ ...input, sizeBytes: MAX_AUTO_EXTRACT_PDF_BYTES + 1 })
    vi.mocked(inspectPdfPageCount).mockClear()

    await expect(
      harness.owner.filterCandidates({
        projectId: 'project-1',
        sources: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'version-1'
          }
        ]
      })
    ).resolves.toEqual({ sources: [], pendingAttachmentIds: [] })
    expect(inspectPdfPageCount).not.toHaveBeenCalled()

    await expect(
      harness.owner.link({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 4,
        sources: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'version-1'
          }
        ]
      })
    ).rejects.toThrow('exceeding the automatic extraction limit')
    expect(harness.patchSessionRuntimeContext).not.toHaveBeenCalled()
  })

  it('reports no mutation when another request already linked the same PDF', async () => {
    const harness = setup()
    const current: SessionRuntimeContext = {
      version: 1,
      revision: 5,
      pdfContext: {
        version: 1,
        bindings: [
          {
            version: 1,
            bindingId: 'binding-1',
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'version-1',
            sourceSessionId: 'source-session-1',
            name: 'paper.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 42,
            checksum: 'a'.repeat(64),
            linkedAt: 1
          }
        ]
      }
    }
    harness.readSessionRuntimeContext.mockResolvedValue(current)

    await expect(
      harness.owner.linkWithResult({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 4,
        sources: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'version-1'
          }
        ]
      })
    ).resolves.toEqual({ context: current, changed: false })
    expect(harness.patchSessionRuntimeContext).not.toHaveBeenCalled()
  })

  it('unlinks only the binding the caller observed', async () => {
    const harness = setup()
    harness.readSessionRuntimeContext.mockResolvedValue({
      version: 1,
      revision: 4,
      pdfContext: {
        version: 1,
        bindings: [
          {
            version: 1,
            bindingId: 'binding-1',
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'version-1',
            sourceSessionId: 'source-session-1',
            name: 'paper.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 42,
            checksum: 'a'.repeat(64),
            linkedAt: 1
          }
        ]
      }
    })

    await harness.owner.unlink({
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 4,
      bindingId: 'binding-1'
    })
    expect(harness.patchSessionRuntimeContext).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 4,
      patch: { pdfContext: undefined }
    })

    await expect(
      harness.owner.unlink({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 4,
        bindingId: 'stale-binding'
      })
    ).rejects.toThrow('binding changed')
  })

  it('excludes single-page PDFs from automatic linking and rejects them explicitly', async () => {
    vi.mocked(inspectPdfPageCount).mockResolvedValueOnce(1)
    const automatic = setup()
    const unchanged = await automatic.owner.link({
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 4,
      sources: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-1'
        }
      ],
      excludeSinglePage: true
    })
    expect(unchanged.pdfContext).toBeUndefined()
    expect(automatic.patchSessionRuntimeContext).not.toHaveBeenCalled()

    vi.mocked(inspectPdfPageCount).mockResolvedValueOnce(1)
    const explicit = setup()
    await expect(
      explicit.owner.link({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 4,
        sources: [
          {
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'version-1'
          }
        ]
      })
    ).rejects.toThrow('multi-page')
  })

  it('keeps up to three multi-page PDFs and does not charge excluded single-page files', async () => {
    const harness = setup()
    harness.readSessionRuntimeContext.mockResolvedValue({
      version: 1,
      revision: 4,
      pdfContext: {
        version: 1,
        bindings: [
          {
            version: 1,
            bindingId: 'binding-1',
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceVersionId: 'version-1',
            sourceSessionId: 'source-session-1',
            name: 'paper-1.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 42,
            checksum: 'a'.repeat(64),
            linkedAt: 1
          },
          {
            version: 1,
            bindingId: 'binding-2',
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-2',
            sourceVersionId: 'version-2',
            sourceSessionId: 'source-session-1',
            name: 'paper-2.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 42,
            checksum: 'b'.repeat(64),
            linkedAt: 2
          }
        ]
      }
    })
    harness.resolveVersion.mockImplementation(async ({ inputFileVersionId }) => ({
      ...input,
      inputFileVersionId,
      sourceFileId: inputFileVersionId,
      filename: `${inputFileVersionId}.pdf`,
      checksum: inputFileVersionId === 'version-3' ? 'c'.repeat(64) : 'd'.repeat(64)
    }))
    vi.mocked(inspectPdfPageCount).mockResolvedValueOnce(1).mockResolvedValueOnce(8)

    const context = await harness.owner.link({
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 4,
      sources: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'single-page',
          sourceVersionId: 'single-page'
        },
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'version-3',
          sourceVersionId: 'version-3'
        }
      ],
      excludeSinglePage: true
    })

    expect(context.pdfContext?.bindings).toHaveLength(3)
    expect(context.pdfContext?.bindings.map(({ sourceVersionId }) => sourceVersionId)).toEqual([
      'version-1',
      'version-2',
      'version-3'
    ])
  })
})
