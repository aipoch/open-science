// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectorsPanel } from './ConnectorsPanel'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { createInitialTagState, useTagStore } from '@/stores/tag-store'

// Radix Select/DropdownMenu call pointer-capture and scroll APIs jsdom does not implement.
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

const seedConnectors = [
  {
    id: 'pubmed',
    name: 'pubmed',
    displayName: 'PubMed',
    description: 'Biomedical literature',
    sources: ['NCBI'],
    requiresNcbi: true,
    enabled: true,
    autoAllow: false,
    group: 'directory' as const
  },
  {
    id: 'europepmc',
    name: 'europepmc',
    displayName: 'Europe PMC',
    description: 'Open-access life-science papers',
    sources: ['EBI'],
    requiresNcbi: false,
    enabled: false,
    autoAllow: false,
    group: 'featured' as const
  },
  {
    id: 'openalex',
    name: 'openalex',
    displayName: 'OpenAlex',
    description: 'Scholarly works catalog',
    sources: ['OurResearch'],
    requiresNcbi: false,
    enabled: true,
    autoAllow: true,
    group: 'featured' as const
  }
]

const seedCustomServers = [
  {
    id: 'custom-server-uuid',
    name: 'my-mcp',
    displayName: 'My MCP',
    description: 'A local tool server',
    transport: 'stdio' as const,
    enabled: true,
    command: 'node server.js'
  }
]

