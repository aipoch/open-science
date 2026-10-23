// @vitest-environment jsdom
import { FileTypeIcon } from '@/pages/workspace/file-type-icon'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import type {
  LiteratureRelatedRecord,
  LiteratureRelatedRequest,
  LiteratureRelatedResult
} from '@aipoch/literature-discovery/contracts'
import { LiteratureRelatedLookup } from './LiteratureRelatedLookup'
import type { LiteratureRendererHost } from '../renderer-host'

const saveCredential = vi.fn()
const loadConnectors = vi.fn().mockResolvedValue(undefined)
const credentialState = {
  encryptionAvailable: true,
  semanticScholar: undefined as { hasApiKey: boolean } | undefined,
  loadConnectors,
  setSemanticScholarCredential: saveCredential
}
const credentialStore = Object.assign(
  (select: (state: typeof credentialState) => unknown) => select(credentialState),
  { getState: () => credentialState }
) as unknown as LiteratureRendererHost['useSettingsStore']

const { render } = createLiteratureTestRenderer({
  FileTypeIcon,
  useSettingsStore: credentialStore,
  get api() {
    return window.api
  }
})
const related = vi.fn<(request: LiteratureRelatedRequest) => Promise<LiteratureRelatedResult>>()
const transact = vi.fn()
const item: LiteratureItemView = {
  id: 'local',
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  attachments: [],
  collectionIds: [],
  projectIds: [],
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Seed' })
}
const record = (letter: string): LiteratureRelatedRecord => ({
  paperId: letter.repeat(40),
  item: literatureItemInputSchema.parse({
    itemType: 'document',
    title: `Paper ${letter}`,
    url: `https://www.semanticscholar.org/paper/${letter.repeat(40)}`
  })
})
const result = (extra: Partial<LiteratureRelatedResult> = {}): LiteratureRelatedResult => ({
  itemId: 'local',
  metadataRevision: 1,
  direction: 'references',
  state: 'ready',
  seed: record('a'),
  records: [record('b'), record('c')],
  resolutionToken: '00000000-0000-4000-8000-000000000000',
  ...extra
})
beforeEach(() => {
  related
    .mockReset()
    .mockImplementation(async (request) => result({ direction: request.direction }))
  transact.mockReset()
  credentialState.encryptionAvailable = true
  credentialState.semanticScholar = undefined
  loadConnectors.mockReset().mockResolvedValue(undefined)
  saveCredential.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { related, transact } }
  })
})
afterEach(cleanup)
it('starts from one paper, switches relationship direction and stages only explicit selections', async () => {
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  expect(transact).not.toHaveBeenCalled()
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cited by' }), { button: 0, ctrlKey: false })
  await waitFor(() =>
    expect(related).toHaveBeenLastCalledWith(
      expect.objectContaining({ itemId: 'local', direction: 'citations', offset: 0 })
    )
  )
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  transact.mockResolvedValue({ kind: 'candidate', id: 'candidate', state: 'pending' })
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await screen.findByText('In Inbox')
  expect(transact).toHaveBeenCalledTimes(1)
  expect(transact).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'stage-candidate',
      candidate: expect.objectContaining({
        source: expect.objectContaining({
          provider: 'semantic-scholar',
          externalId: 'b'.repeat(40)
        }),
        origin: { kind: 'manual-discovery' }
      })
    })
  )
})
it('confirms the matched seed before loading references', async () => {
  related.mockResolvedValueOnce(result({ state: 'match-required', records: [] }))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Is this the same paper?')
  expect(related).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Same paper, show relationships' }))
  await screen.findByText('Paper b')
  expect(related).toHaveBeenLastCalledWith(
    expect.objectContaining({ resolutionToken: result().resolutionToken })
  )
})
it('reports duplicates, dismissed candidates and partial failures without auto-restoring', async () => {
  related.mockResolvedValue(result({ records: [record('b'), record('c'), record('d')] }))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  for (const label of ['b', 'c', 'd'])
    fireEvent.click(screen.getByRole('checkbox', { name: `Select Paper ${label}` }))
  transact
    .mockResolvedValueOnce({ kind: 'item', id: 'saved', state: 'present' })
    .mockResolvedValueOnce({ kind: 'candidate', id: 'dismissed', state: 'dismissed' })
    .mockRejectedValueOnce(new Error('failed'))
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await screen.findByText('Could not add this reference. Try again.')
  expect(screen.getByText('Already in Library')).toBeTruthy()
  expect(screen.getByText('Previously dismissed; review it in Inbox.')).toBeTruthy()
  expect(transact.mock.calls.every(([command]) => command.kind === 'stage-candidate')).toBe(true)
  transact.mockResolvedValueOnce({ kind: 'candidate', id: 'retry', state: 'pending' })
  fireEvent.click(screen.getByRole('button', { name: 'Add selected to Inbox' }))
  await screen.findByText('In Inbox')
  expect(transact).toHaveBeenCalledTimes(4)
})
it('appends unique results while preserving selections and retries failed pages in place', async () => {
  related
    .mockResolvedValueOnce(result({ nextOffset: 20 }))
    .mockResolvedValueOnce(result({ state: 'unavailable', records: [], issue: 'rate-limited' }))
    .mockResolvedValueOnce(result({ records: [record('b'), record('d')] }))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByRole('alert')
  expect(
    (screen.getByRole('checkbox', { name: 'Select Paper b' }) as HTMLInputElement).checked
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Paper d')
  expect(screen.getAllByText('Paper b')).toHaveLength(1)
  expect(screen.getByText('Paper c')).toBeTruthy()
  expect(
    (screen.getByRole('checkbox', { name: 'Select Paper b' }) as HTMLInputElement).checked
  ).toBe(true)
  expect(related).toHaveBeenLastCalledWith(
    expect.objectContaining({ offset: 20, resolutionToken: result().resolutionToken })
  )
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cited by' }), { button: 0, ctrlKey: false })
  await waitFor(() =>
    expect(related).toHaveBeenLastCalledWith(
      expect.objectContaining({ direction: 'citations', offset: 0 })
    )
  )
  expect(screen.queryByText('Paper d')).toBeNull()
})
it('ignores an outstanding load-more request after navigating away', async () => {
  related.mockResolvedValueOnce(result({ nextOffset: 20 }))
  const view = render(
    <LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />
  )
  await screen.findByText('Paper b')
  let resolve!: (value: LiteratureRelatedResult) => void
  related.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  view.unmount()
  resolve(result())
  expect(transact).not.toHaveBeenCalled()
})
it('requires a fresh lookup when an appended page reports an expired seed', async () => {
  related
    .mockResolvedValueOnce(result({ nextOffset: 20 }))
    .mockResolvedValueOnce(result({ state: 'unavailable', records: [], issue: 'expired' }))
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByRole('alert')
  expect(
    (screen.getByRole('button', { name: 'Add selected to Inbox' }) as HTMLButtonElement).disabled
  ).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() =>
    expect(related).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, resolutionToken: undefined })
    )
  )
})

