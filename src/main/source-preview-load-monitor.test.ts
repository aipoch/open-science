import { describe, expect, it, vi } from 'vitest'

import { createSourcePreviewLoadMonitor } from './source-preview-load-monitor'

describe('source preview load monitor', () => {
  it('keeps a failure terminal when a late success arrives for the same navigation', () => {
    const publish = vi.fn()
    const monitor = createSourcePreviewLoadMonitor(publish)
    const frame = { frameTreeNodeId: 7, processId: 11, routingId: 13 }
    const sourceUrl = 'https://example.com/paper'

    monitor.registerRoot(frame, sourceUrl)
    monitor.failNavigation(frame, sourceUrl, -102, 'ERR_CONNECTION_REFUSED')
    monitor.finishNavigation(frame, sourceUrl, 200, 'OK')

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenLastCalledWith({
      navigationId: 1,
      sourceUrl,
      currentUrl: sourceUrl,
      phase: 'failed',
      failure: 'network',
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED'
    })

    monitor.startNavigation(frame, sourceUrl, false)
    monitor.finishNavigation(frame, sourceUrl, 200, 'OK')
    expect(publish).toHaveBeenLastCalledWith({
      navigationId: 2,
      sourceUrl,
      currentUrl: sourceUrl,
      phase: 'loaded',
      httpStatusCode: 200,
      httpStatusText: 'OK'
    })
  })

  it('ignores late lifecycle events after a source is released', () => {
    const publish = vi.fn()
    const monitor = createSourcePreviewLoadMonitor(publish) as ReturnType<
      typeof createSourcePreviewLoadMonitor
    > & {
      releaseSource?: (sourceUrl: string) => void
    }
    const frame = { frameTreeNodeId: 7, processId: 11, routingId: 13 }

    monitor.registerRoot(frame, 'https://example.com/paper')
    expect(monitor.releaseSource).toBeTypeOf('function')
    monitor.releaseSource?.('https://example.com/paper')
    monitor.failNavigation(frame, 'https://example.com/paper', -102, 'ERR_CONNECTION_REFUSED')

    expect(publish).toHaveBeenCalledOnce()
    expect(publish).toHaveBeenCalledWith({
      navigationId: 1,
      sourceUrl: 'https://example.com/paper',
      currentUrl: 'https://example.com/paper',
      phase: 'loading'
    })
  })
})
