// @vitest-environment jsdom
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '@aipoch/compute'

import { createInitialComputeState, useComputeStore } from '@/stores/compute-store'
import { ComputePanel } from './ComputePanel'

let container: HTMLDivElement
let root: Root

const host = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  executionMode: 'direct_ssh',
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

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useComputeStore.setState({ ...createInitialComputeState(), isLoaded: true, loadHosts: vi.fn() })
  ;(window as unknown as { api: { compute: Record<string, unknown> } }).api = {
    compute: {
      deletionStatus: vi.fn().mockResolvedValue({ blockedByJobs: false }),
      jobsSetRemoteCleanup: vi.fn().mockResolvedValue(undefined)
    }
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('ComputePanel', () => {
  it('shows configured targets together under their own backend in remote read-only settings', () => {
    const identity = { id: 'configured', providerId: 'unused' }
    useComputeStore.setState({
      kubernetesTargets: [
        {
          ...identity,
          displayName: 'Lab cluster',
          context: 'dev',
          namespace: 'jobs',
          image: 'worker',
          transferImage: 'transfer',
          sizeMiB: 64
        }
      ],
      hostedTargets: [
        {
          ...identity,
          displayName: 'HF worker',
          namespace: 'lab',
          bucket: 'lab/private',
          flavor: 'cpu-basic',
          image: 'ubuntu',
          timeoutSeconds: 60
        }
      ],
      rayTargets: [
        {
          ...identity,
          displayName: 'Ray lab',
          endpoint: 'http://127.0.0.1:8265',
          sharedRoot: '/local',
          remoteRoot: '/shared',
          cpus: 1,
          gpus: 0
        }
      ],
      modalTargets: [
        {
          ...identity,
          displayName: 'Modal lab',
          environmentName: 'dev',
          appName: 'jobs',
          image: 'ubuntu',
          cpus: 1,
          memoryMiB: 128
        }
      ]
    })

    document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, 'remote')
    try {
      act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))
      expect(
        Array.from(container.querySelectorAll('a[target="_blank"]'), (link) => [
          link.closest('section')?.querySelector('h3')?.textContent,
          link.getAttribute('aria-label'),
          link.getAttribute('href')
        ])
      ).toEqual([
        [
          'Hugging Face Jobs',
          'Open the Hugging Face Jobs website',
          'https://huggingface.co/settings/jobs'
        ],
        ['Modal Sandboxes', 'Open the Modal website', 'https://modal.com/apps']
      ])
      for (const [section, name] of [
        ['Kubernetes', 'Lab cluster'],
        ['Hugging Face Jobs', 'HF worker'],
        ['Ray Jobs', 'Ray lab'],
        ['Modal Sandboxes', 'Modal lab']
      ]) {
        const heading = Array.from(container.querySelectorAll('h3')).find(
          (element) => element.textContent === section
        )
        const group = heading?.closest('section')
        expect(group?.textContent).toContain(name)
        expect(group?.querySelector('button')).toBeNull()
      }
    } finally {
      document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
    }
  })
  it('verifies a saved Modal configuration only from the local surface', async () => {
    const providerId = 'modal:effective'
    const target = {
      id: 'effective',
      providerId,
      displayName: 'GPU',
      environmentName: 'main',
      appName: 'acceptance',
      image: 'ubuntu:24.04',
      cpus: 1,
      memoryMiB: 1024
    }
    useComputeStore.setState({ modalTargets: [target] })
    let identity = 'lab'
    const accountStatus = vi.fn(async (provider: string) => ({
      provider,
      state: 'connected',
      source: 'managed',
      identity
    }))
    const verifyTarget = vi.fn().mockResolvedValue(undefined)
    Object.assign(window.api.compute, { accountStatus, verifyTarget })
    document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, 'remote')
    try {
      await act(async () => root.render(<ComputePanel onNavigate={vi.fn()} />))
      expect(accountStatus).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('Verify access')
    } finally {
      document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
    }
    await act(async () => root.render(<ComputePanel onNavigate={vi.fn()} />))
    const verify = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Verify access'
    )
    expect(verify).toBeDefined()
    verify!.focus()
    await act(async () => verify!.click())
    expect(verifyTarget).toHaveBeenCalledExactlyOnceWith(providerId)
    const row = verify!.closest('li')!
    expect(verify!.textContent).toBe('Verify access')
    expect(row.querySelector('[role="status"]')?.textContent).toBe('Access verified')
    expect(
      Array.from(row.querySelectorAll('button')).map((button) => button.dataset.variant)
    ).toEqual(['outline', 'outline', 'outline'])
    identity = 'another-account'
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(row.querySelector('[role="status"]')).toBeNull()

    let finish!: () => void
    verifyTarget.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    act(() => verify!.click())
    expect(verify!.getAttribute('aria-busy')).toBe('true')
    act(() => useComputeStore.setState({ modalTargets: [{ ...target, image: 'new-image' }] }))
    await act(async () => finish())
    expect(row.querySelector('[role="status"]')).toBeNull()
    expect(document.activeElement).toBe(verify!)
    verifyTarget.mockRejectedValueOnce(new Error('denied'))
    await act(async () => verify!.click())
    expect(row.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not verify access to this configuration.'
    )
  })

  it('opens add for a connected account and permits editing the configuration after disconnect', async () => {
    const accountStatus = vi.fn(async (provider: string) => ({ provider, state: 'connected' }))
    Object.assign(window.api.compute, { accountStatus })
    const onNavigate = vi.fn()
    const providerId = 'modal:13c2e9ce-2a50-4cc0-8c2b-a04de932353b'
    useComputeStore.setState({
      modalTargets: [
        {
          id: providerId.slice(6),
          providerId,
          displayName: 'Lab',
          environmentName: 'dev',
          appName: 'jobs',
          image: 'ubuntu',
          cpus: 1,
          memoryMiB: 128
        }
      ]
    })
    await act(async () => root.render(<ComputePanel onNavigate={onNavigate} />))
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Add Modal Sandbox target"]')!
        .click()
    )
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'target-editor', backend: 'modal' })
    accountStatus.mockImplementation(async (provider) => ({ provider, state: 'disconnected' }))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(container.textContent).toContain('Not connected')
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Edit Lab"]')!.click())
    expect(onNavigate).toHaveBeenLastCalledWith({
      kind: 'target-editor',
      backend: 'modal',
      providerId
    })
  })

  it('resumes adding only after sign-in and keeps the group open on cancel', async () => {
    const onNavigate = vi.fn()
    Object.assign(window.api.compute, {
      accountStatus: async (provider: string) => ({ provider, state: 'disconnected' }),
      useLocalAccount: async (provider: string) => ({
        provider,
        state: 'connected',
        source: 'local'
      })
    })
    await act(async () => root.render(<ComputePanel onNavigate={onNavigate} />))
    const add = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add Hugging Face Jobs target"]'
    )!
    const inDialog = (text: string): HTMLButtonElement => {
      const dialog = document.querySelector('[role="alertdialog"]')!
      return Array.from(dialog.querySelectorAll('button')).find(
        (button) => button.textContent === text
      )!
    }
    await act(async () => add.click())
    await act(async () => inDialog('Cancel').click())
    expect(onNavigate).not.toHaveBeenCalled()
    await act(async () => add.click())
    await act(async () => inDialog('Use local sign-in').click())
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith({ kind: 'target-editor', backend: 'hosted' })
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('orders groups with consistent add actions and only reports empty lists after loading', () => {
    useComputeStore.setState({ isLoaded: false })
    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))
    expect(container.textContent).not.toContain('Not configured')
    act(() => useComputeStore.setState({ isLoaded: true, rayLoadError: 'connection error' }))
    const groups = Array.from(container.querySelectorAll('section[data-slot="settings-section"]'))
    expect(groups.map((group) => group.querySelector('h3')?.textContent)).toEqual([
      'SSH hosts',
      'Hugging Face Jobs',
      'Modal Sandboxes',
      'Kubernetes',
      'Ray Jobs'
    ])
    for (const group of groups) {
      expect(group.querySelector('button')?.textContent?.trim()).toBe('Add')
      if (group.querySelector('[role="alert"]'))
        expect(group.textContent).not.toContain('Not configured')
      else expect(group.textContent).toContain('Not configured')
    }
    expect(groups.at(-1)?.querySelector('[role="alert"]')).toBeTruthy()
  })

  it('renders a host card with its provider id string', () => {
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => {
      root.render(<ComputePanel onNavigate={vi.fn()} />)
    })

    expect(container.textContent).toContain('biowulf')
    expect(container.textContent).toContain('ssh:biowulf')
  })

  it('navigates to the add form when Add SSH host is clicked', () => {
    const onNavigate = vi.fn()

    act(() => {
      root.render(<ComputePanel onNavigate={onNavigate} />)
    })

    const addButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Add SSH host'
    )
    act(() => {
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'add' })
  })

  it('deletes a host and shows a confirmation toast', async () => {
    const deleteHost = vi.fn(() => Promise.resolve())
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
      isLoaded: true,
      deleteHost
    })

    act(() => {
      root.render(<ComputePanel onNavigate={vi.fn()} />)
    })

    const removeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Remove biowulf'
    )
    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(deleteHost).not.toHaveBeenCalled()
    expect(window.api.compute.deletionStatus).toHaveBeenCalledWith({ providerId: 'ssh:biowulf' })
    expect(document.body.textContent).toContain(
      'The local Compute Host and encrypted password will be deleted.'
    )
    expect(document.body.textContent).toContain('password cannot be recovered')

    const confirm = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')
    ).find((button) => button.textContent?.trim() === 'Remove Host')
    await act(async () => confirm?.click())

    expect(deleteHost).toHaveBeenCalledWith('ssh:biowulf')
    expect(container.textContent).toContain('Removed biowulf.')
  })

  it.each([
    ['success', undefined],
    ['failed', 'job_cancelled']
  ] as const)(
    'blocks X-triggered removal while a %s Job still needs attention',
    async (status, errorCode) => {
      vi.mocked(window.api.compute.deletionStatus).mockResolvedValueOnce({
        blockedByJobs: true,
        blockingJobs: [
          {
            jobId: 'job-1',
            projectId: 'project-1',
            sessionId: 'session-1',
            status,
            errorCode,
            harvested: true,
            intent: 'completed research',
            createdAt: 1
          }
        ]
      })
      const deleteHost = vi.fn(async () => undefined)
      useComputeStore.setState({ hosts: [host()], isLoaded: true, deleteHost })

      act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))

      const removeButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-label') === 'Remove biowulf'
      )
      await act(async () => removeButton?.click())

      const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
      const confirm = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
        (button) => button.textContent?.trim() === 'Remove Host'
      )
      expect(dialog?.textContent).toContain(
        'This Host cannot be removed while Compute Jobs still need remote cleanup.'
      )
      expect(
        Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).some(
          (button) => button.textContent?.trim() === 'View blocking jobs' && !button.disabled
        )
      ).toBe(true)
      const viewJobs = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
        (button) => button.textContent?.trim() === 'View blocking jobs'
      )
      act(() => viewJobs?.click())
      expect(dialog?.textContent).toContain('completed research')
      if (errorCode === 'job_cancelled') expect(dialog?.textContent).toContain('Cancelled')
      expect(dialog?.textContent).toContain('Clean up remote files')
      expect(dialog?.textContent).toContain('Abandon remote cleanup')
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const abandonCleanup = Array.from(
        dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
      ).find((button) => button.textContent?.trim() === 'Abandon remote cleanup')
      await act(async () => {
        abandonCleanup?.click()
        await Promise.resolve()
      })
      expect(window.api.compute.jobsSetRemoteCleanup).toHaveBeenCalledWith({
        jobId: 'job-1',
        providerId: 'ssh:biowulf',
        projectId: 'project-1',
        sessionId: 'session-1',
        disposition: 'abandoned'
      })
      expect(confirm?.disabled).toBe(false)
      expect(deleteHost).not.toHaveBeenCalled()
    }
  )

  it('requires a billing warning before abandoning an uncertain Modal creation', async () => {
    const providerId = 'modal:205e1449-7f3c-46b4-b218-5ed529e9e9ba'
    useComputeStore.setState({
      hosts: [],
      modalTargets: [
        {
          id: providerId.slice(6),
          providerId,
          displayName: 'Trial',
          environmentName: 'dev',
          appName: 'demo',
          image: 'ubuntu:24.04',
          cpus: 1,
          memoryMiB: 1024
        }
      ],
      isLoaded: true
    })
    vi.mocked(window.api.compute.deletionStatus).mockResolvedValueOnce({
      blockedByJobs: true,
      blockingJobs: [
        {
          jobId: 'unknown',
          projectId: 'p',
          sessionId: 's',
          status: 'submitted',
          modalCreationUnconfirmed: true,
          intent: 'trial',
          createdAt: 1
        }
      ]
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove Trial"]')!.click()
    )
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')!
    const button = (text: string): HTMLButtonElement =>
      Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === text)!
    act(() => button('View blocking jobs').click())
    expect(button('Clean up remote files').disabled).toBe(true)
    act(() => button('Abandon remote cleanup').click())
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('incurring charges'))
    expect(window.api.compute.jobsSetRemoteCleanup).not.toHaveBeenCalled()
  })

  it('disables remote cleanup until a terminal Job has been harvested', async () => {
    vi.mocked(window.api.compute.deletionStatus).mockResolvedValueOnce({
      blockedByJobs: true,
      blockingJobs: [
        {
          jobId: 'job-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          status: 'success',
          harvested: false,
          intent: 'unharvested research',
          createdAt: 1
        }
      ]
    })
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))
    const removeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Remove biowulf'
    )
    await act(async () => removeButton?.click())

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    const viewJobs = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'View blocking jobs'
    )
    act(() => viewJobs?.click())

    const cleanJob = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Clean up remote files'
    )
    expect(cleanJob?.disabled).toBe(true)
    expect(dialog?.textContent).toContain('Finish harvesting before cleaning up remote files.')
  })

  it('shows an X-triggered deletion failure and keeps the dialog open for retry', async () => {
    const deleteHost = vi.fn(async () => {
      throw new Error('delete failed')
    })
    useComputeStore.setState({ hosts: [host()], isLoaded: true, deleteHost })

    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))

    const removeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Remove biowulf'
    )
    await act(async () => removeButton?.click())
    const confirm = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')
    ).find((button) => button.textContent?.trim() === 'Remove Host')
    await act(async () => confirm?.click())

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Could not remove this Compute Host.')
    expect(
      Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
        (button) => button.textContent?.trim() === 'Remove Host'
      )?.disabled
    ).toBe(false)
    expect(container.textContent).not.toContain('Removed biowulf.')
  })

  it('uses semantic success and failure roles for probed hosts', () => {
    useComputeStore.setState({
      hosts: [
        host({
          probeResult: {
            ok: true,
            probedAt: new Date().toISOString(),
            exitCode: 0,
            errorTail: null
          }
        }),
        host({
          id: 'host-2',
          providerId: 'ssh:failed',
          displayName: 'failed',
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

    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))

    expect(container.querySelector('.bg-status-success-surface')).not.toBeNull()
    expect(container.querySelector('.bg-status-failure-surface')).not.toBeNull()
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

    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))

    expect(container.textContent).toContain('Last probe succeeded')
    expect(container.textContent).not.toContain('Connected')
  })

  it('allows browsing without treating a persisted Probe as a reachability gate', () => {
    useComputeStore.setState({ hosts: [host()], isLoaded: true })

    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))

    const browseButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Browse files on biowulf"]'
    )
    expect(browseButton?.disabled).toBe(false)
  })
})
