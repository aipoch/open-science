// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_NETWORK_PROXY_SETTINGS } from '../../../../shared/network-proxy'
import { createInitialSettingsState, useSettingsStore } from '../../stores/settings-store'
import { NetworkProxyForm } from './NetworkProxyForm'

let container: HTMLDivElement
let root: Root

const click = (element: Element | null): void => {
  if (!(element instanceof HTMLElement)) throw new Error('Expected a clickable element.')
  element.click()
}

describe('NetworkProxyForm', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    useSettingsStore.setState({
      ...createInitialSettingsState(),
      networkProxy: DEFAULT_NETWORK_PROXY_SETTINGS
    })
    ;(window as unknown as { api: unknown }).api = {
      settings: { setNetworkProxy: vi.fn().mockResolvedValue({ mode: 'direct' }) }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('renders System as the historical default and explains process lifecycle', () => {
    act(() => root.render(<NetworkProxyForm onDone={vi.fn()} />))

    expect(container.textContent).toContain('System')
    expect(container.textContent).toContain('Agent processes inherit only the proxy environment')
    expect(container.textContent).toContain('Existing agent sessions')
    expect(container.textContent).toContain('New requests and processes use the saved setting.')
  })

  it('shows the proxy URL example before the field is blurred', () => {
    useSettingsStore.setState({
      networkProxy: { mode: 'manual', server: '' }
    })

    act(() => root.render(<NetworkProxyForm onDone={vi.fn()} />))

    expect(container.querySelector('#network-proxy-server-help')?.textContent).toBe(
      'Example: http://127.0.0.1:1086'
    )
  })

  it('surfaces a rejected save without leaving the form', async () => {
    const failure = new Error('Could not apply the proxy configuration.')
    const setNetworkProxy = vi.fn().mockRejectedValue(failure)
    ;(window as unknown as { api: { settings: { setNetworkProxy: typeof setNetworkProxy } } }).api =
      {
        settings: { setNetworkProxy }
      }
    useSettingsStore.setState({ setNetworkProxy: async (settings) => setNetworkProxy(settings) })
    act(() => root.render(<NetworkProxyForm onDone={vi.fn()} />))

    await act(async () =>
      click(
        [...container.querySelectorAll('button')].find((button) => button.textContent === 'Save') ??
          null
      )
    )

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(failure.message)
  })

  it('invokes Done without mutating settings', () => {
    const onDone = vi.fn()
    act(() => root.render(<NetworkProxyForm onDone={onDone} />))

    act(() =>
      click(
        [...container.querySelectorAll('button')].find((button) => button.textContent === 'Done') ??
          null
      )
    )

    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
