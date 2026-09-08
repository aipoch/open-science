// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { literatureItemInputSchema, type LiteratureItemView } from '../../../../shared/literature'
import type { LiteratureJob, LiteratureJobRequest } from '../../../../shared/literature-jobs'
import { LiteratureBatchLookupDialog } from './LiteratureBatchLookupDialog'

const item: LiteratureItemView = {
  id: 'first',
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  attachments: [],
  projectIds: [],
  collectionIds: [],
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'First paper' })
}
const id = '9323d39a-2ae2-49c8-8826-a589c78f1f5d'
let job: LiteratureJob
const jobs = vi.fn<(request: LiteratureJobRequest) => Promise<{ jobs: LiteratureJob[] }>>(
  async () => ({ jobs: [structuredClone(job)] })
)
const onClose = vi.fn()
const onChanged = vi.fn()
const flush = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1001)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  jobs.mockImplementation(async (request) => {
    if (request.action === 'review') {
      for (const selection of request.selections)
        Object.assign(
          job.rows.find(({ id }) => id === selection.itemId)!,
          selection
        )
      job.updatedAt += 1
    }
    return { jobs: [structuredClone(job)] }
  })
  job = {
    id,
    mode: 'metadata',
    phase: 'search',
    state: 'running',
    createdAt: 1,
    updatedAt: 1,
    rows: [{ id: item.id, item, checked: true, status: 'searching' }]
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { literature: { jobs } } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
const open = (jobId?: string, mode: 'metadata' | 'full-text' = 'metadata'): void => {
  render(
    <StrictMode>
      <LiteratureBatchLookupDialog
        itemIds={[item.id]}
        initialItems={[item]}
        mode={mode}
        jobId={jobId}
        fieldLabel={(field) => field}
        onClose={onClose}
        onChanged={onChanged}
      />
    </StrictMode>
  )
}
it('creates only one background task in Strict Mode and allows closing while it runs', async () => {
  open()
  await flush()
  expect(jobs.mock.calls.filter(([request]) => request.action === 'create')).toHaveLength(1)
  expect(
    screen.getByText('You can close this window. Tasks continue in the background.')
  ).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(jobs.mock.calls.some(([request]) => request.action === 'pause')).toBe(false)
})
it.each(
  (['metadata', 'full-text'] as const).flatMap((mode) =>
    (['search', 'apply'] as const).flatMap((phase) =>
      (['Close', 'Escape'] as const).map((dismiss) => ({
        mode,
        phase,
        dismiss
      }))
    )
  )
)(
  'keeps $mode $phase running after $dismiss and reopens the same task',
  async ({ mode, phase, dismiss }) => {
    job.mode = mode
    job.phase = phase
    job.rows[0]!.status = phase === 'search' ? 'searching' : 'saving'
    function Host(): React.JSX.Element {
      const [visible, setVisible] = useState(true)
      return visible ? (
        <LiteratureBatchLookupDialog
          itemIds={[item.id]}
          initialItems={[item]}
          mode={mode}
          jobId={id}
          fieldLabel={(field) => field}
          onClose={() => setVisible(false)}
          onChanged={onChanged}
        />
      ) : (
        <button onClick={() => setVisible(true)}>Reopen task</button>
      )
    }
    render(<Host />)
    await flush()
    if (dismiss === 'Escape') fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    else fireEvent.click(screen.getByRole('button', { name: dismiss }))
    expect(screen.queryByRole('dialog')).toBeNull()
    const callsAfterClose = jobs.mock.calls.length
    await flush()
    expect(jobs).toHaveBeenCalledTimes(callsAfterClose)
    // The main process can finish the task while its renderer dialog is unmounted.
    job.state = 'completed'
    job.rows[0]!.status = phase === 'search' ? 'skipped' : 'done'
    fireEvent.click(screen.getByRole('button', { name: 'Reopen task' }))
    await flush()
    expect(
      screen.getAllByText(phase === 'search' ? 'Skipped' : 'Completed').length
    ).toBeGreaterThan(0)
    expect(
      jobs.mock.calls.every(([request]) => request.action === 'get' && request.jobId === id)
    ).toBe(true)
  }
)
it.each([
  ['metadata', 'search', 'Continue search'],
  ['full-text', 'search', 'Continue search'],
  ['metadata', 'apply', 'Continue applying'],
  ['full-text', 'apply', 'Continue download']
] as const)(
  'resumes a persisted %s %s task without creating a new one',
  async (mode, phase, label) => {
    job.mode = mode
    job.phase = phase
    job.state = 'paused'
    job.rows[0]!.status = 'pending'
    open(id, mode)
    await flush()
    expect(jobs.mock.calls.every(([request]) => request.action === 'get')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: label }))
    await act(async () => {})
    expect(jobs).toHaveBeenLastCalledWith({ action: 'resume', jobId: id })
  }
)
it('applies only reviewed selections and preserves deselection across polling', async () => {
  job.state = 'review'
  job.rows[0]!.status = 'ready'
  open(id)
  await flush()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select reference: First paper' }))
  await flush()
  expect(jobs).toHaveBeenCalledWith({
    action: 'review',
    jobId: id,
    selections: [{ itemId: item.id, checked: false, candidateId: undefined }]
  })
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  expect(
    (screen.getByRole('button', { name: 'Apply selected (0)' }) as HTMLButtonElement).disabled
  ).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Apply selected (1)' }))
  await act(async () => {})
  expect(jobs).toHaveBeenLastCalledWith({
    action: 'apply',
    jobId: id,
    selections: [{ itemId: item.id, candidateId: undefined }]
  })
})

