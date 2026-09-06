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
