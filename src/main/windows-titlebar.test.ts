import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { WINDOWS_TITLEBAR_LABELS, type WindowsTitleBarMenuRequest } from '../shared/window-controls'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  build: vi.fn(),
  popup: vi.fn(),
  closePopup: vi.fn(),
  scale: vi.fn(),
  openExternal: vi.fn()
}))
vi.mock('./ipc-handler-registry', () => ({
  ipcMainHandle: (channel: string, handler: (...args: unknown[]) => unknown) =>
    mocks.handlers.set(channel, handler)
}))
vi.mock('electron', () => ({
  BrowserWindow: {},
  Menu: { buildFromTemplate: mocks.build },
  shell: { openExternal: mocks.openExternal }
}))
vi.mock('./window-shortcuts', () => ({ applyInterfaceScaleShortcut: mocks.scale }))
import { registerWindowsTitleBarIpc } from './windows-titlebar'

describe('Windows title bar native adapter', () => {
  const makeOwner = (scale = 1.25): { window: BrowserWindow; event: IpcMainInvokeEvent } => {
    const webContents = {
      mainFrame: {},
      getZoomFactor: () => scale,
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const window = {
      webContents,
      isDestroyed: () => false,
      isFullScreen: () => false,
      getContentBounds: () => ({ x: 200, y: 100, width: 1200, height: 900 }),
      setTitleBarOverlay: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn()
    } as unknown as BrowserWindow
    return {
      window,
      event: {
        sender: webContents,
        senderFrame: webContents.mainFrame
      } as unknown as IpcMainInvokeEvent
    }
  }
  const request = (
    menu: WindowsTitleBarMenuRequest['menu'] = 'file'
  ): WindowsTitleBarMenuRequest => ({
    menu,
    x: 100,
    y: 32,
    settingsEnabled: true,
    searchEnabled: true,
    labels: Object.fromEntries(
      WINDOWS_TITLEBAR_LABELS.map((label) => [label, `localized ${label}`])
    ) as WindowsTitleBarMenuRequest['labels']
  })
  const install = (owner = makeOwner(), main = true, platform = 'win32'): typeof owner => {
    registerWindowsTitleBarIpc({
      platform,
      isMainWindow: () => main,
      resolveWindow: () => owner.window
    })
    return owner
  }
  const show = (event: IpcMainInvokeEvent, value: unknown = request()): Promise<unknown> | null =>
    mocks.handlers.get('window:show-titlebar-menu')!(event, value) as Promise<unknown> | null
  const items = (): MenuItemConstructorOptions[] => mocks.build.mock.calls.at(-1)![0]
  const dismiss = (): void => mocks.popup.mock.calls.at(-1)![0].callback()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.build.mockReturnValue({ popup: mocks.popup, closePopup: mocks.closePopup })
    mocks.openExternal.mockResolvedValue(undefined)
  })

  it.each(['darwin', 'linux'])('does not install Windows-only channels on %s', (platform) => {
    install(makeOwner(), true, platform)
    expect(mocks.handlers.size).toBe(0)
  })
  it('anchors a native popup using CSS-to-DIP zoom exactly once and returns a selected app command', async () => {
    const { event, window } = install()
    const selected = show(event)
    expect(mocks.popup).toHaveBeenCalledWith(expect.objectContaining({ window, x: 125, y: 40 }))
    expect(items()[0]).toMatchObject({
      label: 'localized Settings',
      enabled: true,
      registerAccelerator: false
    })
    ;(items()[0].click as () => void)()
    expect(await selected).toBe('settings')
    expect(window.removeListener).toHaveBeenCalledWith('closed', expect.any(Function))
  })
  it.each([
    { origin: { x: 400, y: 200 }, scale: 1 },
    { origin: { x: 800, y: 300 }, scale: 1.25 },
    { origin: { x: -1200, y: -100 }, scale: 0.8 }
  ])(
    'keeps popup coordinates window-relative at $origin and zoom $scale',
    async ({ origin, scale }) => {
      const owner = makeOwner(scale)
      owner.window.getContentBounds = () => ({ ...origin, width: 1200, height: 900 })
      const { event, window } = install(owner)
      const selected = show(event)
      // Electron Menu.popup adds the content origin itself; pass only zoomed renderer coordinates.
      expect(mocks.popup).toHaveBeenCalledWith(
        expect.objectContaining({
          window,
          x: Math.round(100 * scale),
          y: Math.round(32 * scale)
        })
      )
      dismiss()
      await selected
    }
  )
  it('preserves native edit roles and does not register competing accelerators', async () => {
    const { event } = install()
    const selected = show(event, request('edit'))
    expect(
      items()
        .filter((item) => item.type !== 'separator')
        .map((item) => item.role)
    ).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
    dismiss()
    expect(await selected).toBeNull()
  })
  it('uses the existing interface-scale owner and preserves the requesting window', async () => {
    const { event, window } = install()
    const selected = show(event, { ...request('view'), searchEnabled: false })
    expect(items()[0].enabled).toBe(false)
    ;(items()[2].click as () => void)()
    expect(mocks.scale).toHaveBeenCalledWith(window.webContents, 'increase')
    dismiss()
    await selected
  })
  it('retains native close/quit lifecycle roles instead of destroying the window', async () => {
    const { event } = install()
    const selected = show(event, { ...request(), settingsEnabled: false })
    expect(items()[0].enabled).toBe(false)
    expect(
      items()
        .filter((item) => item.role)
        .map((item) => item.role)
    ).toEqual(['close', 'quit'])
    dismiss()
    await selected
  })
  it('updates native controls with validated theme colors and the actual zoom factor', () => {
    const { event, window } = install()
    mocks.handlers.get('window:update-titlebar')!(event, {
      color: '#112233',
      symbolColor: '#abcdef'
    })
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith({
      color: '#112233',
      symbolColor: '#abcdef',
      height: 45
    })
    mocks.handlers.get('window:update-titlebar')!(event, { color: 'red', symbolColor: '#abcdef' })
    expect(window.setTitleBarOverlay).toHaveBeenCalledTimes(1)
  })
  it('rejects untrusted frames, secondary windows, invalid groups, anchors and labels', () => {
    const { event } = install()
    expect(show({ ...event, senderFrame: {} } as IpcMainInvokeEvent)).toBeNull()
    expect(show(event, { ...request(), menu: 'arbitrary' })).toBeNull()
    expect(show(event, { ...request(), x: NaN })).toBeNull()
    expect(show(event, { ...request(), y: 100 })).toBeNull()
    expect(show(event, { ...request(), labels: {} })).toBeNull()
    install(makeOwner(), false)
    expect(show(event)).toBeNull()
    expect(mocks.build).not.toHaveBeenCalled()
  })
  it('deduplicates pending popups and releases them on navigation', async () => {
    const { event, window } = install()
    const selected = show(event)
    expect(show(event)).toBeNull()
    const navigate = vi.mocked(window.webContents.on).mock.calls[0][1] as (details: unknown) => void
    navigate({ isMainFrame: false, isSameDocument: false })
    expect(mocks.closePopup).not.toHaveBeenCalled()
    navigate({ isMainFrame: true, isSameDocument: false })
    expect(mocks.closePopup).toHaveBeenCalledWith(window)
    expect(await selected).toBeNull()
    const second = show(event)
    dismiss()
    await second
  })
  it('releases popup state after a native menu construction error', async () => {
    const { event } = install()
    mocks.build.mockImplementationOnce(() => {
      throw new Error('native popup failed')
    })
    await expect(show(event)).rejects.toThrow('native popup failed')
    const next = show(event)
    dismiss()
    await next
  })
})
