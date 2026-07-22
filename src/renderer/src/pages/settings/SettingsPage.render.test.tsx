// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsPage } from './SettingsPage'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'
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
        codex: {},
        providers: [],
        agentFrameworkId: 'claude-code',
        agentFrameworks: [{ id: 'claude-code', displayName: 'Claude Code', supportsSkills: true }]
      }),
      detectOpencode: vi.fn().mockResolvedValue({
        claude: {},
        opencode: {},
        codex: {},
        providers: [],
        agentFrameworkId: 'claude-code',
        agentFrameworks: [{ id: 'claude-code', displayName: 'Claude Code', supportsSkills: true }]
      }),
      detectCodex: vi.fn().mockResolvedValue({
        claude: {},
        opencode: {},
        codex: {},
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
      }),
      getPackageMirror: vi.fn().mockResolvedValue({}),
      setPackageMirror: vi.fn().mockResolvedValue({})
    },
    acp: {
      getState: vi.fn().mockResolvedValue({ promptInFlightSessionIds: [] }),
      cancel: vi.fn()
    },
    logs: {
      getPath: vi.fn().mockResolvedValue('/Users/x/Library/Logs/Open Science/main.log'),
      openFile: vi.fn().mockResolvedValue({ opened: true }),
      revealInFolder: vi.fn().mockResolvedValue({ revealed: true })
    },
    cli: {
      getStatus: vi.fn().mockResolvedValue({
        installed: false,
        target: '/Users/x/.local/bin/open-science',
        onPath: false
      }),
      install: vi.fn(),
      uninstall: vi.fn()
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

// Opens the Agent sub-panel via the left nav (the agent framework lives there; the Model panel
// itself shows providers).
const openAgentPanel = async (): Promise<void> => {
  const item = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings"] button')
  ).find((candidate) => candidate.textContent?.trim() === 'Agent')
  await act(async () => item?.click())
}

// Finds a left-nav button by its exact label.
const navButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('nav[aria-label="Settings"] button')
  ).find((candidate) => candidate.textContent?.trim() === label)

