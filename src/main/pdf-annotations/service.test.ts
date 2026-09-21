import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PdfAnnotationService, type PdfAnnotationServiceOptions } from './service'
import {
  pdfNativeAnnotationImportProgressSchema,
  type CreatePdfAnnotationRequest
} from '../../shared/pdf-annotations'
const parseNative = vi.hoisted(() => vi.fn())
vi.mock('./native-import', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./native-import')>()),
  parseNativePdfAnnotations: parseNative
}))
beforeEach(() => {
  parseNative.mockReset()
})
const request: CreatePdfAnnotationRequest = {
  id: 'note-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  kind: 'document-note',
  tagIds: [],
  note: 'Read again',
  target: {
    source: {
      kind: 'upload-version',
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceFileId: 'upload-1',
      versionId: 'version-1',
      checksum: 'a'.repeat(64),
      name: 'paper.pdf',
      path: 'upload-version:project-1/session-1/upload-1/version-1'
    },
    selector: { kind: 'document-note', coordinateVersion: 1 }
  }
}
const fixture = (): { options: PdfAnnotationServiceOptions; service: PdfAnnotationService } => {
  const options = {
    repository: {
      get: vi.fn().mockResolvedValue({
        ...request,
        version: 1,
        createdAt: '2026-09-19T00:00:00.000Z',
        updatedAt: '2026-09-19T00:00:00.000Z'
      }),
      list: vi.fn(),
      nativeImportReceipt: vi.fn().mockResolvedValue(undefined),
      createMany: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockResolvedValue(request),
      recoverCreate: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(),
      delete: vi.fn()
    },
    literature: {
      resolveVersion: vi.fn().mockResolvedValue({
        attachmentId: 'file-1',
        versionId: 'version-1',
        filename: 'paper.pdf',
        contentType: 'application/pdf',
        checksum: 'a'.repeat(64)
      }),
      openContent: vi.fn().mockResolvedValue({
        verifyUnchanged: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined)
      })
    },
    sessions: {
      loadSessionWithDiagnostics: vi.fn().mockResolvedValue({
        status: 'found',
        session: { id: request.sessionId!, projectId: request.projectId }
      })
    },
    resolveSessionPdfVersion: vi.fn().mockResolvedValue({
      sourceKind: 'upload-version',
      sourceFileId: 'upload-1',
      sourceVersionId: 'version-1',
      sourceSessionId: 'session-1',
      filename: 'paper.pdf',
      path: 'upload-version:version-1',
      checksum: 'a'.repeat(64),
      sizeBytes: 10,
      openContent: vi.fn().mockResolvedValue({
        path: '/tmp/paper.pdf',
        verifyUnchanged: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined)
      })
    }),
    onNativeImportProgress: vi.fn(),
    runWithSessionAuthority: vi.fn(
      async (_project: string, _session: string, operation: () => Promise<unknown>) => operation()
    )
  }
  return {
    options: options as unknown as PdfAnnotationServiceOptions,
    service: new PdfAnnotationService(options as unknown as PdfAnnotationServiceOptions)
  }
}
describe('PdfAnnotationService', () => {
  it('validates the exact source before creating inside the Session write authority', async () => {
    const { options, service } = fixture()
    await service.create(request)
    expect(options.repository.create).toHaveBeenCalledWith(request)
    expect(options.runWithSessionAuthority).toHaveBeenCalledOnce()
    vi.mocked(options.resolveSessionPdfVersion).mockResolvedValue({
      ...(await options.resolveSessionPdfVersion(importRequest))!,
      checksum: 'b'.repeat(64)
    })
    await expect(service.create(request)).rejects.toThrow('source is not available')
    expect(options.repository.create).toHaveBeenCalledTimes(1)
  })
  it('rejects every mutation of an imported Session and never writes', async () => {
    const { options, service } = fixture()
    vi.mocked(options.sessions.loadSessionWithDiagnostics).mockResolvedValue({
      status: 'found',
      session: {
        id: request.sessionId!,
        projectId: request.projectId!,
        title: 'Imported',
        cwd: '/workspace',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
        packageOrigin: {
          importId: 'import-1',
          sourceProjectId: 'source-project',
          sourceSessionId: 'source-session',
          importedAt: 1,
          manifestChecksum: 'a'.repeat(64)
        }
      }
    })
    await expect(service.create(request)).rejects.toThrow('read-only')
    await expect(
      service.update({
        projectId: request.projectId!,
        sessionId: request.sessionId,
        id: request.id,
        note: ''
      })
    ).rejects.toThrow('read-only')
    await expect(
      service.delete({
        projectId: request.projectId!,
        sessionId: request.sessionId,
        id: request.id
      })
    ).rejects.toThrow('read-only')
    expect(options.repository.create).not.toHaveBeenCalled()
    expect(options.repository.update).not.toHaveBeenCalled()
    expect(options.repository.delete).not.toHaveBeenCalled()
  })
  it('rejects unreadable scopes before listing annotations', async () => {
    const { options, service } = fixture()
    vi.mocked(options.sessions.loadSessionWithDiagnostics).mockResolvedValue({
      status: 'unreadable'
    })
    await expect(
      service.list({ projectId: request.projectId!, sessionId: request.sessionId })
    ).rejects.toThrow('not available')
    expect(options.repository.list).not.toHaveBeenCalled()
  })
})

