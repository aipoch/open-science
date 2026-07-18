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
      getSettings: vi.fn().mockResolvedValue({
        claude: {},
        opencode: {},
        providers: [],
        agentFrameworkId: 'claude-code',
        agentFrameworks: [{ id: 'claude-code', displayName: 'Claude Code', supportsSkills: true }]
      }),
      detectOpencode: vi.fn().mockResolvedValue({
        claude: {},
        opencode: {},
        providers: [],
        agentFrameworkId: 'claude-code',
        agentFrameworks: [{ id: 'claude-code', displayName: 'Claude Code', supportsSkills: true }]
      }),
      getPreflight: vi.fn().mockResolvedValue({ claudeReady: true, activeProviderReady: true }),
      isEncryptionAvailable: vi.fn().mockResolvedValue(true),
      isNpmAvailable: vi.fn().mockResolvedValue(true),
      listSkills: vi.fn().mockResolvedValue([
        {
          id: 'alpha',
          name: 'Alpha',
          description: 'First',
          source: 'featured',
          updatedAt: '2026-07-08T00:00:00.000Z',
          enabled: true
        }
      ]),
      getSkillDetail: vi.fn().mockResolvedValue({
        id: 'alpha',
        name: 'Alpha',
        description: 'First',
        source: 'featured',
        updatedAt: '2026-07-08T00:00:00.000Z',
        enabled: true,
        author: 'Test Author',
        license: 'Test License',
        body: '# Alpha body'
      }),
      listConnectors: vi.fn().mockResolvedValue({
        connectors: [
          {
            id: 'chemistry',
            displayName: 'Chemistry',
            description: 'Small-molecule chemistry via PubChem.',
            sources: ['PubChem'],
            requiresNcbi: false,
            enabled: true,
            autoAllow: false
          }
        ],
        customServers: [],
        ncbi: { hasApiKey: false }
      })
    },
    acp: {
      getState: vi.fn().mockResolvedValue({ promptInFlightSessionIds: [] }),
      cancel: vi.fn()
    },
    logs: {
      getPath: vi.fn().mockResolvedValue('/Users/x/Library/Logs/Open Science/main.log'),
      openFile: vi.fn().mockResolvedValue({ opened: true }),
      revealInFolder: vi.fn().mockResolvedValue({ revealed: true })
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
  it('mounts the sidebar + content with grouped nav items and a close control', () => {
    useSettingsStore.setState({
      providers: [
        {
          id: 'p1',
          type: 'custom',
          name: 'Gateway',
          baseUrl: 'https://gateway.test/v1',
          model: 'test-model',
          models: ['test-model'],
          maskedKey: 'sk-a…wxyz',
          hasKey: true,
          needsKey: false,
          lastValidatedAt: 1
        }
      ],
      activeProviderId: 'p1',
      activeModel: 'test-model'
    })

    act(() => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    // Dialog content is portaled to the document body.
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('data-slot')).toBe('settings-surface')
    expect(dialog?.className).toContain('overscroll-contain')

    // Left navigation grouped as Capabilities (Skills) and Workspace (Model, Storage, General).
    const nav = document.body.querySelector('nav[aria-label="Settings"]')
    expect(nav).not.toBeNull()
    expect(nav?.className).toContain('bg-background')
    expect(nav?.nextElementSibling?.className).toContain('bg-card')
    expect(nav?.textContent).toContain('Capabilities')
    expect(nav?.textContent).toContain('Workspace')
    const navItems = nav?.querySelectorAll('li') ?? []
    expect(navItems).toHaveLength(5)
    expect(navItems[0]?.textContent).toContain('Skills')
    expect(navItems[1]?.textContent).toContain('Connectors')
    expect(navItems[2]?.textContent).toContain('Model')
    expect(navItems[3]?.textContent).toContain('Storage')
    expect(navItems[4]?.textContent).toContain('General')
    // Model is the default active panel.
    expect(nav?.querySelector('[aria-current="page"]')?.textContent).toContain('Model')

    // The header shows the panel title and a close control.
    expect(document.body.querySelector('[aria-label="Close settings"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Back"]')?.getAttribute('data-slot')).toBe(
      'button'
    )
    expect(document.body.querySelector('[aria-label="Maximize"]')?.getAttribute('data-slot')).toBe(
      'button'
    )

    // The Model panel content is present (Claude + Providers sections).
    expect(document.body.textContent).toContain('Claude')
    expect(document.body.textContent).toContain('Providers')
    expect(document.body.textContent).toContain('Agent framework')
    // Agent framework + Claude + OpenCode (both runtimes always shown) + Providers.
    expect(document.body.querySelectorAll('[data-slot="settings-section"]')).toHaveLength(4)
    expect(document.body.querySelector('[data-slot="settings-row"]')).not.toBeNull()
  })

  it('opens Add provider as a history-driven sub-page and returns via the back arrow', () => {
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

    // The sub-page shows a "Model › Add provider" breadcrumb and the provider-type dropdown, hiding
    // the Claude section. There is no standalone in-content back arrow.
    const crumb = document.body.querySelector<HTMLButtonElement>('[aria-label="Back to model"]')
    expect(crumb).not.toBeNull()
    expect(document.body.textContent).toContain('Add provider')
    expect(document.body.querySelector('[aria-label="Back to providers"]')).toBeNull()
    expect(document.body.querySelector('[aria-label="Provider type"]')).not.toBeNull()
    expect(document.body.querySelector('section[aria-label="Claude"]')).toBeNull()

    // The shared top back arrow exits the form back to the provider list.
    const back = document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')
    act(() => back?.click())
    expect(document.body.querySelector('section[aria-label="Providers"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Provider type"]')).toBeNull()

    // Forward re-enters the form as a history location.
    const forward = document.body.querySelector<HTMLButtonElement>('[aria-label="Forward"]')
    act(() => forward?.click())
    expect(document.body.querySelector('[aria-label="Provider type"]')).not.toBeNull()

    // The breadcrumb root crumb returns to the provider list too.
    const rootCrumb = document.body.querySelector<HTMLButtonElement>('[aria-label="Back to model"]')
    act(() => rootCrumb?.click())
    expect(document.body.querySelector('section[aria-label="Providers"]')).not.toBeNull()
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

    expect(document.body.querySelectorAll('[data-slot="settings-section"]')).toHaveLength(3)
    expect(document.body.querySelector('[data-slot="settings-row"]')).not.toBeNull()

    // The Diagnostics panel surfaces the log file path plus Open and Reveal controls.
    expect(document.body.textContent).toContain('main.log')
    const buttons = Array.from(document.body.querySelectorAll('button'))
    const openButton = buttons.find((button) => /^open$/i.test((button.textContent ?? '').trim()))
    const revealButton = buttons.find((button) =>
      /^reveal$/i.test((button.textContent ?? '').trim())
    )
    expect(openButton).not.toBeUndefined()
    expect(revealButton).not.toBeUndefined()

    await act(async () => {
      openButton?.click()
    })

    expect(
      (window as unknown as { api: { logs: { openFile: ReturnType<typeof vi.fn> } } }).api.logs
        .openFile
    ).toHaveBeenCalledTimes(1)

    await act(async () => {
      revealButton?.click()
    })

    expect(
      (window as unknown as { api: { logs: { revealInFolder: ReturnType<typeof vi.fn> } } }).api
        .logs.revealInFolder
    ).toHaveBeenCalledTimes(1)
  })

  it('switches to the Connectors panel and lists bundled connectors', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const connectorsTab = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /connectors/i.test(button.textContent ?? '')) as
      HTMLButtonElement | undefined
    expect(connectorsTab).not.toBeUndefined()

    await act(async () => {
      connectorsTab?.click()
    })

    // The Connectors panel loads and renders the bundled connector rows + contact-email section.
    expect(
      (window as unknown as { api: { settings: { listConnectors: ReturnType<typeof vi.fn> } } }).api
        .settings.listConnectors
    ).toHaveBeenCalled()
    expect(document.body.textContent).toContain('Chemistry')
    expect(document.body.textContent).toContain('Contact email')
  })

  it('shows a breadcrumb in the header when a skill detail is open, and returns on breadcrumb click', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    // Navigate to the Skills panel.
    const skillsTab = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /skills/i.test(button.textContent ?? '')) as HTMLButtonElement | undefined
    await act(async () => {
      skillsTab?.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Open the skill's detail view by clicking its row.
    const alphaRow = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Alpha')
    )
    await act(async () => {
      alphaRow?.click()
    })

    // The header now shows a "Skills › Alpha" breadcrumb with a clickable "Skills" crumb.
    const crumb = document.body.querySelector<HTMLButtonElement>('[aria-label="Back to skills"]')
    expect(crumb).not.toBeNull()
    expect(document.body.textContent).toContain('Alpha')

    // Clicking the breadcrumb returns to the list (the crumb collapses back to the panel title).
    await act(async () => {
      crumb?.click()
    })
    expect(document.body.querySelector('[aria-label="Back to skills"]')).toBeNull()
  })

  it('opens directly on a skill detail when the store has a pending skill', async () => {
    // A skill mention sets the pending id before the dialog opens.
    useSettingsStore.setState({ pendingSkillId: 'alpha' })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    // Flush the seeding effect, the skills-list load, and the skill-detail fetch.
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    // Landed on the skill's detail page (breadcrumb + detail), not the default Model panel.
    expect(document.body.querySelector('[aria-label="Back to skills"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Alpha')
    expect(document.body.querySelector('section[aria-label="Providers"]')).toBeNull()
    // The pending id is consumed so a later normal open won't jump back to it.
    expect(useSettingsStore.getState().pendingSkillId).toBeUndefined()
  })

  it('warns about reduced-protection storage in the provider form when encryption is unavailable', async () => {
    // The store loads encryptionAvailable from this call when the dialog opens.
    ;(
      window as unknown as {
        api: { settings: { isEncryptionAvailable: ReturnType<typeof vi.fn> } }
      }
    ).api.settings.isEncryptionAvailable.mockResolvedValue(false)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    // No warning on the provider list itself…
    expect(document.body.textContent).not.toContain('reduced protection')

    const addProvider = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Add provider')
    await act(async () => {
      addProvider?.click()
    })

    // …but the Add provider sub-page warns before the user saves a key.
    expect(document.body.textContent).toContain('Secure key storage is unavailable')
    expect(document.body.textContent).toContain('reduced protection')
  })

  it('does not render when closed', () => {
    act(() => {
      root.render(<SettingsPage open={false} onClose={vi.fn()} />)
    })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('navigates settings history with the back/forward controls', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const back = (): HTMLButtonElement | null =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Back"]')
    const forward = (): HTMLButtonElement | null =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Forward"]')

    // Start on Model: back and forward are both disabled.
    expect(back()?.disabled).toBe(true)
    expect(forward()?.disabled).toBe(true)

    // Navigate Model -> General enables Back.
    const generalTab = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /general/i.test(button.textContent ?? '')) as HTMLButtonElement | undefined
    await act(async () => {
      generalTab?.click()
    })
    expect(back()?.disabled).toBe(false)

    // Back returns to Model (its nav item is the current page) and enables Forward.
    await act(async () => {
      back()?.click()
    })
    const modelNav = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /model/i.test(button.textContent ?? '')) as HTMLButtonElement | undefined
    expect(modelNav?.getAttribute('aria-current')).toBe('page')
    expect(forward()?.disabled).toBe(false)
  })

  it('toggles the dialog size with the maximize control', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const maximize = document.body.querySelector<HTMLButtonElement>('[aria-label="Maximize"]')
    expect(maximize).not.toBeNull()

    await act(async () => {
      maximize?.click()
    })

    // After maximizing, the control flips to Restore.
    expect(document.body.querySelector('[aria-label="Restore"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="Maximize"]')).toBeNull()
    const dialog = document.body.querySelector<HTMLElement>('[data-slot="settings-surface"]')
    expect(dialog?.className).toContain('inset-4')
    expect(dialog?.className).not.toContain('h-[80vh]')
    expect(dialog?.className).not.toContain('w-[80vw]')
  })
})

