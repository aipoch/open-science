import { describe, expect, it, vi } from 'vitest'

import { registerSourcePreviewWebRequestOwner } from './source-preview-web-request-owner'

describe('source preview web request owner', () => {
  it('shares one Session listener, routes by window, and unregisters after the last owner closes', () => {
    type Handler = (
      details: {
        webContentsId?: number
        frame?: { frameTreeNodeId: number } | null
        resourceType: string
        url: string
        statusCode: number
        statusLine: string
        responseHeaders?: Record<string, string[]>
      },
      callback: (response: { responseHeaders?: Record<string, string[]> }) => void
    ) => void
    let handler: Handler | undefined
    const onHeadersReceived = vi.fn(
      (_filterOrListener: { urls: string[] } | Handler | null, listener?: Handler | null) => {
        handler = listener ?? undefined
      }
    )
    const session = { webRequest: { onHeadersReceived } }
    const firstMonitor = { finishNavigation: vi.fn() }
    const secondMonitor = { finishNavigation: vi.fn() }
    const firstPolicy = { rewriteResponseHeaders: vi.fn(() => undefined) }
    const secondPolicy = {
      rewriteResponseHeaders: vi.fn(() => ({ 'x-preview': ['rewritten'] }))
    }

    const disposeFirst = registerSourcePreviewWebRequestOwner(
      session as unknown as Parameters<typeof registerSourcePreviewWebRequestOwner>[0],
      101,
      firstMonitor,
      firstPolicy
    )
    const disposeSecond = registerSourcePreviewWebRequestOwner(
      session as unknown as Parameters<typeof registerSourcePreviewWebRequestOwner>[0],
      202,
      secondMonitor,
      secondPolicy
    )

    expect(onHeadersReceived).toHaveBeenCalledTimes(1)
    const firstCallback = vi.fn()
    handler?.(
      {
        webContentsId: 101,
        frame: { frameTreeNodeId: 7 },
        resourceType: 'subFrame',
        url: 'https://example.com/unavailable',
        statusCode: 503,
        statusLine: 'HTTP/1.1 503 Service Unavailable'
      },
      firstCallback
    )
    expect(firstMonitor.finishNavigation).toHaveBeenCalledWith(
      { frameTreeNodeId: 7 },
      'https://example.com/unavailable',
      503,
      'Service Unavailable'
    )
    expect(secondMonitor.finishNavigation).not.toHaveBeenCalled()
    expect(firstCallback).toHaveBeenCalledWith({})

    disposeFirst()
    const releasedCallback = vi.fn()
    handler?.(
      {
        webContentsId: 101,
        frame: { frameTreeNodeId: 7 },
        resourceType: 'subFrame',
        url: 'https://example.com/unavailable',
        statusCode: 503,
        statusLine: 'HTTP/1.1 503 Service Unavailable'
      },
      releasedCallback
    )
    expect(firstMonitor.finishNavigation).toHaveBeenCalledTimes(1)
    expect(releasedCallback).toHaveBeenCalledWith({})

    const secondCallback = vi.fn()
    handler?.(
      {
        webContentsId: 202,
        frame: { frameTreeNodeId: 9 },
        resourceType: 'subFrame',
        url: 'https://example.com/paper',
        statusCode: 200,
        statusLine: 'HTTP/1.1 200 OK',
        responseHeaders: { 'x-frame-options': ['DENY'] }
      },
      secondCallback
    )
    expect(secondPolicy.rewriteResponseHeaders).toHaveBeenCalledOnce()
    expect(secondCallback).toHaveBeenCalledWith({
      responseHeaders: { 'x-preview': ['rewritten'] }
    })

    disposeSecond()
    expect(onHeadersReceived).toHaveBeenLastCalledWith(null)
  })
})
