// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../../../shared/notebook-network'
import { useSettingsStore } from '@/stores/settings-store'
import { NotebookNetworkDomainsForm } from './NotebookNetworkDomainsForm'

let container: HTMLDivElement
let root: Root

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
  })
}

const button = (label: string): HTMLButtonElement =>
  [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes(label)
  ) as HTMLButtonElement

const typeInput = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useSettingsStore.setState({
    notebookNetwork: DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
    setNotebookNetwork: vi.fn(async (settings) => settings)
  })
  ;(window as unknown as { api: unknown }).api = {
    platform: 'darwin',
    settings: {
      getNotebookNetworkStatus: vi.fn().mockResolvedValue({ kind: 'ready', warnings: [] }),
      installNotebookNetwork: vi.fn(),
      removeNotebookNetwork: vi.fn()
    }
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('NotebookNetworkDomainsForm', () => {
  it('does not discard domain edits when a pending save completes', async () => {
    let finish!: (value: typeof DEFAULT_NOTEBOOK_NETWORK_SETTINGS) => void
    const save = vi.fn(
      () =>
        new Promise<typeof DEFAULT_NOTEBOOK_NETWORK_SETTINGS>((resolve) => {
          finish = resolve
        })
    )
    useSettingsStore.setState({ setNotebookNetwork: save })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await act(async () => button('Save changes').click())
    const input = container.querySelector<HTMLInputElement>('[aria-label="Domain hostname"]')!
    if (!input.disabled) {
      await typeInput(input, 'during-save.example.org')
      await act(async () => button('Add').click())
    }
    const before = container.querySelector('[aria-label="Custom public domains"]')!.textContent
    await act(async () => finish(DEFAULT_NOTEBOOK_NETWORK_SETTINGS))
    expect(container.querySelector('[aria-label="Custom public domains"]')!.textContent).toBe(
      before
    )
    expect(input.disabled).toBe(false)
  })

  it('disables every domain editor while saving and clears success after another edit', async () => {
    let finish!: (value: typeof DEFAULT_NOTEBOOK_NETWORK_SETTINGS) => void
    const saved = { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, allowedDomains: ['existing.example.org'] }
    useSettingsStore.setState({
      notebookNetwork: saved,
      setNotebookNetwork: vi.fn(
        () =>
          new Promise<typeof DEFAULT_NOTEBOOK_NETWORK_SETTINGS>((resolve) => {
            finish = resolve
          })
      )
    })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await typeInput(container.querySelector('input')!, 'next.example.org')
    await act(async () => button('Add to list').click())
    await act(async () => button('Save changes').click())
    const controls = container.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      '[aria-label="Built-in services"] button, [aria-label="Custom public domains"] button, input'
    )
    expect
      .soft(
        [...controls]
          .filter((control) => !control.disabled)
          .map((control) => control.getAttribute('aria-label') ?? control.textContent)
      )
      .toEqual([])
    await act(async () => finish(saved))
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    await typeInput(container.querySelector('input')!, 'another.example.org')
    await act(async () => button('Add to list').click())
    expect(container.textContent).not.toContain('Network rules saved.')
  })
  it('locks package registries and validates, adds, removes, and saves custom domains', async () => {
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()

    const packageGroup = container.querySelector(
      '[aria-label="Automatic access for Package registries and source code"]'
    ) as HTMLButtonElement
    expect(packageGroup.disabled).toBe(true)
    expect(
      (container.querySelector('[aria-label="Automatic access for pypi.org"]') as HTMLButtonElement)
        .disabled
    ).toBe(true)

    const input = container.querySelector('[aria-label="Domain hostname"]') as HTMLInputElement
    await typeInput(input, 'https://data.example.org/path')
    await act(async () => button('Add').click())
    expect(container.textContent).toContain(
      'Enter an exact hostname without a scheme, path, port, wildcard, or IP address.'
    )

    await typeInput(input, 'data.example.org')
    await act(async () => button('Add').click())
    expect(container.textContent).toContain('data.example.org')

    await act(async () => button('Save changes').click())
    expect(useSettingsStore.getState().setNotebookNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDomains: ['data.example.org'] }),
      [],
      []
    )
  })

  it('keeps a domain approved while the settings form was open', async () => {
    const save = vi.fn(async (settings: typeof DEFAULT_NOTEBOOK_NETWORK_SETTINGS) => ({
      ...settings,
      allowedDomains: ['approved.example.org']
    }))
    useSettingsStore.setState({ setNotebookNetwork: save })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()

    await act(async () => button('Save changes').click())

    expect(save).toHaveBeenCalledWith(DEFAULT_NOTEBOOK_NETWORK_SETTINGS, [], [])
    expect(container.textContent).toContain('approved.example.org')
  })

  it('shows localized status codes and applies successful Windows setup status', async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'setupRequired',
        platform: 'win32',
        reasons: ['windowsProfileMissing']
      })
      .mockResolvedValueOnce({ kind: 'ready', warnings: [] })
    const install = vi.fn().mockResolvedValue({ kind: 'ready', warnings: [] })
    ;(window as unknown as { api: unknown }).api = {
      platform: 'win32',
      settings: {
        getNotebookNetworkStatus: getStatus,
        installNotebookNetwork: install,
        removeNotebookNetwork: vi.fn()
      }
    }

    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()
    expect(container.textContent).toContain('The Windows sandbox needs administrator setup.')

    await act(async () => button('Set up').click())
    expect(install).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Status: Active')
  })

  it('keeps setup available when the Windows UAC prompt is cancelled', async () => {
    const setupRequired = {
      kind: 'setupRequired' as const,
      platform: 'win32' as const,
      reasons: ['windowsOwnershipMissing' as const]
    }
    ;(window as unknown as { api: unknown }).api = {
      platform: 'win32',
      settings: {
        getNotebookNetworkStatus: vi.fn().mockResolvedValue(setupRequired),
        installNotebookNetwork: vi.fn().mockResolvedValue(setupRequired),
        removeNotebookNetwork: vi.fn()
      }
    }

    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()
    await act(async () => button('Set up').click())
    expect(container.textContent).toContain('The Windows sandbox needs administrator setup.')
    expect(button('Set up')).not.toBeUndefined()
  })

  it('shows each Windows setup explanation only once', async () => {
    ;(window as unknown as { api: unknown }).api = {
      platform: 'win32',
      settings: {
        getNotebookNetworkStatus: vi.fn().mockResolvedValue({
          kind: 'setupRequired',
          platform: 'win32',
          reasons: [
            'windowsProfileMissing',
            'windowsLoopbackMissing',
            'windowsNetworkFenceMissing',
            'windowsOwnershipMissing',
            'windowsGatewayPortUnavailable'
          ]
        }),
        installNotebookNetwork: vi.fn(),
        removeNotebookNetwork: vi.fn()
      }
    }

    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()

    expect(
      container.textContent?.match(/The Windows sandbox needs administrator setup\./g)
    ).toHaveLength(1)
    expect(container.textContent).toContain(
      'The Windows sandbox gateway port is unavailable. Set up the sandbox again.'
    )
  })

  it('returns to standard execution after removing Windows protection', async () => {
    const notSetUp = {
      kind: 'setupRequired' as const,
      platform: 'win32' as const,
      reasons: ['windowsProfileMissing' as const]
    }
    const remove = vi.fn().mockResolvedValue(notSetUp)
    ;(window as unknown as { api: unknown }).api = {
      platform: 'win32',
      settings: {
        getNotebookNetworkStatus: vi.fn().mockResolvedValue({ kind: 'ready', warnings: [] }),
        installNotebookNetwork: vi.fn(),
        removeNotebookNetwork: remove
      }
    }

    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()
    await act(async () => button('Remove…').click())

    expect(remove).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Status: Not set up')
    expect(container.textContent).toContain('standard execution')
  })

  it('shows translated generic copy when saving fails', async () => {
    useSettingsStore.setState({
      setNotebookNetwork: vi.fn().mockRejectedValue(new Error('C:\\private\\backend.txt'))
    })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()
    await act(async () => button('Save changes').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save network rules. Reopen this page if another window changed them, or review changed private addresses again.'
    )
    expect(container.textContent).not.toContain('backend.txt')
  })

  it('does not expose backend error prose', async () => {
    ;(window as unknown as { api: unknown }).api = {
      platform: 'darwin',
      settings: {
        getNotebookNetworkStatus: vi.fn().mockRejectedValue(new Error('secret backend path')),
        installNotebookNetwork: vi.fn(),
        removeNotebookNetwork: vi.fn()
      }
    }
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()
    expect(container.textContent).toContain('Could not check Notebook network protection.')
    expect(container.textContent).not.toContain('secret backend path')
  })
})

