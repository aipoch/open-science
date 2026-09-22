import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContents, WebContentsView } from 'electron'
import type { NativeActionMenuRequest } from '../shared/action-menu-overlay'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  views: [] as WebContentsView[],
  focused: null as Pick<WebContents, 'focus' | 'isDestroyed'> | null,
  loads: [] as Array<{ resolve: () => void; reject: (reason?: unknown) => void }>
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    ipcMain: new EventEmitter(),
    webContents: { getFocusedWebContents: () => runtime.focused },
    WebContentsView: class {
      webContents = Object.assign(new EventEmitter(), {
        mainFrame: {},
        isDestroyed: () => false,
        loadFile: vi.fn(
          () =>
            new Promise<void>((resolve, reject) => {
              runtime.loads.push({ resolve, reject })
            })
        ),
        loadURL: vi.fn(
          () =>
            new Promise<void>((resolve, reject) => {
              runtime.loads.push({ resolve, reject })
            })
        ),
        send: vi.fn(),
        focus: vi.fn(),
        close: vi.fn(),
        setZoomFactor: vi.fn(),
        setWindowOpenHandler: vi.fn()
      })
      setBounds = vi.fn()
      setVisible = vi.fn()
      setBackgroundColor = vi.fn()
      constructor() {
        runtime.views.push(this as unknown as WebContentsView)
      }
    }
  }
})
import { ipcMain } from 'electron'
import { createActionMenuOverlay } from './action-menu-overlay'

const request = (id = 'one'): NativeActionMenuRequest => ({
  id,
  pointer: { x: 90, y: 100 },
  dark: false,
  compact: true,
  entries: [
    { kind: 'action', action: 'copy', label: 'Copy', icon: '', disabled: false, danger: false }
  ]
})
const eventFor = <T extends { mainFrame: unknown }>(
  sender: T
): { sender: T; senderFrame: unknown } => ({ sender, senderFrame: sender.mainFrame })

beforeEach(() => {
  ipcMain.removeAllListeners()
  runtime.views = []
  runtime.focused = null
  runtime.loads = []
})
const setup = (): {
  host: EventEmitter & { mainFrame: object; send: ReturnType<typeof vi.fn> }
  window: { contentView: { addChildView: ReturnType<typeof vi.fn> } }
  manager: { destroy: () => void }
  open: (id?: string) => boolean
} => {
  const host = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
    getZoomFactor: () => 1.25,
    send: vi.fn(),
    focus: vi.fn()
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: host,
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1000, height: 750 }),
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
  })
  const manager = createActionMenuOverlay(window as unknown as BrowserWindow, {
    preload: '/preload.js',
    html: '/menu.html'
  })
  const open = (id = 'one'): boolean =>
    ipcMain.emit('action-menu:open', eventFor(host), request(id))
  return { host, window, manager, open }
}

describe('native action menu lifetime', () => {
  it('keeps content live and focuses a topmost transparent view only after the menu is ready', async () => {
    const { host, window, open, manager } = setup()
    const page = { focus: vi.fn(), isDestroyed: () => false }
    runtime.focused = page
    open()
    await Promise.resolve()
    const view = runtime.views[0]
    expect(view.setBackgroundColor).toHaveBeenCalledWith('#00000000')
    expect(view.webContents.focus).not.toHaveBeenCalled()
    ipcMain.emit('action-menu:mounted', eventFor(view.webContents))
    ipcMain.emit('action-menu:ready', eventFor(view.webContents), 'one')
    expect(window.contentView.addChildView).toHaveBeenLastCalledWith(view)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1000, height: 750 })
    expect(view.webContents.setZoomFactor).toHaveBeenCalledWith(1.25)
    expect(view.webContents.focus).toHaveBeenCalledTimes(1)
    ipcMain.emit('action-menu:result', eventFor(view.webContents), { id: 'one', action: 'copy' })
    expect(page.focus).toHaveBeenCalledTimes(1)
    expect(host.send).toHaveBeenCalledWith('action-menu:closed', { id: 'one', action: 'copy' })
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    manager.destroy()
  })
  it('rejects untrusted callers, stale results, and disabled or unknown actions', async () => {
    const { host, open, manager } = setup()
    ipcMain.emit('action-menu:open', eventFor({ mainFrame: {} }), request())
    ipcMain.emit('action-menu:open', { sender: host, senderFrame: {} }, request())
    expect(runtime.views).toHaveLength(0)
    open()
    await Promise.resolve()
    open('two')
    const view = runtime.views[1]
    const disabled = request('two')
    disabled.entries.push({
      kind: 'action',
      action: 'disabled',
      label: 'Disabled',
      icon: '',
      disabled: true,
      danger: false
    })
    ipcMain.emit('action-menu:open', eventFor(host), disabled)
    ipcMain.emit('action-menu:ready', eventFor(view.webContents), 'one')
    expect(view.webContents.focus).not.toHaveBeenCalled()
    for (const result of [
      { id: 'one', action: 'copy' },
      { id: 'two', action: 'delete' },
      { id: 'two', action: 'disabled' }
    ]) {
      ipcMain.emit('action-menu:result', eventFor(view.webContents), result)
    }
    expect(host.send).toHaveBeenCalledWith('action-menu:closed', { id: 'one' })
    expect(host.send).not.toHaveBeenCalledWith('action-menu:closed', { id: 'two' })
    ipcMain.emit('action-menu:close', eventFor(host), 'one')
    ipcMain.emit('action-menu:result', eventFor(view.webContents), { id: 'two' })
    expect(host.send).toHaveBeenCalledWith('action-menu:closed', { id: 'two' })
    manager.destroy()
  })
  it('discards an opening menu when its owner navigates and releases its renderer on teardown', async () => {
    const { host, open, manager } = setup()
    open()
    await Promise.resolve()
    const view = runtime.views[0]
    host.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    ipcMain.emit('action-menu:ready', eventFor(view.webContents), 'one')
    expect(view.webContents.focus).not.toHaveBeenCalled()
    manager.destroy()
    expect(view.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(ipcMain.listenerCount('action-menu:open')).toBe(0)
  })
  it('does not let an old load failure dispose a reopened menu view', async () => {
    const { host, open, manager } = setup()
    open('one')
    const firstLoad = runtime.loads[0]
    const firstView = runtime.views[0]
    ipcMain.emit('action-menu:close', eventFor(host), 'one')
    open('two')
    const view = runtime.views[1]

    firstLoad.reject(new Error('stale load failed'))
    await Promise.resolve()

    expect(firstView.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(host.send).not.toHaveBeenCalledWith('action-menu:closed', { id: 'two' })
    runtime.loads[1].resolve()
    ipcMain.emit('action-menu:mounted', eventFor(view.webContents))
    ipcMain.emit('action-menu:ready', eventFor(view.webContents), 'two')
    expect(view.webContents.focus).toHaveBeenCalledTimes(1)
    manager.destroy()
  })
})
