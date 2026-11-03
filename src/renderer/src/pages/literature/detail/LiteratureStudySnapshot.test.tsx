// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import {
  literatureSnapshotSource,
  type LiteratureSnapshotResult
} from '../../../../../shared/literature-snapshot'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import { LiteratureStudySnapshot } from './LiteratureStudySnapshot'

const studySnapshot = vi.fn()
const readSnapshot = vi.fn()
const { render } = createLiteratureTestRenderer({
  get api() {
    return window.api
  }
})
const item: LiteratureItemView = {
  id: 'paper',
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Paper',
    abstract: 'Study abstract'
  }),
  attachments: [],
  collectionIds: [],
  projectIds: []
}
const result: LiteratureSnapshotResult = {
  sourceKey: literatureSnapshotSource(item).key,
  model: 'test-model',
  coverage: 'abstract',
  sections: {
    question: 'Does it work?',
    population: 'Adults',
    methods: 'Randomized trial',
    results: 'No significant difference',
    limitations: null
  }
}
beforeEach(() => {
  studySnapshot.mockReset().mockResolvedValue(result)
  readSnapshot
    .mockReset()
    .mockResolvedValue({ sourceKey: result.sourceKey, issue: 'not-generated' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        studySnapshot: (request: { mode?: string }) =>
          request.mode === 'read' ? readSnapshot(request) : studySnapshot(request)
      }
    }
  })
})
afterEach(cleanup)
const clickGenerate = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Generate overview' }))
}

