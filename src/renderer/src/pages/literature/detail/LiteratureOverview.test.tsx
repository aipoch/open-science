// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import {
  literatureOverviewSource,
  type LiteratureOverviewResult
} from '../../../../../shared/literature-overview'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import { LiteratureOverview } from './LiteratureOverview'

const studySnapshot = vi.fn()
const readOverview = vi.fn()
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
const pdfOnly: LiteratureItemView = {
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

const result: LiteratureOverviewResult = {
  sourceKey: literatureOverviewSource(item).key,
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
const pdfResult: LiteratureOverviewResult = {
  ...result,
  sourceKey: literatureOverviewSource(pdfOnly).key,
  coverage: 'full-text'
}

beforeEach(() => {
  studySnapshot.mockReset().mockResolvedValue(result)
  readOverview
    .mockReset()
    .mockResolvedValue({ sourceKey: result.sourceKey, issue: 'not-generated' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      literature: {
        studySnapshot: (request: { mode?: string }) =>
          request.mode === 'read' ? readOverview(request) : studySnapshot(request)
      }
    }
  })
})
afterEach(cleanup)
const clickGenerate = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Generate overview' }))
}

describe('Paper overview in reference details', () => {
  it.each(['Generate overview', 'Regenerate', 'Retry'])(
    'blocks the %s action during batch generation and restores it afterwards',
    async (action) => {
      if (action === 'Regenerate') readOverview.mockResolvedValue(result)
      const view = render(<LiteratureOverview item={item} />)
      await waitFor(() => expect(readOverview).toHaveBeenCalledTimes(1))
      if (action === 'Retry') {
        studySnapshot.mockRejectedValueOnce(new Error('Failed generation'))
        clickGenerate()
        await screen.findByRole('button', { name: 'Retry' })
      }
      await screen.findByRole('button', { name: action })
      const calls = studySnapshot.mock.calls.length
      view.rerender(<LiteratureOverview item={item} batchGenerating />)
      const generating = screen.getByRole('button', { name: 'Generating overview…' })
      expect(generating).toHaveProperty('disabled', true)
      expect(screen.getByRole('region', { name: 'Paper overview' }).getAttribute('aria-busy')).toBe(
        'true'
      )
      fireEvent.click(generating)
      expect(studySnapshot).toHaveBeenCalledTimes(calls)
      view.rerender(<LiteratureOverview item={item} batchGenerating={false} />)
      expect(screen.getByRole('button', { name: action })).toHaveProperty('disabled', false)
      expect(screen.getByRole('region', { name: 'Paper overview' }).getAttribute('aria-busy')).toBe(
        'false'
      )
      fireEvent.click(screen.getByRole('button', { name: action }))
      await waitFor(() => expect(studySnapshot).toHaveBeenCalledTimes(calls + 1))
    }
  )

  it('generates only on click and shows structured source-aware results', async () => {
    render(
      <StrictMode>
        <LiteratureOverview item={item} />
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
      expectedSourceKey: literatureOverviewSource(item).key,
      language: 'en'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await waitFor(() => expect(studySnapshot).toHaveBeenCalledTimes(2))
  })
  it('restores a saved result on mount without generating again', async () => {
    readOverview.mockResolvedValueOnce(result)
    const first = render(<LiteratureOverview item={item} />)
    await screen.findByText('Does it work?')
    expect(studySnapshot).not.toHaveBeenCalled()
    first.unmount()
    readOverview.mockResolvedValueOnce(result)
    render(<LiteratureOverview item={item} />)
    await screen.findByText('Does it work?')
    expect(studySnapshot).not.toHaveBeenCalled()
  })
  it.each(['while generation is pending', 'after generation completes'] as const)(
    'keeps a late batch refresh subordinate to manual generation: %s',
    async (completionOrder) => {
      const view = render(<LiteratureOverview item={item} overviewRevision={0} />)
      await waitFor(() => expect(readOverview).toHaveBeenCalledTimes(1))
      const refresh = Promise.withResolvers<LiteratureOverviewResult>()
      const manual = Promise.withResolvers<LiteratureOverviewResult>()
      readOverview.mockReturnValueOnce(refresh.promise)
      studySnapshot.mockReturnValueOnce(manual.promise)
      const overview = screen.getByRole('region', { name: 'Paper overview' })
      view.rerender(<LiteratureOverview item={item} overviewRevision={1} />)
      await waitFor(() => expect(readOverview).toHaveBeenCalledTimes(2))
      clickGenerate()
      expect(screen.getByRole('region', { name: 'Paper overview' })).toBe(overview)
      expect(overview.getAttribute('aria-busy')).toBe('true')
      expect(readOverview).toHaveBeenCalledTimes(2)
      const stale = { ...result, sections: { ...result.sections, question: 'Old batch result' } }
      const fresh = { ...result, sections: { ...result.sections, question: 'New manual result' } }
      if (completionOrder === 'while generation is pending') {
        await act(async () => {
          refresh.resolve(stale)
          await refresh.promise
        })
        expect(screen.queryByText('Old batch result')).toBeNull()
        expect(overview.getAttribute('aria-busy')).toBe('true')
        expect(screen.getByRole('button', { name: 'Generating overview…' })).toHaveProperty(
          'disabled',
          true
        )
        // Check this only after settling the first read, so effect cleanup cannot mask a missing
        // generation guard in the race assertions above or below.
        view.rerender(<LiteratureOverview item={item} overviewRevision={2} />)
        expect(readOverview).toHaveBeenCalledTimes(2)
        expect(screen.getByRole('region', { name: 'Paper overview' })).toBe(overview)
        expect(overview.getAttribute('aria-busy')).toBe('true')
      }
      await act(async () => {
        manual.resolve(fresh)
        await manual.promise
      })
      await screen.findByText('New manual result')
      if (completionOrder === 'after generation completes')
        await act(async () => {
          refresh.resolve(stale)
          await refresh.promise
        })
      expect(screen.queryByText('Old batch result')).toBeNull()
      expect(screen.getByText('New manual result')).toBeTruthy()
      expect(studySnapshot).toHaveBeenCalledTimes(1)
      expect(readOverview).toHaveBeenCalledTimes(2)
      expect(overview.getAttribute('aria-busy')).toBe('false')
    }
  )

  it('recovers a batch save when a pending refresh is invalidated by failed manual generation', async () => {
    const view = render(<LiteratureOverview item={item} overviewRevision={0} />)
    await waitFor(() => expect(readOverview).toHaveBeenCalledTimes(1))
    const refresh = Promise.withResolvers<LiteratureOverviewResult>()
    const manual = Promise.withResolvers<LiteratureOverviewResult>()
    readOverview.mockReturnValueOnce(refresh.promise).mockResolvedValueOnce({
      ...result,
      sections: { ...result.sections, question: 'Fresh persisted batch result' }
    })
    view.rerender(<LiteratureOverview item={item} overviewRevision={1} />)
    await waitFor(() => expect(readOverview).toHaveBeenCalledTimes(2))
    studySnapshot.mockReturnValueOnce(manual.promise)
    clickGenerate()

    await act(async () => {
      manual.reject(new Error('Manual inference failed'))
    })
    await act(async () => {
      refresh.resolve({
        ...result,
        sections: { ...result.sections, question: 'Earlier pending read' }
      })
      await refresh.promise
    })

    await screen.findByText('Fresh persisted batch result')
    expect(screen.queryByText('Earlier pending read')).toBeNull()
    expect(readOverview).toHaveBeenCalledTimes(3)
    expect(studySnapshot).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not regenerate the overview. The previous result is still shown. Please try again.'
    )
  })

  it('reads a deferred batch save after overlapping manual generation fails', async () => {
    const view = render(<LiteratureOverview item={item} overviewRevision={0} />)
    await waitFor(() => expect(readOverview).toHaveBeenCalledTimes(1))
    const manual = Promise.withResolvers<LiteratureOverviewResult>()
    studySnapshot.mockReturnValueOnce(manual.promise)
    clickGenerate()
    readOverview.mockResolvedValueOnce({
      ...result,
      sections: { ...result.sections, question: 'Saved while manual generation failed' }
    })
    view.rerender(<LiteratureOverview item={item} overviewRevision={1} />)
    expect(readOverview).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('region', { name: 'Paper overview' }).getAttribute('aria-busy')).toBe(
      'true'
    )

    await act(async () => {
      manual.reject(new Error('Manual inference failed'))
    })

    await screen.findByText('Saved while manual generation failed')
    expect(readOverview).toHaveBeenCalledTimes(2)
    expect(studySnapshot).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not regenerate the overview. The previous result is still shown. Please try again.'
    )
    expect(screen.getByRole('region', { name: 'Paper overview' }).getAttribute('aria-busy')).toBe(
      'false'
    )
  })

  it.each(['source-changed', 'source-unavailable'] as const)(
    'does not revive invalid source cache after %s until a manual Retry succeeds',
    async (issue) => {
      const initial = Promise.withResolvers<LiteratureOverviewResult>()
      const old = {
        ...pdfResult,
        sections: { ...result.sections, question: 'Invalidated cached answer' }
      }
      readOverview.mockReturnValueOnce(initial.promise).mockResolvedValue(old)
      studySnapshot.mockResolvedValueOnce({ sourceKey: pdfResult.sourceKey, issue })
      const view = render(<LiteratureOverview item={pdfOnly} overviewRevision={0} />)
      await waitFor(() => expect(readOverview).toHaveBeenCalledTimes(1))

      clickGenerate()

      await screen.findByRole('alert')
      await act(async () => {
        initial.resolve(old)
        await initial.promise
      })
      expect(screen.queryByText('Invalidated cached answer')).toBeNull()
      expect(readOverview).toHaveBeenCalledTimes(1)
      // A later completion notification carries no authority to make an invalid source readable.
      view.rerender(<LiteratureOverview item={pdfOnly} overviewRevision={1} />)
      await act(async () => {})
      expect(screen.queryByText('Invalidated cached answer')).toBeNull()
      expect(readOverview).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('alert').textContent).toContain(
        issue === 'source-changed'
          ? 'This reference has changed. Reopen its details and try again.'
          : 'Add an abstract or readable full-text PDF to generate an overview.'
      )
      studySnapshot.mockResolvedValueOnce({
        ...pdfResult,
        sections: { ...result.sections, question: 'Valid manual Retry answer' }
      })

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

      await screen.findByText('Valid manual Retry answer')
      expect(screen.getByText('Based on full text')).toBeTruthy()
      expect(screen.queryByRole('alert')).toBeNull()
      readOverview.mockResolvedValueOnce({
        ...pdfResult,
        sections: { ...result.sections, question: 'Saved after source recovery' }
      })
      view.rerender(<LiteratureOverview item={pdfOnly} overviewRevision={2} />)
      await screen.findByText('Saved after source recovery')
      expect(readOverview).toHaveBeenCalledTimes(2)
      expect(studySnapshot).toHaveBeenCalledTimes(2)
    }
  )

  it('does not run a deferred batch read after manual generation invalidates its source', async () => {
    readOverview.mockResolvedValueOnce(pdfResult)
    const view = render(<LiteratureOverview item={pdfOnly} overviewRevision={0} />)
    await screen.findByText('Does it work?')
    expect(screen.getByText('Based on full text')).toBeTruthy()
    const manual = Promise.withResolvers<LiteratureOverviewResult>()
    studySnapshot.mockReturnValueOnce(manual.promise)
    readOverview.mockResolvedValue({
      ...pdfResult,
      sections: { ...result.sections, question: 'Invalidated deferred cache' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    view.rerender(<LiteratureOverview item={pdfOnly} overviewRevision={1} />)
    expect(readOverview).toHaveBeenCalledTimes(1)

    await act(async () => {
      manual.resolve({ sourceKey: pdfResult.sourceKey, issue: 'source-unavailable' })
      await manual.promise
    })

    expect(screen.queryByText('Does it work?')).toBeNull()
    expect(screen.queryByText('Invalidated deferred cache')).toBeNull()
    expect(readOverview).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toContain(
      'Add an abstract or readable full-text PDF to generate an overview.'
    )
  })

  it('preserves a failed manual request after restoring old initial cache until Retry succeeds', async () => {
    const initial = Promise.withResolvers<LiteratureOverviewResult>()
    readOverview.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(result)
    studySnapshot.mockRejectedValueOnce(new Error('Manual transport failed'))
    render(<LiteratureOverview item={item} />)
    await waitFor(() => expect(readOverview).toHaveBeenCalledTimes(1))

    clickGenerate()

    await screen.findByText('Does it work?')
    await waitFor(() => expect(readOverview).toHaveBeenCalledTimes(2))
    await act(async () => {
      initial.resolve(result)
      await initial.promise
    })
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not regenerate the overview. The previous result is still shown. Please try again.'
    )
    expect(screen.getByText('Does it work?')).toBeTruthy()
    expect(studySnapshot).toHaveBeenCalledTimes(1)
    studySnapshot.mockResolvedValueOnce({
      ...result,
      sections: { ...result.sections, question: 'New result from successful Retry' }
    })

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await screen.findByText('New result from successful Retry')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(studySnapshot).toHaveBeenCalledTimes(2)
    expect(readOverview).toHaveBeenCalledTimes(2)
  })

  it('does not overwrite a regenerated result with a late saved result', async () => {
    let finish!: (value: LiteratureOverviewResult) => void
    readOverview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<LiteratureOverview item={item} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    await act(async () =>
      finish({ ...result, sections: { ...result.sections, question: 'Old saved question' } })
    )
    expect(screen.queryByText('Old saved question')).toBeNull()
    expect(screen.getByText('Does it work?')).toBeTruthy()
  })
  it('disables generation when the source is absent', () => {
    render(<LiteratureOverview item={{ ...item, item: { ...item.item, abstract: '' } }} />)
    expect(
      (screen.getByRole('button', { name: 'Generate overview' }) as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      screen.getByText('Add an abstract or readable full-text PDF to generate an overview.')
    ).toBeTruthy()
  })
  it('prevents duplicate clicks while generation is pending', async () => {
    let finish!: (value: LiteratureOverviewResult) => void
    studySnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<LiteratureOverview item={item} />)
    clickGenerate()
    fireEvent.click(screen.getByRole('button', { name: 'Generating overview…' }))
    expect(studySnapshot).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('Reading the available source')
    await act(async () => finish(result))
  })
  it('shows a retry action after failure without exposing raw model errors', async () => {
    studySnapshot.mockRejectedValueOnce(new Error('Private transport details'))
    render(<LiteratureOverview item={item} />)
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
    render(<LiteratureOverview item={item} />)
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
    render(<LiteratureOverview item={item} />)
    clickGenerate()
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Too many overviews are being generated. Try again shortly.'
    )
  })
  it('preserves a valid earlier result after a transient inference failure', async () => {
    render(<LiteratureOverview item={item} />)
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
  it('preserves a valid result when another overview occupies admission', async () => {
    render(<LiteratureOverview item={item} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    studySnapshot.mockResolvedValueOnce({ sourceKey: result.sourceKey, issue: 'busy' })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await screen.findByRole('alert')
    expect(screen.getByText('Does it work?')).toBeTruthy()
  })
  it('does not let an issue for another source invalidate the current result', async () => {
    render(<LiteratureOverview item={item} />)
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
      sourceKey: literatureOverviewSource(oversized).key,
      issue: 'input-too-large'
    })
    render(<LiteratureOverview item={oversized} />)
    clickGenerate()
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The available source exceeds the overview input limit.'
    )
  })
  it('removes an old result if its only readable source becomes unavailable', async () => {
    const key = literatureOverviewSource(pdfOnly).key
    studySnapshot.mockResolvedValueOnce({ ...result, sourceKey: key, coverage: 'full-text' })
    const view = render(<LiteratureOverview item={pdfOnly} />)
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
    let finish!: (value: LiteratureOverviewResult) => void
    studySnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<LiteratureOverview item={item} />)
    clickGenerate()
    view.rerender(<LiteratureOverview item={{ ...item, id: 'other' }} />)
    await act(async () => finish(result))
    expect(screen.queryByText('Does it work?')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate overview' })).toBeTruthy()
  })
  it('invalidates results when metadata changes', async () => {
    const view = render(<LiteratureOverview item={item} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    view.rerender(<LiteratureOverview item={{ ...item, metadataRevision: 2 }} />)
    expect(screen.queryByText('Does it work?')).toBeNull()
  })
  it('keeps the displayed result when unrelated attachments change', async () => {
    const view = render(<LiteratureOverview item={item} />)
    clickGenerate()
    await screen.findByText('Does it work?')
    view.rerender(
      <LiteratureOverview
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
    let finish!: (value: LiteratureOverviewResult) => void
    studySnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<LiteratureOverview item={withPdf} />)
    clickGenerate()
    const replacement = {
      ...withPdf,
      attachments: [
        { ...withPdf.attachments[0], versions: [{ ...version, id: 'v2', versionNumber: 2 }] }
      ]
    }
    view.rerender(<LiteratureOverview item={replacement} />)
    await act(async () => finish({ ...result, sourceKey: literatureOverviewSource(withPdf).key }))
    expect(screen.queryByText('Does it work?')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate overview' })).toBeTruthy()
  })
  it.each([{ deletedAt: 0 }, { deletedAt: 1 }, { mergedIntoItemId: 'survivor' }])(
    'clears results and disables generation when the reference becomes inactive: %j',
    async (inactive) => {
      const view = render(<LiteratureOverview item={item} />)
      clickGenerate()
      await screen.findByText('Does it work?')
      view.rerender(<LiteratureOverview item={{ ...item, ...inactive }} />)
      expect(screen.queryByText('Does it work?')).toBeNull()
      expect(
        (screen.getByRole('button', { name: 'Generate overview' }) as HTMLButtonElement).disabled
      ).toBe(true)
      expect(screen.getByText('This reference is no longer available.')).toBeTruthy()
    }
  )
  it('rejects a response belonging to a different source', async () => {
    studySnapshot.mockResolvedValue({ ...result, sourceKey: 'other-source' })
    render(<LiteratureOverview item={item} />)
    clickGenerate()
    await screen.findByRole('alert')
    expect(screen.queryByText('Does it work?')).toBeNull()
  })
  it('blocks duplicate native clicks before the pending state is committed', async () => {
    let finish!: (value: LiteratureOverviewResult) => void
    studySnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render(<LiteratureOverview item={item} />)
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
      <LiteratureOverview
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
    render(<LiteratureOverview item={item} />)
    clickGenerate()
    expect(
      await screen.findByText(
        coverage === 'full-text' ? 'Based on full text' : 'Based on selected passages'
      )
    ).toBeTruthy()
  })
})
