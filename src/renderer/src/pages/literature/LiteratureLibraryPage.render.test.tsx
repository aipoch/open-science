// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LITERATURE_IMPORT_IDENTITY_CONFLICT } from '../../../../shared/literature'
import type {
  LiteratureCatalogSearchPage,
  LiteratureCatalogSearchRequest,
  LiteratureInboxCandidateView,
  LiteratureItemInput,
  LiteratureItemView
} from '../../../../shared/literature'
import type { Project } from '../../../../shared/projects'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialTagState, useTagStore } from '@/stores/tag-store'
import { LiteratureLibraryPage } from './LiteratureLibraryPage'

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = (): void => undefined
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = (): boolean => false
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

const { extractLiteraturePdfDraft, completeLiteraturePdfDraft, filePreviewRenderCount } =
  vi.hoisted(() => ({
    extractLiteraturePdfDraft: vi.fn(),
    completeLiteraturePdfDraft: vi.fn(),
    filePreviewRenderCount: { value: 0 }
  }))

vi.mock('./literature-pdf-metadata', () => ({
  extractLiteraturePdfDraft,
  completeLiteraturePdfDraft
}))

vi.mock('../workspace/FilePreviewDialog', () => ({
  FilePreviewDialog: ({
    item,
    allowReadingContext,
    onReadWithAgent,
    onClose
  }: {
    item?: PreviewFileItem
    allowReadingContext?: boolean
    onReadWithAgent?: (item: PreviewFileItem) => void
    onClose: () => void
  }) => {
    filePreviewRenderCount.value += 1
    return item ? (
      <div
        data-testid="literature-pdf-preview"
        data-allow-reading-context={String(allowReadingContext)}
      >
        {`${item.title} · ${item.path}`}
        <button type="button" onClick={() => onClose()}>
          Close PDF
        </button>
        {onReadWithAgent ? (
          <button type="button" onClick={() => onReadWithAgent(item)}>
            Read with agent
          </button>
        ) : null}
      </div>
    ) : null
  }
}))

const inboxPage: LiteratureCatalogSearchPage = {
  entries: [
    {
      id: 'candidate-1',
      state: 'pending',
      candidate: {
        item: {
          itemType: 'journalArticle',
          title: 'Corrective Retrieval Augmented Generation',
          abstract: 'A corrective retrieval method.',
          issuedText: '2024',
          issuedYear: 2024,
          containerTitle: 'arXiv',
          shortTitle: '',
          language: 'en',
          rights: '',
          url: '',
          extra: '',
          typeFields: {},
          creators: [
            {
              nameMode: 'person',
              givenName: 'Shi-Qi',
              familyName: 'Yan',
              creatorType: 'author'
            }
          ],
          identifiers: [{ scheme: 'doi', value: '10.0000/example', isPrimary: true }]
        },
        source: {
          provider: 'Agent search',
          sourceUrl: 'https://example.test/paper',
          rawMetadata: {}
        },
        origin: { kind: 'agent', projectId: 'project-1', sessionId: 'session-1' }
      },
      createdAt: 1,
      updatedAt: 1
    }
  ]
}

const libraryItem: LiteratureItemView = {
  id: 'item-1',
  item: (inboxPage.entries[0] as LiteratureInboxCandidateView).candidate.item,
  attachments: [],
  projectIds: [],
  collectionIds: [],
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1
}

const createLibraryItem = (index: number): LiteratureItemView => ({
  ...libraryItem,
  id: `item-${index}`,
  item: {
    ...libraryItem.item,
    title: `Reference ${index}`,
    issuedYear: 2024 - (index % 5)
  },
  metadataRevision: index + 1,
  createdAt: index + 1,
  updatedAt: index + 1
})

const createLibraryItemWithPdf = (): LiteratureItemView => ({
  ...libraryItem,
  attachments: [
    {
      id: 'attachment-1',
      kind: 'fullText',
      title: '',
      sortOrder: 0,
      versions: [
        {
          id: 'version-1',
          versionNumber: 1,
          filename: 'paper.pdf',
          contentType: 'application/pdf',
          sizeBytes: 8,
          checksum: 'a'.repeat(64),
          createdAt: 2
        }
      ],
      createdAt: 2,
      updatedAt: 2
    }
  ]
})

