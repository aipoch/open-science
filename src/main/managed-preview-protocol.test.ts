import { describe, expect, it, vi } from 'vitest'

import type { ManagedPreviewResources } from './managed-preview-resources'
import { createManagedPreviewProtocolHandler } from './managed-preview-protocol'

describe('managed preview protocol', () => {
  it('streams the capability URL with constrained HTML response headers', async () => {
    const resources = {
      resolveProtocolResource: vi.fn().mockReturnValue({
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
    const csp = response.headers.get('content-security-policy')
    expect(csp).toContain("connect-src 'none'")
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).not.toContain("frame-ancestors 'none'")
    expect(await response.text()).toContain('Plotly.newPlot')
  })

  it('rejects URLs that are not an acquired resource capability', async () => {
    const resources = {
      resolveProtocolResource: vi.fn(() => {
        throw new Error('Managed preview resource is not available.')
      })
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
