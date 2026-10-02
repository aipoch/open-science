import { describe, expect, it, vi } from 'vitest'
import { PdfStructureReader } from './reader'
import { createWebCallerContext } from '../../caller-context'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import type { PdfStructureOwner } from './owner'
import type { PdfStructureResult } from './result'

const request = {
  attachmentVersionId: 'version-1',
  page: 1,
  requestId: '00000000-0000-4000-8000-000000000001'
}
describe('PDF reading authority', () => {
  it('authorizes read-only cache lookup before and after awaiting the owner', async () => {
    let finish!: () => void
    const owner: PdfStructureOwner = {
      acquire: vi.fn(),
      readThumbnail: vi.fn(),
      close: vi.fn(),
      clearCache: vi.fn(),
      readCached: vi.fn(
        () =>
          new Promise<undefined>((resolve) => {
            finish = () => resolve(undefined)
          })
      )
    }
    const reader = new PdfStructureReader(owner)
    const registry = new ApplicationCallerLeaseRegistry()
    const current = registry.acquire({ leaseId: 'reader', surface: 'web' })
    const caller = createWebCallerContext('reader')
    const lookup = { attachmentVersionId: 'version-1', page: 1 }
    const malformed = { ...lookup, path: '/private/user.pdf' }
    await expect(reader.readCached(malformed, caller, current.lease)).rejects.toThrow()
    await expect(
      reader.readCached(
        lookup,
        createWebCallerContext('reader', { location: 'remote' }),
        current.lease
      )
    ).rejects.toThrow('Local PDF access')
    expect(owner.readCached).not.toHaveBeenCalled()
    const pending = reader.readCached(lookup, caller, current.lease)
    expect(owner.readCached).toHaveBeenCalledWith(
      { kind: 'literature', attachmentVersionId: 'version-1' },
      [1],
      current.lease.signal
    )
    current.release()
    finish()
    await expect(pending).rejects.toThrow('Local PDF access')
    expect(owner.acquire).not.toHaveBeenCalled()
  })

  it('accepts a page after 100 through the actual request boundary', async () => {
    const failure = new Error('reached owner')
    const owner: PdfStructureOwner = {
      acquire: vi.fn(() => ({ result: Promise.reject(failure), release: vi.fn() })),
      readThumbnail: vi.fn(),
      readCached: vi.fn(),
      close: vi.fn(),
      clearCache: vi.fn()
    }
    const lease = new ApplicationCallerLeaseRegistry().acquire({
      leaseId: 'long-reader',
      surface: 'web'
    }).lease
    await expect(
      new PdfStructureReader(owner).parse(
        { ...request, page: 101 },
        createWebCallerContext('long-reader'),
        lease
      )
    ).rejects.toThrow('reached owner')
    expect(owner.acquire).toHaveBeenCalledWith(
      { kind: 'literature', attachmentVersionId: 'version-1' },
      [101],
      { signal: lease.signal }
    )
  })
  it('isolates cancellation by caller lease and rechecks access before returning a result', async () => {
    let resolve!: (result: PdfStructureResult) => void
    const release = vi.fn()
    const owner: PdfStructureOwner = {
      acquire: vi.fn(() => ({
        result: new Promise<PdfStructureResult>((yes) => {
          resolve = yes
        }),
        release
      })),
      readThumbnail: vi.fn(),
      readCached: vi.fn(),
      close: vi.fn(),
      clearCache: vi.fn()
    }
    const reader = new PdfStructureReader(owner)
    const registry = new ApplicationCallerLeaseRegistry()
    const owned = registry.acquire({ leaseId: 'reader-a', surface: 'web' })
    const caller = createWebCallerContext('reader-a'),
      ownLease = owned.lease
    const pending = reader.parse(request, caller, ownLease)
    reader.cancel(
      request.requestId,
      createWebCallerContext('reader-b'),
      registry.acquire({ leaseId: 'reader-b', surface: 'web' }).lease
    )
    expect(release).not.toHaveBeenCalled()
    reader.cancel(request.requestId, caller, ownLease)
    expect(release).toHaveBeenCalledOnce()
    expect(owner.acquire).toHaveBeenCalledWith(
      { kind: 'literature', attachmentVersionId: 'version-1' },
      [1],
      { signal: ownLease.signal }
    )
    owned.release()
    resolve({
      schemaVersion: 1,
      extractionId: request.requestId,
      engineFingerprint: 'a'.repeat(64),
      sourceChecksum: 'b'.repeat(64),
      sourceSizeBytes: 1,
      pageCount: 1,
      requestedPages: [1],
      processedPages: [1],
      pages: [{ page: 1, width: 600, height: 800, rotation: 0 }],
      elements: [],
      thumbnails: [],
      navigation: [],
      issues: []
    })
    await expect(pending).rejects.toThrow('Local PDF access')
    await expect(
      reader.parse(
        request,
        createWebCallerContext('remote', { location: 'remote' }),
        registry.acquire({ leaseId: 'remote', surface: 'web' }).lease
      )
    ).rejects.toThrow('Local PDF access')
    expect(owner.acquire).toHaveBeenCalledOnce()
  })
  it('rejects renderer paths and reports cache cleanup without exposing filesystem paths', async () => {
    const owner: PdfStructureOwner = {
      acquire: vi.fn(),
      readThumbnail: vi.fn(),
      readCached: vi.fn(),
      close: vi.fn(),
      clearCache: vi.fn(async () => ({
        removedBytes: 10,
        retained: [{ entry: '/private/unowned', reason: 'unproven' }]
      }))
    }
    const reader = new PdfStructureReader(owner),
      caller = createWebCallerContext('reader'),
      current = new ApplicationCallerLeaseRegistry().acquire({
        leaseId: 'reader',
        surface: 'web'
      }).lease
    const malicious = { ...request, path: '/private/user.pdf' }
    await expect(reader.parse(malicious, caller, current)).rejects.toThrow()
    expect(owner.acquire).not.toHaveBeenCalled()
    expect(await reader.clearCache(caller, current)).toEqual({
      removedBytes: 10,
      retainedEntries: 1
    })
  })
})