// The Agent sub-item's <li> wrapper, whose grid-rows class drives the expand/collapse animation.
const agentItem = (): HTMLElement | null => navButton('Agent')?.closest('li') ?? null

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
          supportsImageInput: false,
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

    // Left navigation grouped as Capabilities (Skills, Connectors, Network) and Workspace (Model
    // with its Agent sub-item, Runtimes, Storage, General).
    const nav = document.body.querySelector('nav[aria-label="Settings"]')
    expect(nav).not.toBeNull()
    expect(nav?.className).toContain('bg-background')
    expect(nav?.nextElementSibling?.className).toContain('bg-card')
    expect(nav?.textContent).toContain('Capabilities')
    expect(nav?.textContent).toContain('Workspace')
    const navItems = nav?.querySelectorAll('li') ?? []
    expect(navItems).toHaveLength(8)
    expect(navItems[0]?.textContent).toContain('Skills')
    expect(navItems[1]?.textContent).toContain('Connectors')
    expect(navItems[2]?.textContent).toContain('Network')
    expect(navItems[3]?.textContent).toContain('Model')
    expect(navItems[4]?.textContent).toContain('Agent')
    expect(navItems[5]?.textContent).toContain('Runtimes')
    expect(navItems[6]?.textContent).toContain('Storage')
    expect(navItems[7]?.textContent).toContain('General')
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

    // The Model panel splits Active model and Reasoning effort (their own sections) from provider
    // management; the agent framework moved to the Agent sub-panel.
    expect(document.body.textContent).toContain('Active model')
    expect(document.body.textContent).toContain('Reasoning effort')
    expect(document.body.textContent).toContain('Providers')
    expect(document.body.textContent).not.toContain('Agent framework')
    expect(document.body.querySelectorAll('[data-slot="settings-section"]')).toHaveLength(3)
    // The add action lives with the list as a dashed ghost row, not a section-header button.
    const addRow = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Add provider'
    )
    expect(addRow?.className).toContain('border-dashed')
  })

  it('shows the agent framework on the Agent sub-panel', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    await openAgentPanel()

    expect(document.body.textContent).toContain('Agent framework')
    expect(document.body.textContent).not.toContain('Add provider')
    expect(document.body.querySelector('nav [aria-current="page"]')?.textContent?.trim()).toBe(
      'Agent'
    )
  })

  it('keeps the Agent sub-item expanded once the Model branch is opened', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    // Model is the default panel, so the branch starts expanded…
    expect(agentItem()?.className).toContain('grid-rows-[1fr]')

    // …and switching to another top-level panel never collapses it.
    await act(async () => navButton('General')?.click())
    expect(agentItem()?.className).toContain('grid-rows-[1fr]')
    expect(navButton('Agent')?.tabIndex).toBe(0)
  })

  it('collapses the Agent sub-item when a skill mention deep-links in, until Model is clicked', async () => {
    // Render the default (Model) landing first: the component stays mounted across opens, so a
    // deep link arrives as a store update AFTER mount — the exact path the regression hit.
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    expect(agentItem()?.className).toContain('grid-rows-[1fr]')

    // A skill mention deep-links settings to the Skills panel (the seeding effect re-seeds history).
    await act(async () => {
      useSettingsStore.setState({ pendingSkillId: 'alpha' })
    })
    expect(agentItem()?.className).toContain('grid-rows-[0fr]')
    expect(navButton('Agent')?.tabIndex).toBe(-1)

    // Clicking Model expands it…
    await act(async () => navButton('Model')?.click())
    expect(agentItem()?.className).toContain('grid-rows-[1fr]')
    expect(navButton('Agent')?.tabIndex).toBe(0)

    // …and it stays expanded after leaving the branch again.
    await act(async () => navButton('General')?.click())
    expect(agentItem()?.className).toContain('grid-rows-[1fr]')
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
    // the Claude section. There is no standalone in-content back arrow. With Claude Code as the
    // active framework, the type defaults to Anthropic.
    const crumb = document.body.querySelector<HTMLButtonElement>('[aria-label="Back to model"]')
    expect(crumb).not.toBeNull()
    expect(document.body.textContent).toContain('Add provider')
    expect(document.body.querySelector('[aria-label="Back to providers"]')).toBeNull()
    const typeTrigger = document.body.querySelector('[aria-label="Provider type"]')
    expect(typeTrigger).not.toBeNull()
    expect(typeTrigger?.textContent).toContain('Anthropic')
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

  it('defaults the Add provider type to the framework vendor (Codex → OpenAI, OpenCode → DeepSeek)', async () => {
    // Claude Code → Anthropic is covered by the history-navigation test above.
    const scenarios = [
      { framework: 'codex', runtime: { codex: { resolvedPath: '/x/codex' } }, label: 'OpenAI' },
      {
        framework: 'opencode',
        runtime: { opencode: { resolvedPath: '/x/opencode' } },
        label: 'DeepSeek'
      }
    ] as const

    for (const { framework, runtime, label } of scenarios) {
      await act(async () => {
        root.render(<SettingsPage open onClose={vi.fn()} />)
      })
      // Set the framework after the initial load() settles, and give the runtime a resolved path
      // so the detect-on-view effect doesn't overwrite it.
      useSettingsStore.setState({ agentFrameworkId: framework, ...runtime })

      const addProvider = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('button')
      ).find((button) => button.textContent?.trim() === 'Add provider')
      act(() => addProvider?.click())

      expect(document.body.querySelector('[aria-label="Provider type"]')?.textContent).toContain(
        label
      )

      act(() => root.unmount())
      container.remove()
      document.body.innerHTML = ''
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
    }
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

    // AppVersion, Notifications, Diagnostics, Command line tool, Community.
    expect(document.body.querySelectorAll('[data-slot="settings-section"]')).toHaveLength(5)
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

  it('switches to the Network panel, configures a mirror, and saves it', async () => {
    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })

    const networkTab = Array.from(
      document.body.querySelectorAll('nav[aria-label="Settings"] button')
    ).find((button) => /network/i.test(button.textContent ?? '')) as HTMLButtonElement | undefined
    expect(networkTab).not.toBeUndefined()

    await act(async () => {
      networkTab?.click()
    })

    // Unconfigured by default (the mocked getSettings snapshot has no packageMirror).
    expect(document.body.textContent).toContain('Not configured')

    const configureButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Configure')
    await act(async () => {
      configureButton?.click()
    })

    const condaInput = document.body.querySelector<HTMLInputElement>('#mirror-conda-channel')
    expect(condaInput).not.toBeNull()
    await act(async () => {
      condaInput?.dispatchEvent(new Event('focus'))
      Object.defineProperty(condaInput, 'value', {
        value: 'https://mirror.example/conda',
        writable: true
      })
      condaInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Save'
    )
    await act(async () => {
      saveButton?.click()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(
      (window as unknown as { api: { settings: { setPackageMirror: ReturnType<typeof vi.fn> } } })
        .api.settings.setPackageMirror
    ).toHaveBeenCalledWith(
      expect.objectContaining({ condaChannel: 'https://mirror.example/conda' })
    )
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

  it('blocks key storage in the provider form when encryption is unavailable', async () => {
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

    // No secure-storage error appears on the provider list itself.
    expect(document.body.textContent).not.toContain('Secure key storage is unavailable')

    const addProvider = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Add provider')
    await act(async () => {
      addProvider?.click()
    })

    // The Add provider sub-page explains that secret writes fail closed.
    expect(document.body.textContent).toContain('Secure key storage is unavailable')
    expect(document.body.textContent).toContain('API keys cannot be saved')
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

  const bothFrameworks = [
    { id: 'claude-code', displayName: 'Claude Code', supportsSkills: true },
    { id: 'opencode', displayName: 'OpenCode', supportsSkills: true }
  ]

  it('gates the uninstall call behind the confirmation dialog', async () => {
    // Claude is managed but NOT the active framework (OpenCode is), so its Uninstall is enabled.
    // OpenCode carries a path so the "auto-detect when active + missing" effect doesn't run.
    const snapshot = {
      claude: { resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' },
      providers: [],
      agentFrameworkId: 'opencode',
      agentFrameworks: bothFrameworks,
      claudeManaged: true,
      opencodeManaged: false
    }
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    const uninstallClaude = vi
      .fn()
      .mockResolvedValue({ ...snapshot, claude: {}, claudeManaged: false })
    api.settings.uninstallClaude = uninstallClaude

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    // The inactive managed Claude card exposes an Uninstall action, and no confirmation is open yet.
    const cardUninstall = findButton(document.body, 'Uninstall')
    expect(cardUninstall).toBeDefined()
    expect(cardUninstall?.disabled).toBe(false)
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

  it('disables uninstall on the active runtime card', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    // Claude is both managed and the active framework — its Uninstall must be disabled.
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: { resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' },
      opencode: {},
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: bothFrameworks,
      claudeManaged: true,
      opencodeManaged: false
    })

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    const cardUninstall = findButton(document.body, 'Uninstall')
    expect(cardUninstall).toBeDefined()
    // The active managed runtime is greyed via aria-disabled (kept hoverable for its explainer tooltip),
    // not the native disabled attribute.
    expect(cardUninstall?.getAttribute('aria-disabled')).toBe('true')
  })

  it('gates a framework switch behind the confirmation dialog', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    // OpenCode must be ready (preflight passed) to be selectable as the framework.
    api.settings.getPreflight = vi
      .fn()
      .mockResolvedValue({ claudeReady: true, opencodeReady: true, activeProviderReady: true })
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: { resolvedPath: '/data/claude-code/bin/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' },
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: bothFrameworks,
      claudeManaged: true,
      opencodeManaged: false
    })
    const setAgentFramework = vi.fn().mockResolvedValue({
      claude: {},
      opencode: {},
      providers: [],
      agentFrameworkId: 'opencode',
      agentFrameworks: bothFrameworks,
      claudeManaged: true,
      opencodeManaged: false
    })
    api.settings.setAgentFramework = setAgentFramework

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    // Selecting the inactive OpenCode card opens the switch confirmation without switching yet.
    const opencodeRadio = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Use OpenCode"]'
    )
    expect(opencodeRadio).not.toBeNull()
    await act(async () => {
      opencodeRadio?.click()
    })
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Switch to OpenCode?')
    expect(setAgentFramework).not.toHaveBeenCalled()

    // Confirming performs the switch.
    await act(async () => {
      findButton(dialog!, 'Switch')?.click()
    })
    expect(setAgentFramework).toHaveBeenCalledWith({ id: 'opencode' })
  })
})

describe('SettingsPage Codex framework', () => {
  const frameworks = [
    { id: 'claude-code', displayName: 'Claude Code', supportsSkills: true },
    { id: 'opencode', displayName: 'OpenCode', supportsSkills: true },
    {
      id: 'codex',
      displayName: 'Codex',
      supportsSkills: true,
      supportedApiTypes: ['responses']
    }
  ]

  it('offers Codex as a selectable framework behind the switch confirmation', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const snapshot = {
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: {},
      codex: {
        resolvedPath: '/data/codex-managed/adapter/dist/index.js',
        version: '1.1.4',
        nativeVersion: '0.144.6'
      },
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: true
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: false,
      codexReady: true,
      agentFrameworkId: 'claude-code',
      agentReady: true,
      activeProviderReady: false
    })
    const setAgentFramework = vi.fn().mockResolvedValue({
      ...snapshot,
      agentFrameworkId: 'codex'
    })
    api.settings.setAgentFramework = setAgentFramework

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    const codexRadio = document.body.querySelector<HTMLButtonElement>('[aria-label="Use Codex"]')
    expect(codexRadio).not.toBeNull()
    // The adapter version shows as a muted v-tag after the name; the repo link points at the ACP adapter.
    expect(document.body.textContent).toContain('v1.1.4')
    expect(document.body.textContent).toContain('agentclientprotocol/codex-acp')

    await act(async () => codexRadio?.click())
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Switch to Codex?')

    const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Switch'
    )
    await act(async () => confirm?.click())
    expect(setAgentFramework).toHaveBeenCalledWith({ id: 'codex' })
  })

  it('routes the default app-managed install action to installCodex', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' },
      codex: {},
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: false
    })
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: true,
      codexReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: true,
      activeProviderReady: false
    })
    const installCodex = vi
      .fn()
      .mockResolvedValue({ installId: 'codex-test', ok: false, error: 'stopped for test' })
    api.settings.installCodex = installCodex
    api.settings.onInstallLog = vi.fn().mockReturnValue(() => undefined)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    const installTrigger = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Install Codex"]'
    )
    expect(installTrigger).not.toBeNull()
    openRadixMenu(installTrigger)

    // The Install button opens a source menu; the app-managed source is the recommended default.
    const managedItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find((item) => item.textContent?.includes('App-managed download (recommended)'))
    expect(managedItem).toBeDefined()
    clickRadixMenuItem(managedItem)

    expect(installCodex).toHaveBeenCalledWith({ source: 'managed' })
  })

  it('groups cards by install state and re-detects every framework from the section action', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const snapshot = {
      claude: { resolvedPath: '/data/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/usr/local/bin/opencode', version: '1.18.3' },
      codex: {},
      providers: [],
      agentFrameworkId: 'claude-code',
      agentFrameworks: frameworks,
      claudeManaged: true,
      opencodeManaged: false,
      codexManaged: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      claudeReady: true,
      opencodeReady: true,
      codexReady: false,
      agentFrameworkId: 'claude-code',
      agentReady: true,
      activeProviderReady: false
    })
    const detectClaude = vi.fn().mockResolvedValue(snapshot)
    const detectOpencode = vi.fn().mockResolvedValue(snapshot)
    const detectCodex = vi.fn().mockResolvedValue(snapshot)
    api.settings.detectClaude = detectClaude
    api.settings.detectOpencode = detectOpencode
    api.settings.detectCodex = detectCodex

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    await openAgentPanel()

    // Two ready runtimes land in the Installed group; Codex (not ready) in Available.
    expect(document.body.textContent).toContain('Installed · 2')
    expect(document.body.textContent).toContain('Available · 1')
    // Claude is renamed in this panel only.
    expect(document.body.textContent).toContain('Claude Agent')

    // The section-level Re-detect re-scans all three frameworks at once.
    const redetect = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Re-detect'
    )
    expect(redetect).toBeDefined()
    await act(async () => redetect?.click())

    expect(detectClaude).toHaveBeenCalledTimes(1)
    expect(detectOpencode).toHaveBeenCalledTimes(1)
    expect(detectCodex).toHaveBeenCalledTimes(1)
  })

  it('routes isolated subscription sign-out from the provider list', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const provider = {
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      models: ['gpt-5.6-sol'],
      supportsImageInput: true,
      hasKey: false,
      needsKey: false,
      lastValidatedAt: 1
    }
    const snapshot = {
      claude: {},
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.1.4' },
      providers: [provider],
      activeProviderId: provider.id,
      activeModel: 'gpt-5.6-sol',
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: false,
      opencodeManaged: false,
      codexManaged: true
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      codexReady: true,
      agentFrameworkId: 'codex',
      agentReady: true,
      activeProviderReady: true
    })
    const logoutIsolatedCodex = vi.fn().mockResolvedValue({ ok: true, category: 'ok' })
    api.settings.logoutIsolatedCodex = logoutIsolatedCodex

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    const signOut = document.body.querySelector<HTMLButtonElement>('[aria-label="Sign out"]')
    await act(async () => signOut?.click())

    expect(logoutIsolatedCodex).toHaveBeenCalledOnce()
    const errorAlert = document.body.querySelector('[role="alert"]')
    expect(errorAlert).toBeNull()
  })

  it('surfaces a Codex sign-out timeout through the provider error alert', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const provider = {
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      models: ['gpt-5.6-sol'],
      supportsImageInput: true,
      hasKey: false,
      needsKey: false,
      verified: true,
      lastValidatedAt: Date.now()
    }
    const snapshot = {
      claude: {},
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.1.4' },
      providers: [provider],
      activeProviderId: provider.id,
      activeModel: 'gpt-5.6-sol',
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: false,
      opencodeManaged: false,
      codexManaged: true
    }
    api.settings.getSettings = vi.fn().mockResolvedValue(snapshot)
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      codexReady: true,
      agentFrameworkId: 'codex',
      agentReady: true,
      activeProviderReady: true
    })
    const logoutIsolatedCodex = vi
      .fn()
      .mockResolvedValue({ ok: false, category: 'timeout', message: 'Codex sign-out timed out.' })
    api.settings.logoutIsolatedCodex = logoutIsolatedCodex

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    const signOut = document.body.querySelector<HTMLButtonElement>('[aria-label="Sign out"]')
    await act(async () => signOut?.click())

    expect(logoutIsolatedCodex).toHaveBeenCalledOnce()
    const errorAlert = document.body.querySelector('[role="alert"]')
    expect(errorAlert?.textContent).toBe('Codex sign-out timed out.')
  })

  it('shows Codex login-check IPC failures instead of leaving an unhandled rejection', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const provider = {
      id: 'builtin-codex-subscription',
      type: 'codex-shared',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      models: ['gpt-5.6-sol'],
      supportsImageInput: true,
      hasKey: false,
      needsKey: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: {},
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.1.4' },
      providers: [provider],
      activeProviderId: provider.id,
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: false,
      opencodeManaged: false,
      codexManaged: true
    })
    api.settings.getPreflight = vi.fn().mockResolvedValue({
      codexReady: true,
      agentFrameworkId: 'codex',
      agentReady: true,
      activeProviderReady: false
    })
    api.settings.validateProvider = vi
      .fn()
      .mockRejectedValue(new Error('The Codex adapter does not support authentication status.'))

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    const testLogin = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Check Codex login"]'
    )
    await act(async () => testLogin?.click())

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'The Codex adapter does not support authentication status.'
    )
  })

  it('cancels a pending isolated sign-in when the dialog closes mid-flow', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const provider = {
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      models: [],
      supportsImageInput: true,
      hasKey: false,
      needsKey: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: {},
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.1.4' },
      providers: [provider],
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: false,
      opencodeManaged: false,
      codexManaged: true
    })
    // The browser flow never settles on its own; closing the dialog is what cancels it.
    api.settings.loginIsolatedCodex = vi.fn(() => new Promise(() => undefined))
    api.settings.cancelCodexLogin = vi.fn().mockResolvedValue(undefined)

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    const signIn = document.body.querySelector<HTMLButtonElement>('[aria-label="Sign in"]')
    await act(async () => signIn?.click())
    expect(document.body.querySelector('[aria-label="Cancel sign-in"]')).not.toBeNull()

    await act(async () => {
      root.render(<SettingsPage open={false} onClose={vi.fn()} />)
    })

    expect(api.settings.cancelCodexLogin).toHaveBeenCalledOnce()
  })

  it('surfaces isolated sign-in failures instead of leaving an unhandled rejection', async () => {
    const api = (window as unknown as { api: { settings: Record<string, unknown> } }).api
    const provider = {
      id: 'builtin-codex-subscription',
      type: 'codex-isolated',
      name: 'Codex subscription',
      apiEndpoints: ['responses'],
      models: [],
      supportsImageInput: true,
      hasKey: false,
      needsKey: false
    }
    api.settings.getSettings = vi.fn().mockResolvedValue({
      claude: {},
      opencode: {},
      codex: { resolvedPath: '/data/codex-acp', version: '1.1.4' },
      providers: [provider],
      agentFrameworkId: 'codex',
      agentFrameworks: frameworks,
      claudeManaged: false,
      opencodeManaged: false,
      codexManaged: true
    })
    api.settings.loginIsolatedCodex = vi
      .fn()
      .mockRejectedValue(new Error('The Codex adapter failed to spawn.'))

    await act(async () => {
      root.render(<SettingsPage open onClose={vi.fn()} />)
    })
    const signIn = document.body.querySelector<HTMLButtonElement>('[aria-label="Sign in"]')
    await act(async () => signIn?.click())

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'The Codex adapter failed to spawn.'
    )
  })
})
