// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { LiteratureJobSummary } from '../../../../shared/literature-jobs'
import { LiteratureBackgroundTasks } from './LiteratureBackgroundTasks'

afterEach(cleanup)
it('refreshes the library when a background job completes after its dialog closes', async () => {
  vi.useFakeTimers()
  const onChanged = vi.fn()
  const request = vi.fn(async () => ({ jobs: [], summaries: [job] }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { jobs: request } }
  })
  await act(async () => {
    render(<LiteratureBackgroundTasks onOpen={vi.fn()} onChanged={onChanged} />)
  })
  request.mockResolvedValue({
    jobs: [],
    summaries: [
      { ...job, state: 'completed', done: 3, ready: 0, completedItemIds: ['a', 'b', 'c'] }
    ]
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(onChanged).toHaveBeenCalledTimes(1)
  expect(onChanged).toHaveBeenCalledWith(['a', 'b', 'c'])
  expect(screen.queryByRole('button')).toBeNull()
  cleanup()
  vi.useRealTimers()
})
const job: LiteratureJobSummary = {
  id: 'job',
  mode: 'metadata',
  phase: 'search',
  state: 'running',
  total: 3,
  checked: 1,
  ready: 1,
  done: 0,
  failed: 0,
  createdAt: 1,
  updatedAt: 1
}
async function show(jobs: LiteratureJobSummary[]): Promise<void> {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { jobs: vi.fn(async () => ({ jobs: [], summaries: jobs })) } }
  })
  await act(async () => {
    render(<LiteratureBackgroundTasks onOpen={vi.fn()} />)
  })
}
it('hides the entry without actionable jobs', async () => {
  await show([{ ...job, state: 'completed', checked: 3, ready: 0, done: 3 }])
  expect(screen.queryByRole('button')).toBeNull()
})
it('shows compact progress and a reduced-motion-aware running icon', async () => {
  await show([job])
  const button = screen.getByRole('button', { name: 'Background tasks' })
  expect(button.textContent).toContain('Searching…1/3')
  expect(button.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
  expect(button.querySelector('svg')?.classList.contains('motion-reduce:animate-none')).toBe(true)
})
it('keeps resumed and unreviewed work discoverable with a static icon', async () => {
  await show([{ ...job, state: 'paused' }])
  const button = screen.getByRole('button', { name: 'Background tasks' })
  expect(button.textContent).toContain('Paused')
  expect(button.querySelector('svg')?.classList.contains('animate-spin')).toBe(false)
})

it('polls idle jobs less often and keeps observing while selection hides the indicator', async () => {
  vi.useFakeTimers()
  const onChanged = vi.fn()
  const request = vi.fn(async () => ({
    jobs: [],
    summaries: [{ ...job, state: 'review' as const }]
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { jobs: request } }
  })
  const { rerender } = render(
    <LiteratureBackgroundTasks onOpen={vi.fn()} onChanged={onChanged} hidden />
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(request).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button')).toBeNull()
  await act(async () => {
    window.dispatchEvent(new Event('literature-jobs-changed'))
  })
  expect(request).toHaveBeenCalledTimes(2)
  rerender(<LiteratureBackgroundTasks onOpen={vi.fn()} onChanged={onChanged} />)
  expect(screen.getByRole('button', { name: 'Background tasks' })).toBeTruthy()
  cleanup()
  vi.useRealTimers()
})

it('distinguishes checked references from successfully updated metadata', async () => {
  await show([{ ...job, checked: 3, ready: 3, state: 'review' }])
  fireEvent.click(screen.getByRole('button', { name: 'Background tasks' }))
  expect(screen.getByText('Awaiting review · Checked 3 of 3')).toBeTruthy()
  expect(screen.queryByText(/Completed 3/)).toBeNull()
})

it('keeps an error entry discoverable when the first task list request fails and allows retry', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ jobs: [], summaries: [] })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { jobs: request } }
  })
  await act(async () => {
    render(<LiteratureBackgroundTasks onOpen={vi.fn()} />)
  })
  expect(screen.getByRole('button', { name: 'Background tasks' }).textContent).toContain(
    'Task list unavailable'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Background tasks' }))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  })
  expect(request).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('button', { name: 'Background tasks' })).toBeNull()
})

it.each([
  { state: 'pausing' as const, failed: 0, ready: 1, label: 'Pausing…' },
  { state: 'completed' as const, failed: 1, ready: 0, label: 'Failed' }
])(
  'shows $label instead of a misleading activity or review label',
  async ({ state, failed, ready, label }) => {
    await show([{ ...job, state, failed, ready }])
    const button = screen.getByRole('button', { name: 'Background tasks' })
    expect(button.textContent).toContain(label)
    expect(button.textContent).not.toContain('Awaiting review')
    expect(button.textContent).not.toContain('Searching…')
  }
)
