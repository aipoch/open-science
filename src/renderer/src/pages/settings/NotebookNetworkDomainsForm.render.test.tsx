// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../../../shared/notebook-network'
import type { NotebookNetworkSettings } from '../../../../shared/notebook-network-settings'
import { useSettingsStore } from '@/stores/settings-store'
import { NotebookNetworkDomainsForm } from './NotebookNetworkDomainsForm'

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => undefined

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
  const selectOption = async (label: string, value: string): Promise<void> => {
    const trigger = container.querySelector<HTMLButtonElement>(
      `[role="combobox"][aria-label="${label}"]`
    )!
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    )
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === value
    )!
    await act(async () => option.click())
  }
  await selectOption('Network protocol', 'HTTP')
  await selectOption('Group', 'New group…')
  await typeInput(
    [...container.querySelectorAll('form input')].at(-1) as HTMLInputElement,
    'My research'
  )
  await act(async () => button('Confirm').click())
  const saved = useSettingsStore.getState().notebookNetwork
  expect(saved.strictWhitelistGroups?.[0]?.name).toBe('My research')
  expect(saved.strictWhitelist?.[0]).toMatchObject({
    hostnamePattern: '*.example.org',
    protocol: 'http',
    port: 80,
    origin: 'manual',
    groupId: saved.strictWhitelistGroups?.[0]?.id
  })
  expect(container.textContent).not.toContain('Added from')
  expect(container.textContent).not.toContain('Restore built-ins')
})
const deleteConfirmation = (): HTMLElement | null =>
  document.body.querySelector('[role="dialog"][aria-label="Delete address?"]')
const confirmationButton = (label: string): HTMLButtonElement =>
  [...deleteConfirmation()!.querySelectorAll('button')].find((item) => item.textContent === label)!

it.each(['project', 'global'] as const)(
  'requires confirmation before revoking a %s agent grant',
  async (scope) => {
    const grant = {
      id: 'agent-grant',
      hostname: 'research.local',
      protocol: 'http' as const,
      port: 80,
      approvedAddresses: [],
      scope,
      projectId: 'project-one',
      sessionId: 'session-one',
      recordId: 'record-one',
      createdAt: 1
    }
    useSettingsStore.setState({
      notebookNetwork: { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, destinationGrants: [grant] },
      setNotebookNetwork: vi.fn(
        async (next: NotebookNetworkSettings, _domains, _trusted, revoked) => {
          const saved = {
            ...next,
            destinationGrants: (next.destinationGrants ?? []).map((item) =>
              revoked?.includes(item.id) ? { ...item, revokedAt: 2 } : item
            )
          }
          useSettingsStore.setState({ notebookNetwork: saved })
          return saved
        }
      )
    })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    const trigger = button('Revoke')
    await act(async () => trigger.click())
    expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
    const dialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]')
    expect(dialog()?.textContent).toContain('http://research.local:80')
    const action = (label: string): HTMLButtonElement =>
      [...dialog()!.querySelectorAll('button')].find((item) => item.textContent === label)!
    await act(async () => action('Cancel').click())
    expect(dialog()).toBeNull()
    expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
    await act(async () => trigger.click())
    await act(async () => action('Revoke').click())
    expect(dialog()).toBeNull()
    expect(useSettingsStore.getState().notebookNetwork.destinationGrants?.[0].revokedAt).toBe(2)
    expect(container.textContent).not.toContain('research.local')
    expect(useSettingsStore.getState().setNotebookNetwork).toHaveBeenCalledOnce()
  }
)

it.each(['relaxed', 'strict'] as const)(
  'restores keyboard focus after cancelling and saving a %s address edit',
  async (mode) => {
    useSettingsStore.setState({
      notebookNetwork: {
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        mode,
        strictWhitelist: [
          {
            id: 'one',
            hostnamePattern: 'research.local',
            protocol: 'http',
            port: 80,
            origin: 'manual'
          }
        ],
        trustedPrivateDestinations: [
          {
            id: 'one',
            hostname: 'research.local',
            protocol: 'http',
            port: 80,
            approvedAddresses: []
          }
        ]
      }
    })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    if (mode === 'strict') {
      const group = container.querySelector('section details') as HTMLDetailsElement
      group.open = true
    }
    await act(async () => button('Edit').click())
    button('Cancel').focus()
    await act(async () => button('Cancel').click())
    const add = (): HTMLButtonElement => button(mode === 'strict' ? 'Add rule' : 'Add address')
    expect(document.activeElement).toBe(add())
    await act(async () => button('Edit').click())
    await typeInput(hostInput(), 'changed.local')
    button('Confirm').focus()
    await act(async () => button('Confirm').click())
    expect(container.querySelector('form')).toBeNull()
    expect(document.activeElement).toBe(add())
    expect(container.textContent).toContain('changed.local')
  }
)

