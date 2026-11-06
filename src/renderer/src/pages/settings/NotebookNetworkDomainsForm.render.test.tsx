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
  it('shows one exception list and removes Notebook public-domain controls', async () => {
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    expect(container.textContent).toContain('Trusted unsafe networks')
    expect(container.textContent).toContain('HTTPS domains are allowed without approval')
    expect(container.textContent).not.toContain('Custom public domains')
    expect(container.textContent).not.toContain('Approved network destinations')
    expect(container.querySelector('[aria-label="Domain hostname"]')).toBeNull()
    expect(container.textContent).not.toContain('Approved addresses')
  })

  it('preserves independent link-preview permissions when saving exceptions', async () => {
    const next = {
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      allowedDomains: ['preview.example'],
      disabledOpenScienceDomainGroups: ['literature' as const],
      trustedPrivateDestinations: [
        { hostname: '::1', port: 8080, protocol: 'http' as const, approvedAddresses: [] }
      ]
    }
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    act(() => useSettingsStore.setState({ notebookNetwork: next }))
    expect(container.textContent).toContain('HTTP://[::1]:8080')
    expect(container.textContent).not.toContain('preview.example')
    await act(async () => button('Save changes').click())
    expect(useSettingsStore.getState().setNotebookNetwork).toHaveBeenCalledWith(
      next,
      next.allowedDomains,
      next.trustedPrivateDestinations
    )
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
    expect(container.textContent).toContain('Allow administrator access to turn on protection.')

    await act(async () => button('Turn on').click())
    expect(install).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Status: On')
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
    await act(async () => button('Turn on').click())
    expect(container.textContent).toContain('Allow administrator access to turn on protection.')
    expect(button('Turn on')).not.toBeUndefined()
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
      container.textContent?.match(/Allow administrator access to turn on protection\./g)
    ).toHaveLength(1)
    expect(container.textContent).toContain(
      'Network port unavailable. Try turning protection on again.'
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
    await act(async () => button('Turn off').click())

    expect(remove).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Status: Off')
    expect(container.textContent).toContain('standard execution')
  })

  it('uses operation-neutral error copy when turning protection off fails', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('private backend details'))
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
    await act(async () => button('Turn off').click())

    expect(remove).toHaveBeenCalledOnce()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Network protection error'
    )
    expect(container.textContent).not.toContain('Could not turn on protection.')
    expect(container.textContent).not.toContain('private backend details')
    expect(button('Turn off').disabled).toBe(false)
  })

  it('shows translated generic copy when saving fails', async () => {
    useSettingsStore.setState({
      setNotebookNetwork: vi.fn().mockRejectedValue(new Error('C:\\private\\backend.txt'))
    })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await flush()
    await act(async () => button('Save changes').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save network rules. Reopen this page and try again.'
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
    expect(container.textContent).toContain('Downloads up to')
    await act(async () => button('Turn on').click())
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
    expect(container.textContent).not.toContain('Status: On')
    current = {
      kind: 'error',
      reason: 'runtimeFailure',
      windowsRuntimeSetup: { downloadBytes: 134781872, canCancel: false, cancelled: true }
    }
    await act(async () => finish(current))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Cancelled. Downloads are kept.'
    )
    expect(button('Try again').disabled).toBe(false)
    expect(button('Turn off').disabled).toBe(false)
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
    await act(async () => button('Turn on').click())
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    await act(async () => complete({ kind: 'ready', warnings: [] }))
    expect(container.textContent).toContain('Status: On')
    await act(async () => stale({ kind: 'checking' }))
    expect(container.textContent).toContain('Status: On')
    expect(container.textContent).not.toContain('Checking…')
  } finally {
    vi.useRealTimers()
  }
})

