// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { restorePdfTranslationExtraction } from '@aipoch/pdf-translation/reader'
import { usePdfTranslationDocument } from './use-pdf-translation-document'
import type { PdfTranslationPdfRequest } from '../../../../../../shared/pdf-translation'
import type { PdfTranslationPdfResult } from '@aipoch/pdf-translation/contracts'
import type { PdfTranslationStructureContext } from './pdf-translation-structure'

const { getDocument, preparePdfTranslationStructure } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  preparePdfTranslationStructure: vi.fn()
}))
vi.mock('../pdfjs', () => ({ pdfjsLib: { getDocument, OPS: {} } }))
vi.mock('./pdf-translation-structure', async (original) => ({
  ...(await original<typeof import('./pdf-translation-structure')>()),
  preparePdfTranslationStructure
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})
const context: PdfTranslationStructureContext = {
  source: { attachmentVersionId: 'saved-attachment' },
  identity: { sourceChecksum: 'a'.repeat(64), sourceSizeBytes: 2 }
}
function fixture(): {
  original: PDFDocumentProxy
  results: {
    source: ReturnType<typeof restorePdfTranslationExtraction>['source']
    units: { id: string; translationSource: string; translation: string }[]
  }
  document: (str: string) => PDFDocumentProxy
  coverage: ReturnType<typeof restorePdfTranslationExtraction>['coverage']
  generatePdf: ReturnType<
    typeof vi.fn<(request: PdfTranslationPdfRequest) => Promise<PdfTranslationPdfResult>>
  >
} {
  const document = (str: string): PDFDocumentProxy =>
    ({
      fingerprints: ['saved-native-table'],
      numPages: 1,
      getData: async () => new Uint8Array([1, 2]),
      getPageIndex: async () => 0,
      getPage: async () => ({
        getViewport: () => ({
          width: 600,
          height: 800,
          rotation: 0,
          convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
        }),
        getTextContent: async () => ({
          items: [{ str, transform: [10, 0, 0, 10, 60, 700], width: 100 }]
        }),
        getAnnotations: async () => [],
        cleanup: () => {}
      })
    }) as unknown as PDFDocumentProxy
  const coverage = {
    pageCount: 1,
    textItemCount: 1,
    includedItemCount: 1,
    excludedItemCount: 0,
    pagesWithoutText: [],
    exclusions: [],
    warnings: []
  }
  const { source } = restorePdfTranslationExtraction(
    {
      version: 1,
      parserVersion: 'historical-layout',
      fingerprint: 'saved-native-table',
      pages: [{ width: 600, height: 800 }],
      coverage,
      units: [
        {
          id: 'saved-cell',
          source: 'First cell Second cell',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
              items: [{ index: 0, text: 'First cell Second cell' }]
            }
          ]
        }
      ]
    },
    'saved-native-table'
  )
  const results = {
    source,
    units: [
      { id: 'saved-cell', translationSource: 'First cell Second cell', translation: '第一格第二格' }
    ]
  }
  const generatePdf = vi
    .fn<(request: PdfTranslationPdfRequest) => Promise<PdfTranslationPdfResult>>()
    .mockResolvedValue({ data: new Uint8Array([4, 5]), layoutFailures: [] })
  vi.stubGlobal('api', {
    pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) },
    pdfStructure: { readCached: vi.fn() }
  })
  return { original: document('First cell Second cell'), results, document, coverage, generatePdf }
}
it('applies current whole-owner negative structure evidence to a saved fixed target', async () => {
  const f = fixture(),
    before = structuredClone(f.results.units)
  preparePdfTranslationStructure.mockImplementation(async ({ extraction }) => ({
    extraction,
    retainedUnitIds: ['saved-cell']
  }))
  getDocument.mockReturnValue({
    promise: Promise.resolve(f.document('First cell Second cell')),
    destroy: vi.fn(async () => {})
  })
  const hook = renderHook(() =>
    usePdfTranslationDocument(
      f.original,
      f.results,
      undefined,
      'saved-native-table',
      undefined,
      undefined,
      false,
      context
    )
  )
  await waitFor(() => expect(hook.result.current.ready).toBeDefined())
  expect(preparePdfTranslationStructure).toHaveBeenCalledWith(
    expect.objectContaining({
      extraction: { source: f.results.source, coverage: f.coverage },
      preserveUnitIdentity: true,
      context
    })
  )
  expect(f.generatePdf.mock.calls[0][0].units[0].translation).toBe('First cell Second cell')
  expect(hook.result.current.ready?.retainedUnitIds).toEqual(['saved-cell'])
  expect(f.results.units).toEqual(before)
})
it('never displays a cached fixed artifact that paints a newly protected owner', async () => {
  const f = fixture(),
    artifact = { results: f.results, data: new Uint8Array([4, 5]) }
  preparePdfTranslationStructure.mockImplementation(async ({ extraction }) => ({
    extraction,
    retainedUnitIds: ['saved-cell']
  }))
  getDocument.mockReturnValue({
    promise: Promise.resolve(f.document('第一格第二格')),
    destroy: vi.fn(async () => {})
  })
  const hook = renderHook(() =>
    usePdfTranslationDocument(
      f.original,
      f.results,
      artifact,
      'saved-native-table',
      undefined,
      undefined,
      false,
      context
    )
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
  expect(hook.result.current.ready).toBeUndefined()
  expect(getDocument).not.toHaveBeenCalled()
  expect(f.generatePdf).not.toHaveBeenCalled()
  getDocument.mockReturnValue({
    promise: Promise.resolve(f.document('First cell Second cell')),
    destroy: vi.fn(async () => {})
  })
  act(() => hook.result.current.retry())
  await waitFor(() => expect(hook.result.current.ready).toBeDefined())
  expect(f.generatePdf.mock.calls[0][0].units[0].translation).toBe('First cell Second cell')
  expect(hook.result.current.ready?.retainedUnitIds).toEqual(['saved-cell'])
  expect(f.results.units[0].translation).toBe('第一格第二格')
})
it('transplants a proven original page without rewriting a saved fixed checkpoint', async () => {
  const f = fixture()
  preparePdfTranslationStructure.mockImplementation(async ({ extraction }) => ({
    extraction,
    retainedUnitIds: [],
    retainedSourcePageNumbers: [1]
  }))
  getDocument.mockReturnValue({
    promise: Promise.resolve(f.document('First cell Second cell')),
    destroy: vi.fn(async () => {})
  })
  const hook = renderHook(() =>
    usePdfTranslationDocument(
      f.original,
      f.results,
      undefined,
      'saved-native-table',
      undefined,
      undefined,
      false,
      context
    )
  )
  await waitFor(() => expect(hook.result.current.ready).toBeDefined())
  expect(f.generatePdf).not.toHaveBeenCalled()
  expect(getDocument.mock.calls[0][0]).toMatchObject({ data: new Uint8Array([1, 2]) })
  expect(hook.result.current.ready?.retainedUnitIds).toEqual(['saved-cell'])
  expect(f.results.units[0].translation).toBe('第一格第二格')
})
it('does not accept a cached page that now requires original-page retention', async () => {
  const f = fixture(),
    artifact = { results: f.results, data: new Uint8Array([4, 5]) }
  preparePdfTranslationStructure.mockImplementation(async ({ extraction }) => ({
    extraction,
    retainedUnitIds: [],
    retainedSourcePageNumbers: [1]
  }))
  getDocument.mockReturnValue({
    promise: Promise.resolve(f.document('第一格第二格')),
    destroy: vi.fn(async () => {})
  })
  const hook = renderHook(() =>
    usePdfTranslationDocument(
      f.original,
      f.results,
      artifact,
      'saved-native-table',
      undefined,
      undefined,
      false,
      context
    )
  )
  await waitFor(() => expect(hook.result.current.state.status).toBe('error'))
  expect(hook.result.current.ready).toBeUndefined()
  expect(getDocument).not.toHaveBeenCalled()
  expect(f.results.units[0].translation).toBe('第一格第二格')
  getDocument.mockReturnValue({
    promise: Promise.resolve(f.document('First cell Second cell')),
    destroy: vi.fn(async () => {})
  })
  act(() => hook.result.current.retry())
  await waitFor(() => expect(hook.result.current.ready).toBeDefined())
  expect(f.generatePdf).not.toHaveBeenCalled()
  expect(getDocument.mock.calls[0][0]).toMatchObject({ data: new Uint8Array([1, 2]) })
  expect(f.results.units[0].translation).toBe('第一格第二格')
})
it('keeps an ordinary saved target when current structure proves no negative ownership', async () => {
  const f = fixture(),
    artifact = { results: f.results, data: new Uint8Array([4, 5]) }
  preparePdfTranslationStructure.mockImplementation(async ({ extraction }) => ({
    extraction,
    retainedUnitIds: []
  }))
  getDocument.mockReturnValue({
    promise: Promise.resolve(f.document('第一格第二格')),
    destroy: vi.fn(async () => {})
  })
  const hook = renderHook(() =>
    usePdfTranslationDocument(
      f.original,
      f.results,
      artifact,
      'saved-native-table',
      undefined,
      undefined,
      false,
      context
    )
  )
  await waitFor(() => expect(hook.result.current.ready).toBeDefined())
  expect(hook.result.current.ready?.retainedUnitIds).toEqual([])
  expect(f.results.units[0].translation).toBe('第一格第二格')
})
