// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { connectOfficePreviewRuntime } from './office-preview-controller'
import { OfficePreviewRuntimeError } from './office-preview-runtime'

describe('connectOfficePreviewRuntime', () => {
  it('runs the received session and disposes it with the runtime subscription', async () => {
    let startListener: ((start: never) => void) | undefined
    const removeStartListener = vi.fn()
    const reportState = vi.fn()
    const disposeRender = vi.fn()
    const runPreview = vi.fn().mockResolvedValue(disposeRender)
    const container = document.createElement('div')
    const bridge = {
      onStart: vi.fn((listener) => {
        startListener = listener
        return removeStartListener
      }),
      reportState
    }
    const start = {
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.pptx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1
      },
      extension: 'pptx' as const,
      name: 'report.pptx',
      attempt: 0
    }

    const disconnect = connectOfficePreviewRuntime({ bridge, container, runPreview })
    startListener?.(start as never)
    await Promise.resolve()
    await Promise.resolve()

    expect(runPreview).toHaveBeenCalledWith({
      start,
      container,
      fetchFile: fetch,
      reportState
    })

    await disconnect()
    expect(removeStartListener).toHaveBeenCalledOnce()
    expect(disposeRender).toHaveBeenCalledOnce()
  })

  it('reports the stable error code returned by the isolated runtime', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let startListener: ((start: never) => void) | undefined
    const reportState = vi.fn()
    const bridge = {
      onStart: vi.fn((listener) => {
        startListener = listener
        return vi.fn()
      }),
      reportState
    }
    const start = {
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.docx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1
      },
      extension: 'docx' as const,
      name: 'report.docx',
      attempt: 0
    }
    const runPreview = vi
      .fn()
      .mockRejectedValue(new OfficePreviewRuntimeError('INVALID_PACKAGE', 'Invalid package'))

    connectOfficePreviewRuntime({
      bridge,
      container: document.createElement('div'),
      runPreview
    })
    startListener?.(start as never)
    await vi.waitFor(() => {
      expect(reportState).toHaveBeenCalledWith({
        sessionId: 'session-1',
        phase: 'error',
        error: 'INVALID_PACKAGE'
      })
    })
  })
})
