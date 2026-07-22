import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { ManagedPreviewResources } from './managed-preview-resources'
import {
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
})
