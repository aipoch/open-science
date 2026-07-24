import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

describe('Office preview runtime protocol', () => {
  it('serves the isolated runtime from its own site and proxies development assets', async () => {
    const module = await import('./office-preview-runtime-protocol').catch(() => undefined)
    expect(module).toBeDefined()
    if (!module) return

    const fetchRuntime = vi.fn().mockResolvedValue(
      new Response('export const ready = true', {
        status: 200,
        headers: { 'content-type': 'text/javascript' }
      })
    )
    const handler = module.createOfficePreviewRuntimeProtocolHandler({
      runtimeHtmlPath: '/app/renderer/office-preview.html',
      devServerUrl: 'http://localhost:5173',
      fetchRuntime
    })

    const response = await handler(
      new Request('open-science-office-preview://runtime/src/office-preview/main.ts')
    )

    const runtimeUrl = new URL(module.createOfficePreviewRuntimeUrl('session / 1'))
    expect(runtimeUrl.protocol).toBe('open-science-office-preview:')
    expect(runtimeUrl.hostname).toBe('runtime')
    expect(runtimeUrl.pathname).toBe('/office-preview.html')
    expect(runtimeUrl.searchParams.get('sessionId')).toBe('session / 1')
    expect(fetchRuntime).toHaveBeenCalledWith(
      'http://localhost:5173/src/office-preview/main.ts',
      expect.any(Request)
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('preserves Vite query parameters when proxying development modules', async () => {
    const module = await import('./office-preview-runtime-protocol')
    const fetchRuntime = vi.fn().mockResolvedValue(new Response('export default "/worker.js"'))
    const handler = module.createOfficePreviewRuntimeProtocolHandler({
      runtimeHtmlPath: '/app/renderer/office-preview.html',
      devServerUrl: 'http://localhost:5173',
      fetchRuntime
    })
    const request = new Request(
      'open-science-office-preview://runtime/@fs/sheet.worker.js?worker&url'
    )

    await handler(request)

    expect(fetchRuntime).toHaveBeenCalledWith(
      'http://localhost:5173/@fs/sheet.worker.js?worker&url',
      request
    )
  })

  it('rejects requests outside the dedicated runtime host', async () => {
    const module = await import('./office-preview-runtime-protocol').catch(() => undefined)
    expect(module).toBeDefined()
    if (!module) return

    const fetchRuntime = vi.fn()
    const handler = module.createOfficePreviewRuntimeProtocolHandler({
      runtimeHtmlPath: '/app/renderer/office-preview.html',
      fetchRuntime
    })

    const response = await handler(
      new Request('open-science-office-preview://untrusted/office-preview.html')
    )

    expect(response.status).toBe(404)
    expect(fetchRuntime).not.toHaveBeenCalled()
  })

  it('maps packaged assets inside the renderer bundle and applies the runtime CSP', async () => {
    const module = await import('./office-preview-runtime-protocol')
    const fetchRuntime = vi.fn().mockResolvedValue(
      new Response('<!doctype html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    )
    const handler = module.createOfficePreviewRuntimeProtocolHandler({
      runtimeHtmlPath: '/app/renderer/office-preview.html',
      fetchRuntime
    })
    const request = new Request(
      'open-science-office-preview://runtime/office-preview.html?sessionId=session-1'
    )

    const response = await handler(request)

    expect(fetchRuntime).toHaveBeenCalledWith(
      pathToFileURL('/app/renderer/office-preview.html').toString(),
      request
    )
    expect(response.headers.get('content-security-policy')).toContain("object-src 'none'")
    expect(response.headers.get('content-security-policy')).toContain(
      'connect-src open-science-preview:'
    )
    expect(response.headers.get('content-security-policy')).toContain('frame-ancestors file:')
    expect(response.headers.get('content-security-policy')).not.toContain(
      "script-src 'self' 'unsafe-inline'"
    )
  })

  it('allows only the local Vite bootstrap requirements in development', async () => {
    const module = await import('./office-preview-runtime-protocol')
    const fetchRuntime = vi.fn().mockResolvedValue(
      new Response('<!doctype html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    )
    const handler = module.createOfficePreviewRuntimeProtocolHandler({
      runtimeHtmlPath: '/app/renderer/office-preview.html',
      devServerUrl: 'http://localhost:5173',
      fetchRuntime
    })

    const response = await handler(
      new Request('open-science-office-preview://runtime/office-preview.html?sessionId=session-1')
    )
    const csp = response.headers.get('content-security-policy')

    expect(csp).toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).toContain('http://localhost:5173')
    expect(csp).toContain('ws://localhost:5173')
    expect(csp).toContain('frame-ancestors http://localhost:5173')
  })

  it('rejects encoded paths that escape the packaged renderer bundle', async () => {
    const module = await import('./office-preview-runtime-protocol')
    const fetchRuntime = vi.fn()
    const handler = module.createOfficePreviewRuntimeProtocolHandler({
      runtimeHtmlPath: '/app/renderer/office-preview.html',
      fetchRuntime
    })

    const response = await handler(
      new Request('open-science-office-preview://runtime/%2e%2e%2fsecrets.txt')
    )

    expect(response.status).toBe(404)
    expect(fetchRuntime).not.toHaveBeenCalled()
  })

  it('preserves HEAD semantics without buffering an upstream body', async () => {
    const module = await import('./office-preview-runtime-protocol')
    const fetchRuntime = vi
      .fn()
      .mockResolvedValue(new Response('runtime', { headers: { 'content-length': '7' } }))
    const handler = module.createOfficePreviewRuntimeProtocolHandler({
      runtimeHtmlPath: '/app/renderer/office-preview.html',
      fetchRuntime
    })

    const response = await handler(
      new Request('open-science-office-preview://runtime/assets/runtime.js', { method: 'HEAD' })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('7')
    expect(await response.text()).toBe('')
  })

  it('buffers trusted runtime assets and replaces stale transfer headers', async () => {
    const module = await import('./office-preview-runtime-protocol')
    const fetchRuntime = vi.fn().mockResolvedValue(
      new Response('runtime', {
        headers: {
          'content-type': 'text/javascript',
          'content-length': '999',
          'content-encoding': 'br'
        }
      })
    )
    const handler = module.createOfficePreviewRuntimeProtocolHandler({
      runtimeHtmlPath: '/app/renderer/office-preview.html',
      fetchRuntime
    })

    const response = await handler(
      new Request('open-science-office-preview://runtime/assets/runtime.js')
    )

    expect(await response.text()).toBe('runtime')
    expect(response.headers.get('content-length')).toBe('7')
    expect(response.headers.get('content-encoding')).toBeNull()
  })

  it('registers and unregisters only the dedicated runtime scheme', async () => {
    const module = await import('./office-preview-runtime-protocol')
    const targetProtocol = { handle: vi.fn(), unhandle: vi.fn() }
    const options = {
      runtimeHtmlPath: '/app/renderer/office-preview.html',
      fetchRuntime: vi.fn()
    }

    const unregister = module.registerOfficePreviewRuntimeProtocol(options, targetProtocol)

    expect(targetProtocol.handle).toHaveBeenCalledWith(
      module.OFFICE_PREVIEW_RUNTIME_SCHEME,
      expect.any(Function)
    )
    unregister()
    expect(targetProtocol.unhandle).toHaveBeenCalledWith(module.OFFICE_PREVIEW_RUNTIME_SCHEME)
  })
})
