// @vitest-environment jsdom
import { createLiteratureTestRenderer } from '../../../../../test/renderer/literature'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { LiteratureZoteroDialog } from './LiteratureZoteroDialog'
const { render } = createLiteratureTestRenderer({
  get api() {
    return window.api
  }
})
beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)
const installCollector = (collect: (request: { kind: string }) => unknown): void => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        collect: (request: { kind: string }) =>
          request.kind === 'zotero-collections'
            ? Promise.resolve({
                entries: [],
                savedItemIds: [],
                failures: [],
                pdfCount: 0,
                collections: [{ key: 'COLLECT1', path: ['Research'] }]
              })
            : collect(request)
      }
    }
  })
}
const previewLibrary = async (): Promise<void> => {
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Preview Zotero library' }) as HTMLButtonElement).disabled
    ).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Preview Zotero library' }))
}
const importButton = (): HTMLElement =>
  screen.getByRole('button', { name: /^Import (?:references|collections|\d+ references?)$/ })

describe('Zotero import dialog', () => {
  it('loads named collections, preserves hidden selections and returns to the chosen scope', async () => {
    const empty = { entries: [], savedItemIds: [], failures: [], pdfCount: 0 }
    const collect = vi.fn().mockImplementation(async ({ kind }) => {
      if (kind === 'zotero-collections')
        return {
          ...empty,
          collections: [{ key: 'COLLECT1', path: ['Research', 'Nested'] }]
        }
      return {
        ...empty,
        snapshotId: 'selection',
        entries: ['Alpha', 'Beta'].map((title) => ({
          key: title,
          title,
          pdfCount: 0,
          identity: { status: 'new', reason: 'new', identifiers: [], matches: [] }
        }))
      }
    })
    Object.defineProperty(window, 'api', { configurable: true, value: { literature: { collect } } })
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Research / Nested' }))
    expect(collect).toHaveBeenCalledWith({ kind: 'zotero-collections' })
    await previewLibrary()
    await screen.findByText('Alpha')
    expect(collect).toHaveBeenLastCalledWith({ kind: 'zotero-preview', collectionKey: 'COLLECT1' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search references' }), {
      target: { value: 'Alpha' }
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(screen.getByRole('button', { name: 'Import 1 reference' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search references' }), {
      target: { value: '' }
    })
    expect((screen.getByRole('checkbox', { name: 'Beta' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Alpha' }) as HTMLInputElement).checked).toBe(
      false
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(
      (screen.getByRole('radio', { name: 'Research / Nested' }) as HTMLInputElement).checked
    ).toBe(true)
    expect(screen.queryByRole('button', { name: 'Import 1 reference' })).toBeNull()
  })

  it.each([false, true])(
    'shows skipped tags and permits importing only valid references (valid: %s)',
    async (hasValid) => {
      const collect = vi.fn().mockResolvedValue({
        snapshotId: 'preview-tags',
        collectionCount: 1,
        entries: hasValid
          ? [
              {
                key: 'VALID001',
                title: 'Valid paper',
                pdfCount: 0,
                identity: { status: 'new', reason: 'new', identifiers: [], matches: [] }
              }
            ]
          : [],
        savedItemIds: [],
        failures: [{ key: 'BADTAG01', message: 'ZOTERO_TAG_LIMIT' }],
        pdfCount: 0
      })
      installCollector(collect)
      render(<LiteratureZoteroDialog onClose={vi.fn()} />)
      await previewLibrary()
      await screen.findByText('Skipped BADTAG01: use at most 100 tags of 64 characters each.')
      const button = importButton() as HTMLButtonElement
      expect(button.disabled).toBe(!hasValid)
      if (hasValid) {
        fireEvent.click(button)
        await waitFor(() =>
          expect(collect).toHaveBeenCalledWith({
            kind: 'zotero-commit',
            snapshotId: 'preview-tags',
            keys: ['VALID001'],
            includePdfs: true
          })
        )
      }
    }
  )

  it.each([
    [
      'ZOTERO_COLLECTION_CONFLICT',
      'Different Zotero collections would merge under the same name. Rename them in Zotero, then preview again.'
    ],
    [
      'ZOTERO_CONNECTION_FAILED',
      'Could not connect to Zotero. Open Zotero 10 or later, then try again.'
    ],
    [
      'ZOTERO_LOCAL_API_DISABLED',
      'In Zotero, open Settings → Advanced and enable “Allow other applications on this computer to communicate with Zotero”, then try again.'
    ],
    [
      'ZOTERO_REQUEST_TIMED_OUT',
      'Zotero did not respond in time. Wait for it to finish starting, then try again.'
    ]
  ])(
    'explains %s across the Electron error wrapper and retries the same preview',
    async (code, message) => {
      const collect = vi
        .fn()
        .mockRejectedValueOnce(new Error('Error invoking remote method: ' + code))
        .mockResolvedValueOnce({ entries: [], savedItemIds: [], failures: [], pdfCount: 0 })
      installCollector(collect)
      render(<LiteratureZoteroDialog onClose={vi.fn()} />)
      fireEvent.click(await screen.findByRole('radio', { name: 'Research' }))
      await previewLibrary()
      await screen.findByText(message)
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await screen.findByText('No valid references found.')
      expect(collect).toHaveBeenNthCalledWith(2, {
        kind: 'zotero-preview',
        collectionKey: 'COLLECT1'
      })
      expect(screen.queryByText(message)).toBeNull()
    }
  )
  it('requires preview and selected references before committing, then displays partial PDF failures', async () => {
    const collect = vi
      .fn()
      .mockResolvedValueOnce({
        snapshotId: 'preview-1',
        entries: [
          {
            key: 'ABCDEFGH',
            title: 'A reference',
            pdfCount: 1,
            identity: { status: 'new', reason: 'new', identifiers: [], matches: [] }
          }
        ],
        savedItemIds: [],
        failures: [],
        pdfCount: 0
      })
      .mockResolvedValueOnce({
        entries: [],
        savedItemIds: ['item-1'],
        failures: [{ key: 'PDFKEY01', message: 'Missing PDF' }],
        pdfCount: 0
      })
      .mockResolvedValueOnce({ entries: [], savedItemIds: ['item-1'], failures: [], pdfCount: 1 })
    installCollector(collect)
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Import references' })).toBeNull()
    await previewLibrary()
    await screen.findByText('A reference')
    fireEvent.click(importButton())
    await waitFor(() =>
      expect(collect).toHaveBeenCalledWith({
        kind: 'zotero-commit',
        snapshotId: 'preview-1',
        keys: ['ABCDEFGH'],
        includePdfs: true
      })
    )
    await screen.findByText('PDFKEY01: Missing PDF')
    expect(screen.queryByRole('checkbox', { name: 'A reference' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry PDFs' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry PDFs' })).toBeNull())
    expect(collect.mock.calls[2]).toEqual(collect.mock.calls[1])
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
  })
  it('shows matching evidence, excludes review and conflict rows by default, and commits a selected subset', async () => {
    const collect = vi
      .fn()
      .mockResolvedValueOnce({
        snapshotId: 'review',
        savedItemIds: [],
        failures: [],
        pdfCount: 0,
        entries: [
          {
            key: 'NEWROW01',
            title: 'New paper',
            pdfCount: 0,
            identity: { status: 'new', reason: 'new', identifiers: [], matches: [] }
          },
          {
            key: 'REVIEW01',
            title: 'Changed title',
            pdfCount: 0,
            identity: {
              status: 'review',
              reason: 'title',
              identifiers: [{ scheme: 'doi', value: '10.1234/one' }],
              matches: [
                { title: 'Local title', identifiers: [{ scheme: 'doi', value: '10.1234/one' }] }
              ]
            }
          },
          {
            key: 'CONFLICT',
            title: 'Conflicting paper',
            pdfCount: 0,
            identity: {
              status: 'conflict',
              reason: 'conflict',
              identifiers: [{ scheme: 'doi', value: '10.1234/wrong' }],
              matches: [
                {
                  title: 'Other paper',
                  identifiers: [{ scheme: 'doi', value: '10.1234/original' }]
                }
              ]
            }
          }
        ]
      })
      .mockResolvedValueOnce({
        entries: [],
        savedItemIds: ['new', 'existing'],
        failures: [],
        pdfCount: 0
      })
    installCollector(collect)
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    await previewLibrary()
    await screen.findByText('Needs review')
    const review = screen.getByRole('checkbox', {
      name: /Changed title/
    }) as HTMLInputElement
    const conflict = screen.getByRole('checkbox', {
      name: /Conflicting paper/
    }) as HTMLInputElement
    expect(review.checked).toBe(false)
    expect(conflict.checked).toBe(false)
    expect(conflict.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Review Changed title' }))
    expect(screen.getByText('Matched reference: Local title')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review Conflicting paper' }))
    expect(screen.getByText('DOI: 10.1234/original', { exact: false })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(review.checked).toBe(false)
    fireEvent.click(review)
    expect(review.checked).toBe(true)
    expect(conflict.checked).toBe(false)
    fireEvent.click(importButton())
    await waitFor(() =>
      expect(collect).toHaveBeenLastCalledWith({
        kind: 'zotero-commit',
        snapshotId: 'review',
        keys: ['NEWROW01', 'REVIEW01'],
        includePdfs: true
      })
    )
  })

  it('does not enable reference import for an all-conflict batch even with collections', async () => {
    const collect = vi.fn().mockResolvedValue({
      snapshotId: 'conflict',
      collectionCount: 1,
      savedItemIds: [],
      failures: [],
      pdfCount: 0,
      entries: [
        {
          key: 'CONFLICT',
          title: 'Conflict',
          pdfCount: 0,
          identity: { status: 'conflict', reason: 'conflict', identifiers: [], matches: [] }
        }
      ]
    })
    installCollector(collect)
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    await previewLibrary()
    await screen.findByText('Identifier conflict')
    expect((importButton() as HTMLButtonElement).disabled).toBe(true)
    expect(
      (screen.getByRole('checkbox', { name: 'Select all' }) as HTMLInputElement).disabled
    ).toBe(true)
  })

  it('clears a stale preview and retries by previewing again rather than resubmitting the commit', async () => {
    const collect = vi
      .fn()
      .mockResolvedValueOnce({
        snapshotId: 'old',
        entries: [
          {
            key: 'ABCDEFGH',
            title: 'Paper',
            pdfCount: 0,
            identity: { status: 'new', reason: 'new', identifiers: [], matches: [] }
          }
        ],
        savedItemIds: [],
        failures: [],
        pdfCount: 0
      })
      .mockRejectedValueOnce(new Error('Error invoking remote method: ZOTERO_PREVIEW_CHANGED'))
      .mockResolvedValueOnce({
        snapshotId: 'fresh',
        entries: [],
        savedItemIds: [],
        failures: [],
        pdfCount: 0
      })
    installCollector(collect)
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Research' }))
    await previewLibrary()
    await screen.findByText('New reference')
    fireEvent.click(importButton())
    await screen.findByText(
      'The library changed since this preview. Preview again before importing.'
    )
    expect(screen.queryByText('Paper')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Import \d/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(collect).toHaveBeenLastCalledWith({
        kind: 'zotero-preview',
        collectionKey: 'COLLECT1'
      })
    )
    await screen.findByText('No valid references found.')
  })

  it('edits conflicting import metadata using a new reviewed snapshot', async () => {
    const item = literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title: 'Wrong title',
      creators: [
        { nameMode: 'person', familyName: 'Lovelace', givenName: 'Ada', creatorType: 'author' }
      ],
      issuedYear: 2024,
      issuedText: '2024',
      containerTitle: 'Source journal',
      identifiers: [{ scheme: 'doi', value: '10.1234/wrong' }]
    })
    const initial = {
      snapshotId: 'old-edit',
      savedItemIds: [],
      failures: [],
      pdfCount: 0,
      entries: [
        {
          key: 'ABCDEFGH',
          title: item.title,
          item,
          policy: 'reuse',
          pdfCount: 0,
          identity: {
            status: 'conflict',
            reason: 'conflict',
            identifiers: item.identifiers,
            matches: [
              {
                title: 'Local title',
                identifiers: [{ scheme: 'doi', value: '10.1234/right' }],
                creators: [
                  {
                    nameMode: 'person',
                    givenName: 'Grace',
                    familyName: 'Hopper',
                    creatorType: 'author'
                  }
                ],
                issuedYear: 2023,
                containerTitle: 'Local journal'
              }
            ]
          }
        }
      ]
    }
    const edited = {
      ...item,
      title: 'Corrected title',
      identifiers: [{ scheme: 'doi', value: '10.1234/right', isPrimary: false }]
    }
    const revised = {
      ...initial,
      snapshotId: 'new-edit',
      entries: [
        {
          ...initial.entries[0],
          title: edited.title,
          item: edited,
          identity: { ...initial.entries[0].identity, status: 'review', reason: 'title' }
        }
      ]
    }
    const collect = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(revised)
      .mockResolvedValueOnce({ entries: [], savedItemIds: ['existing'], failures: [], pdfCount: 0 })
    installCollector(collect)
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    await previewLibrary()
    await screen.findByText('Identifier conflict')
    fireEvent.click(screen.getByRole('button', { name: 'Review Wrong title' }))
    expect(screen.getByText('Ada Lovelace', { exact: false })).toBeTruthy()
    expect(screen.getByText('Grace Hopper', { exact: false })).toBeTruthy()
    expect(screen.getByText('Local journal')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit import metadata' }))
    await screen.findByText('Edits apply to this import only. Zotero will not be changed.')
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: edited.title } })
    fireEvent.change(screen.getByRole('textbox', { name: 'DOI' }), {
      target: { value: '10.1234/right' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(collect).toHaveBeenNthCalledWith(2, {
        kind: 'zotero-revise',
        snapshotId: 'old-edit',
        key: 'ABCDEFGH',
        item: edited
      })
    )
    await screen.findByText('Corrected title')
    const checkbox = screen.getByRole('checkbox', {
      name: /Corrected title/
    }) as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    fireEvent.click(importButton())
    await waitFor(() =>
      expect(collect).toHaveBeenLastCalledWith({
        kind: 'zotero-commit',
        snapshotId: 'new-edit',
        keys: ['ABCDEFGH'],
        includePdfs: true
      })
    )
  })

  it('freezes an explicit separate-copy policy before enabling a conflicting row', async () => {
    const item = literatureItemInputSchema.parse({ itemType: 'journalArticle', title: 'Conflict' })
    const initial = {
      snapshotId: 'original',
      entries: [
        {
          key: 'ABCDEFGH',
          title: item.title,
          item,
          policy: 'reuse',
          pdfCount: 0,
          identity: { status: 'conflict', reason: 'conflict', identifiers: [], matches: [] }
        }
      ],
      savedItemIds: [],
      failures: [],
      pdfCount: 0
    }
    initial.entries.push({
      ...initial.entries[0],
      key: 'SKIPROW1',
      title: 'Skipped',
      item: { ...item, title: 'Skipped' },
      identity: { ...initial.entries[0].identity, status: 'new', reason: 'new' }
    })
    const collect = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({
        ...initial,
        snapshotId: 'separate-reviewed',
        entries: [{ ...initial.entries[0], policy: 'separate' }, initial.entries[1]]
      })
    installCollector(collect)
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    await previewLibrary()
    await screen.findByText('Identifier conflict')
    expect((screen.getByRole('checkbox', { name: /Conflict/ }) as HTMLInputElement).disabled).toBe(
      true
    )
    fireEvent.click(screen.getByRole('checkbox', { name: /Skipped/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Review Conflict' }))
    fireEvent.click(screen.getAllByRole('combobox', { name: 'When identifiers match' })[0])
    fireEvent.click(await screen.findByRole('option', { name: 'Keep as separate reference' }))
    await waitFor(() =>
      expect(collect).toHaveBeenLastCalledWith({
        kind: 'zotero-revise',
        snapshotId: 'original',
        key: 'ABCDEFGH',
        policy: 'separate'
      })
    )
    const checkbox = screen.getByRole('checkbox', { name: /Conflict/ }) as HTMLInputElement
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: /Skipped/ }) as HTMLInputElement).checked).toBe(
      false
    )
  })

  it('imports an empty collection hierarchy without requiring a reference selection', async () => {
    const collect = vi
      .fn()
      .mockResolvedValueOnce({
        snapshotId: 'empty-library',
        entries: [],
        collectionCount: 2,
        savedItemIds: [],
        failures: [],
        pdfCount: 0
      })
      .mockResolvedValueOnce({
        entries: [],
        savedItemIds: [],
        collectionCount: 2,
        failures: [],
        pdfCount: 0
      })
    installCollector(collect)
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    await previewLibrary()
    await screen.findByText('Collections: 2')
    const button = importButton() as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() =>
      expect(collect).toHaveBeenCalledWith({
        kind: 'zotero-commit',
        snapshotId: 'empty-library',
        keys: [],
        includePdfs: true
      })
    )
  })
  it('allows failed previews to be retried without losing the collection input', async () => {
    const collect = vi.fn().mockRejectedValue(new Error('Zotero unavailable'))
    installCollector(collect)
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('radio', { name: 'Research' }))
    await previewLibrary()
    await screen.findByText('Zotero unavailable')
    expect((screen.getByRole('radio', { name: 'Research' }) as HTMLInputElement).checked).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Preview Zotero library' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })
})
