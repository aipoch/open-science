import type { LiteratureAttachmentAuthority } from '../attachment-authority'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PdfStructureSourceAuthority } from './source'
import { inspectPdfPageCount } from '../../uploads/attachment-media'
import type { ResolvedSessionPdfVersion } from '../session-pdf-source-resolver'
import type { ImmutableInputContentLease } from '../../immutable-input-authority'

vi.mock('../../uploads/attachment-media', () => ({
  MAX_AUTO_EXTRACT_PDF_BYTES: 50 * 1024 * 1024,
  inspectPdfPageCount: vi.fn(async (_path, source) => {
    await source.readBytes()
    return 12
  })
}))
const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const setup = async (): Promise<{
  root: string
  bytes: Buffer
  source: Omit<
    Extract<ResolvedSessionPdfVersion, { sourceKind: 'literature-attachment-version' }>,
    'sizeBytes' | 'path'
  > & {
    sizeBytes: number
    path: string
  }
  request: { kind: 'literature'; attachmentVersionId: string }
  authority: PdfStructureSourceAuthority
  resolveVersion: ReturnType<typeof vi.fn<LiteratureAttachmentAuthority['resolveVersion']>>
}> => {
  const root = await mkdtemp(join(tmpdir(), 'pdf-source-metadata-'))
  roots.push(root)
  const bytes = Buffer.from('%PDF-1.7 immutable bytes')
  const source = {
    sourceKind: 'literature-attachment-version',
    sourceFileId: 'attachment',
    sourceVersionId: 'version',
    filename: 'Trial.pdf',
    contentType: 'application/pdf',
    path: join(root, 'trial.pdf'),
    checksum: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length
  } satisfies ResolvedSessionPdfVersion
  await writeFile(source.path, bytes)
  const resolveVersion = vi.fn(async () => ({
    itemId: 'item',
    attachmentId: source.sourceFileId,
    versionId: source.sourceVersionId,
    versionNumber: 1,
    filename: source.filename,
    contentType: source.contentType!,
    path: source.path,
    checksum: source.checksum,
    sizeBytes: source.sizeBytes,
    storageKey: 'content/test'
  }))
  const authority = new PdfStructureSourceAuthority({
    literature: { resolveVersion },
    sources: { resolveVersion: vi.fn() },
    sessions: { loadSessionForContinuation: vi.fn() }
  })
  const request = { kind: 'literature' as const, attachmentVersionId: 'version' }
  return { root, bytes, source, request, authority, resolveVersion }
}
it('inspects verified bounded PDF metadata without running layout extraction', async () => {
  const { authority, request, source } = await setup()
  await expect(authority.pageCount(request, source, new AbortController().signal)).resolves.toBe(12)
  expect(inspectPdfPageCount).toHaveBeenCalledTimes(1)
})
it('rejects changed bytes, oversized sources, symlinks and cancelled reads', async () => {
  const { authority, request, source, root, bytes } = await setup()
  await writeFile(source.path, Buffer.alloc(bytes.length, 32))
  await expect(authority.pageCount(request, source, new AbortController().signal)).rejects.toThrow(
    'LINKED_PDF_UNAVAILABLE'
  )
  source.sizeBytes = 51 * 1024 * 1024
  await expect(authority.pageCount(request, source, new AbortController().signal)).rejects.toThrow(
    'LINKED_PDF_UNAVAILABLE'
  )
  source.sizeBytes = bytes.length
  await symlink(source.path, join(root, 'link.pdf'))
  source.path = join(root, 'link.pdf')
  await expect(authority.pageCount(request, source, new AbortController().signal)).rejects.toThrow(
    'LINKED_PDF_UNAVAILABLE'
  )
  const controller = new AbortController()
  controller.abort()
  await expect(authority.pageCount(request, source, controller.signal)).rejects.toThrow()
})
it('reauthorizes after metadata inspection before returning page count', async () => {
  const { authority, request, source, resolveVersion } = await setup()
  const original = vi.mocked(inspectPdfPageCount).getMockImplementation()!
  vi.mocked(inspectPdfPageCount).mockImplementationOnce(async (...args) => {
    const count = await original(...args)
    resolveVersion.mockImplementationOnce(async () => {
      throw new Error('revoked')
    })
    return count
  })
  await expect(authority.pageCount(request, source, new AbortController().signal)).rejects.toThrow(
    'revoked'
  )
})

it.each(['artifact-version', 'upload-version'] as const)(
  'reads %s only through its verified lease and closes it on failure',
  async (sourceKind) => {
    const { authority, request, source, bytes } = await setup()
    const lease: ImmutableInputContentLease = {
      path: '/must-not-be-opened.pdf',
      size: bytes.length,
      versionToken: 1,
      snapshot: { dev: 1n, ino: 1n, size: BigInt(bytes.length), mtimeNs: 1n },
      read: vi.fn(),
      copyTo: vi.fn(),
      readRange: vi.fn(async () => bytes),
      verifyUnchanged: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined)
    }
    const managed: ResolvedSessionPdfVersion = {
      ...source,
      sourceKind,
      sourceSessionId: 'origin-session',
      path: lease.path,
      openContent: async () => lease
    }
    vi.spyOn(authority, 'reauthorize').mockResolvedValue(managed)
    await expect(authority.pageCount(request, managed, new AbortController().signal)).resolves.toBe(
      12
    )
    expect(lease.readRange).toHaveBeenCalledWith(0, bytes.length)
    expect(lease.verifyUnchanged).toHaveBeenCalledOnce()
    expect(lease.close).toHaveBeenCalledOnce()
    vi.mocked(lease.readRange).mockResolvedValueOnce(Buffer.alloc(bytes.length, 0))
    await expect(
      authority.pageCount(request, managed, new AbortController().signal)
    ).rejects.toThrow('LINKED_PDF_UNAVAILABLE')
    expect(lease.close).toHaveBeenCalledTimes(2)
  }
)