it('does not continuously poll a completed task', async () => {
  job.state = 'completed'
  job.rows[0]!.status = 'done'
  open(id)
  await flush()
  const calls = jobs.mock.calls.length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000)
  })
  expect(jobs).toHaveBeenCalledTimes(calls)
})

it('labels the resumable action as Pause and sends a pause command', async () => {
  open(id)
  await flush()
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
  await act(async () => {
    await Promise.resolve()
  })
  expect(jobs.mock.calls.some(([request]) => request.action === 'pause')).toBe(true)
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
})

it('offers an immediate retry when the initial task request fails', async () => {
  jobs.mockRejectedValueOnce(new Error('offline'))
  open(id)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1)
  })
  expect(screen.getByRole('alert').textContent).toContain('Background task could not be updated')
  expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Run in background' })).toBeNull()
  const before = jobs.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await act(async () => {
    await Promise.resolve()
  })
  expect(jobs.mock.calls.length).toBe(before + 1)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('retries failed review saves without losing the selected source or applying an unsaved draft', async () => {
  job.mode = 'full-text'
  job.state = 'review'
  job.rows[0] = {
    ...job.rows[0]!,
    status: 'ready',
    checked: false,
    candidateId: 'chosen-source',
    candidates: [
      {
        id: 'chosen-source',
        provider: 'pmc',
        source: 'PMC',
        url: 'https://pmc.ncbi.nlm.nih.gov/paper.pdf'
      }
    ]
  }
  let saveAvailable = false
  jobs.mockImplementation(async (request) => {
    if (request.action === 'review') {
      if (!saveAvailable) throw new Error('temporarily unavailable')
      Object.assign(job.rows[0]!, request.selections[0])
      job.updatedAt += 1
    }
    return { jobs: [structuredClone(job)] }
  })
  open(id, 'full-text')
  await flush()
  fireEvent.click(screen.getByRole('checkbox'))
  await act(async () => {})
  expect(screen.getByRole('alert')).toBeTruthy()

  // A successful read must not conceal the failed write or overwrite the local choice.
  fireEvent(window, new Event('literature-job-refresh'))
  await act(async () => {})
  expect(screen.getByRole('alert')).toBeTruthy()
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Add selected (1)' }))
  await act(async () => {})
  expect(jobs.mock.calls.some(([request]) => request.action === 'apply')).toBe(false)

  saveAvailable = true
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  expect(job.rows[0]).toMatchObject({ checked: true, candidateId: 'chosen-source' })
  expect(jobs.mock.calls.filter(([request]) => request.action === 'apply')).toEqual([
    [
      {
        action: 'apply',
        jobId: id,
        selections: [{ itemId: item.id, candidateId: 'chosen-source' }]
      }
    ]
  ])
})

