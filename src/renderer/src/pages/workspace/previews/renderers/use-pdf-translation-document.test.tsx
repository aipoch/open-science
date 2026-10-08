import { readPdfTranslationCases } from '../../../../../../../test/fixtures/pdf-translation/read-cases'
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderHook, waitFor, act, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  usePdfTranslationDocument,
  type PdfTranslationArtifact
} from './use-pdf-translation-document'
import { createPdfTranslationSource, type PdfTranslationResults } from './pdf-translation'
import { extractPdfTranslationSource } from './pdf-translation-extraction'
import {
  PDFDocument,
  StandardFonts,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  drawObject
} from 'pdf-lib'
import {
  PdfGenerationError,
  type PdfTranslationPdfRequest,
  type PdfTranslationPdfResult,
  type PdfTranslationRecordLayoutRequest
} from '../../../../../../shared/pdf-translation'
const { getDocument, operators } = vi.hoisted(() => ({ getDocument: vi.fn(), operators: {} }))
vi.mock('../pdfjs', () => ({ pdfjsLib: { getDocument, OPS: operators } }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
// Inferred fixture mocks keep their exact mutable test signatures.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const source = createPdfTranslationSource({
    resourceRequestKey: 'reader:0',
    fingerprint: 'fp',
    pages: [{ width: 600, height: 800 }],
    units: [
      {
        id: 'one',
        source: 'cell',
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
            items: [{ index: 0, text: 'cell' }]
          }
        ]
      }
    ]
  })
  const results = { source, units: [{ id: 'one', translationSource: 'cell', translation: '细胞' }] }
  const item = { str: '细胞', transform: [10, 0, 0, 10, 60, 700], width: 20 }
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const page = () => ({
    getViewport: vi.fn(() => ({
      width: 600,
      height: 800,
      rotation: 0,
      convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
    })),
    getTextContent: vi.fn(async () => ({ items: [item] })),
    getAnnotations: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
    cleanup: vi.fn()
  })
  const originalPage = page(),
    targetPage = page()
  const original = {
    fingerprints: ['fp'],
    numPages: 1,
    getPage: vi.fn(async () => originalPage),
    getPageIndex: vi.fn(async () => 0),
    getData: vi.fn(async () => new Uint8Array([1, 2]))
  } as unknown as PDFDocumentProxy
  const target = {
    numPages: 1,
    getPage: vi.fn(async (number: number) => {
      void number
      return targetPage
    }),
    getPageIndex: vi.fn(async () => 0)
  }
  const destroy = vi.fn(async () => {})
  getDocument.mockReturnValue({ promise: Promise.resolve(target), destroy })
  const artifact: PdfTranslationArtifact = { results, data: new Uint8Array([4, 5]) }
  return { original, originalPage, targetPage, target, results, artifact, destroy, item }
}
describe('persisted translated PDF cache', () => {
  const checkpoint = { source: 'version-1', key: 'edition-1' }
  const output: PdfTranslationPdfResult = {
    data: new Uint8Array([4, 5]),
    layoutFailures: [],
    cacheToken: '00000000-0000-4000-8000-000000000001'
  }

  it('confirms a complete candidate only after all PDF validation finishes', async () => {
    const f = fixture()
    const page = Promise.withResolvers<typeof f.targetPage>()
    f.target.getPage.mockReturnValueOnce(page.promise)
    const generatePdf = vi
      .fn<(input: PdfTranslationPdfRequest) => Promise<PdfTranslationPdfResult>>()
      .mockResolvedValue(output)
    const recordLayout = vi
      .fn<(request: PdfTranslationRecordLayoutRequest) => Promise<void>>()
      .mockResolvedValue(undefined)
    vi.stubGlobal('api', {
      pdfTranslation: { generatePdf, recordLayout, cancelPdf: vi.fn(async () => {}) }
    })
    const results = { ...f.results, checkpoint }
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, results, undefined, 'reader:0')
    )
    await waitFor(() => expect(f.target.getPage).toHaveBeenCalled())
    expect(generatePdf.mock.calls[0][0].cache).toEqual({
      source: checkpoint.source,
      checkpointKey: checkpoint.key
    })
    expect(recordLayout).not.toHaveBeenCalled()
    await act(async () => page.resolve(f.targetPage))
    await waitFor(() => expect(hook.result.current.ready).toBeDefined())
    expect(recordLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        pdfCacheToken: output.cacheToken,
        checkpointKey: checkpoint.key,
        units: [{ sourceIndex: 0, source: 'cell', translation: '细胞' }]
      })
    )
  })

  it('does not offer incomplete results for caching or confirm an unsolicited token', async () => {
    const f = fixture()
    const source = createPdfTranslationSource({
      ...f.results.source,
      pages: [...f.results.source.pages, ...f.results.source.pages],
      units: [
        ...f.results.source.units,
        {
          ...f.results.source.units[0],
          id: 'two',
          fragments: [{ ...f.results.source.units[0].fragments[0], pageNumber: 2 }]
        }
      ]
    })
    Object.assign(f.original, { numPages: 2 })
    f.target.numPages = 2
    f.originalPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
    f.target.getPage.mockImplementation(async (number) =>
      number === 1 ? f.targetPage : f.originalPage
    )
    const generatePdf = vi
      .fn<(input: PdfTranslationPdfRequest) => Promise<PdfTranslationPdfResult>>()
      .mockResolvedValue(output)
    const recordLayout = vi
      .fn<(request: PdfTranslationRecordLayoutRequest) => Promise<void>>()
      .mockResolvedValue(undefined)
    vi.stubGlobal('api', {
      pdfTranslation: { generatePdf, recordLayout, cancelPdf: vi.fn(async () => {}) }
    })
    const results = { ...f.results, source, checkpoint }
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, results, undefined, 'reader:0')
    )
    await waitFor(() => expect(hook.result.current.ready).toBeDefined())
    expect(generatePdf.mock.calls[0][0]).not.toHaveProperty('cache')
    expect(recordLayout).toHaveBeenCalled()
    expect(recordLayout.mock.calls.every(([request]) => !('pdfCacheToken' in request))).toBe(true)
  })

  it.each([true, false])(
    'bypasses an invalid cache hit once (fresh PDF valid: %s)',
    async (valid) => {
      const f = fixture()
      f.targetPage.getTextContent.mockResolvedValueOnce({ items: [{ ...f.item, str: 'broken' }] })
      if (!valid)
        f.targetPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'broken' }] })
      const generatePdf = vi
        .fn<(input: PdfTranslationPdfRequest) => Promise<PdfTranslationPdfResult>>()
        .mockResolvedValueOnce({ ...output, cacheHit: true })
        .mockResolvedValue({ ...output, cacheHit: true })
      const recordLayout = vi
        .fn<(request: PdfTranslationRecordLayoutRequest) => Promise<void>>()
        .mockResolvedValue(undefined)
      vi.stubGlobal('api', {
        pdfTranslation: { generatePdf, recordLayout, cancelPdf: vi.fn(async () => {}) }
      })
      const results = { ...f.results, checkpoint }
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, results, undefined, 'reader:0')
      )
      await waitFor(() => expect(hook.result.current.state.status).toBe(valid ? 'ready' : 'error'))
      expect(generatePdf).toHaveBeenCalledTimes(2)
      expect(generatePdf.mock.calls[0][0].cache?.bypass).toBeUndefined()
      expect(generatePdf.mock.calls[1][0].cache?.bypass).toBe(true)
      expect(f.targetPage.getTextContent).toHaveBeenCalledTimes(2)
      expect(recordLayout).toHaveBeenCalledTimes(1)
      expect(recordLayout.mock.calls[0][0]).toEqual(
        valid
          ? expect.objectContaining({ pdfCacheToken: output.cacheToken })
          : expect.not.objectContaining({ pdfCacheToken: expect.anything() })
      )
    }
  )

  it.each(['source', 'edition'] as const)(
    'bypasses manual refresh/retry without leaking that choice across a %s change',
    async (change) => {
      const f = fixture()
      const generatePdf = vi
        .fn<(input: PdfTranslationPdfRequest) => Promise<PdfTranslationPdfResult>>()
        .mockResolvedValue(output)
      vi.stubGlobal('api', {
        pdfTranslation: {
          generatePdf,
          recordLayout: vi.fn(async () => {}),
          cancelPdf: vi.fn(async () => {})
        }
      })
      const results = { ...f.results, checkpoint }
      const hook = renderHook(
        ({ results }) => usePdfTranslationDocument(f.original, results, undefined, 'reader:0'),
        { initialProps: { results } }
      )
      await waitFor(() => expect(hook.result.current.ready).toBeDefined())
      generatePdf.mockRejectedValueOnce(new PdfGenerationError({ code: 'timeout' }))
      act(() => hook.result.current.refresh())
      await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
      expect(generatePdf.mock.calls[1][0].cache?.bypass).toBe(true)
      act(() => hook.result.current.retry())
      await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
      expect(generatePdf.mock.calls[2][0].cache?.bypass).toBe(true)
      hook.rerender({
        results: {
          ...results,
          ...(change === 'source'
            ? { source: createPdfTranslationSource(results.source) }
            : { checkpoint: { ...checkpoint, key: 'edition-2' } })
        }
      })
      await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(4))
      expect(generatePdf.mock.calls[3][0].cache?.bypass).toBeUndefined()
      await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
    }
  )

  it('never confirms a candidate whose validation completes after cancellation', async () => {
    const f = fixture()
    const page = Promise.withResolvers<typeof f.targetPage>()
    f.target.getPage.mockReturnValueOnce(page.promise)
    const generatePdf = vi.fn(async () => output)
    const recordLayout = vi
      .fn<(request: PdfTranslationRecordLayoutRequest) => Promise<void>>()
      .mockResolvedValue(undefined)
    vi.stubGlobal('api', {
      pdfTranslation: { generatePdf, recordLayout, cancelPdf: vi.fn(async () => {}) }
    })
    const results = { ...f.results, checkpoint }
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, results, undefined, 'reader:0')
    )
    await waitFor(() => expect(f.target.getPage).toHaveBeenCalled())
    hook.unmount()
    await act(async () => page.resolve(f.targetPage))
    expect(recordLayout).not.toHaveBeenCalled()
  })

  it('keeps the previous verified PDF readable during an invalid cache hit fallback', async () => {
    const f = fixture()
    const fresh = Promise.withResolvers<PdfTranslationPdfResult>()
    const generatePdf = vi
      .fn<(input: PdfTranslationPdfRequest) => Promise<PdfTranslationPdfResult>>()
      .mockResolvedValueOnce(output)
      .mockResolvedValueOnce({ ...output, cacheHit: true })
      .mockReturnValueOnce(fresh.promise)
    const recordLayout = vi
      .fn<(request: PdfTranslationRecordLayoutRequest) => Promise<void>>()
      .mockResolvedValue(undefined)
    vi.stubGlobal('api', {
      pdfTranslation: { generatePdf, recordLayout, cancelPdf: vi.fn(async () => {}) }
    })
    const results = { ...f.results, checkpoint }
    const hook = renderHook(
      ({ results }) => usePdfTranslationDocument(f.original, results, undefined, 'reader:0'),
      { initialProps: { results } }
    )
    await waitFor(() => expect(hook.result.current.ready).toBeDefined())
    const previous = hook.result.current.ready
    f.targetPage.getTextContent
      .mockResolvedValueOnce({ items: [{ ...f.item, str: 'broken' }] })
      .mockResolvedValue({ items: [{ ...f.item, str: '细胞内容' }] })
    hook.rerender({
      results: { ...results, units: [{ ...results.units[0], translation: '细胞内容' }] }
    })
    await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(3))
    expect(hook.result.current.state.status).toBe('loading')
    expect(hook.result.current.ready).toBe(previous)
    expect(recordLayout).toHaveBeenCalledTimes(1)
    expect(generatePdf.mock.calls[2][0].cache?.bypass).toBe(true)
    await act(async () => fresh.resolve(output))
    await waitFor(() => expect(hook.result.current.isCurrent).toBe(true))
    expect(recordLayout).toHaveBeenCalledTimes(2)
  })
})
describe('translated PDF ownership', () => {
  it.each(['version', 'fingerprint', 'source', 'reset', 'removed unit', 'changed source text'])(
    'releases the previous PDF when its source is no longer current: %s',
    async (change) => {
      const f = fixture()
      const initialProps = {
        original: f.original,
        results: f.results as PdfTranslationResults | undefined,
        artifact: f.artifact as PdfTranslationArtifact | undefined,
        key: 'reader:0'
      }
      const hook = renderHook(
        ({ original, results, artifact, key }) =>
          usePdfTranslationDocument(original, results, artifact, key),
        { initialProps }
      )
      await waitFor(() => expect(hook.result.current.ready).toBeDefined())
      const disposePage = vi.fn()
      hook.result.current.registerDisposer(disposePage)
      const next = { ...initialProps }
      if (change === 'version') next.key = 'reader:1'
      if (change === 'fingerprint')
        next.original = { ...f.original, fingerprints: ['new'] } as PDFDocumentProxy
      if (change === 'source')
        next.results = { ...f.results, source: createPdfTranslationSource(f.results.source) }
      if (change === 'reset') next.results = undefined
      if (change === 'removed unit') next.results = { ...f.results, units: [] }
      if (change === 'changed source text')
        next.results = {
          ...f.results,
          units: [{ ...f.results.units[0], translationSource: 'Changed source.' }]
        }
      // Keep artifact identity stable so result admission must reject stale pairings.
      hook.rerender(next)
      expect(hook.result.current.ready).toBeUndefined()
      expect(f.destroy).toHaveBeenCalledOnce()
      expect(disposePage).toHaveBeenCalledOnce()
    }
  )

  it.each(
    ['fraction-height-paragraph-fragments.jsonl', 'short-caption-terminal-fragments.jsonl'].flatMap(
      (file) =>
        readPdfTranslationCases<{
          name: string
          neighbor: boolean
          secondY: number
          count: number
          caption?: boolean
          width?: number
        }>(file)
    )
  )('$name', async ({ neighbor, secondY, count, caption = false, width = 0.5 }) => {
    const f = fixture()
    const source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          ...f.results.source.units[0],
          ...(caption ? { source: 'Table 2: cell body' } : {}),
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.02 },
              items: [{ index: 0, text: 'cell' }]
            },
            {
              pageNumber: 1,
              rect: { x: 0.1, y: secondY, width, height: 0.015 },
              items: [{ index: 1, text: 'body' }]
            }
          ]
        },
        ...(neighbor
          ? [
              {
                id: 'neighbor',
                source: 'Protected label',
                sourceOnly: true as const,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 0.3, y: 0.115, width: 0.1, height: 0.01 },
                    items: [{ index: 2, text: 'Protected label' }]
                  }
                ]
              }
            ]
          : [])
      ]
    })
    const generatePdf = vi.fn(async (_request: { units: Array<{ fragments: unknown[] }> }) => {
      void _request
      return new Uint8Array([4, 5])
    })
    vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
    const results = {
      ...f.results,
      source,
      units: f.results.units.map((unit) => ({ ...unit, translationSource: source.units[0].source }))
    }
    renderHook(() => usePdfTranslationDocument(f.original, results, undefined, 'reader:0'))
    await waitFor(() => expect(generatePdf).toHaveBeenCalledOnce())
    expect(generatePdf.mock.calls[0][0].units[0].fragments).toHaveLength(count)
    expect(source.units[0].fragments).toHaveLength(2)
  })

  it.each(
    readPdfTranslationCases<{ name: string; text: string; width: number; height: number }>(
      'caption-whitespace-neighbor-boundaries.jsonl'
    )
  )('borrows only bounded whitespace: $name', async ({ text, width, height }) => {
    const f = fixture(),
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: text,
            fragments: [{ ...f.results.source.units[0].fragments[0], items: [{ index: 0, text }] }]
          },
          {
            id: 'below',
            source: 'Untouched caption below',
            sourceOnly: true,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.225, width: 0.5, height: 0.1 },
                items: [{ index: 1, text: 'Untouched caption below' }]
              }
            ]
          },
          {
            id: 'right',
            source: 'Untouched right column',
            sourceOnly: true,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.615, y: 0.1, width: 0.2, height: 0.1 },
                items: [{ index: 2, text: 'Untouched right column' }]
              }
            ]
          }
        ]
      })
    const generatePdf = vi.fn(
      async (_request: {
        units: Array<{ fragments: Array<{ rect: { width: number; height: number } }> }>
      }) => {
        void _request
        return new Uint8Array([4, 5])
      }
    )
    vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
    const results = {
      ...f.results,
      source,
      units: [{ ...f.results.units[0], translationSource: text }]
    }
    renderHook(() => usePdfTranslationDocument(f.original, results, undefined, 'reader:0'))
    await waitFor(() => expect(generatePdf).toHaveBeenCalledOnce())
    const rect = generatePdf.mock.calls[0][0].units[0].fragments[0].rect
    expect(rect.width * 600).toBeCloseTo(width)
    expect(rect.height * 800).toBeCloseTo(height)
    expect(source.units[0].fragments[0].rect).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.1 })
  })

  it('never reuses a destroyed PDF after results temporarily leave admission', async () => {
    const f = fixture()
    const hook = renderHook(
      ({ admitted }) =>
        usePdfTranslationDocument(
          f.original,
          admitted ? f.results : undefined,
          f.artifact,
          'reader:0'
        ),
      { initialProps: { admitted: true } }
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
    hook.rerender({ admitted: false })
    expect(f.destroy).toHaveBeenCalledOnce()
    expect(hook.result.current.state.status).toBe('idle')
    const replacement = { ...f.target }
    getDocument.mockReturnValue({
      promise: Promise.resolve(replacement),
      destroy: vi.fn(async () => {})
    })
    hook.rerender({ admitted: true })
    await waitFor(() => {
      expect(hook.result.current.state).toMatchObject({ status: 'ready', document: replacement })
      expect(getDocument).toHaveBeenCalledTimes(2)
    })
  })

  it('keeps accepting initial progress until a first page can be rendered', async () => {
    const f = fixture()
    const source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        f.results.source.units[0],
        {
          id: 'two',
          source: 'value',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
              items: [{ index: 1, text: 'value' }]
            }
          ]
        }
      ]
    })
    f.originalPage.getTextContent.mockResolvedValue({
      items: [
        { ...f.item, str: 'cell' },
        { ...f.item, str: 'value', transform: [10, 0, 0, 10, 60, 620] }
      ]
    })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [f.item, { ...f.item, str: '数值', transform: [10, 0, 0, 10, 60, 620] }]
    })
    const generatePdf = vi.fn(async () => new Uint8Array([4, 5])),
      results = { ...f.results, source }
    vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
    const hook = renderHook(
      ({ current }) => usePdfTranslationDocument(f.original, current, undefined, 'reader:0'),
      { initialProps: { current: results } }
    )
    expect(generatePdf).not.toHaveBeenCalled()
    hook.rerender({
      current: {
        ...results,
        units: [...results.units, { id: 'two', translationSource: 'value', translation: '数值' }]
      }
    })
    await waitFor(() => expect(hook.result.current.ready).toBeDefined())
    expect(generatePdf).toHaveBeenCalledOnce()
    expect(hook.result.current.isCurrent).toBe(true)
  })

  it('renders the completed page while preserving a skipped block as original text', async () => {
    const f = fixture()
    const source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        f.results.source.units[0],
        {
          id: 'two',
          source: 'value',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
              items: [{ index: 1, text: 'value' }]
            }
          ]
        }
      ]
    })
    f.originalPage.getTextContent.mockResolvedValue({
      items: [
        { ...f.item, str: 'cell' },
        { ...f.item, str: 'value', transform: [10, 0, 0, 10, 60, 620] }
      ]
    })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [f.item, { ...f.item, str: 'value', transform: [10, 0, 0, 10, 60, 620] }]
    })
    const generatePdf = vi.fn(async (_request: { units: { translation: string }[] }) => {
        void _request
        return new Uint8Array([4, 5])
      }),
      results = { ...f.results, source }
    vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
    const hook = renderHook(
      ({ current }) => usePdfTranslationDocument(f.original, current, undefined, 'reader:0'),
      { initialProps: { current: { ...results, failedUnitIds: [] as string[] } } }
    )
    expect(generatePdf).not.toHaveBeenCalled()
    hook.rerender({
      current: {
        ...results,
        failedUnitIds: ['two']
      }
    })
    await waitFor(() => expect(hook.result.current.ready).toBeDefined())
    expect(generatePdf).toHaveBeenCalledOnce()
    expect(hook.result.current.isCurrent).toBe(true)
    expect(hook.result.current.ready?.originalUnitCount).toBe(1)
    expect(generatePdf.mock.calls[0][0].units).toHaveLength(1)
    expect(generatePdf.mock.calls[0][0].units[0].translation).toBe('细胞')
  })

  it.each(['append', 'earlier-gap'])('retains the last verified PDF: %s', async (order) => {
    const source = createPdfTranslationSource({
      resourceRequestKey: 'reader:0',
      fingerprint: 'fp',
      pages: [
        { width: 600, height: 800 },
        { width: 600, height: 800 }
      ],
      units: [
        {
          id: 'one',
          source: 'cell',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
              items: [{ index: 0, text: 'cell' }]
            }
          ]
        },
        {
          id: 'two',
          source: 'value',
          fragments: [
            {
              pageNumber: 2,
              rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
              items: [{ index: 0, text: 'value' }]
            }
          ]
        }
      ]
    })
    const page = (text: string): ReturnType<typeof fixture>['targetPage'] => ({
      getViewport: vi.fn(() => ({
        width: 600,
        height: 800,
        rotation: 0,
        convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
      })),
      getTextContent: vi.fn(async () => ({
        items: [{ str: text, transform: [10, 0, 0, 10, 60, 700], width: 20 }]
      })),
      getAnnotations: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
      cleanup: vi.fn()
    })
    const original = {
        fingerprints: ['fp'],
        numPages: 2,
        getPage: vi.fn(async (number: number) => page(number === 1 ? 'cell' : 'value')),
        getPageIndex: vi.fn(async () => 0),
        getData: vi.fn(async () => new Uint8Array([1, 2]))
      } as unknown as PDFDocumentProxy,
      target = {
        numPages: 2,
        getPage: vi.fn(async (number: number) =>
          page(
            order === 'append' ? (number === 1 ? '细胞' : 'value') : number === 1 ? 'cell' : '数值'
          )
        ),
        getPageIndex: vi.fn(async () => 0)
      },
      generatePdf = vi.fn(async (_request: { units: Array<Record<string, unknown>> }) => {
        void _request
        return new Uint8Array([4, 5])
      }),
      targetPdf = { numPages: 2, getPage: target.getPage, getPageIndex: target.getPageIndex }
    const destroy = vi.fn(async () => {})
    getDocument.mockReturnValue({ promise: Promise.resolve(targetPdf), destroy })
    vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
    const allUnits = [
      { id: 'one', translationSource: 'cell', translation: '细胞' },
      { id: 'two', translationSource: 'value', translation: '数值' }
    ]
    const results = { source, units: [allUnits[order === 'append' ? 0 : 1]] }

    const hook = renderHook(
      ({ current }) => usePdfTranslationDocument(original, current, undefined, 'reader:0'),
      { initialProps: { current: results } }
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))

    expect(generatePdf).toHaveBeenCalledOnce()
    expect(generatePdf.mock.calls[0][0].units).toEqual([
      expect.objectContaining({
        source: results.units[0].translationSource,
        translation: results.units[0].translation
      })
    ])
    const firstReady = hook.result.current.ready,
      disposePage = vi.fn(),
      completed = {
        ...results,
        units: allUnits
      }
    hook.result.current.registerDisposer(disposePage)
    let reject!: (error: Error) => void
    generatePdf.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    hook.rerender({ current: completed })
    await waitFor(() => {
      expect(generatePdf).toHaveBeenCalledTimes(2)
      expect(hook.result.current.state.status).toBe('loading')
    })
    expect(hook.result.current.ready).toBe(firstReady)
    expect(destroy).not.toHaveBeenCalled()
    expect(disposePage).not.toHaveBeenCalled()
    await act(async () =>
      reject(
        new PdfGenerationError(
          order === 'append' ? { code: 'timeout' } : { code: 'source-mismatch', pageNumber: 1 }
        )
      )
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
    expect(hook.result.current.ready).toBe(firstReady)
    expect(destroy).not.toHaveBeenCalled()
    const replacement = {
        ...targetPdf,
        getPage: vi.fn(async (number: number) => page(number === 1 ? '细胞' : '数值'))
      },
      destroyReplacement = vi.fn(async () => {})
    getDocument.mockReturnValueOnce({
      promise: Promise.resolve(replacement),
      destroy: destroyReplacement
    })
    act(() => hook.result.current.retry())
    await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
    expect(hook.result.current.ready?.document).toBe(replacement)
    expect(hook.result.current.isCurrent).toBe(true)
    expect(hook.result.current.updateAvailable).toBe(false)
    expect(destroy).toHaveBeenCalledOnce()
    expect(disposePage).toHaveBeenCalledOnce()
    hook.unmount()
    expect(destroyReplacement).toHaveBeenCalledOnce()
  })

  it.each(['retained', 'mixed', 'missing', 'misplaced'])(
    'verifies every original cross-page fragment: %s',
    async (kind) => {
      const f = fixture()
      Object.assign(f.original, { numPages: 2 })
      f.target.numPages = 2
      f.originalPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
      f.targetPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
      const source = createPdfTranslationSource({
        ...f.results.source,
        pages: [f.results.source.pages[0], f.results.source.pages[0]],
        units: [
          {
            ...f.results.source.units[0],
            source: 'cellcell',
            fragments: [1, 2].map((pageNumber) => ({
              ...f.results.source.units[0].fragments[0],
              pageNumber
            }))
          }
        ]
      })
      const results = {
        source,
        units: [{ id: 'one', translationSource: 'cellcell', translation: '细胞细胞' }]
      }
      const second = {
        ...f.targetPage,
        getTextContent: vi.fn(async () => ({
          items:
            kind === 'missing'
              ? []
              : [
                  {
                    ...f.item,
                    str: kind === 'mixed' ? '细胞' : 'cell',
                    transform: [10, 0, 0, 10, kind === 'misplaced' ? 500 : 60, 700]
                  }
                ]
        }))
      }
      f.target.getPage.mockImplementation(async (number) => (number === 1 ? f.targetPage : second))
      const artifact = { results, data: new Uint8Array([4]) }
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
      )
      await waitFor(() =>
        expect(hook.result.current.state.status).toBe(kind === 'retained' ? 'ready' : 'error')
      )
      if (kind === 'retained')
        expect(hook.result.current.state).toMatchObject({ originalUnitCount: 1 })
    }
  )

  it.each(['cell', 'cel'])('independently verifies original text retained as %s', async (text) => {
    const f = fixture()
    f.originalPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
    f.targetPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: text }] })
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, f.results, f.artifact, 'reader:0')
    )
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(text === 'cell' ? 'ready' : 'error')
    )
    if (text === 'cell') expect(hook.result.current.state).toMatchObject({ originalUnitCount: 1 })
  })
  it.each([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])(
    'validates retained links while leaving original annotation type %s behind',
    async (annotationType) => {
      const f = fixture(),
        link = { annotationType: 2, rect: [0, 0, 10, 10], url: 'https://example.org' }
      f.originalPage.getAnnotations.mockResolvedValue([
        { annotationType, rect: [20, 20, 40, 40] },
        link
      ])
      f.targetPage.getAnnotations.mockResolvedValue([link])
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, f.results, f.artifact, 'reader:0')
      )
      await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
    }
  )
  it.each(['lost-link', 'unexpected-markup', 'widget'])(
    'does not weaken generated PDF validation for %s',
    async (kind) => {
      const f = fixture(),
        link = { annotationType: 2, rect: [0, 0, 10, 10], url: 'https://example.org' }
      f.originalPage.getAnnotations.mockResolvedValue([
        link,
        { annotationType: kind === 'widget' ? 20 : 9, rect: [20, 20, 40, 40] }
      ])
      f.targetPage.getAnnotations.mockResolvedValue(
        kind === 'lost-link'
          ? []
          : kind === 'unexpected-markup'
            ? [link, { annotationType: 9, rect: [20, 20, 40, 40] }]
            : [link]
      )
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, f.results, f.artifact, 'reader:0')
      )
      await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
    }
  )
  it.each(['translated', 'unchanged', 'overlap', 'misplaced', 'invalid'] as const)(
    'projects page text once without weakening region validation: %s',
    async (kind) => {
      const f = fixture()
      const items = Array.from({ length: 10 }, (_, index) => ({
        ...f.item,
        str: '细胞' + index,
        transform: [10, 0, 0, 10, 60, 700 - index * 30]
      }))
      const source = createPdfTranslationSource({
        ...f.results.source,
        units: items.map((item, index) => ({
          id: 'region-' + index,
          source: kind === 'unchanged' ? item.str : 'cell' + index,
          fragments: [
            {
              pageNumber: 1,
              rect: {
                x: 0.1,
                y: (90 + (kind === 'overlap' && index === 1 ? 0 : index * 30)) / 800,
                width: 0.5,
                height: 20 / 800
              },
              items: [{ index, text: kind === 'unchanged' ? item.str : 'cell' + index }]
            }
          ]
        }))
      })
      const results = {
        source,
        units: source.units.map((unit, index) => ({
          id: unit.id,
          translationSource: unit.source,
          translation: items[index].str
        }))
      }
      if (kind === 'misplaced') items[0].transform[4] = 500
      if (kind === 'invalid') items[0].transform[0] = 0
      f.targetPage.getTextContent.mockResolvedValue({ items })
      f.originalPage.getTextContent.mockResolvedValue({ items })
      const project = vi.fn((x: number, y: number) => [x, 800 - y])
      for (const page of [f.originalPage, f.targetPage])
        page.getViewport.mockReturnValue({
          ...page.getViewport(),
          convertToViewportPoint: project
        })
      const artifact = { results, data: new Uint8Array([1]) }
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
      )
      if (['overlap', 'misplaced', 'invalid'].includes(kind)) {
        await waitFor(() =>
          expect(hook.result.current.state).toMatchObject({
            status: 'error',
            failure: { code: 'validation-failed', pageNumber: 1 }
          })
        )
        expect(f.destroy).toHaveBeenCalledOnce()
        return
      }
      await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
      expect(project).toHaveBeenCalledTimes(items.length * 2 * (kind === 'unchanged' ? 2 : 1))
      expect(f.targetPage.cleanup).toHaveBeenCalledOnce()
      expect(f.originalPage.cleanup).not.toHaveBeenCalled()
    }
  )

  it.each(
    readPdfTranslationCases<{ name: string; kind: string; expected: string }>(
      'retained-formula-overlap-verification.jsonl'
    )
  )(
    'validates independently grouped superscripts inside retained paragraph bounds: $name',
    async ({ kind, expected }) => {
      const f = fixture()
      const body = { ...f.item, str: 'cell' }
      const citation = { ...f.item, str: '24', transform: [6, 0, 0, 6, 300, 700], width: 10 }
      f.originalPage.getTextContent.mockResolvedValue({ items: [body, citation] })
      f.targetPage.getTextContent.mockResolvedValue({
        items: [
          { ...body, str: kind === 'translated' ? '细胞' : 'cell' },
          ...(kind === 'missing'
            ? []
            : [{ ...citation, transform: [6, 0, 0, 6, kind === 'misplaced' ? 400 : 300, 700] }])
        ]
      })
      const source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          f.results.source.units[0],
          {
            id: 'citation',
            source: kind === 'normalized-formula' ? '2 4' : '24',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.5, y: 0.1125, width: 0.05, height: 0.025 },
                items: [
                  {
                    index: kind === 'shared-source' ? 0 : 1,
                    text: kind === 'shared-source' ? 'cell' : kind === 'wrong-source' ? '25' : '24'
                  }
                ]
              }
            ]
          }
        ]
      })
      const results = {
        source,
        units: source.units.map((unit, i) => ({
          id: unit.id,
          translationSource: unit.source,
          translation:
            i === 1 && kind === 'normalized-formula'
              ? '24'
              : i === 0 && ['fallback', 'translated'].includes(kind)
                ? '细胞'
                : unit.source
        }))
      }
      const artifact = { results, data: new Uint8Array([4, 5]) }
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
      )
      await waitFor(() => expect(hook.result.current.state.status).toBe(expected))
      if (kind === 'fallback')
        expect(hook.result.current.state).toMatchObject({ originalUnitCount: 1 })
    }
  )

  it('reopens a real unchanged PDF whose source grouping joins a line-end hyphen', async () => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    const sheet = pdf.addPage([612, 792])
    sheet.drawText('This controlled experiment measures bio-', { font, x: 40, y: 700, size: 12 })
    sheet.drawText('medical research in healthy cells.', { font, x: 40, y: 686, size: 12 })
    sheet.drawText('Biomedical analysis.', { font, x: 40, y: 600, size: 12 })
    const data = await pdf.save()
    const { getDocument: load } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = load({ data: data.slice(), useSystemFonts: true })
    try {
      const original = await task.promise
      const { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: 'real-hyphen',
        signal: new AbortController().signal
      })
      expect(source.units.map((unit) => unit.source)).toContain(
        'This controlled experiment measures biomedical research in healthy cells.'
      )
      const results = {
        source,
        units: source.units.map((unit) => ({
          id: unit.id,
          translationSource: unit.source,
          translation: unit.source
        }))
      }
      const artifact = { results, data }
      getDocument.mockImplementationOnce((options) => load({ ...options, useSystemFonts: true }))
      const hook = renderHook(() =>
        usePdfTranslationDocument(original, results, artifact, 'real-hyphen')
      )
      await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
      hook.unmount()
    } finally {
      await task.destroy()
    }
  })

  it.each(['retained', 'missing-hyphen', 'wrong-region', 'wrong-letter', 'empty-region'])(
    'verifies unchanged line-end hyphens against the original PDF: %s',
    async (kind) => {
      const f = fixture()
      const source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: 'biomedical',
            fragments: [
              {
                ...f.results.source.units[0].fragments[0],
                items: [
                  { index: 0, text: 'bio-' },
                  { index: 1, text: 'medical' }
                ]
              }
            ]
          }
        ]
      })
      const results = {
        source,
        units: [{ id: 'one', translationSource: 'biomedical', translation: 'biomedical' }]
      }
      const items = [
        { ...f.item, str: 'bio-', width: 20 },
        { ...f.item, str: 'medical', width: 35, transform: [10, 0, 0, 10, 60, 682] }
      ]
      f.originalPage.getTextContent.mockResolvedValue({ items })
      f.targetPage.getTextContent.mockResolvedValue({
        items: [
          {
            ...items[0],
            str: kind === 'missing-hyphen' ? 'bio' : kind === 'wrong-letter' ? 'bioZ' : 'bio-'
          },
          { ...items[1], transform: [10, 0, 0, 10, kind === 'wrong-region' ? 500 : 60, 682] }
        ]
      })
      if (kind === 'empty-region') {
        f.originalPage.getTextContent.mockResolvedValue({ items: [] })
        f.targetPage.getTextContent.mockResolvedValue({ items: [] })
      }
      const artifact = { results, data: new Uint8Array([4]) }
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
      )
      await waitFor(() =>
        expect(hook.result.current.state.status).toBe(kind === 'retained' ? 'ready' : 'error')
      )
    }
  )

  it.each(['valid', 'missing', 'wrong-region', 'repeated', 'symbol-change'])(
    'checks ordered cross-page region completeness: %s',
    async (kind) => {
      const f = fixture()
      f.originalPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
      Object.assign(f.original, { numPages: 2 })
      f.target.numPages = 2
      const source = createPdfTranslationSource({
        ...f.results.source,
        pages: [f.results.source.pages[0], f.results.source.pages[0]],
        units: [
          {
            ...f.results.source.units[0],
            fragments: [1, 2].map((pageNumber) => ({
              ...f.results.source.units[0].fragments[0],
              pageNumber
            }))
          }
        ]
      })
      const translation = kind === 'symbol-change' ? '细胞²' : '细胞生长'
      const results = { source, units: [{ ...f.results.units[0], translation }] }
      const second = {
        ...f.targetPage,
        getTextContent: vi.fn(async () => ({
          items:
            kind === 'missing'
              ? []
              : [
                  {
                    ...f.item,
                    str: kind === 'repeated' ? '细胞' : kind === 'symbol-change' ? '2' : '生长',
                    transform: [10, 0, 0, 10, kind === 'wrong-region' ? 500 : 60, 700]
                  }
                ]
        }))
      }
      f.target.getPage.mockImplementation(async (number) => (number === 1 ? f.targetPage : second))
      const artifact = { results, data: new Uint8Array([4]) }
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
      )
      await waitFor(() =>
        expect(hook.result.current.state.status).toBe(kind === 'valid' ? 'ready' : 'error')
      )
    }
  )
  it.each([
    'retained',
    'rounded',
    'quad-rounded',
    'quad-shifted',
    'dest-rounded',
    'dest-shifted',
    'dest-null',
    'dest-mode',
    'dest-zoom',
    'lost',
    'url',
    'rect',
    'destination'
  ])('checks retained link semantics independently: %s', async (kind) => {
    const f = fixture(),
      link = {
        annotationType: 2,
        rect: [60, 700, 100, 720],
        url: 'https://example.org/',
        dest: [{ num: 4, gen: 0 }, { name: 'XYZ' }, 60.123, 720.456, 1],
        ...(kind.startsWith('quad')
          ? { quadPoints: new Float32Array([60, 720, 100, 720, 60, 700, 100, 700]) }
          : {})
      }
    f.originalPage.getAnnotations.mockResolvedValue([link])
    f.targetPage.getAnnotations.mockResolvedValue(
      kind === 'lost'
        ? []
        : [
            {
              ...link,
              dest: [
                { num: 9, gen: 0 },
                { name: kind === 'dest-mode' ? 'FitR' : 'XYZ' },
                kind === 'dest-rounded'
                  ? 60.12301
                  : kind === 'dest-shifted'
                    ? 60.133
                    : kind === 'dest-null'
                      ? null
                      : 60.123,
                720.456,
                kind === 'dest-zoom' ? 1.00001 : 1
              ],
              ...(kind === 'url' ? { url: 'https://example.org/changed' } : {}),
              ...(kind === 'rect' ? { rect: [70, 700, 110, 720] } : {}),
              ...(kind === 'rounded' ? { rect: [60.00001, 700, 99.99999, 720] } : {}),
              ...(kind.startsWith('quad')
                ? {
                    quadPoints: new Float32Array([
                      kind === 'quad-rounded' ? 60.00001 : 60.01,
                      720,
                      100,
                      720,
                      60,
                      700,
                      100,
                      700
                    ])
                  }
                : {})
            }
          ]
    )
    if (kind === 'destination') f.target.getPageIndex.mockResolvedValue(1)
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, f.results, f.artifact, 'reader:0')
    )
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(
        ['retained', 'rounded', 'quad-rounded', 'dest-rounded'].includes(kind) ? 'ready' : 'error'
      )
    )
  })
  it.each(['retained', 'renamed', 'removed', 'resolved', 'lookup-error'] as const)(
    'preserves unresolved named link identity: %s',
    async (kind) => {
      const f = fixture()
      const link = { annotationType: 2, rect: [0, 0, 10, 10], dest: 'ref1' }
      f.originalPage.getAnnotations.mockResolvedValue([link])
      f.targetPage.getAnnotations.mockResolvedValue([
        {
          ...link,
          dest: kind === 'renamed' ? 'ref2' : kind === 'removed' ? undefined : 'ref1'
        }
      ])
      Object.assign(f.original, { getDestination: vi.fn(async () => null) })
      Object.assign(f.target, {
        getDestination: vi.fn(async () => {
          if (kind === 'lookup-error') throw new Error('Document destroyed')
          return kind === 'resolved' ? [0, { name: 'Fit' }] : null
        })
      })
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, f.results, f.artifact, 'reader:0')
      )
      await waitFor(() =>
        expect(hook.result.current.state.status).toBe(kind === 'retained' ? 'ready' : 'error')
      )
    }
  )
  it('retries only PDF generation using the accepted result and ignores repeated clicks', async () => {
    const f = fixture(),
      generatePdf = vi
        .fn()
        .mockRejectedValueOnce(new PdfGenerationError({ code: 'timeout' }))
        .mockResolvedValueOnce(new Uint8Array([4, 5])),
      translate = vi.fn(),
      begin = vi.fn(),
      cancelPdf = vi.fn(async () => {})
    vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf, translate, begin } })
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, f.results, undefined, 'reader:0')
    )
    await waitFor(() =>
      expect(hook.result.current.state).toMatchObject({
        status: 'error',
        failure: { code: 'timeout' },
        details: '[pdf-generation:timeout:0]'
      })
    )
    act(() => {
      hook.result.current.retry()
      hook.result.current.retry()
    })
    await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
    expect(generatePdf).toHaveBeenCalledTimes(2)
    expect(generatePdf.mock.calls[1][0].units).toEqual(generatePdf.mock.calls[0][0].units)
    expect(generatePdf.mock.calls[1][0].id).not.toBe(generatePdf.mock.calls[0][0].id)
    expect(cancelPdf).toHaveBeenCalledWith(generatePdf.mock.calls[0][0].id)
    expect(begin).not.toHaveBeenCalled()
    expect(translate).not.toHaveBeenCalled()
    act(() => hook.result.current.retry())
    expect(generatePdf).toHaveBeenCalledTimes(2)
  })

  it('reports a deterministic layout reason with its page and diagnostic code', async () => {
    const f = fixture()
    const generatePdf = vi
      .fn()
      .mockRejectedValue(new PdfGenerationError({ code: 'annotations', pageNumber: 1 }))
    vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, f.results, undefined, 'reader:0')
    )
    await waitFor(() =>
      expect(hook.result.current.state).toMatchObject({
        status: 'error',
        details: '[pdf-generation:annotations:1]',
        failure: { code: 'annotations', pageNumber: 1 }
      })
    )
    expect(getDocument).not.toHaveBeenCalled()
  })

  it('verifies pages/text, retains producer bytes and disposes pages before its own task', async () => {
    const f = fixture(),
      events: string[] = []
    f.destroy.mockImplementation(async () => {
      events.push('destroy')
    })
    const before = vi.fn(),
      hook = renderHook(() =>
        usePdfTranslationDocument(f.original, f.results, f.artifact, 'reader:0', before)
      )
    await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
    expect(getDocument.mock.calls[0][0].data).not.toBe(f.artifact.data)
    expect(f.targetPage.cleanup).toHaveBeenCalledOnce()
    expect(f.originalPage.cleanup).not.toHaveBeenCalled()
    hook.result.current.registerDisposer(() => events.push('page'))
    hook.unmount()
    expect(events).toEqual(['page', 'destroy'])
    expect(before).toHaveBeenCalledOnce()
  })
  it.each(['geometry', 'rotation', 'count', 'text'])('rejects changed %s', async (kind) => {
    const f = fixture()
    if (kind === 'geometry')
      f.targetPage.getViewport.mockReturnValue({ ...f.targetPage.getViewport(), width: 601 })
    if (kind === 'rotation')
      f.targetPage.getViewport.mockReturnValue({ ...f.targetPage.getViewport(), rotation: 180 })
    if (kind === 'count') f.target.numPages = 2
    if (kind === 'text')
      f.targetPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'other' }] })
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, f.results, f.artifact, 'reader:0')
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
    expect(hook.result.current.state).toMatchObject({
      status: 'error',
      failure: { code: 'validation-failed', pageNumber: kind === 'count' ? undefined : 1 },
      details:
        kind === 'count'
          ? 'PDF page count changed'
          : kind === 'text'
            ? 'PDF translation text or placement changed'
            : 'PDF page geometry changed',
      ...(kind === 'text' ? { unitId: f.results.source.units[0].id } : {})
    })
    expect(f.destroy).toHaveBeenCalledOnce()
  })
  it('hides stale output immediately on source/result replacement and never destroys the original', async () => {
    const f = fixture()
    const hook = renderHook(
      ({ key }) => usePdfTranslationDocument(f.original, f.results, f.artifact, key),
      { initialProps: { key: 'reader:0' } }
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
    hook.rerender({ key: 'reader:1' })
    expect(hook.result.current.state.status).toBe('idle')
    expect(f.destroy).toHaveBeenCalledOnce()
    expect(f.originalPage.cleanup).not.toHaveBeenCalled()
  })
  it('cancels actual generation on unmount and ignores its late bytes', async () => {
    const f = fixture()
    let finish!: (data: Uint8Array) => void
    const generatePdf = vi.fn(
        (request: { id: string }) =>
          new Promise<Uint8Array>((resolve) => {
            expect(request.id).toBeTruthy()
            finish = resolve
          })
      ),
      cancelPdf = vi.fn(async () => {})
    vi.stubGlobal('api', undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pdfTranslation: { generatePdf, cancelPdf } }
    })
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, f.results, undefined, 'reader:0')
    )
    await waitFor(() => expect(generatePdf).toHaveBeenCalledOnce())
    hook.unmount()
    expect(cancelPdf).toHaveBeenCalledWith(generatePdf.mock.calls[0][0].id)
    await act(async () => {
      finish(new Uint8Array([1]))
      await Promise.resolve()
    })
    expect(getDocument).not.toHaveBeenCalled()
  })
})

