// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectorsPanel } from './ConnectorsPanel'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'

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

  it('orders the group filter before search and keeps the narrow toolbar contained', () => {
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    const toolbar = document.body.querySelector<HTMLElement>('[data-testid="connectors-toolbar"]')
    const search = document.body.querySelector<HTMLInputElement>('[aria-label="Search connectors"]')
    const filter = document.body.querySelector<HTMLElement>(
      '[aria-label="Filter connectors by group"]'
    )
    const addConnector = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.includes('Add connector'))

    expect(toolbar?.className).toContain('grid-cols-[9rem_minmax(0,1fr)]')
    expect(toolbar?.className).toContain('sm:grid-cols-[9rem_minmax(0,1fr)_auto]')
    expect(filter?.compareDocumentPosition(search!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(search?.compareDocumentPosition(addConnector!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(search?.parentElement?.className).toContain('min-w-0')
    expect(search?.parentElement?.className).toContain('sm:col-start-2')
    expect(filter?.className).toContain('w-full')
    expect(addConnector?.className).toContain('col-span-2')
    expect(addConnector?.className).toContain('w-full')
  })

  it('toggles a featured connector and navigates to its detail on row click', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<ConnectorsPanel onNavigate={onNavigate} />)
    })

    act(() => document.body.querySelector<HTMLButtonElement>('[aria-label="PubMed"]')?.click())
    expect(useSettingsStore.getState().setConnectorEnabled).toHaveBeenCalledWith('pubmed', false)

    const row = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('PubMed')
    )
    act(() => row?.click())
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'detail', id: 'pubmed' })
  })

  it('warns about affected Specialists before removing a custom server', async () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<ConnectorsPanel onNavigate={onNavigate} />)
    })

    act(() => document.body.querySelector<HTMLButtonElement>('[aria-label="My MCP"]')?.click())
    expect(useSettingsStore.getState().setCustomServerEnabled).toHaveBeenCalledWith(
      'custom-server-uuid',
      false
    )

    const edit = document.body.querySelector<HTMLButtonElement>('[aria-label="Edit My MCP"]')
    const exportButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Export My MCP"]'
    )
    const remove = document.body.querySelector<HTMLButtonElement>('[aria-label="Remove My MCP"]')
    expect(edit?.getAttribute('data-slot')).toBe('button')
    expect(exportButton?.getAttribute('data-slot')).toBe('button')
    expect(remove?.getAttribute('data-slot')).toBe('button')
    expect(edit?.getAttribute('data-size')).toBe('icon-sm')
    expect(remove?.getAttribute('data-size')).toBe('icon-sm')
    expect(edit?.getAttribute('data-state')).toBe('closed')
    expect(remove?.getAttribute('data-state')).toBe('closed')

    act(() => exportButton?.click())
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'export', id: 'custom-server-uuid' })

    await act(async () => {
      remove?.click()
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

  it('offers validated configuration import from the Add connector menu', () => {
    const onNavigate = vi.fn()
    act(() => {
      root.render(<ConnectorsPanel onNavigate={onNavigate} />)
    })

    openDropdownByText('Add connector')
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
    const waitingToggle = document.body.querySelector<HTMLButtonElement>('[aria-label="OAuth MCP"]')
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
            oauth: { hasTokens: true }
          }
        ]
      })
    })
    expect(document.body.textContent).toContain('Connected')
    const connectedToggle = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="OAuth MCP"]'
    )
    expect(connectedToggle?.disabled).toBe(false)
    expect(connectedToggle?.getAttribute('aria-disabled')).toBeNull()
    expect(connectedToggle?.getAttribute('data-state')).toBe('checked')

    const connectedStatus = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.trim() === 'Connected')
    expect(connectedStatus?.disabled).toBe(true)
    act(() => connectedStatus?.click())
    expect(useSettingsStore.getState().authenticateCustomServer).toHaveBeenCalledTimes(1)
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

    const edit = document.body.querySelector<HTMLButtonElement>('[aria-label="Edit Invalid MCP"]')
    act(() => edit?.click())
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'edit', id: 'invalid-mcp' })
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
      '[aria-label="Expired OAuth"]'
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

  it('keeps a waiting OAuth sign-in disabled until it settles', async () => {
    let finishAuthentication!: () => void
    const authenticateCustomServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishAuthentication = resolve
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
    const connecting = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'Connecting…'
    )
    expect(connecting?.disabled).toBe(true)
    expect(document.body.textContent).not.toContain('Cancel')
    act(() => connecting?.click())
    expect(authenticateCustomServer).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().cancelCustomServerAuthentication).not.toHaveBeenCalled()

    await act(async () => finishAuthentication())
  })

  it('keeps concurrent OAuth sign-ins independently disabled', async () => {
    const finishAuthentications = new Map<string, () => void>()
    const authenticateCustomServer = vi.fn(
      ({ id }: { id: string }) =>
        new Promise<void>((resolve) => {
          finishAuthentications.set(id, resolve)
        })
    )
    useSettingsStore.setState({
      authenticateCustomServer,
      customServers: [
        {
          id: 'oauth-a',
          name: 'oauth-a',
          displayName: 'OAuth A',
          transport: 'streamable_http',
          enabled: false,
          url: 'https://a.example.test',
          oauth: { hasTokens: false }
        },
        {
          id: 'oauth-b',
          name: 'oauth-b',
          displayName: 'OAuth B',
          transport: 'streamable_http',
          enabled: false,
          url: 'https://b.example.test',
          oauth: { hasTokens: false }
        }
      ]
    })
    act(() => root.render(<ConnectorsPanel onNavigate={vi.fn()} />))
    const row = (name: string): HTMLLIElement | undefined =>
      Array.from(document.body.querySelectorAll<HTMLLIElement>('li')).find((item) =>
        item.textContent?.includes(name)
      )
    const clickRowAction = (name: string, action: string): void => {
      const button = Array.from(
        row(name)?.querySelectorAll<HTMLButtonElement>('button') ?? []
      ).find((candidate) => candidate.textContent?.trim() === action)
      button?.click()
    }

    act(() => clickRowAction('OAuth A', 'Sign in'))
    act(() => clickRowAction('OAuth B', 'Sign in'))
    expect(row('OAuth A')?.textContent).toContain('Connecting…')
    expect(row('OAuth B')?.textContent).toContain('Connecting…')

    await act(async () => finishAuthentications.get('oauth-a')?.())
    expect(row('OAuth A')?.textContent).toContain('Sign in')
    expect(row('OAuth B')?.textContent).toContain('Connecting…')

    await act(async () => finishAuthentications.get('oauth-b')?.())
  })

  it('uses the Settings danger banner for OAuth errors', async () => {
    useSettingsStore.setState({
      authenticateCustomServer: vi.fn().mockRejectedValue(new Error('Authorization denied')),
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
    expect(alert?.className).toContain('border-danger-000/30')
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
  it('saves the entered contact email on Edit then Save', () => {
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    clickButtonByText('Edit')
    setValue('Contact email', 'me@example.com')
    clickButtonByText('Save')

    expect(useSettingsStore.getState().setNcbiCredentials).toHaveBeenCalledWith({
      contactEmail: 'me@example.com',
      apiKey: undefined
    })
  })
})