beforeEach(() => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    connectors: seedConnectors,
    customServers: seedCustomServers,
    ncbi: { contactEmail: undefined, hasApiKey: false },
    loadConnectors: vi.fn().mockResolvedValue(undefined),
    setConnectorEnabled: vi.fn().mockResolvedValue(undefined),
    setConnectorAutoAllow: vi.fn().mockResolvedValue(undefined),
    setToolPermission: vi.fn().mockResolvedValue(undefined),
    setNcbiCredentials: vi.fn().mockResolvedValue(undefined),
    addCustomServer: vi.fn().mockResolvedValue(undefined),
    authenticateCustomServer: vi.fn().mockResolvedValue(undefined),
    cancelCustomServerAuthentication: vi.fn().mockResolvedValue(undefined),
    disconnectCustomServer: vi.fn().mockResolvedValue(undefined),
    retryConnectorProjection: vi.fn().mockResolvedValue(undefined),
    retryCustomServer: vi.fn().mockResolvedValue(undefined),
    setCustomServerEnabled: vi.fn().mockResolvedValue(undefined),
    removeCustomServer: vi.fn().mockResolvedValue(undefined)
  })
  useSpecialistStore.setState({
    items: [
      {
        kind: 'custom',
        id: 'selected-legacy-uuid',
        name: 'SELECTED_LEGACY_UUID',
        displayName: 'Selected by legacy UUID',
        description: '',
        systemPrompt: '',
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: {
          skillIds: [],
          connectorIds: ['custom-server-uuid'],
          connectorTools: []
        },
        revision: 1
      },
      {
        kind: 'custom',
        id: 'selected-slug',
        name: 'SELECTED_SLUG',
        displayName: 'Selected by ID',
        description: '',
        systemPrompt: '',
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: [], connectorIds: ['my-mcp'], connectorTools: [] },
        revision: 1
      },
      {
        kind: 'custom',
        id: 'selected-legacy-name',
        name: 'SELECTED_LEGACY_NAME',
        displayName: 'Selected by legacy name',
        description: '',
        systemPrompt: '',
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: [], connectorIds: ['My MCP'], connectorTools: [] },
        revision: 1
      },
      {
        kind: 'custom',
        id: 'full-access',
        name: 'FULL_ACCESS',
        displayName: 'Full access',
        description: '',
        systemPrompt: '',
        enabled: true,
        capabilityMode: 'full',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
        revision: 1
      },
      {
        kind: 'custom',
        id: 'excluded',
        name: 'EXCLUDED',
        description: '',
        systemPrompt: '',
        enabled: true,
        capabilityMode: 'full',
        fullAccess: {
          excludedSkillIds: [],
          excludedConnectorIds: ['my-mcp'],
          connectorTools: []
        },
        selectedCapabilities: { skillIds: [], connectorIds: [], connectorTools: [] },
        revision: 1
      }
    ],
    isLoaded: true,
    load: vi.fn().mockResolvedValue(undefined)
  })
  useTagStore.setState({
    ...createInitialTagState(),
    status: 'ready',
    revision: 1,
    tags: [
      {
        id: 'tag-research',
        name: 'Research',
        iconKey: 'flask-conical',
        colorKey: 'purple',
        createdAt: 1,
        updatedAt: 1
      }
    ],
    assignments: ['pubmed', 'custom-server-uuid'].map((resourceId) => ({
      tagId: 'tag-research',
      resourceType: 'catalog.connector' as const,
      resourceId,
      createdAt: 1
    }))
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const setValue = (label: string, value: string): void => {
  const field = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`
  )
  const proto =
    field instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    setter?.call(field, value)
    field?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const clickButtonByText = (text: string): void => {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === text
  )
  act(() => button?.click())
}

const openMenu = (label: string): void => {
  const trigger = document.body.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const openDropdownByText = (text: string): void => {
  const trigger = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.includes(text)
  )
  act(() => {
    trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

// Select an item (radix option/menuitem) by its visible text.
const clickItemByText = (role: string, text: string): void => {
  const item = Array.from(document.body.querySelectorAll<HTMLElement>(`[role="${role}"]`)).find(
    (candidate) => candidate.textContent?.includes(text)
  )
  act(() => {
    item?.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    item?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('ConnectorsPanel (groups)', () => {
  it('renders Featured connector rows with a toggle each and the Custom group', () => {
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    expect(document.body.textContent).toContain('Featured')
    expect(document.body.textContent).toContain('Custom')
    expect(document.body.textContent).toContain('PubMed')
    expect(document.body.textContent).toContain('Europe PMC')
    expect(document.body.textContent).toContain('OpenAlex')
    expect(document.body.textContent).toContain('My MCP')
    // Three featured toggles + one custom toggle.
    expect(document.body.querySelectorAll('[role="switch"]')).toHaveLength(4)
    expect(document.body.querySelectorAll('[data-slot="settings-list-row"]')).toHaveLength(4)
    expect(document.body.querySelector('[data-slot="settings-section"]')).not.toBeNull()
    const addConnector = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.includes('Add connector'))
    expect(addConnector?.getAttribute('data-slot')).toBe('button')
    expect(addConnector?.getAttribute('data-variant')).toBe('outline')
  })

  it('keeps the agent filter and search in the first row with Add Connector at the far right', () => {
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    const toolbar = document.body.querySelector<HTMLElement>('[data-testid="connectors-toolbar"]')
    const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search connectors"]')
    const filter = document.body.querySelector<HTMLElement>(
      '[aria-label="Filter connectors by group"]'
    )
    const agentFilter = document.body.querySelector<HTMLElement>(
      '[aria-label="Filter Connectors by agent"]'
    )
    const tagFilter = document.body.querySelector<HTMLElement>('[aria-label="Filter by Tag"]')
    const addConnector = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.includes('Add connector'))

    expect(toolbar?.className).toContain('flex-wrap')
    expect(filter?.compareDocumentPosition(agentFilter!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(agentFilter?.compareDocumentPosition(tagFilter!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(tagFilter?.compareDocumentPosition(search!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(search?.compareDocumentPosition(addConnector!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(search?.parentElement?.className).toContain('min-w-48')
    expect(filter?.className).toContain('w-36')
    expect(agentFilter?.className).toContain('w-48')
    expect(addConnector?.className).toContain('ml-auto')
    expect(addConnector?.className).toContain('shrink-0')
    expect(toolbar?.lastElementChild).toBe(addConnector)
    expect(document.body.querySelector('[aria-label="Filter Connectors by scope"]')).toBeNull()
  })

  it('shows actual Connector users as avatar stacks without changing the Main Agent toggle', () => {
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    const pubmedRow = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="settings-list-row"]')
    ).find((row) => row.textContent?.includes('PubMed'))
    const europePmcRow = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="settings-list-row"]')
    ).find((row) => row.textContent?.includes('Europe PMC'))

    expect(pubmedRow?.textContent).not.toContain('Shared with Main')
    expect(pubmedRow?.textContent).not.toContain('Main Agent')
    expect(europePmcRow?.textContent).not.toContain('Specialist only')
    expect(europePmcRow?.textContent).not.toContain('Main Agent')
    expect(pubmedRow?.textContent).toContain('Used by')
    const usageLabel = pubmedRow?.querySelector('[data-slot="skill-usage-agents-label"]')
    const usageTrigger = pubmedRow?.querySelector('[data-slot="skill-usage-agents-trigger"]')
    expect(usageLabel?.compareDocumentPosition(usageTrigger!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(
      pubmedRow
        ?.querySelector('[data-slot="skill-usage-agents-trigger"]')
        ?.getAttribute('data-resource-kind')
    ).toBe('connector')
    expect(europePmcRow?.querySelector('[data-slot="skill-usage-agents-trigger"]')).not.toBeNull()
    expect(
      pubmedRow?.querySelector('[aria-label="Toggle PubMed"]')?.getAttribute('data-state')
    ).toBe('checked')
    expect(
      europePmcRow?.querySelector('[aria-label="Toggle Europe PMC"]')?.getAttribute('data-state')
    ).toBe('unchecked')
  })

  it('combines Main Agent and Specialists in the All Agents/Specialists filter', () => {
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    const agentFilter = document.body.querySelector<HTMLElement>(
      '[aria-label="Filter Connectors by agent"]'
    )
    expect(agentFilter?.textContent).toContain('All Agents/Specialists')

    openMenu('Filter Connectors by agent')
    clickItemByText('option', 'Main Agent')
    expect(document.body.textContent).toContain('PubMed')
    expect(document.body.textContent).toContain('OpenAlex')
    expect(document.body.textContent).toContain('My MCP')
    expect(document.body.textContent).not.toContain('Europe PMC')

    openMenu('Filter Connectors by agent')
    clickItemByText('option', 'Selected by ID')
    expect(document.body.textContent).toContain('My MCP')
    expect(document.body.textContent).not.toContain('PubMed')
    expect(document.body.textContent).not.toContain('Europe PMC')
    expect(document.body.textContent).not.toContain('OpenAlex')
  })

  it('keeps Connector Tags in the third metadata row', () => {
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    for (const resourceId of ['pubmed', 'custom-server-uuid']) {
      const metadata = document.body.querySelector(`[data-connector-metadata="${resourceId}"]`)
      const tagName = metadata?.querySelector('[title="Research"]')
      expect(metadata).not.toBeNull()
      expect(tagName).not.toBeNull()
    }
  })

  it('toggles a featured connector and navigates to its detail on row click', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<ConnectorsPanel onNavigate={onNavigate} />)
    })

    act(() =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle PubMed"]')?.click()
    )
    expect(useSettingsStore.getState().setConnectorEnabled).toHaveBeenCalledWith('pubmed', false)

    const row = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('PubMed')
    )
    act(() => row?.click())
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'detail', id: 'pubmed' })
  })

  it('distinguishes loading and a retryable Connector catalog failure from empty results', async () => {
    let rejectLoad: ((reason?: unknown) => void) | undefined
    const loadConnectors = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectLoad = reject
          })
      )
      .mockResolvedValueOnce(undefined)
    useSettingsStore.setState({ connectors: [], customServers: [], loadConnectors })

    await act(async () => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
      'Loading Connectors…'
    )

    await act(async () => rejectLoad?.(new Error('catalog unavailable')))

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Open Science could not load Connectors.'
    )
    const retry = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    )
    await act(async () => retry?.click())
    expect(loadConnectors).toHaveBeenCalledTimes(2)
  })

  it('shows degraded Connector Skill documents and offers an explicit retry', async () => {
    const retryConnectorProjection = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      skillProjectionStatus: 'degraded',
      retryConnectorProjection
    })

    await act(async () => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    const notice = document.body.querySelector('[role="alert"]')
    expect(notice?.textContent).toContain(
      'Connector settings are saved, but their Agent Skill documents are out of date.'
    )

    const retry = Array.from(notice?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Retry'
    )
    await act(async () => retry?.click())

    expect(retryConnectorProjection).toHaveBeenCalledOnce()
  })

  it('shows a safe Skill projection retry failure instead of backend details', async () => {
    const diagnostic = 'EACCES: write /Users/researcher/private/generated-skill/SKILL.md'
    useSettingsStore.setState({
      skillProjectionStatus: 'degraded',
      retryConnectorProjection: vi.fn().mockRejectedValue(new Error(diagnostic))
    })
    await act(async () => root.render(<ConnectorsPanel onNavigate={vi.fn()} />))

    const retry = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Retry'
    )
    await act(async () => retry?.click())

    expect(document.body.textContent).toContain(
      'Could not refresh the Agent Skill documents for Connectors.'
    )
    expect(document.body.textContent).not.toContain(diagnostic)
  })

  it('reports a rejected Connector access change after rollback', async () => {
    useSettingsStore.setState({
      setConnectorEnabled: vi.fn().mockRejectedValue(new Error('write failed'))
    })
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    const pubmedRow = Array.from(
      document.body.querySelectorAll<HTMLElement>('[data-slot="settings-list-row"]')
    ).find((row) => row.textContent?.includes('PubMed'))
    await act(async () => {
      pubmedRow?.querySelector<HTMLButtonElement>('[role="switch"]')?.click()
      await Promise.resolve()
    })

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save this setting. The previous value was restored.'
    )
  })

  it('warns about affected Specialists before removing a custom server', async () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<ConnectorsPanel onNavigate={onNavigate} />)
    })

    act(() =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Toggle My MCP"]')?.click()
    )
    expect(useSettingsStore.getState().setCustomServerEnabled).toHaveBeenCalledWith(
      'custom-server-uuid',
      false
    )

    const title = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('My MCP') && button.textContent?.includes('my-mcp')
    )
    act(() => title?.click())
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'custom-server-uuid' })

    openMenu('Actions for My MCP')
    clickItemByText('menuitem', 'Export')
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'export', id: 'custom-server-uuid' })

    openMenu('Actions for My MCP')
    clickItemByText('menuitem', 'Remove')
    await act(async () => {
      await Promise.resolve()
    })
    expect(useSettingsStore.getState().removeCustomServer).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('This Connector is used by 3 Specialists')
    expect(document.body.textContent).toContain('Selected by ID')
    expect(document.body.textContent).toContain('Selected by legacy UUID')
    expect(document.body.textContent).toContain('Full access')
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.className).toContain('p-0')
    expect(
      Array.from(dialog?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.className.includes('border-b border-border-300/90')
      )
    ).toBe(true)
    expect(
      Array.from(dialog?.querySelectorAll<HTMLElement>('div') ?? []).some((element) =>
        element.className.includes('border-t border-border-300/90')
      )
    ).toBe(true)

    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Remove Connector'
    )
    await act(async () => {
      confirm?.click()
      await Promise.resolve()
    })
    expect(useSettingsStore.getState().removeCustomServer).toHaveBeenCalledWith(
      'custom-server-uuid'
    )
  })

  it('blocks Connector removal until Specialist references can be checked', async () => {
    let finishRetry!: () => void
    const load = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('specialist store unavailable'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRetry = resolve
          })
      )
    useSpecialistStore.setState({ load })
    act(() => root.render(<ConnectorsPanel onNavigate={vi.fn()} />))

    openMenu('Actions for My MCP')
    clickItemByText('menuitem', 'Remove')
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain(
      'Specialist references could not be checked. Retry before removing this Connector.'
    )
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Remove Connector'
    )
    expect(confirm?.disabled).toBe(true)
    act(() => confirm?.click())
    expect(useSettingsStore.getState().removeCustomServer).not.toHaveBeenCalled()

    await act(async () => {
      const retry = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Retry'
      )
      retry?.click()
      retry?.click()
      await Promise.resolve()
    })

    expect(load).toHaveBeenCalledTimes(3)
    expect(document.body.textContent).toContain('Checking…')
    expect(confirm?.disabled).toBe(true)

    await act(async () => finishRetry())
    expect(confirm?.disabled).toBe(false)
  })

  it('does not reopen a removal dialog after cancelling a pending retry check', async () => {
    let finishRetry!: () => void
    const load = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('specialist store unavailable'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishRetry = resolve
          })
      )
    useSpecialistStore.setState({ load })
    act(() => root.render(<ConnectorsPanel onNavigate={vi.fn()} />))

    openMenu('Actions for My MCP')
    clickItemByText('menuitem', 'Remove')
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      const retry = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Retry'
      )
      retry?.click()
      await Promise.resolve()
    })

    act(() => {
      const cancel = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Cancel'
      )
      cancel?.click()
    })
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()

    await act(async () => finishRetry())
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('offers validated configuration import from the Add connector menu', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<ConnectorsPanel onNavigate={onNavigate} />)
    })

    openDropdownByText('Add connector')
    expect(document.body.textContent).toContain('Import a Connector or MCP client configuration')
    clickItemByText('menuitem', 'Import configuration')

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'import' })
  })

  it('starts OAuth sign-in and displays the connected state', async () => {
    useSettingsStore.setState({
      customServers: [
        {
          id: 'oauth-mcp',
          name: 'oauth-mcp',
          displayName: 'OAuth MCP',
          transport: 'streamable_http',
          enabled: false,
          url: 'https://mcp.example.test',
          oauth: { hasTokens: false }
        }
      ]
    })
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })
    const waitingToggle = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle OAuth MCP"]'
    )
    expect(waitingToggle?.disabled).toBe(false)
    expect(waitingToggle?.getAttribute('aria-disabled')).toBe('true')
    expect(waitingToggle?.className).toContain('cursor-not-allowed')
    expect(waitingToggle?.getAttribute('data-state')).toBe('unchecked')
    act(() => waitingToggle?.click())
    expect(useSettingsStore.getState().setCustomServerEnabled).not.toHaveBeenCalled()

    await act(async () => {
      clickButtonByText('Sign in')
    })
    expect(useSettingsStore.getState().authenticateCustomServer).toHaveBeenCalledWith({
      id: 'oauth-mcp'
    })

    act(() => {
      useSettingsStore.setState({
        customServers: [
          {
            id: 'oauth-mcp',
            name: 'oauth-mcp',
            displayName: 'OAuth MCP',
            transport: 'streamable_http',
            enabled: true,
            url: 'https://mcp.example.test',
            oauth: { hasTokens: true, sharedCredential: true }
          }
        ]
      })
    })
    expect(document.body.textContent).toContain('Connected')
    const connectedToggle = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle OAuth MCP"]'
    )
    expect(connectedToggle?.disabled).toBe(false)
    expect(connectedToggle?.getAttribute('aria-disabled')).toBeNull()
    expect(connectedToggle?.getAttribute('data-state')).toBe('checked')

    const connectedStatus = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Connected')
    expect(connectedStatus?.disabled).toBe(false)
    act(() => connectedStatus?.click())
    expect(document.body.textContent).toContain('Reauthenticate')
    expect(document.body.textContent).toContain('Disconnect')
    expect(document.body.textContent).toContain('disables every Connector using this credential')
    await act(async () => clickButtonByText('Disconnect'))
    expect(useSettingsStore.getState().disconnectCustomServer).toHaveBeenCalledWith({
      id: 'oauth-mcp'
    })

    const connectedAgain = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Connected')
    act(() => connectedAgain?.click())
    await act(async () => clickButtonByText('Reauthenticate'))
    expect(useSettingsStore.getState().disconnectCustomServer).toHaveBeenCalledTimes(2)
    expect(useSettingsStore.getState().authenticateCustomServer).toHaveBeenCalledTimes(2)
  })

  it('shows an unavailable custom Connector and retries it in place', async () => {
    let finishRetry!: () => void
    const retryCustomServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRetry = resolve
        })
    )
    useSettingsStore.setState({
      retryCustomServer,
      customServers: [
        {
          id: 'offline-mcp',
          name: 'offline-mcp',
          displayName: 'Offline MCP',
          transport: 'stdio',
          enabled: true,
          command: 'mcp',
          availability: 'unavailable'
        }
      ]
    })
    act(() => root.render(<ConnectorsPanel onNavigate={vi.fn()} />))

    expect(document.body.textContent).toContain('Unavailable')
    const unavailableStatus = Array.from(document.body.querySelectorAll('span')).find(
      (candidate) => candidate.textContent === 'Unavailable'
    )
    expect(unavailableStatus?.className).toContain('text-destructive')
    act(() => clickButtonByText('Retry'))
    expect(retryCustomServer).toHaveBeenCalledWith('offline-mcp')
    expect(document.body.textContent).toContain('Checking…')

    await act(async () => finishRetry())
  })

  it('shows a safe retry failure instead of backend details', async () => {
    const diagnostic = 'spawn /Users/researcher/private/mcp-server ENOENT'
    useSettingsStore.setState({
      retryCustomServer: vi.fn().mockRejectedValue(new Error(diagnostic)),
      customServers: [
        {
          id: 'offline-mcp',
          name: 'offline-mcp',
          displayName: 'Offline MCP',
          transport: 'stdio',
          enabled: true,
          command: 'mcp',
          availability: 'unavailable'
        }
      ]
    })
    act(() => root.render(<ConnectorsPanel onNavigate={vi.fn()} />))

    await act(async () => clickButtonByText('Retry'))

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not reconnect this Connector.'
    )
    expect(document.body.textContent).not.toContain(diagnostic)
  })

  it('directs invalid custom Connector configurations to Edit without offering Retry', () => {
    const onNavigate = vi.fn()
    useSettingsStore.setState({
      customServers: [
        {
          id: 'invalid-mcp',
          name: 'invalid-mcp',
          displayName: 'Invalid MCP',
          transport: 'stdio',
          enabled: false,
          availability: 'unavailable'
        }
      ]
    })
    act(() => root.render(<ConnectorsPanel onNavigate={onNavigate} />))

    expect(document.body.textContent).toContain('Unavailable')
    expect(
      Array.from(document.body.querySelectorAll('button')).some(
        (button) => button.textContent === 'Retry'
      )
    ).toBe(false)

    openMenu('Actions for Invalid MCP')
    clickItemByText('menuitem', 'Edit')
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'invalid-mcp' })
  })

  it('directs custom Connectors with unavailable credentials to Edit', () => {
    const onNavigate = vi.fn()
    useSettingsStore.setState({
      customServers: [
        {
          id: 'credential-unavailable-mcp',
          name: 'credential-unavailable-mcp',
          displayName: 'Credential unavailable MCP',
          transport: 'stdio',
          enabled: false,
          availability: 'credential_unavailable'
        }
      ]
    })
    act(() => root.render(<ConnectorsPanel onNavigate={onNavigate} />))

    expect(document.body.textContent).toContain('Credentials unavailable')
    expect(
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Toggle Credential unavailable MCP"]')
        ?.getAttribute('aria-disabled')
    ).toBe('true')
    act(() => clickButtonByText('Configure'))
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'credential-unavailable-mcp' })
  })

  it('allows a durably enabled Connector with unavailable credentials to be disabled', () => {
    useSettingsStore.setState({
      customServers: [
        {
          id: 'enabled-credential-unavailable-mcp',
          name: 'enabled-credential-unavailable-mcp',
          displayName: 'Enabled credential unavailable MCP',
          transport: 'stdio',
          enabled: true,
          availability: 'credential_unavailable'
        }
      ]
    })
    act(() => root.render(<ConnectorsPanel onNavigate={vi.fn()} />))

    const toggle = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle Enabled credential unavailable MCP"]'
    )
    expect(toggle?.getAttribute('data-state')).toBe('checked')
    expect(toggle?.getAttribute('aria-disabled')).toBeNull()
    act(() => toggle?.click())
    expect(useSettingsStore.getState().setCustomServerEnabled).toHaveBeenCalledWith(
      'enabled-credential-unavailable-mcp',
      false
    )
  })

  it('shows checking while background discovery is still pending', () => {
    useSettingsStore.setState({
      customServers: [
        {
          id: 'checking-mcp',
          name: 'checking-mcp',
          displayName: 'Checking MCP',
          transport: 'stdio',
          enabled: true,
          command: 'mcp',
          checking: true
        }
      ]
    })

    act(() => root.render(<ConnectorsPanel onNavigate={vi.fn()} />))

    expect(document.body.textContent).toContain('Checking…')
    expect(document.body.textContent).not.toContain('Connected')
  })

  it('offers sign-in again when a stored OAuth token is rejected at runtime', async () => {
    useSettingsStore.setState({
      customServers: [
        {
          id: 'expired-oauth',
          name: 'expired-oauth',
          displayName: 'Expired OAuth',
          transport: 'streamable_http',
          enabled: true,
          url: 'https://mcp.example.test',
          oauth: { hasTokens: true },
          availability: 'unauthenticated'
        }
      ]
    })
    act(() => root.render(<ConnectorsPanel onNavigate={vi.fn()} />))

    expect(document.body.textContent).toContain('Sign-in required')
    const expiredToggle = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle Expired OAuth"]'
    )
    expect(expiredToggle?.getAttribute('data-state')).toBe('checked')
    expect(expiredToggle?.getAttribute('aria-disabled')).toBeNull()
    await act(async () => clickButtonByText('Retry'))
    expect(useSettingsStore.getState().authenticateCustomServer).toHaveBeenCalledWith({
      id: 'expired-oauth'
    })
  })

  it('offers authentication setup when a remote Connector has no OAuth configuration', () => {
    const onNavigate = vi.fn()
    useSettingsStore.setState({
      customServers: [
        {
          id: 'anonymous-remote',
          name: 'anonymous-remote',
          displayName: 'Anonymous Remote',
          transport: 'streamable_http',
          enabled: true,
          url: 'https://mcp.example.test',
          availability: 'unauthenticated'
        }
      ]
    })
    act(() => root.render(<ConnectorsPanel onNavigate={onNavigate} />))

    expect(document.body.textContent).toContain('Sign-in required')
    act(() => clickButtonByText('Configure'))
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'anonymous-remote' })
  })

  it('shows a cancellable dialog while OAuth sign-in is waiting', async () => {
    const authenticateCustomServer = vi.fn(
      () =>
        new Promise<void>(() => {
          // Settled by cancellation in the main process.
        })
    )
    useSettingsStore.setState({
      authenticateCustomServer,
      cancelCustomServerAuthentication: vi.fn().mockResolvedValue(undefined),
      customServers: [
        {
          id: 'oauth-mcp',
          name: 'oauth-mcp',
          displayName: 'OAuth MCP',
          transport: 'streamable_http',
          enabled: false,
          url: 'https://mcp.example.test',
          oauth: { hasTokens: false }
        }
      ]
    })
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    clickButtonByText('Sign in')
    expect(document.body.textContent).toContain('Waiting for authorization…')
    const cancel = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Cancel'
    )
    expect(authenticateCustomServer).toHaveBeenCalledOnce()
    act(() => cancel?.click())
    expect(useSettingsStore.getState().cancelCustomServerAuthentication).toHaveBeenCalledWith({
      id: 'oauth-mcp'
    })
  })

  it('keeps OAuth errors in the retryable sign-in dialog', async () => {
    const authenticateCustomServer = vi
      .fn()
      .mockRejectedValueOnce(new Error('Authorization denied'))
      .mockReturnValueOnce(new Promise<void>(() => undefined))
    useSettingsStore.setState({
      authenticateCustomServer,
      customServers: [
        {
          id: 'oauth-mcp',
          name: 'oauth-mcp',
          displayName: 'OAuth MCP',
          transport: 'streamable_http',
          enabled: false,
          url: 'https://mcp.example.test',
          oauth: { hasTokens: false }
        }
      ]
    })
    act(() => root.render(<ConnectorsPanel onNavigate={vi.fn()} />))

    await act(async () => clickButtonByText('Sign in'))

    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Authorization denied')
    expect(document.body.textContent).toContain('Try again')
    expect(document.body.textContent).toContain('Finish later')

    clickButtonByText('Finish later')
    clickButtonByText('Sign in')

    expect(authenticateCustomServer).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain('Waiting for authorization…')
  })

  it('shows an empty-state line when there are no custom servers', () => {
    useSettingsStore.setState({ customServers: [] })
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    expect(document.body.textContent).toContain(
      'Add a custom connector to connect your own server.'
    )
  })

  it('filters groups with the source Select', () => {
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    openMenu('Filter connectors by group')
    clickItemByText('option', 'Custom')

    expect(document.body.textContent).toContain('My MCP')
    expect(document.body.textContent).not.toContain('PubMed')
    expect(document.body.textContent).not.toContain('OpenAlex')

    // Featured shows featured-group connectors but not the directory one (PubMed) or custom.
    openMenu('Filter connectors by group')
    clickItemByText('option', 'Featured')

    expect(document.body.textContent).toContain('OpenAlex')
    expect(document.body.textContent).not.toContain('PubMed')
    expect(document.body.textContent).not.toContain('My MCP')

    // Directory shows only the directory-group connector (PubMed).
    openMenu('Filter connectors by group')
    clickItemByText('option', 'Directory')

    expect(document.body.textContent).toContain('PubMed')
    expect(document.body.textContent).not.toContain('OpenAlex')
  })

  it('filters rows by the search query', () => {
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    setValue('Search connectors', 'europe')
    expect(document.body.textContent).toContain('Europe PMC')
    expect(document.body.textContent).not.toContain('PubMed')
  })

  it('navigates to the add-local flow from the Add connector dropdown', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<ConnectorsPanel onNavigate={onNavigate} />)
    })

    openDropdownByText('Add connector')
    clickItemByText('menuitem', 'Local command')
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'add', transport: 'local' })
  })
})

describe('ConnectorsPanel (contact email)', () => {
  it('opens the centralized credentials editor', () => {
    const onOpenCredentials = vi.fn()
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} onOpenCredentials={onOpenCredentials} />)
    })

    clickButtonByText('Manage credentials')

    expect(onOpenCredentials).toHaveBeenCalledOnce()
  })
})