describe('independent moved-link validation', () => {
  it.each([
    { sourceLabel: 'Table 2', targetLabel: '表2', accepted: true },
    { sourceLabel: 'Alpha et al.', targetLabel: 'Alpha 等人', accepted: true },
    { sourceLabel: 'Alpha et al.', targetLabel: 'Gamma 等人', accepted: false },
    { sourceLabel: 'Alpha & Beta', targetLabel: 'Alpha 和 Beta', accepted: true },
    { sourceLabel: '3(b)', targetLabel: '3（b）', accepted: true },
    { sourceLabel: 'beta et al.', targetLabel: 'beta 等人', accepted: true, authorPrefix: 'Alpha' },
    {
      sourceLabel: 'beta et al.',
      targetLabel: 'gamma 等人',
      accepted: false,
      authorPrefix: 'Alpha'
    },
    { sourceLabel: 'Suppl. Appendix', targetLabel: '补充附录', accepted: true },
    { sourceLabel: '”19', targetLabel: '"19', accepted: true },
    { sourceLabel: 'Table 2', targetLabel: '表2.1', accepted: false },
    { sourceLabel: 'Table 2', targetLabel: '表2a', accepted: false },
    { sourceLabel: 'Table 2', targetLabel: '表3', accepted: false },
    { sourceLabel: 'Table 2', targetLabel: '表2', accepted: false, changedAction: true }
  ])(
    'independently validates localized moved label $sourceLabel → $targetLabel (accepted=$accepted, changedAction=$changedAction)',
    async ({ sourceLabel, targetLabel, accepted, changedAction, authorPrefix }) => {
      const f = fixture(),
        sourceText = 'cell ' + (authorPrefix ?? '') + sourceLabel,
        targetPrefix = '细胞' + (authorPrefix ?? ''),
        targetText = targetPrefix + targetLabel,
        source = createPdfTranslationSource({
          ...f.results.source,
          units: [{ ...f.results.source.units[0], source: sourceText }]
        }),
        results = {
          source,
          units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
        }
      const item = (str: string, x: number, width: number): typeof f.item => ({
        ...f.item,
        str,
        transform: [10, 0, 0, 10, x, 700],
        width
      })
      // Source PDF.js may combine the linked label with prose in one text item.
      f.originalPage.getTextContent.mockResolvedValue({ items: [item(sourceText, 60, 130)] })
      f.targetPage.getTextContent.mockResolvedValue({
        items: [
          item(targetPrefix, 60, 20),
          item(targetLabel, 90, targetLabel.replace(/\s/gu, '').length * 8)
        ]
      })
      const link = {
        annotationType: 2,
        rect: [99, 699, 191, 711],
        url: 'https://example.org/reference'
      }
      f.originalPage.getAnnotations.mockResolvedValue([link])
      f.targetPage.getAnnotations.mockResolvedValue([
        {
          ...link,
          rect: [89, 699, 181, 711],
          ...(changedAction ? { url: 'https://example.org/changed' } : {})
        }
      ])
      const artifact = { results, data: new Uint8Array([4, 5]) }
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
      )
      await waitFor(() =>
        expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error')
      )
      if (!accepted)
        expect(hook.result.current.state).toMatchObject({ failure: { code: 'validation-failed' } })
    }
  )

  it.each([
    'separate',
    'combined',
    'vertical',
    'wrong-label',
    'outside',
    'resized',
    'duplicate',
    'wrong-type',
    'quad',
    'changed-action'
  ] as const)(
    'accepts only a unique original label translated inside its paragraph: %s',
    async (kind) => {
      const f = fixture(),
        vertical = kind === 'vertical'
      const label = kind === 'wrong-label' ? '[2]' : '[1]'
      const source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: kind === 'duplicate' ? 'cell[1][1]' : 'cell[1]',
            fragments: f.results.source.units[0].fragments.map((fragment) => ({
              ...fragment,
              rect: vertical ? { x: 0.4, y: 0.8, width: 0.15, height: 0.15 } : fragment.rect
            }))
          }
        ]
      })
      const results = {
        source,
        units: [
          { id: 'one', translationSource: source.units[0].source, translation: '细胞' + label }
        ]
      }
      const item = (str: string, x: number, y: number, width: number): typeof f.item => ({
        ...f.item,
        str,
        transform: vertical ? [0, 10, -10, 0, 300, x] : [10, 0, 0, 10, x, y],
        width
      })
      f.originalPage.getTextContent.mockResolvedValue({
        items:
          kind === 'separate'
            ? [item('cell', 60, 700, 40), item('[1]', 100, 700, 10)]
            : [item(source.units[0].source, 60, 700, 50)]
      })
      f.targetPage.getTextContent.mockResolvedValue({
        items: [item('细胞', 60, 700, 20), item(label, 90, 700, 10)]
      })
      const original = {
        annotationType: kind === 'wrong-type' ? 1 : 2,
        rect: vertical ? [289, 99, 301, 111] : [99, 699, 111, 711],
        url: 'https://example.org/1'
      }
      const moved = { ...original, rect: vertical ? [289, 89, 301, 101] : [89, 699, 101, 711] }

      if (kind === 'outside') moved.rect = [400, 699, 412, 711]
      if (kind === 'resized') moved.rect[2] += 1
      if (kind === 'changed-action') moved.url = 'https://example.org/2'
      f.originalPage.getAnnotations.mockResolvedValue([
        { ...original, ...(kind === 'quad' ? { quadPoints: [1, 2, 3, 4] } : {}) }
      ])
      f.targetPage.getAnnotations.mockResolvedValue([
        { ...moved, ...(kind === 'quad' ? { quadPoints: [1, 2, 3, 4] } : {}) }
      ])
      const artifact = { results, data: new Uint8Array([4, 5]) }
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
      )
      await waitFor(() => expect(hook.result.current.state.status).not.toBe('loading'))
      expect(hook.result.current.state.status).toBe(
        ['separate', 'combined', 'vertical'].includes(kind) ? 'ready' : 'error'
      )
    }
  )
})