it('shows the download estimate, progress and cancellation without reporting success early', async () => {
  vi.useFakeTimers()
  let finish!: (value: unknown) => void
  let current: unknown = {
    kind: 'setupRequired',
    platform: 'win32',
    reasons: [],
    windowsRuntimeSetup: { downloadBytes: 134781872, canCancel: false, cancelled: false }
  }
  const install = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const cancel = vi.fn(async () => true)
  Object.assign(window.api, {
    platform: 'win32',
    settings: {
      getNotebookNetworkStatus: vi.fn(async () => current),
      installNotebookNetwork: install,
      cancelNotebookNetworkSetup: cancel
    }
  })
  try {
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    expect(container.textContent).toContain('Missing components may download up to')
    await act(async () => button('Set up').click())
    expect(button('Cancel').disabled).toBe(true)
    current = {
      kind: 'checking',
      runtimePreparation: {
        component: 'node',
        phase: 'downloading',
        download: {
          phase: 'downloading',
          transferred: 50,
          total: 100,
          percent: 50,
          bytesPerSecond: 10,
          attempt: 1
        }
      },
      windowsRuntimeSetup: { downloadBytes: 134781872, canCancel: true, cancelled: false }
    }
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(
      '50'
    )
    await act(async () => button('Cancel').click())
    expect(cancel).toHaveBeenCalledOnce()
    expect(button('Cancelling…').disabled).toBe(true)
    expect(container.textContent).not.toContain('Status: Active')
    current = {
      kind: 'error',
      reason: 'runtimeFailure',
      windowsRuntimeSetup: { downloadBytes: 134781872, canCancel: false, cancelled: true }
    }
    await act(async () => finish(current))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Preparation cancelled'
    )
    expect(button('Try again').disabled).toBe(false)
    expect(button('Remove…').disabled).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

it('restores preparation progress when settings reopens and shows safe failure guidance', async () => {
  vi.useFakeTimers()
  let current: unknown = {
    kind: 'checking',
    runtimePreparation: { component: 'powershell', phase: 'verifying' },
    windowsRuntimeSetup: { downloadBytes: 100, canCancel: true, cancelled: false }
  }
  Object.assign(window.api, {
    platform: 'win32',
    settings: { getNotebookNetworkStatus: vi.fn(async () => current) }
  })
  try {
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    expect(container.textContent).toContain('Verifying PowerShell')
    current = {
      kind: 'error',
      reason: 'runtimeFailure',
      windowsRuntimeSetup: {
        downloadBytes: 100,
        canCancel: false,
        cancelled: false,
        failure: { component: 'powershell', phase: 'verifying' }
      }
    }
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not prepare PowerShell'
    )
    expect(button('Try again').disabled).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})

it('does not replace completed setup with a late preparation status response', async () => {
  vi.useFakeTimers()
  let complete!: (status: unknown) => void
  let stale!: (status: unknown) => void
  const getStatus = vi
    .fn()
    .mockResolvedValueOnce({ kind: 'setupRequired', platform: 'win32', reasons: [] })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          stale = resolve
        })
    )
  Object.assign(window.api, {
    platform: 'win32',
    settings: {
      getNotebookNetworkStatus: getStatus,
      installNotebookNetwork: vi.fn(
        () =>
          new Promise((resolve) => {
            complete = resolve
          })
      )
    }
  })
  try {
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await act(async () => button('Set up').click())
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    await act(async () => complete({ kind: 'ready', warnings: [] }))
    expect(container.textContent).toContain('Status: Active')
    await act(async () => stale({ kind: 'checking' }))
    expect(container.textContent).toContain('Status: Active')
    expect(container.textContent).not.toContain('Checking…')
  } finally {
    vi.useRealTimers()
  }
})