it('retries the failed apply command instead of only refreshing the task', async () => {
  job.state = 'review'
  job.rows[0]!.status = 'ready'
  let writable = false
  jobs.mockImplementation(async (request) => {
    if (request.action === 'apply' && !writable) throw new Error('checkpoint unavailable')
    return { jobs: [structuredClone(job)] }
  })
  open(id)
  await flush()
  fireEvent.click(screen.getByRole('button', { name: 'Apply selected (1)' }))
  await act(async () => {})
  const first = jobs.mock.calls.find(([request]) => request.action === 'apply')![0]
  expect(screen.getByRole('alert')).toBeTruthy()
  writable = true
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await act(async () => {})
  expect(jobs.mock.calls.filter(([request]) => request.action === 'apply')).toEqual([
    [first],
    [first]
  ])
  expect(screen.queryByRole('alert')).toBeNull()
})

it('retires a failed apply request when the user changes the selection', async () => {
  job.state = 'review'
  job.rows[0]!.status = 'ready'
  jobs.mockImplementation(async (request) => {
    if (request.action === 'apply') throw new Error('checkpoint unavailable')
    if (request.action === 'review') {
      Object.assign(job.rows[0]!, request.selections[0])
      job.updatedAt += 1
    }
    return { jobs: [structuredClone(job)] }
  })
  open(id)
  await flush()
  fireEvent.click(screen.getByRole('button', { name: 'Apply selected (1)' }))
  await act(async () => {})
  fireEvent.click(screen.getByRole('checkbox'))
  await act(async () => {})
  jobs.mockRejectedValueOnce(new Error('read unavailable'))
  fireEvent(window, new Event('literature-job-refresh'))
  await act(async () => {})
  expect(screen.getByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await act(async () => {})
  expect(jobs.mock.calls.filter(([request]) => request.action === 'apply')).toHaveLength(1)
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
})

it('shows only the resumable action in a paused task without candidates', async () => {
  job.state = 'paused'
  job.rows[0]!.status = 'pending'
  open(id, 'full-text')
  await flush()
  expect(screen.getByText('Paused')).toBeTruthy()
  expect(
    screen.queryByText('You can close this window. Tasks continue in the background.')
  ).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: /Add selected/ })).toBeNull()
  const resume = screen.getByRole('button', { name: 'Continue search' })
  expect(resume.closest('footer')?.querySelectorAll('button')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Search again' }).closest('footer')).toBeNull()
})

it('gives continuation priority over applying partial results in a paused task', async () => {
  job.state = 'paused'
  job.rows[0]!.status = 'ready'
  open(id)
  await flush()
  const resume = screen.getByRole('button', { name: 'Continue search' })
  const apply = screen.getByRole('button', { name: 'Apply selected (1)' })
  expect(resume.getAttribute('data-variant')).toBe('default')
  expect(apply.getAttribute('data-variant')).toBe('outline')
  expect(resume.closest('footer')?.querySelectorAll('button')).toHaveLength(2)
})

it('explains an empty selection while retaining the review submission action', async () => {
  job.state = 'review'
  job.rows[0]!.status = 'ready'
  job.rows[0]!.checked = false
  open(id, 'full-text')
  await flush()
  expect(
    (screen.getByRole('button', { name: 'Add selected (0)' }) as HTMLButtonElement).disabled
  ).toBe(true)
  expect(screen.getByText('Select at least one result.')).toBeTruthy()
})

it('removes irrelevant footer actions after all task results have been applied', async () => {
  job.state = 'completed'
  job.rows[0]!.status = 'done'
  open(id)
  await flush()
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  expect(
    screen.queryByText('You can close this window. Tasks continue in the background.')
  ).toBeNull()
})