it('verifies repeated numeric citations against their own original links and paragraph', async () => {
  const f = fixture(),
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [{ ...f.results.source.units[0], source: 'cell1 and cell1' }]
    })
  const results = {
    source,
    units: [{ id: 'one', translationSource: 'cell1 and cell1', translation: '细胞1与细胞1' }]
  }
  const item = (str: string, x: number, width: number): typeof f.item => ({
    ...f.item,
    str,
    transform: [10, 0, 0, 10, x, 700],
    width
  })
  f.originalPage.getTextContent.mockResolvedValue({
    items: [item('cell', 60, 40), item('1', 100, 5), item(' and cell', 115, 70), item('1', 185, 5)]
  })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [item('细胞', 60, 20), item('1', 80, 5), item('与细胞', 95, 30), item('1', 125, 5)]
  })
  const link = (x: number): Record<string, unknown> => ({
    annotationType: 2,
    rect: [x - 1, 699, x + 6, 711],
    url: 'https://example.org/1'
  })
  f.originalPage.getAnnotations.mockResolvedValue([link(100), link(185)])
  f.targetPage.getAnnotations.mockResolvedValue([link(80), link(125)])
  const artifact = { results, data: new Uint8Array([4, 5]) }
  const { result } = renderHook(() =>
    usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
  )
  await waitFor(() => expect(result.current.state.status).toBe('ready'))
  expect(result.current.state).toMatchObject({ originalUnitCount: 0 })
})

it.each([
  'valid',
  'superscript-text',
  'changed-second',
  'missing-link',
  'extra-link',
  'duplicate-reference',
  'different-owner',
  'inline',
  'body-sized',
  'too-high',
  'rotated',
  'changed-action',
  'wrong-hit-area',
  'moved-outside'
] as const)(
  'proves a complete raised native citation list attached to a name: %s',
  async (kind) => {
    const f = fixture(),
      list = kind === 'superscript-text' ? '¹,²' : '1,2',
      sourceText = 'built on NumPy' + list,
      targetText =
        '基于NumPy' +
        (kind === 'changed-second' ? '1,3' : list) +
        (kind === 'duplicate-reference' ? '和1,2' : ''),
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments: [
              {
                ...f.results.source.units[0].fragments[0],
                items: [
                  { index: 0, text: 'built on NumPy' },
                  ...(kind === 'different-owner' ? [] : [{ index: 1, text: list }])
                ]
              }
            ]
          },
          ...(kind === 'different-owner'
            ? [
                {
                  id: 'reference-owner',
                  source: list,
                  sourceOnly: true as const,
                  fragments: [
                    {
                      pageNumber: 1,
                      rect: { x: 110 / 600, y: 90 / 800, width: 7.6 / 600, height: 12 / 800 },
                      items: [{ index: 1, text: list }]
                    }
                  ]
                }
              ]
            : [])
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      },
      item = (str: string, x: number, width: number, size = 6, y = 704): typeof f.item => ({
        ...f.item,
        str,
        transform: [size, 0, 0, size, x, y],
        width
      })
    const reference = item(
      list,
      110,
      7.6,
      kind === 'body-sized' ? 10 : 6,
      kind === 'inline' ? 700 : kind === 'too-high' ? 706 : 704
    )
    if (kind === 'rotated') reference.transform[1] = 0.1
    f.originalPage.getTextContent.mockResolvedValue({
      items: [item('built on NumPy', 60, 50, 10, 700), reference]
    })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [
        item('基于NumPy', 60, 40, 10, 700),
        item(kind === 'superscript-text' ? '¹' : '1', 100, 2.6),
        item(',', 103, 1.5),
        item(kind === 'changed-second' ? '3' : kind === 'superscript-text' ? '²' : '2', 105, 2.6),
        ...(kind === 'duplicate-reference'
          ? [item('和', 120, 10, 10, 700), item('1,2', 130, 7.6)]
          : [])
      ]
    })
    const links = [110, 115].map((x, index) => ({
      annotationType: 2,
      rect: [x, 699, x + 2.6, 711],
      url: `https://example.org/reference/${index + 1}`
    }))
    if (kind === 'extra-link') links.push({ ...links[0] })
    f.originalPage.getAnnotations.mockResolvedValue(links)
    f.targetPage.getAnnotations.mockResolvedValue(
      links.slice(0, kind === 'missing-link' ? 1 : links.length).map((link, index) => ({
        ...link,
        rect:
          kind === 'moved-outside' && index === 0
            ? [400, 699, 402.6, 711]
            : kind === 'wrong-hit-area' && index === 0
              ? [105, 699, 107.6, 711]
              : [link.rect[0] - 10, 699, link.rect[2] - 10, 711],
        ...(kind === 'changed-action' && index === 1 ? { url: 'https://example.org/changed' } : {})
      }))
    )
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(
        ['valid', 'superscript-text'].includes(kind) ? 'ready' : 'error'
      )
    )
    if (!['valid', 'superscript-text'].includes(kind))
      expect(hook.result.current.state).toMatchObject({ failure: { code: 'validation-failed' } })
  }
)

it.each([
  'valid',
  'changed-year',
  'changed-author',
  'duplicate-reference',
  'changed-action',
  'wider-overhang',
  'left-overhang',
  'outside',
  'unclaimed',
  'excess-source-overhang',
  'not-native-suffix'
] as const)(
  'preserves only the original native overhang of a complete dated closing link: %s',
  async (kind) => {
    const f = fixture(),
      sourceText = 'Use (Kern et al., 2003)' + (kind === 'not-native-suffix' ? ' More' : ''),
      prefix = '参照（' + (kind === 'changed-author' ? 'Vale' : 'Kern') + ' et al., ',
      tail = kind === 'changed-year' ? '2004）' : '2003）',
      targetText =
        prefix +
        tail +
        (kind === 'duplicate-reference' ? '和（Kern et al., 2003）' : '') +
        (kind === 'not-native-suffix' ? ' 更多' : ''),
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments: [
              {
                ...f.results.source.units[0].fragments[0],
                items: kind === 'unclaimed' ? [] : [{ index: 0, text: sourceText }]
              }
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      },
      item = (str: string, x: number, width: number, size = 10): typeof f.item => ({
        ...f.item,
        str,
        transform: [size, 0, 0, size, x, 700],
        width
      })
    f.originalPage.getTextContent.mockResolvedValue({
      items: [item(sourceText, 60, kind === 'excess-source-overhang' ? 146 : 143)]
    })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [
        item(prefix, 60, 75),
        item(tail, kind === 'left-overhang' ? 148 : 150, kind === 'wider-overhang' ? 30 : 28, 8),
        ...(kind === 'duplicate-reference' ? [item('和（Kern et al., 2003）', 200, 90)] : []),
        ...(kind === 'not-native-suffix' ? [item(' 更多', 200, 20)] : [])
      ]
    })
    const annotation = {
      annotationType: 2,
      rect: [175, 699, 200, 711],
      url: 'https://example.org/reference/2003'
    }
    f.originalPage.getAnnotations.mockResolvedValue([annotation])
    f.targetPage.getAnnotations.mockResolvedValue([
      {
        ...annotation,
        rect: kind === 'outside' ? [400, 699, 425, 711] : [150, 699, 175, 711],
        ...(kind === 'changed-action' ? { url: 'https://example.org/changed' } : {})
      }
    ])
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(kind === 'valid' ? 'ready' : 'error')
    )
  }
)

it.each(['valid', 'partial-source', 'changed-action', 'outside', 'extra-link'] as const)(
  'verifies a translated whole prose link through its entire original paragraph: %s',
  async (kind) => {
    const f = fixture(),
      sourceText = 'Read the revised paper' + (kind === 'partial-source' ? ' More details' : ''),
      targetText = '阅读修订后的论文',
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments: [
              {
                ...f.results.source.units[0].fragments[0],
                items: [
                  { index: 0, text: 'Read the revised paper' },
                  ...(kind === 'partial-source' ? [{ index: 1, text: ' More details' }] : [])
                ]
              }
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      },
      item = (str: string, x: number, width: number): typeof f.item => ({
        ...f.item,
        str,
        transform: [10, 0, 0, 10, x, 700],
        width
      })
    f.originalPage.getTextContent.mockResolvedValue({
      items: [
        item('Read the revised paper', 60, 140),
        ...(kind === 'partial-source' ? [item(' More details', 240, 50)] : [])
      ]
    })
    f.targetPage.getTextContent.mockResolvedValue({ items: [item(targetText, 80, 80)] })
    const annotation = {
      annotationType: 2,
      rect: [59, 699, 201, 711],
      url: 'https://example.org/revised'
    }
    f.originalPage.getAnnotations.mockResolvedValue([annotation])
    const moved = {
      ...annotation,
      rect: kind === 'outside' ? [400, 699, 542, 711] : [79, 699, 221, 711],
      ...(kind === 'changed-action' ? { url: 'https://example.org/changed' } : {})
    }
    f.targetPage.getAnnotations.mockResolvedValue(kind === 'extra-link' ? [moved, moved] : [moved])
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(kind === 'valid' ? 'ready' : 'error')
    )
  }
)

it.each([
  'valid',
  'semantic-suffix',
  'changed-target-uri',
  'duplicate-target-uri',
  'wrong-source-range',
  'wrong-claimed-text',
  'unclaimed',
  'extra-native-text',
  'changed-action',
  'outside',
  'extra-link',
  'changed-query'
] as const)(
  'proves a shared URI fragment through its full original action and native source interval: %s',
  async (kind) => {
    const f = fixture(),
      suffix = kind === 'semantic-suffix',
      first = suffix
        ? 'https://alpha.example.org/reference/api-reference'
        : 'https://alpha.example.org/a',
      second = 'https://beta.example.org/b',
      changedFirst =
        kind === 'changed-target-uri'
          ? second
          : kind === 'changed-query'
            ? first + '?other'
            : first,
      sourceText = `Read ${first} and ${second}`,
      targetText =
        `阅读 ${changedFirst} 和 ${second}` + (kind === 'duplicate-target-uri' ? ' ' + first : ''),
      item = (str: string, x: number, y: number, width: number): typeof f.item => ({
        ...f.item,
        str,
        transform: [10, 0, 0, 10, x, y],
        width
      }),
      native = [
        item('Read ', 60, 700, 25),
        item('https://', 85, 700, 25),
        item(
          suffix ? 'alpha.example.org/reference/api-' : 'alpha.example.org/a',
          112,
          700,
          suffix ? 108 : 100
        ),
        ...(suffix ? [item('reference', 225, 700, 45)] : []),
        item(' and ', 60, 680, 25),
        item('https://', 85, 680, 25),
        item('beta.example.org/b', 112, 680, 100),
        ...(kind === 'extra-native-text' ? [item(' Noise', 300, 700, 30)] : [])
      ],
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments: [
              {
                ...f.results.source.units[0].fragments[0],
                items: native.flatMap((entry, index) =>
                  kind === 'unclaimed' && index === 1
                    ? []
                    : [
                        {
                          index,
                          text: kind === 'wrong-claimed-text' && index === 1 ? 'other' : entry.str
                        }
                      ]
                )
              }
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      }
    f.originalPage.getTextContent.mockResolvedValue({ items: native })
    const after = [
      item('阅读 ', 60, 700, 30),
      item('https://', 100, 700, 25),
      item(
        changedFirst.slice(8, suffix ? changedFirst.lastIndexOf('reference') : undefined),
        127,
        700,
        suffix ? 108 : 100
      ),
      ...(suffix ? [item('reference', 240, 700, 45)] : []),
      item(' 和 ', 60, 680, 30),
      item('https://', 100, 680, 25),
      item('beta.example.org/b', 127, 680, 100),
      ...(kind === 'duplicate-target-uri' ? [item(' ' + first, 240, 680, 100)] : [])
    ]
    f.targetPage.getTextContent.mockResolvedValue({ items: after })
    const links = [
      { annotationType: 2, rect: suffix ? [224, 699, 271, 711] : [84, 699, 111, 711], url: first },
      { annotationType: 2, rect: [84, 679, 111, 691], url: second }
    ]
    if (kind === 'wrong-source-range') links[0].rect = [84, 679, 111, 691]
    f.originalPage.getAnnotations.mockResolvedValue(links)
    const moved = links.map((link, index) => ({
      ...link,
      rect:
        index === 0
          ? kind === 'outside'
            ? [400, 699, 427, 711]
            : suffix
              ? [239, 699, 286, 711]
              : [99, 699, 126, 711]
          : [99, 679, 126, 691],
      ...(kind === 'changed-action' && index === 0 ? { url: second } : {})
    }))
    f.targetPage.getAnnotations.mockResolvedValue(
      kind === 'extra-link' ? [...moved, moved[0]] : moved
    )
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(
        ['valid', 'semantic-suffix'].includes(kind) ? 'ready' : 'error'
      )
    )
  }
)

it.each([
  'valid',
  'valid-suffix',
  'stretched-matrix',
  'changed-size',
  'valid-merged-fragments',
  'different-owner',
  'valid-no-parenthesis',
  'semantic-hyphen-preserved',
  'semantic-hyphen-removed',
  'same-row',
  'distant-row',
  'different-font',
  'missing-eol',
  'shifted-left',
  'interposed-native',
  'unclaimed',
  'wrong-claimed-text',
  'wrong-source-hit-area',
  'extra-owned-text',
  'duplicate-target-uri',
  'changed-source-action',
  'changed-target-action'
] as const)(
  'proves only an action-matching URI layout hyphen across adjacent owned native rows: %s',
  async (kind) => {
    const f = fixture(),
      semantic = kind.startsWith('semantic-hyphen'),
      path = semantic ? 'api-reference' : 'path',
      uri = `http://alpha.example.org/${path}`,
      first =
        'Read http://alpha.example.org/help and the licence ' +
        (kind === 'valid-no-parenthesis' ? '' : '(') +
        'http://alpha.exa-',
      second = `mple.org/${path}) applies here.`,
      sourceText = first.slice(0, -1) + second,
      targetUri =
        kind === 'semantic-hyphen-removed' ? uri.replace('api-reference', 'apireference') : uri,
      targetText =
        `阅读 http://alpha.example.org/help 和许可（${targetUri}）适用于此。` +
        (kind === 'duplicate-target-uri' ? ' ' + uri : ''),
      item = (
        str: string,
        x: number,
        y: number,
        width: number,
        fontName = 'body',
        hasEOL = true
      ): typeof f.item & { fontName: string; hasEOL: boolean } => ({
        ...f.item,
        str,
        transform: [10, 0, 0, 10, x, y],
        width,
        fontName,
        hasEOL
      }),
      native = [
        item(first, 60, 700, 240, 'body', kind !== 'missing-eol'),
        ...(kind === 'interposed-native' ? [item('Foreign content.', 400, 650, 80)] : []),
        item(
          second,
          kind === 'shifted-left' ? 80 : 60,
          kind === 'same-row' ? 700 : kind === 'distant-row' ? 670 : 688,
          200,
          kind === 'different-font' ? 'foreign' : 'body'
        ),
        ...(kind === 'extra-owned-text' ? [item(' Noise', 60, 676, 30)] : [])
      ],
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments:
              kind === 'valid-merged-fragments'
                ? [
                    {
                      pageNumber: 1,
                      rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.0375 },
                      items: [{ index: 0, text: first }]
                    },
                    {
                      pageNumber: 1,
                      rect: { x: 0.1, y: 0.1375, width: 0.5, height: 0.0225 },
                      items: [{ index: 1, text: second }]
                    }
                  ]
                : [
                    {
                      ...f.results.source.units[0].fragments[0],
                      items: native.flatMap((entry, index) =>
                        (kind === 'interposed-native' && index === 1) ||
                        ((kind === 'unclaimed' || kind === 'different-owner') && index === 1)
                          ? []
                          : [
                              {
                                index,
                                text:
                                  kind === 'wrong-claimed-text' && index === 0 ? 'Other' : entry.str
                              }
                            ]
                      )
                    }
                  ]
          },
          ...(kind === 'different-owner'
            ? [
                {
                  id: 'foreign',
                  source: second,
                  sourceOnly: true as const,
                  fragments: [
                    {
                      pageNumber: 1,
                      rect: { x: 0.1, y: 0.1375, width: 0.5, height: 0.0225 },
                      items: [{ index: 1, text: second }]
                    }
                  ]
                }
              ]
            : [])
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      }
    if (kind === 'stretched-matrix') native[1].transform[3] = 20
    if (kind === 'changed-size') native[1].transform[0] = 12
    f.originalPage.getTextContent.mockResolvedValue({ items: native })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [
        item('阅读 http://alpha.example.org/help 和许可（', 60, 720, 220),
        item('http://alpha.exa', 100, 700, 50),
        item(targetUri.slice('http://alpha.exa'.length), 153, 700, 80),
        item('）适用于此。', 235, 700, 60),
        ...(kind === 'duplicate-target-uri' ? [item(' ' + uri, 60, 688, 140)] : [])
      ]
    })
    const annotation = {
      annotationType: 2,
      rect:
        kind === 'valid-suffix'
          ? [59.95, 687, 141, 699]
          : kind === 'wrong-source-hit-area'
            ? [100, 699, 151.05, 711]
            : [249, 699, 300.05, 711],
      url: kind === 'changed-source-action' ? 'http://other.example.org/path' : uri
    }
    f.originalPage.getAnnotations.mockResolvedValue([annotation])
    f.targetPage.getAnnotations.mockResolvedValue([
      {
        ...annotation,
        rect: kind === 'valid-suffix' ? [152, 699, 233.05, 711] : [99, 699, 150.05, 711],
        ...(kind === 'changed-target-action' ? { url: 'http://other.example.org/path' } : {})
      }
    ])
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(
        [
          'valid',
          'valid-suffix',
          'valid-merged-fragments',
          'valid-no-parenthesis',
          'semantic-hyphen-preserved'
        ].includes(kind)
          ? 'ready'
          : 'error'
      )
    )
  }
)