describe('private service draft review', () => {
  const rule = {
    hostname: 'lab.internal.example',
    port: 8443,
    protocol: 'http' as const,
    approvedAddresses: ['10.32.0.7']
  }
  const start = async (): Promise<void> => {
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await act(async () => button('Add service').click())
    await typeInput(container.querySelector('#private-hostname')!, rule.hostname)
    await typeInput(container.querySelector('#private-port')!, String(rule.port))
  }
  it('reviews the exact tuple, invalidates review after edits, and saves after confirmation', async () => {
    window.api.settings.reviewNotebookPrivateDestination = vi
      .fn()
      .mockResolvedValue({ ok: true, destination: rule })
    await start()
    expect(button('Save changes').disabled).toBe(true)
    await act(async () => button('Review service').click())
    expect(container.textContent).not.toContain('Approved addresses')
    expect(container.textContent).toContain('The rule takes effect after you save changes.')
    expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
    await typeInput(container.querySelector('#private-port')!, '443')
    expect(button('Add network exception')).toBeUndefined()
    await typeInput(container.querySelector('#private-port')!, '8443')
    await act(async () => button('Review service').click())
    await act(async () => button('Add network exception').click())
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
    expect(button('Add network exception')).toBeUndefined()
    await act(async () => button('Review service').click())
    await act(async () => button('Cancel').click())
    await act(async () => resolve({ ok: true, destination: rule }))
    expect(container.querySelector('#private-hostname')).toBeNull()
    expect(container.textContent).not.toContain('10.32.0.7')
    expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
  })
  it('replaces only the reviewed port and advances the save baseline before removing it', async () => {
    const otherPort = { ...rule, port: 443 }
    const original = {
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: [otherPort, rule]
    }
    const updatedRule = { ...rule, approvedAddresses: ['10.32.0.8'] }
    const saved = {
      ...original,
      allowedDomains: ['concurrent.example.org'],
      trustedPrivateDestinations: [otherPort, updatedRule]
    }
    const save = vi
      .fn()
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce({
        ...saved,
        trustedPrivateDestinations: [otherPort]
      })
    useSettingsStore.setState({ notebookNetwork: original, setNotebookNetwork: save })
    window.api.settings.reviewNotebookPrivateDestination = vi
      .fn()
      .mockResolvedValue({ ok: true, destination: updatedRule })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    const row = [...container.querySelectorAll('li')].find((item) =>
      item.textContent?.includes(`${rule.hostname}:${rule.port}`)
    )!
    await act(async () => row.querySelector<HTMLButtonElement>('button')!.click())
    expect(container.querySelector<HTMLInputElement>('#private-hostname')!.value).toBe(
      rule.hostname
    )
    expect(container.querySelector<HTMLInputElement>('#private-port')!.value).toBe('8443')
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((item) => !item.disabled && item.textContent?.trim() === 'Review service')!
        .click()
    )
    expect(window.api.settings.reviewNotebookPrivateDestination).toHaveBeenCalledExactlyOnceWith({
      hostname: rule.hostname,
      port: rule.port,
      protocol: 'http'
    })
    expect(save).not.toHaveBeenCalled()
    await act(async () => button('Add network exception').click())
    // A concurrent public-domain grant must not replace the editor's original baseline.
    act(() =>
      useSettingsStore.setState({
        notebookNetwork: { ...original, allowedDomains: saved.allowedDomains }
      })
    )
    await act(async () => button('Save changes').click())
    expect(save).toHaveBeenNthCalledWith(
      1,
      { ...original, trustedPrivateDestinations: [otherPort, updatedRule] },
      original.allowedDomains,
      original.trustedPrivateDestinations
    )
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          `[aria-label="Remove http://${rule.hostname}:${rule.port}"]`
        )!
        .click()
    )
    await act(async () => button('Save changes').click())
    expect(save).toHaveBeenNthCalledWith(
      2,
      { ...saved, trustedPrivateDestinations: [otherPort] },
      saved.allowedDomains,
      saved.trustedPrivateDestinations
    )
    expect(container.textContent).toContain(`${otherPort.hostname}:${otherPort.port}`)
    expect(container.textContent).not.toContain(`${rule.hostname}:${rule.port}`)
    expect(container.textContent).toContain('No unsaved changes')
  })
  it('unifies manual and persistent approval exceptions, and revokes with a current baseline', async () => {
    const grant = {
      id: 'grant-global',
      hostname: '::1',
      protocol: 'https' as const,
      port: 80,
      approvedAddresses: [],
      scope: 'project' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      recordId: 'record-1',
      createdAt: 1
    }
    const original = {
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: [rule],
      destinationGrants: [grant]
    }
    const save = vi.fn().mockResolvedValue(original)
    useSettingsStore.setState({ notebookNetwork: original, setNotebookNetwork: save })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    expect(container.textContent).toContain('HTTP://lab.internal.example:8443')
    expect(container.textContent).toContain('HTTPS://[::1]:80')
    expect(container.textContent).toContain('Project: project-1')
    expect(container.textContent).toContain('All projects')
    expect(container.textContent).not.toContain('Approved addresses')
    expect(container.textContent).not.toContain('Approved network destinations')
    expect(container.textContent).not.toContain('No trusted unsafe networks.')
    await act(async () => button('Revoke').click())
    expect(save).toHaveBeenCalledWith(
      original,
      original.allowedDomains,
      original.trustedPrivateDestinations,
      [grant.id]
    )
  })
  it('enrolls pending text, private reviews and saves in the shared leave guard', async () => {
    const change = vi.fn()
    await act(async () => root.render(<NotebookNetworkDomainsForm onLeaveStateChange={change} />))
    expect(change).toHaveBeenLastCalledWith({ dirty: false, busy: false })
    window.api.settings.reviewNotebookPrivateDestination = vi.fn()
    await act(async () => root.render(<NotebookNetworkDomainsForm onLeaveStateChange={change} />))
    await act(async () => button('Add service').click())
    await typeInput(container.querySelector('#private-hostname')!, 'pending.example')
    expect(change).toHaveBeenLastCalledWith({ dirty: true, busy: false })
    await act(async () => button('Cancel').click())
    expect(change).toHaveBeenLastCalledWith({ dirty: false, busy: false })
  })
})
