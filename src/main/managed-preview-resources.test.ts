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
    expect(resolvePath).toHaveBeenCalledWith('artifact', { path: filePath })
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
