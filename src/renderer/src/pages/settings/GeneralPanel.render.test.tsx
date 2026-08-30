// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUpdateStore } from '@/stores/update-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useThemeStore } from '@/stores/theme-store'
import { i18next } from '@/i18n'
import { GeneralPanel } from './GeneralPanel'

vi.mock('@/assets/logo.png', () => ({ default: 'logo.png' }))
vi.mock('@/assets/logo-dark.png', () => ({ default: 'logo-dark.png' }))

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}

let container: HTMLDivElement
let root: Root
let cliApi: {
  getStatus: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
  uninstall: ReturnType<typeof vi.fn>
}
let settingsApi: {
  setNotificationsEnabled: ReturnType<typeof vi.fn>
  setShowNotificationContent: ReturnType<typeof vi.fn>
  setClosePreference: ReturnType<typeof vi.fn>
  setAppIconVariant: ReturnType<typeof vi.fn>
  listAppIcons: ReturnType<typeof vi.fn>
}
let notificationsApi: {
  getDesktopAvailability: ReturnType<typeof vi.fn>
  sendTest: ReturnType<typeof vi.fn>
}

const findButton = (pattern: RegExp): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((element) =>
    pattern.test(element.textContent ?? '')
  ) as HTMLButtonElement | undefined

// Renders and lets the getStatus effect (and any click handler promise) settle.
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const switchTo = (language: string): void => {
  act(() => {
    void i18next.changeLanguage(language)
  })
}

beforeEach(() => {
  switchTo('en')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useUpdateStore.setState({
    appInfo: { name: 'Open Science', version: '0.4.0', copyright: '© 2026 AIPOCH' },
    status: { state: 'up-to-date', current: '0.4.0', latest: '0.4.0' }
  })
  cliApi = {
    getStatus: vi.fn().mockResolvedValue({
      installed: false,
      target: '/home/u/.local/bin/open-science',
      onPath: true
    }),
    install: vi.fn().mockResolvedValue({
      installed: true,
      target: '/home/u/.local/bin/open-science',
      onPath: false,
      pathHint: 'Add /home/u/.local/bin to your PATH to use "open-science".'
    }),
    uninstall: vi.fn().mockResolvedValue({
      installed: false,
      target: '/home/u/.local/bin/open-science',
      onPath: true
    })
  }
  settingsApi = {
    setNotificationsEnabled: vi
      .fn()
      .mockImplementation((request: { enabled: boolean }) =>
        Promise.resolve({ notificationsEnabled: request.enabled })
      ),
    setShowNotificationContent: vi
      .fn()
      .mockImplementation((request: { enabled: boolean }) =>
        Promise.resolve({ showNotificationContent: request.enabled })
      ),
    setClosePreference: vi
      .fn()
      .mockImplementation((request: { preference?: 'minimize' | 'quit' }) =>
        Promise.resolve({ closePreference: request.preference })
      ),
    setAppIconVariant: vi
      .fn()
      .mockImplementation((request: { variant: 'light' | 'dark' }) =>
        Promise.resolve({ appIconVariant: request.variant })
      ),
    listAppIcons: vi.fn().mockResolvedValue([
      {
        id: 'light',
        label: 'Light',
        description: 'Light',
        previewDataUrl: 'data:image/png;base64,L'
      },
      { id: 'dark', label: 'Dark', description: 'Dark', previewDataUrl: 'data:image/png;base64,D' }
    ])
  }
  useSettingsStore.setState({
    notificationsEnabled: true,
    showNotificationContent: false,
    closePreference: undefined,
    appIconVariant: 'light'
  })
  notificationsApi = {
    getDesktopAvailability: vi.fn().mockResolvedValue('supported'),
    sendTest: vi.fn().mockResolvedValue('shown')
  }
  ;(window as unknown as { api: unknown }).api = {
    logs: {
      getStatus: vi.fn().mockResolvedValue({
        configured: true,
        path: '/logs/main.log',
        existing: true,
        lastWriteSucceeded: true,
        lastFailureCategory: null
      }),
      openFile: vi.fn().mockResolvedValue({ opened: true }),
      revealInFolder: vi.fn().mockResolvedValue({ revealed: true })
    },
    platform: 'win32',
    window: { onCloseConfirmRequest: vi.fn() },
    cli: cliApi,
    github: { getStars: vi.fn().mockResolvedValue(1) },
    notifications: notificationsApi,
    settings: settingsApi
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  switchTo('en')
  vi.restoreAllMocks()
})

describe('GeneralPanel command line tool', () => {
  it('recovers when the initial command status check fails', async () => {
    cliApi.getStatus
      .mockRejectedValueOnce(new Error('command status unavailable'))
      .mockResolvedValueOnce({
        installed: false,
        target: '/home/u/.local/bin/open-science',
        onPath: true
      })

    await act(async () => {
      root.render(<GeneralPanel />)
    })
    await flush()

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not check the command-line tool.'
    )
    const retryButton = findButton(/check again/i)
    expect(retryButton).toBeDefined()
    expect(findButton(/install command/i)?.disabled).toBe(true)

    await act(async () => {
      retryButton?.click()
    })
    await flush()

    expect(cliApi.getStatus).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(findButton(/install command/i)?.disabled).toBe(false)
  })

  it('installs the command and surfaces the returned path + PATH hint', async () => {
    await act(async () => {
      root.render(<GeneralPanel />)
    })
    await flush()

    const installButton = findButton(/install command/i)
    expect(installButton).toBeDefined()

    await act(async () => {
      installButton?.click()
    })
    await flush()

    expect(cliApi.install).toHaveBeenCalledTimes(1)
    // The status pane now shows the installed path and the manual PATH hint from the result.
    expect(container.textContent).toContain('/home/u/.local/bin/open-science')
    expect(container.textContent).toContain('Add /home/u/.local/bin to your PATH')
    // The button flips to the uninstall affordance once installed.
    expect(findButton(/uninstall command/i)).toBeDefined()
  })

  it('shows Uninstall when already installed and calls uninstall on click', async () => {
    cliApi.getStatus.mockResolvedValue({
      installed: true,
      target: '/home/u/.local/bin/open-science',
      onPath: true
    })

    await act(async () => {
      root.render(<GeneralPanel />)
    })
    await flush()

    const uninstallButton = findButton(/uninstall command/i)
    expect(uninstallButton).toBeDefined()

    await act(async () => {
      uninstallButton?.click()
    })
    await flush()

    expect(cliApi.uninstall).toHaveBeenCalledTimes(1)
    expect(findButton(/install command/i)).toBeDefined()
  })

  it('localizes a CLI failure and keeps the backend message in collapsed details', async () => {
    cliApi.install.mockRejectedValue(
      new Error('spawn /private/bin/open-science failed with EACCES')
    )

    await act(async () => root.render(<GeneralPanel />))
    await flush()
    await act(async () => findButton(/install command/i)?.click())
    await flush()
    switchTo('zh-Hans')

    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('无法更新命令行工具。')
    expect(alert?.textContent).not.toContain('/private/bin/open-science')
    const details = container.querySelector('details')
    expect(details?.open).toBe(false)
    expect(details?.textContent).toContain('/private/bin/open-science')
  })
})

