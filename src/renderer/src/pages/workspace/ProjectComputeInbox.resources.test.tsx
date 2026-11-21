// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createI18nTestStub } from '../../../../../test/i18n-test-stub'
import type {
  NotebookProjectResources,
  NotebookResourceRelease,
  NotebookSessionResources
} from '../../../../shared/notebook-resources'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'
import { useProjectStore } from '@/stores/project-store'
import {
  dismissNotebookMemoryRejection,
  observeNotebookMemoryPolicy,
  presentNotebookMemoryRejection,
  useNotebookMemoryNoticeStore
} from '@/stores/notebook-memory-notice-store'
import { ProjectComputeInbox } from './ProjectComputeInbox'

vi.mock('react-i18next', () => createI18nTestStub())
const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }))
vi.mock('@/lib/acp/useWorkspaceAgentRuntime', () => ({
  useWorkspaceAgentRuntime: () => ({ sendMessage })
}))
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
    vi.resetAllMocks()
    useNotebookMemoryNoticeStore.setState({
      rejection: undefined,
      dismissedRefusalIds: [],
      dismissedPressureScopes: []
    })
    view = { groups: [group()], pendingDecisions: [], releases: [] }
    getProjectResources.mockImplementation(async () => view)
    releaseSessionResources.mockImplementation(async () => {
      const result = release()
      view = { ...view, releases: [result] }
      return result
    })
    sendMessage.mockResolvedValue({ id: 'fresh-user-message' })
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
    act(() => root?.unmount())
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('data-open-science-web-events')
    vi.useRealTimers()
    vi.restoreAllMocks()
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
    await act(async () => button('Refresh').click())
    expect(container.textContent).toContain('Research analysis')
    expect(container.textContent).not.toContain('Could not refresh Notebook resources')
    getProjectResources.mockRejectedValueOnce(new Error('resources offline'))
    await act(async () => changed())
    expect(container.textContent).toContain('The last successful sample is shown.')
    expect(container.textContent).toContain('Research analysis')

    view = { groups: [], pendingDecisions: [], releases: [] }
    await act(async () => button('Refresh').click())
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
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('shows every resource and separates interpreter counts from pending work and diagnostic memory', async () => {
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
    expect(container.textContent).toContain('Python · research')
    expect(container.textContent).toContain('R · statistics')
    expect(container.textContent).toContain('Shell')
    expect(container.textContent).toContain('Pending operation')
    expect(container.textContent).toContain('Interpreters: 3')
    expect(container.textContent).toContain('Resources: 4')
    expect(container.textContent).toContain('delegate-1')
    expect(container.textContent).toContain('Starting')
    expect(container.textContent).toContain('Ready')
    expect(container.textContent).toContain('RSS: 1.0 MB')
    expect(container.textContent).toContain('Private Bytes: 2.0 MB')
    expect(container.textContent).toContain('Working Set: 1.0 MB')
    expect(container.textContent).toContain('Partial data')
    expect(container.textContent).toContain('Sampled:')
    expect(container.textContent).toContain('Runtime: Unknown')
    expect(container.textContent).toContain(
      'RSS may include shared pages and does not predict how much memory will be released.'
    )
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
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('keeps an explicit continuation after dismissal and healthy recovery even when no resources exist', async () => {
    const memory = {
      status: 'pressured' as const,
      reason: 'linux-memory-low',
      source: 'linux-proc',
      executionScope: 'linux:host',
      checkedAt: 1
    }
    presentNotebookMemoryRejection({
      projectId: 'project-1',
      sessionId: 'session-1',
      source: 'agent',
      refusalId: 'refusal-original',
      memory
    })
    dismissNotebookMemoryRejection()
    observeNotebookMemoryPolicy({
      hasLiveResources: false,
      memory: { ...memory, status: 'healthy', reason: 'memory-available', checkedAt: 2 }
    })
    expect(useNotebookMemoryNoticeStore.getState().rejection).toBeUndefined()
    view = {
      groups: [],
      releases: [],
      pendingDecisions: [
        { projectId: 'project-1', sessionId: 'session-1', refusalId: 'refusal-original' }
      ]
    }
    await render()
    expect(container.textContent).toContain('No running Notebooks')
    expect(container.textContent).toContain('Waiting for your decision')
    expect(container.textContent).not.toContain('Interpreters: 1')
    expect(sendMessage).not.toHaveBeenCalled()
    await act(async () => button('Continue Notebook work').click())
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      cwd: '/workspace',
      requireExistingSession: true,
      preserveSelection: true,
      notebookContinuation: { refusalId: 'refusal-original' },
      text: 'Recheck memory and reconsider the blocked Notebook work. Keep completed results and ask before repeating completed steps.'
    })
    expect(releaseSessionResources).not.toHaveBeenCalled()
  })

  it('shows where to continue stopped Notebook work when Compute is open in Web', async () => {
    document.documentElement.setAttribute('data-open-science-web-events', 'true')
    view = {
      groups: [],
      releases: [],
      pendingDecisions: [
        { projectId: 'project-1', sessionId: 'session-1', refusalId: 'refusal-original' }
      ]
    }
    await render()
    expect(container.textContent).toContain(
      'Open the same Session and branch in the Open-Science desktop app'
    )
    expect(
      [...container.querySelectorAll('button')].some(
        (item) => item.textContent === 'Continue Notebook work'
      )
    ).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
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

  it('discovers a new ready batch and pending decision after opening an empty Compute view', async () => {
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
    expect(container.textContent).not.toContain('Waiting for your decision')

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(getProjectResources).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Reproduction batch')
    expect(container.textContent).toContain('Ready')
    expect(container.textContent).toContain('Waiting for your decision')
    expect(button('Continue Notebook work').disabled).toBe(false)
    expect(sendMessage).not.toHaveBeenCalled()
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
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('offers a current cross-project origin decision from the release result once and removes it when replaced', async () => {
    const origin = {
      projectId: 'project-origin',
      sessionId: 'session-origin',
      refusalId: 'origin-refusal'
    }
    useProjectStore.setState({
      projects: [
        {
          id: origin.projectId,
          name: 'Original project',
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const existing = useSessionStore.getState().sessions[0]
    useSessionStore.setState({
      sessions: [
        ...useSessionStore.getState().sessions,
        {
          ...existing,
          id: origin.sessionId,
          projectId: origin.projectId,
          title: 'Original discussion',
          cwd: '/origin'
        }
      ]
    })
    view = {
      groups: [],
      pendingDecisions: [],
      releases: [release({ status: 'released', continuations: [origin] })]
    }
    await render()
    expect(container.textContent).toContain('Project: Original project')
    expect(
      [...container.querySelectorAll('button')].filter(
        (item) => item.textContent === 'Continue Notebook work'
      )
    ).toHaveLength(1)
    view = { ...view, pendingDecisions: [origin] }
    await act(async () => changed())
    expect(
      [...container.querySelectorAll('button')].filter(
        (item) => item.textContent === 'Continue Notebook work'
      )
    ).toHaveLength(1)
    await act(async () => button('Continue Notebook work').click())
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-origin',
        sessionId: 'session-origin',
        cwd: '/origin',
        requireExistingSession: true,
        preserveSelection: true,
        notebookContinuation: { refusalId: 'origin-refusal' }
      })
    )
    view = {
      groups: [],
      pendingDecisions: [],
      releases: [release({ status: 'released', continuations: [] })]
    }
    await act(async () => changed())
    expect(
      [...container.querySelectorAll('button')].some(
        (item) => item.textContent === 'Continue Notebook work'
      )
    ).toBe(false)
  })

  it('keeps a local failure notice when a stale continuation disappears after refresh', async () => {
    view = {
      groups: [],
      releases: [],
      pendingDecisions: [
        { projectId: 'project-1', sessionId: 'session-1', refusalId: 'obsolete-refusal' }
      ]
    }
    await render()
    sendMessage.mockImplementationOnce(async () => {
      view = { groups: [], pendingDecisions: [], releases: [] }
      throw new Error('The current Notebook decision changed.')
    })
    await act(async () => button('Continue Notebook work').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Notebook continuation could not be started. The previous request remains stopped.'
    )
    expect(
      [...container.querySelectorAll('button')].some(
        (item) => item.textContent === 'Continue Notebook work'
      )
    ).toBe(false)
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(getProjectResources).toHaveBeenCalledTimes(2)
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
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
