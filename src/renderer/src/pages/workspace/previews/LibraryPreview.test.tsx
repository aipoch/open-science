// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  literatureItemInputSchema,
  type LiteratureItemView,
  type LiteratureCatalogSearchPage
} from '../../../../../shared/literature'
import LibraryPreview from './LibraryPreview'
import { PdfAnnotationsProvider } from '../pdf-annotations/PdfAnnotationsProvider'
import { LibraryReferenceActionsContext } from './library-reference-actions'

const navigation = vi.hoisted(() => ({
  openProjectLiterature: vi.fn(),
  openCollectionLiterature: vi.fn(),
  openLibrary: vi.fn(),
  openLiteratureItem: vi.fn()
}))
const openPreview = vi.hoisted(() => vi.fn())
vi.mock('@/stores/navigation-store', () => ({ useNavigationStore: { getState: () => navigation } }))
vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: { getState: () => ({ upsertAndActivateItem: openPreview }) }
}))
const search = vi.fn<() => Promise<LiteratureCatalogSearchPage>>()
const unsubscribe = vi.fn()
let changed: () => void
const onChanged = vi.fn((listener: () => void) => {
  changed = listener
  return unsubscribe
})
const reference = (id = 'paper', title = 'A reference'): LiteratureItemView => ({
  id,
  item: literatureItemInputSchema.parse({ itemType: 'journalArticle', title }),
  attachments: [],
  collectionIds: [],
  projectIds: ['project-a'],
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1
})
const settle = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
}
const deferred = (): {
  promise: Promise<LiteratureCatalogSearchPage>
  resolve: (page: LiteratureCatalogSearchPage) => void
} => {
  let resolve!: (page: LiteratureCatalogSearchPage) => void
  const promise = new Promise<LiteratureCatalogSearchPage>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  search.mockReset().mockResolvedValue({ entries: [], totalCount: 0 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { literature: { search, onChanged } }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('LibraryPreview', () => {
  it('preserves the loaded Library when a new conversation acquires a session', async () => {
    search.mockResolvedValue({ entries: [reference()], totalCount: 1 })
    const view = (sessionId?: string): React.JSX.Element => (
      <PdfAnnotationsProvider
        projectId={sessionId ? 'project-a' : undefined}
        sessionId={sessionId}
        loadAnnotations={false}
      >
        <LibraryPreview projectId="project-a" isActive />
      </PdfAnnotationsProvider>
    )
    const { rerender } = render(view())
    await settle()
    const rowTitle = screen.getByText('A reference')
    const searchbox = screen.getByRole('searchbox')
    expect(search).toHaveBeenCalledTimes(1)

    rerender(view('new-session'))
    expect(screen.queryByRole('status', { name: 'Loading references…' })).toBeNull()
    expect(screen.getByText('A reference')).toBe(rowTitle)
    expect(screen.getByRole('searchbox')).toBe(searchbox)
    await settle()
    expect(search).toHaveBeenCalledTimes(1)

    rerender(view('another-session'))
    await settle()
    expect(screen.getByText('A reference')).toBe(rowTitle)
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('distinguishes loading, empty project, empty library and empty search with useful actions', async () => {
    render(<LibraryPreview projectId="project-a" isActive />)
    expect(screen.getByRole('status', { name: 'Loading references…' })).toBeTruthy()
    expect(screen.getByText('Recently added')).toBeTruthy()
    expect(screen.queryByText('No references in this project')).toBeNull()
    await settle()
    expect(screen.getByText('No references in this project')).toBeTruthy()
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 'project-a', limit: 20, lifecycle: 'active' })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Browse all references' }))
    await settle()
    expect(screen.getByText('Your library is empty')).toBeTruthy()
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: undefined }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Open in Literature' })[1])
    expect(navigation.openLibrary).toHaveBeenCalledWith('user')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
    await settle()
    expect(screen.getByText('No matching references')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await settle()
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('Your library is empty')).toBeTruthy()
  })

  it('never reads or subscribes while hidden, releases reads on hide, and revalidates on return', async () => {
    const old = deferred()
    const { rerender } = render(<LibraryPreview projectId="project-a" isActive={false} />)
    await settle()
    expect(search).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    search.mockReturnValueOnce(old.promise)
    rerender(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    expect(search).toHaveBeenCalledTimes(1)
    rerender(<LibraryPreview projectId="project-a" isActive={false} />)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await act(async () => old.resolve({ entries: [reference('stale', 'Old result')] }))
    await act(async () => {
      changed()
      window.dispatchEvent(new Event('focus'))
    })
    await settle()
    expect(search).toHaveBeenCalledTimes(1)
    rerender(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    expect(search).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Old result')).toBeNull()
  })

  it('debounces queries and rejects an earlier response after a newer search', async () => {
    const old = deferred()
    search.mockReturnValueOnce(old.promise)
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'a' } })
    await act(async () => vi.advanceTimersByTimeAsync(120))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ab' } })
    expect(search).toHaveBeenCalledTimes(1)
    search.mockResolvedValueOnce({ entries: [reference('new', 'New result')] })
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(search).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(80))
    expect(search).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'ab' }))
    await act(async () => old.resolve({ entries: [reference('old', 'Old result')] }))
    expect(screen.getByText('New result')).toBeTruthy()
    expect(screen.queryByText('Old result')).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(search).toHaveBeenCalledTimes(3)
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: undefined }))
  })

  it('waits until after search debounce before showing a skeleton for a slow query', async () => {
    search.mockResolvedValueOnce({ entries: [reference('seed', 'Previous result')] })
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    const pending = deferred()
    search.mockReturnValueOnce(pending.promise)

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'slow' } })
    await act(async () => vi.advanceTimersByTimeAsync(199))
    expect(search).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status', { name: 'Loading references…' })).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(search).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(159))
    expect(screen.queryByRole('status', { name: 'Loading references…' })).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(screen.getByRole('status', { name: 'Loading references…' })).toBeTruthy()
    await act(async () => pending.resolve({ entries: [reference('done', 'Slow result')] }))
    expect(screen.getByText('Slow result')).toBeTruthy()
  })

  it('shows a retryable failure rather than an empty library', async () => {
    search.mockRejectedValueOnce(new Error('Read failed'))
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    expect(screen.getByText('Could not load references.')).toBeTruthy()
    expect(screen.queryByText('No references in this project')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(screen.getByText('No references in this project')).toBeTruthy()
  })

  it('clears a scope failure after returning to a successful reload', async () => {
    search
      .mockRejectedValueOnce(new Error('Read failed'))
      .mockResolvedValueOnce({ entries: [reference('all', 'All reference')] })
      .mockResolvedValueOnce({ entries: [reference('project', 'Project reference')] })
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    expect(screen.getByText('Could not load references.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await settle()
    expect(screen.getByText('All reference')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    await settle()
    expect(screen.getByText('Project reference')).toBeTruthy()
    expect(screen.queryByText('Could not load references.')).toBeNull()
  })

  it('offers full Literature recovery for a record beyond the display budget', async () => {
    search.mockRejectedValueOnce(new Error('Literature reference exceeds the display budget: huge'))
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    expect(
      screen.getByText(
        'This reference is too large for Preview. Open Literature to access the complete record.'
      )
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Open in Literature' })[1])
    expect(navigation.openProjectLiterature).toHaveBeenCalledWith('project-a', 'user')
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('revalidates once for a burst of change events and rejects the replaced read', async () => {
    const old = deferred()
    search.mockReturnValueOnce(old.promise)
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    await act(async () => {
      changed()
      changed()
    })
    await settle()
    expect(search).toHaveBeenCalledTimes(2)
    await act(async () => old.resolve({ entries: [reference()] }))
    expect(screen.queryByText('A reference')).toBeNull()
    expect(screen.getByText('No references in this project')).toBeTruthy()
  })

  it('renders one bounded page and expands only one reference without fetching PDF bytes', async () => {
    const first = reference()
    first.item.abstract = 'x'.repeat(601) + 'end of abstract'
    search.mockResolvedValueOnce({
      entries: [
        first,
        reference('two', 'Second reference'),
        ...Array.from({ length: 18 }, (_, i) => reference(`other-${i}`, `Other ${i}`))
      ],
      nextOffset: 20
    })
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    expect(screen.queryByRole('heading', { name: 'Abstract' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /A reference/ }))
    expect(screen.getAllByText('No PDF attached.')).toHaveLength(20)
    expect(screen.queryByText(/end of abstract/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByText(/end of abstract/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Second reference/ }))
    expect(screen.getAllByRole('heading', { name: 'Abstract' })).toHaveLength(1)
    expect(screen.getByText('No abstract available.')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'View in Literature' })[1])
    expect(navigation.openLiteratureItem).toHaveBeenCalledWith('two', 'user')
    expect(search).toHaveBeenCalledTimes(1)
    expect(openPreview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await settle()
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20, limit: 20 }))
    expect(screen.queryByText('A reference')).toBeNull()
    expect(screen.getByText('No references on this page')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'First page' }))
    await settle()
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }))
  })

  it('starts a reused reference abstract collapsed in a different scope', async () => {
    const entry = reference('shared', 'Shared reference')
    entry.item.abstract = 'x'.repeat(601) + 'end of abstract'
    search.mockResolvedValueOnce({ entries: [entry] }).mockResolvedValueOnce({ entries: [entry] })
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: /Shared reference/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByText(/end of abstract/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /Shared reference/ }))
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy()
    expect(screen.queryByText(/end of abstract/)).toBeNull()
  })

  it('opens a collapsed reference PDF directly without expanding or fetching extra data', async () => {
    const entry = reference()
    entry.attachments = [
      {
        id: 'attachment',
        kind: 'fullText',
        title: '',
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
        versions: [
          {
            id: 'v2',
            versionNumber: 2,
            filename: 'paper.pdf',
            contentType: 'application/pdf',
            sizeBytes: 10,
            checksum: 'a'.repeat(64),
            createdAt: 1,
            pageCount: 1
          }
        ]
      }
    ]
    search.mockResolvedValueOnce({ entries: [entry] })
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'paper.pdf' }))
    expect(screen.queryByRole('heading', { name: 'Abstract' })).toBeNull()
    expect(openPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'literature',
        format: 'pdf',
        managedFileId: 'attachment',
        selectedVersionId: 'v2',
        versionNumber: 2
      })
    )
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('keeps the current empty-state action mounted during focus revalidation', async () => {
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    const button = screen.getByRole('button', { name: 'Browse all references' })
    const pending = deferred()
    search.mockReturnValueOnce(pending.promise)
    await act(async () => window.dispatchEvent(new Event('focus')))
    await settle()
    expect(screen.getByRole('button', { name: 'Browse all references' })).toBe(button)
    fireEvent.click(button)
    await settle()
    await act(async () => pending.resolve({ entries: [reference()] }))
    expect(screen.getByText('Your library is empty')).toBeTruthy()
  })

  it('preserves the project scope for the full Literature action', async () => {
    render(<LibraryPreview projectId="project-a" isActive />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in Literature' }))
    expect(navigation.openProjectLiterature).toHaveBeenCalledWith('project-a', 'user')
  })

  it('shows all authors in one clipped line, then date, journal and type', async () => {
    const first = reference('one', 'A reference with a long title')
    first.item.creators = [
      { nameMode: 'person', givenName: 'Taina', familyName: 'Labeau', creatorType: 'author' },
      { nameMode: 'person', givenName: 'Jean-Samuel', familyName: 'Loger', creatorType: 'author' }
    ]
    first.item.issuedYear = 2025
    first.item.containerTitle = 'Scientific reports'
    search.mockResolvedValueOnce({ entries: [first], totalCount: 1 })
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()

    const authors = screen.getByText('Taina Labeau; Jean-Samuel Loger')
    expect(authors.className).toContain('truncate')
    expect(screen.getByText('2025 · Scientific reports · Journal article')).toBeTruthy()
    expect(screen.getByText('1 reference')).toBeTruthy()
  })

  it('shows safe record links together only when expanded', async () => {
    const linked = reference('linked', 'Linked reference')
    linked.item.abstract = 'A'.repeat(301)
    linked.item.url = 'https://example.org/paper'
    linked.item.identifiers = [
      { scheme: 'doi', value: '10.1200/GO-26-00172', isPrimary: true },
      { scheme: 'pmid', value: '42566739', isPrimary: false },
      { scheme: 'issn', value: '2687-8941', isPrimary: false }
    ]
    const unsafe = reference('unsafe', 'Unsafe URL')
    unsafe.item.url = 'javascript:alert(1)'
    const duplicate = reference('duplicate', 'Duplicate DOI URL')
    duplicate.item.url = 'https://doi.org/10.1200/GO-26-00172'
    duplicate.item.identifiers = [{ scheme: 'doi', value: '10.1200/GO-26-00172', isPrimary: true }]
    search.mockResolvedValueOnce({ entries: [linked, unsafe, duplicate] })
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()
    expect(screen.queryByRole('link')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Linked reference/ }))
    expect(
      screen.getByRole('link', { name: 'URL: https://example.org/paper' }).getAttribute('href')
    ).toBe('https://example.org/paper')
    expect(screen.getByRole('link', { name: 'DOI: 10.1200/GO-26-00172' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'PMID: 42566739' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /ISSN/ })).toBeNull()
    expect(
      screen
        .getByRole('button', { name: 'Show more' })
        .compareDocumentPosition(screen.getByRole('link', { name: 'DOI: 10.1200/GO-26-00172' })) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      screen
        .getByRole('link', { name: 'DOI: 10.1200/GO-26-00172' })
        .compareDocumentPosition(screen.getAllByRole('button', { name: 'View in Literature' })[0]) &
        Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Unsafe URL/ }))
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Duplicate DOI URL/ }))
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })

  it('avoids a skeleton flash on fast scope changes and shows matched skeletons for slow reads', async () => {
    search.mockResolvedValueOnce({ entries: [reference('project', 'Project reference')] })
    search.mockResolvedValueOnce({ entries: [reference('all', 'All reference')] })
    const pending = deferred()
    search.mockReturnValueOnce(pending.promise)
    render(<LibraryPreview projectId="project-a" isActive />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    expect(screen.getByText('Project reference').closest('[inert]')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading references…' })).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByText('All reference')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading references…' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    expect(screen.getByText('All reference').closest('[inert]')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading references…' })).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(170))
    expect(screen.getByRole('status', { name: 'Loading references…' })).toBeTruthy()
    expect(screen.getByText('Recently added')).toBeTruthy()
    expect(screen.queryByText('All reference')).toBeNull()
    await act(async () => pending.resolve({ entries: [reference('project-2', 'Updated project')] }))
    expect(screen.getByText('Updated project')).toBeTruthy()
  })

  it('opens and searches a Collection scope in the same preview', async () => {
    search.mockResolvedValue({ entries: [reference()] })
    const scopeRequest = { collectionId: 'collection-a', collectionName: 'TP53 evidence' }
    const { rerender } = render(
      <LibraryPreview projectId="project-a" isActive scopeRequest={scopeRequest} />
    )
    await settle()
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ collectionId: 'collection-a', projectId: undefined })
    )
    expect(screen.getByRole('button', { name: 'TP53 evidence' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open in Literature' }))
    expect(navigation.openCollectionLiterature).toHaveBeenCalledWith('collection-a', 'user')

    fireEvent.click(screen.getByRole('button', { name: 'Current project' }))
    await settle()
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ collectionId: undefined, projectId: 'project-a' })
    )
    rerender(<LibraryPreview projectId="project-a" isActive scopeRequest={{}} />)
    expect(screen.queryByRole('button', { name: 'TP53 evidence' })).toBeNull()
  })

  it('does not reuse results when the project owner remounts', async () => {
    const old = deferred()
    search.mockReturnValueOnce(old.promise)
    const { rerender } = render(<LibraryPreview key="a" projectId="project-a" isActive />)
    await settle()
    rerender(<LibraryPreview key="b" projectId="project-b" isActive />)
    await settle()
    await act(async () => old.resolve({ entries: [reference()] }))
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'project-b' }))
    expect(screen.queryByText('A reference')).toBeNull()
  })
})

