// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReadingContextPicker } from './ReadingContextPicker'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('ReadingContextPicker', () => {
  it('retries project PDF discovery after a transient load failure', async () => {
    const listFiles = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ items: [], totalCount: 0 })
    vi.stubGlobal('api', {
      projectFiles: { listFiles },
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
})