it.each(['relaxed', 'strict'] as const)(
  'requires confirmation before deleting a %s address',
  async (mode) => {
    useSettingsStore.setState({
      notebookNetwork: {
        ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
        mode,
        strictWhitelist: [
          {
            id: 'one',
            hostnamePattern: 'research.local',
            protocol: 'http',
            port: 80,
            origin: 'manual'
          }
        ],
        trustedPrivateDestinations: [
          {
            id: 'one',
            hostname: 'research.local',
            protocol: 'http',
            port: 80,
            approvedAddresses: []
          }
        ]
      }
    })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await act(async () => button('Delete').click())
    expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
    expect(deleteConfirmation()?.textContent).toContain('http://research.local:80')
    await act(async () => confirmationButton('Cancel').click())
    expect(deleteConfirmation()).toBeNull()
    expect(container.textContent).toContain('research.local')
    await act(async () => button('Delete').click())
    await act(async () => confirmationButton('Delete').click())
    expect(deleteConfirmation()).toBeNull()
    const saved = useSettingsStore.getState().notebookNetwork
    expect(mode === 'strict' ? saved.strictWhitelist : saved.trustedPrivateDestinations).toEqual([])
  }
)

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
  await act(async () => confirmationButton('Delete').click())
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
  expect(hostInput().value).toBe('unfinished address')
  expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
  await act(async () => button('Switch to Strict mode').click())
  expect(container.querySelector('form')).toBeNull()
  expect(useSettingsStore.getState().notebookNetwork.mode).toBe('strict')
  expect(useSettingsStore.getState().notebookNetwork.trustedPrivateDestinations ?? []).toEqual([])
})

const modeRadio = (mode: string): HTMLButtonElement =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (element) => element.textContent === mode
  )!
const modePanel = (): HTMLElement | null =>
  container.querySelector('[aria-label="Confirm network mode change"]')
const key = async (element: Element, value: string): Promise<void> => {
  await act(async () =>
    element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))
  )
}

it.each([
  [
    'relaxed',
    'Strict',
    'Trusted unsafe networks',
    'Strict mode uses a whitelist. Connections outside it will be blocked without requesting authorization.'
  ],
  ['strict', 'Relaxed', 'Strict whitelist', 'Network access will expand.']
] as const)(
  'requires a separate confirmation from %s mode and retains the active list',
  async (mode, target, list, impact) => {
    useSettingsStore.setState({ notebookNetwork: { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, mode } })
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await act(async () => modeRadio(target).click())
    expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
    expect(container.querySelector(`[aria-label="${list}"]`)).not.toBeNull()
    expect(modePanel()?.textContent).toContain(impact)
    expect(modePanel()?.textContent).toContain('Not yet applied')
    expect(container.textContent).toContain(
      mode === 'relaxed' ? 'Current: Relaxed' : 'Current: Strict'
    )
    await act(async () => button(`Switch to ${target} mode`).click())
    expect(useSettingsStore.getState().setNotebookNetwork).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().notebookNetwork.mode).toBe(target.toLowerCase())
    expect(modePanel()).toBeNull()
  }
)

it.each(['cancel', 'escape', 'active'] as const)(
  'preserves address drafts when cancelling with %s',
  async (method) => {
    await act(async () => root.render(<NotebookNetworkDomainsForm />))
    await act(async () => button('Add address').click())
    await typeInput(hostInput(), 'draft.local')
    await act(async () => modeRadio('Strict').click())
    expect(hostInput().value).toBe('draft.local')
    if (method === 'cancel') await act(async () => modePanel()!.querySelector('button')!.click())
    if (method === 'escape') await key(modeRadio('Strict'), 'Escape')
    if (method === 'active') await act(async () => modeRadio('Relaxed').click())
    expect(modePanel()).toBeNull()
    expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
    expect(hostInput().value).toBe('draft.local')
    expect(document.activeElement).toBe(modeRadio('Relaxed'))
  }
)

it('keeps failed mode changes pending and retries only on explicit confirmation', async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error('private backend details'))
    .mockImplementation(async (next) => {
      useSettingsStore.setState({ notebookNetwork: next })
      return next
    })
  useSettingsStore.setState({ setNotebookNetwork: save })
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  await act(async () => modeRadio('Strict').click())
  await act(async () => button('Switch to Strict mode').click())
  expect(container.textContent).toContain('Current: Relaxed')
  expect(modePanel()?.querySelector('[role="alert"]')).not.toBeNull()
  expect(container.textContent).not.toContain('private backend details')
  expect(save).toHaveBeenCalledOnce()
  await act(async () => button('Switch to Strict mode').click())
  expect(save).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('Current: Strict')
})

