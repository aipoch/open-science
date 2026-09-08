// @vitest-environment jsdom
import { setI18nLocale } from '@/i18n'
import { useLocaleStore } from '@/stores/locale-store'
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

// Exercise live app-language changes while Intl retains the host's default locale.
it('updates metadata dates with the interface language on an unchanged host', async () => {
  const timestamp = '2026-09-02T12:00:00.000Z'
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }
  const hostLocale = new Intl.DateTimeFormat().resolvedOptions().locale
  await show([{ ...job, createdAt: Date.parse(timestamp) }])
  fireEvent.click(screen.getByRole('button', { name: 'Background tasks' }))
  try {
    for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'de'] as const) {
      await act(async () => {
        setI18nLocale(locale)
        useLocaleStore.setState({ locale })
      })
      const expected = new Intl.DateTimeFormat(locale, options).format(new Date(timestamp))
      expect(document.body.textContent).toContain(expected)
      expect(new Intl.DateTimeFormat().resolvedOptions().locale).toBe(hostLocale)
      if (locale === 'zh-Hans') {
        expect(expected).not.toBe(
          new Intl.DateTimeFormat('en-US', options).format(new Date(timestamp))
        )
      }
    }
  } finally {
    await act(async () => {
      setI18nLocale('en')
      useLocaleStore.setState({ locale: 'en' })
    })
  }
})

it.each([
  { state: 'running' as const, failed: 0, ready: 1, label: 'Searching' },
  { state: 'paused' as const, failed: 0, ready: 1, label: 'Paused' },
  { state: 'completed' as const, failed: 1, ready: 0, label: 'Failed' }
])(
  'describes the background task state $label while closed',
  async ({ state, failed, ready, label }) => {
    await show([{ ...job, state, failed, ready }])
    const button = screen.getByRole('button', { name: 'Background tasks' })
    expect(button.textContent).toContain(label)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Background tasks', description: new RegExp(label) })
    ).toBe(button)
  }
)

it('describes an unavailable background task list while closed', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { jobs: vi.fn().mockRejectedValue(new Error('offline')) } }
  })
  await act(async () => {
    render(<LiteratureBackgroundTasks onOpen={vi.fn()} />)
  })
  const button = screen.getByRole('button', { name: 'Background tasks' })
  expect(button.textContent).toContain('Task list unavailable')
  expect(
    screen.getByRole('button', { name: 'Background tasks', description: 'Task list unavailable' })
  ).toBe(button)
})

it('keeps progress polls quiet and announces important transitions after the indicator disappears', async () => {
  const request = vi.fn().mockResolvedValue({ jobs: [], summaries: [job] })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { jobs: request } }
  })
  await act(async () => {
    render(<LiteratureBackgroundTasks onOpen={vi.fn()} />)
  })
  const status = document.querySelector<HTMLElement>('[aria-live="polite"]')!
  const mutations: MutationRecord[] = []
  const observer = new MutationObserver((records) => mutations.push(...records))
  observer.observe(status, { childList: true, characterData: true, subtree: true })
  try {
    const refresh = async (summary: LiteratureJobSummary): Promise<void> => {
      request.mockResolvedValue({ jobs: [], summaries: [summary] })
      await act(async () => {
        window.dispatchEvent(new Event('literature-jobs-changed'))
      })
    }
    await refresh({ ...job, checked: 2 })
    expect(
      screen.getByRole('button', { name: 'Background tasks', description: /2\/3/ })
    ).toBeTruthy()
    expect(mutations).toHaveLength(0)
    await refresh({ ...job, state: 'paused' })
    expect(status.textContent).toBe('Paused')
    mutations.length = 0
    await refresh({ ...job, state: 'paused' })
    expect(mutations).toHaveLength(0)
    await refresh({ ...job, state: 'completed', failed: 1, ready: 0 })
    expect(status.textContent).toBe('Failed')
    await refresh({ ...job, state: 'completed', done: 3, checked: 3, failed: 0, ready: 0 })
    expect(screen.queryByRole('button')).toBeNull()
    expect(status.isConnected).toBe(true)
    expect(status.textContent).toBe('Completed')
  } finally {
    observer.disconnect()
  }
})
