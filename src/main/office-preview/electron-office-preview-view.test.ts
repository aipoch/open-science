import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const runtimeListeners = new Map<string, (...args: unknown[]) => void>()
  const childListeners = new Map<string, () => void>()
  const childContents = {
    id: 91,
    send: vi.fn(),
    close: vi.fn(),
    isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => childListeners.set(event, listener)),
    off: vi.fn((event: string) => childListeners.delete(event)),
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    getOSProcessId: vi.fn(() => 451),
    session: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      protocol: { handle: vi.fn(), unhandle: vi.fn() }
    }
  }
  const childView = {
    webContents: childContents,
    setBounds: vi.fn(),
    setVisible: vi.fn()
  }
  const parentWindow = {
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn()
    }
  }
  return { runtimeListeners, childContents, childView, parentWindow }
})

vi.mock('electron', () => ({
  app: {
    getAppMetrics: vi.fn(() => [
      { pid: 451, memory: { privateBytes: 12_345, workingSetSize: 20_000 } }
    ])
  },
  BrowserWindow: { fromWebContents: vi.fn(() => mocks.parentWindow) },
  WebContentsView: vi.fn(function () {
    return mocks.childView
  }),
  ipcMain: {
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) =>
      mocks.runtimeListeners.set(channel, listener)
    ),
    off: vi.fn((channel: string) => mocks.runtimeListeners.delete(channel))
  },
  webContents: {
    fromId: vi.fn((id: number) =>
      id === 91 ? mocks.childContents : { id: 7, getOSProcessId: vi.fn(() => 450) }
    )
  }
}))

const { createElectronOfficePreviewViewFactory } = await import('./electron-office-preview-view')

describe('createElectronOfficePreviewViewFactory', () => {
  it('creates a sandboxed child with a dedicated partition and runtime entry', async () => {
    let isResourceAllowed: ((resourceId: string) => boolean) | undefined
    const unregisterPreviewProtocol = vi.fn()
    const registerPreviewProtocol = vi.fn((_protocol, isAllowed) => {
      isResourceAllowed = isAllowed
      return unregisterPreviewProtocol
    })
    const factory = createElectronOfficePreviewViewFactory({
      preloadPath: '/app/preload/office-preview.js',
      runtimeHtmlPath: '/app/renderer/office-preview.html',
      devServerUrl: 'http://localhost:5173',
      registerPreviewProtocol
    })
    const child = factory({
      parentOwnerId: 7,
      sessionId: 'session-1',
      onState: vi.fn(),
      onGone: vi.fn().mockResolvedValue(undefined)
    })
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

    await child.start(start)

    const { WebContentsView } = await import('electron')
    expect(WebContentsView).toHaveBeenCalledWith({
      webPreferences: {
        preload: '/app/preload/office-preview.js',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: 'office-preview-session-1'
      }
    })
    expect(registerPreviewProtocol).toHaveBeenCalledWith(
      mocks.childContents.session.protocol,
      expect.any(Function)
    )
    expect(isResourceAllowed?.('resource-1')).toBe(true)
    expect(isResourceAllowed?.('different-resource')).toBe(false)
    expect(mocks.childContents.loadURL).toHaveBeenCalledWith(
      'http://localhost:5173/office-preview.html'
    )
    expect(await child.getMemoryUsageBytes?.()).toBe(12_345 * 1024)
    const permissionHandler = mocks.childContents.session.setPermissionRequestHandler.mock
      .calls[0]?.[0] as (
      _contents: unknown,
      permission: string,
      callback: (allowed: boolean) => void
    ) => void
    const permissionDecision = vi.fn()
    permissionHandler({}, 'clipboard-read', permissionDecision)
    expect(permissionDecision).toHaveBeenCalledWith(false)
    const permissionCheckHandler = mocks.childContents.session.setPermissionCheckHandler.mock
      .calls[0]?.[0] as () => boolean
    expect(permissionCheckHandler()).toBe(false)

    child.close()
    expect(unregisterPreviewProtocol).toHaveBeenCalledOnce()
    expect(mocks.childContents.session.off).toHaveBeenCalledWith(
      'will-download',
      expect.any(Function)
    )
  })
})