it.each(['upload-version', 'artifact-version'] as const)(
  'routes %s parse, cache and thumbnail requests without a message binding',
  async (sourceKind) => {
    const source = {
      kind: 'managed' as const,
      projectId: 'project',
      sourceKind,
      sourceFileId: 'file',
      sourceVersionId: 'version'
    }
    const release = vi.fn()
    const owner: PdfStructureOwner = {
      acquire: vi.fn(() => ({ result: Promise.resolve({} as PdfStructureResult), release })),
      readCached: vi.fn(async () => undefined),
      readThumbnail: vi.fn(async () => Buffer.from('png')),
      close: vi.fn(),
      clearCache: vi.fn()
    }
    const reader = new PdfStructureReader(owner)
    const caller = createWebCallerContext('reader')
    const lease = new ApplicationCallerLeaseRegistry().acquire({
      leaseId: 'reader',
      surface: 'web'
    }).lease
    const input = { source, page: 1, requestId: request.requestId }
    await reader.parse(input, caller, lease)
    expect(owner.acquire).toHaveBeenCalledWith(source, [1], { signal: lease.signal })
    expect(release).toHaveBeenCalledOnce()
    await reader.readCached({ source, page: 1 }, caller, lease)
    expect(owner.readCached).toHaveBeenCalledWith(source, [1], lease.signal)
    const thumbnail = { source, page: 1, extractionId: request.requestId, thumbnailId: 'image' }
    expect(await reader.readThumbnail(thumbnail, caller, lease)).toBe('data:image/png;base64,cG5n')
    expect(owner.readThumbnail).toHaveBeenCalledWith(
      source,
      [1],
      request.requestId,
      'image',
      lease.signal
    )
    for (const extra of [
      { attachmentVersionId: 'other' },
      { source: { ...source, path: '/private/source.pdf' } },
      { source: { ...source, projectId: '' } },
      { source: { ...source, sourceKind: 'local' } }
    ]) {
      await expect(
        reader.parse({ ...input, ...extra } as typeof input, caller, lease)
      ).rejects.toThrow()
    }
    await expect(
      reader.parse(input, createWebCallerContext('remote', { location: 'remote' }), lease)
    ).rejects.toThrow('Local PDF access')
    expect(owner.acquire).toHaveBeenCalledOnce()
  }
)
