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
describe('Zotero import dialog', () => {
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
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { literature: { collect } }
      })
      render(<LiteratureZoteroDialog onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Preview Zotero library' }))
      await screen.findByText('Skipped BADTAG01: use at most 100 tags of 64 characters each.')
      const button = screen.getByRole('button', { name: 'Import references' }) as HTMLButtonElement
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
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { literature: { collect } }
      })
      render(<LiteratureZoteroDialog onClose={vi.fn()} />)
      fireEvent.change(screen.getByLabelText('Zotero collection key (optional)'), {
        target: { value: 'COLLECT1' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Preview Zotero library' }))
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
    Object.defineProperty(window, 'api', { configurable: true, value: { literature: { collect } } })
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    expect(
      (screen.getByRole('button', { name: 'Import references' }) as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Preview Zotero library' }))
    await screen.findByText('A reference')
    fireEvent.click(screen.getByRole('button', { name: 'Import references' }))
    await waitFor(() =>
      expect(collect).toHaveBeenCalledWith({
        kind: 'zotero-commit',
        snapshotId: 'preview-1',
        keys: ['ABCDEFGH'],
        includePdfs: true
      })
    )
    await screen.findByText('PDFKEY01: Missing PDF')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
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
    Object.defineProperty(window, 'api', { configurable: true, value: { literature: { collect } } })
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview Zotero library' }))
    await screen.findByText('Needs review')
    const review = screen.getByRole('checkbox', {
      name: /Changed title.*PDF: 0/
    }) as HTMLInputElement
    const conflict = screen.getByRole('checkbox', {
      name: /Conflicting paper.*PDF: 0/
    }) as HTMLInputElement
    expect(review.checked).toBe(false)
    expect(conflict.checked).toBe(false)
    expect(conflict.disabled).toBe(true)
    expect(screen.getByText('Matched reference: Local title')).toBeTruthy()
    expect(screen.getByText('DOI: 10.1234/original', { exact: false })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(review.checked).toBe(false)
    fireEvent.click(review)
    expect(review.checked).toBe(true)
    expect(conflict.checked).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Import references' }))
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
    Object.defineProperty(window, 'api', { configurable: true, value: { literature: { collect } } })
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview Zotero library' }))
    await screen.findByText('Identifier conflict')
    expect(
      (screen.getByRole('button', { name: 'Import references' }) as HTMLButtonElement).disabled
    ).toBe(true)
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
    Object.defineProperty(window, 'api', { configurable: true, value: { literature: { collect } } })
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Zotero collection key (optional)'), {
      target: { value: 'COLLECT1' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview Zotero library' }))
    await screen.findByText('New reference')
    fireEvent.click(screen.getByRole('button', { name: 'Import references' }))
    await screen.findByText(
      'The library changed since this preview. Preview again before importing.'
    )
    expect(screen.queryByText('Paper')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Import references' }) as HTMLButtonElement).disabled
    ).toBe(true)
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
    Object.defineProperty(window, 'api', { configurable: true, value: { literature: { collect } } })
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview Zotero library' }))
    await screen.findByText('Identifier conflict')
    fireEvent.click(screen.getByText('Compare references'))
    expect(screen.getByText('Ada Lovelace', { exact: false })).toBeTruthy()
    expect(screen.getByText('Grace Hopper', { exact: false })).toBeTruthy()
    expect(screen.getByText('Local journal')).toBeTruthy()
    fireEvent.click(screen.getByText('Import options'))
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
      name: /Corrected title.*PDF: 0/
    }) as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: 'Import references' }))
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
    Object.defineProperty(window, 'api', { configurable: true, value: { literature: { collect } } })
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview Zotero library' }))
    await screen.findByText('Identifier conflict')
    expect(
      (screen.getByRole('checkbox', { name: /Conflict.*PDF: 0/ }) as HTMLInputElement).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /Skipped.*PDF: 0/ }))
    fireEvent.click(screen.getAllByText('Import options')[0])
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
    const checkbox = screen.getByRole('checkbox', { name: /Conflict.*PDF: 0/ }) as HTMLInputElement
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.checked).toBe(true)
    expect(
      (screen.getByRole('checkbox', { name: /Skipped.*PDF: 0/ }) as HTMLInputElement).checked
    ).toBe(false)
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
    Object.defineProperty(window, 'api', { configurable: true, value: { literature: { collect } } })
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview Zotero library' }))
    await screen.findByText('Collections: 2')
    const button = screen.getByRole('button', { name: 'Import references' }) as HTMLButtonElement
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
    Object.defineProperty(window, 'api', { configurable: true, value: { literature: { collect } } })
    render(<LiteratureZoteroDialog onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Zotero collection key (optional)'), {
      target: { value: 'COLLECT1' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview Zotero library' }))
    await screen.findByText('Zotero unavailable')
    expect(
      (screen.getByLabelText('Zotero collection key (optional)') as HTMLInputElement).value
    ).toBe('COLLECT1')
    expect(
      (screen.getByRole('button', { name: 'Preview Zotero library' }) as HTMLButtonElement).disabled
    ).toBe(false)
  })
})
