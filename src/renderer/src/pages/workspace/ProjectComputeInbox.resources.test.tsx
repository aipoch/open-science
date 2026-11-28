// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import type {
  NotebookProcessObservation,
  NotebookProcessMonitorSnapshot
} from '../../../../shared/notebook-process-monitor'
import type {
  NotebookProjectResources,
  NotebookResourceRelease,
  NotebookSessionResources
} from '../../../../shared/notebook-resources'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { WEB_CALLER_LOCATION_ATTRIBUTE } from '../../../../shared/web-caller-location'
import { useProjectStore } from '@/stores/project-store'
import { ProjectComputeInbox } from './ProjectComputeInbox'

vi.mock('react-i18next', () => createI18nTestStub())
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const group = (revision = 'original-resources'): NotebookSessionResources => ({
  projectId: 'project-1',
  sessionId: 'session-1',
  revision,
  resources: [
    {
      id: 'python-original',
      group: 'kernel',
      kind: 'python',
      environment: 'research',
      laneKey: 'main',
      phase: 'running',
      startedAt: Date.parse('2026-11-12T08:00:00Z'),
      memory: { metric: 'rss', coverage: 'unknown', sampledAt: Date.now() }
    }
  ]
})

const release = (overrides: Partial<NotebookResourceRelease> = {}): NotebookResourceRelease => ({
  operationId: 'release-original',
  projectId: 'project-1',
  sessionId: 'session-1',
  revision: 'original-resources',
  status: 'releasing',
  startedAt: Date.now(),
  resources: [{ id: 'python-original', group: 'kernel', kind: 'python', status: 'pending' }],
  continuations: [],
  ...overrides
})

