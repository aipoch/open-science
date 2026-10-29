// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { EnvStatusBanner } from '@/pages/workspace/EnvStatusBanner'
import { useUpdateStore } from '@/stores/update-store'
import type { UpdateStatus } from '../../../shared/update'
import { UpdateDialog } from './UpdateDialog'

const originalStore = useUpdateStore.getState()
const originalApi = window.api
let container: HTMLDivElement
let root: Root
let retryEnvironment: ReturnType<typeof vi.fn>
let openRuntimes: ReturnType<typeof vi.fn>

const ready: UpdateStatus = {
  state: 'ready',
  current: '1.0.0',
  latest: '1.0.1',
  applyKind: 'restart',
  recovery: {
    phase: 'preparing',
    runtime: 'running',
    installation: 'unchanged',
    canCancel: true,
    canRecover: false,
    canRetryInstall: false
  }
}
const unknownOccupancy: UpdateStatus = {
  ...ready,
  reason: 'installation-busy',
  error: 'Installation occupancy could not be verified.',
  recovery: { ...ready.recovery!, detail: 'occupancy-unknown' }
}

const updateButton = (label: string): HTMLButtonElement => {
  const dialog = document.querySelector('[data-testid="runtime-update-dialog"]')
  const button = [...(dialog?.querySelectorAll('button') ?? [])].find(
    (candidate) => candidate.textContent === label
  )
  expect(button, `update dialog button: ${label}`).toBeDefined()
  return button!
}

const expectEnvironmentError = (): void => {
  expect(container.querySelector('[data-testid="env-status-banner"]')?.textContent).toContain(
    'Could not re-check runtimes.'
  )
  expect(retryEnvironment).not.toHaveBeenCalled()
  expect(openRuntimes).not.toHaveBeenCalled()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  retryEnvironment = vi.fn()
  openRuntimes = vi.fn()
  useUpdateStore.setState({ ...originalStore, status: ready, isDialogOpen: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useUpdateStore.setState(originalStore)
  window.api = originalApi
})

const render = async (): Promise<void> => {
  await act(async () =>
    root.render(
      <>
        <EnvStatusBanner
          ui={{ kind: 'error', message: 'Notebook runtime status unavailable' }}
          statusError="Notebook runtime status unavailable"
          onRetry={retryEnvironment}
          onOpenRuntimes={openRuntimes}
        />
        <UpdateDialog />
      </>
    )
  )
}

it('applies and retries an occupancy failure while the Notebook error notice stays open', async () => {
  const apply = vi
    .fn()
    .mockResolvedValueOnce(unknownOccupancy)
    .mockResolvedValueOnce({ ...ready, state: 'applying' })
  const recheck = vi.fn(async () => ready)
  window.api = { update: { apply, recheck } } as unknown as typeof window.api
  await render()

  expectEnvironmentError()
  await act(async () => updateButton('Update').click())
  expect(apply).toHaveBeenCalledExactlyOnceWith({ force: true })
  expect(useUpdateStore.getState().status.recovery?.detail).toBe('occupancy-unknown')
  expectEnvironmentError()

  await act(async () => updateButton('Retry').click())
  expect(recheck).toHaveBeenCalledOnce()
  expect(useUpdateStore.getState().status.reason).toBeUndefined()
  expectEnvironmentError()

  await act(async () => updateButton('Update').click())
  expect(apply).toHaveBeenCalledTimes(2)
  expect(useUpdateStore.getState().status.state).toBe('applying')
  expectEnvironmentError()
})

it('cancels a pending update without dismissing the Notebook error notice', async () => {
  let finishApply!: (status: UpdateStatus) => void
  const apply = vi.fn(
    () =>
      new Promise<UpdateStatus>((resolve) => {
        finishApply = resolve
      })
  )
  const cancel = vi.fn(async (): Promise<UpdateStatus> => ({ ...ready, outcome: 'cancelled' }))
  window.api = { update: { apply, cancel } } as unknown as typeof window.api
  await render()

  act(() => updateButton('Update').click())
  expect(apply).toHaveBeenCalledExactlyOnceWith({ force: true })
  expect(updateButton('Cancel').disabled).toBe(false)
  expectEnvironmentError()

  await act(async () => updateButton('Cancel').click())
  expect(cancel).toHaveBeenCalledOnce()
  expect(document.querySelector('[data-testid="runtime-update-dialog"]')).toBeNull()
  expectEnvironmentError()

  // A late preflight failure cannot undo a newer cancellation or require dismissing the notice.
  await act(async () => finishApply(unknownOccupancy))
  expect(useUpdateStore.getState().status.outcome).toBe('cancelled')
  expect(useUpdateStore.getState().isDialogOpen).toBe(false)
  expectEnvironmentError()
})
