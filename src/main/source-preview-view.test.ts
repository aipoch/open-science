import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
const { ipcMain } = vi.hoisted(() => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() } }))
vi.mock('electron', () => ({ ipcMain, WebContentsView: class {} }))
import { createSourcePreviewViews, getActiveSourceContents } from './source-preview-view'

class FakeView {
  webContents = Object.assign(new EventEmitter(), {
    loadURL: vi.fn().mockResolvedValue(undefined),
    setWindowOpenHandler: vi.fn(),
    isDestroyed: (): boolean => false,
    close: vi.fn(),
    getURL: (): string => 'https://example.com/paper',
    setZoomFactor: vi.fn(),
    stopFindInPage: vi.fn()
  })
  setBounds = vi.fn()
  setVisible = vi.fn()
}
const views: FakeView[] = []
class Harness {
  host = Object.assign(new EventEmitter(), {
    mainFrame: {},
    send: vi.fn(),
    getZoomFactor: (): number => 1.25,
    isDestroyed: (): boolean => false,
    session: new EventEmitter()
  })
  owner = Object.assign(new EventEmitter(), {
    webContents: this.host,
    isDestroyed: (): boolean => false,
    getContentBounds: (): { width: number; height: number } => ({ width: 1000, height: 800 }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
  })
  createView = vi.fn<(options: Electron.WebContentsViewConstructorOptions) => FakeView>(() => {
    const view = new FakeView()
    views.push(view)
    return view
  })
  manager: ReturnType<typeof createSourcePreviewViews>
  update: (event: unknown, request: unknown) => void
  release: (event: unknown, sourceUrl: string, instanceId: string) => void
  event = { sender: this.host, senderFrame: this.host.mainFrame }
  request = {
    instanceId: 'test-instance',
    sourceUrl: 'https://example.com/paper',
    attempt: 0,
    bounds: { x: 100, y: 100, width: 400, height: 300 }
  }
  constructor() {
    ipcMain.on.mockClear()
    views.length = 0
    this.manager = createSourcePreviewViews(
      this.owner as unknown as Electron.BrowserWindow,
      this.createView as unknown as Parameters<typeof createSourcePreviewViews>[1]
    )
    this.update = ipcMain.on.mock.calls.find((call) => call[0] === 'source-preview:update-view')![1]
    this.release = ipcMain.on.mock.calls.find((call) => call[0] === 'source-preview:release')![1]
  }
}
const setup = (): Harness => new Harness()
describe('native source previews', () => {
  it('admits only the owner main frame and HTTPS URLs with finite bounds', () => {
    const s = setup()
    s.update({ ...s.event, senderFrame: {} }, s.request)
    s.update(s.event, { ...s.request, sourceUrl: 'file:///tmp/private' })
    s.update(s.event, { ...s.request, bounds: { ...s.request.bounds, x: NaN } })
    expect(s.createView).not.toHaveBeenCalled()
    s.update(s.event, s.request)
    expect(views).toHaveLength(1)
    expect(s.createView.mock.calls[0][0].webPreferences).toMatchObject({
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    })
    expect(s.createView.mock.calls[0][0].webPreferences?.preload).toBeUndefined()
  })
  it('converts CSS geometry once, preserves hidden tabs, and closes released content', () => {
    const s = setup()
    s.update(s.event, s.request)
    expect(views[0].setBounds).toHaveBeenLastCalledWith({ x: 125, y: 125, width: 500, height: 375 })
    s.update(s.event, { ...s.request, bounds: null })
    expect(views[0].setVisible).toHaveBeenLastCalledWith(false)
    expect(views[0].webContents.close).not.toHaveBeenCalled()
    s.update(s.event, s.request)
    expect(views[0].webContents.loadURL).toHaveBeenCalledTimes(1)
    s.release(s.event, s.request.sourceUrl, s.request.instanceId)
    expect(views[0].webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    s.update(s.event, s.request)
    expect(views).toHaveLength(1)
  })
  it('cleans up after host destruction without reading destroyed native properties', () => {
    const s = setup()
    s.update(s.event, s.request)
    Object.defineProperty(s.host, 'session', {
      get: () => {
        throw new Error('Object has been destroyed')
      }
    })
    expect(() => s.owner.emit('closed')).not.toThrow()
    expect(views[0].webContents.close).toHaveBeenCalledOnce()
  })
  it('uses native focus for find routing and preserves HTTP failure through hash navigation', () => {
    const s = setup()
    s.update(s.event, s.request)
    expect(getActiveSourceContents(s.host)).toBeUndefined()
    const remote = views[0].webContents
    remote.emit('focus')
    expect(getActiveSourceContents(s.host)).toBe(remote)
    s.host.emit('focus')
    expect(getActiveSourceContents(s.host)).toBeUndefined()
  })
  it('preserves HTTP failures through same-document navigation', () => {
    const s = setup()
    s.update(s.event, s.request)
    const remote = views[0].webContents
    remote.emit('did-navigate', {}, 'https://example.com/error', 404, 'Not Found')
    remote.emit('did-navigate-in-page', {}, 'https://example.com/error#details', true)
    expect(s.host.send).toHaveBeenLastCalledWith(
      'source-preview:load-state',
      expect.objectContaining({
        phase: 'failed',
        httpStatusCode: 404,
        currentUrl: 'https://example.com/error#details'
      })
    )
  })
  it('retains secure descendant frames while blocking non-HTTPS top-level navigation', () => {
    const s = setup()
    s.update(s.event, s.request)
    for (const url of ['about:srcdoc', 'blob:https://example.com/frame']) {
      const event = { url, isMainFrame: false, preventDefault: vi.fn() }
      views[0].webContents.emit('will-frame-navigate', event)
      expect(event.preventDefault).not.toHaveBeenCalled()
      event.isMainFrame = true
      views[0].webContents.emit('will-frame-navigate', event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
  })
  it('blocks remote downloads without interfering with other session owners', () => {
    const s = setup()
    s.update(s.event, s.request)
    const preventDefault = vi.fn()
    s.host.session.emit('will-download', { preventDefault }, {}, {})
    expect(preventDefault).not.toHaveBeenCalled()
    s.host.session.emit('will-download', { preventDefault }, {}, views[0].webContents)
    expect(preventDefault).toHaveBeenCalledOnce()
  })
  it('ignores old view events after retry and blocks unsafe navigation', () => {
    const s = setup()
    s.update(s.event, s.request)
    const old = views[0]
    const event = { preventDefault: vi.fn(), isMainFrame: true, url: 'file:///tmp/private' }
    old.webContents.emit('will-frame-navigate', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    s.update(s.event, { ...s.request, attempt: 1 })
    s.host.send.mockClear()
    old.webContents.getURL = () => {
      throw new Error('Object has been destroyed')
    }
    expect(() =>
      old.webContents.emit('did-navigate', {}, s.request.sourceUrl, 200, 'OK')
    ).not.toThrow()
    expect(() =>
      old.webContents.emit('did-navigate-in-page', {}, s.request.sourceUrl + '#x', true)
    ).not.toThrow()
    expect(s.host.send).not.toHaveBeenCalled()
    expect(views).toHaveLength(2)
    s.host.emit('render-process-gone')
    expect(views[1].webContents.close).toHaveBeenCalledOnce()
  })
})