it('exposes collapsed row actions, copies the full title, and opens live details in place', async () => {
  const entry = reference('paper', 'Complete title to copy')
  search.mockResolvedValue({ entries: [entry] })
  const get = vi
    .fn()
    .mockResolvedValue({ ...entry, item: { ...entry.item, title: 'Latest title' } })
  Object.assign(window.api.literature, { get })
  const copy = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  render(<LibraryPreview projectId="project-a" isActive />)
  await settle()
  expect(screen.getByRole('button', { name: 'View in Literature' })).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy title' })))
  expect(copy).toHaveBeenCalledWith(entry.item.title)
  const details = screen.getByRole('button', { name: 'Reference details' })
  details.focus()
  await act(async () => fireEvent.click(details))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Latest title' })).toBeTruthy()
  expect(navigation.openLiteratureItem).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await settle()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(details)
  expect(
    screen.getByRole('button', { name: /Complete title to copy/ }).getAttribute('aria-expanded')
  ).toBe('false')
})

it('batches the selected visible references and clears selection across searches', async () => {
  const entries = [reference('one', 'First'), reference('two', 'Second')]
  search.mockResolvedValue({ entries })
  const add = vi.fn()
  render(
    <LibraryReferenceActionsContext.Provider
      value={{ projectId: 'project-a', canAddToCurrent: true, add }}
    >
      <LibraryPreview projectId="project-a" isActive />
    </LibraryReferenceActionsContext.Provider>
  )
  await settle()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select First' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select Second' }))
  expect(screen.getByText('Selected: 2')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'Add to chat' })[0])
  expect(add).toHaveBeenCalledWith(
    [
      expect.objectContaining({ type: 'literature', itemId: 'one' }),
      expect.objectContaining({ type: 'literature', itemId: 'two' })
    ],
    null
  )
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'First' } })
  await settle()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
  await settle()
  expect(screen.queryByText('Selected: 2')).toBeNull()
  expect(
    screen.getAllByRole('checkbox').every((checkbox) => !(checkbox as HTMLInputElement).checked)
  ).toBe(true)
})