const sharedCitationVerification = readFileSync(
  resolve('test/fixtures/pdf-translation/shared-citation-hit-area-verification.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map(
    (line) =>
      JSON.parse(line) as {
        name: string
        change: 'none' | 'combined' | 'second-link-offset' | 'width' | 'text' | 'action'
        accepted: boolean
      }
  )

it.each(sharedCitationVerification)('$name', async ({ change, accepted }) => {
  const f = fixture(),
    sourceText = 'cell1, 2',
    label = change === 'text' ? '1, 3' : '1, 2',
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [{ ...f.results.source.units[0], source: sourceText }]
    }),
    results = {
      source,
      units: [{ id: 'one', translationSource: sourceText, translation: '细胞' + label }]
    }
  const item = (str: string, x: number, width: number): typeof f.item => ({
    ...f.item,
    str,
    transform: [10, 0, 0, 10, x, 700],
    width
  })
  f.originalPage.getTextContent.mockResolvedValue({
    items:
      change === 'combined'
        ? [item(sourceText, 60, 70)]
        : [item('cell', 60, 25), item('1, 2', 100, 30)]
  })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [item('细胞', 60, change === 'combined' ? 20 : 10), item(label, 80, 30)]
  })
  const links = [100, 120].map((x, index) => ({
    annotationType: 2,
    rect: [x - 0.5, 699, x + 10.5, 711],
    url: `https://example.org/reference/${index + 1}`
  }))
  f.originalPage.getAnnotations.mockResolvedValue(links)
  f.targetPage.getAnnotations.mockResolvedValue(
    links.map((link, index) => {
      const dx = change === 'second-link-offset' && index === 1 ? -18 : -20
      return {
        ...link,
        rect: [link.rect[0] + dx, 699, link.rect[2] + dx + (change === 'width' ? 1 : 0), 711],
        ...(change === 'action' && index === 1 ? { url: 'https://example.org/changed' } : {})
      }
    })
  )
  const artifact = { results, data: new Uint8Array([4, 5]) }
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{
    name: string
    sourceNumbers: string[]
    targetNumbers: string[]
    change: 'none' | 'missing' | 'overlap' | 'action'
    sourcePrefix?: string
    unlinkedList?: boolean
    unlinkedText?: string
    overlappingGlyph?: boolean
    accepted: boolean
  }>('repeated-numeric-link-hit-areas.jsonl')
)(
  '$name',
  async ({
    sourceNumbers,
    targetNumbers,
    sourcePrefix,
    change,
    unlinkedList,
    unlinkedText,
    overlappingGlyph,
    accepted
  }) => {
    const f = fixture(),
      sourceText =
        (sourcePrefix ?? '') +
        sourceNumbers
          .map((value) => `(${value})`)
          .join(unlinkedText ?? (unlinkedList ? ', (3) another method ' : ' ')),
      targetText = '细胞' + targetNumbers.join(' '),
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          { ...f.results.source.units[0], source: sourceText },
          ...(overlappingGlyph
            ? [
                {
                  id: 'operator',
                  source: '√',
                  sourceOnly: true as const,
                  fragments: [
                    {
                      pageNumber: 1,
                      rect: { x: 220 / 600, y: 90 / 800, width: 5 / 600, height: 15 / 800 },
                      items: [{ index: 1, text: '√' }]
                    }
                  ]
                }
              ]
            : [])
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      }
    const item = (str: string, x: number, width: number): typeof f.item => ({
      ...f.item,
      str,
      transform: [10, 0, 0, 10, x, 700],
      width
    })
    f.originalPage.getTextContent.mockResolvedValue({
      items: [item(sourceText, 60, 270), ...(overlappingGlyph ? [item('√', 220, 5)] : [])]
    })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [
        item('细胞', 60, 10),
        ...targetNumbers.map((value, index) => item(value, 80 + index * 60, 30)),
        ...(overlappingGlyph ? [item('√', 220, 5)] : [])
      ]
    })
    const links = sourceNumbers.map((_, index) => ({
      annotationType: 2,
      rect: [99 + index * 90, 699, 131 + index * 90, 711],
      url: `https://example.org/reference/${index}`
    }))
    const moved = links.map((link, index) => ({
      ...link,
      rect: [79 + index * 60, 699, 111 + index * 60, 711]
    }))
    if (change === 'missing') {
      links.pop()
      moved.pop()
    }
    if (change === 'overlap') links[1].rect = links[0].rect
    if (change === 'action') moved[0].url = 'https://example.org/changed'
    f.originalPage.getAnnotations.mockResolvedValue(links)
    f.targetPage.getAnnotations.mockResolvedValue(moved)
    const artifact = { results, data: new Uint8Array([4, 5]) }
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    targetPrefix: string
    accepted: boolean
    author?: string
  }>('repeated-author-link-verification.jsonl')
)('$name', async ({ targetPrefix, accepted, author = 'Alpha' }) => {
  const f = fixture(),
    sourceText = `${author} discusses ${author}`,
    targetText = targetPrefix + '引用' + author,
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [{ ...f.results.source.units[0], source: sourceText }]
    }),
    results = {
      source,
      units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
    }
  const item = (str: string, x: number, y: number, width: number): typeof f.item => ({
    ...f.item,
    str,
    transform: [10, 0, 0, 10, x, y],
    width
  })
  f.originalPage.getTextContent.mockResolvedValue({
    items: [item(author + ' discusses ', 60, 715, 90), item(author, 150, 700, 30)]
  })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [item(targetPrefix + '引用', 60, 715, 90), item(author, 100, 700, 30)]
  })
  const link = {
    annotationType: 2,
    rect: [149, 699, 181, 711],
    url: 'https://example.org/reference'
  }
  f.originalPage.getAnnotations.mockResolvedValue([link])
  f.targetPage.getAnnotations.mockResolvedValue([{ ...link, rect: [99, 699, 131, 711] }])
  const artifact = { results, data: new Uint8Array([4, 5]) }
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{
    name: string
    change: string
    accepted: boolean
    numerator?: string
    denominator?: string
  }>('native-fraction-reading-verification.jsonl')
)(
  '$name',
  async ({ change, accepted, numerator = '32', denominator: originalDenominator = '8' }) => {
    const { getDocument: load, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    Object.assign(operators, OPS)
    const make = async (translated: boolean): Promise<Uint8Array> => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica),
        page = pdf.addPage([600, 800])
      const x = translated ? 160 : 100,
        y = translated ? 690 : 700,
        size = translated && change === 'scaled-glyph' ? 7 : 8
      page.drawText(translated ? 'Value ' : 'Ratio ', { font, x: 60, y, size: 12 })
      const fractionWidth = Math.max(
        font.widthOfTextAtSize(numerator, 8),
        font.widthOfTextAtSize(originalDenominator, 8)
      )
      page.drawText(numerator, {
        font,
        x: x + (fractionWidth - font.widthOfTextAtSize(numerator, 8)) / 2,
        y: y + 4,
        size
      })
      const denominator = translated && change === 'changed-denominator' ? '9' : originalDenominator
      page.drawText(denominator, {
        font,
        x: x + (fractionWidth - font.widthOfTextAtSize(originalDenominator, 8)) / 2,
        y: y - 4,
        size
      })
      if (change.startsWith('mask-')) {
        if (!translated || change !== 'mask-missing') {
          const mask = pdf.context.register(
              pdf.context.stream(new Uint8Array([0]), {
                Type: 'XObject',
                Subtype: 'Image',
                Width: 1,
                Height: 1,
                BitsPerComponent: 1,
                ImageMask: true,
                Decode: [0, 1]
              })
            ),
            name = page.node.newXObject('FractionRule', mask)
          page.pushOperators(
            pushGraphicsState(),
            concatTransformationMatrix(
              fractionWidth,
              0,
              0,
              translated && change === 'mask-thicker' ? 0.8 : 0.4,
              x,
              y + 1 + (translated && change === 'mask-moved' ? 3 : 0)
            ),
            drawObject(name),
            popGraphicsState()
          )
        }
      } else if (!translated || change !== 'missing-rule')
        page.drawLine({
          start: { x, y: y + 1 + (translated && change === 'moved-rule' ? 3 : 0) },
          end: {
            x: x + fractionWidth,
            y: y + 1 + (translated && change === 'moved-rule' ? 3 : 0)
          },
          thickness: 0.4
        })
      page.drawText(' samples.', { font, x: x + 24, y, size: 12 })
      return pdf.save()
    }
    const before = await make(false),
      after = await make(change !== 'kept-original'),
      task = load({ data: before, useSystemFonts: true })
    try {
      const original = await task.promise,
        content = await (await original.getPage(1)).getTextContent()
      const source = createPdfTranslationSource({
        resourceRequestKey: 'fraction-proof',
        fingerprint: original.fingerprints[0]!,
        pages: [{ width: 600, height: 800 }],
        units: [
          {
            id: 'fraction',
            source: `Ratio ${numerator}/${originalDenominator} samples.`,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.08, y: 0.09, width: 0.5, height: 0.09 },
                items: content.items.flatMap((item, index) =>
                  'str' in item ? [{ index, text: item.str }] : []
                )
              }
            ]
          }
        ]
      })
      const translation =
        change === 'flattened-expectation'
          ? 'Value 328 samples.'
          : `Value ${numerator}/${originalDenominator} samples.`
      const results = {
        source,
        units: [{ id: 'fraction', translationSource: source.units[0].source, translation }]
      }
      getDocument.mockImplementationOnce((options) => load({ ...options, useSystemFonts: true }))
      const artifact = { results, data: after }
      const hook = renderHook(() =>
        usePdfTranslationDocument(original, results, artifact, 'fraction-proof')
      )
      await waitFor(() =>
        expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error')
      )
      if (accepted)
        expect(hook.result.current.state).toMatchObject({
          originalUnitCount: change === 'kept-original' ? 1 : 0
        })
      hook.unmount()
    } finally {
      await task.destroy()
    }
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    originalMarker: string
    changedAction: boolean
    accepted: boolean
    unicode?: boolean
  }>('footnote-digit-beside-numeric-prose.jsonl')
)('$name', async ({ originalMarker, changedAction, accepted, unicode }) => {
  const f = fixture(),
    sourcePrefix = unicode ? 'Following the model) ' : 'Device 10MB',
    targetPrefix = unicode ? '按照模型）' : '设备10MB',
    targetMarker = unicode ? '¹' : '1',
    sourceText = sourcePrefix + originalMarker,
    targetText = targetPrefix + targetMarker,
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [{ ...f.results.source.units[0], source: sourceText }]
    }),
    results = {
      source,
      units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
    }
  const item = (str: string, x: number, width: number): typeof f.item => ({
    ...f.item,
    str,
    transform: [10, 0, 0, 10, x, 700],
    width
  })
  f.originalPage.getTextContent.mockResolvedValue({
    items: [item(sourcePrefix, 60, 133), item(originalMarker, 190, 5)]
  })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [item(targetPrefix, 60, 100), item(targetMarker, 170, 5)]
  })
  const link = {
    annotationType: 2,
    rect: [189, 699, 196, 711],
    url: 'https://example.org/footnote'
  }
  f.originalPage.getAnnotations.mockResolvedValue([link])
  f.targetPage.getAnnotations.mockResolvedValue([
    {
      ...link,
      rect: [169, 699, 176, 711],
      ...(changedAction ? { url: 'https://example.org/changed' } : {})
    }
  ])
  const artifact = { results, data: new Uint8Array([4, 5]) }
  const { result } = renderHook(() =>
    usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
  )
  await waitFor(() => expect(result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    translation: string
    label: string
    accepted: boolean
  }>('localized-cross-reference-identities.jsonl').filter(({ name }) =>
    [
      'literal-organization-citation-survives-translated-prose-name',
      'literal-organization-citation-rejects-changed-year',
      'literal-organization-citation-rejects-changed-name'
    ].includes(name)
  )
)('validates a uniquely dated literal citation independently: $name', async (testCase) => {
  const f = fixture(),
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [{ ...f.results.source.units[0], source: testCase.source }]
    }),
    results = {
      source,
      units: [{ id: 'one', translationSource: testCase.source, translation: testCase.translation }]
    },
    targetLabel = testCase.translation.includes(testCase.label) ? testCase.label : 'Beta Bulletin',
    sourceAt = testCase.source.lastIndexOf(testCase.label),
    targetAt = testCase.translation.indexOf(targetLabel),
    item = (str: string, x: number, width: number): typeof f.item => ({
      ...f.item,
      str,
      transform: [10, 0, 0, 10, x, 700],
      width
    })
  f.originalPage.getTextContent.mockResolvedValue({
    items: [
      item(testCase.source.slice(0, sourceAt), 60, 30),
      item(testCase.label, 110, 80),
      item(testCase.source.slice(sourceAt + testCase.label.length), 210, 80)
    ]
  })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [
      item(testCase.translation.slice(0, targetAt), 60, 20),
      item(targetLabel, 90, 80),
      item(testCase.translation.slice(targetAt + targetLabel.length), 180, 80)
    ]
  })
  const link = {
    annotationType: 2,
    rect: [109, 699, 191, 711],
    url: 'https://example.org/reference'
  }
  f.originalPage.getAnnotations.mockResolvedValue([link])
  f.targetPage.getAnnotations.mockResolvedValue([{ ...link, rect: [89, 699, 171, 711] }])
  const artifact = { results, data: new Uint8Array([4, 5]) },
    hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
  await waitFor(() =>
    expect(hook.result.current.state.status).toBe(testCase.accepted ? 'ready' : 'error')
  )
})

it.each([
  { change: 'none', accepted: true },
  { change: 'parentheses', accepted: true },
  { change: 'letter', accepted: false },
  { change: 'number', accepted: false },
  { change: 'suffix', accepted: false },
  { change: 'bare', accepted: false },
  { change: 'duplicate', accepted: false },
  { change: 'action', accepted: false },
  { change: 'owner', accepted: false }
])('verifies a merged native figure-panel digit: $change', async ({ change, accepted }) => {
  const f = fixture(),
    sourceText =
      change === 'bare' ? 'See sample 2(a) with 20 items.' : 'See Figure 2(a) with 20 items.',
    suffix = change === 'letter' ? '(b)' : change === 'parentheses' ? '（a）' : '(a)',
    digit = change === 'number' ? '3' : '2',
    tail =
      change === 'suffix'
        ? '，20项。'
        : change === 'duplicate'
          ? `${suffix}和图2(a)，20项。`
          : `${suffix}，20项。`,
    prefix = change === 'bare' ? '参见样本' : '参见图',
    translation = prefix + digit + tail,
    item = (str: string, x: number, width: number): typeof f.item => ({
      ...f.item,
      str,
      width,
      transform: [10, 0, 0, 10, x, 700]
    }),
    original = item(sourceText, 60, 220),
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          ...f.results.source.units[0],
          source: sourceText,
          fragments: [
            {
              ...f.results.source.units[0].fragments[0],
              ...(change === 'owner' ? { rect: { x: 0.5, y: 0.1, width: 0.4, height: 0.1 } } : {}),
              items: [{ index: 0, text: sourceText }]
            }
          ]
        }
      ]
    }),
    results = { source, units: [{ id: 'one', translationSource: sourceText, translation }] },
    link = {
      annotationType: 2,
      rect: [111, 699, 118, 711],
      url: 'https://example.org/figure'
    }
  f.originalPage.getTextContent.mockResolvedValue({ items: [original] })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [item(prefix, 60, 30), item(digit, 95, 5), item(tail, 103, 120)]
  })
  f.originalPage.getAnnotations.mockResolvedValue([link])
  f.targetPage.getAnnotations.mockResolvedValue([
    {
      ...link,
      rect: [94, 699, 101, 711],
      ...(change === 'action' ? { url: 'https://example.org/changed' } : {})
    }
  ])
  const artifact = { results, data: new Uint8Array([4, 5]) },
    hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'retained-neighbor-glyph-verification.jsonl'
  )
)('$name', async ({ change, accepted }) => {
  const f = fixture(),
    original = { ...f.item, str: 'B', transform: [7, 0, 0, 7, 100, 700], width: 5 },
    changed = {
      ...original,
      ...(change === 'changed' ? { str: 'C' } : {}),
      ...(change === 'width' ? { width: 6 } : {}),
      ...(change === 'moved' ? { transform: [7, 0, 0, 7, 101, 700] } : {}),
      ...(change === 'scaled' ? { transform: [8, 0, 0, 8, 100, 700] } : {})
    }
  f.originalPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }, original] })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [
      f.item,
      ...(change === 'missing' ? [] : [changed]),
      ...(change === 'duplicate' ? [changed] : [])
    ]
  })
  const source =
      change === 'claimed'
        ? createPdfTranslationSource({
            ...f.results.source,
            units: [
              {
                ...f.results.source.units[0],
                source: 'cell B',
                fragments: [
                  {
                    ...f.results.source.units[0].fragments[0],
                    items: [
                      { index: 0, text: 'cell' },
                      { index: 1, text: 'B' }
                    ]
                  }
                ]
              }
            ]
          })
        : createPdfTranslationSource({
            ...f.results.source,
            units: [
              ...f.results.source.units,
              {
                id: 'formula',
                source: 'B',
                sourceOnly: true,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 100 / 600, y: 98 / 800, width: 5 / 600, height: 7 / 800 },
                    items: [{ index: 1, text: 'B' }]
                  }
                ]
              }
            ]
          }),
    results = {
      source,
      units: [{ ...f.results.units[0], translationSource: source.units[0].source }]
    }
  const artifact = { results, data: new Uint8Array([4, 5]) }
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'native-accent-reading-verification.jsonl'
  )
)('$name', async ({ change, accepted }) => {
  const f = fixture(),
    macron = change.startsWith('macron'),
    accent = macron ? '¯' : '̂',
    rise = macron || change === 'raised-hat' ? 2.5 : 0,
    glyph = (str: string, x: number, width: number): typeof f.item => ({
      ...f.item,
      str,
      width,
      transform: [10, 0, 0, 10, x, 700]
    }),
    original = [
      glyph('Value ', 60, 30),
      { ...glyph(accent, 100, macron ? 5 : 0), transform: [10, 0, 0, 10, 100, 700 + rise] },
      glyph('z', change === 'wide-base' ? 98.4 : 100.6, 5)
    ],
    mark = {
      ...glyph(
        change === 'space-mark' ? ' ̂' : accent,
        change === 'moved-mark' ? 141 : 140,
        macron ? 5 : 0
      ),
      transform: [
        10,
        0,
        0,
        10,
        change === 'moved-mark' ? 141 : 140,
        700 + rise + (change === 'macron-detached' ? 1 : 0)
      ]
    },
    base = {
      ...glyph(
        change === 'wrong-base' ? 'x' : 'z',
        change === 'wide-base' ? 138.4 : 140.6,
        change === 'width' ? 6 : 5
      ),
      ...(change === 'scaled' ? { transform: [11, 0, 0, 11, 140.6, 700] } : {})
    },
    target = [
      glyph('数值 ', 60, 25),
      ...(change === 'missing-mark' ? [] : [mark]),
      ...(change === 'duplicate-mark' ? [mark] : []),
      base,
      ...(change === 'duplicate-base' ? [base] : [])
    ]
  f.originalPage.getTextContent.mockResolvedValue({
    items: original.filter((_, i) => change !== 'missing-source-mark' || i !== 1)
  })
  f.targetPage.getTextContent.mockResolvedValue({ items: target })
  const source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          ...f.results.source.units[0],
          source: `Value z${accent}`,
          fragments: [
            {
              ...f.results.source.units[0].fragments[0],
              items: original.map((x, index) => ({ index, text: x.str }))
            }
          ]
        }
      ]
    }),
    results = {
      source,
      units: [{ id: 'one', translationSource: `Value z${accent}`, translation: `数值 z${accent}` }]
    },
    artifact = { results, data: new Uint8Array([4, 5]) },
    hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each([
  { name: 'native H hat preserves its wide inset', letter: 'H', width: 7.62234, inset: 2.376 },
  { name: 'native W hat preserves its wide inset', letter: 'W', width: 8.70189, inset: 2.687 },
  {
    name: 'native w tilde preserves its inset',
    letter: 'w',
    width: 9.0611,
    inset: 1.588,
    mark: '˜'
  },
  {
    name: 'tilde moved away from its native base',
    letter: 'w',
    width: 9.0611,
    inset: 1.588,
    mark: '˜',
    change: 'detached'
  },
  {
    name: 'native tilde base changed size',
    letter: 'w',
    width: 9.0611,
    inset: 1.588,
    mark: '˜',
    change: 'scaled'
  },
  {
    name: 'native tilde cannot pair with an unclaimed source base',
    letter: 'w',
    width: 9.0611,
    inset: 1.588,
    mark: '˜',
    change: 'unclaimed-base'
  },
  {
    name: 'native base cannot pair with an unclaimed source tilde',
    letter: 'w',
    width: 9.0611,
    inset: 1.588,
    mark: '˜',
    change: 'unclaimed-hat'
  },
  {
    name: 'wide hat moved away from its native base',
    letter: 'W',
    width: 8.70189,
    inset: 2.687,
    change: 'detached'
  },
  {
    name: 'wide native base changed size',
    letter: 'W',
    width: 8.70189,
    inset: 2.687,
    change: 'scaled'
  },
  {
    name: 'hat outside its native letter footprint',
    letter: 'W',
    width: 8.70189,
    inset: 8,
    change: 'outside'
  },
  {
    name: 'wide hat cannot pair with an unclaimed source letter',
    letter: 'W',
    width: 8.70189,
    inset: 2.687,
    change: 'unclaimed-base'
  },
  {
    name: 'wide letter cannot pair with an unclaimed source hat',
    letter: 'W',
    width: 8.70189,
    inset: 2.687,
    change: 'unclaimed-hat'
  }
])('$name', async ({ letter, width, inset, change, mark = 'ˆ' }) => {
  const f = fixture(),
    size = mark === '˜' ? 10.9091 : 8.9664,
    rise = mark === '˜' ? 0.152 : 2.267,
    markWidth = mark === '˜' ? 6.0611 : 4.60783,
    glyph = (str: string, x: number, y: number, width: number): typeof f.item => ({
      ...f.item,
      str,
      width,
      transform: [size, 0, 0, size, x, y]
    }),
    original = [
      glyph('Value ', 60, 700, 30),
      glyph(mark, 100, 700 + rise, markWidth),
      glyph(letter, 100 - inset, 700, width)
    ],
    base = glyph(letter, 140 - inset, 700, width),
    target = [
      glyph('数值 ', 60, 700, 25),
      glyph(mark, change === 'detached' ? 141 : 140, 700 + rise, markWidth),
      change === 'scaled' ? { ...base, transform: [9.5, 0, 0, 9.5, 140 - inset, 700] } : base
    ],
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          ...f.results.source.units[0],
          source: `Value ${letter}${mark}`,
          fragments: [
            {
              ...f.results.source.units[0].fragments[0],
              items: original
                .map((item, index) => ({ index, text: item.str }))
                .filter(
                  ({ index }) =>
                    !(change === 'unclaimed-base' && index === 2) &&
                    !(change === 'unclaimed-hat' && index === 1)
                )
            }
          ]
        }
      ]
    }),
    results = {
      source,
      units: [
        {
          id: 'one',
          translationSource: `Value ${letter}${mark}`,
          translation: `数值 ${letter}${mark}`
        }
      ]
    },
    artifact = { results, data: new Uint8Array([4, 5]) }
  f.originalPage.getTextContent.mockResolvedValue({ items: original })
  f.targetPage.getTextContent.mockResolvedValue({ items: target })
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe(change ? 'error' : 'ready'))
})

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'exact-region-glyph-ownership.jsonl'
  )
)('$name', async ({ change, accepted }) => {
  const f = fixture(),
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          id: 'first',
          source: 'First',
          fragments: [
            {
              pageNumber: 1,
              rect: {
                x: 0.1,
                y: 90 / 800,
                width: 0.5,
                height: (change === 'padding-only' ? 9.5 : 11) / 800
              },
              items: [{ index: 0, text: 'First' }]
            }
          ]
        },
        {
          id: 'second',
          source: 'Second',
          fragments: [
            {
              pageNumber: 1,
              rect: {
                x: 0.1,
                y: (change === 'overlap' ? 99 : 100.5) / 800,
                width: 0.5,
                height: 20 / 800
              },
              items: [{ index: 1, text: 'Second' }]
            }
          ]
        }
      ]
    }),
    results = {
      source,
      units: [
        { id: 'first', translationSource: 'First', translation: '甲' },
        { id: 'second', translationSource: 'Second', translation: '乙' }
      ]
    }
  f.originalPage.getTextContent.mockResolvedValue({
    items: [
      { ...f.item, str: 'First' },
      { ...f.item, str: 'Second', transform: [10, 0, 0, 10, 60, 690] }
    ]
  })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [
      {
        ...f.item,
        str: '甲',
        transform: [
          10,
          0,
          0,
          10,
          change === 'rounded' ? 59.99995 : change === 'outside' ? 59.99 : 60,
          change === 'moved' ? 692 : 700
        ]
      },
      { ...f.item, str: '乙', transform: [10, 0, 0, 10, 60, 690] }
    ]
  })
  const artifact = { results, data: new Uint8Array([4, 5]) },
    hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'moved-neighbor-source-ownership.jsonl'
  )
)('$name', async ({ change, accepted }) => {
  const f = fixture(),
    body = { ...f.item, str: 'First', width: 20 },
    neighbor = {
      ...f.item,
      str: 'k',
      width: 5,
      transform: [7, 0, 0, 7, 100, change === 'rounded-neighbor' ? 699.000501 : 699]
    },
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          id: 'first',
          source: 'First',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 60 / 600, y: 90 / 800, width: 70 / 600, height: 15 / 800 },
              items: [{ index: 0, text: 'First' }]
            }
          ]
        },
        {
          id: 'second',
          source: 'k',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 100 / 600, y: 99 / 800, width: 100 / 600, height: 30 / 800 },
              items: [{ index: 1, text: 'k' }]
            }
          ]
        }
      ]
    }),
    results = {
      source,
      units: [
        { id: 'first', translationSource: 'First', translation: '甲' },
        {
          id: 'second',
          translationSource: 'k',
          translation: ['unchanged-neighbor', 'rounded-neighbor'].includes(change) ? 'k' : '乙'
        }
      ]
    }
  f.originalPage.getTextContent.mockResolvedValue({ items: [body, neighbor] })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [
      ...(change === 'missing-body'
        ? []
        : [{ ...body, str: change === 'changed-body' ? 'Other' : 'First' }]),
      change === 'rounded-neighbor'
        ? { ...neighbor, transform: [7, 0, 0, 7, 100, 699.000499] }
        : change === 'unchanged-neighbor'
          ? neighbor
          : { ...f.item, str: '乙', transform: [10, 0, 0, 10, 160, 680] }
    ]
  })
  const artifact = { results, data: new Uint8Array([4, 5]) },
    hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
  if (accepted) expect(hook.result.current.state).toMatchObject({ originalUnitCount: 1 })
})

