// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NotebookRunObservationActions } from './NotebookRunObservationActions'
import type { RunObservationRecordingStatus } from '../../../../../shared/run-observation-recording-status'

const actions = vi.hoisted(() => ({
  showRunObservation: vi.fn(),
  showRecordedObservation: vi.fn()
}))
vi.mock('./open-run-observation', () => actions)
const target = { projectId: 'p', sessionId: 's', runId: 'run' }
const archive = { projectId: 'p', sessionId: 's', artifactId: 'archive', versionId: 'archive-v1' }
const read = vi.fn<() => Promise<RunObservationRecordingStatus>>()
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { observations: { recordingStatus: read } }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('opens the exact Run and only exposes an archive action after Main returns its published Version', async () => {
  vi.useFakeTimers()
  read
    .mockResolvedValueOnce({ target, state: 'recording' })
    .mockResolvedValueOnce({ target, state: 'saving' })
    .mockResolvedValue({ target, state: 'saved', archive, capacityLimit: 'snapshots' })
  render(<NotebookRunObservationActions target={target} runStatus="running" />)
  await act(async () => {})
  expect(screen.getByText('Recording observations')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'View archived replay' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Observe run' }))
  expect(actions.showRunObservation).toHaveBeenCalledWith(target, 'Run observation · run')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(screen.getByText('Saving observation archive…')).toBeTruthy()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  fireEvent.click(screen.getByRole('button', { name: 'View archived replay' }))
  expect(actions.showRecordedObservation).toHaveBeenCalledWith(archive, 'Archived observation')
  expect(
    screen.getByText(
      'Recording stopped at the observation count limit. Earlier records are preserved; later activity was not recorded.'
    )
  ).toBeTruthy()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000)
  })
  expect(read).toHaveBeenCalledTimes(3)
})

it('does not invent an archive for an unrecorded completed Run or poll it forever', async () => {
  vi.useFakeTimers()
  read.mockResolvedValue({ target, state: 'not-recorded' })
  render(<NotebookRunObservationActions target={target} runStatus="completed" />)
  await act(async () => {})
  expect(screen.getByText('This Run has no saved observation recording.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'View run record' }))
  expect(actions.showRunObservation).toHaveBeenCalledWith(target, 'Run observation · run')
  expect(screen.queryByRole('button', { name: 'View archived replay' })).toBeNull()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000)
  })
  expect(read).toHaveBeenCalledOnce()
})

it('rejects an archive returned for another Session before exposing its button', async () => {
  read.mockResolvedValue({ target, state: 'saved', archive: { ...archive, sessionId: 'other' } })
  render(<NotebookRunObservationActions target={target} runStatus="completed" />)
  await act(async () => {})
  expect(screen.getByText('Recording status is unavailable.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'View archived replay' })).toBeNull()
})

it('polls only while the Run row is visible', async () => {
  vi.useFakeTimers()
  let visibility!: IntersectionObserverCallback
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        visibility = callback
      }
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  read.mockResolvedValue({ target, state: 'recording' })
  render(<NotebookRunObservationActions target={target} runStatus="running" />)
  await act(async () => {})
  expect(read).not.toHaveBeenCalled()
  await act(async () => {
    visibility([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
  })
  expect(read).toHaveBeenCalledOnce()
  await act(async () => {
    visibility([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000)
  })
  expect(read).toHaveBeenCalledOnce()
})