describe('Study overview in reference details', () => {
  it('generates only on click and shows structured source-aware results', async () => {
    render(
      <StrictMode>
        <LiteratureStudySnapshot item={item} />
      </StrictMode>
    )
    expect(studySnapshot).not.toHaveBeenCalled()
    clickGenerate()
    expect(await screen.findByText('Does it work?')).toBeTruthy()
    expect(screen.getByText('Randomized trial')).toBeTruthy()
    expect(screen.getByText('Based on abstract')).toBeTruthy()
    expect(screen.getByText('Not reported in the available source')).toBeTruthy()
    expect(screen.getByText('AI-generated. Verify against the original paper.')).toBeTruthy()
    expect(studySnapshot).toHaveBeenCalledWith({
      itemId: 'paper',
      expectedSourceKey: literatureSnapshotSource(item).key,
      language: 'en'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await waitFor(() => expect(studySnapshot).toHaveBeenCalledTimes(2))
  })
  it('restores a saved result on mount without generating again', async () => {
    readSnapshot.mockResolvedValueOnce(result)
    const first = render(<LiteratureStudySnapshot item={item} />)
    await screen.findByText('Does it work?')
    expect(studySnapshot).not.toHaveBeenCalled()
    first.unmount()
    readSnapshot.mockResolvedValueOnce(result)
    render(<LiteratureStudySnapshot item={item} />)
    await screen.findByText('Does it work?')
    expect(studySnapshot).not.toHaveBeenCalled()
  })
  it('does not overwrite a regenerated result with a late saved result', async () => {
    let finish!: (value: LiteratureSnapshotResult) => void
    readSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    await act(async () =>
      finish({ ...result, sections: { ...result.sections, question: 'Old saved question' } })
    )
    expect(screen.queryByText('Old saved question')).toBeNull()
    expect(screen.getByText('Does it work?')).toBeTruthy()
  })
  it('disables generation when the source is absent', () => {
    render(<LiteratureStudySnapshot item={{ ...item, item: { ...item.item, abstract: '' } }} />)
    expect(
      (screen.getByRole('button', { name: 'Generate overview' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      screen.getByText('Add an abstract or readable full-text PDF to generate an overview.')
    ).toBeTruthy()
  })
  it('prevents duplicate clicks while generation is pending', async () => {
    let finish!: (value: LiteratureSnapshotResult) => void
    studySnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    fireEvent.click(screen.getByRole('button', { name: 'Generating overview…' }))
    expect(studySnapshot).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('Reading the available source')
    await act(async () => finish(result))
  })
  it('shows a retry action after failure without exposing raw model errors', async () => {
    studySnapshot.mockRejectedValueOnce(new Error('Private transport details'))
    render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not generate the overview. Please try again.'
    )
    expect(screen.queryByText('Private transport details')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Does it work?')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy()
  })
  it('removes an obsolete result and explains that the reference must be reopened', async () => {
    render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    studySnapshot.mockResolvedValueOnce({ sourceKey: result.sourceKey, issue: 'source-changed' })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    const alert = await screen.findByRole('alert')
    expect(screen.queryByText('Does it work?')).toBeNull()
    expect(alert.textContent).toContain(
      'This reference has changed. Reopen its details and try again.'
    )
  })
  it('explains busy admission without blaming model settings', async () => {
    studySnapshot.mockResolvedValueOnce({ sourceKey: result.sourceKey, issue: 'busy' })
    render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Too many overviews are being generated. Try again shortly.'
    )
  })
  it('preserves a valid earlier result after a transient inference failure', async () => {
    render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    studySnapshot.mockRejectedValueOnce(new Error('Transport failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not regenerate the overview. The previous result is still shown. Please try again.'
    )
    expect(screen.getByText('Does it work?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy()
  })
  it('preserves a valid result when another snapshot occupies admission', async () => {
    render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    studySnapshot.mockResolvedValueOnce({ sourceKey: result.sourceKey, issue: 'busy' })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await screen.findByRole('alert')
    expect(screen.getByText('Does it work?')).toBeTruthy()
  })
  it('does not let an issue for another source invalidate the current result', async () => {
    render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    studySnapshot.mockResolvedValueOnce({ sourceKey: 'another-source', issue: 'source-changed' })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    const alert = await screen.findByRole('alert')
    expect(screen.getByText('Does it work?')).toBeTruthy()
    expect(alert.textContent).toContain(
      'Could not regenerate the overview. The previous result is still shown. Please try again.'
    )
  })
  it('reports an input limit without blaming model configuration', async () => {
    const oversized = {
      ...item,
      metadataRevision: 2,
      item: { ...item.item, abstract: 'x'.repeat(60_001) }
    }
    studySnapshot.mockResolvedValueOnce({
      sourceKey: literatureSnapshotSource(oversized).key,
      issue: 'input-too-large'
    })
    render(<LiteratureStudySnapshot item={oversized} />)
    clickGenerate()
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The available source exceeds the overview input limit.'
    )
  })
  it('removes an old result if its only readable source becomes unavailable', async () => {
    const pdfOnly = {
      ...item,
      item: { ...item.item, abstract: '' },
      attachments: [
        {
          id: 'pdf',
          kind: 'fullText',
          title: '',
          sortOrder: 0,
          createdAt: 1,
          updatedAt: 1,
          versions: [
            {
              id: 'v1',
              versionNumber: 1,
              filename: 'paper.pdf',
              contentType: 'application/pdf',
              sizeBytes: 10,
              checksum: 'a'.repeat(64),
              createdAt: 1
            }
          ]
        }
      ]
    }
    const key = literatureSnapshotSource(pdfOnly).key
    studySnapshot.mockResolvedValueOnce({ ...result, sourceKey: key, coverage: 'full-text' })
    const view = render(<LiteratureStudySnapshot item={pdfOnly} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    studySnapshot.mockResolvedValueOnce({ sourceKey: key, issue: 'source-unavailable' })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    const alert = await screen.findByRole('alert')
    expect(screen.queryByText('Does it work?')).toBeNull()
    expect(alert.textContent).toContain(
      'Add an abstract or readable full-text PDF to generate an overview.'
    )
    view.unmount()
  })
  it('discards late responses after switching papers', async () => {
    let finish!: (value: LiteratureSnapshotResult) => void
    studySnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    view.rerender(<LiteratureStudySnapshot item={{ ...item, id: 'other' }} />)
    await act(async () => finish(result))
    expect(screen.queryByText('Does it work?')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate overview' })).toBeTruthy()
  })
  it('invalidates results when metadata changes', async () => {
    const view = render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    view.rerender(<LiteratureStudySnapshot item={{ ...item, metadataRevision: 2 }} />)
    expect(screen.queryByText('Does it work?')).toBeNull()
  })
  it('keeps the displayed result when unrelated attachments change', async () => {
    const view = render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    view.rerender(
      <LiteratureStudySnapshot
        item={{
          ...item,
          attachments: [
            {
              id: 'supplement',
              kind: 'supplementary',
              title: 'Supplement',
              sortOrder: 0,
              versions: [],
              createdAt: 1,
              updatedAt: 1
            }
          ]
        }}
      />
    )
    expect(screen.queryByText('Does it work?')).not.toBeNull()
  })
  it('discards late results after replacing the current PDF without a metadata revision change', async () => {
    const version = {
      id: 'v1',
      versionNumber: 1,
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksum: 'a'.repeat(64),
      createdAt: 1
    }
    const withPdf = {
      ...item,
      attachments: [
        {
          id: 'attachment',
          kind: 'fullText',
          title: '',
          sortOrder: 0,
          createdAt: 1,
          updatedAt: 1,
          versions: [version]
        }
      ]
    }
    let finish!: (value: LiteratureSnapshotResult) => void
    studySnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<LiteratureStudySnapshot item={withPdf} />)
    clickGenerate()
    const replacement = {
      ...withPdf,
      attachments: [
        { ...withPdf.attachments[0], versions: [{ ...version, id: 'v2', versionNumber: 2 }] }
      ]
    }
    view.rerender(<LiteratureStudySnapshot item={replacement} />)
    await act(async () => finish({ ...result, sourceKey: literatureSnapshotSource(withPdf).key }))
    expect(screen.queryByText('Does it work?')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate overview' })).toBeTruthy()
  })
  it.each([{ deletedAt: 0 }, { deletedAt: 1 }, { mergedIntoItemId: 'survivor' }])(
    'clears results and disables generation when the reference becomes inactive: %j',
    async (inactive) => {
      const view = render(<LiteratureStudySnapshot item={item} />)
      clickGenerate()
      await screen.findByText('Does it work?')
      view.rerender(<LiteratureStudySnapshot item={{ ...item, ...inactive }} />)
      expect(screen.queryByText('Does it work?')).toBeNull()
      expect(
        (screen.getByRole('button', { name: 'Generate overview' }) as HTMLButtonElement).disabled
      ).toBe(true)
      expect(screen.getByText('This reference is no longer available.')).toBeTruthy()
    }
  )
  it('rejects a response belonging to a different source', async () => {
    studySnapshot.mockResolvedValue({ ...result, sourceKey: 'other-source' })
    render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    await screen.findByRole('alert')
    expect(screen.queryByText('Does it work?')).toBeNull()
  })
  it('blocks duplicate native clicks before the pending state is committed', async () => {
    let finish!: (value: LiteratureSnapshotResult) => void
    studySnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<LiteratureStudySnapshot item={item} />)
    const button = screen.getByRole('button', { name: 'Generate overview' })
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(studySnapshot).toHaveBeenCalledTimes(1)
    await act(async () => finish(result))
  })
  it('disables generation if only a historical version is a PDF', () => {
    const previous = {
      id: 'v1',
      versionNumber: 1,
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      checksum: 'a'.repeat(64),
      createdAt: 1
    }
    render(
      <LiteratureStudySnapshot
        item={{
          ...item,
          item: { ...item.item, abstract: '' },
          attachments: [
            {
              id: 'attachment',
              kind: 'fullText',
              title: '',
              sortOrder: 0,
              createdAt: 1,
              updatedAt: 1,
              versions: [
                previous,
                { ...previous, id: 'v2', versionNumber: 2, contentType: 'text/plain' }
              ]
            }
          ]
        }}
      />
    )
    expect(
      (screen.getByRole('button', { name: 'Generate overview' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
  it.each(['full-text', 'passages'] as const)('labels %s evidence accurately', async (coverage) => {
    studySnapshot.mockResolvedValue({ ...result, coverage })
    render(<LiteratureStudySnapshot item={item} />)
    clickGenerate()
    expect(
      await screen.findByText(
        coverage === 'full-text' ? 'Based on full text' : 'Based on selected passages'
      )
    ).toBeTruthy()
  })
})