describe('GeneralPanel About', () => {
  it('keeps app identity and resources at the top of General settings', async () => {
    await act(async () => {
      root.render(<GeneralPanel />)
    })
    await flush()

    const sections = Array.from(container.querySelectorAll('[data-slot="settings-section"]'))
    expect(sections.at(0)?.querySelector('h3')?.textContent).toBe('About')
  })
})

describe('GeneralPanel notifications', () => {
  it('toggles task notifications off via the settings API', async () => {
    await act(async () => {
      root.render(<GeneralPanel />)
    })
    await flush()

    const toggle = container.querySelector(
      '[aria-label="Toggle task notifications"]'
    ) as HTMLButtonElement | null
    expect(toggle).not.toBeNull()
    // The store default (and the mocked preference) starts enabled.
    expect(toggle?.getAttribute('data-state')).toBe('checked')

    await act(async () => {
      toggle?.click()
    })
    await flush()

    expect(settingsApi.setNotificationsEnabled).toHaveBeenCalledWith({ enabled: false })
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false)
  })

  it('keeps task content private by default and can verify native delivery', async () => {
    await act(async () => {
      root.render(<GeneralPanel />)
    })
    await flush()

    const contentToggle = container.querySelector(
      '[aria-label="Toggle task content in system notifications"]'
    ) as HTMLButtonElement | null
    expect(contentToggle?.getAttribute('data-state')).toBe('unchecked')

    await act(async () => {
      contentToggle?.click()
    })
    await flush()
    expect(settingsApi.setShowNotificationContent).toHaveBeenCalledWith({ enabled: true })

    await act(async () => {
      findButton(/Send test notification/)?.click()
    })
    await flush()

    expect(notificationsApi.sendTest).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Test notification shown.')
  })
})