const openMenu = async (trigger: Element): Promise<void> => {
  act(() => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

const openReferenceDetail = async (trigger: Element): Promise<HTMLElement> => {
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog')
  await waitFor(() => expect(within(dialog).queryByRole('status')).toBeNull())
  return dialog
}

describe('LiteratureLibraryPage', () => {
  const search = vi.fn()
  const get = vi.fn()
  const formatReferences = vi.fn()
  const citationStyles = vi.fn()
  const completeMetadata = vi.fn()
  const fullText = vi.fn()
  const importRecords = vi.fn()
  const transact = vi.fn().mockResolvedValue({ kind: 'item', id: 'item-1', state: 'present' })
  const importPdf = vi.fn()
  const stageLocalFile = vi.fn()
  const claimLocalFile = vi.fn().mockResolvedValue(undefined)
  const deleteUpload = vi.fn().mockResolvedValue(undefined)
  const filterPdfContextCandidates = vi.fn()
  const createProjectApi = vi.fn()
  const startPdfReadingConversation = vi.fn()
  const startPdfReadingConversations = vi.fn(() => true)
  const startLiteratureReviewConversation = vi.fn(() => true)
  const saveBlobFile = vi.fn()

  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    useNavigationStore.setState({
      view: 'library',
      activeProjectId: undefined,
      pendingLiteratureItemId: undefined,
      pendingLiteratureProjectId: undefined,
      pendingLiteratureCollectionId: undefined,
      startPdfReadingConversation,
      startPdfReadingConversations,
      startLiteratureReviewConversation
    })
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [
        {
          id: 'project-1',
          name: 'Retrieval research',
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      isLoaded: true
    })
    useTagStore.setState({
      ...createInitialTagState(),
      status: 'ready',
      revision: 1,
      tags: [
        {
          id: 'tag-favorite',
          systemKey: 'favorite',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      assignments: [
        {
          tagId: 'tag-favorite',
          resourceType: 'literature.item',
          resourceId: libraryItem.id,
          createdAt: 1
        }
      ]
    })
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'inbox' ? inboxPage : { entries: [] })
    )
    filterPdfContextCandidates.mockImplementation(
      (request: { sources: readonly { sourceKind: string; sourceVersionId: string }[] }) =>
        Promise.resolve({ sources: request.sources, pendingAttachmentIds: [] })
    )
    createProjectApi.mockResolvedValue({
      id: 'reading-project',
      name: 'Reading project',
      description: '',
      agentContext: '',
      isExample: false,
      createdAt: 2,
      updatedAt: 2
    } satisfies Project)
    startPdfReadingConversation.mockReturnValue(true)
    saveBlobFile.mockResolvedValue({ saved: true, filePath: '/tmp/references.bib' })
    get.mockResolvedValue(undefined)
    formatReferences.mockResolvedValue({
      references: [
        {
          itemId: libraryItem.id,
          inText: '(Yan, 2024)',
          reference: 'Yan, S.-Q. (2024). Corrective Retrieval Augmented Generation.'
        }
      ],
      exports: {
        bibtex: '@article{item-1, title = {Corrective Retrieval Augmented Generation}}',
        ris: 'TY  - JOUR\nTI  - Corrective Retrieval Augmented Generation\nER  -'
      }
    })
    citationStyles.mockResolvedValue({
      styles: [
        { id: 'apa', title: 'APA Style 7th edition', source: 'built-in' },
        { id: 'mla', title: 'Modern Language Association 9th edition', source: 'built-in' },
        { id: 'vancouver', title: 'Vancouver', source: 'built-in' }
      ]
    })
    importRecords.mockImplementation((request: { mode: 'commit' | 'preview' }) =>
      Promise.resolve({
        format: 'bibtex',
        items: [libraryItem.item],
        entries: [
          {
            index: 0,
            title: libraryItem.item.title,
            status: 'ready',
            warnings: [],
            item: libraryItem.item
          }
        ],
        errors: [],
        truncated: false,
        scannedEntries: 1,
        ...(request.mode === 'commit'
          ? { imported: { itemIds: [libraryItem.id], createdCount: 1, reusedCount: 0 } }
          : {})
      })
    )
    completeLiteraturePdfDraft.mockImplementation(async (draft: LiteratureItemInput) => draft)
    extractLiteraturePdfDraft.mockImplementation((_file: File, fallback: LiteratureItemInput) =>
      Promise.resolve(fallback)
    )
    completeMetadata.mockImplementation((request: { mode: 'commit' | 'preview' }) => {
      const completedItem = {
        ...libraryItem,
        metadataRevision: request.mode === 'commit' ? 2 : 1,
        item: {
          ...libraryItem.item,
          containerTitle: 'Journal of Retrieval',
          typeFields: { volume: '12', issue: '3', pages: '44-58' }
        }
      }
      return Promise.resolve({
        mode: request.mode,
        provider: 'crossref',
        sourceUrl: 'https://api.crossref.org/works/10.0000%2Fexample',
        item: completedItem,
        filled: [
          { field: 'journal', value: 'Journal of Retrieval' },
          { field: 'volume', value: '12' },
          { field: 'issue', value: '3' },
          { field: 'pages', value: '44-58' }
        ],
        conflicts:
          request.mode === 'preview'
            ? [
                {
                  field: 'title',
                  currentValue: 'Corrective Retrieval Augmented Generation',
                  value: 'Corrective RAG'
                }
              ]
            : []
      })
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: 'darwin',
        saveBlobFile,
        literature: {
          lookupMetadata: vi.fn(async () => libraryItem.item),
          jobs: vi.fn(async () => ({ jobs: [], summaries: [] })),
          search,
          transact,
          get,
          completeMetadata,
          fullText,
          citationStyles,
          formatDocument: vi.fn(),
          formatReferences,
          importPdf,
          importRecords
        },
        uploads: {
          stageLocalFile,
          claimLocalFile,
          deleteUpload,
          finalizeSession: vi.fn(),
          beginTransfer: vi.fn(),
          appendTransfer: vi.fn(),
          getTransferStatus: vi.fn(),
          finishTransfer: vi.fn(),
          abortTransfer: vi.fn()
        } as unknown as Window['api']['uploads'],
        sessions: {
          filterPdfContextCandidates
        } as unknown as Window['api']['sessions'],
        projects: {
          create: createProjectApi
        } as unknown as Window['api']['projects'],
        tags: {
          snapshot: vi.fn().mockResolvedValue({
            revision: 1,
            tags: [
              {
                id: 'tag-favorite',
                systemKey: 'favorite',
                createdAt: 1,
                updatedAt: 1
              }
            ],
            assignments: [
              {
                tagId: 'tag-favorite',
                resourceType: 'literature.item',
                resourceId: libraryItem.id,
                createdAt: 1
              }
            ]
          }),
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          reorder: vi.fn(),
          setAssignment: vi.fn(),
          onChanged: vi.fn(() => () => undefined)
        } as unknown as Window['api']['tags']
      } satisfies Partial<Window['api']>
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows the load error after the initial Inbox request settles', async () => {
    search.mockImplementation((request: LiteratureCatalogSearchRequest) =>
      request.scope === 'inbox' && request.limit !== 1
        ? Promise.reject(new Error('Inbox unavailable'))
        : Promise.resolve({ entries: [], totalCount: 0 })
    )
    render(<LiteratureLibraryPage />)
    await act(async () => {})
    expect(
      search.mock.calls.some(([request]) => request.scope === 'inbox' && request.limit !== 1)
    ).toBe(true)
    expect(screen.queryByText('Literature could not be loaded.')).not.toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.queryByText('Inbox is clear')).toBeNull()
    search.mockImplementation((request: LiteratureCatalogSearchRequest) =>
      Promise.resolve(request.scope === 'inbox' ? inboxPage : { entries: [] })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText(libraryItem.item.title)
    expect(screen.queryByText('Literature could not be loaded.')).toBeNull()
  })

  it('makes every collection reachable when navigation spans multiple pages', async () => {
    const collections = Array.from({ length: 101 }, (_, index) => ({
      id: `collection-${index + 1}`,
      name: `Collection ${index + 1}`,
      description: '',
      itemCount: 0,
      createdAt: 1,
      updatedAt: 1
    }))
    search.mockImplementation((request: LiteratureCatalogSearchRequest) => {
      const offset = request.offset ?? 0
      return Promise.resolve(
        request.scope === 'collections'
          ? {
              entries: collections.slice(offset, offset + 100),
              totalCount: 101,
              nextOffset: offset === 0 ? 100 : undefined
            }
          : { entries: [], totalCount: 0 }
      )
    })
    render(<LiteratureLibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show all collections' }))
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Collection 100' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Collection 101' })).not.toBeNull()
  })

  it('prevents metadata edits from being lost while a save is in flight', async () => {
    search.mockImplementation((request: LiteratureCatalogSearchRequest) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )
    get.mockResolvedValue(libraryItem)
    let finish: () => void = () => {}
    transact.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ kind: 'item', id: libraryItem.id, state: 'present' })
        })
    )
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText(libraryItem.item.title))
    await openMenu(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit metadata' }))
    const title = screen.getByLabelText('Title') as HTMLInputElement
    fireEvent.change(title, { target: { value: 'Submitted title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    const locked = title.matches(':disabled') || title.readOnly
    if (!locked) fireEvent.change(title, { target: { value: 'New unsaved title' } })
    expect(title.value).toBe(locked ? 'Submitted title' : 'New unsaved title')
    get.mockResolvedValue({
      ...libraryItem,
      metadataRevision: 2,
      item: { ...libraryItem.item, title: 'Submitted title' }
    })
    await act(async () => finish())
    expect(transact).toHaveBeenCalledTimes(1)
    expect(
      locked ||
        (screen.queryByLabelText('Title') as HTMLInputElement | null)?.value === 'New unsaved title'
    ).toBe(true)
  })

  it('previews selected duplicate groups before committing and reports the batch result', async () => {
    let merged = false
    search.mockImplementation(async (request: { scope: string }) =>
      request.scope === 'duplicates'
        ? {
            entries: merged
              ? []
              : [
                  {
                    id: 'group-1',
                    title: 'Duplicate study',
                    itemIds: ['item-1', 'item-2'],
                    match: 'identifier'
                  }
                ],
            totalCount: merged ? 0 : 1
          }
        : { entries: [] }
    )
    transact.mockImplementationOnce(async () => ({
      kind: 'item',
      id: 'item-1',
      batch: { eligible: 1, reduced: 1, review: 0, succeeded: 0, skipped: 0, failed: 0 }
    }))
    transact.mockImplementationOnce(async () => {
      merged = true
      return {
        kind: 'item',
        id: 'item-1',
        batch: { eligible: 1, reduced: 1, review: 0, succeeded: 1, skipped: 0, failed: 0 }
      }
    })
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Duplicates' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select groups on this page' }))
    expect(transact).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Preview batch merge' }))
    expect(await screen.findByText(/Selected groups: 1 · Ready to merge: 1/)).not.toBeNull()
    expect(transact).toHaveBeenCalledWith({
      kind: 'merge-duplicates',
      mode: 'preview',
      strategy: 'conflict-free',
      groups: [['item-1', 'item-2']]
    })
    fireEvent.click(screen.getByRole('button', { name: 'Merge conflict-free groups' }))
    expect(await screen.findByText('Succeeded: 1 · Skipped: 0 · Failed: 0')).not.toBeNull()
    expect(transact).toHaveBeenLastCalledWith({
      kind: 'merge-duplicates',
      mode: 'commit',
      strategy: 'conflict-free',
      expectedItems: undefined,
      groups: [['item-1', 'item-2']]
    })
    expect(await screen.findByText('No duplicates found')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    expect(await screen.findByText('No references found')).not.toBeNull()
  })

  it('shows duplicate group count between All references and Trash and reviews a group before merging', async () => {
    let merged = false
    search.mockImplementation(async (request: { scope: string }) =>
      request.scope === 'duplicates'
        ? {
            entries: merged
              ? []
              : [
                  {
                    id: 'group-1',
                    title: libraryItem.item.title,
                    itemIds: ['item-1', 'item-2'],
                    match: 'metadata'
                  }
                ],
            totalCount: merged ? 0 : 1
          }
        : { entries: [] }
    )
    get.mockImplementation(async (id: string) => ({
      ...libraryItem,
      id,
      item: {
        ...libraryItem.item,
        personalNote: id === 'item-2' ? 'Check the methods' : '',
        rating: id === 'item-2' ? 5 : 0
      }
    }))
    transact.mockImplementationOnce(async () => {
      merged = true
      return { kind: 'item', id: 'item-1', state: 'merged' }
    })
    render(<LiteratureLibraryPage />)
    const nav = screen.getByRole('navigation', { name: 'Literature library' })
    const buttons = within(nav)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
    expect(buttons.indexOf('Duplicates')).toBe(buttons.indexOf('All references') + 1)
    expect(buttons.indexOf('Trash')).toBe(buttons.indexOf('Duplicates') + 1)
    expect(await within(nav).findByLabelText('1 duplicate group')).not.toBeNull()
    fireEvent.click(within(nav).getByRole('button', { name: 'All references' }))
    expect(await screen.findByText('No references found')).not.toBeNull()
    const libraryRequests = search.mock.calls.filter(
      ([request]) => request.scope === 'library' && request.limit !== 1
    ).length
    fireEvent.click(within(nav).getByRole('button', { name: 'Duplicates' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review duplicates' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('radio')).toHaveLength(2)
    expect(transact).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge references' }))
    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'merge-items',
          survivorId: 'item-1',
          duplicateIds: ['item-2'],
          expectedItems: expect.arrayContaining([
            expect.objectContaining({
              id: 'item-1',
              metadataRevision: expect.any(Number),
              updatedAt: expect.any(Number)
            }),
            expect.objectContaining({
              id: 'item-2',
              metadataRevision: expect.any(Number),
              updatedAt: expect.any(Number)
            })
          ]),
          item: expect.objectContaining({ personalNote: 'Check the methods', rating: 5 })
        })
      )
    )
    expect(await screen.findByText('No duplicates found')).not.toBeNull()
    expect(within(nav).getByLabelText('0 duplicate groups')).not.toBeNull()
    fireEvent.click(within(nav).getByRole('button', { name: 'All references' }))
    await waitFor(() =>
      expect(
        search.mock.calls.filter(([request]) => request.scope === 'library' && request.limit !== 1)
      ).toHaveLength(libraryRequests + 1)
    )
  })

  it('merges the field values chosen in the duplicate comparison', async () => {
    search.mockImplementation(async (request: { scope: string }) => ({
      entries:
        request.scope === 'duplicates'
          ? [
              {
                id: 'group-1',
                title: libraryItem.item.title,
                itemIds: ['item-1', 'item-2'],
                match: 'identifier'
              }
            ]
          : [],
      totalCount: request.scope === 'duplicates' ? 1 : 0
    }))
    const second = {
      ...libraryItem.item,
      title: 'Updated title',
      creators: [
        { nameMode: 'organization' as const, literalName: 'Research Team', creatorType: 'author' }
      ],
      typeFields: { volume: '12' }
    }
    get.mockImplementation(async (id: string) => ({
      ...libraryItem,
      id,
      item: id === 'item-2' ? second : { ...libraryItem.item, typeFields: { volume: '10' } }
    }))
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Duplicates' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review duplicates' }))
    const dialog = await screen.findByRole('dialog')
    for (const field of ['Title', 'Authors', 'Volume']) {
      fireEvent.click(within(dialog).getByRole('radio', { name: `Use ${field} from reference 2` }))
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge references' }))
    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'merge-items',
          survivorId: 'item-1',
          duplicateIds: ['item-2'],
          item: expect.objectContaining({
            title: second.title,
            creators: second.creators,
            typeFields: second.typeFields
          })
        })
      )
    )
  })

  it('preserves the loaded reference rows when visiting Duplicates and returning without changes', async () => {
    const entries = Array.from({ length: 50 }, (_, index) => createLibraryItem(index))
    search.mockImplementation(async (request: { scope: string }) => ({
      entries: request.scope === 'library' ? entries : [],
      totalCount: request.scope === 'library' ? entries.length : 0
    }))
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const row = await screen.findByLabelText('Select Reference 0')
    const libraryRequests = search.mock.calls.filter(
      ([request]) => request.scope === 'library' && request.limit !== 1
    ).length
    fireEvent.click(screen.getByRole('button', { name: 'Duplicates' }))
    expect(document.body.contains(row)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    expect(screen.getByLabelText('Select Reference 0')).toBe(row)
    expect(
      search.mock.calls.filter(([request]) => request.scope === 'library' && request.limit !== 1)
    ).toHaveLength(libraryRequests)
  })

  it('shows detection errors with retry instead of reporting no duplicates', async () => {
    search.mockImplementation(async (request: { scope: string }) => {
      if (request.scope === 'duplicates') throw new Error('unavailable')
      return { entries: [] }
    })
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Duplicates' }))
    expect(await screen.findByRole('button', { name: 'Retry' })).not.toBeNull()
    expect(screen.queryByText('No duplicates found')).toBeNull()
    search.mockResolvedValue({ entries: [], totalCount: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No duplicates found')).not.toBeNull()
  })

  it('keeps duplicate review open and shows a failed merge inside the dialog', async () => {
    search.mockImplementation(async (request: { scope: string }) => ({
      entries:
        request.scope === 'duplicates'
          ? [
              {
                id: 'group-1',
                title: libraryItem.item.title,
                itemIds: ['item-1', 'item-2'],
                match: 'metadata'
              }
            ]
          : [],
      totalCount: 1
    }))
    get.mockImplementation(async (id: string) => ({ ...libraryItem, id }))
    transact.mockRejectedValueOnce(new Error('Metadata changed'))
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Duplicates' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Review duplicates' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge references' }))
    expect(await within(dialog).findByText('Literature could not be merged.')).not.toBeNull()
    expect(within(dialog).getAllByRole('radio')).toHaveLength(2)
  })

  it('reviews an Agent candidate before accepting it into the library', async () => {
    render(<LiteratureLibraryPage />)

    expect(await screen.findByText('Corrective Retrieval Augmented Generation')).not.toBeNull()
    expect(screen.getByText('Shi-Qi Yan')).not.toBeNull()
    expect(screen.getByText('2024 · arXiv')).not.toBeNull()
    expect(screen.getByText('A corrective retrieval method.')).not.toBeNull()
    expect(screen.getByText('Found via Agent search')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'View details: Corrective Retrieval Augmented Generation'
      })
    )

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('A corrective retrieval method.')
    expect(dialog.textContent).toContain('10.0000/example')
    expect(within(dialog).getByRole('link', { name: 'DOI: 10.0000/example' })).toHaveProperty(
      'href',
      'https://doi.org/10.0000/example'
    )
    expect(dialog.textContent).toContain('Agent search')
    expect(within(dialog).getByRole('link', { name: 'https://example.test/paper' })).toHaveProperty(
      'href',
      'https://example.test/paper'
    )

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Accept' })))

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'accept-candidate',
        candidateId: 'candidate-1'
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('offers to restore a dismissed Inbox candidate', async () => {
    render(<LiteratureLibraryPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'dismiss-candidate',
        candidateId: 'candidate-1'
      })
    )

    const undo = await screen.findByRole('button', { name: 'Undo' })
    fireEvent.click(undo)

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'restore-candidates',
        candidateIds: ['candidate-1']
      })
    )
  })

  it('shows the total pending Inbox count instead of the loaded page length', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'inbox' ? { ...inboxPage, totalCount: 73 } : { entries: [] }
      )
    )

    render(<LiteratureLibraryPage />)

    const inbox = await screen.findByRole('button', { name: 'Inbox' })
    await waitFor(() => expect(within(inbox).getByText('73')).not.toBeNull())
    expect(within(inbox).queryByText('1')).toBeNull()
  })

  it('selects and settles the loaded Inbox page as one batch', async () => {
    const first = inboxPage.entries[0] as LiteratureInboxCandidateView
    const second: LiteratureInboxCandidateView = {
      ...first,
      id: 'candidate-2',
      candidate: {
        ...first.candidate,
        item: { ...first.candidate.item, title: 'A second discovery' }
      }
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'inbox' ? { entries: [first, second], totalCount: 2 } : { entries: [] }
      )
    )

    render(<LiteratureLibraryPage />)

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select all references' }))
    expect(screen.getByText('2 selected')).not.toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept' })[0]!)

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'settle-candidates',
        candidateIds: ['candidate-1', 'candidate-2'],
        state: 'accepted'
      })
    )
  })

  it('opens the Literature detail selected by a one-shot navigation intent', async () => {
    get.mockResolvedValue(libraryItem)
    useNavigationStore.getState().openLiteratureItem(libraryItem.id, 'user')

    render(<LiteratureLibraryPage />)

    await waitFor(() => expect(get).toHaveBeenCalledWith(libraryItem.id))
    expect(await screen.findByRole('dialog')).not.toBeNull()
    expect(await screen.findByRole('heading', { name: libraryItem.item.title })).not.toBeNull()
    expect(useNavigationStore.getState().pendingLiteratureItemId).toBeUndefined()
  })

  it('explains when a linked Literature reference no longer exists', async () => {
    get.mockResolvedValue(undefined)
    useNavigationStore.getState().openLiteratureItem('missing-item', 'user')

    render(<LiteratureLibraryPage />)

    expect(await screen.findByText('This reference is no longer in your Library.')).not.toBeNull()
    expect(useNavigationStore.getState().pendingLiteratureItemId).toBeUndefined()
  })

  it('opens an explicitly scoped Project view and can return to its Workspace', async () => {
    const longProjectName = `Retrieval research ${'project '.repeat(12)}`.trim()
    const openProject = vi.fn(() => true)
    useProjectStore.setState({
      projects: [
        {
          id: 'project-1',
          name: longProjectName,
          description: '',
          isExample: false,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    useNavigationStore.setState({
      pendingLiteratureProjectId: 'project-1',
      openProject
    })

    render(<LiteratureLibraryPage />)

    const projectHeading = await screen.findByRole('heading', { name: longProjectName })
    expect(projectHeading.className).toContain('truncate')
    expect(projectHeading.parentElement?.className).toContain('w-fit')
    expect(projectHeading.parentElement?.className).toContain('max-w-full')
    expect(projectHeading.getAttribute('title')).toBe(longProjectName)
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'library', projectId: 'project-1' })
      )
    )
    expect(useNavigationStore.getState().pendingLiteratureProjectId).toBeUndefined()

    const openProjectButton = screen.getByRole('button', { name: 'Open project' })
    expect(openProjectButton.className).toContain('shrink-0')
    expect(openProjectButton.querySelector('.lucide-external-link')).not.toBeNull()
    expect(projectHeading.nextElementSibling).toBe(openProjectButton)
    fireEvent.click(openProjectButton)
    expect(openProject).toHaveBeenCalledWith('project-1', 'user')

    const reviewButton = screen.getByRole('button', { name: 'Review with agent' })
    expect(reviewButton.getAttribute('data-variant')).toBe('default')
    expect(reviewButton.getAttribute('data-attention')).toBe('true')
    expect(reviewButton.querySelector('.literature-review-cta__content')).not.toBeNull()
    expect(reviewButton.querySelector('.literature-review-cta__mark')).not.toBeNull()
    expect(window.sessionStorage.getItem('open-science:literature-review-cta-attention-seen')).toBe(
      'true'
    )
    fireEvent.click(reviewButton)
    expect(startLiteratureReviewConversation).toHaveBeenCalledWith(
      'project-1',
      { type: 'literature-scope', scope: 'project' },
      'Synthesize this literature into a concise review.'
    )
  })

  it('keeps the selected Project sidebar count aligned with its loaded result total', async () => {
    search.mockImplementation((request: { scope: string; projectId?: string; query?: string }) =>
      Promise.resolve(
        request.scope === 'library' && request.projectId === 'project-1'
          ? { entries: [libraryItem], totalCount: request.query ? 1 : 50 }
          : request.scope === 'inbox'
            ? inboxPage
            : { entries: [] }
      )
    )
    useNavigationStore.setState({ pendingLiteratureProjectId: 'project-1' })

    render(<LiteratureLibraryPage />)

    const projectButton = await screen.findByRole('button', { name: 'Retrieval research' })
    await waitFor(() => expect(within(projectButton).getByText('50')).not.toBeNull())

    filePreviewRenderCount.value = 0
    fireEvent.change(screen.getByLabelText('Search references'), {
      target: { value: 'focused' }
    })
    fireEvent.change(screen.getByLabelText('Search references'), {
      target: { value: 'focused result' }
    })
    expect(filePreviewRenderCount.value).toBe(0)
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-1', query: 'focused result' })
      )
    )
    expect(within(projectButton).getByText('50')).not.toBeNull()
  })

  it('opens an explicitly scoped Collection view', async () => {
    const collection = {
      id: 'collection-1',
      name: 'TP53 evidence',
      description: 'Curated TP53 studies.',
      itemCount: 1,
      createdAt: 1,
      updatedAt: 1
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'collections'
          ? { entries: [collection], totalCount: 1 }
          : request.scope === 'inbox'
            ? inboxPage
            : { entries: [] }
      )
    )
    useNavigationStore.setState({
      activeProjectId: 'project-1',
      pendingLiteratureCollectionId: collection.id
    })

    render(<LiteratureLibraryPage />)

    expect(await screen.findByRole('heading', { name: collection.name })).not.toBeNull()
    expect(screen.getByText(collection.description)).not.toBeNull()
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'library', collectionId: collection.id })
      )
    )
    expect(useNavigationStore.getState().pendingLiteratureCollectionId).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: 'Review with agent' }))
    expect(startLiteratureReviewConversation).toHaveBeenCalledWith(
      'project-1',
      {
        type: 'literature-scope',
        scope: 'collection',
        collectionId: collection.id,
        name: collection.name
      },
      'Synthesize this literature into a concise review.'
    )
  })

  it('keeps the Collection editor open and explains duplicate-name rejection', async () => {
    transact.mockRejectedValueOnce(
      new Error('Error invoking remote method: literature_collection_name_conflict')
    )
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New collection' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Review' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create collection' }))
    expect(
      await within(dialog).findByText(
        'A collection with this name already exists at this level. Choose another name.'
      )
    ).not.toBeNull()
    expect(within(dialog).getByLabelText('Name').getAttribute('value')).toBe('Review')
    expect(screen.getByRole('dialog')).toBe(dialog)
  })

  it('creates and edits Collections with one shared name and description form', async () => {
    let collection:
      | {
          id: string
          name: string
          description: string
          itemCount: number
          createdAt: number
          updatedAt: number
        }
      | undefined
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'collections'
          ? { entries: collection ? [collection] : [], totalCount: collection ? 1 : 0 }
          : request.scope === 'inbox'
            ? inboxPage
            : { entries: [] }
      )
    )
    transact.mockImplementation(
      (command: { kind: string; name?: string; description?: string }) => {
        if (command.kind === 'create-collection') {
          collection = {
            id: 'collection-1',
            name: command.name ?? '',
            description: command.description ?? '',
            itemCount: 0,
            createdAt: 1,
            updatedAt: 1
          }
          return Promise.resolve({ kind: 'collection', id: collection.id })
        }
        if (command.kind === 'update-collection' && collection) {
          collection = {
            ...collection,
            name: command.name ?? collection.name,
            description: command.description ?? collection.description,
            updatedAt: 2
          }
          return Promise.resolve({ kind: 'collection', id: collection.id })
        }
        return Promise.resolve({ kind: 'item', id: libraryItem.id, state: 'present' })
      }
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'New collection' }))

    let dialog = await screen.findByRole('dialog')
    const descriptionHelp =
      "Shown in the Library for your reference — not included in the agent's prompt."
    expect(within(dialog).queryByText(descriptionHelp)).toBeNull()
    const descriptionHelpTrigger = within(dialog).getByRole('button', {
      name: descriptionHelp
    })
    fireEvent.focus(descriptionHelpTrigger)
    expect((await screen.findByRole('tooltip')).textContent).toBe(descriptionHelp)
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Screening' }
    })
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Papers awaiting review.' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create collection' }))

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'create-collection',
        name: 'Screening',
        description: 'Papers awaiting review.'
      })
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Screening' }))
    expect(await screen.findByText('Papers awaiting review.')).not.toBeNull()

    await openMenu(screen.getByRole('button', { name: 'Collection actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit collection' }))
    dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByLabelText('Name').getAttribute('value')).toBe('Screening')
    expect(within(dialog).getByLabelText('Description').textContent).toBe('Papers awaiting review.')
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Included studies' }
    })
    fireEvent.change(within(dialog).getByLabelText('Description'), {
      target: { value: 'Final synthesis set.' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'update-collection',
        collectionId: 'collection-1',
        name: 'Included studies',
        description: 'Final synthesis set.'
      })
    )
    expect(await screen.findByRole('heading', { name: 'Included studies' })).not.toBeNull()
    expect(screen.getByText('Final synthesis set.')).not.toBeNull()
  })

  it('opens the Collection editor from its collapsed group without toggling or rerendering the page', () => {
    render(<LiteratureLibraryPage />)
    const collectionsGroup = screen.getByRole('button', { name: 'Collections' })
    const newCollectionButton = screen.getByRole('button', { name: 'New collection' })
    expect(collectionsGroup.parentElement).toBe(newCollectionButton.parentElement)
    expect(collectionsGroup.contains(newCollectionButton)).toBe(false)
    expect(screen.getByRole('button', { name: 'Settings' }).parentElement).not.toBe(
      newCollectionButton.parentElement
    )
    fireEvent.click(collectionsGroup)
    filePreviewRenderCount.value = 0

    fireEvent.click(newCollectionButton)

    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(collectionsGroup.getAttribute('aria-expanded')).toBe('false')
    expect(filePreviewRenderCount.value).toBe(0)
  })

  it.each([false, true])(
    'handles Collection deletion while keeping the user in the Library (name conflict: %s)',
    async (nameConflict) => {
      const collection = {
        id: 'collection-1',
        name: 'Screening',
        description: 'Papers awaiting review.',
        itemCount: 1,
        createdAt: 1,
        updatedAt: 1
      }
      search.mockImplementation((request: { scope: string }) =>
        Promise.resolve(
          request.scope === 'collections'
            ? { entries: [collection], totalCount: 1 }
            : request.scope === 'inbox'
              ? inboxPage
              : { entries: [] }
        )
      )
      useNavigationStore.setState({ pendingLiteratureCollectionId: collection.id })

      render(<LiteratureLibraryPage />)
      await screen.findByRole('heading', { name: collection.name })
      await openMenu(screen.getByRole('button', { name: 'Collection actions' }))
      const editCollection = screen.getByRole('menuitem', { name: 'Edit collection' })
      const deleteCollection = screen.getByRole('menuitem', { name: 'Delete collection' })
      expect(editCollection.className).toContain('gap-2')
      expect(editCollection.firstElementChild?.className).toContain('shrink-0')
      expect(deleteCollection.className).toContain('gap-2')
      expect(deleteCollection.firstElementChild?.className).toContain('shrink-0')
      fireEvent.click(deleteCollection)

      const alert = await screen.findByRole('alertdialog')
      expect(within(alert).getByText(`Delete “${collection.name}”?`)).not.toBeNull()
      expect(
        within(alert).getByText(
          'References in this collection will remain in All references. This action cannot be undone.'
        )
      ).not.toBeNull()
      if (nameConflict) {
        transact.mockRejectedValueOnce(new Error('literature_collection_name_conflict'))
      } else {
        transact.mockResolvedValueOnce({ kind: 'collection', id: collection.id })
      }
      fireEvent.click(within(alert).getByRole('button', { name: 'Delete collection' }))

      await waitFor(() =>
        expect(transact).toHaveBeenCalledWith({
          kind: 'delete-collection',
          collectionId: collection.id
        })
      )
      if (nameConflict) {
        expect(
          await within(alert).findByText(
            'A child collection would duplicate a top-level name. Rename it before deleting this collection.'
          )
        ).not.toBeNull()
        fireEvent.click(within(alert).getByRole('button', { name: 'Cancel' }))
        expect(await screen.findByRole('heading', { name: collection.name })).not.toBeNull()
      } else {
        expect(await screen.findByRole('heading', { name: 'All references' })).not.toBeNull()
      }
    }
  )

  it('truncates a long Collection view name without squeezing the action toolbar', async () => {
    const longCollectionName = `Collection ${'research '.repeat(12)}`.trim()
    const collection = {
      id: 'collection-long',
      name: longCollectionName,
      description: '',
      itemCount: 0,
      createdAt: 1,
      updatedAt: 1
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'collections'
          ? { entries: [collection], totalCount: 1 }
          : request.scope === 'inbox'
            ? inboxPage
            : { entries: [] }
      )
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: longCollectionName }))

    const collectionHeading = await screen.findByRole('heading', { name: longCollectionName })
    expect(collectionHeading.className).toContain('truncate')
    expect(collectionHeading.parentElement?.className).toContain('max-w-full')
    expect(collectionHeading.getAttribute('title')).toBe(longCollectionName)
    expect(
      screen.getByLabelText('Search references').closest('label')?.parentElement?.className
    ).toContain('shrink-0')
  })

  it('collapses the Literature navigation into an icon rail', async () => {
    render(<LiteratureLibraryPage />)

    const sidebar = screen.getByRole('complementary')
    expect(sidebar.className).toContain('w-60')
    filePreviewRenderCount.value = 0

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar panel' }))

    expect(sidebar.className).toContain('w-14')
    expect(filePreviewRenderCount.value).toBe(0)
    expect(screen.queryByText('Your research references')).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand sidebar panel' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'All references' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Settings' })).not.toBeNull()
    expect(
      screen.getByRole('button', { name: 'New collection' }).parentElement?.className
    ).toContain('items-center')
    fireEvent.click(screen.getByRole('button', { name: 'New collection' }))
    const collectionDialog = screen.getByRole('dialog')
    expect(within(collectionDialog).getByLabelText('Name')).not.toBeNull()
    fireEvent.click(within(collectionDialog).getByRole('button', { name: 'Cancel' }))
    filePreviewRenderCount.value = 0

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar panel' }))

    expect(sidebar.className).toContain('w-60')
    expect(filePreviewRenderCount.value).toBe(0)
    expect(screen.getByText('Your research references')).not.toBeNull()
  })

  it('keeps large Project and Collection groups compact, collapsible, and selection-aware', async () => {
    useProjectStore.setState({
      projects: Array.from({ length: 8 }, (_, index) => ({
        id: `project-${index + 1}`,
        name: `Project ${index + 1}`,
        description: '',
        isExample: false,
        createdAt: index + 1,
        updatedAt: index + 1
      })),
      isLoaded: true
    })
    const collectionEntries = Array.from({ length: 8 }, (_, index) => ({
      id: `collection-${index + 1}`,
      name: `Collection ${index + 1}`,
      description: '',
      itemCount: index + 1,
      createdAt: index + 1,
      updatedAt: index + 1
    }))
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'collections'
          ? { entries: collectionEntries, totalCount: collectionEntries.length }
          : request.scope === 'project-counts'
            ? {
                entries: Array.from({ length: 8 }, (_, index) => ({
                  projectId: `project-${index + 1}`,
                  itemCount: (index + 1) * 10
                })),
                totalCount: 8
              }
            : request.scope === 'inbox'
              ? inboxPage
              : { entries: [] }
      )
    )

    render(<LiteratureLibraryPage />)
    await screen.findByRole('button', { name: 'Collection 1' })

    expect(screen.queryByRole('button', { name: 'Project 6' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Collection 6' })).toBeNull()
    const sidebarSeparators = within(screen.getByRole('complementary')).getAllByRole('separator')
    expect(sidebarSeparators).toHaveLength(2)
    expect(
      sidebarSeparators.every((separator) => separator.className.includes('bg-border-300/80'))
    ).toBe(true)
    expect(
      screen
        .getByRole('button', { name: 'Project 1' })
        .querySelector('.lucide-gallery-vertical-end')
    ).not.toBeNull()
    await waitFor(() =>
      expect(
        within(screen.getByRole('button', { name: 'Project 1' })).getByText('10')
      ).not.toBeNull()
    )
    expect(screen.getByRole('button', { name: 'Project 1' }).className).not.toContain(
      'transition-colors'
    )
    expect(screen.getByRole('button', { name: 'Collection 1' }).className).not.toContain(
      'transition-colors'
    )

    const projectsGroup = screen.getByRole('button', { name: 'Projects' })
    expect(projectsGroup.className).toContain('h-9')
    expect(projectsGroup.className).toContain('rounded-lg')
    expect(projectsGroup.className).toContain('hover:bg-bg-300')
    expect(projectsGroup.className).not.toContain('transition-colors')
    expect(projectsGroup.getAttribute('aria-expanded')).toBe('true')
    filePreviewRenderCount.value = 0
    fireEvent.click(projectsGroup)
    expect(projectsGroup.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Project 1' })).toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)
    fireEvent.click(projectsGroup)

    const showAllProjects = screen.getByRole('button', { name: 'Show all projects' })
    expect(showAllProjects.className.split(/\s+/)).toContain('transition-none')
    fireEvent.click(showAllProjects)
    fireEvent.click(screen.getByRole('button', { name: 'Project 8' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer projects' }))
    expect(screen.getByRole('button', { name: 'Project 8' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Project 5' })).toBeNull()

    const collectionsGroup = screen.getByRole('button', { name: 'Collections' })
    expect(collectionsGroup.className).toContain('h-9')
    expect(collectionsGroup.className).toContain('rounded-lg')
    expect(collectionsGroup.className).toContain('hover:bg-bg-300')
    expect(collectionsGroup.className).not.toContain('transition-colors')
    expect(collectionsGroup.getAttribute('aria-expanded')).toBe('true')
    filePreviewRenderCount.value = 0
    fireEvent.click(collectionsGroup)
    expect(collectionsGroup.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Collection 1' })).toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)
    fireEvent.click(collectionsGroup)

    const showAllCollections = screen.getByRole('button', { name: 'Show all collections' })
    expect(showAllCollections.className.split(/\s+/)).toContain('transition-none')
    fireEvent.click(showAllCollections)
    fireEvent.click(screen.getByRole('button', { name: 'Collection 8' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer collections' }))
    expect(screen.getByRole('button', { name: 'Collection 8' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Collection 5' })).toBeNull()
  })

  it('toggles the Literature navigation with the platform sidebar shortcut', () => {
    render(<LiteratureLibraryPage />)

    const sidebar = screen.getByRole('complementary')
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar panel' })
    expect(toggle.getAttribute('aria-keyshortcuts')).toBe('Meta+B')

    const collapse = new KeyboardEvent('keydown', {
      key: 'b',
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
    act(() => window.dispatchEvent(collapse))

    expect(collapse.defaultPrevented).toBe(true)
    expect(sidebar.className).toContain('w-14')

    act(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'b',
          metaKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    )
    expect(sidebar.className).toContain('w-60')
  })

  it.each(['Complete metadata', 'Find full-text PDF'])(
    'opens batch %s from More actions without writing references',
    async (action) => {
      const entries = [createLibraryItem(1), createLibraryItem(2)]
      search.mockImplementation((request: { scope: string }) =>
        Promise.resolve(request.scope === 'library' ? { entries, totalCount: 2 } : { entries: [] })
      )
      render(<LiteratureLibraryPage />)
      fireEvent.click(screen.getByRole('button', { name: 'All references' }))
      fireEvent.click(await screen.findByLabelText('Select all references'))
      const toolbar = document.querySelector('[data-slot="literature-selection-toolbar"]')!
      expect(within(toolbar as HTMLElement).queryByRole('button', { name: action })).toBeNull()
      fireEvent.pointerDown(
        within(toolbar as HTMLElement).getByRole('button', { name: 'More actions' }),
        { button: 0, ctrlKey: false }
      )
      fireEvent.click(await screen.findByRole('menuitem', { name: action }))
      const dialog = await screen.findByRole('dialog')
      expect(within(dialog).getByRole('heading', { name: action })).not.toBeNull()
      expect(within(dialog).getByText('Reference 1')).not.toBeNull()
      expect(within(dialog).getByText('Reference 2')).not.toBeNull()
      expect(completeMetadata).not.toHaveBeenCalled()
      expect(fullText).not.toHaveBeenCalled()
    }
  )

  it('adds a selected PDF to an existing Literature Item through managed staging', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )
    const staged = {
      id: 'upload-1',
      sessionId: '.pending',
      name: 'paper.pdf',
      originalName: 'paper.pdf',
      path: '/managed/paper.pdf',
      mimeType: 'application/pdf',
      size: 8
    }
    stageLocalFile.mockResolvedValue(staged)
    importPdf.mockResolvedValue({
      item: {
        ...libraryItem,
        attachments: [
          {
            id: 'attachment-1',
            kind: 'fullText',
            title: '',
            sortOrder: 0,
            versions: [
              {
                id: 'version-1',
                versionNumber: 1,
                filename: 'paper.pdf',
                contentType: 'application/pdf',
                sizeBytes: 8,
                checksum: 'a'.repeat(64),
                createdAt: 2
              }
            ],
            createdAt: 2,
            updatedAt: 2
          }
        ]
      }
    })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const file = new File(['%PDF-1.7'], 'paper.pdf', { type: 'application/pdf' })
    expect(screen.getByText('Drag and drop or click to upload')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Attachments' })).not.toBeNull()
    expect(screen.queryByRole('heading', { name: 'Files' })).toBeNull()
    const dropZone = document.querySelector<HTMLElement>('[data-slot="literature-pdf-drop-zone"]')!
    const pdfInput = screen.getByLabelText('Add PDF') as HTMLInputElement
    const inputClick = vi.spyOn(pdfInput, 'click')
    fireEvent.click(dropZone)
    expect(inputClick).toHaveBeenCalledOnce()
    const dropEvent = new Event('drop', { bubbles: true })
    Object.defineProperty(dropEvent, 'dataTransfer', {
      value: { types: ['Files'], files: [file] }
    })
    fireEvent(dropZone, dropEvent)

    await waitFor(() =>
      expect(importPdf).toHaveBeenCalledWith({ itemId: libraryItem.id, attachment: staged })
    )
    expect(claimLocalFile).toHaveBeenCalledWith({ transferId: expect.any(String) })
    expect(await screen.findByText('8 B')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Preview paper.pdf' }))

    expect(screen.getByTestId('literature-pdf-preview').textContent).toContain(
      'paper.pdf · literature-attachment-version:version-1'
    )
    expect(screen.getByTestId('literature-pdf-preview').dataset.allowReadingContext).toBe('false')

    fireEvent.click(
      within(screen.getByTestId('literature-pdf-preview')).getByRole('button', {
        name: 'Read with agent',
        hidden: true
      })
    )
    expect(await screen.findByRole('heading', { name: 'Read with agent' })).not.toBeNull()
    expect(screen.getByText('Choose a project for this Reading session.')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retrieval research' }))

    await waitFor(() =>
      expect(filterPdfContextCandidates).toHaveBeenCalledWith({
        projectId: 'project-1',
        sources: [
          {
            sourceKind: 'literature-attachment-version',
            sourceVersionId: 'version-1'
          }
        ]
      })
    )
    expect(startPdfReadingConversation).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        path: 'literature-attachment-version:version-1',
        source: 'literature'
      }),
      {
        sourceKind: 'literature-attachment-version',
        sourceVersionId: 'version-1'
      }
    )
  })

  it('keeps every Reading project selectable and creation outside the scrolling list', async () => {
    const entry = createLibraryItemWithPdf()
    const template = useProjectStore.getState().projects[0]
    useProjectStore.setState({
      projects: Array.from({ length: 35 }, (_, index) => ({
        ...template,
        id: `project-${index + 1}`,
        name: `Reading project ${index + 1}`
      }))
    })
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [entry] } : { entries: [] })
    )
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Preview paper.pdf' }))
    fireEvent.click(
      within(screen.getByTestId('literature-pdf-preview')).getByRole('button', {
        name: 'Read with agent',
        hidden: true
      })
    )
    const dialog = await screen.findByRole('dialog', { name: 'Read with agent' })
    const viewport = dialog.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    const lastProject = within(dialog).getByRole('button', { name: 'Reading project 35' })
    expect(viewport.contains(lastProject)).toBe(true)
    expect(viewport.contains(within(dialog).getByRole('button', { name: 'New project' }))).toBe(
      false
    )
    expect(within(viewport).getAllByRole('button')).toHaveLength(35)
    fireEvent.click(lastProject)
    await waitFor(() =>
      expect(startPdfReadingConversation).toHaveBeenCalledWith(
        'project-35',
        expect.objectContaining({ source: 'literature' }),
        { sourceKind: 'literature-attachment-version', sourceVersionId: 'version-1' }
      )
    )
  })

  it('reviews a batch of references and opens a three-PDF Reading draft without silently including missing PDFs', async () => {
    const entries = [1, 2, 3, 4].map((id) => {
      const entry = createLibraryItemWithPdf()
      return {
        ...entry,
        id: `item-${id}`,
        item: { ...entry.item, title: `Paper ${id}` },
        attachments: entry.attachments.map((attachment) => ({
          ...attachment,
          id: `attachment-${id}`,
          versions: attachment.versions.map((version) => ({
            ...version,
            id: `version-${id}`,
            filename: `paper-${id}.pdf`
          }))
        }))
      }
    })
    entries.push({ ...createLibraryItem(5), attachments: [] })
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'library' ? { entries, totalCount: entries.length } : { entries: [] }
      )
    )
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    fireEvent.click(await screen.findByLabelText('Select all references'))
    fireEvent.click(screen.getByRole('button', { name: 'Read with agent' }))
    await screen.findByText('Choose up to 3 PDFs to read together.')
    expect(await screen.findByText('No readable PDF')).not.toBeNull()
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    for (const id of [1, 2, 3]) fireEvent.click(screen.getByLabelText(`Read Paper ${id}`))
    expect((screen.getByLabelText('Read Paper 4') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Read Paper 2'))
    fireEvent.click(screen.getByLabelText('Read Paper 4'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retrieval research' }))
    await waitFor(() =>
      expect(startPdfReadingConversations).toHaveBeenCalledWith('project-1', [
        expect.objectContaining({
          source: { sourceKind: 'literature-attachment-version', sourceVersionId: 'version-1' }
        }),
        expect.objectContaining({
          source: { sourceKind: 'literature-attachment-version', sourceVersionId: 'version-3' }
        }),
        expect.objectContaining({
          source: { sourceKind: 'literature-attachment-version', sourceVersionId: 'version-4' }
        })
      ])
    )
    expect(filterPdfContextCandidates).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: [1, 3, 4].map((id) => ({
        sourceKind: 'literature-attachment-version',
        sourceVersionId: `version-${id}`
      }))
    })
  })

  it('loads Reading candidates across all matching pages and rejects a partially unreadable selection', async () => {
    const first = createLibraryItemWithPdf()
    const last = {
      ...createLibraryItemWithPdf(),
      id: 'last-item',
      item: { ...libraryItem.item, title: 'Last paper' },
      attachments: first.attachments.map((attachment) => ({
        ...attachment,
        id: 'last-attachment',
        versions: attachment.versions.map((version) => ({ ...version, id: 'last-version' }))
      }))
    }
    const entries = [
      first,
      ...Array.from({ length: 49 }, (_, index) => createLibraryItem(index + 2)),
      last
    ]
    search.mockImplementation((request: { scope: string; offset?: number; limit?: number }) => {
      if (request.scope !== 'library') return Promise.resolve({ entries: [] })
      const offset = request.offset ?? 0
      const limit = request.limit ?? 50
      return Promise.resolve({
        entries: entries.slice(offset, offset + limit),
        totalCount: 51,
        ...(offset + limit < entries.length ? { nextOffset: offset + limit } : {})
      })
    })
    filterPdfContextCandidates.mockResolvedValue({
      sources: [{ sourceKind: 'literature-attachment-version', sourceVersionId: 'version-1' }],
      pendingAttachmentIds: []
    })
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    fireEvent.click(await screen.findByLabelText('Select all references'))
    fireEvent.click(screen.getByRole('button', { name: /^Select all matching references/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Read with agent' }))
    await screen.findByLabelText('Read Last paper')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retrieval research' }))
    expect(
      await screen.findByText('Some selected PDFs cannot be read. Review your selection.')
    ).not.toBeNull()
    expect(startPdfReadingConversations).not.toHaveBeenCalled()
    expect(filterPdfContextCandidates).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: [
        { sourceKind: 'literature-attachment-version', sourceVersionId: 'version-1' },
        { sourceKind: 'literature-attachment-version', sourceVersionId: 'last-version' }
      ]
    })
  })

  it('does not block PDF wheel events behind reference details and restores the detail modal on close', async () => {
    const itemWithPdf = createLibraryItemWithPdf()
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [itemWithPdf] } : { entries: [] })
    )
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview paper.pdf' }))
    const preview = screen.getByTestId('literature-pdf-preview')
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 600 })
    await act(async () => {
      preview.dispatchEvent(wheel)
    })
    expect(wheel.defaultPrevented).toBe(false)
    fireEvent.click(within(preview).getByRole('button', { name: 'Close PDF', hidden: true }))
    expect(await screen.findByRole('button', { name: 'Preview paper.pdf' })).not.toBeNull()
    const outsideWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 600 })
    await act(async () => {
      document.body.dispatchEvent(outsideWheel)
    })
    expect(outsideWheel.defaultPrevented).toBe(true)
  })

  it('creates the first Project from the Reading chooser and continues the Reading session', async () => {
    const itemWithPdf = createLibraryItemWithPdf()
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [itemWithPdf] } : { entries: [] })
    )
    useProjectStore.setState({ projects: [], isLoaded: true })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview paper.pdf' }))
    fireEvent.click(
      within(screen.getByTestId('literature-pdf-preview')).getByRole('button', {
        name: 'Read with agent',
        hidden: true
      })
    )

    expect(await screen.findByRole('heading', { name: 'No projects yet' })).not.toBeNull()
    expect(
      screen.getByText('Create a project to keep this paper and its Reading session together.')
    ).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'Reading project' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() =>
      expect(createProjectApi).toHaveBeenCalledWith({
        name: 'Reading project',
        description: '',
        agentContext: ''
      })
    )
    await waitFor(() =>
      expect(filterPdfContextCandidates).toHaveBeenCalledWith({
        projectId: 'reading-project',
        sources: [
          {
            sourceKind: 'literature-attachment-version',
            sourceVersionId: 'version-1'
          }
        ]
      })
    )
    expect(startPdfReadingConversation).toHaveBeenCalledWith(
      'reading-project',
      expect.objectContaining({ path: 'literature-attachment-version:version-1' }),
      {
        sourceKind: 'literature-attachment-version',
        sourceVersionId: 'version-1'
      }
    )
  })

  it('starts Reading directly in the current Project view', async () => {
    const itemWithPdf = { ...createLibraryItemWithPdf(), projectIds: ['project-1'] }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [itemWithPdf] } : { entries: [] })
    )
    useNavigationStore.setState({ pendingLiteratureProjectId: 'project-1' })

    render(<LiteratureLibraryPage />)
    await screen.findByRole('heading', { name: 'Retrieval research' })
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    fireEvent.click(screen.getByRole('button', { name: 'Preview paper.pdf' }))
    fireEvent.click(
      within(screen.getByTestId('literature-pdf-preview')).getByRole('button', {
        name: 'Read with agent',
        hidden: true
      })
    )

    expect(screen.queryByRole('heading', { name: 'Read with agent' })).toBeNull()
    await waitFor(() =>
      expect(filterPdfContextCandidates).toHaveBeenCalledWith({
        projectId: 'project-1',
        sources: [
          {
            sourceKind: 'literature-attachment-version',
            sourceVersionId: 'version-1'
          }
        ]
      })
    )
    expect(startPdfReadingConversation).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ path: 'literature-attachment-version:version-1' }),
      {
        sourceKind: 'literature-attachment-version',
        sourceVersionId: 'version-1'
      }
    )
  })

  it('previews and copies a formatted reference from the Literature detail', async () => {
    citationStyles.mockResolvedValueOnce({
      styles: [
        { id: 'apa', title: 'APA Style 7th edition', source: 'built-in' },
        { id: 'mla', title: 'MLA Handbook 9th edition', source: 'built-in' },
        {
          id: 'chicago-author-date',
          title: 'Chicago Manual of Style 18th edition (author-date)',
          source: 'built-in'
        },
        {
          id: 'vancouver',
          title: 'Elsevier - NLM/Vancouver (citation-sequence)',
          source: 'built-in'
        },
        { id: 'ieee', title: 'IEEE Reference Guide version 11.29.2023', source: 'built-in' },
        { id: 'nature', title: 'Nature', source: 'built-in' },
        {
          id: 'american-medical-association',
          title: 'AMA Manual of Style 11th edition',
          source: 'built-in'
        },
        {
          id: 'harvard-cite-them-right',
          title: 'Cite Them Right 12th edition (author-date/Harvard)',
          source: 'built-in'
        }
      ]
    })
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    await openMenu(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Citation' }))

    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Citation' })).not.toBeNull()
    await waitFor(() =>
      expect(formatReferences).toHaveBeenCalledWith({
        itemIds: [libraryItem.id],
        styleId: 'apa',
        locale: 'en-US'
      })
    )
    const styleSelect = screen.getByRole('combobox', { name: 'Citation style' })
    await waitFor(() => expect(styleSelect.textContent).toContain('APA Style 7th edition'))
    expect(screen.getByTestId('citation-preview').className).toContain('min-h-48')
    expect(await screen.findByText('(Yan, 2024)')).not.toBeNull()
    expect(
      screen.getByText('Yan, S.-Q. (2024). Corrective Retrieval Augmented Generation.')
    ).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Copy reference' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'Yan, S.-Q. (2024). Corrective Retrieval Augmented Generation.'
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Copy BibTeX' }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        '@article{item-1, title = {Corrective Retrieval Augmented Generation}}'
      )
    )

    filePreviewRenderCount.value = 0
    fireEvent.click(styleSelect)
    const styleList = await screen.findByRole('listbox')
    expect(
      within(styleList).getByRole('option', {
        name: 'Chicago Manual of Style 18th edition (author-date)'
      })
    ).not.toBeNull()
    expect(within(styleList).getByRole('option', { name: 'Nature' })).not.toBeNull()
    expect(within(styleList).getAllByRole('option', { name: /Vancouver/ })).toHaveLength(1)
    fireEvent.click(await screen.findByRole('option', { name: 'MLA Handbook 9th edition' }))
    await waitFor(() =>
      expect(formatReferences).toHaveBeenCalledWith({
        itemIds: [libraryItem.id],
        styleId: 'mla',
        locale: 'en-US'
      })
    )
    expect(filePreviewRenderCount.value).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(
      screen.getByRole('heading', { name: 'Corrective Retrieval Augmented Generation' })
    ).not.toBeNull()
  })

  it('keeps the Citation view open when the style selector is toggled twice quickly', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    await openMenu(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Citation' }))

    const detailDialog = screen.getByRole('dialog')
    const detailOverlay = detailDialog.previousElementSibling as HTMLElement
    fireEvent.click(within(detailDialog).getByRole('combobox', { name: 'Citation style' }))
    fireEvent.click(screen.getByRole('option', { name: 'APA' }))
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())

    fireEvent.pointerDown(detailOverlay, { button: 0, ctrlKey: false })
    fireEvent.click(detailOverlay)

    expect(screen.getAllByRole('dialog')).toEqual([detailDialog])
    expect(within(detailDialog).getByRole('heading', { name: 'Citation' })).not.toBeNull()
  })

  it('opens the Citation styles manager from Library Settings', async () => {
    citationStyles.mockResolvedValueOnce({
      styles: [
        { id: 'apa', title: 'APA Style 7th edition', source: 'built-in' },
        {
          id: 'custom:preview',
          title: 'Imported journal style',
          source: 'custom',
          preview: {
            inText: '(Rivera and Chen 2024)',
            reference: 'Rivera, Alex, and Wei Chen. 2024. Genome Editing in Human Cells.'
          }
        }
      ]
    })
    citationStyles.mockResolvedValueOnce({
      styles: [],
      preview: {
        styleId: 'apa',
        inText: '(Rivera & Chen, 2024)',
        reference:
          'Rivera, A., & Chen, W. (2024). Genome Editing in Human Cells. Nature, 1(2), 10–20.'
      }
    })
    render(<LiteratureLibraryPage />)

    const settingsButton = screen.getByRole('button', { name: 'Settings' })
    const newCollectionButton = screen.getByRole('button', { name: 'New collection' })
    expect(settingsButton.closest('aside')).not.toBeNull()
    expect(
      newCollectionButton.compareDocumentPosition(settingsButton) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    fireEvent.click(settingsButton)

    expect(await screen.findByRole('heading', { name: 'Citation styles' })).not.toBeNull()
    expect(citationStyles).toHaveBeenCalledWith({ kind: 'list' })
    expect(screen.getByText('Built-in styles')).not.toBeNull()
    const apaStyle = screen.getByText('APA Style 7th edition').closest('li')
    expect(apaStyle).not.toBeNull()
    expect(within(apaStyle as HTMLElement).queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(screen.queryByText('(Rivera & Chen, 2024)')).toBeNull()
    const apaPreviewTrigger = screen.getByLabelText('Preview: APA Style 7th edition')
    fireEvent.pointerEnter(apaPreviewTrigger, { pointerType: 'mouse' })
    fireEvent.pointerMove(apaPreviewTrigger, { pointerType: 'mouse' })
    const preview = await screen.findByRole('dialog', { name: 'Preview: APA Style 7th edition' })
    expect(within(preview).getByText('In-text citation')).not.toBeNull()
    expect(within(preview).getByText('(Rivera & Chen, 2024)')).not.toBeNull()
    expect(within(preview).getByText('Reference')).not.toBeNull()
    expect(within(preview).getByText(/Genome Editing in Human Cells/)).not.toBeNull()
    expect(screen.getByRole('link', { name: 'Browse styles' }).getAttribute('href')).toBe(
      'https://www.zotero.org/styles'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to references' }))
    expect(screen.getByRole('heading', { name: 'Inbox' })).not.toBeNull()
  })

  it.each([
    { id: 'custom:preview', title: 'Imported journal style', source: 'custom' as const },
    { id: 'vancouver', title: 'Vancouver', source: 'built-in' as const }
  ])('shows styles before generating the $source CSL preview on hover', async (style) => {
    const styles = [style]
    let resolvePreview!: (value: {
      styles: typeof styles
      preview: { styleId: string; inText: string; reference: string }
    }) => void
    citationStyles.mockImplementation((request: { kind: string }) =>
      request.kind === 'list'
        ? Promise.resolve({ styles })
        : new Promise((resolve) => {
            resolvePreview = resolve
          })
    )
    render(<LiteratureLibraryPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByRole('heading', { name: 'Citation styles' })).not.toBeNull()
    expect(await screen.findByText(style.title)).not.toBeNull()
    expect(citationStyles).toHaveBeenCalledTimes(1)

    const customPreviewTrigger = screen.getByLabelText(`Preview: ${style.title}`)
    expect(screen.queryByText('(Rivera and Chen 2024)')).toBeNull()
    fireEvent.pointerEnter(customPreviewTrigger, { pointerType: 'mouse' })
    fireEvent.pointerMove(customPreviewTrigger, { pointerType: 'mouse' })

    await waitFor(() =>
      expect(citationStyles).toHaveBeenLastCalledWith({
        kind: 'preview',
        styleId: style.id
      })
    )
    expect((await screen.findAllByText('Loading preview…')).length).toBeGreaterThan(0)
    await act(async () =>
      resolvePreview({
        styles,
        preview: {
          styleId: style.id,
          inText: '(Rivera and Chen 2024)',
          reference: 'Rivera, Alex, and Wei Chen. 2024. Genome Editing in Human Cells.'
        }
      })
    )

    expect((await screen.findAllByText('(Rivera and Chen 2024)')).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Rivera, Alex, and Wei Chen/).length).toBeGreaterThan(0)
  })

  it('adds a Library reference to an active Project from its detail', async () => {
    let resolveProjectLink: (() => void) | undefined
    transact.mockImplementationOnce(
      () => new Promise((resolve) => (resolveProjectLink = () => resolve({ kind: 'item' })))
    )
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const project = screen.getByRole('checkbox', { name: 'Retrieval research' })
    expect(screen.queryByLabelText('Search projects')).toBeNull()
    expect(project.getAttribute('aria-checked')).toBe('false')
    filePreviewRenderCount.value = 0
    fireEvent.click(project)

    expect(project.getAttribute('aria-checked')).toBe('true')
    expect(project.getAttribute('aria-busy')).toBe('true')
    expect(filePreviewRenderCount.value).toBe(0)
    expect(project.className).not.toContain('disabled:opacity-50')

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'set-project-item',
        projectId: 'project-1',
        itemId: 'item-1',
        included: true,
        source: 'library'
      })
    )
    await act(async () => resolveProjectLink?.())
    await waitFor(() => expect(project.getAttribute('aria-busy')).toBe('false'))
  })

  it('rolls back an optimistic Project link when persistence fails', async () => {
    transact.mockRejectedValueOnce(new Error('database is locked'))
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const project = screen.getByRole('checkbox', { name: 'Retrieval research' })
    fireEvent.click(project)

    expect(project.getAttribute('aria-checked')).toBe('true')
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Project link could not be updated.'
    )
    await waitFor(() => expect(project.getAttribute('aria-checked')).toBe('false'))
  })

  it('removes an unlinked reference from the active Project view', async () => {
    const projectItem = { ...libraryItem, projectIds: ['project-1'] }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [projectItem] } : { entries: [] })
    )
    useNavigationStore.setState({ pendingLiteratureProjectId: 'project-1' })

    render(<LiteratureLibraryPage />)
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const project = screen.getByRole('checkbox', { name: 'Retrieval research' })
    expect(project.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(project)

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'set-project-item',
        projectId: 'project-1',
        itemId: 'item-1',
        included: false,
        source: 'library'
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('searches a long Project list and keeps long names inside the Project column', async () => {
    const longProjectName = `P5 ${'5'.repeat(48)}`
    useProjectStore.setState({
      projects: Array.from({ length: 6 }, (_, index) => ({
        id: `project-${index + 1}`,
        name: index === 4 ? longProjectName : `P${index + 1}`,
        description: '',
        isExample: false,
        createdAt: index + 1,
        updatedAt: index + 1
      })),
      isLoaded: true
    })
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const detailDialog = screen.getByRole('dialog')
    const projectSearch = screen.getByLabelText('Search projects')
    const longProjectLabel = within(detailDialog).getByText(longProjectName)
    expect(longProjectLabel.className).toContain('truncate')
    expect(longProjectLabel.parentElement?.className).toContain('min-w-0')
    filePreviewRenderCount.value = 0
    fireEvent.change(projectSearch, { target: { value: 'P4' } })

    expect(screen.getByRole('checkbox', { name: 'P4' })).not.toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'P1' })).toBeNull()

    fireEvent.change(projectSearch, { target: { value: 'missing project' } })
    expect(screen.getByText('No matching projects')).not.toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)
  })

  it('organizes a Library reference in an existing collection', async () => {
    let resolveCollectionLink: (() => void) | undefined
    transact.mockImplementationOnce(
      () => new Promise((resolve) => (resolveCollectionLink = () => resolve({ kind: 'item' })))
    )
    search.mockImplementation((request: { scope: string }) => {
      if (request.scope === 'collections') {
        return Promise.resolve({
          entries: [
            {
              id: 'collection-1',
              name: 'Retrieval methods',
              itemCount: 0,
              createdAt: 1,
              updatedAt: 1
            },
            ...Array.from({ length: 5 }, (_, index) => ({
              id: `collection-${index + 2}`,
              name: `Collection ${index + 2}`,
              itemCount: 0,
              createdAt: index + 2,
              updatedAt: index + 2
            }))
          ]
        })
      }
      return Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : inboxPage)
    })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const collectionSearch = await screen.findByLabelText('Search collections')
    filePreviewRenderCount.value = 0
    fireEvent.change(collectionSearch, { target: { value: 'Retrieval' } })

    const collection = screen.getByRole('checkbox', { name: 'Retrieval methods' })
    expect(screen.queryByRole('checkbox', { name: 'Collection 2' })).toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)
    expect(collection.className).toContain('w-full')
    expect(collection.className).toContain('hover:bg-muted')
    expect(collection.getAttribute('aria-checked')).toBe('false')
    filePreviewRenderCount.value = 0
    fireEvent.click(collection)

    expect(collection.getAttribute('aria-checked')).toBe('true')
    expect(collection.getAttribute('aria-busy')).toBe('true')
    expect(filePreviewRenderCount.value).toBe(0)
    expect(collection.className).not.toContain('disabled:opacity-50')

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'set-collection-item',
        collectionId: 'collection-1',
        itemId: libraryItem.id,
        included: true
      })
    )
    await act(async () => resolveCollectionLink?.())
    await waitFor(() => expect(collection.getAttribute('aria-busy')).toBe('false'))
  })

  it('rolls back an optimistic Collection link when persistence fails', async () => {
    transact.mockRejectedValueOnce(new Error('database is locked'))
    search.mockImplementation((request: { scope: string }) => {
      if (request.scope === 'collections') {
        return Promise.resolve({
          entries: [
            {
              id: 'collection-1',
              name: 'Retrieval methods',
              itemCount: 0,
              createdAt: 1,
              updatedAt: 1
            }
          ]
        })
      }
      return Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : inboxPage)
    })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const collection = await screen.findByRole('checkbox', { name: 'Retrieval methods' })
    fireEvent.click(collection)

    expect(collection.getAttribute('aria-checked')).toBe('true')
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Collection link could not be updated.'
    )
    await waitFor(() => expect(collection.getAttribute('aria-checked')).toBe('false'))
  })

  it('keeps the detail Tag menu open after an assignment snapshot refresh', async () => {
    const tagsApi = window.api.tags as unknown as {
      snapshot: ReturnType<typeof vi.fn>
      setAssignment: ReturnType<typeof vi.fn>
      onChanged: ReturnType<typeof vi.fn>
    }
    let emitChanged: ((event: { revision: number }) => void) | undefined
    const assignedSnapshot = {
      revision: 2,
      tags: [
        {
          id: 'tag-favorite',
          systemKey: 'favorite' as const,
          createdAt: 1,
          updatedAt: 2
        }
      ],
      assignments: []
    }
    tagsApi.setAssignment.mockResolvedValue(assignedSnapshot)
    tagsApi.snapshot.mockResolvedValue(assignedSnapshot)
    tagsApi.onChanged.mockImplementation((listener: (event: { revision: number }) => void) => {
      emitChanged = listener
      return () => undefined
    })
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const detailDialog = screen.getByRole('dialog')
    await openMenu(within(detailDialog).getByRole('button', { name: 'Manage Tags' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Favorites' }))
    await waitFor(() => expect(tagsApi.setAssignment).toHaveBeenCalledOnce())
    await act(async () => {
      emitChanged?.({ revision: 3 })
      await Promise.resolve()
    })

    expect(screen.getByText('Add or remove Tags')).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Favorites' })).not.toBeNull()

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Add or remove Tags')).toBeNull())
  })

  it('keeps the reference detail open when the Tag menu trigger is toggled', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const detail = screen.getByRole('dialog')
    const trigger = within(detail).getByRole('button', { name: 'Manage Tags' })
    expect(trigger.style.pointerEvents).toBe('auto')
    filePreviewRenderCount.value = 0
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).not.toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(trigger)

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(screen.getByRole('dialog')).toBe(detail)
  })

  it('keeps the reference detail open when a portaled child requests a delayed dismiss', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const detail = screen.getByRole('dialog')
    const trigger = within(detail).getByRole('button', { name: 'Manage Tags' })
    await openMenu(trigger)
    expect(screen.getByRole('menu')).not.toBeNull()

    fireEvent.keyDown(trigger, { key: 'Enter' })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10))
    })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog')).toBe(detail)
  })

  it('updates citation metadata from the Literature detail', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )
    const updatedItem: LiteratureItemView = {
      ...libraryItem,
      metadataRevision: 2,
      item: {
        ...libraryItem.item,
        title: 'Corrective RAG',
        creators: [
          {
            nameMode: 'person',
            givenName: 'Shiqi',
            familyName: 'Yan',
            creatorType: 'author'
          }
        ]
      }
    }
    get.mockResolvedValue(updatedItem)

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    const detailDialog = screen.getByRole('dialog')
    expect(detailDialog.className).toContain('h-[min(840px,calc(100vh-2rem))]')
    await openMenu(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit metadata' }))

    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog')).toBe(detailDialog)
    expect(screen.getByRole('heading', { name: 'Edit metadata' })).not.toBeNull()

    const identifierValue = screen.getByRole('textbox', { name: 'DOI' })
    const identifierType = within(identifierValue.parentElement!).getByRole('combobox', {
      name: 'Type'
    })
    expect(identifierType.className).toContain('h-8')
    expect(identifierValue.className).toContain('h-8')

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Corrective RAG' } })
    fireEvent.change(screen.getByLabelText('Given name'), { target: { value: 'Shiqi' } })
    fireEvent.click(screen.getByText('Advanced settings'))
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('Issue'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Pages'), { target: { value: '44–58' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'update-item',
        itemId: libraryItem.id,
        expectedMetadataRevision: 1,
        item: expect.objectContaining({
          title: 'Corrective RAG',
          creators: [
            expect.objectContaining({
              givenName: 'Shiqi',
              familyName: 'Yan',
              creatorType: 'author'
            })
          ],
          typeFields: expect.objectContaining({ volume: '12', issue: '3', pages: '44–58' })
        })
      })
    )
    await waitFor(() => expect(get).toHaveBeenCalledWith(libraryItem.id))
    expect(await screen.findByRole('heading', { name: 'Corrective RAG' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('presents reference details in a compact reading-first hierarchy', async () => {
    const sparseItem: LiteratureItemView = {
      ...libraryItem,
      item: {
        ...libraryItem.item,
        creators: [],
        issuedYear: undefined,
        containerTitle: '',
        typeFields: { publisher: 'Open Research Press' }
      }
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [sparseItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByText('Unknown')).toBeNull()
    expect(
      within(dialog)
        .getAllByText('Journal article')
        .filter((element) => !element.className.includes('sr-only'))
    ).toHaveLength(2)
    expect(within(dialog).getByText('Open Research Press')).not.toBeNull()

    const headings = within(dialog)
      .getAllByRole('heading')
      .map((heading) => heading.textContent)
    expect(headings.indexOf('Abstract')).toBeLessThan(headings.indexOf('Publication metadata'))
  })

  it('orders a reference detail as publication, title, full authors, abstract, then metadata', async () => {
    const richItem: LiteratureItemView = {
      ...libraryItem,
      item: {
        ...libraryItem.item,
        itemType: 'review',
        issuedText: '2024 Jan',
        shortTitle: 'J Retrieval',
        typeFields: { volume: '12', issue: '3', pages: '44-58' },
        creators: [
          ...libraryItem.item.creators,
          {
            nameMode: 'person',
            givenName: 'Jia-Chen',
            familyName: 'Gu',
            creatorType: 'author'
          },
          {
            nameMode: 'person',
            givenName: 'Yun',
            familyName: 'Zhu',
            creatorType: 'author'
          },
          {
            nameMode: 'person',
            givenName: 'Zhen-Hua',
            familyName: 'Ling',
            creatorType: 'author'
          }
        ]
      }
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [richItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const dialog = screen.getByRole('dialog')
    const publication = within(dialog).getByText(
      'J Retrieval. 2024 Jan;12(3):44-58. doi: 10.0000/example'
    )
    const title = within(dialog).getByRole('heading', {
      name: 'Corrective Retrieval Augmented Generation'
    })
    const authors = within(dialog)
      .getAllByText('Shi-Qi Yan, Jia-Chen Gu, Yun Zhu, Zhen-Hua Ling')
      .find((element) => !element.className.includes('sr-only'))!
    const abstract = within(dialog).getByRole('heading', { name: 'Abstract' })
    const metadata = within(dialog).getByRole('heading', { name: 'Publication metadata' })

    expect(
      publication.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(title.compareDocumentPosition(authors) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      authors.compareDocumentPosition(abstract) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      abstract.compareDocumentPosition(metadata) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(title.className).toContain('line-clamp-3')
    expect(authors.className).not.toContain('truncate')
    expect(authors.className).toContain('line-clamp-5')
    expect(authors.closest('section')?.parentElement?.className).toContain('overflow-y-auto')
    expect(within(dialog).getAllByText('Review')).toHaveLength(2)
  })

  it('collapses an overflowing author list until the reader expands it', async () => {
    const creators = Array.from({ length: 20 }, (_, index) => ({
      nameMode: 'person' as const,
      givenName: `Author ${index + 1}`,
      familyName: 'Researcher',
      creatorType: 'author'
    }))
    const longItem: LiteratureItemView = {
      ...libraryItem,
      item: { ...libraryItem.item, abstract: '', creators }
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [longItem] } : { entries: [] })
    )
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(240)
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120)

    try {
      render(<LiteratureLibraryPage />)
      fireEvent.click(screen.getByRole('button', { name: 'All references' }))
      await openReferenceDetail(
        await screen.findByRole('button', { name: 'Corrective Retrieval Augmented Generation' })
      )

      const authorsSection = within(screen.getByRole('dialog'))
        .getByRole('heading', { name: 'Authors' })
        .closest('section')!
      const authors = authorsSection.querySelector('p')!
      expect(authors.className).toContain('line-clamp-5')
      fireEvent.click(within(authorsSection).getByRole('button', { name: 'Show more' }))
      expect(authors.className).not.toContain('line-clamp-5')
      expect(within(authorsSection).getByRole('button', { name: 'Show less' })).not.toBeNull()
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
    }
  })

  it('collapses an overflowing abstract until the reader expands it', async () => {
    const longAbstract = Array.from(
      { length: 12 },
      (_, index) => `Abstract line ${index + 1}`
    ).join('\n')
    const longItem: LiteratureItemView = {
      ...libraryItem,
      item: { ...libraryItem.item, abstract: longAbstract }
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [longItem] } : { entries: [] })
    )
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(288)
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(192)

    try {
      render(<LiteratureLibraryPage />)
      fireEvent.click(screen.getByRole('button', { name: 'All references' }))
      await openReferenceDetail(
        await screen.findByRole('button', { name: 'Corrective Retrieval Augmented Generation' })
      )

      const dialog = within(screen.getByRole('dialog'))
      const abstract = dialog.getByText(
        (_content, element) => element?.tagName === 'P' && element.textContent === longAbstract
      )
      const abstractSection = abstract.closest('section')!
      expect(abstract.className).toContain('line-clamp-8')
      const showMore = within(abstractSection).getByRole('button', { name: 'Show more' })
      expect(showMore.className).toContain('hover:bg-primary/10')
      expect(showMore.className).toContain('px-2')
      fireEvent.click(showMore)
      expect(abstract.className).not.toContain('line-clamp-8')
      expect(within(abstractSection).getByRole('button', { name: 'Show less' })).not.toBeNull()
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
    }
  })

  it('shows metadata URLs as icon-only external links when enabled', async () => {
    window.localStorage.setItem(
      'open-science:literature-table-preferences',
      JSON.stringify({ visible: ['url'] })
    )
    const linkedItem: LiteratureItemView = {
      ...libraryItem,
      item: {
        ...libraryItem.item,
        url: 'https://pubmed.ncbi.nlm.nih.gov/39125710/'
      }
    }
    const unsafeItem: LiteratureItemView = {
      ...libraryItem,
      id: 'item-unsafe-url',
      item: {
        ...libraryItem.item,
        title: 'Unsafe URL reference',
        url: 'javascript:alert(1)'
      }
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'library' ? { entries: [linkedItem, unsafeItem] } : { entries: [] }
      )
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await screen.findByText('Corrective Retrieval Augmented Generation')

    expect(screen.getByRole('columnheader', { name: 'URL' })).not.toBeNull()
    const link = screen.getByRole('link', {
      name: 'URL: https://pubmed.ncbi.nlm.nih.gov/39125710/'
    })
    expect(within(link).getByText('https://pubmed.ncbi.nlm.nih.gov/39125710/').className).toContain(
      'sr-only'
    )
    expect(link.getAttribute('href')).toBe('https://pubmed.ncbi.nlm.nih.gov/39125710/')
    expect(link.getAttribute('target')).toBe('_blank')
    const unsafeRow = screen.getByRole('button', { name: 'Unsafe URL reference' }).closest('tr')
    expect(unsafeRow).not.toBeNull()
    expect(within(unsafeRow!).queryByRole('link')).toBeNull()
  })

  it('links DOI, PMID, and PMCID identifiers from reference details', async () => {
    const linkedItem: LiteratureItemView = {
      ...libraryItem,
      item: {
        ...libraryItem.item,
        identifiers: [
          { scheme: 'doi', value: '10.1234/exampleCopyright', isPrimary: true },
          { scheme: 'pmid', value: '32877581', isPrimary: false },
          { scheme: 'pmcid', value: 'PMC7610567', isPrimary: false }
        ]
      }
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [linkedItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const detail = await openReferenceDetail(
      await screen.findByRole('button', { name: 'Corrective Retrieval Augmented Generation' })
    )

    expect(within(detail).getByRole('link', { name: 'DOI: 10.1234/example' })).toHaveProperty(
      'href',
      'https://doi.org/10.1234/example'
    )
    expect(within(detail).getByRole('link', { name: 'PMID: 32877581' })).toHaveProperty(
      'href',
      'https://pubmed.ncbi.nlm.nih.gov/32877581/'
    )
    expect(within(detail).getByRole('link', { name: 'PMCID: PMC7610567' })).toHaveProperty(
      'href',
      'https://pmc.ncbi.nlm.nih.gov/articles/PMC7610567/'
    )
  })

  it('finds a full-text PDF and attaches it only after the source is confirmed', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )
    fullText.mockResolvedValueOnce({
      mode: 'search',
      notices: [],
      candidates: [
        {
          id: 'candidate-1',
          provider: 'openalex',
          source: 'Example repository',
          url: 'https://journal.example/paper.pdf',
          sourceUrl: 'https://journal.example/articles/paper',
          version: 'accepted',
          license: 'cc-by'
        }
      ]
    })
    fullText.mockResolvedValueOnce({ mode: 'attach', item: libraryItem })
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    const detail = screen.getByRole('dialog')
    fireEvent.click(within(detail).getByRole('button', { name: 'Find full-text PDF' }))
    await within(detail).findByText('Example repository')
    expect(fullText).toHaveBeenCalledTimes(1)
    expect(fullText).toHaveBeenCalledWith({ mode: 'search', itemId: libraryItem.id })
    expect(within(detail).getByText(/Accepted manuscript/)).not.toBeNull()
    expect(within(detail).getByRole('link', { name: 'Open source' })).toHaveProperty(
      'href',
      'https://journal.example/articles/paper'
    )
    fireEvent.click(within(detail).getByRole('button', { name: 'Add attachment' }))
    await waitFor(() =>
      expect(fullText).toHaveBeenCalledWith({
        mode: 'attach',
        itemId: libraryItem.id,
        candidateId: 'candidate-1'
      })
    )
    await within(detail).findByRole('heading', { name: libraryItem.item.title })
  })

  it('offers metadata completion when full-text search has no identifiers', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )
    fullText.mockResolvedValueOnce({
      mode: 'search',
      notices: ['missing-identifiers'],
      candidates: []
    })
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    const detail = screen.getByRole('dialog')
    await openMenu(within(detail).getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Find full-text PDF' }))
    fireEvent.click(await within(detail).findByRole('button', { name: 'Complete metadata' }))
    expect(within(detail).getByRole('heading', { name: 'Complete metadata' })).not.toBeNull()
    expect(within(detail).queryByRole('button', { name: 'Add attachment' })).toBeNull()
  })

  it('opens OpenAlex configuration inside the existing full-text dialog', async () => {
    search.mockImplementation(async (request: { scope: string }) =>
      request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] }
    )
    fullText.mockResolvedValueOnce({
      mode: 'search',
      candidates: [],
      notices: ['openalex-not-configured']
    })
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Find full-text PDF' })
    )
    fireEvent.click(await screen.findByText('Search sources'))
    fireEvent.click(await screen.findByRole('button', { name: 'Configure OpenAlex' }))
    expect(within(screen.getByRole('dialog')).getByLabelText('OpenAlex API key')).not.toBeNull()
    expect(useSettingsStore.getState().pendingSettingsIntent).toBeUndefined()
  })

  it('keeps the full-text candidate available after a failed download', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )
    fullText.mockResolvedValueOnce({
      mode: 'search',
      notices: ['openalex-unavailable'],
      candidates: [
        {
          id: 'candidate-1',
          provider: 'europe-pmc',
          source: 'Europe PMC',
          url: 'https://journal.example/paper.pdf'
        }
      ]
    })
    fullText.mockRejectedValueOnce(new Error('Not a PDF'))
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    const detail = screen.getByRole('dialog')
    fireEvent.click(within(detail).getByRole('button', { name: 'Find full-text PDF' }))
    fireEvent.click(await within(detail).findByRole('button', { name: 'Add attachment' }))
    await within(detail).findByRole('alert')
    expect(within(detail).getByRole('button', { name: 'Add attachment' })).toHaveProperty(
      'disabled',
      false
    )
    expect(within(detail).getByRole('button', { name: 'Add PDF' })).not.toBeNull()
    expect(
      within(detail).getByText('OpenAlex is unavailable. Results may be incomplete.')
    ).not.toBeNull()
  })

  it('shows identifier-only additions and submits one publication-date conflict choice', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )
    completeMetadata.mockResolvedValue({
      mode: 'preview',
      provider: 'crossref',
      reviewVersion: 1,
      reviewToken: '9323d39a-2ae2-49c8-8826-a589c78f1f5d',
      sourceUrl: 'https://api.crossref.org/works/10.0000/example',
      item: libraryItem,
      filled: [{ field: 'identifiers', value: 'DOI: 10.0000/example ★; PMID: 12345678' }],
      conflicts: [{ field: 'publicationDate', currentValue: '2020', value: '2021-02-03' }]
    })
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    const detail = screen.getByRole('dialog')
    await openMenu(within(detail).getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Complete metadata' }))
    fireEvent.click(within(detail).getByRole('button', { name: 'Search' }))
    expect(await screen.findByText('Identifiers (★ primary)')).toBeTruthy()
    expect(screen.getByText('DOI: 10.0000/example ★; PMID: 12345678')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apply metadata' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Use Crossref' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Use Crossref' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply metadata' }))
    await waitFor(() =>
      expect(completeMetadata).toHaveBeenLastCalledWith(
        expect.objectContaining({
          mode: 'commit',
          overwriteFields: ['publicationDate']
        })
      )
    )
  })

  it('previews and applies missing publication metadata from Crossref', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    const detail = screen.getByRole('dialog')
    expect(within(detail).queryByRole('button', { name: 'Search' })).toBeNull()
    await openMenu(within(detail).getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Complete metadata' }))

    expect(within(detail).getByRole('heading', { name: 'Complete metadata' })).not.toBeNull()
    filePreviewRenderCount.value = 0
    fireEvent.change(within(detail).getByRole('textbox', { name: 'DOI' }), {
      target: { value: 'doi:10.1234/exampleCopy' }
    })
    fireEvent.change(within(detail).getByRole('textbox', { name: 'DOI' }), {
      target: { value: 'doi:10.1234/exampleCopyright' }
    })
    expect(filePreviewRenderCount.value).toBe(0)
    fireEvent.click(within(detail).getByRole('button', { name: 'Search' }))

    await waitFor(() =>
      expect(completeMetadata).toHaveBeenCalledWith({
        mode: 'preview',
        itemId: libraryItem.id,
        identifier: { scheme: 'doi', value: '10.1234/example' }
      })
    )
    expect(await screen.findByText('Journal of Retrieval')).not.toBeNull()
    expect(screen.getByText('Fields to add: 4')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Use Crossref' }))

    fireEvent.click(screen.getByRole('button', { name: 'Apply metadata' }))
    await waitFor(() =>
      expect(completeMetadata).toHaveBeenCalledWith({
        mode: 'commit',
        itemId: libraryItem.id,
        expectedMetadataRevision: 1,
        identifier: { scheme: 'doi', value: '10.1234/example' },
        overwriteFields: ['title']
      })
    )
    expect(await screen.findByText('Fields completed: 4')).not.toBeNull()
    fireEvent.click(within(detail).getByRole('button', { name: 'Back' }))
    expect(within(detail).getByText('Publication metadata')).not.toBeNull()
    expect(within(detail).queryByRole('button', { name: 'Search' })).toBeNull()
  })

  it('marks equivalent metadata as unchanged instead of offering a replacement', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )
    completeMetadata.mockResolvedValueOnce({
      mode: 'preview',
      provider: 'crossref',
      sourceUrl: 'https://api.crossref.org/works/10.0000%2Fexample',
      item: libraryItem,
      filled: [],
      conflicts: [
        {
          field: 'title',
          currentValue: 'Corrective Retrieval Augmented Generation',
          value: 'Corrective Retrieval Augmented Generation.'
        }
      ]
    })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))
    const detail = screen.getByRole('dialog')
    await openMenu(within(detail).getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Complete metadata' }))
    fireEvent.click(within(detail).getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('Unchanged')).not.toBeNull()
    expect(screen.getByText('Kept')).not.toBeNull()
    expect(screen.getByText('Crossref')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Use Crossref' })).toBeNull()
  })

  it('creates a manual reference directly in the Library', async () => {
    let total = 0
    search.mockImplementation(async (request: LiteratureCatalogSearchRequest) => ({
      entries: [],
      totalCount: request.scope === 'library' ? total : 0
    }))
    transact.mockImplementationOnce(async () => {
      total = 1
      return { kind: 'item', id: libraryItem.id, state: 'created' }
    })
    const createdItem: LiteratureItemView = {
      ...libraryItem,
      item: { ...libraryItem.item, title: 'Manual paper', creators: [], identifiers: [] }
    }
    get.mockResolvedValue(createdItem)

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const countButton = screen.getByRole('button', { name: 'All references' })
    await within(countButton).findByText('0')
    fireEvent.click(screen.getByRole('button', { name: 'Duplicates' }))
    fireEvent.click(countButton)
    fireEvent.change(screen.getByLabelText('Search references'), {
      target: { value: 'query' }
    })
    expect(
      search.mock.calls.filter(([request]) => request.scope === 'library' && request.limit === 1)
    ).toHaveLength(1)
    await openMenu(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add reference' }))

    expect(screen.getByLabelText('Reference type').textContent).toContain('Journal article')
    expect(screen.getByRole('dialog').querySelector('select')).toBeNull()
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Manual paper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'create-item',
        item: expect.objectContaining({
          itemType: 'journalArticle',
          title: 'Manual paper'
        })
      })
    )
    await waitFor(() => expect(get).toHaveBeenCalledWith(libraryItem.id))
    expect(await screen.findByRole('heading', { name: 'Manual paper' })).not.toBeNull()
    await within(countButton).findByText('1')
    expect(
      search.mock.calls.filter(([request]) => request.scope === 'library' && request.limit === 1)
    ).toHaveLength(2)
  })

  it('links a manually created reference to the current Project', async () => {
    const createdItem: LiteratureItemView = {
      ...libraryItem,
      projectIds: ['project-1'],
      item: { ...libraryItem.item, title: 'Project paper', creators: [], identifiers: [] }
    }
    get.mockResolvedValue(createdItem)
    useNavigationStore.setState({ pendingLiteratureProjectId: 'project-1' })

    render(<LiteratureLibraryPage />)
    await screen.findByRole('heading', { name: 'Retrieval research' })
    await openMenu(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add reference' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Project paper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'set-project-item',
        projectId: 'project-1',
        itemId: libraryItem.id,
        included: true,
        source: 'library'
      })
    )
  })

  it('links a manually created reference to the current Collection', async () => {
    const collection = {
      id: 'collection-1',
      name: 'Review set',
      description: '',
      itemCount: 0,
      createdAt: 1,
      updatedAt: 1
    }
    const createdItem: LiteratureItemView = {
      ...libraryItem,
      collectionIds: [collection.id],
      item: { ...libraryItem.item, title: 'Collection paper', creators: [], identifiers: [] }
    }
    get.mockResolvedValue(createdItem)
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'collections'
          ? { entries: [collection], totalCount: 1 }
          : request.scope === 'inbox'
            ? inboxPage
            : { entries: [] }
      )
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review set' }))
    await openMenu(screen.getByRole('button', { name: 'Add' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add reference' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Collection paper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'set-collection-item',
        collectionId: collection.id,
        itemId: libraryItem.id,
        included: true
      })
    )
  })

  it('groups creation actions and preserves customizable table columns', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))

    expect(await screen.findByText('Corrective Retrieval Augmented Generation')).not.toBeNull()
    const referenceRow = screen
      .getByRole('button', { name: 'Corrective Retrieval Augmented Generation' })
      .closest('tr')
    expect(referenceRow?.className).toContain('hover:bg-bg-200')
    expect(referenceRow?.className).toContain('bg-bg-000')
    expect(referenceRow?.className).not.toContain('transition-colors')
    const stickyRowCells = Array.from(referenceRow?.querySelectorAll('td.sticky') ?? [])
    expect(stickyRowCells).toHaveLength(2)
    for (const cell of stickyRowCells) {
      expect(cell.className).toContain('bg-inherit')
      expect(cell.className).not.toContain('group-hover:bg-bg-200')
    }
    expect(
      screen
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
        .filter(Boolean)
        .slice(0, 8)
    ).toEqual(['#', 'Title', 'Year', 'Publication', 'Authors', 'Type', 'Tags', 'Rating'])
    expect(document.querySelector('[data-row-number="1"]')?.textContent).toBe('1')
    expect(screen.queryByRole('columnheader', { name: 'Publisher' })).toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Rating' })).not.toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Notes' })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'URL' })).toBeNull()
    expect(screen.getByText('arXiv')).not.toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Abstract' })).toBeNull()
    expect(referenceRow?.querySelector('button span')?.className).toContain('line-clamp-2')
    expect(screen.getByText('Favorites')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Manage Tags' }).className).toContain('w-full')
    expect(screen.getByRole('columnheader', { name: 'Attachment' }).className).toContain('right-12')
    expect(screen.getByRole('columnheader', { name: 'Attachment' }).className).toContain(
      'shadow-card-opaque'
    )
    expect(screen.getByRole('columnheader', { name: 'Attachment' }).className).toContain(
      'bg-bg-200'
    )
    expect(screen.getByRole('columnheader', { name: 'Actions' }).className).toContain('sticky')
    expect(screen.getByRole('columnheader', { name: 'Actions' }).className).toContain('bg-bg-200')
    expect(screen.getByRole('columnheader', { name: 'Attachment' }).className).toContain('w-28')
    const tableScroll = document.querySelector<HTMLElement>('[data-slot="literature-table-scroll"]')
    expect(tableScroll?.className).toContain('pb-3')
    expect(tableScroll?.className).toContain('h-full')
    expect(tableScroll?.className).not.toContain('100vh')
    expect(tableScroll?.closest('section')?.className).toContain('overflow-hidden')
    expect(tableScroll?.closest('main')?.className).toContain('overflow-hidden')
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    const customizeTitle = await screen.findByText('Customize columns')
    expect(customizeTitle.parentElement?.parentElement?.className).toContain('bg-bg-000')
    expect(customizeTitle.parentElement?.parentElement?.className).toContain('text-foreground')
    expect(screen.getByText('Drag to reorder. Select columns to show.').className).toContain(
      'whitespace-nowrap'
    )
    for (const column of [
      'Abstract',
      'Year',
      'Publication',
      'Authors',
      'Type',
      'Tags',
      'Rating',
      'Notes',
      'URL'
    ]) {
      expect(screen.getByRole('checkbox', { name: column }).getAttribute('data-state')).toBe(
        ['Abstract', 'Notes', 'URL'].includes(column) ? 'unchecked' : 'checked'
      )
    }
    for (const column of ['Abstract', 'Notes', 'URL']) {
      fireEvent.click(screen.getByRole('checkbox', { name: column }))
    }
    fireEvent.keyDown(screen.getByRole('button', { name: 'Move Abstract' }), {
      key: 'ArrowDown'
    })
    expect(
      screen
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
        .filter(Boolean)
        .slice(0, 4)
    ).toEqual(['#', 'Title', 'Year', 'Abstract'])
    expect(screen.getByRole('columnheader', { name: 'Abstract' })).not.toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Rating' })).not.toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Notes' })).not.toBeNull()
    expect(screen.getByRole('columnheader', { name: 'Publication' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit metadata' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Import PDF' })).toBeNull()
    await openMenu(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('menuitem', { name: 'Add reference' })).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Import PDF' })).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Import references' })).not.toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Smart collection' })).toBeNull()
    expect(screen.getByText('Create metadata manually')).not.toBeNull()
    expect(screen.getByText('Create a reference from a PDF')).not.toBeNull()
    expect(screen.getByText('BibTeX, RIS, or PubMed NBIB')).not.toBeNull()
    expect(screen.queryByText('Only the first 1,000 references will be imported.')).toBeNull()
  })

  it('shows the insertion edge while dragging a table column', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await screen.findByText('Corrective Retrieval Augmented Generation')
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Abstract' }))
    const source = document.querySelector<HTMLElement>('[data-column="abstract"]')!
    const target = document.querySelector<HTMLElement>('[data-column="year"]')!
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 140,
      left: 0,
      right: 256,
      width: 256,
      height: 40,
      x: 0,
      y: 100,
      toJSON: () => undefined
    })
    const values = new Map<string, string>()
    const dataTransfer = {
      dropEffect: 'none',
      effectAllowed: 'none',
      getData: (type: string) => values.get(type) ?? '',
      setData: (type: string, value: string) => {
        values.set(type, value)
      }
    } as unknown as DataTransfer

    filePreviewRenderCount.value = 0
    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(target, { clientY: 139, dataTransfer })

    expect(source.className).toContain('ring-primary/30')
    expect(
      target
        .querySelector('[data-slot="literature-column-drop-indicator"]')
        ?.getAttribute('data-edge')
    ).toBe('after')
    expect(filePreviewRenderCount.value).toBe(0)

    fireEvent.drop(target, { dataTransfer })
    expect(
      screen
        .getAllByRole('columnheader')
        .map((header) => header.textContent)
        .filter(Boolean)
        .slice(0, 4)
    ).toEqual(['#', 'Title', 'Year', 'Abstract'])
    expect(document.querySelector('[data-slot="literature-column-drop-indicator"]')).toBeNull()
  })

  it('edits the reference type inline and opens the same details from title and Edit', async () => {
    let resolveType: (() => void) | undefined
    const updatedItem = {
      ...libraryItem,
      metadataRevision: 2,
      item: { ...libraryItem.item, itemType: 'preprint' as const }
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )
    transact.mockImplementationOnce(
      () => new Promise((resolve) => (resolveType = () => resolve({ kind: 'item' })))
    )
    get.mockResolvedValue(updatedItem)

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const referenceRow = (
      await screen.findByText('Corrective Retrieval Augmented Generation')
    ).closest('tr')!

    fireEvent.click(
      screen.getByRole('combobox', {
        name: 'Reference type: Corrective Retrieval Augmented Generation'
      })
    )
    filePreviewRenderCount.value = 0
    fireEvent.click(screen.getByRole('option', { name: 'Preprint' }))

    expect(
      screen.getByRole('combobox', {
        name: 'Reference type: Corrective Retrieval Augmented Generation'
      }).textContent
    ).toContain('Preprint')
    expect(filePreviewRenderCount.value).toBe(0)

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'update-item',
        itemId: libraryItem.id,
        expectedMetadataRevision: libraryItem.metadataRevision,
        item: { ...libraryItem.item, itemType: 'preprint' }
      })
    )
    await act(async () => {
      resolveType?.()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', {
          name: 'Reference type: Corrective Retrieval Augmented Generation'
        }).textContent
      ).toContain('Preprint')
    )

    await openMenu(within(referenceRow).getByRole('button', { name: 'More actions' }))
    expect(screen.getAllByRole('menuitem')[0]?.textContent).toContain('Edit')
    await openReferenceDetail(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'More actions' })
    ).not.toBeNull()
    expect(screen.queryByLabelText('Title')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Collections' })).not.toBeNull()
  })

  it('edits rating and notes directly in optional table columns', async () => {
    window.localStorage.setItem(
      'open-science:literature-table-preferences',
      JSON.stringify({ visible: ['rating', 'notes'] })
    )
    let resolveRating: (() => void) | undefined
    let resolveNote: (() => void) | undefined
    const ratedItem = {
      ...libraryItem,
      metadataRevision: 2,
      item: { ...libraryItem.item, rating: 4, personalNote: '' }
    }
    const notedItem = {
      ...ratedItem,
      metadataRevision: 3,
      item: { ...ratedItem.item, personalNote: 'Discuss in the next lab meeting.' }
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )
    transact
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveRating = () => resolve({ kind: 'item' })))
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveNote = () => resolve({ kind: 'item' })))
      )
    get.mockResolvedValueOnce(ratedItem).mockResolvedValueOnce(notedItem)

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await screen.findByText('Corrective Retrieval Augmented Generation')

    const ratingButton = screen.getByRole('button', { name: 'Set rating to 4' })
    filePreviewRenderCount.value = 0
    fireEvent.click(ratingButton)

    expect(ratingButton.querySelector('svg')?.getAttribute('class')).toContain('fill-amber-400')
    expect(filePreviewRenderCount.value).toBe(0)

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'update-item',
        itemId: libraryItem.id,
        expectedMetadataRevision: libraryItem.metadataRevision,
        item: { ...libraryItem.item, rating: 4 }
      })
    )
    await act(async () => {
      resolveRating?.()
      await Promise.resolve()
    })
    await waitFor(() => expect(get).toHaveBeenCalledWith(libraryItem.id))

    const noteInput = await screen.findByRole('textbox', {
      name: 'Note for Corrective Retrieval Augmented Generation'
    })
    filePreviewRenderCount.value = 0
    fireEvent.change(noteInput, { target: { value: 'Discuss in the next lab meeting.' } })
    fireEvent.blur(noteInput)

    expect((noteInput as HTMLInputElement).value).toBe('Discuss in the next lab meeting.')
    expect(filePreviewRenderCount.value).toBe(0)

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'update-item',
        itemId: libraryItem.id,
        expectedMetadataRevision: 2,
        item: {
          ...libraryItem.item,
          rating: 4,
          personalNote: 'Discuss in the next lab meeting.'
        }
      })
    )
    await act(async () => {
      resolveNote?.()
      await Promise.resolve()
    })
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2))

    const savedNoteInput = await screen.findByRole('textbox', {
      name: 'Note for Corrective Retrieval Augmented Generation'
    })
    fireEvent.change(savedNoteInput, { target: { value: 'Discard this draft.' } })
    fireEvent.keyDown(savedNoteInput, { key: 'Escape' })
    expect((savedNoteInput as HTMLInputElement).value).toBe('Discuss in the next lab meeting.')
    expect(transact).toHaveBeenCalledTimes(2)
  })

  it('rolls back an optimistic rating when saving fails', async () => {
    let rejectRating: ((error: Error) => void) | undefined
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )
    transact.mockImplementationOnce(
      () => new Promise((_, reject) => (rejectRating = (error) => reject(error)))
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await screen.findByText('Corrective Retrieval Augmented Generation')

    fireEvent.click(screen.getByRole('button', { name: 'Set rating to 3' }))
    expect(
      screen
        .getByRole('button', { name: 'Set rating to 3' })
        .querySelector('svg')
        ?.getAttribute('class')
    ).toContain('fill-amber-400')

    await act(async () => {
      rejectRating?.(new Error('save failed'))
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Set rating to 3' })
          .querySelector('svg')
          ?.getAttribute('class')
      ).not.toContain('fill-amber-400')
    )
    expect(await screen.findByText('Literature could not be updated.')).not.toBeNull()
  })

  it('looks up missing publication metadata by PMID', async () => {
    const itemWithoutIdentifiers = {
      ...libraryItem,
      item: { ...libraryItem.item, identifiers: [] }
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'library' ? { entries: [itemWithoutIdentifiers] } : { entries: [] }
      )
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const detail = screen.getByRole('dialog')
    await openMenu(within(detail).getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Complete metadata' }))
    fireEvent.click(within(detail).getByRole('combobox', { name: 'Type' }))
    fireEvent.click(screen.getByRole('option', { name: 'PMID' }))
    fireEvent.change(within(detail).getByRole('textbox', { name: 'PMID' }), {
      target: { value: '12345678' }
    })
    fireEvent.click(within(detail).getByRole('button', { name: 'Search' }))

    await waitFor(() =>
      expect(completeMetadata).toHaveBeenCalledWith({
        mode: 'preview',
        itemId: libraryItem.id,
        identifier: { scheme: 'pmid', value: '12345678' }
      })
    )
  })

  it('normalizes a stored DOI before requesting completed metadata', async () => {
    const itemWithJoinedSuffix: LiteratureItemView = {
      ...libraryItem,
      item: {
        ...libraryItem.item,
        identifiers: [{ scheme: 'doi', value: '10.1234/exampleCopyright', isPrimary: true }]
      }
    }
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'library' ? { entries: [itemWithJoinedSuffix] } : { entries: [] }
      )
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const detail = screen.getByRole('dialog')
    await openMenu(within(detail).getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Complete metadata' }))

    expect((within(detail).getByRole('textbox', { name: 'DOI' }) as HTMLInputElement).value).toBe(
      '10.1234/example'
    )
    fireEvent.click(within(detail).getByRole('button', { name: 'Search' }))
    await waitFor(() =>
      expect(completeMetadata).toHaveBeenCalledWith({
        mode: 'preview',
        itemId: libraryItem.id,
        identifier: { scheme: 'doi', value: '10.1234/example' }
      })
    )
  })

  it('keeps the reference detail open when the metadata identifier selector is dismissed', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await openReferenceDetail(await screen.findByText('Corrective Retrieval Augmented Generation'))

    const detail = screen.getByRole('dialog')
    await openMenu(within(detail).getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Complete metadata' }))
    const identifierType = within(detail).getByRole('combobox', { name: 'Type' })
    const identifierValue = within(detail).getByRole('textbox', { name: 'DOI' })
    const searchButton = within(detail).getByRole('button', { name: 'Search' })

    expect(identifierType.className).toContain('h-8')
    expect(identifierType.style.pointerEvents).toBe('auto')
    expect(identifierValue.className).toContain('h-8')
    expect(searchButton.className).toContain('h-8')

    filePreviewRenderCount.value = 0
    fireEvent.click(identifierType)
    const listbox = screen.getByRole('listbox')
    expect(listbox).not.toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)

    fireEvent.keyDown(listbox, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(screen.getByRole('dialog')).toBe(detail)
  })

  it('reviews metadata before importing a PDF as a Library reference', async () => {
    const staged = {
      id: 'upload-2',
      sessionId: '.pending',
      name: '2024_corrective-rag.pdf',
      originalName: '2024_corrective-rag.pdf',
      path: '/managed/import.pdf',
      mimeType: 'application/pdf',
      size: 8
    }
    const importedItem: LiteratureItemView = {
      ...libraryItem,
      item: { ...libraryItem.item, title: 'Corrective RAG' },
      attachments: [
        {
          id: 'attachment-2',
          kind: 'fullText',
          title: '',
          sortOrder: 0,
          versions: [
            {
              id: 'version-2',
              versionNumber: 1,
              filename: staged.name,
              contentType: 'application/pdf',
              sizeBytes: staged.size,
              checksum: 'b'.repeat(64),
              createdAt: 2
            }
          ],
          createdAt: 2,
          updatedAt: 2
        }
      ]
    }
    stageLocalFile.mockResolvedValue(staged)
    importPdf.mockResolvedValue({ item: importedItem })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const file = new File(['%PDF-1.7'], staged.name, { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Import PDF'), { target: { files: [file] } })

    expect(((await screen.findByLabelText('Title')) as HTMLInputElement).value).toBe(
      '2024 corrective rag'
    )
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Corrective RAG' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'create-item',
        item: expect.objectContaining({ title: 'Corrective RAG' })
      })
    )
    await waitFor(() =>
      expect(importPdf).toHaveBeenCalledWith({ itemId: libraryItem.id, attachment: staged })
    )
    expect(claimLocalFile).toHaveBeenCalledWith({ transferId: expect.any(String) })
    expect(await screen.findByRole('heading', { name: 'Corrective RAG' })).not.toBeNull()
    expect(await screen.findByText('8 B')).not.toBeNull()
  })

  it('opens immediately and prefills metadata extracted from an imported PDF', async () => {
    let resolveMetadata!: (item: LiteratureItemInput) => void
    extractLiteraturePdfDraft.mockReturnValueOnce(
      new Promise<LiteratureItemInput>((resolve) => {
        resolveMetadata = resolve
      })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const file = new File(['%PDF-1.7'], 'opaque-name.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Import PDF'), { target: { files: [file] } })

    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Reading…')

    await act(async () => {
      resolveMetadata({
        ...libraryItem.item,
        title: 'Mapping cancer origins',
        issuedYear: 2011,
        issuedText: '2011',
        containerTitle: 'Cell',
        creators: [
          {
            nameMode: 'person',
            givenName: '',
            familyName: 'Richard J Gilbertson',
            creatorType: 'author'
          }
        ],
        identifiers: [{ scheme: 'doi', value: '10.1234/extracted', isPrimary: true }]
      })
      await Promise.resolve()
    })

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
      'Mapping cancer origins'
    )
    expect((screen.getByLabelText('Year') as HTMLInputElement).value).toBe('2011')
    expect((screen.getByLabelText('Publication') as HTMLInputElement).value).toBe('Cell')
    expect((screen.getByLabelText('Family name') as HTMLInputElement).value).toBe(
      'Richard J Gilbertson'
    )
    expect((screen.getByLabelText('DOI') as HTMLInputElement).value).toBe('10.1234/extracted')
  })

  it('waits for remote PDF metadata and ignores completion from a closed import', async () => {
    let finishOld!: (draft: LiteratureItemInput) => void
    let finishCurrent!: (draft: LiteratureItemInput) => void
    completeLiteraturePdfDraft
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCurrent = resolve
          })
      )
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const upload = (name: string): void => {
      fireEvent.change(screen.getByLabelText('Import PDF'), {
        target: { files: [new File(['%PDF-1.7'], name, { type: 'application/pdf' })] }
      })
    }
    upload('old.pdf')
    await waitFor(() => expect(completeLiteraturePdfDraft).toHaveBeenCalledTimes(1))
    expect(screen.queryByLabelText('Title')).toBeNull()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    upload('current.pdf')
    await waitFor(() => expect(completeLiteraturePdfDraft).toHaveBeenCalledTimes(2))
    await act(async () => finishOld({ ...libraryItem.item, title: 'Obsolete result' }))
    expect(screen.queryByLabelText('Title')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Reading…')
    await act(async () => finishCurrent({ ...libraryItem.item, title: 'Resolved Crossref title' }))
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(
      'Resolved Crossref title'
    )
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'User reviewed title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'create-item',
        item: expect.objectContaining({ title: 'User reviewed title' })
      })
    )
  })

  it('falls back to the PDF filename when local metadata cannot be read', async () => {
    extractLiteraturePdfDraft.mockRejectedValueOnce(new Error('Unreadable PDF'))

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    fireEvent.change(screen.getByLabelText('Import PDF'), {
      target: {
        files: [new File(['not-a-pdf'], 'fallback-title.pdf', { type: 'application/pdf' })]
      }
    })

    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Reading…')
    expect(((await screen.findByLabelText('Title')) as HTMLInputElement).value).toBe(
      'fallback title'
    )
  })

  it.each([
    ['Keep as separate reference', 'separate'],
    ['Fill empty fields', 'fill-missing']
  ])('passes the selected import duplicate policy: %s', async (label, duplicatePolicy) => {
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const content = '@article{crag, title={Corrective Retrieval Augmented Generation}}'
    const file = new File([content], 'references.bib')
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(content) })
    fireEvent.change(screen.getByLabelText('Import references'), { target: { files: [file] } })
    const select = await screen.findByRole('combobox', { name: 'When identifiers match' })
    const dialog = screen.getByRole('dialog')
    const overlay = dialog.previousElementSibling!
    fireEvent.click(select)
    await screen.findByRole('listbox')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await act(async () => {
      fireEvent.pointerDown(overlay, { button: 0 })
      fireEvent.pointerUp(overlay, { button: 0 })
      fireEvent.click(overlay, { button: 0 })
    })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(screen.getByRole('dialog')).toBe(dialog)
    fireEvent.click(select)
    fireEvent.click(await screen.findByRole('option', { name: label }))
    expect(screen.getByRole('dialog')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Import references' }))
    await waitFor(() =>
      expect(importRecords).toHaveBeenCalledWith({ mode: 'commit', content, duplicatePolicy })
    )
  })

  it('refreshes conflict details when identities change between preview and commit', async () => {
    let changed = false
    importRecords.mockImplementation(async (request: { mode: 'commit' | 'preview' }) => {
      if (request.mode === 'commit') {
        changed = true
        throw new Error(LITERATURE_IMPORT_IDENTITY_CONFLICT)
      }
      return {
        format: 'bibtex',
        items: [libraryItem.item],
        errors: [],
        scannedEntries: 1,
        truncated: false,
        entries: [
          {
            index: 0,
            title: libraryItem.item.title,
            item: libraryItem.item,
            warnings: [],
            status: changed ? 'conflict' : 'ready',
            ...(changed
              ? {
                  conflict: {
                    identifiers: libraryItem.item.identifiers,
                    matches: [{ itemId: 'new-owner', title: 'New matching reference' }]
                  }
                }
              : {})
          }
        ]
      }
    })
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const file = new File(['reference'], 'references.bib')
    Object.defineProperty(file, 'text', { value: async () => 'reference' })
    fireEvent.change(screen.getByLabelText('Import references'), { target: { files: [file] } })
    await screen.findByRole('dialog')
    fireEvent.click(await screen.findByRole('button', { name: 'Import references' }))
    expect(await screen.findByText('Library reference: New matching reference')).not.toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Import references' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(importRecords.mock.calls.map(([request]) => request.mode)).toEqual([
      'preview',
      'commit',
      'preview'
    ])
  })

  it('previews and imports BibTeX records into the Library', async () => {
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const content = '@article{crag, title={Corrective Retrieval Augmented Generation}}'
    const file = new File([content], 'references.bib', { type: 'application/x-bibtex' })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: vi.fn().mockResolvedValue(content)
    })

    const importInput = screen.getByLabelText('Import references')
    expect(importInput.getAttribute('accept')).toContain('.nbib')
    fireEvent.change(importInput, {
      target: { files: [file] }
    })

    await waitFor(() => expect(importRecords).toHaveBeenCalledWith({ mode: 'preview', content }))
    expect(await screen.findByRole('dialog')).not.toBeNull()
    expect(screen.getByText('Corrective Retrieval Augmented Generation')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Import references' }))
    await waitFor(() => expect(importRecords).toHaveBeenCalledWith({ mode: 'commit', content }))
    expect(await screen.findByText('Created')).not.toBeNull()
    expect(screen.getByText('Reused')).not.toBeNull()
    expect(screen.getByText('Skipped').parentElement?.textContent).toBe('0Skipped')
    expect(screen.getByText('Failed').parentElement?.textContent).toBe('0Failed')
    expect((screen.getByText(/View details/).closest('details') as HTMLDetailsElement).open).toBe(
      false
    )
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('links imported references to the current Project', async () => {
    useNavigationStore.setState({ pendingLiteratureProjectId: 'project-1' })
    render(<LiteratureLibraryPage />)
    await screen.findByRole('heading', { name: 'Retrieval research' })
    const content = '@article{crag, title={Corrective Retrieval Augmented Generation}}'
    const file = new File([content], 'references.bib', { type: 'application/x-bibtex' })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: vi.fn().mockResolvedValue(content)
    })

    fireEvent.change(screen.getByLabelText('Import references'), {
      target: { files: [file] }
    })
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Import references' }))

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'set-project-items',
        projectId: 'project-1',
        itemIds: [libraryItem.id],
        included: true,
        source: 'library'
      })
    )
  })

  it('keeps a cancelled import preview closed when parsing finishes later', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    importRecords.mockImplementationOnce(async () => {
      await pending
      return {
        format: 'nbib',
        items: [],
        entries: [],
        errors: [],
        truncated: false,
        scannedEntries: 0
      }
    })
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const file = new File(['PMID- 123'], 'references.nbib')
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue('PMID- 123') })
    fireEvent.change(screen.getByLabelText('Import references'), { target: { files: [file] } })
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => {
      finish()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('explains truncated and invalid references in the skipped import summary', async () => {
    importRecords.mockImplementation((request: { mode: 'commit' | 'preview' }) =>
      Promise.resolve({
        format: 'nbib',
        items: [libraryItem.item],
        entries: [
          {
            index: 0,
            title: libraryItem.item.title,
            status: 'ready',
            warnings: [],
            item: libraryItem.item
          },
          {
            index: 1,
            title: '',
            status: 'invalid',
            warnings: [],
            errors: ['Title is required.']
          }
        ],
        errors: [],
        truncated: true,
        scannedEntries: 1_002,
        ...(request.mode === 'commit'
          ? { imported: { itemIds: [libraryItem.id], createdCount: 1, reusedCount: 0 } }
          : {})
      })
    )
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const content = 'PMID- 41057692\r\nTI  - TP53 and cancer\r\n\r\n'
    const file = new File([content], 'references.nbib', { type: 'text/plain' })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: vi.fn().mockResolvedValue(content)
    })

    fireEvent.change(screen.getByLabelText('Import references'), { target: { files: [file] } })
    await screen.findByRole('dialog')
    expect(screen.getByText('Only the first 1,000 references will be imported.')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Import references' }))
    expect(await screen.findByText('Created')).not.toBeNull()
    expect(screen.getByText('Skipped').parentElement?.textContent).toContain('1001Skipped')

    fireEvent.focus(screen.getByRole('button', { name: 'Why were references skipped?' }))
    await waitFor(() =>
      expect(screen.getAllByText('References after the first 1,000 were skipped.')).toHaveLength(2)
    )
    expect(
      screen.getAllByText(
        'Invalid references were skipped. Open View details to review their errors.'
      )
    ).toHaveLength(2)
  })

  it('preserves the import receipt when adding saved references to a project fails', async () => {
    useNavigationStore.setState({ pendingLiteratureProjectId: 'project-1' })
    transact.mockRejectedValueOnce(new Error('Project unavailable'))
    render(<LiteratureLibraryPage />)
    await screen.findByRole('heading', { name: 'Retrieval research' })
    const file = new File(['@article{example, title={Example}}'], 'references.bib')
    Object.defineProperty(file, 'text', {
      value: vi.fn().mockResolvedValue('@article{example, title={Example}}')
    })
    fireEvent.change(screen.getByLabelText('Import references'), { target: { files: [file] } })
    fireEvent.click(await screen.findByRole('button', { name: 'Import references' }))
    expect((await screen.findByRole('alert')).textContent).toContain('References were saved')
    expect(screen.getByText('Created').parentElement?.textContent).toBe('1Created')
    expect(screen.getByText('Failed').parentElement?.textContent).toBe('0Failed')
    expect(screen.getByRole('button', { name: 'Done' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Import references' })).toBeNull()
  })

  it('accepts a 21 MB PubMed NBIB file and delegates record limits to the parser', async () => {
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const content = 'PMID- 41057692\r\nTI  - TP53 and cancer\r\n\r\n'
    const file = new File([content], 'pubmed-tp53andcan-set.nbib', { type: 'text/plain' })
    Object.defineProperty(file, 'size', {
      configurable: true,
      value: 22_294_440
    })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: vi.fn().mockResolvedValue(content)
    })

    fireEvent.change(screen.getByLabelText('Import references'), {
      target: { files: [file] }
    })

    await waitFor(() => expect(importRecords).toHaveBeenCalledWith({ mode: 'preview', content }))
    expect(screen.queryByText('Reference file could not be read.')).toBeNull()
  })

  it('reports the file size limit before reading an oversized reference file', async () => {
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const file = new File(['PMID- 41057692'], 'oversized.nbib', { type: 'text/plain' })
    const read = vi.fn().mockResolvedValue('PMID- 41057692')
    Object.defineProperty(file, 'size', {
      configurable: true,
      value: 32 * 1024 * 1024 + 1
    })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: read
    })

    fireEvent.change(screen.getByLabelText('Import references'), {
      target: { files: [file] }
    })

    expect(
      await screen.findByText('oversized.nbib: file is too large (limit 32 MB).')
    ).not.toBeNull()
    expect(read).not.toHaveBeenCalled()
    expect(importRecords).not.toHaveBeenCalled()
  })

  it('keeps the read failure message for a reference file that cannot be opened', async () => {
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const file = new File(['PMID- 41057692'], 'unreadable.nbib', { type: 'text/plain' })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error('read failed'))
    })

    fireEvent.change(screen.getByLabelText('Import references'), {
      target: { files: [file] }
    })

    expect(await screen.findByText('Reference file could not be read.')).not.toBeNull()
    expect(importRecords).not.toHaveBeenCalled()
  })

  it('keeps a large import preview bounded until more rows are requested', async () => {
    const entries = Array.from({ length: 150 }, (_, index) => ({
      index,
      title: `Imported reference ${index}`,
      status: 'ready' as const,
      warnings: [],
      item: { ...libraryItem.item, title: `Imported reference ${index}` }
    }))
    importRecords.mockResolvedValueOnce({
      format: 'bibtex',
      items: entries.map((entry) => entry.item),
      entries,
      errors: [],
      truncated: false,
      scannedEntries: entries.length
    })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const content = '@article{many, title={Many references}}'
    const file = new File([content], 'many.bib', { type: 'application/x-bibtex' })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: vi.fn().mockResolvedValue(content)
    })

    fireEvent.change(screen.getByLabelText('Import references'), {
      target: { files: [file] }
    })

    expect(await screen.findByText('Imported reference 99')).not.toBeNull()
    expect(screen.queryByText('Imported reference 100')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(await screen.findByText('Imported reference 100')).not.toBeNull()
  })

  it('shows invalid-only imports and keeps their entry details available', async () => {
    importRecords.mockResolvedValueOnce({
      format: 'bibtex',
      items: [],
      entries: [
        {
          index: 0,
          title: '@broken{',
          status: 'invalid',
          warnings: [],
          error: 'Invalid BibTeX'
        }
      ],
      errors: [{ preview: '@broken{', error: 'Invalid BibTeX' }],
      truncated: false,
      scannedEntries: 1
    })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const content = '@broken{'
    const file = new File([content], 'broken.bib', { type: 'application/x-bibtex' })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: vi.fn().mockResolvedValue(content)
    })

    fireEvent.change(screen.getByLabelText('Import references'), {
      target: { files: [file] }
    })

    expect(await screen.findByText('No valid references found.')).not.toBeNull()
    expect(screen.getByText('Invalid BibTeX')).not.toBeNull()
    expect(screen.getByText('Invalid')).not.toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Import references' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('reports all valid records as failed when the atomic import is rolled back', async () => {
    importRecords
      .mockImplementationOnce((request: { mode: 'commit' | 'preview' }) =>
        Promise.resolve({
          format: 'bibtex',
          items: [libraryItem.item],
          entries: [
            {
              index: 0,
              title: libraryItem.item.title,
              status: 'ready',
              warnings: [],
              item: libraryItem.item
            }
          ],
          errors: [],
          truncated: false,
          scannedEntries: 1,
          ...(request.mode === 'commit'
            ? { imported: { itemIds: [libraryItem.id], createdCount: 1, reusedCount: 0 } }
            : {})
        })
      )
      .mockRejectedValueOnce(new Error('disk unavailable'))

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const content = '@article{crag, title={Corrective Retrieval Augmented Generation}}'
    const file = new File([content], 'references.bib', { type: 'application/x-bibtex' })
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: vi.fn().mockResolvedValue(content)
    })

    fireEvent.change(screen.getByLabelText('Import references'), {
      target: { files: [file] }
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Import references' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Reference import failed. Please try again.'
    )
    expect(screen.getByText('Failed').parentElement?.textContent).toBe('1Failed')
    expect(
      (screen.getByRole('button', { name: 'Import references' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it('sends explicit ordering for each sort choice', async () => {
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    for (const [label, sortBy, sortDirection] of [
      ['Recently added', 'created', 'desc'],
      ['First added', 'created', 'asc'],
      ['Title: A–Z', 'title', 'asc'],
      ['Title: Z–A', 'title', 'desc'],
      ['Year: newest first', 'year', 'desc'],
      ['Year: oldest first', 'year', 'asc'],
      ['Highest rated', 'rating', 'desc'],
      ['Recently updated', 'updated', 'desc']
    ]) {
      fireEvent.click(screen.getByLabelText('Sort references'))
      fireEvent.click(screen.getByRole('option', { name: label }))
      await waitFor(() =>
        expect(search).toHaveBeenCalledWith(
          expect.objectContaining({ scope: 'library', sortBy, sortDirection, offset: 0 })
        )
      )
    }
  })

  it('applies pending years after closing Filters and restores the drafts when reopened', async () => {
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    fireEvent.change(screen.getByLabelText('From year'), { target: { value: '2020' } })
    fireEvent.keyDown(screen.getByLabelText('From year'), { key: 'Escape' })
    expect(screen.queryByLabelText('From year')).toBeNull()
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'library',
          filter: expect.objectContaining({ yearFrom: 2020 })
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
    expect((screen.getByLabelText('From year') as HTMLInputElement).value).toBe('2020')
    fireEvent.change(screen.getByLabelText('To year'), { target: { value: '2024' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect((screen.getByLabelText('From year') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('To year') as HTMLInputElement).value).toBe('')
  })

  it('filters and moves the current view to Trash', async () => {
    let resolveFilteredSearch!: (page: { entries: (typeof libraryItem)[] }) => void
    const filteredSearch = new Promise<{ entries: (typeof libraryItem)[] }>((resolve) => {
      resolveFilteredSearch = resolve
    })
    search.mockImplementation(
      (request: { scope: string; filter?: { yearFrom?: number; hasFullText?: boolean } }) => {
        if (request.filter?.yearFrom === 2020 && request.filter.hasFullText === true) {
          return filteredSearch
        }
        return Promise.resolve(
          request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] }
        )
      }
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Filters' }))
    fireEvent.click(screen.getByLabelText('Reference type'))
    fireEvent.click(screen.getByRole('option', { name: 'Journal article' }))
    fireEvent.change(screen.getByLabelText('From year'), { target: { value: '2020' } })
    fireEvent.click(screen.getByLabelText('PDF'))
    fireEvent.click(screen.getByRole('option', { name: 'With PDF' }))

    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'library',
          filter: expect.objectContaining({
            itemTypes: ['journalArticle'],
            yearFrom: 2020,
            hasFullText: true
          })
        })
      )
    )

    // The search call can be observed before its response renders the filtered row.
    setTimeout(() => resolveFilteredSearch({ entries: [libraryItem] }), 0)
    fireEvent.click(
      await screen.findByLabelText('Select Corrective Retrieval Augmented Generation')
    )
    expect(screen.queryByLabelText('Sort references')).toBeNull()
    expect(screen.getByRole('button', { name: 'Clear selection' })).not.toBeNull()
    const actionRail = document.querySelector<HTMLElement>('[data-slot="literature-action-rail"]')
    expect(actionRail?.className).toContain('h-12')
    const selectionToolbar = document.querySelector<HTMLElement>(
      '[data-slot="literature-selection-toolbar"]'
    )
    expect(selectionToolbar).not.toBeNull()
    await openMenu(
      within(selectionToolbar as HTMLElement).getByRole('button', { name: 'More actions' })
    )
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }))
    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'set-item-lifecycle',
        itemIds: [libraryItem.id],
        state: 'deleted'
      })
    )
  })

  it('updates a row selection without rerendering the Literature page', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const checkbox = await screen.findByLabelText(
      'Select Corrective Retrieval Augmented Generation'
    )
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    filePreviewRenderCount.value = 0

    fireEvent.click(checkbox)

    expect((checkbox as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('1 selected').className).toContain('whitespace-nowrap')
    expect(screen.getByRole('button', { name: 'Clear selection' }).textContent).toBe('')
    expect(filePreviewRenderCount.value).toBe(0)
  })

  it('exports selected references from the selection toolbar', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    fireEvent.click(
      await screen.findByLabelText('Select Corrective Retrieval Augmented Generation')
    )
    await openMenu(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'BibTeX' }))

    await waitFor(() =>
      expect(formatReferences).toHaveBeenCalledWith({
        itemIds: [libraryItem.id],
        styleId: 'apa',
        locale: 'en-US'
      })
    )
    await waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
    const request = saveBlobFile.mock.calls[0]?.[0] as {
      data: ArrayBuffer
      mimeType: string
      suggestedName: string
    }
    expect(request.suggestedName).toBe('selected-references.bib')
    expect(request.mimeType).toBe('application/x-bibtex;charset=utf-8')
    expect(new TextDecoder().decode(request.data)).toContain('@article{item-1')
  })

  it.each([2, 201])(
    'rejects duplicate BibTeX keys among %s entries before saving a file',
    async (count) => {
      const entries = Array.from({ length: count }, (_, index) => createLibraryItem(index + 1))
      search.mockImplementation(
        (request: { scope: string; projectId?: string; offset?: number; limit?: number }) =>
          Promise.resolve(
            request.scope === 'library' && request.projectId === 'project-1'
              ? {
                  entries: entries.slice(
                    request.offset ?? 0,
                    (request.offset ?? 0) + (request.limit ?? 100)
                  ),
                  totalCount: entries.length,
                  nextOffset:
                    (request.offset ?? 0) + (request.limit ?? 100) < entries.length
                      ? (request.offset ?? 0) + (request.limit ?? 100)
                      : undefined
                }
              : { entries: [] }
          )
      )
      formatReferences.mockImplementation(async ({ itemIds }: { itemIds: string[] }) => ({
        references: [],
        exports: {
          bibtex: itemIds
            .map((id) => `@article{${id === `item-${count}` ? 'item-1' : id}, title={Paper}}`)
            .join('\n'),
          ris: 'TY  - JOUR\nER  -'
        }
      }))
      useNavigationStore.setState({ pendingLiteratureProjectId: 'project-1' })
      render(<LiteratureLibraryPage />)
      await screen.findByRole('heading', { name: 'Retrieval research' })
      await openMenu(screen.getByTitle('More actions'))
      fireEvent.click(screen.getByRole('menuitem', { name: 'BibTeX' }))
      await waitFor(() => expect(formatReferences).toHaveBeenCalledTimes(Math.ceil(count / 200)))
      await waitFor(() =>
        expect(screen.queryByText('References could not be exported.')).not.toBeNull()
      )
      expect(saveBlobFile).not.toHaveBeenCalled()
    }
  )

  it('exports every reference in the current Project', async () => {
    search.mockImplementation((request: { projectId?: string; scope: string; sortBy?: string }) =>
      Promise.resolve(
        request.scope === 'library' && request.projectId === 'project-1'
          ? { entries: [libraryItem], totalCount: 1 }
          : request.scope === 'inbox'
            ? inboxPage
            : { entries: [] }
      )
    )
    useNavigationStore.setState({ pendingLiteratureProjectId: 'project-1' })

    render(<LiteratureLibraryPage />)
    expect(await screen.findByRole('heading', { name: 'Retrieval research' })).not.toBeNull()
    await screen.findByText('Corrective Retrieval Augmented Generation')
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull()
    await openMenu(screen.getByTitle('More actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'RIS' }))

    await waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'library',
        projectId: 'project-1',
        sortBy: 'title',
        limit: 100
      })
    )
    expect(saveBlobFile).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: 'Retrieval research-references.ris',
        mimeType: 'application/x-research-info-systems;charset=utf-8'
      })
    )
  })

  it('exports every reference in the current Collection', async () => {
    const collection = {
      id: 'collection-export',
      name: 'Review queue',
      description: '',
      itemCount: 1,
      createdAt: 1,
      updatedAt: 1
    }
    search.mockImplementation(
      (request: { collectionId?: string; scope: string; sortBy?: string }) =>
        Promise.resolve(
          request.scope === 'collections'
            ? { entries: [collection], totalCount: 1 }
            : request.scope === 'library' && request.collectionId === collection.id
              ? { entries: [libraryItem], totalCount: 1 }
              : request.scope === 'inbox'
                ? inboxPage
                : { entries: [] }
        )
    )
    useNavigationStore.setState({ pendingLiteratureCollectionId: collection.id })

    render(<LiteratureLibraryPage />)
    expect(await screen.findByRole('heading', { name: collection.name })).not.toBeNull()
    await screen.findByText('Corrective Retrieval Augmented Generation')
    await openMenu(screen.getByTitle('More actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'BibTeX' }))

    await waitFor(() => expect(saveBlobFile).toHaveBeenCalledOnce())
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'library',
        collectionId: collection.id,
        sortBy: 'title',
        limit: 100
      })
    )
    expect(saveBlobFile).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'Review queue-references.bib' })
    )
  })

  it('keeps scroll and selection when a hidden background indicator observes completion', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve({ entries: request.scope === 'library' ? [libraryItem] : [] })
    )
    const summary = {
      id: 'background-job',
      mode: 'metadata' as const,
      phase: 'apply' as const,
      state: 'running' as const,
      total: 1,
      checked: 1,
      ready: 0,
      done: 0,
      failed: 0,
      createdAt: 1,
      updatedAt: 1,
      completedItemIds: [] as string[]
    }
    vi.mocked(window.api.literature.jobs).mockResolvedValue({ jobs: [], summaries: [summary] })
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const select = await screen.findByRole('checkbox', { name: `Select ${libraryItem.item.title}` })
    await screen.findByRole('button', { name: 'Background tasks' })
    const scroll = document.querySelector<HTMLDivElement>('[data-slot="literature-table-scroll"]')!
    scroll.scrollTop = 240
    fireEvent.click(select)
    expect(screen.queryByRole('button', { name: 'Background tasks' })).toBeNull()
    const listRequests = search.mock.calls.filter(
      ([request]) => request.scope === 'library' && request.limit !== 1
    ).length
    get.mockResolvedValue({
      ...libraryItem,
      item: { ...libraryItem.item, title: 'Updated while reading' },
      metadataRevision: 2
    })
    vi.mocked(window.api.literature.jobs).mockResolvedValue({
      jobs: [],
      summaries: [{ ...summary, state: 'completed', done: 1, completedItemIds: [libraryItem.id] }]
    })
    await act(async () => {
      window.dispatchEvent(new Event('literature-jobs-changed'))
    })
    await screen.findByText('Updated while reading')
    expect(scroll.scrollTop).toBe(240)
    expect(
      (screen.getByRole('checkbox', { name: 'Select Updated while reading' }) as HTMLInputElement)
        .checked
    ).toBe(true)
    expect(
      search.mock.calls.filter(([request]) => request.scope === 'library' && request.limit !== 1)
    ).toHaveLength(listRequests)
  })

  it('pages filtered ordered results and selects only the current page', async () => {
    const yearOrderedItems = Array.from({ length: 51 }, (_, index) => createLibraryItem(index))
    const titleOrderedItem = {
      ...createLibraryItem(51),
      item: { ...createLibraryItem(51).item, title: 'Alphabetical result' }
    }
    search.mockImplementation(
      (request: {
        filter?: { yearFrom?: number }
        limit?: number
        offset?: number
        scope: string
        sortBy?: string
        sortDirection?: string
      }) => {
        if (request.scope !== 'library') return Promise.resolve({ entries: [] })
        if (request.sortBy === 'title') {
          return Promise.resolve({ entries: [titleOrderedItem], totalCount: 1 })
        }
        const offset = request.offset ?? 0
        const limit = request.limit ?? 50
        const entries = yearOrderedItems.slice(offset, offset + limit)
        return Promise.resolve({
          entries,
          ...(offset + entries.length < yearOrderedItems.length
            ? { nextOffset: offset + entries.length }
            : {}),
          totalCount: yearOrderedItems.length
        })
      }
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Filters' }))
    fireEvent.change(screen.getByLabelText('From year'), { target: { value: '2020' } })
    expect(screen.getByLabelText('References per page').textContent).toContain('25')
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'library',
          limit: 25,
          filter: expect.objectContaining({ yearFrom: 2020 })
        })
      )
    )
    await waitFor(() => expect(screen.getAllByLabelText(/^Select Reference /)).toHaveLength(25))
    fireEvent.click(screen.getByLabelText('References per page'))
    fireEvent.click(screen.getByRole('option', { name: '50' }))
    fireEvent.click(screen.getByLabelText('Sort references'))
    fireEvent.click(screen.getByRole('option', { name: 'Year: newest first' }))

    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'library',
          offset: 0,
          limit: 50,
          sortBy: 'year',
          sortDirection: 'desc',
          filter: expect.objectContaining({ yearFrom: 2020 })
        })
      )
    )
    await screen.findByText('Reference 0')
    expect(screen.getAllByLabelText(/^Select Reference /)).toHaveLength(50)
    expect(screen.getByText('Reference 49')).not.toBeNull()
    expect(screen.queryByText('Reference 50')).toBeNull()
    const defaultRange = screen.getByText('1–50')
    expect(defaultRange.parentElement?.textContent).toContain('51')

    fireEvent.click(screen.getByLabelText('Select all references'))
    expect(screen.getByText('50 selected')).not.toBeNull()

    fireEvent.click(screen.getByLabelText('References per page'))
    fireEvent.click(screen.getByRole('option', { name: '25' }))
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'library',
          offset: 0,
          limit: 25,
          sortBy: 'year',
          sortDirection: 'desc',
          filter: expect.objectContaining({ yearFrom: 2020 })
        })
      )
    )
    await waitFor(() => expect(screen.getAllByLabelText(/^Select Reference /)).toHaveLength(25))
    expect(screen.queryByText(/ selected$/)).toBeNull()
    expect(screen.getByText('1–25')).not.toBeNull()

    fireEvent.click(screen.getByLabelText('Select all references'))
    expect(screen.getByText('25 selected')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'library',
          offset: 25,
          sortBy: 'year',
          sortDirection: 'desc',
          filter: expect.objectContaining({ yearFrom: 2020 })
        })
      )
    )

    expect(await screen.findByText('Reference 25')).not.toBeNull()
    expect(screen.getByText('Reference 49')).not.toBeNull()
    expect(screen.queryByText('Reference 50')).toBeNull()
    expect(screen.queryByText('Reference 0')).toBeNull()
    expect(document.querySelector('[data-row-number="26"]')?.textContent).toBe('26')
    expect(screen.getByRole('button', { name: 'Page 2' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByText('26–50')).not.toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled
    ).toBe(false)

    const firstPageRequestCount = search.mock.calls.filter(
      ([request]) =>
        request.scope === 'library' &&
        request.offset === 0 &&
        request.limit === 25 &&
        request.sortBy === 'year'
    ).length
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(await screen.findByText('Reference 0')).not.toBeNull()
    expect(
      search.mock.calls.filter(
        ([request]) =>
          request.scope === 'library' &&
          request.offset === 0 &&
          request.limit === 25 &&
          request.sortBy === 'year'
      )
    ).toHaveLength(firstPageRequestCount)

    fireEvent.click(screen.getByLabelText('Sort references'))
    fireEvent.click(screen.getByRole('option', { name: 'Title: A–Z' }))
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'library',
          offset: 0,
          sortBy: 'title',
          sortDirection: 'asc',
          filter: expect.objectContaining({ yearFrom: 2020 })
        })
      )
    )
    expect(await screen.findByText('Alphabetical result')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Page 2' })).toBeNull()
    expect(screen.queryByText('Reference 25')).toBeNull()
  })

  it('starts a page request and shows its loading state in the pagination click', async () => {
    const pagedItems = Array.from({ length: 51 }, (_, index) => createLibraryItem(index))
    search.mockImplementation((request: { limit?: number; offset?: number; scope: string }) => {
      if (request.scope !== 'library') return Promise.resolve({ entries: [] })
      const offset = request.offset ?? 0
      const limit = request.limit ?? 50
      const entries = pagedItems.slice(offset, offset + limit)
      return Promise.resolve({
        entries,
        totalCount: pagedItems.length,
        ...(offset + entries.length < pagedItems.length
          ? { nextOffset: offset + entries.length }
          : {})
      })
    })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await screen.findByText('Reference 0')
    search.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))

    expect(screen.getByRole('button', { name: 'Page 2' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('status').textContent).toContain('Loading…')
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'library', offset: 25, limit: 25 })
    )
  })

  it('opens the detail from the full title cell', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const title = await screen.findByRole('button', {
      name: 'Corrective Retrieval Augmented Generation'
    })
    expect(title.className).toContain('w-full')
    expect(title.className).toContain('h-full')
    filePreviewRenderCount.value = 0

    fireEvent.click(title)

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Publication metadata')).not.toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)
  })

  it('opens the Add menu only after an explicit click without rerendering the Literature page', async () => {
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const add = await screen.findByRole('button', { name: 'Add' })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    filePreviewRenderCount.value = 0

    fireEvent.pointerEnter(add)

    expect(screen.queryByRole('menuitem', { name: 'Add reference' })).toBeNull()

    fireEvent.pointerDown(add, { button: 0, ctrlKey: false })
    fireEvent.click(add)

    expect(screen.getByRole('menuitem', { name: 'Add reference' })).not.toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)
  })

  it('opens cached batch destinations without rerendering the Literature page', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(
        request.scope === 'library'
          ? { entries: [libraryItem] }
          : request.scope === 'collections'
            ? {
                entries: [
                  {
                    id: 'collection-1',
                    name: 'Review queue',
                    description: '',
                    itemCount: 0,
                    createdAt: 1,
                    updatedAt: 1
                  }
                ]
              }
            : { entries: [] }
      )
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await screen.findByRole('button', { name: 'Corrective Retrieval Augmented Generation' })
    fireEvent.click(screen.getByLabelText('Select all references'))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())

    const addToCollection = screen.getByRole('button', { name: 'Add to collection' })
    filePreviewRenderCount.value = 0
    fireEvent.click(addToCollection)
    const collectionPopover = document.querySelector<HTMLElement>(
      '[data-slot="literature-batch-collection-popover"]'
    )
    expect(
      within(collectionPopover as HTMLElement).getByRole('button', { name: 'Review queue' })
    ).not.toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)

    fireEvent.click(addToCollection)
    const addToProject = screen.getByRole('button', { name: 'Add to project' })
    filePreviewRenderCount.value = 0
    fireEvent.click(addToProject)
    const projectPopover = document.querySelector<HTMLElement>(
      '[data-slot="literature-batch-project-popover"]'
    )
    expect(
      within(projectPopover as HTMLElement).getByRole('button', { name: 'Retrieval research' })
    ).not.toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)
  })

  it('opens a reference action menu without rerendering the Literature page', async () => {
    search.mockImplementation((request: { scope: string }) =>
      Promise.resolve(request.scope === 'library' ? { entries: [libraryItem] } : { entries: [] })
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    const referenceRow = (
      await screen.findByRole('button', { name: 'Corrective Retrieval Augmented Generation' })
    ).closest('tr')!
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    filePreviewRenderCount.value = 0

    await openMenu(within(referenceRow).getByRole('button', { name: 'More actions' }))

    expect(screen.getByRole('menuitem', { name: 'Edit' })).not.toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)
  })

  it('refreshes committed references when a later lifecycle batch fails', async () => {
    let items = Array.from({ length: 201 }, (_, index) => createLibraryItem(index))
    search.mockImplementation((request: LiteratureCatalogSearchRequest) => {
      if (request.scope !== 'library') return Promise.resolve({ entries: [] })
      const offset = request.offset ?? 0
      const limit = request.limit ?? 100
      return Promise.resolve({
        entries: items.slice(offset, offset + limit),
        totalCount: items.length,
        nextOffset: offset + limit < items.length ? offset + limit : undefined
      })
    })
    transact
      .mockImplementationOnce(async (command) => {
        items = items.filter(({ id }) => !command.itemIds.includes(id))
        return { kind: 'item', id: command.itemIds[0], state: 'deleted' }
      })
      .mockRejectedValueOnce(new Error('One or more Literature Items are unavailable.'))
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await screen.findByText('Reference 0')
    fireEvent.click(screen.getByLabelText('Select all references'))
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching references 201' }))
    const toolbar = document.querySelector<HTMLElement>(
      '[data-slot="literature-selection-toolbar"]'
    )!
    await openMenu(within(toolbar).getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }))
    await act(async () => {})
    expect(items).toHaveLength(1)
    expect(
      transact.mock.calls.filter(([command]) => command.kind === 'set-item-lifecycle')
    ).toHaveLength(2)
    expect(screen.queryByText('Reference 0')).toBeNull()
    expect(screen.queryByText('Reference 200')).not.toBeNull()
    expect(screen.getByText('Updated: 200. Not updated: 1.')).not.toBeNull()
    expect(screen.getByText('1 selected')).not.toBeNull()
    transact.mockImplementationOnce(async (command) => {
      items = items.filter(({ id }) => !command.itemIds.includes(id))
      return { kind: 'item', id: command.itemIds[0], state: 'deleted' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {})
    expect(transact).toHaveBeenLastCalledWith({
      kind: 'set-item-lifecycle',
      itemIds: ['item-200'],
      state: 'deleted'
    })
    expect(items).toHaveLength(0)
    expect(screen.queryByText('Updated: 200. Not updated: 1.')).toBeNull()
  })

  it('refreshes project and collection counts through delete and restore, including zero', async () => {
    let deleted = false
    search.mockImplementation((request: LiteratureCatalogSearchRequest) => {
      if (request.scope === 'project-counts')
        return Promise.resolve({
          entries: deleted ? [] : [{ projectId: 'project-1', itemCount: 1 }]
        })
      if (request.scope === 'collections')
        return Promise.resolve({
          entries: [
            {
              id: 'c1',
              name: 'Reading',
              description: '',
              itemCount: deleted ? 0 : 1,
              createdAt: 1,
              updatedAt: 1
            }
          ]
        })
      if (request.scope === 'library') {
        const visible = (request.lifecycle === 'deleted') === deleted
        return Promise.resolve({
          entries: visible ? [libraryItem] : [],
          totalCount: visible ? 1 : 0
        })
      }
      return Promise.resolve({ entries: [] })
    })
    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    for (const [action, expectedCount] of [
      ['Move to Trash', '0'],
      ['Restore', '1']
    ] as const) {
      const row = (await screen.findByText(libraryItem.item.title)).closest('tr')!
      await openMenu(within(row).getByRole('button', { name: 'More actions' }))
      transact.mockImplementationOnce(async () => {
        deleted = !deleted
        return { kind: 'item', id: libraryItem.id, state: deleted ? 'deleted' : 'active' }
      })
      fireEvent.click(screen.getByRole('menuitem', { name: action }))
      await act(async () => {})
      expect(
        within(screen.getByRole('button', { name: 'Retrieval research' })).getByText(expectedCount)
      ).not.toBeNull()
      expect(
        within(screen.getByRole('button', { name: 'Reading' })).getByText(expectedCount)
      ).not.toBeNull()
      if (deleted) fireEvent.click(screen.getByRole('button', { name: 'Trash' }))
    }
  })

  it('does not publish a truncated collection navigation when a continuation fails and permits retry', async () => {
    const collections = Array.from({ length: 101 }, (_, index) => ({
      id: `c-${index}`,
      name: `Collection ${index}`,
      description: '',
      itemCount: 0,
      createdAt: 1,
      updatedAt: 1
    }))
    let fail = true
    search.mockImplementation((request: LiteratureCatalogSearchRequest) => {
      if (request.scope !== 'collections') return Promise.resolve({ entries: [] })
      if (request.offset === 100 && fail) return Promise.reject(new Error('Page unavailable'))
      return Promise.resolve({
        entries: collections.slice(request.offset ?? 0, (request.offset ?? 0) + 100),
        nextOffset: request.offset === 100 ? undefined : 100,
        totalCount: 101
      })
    })
    render(<LiteratureLibraryPage />)
    await act(async () => {})
    expect(screen.getByText('Literature could not be loaded.')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Collection 0' })).toBeNull()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Show all collections' }))
    expect(screen.getByRole('button', { name: 'Collection 100' })).not.toBeNull()
  })

  it('applies a bulk action to every matching page in bounded command batches', async () => {
    const matchingItems = Array.from({ length: 201 }, (_, index) => createLibraryItem(index))
    search.mockImplementation((request: { limit?: number; offset?: number; scope: string }) => {
      if (request.scope !== 'library') return Promise.resolve({ entries: [] })
      const offset = request.offset ?? 0
      const limit = request.limit ?? 100
      const entries = matchingItems.slice(offset, offset + limit)
      return Promise.resolve({
        entries,
        totalCount: matchingItems.length,
        ...(offset + entries.length < matchingItems.length
          ? { nextOffset: offset + entries.length }
          : {})
      })
    })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await screen.findByText('Reference 0')
    fireEvent.click(screen.getByLabelText('Select all references'))
    const selectAllMatching = screen.getByRole('button', {
      name: 'Select all matching references 201'
    })
    expect(selectAllMatching.textContent).toBe('Select all201')
    fireEvent.click(selectAllMatching)
    expect(screen.getByText('201 selected')).not.toBeNull()

    const selectionToolbar = document.querySelector<HTMLElement>(
      '[data-slot="literature-selection-toolbar"]'
    )
    await openMenu(
      within(selectionToolbar as HTMLElement).getByRole('button', { name: 'More actions' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }))

    await waitFor(() => {
      const lifecycleCommands = transact.mock.calls
        .map(([command]) => command)
        .filter((command) => command.kind === 'set-item-lifecycle')
      expect(lifecycleCommands).toEqual([
        {
          kind: 'set-item-lifecycle',
          itemIds: matchingItems.slice(0, 200).map(({ id }) => id),
          state: 'deleted'
        },
        {
          kind: 'set-item-lifecycle',
          itemIds: [matchingItems[200]!.id],
          state: 'deleted'
        }
      ])
    })
  })

  it('creates a Collection from the batch popover and adds every matching reference', async () => {
    const matchingItems = Array.from({ length: 201 }, (_, index) => createLibraryItem(index))
    search.mockImplementation((request: { limit?: number; offset?: number; scope: string }) => {
      if (request.scope === 'collections') return Promise.resolve({ entries: [] })
      if (request.scope !== 'library') return Promise.resolve({ entries: [] })
      const offset = request.offset ?? 0
      const limit = request.limit ?? 50
      const entries = matchingItems.slice(offset, offset + limit)
      return Promise.resolve({
        entries,
        totalCount: matchingItems.length,
        ...(offset + entries.length < matchingItems.length
          ? { nextOffset: offset + entries.length }
          : {})
      })
    })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await screen.findByText('Reference 0')
    fireEvent.click(screen.getByLabelText('Select all references'))
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching references 201' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to collection' }))

    expect(screen.getByText('No collections')).not.toBeNull()
    expect(screen.getByText('Create a collection for the selected references.')).not.toBeNull()
    const collectionPopover = document.querySelector(
      '[data-slot="literature-batch-collection-popover"]'
    )
    expect(collectionPopover?.className).toContain('w-72')

    fireEvent.click(
      within(collectionPopover as HTMLElement).getByRole('button', { name: 'New collection' })
    )
    filePreviewRenderCount.value = 0
    fireEvent.change(within(collectionPopover as HTMLElement).getByLabelText('Collection name'), {
      target: { value: 'Review queue' }
    })
    expect(filePreviewRenderCount.value).toBe(0)
    transact.mockResolvedValueOnce({ kind: 'collection', id: 'collection-new' })
    fireEvent.click(
      within(collectionPopover as HTMLElement).getByRole('button', {
        name: 'Create collection'
      })
    )

    await waitFor(() => {
      expect(transact.mock.calls.map(([command]) => command)).toEqual(
        expect.arrayContaining([
          { kind: 'create-collection', name: 'Review queue' },
          {
            kind: 'move-collection-items',
            itemIds: matchingItems.slice(0, 200).map(({ id }) => id),
            targetCollectionId: 'collection-new'
          },
          {
            kind: 'move-collection-items',
            itemIds: [matchingItems[200]!.id],
            targetCollectionId: 'collection-new'
          }
        ])
      )
    })
  })

  it('searches Projects and adds every matching reference in bounded batches', async () => {
    const matchingItems = Array.from({ length: 201 }, (_, index) => createLibraryItem(index))
    useProjectStore.setState({
      projects: Array.from({ length: 6 }, (_, index) => ({
        id: `project-${index + 1}`,
        name: `Project ${index + 1}`,
        description: '',
        isExample: false,
        createdAt: index + 1,
        updatedAt: index + 1
      })),
      isLoaded: true
    })
    search.mockImplementation((request: { limit?: number; offset?: number; scope: string }) => {
      if (request.scope === 'collections') return Promise.resolve({ entries: [] })
      if (request.scope !== 'library') return Promise.resolve({ entries: [] })
      const offset = request.offset ?? 0
      const limit = request.limit ?? 50
      const entries = matchingItems.slice(offset, offset + limit)
      return Promise.resolve({
        entries,
        totalCount: matchingItems.length,
        ...(offset + entries.length < matchingItems.length
          ? { nextOffset: offset + entries.length }
          : {})
      })
    })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    await screen.findByText('Reference 0')
    fireEvent.click(screen.getByLabelText('Select all references'))
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching references 201' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to project' }))

    const searchProjects = screen.getByLabelText('Search projects')
    const projectPopover = searchProjects.closest(
      '[data-slot="literature-batch-project-popover"]'
    ) as HTMLElement
    filePreviewRenderCount.value = 0
    fireEvent.change(searchProjects, { target: { value: 'Project 6' } })
    expect(within(projectPopover).queryByRole('button', { name: 'Project 1' })).toBeNull()
    expect(filePreviewRenderCount.value).toBe(0)
    fireEvent.click(within(projectPopover).getByRole('button', { name: 'Project 6' }))

    await waitFor(() => {
      const projectCommands = transact.mock.calls
        .map(([command]) => command)
        .filter((command) => command.kind === 'set-project-items')
      expect(projectCommands).toEqual([
        {
          kind: 'set-project-items',
          projectId: 'project-6',
          itemIds: matchingItems.slice(0, 200).map(({ id }) => id),
          included: true,
          source: 'library'
        },
        {
          kind: 'set-project-items',
          projectId: 'project-6',
          itemIds: [matchingItems[200]!.id],
          included: true,
          source: 'library'
        }
      ])
    })
  })

  it('restores or permanently deletes references from Trash after confirmation', async () => {
    search.mockImplementation((request: { lifecycle?: string; scope: string }) =>
      Promise.resolve(
        request.scope === 'library' && request.lifecycle === 'deleted'
          ? { entries: [libraryItem] }
          : { entries: [] }
      )
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }))
    const referenceRow = (
      await screen.findByText('Corrective Retrieval Augmented Generation')
    ).closest('tr')!
    await openMenu(within(referenceRow).getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('menuitem', { name: 'Restore' })).not.toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete permanently' }))

    const confirmation = screen.getByRole('alertdialog')
    expect(within(confirmation).getByText('Delete permanently?')).not.toBeNull()
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete permanently' }))

    await waitFor(() =>
      expect(transact).toHaveBeenCalledWith({
        kind: 'delete-items-permanently',
        itemIds: [libraryItem.id]
      })
    )
  })

  it('hides the previous section rows as soon as the library section changes', async () => {
    search.mockImplementation((request: { lifecycle?: string; scope: string }) =>
      Promise.resolve(
        request.scope === 'library' && request.lifecycle === 'active'
          ? { entries: [libraryItem] }
          : { entries: [] }
      )
    )

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    expect(await screen.findByText('Corrective Retrieval Augmented Generation')).not.toBeNull()

    expect(screen.queryByRole('button', { name: 'Archived' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }))

    expect(screen.queryByText('Corrective Retrieval Augmented Generation')).toBeNull()
    expect(screen.getByRole('status')).not.toBeNull()
  })

  it('keeps the created reference available when its PDF import fails', async () => {
    const staged = {
      id: 'upload-3',
      sessionId: '.pending',
      name: 'paper.pdf',
      originalName: 'paper.pdf',
      path: '/managed/failing.pdf',
      mimeType: 'application/pdf',
      size: 8
    }
    stageLocalFile.mockResolvedValue(staged)
    importPdf.mockRejectedValue(new Error('Invalid PDF'))
    get.mockResolvedValue({ ...libraryItem, item: { ...libraryItem.item, title: 'Paper' } })

    render(<LiteratureLibraryPage />)
    fireEvent.click(screen.getByRole('button', { name: 'All references' }))
    fireEvent.change(screen.getByLabelText('Import PDF'), {
      target: { files: [new File(['broken'], staged.name, { type: 'application/pdf' })] }
    })
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Paper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('heading', { name: 'Paper' })).not.toBeNull()
    expect((await screen.findByRole('alert')).textContent).toBe('PDF could not be added.')
    expect(transact).toHaveBeenCalledTimes(1)
  })
})