describe('private service draft review', () => {
  const rule = { hostname: 'lab.internal.example', port: 8443, approvedAddresses: ['10.32.0.7'] }
  const start = async (): Promise<void> => {
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await act(async () => button('Add service').click())
    await typeInput(container.querySelector('#private-hostname')!, rule.hostname)
    await typeInput(container.querySelector('#private-port')!, String(rule.port))
  }
  it('requires reviewed addresses, invalidates review after edits, and only saves after confirmation', async () => {
    window.api.settings.reviewNotebookPrivateDestination = vi
      .fn()
      .mockResolvedValue({ ok: true, destination: rule })
    await start()
    expect(button('Save changes').disabled).toBe(true)
    await act(async () => button('Review service').click())
    expect(container.textContent).toContain('10.32.0.7')
    expect(container.textContent).toContain('across all projects')
    expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
    await typeInput(container.querySelector('#private-port')!, '443')
    expect(button('Add to trusted services')).toBeUndefined()
    await typeInput(container.querySelector('#private-port')!, '8443')
    await act(async () => button('Review service').click())
    await act(async () => button('Add to trusted services').click())
    expect(button('Save changes').disabled).toBe(false)
    await act(async () => button('Save changes').click())
    expect(useSettingsStore.getState().setNotebookNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ trustedPrivateDestinations: [rule] }),
      [],
      []
    )
  })
  it('ignores late review responses after input changes or cancellation', async () => {
    let resolve!: (value: { ok: true; destination: typeof rule }) => void
    window.api.settings.reviewNotebookPrivateDestination = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await start()
    await act(async () => button('Review service').click())
    await typeInput(container.querySelector('#private-hostname')!, 'other.internal.example')
    await act(async () => resolve({ ok: true, destination: rule }))
    expect(button('Add to trusted services')).toBeUndefined()
    await act(async () => button('Review service').click())
    await act(async () => button('Cancel').click())
    await act(async () => resolve({ ok: true, destination: rule }))
    expect(container.querySelector('#private-hostname')).toBeNull()
    expect(container.textContent).not.toContain('10.32.0.7')
    expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
  })
  it('enrolls pending text, private reviews and saves in the shared leave guard', async () => {
    const change = vi.fn()
    await act(async () => root.render(<NotebookNetworkDomainsForm onLeaveStateChange={change} />))
    expect(change).toHaveBeenLastCalledWith({ dirty: false, busy: false })
    await typeInput(container.querySelector('input')!, 'pending.example')
    expect(change).toHaveBeenLastCalledWith({ dirty: true, busy: false })
    await act(async () => button('Cancel').click())
    expect(change).toHaveBeenLastCalledWith({ dirty: false, busy: false })
  })
})
