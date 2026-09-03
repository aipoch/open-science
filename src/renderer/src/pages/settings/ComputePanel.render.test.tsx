// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../../../shared/compute'
import { ComputePanel } from './ComputePanel'
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
  it('renders the header banner and empty state', () => {
    act(() => {
      root.render(<ComputePanel onNavigate={vi.fn()} />)
    })

    expect(container.textContent).toContain('Connect where heavy compute runs')
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

  it('blocks X-triggered removal while Compute Jobs still need attention', async () => {
    vi.mocked(window.api.compute.deletionStatus).mockResolvedValueOnce({
      blockedByJobs: true,
      blockingJobs: [
        {
          jobId: 'job-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          status: 'success',
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
