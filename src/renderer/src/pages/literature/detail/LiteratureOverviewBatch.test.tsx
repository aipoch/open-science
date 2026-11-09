// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import { LiteratureOverviewBatch } from './LiteratureOverviewBatch'
import type { OverviewBatch } from '../../../../../shared/literature-overview-batch'
const { render } = createLiteratureTestRenderer({
  get api() {
    return window.api
  }
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
it('notifies each saved reference while its sibling runs and deduplicates repeated polls', async () => {
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: false,
    rows: ['a', 'b'].map((itemId) => ({
      request: { itemId, expectedSourceKey: `source-${itemId}`, language: 'en' },
      status: 'running'
    }))
  }
  const onOverviewSaved = vi.fn()
  const onActiveRequestsChange = vi.fn()
  const overviewBatch = vi.fn(async () => structuredClone(job))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { overviewBatch, get: vi.fn(async (id) => ({ item: { title: id } })) } }
  })
  vi.useFakeTimers()
  const view = render(
    <LiteratureOverviewBatch
      hasSelection={false}
      resolveSelection={async () => []}
      onOverviewSaved={onOverviewSaved}
      onActiveRequestsChange={onActiveRequestsChange}
    />
  )
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Batch overviews' }))
  expect(screen.getAllByText('Generating overview…')).toHaveLength(2)
  expect(onActiveRequestsChange).toHaveBeenLastCalledWith(job.rows.map((row) => row.request))
  job.rows[0].status = 'succeeded'

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })

  expect(onOverviewSaved.mock.calls).toEqual([[job.rows[0].request]])
  expect(screen.getAllByText('Generating overview…')).toHaveLength(1)
  expect(onActiveRequestsChange).toHaveBeenLastCalledWith([job.rows[1].request])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000)
  })
  expect(onOverviewSaved).toHaveBeenCalledTimes(1)
  job.rows[1].status = 'succeeded'
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(onOverviewSaved.mock.calls).toEqual([[job.rows[0].request], [job.rows[1].request]])
  expect(onActiveRequestsChange).toHaveBeenLastCalledWith([])
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0])
  await act(async () => {})
  expect(screen.queryByRole('button', { name: 'Batch overviews' })).toBeNull()
  view.unmount()
  expect(onActiveRequestsChange).toHaveBeenLastCalledWith([])
  render(<LiteratureOverviewBatch hasSelection={false} resolveSelection={async () => []} />)
  await act(async () => {})
  expect(screen.queryByRole('button', { name: 'Batch overviews' })).toBeNull()
})