it.each([
  ...[1, 2].flatMap((copies) =>
    [
      'same',
      'missing',
      'duplicate',
      'moved',
      'changed-width',
      'changed-symbol',
      ...(copies === 2 ? ['claimed'] : [])
    ].map((change) => ({ copies, change, readOnly: false }))
  ),
  ...['same', 'missing', 'duplicate', 'moved', 'changed-width', 'changed-symbol', 'reordered'].map(
    (change) => ({ copies: 2, change, readOnly: true })
  )
])(
  'preserves exact unclaimed native glyph ownership: $change, $copies source copies, whole page $readOnly',
  async ({ change, copies, readOnly }) => {
    const f = fixture(),
      first = { ...f.item, str: 'Alpha', transform: [10, 0, 0, 10, 140, 700] },
      second = { ...f.item, str: 'Beta', width: 0.5, transform: [10, 0, 0, 10, 129.2, 700] },
      unclaimed = { ...f.item, str: '\u001f', width: 9, transform: [9, 0, 0, 9, 129.998999, 700] },
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            id: 'first',
            source: 'Alpha',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 130 / 600, y: 90 / 800, width: 150 / 600, height: 30 / 800 },
                items: [{ index: 0, text: 'Alpha' }]
              }
            ]
          },
          {
            id: 'second',
            source: 'Beta',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 129 / 600, y: 90 / 800, width: 30 / 600, height: 30 / 800 },
                items: [{ index: 1, text: 'Beta' }]
              }
            ]
          },
          {
            id: 'native',
            sourceOnly: true,
            source: '\u001f'.repeat(copies),
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 129 / 600, y: 90 / 800, width: 10 / 600, height: 30 / 800 },
                items: Array.from({ length: copies }, (_, i) => ({ index: i + 2, text: '\u001f' }))
              }
            ]
          },
          ...(change === 'claimed' || readOnly
            ? [
                {
                  id: 'claimed',
                  source: '\u001f',
                  fragments: [
                    {
                      pageNumber: 1,
                      rect: { x: 129 / 600, y: 90 / 800, width: 10 / 600, height: 30 / 800 },
                      items: [{ index: 3, text: '\u001f' }]
                    }
                  ]
                }
              ]
            : [])
        ]
      }),
      results = {
        source,
        units: [
          { id: 'first', translationSource: 'Alpha', translation: readOnly ? 'Alpha' : '甲' },
          { id: 'second', translationSource: 'Beta', translation: 'Beta' },
          ...(change === 'claimed' || readOnly
            ? [{ id: 'claimed', translationSource: '\u001f', translation: '\u001f' }]
            : [])
        ]
      },
      native =
        change === 'moved'
          ? { ...unclaimed, transform: [9, 0, 0, 9, 130.1, 700] }
          : change === 'changed-width'
            ? { ...unclaimed, width: 9.1 }
            : change === 'changed-symbol'
              ? { ...unclaimed, str: '\u001e' }
              : unclaimed
    f.originalPage.getTextContent.mockResolvedValue({
      items: [first, second, ...Array.from({ length: copies }, () => unclaimed)]
    })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [
        ...(change === 'reordered'
          ? [second, first]
          : [{ ...first, str: readOnly ? 'Alpha' : '甲' }, second]),
        ...(copies === 2 ? [unclaimed] : []),
        ...(change === 'missing' ? [] : [native]),
        ...(change === 'duplicate' ? [native] : [])
      ]
    })
    f.targetPage.getViewport.mockImplementation(() => ({
      ...f.originalPage.getViewport(),
      width: 599.99997
    }))
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(change === 'same' ? 'ready' : 'error')
    )
  }
)

it.each(
  readPdfTranslationCases<{
    name: string
    source: string
    prefix: string
    label: string
    changedAction: boolean
    accepted: boolean
  }>('typed-appendix-letter-verification.jsonl')
)('$name', async (testCase) => {
  const f = fixture(),
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [{ ...f.results.source.units[0], source: testCase.source }]
    }),
    translation = testCase.prefix + testCase.label + '及CIFAR。',
    results = { source, units: [{ id: 'one', translationSource: testCase.source, translation }] },
    item = (str: string, x: number, width: number): typeof f.item => ({
      ...f.item,
      str,
      transform: [10, 0, 0, 10, x, 700],
      width
    })
  f.originalPage.getTextContent.mockResolvedValue({ items: [item(testCase.source, 60, 250)] })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [item(testCase.prefix, 60, 30), item(testCase.label, 100, 7), item('及CIFAR。', 110, 80)]
  })
  const link = {
    annotationType: 2,
    rect: [149, 699, 158, 711],
    url: 'https://example.org/appendix'
  }
  f.originalPage.getAnnotations.mockResolvedValue([link])
  f.targetPage.getAnnotations.mockResolvedValue([
    {
      ...link,
      rect: [99, 699, 108, 711],
      ...(testCase.changedAction ? { url: 'https://example.org/changed' } : {})
    }
  ])
  const artifact = { results, data: new Uint8Array([4, 5]) },
    hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
  await waitFor(() =>
    expect(hook.result.current.state.status).toBe(testCase.accepted ? 'ready' : 'error')
  )
})

it.each(
  readPdfTranslationCases<{ name: string; widths: number[]; regions: number }>(
    'paragraph-width-transition-regions.jsonl'
  )
)('$name', async ({ widths, regions }) => {
  const f = fixture(),
    text = 'First line second line',
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          id: 'one',
          source: text,
          fragments: widths.map((width, index) => ({
            pageNumber: 1,
            rect: { x: 0.1, y: 0.1 + index * 0.02, width, height: 0.02 },
            items: [{ index, text: index ? 'second line' : 'First line' }]
          }))
        }
      ]
    }),
    generatePdf = vi.fn(async (input: { units: Array<{ fragments: unknown[] }> }) => {
      void input
      return new Uint8Array([4, 5])
    })
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  renderHook(() =>
    usePdfTranslationDocument(
      f.original,
      {
        source,
        units: [{ id: 'one', translationSource: text, translation: '第一行第二行' }]
      },
      undefined,
      'reader:0'
    )
  )
  await waitFor(() => expect(generatePdf).toHaveBeenCalledOnce())
  expect(generatePdf.mock.calls[0][0].units[0].fragments).toHaveLength(regions)
})

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'native-raised-footnote-verification.jsonl'
  )
)('$name', async ({ change, accepted }) => {
  const f = fixture(),
    marker = { ...f.item, str: '1', width: 3, transform: [6, 0, 0, 6, 60, 704] },
    original = [
      { ...marker, ...(change === 'source-lowered' ? { transform: [6, 0, 0, 6, 60, 697] } : {}) },
      { ...f.item, str: 'See the note.', width: 80, transform: [10, 0, 0, 10, 64, 700] }
    ],
    moved = {
      ...marker,
      ...(change === 'width' ? { width: 4 } : {}),
      ...(change === 'scale' ? { transform: [7, 0, 0, 7, 60, 704] } : {}),
      ...(change === 'rise' ? { transform: [6, 0, 0, 6, 60, 705] } : {}),
      ...(change === 'target-baseline' ? { transform: [6, 0, 0, 6, 60, 700] } : {}),
      ...(change === 'digit' ? { str: '2' } : {})
    },
    target = [
      ...(change === 'missing' ? [] : [moved]),
      ...(change === 'duplicate' ? [moved] : []),
      { ...f.item, str: '参见说明。', width: 50, transform: [10, 0, 0, 10, 64, 700] }
    ]
  f.originalPage.getTextContent.mockResolvedValue({ items: original })
  f.targetPage.getTextContent.mockResolvedValue({ items: target })
  const source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          ...f.results.source.units[0],
          source: '1See the note.',
          fragments: [
            {
              ...f.results.source.units[0].fragments[0],
              items: original.map((item, index) => ({ index, text: item.str }))
            }
          ]
        }
      ]
    }),
    results = {
      source,
      units: [{ id: 'one', translationSource: '1See the note.', translation: '¹参见说明。' }]
    },
    artifact = { results, data: new Uint8Array([4, 5]) },
    hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
  if (accepted) expect(hook.result.current.state).toMatchObject({ originalUnitCount: 0 })
})

it.each(
  readPdfTranslationCases<{
    name: string
    accepted: boolean
    dy?: number
    outsideX?: boolean
    foreign?: boolean
    changedAction?: boolean
  }>('existing-citation-hit-padding.jsonl')
)(
  'verifies existing citation hit padding: $name',
  async ({ accepted, dy = 0, outsideX, foreign, changedAction }) => {
    const f = fixture(),
      sourceText = 'cell Alpha et al.',
      targetText = '细胞Alpha 等人'
    const source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          ...f.results.source.units[0],
          source: sourceText,
          fragments: [
            {
              ...f.results.source.units[0].fragments[0],
              rect: { x: 0.1, y: 93 / 800, width: 0.5, height: 14 / 800 },
              items: [{ index: 0, text: sourceText }]
            }
          ]
        }
      ]
    })
    const results = {
      source,
      units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
    }
    const item = (str: string, x: number, width: number, y = 700): typeof f.item => ({
      ...f.item,
      str,
      transform: [10, 0, 0, 10, x, y],
      width
    })
    const untouched = foreign ? [item('x', 90, 4, 685)] : []
    f.originalPage.getTextContent.mockResolvedValue({
      items: [item(sourceText, 60, 130), ...untouched]
    })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [item('细胞', 60, 20), item('Alpha 等人', 90, 80), ...untouched]
    })
    const link = {
      annotationType: 2,
      rect: [outsideX ? 40 : 99, 688, outsideX ? 132 : 191, 712],
      url: 'https://example.org/reference'
    }
    f.originalPage.getAnnotations.mockResolvedValue([link])
    f.targetPage.getAnnotations.mockResolvedValue([
      {
        ...link,
        rect: [outsideX ? 30 : 89, 688 + dy, outsideX ? 122 : 181, 712 + dy],
        ...(changedAction ? { url: 'https://example.org/changed' } : {})
      }
    ])
    const artifact = { results, data: new Uint8Array([4, 5]) }
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
  }
)

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'reflowed-script-region-ownership.jsonl'
  )
)('$name', async ({ change, accepted }) => {
  const f = fixture(),
    body = { ...f.item, str: 'First', width: 35 },
    script = {
      ...f.item,
      str: 'BN',
      width: 10,
      transform: [
        7,
        0,
        0,
        7,
        120,
        change === 'baseline-source' ? 700 : change === 'shallow-subscript' ? 698.5 : 697
      ]
    },
    next = { ...f.item, str: 'Next', width: 25, transform: [10, 0, 0, 10, 60, 688] },
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          id: 'first',
          source: 'First BN',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 60 / 600, y: 90 / 800, width: 100 / 600, height: 14 / 800 },
              items: [
                { index: 0, text: 'First' },
                { index: 1, text: 'BN' }
              ]
            }
          ]
        },
        {
          id: 'next',
          source: 'Next',
          fragments: [
            {
              pageNumber: 1,
              rect: {
                x: 60 / 600,
                y: (change === 'shallow-subscript' ? 101 : 102) / 800,
                width: 40 / 600,
                height: 14 / 800
              },
              items: [{ index: 2, text: 'Next' }]
            }
          ]
        }
      ]
    }),
    results = {
      source,
      units: [
        { id: 'first', translationSource: 'First BN', translation: '甲BN' },
        { id: 'next', translationSource: 'Next', translation: '乙' }
      ]
    },
    moved = {
      ...script,
      str: change === 'changed-label' ? 'DN' : 'BN',
      width: 8,
      transform: [
        change === 'changed-size' ? 6 : change === 'minor-fit' ? 6.91 : 7,
        0,
        0,
        change === 'changed-size' ? 6 : change === 'minor-fit' ? 6.91 : 7,
        80,
        change === 'changed-baseline' ? 696.8 : change === 'shallow-subscript' ? 698.5 : 697
      ]
    }
  f.originalPage.getTextContent.mockResolvedValue({ items: [body, script, next] })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [
      { ...body, str: '甲', width: 10 },
      moved,
      ...(change === 'duplicate' ? [{ ...moved, transform: [7, 0, 0, 7, 90, 697] }] : []),
      { ...next, str: '乙', width: 10 }
    ]
  })
  const artifact = { results, data: new Uint8Array([4, 5]) },
    hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'same-paragraph-link-reordering.jsonl'
  )
)('$name', async ({ change, accepted }) => {
  const f = fixture(),
    item = (str: string, x: number, y: number, width: number): typeof f.item => ({
      ...f.item,
      str,
      width,
      transform: [10, 0, 0, 10, x, y]
    }),
    first = item('Apply method.', 60, 700, 75),
    second = item('See Fig. ', 60, 600, 45),
    label = item('2', 105, 600, 6),
    fragments = [
      {
        pageNumber: 1,
        rect: { x: 0.1, y: 90 / 800, width: 0.5, height: 20 / 800 },
        items: [{ index: 0, text: first.str }]
      },
      {
        pageNumber: 1,
        rect: { x: 0.1, y: 190 / 800, width: 0.5, height: 20 / 800 },
        items: [
          { index: 1, text: second.str },
          { index: 2, text: label.str }
        ]
      }
    ],
    sourceText = 'Apply method. See Fig. 2',
    translation = '见图2应用方法。',
    source = createPdfTranslationSource({
      ...f.results.source,
      units:
        change === 'foreign-owner'
          ? [
              { id: 'one', source: first.str, fragments: [fragments[0]] },
              { id: 'two', source: 'See Fig. 2', fragments: [fragments[1]] }
            ]
          : [{ id: 'one', source: sourceText, fragments }]
    }),
    results = {
      source,
      units:
        change === 'foreign-owner'
          ? [
              { id: 'one', translationSource: first.str, translation: '应用方法。' },
              { id: 'two', translationSource: 'See Fig. 2', translation: '见图2' }
            ]
          : [{ id: 'one', translationSource: sourceText, translation }]
    },
    targetY = change === 'outside-region' ? 650 : 700,
    link = { annotationType: 2, rect: [104, 599, 112, 611], url: 'https://example.org/figure' },
    moved = {
      ...link,
      rect: [79, targetY - 1, 87, targetY + 11],
      ...(change === 'changed-action' ? { url: 'https://example.org/other' } : {})
    }
  f.originalPage.getTextContent.mockResolvedValue({ items: [first, second, label] })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [
      item('见图', 60, targetY, 20),
      item(change === 'changed-label' ? '3' : '2', 80, targetY, 6),
      item('应用方法。', 60, 600, 60)
    ]
  })
  f.originalPage.getAnnotations.mockResolvedValue([link])
  f.targetPage.getAnnotations.mockResolvedValue(
    change === 'duplicate-link' ? [moved, moved] : [moved]
  )
  const artifact = { results, data: new Uint8Array([4, 5]) },
    hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{
    name: string
    sourceRise: number
    targetRise: number
    digit: string
    accepted: boolean
    neighbor?: boolean
    base?: string
    targetBase?: string
    sourceDigit?: string
  }>('unicode-power-native-geometry.jsonl')
)('$name', async (entry) => {
  const {
    sourceRise,
    targetRise,
    digit,
    accepted,
    neighbor,
    base = 'a',
    targetBase = base,
    sourceDigit = '2'
  } = entry
  const f = fixture(),
    body = { ...f.item, str: `Value ${base}`, width: 80 },
    marker = {
      ...f.item,
      str: sourceDigit,
      width: 4,
      transform: [7, 0, 0, 7, 140, 700 + sourceRise]
    },
    tail = { ...f.item, str: ' is stable.', width: 50, transform: [10, 0, 0, 10, 146, 700] },
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          id: 'power',
          source: `Value ${base}${sourceDigit} is stable.`,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 60 / 600, y: 88 / 800, width: 160 / 600, height: 25 / 800 },
              items: [
                { index: 0, text: body.str },
                { index: 1, text: marker.str },
                { index: 2, text: tail.str }
              ]
            }
          ]
        }
      ]
    }),
    results = {
      source,
      units: [
        {
          id: 'power',
          translationSource: `Value ${base}${sourceDigit} is stable.`,
          translation: `值${base}${[...sourceDigit].map((d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]).join('')}稳定。`
        }
      ]
    }
  const shifted = (item: typeof body): typeof body => ({
    ...item,
    transform: item.transform.map((value, i) => (i === 5 ? value - 50 : value))
  })
  if (neighbor) {
    results.source = createPdfTranslationSource({
      ...source,
      units: [
        ...source.units,
        {
          ...source.units[0],
          id: 'other-power',
          fragments: source.units[0].fragments.map((fragment) => ({
            ...fragment,
            rect: { ...fragment.rect, y: fragment.rect.y + 50 / 800 },
            items: fragment.items.map((item) => ({ ...item, index: item.index + 3 }))
          }))
        }
      ]
    })
    results.units.push({
      id: 'other-power',
      translationSource: `Value ${base}${sourceDigit} is stable.`,
      translation: `值${base}${sourceDigit}稳定。`
    })
  }
  f.originalPage.getTextContent.mockResolvedValue({
    items: [body, marker, tail, ...(neighbor ? [body, marker, tail].map(shifted) : [])]
  })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [
      { ...body, str: `值${targetBase}`, width: 20 },
      { ...marker, str: digit, transform: [7, 0, 0, 7, 80, 700 + targetRise] },
      { ...tail, str: '稳定。', width: 30, transform: [10, 0, 0, 10, 86, 700] },
      ...(neighbor
        ? [
            { ...body, str: `值${targetBase}`, width: 20, transform: [10, 0, 0, 10, 60, 650] },
            { ...marker, str: '2', transform: [7, 0, 0, 7, 80, 650 + targetRise] },
            { ...tail, str: '稳定。', width: 30, transform: [10, 0, 0, 10, 86, 650] }
          ]
        : [])
    ]
  })
  const artifact = { results, data: new Uint8Array([4, 5]) }
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'same-paragraph-fragment-read-padding.jsonl'
  )
)('$name', async ({ change, accepted }) => {
  const f = fixture(),
    item = (str: string, y: number): typeof f.item => ({
      ...f.item,
      str,
      width: 15,
      transform: [10, 0, 0, 10, 60, y]
    }),
    original = [item('A', 705), item('2', 701), item('B', 690)],
    fragments = [
      {
        pageNumber: 1,
        rect: { x: 60 / 600, y: 90 / 800, width: 150 / 600, height: 10 / 800 },
        items: [
          { index: 0, text: 'A' },
          { index: 1, text: '2' }
        ]
      },
      {
        pageNumber: 1,
        rect: { x: 60 / 600, y: 100.2 / 800, width: 150 / 600, height: 15 / 800 },
        items: [{ index: 2, text: 'B' }]
      }
    ],
    separate = change === 'foreign-owner',
    source = createPdfTranslationSource({
      ...f.results.source,
      units: separate
        ? [
            { id: 'first', source: 'A2', fragments: [fragments[0]] },
            { id: 'second', source: 'B', fragments: [fragments[1]] }
          ]
        : [{ id: 'first', source: 'A2B', fragments }]
    }),
    results = {
      source,
      units: separate
        ? [
            { id: 'first', translationSource: 'A2', translation: '甲2' },
            { id: 'second', translationSource: 'B', translation: '乙' }
          ]
        : [{ id: 'first', translationSource: 'A2B', translation: '甲2乙' }]
    }
  f.originalPage.getTextContent.mockResolvedValue({ items: original })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [
      item('甲', 705),
      ...(change === 'missing' ? [] : [item('2', 699.9)]),
      ...(change === 'duplicate' ? [item('2', 699.9)] : []),
      item('乙', 690)
    ]
  })
  const artifact = { results, data: new Uint8Array([4, 5]) }
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{ name: string; overlap: number; regions: number }>(
    'script-line-box-neighbor-overlap.jsonl'
  )
)('$name', async ({ overlap, regions }) => {
  const f = fixture(),
    text = 'First line second line',
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          id: 'one',
          source: text,
          fragments: [0, 1].map((index) => ({
            pageNumber: 1,
            rect: { x: 0.1, y: 0.1 + index * 0.02, width: 0.5, height: 0.02 },
            items: [{ index, text: index ? 'second line' : 'First line' }]
          }))
        },
        {
          id: 'formula',
          source: 'x = 2',
          sourceOnly: true,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.14 - overlap / 800, width: 0.5, height: 0.02 },
              items: [{ index: 2, text: 'x = 2' }]
            }
          ]
        }
      ]
    }),
    generatePdf = vi.fn<
      (input: {
        units: Array<{ fragments: Array<{ rect: { y: number; height: number } }> }>
      }) => Promise<Uint8Array>
    >(async () => new Uint8Array([4, 5]))
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  renderHook(() =>
    usePdfTranslationDocument(
      f.original,
      {
        source,
        units: [{ id: 'one', translationSource: text, translation: '第一行第二行' }]
      },
      undefined,
      'reader:0'
    )
  )
  await waitFor(() => expect(generatePdf).toHaveBeenCalledOnce())
  const fragments = generatePdf.mock.calls[0][0].units[0].fragments
  expect(fragments).toHaveLength(regions)
  if (regions === 1)
    expect(fragments[0].rect.y + fragments[0].rect.height).toBeCloseTo(0.14 - overlap / 800)
})

