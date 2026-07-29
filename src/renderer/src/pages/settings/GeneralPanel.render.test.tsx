// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUpdateStore } from '@/stores/update-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useThemeStore } from '@/stores/theme-store'
import { GeneralPanel } from './GeneralPanel'

vi.mock('@/assets/logo.png', () => ({ default: 'logo.png' }))

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
  setClosePreference: ReturnType<typeof vi.fn>
  setAppIconVariant: ReturnType<typeof vi.fn>
  listAppIcons: ReturnType<typeof vi.fn>
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

beforeEach(() => {
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
    closePreference: undefined,
    appIconVariant: 'light'
  })
  ;(window as unknown as { api: unknown }).api = {
    logs: {
      getPath: vi.fn().mockResolvedValue('/logs/main.log'),
      openFile: vi.fn().mockResolvedValue({ opened: true }),
      revealInFolder: vi.fn().mockResolvedValue({ revealed: true })
    },
    platform: 'win32',
    window: { onCloseConfirmRequest: vi.fn() },
    cli: cliApi,
    github: { getStars: vi.fn().mockResolvedValue(1) },
    settings: settingsApi
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('GeneralPanel command line tool', () => {
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
})
