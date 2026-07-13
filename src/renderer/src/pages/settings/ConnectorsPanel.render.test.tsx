// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectorsPanel } from './ConnectorsPanel'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

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
    id: 'my-mcp',
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
    setCustomServerEnabled: vi.fn().mockResolvedValue(undefined),
    removeCustomServer: vi.fn().mockResolvedValue(undefined)
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

  it('renders a custom server that can be toggled and removed', () => {
    act(() => {
      root.render(<ConnectorsPanel onNavigate={vi.fn()} />)
    })

    act(() => document.body.querySelector<HTMLButtonElement>('[aria-label="My MCP"]')?.click())
    expect(useSettingsStore.getState().setCustomServerEnabled).toHaveBeenCalledWith('my-mcp', false)

    act(() =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="Remove My MCP"]')?.click()
    )
    expect(useSettingsStore.getState().removeCustomServer).toHaveBeenCalledWith('my-mcp')
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
