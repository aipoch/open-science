// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProjectFileItem } from '../../../../shared/project-files'

import { ReadingContextPicker } from './ReadingContextPicker'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('ReadingContextPicker', () => {
  const paper = {
    id: 'item-101',
    item: { title: 'older.pdf', creators: [] },
    attachments: [
      {
        kind: 'supplementary',
        versions: [
          {
            id: 'version-101',
            filename: 'supplement.pdf',
            contentType: 'application/pdf',
            sizeBytes: 42,
            pageCount: 2,
            versionNumber: 1,
            createdAt: 1
          }
        ]
      }
    ]
  }
  const openPicker = (): void => {
    render(
      <ReadingContextPicker
        projectId="project-1"
        linkedSources={[]}
        atLimit={false}
        onSelect={vi.fn()}
      >
        <button type="button">Reading</button>
      </ReadingContextPicker>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reading' }))
  }
  const installApi = (search = vi.fn().mockResolvedValue({ entries: [paper] })): void => {
    vi.stubGlobal('api', {
      literature: { search },
      projectFiles: { listFiles: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }) },
      sessions: {
        filterPdfContextCandidates: vi.fn(async ({ sources }) => ({
          sources,
          pendingAttachmentIds: []
        }))
      }
    })
  }

  it('LR-01 finds a supplementary PDF after 100 metadata-only project records', async () => {
    const search = vi.fn(async ({ offset = 0 }) =>
      offset === 0
        ? {
            entries: Array.from({ length: 100 }, (_, id) => ({
              ...paper,
              id: `metadata-${id}`,
              attachments: []
            })),
            totalCount: 101,
            nextOffset: 100
          }
        : { entries: [paper], totalCount: 101 }
    )
    installApi(search)
    openPicker()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search PDFs' }), {
      target: { value: paper.item.title }
    })
    expect(await screen.findByRole('option', { name: paper.item.title })).not.toBeNull()
    expect(search).toHaveBeenLastCalledWith({
      scope: 'library',
      projectId: 'project-1',
      limit: 100,
      offset: 100
    })
  })

  it('LR-02 shows healthy candidates with a partial-failure warning and retry', async () => {
    installApi()
    const filter = vi.mocked(window.api.sessions.filterPdfContextCandidates)
    filter.mockResolvedValueOnce({
      sources: [{ sourceKind: 'literature-attachment-version', sourceVersionId: 'version-101' }],
      pendingAttachmentIds: [],
      unavailableSources: [{ sourceKind: 'literature-attachment-version', sourceVersionId: 'bad' }]
    })
    openPicker()
    expect(await screen.findByRole('option', { name: paper.item.title })).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Some PDFs are unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('option', { name: paper.item.title })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('LR-03 reports a literature database failure and retries project discovery', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error('database read failed'))
      .mockResolvedValueOnce({ entries: [paper] })
    installApi(search)
    openPicker()
    expect(await screen.findByRole('alert')).not.toBeNull()
    expect(screen.queryByText('No multi-page PDFs available')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('option', { name: paper.item.title })).not.toBeNull()
  })

  it.each(['Project', 'Library'])(
    'LR-04 keeps results when clicking the active %s tab',
    async (tab) => {
      const search = vi.fn().mockResolvedValue({ entries: [paper] })
      installApi(search)
      openPicker()
      await screen.findByRole('option', { name: paper.item.title })
      if (tab === 'Library') {
        fireEvent.click(screen.getByRole('button', { name: tab }))
        await screen.findByRole('option', { name: paper.item.title })
      }
      const calls = search.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: tab }))
      expect(await screen.findByRole('option', { name: paper.item.title })).not.toBeNull()
      expect(screen.queryByText('Checking PDFs…')).toBeNull()
      expect(search).toHaveBeenCalledTimes(calls)
    }
  )

  it('hides stale project PDFs and prevents selection while the next project loads', async () => {
    const file = (projectId: string): ProjectFileItem => ({
      id: projectId,
      source: 'upload',
      sourceFileId: `upload-${projectId}`,
      sourceVersionId: `version-${projectId}`,
      projectId,
      sessionId: 'source-session',
      name: `${projectId}-only.pdf`,
      path: `${projectId}.pdf`,
      mimeType: 'application/pdf',
      size: 20,
      sortAtMs: 1
    })
    const first = { items: [file('A')], totalCount: 1 }
    const second = { items: [file('B')], totalCount: 1 }
    let resolveSecond!: (value: typeof second) => void
    const loadingSecond = new Promise<typeof second>((resolve) => {
      resolveSecond = resolve
    })
    const listFiles = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(loadingSecond)
    vi.stubGlobal('api', {
      projectFiles: { listFiles },
      literature: { search: vi.fn().mockResolvedValue({ entries: [] }) },
      sessions: { filterPdfContextCandidates: vi.fn(async ({ sources }) => ({ sources })) }
    })
    const selectFirst = vi.fn().mockResolvedValue(undefined)
    const selectSecond = vi.fn().mockRejectedValue(new Error('keep picker open'))
    const picker = (projectId: string, onSelect: typeof selectFirst): React.JSX.Element => (
      <ReadingContextPicker
        projectId={projectId}
        linkedSources={[]}
        atLimit={false}
        onSelect={onSelect}
      >
        <button type="button">Reading</button>
      </ReadingContextPicker>
    )
    const view = render(picker('A', selectFirst))
    fireEvent.click(screen.getByRole('button', { name: 'Reading' }))
    await screen.findByRole('option', { name: 'A-only.pdf' })

    view.rerender(picker('B', selectSecond))
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
    const stale = screen.queryByRole('option', { name: 'A-only.pdf' })
    expect.soft(stale).toBeNull()
    expect.soft(screen.queryByText('Checking PDFs…')).not.toBeNull()
    if (stale)
      await act(async () => {
        fireEvent.click(stale)
      })
    expect.soft(selectSecond).not.toHaveBeenCalled()
    expect(selectFirst).not.toHaveBeenCalled()

    selectSecond.mockClear().mockResolvedValue(undefined)
    await act(async () => {
      resolveSecond(second)
    })
    fireEvent.click(await screen.findByRole('option', { name: 'B-only.pdf' }))
    await waitFor(() =>
      expect(selectSecond).toHaveBeenCalledWith({
        sourceKind: 'upload-version',
        sourceFileId: 'upload-B',
        sourceVersionId: 'version-B'
      })
    )
  })

  it('retries project PDF discovery after a transient load failure', async () => {
    const listFiles = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ items: [], totalCount: 0 })
    vi.stubGlobal('api', {
      projectFiles: { listFiles },
      literature: { search: vi.fn().mockResolvedValue({ entries: [] }) },
      sessions: { filterPdfContextCandidates: vi.fn() }
    })

    render(
      <ReadingContextPicker
        projectId="project-1"
        linkedSources={[]}
        atLimit={false}
        onSelect={vi.fn()}
      >
        <button type="button">Reading</button>
      </ReadingContextPicker>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Reading' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No multi-page PDFs available')).not.toBeNull()
  })

  it('offers only multi-page PDFs and links the selected immutable Version', async () => {
    const listFiles = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'multi',
          source: 'artifact',
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-multi',
          projectId: 'project-1',
          sessionId: 'source-session',
          name: 'multi.pdf',
          path: 'multi.pdf',
          mimeType: 'application/pdf',
          size: 20,
          sortAtMs: 2
        },
        {
          id: 'single',
          source: 'upload',
          sourceFileId: 'upload-1',
          sourceVersionId: 'version-single',
          projectId: 'project-1',
          sessionId: 'source-session',
          name: 'single.pdf',
          path: 'single.pdf',
          mimeType: 'application/pdf',
          size: 10,
          sortAtMs: 1
        },
        {
          id: 'notes',
          source: 'upload',
          sourceFileId: 'upload-2',
          sourceVersionId: 'version-notes',
          projectId: 'project-1',
          sessionId: 'source-session',
          name: 'notes.txt',
          path: 'notes.txt',
          mimeType: 'text/plain',
          size: 5,
          sortAtMs: 0
        }
      ],
      totalCount: 3
    })
    const filterPdfContextCandidates = vi.fn().mockResolvedValue({
      sources: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-multi'
        }
      ],
      pendingAttachmentIds: []
    })
    vi.stubGlobal('api', {
      projectFiles: { listFiles },
      literature: { search: vi.fn().mockResolvedValue({ entries: [] }) },
      sessions: { filterPdfContextCandidates }
    })
    const onSelect = vi.fn().mockResolvedValue(undefined)

    render(
      <ReadingContextPicker
        projectId="project-1"
        linkedSources={[]}
        atLimit={false}
        onSelect={onSelect}
      >
        <button type="button">Reading</button>
      </ReadingContextPicker>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Reading' }))

    expect(await screen.findByRole('option', { name: 'multi.pdf' })).not.toBeNull()
    expect(screen.queryByText('single.pdf')).toBeNull()
    expect(screen.queryByText('notes.txt')).toBeNull()
    expect(filterPdfContextCandidates).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: [
        {
          sourceKind: 'artifact-version',
          sourceFileId: 'artifact-1',
          sourceVersionId: 'version-multi'
        },
        {
          sourceKind: 'upload-version',
          sourceFileId: 'upload-1',
          sourceVersionId: 'version-single'
        }
      ]
    })

    fireEvent.click(screen.getByRole('option', { name: 'multi.pdf' }))
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledWith({
        sourceKind: 'artifact-version',
        sourceFileId: 'artifact-1',
        sourceVersionId: 'version-multi'
      })
    )
  })

  it('links an eligible PDF selected from the user Literature library', async () => {
    const search = vi.fn().mockResolvedValue({
      entries: [
        {
          id: 'literature-item-1',
          item: {
            itemType: 'journalArticle',
            title: 'Corrective Retrieval Augmented Generation',
            abstract: '',
            issuedText: '2024',
            issuedYear: 2024,
            containerTitle: 'arXiv',
            shortTitle: 'CRAG',
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
            identifiers: []
          },
          attachments: [
            {
              id: 'attachment-1',
              kind: 'fullText',
              title: '',
              sortOrder: 0,
              versions: [
                {
                  id: 'literature-version-1',
                  versionNumber: 1,
                  filename: 'crag.pdf',
                  contentType: 'application/pdf',
                  sizeBytes: 629,
                  checksum: 'a'.repeat(64),
                  pageCount: 14,
                  createdAt: 2
                }
              ],
              createdAt: 2,
              updatedAt: 2
            }
          ],
          projectIds: ['project-1'],
          collectionIds: [],
          metadataRevision: 1,
          createdAt: 1,
          updatedAt: 2
        }
      ]
    })
    const literatureSource = {
      sourceKind: 'literature-attachment-version' as const,
      sourceVersionId: 'literature-version-1'
    }
    const filterPdfContextCandidates = vi.fn().mockResolvedValue({
      sources: [literatureSource],
      pendingAttachmentIds: []
    })
    const onSelect = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('api', {
      projectFiles: { listFiles: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }) },
      literature: { search },
      sessions: { filterPdfContextCandidates }
    })

    render(
      <ReadingContextPicker
        projectId="project-1"
        linkedSources={[]}
        atLimit={false}
        onSelect={onSelect}
      >
        <button type="button">Reading</button>
      </ReadingContextPicker>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Reading' }))

    expect(
      await screen.findByRole('option', { name: /Corrective Retrieval Augmented Generation/u })
    ).not.toBeNull()
    expect(search).toHaveBeenCalledWith({
      scope: 'library',
      projectId: 'project-1',
      limit: 100
    })
    fireEvent.click(screen.getByRole('button', { name: 'Library' }))

    const option = await screen.findByRole('option', {
      name: /Corrective Retrieval Augmented Generation/u
    })
    expect(option.textContent).toContain('Yan, Shi-Qi · 2024')
    expect(search).toHaveBeenCalledWith({ scope: 'library', limit: 100 })
    expect(filterPdfContextCandidates).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: [literatureSource]
    })

    fireEvent.click(option)
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(literatureSource))
  })
})
