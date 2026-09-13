// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type { SpecialistListItem } from '../../../../shared/specialist'
import { ConnectorBulkManageView } from './ConnectorBulkManageView'
import { clickRadixMenuItem, openRadixMenu } from './test-utils'

let container: HTMLDivElement
let root: Root

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => undefined

const specialist: SpecialistListItem = {
  kind: 'custom',
  id: 'researcher',
  name: 'Researcher',
  description: '',
  systemPrompt: '',
  enabled: true,
  capabilityMode: 'selected',
  revision: 1,
  selectedCapabilities: { skillIds: [], connectorIds: ['local'], connectorTools: [] },
  fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] }
}

beforeEach(() => {
  Object.assign(window, {
    api: {
      platform: 'darwin',
      specialist: {
        list: vi.fn(async () => ({
          items: useSpecialistStore.getState().items,
          integrity: useSpecialistStore.getState().integrity
        }))
      },
      settings: {
        listConnectors: vi.fn(async () => ({
          connectors: useSettingsStore.getState().connectors,
          customServers: useSettingsStore.getState().customServers,
          reservedCustomServerIds: useSettingsStore.getState().reservedCustomServerIds,
          ncbi: { hasApiKey: false },
          openAlex: { hasApiKey: false }
        }))
      }
    }
  })
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    connectors: [
      {
        id: 'pubmed',
        name: 'pubmed',
        displayName: 'PubMed',
        description: 'Literature',
        sources: [],
        requiresNcbi: false,
        enabled: true,
        autoAllow: true,
        group: 'featured'
      },
      {
        id: 'openalex',
        name: 'openalex',
        displayName: 'OpenAlex',
        description: 'Research',
        sources: [],
        requiresNcbi: false,
        enabled: false,
        autoAllow: false,
        group: 'directory'
      }
    ],
    customServers: [
      {
        id: 'local',
        name: 'local',
        displayName: 'Local tools',
        enabled: true,
        transport: 'stdio',
        command: 'node'
      },
      {
        id: 'oauth',
        name: 'oauth',
        displayName: 'Sign-in tools',
        enabled: false,
        transport: 'streamable_http',
        oauth: { hasTokens: false, hasClientSecret: false }
      }
    ],
    loadConnectors: vi.fn().mockResolvedValue(undefined),
    setConnectorEnabled: vi.fn(async (id, enabled) => {
      useSettingsStore.setState((state) => ({
        connectors: state.connectors.map((item) => (item.id === id ? { ...item, enabled } : item))
      }))
    }),
    setCustomServerEnabled: vi.fn(async (id, enabled) => {
      useSettingsStore.setState((state) => ({
        customServers: state.customServers.map((item) =>
          item.id === id ? { ...item, enabled } : item
        )
      }))
    }),
    setConnectorAutoAllow: vi.fn(),
    removeCustomServer: vi.fn(async (id) => {
      useSettingsStore.setState((state) => ({
        customServers: state.customServers.filter((item) => item.id !== id)
      }))
    })
  })
  useSpecialistStore.setState({
    items: [],
    isLoaded: true,
    integrity: { status: 'ok' },
    loadError: undefined,
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
const render = async (): Promise<void> => {
  await act(async () => root.render(<ConnectorBulkManageView />))
}
const button = (label: string): HTMLButtonElement => {
  const result = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.trim() === label
  )
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
const select = (label: string): void => {
  const input = document.body.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
  if (!input) throw new Error(`Missing checkbox: ${label}`)
  act(() => input.click())
}
const search = (value: string): void => {
  const input = document.body.querySelector<HTMLInputElement>(
    '[aria-label="Search manageable connectors"]'
  )
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      value
    )
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const filter = (kind: 'group' | 'status', option: string): void => {
  openRadixMenu(
    document.body.querySelector<HTMLElement>(
      `[aria-label="Filter manageable connectors by ${kind}"]`
    )
  )
  clickRadixMenuItem(
    Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent === option
    )
  )
}
const rows = (): string[] =>
  Array.from(document.body.querySelectorAll('[data-slot="bulk-connector-row"]')).map(
    (item) => item.textContent ?? ''
  )

describe('ConnectorBulkManageView', () => {
  it('selects only filtered results and preserves selection across group and status filters', async () => {
    await render()
    filter('group', 'Custom')
    filter('status', 'Enabled')
    expect(rows()).toHaveLength(1)
    select('Select all results')
    filter('group', 'All groups')
    filter('status', 'Any status')
    search('PubMed')
    select('Select all results')
    expect(button('Selected (2)')).toBeDefined()
    await act(async () => button('Selected (2)').click())
    expect(rows()).toHaveLength(2)
    // Select all in selected-only mode acts on those visible rows, not a hidden old search.
    select('Select all results')
    expect(button('Selected (0)').disabled).toBe(true)
  })

  it('disables mixed resources and enables eligible targets without changing approvals', async () => {
    await render()
    select('Select all results')
    await act(async () => button('Disable selected (4)').click())
    expect(useSettingsStore.getState().setConnectorEnabled).toHaveBeenCalledWith('pubmed', false)
    expect(useSettingsStore.getState().setCustomServerEnabled).toHaveBeenCalledWith('local', false)
    await act(async () => button('Enable selected (4)').click())
    expect(useSettingsStore.getState().setConnectorEnabled).toHaveBeenCalledWith('openalex', true)
    expect(useSettingsStore.getState().setCustomServerEnabled).not.toHaveBeenCalledWith(
      'oauth',
      true
    )
    expect(document.body.textContent).toContain('Updated: 3 / 4')
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Sign-in tools')
    expect(rows()).toHaveLength(1)
    expect(button('Selected (1)')).toBeDefined()
    expect(useSettingsStore.getState().setConnectorAutoAllow).not.toHaveBeenCalled()
  })

  it('keeps failed writes selected for retry and does not duplicate an in-flight batch', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const update = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockRejectedValueOnce(new Error('write failed'))
    useSettingsStore.setState({ setConnectorEnabled: update })
    await render()
    select('Select PubMed')
    select('Select Local tools')
    const disable = button('Disable selected (2)')
    await act(async () => {
      disable.click()
      disable.click()
    })
    expect(update).toHaveBeenCalledTimes(1)
    expect(
      document.body.querySelector<HTMLInputElement>('[aria-label="Search manageable connectors"]')
        ?.disabled
    ).toBe(true)
    await act(async () => finish())
    expect(useSettingsStore.getState().setCustomServerEnabled).toHaveBeenCalledTimes(1)
    await act(async () => button('Disable selected (2)').click())
    expect(button('Selected (1)')).toBeDefined()
    expect(rows()[0]).toContain('PubMed')
  })

  it('requires successful catalog loading before allowing mutations and supports retry', async () => {
    useSettingsStore.setState({
      loadConnectors: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(undefined)
    })
    await render()
    expect(document.body.querySelector('[aria-label="Bulk Connector controls"]')).toBeNull()
    await act(async () => button('Retry').click())
    expect(rows()).toHaveLength(4)
  })

  it('previews protected bundled and Specialist-used resources and only deletes reviewed custom targets', async () => {
    useSpecialistStore.setState({ items: [specialist] })
    await render()
    select('Select all results')
    await act(async () => button('Delete selected (4)').click())
    expect(window.api.specialist.list).toHaveBeenCalledTimes(1)
    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('3 protected Connectors will be kept.')
    expect(dialog?.textContent).toContain('Researcher')
    expect(useSettingsStore.getState().removeCustomServer).not.toHaveBeenCalled()
    await act(async () => button('Delete 1 Connector').click())
    expect(useSettingsStore.getState().removeCustomServer).toHaveBeenCalledExactlyOnceWith('oauth')
    expect(document.body.textContent).toContain('Deleted: 1 / 1')
    expect(useSettingsStore.getState().customServers.some((item) => item.id === 'local')).toBe(true)
  })

  it('keeps newly referenced resources after the preview and retains removal failures', async () => {
    await render()
    select('Select Local tools')
    select('Select Sign-in tools')
    await act(async () => button('Delete selected (2)').click())
    vi.mocked(window.api.specialist.list).mockResolvedValue({
      items: [specialist],
      integrity: { status: 'ok' }
    })
    const remove = vi.fn().mockRejectedValue(new Error('cleanup failed'))
    useSettingsStore.setState({ removeCustomServer: remove })
    await act(async () => button('Delete 2 Connectors').click())
    expect(remove).toHaveBeenCalledExactlyOnceWith('oauth')
    expect(document.body.textContent).toContain('Deleted: 0 / 2')
    expect(document.body.textContent).toContain('Local tools')
    expect(document.body.textContent).toContain(
      'Deletion or cleanup did not finish for: Sign-in tools'
    )
    expect(button('Selected (2)')).toBeDefined()
  })

  it.each(['load failure', 'degraded catalog', 'unavailable API'])(
    'fails closed before deletion on %s',
    async (failure) => {
      if (failure === 'load failure')
        vi.mocked(window.api.specialist.list).mockRejectedValue(new Error('offline'))
      if (failure === 'degraded catalog')
        useSpecialistStore.setState({
          integrity: { status: 'degraded', issues: [] }
        })
      if (failure === 'unavailable API') Object.assign(window, { api: { platform: 'darwin' } })
      await render()
      select('Select Local tools')
      await act(async () => button('Delete selected (1)').click())
      expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
      expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
        'Could not check Specialist usage'
      )
      expect(useSettingsStore.getState().removeCustomServer).not.toHaveBeenCalled()
    }
  )

  it('retries journaled cleanup even after the deleted configuration disappears from the catalog', async () => {
    const remove = vi
      .fn()
      .mockImplementationOnce(async (id: string) => {
        useSettingsStore.setState((state) => ({
          customServers: state.customServers.filter((item) => item.id !== id),
          reservedCustomServerIds: [id]
        }))
        throw new Error('permission cleanup failed after persistence')
      })
      .mockImplementationOnce(async () => {
        useSettingsStore.setState({ reservedCustomServerIds: [] })
      })
    useSettingsStore.setState({ removeCustomServer: remove })
    await render()
    select('Select Local tools')
    await act(async () => button('Delete selected (1)').click())
    await act(async () => button('Delete 1 Connector').click())
    expect(document.body.textContent).toContain(
      'Deletion or cleanup did not finish for: Local tools'
    )
    expect(button('Selected (0)').disabled).toBe(true)
    await act(async () => button('Retry cleanup').click())
    expect(remove).toHaveBeenNthCalledWith(2, 'local')
    expect(document.body.textContent).not.toContain('Deletion or cleanup did not finish')
  })

  it('does not use cleanup retry to delete a surviving or recreated configuration', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('write failed'))
    useSettingsStore.setState({ removeCustomServer: remove })
    await render()
    select('Select Local tools')
    await act(async () => button('Delete selected (1)').click())
    await act(async () => button('Delete 1 Connector').click())
    await act(async () => button('Retry cleanup').click())
    expect(remove).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('Review their usage and try again.')
    expect(button('Selected (1)')).toBeDefined()
  })

  it('uses the requested usage snapshot even when a concurrent store refresh leaves stale items', async () => {
    await render()
    select('Select Local tools')
    await act(async () => button('Delete selected (1)').click())
    // A newer catalog refresh may supersede a store load while leaving its old items published.
    useSpecialistStore.setState({
      items: [],
      load: vi.fn(() => new Promise<void>(() => undefined))
    })
    vi.mocked(window.api.specialist.list).mockResolvedValue({
      items: [specialist],
      integrity: { status: 'ok' }
    })
    await act(async () => button('Delete 1 Connector').click())
    expect(useSettingsStore.getState().removeCustomServer).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('These Connectors were not deleted: Local tools')
  })

  it('does not remove anything when usage refresh fails after confirmation', async () => {
    await render()
    select('Select Local tools')
    await act(async () => button('Delete selected (1)').click())
    vi.mocked(window.api.specialist.list).mockRejectedValue(new Error('offline'))
    await act(async () => button('Delete 1 Connector').click())
    expect(useSettingsStore.getState().removeCustomServer).not.toHaveBeenCalled()
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not check Specialist usage'
    )
  })
})
