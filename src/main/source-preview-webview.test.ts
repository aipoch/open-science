import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  installSourcePreviewWebviews,
  getActiveSourceContents,
  isRegisteredSourcePreviewGuest,
  isAllowedSourcePreviewStorageAccess,
  getSourcePreviewSession,
  getSourcePreviewCookies,
  removeSourcePreviewCookies,
  clearSourcePreviewOriginStorage,
  clearSourcePreviewPartitionData
} from './source-preview-webview'

const previewSession = Object.assign(new EventEmitter(), {
  setPermissionRequestHandler: vi.fn<Electron.Session['setPermissionRequestHandler']>(),
  setPermissionCheckHandler: vi.fn<Electron.Session['setPermissionCheckHandler']>(),
  clearCache: vi.fn(async () => undefined),
  clearStorageData: vi.fn(async () => undefined),
  cookies: {
    get: vi.fn(async (): Promise<Electron.Cookie[]> => []),
    remove: vi.fn(async () => undefined)
  }
})
previewSession.setMaxListeners(0)

vi.mock('electron', () => ({
  session: { fromPartition: vi.fn(() => previewSession) },
  webFrameMain: { fromId: vi.fn() }
}))

const setup = (): {
  session: EventEmitter
  host: EventEmitter & {
    session: EventEmitter
    isDestroyed: () => boolean
    send: ReturnType<typeof vi.fn>
    getZoomFactor: () => number
  }
  owner: EventEmitter
  previewSession: EventEmitter
  guest: EventEmitter & {
    id: number
    session: EventEmitter
    isDestroyed: () => boolean
    close: ReturnType<typeof vi.fn>
    setWindowOpenHandler: ReturnType<typeof vi.fn>
  }
  attach: () => boolean
} => {
  const session = new EventEmitter()
  const host = Object.assign(new EventEmitter(), {
    session,
    isDestroyed: () => false,
    send: vi.fn(),
    getZoomFactor: () => 1.25
  })
  const owner = Object.assign(new EventEmitter(), { webContents: host })
  installSourcePreviewWebviews(owner as unknown as Electron.BrowserWindow)
  const guest = Object.assign(new EventEmitter(), {
    id: 12,
    session: previewSession,
    isDestroyed: () => false,
    close: vi.fn(),
    setWindowOpenHandler: vi.fn()
  })
  return {
    session,
    previewSession,
    host,
    owner,
    guest,
    attach: () => host.emit('did-attach-webview', {}, guest)
  }
}
describe('source guest security', () => {
  it.each([
    { src: 'file:///private' },
    { src: 'http://example.com' },
    { src: 'javascript:alert(1)' },
    { src: 'https://user:password@example.com' },
    { partition: 'persist:other' },
    { preload: 'file:///app/preload.js' },
    { webpreferences: 'sandbox=no' },
    { nodeintegration: 'true' },
    { nodeintegrationinsubframes: 'true' },
    { blinkfeatures: 'WebUSB' },
    { allowpopups: 'true' },
    { disablewebsecurity: 'true' },
    { plugins: 'true' }
  ])('rejects unsafe attachment %j', (params) => {
    const { host } = setup()
    const event = { preventDefault: vi.fn() }
    host.emit(
      'will-attach-webview',
      event,
      {},
      {
        src: 'https://example.com/paper',
        partition: 'persist:open-science-source-preview-v1',
        ...params
      }
    )
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
  it('fixes secure preferences and uses the exact dedicated Session', () => {
    const { host, previewSession } = setup()
    const event = { preventDefault: vi.fn() }
    const preferences: Electron.WebPreferences = {
      sandbox: false,
      nodeIntegration: true,
      webSecurity: false
    }
    host.emit('will-attach-webview', event, preferences, {
      src: 'https://example.com/paper',
      partition: 'persist:open-science-source-preview-v1'
    })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(preferences).toMatchObject({
      session: previewSession,
      sandbox: true,
      contextIsolation: true,
      webSecurity: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false
    })
    expect(preferences.preload).toBeUndefined()
  })
  it('rejects every partition except the exact shared source preview partition', () => {
    const { host } = setup()
    for (const partition of [
      undefined,
      'persist:untrusted',
      'persist:open-science-source-preview-v2'
    ]) {
      const event = { preventDefault: vi.fn() }
      host.emit(
        'will-attach-webview',
        event,
        {},
        { src: 'https://example.com/paper', ...(partition ? { partition } : {}) }
      )
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
  })
  it('rejects an inherited preload and mismatched session before granting guest behavior', () => {
    const s = setup()
    const event = { preventDefault: vi.fn() }
    s.host.emit(
      'will-attach-webview',
      event,
      { preload: '/app/preload.js' },
      { src: 'https://example.com' }
    )
    expect(event.preventDefault).toHaveBeenCalledOnce()
    s.guest.session = new EventEmitter()
    s.attach()
    expect(s.guest.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    expect(s.guest.setWindowOpenHandler).not.toHaveBeenCalled()
  })
  it('blocks unsafe top-level URLs and redirects while admitting HTTPS descendants', () => {
    const s = setup()
    s.attach()
    for (const url of ['file:///private', 'http://example.com', 'open-science-preview://private']) {
      const event = { preventDefault: vi.fn(), isMainFrame: true, url }
      s.guest.emit('did-start-navigation', { ...event, isSameDocument: false })
      s.guest.emit('will-frame-navigate', event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
      event.preventDefault.mockClear()
      s.guest.emit('will-redirect', event, url, false, true)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    for (const url of ['https://example.com', 'about:srcdoc', 'blob:https://example.com/id']) {
      const event = { preventDefault: vi.fn(), isMainFrame: false, url }
      s.guest.emit('will-frame-navigate', event)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    expect(s.guest.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    expect(s.host.send).toHaveBeenCalledWith('source-preview:navigation-blocked', {
      guestId: 12,
      url: 'http://example.com',
      navigationId: 2
    })
  })
  it('assigns a new navigation id to each consecutive top-level navigation', () => {
    const s = setup()
    s.attach()
    s.guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    s.guest.emit('will-frame-navigate', {
      preventDefault: vi.fn(),
      isMainFrame: true,
      url: 'http://one.example'
    })
    s.guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    s.guest.emit('will-frame-navigate', {
      preventDefault: vi.fn(),
      isMainFrame: true,
      url: 'http://two.example'
    })
    expect(s.host.send).toHaveBeenNthCalledWith(1, 'source-preview:navigation-blocked', {
      guestId: 12,
      url: 'http://one.example',
      navigationId: 1
    })
    expect(s.host.send).toHaveBeenNthCalledWith(2, 'source-preview:navigation-blocked', {
      guestId: 12,
      url: 'http://two.example',
      navigationId: 2
    })
  })
  it('counts reloads before reporting a blocked redirect without will-frame-navigate', () => {
    const s = setup()
    s.attach()
    // Initial load and reload both emit did-start-navigation, but reload skips will-frame-navigate.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      s.guest.emit('did-start-navigation', {
        isMainFrame: true,
        isSameDocument: false,
        url: 'https://example.com/paper'
      })
    }
    s.guest.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    s.guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    const event = { preventDefault: vi.fn() }
    s.guest.emit('will-redirect', event, 'http://blocked.example', false, true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(s.host.send).toHaveBeenCalledWith('source-preview:navigation-blocked', {
      guestId: 12,
      url: 'http://blocked.example',
      navigationId: 3
    })
    s.guest.emit('destroyed')
    expect(s.guest.listenerCount('did-start-navigation')).toBe(0)
  })
  it('registers only live HTTPS guests for storage access and removes them on destroy', () => {
    const s = setup()
    const guest = s.guest as unknown as Electron.WebContents
    const session = s.previewSession as unknown as Electron.Session
    expect(isRegisteredSourcePreviewGuest(guest, session)).toBe(false)
    s.attach()
    expect(isRegisteredSourcePreviewGuest(guest, session)).toBe(true)
    expect(
      isRegisteredSourcePreviewGuest(guest, new EventEmitter() as unknown as Electron.Session)
    ).toBe(false)
    s.guest.emit('destroyed')
    expect(isRegisteredSourcePreviewGuest(guest, session)).toBe(false)
  })
  it('allows storage access only for HTTPS non-main frames of a live source guest', () => {
    const s = setup()
    const guest = s.guest as unknown as Electron.WebContents
    const session = s.previewSession as unknown as Electron.Session
    s.attach()
    expect(
      isAllowedSourcePreviewStorageAccess(guest, session, {
        isMainFrame: false,
        requestingUrl: 'https://third-party.example/frame'
      })
    ).toBe(true)
    expect(
      isAllowedSourcePreviewStorageAccess(guest, session, {
        isMainFrame: true,
        requestingUrl: 'https://third-party.example/frame'
      })
    ).toBe(false)
    expect(
      isAllowedSourcePreviewStorageAccess(guest, session, {
        isMainFrame: false,
        requestingUrl: 'http://third-party.example/frame'
      })
    ).toBe(false)
    expect(
      isAllowedSourcePreviewStorageAccess(
        guest,
        session,
        {
          isMainFrame: false,
          requestingUrl: 'https://third-party.example/frame'
        },
        'top-level-storage-access'
      )
    ).toBe(false)
  })
  it('checks cross-origin storage by origin when Electron omits requestingUrl', () => {
    const s = setup()
    s.attach()
    const guest = s.guest as unknown as Electron.WebContents
    const session = s.previewSession as unknown as Electron.Session
    const check = (origin: string, requestingUrl?: string): boolean =>
      isAllowedSourcePreviewStorageAccess(
        guest,
        session,
        { isMainFrame: false, requestingUrl },
        'storage-access',
        origin
      )
    expect(check('https://third-party.example')).toBe(true)
    expect(check('http://third-party.example')).toBe(false)
    expect(check('https://third-party.example', 'http://third-party.example/frame')).toBe(false)
    s.guest.emit('destroyed')
    expect(check('https://third-party.example')).toBe(false)
  })
  it('blocks only registered guest downloads and unregisters when the guest dies', () => {
    const s = setup()
    s.attach()
    const event = { preventDefault: vi.fn() }
    s.previewSession.emit('will-download', event, {}, {})
    expect(event.preventDefault).not.toHaveBeenCalled()
    s.previewSession.emit('will-download', event, {}, s.guest)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    s.guest.emit('destroyed')
    event.preventDefault.mockClear()
    s.previewSession.emit('will-download', event, {}, s.guest)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })
  it('routes focused page find and shortcuts without intercepting composition', () => {
    const s = setup()
    s.attach()
    s.guest.emit('focus')
    expect(getActiveSourceContents(s.host)).toBe(s.guest)
    const forward = vi.fn()
    s.host.on('before-input-event', forward)
    s.guest.emit('before-input-event', {}, { key: 'f', control: true, isComposing: true })
    expect(forward).not.toHaveBeenCalled()
    s.guest.emit('before-input-event', {}, { key: 'f', control: true })
    expect(forward).toHaveBeenCalledOnce()
    s.host.emit('focus')
    expect(getActiveSourceContents(s.host)).toBeUndefined()
    s.guest.emit('focus')
    s.guest.emit('destroyed')
    expect(getActiveSourceContents(s.host)).toBeUndefined()
  })
  it('keeps the original context-menu frame and rejects editable or stale requests', async () => {
    const s = setup()
    s.attach()
    const frame = {
      url: 'https://example.com',
      detached: false,
      isDestroyed: () => false,
      executeJavaScript: vi.fn().mockResolvedValue(false)
    }
    const params = { frame, isEditable: false, formControlType: 'none', x: 125, y: 250 }
    s.guest.emit('context-menu', {}, params)
    await Promise.resolve()
    expect(s.host.send).toHaveBeenCalledWith('source-preview:context-menu', {
      guestId: 12,
      x: 100,
      y: 200
    })
    s.host.send.mockClear()
    s.guest.emit('context-menu', {}, { ...params, isEditable: true })
    s.guest.emit('context-menu', {}, params)
    frame.url = 'https://different.example'
    await Promise.resolve()
    expect(s.host.send).not.toHaveBeenCalled()
  })
  it('does not replace a page menu when the target snapshot is absent or requests passthrough', async () => {
    const s = setup()
    s.attach()
    for (const value of [null, undefined, true]) {
      const frame = {
        url: 'https://nested.example',
        detached: false,
        isDestroyed: () => false,
        executeJavaScript: vi.fn().mockResolvedValue(value)
      }
      s.guest.emit(
        'context-menu',
        {},
        { frame, isEditable: false, formControlType: 'none', x: 10, y: 10 }
      )
      await Promise.resolve()
    }
    expect(s.host.send).not.toHaveBeenCalled()
  })
  it('rejects an old menu reply when a newer request has already arrived', async () => {
    const s = setup()
    s.attach()
    let settle!: (value: boolean) => void
    const frame = {
      url: 'https://nested.example',
      detached: false,
      isDestroyed: () => false,
      executeJavaScript: vi
        .fn()
        .mockReturnValueOnce(
          new Promise<boolean>((resolve) => {
            settle = resolve
          })
        )
        .mockResolvedValue(true)
    }
    const params = { frame, isEditable: false, formControlType: 'none', x: 10, y: 10 }
    s.guest.emit('context-menu', {}, params)
    s.guest.emit('context-menu', {}, params)
    settle(false)
    await Promise.resolve()
    expect(s.host.send).not.toHaveBeenCalled()
  })
  it('cleans listeners without accessing destroyed host properties', () => {
    const s = setup()
    s.attach()
    Object.defineProperty(s.host, 'session', {
      get: () => {
        throw new Error('destroyed')
      }
    })
    s.owner.emit('closed')
    // The dedicated Session is process-scoped and remains configured for future windows.
    expect(s.previewSession.listenerCount('will-download')).toBe(1)
    expect(s.guest.listenerCount('before-input-event')).toBe(0)
  })
})

describe('source partition management', () => {
  it('shares one dedicated session and installs policies once across host windows', () => {
    const a = setup()
    const b = setup()
    expect(getSourcePreviewSession()).toBe(previewSession)
    expect(getSourcePreviewSession()).not.toBe(a.host.session)
    a.attach()
    b.attach()
    const check = previewSession.setPermissionCheckHandler.mock.calls[0][0]!
    const request = previewSession.setPermissionRequestHandler.mock.calls[0][0]!
    const details = { isMainFrame: false, requestingUrl: 'https://third-party.example/frame' }
    const guest = a.guest as unknown as Electron.WebContents
    expect(check(guest, 'storage-access', 'https://third-party.example', details)).toBe(true)
    expect(check(guest, 'geolocation', 'https://third-party.example', details)).toBe(false)
    expect(
      check(
        a.host as unknown as Electron.WebContents,
        'storage-access',
        'https://third-party.example',
        details
      )
    ).toBe(false)
    const callback = vi.fn()
    request(guest, 'storage-access', callback, details)
    expect(callback).toHaveBeenCalledWith(true)
    a.owner.emit('closed')
    expect(check(guest, 'storage-access', 'https://third-party.example', details)).toBe(false)
    expect(
      check(
        b.guest as unknown as Electron.WebContents,
        'storage-access',
        'https://third-party.example',
        details
      )
    ).toBe(true)
    expect(previewSession.setPermissionCheckHandler).toHaveBeenCalledOnce()
    expect(previewSession.listenerCount('will-download')).toBe(1)
    b.owner.emit('closed')
  })
  it('queries and removes only the exact normalized Cookie domain through Electron', async () => {
    const host = setup()
    const hostCookieRemove = vi.fn()
    Object.assign(host.session, { cookies: { remove: hostCookieRemove } })
    const cookie = {
      name: 'login',
      value: 'secret',
      domain: '.example.com',
      path: '/account',
      secure: true,
      httpOnly: true,
      session: false
    } as Electron.Cookie
    previewSession.cookies.get.mockResolvedValue([
      cookie,
      { ...cookie, domain: 'child.example.com' }
    ])
    expect(await getSourcePreviewCookies('.EXAMPLE.COM')).toEqual([cookie])
    await removeSourcePreviewCookies('example.com')
    expect(previewSession.cookies.remove).toHaveBeenCalledWith(
      'https://example.com/account',
      'login'
    )
    expect(previewSession.cookies.remove).toHaveBeenCalledTimes(1)
    expect(hostCookieRemove).not.toHaveBeenCalled()
    for (const invalid of ['', '*', 'https://example.com', 'example.com:443', 'example.com/path']) {
      await expect(removeSourcePreviewCookies(invalid)).rejects.toThrow()
    }
    host.owner.emit('closed')
  })
  it('scopes origin cleanup and keeps Cookie and HTTP-cache cleanup explicit', async () => {
    await clearSourcePreviewOriginStorage('https://example.com')
    expect(previewSession.clearStorageData).toHaveBeenCalledWith({
      origin: 'https://example.com',
      storages: ['filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'cachestorage']
    })
    for (const origin of ['', 'https://example.com/path', 'http://example.com'])
      await expect(clearSourcePreviewOriginStorage(origin)).rejects.toThrow()
    await clearSourcePreviewPartitionData()
    expect(previewSession.clearCache).toHaveBeenCalledOnce()
    expect(previewSession.clearStorageData).toHaveBeenLastCalledWith({ storages: ['cookies'] })
  })
})