describe('SettingsPage uninstall confirmation', () => {
  const findButton = (root: ParentNode, text: string): HTMLButtonElement | undefined =>
    Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === text
    )

  it('gates the uninstall call behind the confirmation dialog', async () => {
    const managedSnapshot = {
      claude: { resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' },
      opencode: {},
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: [{ id: 'claude-code', displayName: 'Claude Code', supportsSkills: true }],
      claudeManaged: true,
      opencodeManaged: false
    }
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getSettings = vi.fn().mockResolvedValue(managedSnapshot)
    const uninstallClaude = vi
      .fn()
      .mockResolvedValue({ ...managedSnapshot, claude: {}, claudeManaged: false })
    api.settings.uninstallClaude = uninstallClaude

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    // The managed Claude card exposes an Uninstall action, and no confirmation is open yet.
    const cardUninstall = findButton(document.body, 'Uninstall')
    expect(cardUninstall).toBeDefined()
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()

    // Clicking it only opens the confirmation — the uninstall must not fire yet.
    await act(async () => {
      cardUninstall?.click()
    })
    const confirmDialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(confirmDialog).not.toBeNull()
    expect(uninstallClaude).not.toHaveBeenCalled()

    // Only confirming in the dialog performs the uninstall.
    const confirm = findButton(confirmDialog!, 'Uninstall')
    expect(confirm).toBeDefined()
    await act(async () => {
      confirm?.click()
    })
    expect(uninstallClaude).toHaveBeenCalledTimes(1)
  })
})
