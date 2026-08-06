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
    slug: 'my-mcp',
    name: 'My MCP',
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
    expect(document.body.textContent).toContain('This Connector is used by 4 Specialists')
    expect(document.body.textContent).toContain('Selected by legacy UUID')
    expect(document.body.textContent).toContain('Selected by ID')
    expect(document.body.textContent).toContain('Selected by legacy name')
    expect(document.body.textContent).toContain('Full access')

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
          slug: 'oauth-mcp',
          name: 'OAuth MCP',
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
    expect(waitingToggle?.disabled).toBe(true)
    expect(waitingToggle?.getAttribute('data-state')).toBe('unchecked')

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
            slug: 'oauth-mcp',
            name: 'OAuth MCP',
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
    expect(connectedToggle?.getAttribute('data-state')).toBe('checked')
  })

  it('cancels a waiting OAuth sign-in and allows retry', async () => {
    const rejectAuthentications: Array<(error: Error) => void> = []
    const authenticateCustomServer = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAuthentications.push(reject)
        })
    )
    useSettingsStore.setState({
      authenticateCustomServer,
      cancelCustomServerAuthentication: vi.fn().mockResolvedValue(undefined),
      customServers: [
        {
          id: 'oauth-mcp',
          slug: 'oauth-mcp',
          name: 'OAuth MCP',
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
    expect(document.body.textContent).toContain('Cancel')

    await act(async () => clickButtonByText('Cancel'))

    expect(useSettingsStore.getState().cancelCustomServerAuthentication).toHaveBeenCalledWith({
      id: 'oauth-mcp'
    })
    expect(document.body.textContent).toContain('Sign in')

    clickButtonByText('Sign in')
    expect(authenticateCustomServer).toHaveBeenCalledTimes(2)

    await act(async () => rejectAuthentications[0](new Error('Authorization denied')))
    expect(document.body.textContent).not.toContain('Authorization denied')
    expect(useSettingsStore.getState().loadConnectors).toHaveBeenCalledTimes(2)
  })

  it('keeps independent cancel controls for concurrent OAuth sign-ins', async () => {
    const rejectAuthentications = new Map<string, (error: Error) => void>()
    const authenticateCustomServer = vi.fn(
      ({ id }: { id: string }) =>
        new Promise<void>((_resolve, reject) => {
          rejectAuthentications.set(id, reject)
        })
    )
    const cancelCustomServerAuthentication = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      authenticateCustomServer,
      cancelCustomServerAuthentication,
      customServers: [
        {
          id: 'oauth-a',
          slug: 'oauth-a',
          name: 'OAuth A',
          transport: 'streamable_http',
          enabled: false,
          url: 'https://a.example.test',
          oauth: { hasTokens: false }
        },
        {
          id: 'oauth-b',
          slug: 'oauth-b',
          name: 'OAuth B',
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
    expect(row('OAuth A')?.textContent).toContain('Cancel')
    expect(row('OAuth B')?.textContent).toContain('Cancel')

    await act(async () => clickRowAction('OAuth A', 'Cancel'))
    expect(cancelCustomServerAuthentication).toHaveBeenCalledWith({ id: 'oauth-a' })
    expect(row('OAuth A')?.textContent).toContain('Sign in')
    expect(row('OAuth B')?.textContent).toContain('Cancel')

    await act(async () => rejectAuthentications.get('oauth-a')?.(new Error('cancelled')))
    await act(async () => clickRowAction('OAuth B', 'Cancel'))
    await act(async () => rejectAuthentications.get('oauth-b')?.(new Error('cancelled')))
  })

  it('uses the Settings danger banner for OAuth errors', async () => {
    useSettingsStore.setState({
      authenticateCustomServer: vi.fn().mockRejectedValue(new Error('Authorization denied')),
      customServers: [
        {
          id: 'oauth-mcp',
          slug: 'oauth-mcp',
          name: 'OAuth MCP',
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
