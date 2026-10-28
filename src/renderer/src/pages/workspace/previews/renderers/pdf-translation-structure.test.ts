// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import {
  applyCachedPdfStructureSources,
  createPdfTranslationSource,
  type PdfTranslationExtraction
} from '@aipoch/pdf-translation/reader'
import {
  preparePdfTranslationStructure,
  type PdfTranslationStructureContext
} from './pdf-translation-structure'

vi.mock('@aipoch/pdf-translation/reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aipoch/pdf-translation/reader')>()),
  applyCachedPdfStructureSources: vi.fn()
}))

const identity = { sourceChecksum: 'a'.repeat(64), sourceSizeBytes: 100 }
const context: PdfTranslationStructureContext = {
  source: { attachmentVersionId: 'version' },
  identity
}
const document = { numPages: 3, fingerprints: ['source'], getPage: vi.fn() }
const extraction: PdfTranslationExtraction = {
  source: createPdfTranslationSource({
    fingerprint: 'source',
    resourceRequestKey: 'version',
    pages: Array.from({ length: 3 }, () => ({ width: 400, height: 500 })),
    units: []
  }),
  coverage: {
    pageCount: 3,
    textItemCount: 0,
    includedItemCount: 0,
    excludedItemCount: 0,
    pagesWithoutText: [1, 2, 3],
    exclusions: [],
    warnings: []
  }
}
const result = (...pages: number[]): PdfStructureResult => ({
  schemaVersion: 1,
  extractionId: `pages-${pages.join('-')}`,
  engineFingerprint: 'b'.repeat(64),
  ...identity,
  pageCount: 3,
  requestedPages: [...pages],
  processedPages: [...pages],
  pages: pages.map((page) => ({ page, width: 400, height: 500, rotation: 0 })),
  elements: [],
  thumbnails: [],
  navigation: [],
  issues: []
})
const api = {
  pdfStructure: {
    readCached: vi.fn<(request: { page: number }) => Promise<PdfStructureResult | undefined>>(),
    parse: vi.fn<(request: { page: number; requestId: string }) => Promise<PdfStructureResult>>(),
    cancel: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)
  },
  localModels: {
    getSnapshot: vi.fn(async () => ({ availability: 'ready', installedRevision: 'installed' })),
    install: vi.fn(),
    cancel: vi.fn()
  }
}
let reads: (PdfStructureResult | undefined)[]
beforeEach(() => {
  vi.clearAllMocks()
  api.pdfStructure.readCached.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('api', api)
  reads = []
  // Both reader adapters enumerate pages; the loader must share their exact same results.
  vi.mocked(applyCachedPdfStructureSources)
    .mockReset()
    .mockImplementation(async (request) => {
      for (let pass = 0; pass < 2; pass++)
        for (let page = 1; page <= document.numPages; page++)
          reads.push(await request.readCached({ sourceId: request.sourceId, page }))
      return { extraction: request.extraction, retainedUnitIds: [] }
    })
})
afterEach(() => {
  expect(api.pdfStructure.parse).not.toHaveBeenCalled()
  expect(api.pdfStructure.cancel).not.toHaveBeenCalled()
  expect(api.localModels.getSnapshot).not.toHaveBeenCalled()
  expect(api.localModels.install).not.toHaveBeenCalled()
  expect(api.localModels.cancel).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})
const prepare = (
  signal = new AbortController().signal
): ReturnType<typeof preparePdfTranslationStructure> =>
  preparePdfTranslationStructure({ document, extraction, context, signal })

it('returns the exact ordinary extraction without a source context', async () => {
  const output = await preparePdfTranslationStructure({
    document,
    extraction,
    signal: new AbortController().signal
  })
  expect(output.extraction).toBe(extraction)
  expect(output.retainedUnitIds).toEqual([])
  expect(applyCachedPdfStructureSources).not.toHaveBeenCalled()
  expect(api.pdfStructure.readCached).not.toHaveBeenCalled()
})

it('uses cached results without inspecting or installing a model', async () => {
  api.pdfStructure.readCached.mockImplementation(async ({ page }) => result(page))
  await prepare()
  expect(api.pdfStructure.readCached.mock.calls.map(([request]) => request.page)).toEqual([1, 2, 3])
  expect(reads.slice(0, 3)).toEqual(reads.slice(3))
  expect(api.pdfStructure.parse).not.toHaveBeenCalled()
  expect(api.localModels.getSnapshot).not.toHaveBeenCalled()
  expect(api.localModels.install).not.toHaveBeenCalled()
})

