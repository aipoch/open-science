// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'
import { CredentialsPanel } from './CredentialsPanel'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    customServers: [
      {
        id: 'custom-search',
        name: 'custom-search',
        displayName: 'Custom Search',
        transport: 'streamable_http',
        enabled: true,
        url: 'https://mcp.example.test',
        hasHeaders: true
      }
    ],
    loadConnectors: vi.fn().mockResolvedValue(undefined)
  })
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getGitHubTokenStatus: vi.fn().mockResolvedValue({ configured: false })
    }
  }
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

describe('CredentialsPanel', () => {
  it('lists device credentials and opens their shared credential editor', async () => {
    const onNavigate = vi.fn()
    useSettingsStore.setState({
      deviceCredentials: [
        {
          id: 'credential-1',
          displayName: 'Lab OAuth',
          kind: 'oauth',
          status: 'connected',
          resourceUri: 'https://mcp.example.test/',
          transport: 'streamable_http',
          consumerCount: 1,
          consumerNames: ['Custom Search'],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      loadDeviceCredentials: vi.fn().mockResolvedValue(undefined)
    })

    await act(async () => {
      root.render(
        <CredentialsPanel
          view={{ kind: 'list' }}
          onNavigate={onNavigate}
          onOpenConnector={vi.fn()}
          onOpenProvider={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    const label = Array.from(document.body.querySelectorAll<HTMLParagraphElement>('p')).find(
      (element) => element.textContent === 'Lab OAuth'
    )
    const row = label?.parentElement?.parentElement
    act(() =>
      Array.from(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])
        .find((button) => button.textContent === 'Manage')
        ?.click()
    )

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'credential', id: 'credential-1' })
    const remove = row?.querySelector<HTMLButtonElement>('[aria-label="Remove Lab OAuth"]')
    expect(remove?.disabled).toBe(false)
    expect(remove?.getAttribute('aria-disabled')).toBe('true')
  })

  it('aggregates service credentials and links custom MCP secrets to their owner', async () => {
    const onOpenConnector = vi.fn()
    await act(async () => {
      root.render(
        <CredentialsPanel
          view={{ kind: 'list' }}
          onNavigate={vi.fn()}
          onOpenConnector={onOpenConnector}
          onOpenProvider={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Services')
    expect(document.body.textContent).toContain('GitHub')
    expect(document.body.textContent).toContain('Literature access')
    expect(document.body.textContent).toContain('OpenAlex')
    expect(document.body.textContent).toContain('Custom Search')
    expect(document.body.textContent).toContain('Credential fields configured')

    const customLabel = Array.from(document.body.querySelectorAll<HTMLParagraphElement>('p')).find(
      (element) => element.textContent === 'Custom Search'
    )
    const customRow = customLabel?.parentElement?.parentElement
    act(() => customRow?.querySelector<HTMLButtonElement>('button')?.click())
    expect(onOpenConnector).toHaveBeenCalledWith('custom-search')
  })

  it('keeps credential drafts isolated between service forms', async () => {
    const props = {
      onNavigate: vi.fn(),
      onOpenConnector: vi.fn(),
      onOpenProvider: vi.fn()
    }
    await act(async () => {
      root.render(<CredentialsPanel {...props} view={{ kind: 'service', serviceId: 'openalex' }} />)
      await Promise.resolve()
    })
    const openAlexField = document.body.querySelector<HTMLInputElement>('#service-api-key')!
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: vi.fn(() => 'openalex-secret'), setData: vi.fn() }
    })
    act(() => openAlexField.dispatchEvent(paste))
    expect(openAlexField.value).not.toBe('')

    act(() =>
      root.render(
        <CredentialsPanel {...props} view={{ kind: 'service', serviceId: 'literature' }} />
      )
    )

    expect(document.body.querySelector<HTMLInputElement>('#service-api-key')?.value).toBe('')
  })

  it('keeps desktop-only service credentials unavailable and hides Connector credentials on remote Web', async () => {
    window.api.settings.getGitHubTokenStatus = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'This action is only available in the local desktop app (settings:get-github-token-status).'
        )
      )
    const props = {
      onNavigate: vi.fn(),
      onOpenConnector: vi.fn(),
      onOpenProvider: vi.fn()
    }

    await act(async () => {
      root.render(<CredentialsPanel {...props} view={{ kind: 'list' }} />)
      await Promise.resolve()
    })

    const desktopOnlyButtons = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).filter((button) => button.textContent === 'Desktop only')
    expect(desktopOnlyButtons).toHaveLength(2)
    expect(desktopOnlyButtons.every((button) => button.disabled)).toBe(true)
    expect(
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Connect' && !button.disabled
      )
    ).toBeDefined()
    expect(document.body.textContent).not.toContain('Connector credentials')
    expect(document.body.textContent).not.toContain('New credential')

    act(() =>
      root.render(<CredentialsPanel {...props} view={{ kind: 'service', serviceId: 'openalex' }} />)
    )

    expect(document.body.textContent).toContain(
      'This credential can only be configured in the local desktop app.'
    )
    expect(document.body.querySelector('#service-api-key')).toBeNull()

    act(() => root.render(<CredentialsPanel {...props} view={{ kind: 'create' }} />))
    expect(document.body.textContent).toContain(
      'This credential can only be configured in the local desktop app.'
    )
  })

  it('removes a stored NCBI key without clearing the contact email', async () => {
    const setNcbiCredentials = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      ncbi: { contactEmail: 'science@example.test', hasApiKey: true },
      setNcbiCredentials
    })

    await act(async () => {
      root.render(
        <CredentialsPanel
          view={{ kind: 'service', serviceId: 'literature' }}
          onNavigate={vi.fn()}
          onOpenConnector={vi.fn()}
          onOpenProvider={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    const removeButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent === 'Remove key')
    await act(async () => removeButton?.click())

    expect(setNcbiCredentials).toHaveBeenCalledWith({
      contactEmail: 'science@example.test',
      apiKey: ''
    })
  })
})