it('resolves and saves library annotations without inventing a Project or Session', async () => {
  const { options, service } = fixture()
  const source = {
    ...request.target.source,
    kind: 'literature-attachment-version' as const,
    projectId: undefined,
    sessionId: undefined,
    sourceFileId: 'file-1',
    path: 'literature-attachment-version:version-1'
  }
  const global = {
    ...request,
    projectId: undefined,
    sessionId: undefined,
    literatureVersionId: 'version-1',
    target: { ...request.target, source }
  }
  vi.mocked(options.repository.list).mockResolvedValue({ items: [], total: 0 })
  expect(await service.list({ literatureVersionId: 'version-1' })).toMatchObject({
    items: [],
    source: JSON.parse(JSON.stringify(source))
  })
  await service.create(global)
  expect(options.repository.create).toHaveBeenCalledWith(global)
  expect(options.sessions.loadSessionWithDiagnostics).not.toHaveBeenCalled()
  expect(options.runWithSessionAuthority).not.toHaveBeenCalled()
  await expect(
    service.create({
      ...global,
      target: { ...global.target, source: { ...source, checksum: 'b'.repeat(64) } }
    })
  ).rejects.toThrow('source is not available')
  vi.mocked(options.literature.resolveVersion).mockResolvedValue(undefined)
  await expect(service.list({ literatureVersionId: 'version-1' })).rejects.toThrow(
    'source is not available'
  )
})

const importRequest = {
  operationId: 'operation-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  sourceKind: 'upload-version' as const,
  sourceFileId: 'upload-1',
  versionId: 'version-1'
}
const parsed = {
  pageCount: 2,
  annotations: [
    {
      stableKey: 'native-object',
      pageNumber: 1,
      kind: 'area',
      color: 'yellow',
      note: 'External comment',
      subtype: 'Text',
      selector: {
        kind: 'region',
        pageNumber: 1,
        pageRotation: 0,
        coordinateVersion: 1,
        rect: { x: 0, y: 0, width: 0.1, height: 0.1 }
      }
    }
  ],
  unsupportedCount: 3,
  truncated: false
}

it.each(['upload-version', 'artifact-version'] as const)(
  'imports %s native provenance once per source across sessions',
  async (sourceKind) => {
    const { options, service } = fixture()
    const source = await options.resolveSessionPdfVersion(importRequest)
    vi.mocked(options.resolveSessionPdfVersion).mockResolvedValue({
      ...source!,
      sourceKind,
      sourceSessionId: 'session-1'
    })
    const nativeRequest = { ...importRequest, sourceKind }
    parseNative.mockResolvedValue(parsed)
    expect(await service.importNative(nativeRequest)).toMatchObject({
      importedCount: 1,
      unsupportedCount: 3
    })
    expect(options.repository.createMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          origin: 'imported',
          externalSubtype: 'Text',
          note: 'External comment',
          projectId: 'project-1',
          sessionId: 'session-1'
        })
      ],
      expect.objectContaining({
        result: expect.objectContaining({ pageCount: expect.any(Number) })
      })
    )
    expect(
      await service.importNative({ ...nativeRequest, operationId: 'operation-2' })
    ).toMatchObject({ operationId: 'operation-2', importedCount: 1 })
    expect(parseNative).toHaveBeenCalledOnce()
    for (const [progress] of vi.mocked(options.onNativeImportProgress!).mock.calls) {
      expect(pdfNativeAnnotationImportProgressSchema.safeParse(progress).success).toBe(true)
    }
    await service.importNative({
      ...nativeRequest,
      operationId: 'operation-3',
      sessionId: 'session-2'
    })
    const calls = vi.mocked(options.repository.createMany).mock.calls
    expect(calls).toHaveLength(1)
    expect(parseNative).toHaveBeenCalledOnce()
  }
)