it('passes the configured native document factory without opening an auxiliary document eagerly', async () => {
  const nativeDocumentFactory = vi.fn<typeof import('pdfjs-dist').getDocument>()
  await preparePdfTranslationStructure({
    document,
    extraction,
    context,
    signal: new AbortController().signal,
    nativeDocumentFactory
  })
  expect(applyCachedPdfStructureSources).toHaveBeenCalledWith(
    expect.objectContaining({ nativeDocumentFactory })
  )
  expect(nativeDocumentFactory).not.toHaveBeenCalled()
})

it.each([undefined, true])(
  'requests original unit identity only when explicitly enabled (%s)',
  async (preserveUnitIdentity) => {
    const prepared = {
      extraction: { ...extraction, coverage: { ...extraction.coverage, warnings: [] } },
      retainedUnitIds: ['verified-unit']
    }
    vi.mocked(applyCachedPdfStructureSources).mockResolvedValue(prepared)
    const output = await preparePdfTranslationStructure({
      document,
      extraction,
      context,
      signal: new AbortController().signal,
      preserveUnitIdentity
    })
    expect(applyCachedPdfStructureSources).toHaveBeenCalledWith(
      expect.objectContaining({ preserveUnitIdentity: preserveUnitIdentity ?? false })
    )
    // Preparation must retain the reader's complete result, including coverage.
    expect(output).toBe(prepared)
  }
)

it('keeps missing pages as ordinary prose without parsing or inspecting a model', async () => {
  api.pdfStructure.readCached.mockImplementation(async ({ page }) =>
    page === 2 ? result(page) : undefined
  )
  const output = await prepare()
  expect(output.extraction).toBe(extraction)
  expect(api.pdfStructure.readCached.mock.calls.map(([request]) => request.page)).toEqual([1, 2, 3])
  expect(reads).toEqual([undefined, result(2), undefined, undefined, result(2), undefined])
  expect(api.pdfStructure.parse).not.toHaveBeenCalled()
  expect(api.localModels.getSnapshot).not.toHaveBeenCalled()
})

it('reuses every processed page of a cached batch without another cache read', async () => {
  api.pdfStructure.readCached.mockResolvedValue(result(1, 2, 3))
  await prepare()
  expect(api.pdfStructure.readCached).toHaveBeenCalledOnce()
  expect(reads).toHaveLength(6)
  expect(reads.every((value) => value === reads[0])).toBe(true)
})

it('passes managed source authority and identity through the existing boundaries', async () => {
  const managed: PdfTranslationStructureContext = {
    source: {
      source: {
        kind: 'managed',
        projectId: 'project',
        sourceKind: 'artifact-version',
        sourceFileId: 'file',
        sourceVersionId: 'managed-version'
      }
    },
    identity
  }
  await preparePdfTranslationStructure({
    document,
    extraction,
    context: managed,
    signal: new AbortController().signal
  })
  expect(api.pdfStructure.readCached).toHaveBeenCalledWith({ ...managed.source, page: 1 })
  expect(applyCachedPdfStructureSources).toHaveBeenCalledWith(
    expect.objectContaining({ sourceIdentity: identity })
  )
})

it.each(['checksum', 'size', 'page-count', 'processed-page', 'read-error'])(
  'isolates a %s failure while preserving independent valid pages',
  async (failure) => {
    const invalid = result(1)
    if (failure === 'checksum') invalid.sourceChecksum = 'c'.repeat(64)
    if (failure === 'size') invalid.sourceSizeBytes++
    if (failure === 'page-count') invalid.pageCount++
    api.pdfStructure.readCached.mockImplementation(async ({ page }) => {
      if (page !== 1) return result(page)
      if (failure === 'read-error') throw new Error('cache unreadable')
      return failure === 'processed-page' ? result(2) : invalid
    })
    const output = await prepare()
    expect(output.extraction).toBe(extraction)
    expect(reads).toEqual([undefined, result(2), result(3), undefined, result(2), result(3)])
  }
)

it('discards a late cache result after cancellation without cancelling shared work', async () => {
  const cached = Promise.withResolvers<PdfStructureResult | undefined>()
  api.pdfStructure.readCached.mockReturnValueOnce(cached.promise)
  const controller = new AbortController()
  const pending = prepare(controller.signal)
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  cached.resolve(result(1, 2, 3))
  await rejection
  expect(api.pdfStructure.parse).not.toHaveBeenCalled()
  expect(api.pdfStructure.cancel).not.toHaveBeenCalled()
})

it('falls back to ordinary extraction when optional structure verification fails', async () => {
  vi.mocked(applyCachedPdfStructureSources).mockRejectedValue(new Error('unavailable'))
  expect(await prepare()).toEqual({ extraction, retainedUnitIds: [] })
})
