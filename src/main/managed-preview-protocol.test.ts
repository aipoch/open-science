import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { ManagedPreviewResources } from './managed-preview-resources'
import {
  createManagedPreviewProtocolBridge,
  createManagedPreviewProtocolHandler,
  registerManagedPreviewProtocol
} from './managed-preview-protocol'

describe('managed preview protocol', () => {
  it('can register the capability handler on an isolated Electron session', () => {
    const resources = {} as ManagedPreviewResources
    const targetProtocol = { handle: vi.fn(), unhandle: vi.fn() }

    const unregister = registerManagedPreviewProtocol(resources, targetProtocol)

    expect(targetProtocol.handle).toHaveBeenCalledWith('open-science-preview', expect.any(Function))
    unregister()
    expect(targetProtocol.unhandle).toHaveBeenCalledWith('open-science-preview')
  })

  it('installs a stable session route before the resource handler is available', async () => {
    let sessionHandler: ((request: Request) => Promise<Response> | Response) | undefined
    const targetProtocol = {
      handle: vi.fn((_scheme: string, handler: typeof sessionHandler) => {
        sessionHandler = handler
      }),
      unhandle: vi.fn()
    }
    const bridge = createManagedPreviewProtocolBridge(targetProtocol)
    const resources = {
      resolveProtocolResource: vi.fn().mockResolvedValue({
        filePath: '/managed/plot.png',
        mimeType: 'image/png'
      })
    } as unknown as ManagedPreviewResources
    const fetchFile = vi.fn().mockResolvedValue(new Response('image', { status: 200 }))

    expect(targetProtocol.handle).toHaveBeenCalledWith('open-science-preview', expect.any(Function))
    expect(
      (await sessionHandler!(new Request('open-science-preview://resource-1/plot.png'))).status
    ).toBe(404)

    bridge.registrar.handle(
      'open-science-preview',
      createManagedPreviewProtocolHandler(resources, fetchFile)
    )
    expect(
      (await sessionHandler!(new Request('open-science-preview://resource-1/plot.png'))).status
    ).toBe(200)

    bridge.registrar.unhandle('open-science-preview')
    expect(
      (await sessionHandler!(new Request('open-science-preview://resource-1/plot.png'))).status
    ).toBe(404)
    bridge.dispose()
    expect(targetProtocol.unhandle).toHaveBeenCalledWith('open-science-preview')
  })

  it('rejects a capability that is not assigned to the isolated child session', async () => {
    const resources = { resolveProtocolResource: vi.fn() } as unknown as ManagedPreviewResources
    const handle = createManagedPreviewProtocolHandler(resources, undefined, {
      isResourceAllowed: (resourceId) => resourceId === 'assigned-resource'
    })

    const response = await handle(
      new Request('open-science-preview://different-resource/report.xlsx')
    )

    expect(response.status).toBe(404)
    expect(resources.resolveProtocolResource).not.toHaveBeenCalled()
  })

  it('streams the capability URL with constrained HTML response headers', async () => {
    const resources = {
      resolveProtocolResource: vi.fn().mockResolvedValue({
        filePath: '/managed/plot.html',
        mimeType: 'Text/HTML; Charset=UTF-8'
      })
    } as unknown as ManagedPreviewResources
    const fetchFile = vi.fn().mockResolvedValue(
      new Response('<script>Plotly.newPlot()</script>', {
        status: 200,
        headers: { 'content-length': '34' }
      })
    )
    const handle = createManagedPreviewProtocolHandler(resources, fetchFile)
    const request = new Request('open-science-preview://resource-1/plot.html', {
      headers: { Range: 'bytes=0-1023' }
    })

    const response = await handle(request)

    expect(resources.resolveProtocolResource).toHaveBeenCalledWith('resource-1')
    expect(fetchFile).toHaveBeenCalledWith('/managed/plot.html', request)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('Text/HTML; Charset=UTF-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const csp = response.headers.get('content-security-policy')
    expect(csp).toContain("connect-src 'none'")
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).not.toContain("frame-ancestors 'none'")
    expect(await response.text()).toContain('Plotly.newPlot')
  })

  it('caps strict Office streams to the admitted size even when the open inode grows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'office-preview-protocol-'))
    const filePath = join(directory, 'report.xlsx')
    await writeFile(filePath, 'approved-extra-bytes')
    const fileHandle = await open(filePath, 'r')
    const resources = {
      resolveProtocolResource: vi.fn().mockResolvedValue({
        fileHandle,
        mimeType: 'application/octet-stream',
        size: 8,
        verifyUnchanged: vi.fn().mockResolvedValue(undefined)
      })
    } as unknown as ManagedPreviewResources

    try {
      const response = await createManagedPreviewProtocolHandler(resources)(
        new Request('open-science-preview://resource-1/report.xlsx')
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('content-length')).toBe('8')
      expect(await response.text()).toBe('approved')
    } finally {
      await fileHandle.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fills a strict stream chunk across valid short FileHandle reads', async () => {
    const source = new TextEncoder().encode('short reads are valid')
    let closed = false
    const fileHandle = {
      read: vi.fn(async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const bytesRead = Math.min(3, length, source.length - position)
        buffer.set(source.subarray(position, position + bytesRead), offset)
        return { bytesRead, buffer }
      }),
      close: vi.fn(async () => {
        closed = true
      })
    }
    const resources = {
      resolveProtocolResource: vi.fn().mockResolvedValue({
        fileHandle,
        mimeType: 'application/octet-stream',
        size: source.length,
        verifyUnchanged: vi.fn().mockResolvedValue(undefined)
      })
    } as unknown as ManagedPreviewResources

    const response = await createManagedPreviewProtocolHandler(resources)(
      new Request('open-science-preview://resource-1/report.xlsx')
    )

    expect(await response.text()).toBe('short reads are valid')
    expect(fileHandle.read.mock.calls.length).toBeGreaterThan(1)
    expect(closed).toBe(true)
  })

  it('fails a strict stream when the admitted inode changes during the read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'office-preview-stream-mutation-'))
    const filePath = join(directory, 'report.xlsx')
    await writeFile(filePath, new Uint8Array(192 * 1024))
    const resources = new (await import('./managed-preview-resources')).ManagedPreviewResources({
      resolvePath: async () => filePath,
      createId: () => 'resource-1'
    })
    const request = { source: 'artifact' as const, path: filePath }
    const snapshot = await resources.inspect(request)
    await resources.acquire(17, request, { snapshot, maxBytes: 192 * 1024 })

    try {
      const response = await createManagedPreviewProtocolHandler(resources)(
        new Request('open-science-preview://resource-1/report.xlsx')
      )
      const reader = response.body!.getReader()
      await reader.read()
      const changed = new Uint8Array(192 * 1024)
      changed[0] = 1
      await writeFile(filePath, changed)

      const drain = async (): Promise<void> => {
        while (!(await reader.read()).done) {
          // Continue until the end-of-stream identity check rejects the mutated file.
        }
      }
      await expect(drain()).rejects.toThrow(/changed during (protocol )?streaming/i)
      expect(() => resources.release(17, { resourceId: 'resource-1' })).not.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('streams a logical managed resource from its verified lease after the path is replaced', async () => {
    const verified = Buffer.from('verified managed version')
    const close = vi.fn().mockResolvedValue(undefined)
    const lease = {
      path: '/managed/report.xlsx',
      size: verified.byteLength,
      versionToken: 42,
      snapshot: { dev: 1n, ino: 2n, size: BigInt(verified.byteLength), mtimeNs: 3n },
      read: vi.fn(async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        buffer.set(verified.subarray(position, position + length), offset)
        return { bytesRead: length }
      }),
      readRange: vi.fn(),
      copyTo: vi.fn(),
      verifyUnchanged: vi.fn().mockResolvedValue(undefined),
      close
    }
    const openLatestManagedFile = vi.fn().mockResolvedValue(lease)
    const openManagedFileVersion = vi.fn()
    const resources = new (await import('./managed-preview-resources')).ManagedPreviewResources({
      resolvePath: vi.fn(),
      openLatestManagedFile,
      openManagedFileVersion,
      createId: () => 'trusted-resource'
    } as never)
    await resources.acquire(17, {
      source: 'artifact',
      path: 'stale-projection',
      projectId: 'project-1',
      fileId: 'artifact-1'
    })

    const response = await createManagedPreviewProtocolHandler(resources)(
      new Request('open-science-preview://trusted-resource/report.xlsx')
    )

    await expect(response.text()).resolves.toBe('verified managed version')
    expect(lease.read).toHaveBeenCalled()
    expect(openLatestManagedFile).toHaveBeenCalledWith('artifact', {
      projectId: 'project-1',
      fileId: 'artifact-1'
    })
    expect(openManagedFileVersion).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    resources.release(17, { resourceId: 'trusted-resource' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects URLs that are not an acquired resource capability', async () => {
    const resources = {
      resolveProtocolResource: vi
        .fn()
        .mockRejectedValue(new Error('Managed preview resource is not available.'))
    } as unknown as ManagedPreviewResources
    const fetchFile = vi.fn()
    const handle = createManagedPreviewProtocolHandler(resources, fetchFile)

    const response = await handle(
      new Request('open-science-preview://missing-resource/report.html')
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('text/html')
    const body = await response.text()
    expect(body).toContain('open-science-preview-load-error')
    expect(body).toContain('parent.postMessage')
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('errors the strict stream when the request signal is already aborted with a custom reason', async () => {
    const source = new Uint8Array(128 * 1024)
    source.fill(7)
    let closed = false
    const fileHandle = {
      read: vi.fn(async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        buffer.fill(7, offset, offset + length)
        // Echo a value derived from the requested position so the read observable matches it.
        buffer[buffer.length - 1] = position & 0xff
        return { bytesRead: length, buffer }
      }),
      close: vi.fn(async () => {
        closed = true
      })
    }
    const resources = {
      resolveProtocolResource: vi.fn().mockResolvedValue({
        fileHandle,
        mimeType: 'application/octet-stream',
        size: source.length,
        verifyUnchanged: vi.fn().mockResolvedValue(undefined)
      })
    } as unknown as ManagedPreviewResources
    const controller = new AbortController()
    controller.abort(new DOMException('Renderer stepped away', 'AbortError'))
    const handle = createManagedPreviewProtocolHandler(resources)

    const response = await handle(
      new Request('open-science-preview://resource-1/report.xlsx', {
        signal: controller.signal
      })
    )
    const reader = response.body!.getReader()

    await expect(reader.read()).rejects.toThrow(/Renderer stepped away/i)
    expect(closed).toBe(true)
  })

  it('closes the underlying file handle when the consumer cancels a strict stream mid-read', async () => {
    const source = new TextEncoder().encode('cancel-strict-stream-payload')
    const fileHandle = {
      read: vi.fn(async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        buffer.set(source.subarray(position, position + length), offset)
        return { bytesRead: length, buffer }
      }),
      close: vi.fn()
    }
    const resources = {
      resolveProtocolResource: vi.fn().mockResolvedValue({
        fileHandle,
        mimeType: 'application/octet-stream',
        size: source.length,
        verifyUnchanged: vi.fn().mockResolvedValue(undefined)
      })
    } as unknown as ManagedPreviewResources
    const handle = createManagedPreviewProtocolHandler(resources)

    const response = await handle(
      new Request('open-science-preview://resource-1/report.xlsx', {
        headers: { Range: `bytes=0-${source.length - 1}` }
      })
    )
    const reader = response.body!.getReader()
    await reader.read()

    await reader.cancel()

    expect(fileHandle.close).toHaveBeenCalled()
  })

  it('returns the load-error page when an invalid Range header rejects the strict response setup', async () => {
    const source = Buffer.from('strict-range-error-path')
    const fileHandle = {
      read: vi.fn(async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        buffer.set(source.subarray(position, position + length), offset)
        return { bytesRead: length, buffer }
      }),
      close: vi.fn()
    }
    const resources = {
      resolveProtocolResource: vi.fn().mockResolvedValue({
        fileHandle,
        mimeType: 'application/octet-stream',
        size: source.length,
        verifyUnchanged: vi.fn().mockResolvedValue(undefined)
      })
    } as unknown as ManagedPreviewResources
    const handle = createManagedPreviewProtocolHandler(resources)

    const response = await handle(
      new Request('open-science-preview://resource-1/report.xlsx', {
        headers: { Range: 'bytes=abc-def' }
      })
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('text/html')
    // The inner throw forces the file handle to close before the outer catch falls back.
    expect(fileHandle.close).toHaveBeenCalled()
  })

  it('returns the load-error page when the strict stream rejects synchronously before any body is created', async () => {
    const fileHandle = {
      read: vi.fn(),
      close: vi.fn()
    }
    const resources = {
      resolveProtocolResource: vi.fn().mockResolvedValue({
        fileHandle,
        mimeType: 'application/octet-stream',
        size: 4,
        verifyUnchanged: vi.fn().mockRejectedValue(new Error('inode vanished'))
      })
    } as unknown as ManagedPreviewResources
    const handle = createManagedPreviewProtocolHandler(resources)

    const response = await handle(
      new Request('open-science-preview://resource-1/report.xlsx', {
        method: 'HEAD'
      })
    )

    expect(response.status).toBe(404)
    expect(fileHandle.close).toHaveBeenCalled()
  })

  it('handles a HEAD request for a strict resource without invoking FileHandle.read', async () => {
    const verifyUnchanged = vi.fn().mockResolvedValue(undefined)
    const fileHandle = {
      read: vi.fn(),
      close: vi.fn()
    }
    const resources = {
      resolveProtocolResource: vi.fn().mockResolvedValue({
        fileHandle,
        mimeType: 'application/octet-stream',
        size: 256,
        verifyUnchanged
      })
    } as unknown as ManagedPreviewResources
    const handle = createManagedPreviewProtocolHandler(resources)

    const response = await handle(
      new Request('open-science-preview://resource-1/report.xlsx', {
        method: 'HEAD'
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('256')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.body).toBeNull()
    expect(fileHandle.read).not.toHaveBeenCalled()
    expect(verifyUnchanged).toHaveBeenCalled()
    expect(fileHandle.close).toHaveBeenCalled()
  })

  it('serves an entire strict file via a Range header when the end is omitted and content-length reflects the full file', async () => {
    const source = Buffer.alloc(512)
    source.fill(0xab)
    let closed = false
    const fileHandle = {
      read: vi.fn(async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        buffer.set(source.subarray(position, position + length), offset)
        return { bytesRead: length, buffer }
      }),
      close: vi.fn(async () => {
        closed = true
      })
    }
    const resources = {
      resolveProtocolResource: vi.fn().mockResolvedValue({
        fileHandle,
        mimeType: 'application/octet-stream',
        size: source.length,
        verifyUnchanged: vi.fn().mockResolvedValue(undefined)
      })
    } as unknown as ManagedPreviewResources
    const handle = createManagedPreviewProtocolHandler(resources)

    const response = await handle(
      new Request('open-science-preview://resource-1/report.xlsx', {
        headers: { Range: 'bytes=0-' }
      })
    )

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(
      `bytes 0-${source.length - 1}/${source.length}`
    )
    expect(response.headers.get('content-length')).toBe(String(source.length))
    const collected = await response.text()
    expect(collected.length).toBe(source.length)
    expect(closed).toBe(true)
  })

  it('errors the stream when verifyUnchanged rejects the final identity check mid-pull', async () => {
    const source = Buffer.alloc(64 * 1024)
    const fileHandle = {
      read: vi.fn(async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        buffer.set(source.subarray(position, position + length), offset)
        return { bytesRead: length, buffer }
      }),
      close: vi.fn()
    }
    const verifyUnchanged = vi.fn().mockRejectedValue(new Error('inode changed mid-stream'))
    const resources = {
      resolveProtocolResource: vi.fn().mockResolvedValue({
        fileHandle,
        mimeType: 'application/octet-stream',
        size: source.length,
        verifyUnchanged
      })
    } as unknown as ManagedPreviewResources
    const handle = createManagedPreviewProtocolHandler(resources)

    const response = await handle(new Request('open-science-preview://resource-1/report.xlsx'))
    const reader = response.body!.getReader()
    const drain = async (): Promise<void> => {
      while (!(await reader.read()).done) {
        // Drain until the final pull observes the inode mutation.
      }
    }

    await expect(drain()).rejects.toThrow(/inode changed mid-stream/i)
    expect(fileHandle.close).toHaveBeenCalled()
  })
})
