import { beforeEach, expect, it, vi } from 'vitest'
import { SETTINGS_WINDOW_CHANNELS as C, type SettingsWindowState } from '../shared/settings-window'
const h = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const makeWindow = vi.fn(() => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const contents = { mainFrame: {}, send: vi.fn(), isCrashed: vi.fn(() => false) }
    return {
      webContents: contents,
      listeners,
      on: vi.fn((name, fn) => listeners.set(name, fn)),
      once: vi.fn((name, fn) => listeners.set(name, fn)),
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      hide: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      destroy: vi.fn()
    }
  })
  const owner = makeWindow(),
    settings = makeWindow()
  return { handlers, owner, settings, create: vi.fn(() => settings) }
})
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (sender: unknown) => (sender === h.owner.webContents ? h.owner : null)
  }
}))
vi.mock('./ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, fn: (...args: unknown[]) => unknown) =>
    h.handlers.set(channel, fn)
}))
vi.mock('./windows', () => ({
  createSettingsWindow: h.create,
  isTrustedAppContents: (sender: unknown) =>
    sender === h.owner.webContents || sender === h.settings.webContents
}))
import { registerSettingsWindowIpcHandlers } from './settings-window-ipc'
const invoke = (
  channel: string,
  sender = h.owner.webContents,
  ...args: unknown[]
): SettingsWindowState =>
  h.handlers.get(channel)!(
    { sender, senderFrame: sender.mainFrame },
    ...args
  ) as SettingsWindowState
beforeEach(() => {
  vi.clearAllMocks()
  h.handlers.clear()
  h.owner.listeners.clear()
  h.settings.listeners.clear()
  registerSettingsWindowIpcHandlers()
})
it('reuses one window and returns the latest intent after renderer readiness', () => {
  invoke(C.open, h.owner.webContents, { route: { panel: 'general' } })
  invoke(C.open, h.owner.webContents, { route: { panel: 'storage' }, activeProjectId: 'p' })
  expect(h.create).toHaveBeenCalledOnce()
  expect(invoke(C.ready, h.settings.webContents)).toMatchObject({
    revision: 2,
    route: { panel: 'storage' },
    activeProjectId: 'p',
    visible: true
  })
  expect(h.settings.show).toHaveBeenCalledOnce()
})
it('hides and reopens without losing the renderer, and destroys it with its workspace', () => {
  invoke(C.open)
  const event = { preventDefault: vi.fn() }
  h.settings.listeners.get('close')!(event)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(invoke(C.ready, h.settings.webContents).visible).toBe(false)
  expect(h.settings.destroy).not.toHaveBeenCalled()
  expect(h.owner.focus).toHaveBeenCalledOnce()
  expect(h.owner.webContents.send).toHaveBeenLastCalledWith(
    C.opened,
    expect.objectContaining({ visible: false })
  )
  invoke(C.open)
  expect(invoke(C.ready, h.settings.webContents).visible).toBe(true)
  h.owner.listeners.get('closed')!()
  expect(h.settings.destroy).toHaveBeenCalledOnce()
})
it('rejects child frames and cross-window navigation impersonation', () => {
  invoke(C.open)
  expect(() =>
    h.handlers.get(C.open)!({ sender: h.owner.webContents, senderFrame: {} }, {})
  ).toThrow('Untrusted')
  expect(() =>
    invoke(C.navigate, h.owner.webContents, { method: 'openProject', args: ['p'] })
  ).toThrow()
  expect(() =>
    invoke(C.navigate, h.settings.webContents, { method: 'setState', args: [] })
  ).toThrow()
  invoke(C.navigate, h.settings.webContents, { method: 'openProject', args: ['p'] })
  expect(h.owner.webContents.send).toHaveBeenCalledWith(C.navigation, {
    method: 'openProject',
    args: ['p'],
    navigationToken: 2
  })
  expect(h.settings.hide).not.toHaveBeenCalled()
  invoke(C.navigated, h.owner.webContents, 2)
  expect(h.settings.hide).toHaveBeenCalledOnce()
  expect(h.owner.webContents.send).toHaveBeenLastCalledWith(C.navigation, expect.anything())
})

it('does not close a reopened window for a stale navigation acknowledgement', () => {
  invoke(C.open)
  invoke(C.navigate, h.settings.webContents, { method: 'openProject', args: ['p'] })
  invoke(C.open)
  invoke(C.navigated, h.owner.webContents, 2)
  expect(h.settings.hide).not.toHaveBeenCalled()
  invoke(C.navigate, h.settings.webContents, { method: 'openProject', args: ['p'] })
  invoke(C.context, h.owner.webContents, { activeProjectId: 'p' })
  invoke(C.navigated, h.owner.webContents, 4)
  expect(h.settings.hide).toHaveBeenCalledOnce()
})
