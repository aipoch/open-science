// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConnectorDetailView as ConnectorDetail } from '../../../../shared/settings'
import { ConnectorDetailView } from './ConnectorDetailView'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root

const detail: ConnectorDetail = {
  id: 'ensembl',
  displayName: 'Ensembl',
  description: 'Query the Ensembl genome database.',
  sources: ['Ensembl'],
  requiresNcbi: false,
  enabled: true,
  autoAllow: false,
  group: 'featured',
  useWhen: 'Use when exploring genes.',
  termsUrl: 'https://example.com/terms',
  tools: [
    {
      id: 'ensembl/lookup_gene',
      method: 'lookup_gene',
      description: 'Look up a gene.',
      permission: 'allow'
    },
    {
      id: 'ensembl/list_species',
      method: 'list_species',
      description: 'List species.',
      permission: 'block'
    }
  ]
}

// The refreshed detail returned by setToolPermission after flipping lookup_gene to block.
const updatedDetail: ConnectorDetail = {
  ...detail,
  tools: [{ ...detail.tools[0], permission: 'block' }, detail.tools[1]]
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    settings: { getConnectorDetail: vi.fn().mockResolvedValue(detail) }
  }
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    setConnectorEnabled: vi.fn().mockResolvedValue(undefined),
    setConnectorAutoAllow: vi.fn().mockResolvedValue(undefined),
    setToolPermission: vi.fn().mockResolvedValue(updatedDetail)
  })
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

const render = async (): Promise<void> => {
  await act(async () => {
    root.render(<ConnectorDetailView id="ensembl" />)
  })
  // Let the getConnectorDetail promise resolve and re-render with the tools.
  await act(async () => {
    await Promise.resolve()
  })
}

// Finds the Block segment button within a specific tool's permission control.
const blockSegment = (method: string): HTMLButtonElement | null => {
  const group = document.body.querySelector<HTMLElement>(
    `[role="radiogroup"][aria-label="Permission for ${method}"]`
  )
  return group?.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Block"]') ?? null
}

describe('ConnectorDetailView', () => {
  it('renders the connector name and a permission control per tool', async () => {
    await render()

    expect(document.body.textContent).toContain('Ensembl')
    expect(document.body.textContent).toContain('lookup_gene')
    expect(document.body.textContent).toContain('list_species')

    // One radiogroup (ToolPermissionControl) per tool.
    expect(document.body.querySelectorAll('[role="radiogroup"]')).toHaveLength(2)
  })

  it('expands a tool row to reveal its description', async () => {
    await render()

    // Collapsed by default: the tool's description is not shown.
    expect(document.body.textContent).not.toContain('Look up a gene.')

    const toolButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')
    ).find((button) => button.textContent?.includes('lookup_gene'))
    expect(toolButton).not.toBeUndefined()

    await act(async () => {
      toolButton?.click()
    })

    expect(document.body.textContent).toContain('Look up a gene.')
  })

  it('persists a tool permission change when Block is clicked on the allow-tool', async () => {
    await render()

    await act(async () => {
      blockSegment('lookup_gene')?.click()
    })

    expect(useSettingsStore.getState().setToolPermission).toHaveBeenCalledWith(
      'ensembl/lookup_gene',
      'block'
    )
  })

  it('toggles the connector from the header switch and skip-approvals row', async () => {
    await render()

    const switches = document.body.querySelectorAll<HTMLButtonElement>('[role="switch"]')
    // First switch is the header enable toggle; second is the skip-approvals toggle.
    act(() => switches[0]?.click())
    expect(useSettingsStore.getState().setConnectorEnabled).toHaveBeenCalledWith('ensembl', false)

    act(() => switches[1]?.click())
    expect(useSettingsStore.getState().setConnectorAutoAllow).toHaveBeenCalledWith('ensembl', true)
  })

  it('tracks live store state so the header toggle flips both directions', async () => {
    // Seed the connectors list as ConnectorsPanel.loadConnectors would; the header switch must read
    // this reconciled state, not the one-time detail fetch, or it sticks and only fires one way.
    useSettingsStore.setState({
      connectors: [
        {
          id: 'ensembl',
          displayName: 'Ensembl',
          description: 'Query the Ensembl genome database.',
          sources: ['Ensembl'],
          requiresNcbi: false,
          enabled: true,
          autoAllow: false,
          group: 'featured'
        }
      ]
    })
    await render()

    const header = (): HTMLButtonElement =>
      document.body.querySelectorAll<HTMLButtonElement>('[role="switch"]')[0]

    expect(header().getAttribute('aria-checked')).toBe('true')
    act(() => header().click())
    expect(useSettingsStore.getState().setConnectorEnabled).toHaveBeenLastCalledWith(
      'ensembl',
      false
    )

    // Simulate the store reconciling to disabled after the mutation.
    act(() =>
      useSettingsStore.setState((state) => ({
        connectors: state.connectors.map((c) => ({ ...c, enabled: false }))
      }))
    )

    // The header now reflects OFF, and clicking re-enables (would still send `false` if it read the
    // stale detail).
    expect(header().getAttribute('aria-checked')).toBe('false')
    act(() => header().click())
    expect(useSettingsStore.getState().setConnectorEnabled).toHaveBeenLastCalledWith(
      'ensembl',
      true
    )
  })
})