it.each(
  readPdfTranslationCases<{ name: string; previousBottom: number; top: number }>(
    'definition-borrowed-top-whitespace.jsonl'
  )
)('$name', async ({ previousBottom, top }) => {
  const f = fixture(),
    text = 'Definition 2.1. A function is convex if',
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          id: 'one',
          source: text,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.02 },
              items: [{ index: 0, text }]
            }
          ]
        },
        {
          id: 'heading',
          source: 'Definitions',
          sourceOnly: true,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: previousBottom - 0.02, width: 0.5, height: 0.02 },
              items: [{ index: 1, text: 'Definitions' }]
            }
          ]
        }
      ]
    }),
    generatePdf = vi.fn(
      async (_input: { units: Array<{ fragments: Array<{ rect: { y: number } }> }> }) => {
        void _input
        return new Uint8Array([4, 5])
      }
    )
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  renderHook(() =>
    usePdfTranslationDocument(
      f.original,
      {
        source,
        units: [
          { id: 'one', translationSource: text, translation: '定义2.1：满足以下条件的函数为凸函数' }
        ]
      },
      undefined,
      'reader:0'
    )
  )
  await waitFor(() => expect(generatePdf).toHaveBeenCalledOnce())
  expect(generatePdf.mock.calls[0][0].units[0].fragments[0].rect.y).toBeCloseTo(top)
})

it.each([
  ...readPdfTranslationCases<{ name: string; gap: number; extra: number; text?: string }>(
    'short-connective-inline-whitespace.jsonl'
  ),
  ...readPdfTranslationCases<{ name: string; gap: number; extra: number; text: string }>(
    'parenthesized-acronym-inline-whitespace.jsonl'
  )
])('$name', async ({ gap, extra, text = 'Hence,' }) => {
  const f = fixture(),
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          id: 'one',
          source: text,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 60 / 600, y: 80 / 800, width: 24 / 600, height: 12 / 800 },
              items: [{ index: 0, text }]
            }
          ]
        },
        {
          id: 'formula',
          source: 'y = 2',
          sourceOnly: true,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: (84 + gap) / 600, y: 80 / 800, width: 20 / 600, height: 12 / 800 },
              items: [{ index: 1, text: 'y = 2' }]
            }
          ]
        }
      ]
    }),
    generatePdf = vi.fn<
      (input: {
        units: Array<{ fragments: Array<{ rect: { width: number; height: number } }> }>
      }) => Promise<Uint8Array>
    >(async () => new Uint8Array([4, 5]))
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  renderHook(() =>
    usePdfTranslationDocument(
      f.original,
      {
        source,
        units: [{ id: 'one', translationSource: text, translation: '因此，' }]
      },
      undefined,
      'reader:0'
    )
  )
  await waitFor(() => expect(generatePdf).toHaveBeenCalledOnce())
  const rect = generatePdf.mock.calls[0][0].units[0].fragments[0].rect
  expect(rect.width * 600).toBeCloseTo(24 + extra)
  expect(rect.height * 800).toBeCloseTo(12 + (/\p{L}/u.test(text) ? 0.25 : 0))
})

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'partially-contained-author-link-runs.jsonl'
  )
)('verifies split author link runs: $name', async ({ change, accepted }) => {
  const f = fixture()
  const item = (str: string, x: number, width: number): typeof f.item => ({
    ...f.item,
    str,
    transform: [10, 0, 0, 10, x, 700],
    width
  })
  const label = 'A¨lpha & Beta'
  const before = [
    item('cell A¨', 60, 50),
    item('lpha', 110, 25),
    item(' & Beta' + (change === 'repeated' ? ' ' + label : ''), 135, 110),
    ...(change === 'foreign' ? [item(' extra', 150, 20)] : [])
  ]
  const sourceText = before.map((part) => part.str).join('')
  const targetLabel = change === 'name' ? 'Gamma & Beta' : label
  const after = [
    item('细胞', 60, 20),
    item(targetLabel, 90, 80),
    ...(change === 'repeated' ? [item(label, 210, 80)] : []),
    ...(change === 'foreign' ? [item(' extra', 210, 20)] : [])
  ]
  const source = createPdfTranslationSource({
    ...f.results.source,
    units: [
      {
        ...f.results.source.units[0],
        source: sourceText,
        fragments: [
          {
            ...f.results.source.units[0].fragments[0],
            items: before.map((part, index) => ({ index, text: part.str }))
          }
        ]
      }
    ]
  })
  const results = {
    source,
    units: [
      {
        id: 'one',
        translationSource: sourceText,
        translation: after.map((part) => part.str).join('')
      }
    ]
  }
  f.originalPage.getTextContent.mockResolvedValue({ items: before })
  f.targetPage.getTextContent.mockResolvedValue({ items: after })
  const link = {
    annotationType: 2,
    rect: [99, 699, 191, 711],
    url: 'https://example.org/reference'
  }
  f.originalPage.getAnnotations.mockResolvedValue([link])
  f.targetPage.getAnnotations.mockResolvedValue([
    {
      ...link,
      rect: [89, 699, 181, 711],
      ...(change === 'action' ? { url: 'https://example.org/changed' } : {})
    }
  ])
  const artifact = { results, data: new Uint8Array([4, 5]) }
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'table-caption-footnote-verification.jsonl'
  )
)('$name', async ({ change, accepted }) => {
  const f = fixture(),
    sourceText = 'Table 1 Participant data at baselinea,b',
    prefix = change === 'table' ? '表2 基线数据' : '表1 基线数据',
    markers = change === 'order' ? 'b,a' : 'a,b',
    translation = prefix + markers,
    item = (str: string, x: number, width: number): typeof f.item => ({
      ...f.item,
      str,
      width,
      transform: [10, 0, 0, 10, x, 700]
    }),
    original = [item(sourceText.slice(0, -3), 60, 180), item('a', 240, 5), item(',b', 245, 8)],
    targetX = change === 'position' ? 450 : 120
  f.originalPage.getTextContent.mockResolvedValue({ items: original })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [
      item(prefix, 60, 55),
      item(markers[0], targetX, 5),
      item(markers.slice(1), targetX + 5, 8)
    ]
  })
  const link = {
    annotationType: 2,
    rect: [239, 699, 246, 711],
    url: 'https://example.org/table-note'
  }
  f.originalPage.getAnnotations.mockResolvedValue([link])
  f.targetPage.getAnnotations.mockResolvedValue([
    {
      ...link,
      rect: [targetX - 1, 699, targetX + 6, 711],
      ...(change === 'destination' ? { url: 'https://example.org/different-note' } : {})
    }
  ])
  const source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          ...f.results.source.units[0],
          source: sourceText,
          fragments: [
            {
              ...f.results.source.units[0].fragments[0],
              items: original.map((value, index) => ({ index, text: value.str }))
            }
          ]
        }
      ]
    }),
    results = { source, units: [{ id: 'one', translationSource: sourceText, translation }] },
    artifact = { results, data: new Uint8Array([4, 5]) },
    hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it.each(
  readPdfTranslationCases<{ name: string; change: string; accepted: boolean }>(
    'bracketed-citation-narrow-hit-area.jsonl'
  )
)('$name', async ({ change, accepted }) => {
  const f = fixture(),
    repeated = change === 'repeated',
    sourceText = repeated ? 'See [3] and [3]' : 'See [3]',
    translation = repeated ? '见[3]和[3]' : '见[3]'
  const source = createPdfTranslationSource({
    ...f.results.source,
    units: [
      {
        ...f.results.source.units[0],
        source: sourceText,
        fragments: [
          {
            ...f.results.source.units[0].fragments[0],
            items: [
              { index: 0, text: 'See ' },
              { index: 1, text: '[3]' },
              ...(repeated
                ? [
                    { index: 2, text: ' and ' },
                    { index: 3, text: '[3]' }
                  ]
                : [])
            ]
          }
        ]
      }
    ]
  })
  const results = { source, units: [{ id: 'one', translationSource: sourceText, translation }] }
  const before = { ...f.item, str: '[3]', width: 12, transform: [10, 0, 0, 10, 100, 700] }
  const after = {
    ...before,
    str: change === 'label' ? '[4]' : '[3]',
    transform: [10, 0, 0, 10, 140 + (change === 'shift' ? 2 : 0), 700]
  }
  f.originalPage.getTextContent.mockResolvedValue({
    items: [
      { ...f.item, str: 'See ', width: 30 },
      before,
      ...(repeated
        ? [
            { ...f.item, str: ' and ', width: 24, transform: [10, 0, 0, 10, 115, 700] },
            { ...before, transform: [10, 0, 0, 10, 160, 700] }
          ]
        : [])
    ]
  })
  f.targetPage.getTextContent.mockResolvedValue({
    items: [
      { ...f.item, str: '见', width: 10 },
      after,
      ...(repeated
        ? [
            { ...f.item, str: '和', width: 10, transform: [10, 0, 0, 10, 153, 700] },
            { ...before, transform: [10, 0, 0, 10, 180, 700] }
          ]
        : [])
    ]
  })
  f.originalPage.getAnnotations.mockResolvedValue([
    { annotationType: 2, url: 'https://example.invalid/cite/3', rect: [103, 699, 109, 708] },
    ...(repeated
      ? [{ annotationType: 2, url: 'https://example.invalid/cite/3', rect: [160, 699, 172, 708] }]
      : [])
  ])
  f.targetPage.getAnnotations.mockResolvedValue([
    { annotationType: 2, url: 'https://example.invalid/cite/3', rect: [143, 699, 149, 708] },
    ...(repeated
      ? [{ annotationType: 2, url: 'https://example.invalid/cite/3', rect: [180, 699, 192, 708] }]
      : [])
  ])
  const artifact = { results, data: new Uint8Array([4, 5]) }
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe(accepted ? 'ready' : 'error'))
})

it('automatically refreshes a repaired paragraph on an already completed page', async () => {
  const f = fixture()
  const generatePdf = vi.fn(async () => new Uint8Array([4, 5]))
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  const hook = renderHook(
    ({ results }) => usePdfTranslationDocument(f.original, results, undefined, 'reader:0'),
    { initialProps: { results: f.results } }
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
  const ready = hook.result.current.ready
  const results = { ...f.results, units: [{ ...f.results.units[0], translation: '细胞内容' }] }
  f.targetPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: '细胞内容' }] })
  hook.rerender({ results })
  expect(hook.result.current.ready).toBe(ready)
  expect(hook.result.current.isCurrent).toBe(false)
  await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(hook.result.current.isCurrent).toBe(true))
  expect(hook.result.current.updateAvailable).toBe(false)
})

it.each([
  'unchanged',
  'digit',
  'missing',
  'duplicate',
  'scale',
  'width',
  'rise',
  'baseline',
  'source-lowered'
])('verifies native author footnotes after translated degrees: %s', async (change) => {
  const f = fixture(),
    item = (str: string, x: number, y: number, size: number, width: number): typeof f.item => ({
      ...f.item,
      str,
      width,
      transform: [size, 0, 0, size, x, y]
    })
  const original = [
    item('Riley PhD', 60, 700, 10, 60),
    item('1†', 120, change === 'source-lowered' ? 700 : 704, 6, 6),
    item(', Morgan MM', 60, 684, 10, 80),
    item('2', 140, 688, 6, 3)
  ]
  const marker = item(
    change === 'digit' ? '3' : '2',
    140,
    change === 'baseline' ? 684 : change === 'rise' ? 689 : 688,
    change === 'scale' ? 7 : 6,
    change === 'width' ? 4 : 3
  )
  const target = [
    item('甲 博士', 60, 700, 10, 60),
    item('1†', 120, 704, 6, 6),
    item('，乙 医学硕士', 60, 684, 10, 80),
    ...(change === 'missing' ? [] : [marker]),
    ...(change === 'duplicate' ? [marker] : [])
  ]
  f.originalPage.getTextContent.mockResolvedValue({ items: original })
  f.targetPage.getTextContent.mockResolvedValue({ items: target })
  const sourceText = 'Riley PhD1†, Morgan MM2',
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          ...f.results.source.units[0],
          source: sourceText,
          fragments: [
            {
              ...f.results.source.units[0].fragments[0],
              items: original.map((i, index) => ({ index, text: i.str }))
            }
          ]
        }
      ]
    }),
    results = {
      source,
      units: [{ id: 'one', translationSource: sourceText, translation: '甲 博士¹†，乙 医学硕士²' }]
    }
  const artifact = { results, data: new Uint8Array([4, 5]) }
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
  )
  await waitFor(() =>
    expect(hook.result.current.state.status).toBe(change === 'unchanged' ? 'ready' : 'error')
  )
  if (change === 'unchanged')
    expect(hook.result.current.state).toMatchObject({ originalUnitCount: 0 })
})

it.each(['unchanged', 'recovered'] as const)(
  'rebuilds a cached PDF and reports an %s layout retry',
  async (outcome) => {
    const f = fixture(),
      native = { ...f.item, str: 'cell' }
    f.originalPage.getTextContent.mockResolvedValue({ items: [native] })
    f.targetPage.getTextContent.mockResolvedValue({ items: [native] })
    Object.assign(f.target, { getData: vi.fn(async () => new Uint8Array([4, 5])) })
    const generatePdf = vi.fn(async () => new Uint8Array([4, 5])),
      translate = vi.fn(),
      beforeReady = vi.fn()
    vi.stubGlobal('api', {
      pdfTranslation: { generatePdf, translate, cancelPdf: vi.fn(async () => {}) }
    })
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, f.results, f.artifact, 'reader:0', beforeReady)
    )
    await waitFor(() => expect(hook.result.current.ready?.retainedUnitIds).toEqual(['one']))
    expect(generatePdf).not.toHaveBeenCalled()
    const previous = hook.result.current.ready?.document,
      dispose = vi.fn(),
      destroyReplacement = vi.fn(async () => {})
    hook.result.current.registerDisposer(dispose)
    const replacement = { ...f.target }
    getDocument.mockReturnValueOnce({
      promise: Promise.resolve(replacement),
      destroy: destroyReplacement
    })
    if (outcome === 'recovered') f.targetPage.getTextContent.mockResolvedValue({ items: [f.item] })
    act(() => {
      hook.result.current.refresh()
      hook.result.current.refresh()
    })
    await waitFor(() => expect(generatePdf).toHaveBeenCalledOnce())
    await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
    expect(translate).not.toHaveBeenCalled()
    if (outcome === 'unchanged') {
      expect(hook.result.current.unchangedLayoutUnitIds).toEqual(['one'])
      expect(hook.result.current.ready?.document).toBe(previous)
      expect(destroyReplacement).toHaveBeenCalledOnce()
      expect(f.destroy).not.toHaveBeenCalled()
      expect(dispose).not.toHaveBeenCalled()
      expect(beforeReady).toHaveBeenCalledOnce()
    } else {
      expect(hook.result.current.unchangedLayoutUnitIds).toEqual([])
      expect(hook.result.current.ready?.retainedUnitIds).toEqual([])
      expect(hook.result.current.ready?.document).toBe(replacement)
      expect(f.destroy).toHaveBeenCalledOnce()
    }
  }
)

it('re-enables layout retry after the paragraph translation changes', async () => {
  const f = fixture(),
    native = { ...f.item, str: 'cell' }
  f.originalPage.getTextContent.mockResolvedValue({ items: [native] })
  f.targetPage.getTextContent.mockResolvedValue({ items: [native] })
  Object.assign(f.target, { getData: vi.fn(async () => new Uint8Array([4, 5])) })
  const generatePdf = vi.fn(async () => new Uint8Array([4, 5]))
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  const hook = renderHook(
    ({ results }) => usePdfTranslationDocument(f.original, results, undefined, 'reader:0'),
    { initialProps: { results: f.results } }
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
  act(() => hook.result.current.refresh())
  await waitFor(() => expect(hook.result.current.unchangedLayoutUnitIds).toEqual(['one']))
  hook.rerender({
    results: { ...f.results, units: [{ ...f.results.units[0], translation: '细胞内容' }] }
  })
  expect(hook.result.current.unchangedLayoutUnitIds).toEqual([])
  await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(3))
  await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
  expect(hook.result.current.updateAvailable).toBe(false)
})

it('regenerates instead of revalidating a broken cached PDF on retry', async () => {
  const f = fixture(),
    generatePdf = vi.fn(async () => new Uint8Array([6, 7]))
  f.targetPage.getTextContent.mockResolvedValueOnce({ items: [{ ...f.item, str: 'broken' }] })
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, f.results, f.artifact, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
  expect(generatePdf).not.toHaveBeenCalled()
  act(() => hook.result.current.retry())
  await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
  expect(generatePdf).toHaveBeenCalledOnce()
  expect(getDocument).toHaveBeenLastCalledWith({ data: new Uint8Array([6, 7]) })
})

it('stops repeating the same validation failure until the translation changes', async () => {
  const f = fixture(),
    generatePdf = vi.fn(async () => new Uint8Array([6, 7]))
  f.targetPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'broken' }] })
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  const hook = renderHook(
    ({ results }) => usePdfTranslationDocument(f.original, results, undefined, 'reader:0'),
    { initialProps: { results: f.results } }
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
  act(() => hook.result.current.retry())
  await waitFor(() =>
    expect(hook.result.current.state).toMatchObject({ status: 'error', retryUnchanged: true })
  )
  expect(generatePdf).toHaveBeenCalledTimes(2)
  act(() => hook.result.current.retry())
  expect(generatePdf).toHaveBeenCalledTimes(2)
  hook.rerender({
    results: { ...f.results, units: [{ ...f.results.units[0], translation: '细胞内容' }] }
  })
  expect(hook.result.current.state).toMatchObject({ status: 'error', retryUnchanged: false })
  f.targetPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: '细胞内容' }] })
  act(() => hook.result.current.retry())
  await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
  expect(generatePdf).toHaveBeenCalledTimes(3)
})

it('keeps transient generation failures retryable', async () => {
  const f = fixture(),
    generatePdf = vi.fn().mockRejectedValue(new PdfGenerationError({ code: 'timeout' }))
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, f.results, undefined, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
  act(() => hook.result.current.retry())
  await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(2))
  await waitFor(() =>
    expect(hook.result.current.state).toMatchObject({ status: 'error', retryUnchanged: false })
  )
  generatePdf.mockResolvedValue(new Uint8Array([4, 5]))
  act(() => hook.result.current.retry())
  await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
  expect(generatePdf).toHaveBeenCalledTimes(3)
})

it('coalesces page completions received during generation without cancelling the active update', async () => {
  const f = fixture()
  f.originalPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
  const source = createPdfTranslationSource({
    ...f.results.source,
    pages: [1, 2, 3].map(() => ({ width: 600, height: 800 })),
    units: [1, 2, 3].map((pageNumber) => ({
      ...f.results.source.units[0],
      id: `unit-${pageNumber}`,
      fragments: [{ ...f.results.source.units[0].fragments[0], pageNumber }]
    }))
  })
  const original = { ...f.original, numPages: 3 } as PDFDocumentProxy
  const accepted = source.units.map((unit) => ({
    id: unit.id,
    translationSource: 'cell',
    translation: '细胞'
  }))
  let renderedPages = new Set<number>()
  let finishSecond!: (bytes: Uint8Array) => void
  const generatePdf = vi.fn(
    async (request: { units: { fragments: { pageNumber: number }[] }[] }) => {
      renderedPages = new Set(
        request.units.flatMap((unit) => unit.fragments.map((fragment) => fragment.pageNumber))
      )
      if (generatePdf.mock.calls.length === 2)
        return new Promise<Uint8Array>((resolve) => {
          finishSecond = resolve
        })
      return new Uint8Array([4, 5])
    }
  )
  getDocument.mockImplementation(() => {
    const pages = new Set(renderedPages)
    return {
      promise: Promise.resolve({
        ...f.target,
        numPages: 3,
        getPage: async (page: number) => (pages.has(page) ? f.targetPage : f.originalPage)
      }),
      destroy: vi.fn(async () => {})
    }
  })
  const snapshots = [1, 2, 3].map((count) => ({ source, units: accepted.slice(0, count) }))
  const cancelPdf = vi.fn(async () => {}),
    beforeReady = vi.fn()
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf } })
  const hook = renderHook(
    ({ count }) =>
      usePdfTranslationDocument(original, snapshots[count - 1], undefined, 'reader:0', beforeReady),
    { initialProps: { count: 1 } }
  )
  await waitFor(() => expect(hook.result.current.ready).toBeDefined())
  const first = hook.result.current.ready
  hook.rerender({ count: 2 })
  await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(2))
  const cancellations = cancelPdf.mock.calls.length
  hook.rerender({ count: 3 })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250))
  })
  expect(generatePdf).toHaveBeenCalledTimes(2)
  expect(cancelPdf).toHaveBeenCalledTimes(cancellations)
  expect(hook.result.current.ready).toBe(first)
  await act(async () => finishSecond(new Uint8Array([4, 5])))
  await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(3))
  await waitFor(() => expect(hook.result.current.isCurrent).toBe(true))
  expect(generatePdf.mock.calls.map(([request]) => request.units.length)).toEqual([1, 2, 3])
  expect(beforeReady).toHaveBeenCalledTimes(3)
})

it('waits for an accepted translation when the first completed page contains only failed blocks', async () => {
  const f = fixture()
  const generatePdf = vi.fn(async () => new Uint8Array([4, 5]))
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  const failed = { ...f.results, units: [] as typeof f.results.units, failedUnitIds: ['one'] }
  const hook = renderHook(
    ({ results }) => usePdfTranslationDocument(f.original, results, undefined, 'reader:0'),
    { initialProps: { results: failed } }
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(generatePdf).not.toHaveBeenCalled()
  expect(hook.result.current.state.status).toBe('idle')
  hook.rerender({ results: { ...f.results, failedUnitIds: [] } })
  await waitFor(() => expect(hook.result.current.isCurrent).toBe(true))
  expect(generatePdf).toHaveBeenCalledOnce()
})

it.each([
  'valid',
  'changed-first',
  'changed-second',
  'lost-first-space',
  'lost-second-space',
  'changed-year',
  'extra-reference',
  'changed-action',
  'not-nfc'
])(
  'verifies a normalized compound-author link only through its complete raw dated citation: %s',
  async (kind) => {
    const f = fixture(),
      sourceText = 'See (Tjong Kim Sang and De Meulder, 2003). More.',
      targetText =
        (kind === 'not-nfc' ? 'e\u0301 ' : '') +
        '见（' +
        (kind === 'changed-first'
          ? 'Tjong Kim Fang'
          : kind === 'lost-first-space'
            ? 'TjongKim Sang'
            : 'Tjong Kim Sang') +
        ' 和 ' +
        (kind === 'changed-second'
          ? 'De Baker'
          : kind === 'lost-second-space'
            ? 'DeMeulder'
            : 'De Meulder') +
        '，' +
        (kind === 'changed-year' ? '2004' : '2003') +
        '）。正文。' +
        (kind === 'extra-reference' ? '见（Tjong Kim Sang 和 De Meulder，2003）。' : ''),
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [{ ...f.results.source.units[0], source: sourceText }]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      },
      tail =
        '和 ' +
        (kind === 'changed-second'
          ? 'De Baker'
          : kind === 'lost-second-space'
            ? 'DeMeulder'
            : 'De Meulder'),
      at = targetText.indexOf(tail),
      item = (str: string, x: number, width: number): typeof f.item => ({
        ...f.item,
        str,
        transform: [10, 0, 0, 10, x, 700],
        width
      })
    f.originalPage.getTextContent.mockResolvedValue({
      items: [item('See (Tjong Kim Sang ', 60, 45), item('and De Meulder, 2003). More.', 110, 240)]
    })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [
        item(targetText.slice(0, at), 60, 35),
        item(tail.replace(/\s/gu, ''), 100, 80),
        item(targetText.slice(at + tail.length), 190, 100)
      ]
    })
    const link = {
      annotationType: 2,
      rect: [109, 699, 191, 711],
      url: 'https://example.org/reference/2003'
    }
    f.originalPage.getAnnotations.mockResolvedValue([link])
    f.targetPage.getAnnotations.mockResolvedValue([
      {
        ...link,
        rect: [99, 699, 181, 711],
        ...(kind === 'changed-action' ? { url: 'https://example.org/changed' } : {})
      }
    ])
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(kind === 'valid' ? 'ready' : 'error')
    )
  }
)

