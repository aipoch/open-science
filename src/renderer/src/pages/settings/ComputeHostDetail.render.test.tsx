// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ChangeComputeHostAuthenticationRequest,
  ComputeHost
} from '../../../../shared/compute'
import { ComputeHostDetail } from './ComputeHostDetail'
import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'

let container: HTMLDivElement
let root: Root

const host = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const passwordHost = (): ComputeHost =>
  host({
    sshOverrides: { user: 'researcher', port: 22 },
    authentication: {
      mode: 'password',
      credentialStatus: 'configured',
      revision: 3,
      lastVerifiedAt: Date.parse('2026-08-17T00:00:00.000Z')
    }
  })

// Stub window.api.compute.detailsGet so the component does not hit real IPC.
const stubDetailsGet = (doc: string, isSkeleton = false): void => {
  ;(window as unknown as { api: { compute: Record<string, unknown> } }).api = {
    compute: {
      detailsGet: vi.fn().mockResolvedValue({ doc, isSkeleton }),
      deletionStatus: vi.fn().mockResolvedValue({ blockedByJobs: false }),
      passwordCapability: vi.fn().mockResolvedValue({ available: true })
    }
  }
}

const pastePassword = (input: HTMLInputElement | null, value: string): void => {
  if (!input) throw new Error('Missing password input')
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: () => value, setData: vi.fn() }
  })
  input.dispatchEvent(event)
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)

  const state = {
    ...createInitialComputeState(),
    isLoaded: true,
    loadHosts: vi.fn(),
    probeHost: vi.fn(),
    deleteHost: vi.fn(),
    saveDetails: vi.fn(),
    resetPassword: vi.fn(),
    setScratch: vi.fn(),
    setConcurrency: vi.fn(),
    changeAuthentication: vi.fn()
  }
  useComputeStore.setState(state)
  stubDetailsGet('')
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('ComputeHostDetail', () => {
  it('keeps ordinary Settings sections uncarded while retaining the resource status surface', () => {
    useComputeStore.setState({
      hosts: [
        {
          ...passwordHost(),
          probeResult: {
            ok: true,
            probedAt: '2026-08-18T00:00:00.000Z',
            exitCode: 0,
            errorTail: '',
            cpus: 8,
            memMib: 16384,
            detectedScheduler: 'slurm'
          }
        }
      ],
      isLoaded: true
    })

    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const sections = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="settings-section"]')
    )
    const sectionNamed = (title: string): HTMLElement | undefined =>
      sections.find((section) => section.querySelector('h3')?.textContent === title)
    const cardClasses = ['rounded-xl', 'border', 'bg-card', 'p-4']

    expect(sectionNamed('Resources')?.classList.contains('bg-card')).toBe(true)
    for (const title of ['Configuration', 'Details']) {
      const section = sectionNamed(title)
      expect(section).toBeDefined()
      expect(cardClasses.filter((className) => section?.classList.contains(className))).toEqual([])
    }
  })

  it('renders a single Configuration section with Edit in its header', async () => {
    useComputeStore.setState({ hosts: [passwordHost()], isLoaded: true })

    await act(async () => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
      await Promise.resolve()
    })

    const authenticationSections = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="settings-section"]')
    ).filter((section) => section.querySelector('h3')?.textContent === 'Configuration')
    const authenticationHeadings = Array.from(container.querySelectorAll('h3, h4')).filter(
      (heading) => heading.textContent === 'Configuration'
    )
    const connectionTests = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === 'Test connection'
    )
    const editButtons = Array.from(
      authenticationSections[0]?.querySelectorAll('button') ?? []
    ).filter((button) => button.textContent?.trim() === 'Edit')

    expect(authenticationSections).toHaveLength(1)
    expect(authenticationHeadings).toHaveLength(1)
    expect(connectionTests).toHaveLength(0)
    // Exactly one Edit action remains — the header one; the old bottom-right duplicate is gone.
    expect(editButtons).toHaveLength(1)
    expect(authenticationSections[0]?.textContent).toContain('Update')
    expect(authenticationSections[0]?.textContent).toContain('Configured · cannot be viewed')
    expect(authenticationSections[0]?.querySelector('input[type="radio"]')).toBeNull()
    expect(
      authenticationSections[0]?.querySelector('[aria-label="Collapse configuration"]')
    ).toBeNull()
  })

  it('resets a password inline and clears the renderer-local secret after success', async () => {
    const passwordHost = host({
      sshOverrides: { user: 'researcher', port: 22 },
      authentication: {
        mode: 'password',
        credentialStatus: 'configured',
        revision: 4,
        lastVerifiedAt: undefined
      }
    })
    const resetPassword = vi.fn(async () => ({
      ...passwordHost,
      authentication: { ...passwordHost.authentication!, revision: 5 }
    }))
    useComputeStore.setState({ hosts: [passwordHost], isLoaded: true, resetPassword })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })
    const open = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Update'
    )
    act(() => open?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const password = container.querySelector<HTMLInputElement>('#compute-reset-password')
    expect(password).toBeTruthy()
    const exactPassword = `  "quoted" 'single'\n第二行🙂\n${'x'.repeat(4096)}  `
    act(() => {
      pastePassword(password, exactPassword)
    })
    const submit = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Test and update'
    )
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(resetPassword).toHaveBeenCalledWith({
      providerId: 'ssh:biowulf',
      password: exactPassword,
      operationId: expect.any(String),
      expectedAuthenticationRevision: 4
    })
    expect(container.querySelector('#compute-reset-password')).toBeNull()
    expect(container.textContent).toContain('Saved password updated successfully.')
    expect(container.textContent).not.toContain(exactPassword)
  })

  it('clears the local password when reset is cancelled', () => {
    useComputeStore.setState({
      hosts: [
        host({
          authentication: {
            mode: 'password',
            credentialStatus: 'configured',
            revision: 1,
            lastVerifiedAt: undefined
          }
        })
      ],
      isLoaded: true
    })
    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })
    const click = (label: string): void => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      )
      act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    }
    click('Update')
    const input = container.querySelector<HTMLInputElement>('#compute-reset-password')
    act(() => {
      pastePassword(input, 'discard me')
    })
    click('Cancel')
    click('Update')

    expect(container.querySelector<HTMLInputElement>('#compute-reset-password')?.value).toBe('')
    expect(JSON.stringify(useComputeStore.getState())).not.toContain('discard me')
  })

  it('uses a new operation identifier when the password changes after a failed reset', async () => {
    const configuredHost = passwordHost()
    const resetPassword = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('host_unreachable'), { code: 'host_unreachable' })
      )
      .mockResolvedValueOnce({
        ...configuredHost,
        authentication: { ...configuredHost.authentication!, revision: 4 }
      })
    useComputeStore.setState({ hosts: [configuredHost], isLoaded: true, resetPassword })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))
    const click = async (label: string): Promise<void> => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      )
      await act(async () => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
    }

    await click('Update')
    act(() => pastePassword(container.querySelector('#compute-reset-password'), 'first password'))
    await click('Test and update')
    const firstOperationId = resetPassword.mock.calls[0]?.[0].operationId

    act(() => pastePassword(container.querySelector('#compute-reset-password'), 'second password'))
    await click('Test and update')

    expect(resetPassword).toHaveBeenCalledTimes(2)
    expect(resetPassword.mock.calls[1]?.[0]).toMatchObject({
      password: 'first passwordsecond password'
    })
    expect(resetPassword.mock.calls[1]?.[0].operationId).not.toBe(firstOperationId)
  })

  it('keeps authentication configuration and saved-password editors mutually exclusive', () => {
    useComputeStore.setState({ hosts: [passwordHost()], isLoaded: true })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const click = (label: string): void => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      )
      act(() => button?.click())
    }

    click('Update')
    act(() => pastePassword(container.querySelector('#compute-reset-password'), 'discard me'))
    click('Edit')

    expect(container.querySelector('#compute-reset-password')).toBeNull()
    expect(container.querySelector('#compute-detail-username')).toBeTruthy()

    click('Cancel')
    click('Update')

    expect(container.querySelector('#compute-detail-username')).toBeNull()
    expect(container.querySelector<HTMLInputElement>('#compute-reset-password')?.value).toBe('')
  })

  it('discards the local password when the authentication section unmounts', () => {
    const passwordHost = host({
      authentication: {
        mode: 'password',
        credentialStatus: 'configured',
        revision: 1,
        lastVerifiedAt: undefined
      }
    })
    useComputeStore.setState({ hosts: [passwordHost], isLoaded: true })
    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })
    const reset = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Update'
    )
    act(() => reset?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('#compute-reset-password')
    act(() => {
      pastePassword(input, 'unmounted secret')
    })

    act(() => useComputeStore.setState({ hosts: [] }))
    act(() => useComputeStore.setState({ hosts: [passwordHost] }))
    const reopened = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Update'
    )
    act(() => reopened?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelector<HTMLInputElement>('#compute-reset-password')?.value).toBe('')
    expect(JSON.stringify(useComputeStore.getState())).not.toContain('unmounted secret')
  })

  it('shows reset safety, inline progress, and inline authentication errors', async () => {
    const passwordHost = host({
      sshOverrides: { user: 'researcher', port: 22 },
      authentication: {
        mode: 'password',
        credentialStatus: 'configured',
        revision: 1,
        lastVerifiedAt: undefined
      }
    })
    let rejectReset!: (error: unknown) => void
    const resetPassword = vi.fn(
      () =>
        new Promise<ComputeHost>((_resolve, reject) => {
          rejectReset = reject
        })
    )
    useComputeStore.setState({ hosts: [passwordHost], isLoaded: true, resetPassword })
    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })
    const click = (label: string): void => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      )
      act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    }
    click('Update')
    expect(container.querySelector<HTMLInputElement>('#compute-reset-username')?.value).toBe(
      'researcher'
    )
    expect(container.querySelector('#compute-reset-username-help')?.textContent).toBe('(unchanged)')
    expect(container.textContent).toContain('Running Compute Jobs may continue')
    const input = container.querySelector<HTMLInputElement>('#compute-reset-password')
    act(() => {
      pastePassword(input, 'rejected secret')
    })
    click('Test and update')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Testing connection')
    await act(async () => {
      rejectReset(
        Object.assign(new Error('authentication_failed'), { code: 'authentication_failed' })
      )
      await Promise.resolve()
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Authentication failed. Verify the username and password.'
    )
    expect(input?.value).toBe('•'.repeat('rejected secret'.length))
  })
  it('shows loading state when host list is not loaded', () => {
    useComputeStore.setState({ isLoaded: false })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })

    expect(container.textContent).toContain('Loading host')
  })

  it('shows "no longer exists" when host is not in the store', () => {
    useComputeStore.setState({ hosts: [], isLoaded: true })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })

    expect(container.textContent).toContain('no longer exists')
  })

  it('renders host name and provider id', () => {
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })

    expect(container.textContent).toContain('biowulf')
    expect(container.textContent).toContain('ssh:biowulf')
  })

  it('labels a successful Probe as historical evidence instead of a live connection', () => {
    useComputeStore.setState({
      hosts: [
        host({
          probeResult: {
            ok: true,
            probedAt: '2020-01-01T00:00:00.000Z',
            exitCode: 0,
            errorTail: null
          }
        })
      ],
      isLoaded: true
    })

    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    expect(container.textContent).toContain('Last probe succeeded')
    expect(container.textContent).not.toContain('Connected')
  })

  it('explains unavailable Credentials without offering reveal, export, or Forget actions', async () => {
    useComputeStore.setState({
      hosts: [
        host({
          authentication: {
            mode: 'password',
            credentialStatus: 'unavailable',
            revision: 2,
            lastVerifiedAt: undefined
          },
          sshOverrides: { user: 'researcher', port: 22 }
        })
      ]
    })

    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))
    await act(async () => Promise.resolve())

    expect(container.textContent).toContain('Credential unavailable')
    expect(container.textContent).toContain('does not fall back to SSH configuration')
    expect(container.textContent).not.toMatch(/Forget password|Show password|Export password/)
  })

  it.each([
    {
      credentialStatus: 'missing' as const,
      capability: { available: true },
      expected: 'The saved credential is missing',
      absent: 'this platform cannot provide'
    },
    {
      credentialStatus: 'unavailable' as const,
      capability: { available: false, reason: 'secure_storage_unavailable' as const },
      expected: 'Secure credential storage is locked or unavailable',
      absent: 'this platform cannot provide'
    },
    {
      credentialStatus: 'unavailable' as const,
      capability: { available: false, reason: 'unsupported_platform' as const },
      expected: 'this platform cannot provide secure credential storage',
      absent: 'Unlock the system credential store'
    }
  ])(
    'explains $credentialStatus and platform capability separately',
    async ({ credentialStatus, capability, expected, absent }) => {
      vi.mocked(window.api.compute.passwordCapability).mockResolvedValueOnce(capability)
      useComputeStore.setState({
        hosts: [
          host({
            authentication: {
              mode: 'password',
              credentialStatus,
              revision: 1,
              lastVerifiedAt: undefined
            }
          })
        ]
      })

      act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))
      await act(async () => Promise.resolve())

      expect(container.textContent).toContain(expected)
      expect(container.textContent).not.toContain(absent)
    }
  )

  it('does not duplicate the list-level Remove Host action', () => {
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const removeActions = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === 'Remove Host'
    )

    expect(removeActions).toHaveLength(0)
  })

  it('shows Details, Scratch root, and Concurrent job limit sections', () => {
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })

    expect(container.textContent).toContain('Details')
    expect(container.textContent).toContain('Scratch root')
    expect(container.textContent).toContain('Concurrent job limit')
    expect(container.textContent).toContain('Configuration')
    expect(container.textContent).toContain(
      'New jobs wait when this host reaches the limit (1–500). Lowering the limit does not stop running jobs.'
    )
  })

  it('shows PINNED badge when scratchPinned is true', () => {
    useComputeStore.setState({
      hosts: [host({ scratchRoot: '/my/scratch', scratchPinned: true })],
      isLoaded: true
    })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })

    expect(container.textContent).toContain('PINNED')
  })

  it('offers to restore auto-detection for a historically empty pinned scratch root', () => {
    const clearScratch = vi.fn().mockResolvedValue(undefined)
    useComputeStore.setState({
      hosts: [host({ scratchRoot: '', scratchPinned: true })],
      isLoaded: true,
      clearScratch
    })

    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const restoreButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Restore auto-detection'
    )
    expect(restoreButton).toBeDefined()
    act(() => restoreButton?.click())
    expect(clearScratch).toHaveBeenCalledWith('ssh:biowulf')
  })

  it('does not allow saving an empty scratch root', () => {
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))
    const scratchHeading = Array.from(container.querySelectorAll('h4')).find(
      (heading) => heading.textContent === 'Scratch root'
    )
    const scratchSection = scratchHeading?.parentElement?.parentElement?.parentElement
    const editButton = Array.from(scratchSection?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Edit'
    )
    act(() => editButton?.click())

    const saveButton = Array.from(scratchSection?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Save'
    )
    expect(saveButton?.disabled).toBe(true)
  })

  it('shows (default) when concurrencyLimit is not set', () => {
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })

    expect(container.textContent).toContain('10 (default)')
    expect(container.textContent).not.toContain('Not yet enforced')
  })

  it('shows concurrencyLimit value when set', () => {
    useComputeStore.setState({ hosts: [host({ concurrencyLimit: 10 })], isLoaded: true })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })

    expect(container.textContent).toContain('10')
  })

  it('switches authentication methods in the existing Authentication section with inline testing state', async () => {
    let release!: (value: ComputeHost) => void
    const changeAuthentication = vi.fn(
      () => new Promise<ComputeHost>((resolve) => (release = resolve))
    )
    useComputeStore.setState({ hosts: [passwordHost()], isLoaded: true, changeAuthentication })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })

    const authSection = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="settings-section"]')
    ).find((section) => section.querySelector('h3')?.textContent === 'Configuration')
    expect(authSection?.textContent).toContain('Username and password')
    const edit = Array.from(authSection?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Edit'
    )
    act(() => edit?.click())
    const sshChoice = authSection?.querySelector<HTMLInputElement>('input[value="ssh_config"]')
    act(() => sshChoice?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(authSection?.textContent).toContain(
      'After SSH configuration is verified, the saved password is deleted.'
    )

    const save = Array.from(authSection?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Test and save'
    )
    await act(async () => save?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(authSection?.textContent).toContain('Testing connection…')
    expect(changeAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'ssh:biowulf',
        expectedRevision: 3,
        authenticationMode: 'ssh_config',
        username: 'researcher',
        port: 22
      })
    )

    await act(async () => release(passwordHost()))
    expect(authSection?.textContent).toContain(
      'SSH configuration verified and activated. Saved password deleted. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.'
    )
  })

  it('confirms password activation and lifecycle consequences when switching from SSH configuration', async () => {
    const sshHost = host({
      sshOverrides: { user: 'researcher', port: 22 },
      authentication: {
        mode: 'ssh_config',
        credentialStatus: 'missing',
        revision: 3,
        lastVerifiedAt: undefined
      }
    })
    const changed = passwordHost()
    const changeAuthentication = vi
      .fn<(request: ChangeComputeHostAuthenticationRequest) => Promise<ComputeHost>>()
      .mockResolvedValue(changed)
    useComputeStore.setState({ hosts: [sshHost], isLoaded: true, changeAuthentication })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const click = async (label: string): Promise<void> => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      )
      await act(async () => button?.click())
    }
    await click('Edit')
    act(() =>
      container
        .querySelector<HTMLInputElement>('input[value="password"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    act(() => pastePassword(container.querySelector('#compute-detail-password'), 'candidate'))
    await click('Test and save')

    expect(container.textContent).toContain(
      'Password authentication verified and activated. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.'
    )
  })

  it('explains the execution-target reset and reapproval consequences after a username change', async () => {
    const changeAuthentication = vi
      .fn<(request: ChangeComputeHostAuthenticationRequest) => Promise<ComputeHost>>()
      .mockResolvedValue(passwordHost())
    useComputeStore.setState({ hosts: [passwordHost()], isLoaded: true, changeAuthentication })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const enter = (id: string, value: string): void => {
      const input = container.querySelector<HTMLInputElement>(`#${id}`)!
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          value
        )
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const click = async (label: string): Promise<void> => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      )
      await act(async () => button?.click())
    }

    await click('Edit')
    enter('compute-detail-username', 'new-user')
    act(() => pastePassword(container.querySelector('#compute-detail-password'), 'candidate'))
    await click('Test and save')

    expect(container.textContent).toContain(
      'Username changed. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.'
    )
  })

  it('allows an unchanged password configuration to save without a password', async () => {
    const current = passwordHost()
    const changeAuthentication = vi
      .fn<(request: ChangeComputeHostAuthenticationRequest) => Promise<ComputeHost>>()
      .mockResolvedValue(current)
    useComputeStore.setState({ hosts: [current], isLoaded: true, changeAuthentication })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const click = async (label: string): Promise<void> => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      )
      await act(async () => button?.click())
    }
    await click('Edit')
    await click('Test and save')

    expect(changeAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticationMode: 'password',
        username: 'researcher',
        port: 22
      })
    )
    expect(changeAuthentication.mock.calls[0]?.[0]).not.toHaveProperty('password')
    expect(container.textContent).toContain('Authentication settings are already up to date.')
  })

  it('reports other connection changes separately from username and method changes', async () => {
    const current = passwordHost()
    const changeAuthentication = vi
      .fn<(request: ChangeComputeHostAuthenticationRequest) => Promise<ComputeHost>>()
      .mockResolvedValue(current)
    useComputeStore.setState({ hosts: [current], isLoaded: true, changeAuthentication })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const click = async (label: string): Promise<void> => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      )
      await act(async () => button?.click())
    }
    await click('Edit')
    const port = container.querySelector<HTMLInputElement>('#compute-detail-port')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(port, '2222')
      port.dispatchEvent(new Event('input', { bubbles: true }))
      pastePassword(container.querySelector('#compute-detail-password'), 'candidate')
    })
    await click('Test and save')

    expect(container.textContent).toContain(
      'Connection settings verified and saved. Select this Compute Host again as an execution target in each Session and approve new Permission Grants.'
    )
  })

  it('validates a changed username with the current password method and renders a Job block inline', async () => {
    const changeAuthentication = vi.fn(async () => {
      throw Object.assign(new Error('credential_change_blocked_by_jobs'), {
        code: 'credential_change_blocked_by_jobs'
      })
    })
    useComputeStore.setState({ hosts: [passwordHost()], isLoaded: true, changeAuthentication })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })
    const authSection = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="settings-section"]')
    ).find((section) => section.querySelector('h3')?.textContent === 'Configuration')
    const edit = Array.from(authSection?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Edit'
    )
    act(() => edit?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const username = container.querySelector<HTMLInputElement>('#compute-detail-username')
    const password = container.querySelector<HTMLInputElement>('#compute-detail-password')
    act(() => {
      Object.defineProperty(username!, 'value', { value: 'new-user', writable: true })
      username?.dispatchEvent(new Event('input', { bubbles: true }))
      pastePassword(password, 'new-password')
    })
    const save = Array.from(authSection?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Test and save'
    )
    await act(async () => save?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(changeAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticationMode: 'password',
        username: 'new-user',
        password: 'new-password'
      })
    )
    expect(authSection?.querySelector('[role="alert"]')?.textContent).toContain(
      'Authentication change blocked'
    )
  })

  it('reuses the authentication operation identifier when retrying an unchanged candidate', async () => {
    const changeAuthentication = vi.fn<
      (request: ChangeComputeHostAuthenticationRequest) => Promise<never>
    >(async () => {
      throw Object.assign(new Error('host_unreachable'), { code: 'host_unreachable' })
    })
    useComputeStore.setState({ hosts: [passwordHost()], isLoaded: true, changeAuthentication })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const click = async (label: string): Promise<void> => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      )
      await act(async () => button?.click())
    }

    await click('Edit')
    act(() => pastePassword(container.querySelector('#compute-detail-password'), 'retry secret'))
    await click('Test and save')
    await click('Test and save')

    expect(changeAuthentication).toHaveBeenCalledTimes(2)
    expect(changeAuthentication.mock.calls[1]?.[0].operationId).toBe(
      changeAuthentication.mock.calls[0]?.[0].operationId
    )
  })

  it.each([
    ['authentication mode', 'mode'],
    ['username', 'username'],
    ['port', 'port'],
    ['password', 'password']
  ] as const)(
    'uses a new authentication operation identifier after changing the %s candidate field',
    async (_label, field) => {
      const changeAuthentication = vi.fn<
        (request: ChangeComputeHostAuthenticationRequest) => Promise<never>
      >(async () => {
        throw Object.assign(new Error('host_unreachable'), { code: 'host_unreachable' })
      })
      useComputeStore.setState({ hosts: [passwordHost()], isLoaded: true, changeAuthentication })
      act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

      const click = async (label: string): Promise<void> => {
        const button = Array.from(container.querySelectorAll('button')).find(
          (candidate) => candidate.textContent?.trim() === label
        )
        await act(async () => button?.click())
      }
      const enter = (id: string, value: string): void => {
        const input = container.querySelector<HTMLInputElement>(`#${id}`)!
        act(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            input,
            value
          )
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
      }

      await click('Edit')
      act(() => pastePassword(container.querySelector('#compute-detail-password'), 'first secret'))
      await click('Test and save')
      const firstOperationId = changeAuthentication.mock.calls[0]?.[0].operationId

      if (field === 'mode') {
        act(() =>
          container
            .querySelector<HTMLInputElement>('input[value="ssh_config"]')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        )
      } else if (field === 'username') {
        enter('compute-detail-username', 'second-user')
      } else if (field === 'port') {
        enter('compute-detail-port', '2222')
      } else {
        act(() =>
          pastePassword(container.querySelector('#compute-detail-password'), ' second secret')
        )
      }
      await click('Test and save')

      expect(changeAuthentication).toHaveBeenCalledTimes(2)
      expect(changeAuthentication.mock.calls[1]?.[0].operationId).not.toBe(firstOperationId)
    }
  )

  it('uses a new authentication operation identifier when the identity-file candidate changes', async () => {
    const sshHost = host({
      sshOverrides: { user: 'researcher', port: 22, identityFile: '/keys/first' },
      authentication: {
        mode: 'ssh_config',
        credentialStatus: 'missing',
        revision: 3,
        lastVerifiedAt: undefined
      }
    })
    const changeAuthentication = vi.fn<
      (request: ChangeComputeHostAuthenticationRequest) => Promise<never>
    >(async () => {
      throw Object.assign(new Error('host_unreachable'), { code: 'host_unreachable' })
    })
    useComputeStore.setState({ hosts: [sshHost], isLoaded: true, changeAuthentication })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const click = async (label: string): Promise<void> => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      )
      await act(async () => button?.click())
    }
    await click('Edit')
    await click('Test and save')
    const firstOperationId = changeAuthentication.mock.calls[0]?.[0].operationId

    act(() =>
      useComputeStore.setState({
        hosts: [
          {
            ...sshHost,
            sshOverrides: { ...sshHost.sshOverrides!, identityFile: '/keys/second' }
          }
        ]
      })
    )
    await click('Test and save')

    expect(changeAuthentication).toHaveBeenCalledTimes(2)
    expect(changeAuthentication.mock.calls[1]?.[0]).toMatchObject({
      identityFile: '/keys/second'
    })
    expect(changeAuthentication.mock.calls[1]?.[0].operationId).not.toBe(firstOperationId)
  })

  it('associates username, port, and password validation errors with their fields', async () => {
    useComputeStore.setState({ hosts: [passwordHost()], isLoaded: true })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const click = (label: string): void => {
      const button = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === label
      )
      act(() => button?.click())
    }
    const enter = (id: string, value: string): void => {
      const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!
      const prototype =
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
      act(() => {
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value)
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const expectInvalid = (id: string, message: string): void => {
      const field = container.querySelector<HTMLElement>(`#${id}`)!
      const errorId = field.getAttribute('aria-describedby')
      expect(field.getAttribute('aria-invalid')).toBe('true')
      expect(errorId).toBeTruthy()
      expect(container.querySelector(`#${errorId}`)?.textContent).toBe(message)
    }

    click('Edit')
    enter('compute-detail-username', '   ')
    click('Test and save')
    expectInvalid('compute-detail-username', 'Username is required.')

    enter('compute-detail-username', 'researcher')
    enter('compute-detail-port', '70000')
    click('Test and save')
    expectInvalid('compute-detail-port', 'Port must be an integer from 1 through 65535.')

    enter('compute-detail-port', '22')
    enter('compute-detail-username', 'new-researcher')
    enter('compute-detail-password', '')
    click('Test and save')
    expectInvalid('compute-detail-password', 'Password is required.')
  })

  it('masks but preserves the exact multiline password candidate when changing identity', async () => {
    const changeAuthentication = vi.fn(async () => passwordHost())
    useComputeStore.setState({ hosts: [passwordHost()], isLoaded: true, changeAuthentication })
    act(() => root.render(<ComputeHostDetail providerId="ssh:biowulf" />))

    const changeUsername = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Edit'
    )
    act(() => changeUsername?.click())
    const password = container.querySelector<HTMLInputElement>('#compute-detail-password')!
    const exactPassword = `  "quoted" 'single'\n第二行🙂\n${'x'.repeat(4096)}  `
    act(() => {
      pastePassword(password, exactPassword)
    })
    const save = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Test and save'
    )
    await act(async () => save?.click())

    expect(password.type).toBe('password')
    expect(password.value).toBe('•'.repeat(exactPassword.length))
    expect(container.innerHTML).not.toContain(exactPassword)
    expect(changeAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({ password: exactPassword })
    )
  })

  it('uses semantic failure roles for a failed probe', () => {
    useComputeStore.setState({
      hosts: [
        host({
          probeResult: {
            ok: false,
            probedAt: new Date().toISOString(),
            exitCode: 255,
            errorTail: 'offline'
          }
        })
      ],
      isLoaded: true
    })

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })

    const failure = container.querySelector<HTMLElement>('[role="alert"]')
    expect(failure?.className).toContain('border-status-failure-border')
    expect(failure?.className).toContain('bg-status-failure-subtle/50')
  })

  it('calls saveDetails with author=user when Save is clicked in details editor', async () => {
    const saveDetails = vi.fn(() => Promise.resolve())
    useComputeStore.setState({ hosts: [host()], isLoaded: true, saveDetails })
    stubDetailsGet('original notes')

    act(() => {
      root.render(<ComputeHostDetail providerId="ssh:biowulf" />)
    })

    // Wait for the detailsGet effect to resolve.
    await act(async () => {
      await Promise.resolve()
    })
    const details = container.querySelector<HTMLElement>('pre')
    expect(details?.className).toContain('transition-opacity')
    expect(details?.className).toContain('motion-reduce:transition-none')
    expect(details?.className).not.toContain('transition-all')

    const detailsSection = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="settings-section"]')
    ).find((section) => section.querySelector('h3')?.textContent === 'Details')
    const editButton = Array.from(detailsSection?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Edit'
    )
    act(() => {
      editButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const textarea = container.querySelector('textarea')
    expect(textarea).toBeTruthy()

    act(() => {
      Object.defineProperty(textarea!, 'value', { value: 'updated notes', writable: true })
      textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save'
    )
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // saveDetails should have been called with 'user' as author.
    expect(saveDetails).toHaveBeenCalled()
  })

  it('opens and focuses the saved-password reset editor from credential recovery', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    useComputeStore.setState({
      hosts: [
        host({
          authentication: {
            mode: 'password',
            credentialStatus: 'configured',
            revision: 2,
            lastVerifiedAt: undefined
          }
        })
      ],
      isLoaded: true
    })

    act(() => {
      root.render(
        <ComputeHostDetail
          providerId="ssh:biowulf"

          authenticationFocus="authentication_failed"
        />
      )
    })
    await act(async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const alert = container.querySelector<HTMLElement>('[data-compute-authentication-alert]')
    const password = container.querySelector<HTMLInputElement>('#compute-reset-password')
    expect(alert?.textContent).toContain('The saved username or password was rejected')
    expect(password).toBe(document.activeElement)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(container.querySelector('#compute-detail-password')).toBeNull()
  })

  it('focuses an actionable connection test when secure storage blocks password editing', async () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    vi.mocked(window.api.compute.passwordCapability).mockResolvedValueOnce({
      available: false,
      reason: 'secure_storage_unavailable'
    })
    useComputeStore.setState({ hosts: [passwordHost()], isLoaded: true })

    act(() => {
      root.render(
        <ComputeHostDetail
          providerId="ssh:biowulf"

          authenticationFocus="secure_storage_unavailable"
        />
      )
    })
    await act(async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const testConnection = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Test connection'
    )
    expect(testConnection).toBe(document.activeElement)
    expect(container.querySelector('#compute-reset-password')).toBeNull()
    expect(container.textContent).toContain('Unlock system credential storage')
  })

  it('clears stale recovery guidance after a successful probe', async () => {
    const probeHost = vi.fn().mockResolvedValue({
      ok: true,
      probedAt: new Date().toISOString(),
      exitCode: 0,
      errorTail: null
    })
    useComputeStore.setState({ hosts: [host()], isLoaded: true, probeHost })

    act(() => {
      root.render(
        <ComputeHostDetail
          providerId="ssh:biowulf"

          authenticationFocus="authentication_failed"
          authenticationRequestId={7}
        />
      )
    })
    const probe = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Probe'
    )
    await act(async () => probe?.click())

    expect(probeHost).toHaveBeenCalledWith('ssh:biowulf')
    expect(container.querySelector('[data-compute-authentication-alert]')).toBeNull()
  })
})