it('cancels after parsing and closes the lease without writing', async () => {
  const { options, service } = fixture()
  parseNative.mockImplementation(async () => {
    expect(service.cancelImport({ operationId: importRequest.operationId })).toEqual({
      cancelled: true
    })
    return parsed
  })
  expect(await service.importNative(importRequest)).toMatchObject({
    cancelled: true,
    importedCount: 0
  })
  expect(options.repository.createMany).not.toHaveBeenCalled()
  const resolved = await options.resolveSessionPdfVersion(importRequest)
  const lease = await resolved!.openContent!()
  expect(lease.close).toHaveBeenCalledOnce()
  expect(service.cancelImport({ operationId: importRequest.operationId })).toEqual({
    cancelled: false
  })
  parseNative.mockResolvedValue(parsed)
  expect(await service.importNative(importRequest)).toMatchObject({
    cancelled: false,
    importedCount: 1
  })
})

it('rejects an already-disconnected caller before resolving or parsing', async () => {
  const { options, service } = fixture()
  await expect(
    service.importNative(importRequest, AbortSignal.abort(new Error('Disconnected')))
  ).rejects.toThrow('Disconnected')
  expect(options.resolveSessionPdfVersion).not.toHaveBeenCalled()
  expect(parseNative).not.toHaveBeenCalled()
})

it('accepts cancellation while source authority is still pending and never starts parsing', async () => {
  const { service, options } = fixture()
  const pending = service.importNative(importRequest)
  expect(service.cancelImport({ operationId: importRequest.operationId })).toEqual({
    cancelled: true
  })
  expect(await pending).toMatchObject({ cancelled: true })
  expect(parseNative).not.toHaveBeenCalled()
  expect(options.repository.createMany).not.toHaveBeenCalled()
})

it('parses outside the Session writer and revalidates source availability before saving', async () => {
  const { service, options } = fixture()
  parseNative.mockImplementation(async () => {
    expect(options.runWithSessionAuthority).not.toHaveBeenCalled()
    vi.mocked(options.resolveSessionPdfVersion).mockResolvedValue(undefined)
    return parsed
  })
  await expect(service.importNative(importRequest)).rejects.toThrow('source is not available')
  expect(options.runWithSessionAuthority).toHaveBeenCalledOnce()
  expect(options.repository.createMany).not.toHaveBeenCalled()
})

it('allows document-scoped reads and edits independently of the annotation creator session', async () => {
  const { options, service } = fixture()
  await service.list({ projectId: 'project-1', sourceFileId: 'upload-1', versionId: 'version-1' })
  expect(options.sessions.loadSessionWithDiagnostics).not.toHaveBeenCalled()
  await service.update({ projectId: 'project-1', id: request.id, note: 'Shared' })
  expect(options.repository.update).toHaveBeenCalledWith({
    projectId: 'project-1',
    id: request.id,
    note: 'Shared'
  })
  await service.setTagAssignment({
    resourceType: 'pdf.annotation',
    resourceId: request.id,
    tagId: 'review',
    assigned: true
  })
  expect(options.repository.update).toHaveBeenLastCalledWith(
    expect.objectContaining({ projectId: 'project-1', tagIds: ['review'] })
  )
  expect(vi.mocked(options.repository.update).mock.calls.at(-1)![0].sessionId).toBeUndefined()
})

it('restores native project annotations by verified file version without the creator Session', async () => {
  const { options, service } = fixture()
  parseNative.mockResolvedValue(parsed)
  await service.importNative(importRequest)
  const imported = vi.mocked(options.repository.createMany).mock.calls[0][0][0]
  await service.create({ ...imported, sessionId: undefined })
  expect(options.repository.create).toHaveBeenLastCalledWith({ ...imported, sessionId: undefined })
  await service.create({ ...imported, sessionId: 'session-2' })
  expect(options.repository.create).toHaveBeenLastCalledWith({
    ...imported,
    sessionId: 'session-2'
  })
  for (const change of [{ path: '/untrusted.pdf' }, { checksum: 'b'.repeat(64) }]) {
    await expect(
      service.create({
        ...imported,
        sessionId: undefined,
        target: { ...imported.target, source: { ...imported.target.source, ...change } }
      })
    ).rejects.toThrow('source is not available')
  }
})

it.each([undefined, 'session-1'])(
  'rejects project-owned Library notes before retry recovery (session: %s)',
  async (sessionId) => {
    const { options, service } = fixture()
    await expect(
      service.create({
        ...request,
        sessionId,
        target: {
          ...request.target,
          source: {
            ...request.target.source,
            kind: 'literature-attachment-version',
            sessionId: undefined
          }
        }
      })
    ).rejects.toThrow('source is not available')
    expect(options.repository.recoverCreate).not.toHaveBeenCalled()
    expect(options.repository.create).not.toHaveBeenCalled()
  }
)