it('blocks duplicate confirmations and keeps the old mode until the save resolves', async () => {
  let finish!: (value: typeof DEFAULT_NOTEBOOK_NETWORK_SETTINGS) => void
  const save = vi.fn(
    () =>
      new Promise<typeof DEFAULT_NOTEBOOK_NETWORK_SETTINGS>((resolve) => {
        finish = resolve
      })
  )
  useSettingsStore.setState({ setNotebookNetwork: save })
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  await act(async () => modeRadio('Strict').click())
  await act(async () => {
    button('Switch to Strict mode').click()
    button('Switch to Strict mode').click()
  })
  expect(save).toHaveBeenCalledOnce()
  expect(modeRadio('Relaxed').disabled).toBe(true)
  expect(modePanel()?.textContent).toContain('Switching…')
  expect(container.textContent).toContain('Current: Relaxed')
  await key(modeRadio('Strict'), 'Escape')
  expect(modePanel()).not.toBeNull()
  const result = { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, mode: 'strict' as const }
  await act(async () => {
    useSettingsStore.setState({ notebookNetwork: result })
    finish(result)
  })
  expect(modePanel()).toBeNull()
  expect(container.textContent).toContain('Current: Strict')
})

it('invalidates pending confirmation when another window changes the mode', async () => {
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  await act(async () => modeRadio('Strict').click())
  await act(async () =>
    useSettingsStore.setState({
      notebookNetwork: { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, mode: 'strict' }
    })
  )
  expect(modePanel()).toBeNull()
  expect(container.textContent).toContain('Current: Strict')
  expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
})

it('confirms against the latest unrelated rule updates without including address drafts', async () => {
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  await act(async () => button('Add address').click())
  await typeInput(hostInput(), 'unsaved.local')
  await act(async () => modeRadio('Strict').click())
  const latest = { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, allowedDomains: ['other.example'] }
  await act(async () => useSettingsStore.setState({ notebookNetwork: latest }))
  await act(async () => button('Switch to Strict mode').click())
  const save = vi.mocked(useSettingsStore.getState().setNotebookNetwork)
  expect(save.mock.calls[0][4]).toBe(latest)
  expect(save.mock.calls[0][0].allowedDomains).toEqual(['other.example'])
  expect(save.mock.calls[0][0].trustedPrivateDestinations ?? []).toEqual([])
})

it('keyboard selection only stages a mode and does not create an extra leave guard', async () => {
  const leave = vi.fn()
  await act(async () => root.render(<NotebookNetworkDomainsForm onLeaveStateChange={leave} />))
  await key(modeRadio('Relaxed'), 'End')
  expect(modePanel()).not.toBeNull()
  expect(document.activeElement).toBe(modeRadio('Strict'))
  await key(modeRadio('Strict'), 'Home')
  expect(modePanel()).toBeNull()
  await key(modeRadio('Relaxed'), 'ArrowRight')
  expect(modePanel()).not.toBeNull()
  expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
  expect(leave).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: false, busy: false }))
})

it('invalidates both a pending switch and its old-mode editor after an external mode change', async () => {
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  await act(async () => button('Add address').click())
  await typeInput(hostInput(), 'draft.local')
  await act(async () => modeRadio('Strict').click())
  await act(async () =>
    useSettingsStore.setState({
      notebookNetwork: { ...DEFAULT_NOTEBOOK_NETWORK_SETTINGS, mode: 'strict' }
    })
  )
  expect(modePanel()).toBeNull()
  expect(container.querySelector('form')).toBeNull()
  expect(container.querySelector('[aria-label="Strict whitelist"]')).not.toBeNull()
  expect(useSettingsStore.getState().setNotebookNetwork).not.toHaveBeenCalled()
})

it('uses the authoritative returned mode even when it differs from the requested mode', async () => {
  const save = vi.fn(async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS)
  useSettingsStore.setState({ setNotebookNetwork: save })
  await act(async () => root.render(<NotebookNetworkDomainsForm />))
  await act(async () => modeRadio('Strict').click())
  await act(async () => button('Switch to Strict mode').click())
  expect(modePanel()).toBeNull()
  expect(modeRadio('Relaxed').getAttribute('aria-checked')).toBe('true')
  expect(container.querySelector('[aria-label="Trusted unsafe networks"]')).not.toBeNull()
  expect(document.activeElement).toBe(modeRadio('Relaxed'))
})
