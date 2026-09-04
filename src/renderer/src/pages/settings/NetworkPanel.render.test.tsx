// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { NetworkPanel } from './NetworkPanel'
import { useNetworkStore } from '@/stores/network-store'
import { createInitialSettingsState, useSettingsStore } from '@/stores/settings-store'

let container: HTMLDivElement
let root: Root
const originalSetPackageMirror = useSettingsStore.getState().setPackageMirror

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true })
  useNetworkStore.setState({ isOnline: false, connectivity: 'unreachable' })
  useSettingsStore.setState({
    ...createInitialSettingsState(),
    setPackageMirror: originalSetPackageMirror
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
  useNetworkStore.setState({ isOnline: true, connectivity: 'unknown' })
})

const buttonWithText = (text: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(text)
  ) as HTMLButtonElement

const changeInput = async (input: HTMLInputElement, value: string): Promise<void> => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('NetworkPanel offline retry', () => {
  it('confirms a CA bundle change and shows progress while saving', async () => {
    let resolveSave!: () => void
    const setPackageMirror = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve
        })
    )
    const onNavigate = vi.fn()
    useSettingsStore.setState({
      packageMirror: { caBundle: '/certs/old.pem' },
      setPackageMirror
    })
    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'mirror' }} onNavigate={onNavigate} />)
      await Promise.resolve()
    })

    await changeInput(
      container.querySelector<HTMLInputElement>('[aria-label="CA bundle path"]')!,
      '/certs/new.pem'
    )
    await act(async () => buttonWithText('Save').click())

    const confirmation = (): HTMLElement | null =>
      document.body.querySelector('[data-testid="package-mirror-confirmation"]')
    expect(confirmation()?.textContent).toContain(
      'Changing the CA bundle will stop active Notebook kernels. Continue?'
    )
    expect(setPackageMirror).not.toHaveBeenCalled()

    await act(async () => {
      confirmation()?.querySelector<HTMLButtonElement>('button:first-of-type')?.click()
    })
    expect(confirmation()).toBeNull()
    expect(setPackageMirror).not.toHaveBeenCalled()

    await act(async () => buttonWithText('Save').click())
    await act(async () => {
      confirmation()?.querySelector<HTMLButtonElement>('button:last-of-type')?.click()
      await Promise.resolve()
    })
    expect(setPackageMirror).toHaveBeenCalledWith({ caBundle: '/certs/new.pem' })
    expect(confirmation()?.textContent).toContain('Saving…')
    expect(confirmation()?.querySelector<HTMLButtonElement>('button:last-of-type')?.disabled).toBe(
      true
    )

    await act(async () => {
      resolveSave()
      await Promise.resolve()
    })
    expect(confirmation()).toBeNull()
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'list' })
  })

  it('hides unavailable Notebook network controls and falls back from the domains view', async () => {
    const onNavigate = vi.fn()
    await act(async () => {
      root.render(
        <NetworkPanel
          view={{ kind: 'list' }}
          onNavigate={onNavigate}
          notebookNetworkAvailable={false}
        />
      )
    })

    expect(container.querySelector('[aria-label="Notebook network access"]')).toBeNull()

    await act(async () => {
      root.render(
        <NetworkPanel
          view={{ kind: 'domains' }}
          onNavigate={onNavigate}
          notebookNetworkAvailable={false}
        />
      )
    })

    expect(container.querySelector('[aria-label="Allowed domains"]')).toBeNull()
    expect(container.querySelector('[aria-label="Network status"]')).not.toBeNull()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('shows a retry action for a failed cold-start probe', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    useNetworkStore.setState({ isOnline: true, connectivity: 'probe-failed' })

    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => {}} />)
    })

    expect(container.textContent).toContain(
      'Could not check whether package registries are reachable.'
    )
    expect(buttonWithText('Check again')).not.toBeUndefined()
    expect(container.textContent).not.toContain('Checking…')
  })

  it('holds a checking state for at least 500ms when Check again is clicked while offline', async () => {
    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => {}} />)
    })
    expect(container.textContent).toContain('This machine is offline.')

    await act(async () => {
      buttonWithText('Check again').click()
    })
    expect(container.textContent).toContain('Checking…')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(499)
    })
    expect(container.textContent).toContain('Checking…')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(container.textContent).toContain('This machine is offline.')
  })

  it('restores the last known status when an online retry probe rejects', async () => {
    const checkConnectivity = vi.fn().mockRejectedValue(new Error('bridge gone'))
    ;(window as unknown as { api: unknown }).api = {
      network: {
        getInfo: vi.fn().mockResolvedValue({ connectionType: 'wifi', ipAddress: '192.168.1.42' }),
        checkConnectivity
      }
    }
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })

    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => {}} />)
    })
    expect(container.textContent).toContain(
      'The network link is up, but package registries are unreachable.'
    )

    await act(async () => {
      buttonWithText('Check again').click()
    })
    expect(container.textContent).toContain('Checking…')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(container.textContent).toContain(
      'The network link is up, but package registries are unreachable.'
    )
    expect(buttonWithText('Check again')).not.toBeUndefined()
    expect(checkConnectivity).toHaveBeenCalledOnce()
  })

  it('shows an explicit error when local network info cannot be loaded', async () => {
    const getInfo = vi.fn().mockRejectedValue(new Error('ipc down'))
    ;(window as unknown as { api: unknown }).api = {
      network: {
        getInfo,
        checkConnectivity: vi.fn().mockResolvedValue(true)
      }
    }
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })

    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => {}} />)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Could not load local network details.')
    expect(container.textContent).toContain('Package registries are reachable.')
    expect(getInfo).toHaveBeenCalledOnce()
  })

  it('uses a neutral icon when the local connection type is unknown', async () => {
    ;(window as unknown as { api: unknown }).api = {
      network: {
        getInfo: vi.fn().mockResolvedValue({
          connectionType: 'unknown',
          ipAddress: '10.8.0.2'
        }),
        checkConnectivity: vi.fn().mockResolvedValue(true)
      }
    }
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })

    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => {}} />)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('10.8.0.2')
    expect(container.querySelector('.lucide-network')).not.toBeNull()
    expect(container.querySelector('.lucide-wifi')).toBeNull()
    expect(container.querySelector('.lucide-ethernet-port')).toBeNull()
  })

  it('does not let a stale getInfo rejection overwrite a newer success', async () => {
    let rejectFirst!: (reason: Error) => void
    const firstResult = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject
    })
    const getInfo = vi
      .fn()
      .mockReturnValueOnce(firstResult)
      .mockResolvedValueOnce({ connectionType: 'wifi', ipAddress: '192.168.1.42' })
    ;(window as unknown as { api: unknown }).api = {
      network: {
        getInfo,
        checkConnectivity: vi.fn().mockResolvedValue(true)
      }
    }
    const noop = (): void => {}
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })

    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={noop} />)
    })
    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'mirror' }} onNavigate={noop} />)
    })
    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={noop} />)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Wi-Fi · 192.168.1.42')

    await act(async () => {
      rejectFirst(new Error('stale'))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Wi-Fi · 192.168.1.42')
    expect(container.textContent).not.toContain('Could not load local network details.')
    expect(getInfo).toHaveBeenCalledTimes(2)
  })
})
