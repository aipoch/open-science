/* eslint-disable @typescript-eslint/explicit-function-return-type -- inferred test fixture types */
import { describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { applyCachedPdfTableSources } from './pdf-translation-table-source'
import { bindPdfTranslation, createPdfTranslationSource } from './pdf-translation'
import type { PdfTranslationExtraction } from './pdf-translation-extraction'
import type { PdfStructureResult } from '../../../../../../shared/pdf-structure'

function setup() {
  const sourceIdentity = { sourceChecksum: 'a'.repeat(64), sourceSizeBytes: 100 }
  const item = (str: string, x: number, y = 80) => ({
    str,
    dir: 'ltr',
    fontName: 'f',
    transform: [10, 0, 0, 10, x, y],
    width: 20,
    height: 10
  })
  const items = [item('Row', 10), item('10', 40), item('Prose', 10, 30)]
  const rect = (x: number, y = 0.1) => ({ x, y, width: 0.2, height: 0.1 })
  const page = {
    rotate: 0,
    getViewport: vi.fn(() => ({
      width: 100,
      height: 100,
      convertToViewportPoint: (x: number, y: number) => [x, 100 - y]
    })),
    getTextContent: vi.fn(async () => ({ items, styles: {} })),
    cleanup: vi.fn()
  }
  const document = {
    numPages: 1,
    fingerprints: ['fingerprint'],
    getPage: vi.fn(async () => page),
    getData: vi.fn(),
    destroy: vi.fn()
  }
  const source = createPdfTranslationSource({
    resourceRequestKey: 'reader',
    fingerprint: 'fingerprint',
    pages: [{ width: 100, height: 100 }],
    units: [
      {
        id: 'group',
        source: 'Row 10',
        fragments: [
          {
            pageNumber: 1,
            rect: { ...rect(0.1), width: 0.5 },
            items: [
              { index: 0, text: 'Row' },
              { index: 1, text: '10' }
            ]
          }
        ]
      },
      {
        id: 'prose',
        source: 'Prose',
        fragments: [{ pageNumber: 1, rect: rect(0.1, 0.6), items: [{ index: 2, text: 'Prose' }] }]
      }
    ]
  })
  const extraction: PdfTranslationExtraction = {
    source,
    coverage: {
      pageCount: 1,
      textItemCount: 3,
      includedItemCount: 3,
      excludedItemCount: 0,
      pagesWithoutText: [],
      exclusions: [],
      warnings: [{ unitId: 'group', reasons: ['table-layout'] }]
    }
  }
  const cached: PdfStructureResult = {
    schemaVersion: 1,
    extractionId: 'cached-1',
    engineFingerprint: 'b'.repeat(64),
    ...sourceIdentity,
    pageCount: 1,
    requestedPages: [1],
    processedPages: [1],
    pages: [{ page: 1, width: 100, height: 100, rotation: 0 }],
    elements: [
      {
        id: 'table-1',
        kind: 'table',
        regions: [{ page: 1, ...rect(0.1), width: 0.5 }],
        issues: [],
        table: {
          rowCount: 1,
          columnCount: 2,
          issues: [{ code: 'structural-warning', detail: 'Still uncertain' }],
          unassignedText: [],
          cells: [0, 1].map((i) => ({
            row: 0,
            column: i,
            rowSpan: 1,
            columnSpan: 1,
            text: items[i].str,
            regions: [{ page: 1, ...rect(i === 0 ? 0.1 : 0.4) }],
            sourceItems: [{ pageNumber: 1, index: i, text: items[i].str }]
          }))
        }
      }
    ],
    thumbnails: [],
    navigation: [],
    issues: []
  }
  const readCached = vi.fn(async () => cached as PdfStructureResult | undefined)
  const controller = new AbortController()
  const context = {
    extraction,
    document: document as unknown as PDFDocumentProxy,
    attachmentVersionId: 'version',
    sourceIdentity,
    signal: controller.signal,
    readCached
  }
  return { context, cached, document, page, readCached, controller, extraction, rect }
}

describe('cached PDF table source ownership', () => {
  it('moves complete units once, keeps raw text and coverage, and never enables cell translation', async () => {
    const f = setup()
    f.cached.elements[0].table!.cells[0].text = 'Repaired display text'
    const result = await applyCachedPdfTableSources(f.context)
    expect(result).not.toBe(f.extraction)
    expect(result.coverage).toBe(f.extraction.coverage)
    expect(result.source.units.map((u) => [u.source, u.sourceOnly])).toEqual([
      ['Prose', undefined],
      ['Row', true],
      ['10', true]
    ])
    expect(result.source.units[0]).toEqual(f.extraction.source.units[1])
    expect(Object.isFrozen(result.source.units[1])).toBe(true)
    expect(f.readCached).toHaveBeenCalledWith({ attachmentVersionId: 'version', page: 1 })
    expect(f.document.getPage).toHaveBeenCalledTimes(1)
    expect(f.page.getTextContent).toHaveBeenCalledTimes(1)
    const cell = result.source.units[1],
      prose = result.source.units[0]
    const bind = (unit: typeof cell, source = result.source) =>
      bindPdfTranslation(
        result.source,
        {
          source,
          units: [{ id: unit.id, translationSource: unit.source, translation: 'Translation' }]
        },
        f.context.document,
        'reader',
        f.context.signal
      )
    expect(await bind(cell)).toBeNull()
    expect(await bind(prose)).not.toBeNull()
    expect(await bind(prose, f.extraction.source)).toBeNull()
    expect(f.document.getData).not.toHaveBeenCalled()
    expect(f.document.destroy).not.toHaveBeenCalled()
    expect(f.page.cleanup).not.toHaveBeenCalled()
  })
  it.each([
    'no-cache',
    'old-origins',
    'checksum',
    'size',
    'page-count',
    'rotation',
    'dimensions',
    'text',
    'region',
    'extra-region',
    'duplicate-origin',
    'mixed-unit',
    'missing-owner',
    'split-table',
    'malformed',
    'read-error'
  ])('preserves the complete original extraction for %s', async (kind) => {
    const f = setup(),
      table = f.cached.elements[0].table!
    if (kind === 'no-cache') f.readCached.mockResolvedValue(undefined)
    if (kind === 'old-origins') delete table.cells[0].sourceItems
    if (kind === 'checksum') f.cached.sourceChecksum = 'c'.repeat(64)
    if (kind === 'size') f.cached.sourceSizeBytes++
    if (kind === 'page-count') f.cached.pageCount++
    if (kind === 'rotation') f.cached.pages[0].rotation = 90
    if (kind === 'dimensions') f.cached.pages[0].width++
    if (kind === 'text') table.cells[0].sourceItems![0].text = 'Wrong'
    if (kind === 'region') table.cells[0].regions[0].x += 0.01
    if (kind === 'extra-region') table.cells[0].regions.push({ ...table.cells[0].regions[0] })
    if (kind === 'duplicate-origin')
      table.cells[1].sourceItems = structuredClone(table.cells[0].sourceItems)
    if (kind === 'mixed-unit') table.cells.pop()
    if (kind === 'missing-owner')
      f.context.extraction = {
        ...f.extraction,
        source: createPdfTranslationSource({
          ...f.extraction.source,
          units: [f.extraction.source.units[1]]
        })
      }
    if (kind === 'split-table')
      f.cached.elements.push({
        ...f.cached.elements[0],
        id: 'table-2',
        table: { ...table, cells: table.cells.splice(1) }
      })
    if (kind === 'malformed') table.cells[0].rowSpan = 2
    if (kind === 'read-error') f.readCached.mockRejectedValue(new Error('Cache unavailable'))
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })
  it('deduplicates repeated cached batches and retains uncached pages', async () => {
    const f = setup()
    f.document.numPages = 2
    f.cached.pageCount = 2
    f.cached.requestedPages = [1, 2]
    f.cached.processedPages = [1, 2]
    f.cached.pages.push({ page: 2, width: 100, height: 100, rotation: 0 })
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        pages: [...f.extraction.source.pages, { width: 100, height: 100 }]
      })
    }
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units.filter((u) => u.sourceOnly)).toHaveLength(2)
    expect(f.readCached).toHaveBeenCalledTimes(2)
    f.readCached.mockResolvedValueOnce(f.cached).mockResolvedValueOnce(undefined)
    expect((await applyCachedPdfTableSources(f.context)).source.units).toEqual(result.source.units)
    const conflict = structuredClone(f.cached)
    conflict.elements[0].table!.cells[0].text = 'Changed cache'
    f.readCached.mockResolvedValueOnce(f.cached).mockResolvedValueOnce(conflict)
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })
  it('rejects duplicate claims from distinct cache identities and grouped table parts', async () => {
    const f = setup(),
      table = f.cached.elements[0].table!
    f.cached.elements[0] = {
      ...f.cached.elements[0],
      table: undefined,
      caption: { text: 'Table', regions: f.cached.elements[0].regions },
      tableParts: [
        { title: 'First', table },
        { title: 'Second', table: structuredClone(table) }
      ]
    }
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.extraction)
  })
  it.each(['cache', 'page', 'text'])(
    'aborts during the %s await without publishing a partial source',
    async (stage) => {
      const f = setup()
      if (stage === 'cache')
        f.readCached.mockImplementation(async () => {
          f.controller.abort()
          return f.cached
        })
      if (stage === 'page')
        f.document.getPage.mockImplementation(async () => {
          f.controller.abort()
          return f.page
        })
      if (stage === 'text')
        f.page.getTextContent.mockImplementation(async () => {
          f.controller.abort()
          return { items: [], styles: {} }
        })
      await expect(applyCachedPdfTableSources(f.context)).rejects.toThrow()
      expect(f.page.cleanup).not.toHaveBeenCalled()
    }
  )
  it('snapshots cache payloads before page reads and checks live source identity afterwards', async () => {
    const f = setup()
    f.document.getPage.mockImplementation(async () => {
      f.cached.elements[0].table!.cells.length = 0
      return f.page
    })
    expect(
      (await applyCachedPdfTableSources(f.context)).source.units.filter((u) => u.sourceOnly)
    ).toHaveLength(2)
    const second = setup()
    second.page.getTextContent.mockImplementation(async () => {
      second.document.fingerprints[0] = 'replacement'
      return { items: [], styles: {} }
    })
    expect(await applyCachedPdfTableSources(second.context)).toBe(second.extraction)
  })
  it('keeps omitted whole cells in their old owners; a positive item proof is not completeness', async () => {
    const f = setup()
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: [
          ...f.extraction.source.units.slice(1),
          ...f.extraction.source.units[0].fragments[0].items.map((i) => ({
            id: 'single-' + i.index,
            source: i.text,
            fragments: [{ pageNumber: 1, rect: f.rect(i.index === 0 ? 0.1 : 0.4), items: [i] }]
          }))
        ]
      })
    }
    f.cached.elements[0].table!.cells.pop()
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units.find((u) => u.id === 'single-1')).toEqual(
      f.context.extraction.source.units.find((u) => u.id === 'single-1')
    )
    expect(result.source.units.flatMap((u) => u.fragments.flatMap((f) => f.items))).toHaveLength(3)
  })
  it.each(['missing-hash', 'invalid-size', 'wrong-fingerprint'])(
    'does not read cached evidence for %s',
    async (kind) => {
      const f = setup()
      if (kind === 'missing-hash') f.context.sourceIdentity.sourceChecksum = ''
      if (kind === 'invalid-size') f.context.sourceIdentity.sourceSizeBytes = 0
      if (kind === 'wrong-fingerprint') f.document.fingerprints[0] = 'other'
      expect(await applyCachedPdfTableSources(f.context)).toBe(f.extraction)
      expect(f.readCached).not.toHaveBeenCalled()
    }
  )
  it.each(['page', 'text'])('preserves extraction when the %s read fails', async (kind) => {
    const f = setup()
    if (kind === 'page') f.document.getPage.mockRejectedValue(new Error('Unavailable page'))
    else f.page.getTextContent.mockRejectedValue(new Error('Unavailable text'))
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.extraction)
  })
  it('rejects distinct extraction identities claiming the same original items', async () => {
    const f = setup()
    f.document.numPages = 2
    f.cached.pageCount = 2
    f.cached.requestedPages = [1, 2]
    f.cached.processedPages = [1, 2]
    f.cached.pages.push({ page: 2, width: 100, height: 100, rotation: 0 })
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        pages: [...f.extraction.source.pages, { width: 100, height: 100 }]
      })
    }
    const other = structuredClone(f.cached)
    other.extractionId = 'other-extraction'
    f.readCached.mockResolvedValueOnce(f.cached).mockResolvedValueOnce(other)
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })
  it('keeps the original source when the cached inventory exceeds the reader budget', async () => {
    const f = setup(),
      element = f.cached.elements[0]
    f.cached.elements = Array.from({ length: 513 }, (_, i) => ({
      ...structuredClone(element),
      id: 'table-' + i
    }))
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.extraction)
    expect(f.document.getPage).not.toHaveBeenCalled()
  })
})
