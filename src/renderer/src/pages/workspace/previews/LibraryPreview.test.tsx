// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  literatureItemInputSchema,
  type LiteratureItemView,
  type LiteratureCatalogSearchPage
} from '../../../../../shared/literature'
import LibraryPreview from './LibraryPreview'

const navigation = vi.hoisted(() => ({
  openProjectLiterature: vi.fn(),
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
  it('distinguishes loading, empty project, empty library and empty search with useful actions', async () => {
    render(<LibraryPreview projectId="project-a" isActive />)
    expect(screen.getByText('Loading references…')).toBeTruthy()
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
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ab' } })
    expect(search).toHaveBeenCalledTimes(1)
    search.mockResolvedValueOnce({ entries: [reference('new', 'New result')] })
    await settle()
    expect(search).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'ab' }))
    await act(async () => old.resolve({ entries: [reference('old', 'Old result')] }))
    expect(screen.getByText('New result')).toBeTruthy()
    expect(screen.queryByText('Old result')).toBeNull()
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
    expect(screen.queryByText('Abstract')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /A reference/ }))
    expect(screen.getByText('No PDF attached.')).toBeTruthy()
    expect(screen.queryByText(/end of abstract/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByText(/end of abstract/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Second reference/ }))
    expect(screen.getAllByText('Abstract')).toHaveLength(1)
    expect(screen.getByText('No abstract available.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View in Literature' }))
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

  it('opens the selected PDF version in the workbench, including single-page PDFs', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /A reference/ }))
    fireEvent.click(screen.getByRole('button', { name: 'paper.pdf' }))
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
