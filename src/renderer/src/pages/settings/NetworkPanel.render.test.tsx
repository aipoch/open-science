import { useDesktopRuntimeRecoveryStore } from '@/stores/desktop-runtime-recovery-store'
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
  it('refreshes failed local interface details after backend recovery without a link change', async () => {
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })
    const getInfo = vi
      .fn()
      .mockRejectedValueOnce(new Error('bridge lost'))
      .mockResolvedValue({ connectionType: 'wifi', ipAddress: '192.0.2.10' })
    ;(window as unknown as { api: unknown }).api = { network: { getInfo } }
    await act(async () =>
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => {}} />)
    )
    expect(container.textContent).toContain('Could not load local network details.')
    await act(async () =>
      useDesktopRuntimeRecoveryStore.setState({
        epoch: useDesktopRuntimeRecoveryStore.getState().epoch + 1
      })
    )
    expect(container.textContent).toContain('192.0.2.10')
    expect(container.textContent).not.toContain('Could not load local network details.')
  })

  it('allows checking again after a successful reachability probe', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    useNetworkStore.setState({ isOnline: true, connectivity: 'reachable' })
    const checkConnectivity = vi.fn().mockResolvedValue(false)
    ;(window as unknown as { api: unknown }).api = { network: { checkConnectivity } }
    await act(async () =>
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => {}} />)
    )
    expect(container.querySelector('[aria-label="Proxy"]')?.textContent).toContain(
      'How Open-Science, ACP agents, notebook runtimes, and installers reach the internet.'
    )
    expect(buttonWithText('Check again')).not.toBeUndefined()
    await act(async () => buttonWithText('Check again').click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(container.textContent).toContain(
      'The network link is up, but package registries are unreachable.'
    )
  })
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
    for (const input of container.querySelectorAll<HTMLInputElement>('input[id^="mirror-"]')) {
      expect(input.disabled).toBe(true)
    }

    await act(async () => {
      resolveSave()
      await Promise.resolve()
    })
    expect(confirmation()).toBeNull()
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'list' })
  })

  it.each(['success', 'failure'] as const)(
    'locks mirror drafts until a pending save settles with %s',
    async (outcome) => {
      let resolveSave!: () => void
      let rejectSave!: (error: Error) => void
      const setPackageMirror = vi
        .fn<() => Promise<void>>()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve, reject) => {
              resolveSave = resolve
              rejectSave = reject
            })
        )
        .mockResolvedValue(undefined)
      const onNavigate = vi.fn()
      useSettingsStore.setState({
        packageMirror: { pypiIndex: 'https://mirror.example/original' },
        setPackageMirror
      })
      await act(async () =>
        root.render(<NetworkPanel view={{ kind: 'mirror' }} onNavigate={onNavigate} />)
      )
      const inputs = [...container.querySelectorAll<HTMLInputElement>('input[id^="mirror-"]')]
      expect(inputs).toHaveLength(3)
      const pypiInput = container.querySelector<HTMLInputElement>('#mirror-pypi-index')!
      await changeInput(pypiInput, 'https://mirror.example/submitted')
      await act(async () => buttonWithText('Save').click())

      expect(setPackageMirror).toHaveBeenCalledExactlyOnceWith({
        pypiIndex: 'https://mirror.example/submitted'
      })
      expect(inputs.every((input) => input.disabled)).toBe(true)
      expect(buttonWithText('Cancel').disabled).toBe(true)
      expect(buttonWithText('Saving…').disabled).toBe(true)
      expect(onNavigate).not.toHaveBeenCalled()

      await act(async () => {
        if (outcome === 'success') resolveSave()
        else rejectSave(new Error('Save failed'))
      })
      expect(inputs.every((input) => !input.disabled)).toBe(true)
      if (outcome === 'success') {
        expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: 'list' })
        return
      }

      expect(onNavigate).not.toHaveBeenCalled()
      expect(pypiInput.value).toBe('https://mirror.example/submitted')
      expect(container.textContent).toContain('Could not save the package mirror.')
      await changeInput(pypiInput, 'https://mirror.example/retry')
      await act(async () => buttonWithText('Save').click())
      expect(setPackageMirror).toHaveBeenLastCalledWith({
        pypiIndex: 'https://mirror.example/retry'
      })
      expect(setPackageMirror).toHaveBeenCalledTimes(2)
      expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: 'list' })
    }
  )

  it('cancels immediately when the mirror draft is clean, but confirms before discarding edits', async () => {
    const onNavigate = vi.fn()
    useSettingsStore.setState({ packageMirror: { condaChannel: 'https://mirror.example/conda' } })
    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'mirror' }} onNavigate={onNavigate} />)
      await Promise.resolve()
    })

    const discardConfirmation = (): HTMLElement | null =>
      document.body.querySelector('[data-testid="package-mirror-discard-confirmation"]')

    // Clean draft: Cancel returns to the list without asking.
    await act(async () => buttonWithText('Cancel').click())
    expect(discardConfirmation()).toBeNull()
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'list' })

    // Dirty draft: Cancel asks first; Keep editing preserves the draft.
    onNavigate.mockClear()
    await changeInput(
      container.querySelector<HTMLInputElement>('[aria-label="Conda channel mirror"]')!,
      'https://mirror.example/edited'
    )
    await act(async () => buttonWithText('Cancel').click())
    expect(onNavigate).not.toHaveBeenCalled()
    expect(discardConfirmation()?.textContent).toContain(
      'Your edits to the package mirror have not been saved. Discard them and go back?'
    )

    await act(async () => {
      discardConfirmation()?.querySelector<HTMLButtonElement>('button:first-of-type')?.click()
    })
    expect(discardConfirmation()).toBeNull()
    expect(onNavigate).not.toHaveBeenCalled()
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Conda channel mirror"]')?.value
    ).toBe('https://mirror.example/edited')

    // Confirming discards the draft and returns to the list.
    await act(async () => buttonWithText('Cancel').click())
    await act(async () => {
      discardConfirmation()?.querySelector<HTMLButtonElement>('button:last-of-type')?.click()
    })
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

    expect(container.querySelector('[aria-label="Custom public domains"]')).toBeNull()
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

  it('shows a check failure when an online retry probe rejects', async () => {
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
      'Could not check whether package registries are reachable.'
    )
    expect(buttonWithText('Check again')).not.toBeUndefined()
    expect(checkConnectivity).toHaveBeenCalledOnce()
  })

  it('reports an unavailable probe after retry instead of presenting a cached registry failure as current', async () => {
    const checkConnectivity = vi.fn().mockRejectedValue(new Error('bridge gone'))
    ;(window as unknown as { api: unknown }).api = {
      network: {
        getInfo: vi.fn().mockRejectedValue(new Error('bridge gone')),
        checkConnectivity
      }
    }
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
    useNetworkStore.setState({ isOnline: true, connectivity: 'unreachable' })

    await act(async () => {
      root.render(<NetworkPanel view={{ kind: 'list' }} onNavigate={() => {}} />)
    })
    // This reproduces both lines in the report without requiring an external network outage.
    expect(container.textContent).toContain('Could not load local network details.')
    expect(container.textContent).toContain(
      'The network link is up, but package registries are unreachable.'
    )
    await act(async () => {
      buttonWithText('Check again').click()
      await vi.advanceTimersByTimeAsync(500)
    })

    expect(checkConnectivity).toHaveBeenCalledOnce()
    expect(container.textContent).toContain(
      'Could not check whether package registries are reachable.'
    )
    expect(container.textContent).not.toContain('package registries are unreachable')
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
    expect(container.textContent).toContain('Wi-Fi / 192.168.1.42')

    await act(async () => {
      rejectFirst(new Error('stale'))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Wi-Fi / 192.168.1.42')
    expect(container.textContent).not.toContain('Could not load local network details.')
    expect(getInfo).toHaveBeenCalledTimes(2)
  })
})
