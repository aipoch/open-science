import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MANAGED_PREVIEW_SCHEME,
  ManagedPreviewResources,
  readExactRange
} from './managed-preview-resources'

describe('ManagedPreviewResources', () => {
  let temporaryDirectory: string | undefined

  afterEach(async () => {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true })
      temporaryDirectory = undefined
    }
  })

  const createFile = async (content: Uint8Array, name = 'report.pdf'): Promise<string> => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'open-science-preview-resource-'))
    const filePath = join(temporaryDirectory, name)

    await writeFile(filePath, content)
    return filePath
  }

  it('registers the preview scheme for streaming and cross-scheme capability fetches', () => {
    expect(MANAGED_PREVIEW_SCHEME).toEqual({
      scheme: 'open-science-preview',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    })
  })

  it('reads only the requested byte range from an owner-scoped resource', async () => {
    const filePath = await createFile(Buffer.from('0123456789'))
    const resolvePath = vi.fn().mockResolvedValue(filePath)
    const resources = new ManagedPreviewResources({
      resolvePath,
      createId: () => 'resource-1'
    })

    const resource = await resources.acquire(17, {
      source: 'artifact',
      path: filePath,
      mimeType: 'application/pdf'
    })

    expect(resource).toEqual({
      id: 'resource-1',
      url: 'open-science-preview://resource-1/report.pdf',
      size: 10,
      mimeType: 'application/pdf',
      version: expect.any(Number)
    })
    expect(resolvePath).toHaveBeenCalledWith('artifact', {
      source: 'artifact',
      path: filePath,
      mimeType: 'application/pdf'
    })
    await expect(
      resources.readRange(17, { resourceId: resource.id, begin: 2, end: 6 })
    ).resolves.toEqual({
      begin: 2,
      end: 6,
      total: 10,
      data: new Uint8Array(Buffer.from('2345'))
    })
  })

  it('inspects authoritative metadata without minting a resource capability', async () => {
    const filePath = await createFile(Buffer.from('office'))
    const createId = vi.fn(() => 'resource-1')
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId
    })

    await expect(resources.inspect({ source: 'artifact', path: filePath })).resolves.toEqual({
      size: 6,
      version: expect.any(Number)
    })
    expect(createId).not.toHaveBeenCalled()
  })

  it('enforces a caller-owned limit again before minting a capability', async () => {
    const filePath = await createFile(Buffer.from('01234567890'))
    const createId = vi.fn(() => 'resource-1')
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId
    })
    const request = { source: 'artifact' as const, path: filePath }
    const snapshot = await resources.inspect(request)

    await expect(resources.acquire(17, request, { snapshot, maxBytes: 10 })).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
      size: 11,
      limit: 10
    })
    expect(createId).not.toHaveBeenCalled()
  })

  it('rejects a file that changed after its admission snapshot', async () => {
    const filePath = await createFile(Buffer.from('before'))
    const createId = vi.fn(() => 'resource-1')
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId
    })
    const request = { source: 'artifact' as const, path: filePath }
    const snapshot = await resources.inspect(request)
    await writeFile(filePath, Buffer.from('changed-size'))

    await expect(
      resources.acquire(17, request, { snapshot, maxBytes: 40 * 1024 * 1024 })
    ).rejects.toThrow(/changed/i)
    expect(createId).not.toHaveBeenCalled()
  })

  it('revokes a capability when the file changes before protocol streaming', async () => {
    const filePath = await createFile(Buffer.from('before'))
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'resource-1'
    })
    const request = { source: 'artifact' as const, path: filePath }
    const snapshot = await resources.inspect(request)
    const resource = await resources.acquire(17, request, {
      snapshot,
      maxBytes: 40 * 1024 * 1024
    })
    await writeFile(filePath, Buffer.from('changed-size'))

    await expect(resources.resolveProtocolResource(resource.id)).rejects.toThrow(/changed/i)
    expect(() => resources.release(17, { resourceId: resource.id })).not.toThrow()
  })

  it('opens strict Office resources by stable file handle instead of returning a mutable path', async () => {
    const filePath = await createFile(Buffer.from('office'))
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'resource-1'
    })
    const request = { source: 'artifact' as const, path: filePath }
    const snapshot = await resources.inspect(request)
    const resource = await resources.acquire(17, request, { snapshot, maxBytes: 6 })

    const protocolResource = await resources.resolveProtocolResource(resource.id)

    expect(protocolResource).toMatchObject({
      size: 6,
      mimeType: 'application/pdf',
      verifyUnchanged: expect.any(Function)
    })
    expect('fileHandle' in protocolResource).toBe(true)
    expect('filePath' in protocolResource).toBe(false)
    if ('fileHandle' in protocolResource) await protocolResource.fileHandle.close()
  })

  it('rejects oversized ranges and access from another owner', async () => {
    const filePath = await createFile(new Uint8Array(2 * 1024 * 1024))
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'resource-1'
    })
    const resource = await resources.acquire(17, { source: 'upload', path: filePath })

    expect(resource.mimeType).toBe('application/pdf')

    await expect(
      resources.readRange(17, {
        resourceId: resource.id,
        begin: 0,
        end: 1024 * 1024 + 1
      })
    ).rejects.toThrow(/range exceeds/i)
    await expect(
      resources.readRange(18, { resourceId: resource.id, begin: 0, end: 1 })
    ).rejects.toThrow(/not available/i)
  })

  it('invalidates released resources and all resources owned by a closed window', async () => {
    const filePath = await createFile(Buffer.from('preview'))
    let nextId = 0
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => `resource-${++nextId}`
    })
    const first = await resources.acquire(17, { source: 'artifact', path: filePath })
    const second = await resources.acquire(17, { source: 'artifact', path: filePath })

    resources.release(17, { resourceId: first.id })
    await expect(
      resources.readRange(17, { resourceId: first.id, begin: 0, end: 1 })
    ).rejects.toThrow(/not available/i)

    resources.releaseOwner(17)
    await expect(
      resources.readRange(17, { resourceId: second.id, begin: 0, end: 1 })
    ).rejects.toThrow(/not available/i)
  })

  it('acquires files larger than the former whole-file preview limits', async () => {
    const filePath = await createFile(new Uint8Array())
    const fileSize = 128 * 1024 * 1024
    await truncate(filePath, fileSize)
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'large-resource'
    })

    const resource = await resources.acquire(17, { source: 'artifact', path: filePath })
    const tail = await resources.readRange(17, {
      resourceId: resource.id,
      begin: fileSize - 1,
      end: fileSize
    })

    expect(resource.size).toBe(fileSize)
    expect(tail.data).toHaveLength(1)
  })

  it('normalizes trusted MIME metadata for files without an extension', async () => {
    const filePath = await createFile(Buffer.from('<script></script>'), 'generated-report')
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'html-resource'
    })

    const resource = await resources.acquire(17, {
      source: 'artifact',
      path: filePath,
      mimeType: ' Text/HTML; Charset=UTF-8 '
    })

    expect(resource.mimeType).toBe('text/html; charset=utf-8')
  })

  it('treats a second release for the same owner as a silent no-op', async () => {
    const filePath = await createFile(Buffer.from('silent-release'))
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'resource-1'
    })
    const resource = await resources.acquire(17, { source: 'artifact', path: filePath })

    resources.release(17, { resourceId: resource.id })
    expect(() => resources.release(17, { resourceId: resource.id })).not.toThrow()

    // Releasing from another owner for a tombstoned id must still throw — only the same
    // owner that produced the tombstone gets the silent idempotence.
    expect(() => resources.release(99, { resourceId: resource.id })).toThrow(/not available/i)
  })

  it('rejects a release attempt against a live resource owned by a different renderer', async () => {
    const filePath = await createFile(Buffer.from('owner-mismatch'))
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'resource-1'
    })
    const resource = await resources.acquire(17, { source: 'artifact', path: filePath })

    expect(() => resources.release(99, { resourceId: resource.id })).toThrow(/not available/i)
  })

  it('rejects a release of an unknown resource id from a never-seen owner', async () => {
    const filePath = await createFile(Buffer.from('unknown-id'))
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'resource-1'
    })

    expect(() => resources.release(42, { resourceId: 'never-minted' })).toThrow(/not available/i)
  })

  it('releaseOwner handles owners with no resources or tombstones as a no-op', async () => {
    const filePath = await createFile(Buffer.from('noop-owner'))
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'resource-1'
    })

    expect(() => resources.releaseOwner(555)).not.toThrow()
  })

  it('releaseOwner also clears tombstone entries for the matching owner', async () => {
    const filePath = await createFile(Buffer.from('tombstone-cleanup'))
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'resource-1'
    })

    const resource = await resources.acquire(17, { source: 'artifact', path: filePath })
    resources.release(17, { resourceId: resource.id })
    resources.releaseOwner(17)

    // After releaseOwner, even the same owner must observe the resource as gone, not tombstoned.
    expect(() => resources.release(17, { resourceId: resource.id })).toThrow(/not available/i)
  })

  it('mints concurrent acquisitions of the same path with distinct ids', async () => {
    const filePath = await createFile(Buffer.from('concurrent-acquire'))
    let nextId = 0
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => `resource-${++nextId}`
    })

    const [first, second, third] = await Promise.all([
      resources.acquire(17, { source: 'artifact', path: filePath }),
      resources.acquire(18, { source: 'artifact', path: filePath }),
      resources.acquire(17, { source: 'artifact', path: filePath })
    ])

    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
    // Each id remains independently readable by its respective owner.
    await expect(
      resources.readRange(18, { resourceId: second.id, begin: 0, end: 1 })
    ).resolves.toMatchObject({ data: expect.any(Uint8Array) })
  })

  it('rejects readRange requests where the end is not strictly greater than the begin', async () => {
    const filePath = await createFile(Buffer.from('range-validation'))
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'resource-1'
    })
    const resource = await resources.acquire(17, { source: 'artifact', path: filePath })

    await expect(
      resources.readRange(17, { resourceId: resource.id, begin: 4, end: 4 })
    ).rejects.toThrow(/Invalid managed preview range/i)
    await expect(
      resources.readRange(17, { resourceId: resource.id, begin: 5, end: 3 })
    ).rejects.toThrow(/Invalid managed preview range/i)
  })

  it('rejects acquisitions against a resolved directory path', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'open-science-preview-dir-'))
    const resolvePath = vi.fn(async () => temporaryDirectory!)
    const resources = new ManagedPreviewResources({
      resolvePath,
      createId: () => 'resource-1'
    })

    await expect(
      resources.inspect({ source: 'artifact', path: temporaryDirectory! })
    ).rejects.toThrow(/not a file/i)
    await expect(
      resources.acquire(17, { source: 'artifact', path: temporaryDirectory! })
    ).rejects.toThrow(/not a file/i)
    expect(resolvePath).toHaveBeenCalled()
  })

  it('propagates a resolvePath failure from acquire without minting a capability', async () => {
    const resolvePath = vi.fn().mockRejectedValue(new Error('permission denied'))
    const createId = vi.fn(() => 'resource-1')
    const resources = new ManagedPreviewResources({ resolvePath, createId })

    await expect(
      resources.acquire(17, { source: 'artifact', path: '/inaccessible.pdf' })
    ).rejects.toThrow(/permission denied/i)
    expect(createId).not.toHaveBeenCalled()
  })

  it('returns the filePath variant when a non-strict resource is resolved for protocol streaming', async () => {
    const filePath = await createFile(Buffer.from('non-strict-protocol'))
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'non-strict-resource'
    })
    const resource = await resources.acquire(17, { source: 'artifact', path: filePath })

    const protocolResource = await resources.resolveProtocolResource(resource.id)

    expect(protocolResource).toEqual({
      filePath,
      mimeType: 'application/pdf'
    })
    expect('fileHandle' in protocolResource).toBe(false)
  })

  it('rejects resolveProtocolResource for an unknown resource id', async () => {
    const filePath = await createFile(Buffer.from('protocol-missing'))
    const resources = new ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'resource-1'
    })

    await expect(resources.resolveProtocolResource('not-a-real-id')).rejects.toThrow(
      /not available/i
    )
  })

  it('fills a requested range across short filesystem reads', async () => {
    const source = Buffer.from('abcd')
    const read = vi.fn(
      async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const bytesRead = Math.min(2, length)
        buffer.set(source.subarray(position - 10, position - 10 + bytesRead), offset)
        return { bytesRead }
      }
    )
    const buffer = Buffer.alloc(4)

    await readExactRange({ read }, buffer, 10)

    expect(read).toHaveBeenCalledTimes(2)
    expect(buffer.toString()).toBe('abcd')
  })
})