it('keeps the paused actions stable and prevents duplicate requests while resuming', async () => {
  job.state = 'paused'
  job.rows[0]!.status = 'pending'
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  jobs.mockImplementation(async (request) => {
    if (request.action === 'resume') await waiting
    return { jobs: [structuredClone(job)] }
  })
  open(id)
  await flush()
  const resume = screen.getByRole('button', { name: 'Continue search' }) as HTMLButtonElement
  fireEvent.click(resume)
  await act(async () => {})
  expect(resume.disabled).toBe(true)
  expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
  fireEvent.click(resume)
  expect(jobs.mock.calls.filter(([request]) => request.action === 'resume')).toHaveLength(1)
  await act(async () => {
    release()
  })
  expect(resume.disabled).toBe(false)
})

it('adopts another window saved deselection when this window has no pending draft', async () => {
  job.state = 'review'
  job.rows[0]!.status = 'ready'
  job.rows.push({
    id: 'second',
    item: { ...item, id: 'second', item: { ...item.item, title: 'Second paper' } },
    checked: true,
    status: 'ready'
  })
  open(id)
  await flush()
  expect(
    (screen.getByRole('checkbox', { name: 'Select reference: First paper' }) as HTMLInputElement)
      .checked
  ).toBe(true)
  job.rows[0]!.checked = false
  job.updatedAt += 1
  fireEvent(window, new Event('literature-job-refresh'))
  await act(async () => {})
  expect
    .soft(
      (screen.getByRole('checkbox', { name: 'Select reference: First paper' }) as HTMLInputElement)
        .checked
    )
    .toBe(false)
  fireEvent.click(screen.getByRole('button', { name: /Apply selected/ }))
  await act(async () => {})
  expect(jobs).toHaveBeenLastCalledWith({
    action: 'apply',
    jobId: id,
    selections: [{ itemId: 'second', candidateId: undefined }]
  })
})

it('adopts another window saved candidate when there is no local draft', async () => {
  job.state = 'review'
  job.mode = 'full-text'
  job.rows[0] = {
    ...job.rows[0]!,
    status: 'ready',
    candidateId: 'first-source',
    candidates: [
      {
        id: 'first-source',
        provider: 'pmc',
        source: 'PMC',
        url: 'https://first.example/paper.pdf'
      },
      {
        id: 'second-source',
        provider: 'pmc',
        source: 'PMC',
        url: 'https://second.example/paper.pdf'
      }
    ]
  }
  open(id, 'full-text')
  await flush()
  job.updatedAt += 1
  job.rows[0].candidateId = 'second-source'
  fireEvent(window, new Event('literature-job-refresh'))
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Add selected (1)' }))
  await act(async () => {})
  expect(jobs).toHaveBeenLastCalledWith({
    action: 'apply',
    jobId: id,
    selections: [{ itemId: item.id, candidateId: 'second-source' }]
  })
})

it('retires failed apply selections when another window saves a different review', async () => {
  job.state = 'review'
  job.rows[0]!.status = 'ready'
  jobs.mockImplementation(async (request) => {
    if (request.action === 'apply') throw new Error('checkpoint unavailable')
    return { jobs: [structuredClone(job)] }
  })
  open(id)
  await flush()
  fireEvent.click(screen.getByRole('button', { name: 'Apply selected (1)' }))
  await act(async () => {})
  expect(screen.getByRole('alert')).toBeTruthy()
  job.rows[0]!.checked = false
  job.updatedAt += 1
  fireEvent(window, new Event('literature-job-refresh'))
  await act(async () => {})
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  const retry = screen.queryByRole('button', { name: 'Retry' })
  if (retry) fireEvent.click(retry)
  await act(async () => {})
  expect(jobs.mock.calls.filter(([request]) => request.action === 'apply')).toHaveLength(1)
})

it('reports failed searches instead of completion when no candidates are ready', async () => {
  job.state = 'review'
  job.rows[0]!.status = 'error'
  open(id, 'full-text')
  await flush()
  const status = screen.getByRole('status')
  expect(within(status).getByText('Failed')).toBeTruthy()
  expect(within(status).queryByText('Completed')).toBeNull()
  expect(status.textContent).toContain(
    'Some references failed. Search again to retry unfinished references.'
  )
  expect(screen.getByRole('button', { name: 'Search again' })).toBeTruthy()
})
