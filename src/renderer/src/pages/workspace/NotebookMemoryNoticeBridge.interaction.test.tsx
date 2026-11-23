// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  NotebookMemoryRejectedEvent,
  NotebookMemoryPolicyChangedEvent
} from '../../../../shared/notebook-memory'
import { useNotebookMemoryNoticeStore } from '@/stores/notebook-memory-notice-store'
import {
  createInitialPreviewWorkbenchState,
  PROJECT_COMPUTE_PREVIEW_ID,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { BottomNoticeStack } from '@/components/ActionToast'
import {
  NotebookMemoryNoticeBridge,
  NotebookMemoryPressureNotice
} from './NotebookMemoryNoticeBridge'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let changed: (event: NotebookMemoryPolicyChangedEvent) => void
let rejected: (event: NotebookMemoryRejectedEvent) => void
const execute = vi.fn()
const unsubscribeMemoryPolicy = vi.fn()

beforeEach(() => {
  execute.mockReset()
  unsubscribeMemoryPolicy.mockReset()
  useNotebookMemoryNoticeStore.setState({
    rejection: undefined,
    latestCheck: undefined,
    terminal: undefined,
    dismissedRefusalIds: [],
    dismissedPressureScopes: [],
    pressure: undefined
  })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  window.api = {
    notebook: {
      onMemoryRejected: vi.fn((listener) => {
        rejected = listener
        return vi.fn()
      }),
      onMemoryPolicyChanged: vi.fn((listener) => {
        changed = listener
        return unsubscribeMemoryPolicy
      }),
      execute
    }
  } as never
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it('shows a live Agent refusal without a Notebook pane and ends it on Escape', async () => {
  const continueExecution = vi.fn()
  await act(async () => {
    root.render(<NotebookMemoryNoticeBridge projectId="project" onContinue={continueExecution} />)
  })
  await act(async () => {
    rejected({
      projectId: 'project',
      sessionId: 'session',
      source: 'agent',
      refusalId: 'refusal',
      memory: {
        status: 'pressured',
        reason: 'windows-physical-low',
        source: 'windows-performance-info',
        executionScope: 'windows:host',
        checkedAt: 1
      }
    })
  })

  expect(screen.getByRole('dialog', { name: 'System memory is under pressure' })).toBeTruthy()
  expect(
    screen.getByText('This code did not run. Choose whether to retry or manage Notebook resources.')
  ).toBeTruthy()
  expect(continueExecution).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()

  await act(async () => fireEvent.keyDown(document.body, { key: 'Escape' }))

  expect(screen.queryByRole('dialog')).toBeNull()
  expect(continueExecution).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
})

it('keeps a failed explicit continuation visible and dismisses only after a successful click', async () => {
  const continueExecution = vi
    .fn()
    .mockRejectedValueOnce(new Error('Continuation unavailable'))
    .mockResolvedValue(undefined)
  const refusal: NotebookMemoryRejectedEvent = {
    projectId: 'project',
    sessionId: 'session',
    workspaceCwd: '/workspace/project',
    source: 'agent',
    refusalId: 'refusal',
    memory: {
      status: 'pressured',
      reason: 'low',
      source: 'linux-procfs',
      executionScope: 'linux:host',
      checkedAt: 1
    }
  }
  await act(async () =>
    root.render(<NotebookMemoryNoticeBridge projectId="project" onContinue={continueExecution} />)
  )
  await act(async () => rejected(refusal))
  expect(continueExecution).not.toHaveBeenCalled()

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Recheck and retry' })))
  expect(continueExecution).toHaveBeenCalledExactlyOnceWith(refusal)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByText('Continuation unavailable')).toBeTruthy()
  expect(execute).not.toHaveBeenCalled()

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Recheck and retry' })))
  expect(continueExecution).toHaveBeenCalledTimes(2)
  expect(continueExecution).toHaveBeenNthCalledWith(2, refusal)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(execute).not.toHaveBeenCalled()
})

it('updates recovery without running and opens the existing Compute preview on Manage', async () => {
  const continueExecution = vi.fn()
  await act(async () =>
    root.render(
      <>
        <NotebookMemoryNoticeBridge projectId="project" onContinue={continueExecution} />
        <NotebookMemoryPressureNotice />
      </>
    )
  )
  await act(async () =>
    rejected({
      projectId: 'project',
      sessionId: 'session',
      source: 'agent',
      refusalId: 'r',
      memory: {
        status: 'pressured',
        reason: 'linux-cgroup-high',
        source: 'linux-proc-cgroup-v2',
        executionScope: 'linux:cgroup-v2:/tenant/child',
        limitingCgroupPath: '/tenant',
        cgroupConstraints: [{ path: '/tenant', currentBytes: 1024 ** 3, highBytes: 1024 ** 3 }],
        checkedAt: 1
      }
    })
  )
  await act(async () =>
    changed({
      hasLiveResources: true,
      memory: {
        status: 'healthy',
        reason: 'healthy',
        source: 'linux-proc-cgroup-v2',
        executionScope: 'linux:cgroup-v2:/tenant/child',
        cgroupConstraints: [
          { path: '/tenant/child', currentBytes: 42, highBytes: 100 },
          { path: '/tenant', currentBytes: 512 * 1024 ** 2, highBytes: 1024 ** 3 }
        ],
        checkedAt: 2
      }
    })
  )
  await act(async () => fireEvent.click(screen.getByText('Memory check details')))
  expect(
    screen.getByRole('row', {
      name: 'cgroup usage / throttling limit 1 GiB / 1 GiB 512 MiB / 1 GiB'
    })
  ).toBeTruthy()
  expect(
    screen.getByText('Memory has recovered. Execution still requires your choice.')
  ).toBeTruthy()
  expect(continueExecution).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Manage Notebook resources' }))
  )
  expect(usePreviewWorkbenchStore.getState().activeItemId).toBe(PROJECT_COMPUTE_PREVIEW_ID)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(continueExecution).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
})

it('shows macOS pressure and the remaining recovery window in separate readings', async () => {
  const memory = {
    status: 'pressured',
    reason: 'mac-memory-critical',
    pressureLevel: 'critical',
    source: 'darwin-sysctl-dispatch',
    executionScope: 'darwin:host',
    checkedAt: 1
  } as const
  window.api.notebook.getMemoryPolicyState = vi.fn(async () => ({
    ...memory,
    checkedAt: 2,
    reason: 'mac-memory-recovering',
    pressureLevel: 'normal' as const,
    recoveryRemainingMs: 15_000
  }))
  await act(async () => root.render(<NotebookMemoryNoticeBridge projectId="project" />))
  await act(async () => rejected({ projectId: 'project', sessionId: 'session', memory }))
  await act(async () => fireEvent.click(screen.getByText('Memory check details')))
  expect(
    screen.getByRole('row', {
      name: 'Status Critical memory pressure Waiting for stable memory pressure'
    })
  ).toBeTruthy()
  expect(screen.getByRole('row', { name: /Recovery time remaining.*15/ })).toBeTruthy()
})

it.each(['warning', 'critical'] as const)(
  'dismisses background %s pressure outside the workspace without repeated notices',
  async (pressureLevel) => {
    vi.useFakeTimers()
    try {
      await act(async () =>
        root.render(
          <BottomNoticeStack>
            <NotebookMemoryPressureNotice />
          </BottomNoticeStack>
        )
      )
      expect(window.api.notebook.onMemoryPolicyChanged).toHaveBeenCalledOnce()
      const pressure: NotebookMemoryPolicyChangedEvent = {
        hasLiveResources: true,
        memory: {
          status: 'pressured',
          reason: `mac-memory-${pressureLevel}`,
          source: 'darwin-sysctl-dispatch',
          executionScope: 'darwin:host',
          checkedAt: 1,
          pressureLevel
        }
      }
      await act(async () => changed({ ...pressure, hasLiveResources: false }))
      expect(screen.queryByRole('status')).toBeNull()
      await act(async () => changed(pressure))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getByRole('status').closest('[data-bottom-notice-stack]')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
      if (pressureLevel === 'warning') {
        await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Close' })))
      } else {
        await act(async () => vi.advanceTimersByTime(3000))
        await act(async () =>
          changed({ ...pressure, memory: { ...pressure.memory, checkedAt: 2 } })
        )
        await act(async () => vi.advanceTimersByTime(3000))
      }
      expect(screen.queryByRole('status')).toBeNull()
      await act(async () => changed(pressure))
      expect(screen.queryByRole('status')).toBeNull()
      await act(async () =>
        changed({
          ...pressure,
          memory: { ...pressure.memory, status: 'healthy', pressureLevel: 'normal' }
        })
      )
      await act(async () => changed(pressure))
      expect(screen.getByRole('status')).toBeTruthy()
      await act(async () => changed({ ...pressure, hasLiveResources: false }))
      expect(screen.queryByRole('status')).toBeNull()
      expect(execute).not.toHaveBeenCalled()
      await act(async () => root.render(null))
      expect(unsubscribeMemoryPolicy).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  }
)

it('refreshes visible policy with one request in flight and stops polling after dismissal', async () => {
  let finish!: (value: NotebookMemoryPolicyChangedEvent['memory']) => void
  const getMemoryPolicyState = vi.fn(
    () =>
      new Promise<NotebookMemoryPolicyChangedEvent['memory']>((resolve) => {
        finish = resolve
      })
  )
  window.api.notebook.getMemoryPolicyState = getMemoryPolicyState
  const continueExecution = vi.fn()
  await act(async () =>
    root.render(<NotebookMemoryNoticeBridge projectId="project" onContinue={continueExecution} />)
  )
  vi.useFakeTimers()
  try {
    await act(async () =>
      rejected({
        projectId: 'project',
        sessionId: 'session',
        refusalId: 'poll-r',
        source: 'agent',
        memory: {
          status: 'pressured',
          availableBytes: 512 * 1024 ** 2,
          totalBytes: 8 * 1024 ** 3,
          reason: 'linux-memory-low',
          source: 'linux-procfs',
          executionScope: 'linux:host',
          checkedAt: 1
        }
      })
    )
    expect(getMemoryPolicyState).toHaveBeenCalledWith({ executionScope: 'linux:host' })
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    expect(getMemoryPolicyState).toHaveBeenCalledTimes(1)
    await act(async () =>
      finish({
        status: 'healthy',
        reason: 'recovered',
        availableBytes: 3 * 1024 ** 3,
        totalBytes: 8 * 1024 ** 3,
        source: 'linux-procfs',
        executionScope: 'linux:host',
        checkedAt: 2
      })
    )
    expect(
      screen.getByText('Memory has recovered. Execution still requires your choice.')
    ).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByText('Memory check details')))
    expect(
      screen.getByRole('row', { name: 'Available RAM / total 512 MiB / 8 GiB 3 GiB / 8 GiB' })
    ).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    expect(getMemoryPolicyState).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
    expect(continueExecution).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('does not reopen a cancelled refusal when the same blocked intent calls again', async () => {
  await act(async () => root.render(<NotebookMemoryNoticeBridge projectId="project" />))
  const refusal: NotebookMemoryRejectedEvent = {
    projectId: 'project',
    sessionId: 'session',
    source: 'agent',
    refusalId: 'same-intent',
    memory: {
      status: 'unavailable',
      reason: 'memory-component-unavailable',
      source: 'memory-policy',
      executionScope: 'darwin:host',
      checkedAt: 1
    }
  }
  await act(async () => rejected(refusal))
  expect(
    screen.getByRole('dialog', { name: 'Notebook memory checking is unavailable' })
  ).toBeTruthy()
  expect(
    screen.getByText(
      'The memory checking component is unavailable. Update or repair the installation before retrying.'
    )
  ).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))
  await act(async () => rejected(refusal))
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => rejected({ ...refusal, refusalId: 'new-intent' }))
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(execute).not.toHaveBeenCalled()
})