it('starts selected references with their own current source identities', async () => {
  const items = [
    { id: 'a', metadataRevision: 11, attachments: [], item: { title: 'Study A' } },
    { id: 'b', metadataRevision: 22, attachments: [], item: { title: 'Study B' } }
  ]
  const overviewBatch = vi.fn().mockResolvedValue(null)
  const get = vi.fn(async (id) => items.find((item) => item.id === id))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { overviewBatch, get } }
  })
  render(<LiteratureOverviewBatch hasSelection resolveSelection={async () => ['b', 'a']} />)
  await waitFor(() => expect(overviewBatch).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Generate overviews' }))
  await waitFor(() =>
    expect(overviewBatch).toHaveBeenCalledWith({
      action: 'start',
      entries: [
        { itemId: 'b', expectedSourceKey: '["b",22,true,null]', language: 'en' },
        { itemId: 'a', expectedSourceKey: '["a",11,true,null]', language: 'en' }
      ]
    })
  )
})
it('offers retry with pending references without rerunning saved references', async () => {
  const titles: Record<string, string> = {
    saved: 'Saved study',
    failed: 'Failed study',
    pending: 'Pending study'
  }
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: true,
    rows: ['saved', 'failed', 'pending'].map((itemId) => ({
      request: { itemId, expectedSourceKey: itemId, language: 'en' },
      status: itemId === 'saved' ? 'succeeded' : itemId === 'failed' ? 'failed' : 'pending'
    }))
  }
  const advanced: string[] = []
  const overviewBatch = vi.fn(async (request) => {
    if (request.action === 'resume' || request.action === 'retry') job.paused = false
    if (request.action === 'retry') {
      for (const row of job.rows) if (row.status === 'failed') row.status = 'pending'
    }
    if (request.action === 'advance') {
      const row = job.rows.find((entry) => entry.status === 'pending')!
      advanced.push(row.request.itemId)
      row.status = 'succeeded'
    }
    return structuredClone(job)
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        overviewBatch,
        get: vi.fn(async (id) => ({ item: { title: titles[id] } })),
        studySnapshot: vi.fn().mockResolvedValue({ issue: 'source-unavailable' })
      }
    }
  })
  render(<LiteratureOverviewBatch hasSelection={false} resolveSelection={async () => []} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Batch overviews' }))

  await screen.findByRole('button', { name: 'Continue remaining' })
  await screen.findByText('Pending study')
  for (const title of Object.values(titles)) expect(screen.getByText(title)).toBeTruthy()
  const retry = screen.getByRole('button', { name: 'Retry failed overviews' })
  expect(screen.getByText('1 failed overview')).toBeTruthy()
  const originalSaved = screen.getByRole('button', { name: 'Saved study' })
  fireEvent.click(originalSaved)
  await screen.findByText('Could not load the overview. Try again.')
  const originalSavedRow = originalSaved.closest('li')!
  vi.spyOn(originalSavedRow, 'getBoundingClientRect').mockReturnValue({
    ...originalSavedRow.getBoundingClientRect(),
    height: 377
  })
  const failedRow = screen.getByText('Failed study').closest('li')!
  vi.spyOn(failedRow, 'getBoundingClientRect').mockReturnValue({
    ...failedRow.getBoundingClientRect(),
    height: 120
  })
  fireEvent.click(retry)
  await waitFor(() =>
    expect(within(screen.getByRole('list')).getAllByText('Overview saved')).toHaveLength(3)
  )
  expect(advanced).toEqual(['failed', 'pending'])
  expect(overviewBatch.mock.calls.map(([request]) => request.action)).toEqual([
    'read',
    'retry',
    'advance',
    'advance'
  ])
  expect(screen.queryByRole('button', { name: 'Retry failed overviews' })).toBeNull()
  expect(originalSaved.getAttribute('aria-expanded')).toBe('true')
  expect(originalSavedRow.style.minHeight).toBe('377px')
  fireEvent.click(originalSaved)
  expect(originalSaved.getAttribute('aria-expanded')).toBe('false')
  expect(originalSavedRow.style.minHeight).toBe('')
  expect(originalSaved.style.minHeight).toBe('')
  expect(failedRow.style.minHeight).toBe('120px')
  const savedRow = screen.getByRole('button', { name: 'Failed study' })
  // The entire reserved row height must remain clickable after retry succeeds.
  expect(savedRow.style.minHeight).toBe('120px')
  fireEvent.click(savedRow)
  await screen.findByText('Could not load the overview. Try again.')
  expect(savedRow.style.minHeight).toBe('')
  fireEvent.click(savedRow)
  expect(savedRow.style.minHeight).toBe('')
  expect(failedRow.style.minHeight).toBe('')
})
it('rejects oversized selections before fetching references or generating', async () => {
  const overviewBatch = vi.fn().mockResolvedValue(null)
  const get = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { overviewBatch, get } }
  })
  render(
    <LiteratureOverviewBatch
      hasSelection
      resolveSelection={async () => ['a', 'b', 'c', 'd', 'e', 'f']}
    />
  )
  await waitFor(() => expect(overviewBatch).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Generate overviews' }))
  await screen.findByText('Select up to 5 references.')
  expect(get).not.toHaveBeenCalled()
  expect(overviewBatch).toHaveBeenCalledTimes(1)
})
it('does not start a task after selection preparation outlives its view', async () => {
  let resolve!: (ids: string[]) => void
  const selection = new Promise<string[]>((done) => {
    resolve = done
  })
  const overviewBatch = vi.fn().mockResolvedValue(null)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        overviewBatch,
        get: vi.fn().mockResolvedValue({
          id: 'a',
          metadataRevision: 1,
          attachments: [],
          item: { title: 'A' }
        })
      }
    }
  })
  const view = render(<LiteratureOverviewBatch hasSelection resolveSelection={() => selection} />)
  await waitFor(() => expect(overviewBatch).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Generate overviews' }))
  view.unmount()
  await act(async () => {
    resolve(['a'])
    await selection
  })
  expect(overviewBatch.mock.calls.map(([request]) => request.action)).toEqual(['read'])
})
it('retries observation after a busy owner without starting inference', async () => {
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: false,
    rows: [{ request: { itemId: 'a', language: 'en', expectedSourceKey: 'a' }, status: 'pending' }]
  }
  const overviewBatch = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(job)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: { overviewBatch, get: vi.fn().mockResolvedValue({ item: { title: 'A' } }) }
    }
  })
  render(<LiteratureOverviewBatch hasSelection={false} resolveSelection={async () => []} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Batch overviews' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  await screen.findByRole('button', { name: 'Continue remaining' })
  expect(overviewBatch.mock.calls.map(([request]) => request.action)).toEqual(['read', 'read'])
})
it('honors pause requested while preparing selection before any inference', async () => {
  let resolve!: (ids: string[]) => void
  const selection = new Promise<string[]>((done) => {
    resolve = done
  })
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: false,
    rows: [{ request: { itemId: 'a', expectedSourceKey: 'a', language: 'en' }, status: 'pending' }]
  }
  const overviewBatch = vi.fn(async (request) => {
    if (request.action === 'read') return null
    if (request.action === 'pause') job.paused = true
    if (request.action === 'advance') job.rows[0].status = 'succeeded'
    return structuredClone(job)
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        overviewBatch,
        get: vi.fn().mockResolvedValue({
          id: 'a',
          metadataRevision: 1,
          attachments: [],
          item: { title: 'A' }
        })
      }
    }
  })
  render(<LiteratureOverviewBatch hasSelection resolveSelection={() => selection} />)
  await waitFor(() => expect(overviewBatch).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Generate overviews' }))
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
  expect(screen.getByRole('button', { name: 'Pausing…' })).toHaveProperty('disabled', true)
  await act(async () => {
    resolve(['a'])
    await selection
  })
  await screen.findByRole('button', { name: 'Continue remaining' })
  expect(overviewBatch.mock.calls.map(([request]) => request.action)).toEqual([
    'read',
    'start',
    'pause'
  ])
})
it('ignores a failed initial observation after a newer task completed', async () => {
  let reject!: (error: Error) => void
  const initial = new Promise<null>((_, fail) => {
    reject = fail
  })
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: false,
    rows: [{ request: { itemId: 'a', expectedSourceKey: 'a', language: 'en' }, status: 'pending' }]
  }
  const overviewBatch = vi.fn(async (request) => {
    if (request.action === 'read') return initial
    if (request.action === 'advance') job.rows[0].status = 'succeeded'
    return structuredClone(job)
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        overviewBatch,
        get: vi.fn().mockResolvedValue({
          id: 'a',
          metadataRevision: 1,
          attachments: [],
          item: { title: 'A' }
        })
      }
    }
  })
  render(<LiteratureOverviewBatch hasSelection resolveSelection={async () => ['a']} />)
  await waitFor(() => expect(overviewBatch).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: 'Generate overviews' }))
  await waitFor(() =>
    expect(within(screen.getByRole('list')).getByText('Overview saved')).toBeTruthy()
  )
  await act(async () => {
    reject(new Error('old request'))
    await initial.catch(() => {})
  })
  expect(
    screen.queryByText('Could not generate batch overviews. Check the selection and try again.')
  ).toBeNull()
})
it('does not leave a phantom running row after advance fails', async () => {
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: true,
    rows: [{ request: { itemId: 'a', expectedSourceKey: 'a', language: 'en' }, status: 'pending' }]
  }
  const overviewBatch = vi.fn(async (request) => {
    if (request.action === 'advance') throw new Error('checkpoint unavailable')
    if (request.action === 'resume') job.paused = false
    return structuredClone(job)
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: { overviewBatch, get: vi.fn().mockResolvedValue({ item: { title: 'A' } }) }
    }
  })
  render(<LiteratureOverviewBatch hasSelection={false} resolveSelection={async () => []} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Batch overviews' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue remaining' }))
  await screen.findByText('Could not generate batch overviews. Check the selection and try again.')
  expect(screen.queryByText('Generating overview…')).toBeNull()
  expect(within(screen.getByRole('list')).getByText('Pending')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Continue remaining' })).toBeTruthy()
})
it('shows both in-flight references and honors pause after they complete', async () => {
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: true,
    rows: ['a', 'b', 'c'].map((itemId) => ({
      request: { itemId, expectedSourceKey: itemId, language: 'en' },
      status: 'pending'
    }))
  }
  let finish!: (job: OverviewBatch) => void
  const inFlight = new Promise<OverviewBatch>((resolve) => {
    finish = resolve
  })
  const overviewBatch = vi.fn(async (request) => {
    if (request.action === 'resume') job.paused = false
    if (request.action === 'advance') return inFlight
    if (request.action === 'pause') job.paused = true
    return structuredClone(job)
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { overviewBatch, get: vi.fn(async (id) => ({ item: { title: id } })) } }
  })
  render(<LiteratureOverviewBatch hasSelection={false} resolveSelection={async () => []} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Batch overviews' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Continue remaining' }))
  await waitFor(() => expect(screen.getAllByText('Generating overview…')).toHaveLength(2))
  expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(3)
  expect(screen.getByText('0 of 3 finished')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0])
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(overviewBatch.mock.calls.filter(([request]) => request.action === 'pause')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Batch overviews' }))
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
  expect(screen.getByRole('button', { name: 'Pausing…' })).toHaveProperty('disabled', true)
  await act(async () => {
    job.rows[0].status = 'succeeded'
    job.rows[1].status = 'succeeded'
    finish(structuredClone(job))
    await inFlight
  })
  await screen.findByRole('button', { name: 'Continue remaining' })
  expect(screen.queryByText('Generating overview…')).toBeNull()
  expect(screen.getByText('2 of 3 finished')).toBeTruthy()
  expect(overviewBatch.mock.calls.map(([request]) => request.action)).toEqual([
    'read',
    'resume',
    'advance',
    'pause'
  ])
})

