import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted so the electron mock and the test body share the same shell.openExternal spy.
const { openExternalMock } = vi.hoisted(() => ({ openExternalMock: vi.fn() }))

// Captured window-open handler so tests can drive it directly, mirroring how Electron invokes it on a
// target="_blank" click or window.open() from the main app frame.
type WindowOpenDetails = { url: string; referrer: { url: string } }
let windowOpenHandler: ((details: WindowOpenDetails) => unknown) | undefined

class FakeBrowserWindow {
  webContents = {
    setWindowOpenHandler: (handler: (details: WindowOpenDetails) => unknown): void => {
      windowOpenHandler = handler
    },
    on: vi.fn(),
    getURL: (): string => 'file:///app/index.html'
  }

  on(): this {
    return this
  }

  loadURL(): Promise<void> {
    return Promise.resolve()
  }

  loadFile(): Promise<void> {
    return Promise.resolve()
  }
}

vi.mock('electron', () => ({
  // isPackaged=true skips the dev title-suffix branch, keeping the fake focused on the open handler.
  app: { isPackaged: true },
  BrowserWindow: class {
    constructor() {
      return new FakeBrowserWindow() as unknown as object
    }
  },
  shell: { openExternal: openExternalMock }
}))

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

vi.mock('../../resources/icon.png?asset', () => ({ default: 'icon-path' }))

const { createMainWindow } = await import('./windows')

describe('window navigation policy', () => {
  it('allows only explicit external URL protocols', async () => {
    const policy = await import('./navigation-policy').catch(() => undefined)

    expect(policy).toBeDefined()
    expect(policy?.isAllowedExternalUrl('https://example.com/report')).toBe(true)
    expect(policy?.isAllowedExternalUrl('mailto:researcher@example.com')).toBe(true)
    expect(policy?.isAllowedExternalUrl('file:///Users/example/private.txt')).toBe(false)
    expect(policy?.isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    // External-open is gated on the protocol allowlist alone: the initiating referrer is unreliable
    // (rel="noreferrer" and file:-origin cross-origin suppression both empty it), and window-open can
    // only originate from the trusted main frame anyway (see navigation-policy.ts).
    expect(policy?.isAllowedExternalNavigation('https://example.com/report')).toBe(true)
    expect(policy?.isAllowedExternalNavigation('mailto:researcher@example.com')).toBe(true)
    expect(policy?.isAllowedExternalNavigation('javascript:alert(1)')).toBe(false)
    expect(policy?.isAllowedExternalNavigation('file:///Users/example/private.txt')).toBe(false)
  })

  it('keeps subframe navigation inside the managed preview protocol', async () => {
    const policy = await import('./navigation-policy').catch(() => undefined)

    expect(policy).toBeDefined()
    expect(
      policy?.isAllowedFrameNavigation('open-science-preview://resource/report.html', false)
    ).toBe(true)
    expect(policy?.isAllowedFrameNavigation('https://example.com/exfiltrate', false)).toBe(false)
    expect(
      policy?.isAllowedFrameNavigation(
        'https://app.example.com/workspace',
        true,
        'https://app.example.com/'
      )
    ).toBe(true)
    expect(
      policy?.isAllowedFrameNavigation(
        'https://example.com/exfiltrate',
        true,
        'https://app.example.com/'
      )
    ).toBe(false)
    expect(
      policy?.isAllowedFrameNavigation(
        'file://remote-host/app/index.html',
        true,
        'file:///app/index.html'
      )
    ).toBe(false)
  })
})

describe('window-open external handler', () => {
  beforeEach(() => {
    windowOpenHandler = undefined
    openExternalMock.mockClear()
  })

  // Regression: app links use rel="noreferrer" and the packaged app runs on a file:// origin, so the
  // referrer arrives empty. The handler must still open allowlisted URLs.
  it('opens an allowlisted URL even when the referrer is empty', () => {
    createMainWindow()
    const result = windowOpenHandler!({
      url: 'https://example.com/report',
      referrer: { url: '' }
    })

    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/report')
    expect(result).toEqual({ action: 'deny' })
  })

  it('refuses to open a dangerous protocol', () => {
    createMainWindow()
    windowOpenHandler!({ url: 'javascript:alert(1)', referrer: { url: '' } })

    expect(openExternalMock).not.toHaveBeenCalled()
  })
})