describe('GeneralPanel appearance', () => {
  it('sets the theme preference from the segmented control and reflects it on <html>', async () => {
    useThemeStore.getState().setPreference('light')
    document.documentElement.classList.remove('dark')

    await act(async () => {
      root.render(<GeneralPanel />)
    })
    await flush()

    const group = container.querySelector('[role="radiogroup"][aria-label="Theme"]')
    expect(group).not.toBeNull()

    const darkRadio = group?.querySelector(
      '[role="radio"][aria-label="Dark"]'
    ) as HTMLButtonElement | null
    expect(darkRadio).not.toBeNull()
    expect(darkRadio?.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      darkRadio?.click()
    })
    await flush()

    expect(useThemeStore.getState().preference).toBe('dark')
    expect(useThemeStore.getState().resolvedTheme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    const systemRadio = group?.querySelector(
      '[role="radio"][aria-label="System"]'
    ) as HTMLButtonElement | null
    await act(async () => {
      systemRadio?.click()
    })
    await flush()

    expect(useThemeStore.getState().preference).toBe('system')
  })

  it('binds macOS Dock appearance to Theme and hides the competing icon picker', async () => {
    window.api.platform = 'darwin'

    await act(async () => {
      root.render(<GeneralPanel />)
    })
    await flush()

    expect(container.textContent).toContain('The Dock icon follows the resolved theme.')
    expect(document.body.querySelector('[role="radiogroup"][aria-label="App icon"]')).toBeNull()
    expect(settingsApi.listAppIcons).not.toHaveBeenCalled()
  })
})

describe('GeneralPanel close behavior', () => {
  it('changes the Windows titlebar-close preference', async () => {
    await act(async () => {
      root.render(<GeneralPanel />)
    })
    await flush()

    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="When closing the window"]'
    )
    expect(trigger?.textContent).toContain('Ask every time')

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const quit = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (option) => option.textContent?.includes('Quit')
    )
    await act(async () => {
      quit?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      quit?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(settingsApi.setClosePreference).toHaveBeenCalledWith({ preference: 'quit' })
    expect(useSettingsStore.getState().closePreference).toBe('quit')
  })
})

describe('GeneralPanel diagnostics', () => {
  it('shows a recent write failure without hiding an existing log file', async () => {
    const getStatus = (
      window as unknown as { api: { logs: { getStatus: ReturnType<typeof vi.fn> } } }
    ).api.logs.getStatus
    getStatus.mockResolvedValueOnce({
      configured: true,
      path: '/logs/main.log',
      existing: true,
      lastWriteSucceeded: false,
      lastFailureCategory: 'append'
    })

    await act(async () => root.render(<GeneralPanel />))
    await flush()

    expect(container.textContent).toContain(
      'The app could not write to the log file during its most recent attempt.'
    )
    expect(findButton(/^open$/i)?.disabled).toBe(false)
    expect(findButton(/^reveal$/i)?.disabled).toBe(false)
  })
})

describe('GeneralPanel app icon', () => {
  it('renders a preview tile per variant and switches the icon on click', async () => {
    await act(async () => {
      root.render(<GeneralPanel />)
    })
    await flush()

    expect(settingsApi.listAppIcons).toHaveBeenCalledTimes(1)

    const group = document.body.querySelector<HTMLElement>(
      '[role="radiogroup"][aria-label="App icon"]'
    )
    expect(group).toBeDefined()
    const tiles = Array.from(group?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])
    expect(tiles).toHaveLength(2)

    // Light is the selected default; Dark is not.
    const light = tiles.find((tile) => tile.getAttribute('aria-label') === 'Light')
    const dark = tiles.find((tile) => tile.getAttribute('aria-label') === 'Dark')
    expect(light?.getAttribute('aria-checked')).toBe('true')
    expect(dark?.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      dark?.click()
    })
    await flush()

    expect(settingsApi.setAppIconVariant).toHaveBeenCalledWith({ variant: 'dark' })
    expect(useSettingsStore.getState().appIconVariant).toBe('dark')
  })

  it('uses one App icon Tab stop and selects with ArrowRight', async () => {
    await act(async () => {
      root.render(<GeneralPanel />)
    })
    await flush()

    const tiles = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>(
        '[role="radiogroup"][aria-label="App icon"] [role="radio"]'
      )
    )
    const group = document.body.querySelector<HTMLElement>(
      '[role="radiogroup"][aria-label="App icon"]'
    )
    expect(group?.tabIndex).toBe(0)
    expect(tiles.map((tile) => tile.tabIndex)).toEqual([-1, -1])

    await act(async () => {
      group?.focus()
    })
    expect(document.activeElement).toBe(tiles[0])
    expect(tiles.map((tile) => tile.tabIndex)).toEqual([0, -1])

    await act(async () => {
      tiles[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      )
    })
    await flush()

    expect(settingsApi.setAppIconVariant).toHaveBeenCalledWith({ variant: 'dark' })
    expect(document.activeElement).toBe(tiles[1])
  })
})