it.each([
  'valid',
  'ascii',
  'month-hit-area',
  'swapped-hit-areas',
  'reordered-numbers',
  'changed-number',
  'duplicate-target-block',
  'missing-close',
  'changed-action',
  'extra-link',
  'distant-bracket',
  'raised-comma',
  'duplicate-source-block',
  'valid-repeated-blocks',
  'missing-repeated-block',
  'extra-repeated-block',
  'swapped-repeated-actions'
] as const)(
  'proves the complete native closed numeric citation before moving a link: %s',
  async (kind) => {
    const f = fixture(),
      repeated = [
        'valid-repeated-blocks',
        'missing-repeated-block',
        'extra-repeated-block',
        'swapped-repeated-actions'
      ].includes(kind),
      repeatSource = repeated || kind === 'duplicate-source-block',
      sourceText = 'Use [10, 11].' + (repeatSource ? ' Again [10, 11].' : ''),
      ascii = kind === 'ascii',
      labels =
        kind === 'reordered-numbers'
          ? ['11', '10']
          : ['10', kind === 'changed-number' ? '12' : '11'],
      open = ascii ? '[' : '［',
      comma = ascii ? ',' : '，',
      close = kind === 'missing-close' ? '' : ascii ? ']' : '］',
      block = open + labels.join(comma) + close,
      targetBlocks =
        kind === 'missing-repeated-block'
          ? 1
          : kind === 'extra-repeated-block'
            ? 3
            : repeated || kind === 'duplicate-target-block'
              ? 2
              : 1,
      targetText =
        '2020年10月参照' +
        Array(targetBlocks)
          .fill(block + '。')
          .join(''),
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments: [
              { ...f.results.source.units[0].fragments[0], items: [{ index: 0, text: sourceText }] }
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      },
      item = (str: string, x: number, width: number, y = 700): typeof f.item => ({
        ...f.item,
        str,
        transform: [10, 0, 0, 10, x, y],
        width
      })
    f.originalPage.getTextContent.mockResolvedValue({
      items: [item(sourceText, 60, repeatSource ? 190 : 90)]
    })
    const after = [
      item('2020年', 60, 35, 720),
      item('10', 95, 12, 720),
      item('月参照', 107, 30, 720)
    ]
    for (let index = 0; index < targetBlocks; index++) {
      const y = 700 - index * 16
      after.push(
        item(open, kind === 'distant-bracket' ? 70 : 80, 10, y),
        item(labels[0], 90, 12, y),
        item(comma, 102, 10, kind === 'raised-comma' ? y + 4 : y),
        item(labels[1], 112, 12, y),
        item(close + '。', 124, 20, y)
      )
    }
    f.targetPage.getTextContent.mockResolvedValue({ items: after })
    const links = Array.from({ length: repeatSource ? 4 : 2 }, (_, index) => ({
      annotationType: 2,
      rect: [
        85 + Math.floor(index / 2) * 70 + (index % 2) * 22,
        699,
        99 + Math.floor(index / 2) * 70 + (index % 2) * 22,
        711
      ],
      url: `https://example.org/reference/${index % 2 === 0 ? 10 : 11}/occurrence/${Math.floor(index / 2)}`
    }))
    f.originalPage.getAnnotations.mockResolvedValue(links)
    const moved = links.map((link, index) => {
      const position =
          kind === 'swapped-hit-areas'
            ? 1 - index
            : kind === 'swapped-repeated-actions'
              ? (index + 2) % 4
              : index,
        y = 699 - Math.floor(position / 2) * 16,
        x = 89 + (position % 2) * 22
      return {
        ...link,
        rect:
          kind === 'month-hit-area' && index === 0 ? [94, 719, 108, 731] : [x, y, x + 14, y + 12],
        ...(kind === 'changed-action' && index === 0 ? { url: 'https://example.org/changed' } : {})
      }
    })
    f.targetPage.getAnnotations.mockResolvedValue(
      kind === 'extra-link' ? [...moved, moved[0]] : moved
    )
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(
        ['valid', 'ascii', 'valid-repeated-blocks'].includes(kind) ? 'ready' : 'error'
      )
    )
    if (!['valid', 'ascii', 'valid-repeated-blocks'].includes(kind))
      expect(hook.result.current.state).toMatchObject({ failure: { code: 'validation-failed' } })
  }
)

it.each([
  'valid',
  'numeric-hit-area-on-author',
  'changed-numeric-year',
  'changed-action',
  'extra-numeric-block'
] as const)(
  'keeps merged author years separate from other complete numeric citation blocks: %s',
  async (kind) => {
    const f = fixture(),
      before = [
        'Use [Other et al., 2018, ',
        'Alpha et al., 2019, Beta et al., 2019]. ',
        'Later Gamma [2019], Delta [2019].'
      ],
      sourceText = before.join(''),
      laterYear = kind === 'changed-numeric-year' ? '2020' : '2019',
      targetText =
        '见[Other 等,2018;Alpha 等,2019;Beta 等,2019]。稍后Gamma[' +
        laterYear +
        '],Delta[2019]。' +
        (kind === 'extra-numeric-block' ? '[2019]' : ''),
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments: [
              {
                ...f.results.source.units[0].fragments[0],
                rect: { x: 0.1, y: 0.075, width: 0.5, height: 0.13 },
                items: before.map((text, index) => ({ index, text }))
              }
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      },
      item = (str: string, x: number, y: number, width: number): typeof f.item => ({
        ...f.item,
        str,
        transform: [10, 0, 0, 10, x, y],
        width
      })
    f.originalPage.getTextContent.mockResolvedValue({
      items: [
        item(before[0], 60, 720, 150),
        item(before[1], 60, 704, 220),
        item(before[2], 60, 688, 220)
      ]
    })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [
        item('见[Other 等,', 60, 720, 70),
        item('2018', 130, 720, 24),
        item(';', 154, 720, 5),
        item('Alpha 等,', 60, 704, 60),
        item('2019', 120, 704, 24),
        item(';Beta 等,', 144, 704, 70),
        item('2019', 214, 704, 24),
        item(']。', 238, 704, 15),
        item('稍后Gamma[', 60, 688, 70),
        item(laterYear, 130, 688, 24),
        item('],Delta[', 154, 688, 60),
        item('2019', 214, 688, 24),
        item(']。', 238, 688, 15),
        ...(kind === 'extra-numeric-block' ? [item('[2019]', 60, 672, 34)] : [])
      ]
    })
    const positions = [
        [180, 720],
        [130, 704],
        [240, 704],
        [130, 688],
        [240, 688]
      ],
      links = positions.map(([x, y], index) => ({
        annotationType: 2,
        rect: [x - 1, y - 1, x + 25, y + 11],
        url: `https://example.org/reference/${index}`
      })),
      targetPositions = [
        [130, 720],
        [120, 704],
        [214, 704],
        [130, 688],
        [214, 688]
      ],
      moved = links.map((link, index) => {
        const [x, y] =
          kind === 'numeric-hit-area-on-author' && index === 3
            ? targetPositions[1]
            : targetPositions[index]
        return {
          ...link,
          rect: [x - 1, y - 1, x + 25, y + 11],
          ...(kind === 'changed-action' && index === 1
            ? { url: 'https://example.org/changed' }
            : {})
        }
      })
    f.originalPage.getAnnotations.mockResolvedValue(links)
    f.targetPage.getAnnotations.mockResolvedValue(moved)
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() => expect(['ready', 'error']).toContain(hook.result.current.state.status))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(kind === 'valid' ? 'ready' : 'error')
    )
  }
)

it.each([
  'valid',
  'hit-padding-jitter',
  'distant-row',
  'not-line-start',
  'not-line-end',
  'interposed-text',
  'changed-vector',
  'swapped-actions'
] as const)(
  'proves a complete numeric citation across adjacent owned native rows: %s',
  async (kind) => {
    const f = fixture(),
      labels = ['27', '31', kind === 'changed-vector' ? '28' : '29', '8'],
      sourceText = 'See [27, 31, 29, 8].',
      targetText = '见［' + labels.join('，') + '］。',
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments: [
              { ...f.results.source.units[0].fragments[0], items: [{ index: 0, text: sourceText }] }
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      },
      item = (str: string, x: number, y: number, width: number): typeof f.item => ({
        ...f.item,
        str,
        transform: [10, 0, 0, 10, x, y],
        width
      }),
      firstX = kind === 'not-line-end' ? 105 : 330,
      nextY = kind === 'distant-row' ? 670 : 688,
      nextX = kind === 'not-line-start' ? 80 : 60
    f.originalPage.getTextContent.mockResolvedValue({ items: [item(sourceText, 60, 700, 240)] })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [
        item('见［', firstX - 15, 700, 15),
        item(labels[0], firstX, 700, 10),
        item('，', firstX + 13, 700, 3),
        ...(kind === 'interposed-text' ? [item('Noise', 60, 694, 25)] : []),
        item(labels[1], nextX, nextY, 10),
        item('，', nextX + 13, nextY, 3),
        item(labels[2], nextX + 19, nextY, 10),
        item('，', nextX + 32, nextY, 3),
        item(labels[3], nextX + 38, nextY, 5),
        item('］。', nextX + 46, nextY, 14)
      ]
    })
    const links = [180, 200, 220, 240].map((x, index) => {
        const jitter = kind === 'hit-padding-jitter' && index === 1 ? 0.08 : 0
        return {
          annotationType: 2,
          rect: [x - 1, 699 - jitter, x + (index === 3 ? 6 : 11), 711 - jitter],
          url: `https://example.org/reference/${index}`
        }
      }),
      positions = [
        [firstX, 700],
        [nextX, nextY],
        [nextX + 19, nextY],
        [nextX + 38, nextY]
      ],
      moved = links.map((link, index) => {
        const [x, y] = positions[kind === 'swapped-actions' && index < 2 ? 1 - index : index],
          jitter = kind === 'hit-padding-jitter' && index === 2 ? 0.08 : 0
        return {
          ...link,
          rect: [x - 1, y - 1 - jitter, x + (index === 3 ? 6 : 11), y + 11 - jitter]
        }
      })
    f.originalPage.getAnnotations.mockResolvedValue(links)
    f.targetPage.getAnnotations.mockResolvedValue(moved)
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(
        ['valid', 'hit-padding-jitter'].includes(kind) ? 'ready' : 'error'
      )
    )
  }
)

it.each(['valid', 'changed-action', 'changed-vector'] as const)(
  'allows independently complete citation blocks to move with translated prose: %s',
  async (kind) => {
    const f = fixture(),
      sourceText = 'Use [13] then [23].',
      second = kind === 'changed-vector' ? '14' : '13',
      targetText = '先［23］后［' + second + '］。',
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments: [
              { ...f.results.source.units[0].fragments[0], items: [{ index: 0, text: sourceText }] }
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      },
      item = (str: string, x: number, width: number): typeof f.item => ({
        ...f.item,
        str,
        transform: [10, 0, 0, 10, x, 700],
        width
      })
    f.originalPage.getTextContent.mockResolvedValue({ items: [item(sourceText, 60, 150)] })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [
        item('先［', 60, 20),
        item('23', 80, 10),
        item('］后［', 90, 25),
        item(second, 115, 10),
        item('］。', 125, 15)
      ]
    })
    const links = [90, 160].map((x, index) => ({
      annotationType: 2,
      rect: [x - 1, 699, x + 11, 711],
      url: `https://example.org/reference/${index}`
    }))
    f.originalPage.getAnnotations.mockResolvedValue(links)
    f.targetPage.getAnnotations.mockResolvedValue(
      links.map((link, index) => ({
        ...link,
        rect: index === 0 ? [114, 699, 126, 711] : [79, 699, 91, 711],
        ...(kind === 'changed-action' && index === 0 ? { url: 'https://example.org/changed' } : {})
      }))
    )
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(kind === 'valid' ? 'ready' : 'error')
    )
  }
)

it.each([
  'same-ink',
  'neighbor-ink',
  'invalid-font-metrics',
  'blank-ink',
  'transparent-ink',
  'changed-ink',
  'changed-character',
  'moved-piece',
  'changed-width',
  'duplicate-piece'
])(
  'verifies a split untouched neighboring run with complete geometry and rendered ink: %s',
  async (kind) => {
    const { createCanvas } = await import('@napi-rs/canvas')
    const f = fixture(),
      before = {
        str: '1) (%)',
        fontName: 'native',
        transform: [10, 0, 0, 10, 100, 700],
        width: 30
      },
      first = { ...before, str: kind === 'changed-character' ? '2)' : '1)', width: 10 },
      last = {
        ...before,
        str: '(%)',
        width: kind === 'changed-width' ? 14 : 15,
        transform: [10, 0, 0, 10, kind === 'moved-piece' ? 116 : 115, 700]
      },
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 60 / 600, y: 80 / 800, width: 160 / 600, height: 35 / 800 },
                items: [{ index: 0, text: 'cell' }]
              }
            ]
          },
          {
            id: 'untouched',
            source: before.str,
            sourceOnly: true,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 100 / 600, y: 90 / 800, width: 30 / 600, height: 10 / 800 },
                items: [{ index: 1, text: before.str }]
              }
            ]
          }
        ]
      })
    const originalText = {
      items: [{ ...f.item, str: 'cell' }, before],
      styles:
        kind === 'neighbor-ink' || kind === 'invalid-font-metrics'
          ? {
              native: {
                ascent: kind === 'invalid-font-metrics' ? NaN : 0.72,
                descent: -0.18,
                vertical: false
              }
            }
          : {}
    }
    f.originalPage.getTextContent.mockResolvedValue(originalText)
    f.targetPage.getTextContent.mockResolvedValue({
      items: [f.item, first, last, ...(kind === 'duplicate-piece' ? [last] : [])]
    })
    const createElement = document.createElement.bind(document),
      canvasFactory = vi
        .spyOn(document, 'createElement')
        .mockImplementation(((tag: string, options?: ElementCreationOptions) =>
          tag === 'canvas'
            ? (createCanvas(1, 1) as unknown as HTMLCanvasElement)
            : createElement(tag, options)) as typeof document.createElement),
      render = (changed: boolean): ReturnType<typeof vi.fn> =>
        vi.fn(
          ({
            canvasContext: context,
            transform
          }: {
            canvasContext: CanvasRenderingContext2D
            transform: number[]
          }) => {
            if (kind !== 'transparent-ink') {
              context.fillStyle = 'white'
              context.fillRect(0, 0, context.canvas.width, context.canvas.height)
              context.fillStyle = 'black'
              // Matching run bounds alone cannot detect movement of an inner glyph.
              if (kind !== 'blank-ink')
                context.fillRect(kind === 'changed-ink' && changed ? 5 : 4, 4, 3, 3)
              if (changed && ['neighbor-ink', 'invalid-font-metrics'].includes(kind))
                context.fillRect(4, 440 + transform[5], 3, 3)
            }
            return { promise: Promise.resolve() }
          }
        ),
      originalRender = render(false),
      targetRender = render(['changed-ink', 'neighbor-ink', 'invalid-font-metrics'].includes(kind))
    Object.assign(f.originalPage, { render: originalRender })
    Object.assign(f.targetPage, { render: targetRender })
    for (const page of [f.originalPage, f.targetPage])
      Object.assign(page, {
        getViewport: vi.fn(({ scale = 1 }: { scale?: number } = {}) => ({
          width: 600 * scale,
          height: 800 * scale,
          rotation: 0,
          convertToViewportPoint: (x: number, y: number): number[] => [x * scale, (800 - y) * scale]
        }))
      })
    const results = { ...f.results, source },
      artifact = { ...f.artifact, results }
    try {
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
      )
      await waitFor(() =>
        expect(hook.result.current.state.status).toBe(
          kind === 'same-ink' || kind === 'neighbor-ink' ? 'ready' : 'error'
        )
      )
      if (
        [
          'same-ink',
          'neighbor-ink',
          'invalid-font-metrics',
          'changed-ink',
          'blank-ink',
          'transparent-ink'
        ].includes(kind)
      ) {
        expect(originalRender).toHaveBeenCalledOnce()
        expect(targetRender).toHaveBeenCalledOnce()
      } else {
        expect(originalRender).not.toHaveBeenCalled()
        expect(targetRender).not.toHaveBeenCalled()
      }
    } finally {
      canvasFactory.mockRestore()
    }
  }
)

it.each([
  'valid',
  'changed-action',
  'changed-piece',
  'changed-query',
  'duplicate-target',
  'missing-claim',
  'wrong-claim',
  'changed-width',
  'shifted-glyph',
  'changed-font',
  'incomplete-group'
] as const)('verifies native wrapped URI overhang without borrowing prose: %s', async (kind) => {
  const f = fixture(),
    uri = 'https://alpha.example.org/reference',
    sourceText = 'Read https: //alpha.example.org/reference.',
    targetText = `阅读https: //alpha.example.org/reference${kind === 'changed-query' ? '?other' : ''}。${kind === 'duplicate-target' ? uri : ''}`,
    item = (
      str: string,
      x: number,
      y: number,
      width: number
    ): typeof f.item & { fontName: string } => ({
      ...f.item,
      str,
      transform: [10, 0, 0, 10, x, y],
      width,
      fontName: 'native-uri'
    }),
    native = [
      item('Read ', 60, 700, 25),
      item('https:', 85, 700, 25),
      item('//alpha.example.org/reference', 60, 680, 150),
      item('.', 210, 680, 2)
    ],
    source = createPdfTranslationSource({
      ...f.results.source,
      units: [
        {
          ...f.results.source.units[0],
          source: sourceText,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.07 },
              items: native.flatMap((run, index) =>
                kind === 'missing-claim' && index === 1
                  ? []
                  : [
                      {
                        index,
                        text: kind === 'wrong-claim' && index === 1 ? 'other' : run.str
                      }
                    ]
              )
            }
          ]
        }
      ]
    }),
    results = {
      source,
      units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
    },
    styles = {
      'native-uri': { fontFamily: 'monospace', ascent: 0.7, descent: -0.2, vertical: false }
    },
    links = [
      { annotationType: 2, url: uri, rect: [84, 699, 108, 711] },
      { annotationType: 2, url: uri, rect: [59, 679, 211, 691] }
    ],
    moved = links.map((link, index) => ({
      ...link,
      rect: index === 0 ? [104, 699, 128, 711] : [69, 679, 221, 691],
      ...(kind === 'changed-action' && index === 0 ? { url: uri + '?other' } : {})
    }))
  f.originalPage.getTextContent.mockResolvedValue(Object.assign({ items: native }, { styles }))
  f.targetPage.getTextContent.mockResolvedValue(
    Object.assign(
      {
        items: [
          item('阅读', 60, 700, 40),
          item(
            kind === 'changed-piece' ? 'httpx:' : 'https:',
            kind === 'shifted-glyph' ? 106 : 105,
            700,
            kind === 'changed-width' ? 26 : 25
          ),
          item('//alpha.example.org/reference', 70, 680, 150),
          item(kind === 'changed-query' ? '?other。' : '。', 220, 680, 10),
          ...(kind === 'duplicate-target' ? [item(uri, 60, 660, 180)] : [])
        ]
      },
      {
        styles:
          kind === 'changed-font'
            ? { 'native-uri': { ...styles['native-uri'], fontFamily: 'serif' } }
            : styles
      }
    )
  )
  f.originalPage.getAnnotations.mockResolvedValue(
    kind === 'incomplete-group' ? links.slice(0, 1) : links
  )
  f.targetPage.getAnnotations.mockResolvedValue(
    kind === 'incomplete-group' ? moved.slice(0, 1) : moved
  )
  const artifact = { results, data: new Uint8Array([4, 5]) },
    hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
  await waitFor(() =>
    expect(hook.result.current.state.status).toBe(kind === 'valid' ? 'ready' : 'error')
  )
})

it.each([
  'valid',
  'wrong-destination',
  'incomplete-group',
  'swapped-parts',
  'changed-matrix',
  'missing-author',
  'other-source-author',
  'changed-ink',
  'blank-ink'
] as const)(
  'binds a repeated wrapped collective citation to its native author and action: %s',
  async (kind) => {
    const { createCanvas } = await import('@napi-rs/canvas')
    const f = fixture(),
      item = (
        str: string,
        x: number,
        y: number,
        width: number
      ): typeof f.item & { fontName: string } => ({
        str,
        fontName: 'native',
        transform: [10, 0, 0, 10, x, y],
        width
      }),
      native = [
        item('Models BART (Lewis', 60, 700, 160),
        item('et al., 2020) and T5 (Raffel et al., 2021).', 60, 680, 260),
        ...(kind === 'other-source-author' ? [item('Other (Raffel', 60, 660, 160)] : [])
      ],
      sourceText = native.map(({ str }) => str).join(' '),
      targetText =
        kind === 'missing-author'
          ? '模型 BART (et al., 2020) 和 T5 (Raffel et al., 2021)。'
          : '模型 BART (Lewis et al., 2020) 和 T5 (Raffel et al., 2021)。',
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.7, height: 0.12 },
                items: native.map(({ str }, index) => ({ index, text: str }))
              }
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      },
      styles = { native: { ascent: 0.9, descent: -0.2, vertical: false, fontFamily: 'serif' } },
      after = [
        item('模型 BART (', 60, 700, 40),
        item(kind === 'missing-author' ? '' : 'Lewis', 100, 700, 26),
        item(' ', 126, 700, 6),
        item('et al.', 132, 700, 24),
        item(', ', 156, 700, 12),
        item('2020', 168, 700, 24),
        item(') 和 T5 (Raffel et al., 2021)。', 192, 700, 160)
      ]
    if (kind === 'changed-matrix') after[3].transform[0] = 11
    f.originalPage.getTextContent.mockResolvedValue(Object.assign({ items: native }, { styles }))
    f.targetPage.getTextContent.mockResolvedValue(Object.assign({ items: after }, { styles }))
    const links = [
        {
          rect: [
            193,
            kind === 'other-source-author' ? 659 : 699,
            221,
            kind === 'other-source-author' ? 671 : 711
          ]
        },
        { rect: [59, 679, 85, 691] },
        { rect: [91, 679, 117, 691] }
      ].map((part) => ({ ...part, annotationType: 2, url: 'https://example.org/Lewis2020' })),
      moved = [
        { ...links[0], rect: [99, 699, 127, 711] },
        { ...links[1], rect: [131, 699, 157, 711] },
        { ...links[2], rect: [167, 699, 193, 711] }
      ]
    if (kind === 'wrong-destination') moved[1].url = 'https://example.org/Raffel2020'
    if (kind === 'swapped-parts') [moved[1].rect, moved[2].rect] = [moved[2].rect, moved[1].rect]
    if (kind === 'incomplete-group') {
      links.pop()
      moved.pop()
    }
    f.originalPage.getAnnotations.mockResolvedValue(links)
    f.targetPage.getAnnotations.mockResolvedValue(moved)
    const createElement = document.createElement.bind(document),
      canvasFactory = vi
        .spyOn(document, 'createElement')
        .mockImplementation(((tag: string, options?: ElementCreationOptions) =>
          tag === 'canvas'
            ? (createCanvas(1, 1) as unknown as HTMLCanvasElement)
            : createElement(tag, options)) as typeof document.createElement),
      render = (changed: boolean): ReturnType<typeof vi.fn> =>
        vi.fn(({ canvasContext: context }: { canvasContext: CanvasRenderingContext2D }) => {
          context.fillStyle = 'white'
          context.fillRect(0, 0, context.canvas.width, context.canvas.height)
          context.fillStyle = 'black'
          if (kind !== 'blank-ink')
            context.fillRect(changed && kind === 'changed-ink' ? 5 : 4, 4, 3, 3)
          return { promise: Promise.resolve() }
        })
    Object.assign(f.originalPage, { render: render(false) })
    Object.assign(f.targetPage, { render: render(true) })
    for (const page of [f.originalPage, f.targetPage])
      Object.assign(page, {
        getViewport: vi.fn(({ scale = 1 }: { scale?: number } = {}) => ({
          width: 600 * scale,
          height: 800 * scale,
          rotation: 0,
          convertToViewportPoint: (x: number, y: number): number[] => [x * scale, (800 - y) * scale]
        }))
      })
    const artifact = { results, data: new Uint8Array([4, 5]) }
    try {
      const hook = renderHook(() =>
        usePdfTranslationDocument(f.original, results, artifact, 'reader:0')
      )
      await waitFor(() =>
        expect(hook.result.current.state.status).toBe(kind === 'valid' ? 'ready' : 'error')
      )
    } finally {
      canvasFactory.mockRestore()
    }
  }
)