describe('Compute Notebook resource controls', () => {
  let root: Root | undefined
  let container: HTMLDivElement
  let changed: () => void
  let view: NotebookProjectResources
  const getProjectResources = vi.fn()
  const releaseSessionResources = vi.fn()
  const retryResourceRelease = vi.fn()

  const button = (label: string, scope: ParentNode = document): HTMLButtonElement => {
    const found = [...scope.querySelectorAll('button')].find(
      (item) => item.textContent === label || item.getAttribute('aria-label') === label
    )
    expect(found, label).toBeDefined()
    return found!
  }
  const render = async (): Promise<void> => {
    root = createRoot(container)
    await act(async () => root?.render(<ProjectComputeInbox />))
  }

  beforeEach(() => {
    document.documentElement.setAttribute(WEB_CALLER_LOCATION_ATTRIBUTE, 'remote')
    vi.resetAllMocks()
    view = { groups: [group()], pendingDecisions: [], releases: [] }
    getProjectResources.mockImplementation(async () => view)
    releaseSessionResources.mockImplementation(async () => {
      const result = release()
      view = { ...view, releases: [result] }
      return result
    })
    useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-1' })
    useProjectStore.setState({ projects: [] })
    useSessionStore.setState({
      sessions: [
        {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Research analysis',
          cwd: '/workspace',
          status: 'idle',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      selectedSessionId: 'session-1'
    })
    Object.assign(window, {
      api: {
        notebook: {
          getProjectResources,
          releaseSessionResources,
          retryResourceRelease,
          getProjectActivity: vi.fn().mockResolvedValue({ kernels: [], backgroundRuns: [] }),
          onChanged: (listener: (event: { projectId: string }) => void) => {
            changed = () => listener({ projectId: 'project-1' })
            return () => undefined
          }
        },
        compute: {
          jobsList: vi.fn().mockResolvedValue([]),
          onJobUpdated: () => () => undefined
        }
      }
    })
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(() => {
    document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
    act(() => root?.unmount())
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const process = (
    id: string,
    kind: NotebookProcessObservation['kind'],
    scope = group()
  ): NotebookProcessObservation => ({
    id,
    kind,
    lane: 'main',
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    status: 'idle',
    startedAt: 1,
    pid: 42,
    hasLastCell: true,
    lastCell: { code: 'print(42)', truncated: false },
    memoryBytes: 1024,
    cpuCores: 0.4,
    processes: [{ pid: 42, parentPid: 1, command: 'kernel', memoryBytes: 1024, cpuCores: 0.4 }]
  })
  const desktop = (
    initial: NotebookProcessObservation[],
    initialResourceProjectIds?: string[]
  ): {
    terminate: ReturnType<typeof vi.fn>
    update: (next: NotebookProcessObservation[]) => void
    updateResourceProjects: (ids: string[]) => void
  } => {
    document.documentElement.removeAttribute(WEB_CALLER_LOCATION_ATTRIBUTE)
    let instances = initial
    let resourceProjectIds = initialResourceProjectIds
    const getProcessMonitor = vi.fn(async (): Promise<NotebookProcessMonitorSnapshot> => ({
      sampledAt: Date.now(),
      processMetricsAvailable: true,
      host: {
        hostname: 'localhost',
        platform: 'darwin',
        cpuCount: 8,
        memoryTotalBytes: 16 * 1024 ** 3,
        memoryUsedBytes: 4 * 1024 ** 3,
        uptimeSeconds: 60
      },
      instances,
      resourceProjectIds
    }))
    const terminate = vi.fn()
    Object.assign(window.api.notebook, { getProcessMonitor, terminateMonitoredProcess: terminate })
    return {
      terminate,
      update: (next: NotebookProcessObservation[]) => {
        instances = next
      },
      updateResourceProjects: (ids: string[]) => {
        resourceProjectIds = ids
      }
    }
  }
  const stopAll = async (session: HTMLElement): Promise<void> => {
    await act(async () =>
      fireEvent.click(
        within(session.querySelector('header')!).getByRole('button', { name: 'Stop all' })
      )
    )
  }

  it('shows one desktop list with four interpreter details and changes Stop to Force close after a verified timeout', async () => {
    const items = [
      process('python', 'python'),
      process('r', 'r'),
      process('shell', 'shell'),
      process('repl', 'repl')
    ]
    const { terminate, update } = desktop(items)
    terminate.mockImplementationOnce(async () => {
      update([{ ...items[0], status: 'cleanup-failed', canForceClose: true }, ...items.slice(1)])
      throw new Error('Timed out')
    })
    terminate.mockImplementationOnce(async () => update(items.slice(1)))
    await render()
    expect(screen.getAllByRole('heading', { name: 'Notebook resources' })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Compute jobs' })).toBeTruthy()
    await act(async () => fireEvent.click(container.querySelector('button[aria-controls]')!))
    for (const name of ['Python', 'R', 'Shell', 'JavaScript REPL'])
      expect(screen.getByRole('img', { name })).toBeTruthy()

    const row = container.querySelector<HTMLDetailsElement>('[data-kernel-details]')!
    await act(async () => {
      row.open = true
      fireEvent(row, new Event('toggle'))
    })
    expect(within(row).getByRole('region', { name: 'Last cell' }).textContent).toContain(
      'print(42)'
    )
    expect(within(row).getByText('Process ID')).toBeTruthy()
    expect(within(row).getByRole('img', { name: 'Memory usage' })).toBeTruthy()
    expect(within(row).getByRole('img', { name: 'CPU usage' })).toBeTruthy()
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: 'Stop' })))
    const form = screen.getByRole('form', { name: 'Stop this kernel?' })
    await act(async () => {
      fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'Use less memory' } })
      fireEvent.submit(form)
    })
    expect(terminate).toHaveBeenNthCalledWith(1, {
      id: 'python',
      projectId: 'project-1',
      sessionId: 'session-1',
      comment: 'Use less memory'
    })
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: 'Force close' })))
    expect(terminate).toHaveBeenNthCalledWith(2, {
      id: 'python',
      projectId: 'project-1',
      sessionId: 'session-1',
      force: true
    })
  })

  it('discovers resource-only Sessions across projects and confirms the targeted revision', async () => {
    const otherProject = {
      ...group('target-revision'),
      projectId: 'project-2',
      sessionId: 'foreign',
      resources: [{ ...group().resources[0], id: 'repro', group: 'reproduction' as const }]
    }
    const installer = {
      ...group('installer-revision'),
      sessionId: 'installer',
      resources: [{ ...group().resources[0], id: 'installer', group: 'installer' as const }]
    }
    const pending = {
      ...installer,
      sessionId: 'hidden',
      resources: [{ ...installer.resources[0], id: 'hidden', group: 'operation' as const }]
    }
    desktop([], ['project-2'])
    useSessionStore.setState((state) => ({
      sessions: [
        ...state.sessions,
        {
          ...state.sessions[0],
          id: 'foreign',
          projectId: 'project-2',
          title: 'Other project session'
        },
        { ...state.sessions[0], id: 'installer', title: 'Installer session' },
        { ...state.sessions[0], id: 'hidden', title: 'Pending-only session' }
      ]
    }))
    getProjectResources.mockImplementation(async ({ projectId }) => ({
      groups: projectId === 'project-2' ? [otherProject] : [installer, pending],
      releases: view.releases.filter((result) => result.projectId === projectId),
      pendingDecisions: []
    }))
    releaseSessionResources.mockImplementation(async (request) => {
      const result = release({
        ...request,
        operationId: request.sessionId,
        status: 'released',
        phase: 'release',
        resources: []
      })
      view.releases.push(result)
      return result
    })
    const openSession = vi.spyOn(useNavigationStore.getState(), 'openSession').mockReturnValue(true)
    await render()
    expect(screen.queryByText('Pending-only session')).toBeNull()
    expect(screen.getByText('Other project session')).toBeTruthy()
    expect(getProjectResources).toHaveBeenCalledWith({ projectId: 'project-2' })
    const pendingRead = Promise.withResolvers<NotebookProjectResources>()
    getProjectResources.mockReturnValueOnce(pendingRead.promise)
    await stopAll(screen.getByText('Other project session').closest('section')!)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Current project' })))
    expect(screen.queryByText('Other project session')).toBeNull()
    await act(async () =>
      pendingRead.resolve({ groups: [otherProject], releases: [], pendingDecisions: [] })
    )
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(releaseSessionResources).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'All projects' })))
    await stopAll(screen.getByText('Other project session').closest('section')!)
    const confirmation = screen.getByRole('alertdialog')
    expect(within(confirmation).getByText(/may be forced to stop/)).toBeTruthy()
    await act(async () => {
      fireEvent.change(within(confirmation).getByRole('textbox'), {
        target: { value: 'Reduce demand' }
      })
      fireEvent.click(within(confirmation).getByRole('button', { name: 'Stop' }))
    })
    expect(releaseSessionResources).toHaveBeenCalledExactlyOnceWith({
      projectId: 'project-2',
      sessionId: 'foreign',
      revision: 'target-revision',
      stopAll: { comment: 'Reduce demand' }
    })
    const completion = screen.getByText('Notebook resources released').closest('section')!
    expect(within(completion).getByRole('status').textContent).toContain('Other project session')
    const open = within(completion).getByRole('button', { name: 'Open session' })
    await act(async () => fireEvent.click(open))
    expect(openSession).toHaveBeenCalledExactlyOnceWith('project-2', 'foreign', 'user')

    const session = screen.getByText('Installer session').closest('section')!
    await act(async () => fireEvent.click(session.querySelector('button[aria-controls]')!))
    expect(within(session).getByText('Other resources (1)')).toBeTruthy()
    await stopAll(session)
    const installerConfirmation = screen.getByRole('alertdialog')
    expect(installerConfirmation.textContent).toContain('Environment installer')
    await act(async () =>
      fireEvent.click(within(installerConfirmation).getByRole('button', { name: 'Stop' }))
    )
    expect(releaseSessionResources).toHaveBeenNthCalledWith(2, {
      projectId: 'project-1',
      sessionId: 'installer',
      revision: 'installer-revision',
      stopAll: { comment: '' }
    })
  })

  it('announces cross-project release progress after the installer disappears', async () => {
    vi.useFakeTimers()
    const { updateResourceProjects } = desktop([], ['project-2'])
    const installer = {
      ...group(),
      projectId: 'project-2',
      resources: [{ ...group().resources[0], id: 'installer', group: 'installer' as const }]
    }
    const operation = release({
      projectId: 'project-2',
      phase: 'release',
      resources: [{ id: 'installer', group: 'installer', status: 'pending' }]
    })
    const completedHistory = release({
      operationId: 'earlier-release',
      projectId: 'project-2',
      phase: 'release',
      status: 'released'
    })
    view = { groups: [installer], pendingDecisions: [], releases: [completedHistory] }
    getProjectResources.mockImplementation(async ({ projectId }) =>
      projectId === 'project-2' ? view : { groups: [], pendingDecisions: [], releases: [] }
    )
    releaseSessionResources.mockImplementation(async () => {
      view = { ...view, groups: [] }
      return operation
    })
    await render()
    expect(screen.queryByText('Notebook resources released')).toBeNull()
    await stopAll(screen.getByText('Research analysis').closest('section')!)
    const confirmation = screen.getByRole('alertdialog')
    await act(async () =>
      fireEvent.click(within(confirmation).getByRole('button', { name: 'Stop' }))
    )

    expect(screen.queryByRole('button', { name: 'Stop all' })).toBeNull()
    const announcement = screen
      .getByText('Releasing Notebook resources')
      .closest('[role="status"]')!
    expect(announcement.textContent).toContain('Research analysis')
    await act(async () => button('Current project').click())
    expect(announcement.closest('[hidden]')).not.toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await act(async () => button('All projects').click())
    expect(announcement.closest('[hidden]')).toBeNull()
    updateResourceProjects([])

    for (const [phase, label] of [
      ['retry', 'Retrying Notebook cleanup…'],
      ['force-close', 'Force closing Notebook processes…']
    ] as const) {
      view = { ...view, releases: [completedHistory, { ...operation, phase }] }
      await act(async () => vi.advanceTimersByTimeAsync(3000))
      expect(announcement.textContent).toContain(label)
    }

    view = {
      ...view,
      releases: [
        completedHistory,
        {
          ...operation,
          phase: 'force-close',
          status: 'released',
          resources: [
            { ...operation.resources[0], status: 'released', environmentRecoveryRequired: true }
          ]
        }
      ]
    }
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(announcement.textContent).toContain('Notebook resources released')
    expect(announcement.textContent).toContain(
      'The installer stopped. Recover the affected environment before using it again.'
    )
    expect(screen.queryByRole('button', { name: 'Retry cleanup' })).toBeNull()
    expect(retryResourceRelease).not.toHaveBeenCalled()

    const result = announcement.closest('section')!
    await act(async () => fireEvent.click(within(result).getByRole('button', { name: 'Dismiss' })))
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(screen.queryByText('Notebook resources released')).toBeNull()
  })

  it('drops departed project rows and stops polling their failed discovery read', async () => {
    vi.useFakeTimers()
    const { updateResourceProjects } = desktop([], ['project-2'])
    const installer = {
      ...group(),
      projectId: 'project-2',
      resources: [{ ...group().resources[0], id: 'installer', group: 'installer' as const }]
    }
    let departed = false
    getProjectResources.mockImplementation(async ({ projectId }) => {
      if (projectId !== 'project-2') return { groups: [], pendingDecisions: [], releases: [] }
      if (departed) throw new Error('Departed project read failed')
      return { groups: [installer], pendingDecisions: [], releases: [] }
    })
    await render()
    expect(screen.getByText('Research analysis')).toBeTruthy()

    departed = true
    updateResourceProjects([])
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(screen.queryByText('Research analysis')).toBeNull()
    expect(screen.queryByText('Could not refresh Notebook resources')).toBeNull()
    const reads = getProjectResources.mock.calls.filter(
      ([request]) => request.projectId === 'project-2'
    ).length
    await act(async () => vi.advanceTimersByTimeAsync(9000))
    expect(
      getProjectResources.mock.calls.filter(([request]) => request.projectId === 'project-2')
    ).toHaveLength(reads)
  })

  it('reports final desktop cleanup failures even when the resource list is empty', async () => {
    desktop([])
    view = {
      groups: [],
      pendingDecisions: [],
      releases: [
        release({ status: 'released', phase: 'release', operationId: 'complete' }),
        release({ status: 'releasing', phase: 'retry', operationId: 'in-progress' }),
        release({
          status: 'partial',
          phase: 'force-close',
          resources: [
            {
              id: 'python-original',
              group: 'kernel',
              kind: 'python',
              status: 'incomplete',
              temporaryResourcesRemoved: false
            }
          ]
        })
      ]
    }
    await render()
    expect(screen.getByRole('alert').textContent).toContain('Cleanup incomplete')
    expect(container.textContent).not.toContain('Notebook resources released')
    expect(container.textContent).toContain('Retrying Notebook cleanup')
    const notice = screen.getByRole('alert').closest('section')!
    await act(async () => fireEvent.click(within(notice).getByText('Details', { exact: true })))
    expect(within(notice).getByText(/Temporary resources removed: No/)).toBeTruthy()
    await act(async () => fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' })))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps a desktop cleanup completion that arrives before the Stop response', async () => {
    vi.useFakeTimers()
    desktop([process('python', 'python')])
    const pending = Promise.withResolvers<NotebookResourceRelease>()
    releaseSessionResources.mockReturnValueOnce(pending.promise)
    await render()
    await stopAll(screen.getByText('Research analysis').closest('section')!)
    const confirmation = screen.getByRole('alertdialog')
    await act(async () => button('Stop', confirmation).click())

    view = {
      ...view,
      groups: [],
      releases: [release({ phase: 'release', status: 'released' })]
    }
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(screen.queryByText('Notebook resources released')).toBeNull()
    const refresh = Promise.withResolvers<NotebookProjectResources>()
    getProjectResources.mockReturnValueOnce(refresh.promise)
    await act(async () => pending.resolve(release({ phase: 'release' })))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Notebook resources released')
    await act(async () => refresh.resolve(view))
  })

  it('retries the original desktop cleanup operation without any remaining resource rows', async () => {
    vi.useFakeTimers()
    desktop([])
    const partial = release({ phase: 'force-close', status: 'partial', finishedAt: Date.now() })
    view = { ...view, groups: [], releases: [partial] }
    const pending = Promise.withResolvers<NotebookResourceRelease>()
    retryResourceRelease.mockReturnValueOnce(pending.promise)
    await render()

    const retry = button('Retry cleanup')
    await act(async () => retry.click())
    expect(retry.disabled).toBe(true)
    expect(retryResourceRelease).toHaveBeenCalledExactlyOnceWith({
      projectId: partial.projectId,
      sessionId: partial.sessionId,
      operationId: partial.operationId
    })
    await act(async () => pending.reject(new Error('Cleanup service unavailable')))
    expect(container.textContent).toContain('Notebook release could not be confirmed.')
    expect(retry.disabled).toBe(false)

    const staleView = view
    const staleRead = Promise.withResolvers<NotebookProjectResources>()
    getProjectResources.mockReturnValueOnce(staleRead.promise)
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    retryResourceRelease.mockImplementationOnce(async () => {
      const result = release({ phase: 'retry', status: 'releasing' })
      view = { ...view, releases: [result] }
      return result
    })
    await act(async () => retry.click())
    expect(retryResourceRelease.mock.calls[1]).toEqual(retryResourceRelease.mock.calls[0])
    expect(releaseSessionResources).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Retry cleanup' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Retrying Notebook cleanup…')
    expect(screen.queryByRole('alert')).toBeNull()

    await act(async () => staleRead.resolve(staleView))
    expect(screen.queryByRole('button', { name: 'Retry cleanup' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Retrying Notebook cleanup…')

    view = { ...view, releases: [release({ phase: 'retry', status: 'released' })] }
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(screen.getByRole('status').textContent).toContain('Notebook resources released')
  })

  it.each(['Cancel', 'Escape'] as const)(
    'restores focus when desktop Stop closes using %s',
    async (close) => {
      vi.useFakeTimers()
      desktop([process('python', 'python')])
      await render()
      const session = screen.getByText('Research analysis').closest('section')!
      const stop = button('Stop all', session.querySelector('header')!)
      await stopAll(session)
      const confirmation = screen.getByRole('alertdialog')
      await act(async () => {
        if (close === 'Escape') fireEvent.keyDown(confirmation, { key: 'Escape' })
        else button('Cancel', confirmation).click()
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(document.activeElement).toBe(stop)
      expect(releaseSessionResources).not.toHaveBeenCalled()
    }
  )

  it('focuses the project scope control if the session disappears during confirmation', async () => {
    vi.useFakeTimers()
    const { update } = desktop([process('python', 'python')])
    await render()
    const session = screen.getByText('Research analysis').closest('section')!
    await stopAll(session)

    update([])
    view = { ...view, groups: [] }
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(screen.queryByText('Research analysis')).toBeNull()
    const confirmation = screen.getByRole('alertdialog')
    await act(async () => {
      fireEvent.keyDown(confirmation, { key: 'Escape' })
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(button('All projects'))
  })

  it('distinguishes loading, failed reads, stale data and a confirmed empty project', async () => {
    let fail!: (error: Error) => void
    getProjectResources.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject
        })
    )
    await render()
    expect(container.textContent).toContain('Loading…')
    expect(container.textContent).not.toContain('No running Notebooks')
    await act(async () => fail(new Error('resources offline')))
    expect(container.textContent).toContain('Could not refresh Notebook resources')
    expect(container.textContent).not.toContain('Sessions: 0')
    expect(container.textContent).not.toContain('No running Notebooks')

    vi.mocked(window.api.notebook.getProjectActivity).mockRejectedValue(
      new Error('activity offline')
    )
    await act(async () => button('Refresh Notebook resources').click())
    expect(container.textContent).toContain('Research analysis')
    expect(container.textContent).not.toContain('Could not refresh Notebook resources')
    getProjectResources.mockRejectedValueOnce(new Error('resources offline'))
    await act(async () => changed())
    expect(container.textContent).toContain('The last successful sample is shown.')
    expect(container.textContent).toContain('Research analysis')

    view = { groups: [], pendingDecisions: [], releases: [] }
    await act(async () => button('Refresh Notebook resources').click())
    expect(container.textContent).toContain('No running Notebooks')
    expect(container.textContent).not.toContain('Could not refresh Notebook resources')
  })

  it('cancels without stopping and confirms only the resources shown when confirmation opened', async () => {
    await render()
    await act(async () => button('Stop and release Notebook').click())
    const firstDialog = document.querySelector('[role="alertdialog"]')!
    expect(firstDialog.textContent).toContain('Variables and connections will be lost')
    expect(firstDialog.textContent).toContain(
      'History, saved outputs, files, and installed environments are kept'
    )
    expect(firstDialog.textContent).toContain('Earlier file writes are not undone')
    expect(firstDialog.textContent).toContain('Independent remote Compute Jobs are not stopped')
    await act(async () => button('Cancel', firstDialog).click())
    expect(releaseSessionResources).not.toHaveBeenCalled()

    await act(async () => button('Stop and release Notebook').click())
    view = { ...view, groups: [group('replacement-resources')] }
    await act(async () => changed())
    await act(async () =>
      button('Stop and release', document.querySelector('[role="alertdialog"]')!).click()
    )
    expect(releaseSessionResources).toHaveBeenCalledExactlyOnceWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      revision: 'original-resources'
    })
  })

  it('summarizes each resource and keeps its memory diagnostics in an independent disclosure', async () => {
    const original = group()
    view.groups = [
      {
        ...original,
        resources: [
          ...original.resources,
          {
            id: 'r-delegate',
            group: 'kernel',
            kind: 'r',
            environment: 'statistics',
            laneKey: 'delegate-1',
            phase: 'idle',
            memory: { metric: 'rss', coverage: 'partial', rssBytes: 1048576, sampledAt: Date.now() }
          },
          {
            id: 'shell-starting',
            group: 'shell',
            kind: 'bash',
            laneKey: 'delegate-2',
            phase: 'starting',
            memory: {
              metric: 'private-bytes-and-working-set',
              coverage: 'complete',
              privateBytes: 2097152,
              workingSetBytes: 1048576,
              sampledAt: Date.now()
            }
          },
          {
            id: 'pending-request',
            group: 'operation',
            phase: 'ready',
            memory: { metric: 'rss', coverage: 'unknown', sampledAt: Date.now() }
          }
        ]
      }
    ]
    await render()
    const rows = [
      ...container.querySelectorAll<HTMLDetailsElement>(
        'section[aria-label="Research analysis"] details'
      )
    ]
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => !row.open)).toBe(true)
    const summaries = rows.map((row) => row.querySelector('summary')!)
    expect(summaries[0].textContent).toContain('Python · research')
    expect(summaries[0].textContent).toContain('Running')
    expect(summaries[0].textContent).toContain('Elapsed time')
    expect(summaries[0].textContent).not.toContain('Memory usage')
    expect(summaries[1].textContent).toContain('R · statistics')
    expect(summaries[1].textContent).toContain('1.0 MB')
    expect(summaries[1].textContent).toContain('Partial data')
    expect(summaries[2].textContent).toContain('Shell')
    expect(summaries[2].textContent).toContain('Starting')
    expect(summaries[2].textContent).toContain('1.0 MB')
    expect(summaries[2].textContent).not.toContain('2.0 MB')
    expect(summaries[3].textContent).toContain('Pending operation')
    expect(summaries[3].textContent).toContain('Ready')
    expect(summaries[3].textContent).not.toContain('Unknown')
    for (const summary of summaries) {
      expect(summary.textContent).not.toMatch(/Lane:|Sampled:|RSS:|Complete data/)
    }
    await act(async () => summaries[1].click())
    expect(rows.map((row) => row.open)).toEqual([false, true, false, false])
    expect(rows[1].textContent).toContain('Lane: delegate-1')
    expect(rows[1].textContent).toContain('RSS: 1.0 MB')
    expect(rows[1].textContent).toContain('Sampled:')
    expect(rows[1].textContent).toContain('RSS may include shared pages')
    expect(rows[2].textContent).toContain('Private Bytes: 2.0 MB')
    expect(rows[2].textContent).toContain('Working Set: 1.0 MB')
    await act(async () => changed())
    expect(rows[1].open).toBe(true)
    await act(async () => summaries[1].click())
    expect(rows[1].open).toBe(false)
    expect(button('Stop and release Notebook').disabled).toBe(false)
  })

  it('hides progress without cancelling cleanup and retries only the same partial operation', async () => {
    await render()
    await act(async () => button('Stop and release Notebook').click())
    await act(async () =>
      button('Stop and release', document.querySelector('[role="alertdialog"]')!).click()
    )
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Releasing Notebook resources'
    )
    await act(async () => root?.render(<ProjectComputeInbox isActive={false} />))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => root?.render(<ProjectComputeInbox isActive />))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Releasing Notebook resources'
    )
    await act(async () => button('Close progress').click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(releaseSessionResources).toHaveBeenCalledOnce()
    expect(retryResourceRelease).not.toHaveBeenCalled()

    const partial = release({
      status: 'partial',
      resources: [
        {
          id: 'python-original',
          group: 'kernel',
          kind: 'python',
          status: 'released',
          processesTerminated: true,
          projection: 'complete'
        },
        {
          id: 'shell-original',
          group: 'shell',
          status: 'incomplete',
          processesTerminated: false,
          networkClosed: true,
          temporaryResourcesRemoved: false,
          projection: 'failed'
        }
      ]
    })
    view = { ...view, releases: [partial] }
    await act(async () => changed())
    await act(async () => button('View cleanup progress').click())
    const progress = document.querySelector('[role="dialog"]')!
    expect(progress.textContent).toContain('Cleanup incomplete')
    expect(progress.textContent).toContain('Released')
    expect(progress.textContent).toContain('Processes terminated: No')
    expect(progress.textContent).toContain('Network closed: Yes')
    expect(progress.textContent).toContain('Temporary resources removed: No')
    expect(progress.textContent).toContain('Saved Notebook state could not be updated.')

    retryResourceRelease.mockImplementation(async () => {
      const result = release({ status: 'released' })
      view = { groups: [], pendingDecisions: [], releases: [result] }
      return result
    })
    await act(async () => button('Retry cleanup', progress).click())
    expect(retryResourceRelease).toHaveBeenCalledExactlyOnceWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      operationId: 'release-original'
    })
    expect(releaseSessionResources).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Notebook resources released'
    )
  })

  it('polls at five-second intervals without overlapping reads and stops while hidden or unmounted', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await render()
    expect(getProjectResources).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(4_999))
    expect(getProjectResources).toHaveBeenCalledOnce()
    let finish!: (value: NotebookProjectResources) => void
    getProjectResources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(getProjectResources).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(getProjectResources).toHaveBeenCalledTimes(2)
    await act(async () => finish(view))
    expect(getProjectResources).toHaveBeenCalledTimes(2)

    visibility.mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await act(async () => {
      changed()
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(getProjectResources).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(getProjectResources).toHaveBeenCalledTimes(3)
    await act(async () => root?.render(<ProjectComputeInbox isActive={false} />))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(getProjectResources).toHaveBeenCalledTimes(3)
    await act(async () => root?.render(<ProjectComputeInbox isActive />))
    expect(getProjectResources).toHaveBeenCalledTimes(4)
    act(() => {
      root?.unmount()
      root = undefined
    })
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(getProjectResources).toHaveBeenCalledTimes(4)
  })

  it('discovers a new ready batch after opening an empty Compute view', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    view = { groups: [], pendingDecisions: [], releases: [] }
    await render()
    expect(container.textContent).toContain('No running Notebooks')
    expect(getProjectResources).toHaveBeenCalledOnce()

    view = {
      groups: [
        {
          ...group('ready-batch'),
          resources: [
            {
              id: 'batch-created-later',
              group: 'batch',
              phase: 'ready',
              memory: { metric: 'rss', coverage: 'unknown', sampledAt: Date.now() }
            }
          ]
        }
      ],
      pendingDecisions: [
        { projectId: 'project-1', sessionId: 'session-1', refusalId: 'refusal-created-later' }
      ],
      releases: []
    }
    await act(async () => vi.advanceTimersByTimeAsync(4_999))
    expect(getProjectResources).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('Reproduction batch')

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(getProjectResources).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Reproduction batch')
    expect(container.textContent).toContain('Ready')
  })

  it.each([
    ['release-in-progress', 'Notebook cleanup is already in progress.'],
    ['session-exporting', 'This Session is being exported. Wait, then review the resources again.'],
    [
      'runtime-binding-changing',
      'The Notebook environment is changing. Wait, then review the resources again.'
    ],
    ['cleanup-in-progress', 'Notebook cleanup is already in progress.'],
    ['application-stopping', 'Open-Science is shutting down.'],
    ['application-updating', 'An update is in progress. Wait, then review the resources again.'],
    [
      'package-handoff',
      'Session files are being transferred. Wait, then review the resources again.'
    ],
    ['data-migration', 'Data is being moved. Wait, then review the resources again.'],
    [
      'session-unavailable',
      'This Session is unavailable or you do not have permission to manage it.'
    ],
    [
      'future-conflict',
      'Notebook release is currently unavailable. Refresh and review the resources again.'
    ]
  ])(
    'keeps the release entry visible with a friendly %s explanation',
    async (reason, explanation) => {
      view.groups[0].releaseBlockedReason = reason
      await render()
      expect(button('Stop and release Notebook').disabled).toBe(true)
      expect(container.textContent).toContain(explanation)
      expect(container.textContent).not.toContain(reason)
      expect(releaseSessionResources).not.toHaveBeenCalled()
    }
  )

  it('refreshes a stale confirmation and reports the failure without silently confirming replacement resources', async () => {
    await render()
    await act(async () => button('Stop and release Notebook').click())
    view = {
      ...view,
      groups: [
        {
          ...group('replacement'),
          resources: [{ ...group().resources[0], environment: 'replacement environment' }]
        }
      ]
    }
    releaseSessionResources.mockRejectedValueOnce(new Error('resource-set-changed'))
    await act(async () =>
      button('Stop and release', document.querySelector('[role="alertdialog"]')!).click()
    )
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Notebook release could not be confirmed'
    )
    expect(container.textContent).toContain('replacement environment')
    expect(releaseSessionResources).toHaveBeenCalledOnce()
  })

  it('disables retry during a current Session conflict and enables the same operation when it clears', async () => {
    view = {
      ...view,
      groups: [{ ...group(), releaseBlockedReason: 'session-exporting' }],
      releases: [release({ status: 'partial' })]
    }
    await render()
    await act(async () => button('View cleanup progress').click())
    const progress = document.querySelector('[role="dialog"]')!
    expect(button('Retry cleanup', progress).disabled).toBe(true)
    expect(progress.textContent).toContain(
      'This Session is being exported. Wait, then review the resources again.'
    )
    expect(retryResourceRelease).not.toHaveBeenCalled()
    view = { ...view, groups: [group()] }
    await act(async () => changed())
    expect(button('Retry cleanup', progress).disabled).toBe(false)
  })

  it('keeps a single read in flight when a retained Compute tab is hidden and reopened before it settles', async () => {
    await render()
    let finish!: (value: NotebookProjectResources) => void
    getProjectResources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    act(() => changed())
    expect(getProjectResources).toHaveBeenCalledTimes(2)
    await act(async () => root?.render(<ProjectComputeInbox isActive={false} />))
    await act(async () => root?.render(<ProjectComputeInbox isActive />))
    expect(getProjectResources).toHaveBeenCalledTimes(2)
    await act(async () => finish(view))
    expect(getProjectResources).toHaveBeenCalledTimes(3)
  })

  it('identifies original environments and lanes in cleanup results after their resources are replaced', async () => {
    const completed = release({
      status: 'released',
      resources: [
        {
          id: 'python-original',
          group: 'kernel',
          kind: 'python',
          environment: 'original analysis',
          laneKey: 'original-main',
          status: 'released'
        },
        {
          id: 'python-delegate',
          group: 'kernel',
          kind: 'python',
          environment: 'original statistics',
          laneKey: 'original-delegate',
          status: 'released'
        }
      ]
    })
    view = { groups: [], pendingDecisions: [], releases: [completed] }
    await render()
    await act(async () => button('View cleanup progress').click())
    const progress = document.querySelector('[role="dialog"]')!
    expect(progress.textContent).toContain('Python · original analysis')
    expect(progress.textContent).toContain('Python · original statistics')
    expect(progress.textContent).toContain('Lane: original-main')
    expect(progress.textContent).toContain('Lane: original-delegate')
    view = {
      ...view,
      groups: [
        {
          ...group('replacement'),
          resources: [
            {
              ...group().resources[0],
              environment: 'replacement environment',
              laneKey: 'replacement-lane'
            }
          ]
        }
      ]
    }
    await act(async () => changed())
    expect(progress.textContent).toContain('original analysis')
    expect(progress.textContent).not.toContain('replacement environment')
  })

  it('shows completed installer cleanup separately from environment recovery in remote progress', async () => {
    const completed = release({
      status: 'released',
      resources: [
        {
          id: 'installer',
          group: 'installer',
          status: 'released',
          processesTerminated: true,
          environmentRecoveryRequired: true
        }
      ]
    })
    view = { groups: [], pendingDecisions: [], releases: [completed] }
    await render()
    await act(async () => button('View cleanup progress').click())
    const progress = screen.getByRole('dialog')
    expect(progress.textContent).toContain('Processes terminated: Yes')
    expect(progress.textContent).toContain(
      'The installer stopped. Recover the affected environment before using it again.'
    )
    expect(within(progress).queryByRole('button', { name: 'Retry cleanup' })).toBeNull()
  })
})
