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
import { NotebookMemoryNoticeBridge } from './NotebookMemoryNoticeBridge'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let changed: (event: NotebookMemoryPolicyChangedEvent) => void
let rejected: (event: NotebookMemoryRejectedEvent) => void
const execute = vi.fn()

beforeEach(() => {
  execute.mockReset()
  useNotebookMemoryNoticeStore.setState({
    rejection: undefined,
    warning: undefined,
    terminal: undefined,
    dismissedRefusalIds: [],
    criticalScopes: [],
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
        return vi.fn()
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
    root.render(<NotebookMemoryNoticeBridge projectId="project" onContinue={continueExecution} />)
  )
  await act(async () =>
    rejected({
      projectId: 'project',
      sessionId: 'session',
      source: 'agent',
      refusalId: 'r',
      memory: {
        status: 'pressured',
        reason: 'low',
        source: 'linux-procfs',
        executionScope: 'linux:host',
        checkedAt: 1
      }
    })
  )
  await act(async () =>
    changed({
      hasLiveResources: true,
      memory: {
        status: 'healthy',
        reason: 'recovered',
        source: 'linux-procfs',
        executionScope: 'linux:host',
        checkedAt: 2
      }
    })
  )
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

it('warns once for a live macOS critical episode and never describes it as an unstarted request', async () => {
  await act(async () => root.render(<NotebookMemoryNoticeBridge projectId="project" />))
  const critical: NotebookMemoryPolicyChangedEvent = {
    hasLiveResources: true,
    memory: {
      status: 'pressured',
      reason: 'macos-critical',
      source: 'darwin-sysctl-dispatch',
      executionScope: 'darwin:host',
      checkedAt: 1,
      pressureLevel: 'critical'
    }
  }
  await act(async () => changed({ ...critical, hasLiveResources: false }))
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => changed(critical))
  expect(screen.getByRole('dialog', { name: 'System memory is under pressure' })).toBeTruthy()
  expect(
    screen.queryByText(
      'This code did not run. Choose whether to retry or manage Notebook resources.'
    )
  ).toBeNull()
  expect(screen.queryByRole('button', { name: 'Recheck and retry' })).toBeNull()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })))
  await act(async () => changed(critical))
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () =>
    changed({
      ...critical,
      memory: { ...critical.memory, status: 'healthy', pressureLevel: 'normal' }
    })
  )
  await act(async () => changed(critical))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(execute).not.toHaveBeenCalled()
})

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
          reason: 'low',
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
        source: 'linux-procfs',
        executionScope: 'linux:host',
        checkedAt: 2
      })
    )
    expect(
      screen.getByText('Memory has recovered. Execution still requires your choice.')
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
