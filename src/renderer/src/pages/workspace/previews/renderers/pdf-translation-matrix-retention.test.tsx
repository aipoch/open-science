// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { createPdfTranslationSource } from '@aipoch/pdf-translation/reader'
import { usePdfTranslationDocument } from './use-pdf-translation-document'
import type { PdfTranslationPdfRequest } from '../../../../../../shared/pdf-translation'
import type { PdfTranslationPdfResult } from '@aipoch/pdf-translation/contracts'

const { getDocument, sameNativeMatrixBody } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  sameNativeMatrixBody: vi.fn()
}))
vi.mock('../pdfjs', () => ({ pdfjsLib: { getDocument, OPS: {} } }))
vi.mock('@aipoch/pdf-translation/reader', async (original) => ({
  ...(await original<typeof import('@aipoch/pdf-translation/reader')>()),
  sameNativeMatrixBody
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

// The native packet predicate has separate real-font tests. This fixture tests
// that its rejection also applies to accepted, persisted translations.
function fixture(): {
  original: PDFDocumentProxy
  candidate: PDFDocumentProxy
  restored: PDFDocumentProxy
  results: ReturnType<typeof createResults>
  destroy: ReturnType<typeof vi.fn>
} {
  const page = (str: string): object => ({
    getViewport: () => ({
      width: 600,
      height: 800,
      rotation: 0,
      convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
    }),
    getTextContent: async () => ({
      items: [{ str, transform: [10, 0, 0, 10, 60, 700], width: 10 }]
    }),
    getAnnotations: async () => [],
    cleanup: () => {}
  })
  const document = (str: string): PDFDocumentProxy =>
    ({
      fingerprints: ['matrix-retention'],
      numPages: 1,
      getPage: async () => page(str),
      getPageIndex: async () => 0,
      getData: async () => new Uint8Array([1, 2])
    }) as unknown as PDFDocumentProxy
  const original = document('I'),
    candidate = document('我'),
    restored = document('I'),
    destroy = vi.fn(async () => {})
  getDocument.mockReturnValue({ promise: Promise.resolve(candidate), destroy })
  return { original, candidate, restored, destroy, results: createResults() }
}

function createResults(): {
  source: ReturnType<typeof createPdfTranslationSource>
  units: { id: string; translationSource: string; translation: string }[]
} {
  return {
    source: createPdfTranslationSource({
      resourceRequestKey: 'matrix-retention',
      fingerprint: 'matrix-retention',
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          id: 'one',
          source: 'I',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
              items: [{ index: 0, text: 'I' }]
            }
          ]
        }
      ]
    }),
    units: [{ id: 'one', translationSource: 'I', translation: '我' }]
  }
}

it('rejects a saved candidate whose original native matrix changed', async () => {
  const f = fixture()
  sameNativeMatrixBody.mockResolvedValue(false)
  const originalTargets = structuredClone(f.results.units)
  const artifact = { results: f.results, data: new Uint8Array([4, 5]) }
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, f.results, artifact, 'matrix-retention')
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
  expect(hook.result.current.ready).toBeUndefined()
  expect(f.results.units).toEqual(originalTargets)
})

it('retains the unsafe page from original content without replacing saved targets', async () => {
  const f = fixture()
  sameNativeMatrixBody.mockResolvedValueOnce(false).mockResolvedValue(true)
  getDocument.mockReturnValueOnce({ promise: Promise.resolve(f.candidate), destroy: f.destroy })
  getDocument.mockReturnValue({ promise: Promise.resolve(f.restored), destroy: f.destroy })
  const generatePdf = vi
    .fn<(input: PdfTranslationPdfRequest) => Promise<PdfTranslationPdfResult>>()
    .mockResolvedValue({ data: new Uint8Array([4, 5]), layoutFailures: [] })
  vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, f.results, undefined, 'matrix-retention')
  )
  await waitFor(() => expect(hook.result.current.ready).toBeDefined())
  // A one-page original fallback borrows the verified source bytes directly.
  expect(generatePdf).toHaveBeenCalledTimes(1)
  expect(getDocument.mock.calls[1][0]).toMatchObject({ data: new Uint8Array([1, 2]) })
  expect(hook.result.current.ready?.retainedUnitIds).toEqual(['one'])
  expect(f.results.units[0].translation).toBe('我')
})

it('aborts native packet verification when the source is unmounted', async () => {
  const f = fixture(),
    pending = Promise.withResolvers<boolean>(),
    beforeReady = vi.fn(),
    artifact = { results: f.results, data: new Uint8Array([4, 5]) }
  sameNativeMatrixBody.mockReturnValue(pending.promise)
  const hook = renderHook(() =>
    usePdfTranslationDocument(f.original, f.results, artifact, 'matrix-retention', beforeReady)
  )
  await waitFor(() => expect(sameNativeMatrixBody).toHaveBeenCalled())
  const signal = sameNativeMatrixBody.mock.calls[0][3].signal as AbortSignal
  expect(signal.aborted).toBe(false)
  hook.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => pending.resolve(true))
  expect(beforeReady).not.toHaveBeenCalled()
  expect(f.destroy).toHaveBeenCalled()
})