it('shows five independent results with controlled per-reference failure reasons', async () => {
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: true,
    rows: ['source-changed', 'source-unavailable', 'input-too-large', 'busy', undefined].map(
      (issue, index) => ({
        request: { itemId: `study-${index}`, expectedSourceKey: `key-${index}`, language: 'en' },
        status: issue ? 'failed' : 'succeeded',
        issue
      })
    )
  }
  const overviewBatch = vi.fn().mockResolvedValue(job)
  const studySnapshot = vi
    .fn()
    .mockRejectedValueOnce(new Error('Read failed'))
    .mockResolvedValue({
      sourceKey: 'key-4',
      coverage: 'abstract',
      model: 'test-model',
      sections: {
        question: 'Does it work?',
        population: null,
        methods: null,
        results: 'Saved findings',
        limitations: null
      }
    })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        overviewBatch,
        studySnapshot,
        get: vi.fn(async (id) => ({ item: { title: id } }))
      }
    }
  })
  const onOpenOverview = vi.fn()
  render(
    <LiteratureOverviewBatch
      hasSelection={false}
      resolveSelection={async () => []}
      onOpenOverview={onOpenOverview}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Batch overviews' }))
  const rows = await screen.findAllByRole('listitem')
  expect(rows).toHaveLength(5)
  expect(screen.getByText('4 failed overviews')).toBeTruthy()

  const reasons = [
    'Source changed',
    'Add an abstract or readable full-text PDF to generate an overview.',
    'The available source exceeds the overview input limit.',
    'Too many overviews are being generated. Try again shortly.'
  ]
  reasons.forEach((reason, index) => {
    expect(within(rows[index]).getByText(`study-${index}`)).toBeTruthy()
    expect(within(rows[index]).getByText('Overview failed')).toBeTruthy()
    expect(within(rows[index]).getByText(reason)).toBeTruthy()
  })
  expect(screen.queryByRole('button', { name: 'View details' })).toBeNull()
  for (const row of rows.slice(0, 4)) expect(within(row).queryByRole('button')).toBeNull()
  expect(screen.getByRole('button', { name: 'Retry failed overviews' })).toBeTruthy()
  const expand = within(rows[4]).getByRole('button', { name: 'study-4' })
  const statusIcon = rows[4].querySelector('svg.lucide-check')!
  expect(statusIcon).toBeTruthy()
  expect(statusIcon.closest('button')).toBe(expand)
  fireEvent.click(statusIcon)
  await screen.findByText('Could not load the overview. Try again.')
  expect(expand.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(within(rows[4]).getByRole('button', { name: 'Retry' }))
  const findings = await screen.findByText('Saved findings')
  fireEvent.click(findings)
  expect(expand.getAttribute('aria-expanded')).toBe('true')
  expect(studySnapshot.mock.calls).toEqual([
    [{ ...job.rows[4].request, mode: 'read' }],
    [{ ...job.rows[4].request, mode: 'read' }]
  ])
  fireEvent.click(expand)
  expect(screen.queryByText('Saved findings')).toBeNull()
  expect(screen.queryByRole('button', { name: 'View details' })).toBeNull()
  fireEvent.click(expand)
  await screen.findByText('Saved findings')
  const details = within(rows[4]).getByRole('button', { name: 'View details' })
  expect(details.closest('button')).toBe(details)
  expect(expand.contains(details)).toBe(false)
  fireEvent.click(details)
  await waitFor(() =>
    expect(onOpenOverview).toHaveBeenCalledWith(
      { item: { title: 'study-4' } },
      screen.getByRole('button', { name: 'Batch overviews' })
    )
  )
  expect(onOpenOverview).toHaveBeenCalledTimes(1)
  expect(studySnapshot.mock.calls).toEqual([
    [{ ...job.rows[4].request, mode: 'read' }],
    [{ ...job.rows[4].request, mode: 'read' }],
    [{ ...job.rows[4].request, mode: 'read' }]
  ])
  expect(overviewBatch.mock.calls).toEqual([[{ action: 'read' }]])
  expect(screen.queryByRole('dialog')).toBeNull()
})
it.each(['generation-failed', 'private backend exception', undefined])(
  'uses a safe translated fallback for issue %s',
  async (issue) => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        literature: {
          overviewBatch: vi.fn().mockResolvedValue({
            id: '00000000-0000-4000-8000-000000000000',
            paused: true,
            rows: [
              {
                request: { itemId: 'a', expectedSourceKey: 'a', language: 'en' },
                status: 'failed',
                issue
              }
            ]
          }),
          get: vi.fn().mockResolvedValue({ item: { title: 'Study A' } })
        }
      }
    })
    render(<LiteratureOverviewBatch hasSelection={false} resolveSelection={async () => []} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Batch overviews' }))
    await screen.findByText('Could not generate the overview. Please try again.')
    if (issue) expect(screen.queryByText(issue)).toBeNull()
  }
)

