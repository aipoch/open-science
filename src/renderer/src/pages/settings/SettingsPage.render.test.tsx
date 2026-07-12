// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsPage } from './SettingsPage'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

// Minimal window.api surface the settings store touches when the dialog opens. Attached onto the
// real jsdom window so DOM globals radix relies on (getComputedStyle, etc.) stay intact.
const installApi = (): void => {
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getSettings: vi.fn().mockResolvedValue({ claude: {}, providers: [] }),
      getPreflight: vi.fn().mockResolvedValue({ claudeReady: true, activeProviderReady: true }),
      isEncryptionAvailable: vi.fn().mockResolvedValue(true),
      isNpmAvailable: vi.fn().mockResolvedValue(true)
    },
    acp: {
      getState: vi.fn().mockResolvedValue({ promptInFlightSessionIds: [] }),
      cancel: vi.fn()
    },
    logs: {
      getPath: vi.fn().mockResolvedValue('/Users/x/Library/Logs/Open Science/main.log'),
      openFile: vi.fn().mockResolvedValue({ opened: true })
    }
  }
}

beforeEach(() => {
  installApi()
  useSettingsStore.setState(createInitialSettingsState())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('SettingsPage layout', () => {
  it('mounts the sidebar + content with Model and General nav items and a close control', () => {
    act(() => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    // Dialog content is portaled to the document body.
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()

    // Left navigation labelled "Settings" with two nav items: Model (active) and General.
    const nav = document.body.querySelector('nav[aria-label="Settings"]')
    expect(nav).not.toBeNull()
    const navItems = nav?.querySelectorAll('li') ?? []
    expect(navItems).toHaveLength(2)
    expect(navItems[0]?.textContent).toContain('Model')
    expect(navItems[1]?.textContent).toContain('General')
    // Model is the default active panel.
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toContain('Model')

    // The header shows the panel title and a close control.
    expect(document.body.querySelector('[aria-label="Close settings"]')).not.toBeNull()

    // The Model panel content is present (Claude + Providers sections).
    expect(document.body.textContent).toContain('Claude')
    expect(document.body.textContent).toContain('Providers')
  })

  it('opens Add provider as a sub-page with a back control, and returns on back', () => {
    act(() => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const clickByText = (text: string): void => {
      const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (candidate) => candidate.textContent?.trim() === text
      )
      act(() => button?.click())
    }

    clickByText('Add provider')

    // The sub-page shows a back control and the provider-type dropdown, hiding the Claude section.
    expect(document.body.querySelector('[aria-label="Back to providers"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Provider type"]')).not.toBeNull()
    expect(document.body.querySelector('section[aria-label="Claude"]')).toBeNull()

    // Going back restores the provider list view.
    const back = document.body.querySelector<HTMLButtonElement>('[aria-label="Back to providers"]')
    act(() => back?.click())
    expect(document.body.querySelector('section[aria-label="Providers"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Provider type"]')).toBeNull()
  })

  it('switches to the General panel and shows the diagnostic log file', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const generalTab = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /general/i.test(button.textContent ?? '')) as HTMLButtonElement | undefined
    expect(generalTab).not.toBeUndefined()

    await act(async () => {
      generalTab?.click()
    })

    // The General panel surfaces the log file path and an open control.
    expect(document.body.textContent).toContain('main.log')
    const openButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      /open log file/i.test(button.textContent ?? '')
    )
    expect(openButton).not.toBeUndefined()

    await act(async () => {
      openButton?.click()
    })

    expect(
      (window as unknown as { api: { logs: { openFile: ReturnType<typeof vi.fn> } } }).api.logs
        .openFile
    ).toHaveBeenCalledTimes(1)
  })

  it('does not render when closed', () => {
    act(() => {
      root.render(<SettingsPage open={false} onClose={vi.fn()} />)
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })
})