it('saves an inline key and retries a failed appended page without losing selections', async () => {
  related
    .mockResolvedValueOnce(result({ nextOffset: 20 }))
    .mockResolvedValueOnce(result({ state: 'unavailable', records: [], issue: 'rate-limited' }))
    .mockResolvedValueOnce(result({ records: [record('d')] }))
  const close = vi.fn()
  render(
    <LiteratureRelatedLookup
      item={item}
      initialDirection="references"
      onSaved={vi.fn()}
      credentialsOpen
      onCloseCredentials={close}
    />
  )
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByRole('alert')
  fireEvent.paste(screen.getByLabelText('API key'), {
    clipboardData: { getData: () => 'test-key' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
  await screen.findByText('Paper d')
  expect(saveCredential).toHaveBeenCalledWith({ apiKey: 'test-key' })
  expect(close).toHaveBeenCalledOnce()
  expect(related).toHaveBeenLastCalledWith(
    expect.objectContaining({ offset: 20, resolutionToken: result().resolutionToken })
  )
  expect(
    (screen.getByRole('checkbox', { name: 'Select Paper b' }) as HTMLInputElement).checked
  ).toBe(true)
})

it('keeps a failed credential draft for retry and does not retry lookup before saving succeeds', async () => {
  saveCredential.mockRejectedValueOnce(new Error('storage unavailable'))
  const close = vi.fn()
  render(
    <LiteratureRelatedLookup
      item={item}
      initialDirection="references"
      onSaved={vi.fn()}
      credentialsOpen
      onCloseCredentials={close}
    />
  )
  await screen.findByText('Paper b')
  const input = screen.getByLabelText('API key') as HTMLInputElement
  fireEvent.paste(input, { clipboardData: { getData: () => 'test-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
  await screen.findByText('Could not save the Semantic Scholar API key.')
  expect(input.value).toBe('•'.repeat(8))
  expect(close).not.toHaveBeenCalled()
  expect(related).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(input.value).toBe('')
  expect(related).toHaveBeenCalledTimes(1)
})

it('disables credential saving when secure storage is unavailable', async () => {
  credentialState.encryptionAvailable = false
  render(
    <LiteratureRelatedLookup
      item={item}
      initialDirection="references"
      onSaved={vi.fn()}
      credentialsOpen
      onCloseCredentials={vi.fn()}
    />
  )
  await screen.findByText('Paper b')
  fireEvent.paste(screen.getByLabelText('API key'), {
    clipboardData: { getData: () => 'test-key' }
  })
  expect((screen.getByRole('button', { name: 'Save key' }) as HTMLButtonElement).disabled).toBe(
    true
  )
  expect(saveCredential).not.toHaveBeenCalled()
})

it('ignores a pending key save after the inline editor is closed and reopened', async () => {
  let finish!: () => void
  saveCredential.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const close = vi.fn()
  const props = {
    item,
    initialDirection: 'references' as const,
    onSaved: vi.fn(),
    onCloseCredentials: close
  }
  const view = render(<LiteratureRelatedLookup {...props} credentialsOpen />)
  await screen.findByText('Paper b')
  fireEvent.paste(screen.getByLabelText('API key'), { clipboardData: { getData: () => 'old-key' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
  view.rerender(<LiteratureRelatedLookup {...props} credentialsOpen={false} />)
  view.rerender(<LiteratureRelatedLookup {...props} credentialsOpen />)
  fireEvent.paste(screen.getByLabelText('API key'), { clipboardData: { getData: () => 'new-key' } })
  await act(async () => finish())
  await waitFor(() =>
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('•'.repeat(7))
  )
  expect(close).not.toHaveBeenCalled()
  expect(related).toHaveBeenCalledTimes(1)
})

it.each(['rate-limited', 'authentication'] as const)(
  'offers inline key configuration directly in a %s notice',
  async (issue) => {
    related.mockResolvedValue(result({ state: 'unavailable', records: [], issue }))
    const open = vi.fn()
    const props = {
      item,
      initialDirection: 'references' as const,
      onSaved: vi.fn(),
      onOpenCredentials: open,
      onCloseCredentials: vi.fn()
    }
    const view = render(<LiteratureRelatedLookup {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Configure API key' }))
    expect(open).toHaveBeenCalledOnce()
    expect(related).toHaveBeenCalledTimes(1)
    view.rerender(<LiteratureRelatedLookup {...props} credentialsOpen />)
    expect(document.activeElement).toBe(screen.getByLabelText('API key'))
    expect(screen.queryByRole('button', { name: 'Configure API key' })).toBeNull()
  }
)

it('offers key configuration after a failed append without clearing existing selections', async () => {
  related
    .mockResolvedValueOnce(result({ nextOffset: 20 }))
    .mockResolvedValueOnce(result({ state: 'unavailable', records: [], issue: 'rate-limited' }))
  const open = vi.fn()
  render(
    <LiteratureRelatedLookup
      item={item}
      initialDirection="references"
      onSaved={vi.fn()}
      onOpenCredentials={open}
    />
  )
  await screen.findByText('Paper b')
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Paper b' }))
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Configure API key' }))
  expect(open).toHaveBeenCalledOnce()
  expect(
    (screen.getByRole('checkbox', { name: 'Select Paper b' }) as HTMLInputElement).checked
  ).toBe(true)
})

it('replaces the accessible loading placeholder when the first lookup finishes', async () => {
  let finish!: (value: LiteratureRelatedResult) => void
  related.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  const status = await screen.findByRole('status')
  expect(status.textContent).toContain('Searching…')
  expect(status.textContent).toContain('Papers referenced by this paper.')
  expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByRole('checkbox')).toBeNull()
  await act(async () => finish(result()))
  await screen.findByText('Paper b')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false')
})

it('does not flash a skeleton for a response within the loading delay', async () => {
  vi.useFakeTimers()
  try {
    let finish!: (value: LiteratureRelatedResult) => void
    related.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
    await act(async () => {})
    expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('true')
    await act(async () => vi.advanceTimersByTime(199))
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => finish(result()))
    await act(async () => vi.advanceTimersByTime(200))
    expect(screen.getByText('Paper b')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('keeps the same notice mounted while switching tabs and retrying a limited request', async () => {
  related.mockResolvedValueOnce(
    result({ state: 'unavailable', records: [], issue: 'rate-limited' })
  )
  render(<LiteratureRelatedLookup item={item} initialDirection="references" onSaved={vi.fn()} />)
  const notice = await screen.findByRole('alert')
  for (const action of ['switch', 'retry']) {
    let finish!: (value: LiteratureRelatedResult) => void
    related.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    vi.useFakeTimers()
    try {
      if (action === 'switch')
        fireEvent.mouseDown(screen.getByRole('tab', { name: 'Cited by' }), {
          button: 0,
          ctrlKey: false
        })
      else fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await act(async () => vi.advanceTimersByTime(250))
      expect(screen.getByRole('alert')).toBe(notice)
      expect(screen.queryByText('Searching…')).toBeNull()
      expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(
        true
      )
      await act(async () =>
        finish(
          result({
            direction: 'citations',
            state: 'unavailable',
            records: [],
            issue: 'rate-limited'
          })
        )
      )
      expect(screen.getByRole('alert')).toBe(notice)
    } finally {
      vi.useRealTimers()
    }
  }
})

it.each([false, true, undefined])(
  'only suggests an optional key when its absence is known (%s)',
  async (hasApiKey) => {
    credentialState.semanticScholar = hasApiKey === undefined ? undefined : { hasApiKey }
    let finish!: (value: LiteratureRelatedResult) => void
    related.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const open = vi.fn()
    const props = {
      item,
      initialDirection: 'references' as const,
      onSaved: vi.fn(),
      onOpenCredentials: open,
      onCloseCredentials: vi.fn()
    }
    const view = render(<LiteratureRelatedLookup {...props} />)
    await waitFor(() => expect(related).toHaveBeenCalledOnce())
    expect(loadConnectors).toHaveBeenCalledOnce()
    const hint = screen.queryByText('An API key is optional but recommended.')
    expect(Boolean(hint)).toBe(hasApiKey === false)
    expect(screen.queryByRole('alert')).toBeNull()
    if (hasApiKey === false) {
      fireEvent.click(screen.getByRole('button', { name: 'Configure API key' }))
      expect(open).toHaveBeenCalledOnce()
      view.rerender(<LiteratureRelatedLookup {...props} credentialsOpen />)
      const input = screen.getByLabelText('API key') as HTMLInputElement
      expect(input.disabled).toBe(false)
      expect(document.activeElement).toBe(input)
      fireEvent.paste(input, { clipboardData: { getData: () => 'draft-key' } })
      expect((screen.getByRole('button', { name: 'Save key' }) as HTMLButtonElement).disabled).toBe(
        true
      )
      expect(screen.queryByText('An API key is optional but recommended.')).toBeNull()
      view.rerender(<LiteratureRelatedLookup {...props} />)
      expect(screen.getByText('An API key is optional but recommended.')).toBeTruthy()
      credentialState.semanticScholar = { hasApiKey: true }
      view.rerender(<LiteratureRelatedLookup {...props} />)
      expect(screen.queryByText('An API key is optional but recommended.')).toBeNull()
    }
    await act(async () => finish(result()))
  }
)