it('observes individual completions during a wave and ignores a late progress response', async () => {
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: true,
    rows: ['a', 'b', 'c'].map((itemId) => ({
      request: { itemId, expectedSourceKey: itemId, language: 'en' },
      status: 'pending'
    }))
  }
  let finish!: (value: OverviewBatch) => void
  const wave = new Promise<OverviewBatch>((resolve) => {
    finish = resolve
  })
  let finishRead!: (value: OverviewBatch) => void
  const lateRead = new Promise<OverviewBatch>((resolve) => {
    finishRead = resolve
  })
  let reads = 0
  const overviewBatch = vi.fn(async (request) => {
    if (request.action === 'read' && ++reads === 3) return lateRead
    if (request.action === 'resume') job.paused = false
    if (request.action === 'advance') {
      job.rows[0].status = 'running'
      job.rows[1].status = 'running'
      return wave
    }
    return structuredClone(job)
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { overviewBatch, get: vi.fn(async (id) => ({ item: { title: id } })) } }
  })
  const view = render(
    <LiteratureOverviewBatch hasSelection={false} resolveSelection={async () => []} />
  )
  if (!screen.queryByRole('dialog'))
    fireEvent.click(await screen.findByRole('button', { name: 'Batch overviews' }))
  const resume = await screen.findByRole('button', { name: 'Continue remaining' })
  vi.useFakeTimers()
  await act(async () => {
    fireEvent.click(resume)
  })
  job.rows[0].status = 'succeeded'
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  const summary = within(screen.getByRole('status'))
  expect(summary.getByText('1 of 3 finished')).toBeTruthy()
  expect(
    screen.getByRole('progressbar', { name: 'Batch overviews' }).getAttribute('aria-valuenow')
  ).toBe('33')
  expect(screen.getAllByText('Generating overview…')).toHaveLength(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  const stale = structuredClone(job)
  job.rows[1].status = 'failed'
  job.paused = true
  await act(async () => {
    finish(structuredClone(job))
    await wave
  })
  expect(screen.getByRole('button', { name: 'Retry failed overviews' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Continue remaining' })).toBeTruthy()
  await act(async () => {
    finishRead(stale)
    await lateRead
  })
  expect(summary.getByText('1 failed overview')).toBeTruthy()
  expect(
    screen.getByRole('progressbar', { name: 'Batch overviews' }).getAttribute('aria-valuenow')
  ).toBe('67')
  expect(screen.queryByText('Generating overview…')).toBeNull()
  expect(overviewBatch.mock.calls.filter(([request]) => request.action === 'advance')).toHaveLength(
    1
  )
  view.unmount()
  await vi.advanceTimersByTimeAsync(5000)
  expect(reads).toBe(3)
})

it('stops showing a running observation when the advance request fails', async () => {
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: true,
    rows: [{ request: { itemId: 'a', expectedSourceKey: 'a', language: 'en' }, status: 'pending' }]
  }
  let fail!: (reason: Error) => void
  const wave = new Promise<OverviewBatch>((_, reject) => {
    fail = reject
  })
  const overviewBatch = vi.fn(async (request) => {
    if (request.action === 'resume') job.paused = false
    if (request.action === 'advance') {
      job.rows[0].status = 'running'
      return wave
    }
    return structuredClone(job)
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { overviewBatch, get: vi.fn(async () => ({ item: { title: 'A' } })) } }
  })
  render(<LiteratureOverviewBatch hasSelection={false} resolveSelection={async () => []} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Batch overviews' }))
  if (!screen.queryByRole('dialog'))
    fireEvent.click(await screen.findByRole('button', { name: 'Batch overviews' }))
  const resume = await screen.findByRole('button', { name: 'Continue remaining' })
  vi.useFakeTimers()
  await act(async () => {
    fireEvent.click(resume)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(screen.getByText('Generating overview…')).toBeTruthy()
  await act(async () => {
    fail(new Error('checkpoint unavailable'))
    await wave.catch(() => {})
  })
  expect(
    screen.getByText('Could not generate batch overviews. Check the selection and try again.')
  ).toBeTruthy()
  expect(screen.queryByText('Generating overview…')).toBeNull()
  expect(screen.getByRole('button', { name: 'Continue remaining' })).toBeTruthy()
})

it('observes a still-running wave after leaving and returning without advancing the queue', async () => {
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: true,
    rows: ['a', 'b', 'c'].map((itemId) => ({
      request: { itemId, expectedSourceKey: itemId, language: 'en' },
      status: 'pending'
    }))
  }
  let finish!: (value: OverviewBatch) => void
  const wave = new Promise<OverviewBatch>((resolve) => {
    finish = resolve
  })
  const overviewBatch = vi.fn(async (request) => {
    if (request.action === 'resume') job.paused = false
    if (request.action === 'advance') {
      job.rows[0].status = 'running'
      job.rows[1].status = 'running'
      return wave
    }
    return structuredClone(job)
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { overviewBatch, get: vi.fn(async (id) => ({ item: { title: id } })) } }
  })
  const view = render(
    <LiteratureOverviewBatch hasSelection={false} resolveSelection={async () => []} />
  )
  if (!screen.queryByRole('dialog'))
    fireEvent.click(await screen.findByRole('button', { name: 'Batch overviews' }))
  const resume = await screen.findByRole('button', { name: 'Continue remaining' })
  vi.useFakeTimers()
  await act(async () => {
    fireEvent.click(resume)
  })
  view.unmount()
  await act(async () => {
    render(<LiteratureOverviewBatch hasSelection={false} resolveSelection={async () => []} />)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Batch overviews' }))
  expect(screen.getAllByText('Generating overview…')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Continue remaining' })).toHaveProperty(
    'disabled',
    true
  )
  job.rows[0].status = 'succeeded'
  job.rows[1].status = 'succeeded'
  await act(async () => {
    finish(structuredClone(job))
    await wave
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(screen.getByText('2 of 3 finished')).toBeTruthy()
  expect(screen.queryByText('Generating overview…')).toBeNull()
  expect(screen.getByRole('button', { name: 'Continue remaining' })).toHaveProperty(
    'disabled',
    false
  )
  expect(overviewBatch.mock.calls.filter(([request]) => request.action === 'advance')).toHaveLength(
    1
  )
})

it('reports restored running references even while paused and releases them on unmount', async () => {
  const job: OverviewBatch = {
    id: '00000000-0000-4000-8000-000000000000',
    paused: true,
    rows: (['running', 'pending', 'failed', 'succeeded'] as const).map((status) => ({
      request: { itemId: status, expectedSourceKey: status, language: 'en' },
      status
    }))
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        overviewBatch: vi.fn(async () => structuredClone(job)),
        get: vi.fn(async (id) => ({ item: { title: id } }))
      }
    }
  })
  const onActiveRequestsChange = vi.fn()
  const view = render(
    <LiteratureOverviewBatch
      hasSelection={false}
      resolveSelection={async () => []}
      onActiveRequestsChange={onActiveRequestsChange}
    />
  )
  await waitFor(() =>
    expect(onActiveRequestsChange).toHaveBeenLastCalledWith([job.rows[0].request])
  )
  view.unmount()
  expect(onActiveRequestsChange).toHaveBeenLastCalledWith([])
})
