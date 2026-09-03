import { describe, expect, it, vi } from 'vitest'

import { PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL } from '../shared/preview-context-menu'
import {
  createPreviewContextMenuRequest,
  installPreviewContextMenuBridge,
  type PreviewContextMenuFrame,
  type PreviewContextMenuParams,
  type PreviewContextMenuWebContents
} from './preview-context-menu'

const mainFrame: PreviewContextMenuFrame = {
  url: 'file:///app/index.html',
  parent: null,
  detached: false,
  isDestroyed: () => false,
  executeJavaScript: async () => false
}

const childFrame = (overrides: Partial<PreviewContextMenuFrame> = {}): PreviewContextMenuFrame => ({
  url: 'open-science-preview://resource-1/report.html',
  parent: mainFrame,
  detached: false,
  isDestroyed: () => false,
  executeJavaScript: async () => false,
  ...overrides
})

const contextMenuParams = (frame: PreviewContextMenuFrame | null): PreviewContextMenuParams => ({
  x: 12,
  y: 24,
  frame,
  isEditable: false,
  formControlType: 'none'
})

describe('preview context menu main-process bridge', () => {
  it('builds a narrow request from the live managed child frame', () => {
    const request = createPreviewContextMenuRequest(mainFrame, contextMenuParams(childFrame()))

    expect(request).toEqual({
      x: 12,
      y: 24,
      frameUrl: 'open-science-preview://resource-1/report.html'
    })
    expect(Object.keys(request ?? {})).not.toEqual(
      expect.arrayContaining(['selectionText', 'linkURL', 'srcURL', 'pageURL'])
    )
  })

  it('accepts the Office runtime but rejects unsafe or stale frame events', () => {
    expect(
      createPreviewContextMenuRequest(
        mainFrame,
        contextMenuParams(
          childFrame({
            url: 'open-science-office-preview://runtime/office-preview.html?sessionId=session-1'
          })
        )
      )
    ).not.toBeNull()
    expect(createPreviewContextMenuRequest(mainFrame, contextMenuParams(mainFrame))).toBeNull()
    expect(createPreviewContextMenuRequest(mainFrame, contextMenuParams(null))).toBeNull()
    expect(
      createPreviewContextMenuRequest(mainFrame, contextMenuParams(childFrame({ parent: null })))
    ).toBeNull()
    expect(
      createPreviewContextMenuRequest(
        mainFrame,
        contextMenuParams(childFrame({ url: 'https://example.com/report.html' }))
      )
    ).toBeNull()
    expect(
      createPreviewContextMenuRequest(
        mainFrame,
        contextMenuParams(childFrame({ isDestroyed: () => true }))
      )
    ).toBeNull()
    expect(
      createPreviewContextMenuRequest(mainFrame, contextMenuParams(childFrame({ detached: true })))
    ).toBeNull()
    expect(
      createPreviewContextMenuRequest(mainFrame, {
        ...contextMenuParams(childFrame()),
        x: Number.NaN
      })
    ).toBeNull()
    expect(
      createPreviewContextMenuRequest(mainFrame, {
        ...contextMenuParams(childFrame()),
        isEditable: true
      })
    ).toBeNull()
    expect(
      createPreviewContextMenuRequest(mainFrame, {
        ...contextMenuParams(childFrame()),
        formControlType: 'input-text'
      })
    ).toBeNull()
  })

  it('forwards accepted requests and tears down the exact listener', async () => {
    let listener:
      ((event: unknown, value: ReturnType<typeof contextMenuParams>) => void) | undefined
    const send = vi.fn()
    const removeListener = vi.fn()
    const webContents: PreviewContextMenuWebContents = {
      mainFrame,
      getZoomFactor: () => 1,
      send,
      on: (_event, nextListener) => {
        listener = nextListener
      },
      removeListener
    }

    const dispose = installPreviewContextMenuBridge(webContents)
    listener?.({}, contextMenuParams(childFrame()))

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send).toHaveBeenCalledWith(PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL, {
      x: 12,
      y: 24,
      frameUrl: 'open-science-preview://resource-1/report.html'
    })

    listener?.({}, contextMenuParams(childFrame({ url: 'https://example.com' })))
    await Promise.resolve()
    expect(send).toHaveBeenCalledTimes(1)

    dispose()
    expect(removeListener).toHaveBeenCalledWith('context-menu', listener)
  })

  it('normalizes zoomed Electron coordinates before probing and forwarding', async () => {
    let listener:
      ((event: unknown, value: ReturnType<typeof contextMenuParams>) => void) | undefined
    const send = vi.fn()
    const executeJavaScript = vi.fn().mockResolvedValue(false)
    const frame = { ...childFrame(), executeJavaScript }
    const params = { ...contextMenuParams(frame), x: 250, y: 125 }
    Object.defineProperty(params, 'frame', {
      value: frame,
      enumerable: false
    })
    const webContents = {
      mainFrame: {
        ...mainFrame,
        executeJavaScript: vi.fn().mockResolvedValue({ left: 50, top: 25 })
      },
      getZoomFactor: () => 1.25,
      send,
      on: (_event, nextListener) => {
        listener = nextListener
      },
      removeListener: vi.fn()
    } satisfies PreviewContextMenuWebContents & { getZoomFactor: () => number }

    installPreviewContextMenuBridge(webContents)
    listener?.({}, params)

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(Object.keys(params)).not.toContain('frame')
    expect(Object.getOwnPropertyNames(params)).toContain('frame')
    expect(params.frame).toBe(frame)
    expect(executeJavaScript).toHaveBeenCalledOnce()
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain('document.elementFromPoint(150, 75)')
    expect(send).toHaveBeenCalledWith(PREVIEW_CONTEXT_MENU_REQUESTED_CHANNEL, {
      x: 200,
      y: 100,
      frameUrl: 'open-science-preview://resource-1/report.html'
    })
  })

  it('does not forward when the child-frame target opts out explicitly', async () => {
    let listener:
      ((event: unknown, value: ReturnType<typeof contextMenuParams>) => void) | undefined
    const send = vi.fn()
    const executeJavaScript = vi.fn().mockResolvedValue(true)
    const initialFrameUrl = 'open-science-preview://resource-1/report.html'
    const frame = {
      ...childFrame({ url: `${initialFrameUrl}#results` }),
      executeJavaScript
    }
    const executeFrameLookup = vi.fn(async (code: string) => {
      const iframe = {
        src: initialFrameUrl,
        getBoundingClientRect: () => ({ left: 5, top: 7 })
      }
      const frameDocument = { querySelectorAll: () => [iframe] }
      return Function('document', `return ${code}`)(frameDocument) as unknown
    })
    const webContents: PreviewContextMenuWebContents = {
      mainFrame: { ...mainFrame, executeJavaScript: executeFrameLookup },
      getZoomFactor: () => 1,
      send,
      on: (_event, nextListener) => {
        listener = nextListener
      },
      removeListener: vi.fn()
    }

    installPreviewContextMenuBridge(webContents)
    listener?.({}, contextMenuParams(frame))
    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalledOnce())

    expect(executeJavaScript.mock.calls[0]?.[0]).toContain(
      '[data-preview-context-menu-passthrough]'
    )
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain('document.elementFromPoint(7, 17)')
    expect(send).not.toHaveBeenCalled()
  })

  it('drops an older async request when a newer native-menu event arrives', async () => {
    let listener:
      ((event: unknown, value: ReturnType<typeof contextMenuParams>) => void) | undefined
    let resolveTargetCheck: (passthrough: boolean) => void = () => undefined
    const targetCheck = new Promise<boolean>((resolve) => {
      resolveTargetCheck = resolve
    })
    const send = vi.fn()
    const frame = {
      ...childFrame(),
      executeJavaScript: vi.fn().mockReturnValue(targetCheck)
    }
    const webContents: PreviewContextMenuWebContents = {
      mainFrame: { ...mainFrame, executeJavaScript: async () => null },
      getZoomFactor: () => 1,
      send,
      on: (_event, nextListener) => {
        listener = nextListener
      },
      removeListener: vi.fn()
    }

    installPreviewContextMenuBridge(webContents)
    listener?.({}, contextMenuParams(frame))
    await vi.waitFor(() => expect(frame.executeJavaScript).toHaveBeenCalledOnce())

    listener?.({}, { ...contextMenuParams(frame), isEditable: true })
    resolveTargetCheck(false)
    await targetCheck
    await Promise.resolve()

    expect(send).not.toHaveBeenCalled()
  })

  it.each([
    [
      'open-science-preview://resource-1/report.html',
      'open-science-preview://resource-2/report.html'
    ],
    [
      'open-science-office-preview://runtime/office-preview.html?sessionId=session-1',
      'open-science-office-preview://runtime/office-preview.html?sessionId=session-2'
    ]
  ])('drops an async request when its frame navigates from %s', async (initialUrl, nextUrl) => {
    let listener:
      ((event: unknown, value: ReturnType<typeof contextMenuParams>) => void) | undefined
    let resolveTargetCheck: (passthrough: boolean) => void = () => undefined
    const targetCheck = new Promise<boolean>((resolve) => {
      resolveTargetCheck = resolve
    })
    const send = vi.fn()
    const frame = {
      ...childFrame({ url: initialUrl }),
      executeJavaScript: vi.fn().mockReturnValue(targetCheck)
    }
    const webContents: PreviewContextMenuWebContents = {
      mainFrame: { ...mainFrame, executeJavaScript: async () => null },
      getZoomFactor: () => 1,
      send,
      on: (_event, nextListener) => {
        listener = nextListener
      },
      removeListener: vi.fn()
    }

    installPreviewContextMenuBridge(webContents)
    listener?.({}, contextMenuParams(frame))
    await vi.waitFor(() => expect(frame.executeJavaScript).toHaveBeenCalledOnce())

    frame.url = nextUrl
    resolveTargetCheck(false)
    await targetCheck
    await Promise.resolve()

    expect(send).not.toHaveBeenCalled()
  })
})
