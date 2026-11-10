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
    setNotebookNetwork: vi.fn(async (settings) => {
      useSettingsStore.setState({ notebookNetwork: settings })
      return settings
    })
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

const hostInput = (): HTMLInputElement => container.querySelector('form input')!
it.each(['relaxed', 'strict'] as const)(
  'ends an existing %s edit when saving returns a different mode',
  async (mode) => {
    const initial = {
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      mode,
      strictWhitelist: [
        {
          id: 'strict-one',
          hostnamePattern: 'strict.local',
          protocol: 'http' as const,
          port: 80,
          origin: 'manual' as const
        }
      ],
      trustedPrivateDestinations: [
        {
          id: 'manual-one',
          hostname: 'relaxed.local',
          protocol: 'http' as const,
          port: 80,
          approvedAddresses: []
        }
      ]
    }
    const nextMode = mode === 'relaxed' ? 'strict' : 'relaxed'
    useSettingsStore.setState({
      notebookNetwork: initial,
      // The settings owner merges the edit with the other window's mode change.
      setNotebookNetwork: vi.fn(async (next) => {
        const result = { ...next, mode: nextMode }
        useSettingsStore.setState({ notebookNetwork: result })
        return result
      })
    })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await act(async () => button('Edit').click())
    await act(async () =>
      useSettingsStore.setState({ notebookNetwork: { ...initial, mode: nextMode } })
    )
    await typeInput(hostInput(), 'changed.local')
    await act(async () => button('Confirm').click())
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector(`[role="radio"][aria-checked="true"]`)?.textContent).toBe(
      nextMode === 'strict' ? 'Strict' : 'Relaxed'
    )
    const saved = useSettingsStore.getState().notebookNetwork
    if (mode === 'relaxed') expect(saved.strictWhitelist).toEqual(initial.strictWhitelist)
    else expect(saved.trustedPrivateDestinations).toEqual(initial.trustedPrivateDestinations)
  }
)

it('keeps existing edits local until confirmed and discards them on cancel', async () => {
  useSettingsStore.setState({
    notebookNetwork: {
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      trustedPrivateDestinations: [
        {
          id: 'manual-one',
          hostname: 'localhost',
          protocol: 'http',
          port: 80,
          approvedAddresses: []
        }
      ]
    }
  })
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  await act(async () => button('Edit').click())
  await typeInput(hostInput(), 'research.local')
  await act(async () => hostInput().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(
    useSettingsStore.getState().notebookNetwork.trustedPrivateDestinations?.[0]?.hostname
  ).toBe('localhost')
  expect(button('Add address').disabled).toBe(true)
  await act(async () => button('Cancel').click())
  expect(container.querySelector('form')).toBeNull()
  expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
  await act(async () => button('Edit').click())
  expect(hostInput().value).toBe('localhost')
  await typeInput(hostInput(), 'not a host')
  await act(async () => button('Confirm').click())
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
  await typeInput(hostInput(), 'research.local')
  await act(async () => button('Confirm').click())
  expect(container.querySelector('form')).toBeNull()
  expect(useSettingsStore.getState().notebookNetwork.trustedPrivateDestinations?.[0]).toMatchObject(
    { id: 'manual-one', hostname: 'research.local' }
  )
})

it('opens a form below the toolbar and immediately saves an exact address with the same Confirm button', async () => {
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  expect(container.querySelector('form')).toBeNull()
  const add = button('Add address')
  await act(async () => add.click())
  expect(button('Confirm')).toBe(add)
  expect(
    container.querySelector('form')!.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_PRECEDING
  ).toBeTruthy()
  await typeInput(hostInput(), 'localhost')
  await act(async () => button('Confirm').click())
  expect(useSettingsStore.getState().setNotebookNetwork).toHaveBeenCalledWith(
    expect.objectContaining({
      trustedPrivateDestinations: [
        expect.objectContaining({ hostname: 'localhost', protocol: 'http', port: 80 })
      ]
    }),
    [],
    [],
    undefined,
    expect.anything()
  )
  expect(container.querySelector('form')).toBeNull()
  expect(container.textContent).toContain('Manual')
  expect(container.textContent).not.toContain('Save changes')
})
it('preserves the form on save failure without exposing backend details', async () => {
  useSettingsStore.setState({
    setNotebookNetwork: vi.fn().mockRejectedValue(new Error('secret backend path'))
  })
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  await act(async () => button('Add address').click())
  await typeInput(hostInput(), 'localhost')
  await act(async () => button('Confirm').click())
  expect(container.querySelector('form')).not.toBeNull()
  expect(container.textContent).toContain('Could not save network rules.')
  expect(container.textContent).not.toContain('secret backend path')
})
it('creates a logical group and a manual strict rule without an origin field', async () => {
  useSettingsStore.setState({
    notebookNetwork: {
      ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      mode: 'strict',
      strictWhitelist: [],
      strictWhitelistGroups: []
    }
  })
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  await act(async () => button('Add rule').click())
  await typeInput(hostInput(), '*.example.org')
  const select = container.querySelector('select[aria-label="Group"]') as HTMLSelectElement
  await act(async () => {
    select.value = '__new__'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await typeInput(
    [...container.querySelectorAll('form input')].at(-1) as HTMLInputElement,
    'My research'
  )
  await act(async () => button('Confirm').click())
  const saved = useSettingsStore.getState().notebookNetwork
  expect(saved.strictWhitelistGroups?.[0]?.name).toBe('My research')
  expect(saved.strictWhitelist?.[0]).toMatchObject({
    hostnamePattern: '*.example.org',
    origin: 'manual',
    groupId: saved.strictWhitelistGroups?.[0]?.id
  })
  expect(container.textContent).not.toContain('Added from')
  expect(container.textContent).not.toContain('Restore built-ins')
})
it('shows relaxed search only above ten entries and keeps it visible while filtering', async () => {
  const rules = Array.from({ length: 11 }, (_, index) => ({
    hostname: `host${index}.example`,
    protocol: 'http' as const,
    port: 80,
    approvedAddresses: []
  }))
  useSettingsStore.setState({
    notebookNetwork: { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, trustedPrivateDestinations: rules }
  })
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  const search = container.querySelector(
    'input[aria-label="Search network addresses"]'
  ) as HTMLInputElement
  await typeInput(search, 'host10')
  expect(container.querySelector('input[aria-label="Search network addresses"]')).not.toBeNull()
  await act(async () => button('Delete').click())
  expect(container.querySelector('input[aria-label="Search network addresses"]')).toBeNull()
  expect(container.textContent).toContain('host0.example')
})
it('keeps mode explanations collapsed and guards a pending edit on leave', async () => {
  const change = vi.fn()
  await act(async () => root.render(<NotebookNetworkDomainsForm onLeaveStateChange={change} />))
  expect(container.querySelector('details')?.open).toBe(false)
  await act(async () => button('Add address').click())
  expect(change).toHaveBeenLastCalledWith({ dirty: true, busy: false })
  await act(async () => button('Cancel').click())
  expect(change).toHaveBeenLastCalledWith({ dirty: false, busy: false })
})

it('switches modes while discarding an incomplete new address', async () => {
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  await act(async () => button('Add address').click())
  await typeInput(hostInput(), 'unfinished address')
  await act(async () => button('Strict').click())
  expect(container.querySelector('form')).toBeNull()
  expect(useSettingsStore.getState().notebookNetwork.mode).toBe('strict')
  expect(useSettingsStore.getState().notebookNetwork.trustedPrivateDestinations ?? []).toEqual([])
})
