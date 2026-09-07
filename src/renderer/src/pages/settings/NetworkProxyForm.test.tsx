// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_NETWORK_PROXY_SETTINGS,
  type NetworkProxySettings
} from '../../../../shared/network-proxy'
import { createInitialSettingsState, useSettingsStore } from '../../stores/settings-store'
import { NetworkProxyForm } from './NetworkProxyForm'
import { fireEvent } from '@testing-library/react'
import { i18next } from '@/i18n'

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
    void i18next.changeLanguage('en')
  })

  it('only confirms the visible proxy that was submitted before a delayed save', async () => {
    const saved = { mode: 'manual' as const, server: 'http://proxy-a.example:8080' }
    let finish!: () => void
    const save = vi.fn<(settings: NetworkProxySettings) => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    useSettingsStore.setState({ networkProxy: saved, setNetworkProxy: save })
    act(() => root.render(<NetworkProxyForm onDone={vi.fn()} />))
    await act(async () =>
      click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!)
    )
    const input = container.querySelector<HTMLInputElement>('#network-proxy-server')!
    if (!input.disabled)
      act(() => {
        fireEvent.change(input, { target: { value: 'http://proxy-b.example:8080' } })
      })
    expect
      .soft(container.querySelector<HTMLButtonElement>('[aria-label="Proxy mode"]')!.disabled)
      .toBe(true)
    expect
      .soft(container.querySelector<HTMLInputElement>('#network-proxy-bypass')!.disabled)
      .toBe(true)
    await act(async () => finish())
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Proxy settings saved.'
    )
    expect(input.value).toBe(save.mock.calls[0]?.[0]?.server)
  })

  it('clears the saved confirmation when bypass rules are edited', async () => {
    useSettingsStore.setState({
      networkProxy: { mode: 'manual', server: 'http://proxy.example:8080' },
      setNetworkProxy: vi.fn().mockResolvedValue(undefined)
    })
    act(() => root.render(<NetworkProxyForm onDone={vi.fn()} />))
    await act(async () =>
      click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Save')!)
    )
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    act(() => {
      fireEvent.change(container.querySelector('#network-proxy-bypass')!, {
        target: { value: 'internal.example' }
      })
    })
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it.each([
    ['zh-Hans', '请输入代理服务器 URL，例如 http://127.0.0.1:1086。'],
    ['zh-Hant', '請輸入代理伺服器 URL，例如 http://127.0.0.1:1086。']
  ])('translates a blurred empty proxy server in %s', async (language, expected) => {
    await i18next.changeLanguage(language)
    useSettingsStore.setState({ networkProxy: { mode: 'manual', server: '' } })
    act(() => root.render(<NetworkProxyForm onDone={vi.fn()} />))
    act(() => {
      fireEvent.blur(container.querySelector('#network-proxy-server')!)
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected)
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
