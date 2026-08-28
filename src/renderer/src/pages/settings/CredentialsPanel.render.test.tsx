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

  it('keeps credential drafts isolated between service forms', () => {
    const props = {
      onNavigate: vi.fn(),
      onOpenConnector: vi.fn(),
      onOpenProvider: vi.fn()
    }
    act(() =>
      root.render(<CredentialsPanel {...props} view={{ kind: 'service', serviceId: 'openalex' }} />)
    )
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
})
