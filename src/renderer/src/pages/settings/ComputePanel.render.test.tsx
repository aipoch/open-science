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
      for (const [section, name] of [
        ['Kubernetes targets', 'Lab cluster'],
        ['Hugging Face Jobs targets', 'HF worker'],
        ['Ray Jobs targets', 'Ray lab'],
        ['Modal Sandbox targets', 'Modal lab']
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
  it('submits the explicit Modal Sandbox target from Settings', async () => {
    const save = vi.fn().mockResolvedValue({})
    Object.assign(window.api.compute, { createModalTarget: save })
    act(() => root.render(<ComputePanel onNavigate={vi.fn()} />))
    const add = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Add Modal Sandbox target')
    )
    act(() => add!.click())
    const form = container.querySelector('form')!
    const config = {
      displayName: 'Local',
      environmentName: 'research',
      appName: 'experiment',
      image: 'ubuntu:24.04',
      cpus: 2,
      memoryMiB: 1024
    }
    for (const [name, value] of Object.entries(config)) {
      ;(form.elements.namedItem(name) as HTMLInputElement).value = String(value)
    }
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(save).toHaveBeenCalledWith(config)
    expect(container.querySelector('form')).toBeNull()
  })

  it('renders the registered host sections and empty state', () => {
    act(() => {
      root.render(<ComputePanel onNavigate={vi.fn()} />)
    })

    expect(container.textContent).toContain('Modal Sandbox targets')
    expect(container.textContent).toContain('SSH hosts')
    expect(container.textContent).toContain('No SSH hosts yet')
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

    const addButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Add SSH host')
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
