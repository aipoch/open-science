import type { PdfTranslationCheckpoint } from '../../../../../../shared/pdf-translation'
import { createPdfTranslationSource } from './pdf-translation'
import { getPdfTranslationLayoutSnapshot } from './pdf-translation-snapshot'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePdfTranslationPreparation } from './use-pdf-translation-preparation'
import {
  extractPdfTranslationSource,
  type PdfTranslationExtraction
} from './pdf-translation-extraction'
import { applyCachedPdfTableSources } from './pdf-translation-table-source'
import type { PDFDocumentProxy } from 'pdfjs-dist'
vi.mock('./pdf-translation-table-source', () => ({ applyCachedPdfTableSources: vi.fn() }))
vi.mock('./pdf-translation-extraction', () => ({ extractPdfTranslationSource: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('reader-owned PDF preparation', () => {
  let root: Root, container: HTMLDivElement
  let current: ReturnType<typeof usePdfTranslationPreparation>
  let document: Pick<PDFDocumentProxy, 'getPage' | 'numPages' | 'fingerprints'>
  const ready: PdfTranslationExtraction = {
    source: createPdfTranslationSource({
      resourceRequestKey: 'v1',
      fingerprint: 'test',
      pages: [
        { width: 612, height: 792 },
        { width: 612, height: 792 }
      ],
      units: [
        {
          id: 'saved-unit',
          source: 'A paragraph.',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
              items: [{ index: 0, text: 'A paragraph.' }]
            }
          ]
        }
      ]
    }),
    coverage: {
      pageCount: 2,
      textItemCount: 1,
      includedItemCount: 1,
      excludedItemCount: 0,
      pagesWithoutText: [2],
      exclusions: [],
      warnings: []
    }
  }
  let checkpoint: PdfTranslationCheckpoint | undefined
  const sourceIdentity = Object.freeze({ sourceChecksum: 'a'.repeat(64), sourceSizeBytes: 100 })
  let useTables = false
  function Harness({ owner, identity }: { owner: typeof document | null; identity: string }): null {
    current = usePdfTranslationPreparation(
      owner,
      identity,
      useTables ? 'version' : undefined,
      useTables ? sourceIdentity : undefined,
      checkpoint
    )
    return null
  }
  beforeEach(() => {
    container = window.document.createElement('div')
    window.document.body.appendChild(container)
    root = createRoot(container)
    document = { numPages: 2, fingerprints: ['test'], getPage: vi.fn() }
    vi.mocked(extractPdfTranslationSource).mockReset()
    vi.mocked(applyCachedPdfTableSources).mockReset()
    useTables = false
    checkpoint = undefined
    window.api = {
      pdfStructure: { readCached: vi.fn().mockResolvedValue(undefined), parse: vi.fn() }
    } as never
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  const render = async (
    owner: typeof document | null = document,
    identity = 'v1'
  ): Promise<void> => {
    await act(async () => root.render(<Harness owner={owner} identity={identity} />))
  }
  it('switches each edition to its own pinned layout for identical PDF bytes', async () => {
    const snapshot = {
      version: 1 as const,
      parserVersion: 'first-parser',
      fingerprint: ready.source.fingerprint,
      pages: ready.source.pages,
      units: ready.source.units,
      coverage: ready.coverage
    }
    checkpoint = { key: 'first', layoutSnapshot: snapshot } as PdfTranslationCheckpoint
    await render()
    if (current.state.status !== 'ready') throw new Error('Expected restored layout')
    const firstSource = current.state.extraction.source
    checkpoint = {
      key: 'second',
      layoutSnapshot: {
        ...snapshot,
        parserVersion: 'second-parser',
        units: snapshot.units.map((unit) => ({
          ...unit,
          id: 'other-unit',
          fragments: unit.fragments.map((fragment) => ({
            ...fragment,
            rect: { ...fragment.rect, y: 0.6 }
          }))
        }))
      }
    } as PdfTranslationCheckpoint
    await render()
    if (current.state.status !== 'ready') throw new Error('Expected restored layout')
    expect(current.state.extraction.source).not.toBe(firstSource)
    expect(current.state.extraction.source.units[0].id).toBe('other-unit')
    expect(current.state.extraction.source.units[0].fragments[0].rect.y).toBe(0.6)
    expect(extractPdfTranslationSource).not.toHaveBeenCalled()
  })

  it('restores the saved parser layout without reading pages or invoking current extraction', async () => {
    checkpoint = {
      layoutSnapshot: {
        version: 1,
        parserVersion: 'historical-parser',
        fingerprint: ready.source.fingerprint,
        pages: ready.source.pages,
        units: ready.source.units,
        coverage: ready.coverage
      }
    } as PdfTranslationCheckpoint
    await render(document, 'reopened-document')
    expect(current.state.status).toBe('ready')
    if (current.state.status !== 'ready') throw new Error('Expected restored layout')
    expect(current.state.extraction.source.resourceRequestKey).toBe('reopened-document')
    expect(current.state.extraction.source.units).toEqual(ready.source.units)
    expect(getPdfTranslationLayoutSnapshot(current.state.extraction.source)?.parserVersion).toBe(
      'historical-parser'
    )
    await act(async () => current.start())
    expect(extractPdfTranslationSource).not.toHaveBeenCalled()
    expect(document.getPage).not.toHaveBeenCalled()
    await render({ ...document, fingerprints: ['changed-pdf'] })
    expect(current.state.status).toBe('error')
    expect(extractPdfTranslationSource).not.toHaveBeenCalled()
  })
  it('extracts a legacy record once and saves its layout without calling a model', async () => {
    checkpoint = {
      key: 'checkpoint-key',
      attachmentVersionId: 'version'
    } as PdfTranslationCheckpoint
    const saveSnapshot = vi.fn().mockResolvedValue(undefined)
    window.api.pdfTranslation = { saveSnapshot } as never
    vi.mocked(extractPdfTranslationSource).mockResolvedValue(ready)
    await render()
    await act(async () => current.start())
    expect(saveSnapshot).toHaveBeenCalledWith({
      source: 'version',
      checkpointKey: 'checkpoint-key',
      snapshot: expect.objectContaining({ version: 1 })
    })
    checkpoint = { ...checkpoint, layoutSnapshot: saveSnapshot.mock.calls[0][0].snapshot }
    await render(document, 'next-open')
    expect(current.state.status).toBe('ready')
    expect(extractPdfTranslationSource).toHaveBeenCalledTimes(1)
  })
  it('starts explicitly, reports actual progress, deduplicates clicks and retains the result', async () => {
    let resolve!: (value: PdfTranslationExtraction) => void
    vi.mocked(extractPdfTranslationSource).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await render()
    expect(current.state.status).toBe('idle')
    expect(extractPdfTranslationSource).not.toHaveBeenCalled()
    await act(async () => {
      current.start()
      current.start()
    })
    expect(extractPdfTranslationSource).toHaveBeenCalledTimes(1)
    const request = vi.mocked(extractPdfTranslationSource).mock.calls[0][0]
    expect(request.document).toBe(document)
    await act(async () => request.onProgress?.(1))
    expect(current.state).toEqual({ status: 'running', pagesRead: 1 })
    await act(async () => resolve(ready))
    await render()
    expect(current.state).toEqual({ status: 'ready', extraction: ready })
  })
  it('cancels immediately and ignores old progress and completion during a fresh retry', async () => {
    const completions: ((value: PdfTranslationExtraction) => void)[] = []
    vi.mocked(extractPdfTranslationSource).mockImplementation(
      () => new Promise((done) => completions.push(done))
    )
    await render()
    await act(async () => current.start())
    const first = vi.mocked(extractPdfTranslationSource).mock.calls[0][0]
    await act(async () => current.cancel())
    expect(first.signal.aborted).toBe(true)
    expect(current.state.status).toBe('cancelled')
    await act(async () => current.start())
    await act(async () => {
      first.onProgress?.(2)
      completions[0](ready)
    })
    expect(current.state).toEqual({ status: 'running', pagesRead: 0 })
    await act(async () => completions[1](ready))
    expect(current.state.status).toBe('ready')
  })
  it.each(['key', 'document', 'disabled'] as const)(
    'invalidates source ownership on %s change',
    async (change) => {
      let reject!: (error: Error) => void
      vi.mocked(extractPdfTranslationSource).mockImplementation(
        () =>
          new Promise((_, fail) => {
            reject = fail
          })
      )
      await render()
      await act(async () => current.start())
      const old = vi.mocked(extractPdfTranslationSource).mock.calls[0][0]
      await render(
        change === 'disabled' ? null : change === 'document' ? { ...document } : document,
        change === 'key' ? 'v2' : 'v1'
      )
      expect(old.signal.aborted).toBe(true)
      await act(async () => reject(new Error('Late read failure')))
      expect(current.state.status).toBe('idle')
    }
  )
  it('aborts on unmount', async () => {
    vi.mocked(extractPdfTranslationSource).mockImplementation(() => new Promise(() => {}))
    await render()
    await act(async () => current.start())
    const request = vi.mocked(extractPdfTranslationSource).mock.calls[0][0]
    await act(async () => root.render(null))
    expect(request.signal.aborted).toBe(true)
  })
  it('supports retry after an extraction failure', async () => {
    vi.mocked(extractPdfTranslationSource)
      .mockRejectedValueOnce(new Error('Read failed'))
      .mockResolvedValueOnce(ready)
    await render()
    await act(async () => current.start())
    expect(current.state.status).toBe('error')
    await act(async () => current.start())
    expect(current.state.status).toBe('ready')
  })
  it('publishes once after cached ownership verification and does not inspect later cache changes', async () => {
    useTables = true
    const deferred = Promise.withResolvers<PdfTranslationExtraction>()
    vi.mocked(extractPdfTranslationSource).mockResolvedValue(ready)
    vi.mocked(applyCachedPdfTableSources).mockReturnValue(deferred.promise)
    await render()
    expect(applyCachedPdfTableSources).not.toHaveBeenCalled()
    await act(async () => current.start())
    expect(current.state.status).toBe('running')
    const request = vi.mocked(applyCachedPdfTableSources).mock.calls[0][0]
    expect(request).toMatchObject({
      extraction: ready,
      document,
      attachmentVersionId: 'version',
      sourceIdentity
    })
    await request.readCached({ attachmentVersionId: 'version', page: 1 })
    expect(window.api.pdfStructure.readCached).toHaveBeenCalledOnce()
    await act(async () => deferred.resolve(ready))
    await render()
    expect(current.state).toEqual({ status: 'ready', extraction: ready })
    expect(applyCachedPdfTableSources).toHaveBeenCalledOnce()
    expect(window.api.pdfStructure.parse).not.toHaveBeenCalled()
  })
  it.each(['cancel', 'switch', 'unmount'] as const)(
    'ignores late table verification after %s',
    async (kind) => {
      useTables = true
      const deferred = Promise.withResolvers<PdfTranslationExtraction>()
      vi.mocked(extractPdfTranslationSource).mockResolvedValue(ready)
      vi.mocked(applyCachedPdfTableSources).mockReturnValue(deferred.promise)
      await render()
      await act(async () => current.start())
      const request = vi.mocked(applyCachedPdfTableSources).mock.calls[0][0]
      if (kind === 'cancel') await act(async () => current.cancel())
      if (kind === 'switch') await render(document, 'new-version')
      if (kind === 'unmount') await act(async () => root.render(null))
      expect(request.signal.aborted).toBe(true)
      await act(async () => deferred.resolve(ready))
      if (kind !== 'unmount')
        expect(current.state.status).toBe(kind === 'cancel' ? 'cancelled' : 'idle')
    }
  )
})