it.each([
  'valid',
  'changed-other-source-year',
  'changed-other-target-year',
  'missing-claim',
  'changed-action',
  'missing-close',
  'missing-link',
  'changed-width',
  'distant-comma'
] as const)(
  'binds repeated merged author/year links to complete native dated pairs: %s',
  async (kind) => {
    const f = fixture(),
      sourceText =
        'See (Quinn et al., 2031). Quinn et al. (' +
        (kind === 'changed-other-source-year' ? '2032' : '2031') +
        ') agrees.',
      secondYear = kind === 'changed-other-target-year' ? '2032' : '2031',
      close = kind === 'missing-close' ? '同意。' : '）同意。',
      targetText = '见（Quinn et al.，2031）。Quinn et al.（' + secondYear + close,
      glyph = (str: string, x: number, width: number): typeof f.item => ({
        ...f.item,
        str,
        transform: [10, 0, 0, 10, x, 700],
        width
      }),
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
                items: [{ index: kind === 'missing-claim' ? 99 : 0, text: sourceText }]
              }
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      }
    f.originalPage.getTextContent.mockResolvedValue({ items: [glyph(sourceText, 60, 290)] })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [
        glyph('见（', 60, 15),
        glyph('Quinn et al.', 75, 40),
        glyph('，', kind === 'distant-comma' ? 40 : 115, 10),
        glyph('2031', 128, 25),
        glyph('）。', 155, 25),
        glyph('Quinn et al.', 185, 40),
        glyph('（', 228, 15),
        glyph(secondYear, 248, 25),
        glyph(close, 275, 70)
      ]
    })
    const links = [85, 148, 190, 253].map((x, index) => ({
      annotationType: 2,
      url: 'https://example.org/quinn/2031',
      rect: [x, 698, x + (index % 2 ? 25 : 40), 711]
    }))
    f.originalPage.getAnnotations.mockResolvedValue(links)
    f.targetPage.getAnnotations.mockResolvedValue(
      links.slice(0, kind === 'missing-link' ? 3 : 4).map((link, index) => ({
        ...link,
        url: kind === 'changed-action' && index === 0 ? 'https://example.org/wrong' : link.url,
        rect: [
          [75, 128, 185, 248][index],
          698,
          [75, 128, 185, 248][index] +
            (index % 2 ? 25 : 40) +
            (kind === 'changed-width' && index === 0 ? 1 : 0),
          711
        ]
      }))
    )
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(kind === 'valid' ? 'ready' : 'error')
    )
  }
)

it.each([
  'valid',
  'changed-action',
  'missing-component',
  'bare-information',
  'changed-width',
  'outside-owner'
] as const)(
  'verifies wrapped supporting-information components and their original actions: %s',
  async (kind) => {
    const f = fixture(),
      sourceText = 'Data are in Supporting information.',
      targetText = kind === 'bare-information' ? '数据见信息。' : '数据见支持信息。',
      glyph = (str: string, x: number, y: number, width: number): typeof f.item => ({
        ...f.item,
        str,
        transform: [10, 0, 0, 10, x, y],
        width
      }),
      sourceItems = [
        glyph('Data are in ', 60, 700, 65),
        glyph('Supporting', 130, 700, 55),
        glyph('information.', 60, 680, 65)
      ],
      source = createPdfTranslationSource({
        ...f.results.source,
        units: [
          {
            ...f.results.source.units[0],
            source: sourceText,
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
                items: sourceItems.map((item, index) => ({ index, text: item.str }))
              }
            ]
          }
        ]
      }),
      results = {
        source,
        units: [{ id: 'one', translationSource: sourceText, translation: targetText }]
      }
    f.originalPage.getTextContent.mockResolvedValue({ items: sourceItems })
    f.targetPage.getTextContent.mockResolvedValue({
      items: [
        glyph('数据见', 60, 700, 30),
        ...(kind === 'bare-information' || kind === 'missing-component'
          ? []
          : [glyph('支持', 100, 700, 20)]),
        glyph('信息', kind === 'outside-owner' ? 400 : 165, 700, 20),
        glyph('。', 230, 700, 10)
      ]
    })
    const url = 'https://example.org/supporting',
      links = [
        { annotationType: 2, url, rect: [130, 698, 187, 711] },
        { annotationType: 2, url, rect: [60, 678, 118, 691] }
      ]
    f.originalPage.getAnnotations.mockResolvedValue(links)
    const x = kind === 'outside-owner' ? 400 : 165
    f.targetPage.getAnnotations.mockResolvedValue([
      { ...links[0], rect: [100, 698, 157 + (kind === 'changed-width' ? 1 : 0), 711] },
      {
        ...links[1],
        url: kind === 'changed-action' ? 'https://example.org/changed' : url,
        rect: [x, 698, x + 58, 711]
      }
    ])
    const artifact = { results, data: new Uint8Array([4, 5]) },
      hook = renderHook(() => usePdfTranslationDocument(f.original, results, artifact, 'reader:0'))
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(kind === 'valid' ? 'ready' : 'error')
    )
  }
)

it.each(['reuse', 'changed-link', 'full-fallback', 'cache-save', 'cache-hit'] as const)(
  'updates only a changed page while protecting reused pages (%s)',
  async (mode) => {
    const fixtures = Array.from({ length: 3 }, () => fixture())
    const source = createPdfTranslationSource({
      ...fixtures[0].results.source,
      pages: Array.from({ length: 3 }, () => ({ width: 600, height: 800 })),
      units: fixtures.map((f, index) => ({
        ...f.results.source.units[0],
        id: `page-${index + 1}`,
        fragments: [{ ...f.results.source.units[0].fragments[0], pageNumber: index + 1 }]
      }))
    })
    const results = {
      source,
      ...(['cache-save', 'cache-hit'].includes(mode)
        ? { checkpoint: { source: 'version-1', key: 'edition-1' } }
        : {}),
      units: source.units.map((unit) => ({
        id: unit.id,
        translationSource: unit.source,
        translation: '细胞'
      }))
    }
    const original = {
      ...fixtures[0].original,
      numPages: 3,
      getPage: vi.fn(async (number: number) => fixtures[number - 1].originalPage)
    } as unknown as PDFDocumentProxy
    const target = {
      ...fixtures[0].target,
      numPages: 3,
      getPage: vi.fn(async (number: number) => fixtures[number - 1].targetPage)
    }
    getDocument.mockReturnValue({
      promise: Promise.resolve(target),
      destroy: vi.fn(async () => {})
    })
    const generatePdf = vi.fn(
      async (input: PdfTranslationPdfRequest): Promise<Uint8Array | PdfTranslationPdfResult> =>
        input.cache
          ? {
              data: new Uint8Array([4, 5]),
              layoutFailures: [],
              cacheToken: '00000000-0000-4000-8000-000000000001',
              cacheHit: mode === 'cache-hit' && Boolean(input.incremental)
            }
          : new Uint8Array([4, 5])
    )
    const recordLayout = vi
      .fn<(request: PdfTranslationRecordLayoutRequest) => Promise<void>>()
      .mockResolvedValue(undefined)
    vi.stubGlobal('api', {
      pdfTranslation: { generatePdf, recordLayout, cancelPdf: vi.fn(async () => {}) }
    })
    const hook = renderHook(
      ({ results }) => usePdfTranslationDocument(original, results, undefined, 'reader:0'),
      { initialProps: { results } }
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
    const previousReady = hook.result.current.ready
    expect(hook.result.current.unfilledUnitIds).toEqual([])
    expect(fixtures.map((f) => f.targetPage.getTextContent.mock.calls.length)).toEqual([1, 1, 1])
    if (mode === 'changed-link')
      fixtures[0].targetPage.getAnnotations.mockResolvedValue([
        { annotationType: 2, rect: [40, 40, 50, 50], url: 'https://example.org/changed' }
      ])
    if (mode === 'full-fallback')
      generatePdf.mockRejectedValueOnce(new PdfGenerationError({ code: 'worker-failed' }))
    fixtures[1].targetPage.getTextContent.mockResolvedValue({
      items: [{ ...fixtures[1].item, str: '细胞内容' }]
    })
    const next = {
      ...results,
      units: results.units.map((unit, index) =>
        index === 1 ? { ...unit, translation: '细胞内容' } : unit
      )
    }
    hook.rerender({ results: next })
    expect(hook.result.current.unfilledUnitIds).toEqual(['page-2'])
    expect(hook.result.current.ready).toBe(previousReady)
    await waitFor(() =>
      expect(hook.result.current.state.status).toBe(mode === 'changed-link' ? 'error' : 'ready')
    )
    await waitFor(() =>
      expect(generatePdf.mock.calls.length).toBe(mode === 'full-fallback' ? 3 : 2)
    )
    expect(generatePdf.mock.calls[1][0]).toMatchObject({
      incremental: { data: new Uint8Array([4, 5]), pageNumbers: [2] }
    })
    if (['reuse', 'cache-save', 'cache-hit'].includes(mode)) {
      await waitFor(() => expect(hook.result.current.isCurrent).toBe(true))
      expect(fixtures.map((f) => f.targetPage.getTextContent.mock.calls.length)).toEqual(
        mode === 'cache-hit' ? [2, 2, 2] : [1, 2, 1]
      )
      expect(hook.result.current.ready?.pages).toHaveLength(3)
      if (mode !== 'reuse') {
        const report = recordLayout.mock.calls.at(-1)![0]
        expect(report.pdfCacheToken).toBe('00000000-0000-4000-8000-000000000001')
        expect(report.units.map((unit) => unit.sourceIndex)).toEqual([0, 1, 2])
      }
    } else if (mode === 'full-fallback') {
      await waitFor(() => expect(hook.result.current.isCurrent).toBe(true))
      expect(generatePdf.mock.calls[2][0]).not.toHaveProperty('incremental')
      expect(fixtures.map((f) => f.targetPage.getTextContent.mock.calls.length)).toEqual([2, 2, 2])
    } else {
      expect(hook.result.current.state).toMatchObject({
        status: 'error',
        failure: { code: 'validation-failed', pageNumber: 1 }
      })
      expect(hook.result.current.ready).toBe(previousReady)
      expect(hook.result.current.unfilledUnitIds).toEqual(['page-2'])
    }
    if (mode !== 'changed-link') expect(hook.result.current.unfilledUnitIds).toEqual([])
  }
)

it('keeps all accepted text marked unfilled when first PDF generation fails', async () => {
  const f = fixture()
  const generatePdf = vi
    .fn()
    .mockRejectedValue(new PdfGenerationError({ code: 'source-mismatch', pageNumber: 1 }))
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, f.results, undefined, 'reader:0')
  )
  expect(hook.result.current.unfilledUnitIds).toEqual(['one'])
  await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
  expect(hook.result.current.ready).toBeUndefined()
  expect(hook.result.current.unfilledUnitIds).toEqual(['one'])
  expect(hook.result.current.state).toMatchObject({
    failure: { code: 'source-mismatch', pageNumber: 1 }
  })
  expect(f.results.units[0].translation).toBe('细胞')
})

it.each([false, true, 'automatic'] as const)(
  'retries one retained paragraph page with new pending results: %s',
  async (pendingResults) => {
    const fixtures = Array.from({ length: 3 }, () => fixture())
    for (const f of fixtures) {
      f.originalPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
      f.targetPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
    }
    const source = createPdfTranslationSource({
      ...fixtures[0].results.source,
      pages: Array.from({ length: 3 }, () => ({ width: 600, height: 800 })),
      units: fixtures.map((f, index) => ({
        ...f.results.source.units[0],
        id: `page-${index + 1}`,
        fragments: [{ ...f.results.source.units[0].fragments[0], pageNumber: index + 1 }]
      }))
    })
    const results = {
      source,
      checkpoint: { key: '00000000-0000-4000-8000-000000000001', source: 'attachment' },
      units: source.units.map((unit) => ({
        id: unit.id,
        translationSource: unit.source,
        translation: '细胞'
      }))
    }
    const original = {
      ...fixtures[0].original,
      numPages: 3,
      getPage: async (number: number) => fixtures[number - 1].originalPage
    } as unknown as PDFDocumentProxy
    const target = {
      ...fixtures[0].target,
      numPages: 3,
      getPage: async (number: number) => fixtures[number - 1].targetPage
    }
    getDocument.mockReturnValue({
      promise: Promise.resolve(target),
      destroy: vi.fn(async () => {})
    })
    const generatePdf = vi.fn(async (input: PdfTranslationPdfRequest) => {
      void input
      return new Uint8Array([4, 5])
    })
    const recordLayout = vi.fn(async () => {})
    vi.stubGlobal('api', {
      pdfTranslation: { generatePdf, recordLayout, cancelPdf: vi.fn(async () => {}) }
    })
    const hook = renderHook(
      ({ current }) => usePdfTranslationDocument(original, current, undefined, 'reader:0'),
      {
        initialProps: {
          current: pendingResults ? { ...results, units: results.units.slice(0, 2) } : results
        }
      }
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
    expect(hook.result.current.unfilledUnitIds).toEqual(
      pendingResults ? ['page-1', 'page-2'] : ['page-1', 'page-2', 'page-3']
    )
    fixtures[1].targetPage.getTextContent.mockResolvedValue({ items: [fixtures[1].item] })
    if (pendingResults) hook.rerender({ current: results })
    if (pendingResults === 'automatic') {
      await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
      expect(generatePdf.mock.calls[1][0]).toMatchObject({ incremental: { pageNumbers: [3] } })
      // Page 3 refreshed automatically. Retained pages 1 and 2 were only reused,
      // so their first manual retry must remain available.
      expect(hook.result.current.unchangedLayoutUnitIds).toEqual([])
      expect(hook.result.current.unfilledUnitIds).toEqual(['page-1', 'page-2', 'page-3'])
    }
    act(() => hook.result.current.refresh('page-2'))
    const expectedCalls = pendingResults === 'automatic' ? 3 : 2
    await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(expectedCalls))
    await waitFor(() => expect(hook.result.current.state.status).toBe('ready'))
    expect(generatePdf.mock.calls[expectedCalls - 1][0]).toMatchObject({
      incremental: { pageNumbers: pendingResults === true ? [2, 3] : [2] }
    })
    expect(recordLayout).toHaveBeenLastCalledWith(
      expect.objectContaining({
        units:
          pendingResults === true
            ? [
                expect.objectContaining({ sourceIndex: 1 }),
                expect.objectContaining({ sourceIndex: 2 })
              ]
            : [expect.objectContaining({ sourceIndex: 1 })]
      })
    )
    expect(hook.result.current.layoutFailures['page-1']).toBeDefined()
    expect(hook.result.current.layoutFailures['page-2']).toBeUndefined()
    expect(hook.result.current.unfilledUnitIds).toEqual(['page-1', 'page-3'])
    expect(hook.result.current.unchangedLayoutUnitIds).toEqual([])
    expect(fixtures.map((f) => f.targetPage.getTextContent.mock.calls.length)).toEqual(
      pendingResults ? [1, 2, 2] : [1, 2, 1]
    )
  }
)

it('saves native layout reasons only after verification and clears them after a successful retry', async () => {
  const f = fixture()
  f.originalPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
  f.targetPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
  const failure = {
    code: 'overflow' as const,
    phase: 'planning' as const,
    pageNumbers: [1],
    fragmentCount: 1
  }
  const results: PdfTranslationResults = {
    ...f.results,
    checkpoint: { key: '00000000-0000-4000-8000-000000000001', source: 'attachment' },
    layoutFailures: { one: failure }
  }
  let admit!: () => void
  getDocument.mockReturnValueOnce({
    promise: new Promise((resolve) => {
      admit = () => resolve(f.target)
    }),
    destroy: f.destroy
  })
  const generatePdf = vi
    .fn()
    .mockResolvedValueOnce({
      data: new Uint8Array([4, 5]),
      layoutFailures: [{ unitIndex: 0, ...failure }]
    })
    .mockResolvedValue({ data: new Uint8Array([6, 7]), layoutFailures: [] })
  const recordLayout = vi.fn(async () => {})
  vi.stubGlobal('api', {
    pdfTranslation: { generatePdf, recordLayout, cancelPdf: vi.fn(async () => {}) }
  })
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, undefined, 'reader:0')
  )
  await waitFor(() =>
    expect(hook.result.current.state).toMatchObject({ status: 'loading', phase: 'validating' })
  )
  expect(recordLayout).not.toHaveBeenCalled()
  act(() => admit())
  await waitFor(() => expect(hook.result.current.ready).toBeDefined())
  expect(hook.result.current.layoutFailures).toEqual({ one: failure })
  expect(recordLayout).toHaveBeenLastCalledWith({
    source: 'attachment',
    checkpointKey: results.checkpoint!.key,
    generatedAt: expect.any(Number),
    units: [{ sourceIndex: 0, source: 'cell', translation: '细胞', failure }]
  })
  f.targetPage.getTextContent.mockResolvedValue({ items: [f.item] })
  act(() => hook.result.current.refresh('one'))
  await waitFor(() => expect(hook.result.current.unfilledUnitIds).toEqual([]))
  expect(hook.result.current.layoutFailures).toEqual({})
  expect(recordLayout).toHaveBeenLastCalledWith(
    expect.objectContaining({
      units: [{ sourceIndex: 0, source: 'cell', translation: '细胞' }]
    })
  )
})

it.each(['busy', 'source-mismatch'] as const)(
  'attributes generation errors only to known affected pages: %s',
  async (code) => {
    const f = fixture()
    const recordLayout = vi.fn(async () => {})
    const results: PdfTranslationResults = {
      ...f.results,
      checkpoint: { key: '00000000-0000-4000-8000-000000000001', source: 'attachment' }
    }
    vi.stubGlobal('api', {
      pdfTranslation: {
        generatePdf: vi.fn().mockRejectedValue(new PdfGenerationError({ code, pageNumber: 1 })),
        recordLayout,
        cancelPdf: vi.fn(async () => {})
      }
    })
    const hook = renderHook(() =>
      usePdfTranslationDocument(f.original, results, undefined, 'reader:0')
    )
    await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
    if (code === 'busy') {
      expect(recordLayout).not.toHaveBeenCalled()
      expect(hook.result.current.layoutFailures).toEqual({})
    } else {
      expect(recordLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          units: [
            expect.objectContaining({
              sourceIndex: 0,
              failure: { code, phase: 'generation', pageNumbers: [1], fragmentCount: 1 }
            })
          ]
        })
      )
      expect(hook.result.current.layoutFailures.one.code).toBe(code)
    }
  }
)

it('keeps the verified PDF readable when saving layout diagnostics fails', async () => {
  const f = fixture()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const results: PdfTranslationResults = {
    ...f.results,
    checkpoint: { key: '00000000-0000-4000-8000-000000000001', source: 'attachment' }
  }
  vi.stubGlobal('api', {
    pdfTranslation: {
      generatePdf: vi.fn().mockResolvedValue({ data: new Uint8Array([4, 5]), layoutFailures: [] }),
      recordLayout: vi.fn().mockRejectedValue(new Error('unavailable')),
      cancelPdf: vi.fn(async () => {})
    }
  })
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, undefined, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.ready).toBeDefined())
  expect(warn).toHaveBeenCalledWith('[pdf-translation] Could not save PDF layout diagnostics')
  warn.mockRestore()
})

it('publishes the verified PDF without waiting for diagnostic persistence', async () => {
  const f = fixture()
  const results: PdfTranslationResults = {
    ...f.results,
    checkpoint: { key: '00000000-0000-4000-8000-000000000001', source: 'attachment' }
  }
  const recordLayout = vi.fn(() => new Promise<void>(() => {}))
  vi.stubGlobal('api', {
    pdfTranslation: {
      generatePdf: vi.fn().mockResolvedValue(new Uint8Array([4, 5])),
      recordLayout,
      cancelPdf: vi.fn(async () => {})
    }
  })
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, results, undefined, 'reader:0')
  )
  await waitFor(() => expect(hook.result.current.ready).toBeDefined())
  expect(recordLayout).toHaveBeenCalledOnce()
})

it('maps native accepted-subset indices back to checkpoint indices across skipped and source-only blocks', async () => {
  const f = fixture()
  f.originalPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
  f.targetPage.getTextContent.mockResolvedValue({ items: [{ ...f.item, str: 'cell' }] })
  const source = createPdfTranslationSource({
    ...f.results.source,
    pages: Array.from({ length: 4 }, () => ({ width: 600, height: 800 })),
    units: [
      {
        ...f.results.source.units[0],
        id: 'protected',
        sourceOnly: true as const,
        fragments: [{ ...f.results.source.units[0].fragments[0], pageNumber: 4 }]
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        ...f.results.source.units[0],
        id: `page-${index + 1}`,
        fragments: [{ ...f.results.source.units[0].fragments[0], pageNumber: index + 1 }]
      }))
    ]
  })
  const results: PdfTranslationResults = {
    source,
    units: [source.units[1], source.units[3]].map((unit) => ({
      id: unit.id,
      translationSource: unit.source,
      translation: '细胞'
    })),
    failedUnitIds: ['page-2'],
    checkpoint: { key: '00000000-0000-4000-8000-000000000001', source: 'attachment' }
  }
  const failure = {
    code: 'overflow' as const,
    phase: 'planning' as const,
    pageNumbers: [3],
    fragmentCount: 1
  }
  const recordLayout = vi.fn(async () => {})
  const generatePdf = vi.fn().mockResolvedValue({
    data: new Uint8Array([4, 5]),
    layoutFailures: [{ unitIndex: 1, ...failure }]
  })
  vi.stubGlobal('api', {
    pdfTranslation: { generatePdf, recordLayout, cancelPdf: vi.fn(async () => {}) }
  })
  getDocument.mockReturnValue({
    promise: Promise.resolve({ ...f.target, numPages: 4 }),
    destroy: f.destroy
  })
  const original = { ...f.original, numPages: 4 } as PDFDocumentProxy
  const hook = renderHook(() => usePdfTranslationDocument(original, results, undefined, 'reader:0'))
  await waitFor(() => expect(hook.result.current.ready).toBeDefined())
  expect(generatePdf.mock.calls[0][0].units).toHaveLength(2)
  expect(hook.result.current.layoutFailures['page-3']).toEqual(failure)
  expect(hook.result.current.layoutFailures['page-2']).toBeUndefined()
  expect(recordLayout).toHaveBeenCalledWith(
    expect.objectContaining({
      units: [
        expect.objectContaining({ sourceIndex: 0 }),
        expect.objectContaining({ sourceIndex: 2, failure })
      ]
    })
  )
})
