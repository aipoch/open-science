// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUpdateStore } from '@/stores/update-store'
import { GeneralPanel } from './GeneralPanel'

vi.mock('@/assets/logo.png', () => ({ default: 'logo.png' }))

let container: HTMLDivElement
let root: Root
let cliApi: {
  getStatus: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
  uninstall: ReturnType<typeof vi.fn>
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
  ;(window as unknown as { api: unknown }).api = {
    logs: {
      getPath: vi.fn().mockResolvedValue('/logs/main.log'),
      openFile: vi.fn().mockResolvedValue({ opened: true }),
      revealInFolder: vi.fn().mockResolvedValue({ revealed: true })
    },
    cli: cliApi,
    github: { getStars: vi.fn().mockResolvedValue(1) }
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
