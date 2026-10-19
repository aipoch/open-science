/* eslint-disable @typescript-eslint/explicit-function-return-type -- inferred test fixture types */
import { describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { applyCachedPdfTableSources } from '../../src/reader/table-source.js'
import { bindPdfTranslation, createPdfTranslationSource } from '../../src/reader/source.js'
import type { PdfTranslationExtraction } from '../../src/reader/extraction.js'
import { parsePdfStructureResult, type PdfStructureResult } from '@aipoch/pdf-structure/result'

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
    sourceId: 'version',
    sourceIdentity,
    signal: controller.signal,
    readCached
  }
  return { context, cached, document, page, items, readCached, controller, extraction, rect }
}

describe('cached PDF table source ownership', () => {
  const measuredSegmentsSetup = () => {
    const f = setup()
    f.items[1].str = '10 10'
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: [
          {
            ...f.extraction.source.units[0],
            source: 'Row 10 10',
            fragments: [
              {
                ...f.extraction.source.units[0].fragments[0],
                items: [
                  { index: 0, text: 'Row' },
                  { index: 1, text: '10 10' }
                ]
              }
            ]
          },
          f.extraction.source.units[1]
        ]
      })
    }
    const table = f.cached.elements[0].table!
    table.columnCount = 3
    const segmentCell = (column: number, start: number, end: number, x: number) => ({
      row: 0,
      column,
      rowSpan: 1,
      columnSpan: 1,
      text: '10',
      regions: [{ page: 1, ...f.rect(x), width: 0.08 }],
      sourceSegments: [
        {
          pageNumber: 1,
          index: 1,
          text: '10 10',
          start,
          end,
          region: { page: 1, ...f.rect(x), width: 0.08 }
        }
      ]
    })
    table.cells = [table.cells[0], segmentCell(1, 0, 2, 0.4), segmentCell(2, 3, 5, 0.52)]
    return { ...f, table }
  }

  it.each([false, true])(
    'consumes complete measured repeated ranges once, reverse order: %s',
    async (reverse) => {
      const f = measuredSegmentsSetup()
      if (reverse) f.table.cells.reverse()
      const result = await applyCachedPdfTableSources(f.context)
      expect(result).not.toBe(f.context.extraction)
      const units = result.source.units.filter((u) => u.sourceOnly)
      expect(
        units
          .flatMap((u) => u.fragments.flatMap((fragment) => fragment.items))
          .sort((a, b) => a.index - b.index)
      ).toEqual([
        { index: 0, text: 'Row' },
        { index: 1, text: '10 10' }
      ])
      for (const unit of units)
        expect(unit.source).toBe(
          unit.fragments.flatMap((fragment) => fragment.items.map((item) => item.text)).join(' ')
        )
      const owner = units.find((u) =>
        u.fragments.some((fragment) => fragment.items.some((item) => item.index === 1))
      )!
      expect(owner.fragments[0].rect).toMatchObject({ x: 0.4, y: 0.1, height: 0.1 })
      expect(owner.fragments[0].rect.width).toBeCloseTo(0.2)
      expect(result.source.units.find((u) => u.id === 'prose')).toEqual(
        f.extraction.source.units[1]
      )
    }
  )

  it.each([
    'partial',
    'overlap',
    'text-order',
    'nonspace-gap',
    'outer-gap',
    'region-overlap',
    'baseline',
    'wrong-cell-text',
    'wrong-text',
    'wrong-region',
    'legacy-mix',
    'different-table'
  ])('preserves the original extraction for invalid measured source ranges: %s', async (kind) => {
    const f = measuredSegmentsSetup(),
      a = f.table.cells[1],
      b = f.table.cells[2]
    if (kind === 'partial') f.table.cells.pop()
    if (kind === 'overlap') b.sourceSegments![0].start = 1
    if (kind === 'text-order') {
      a.sourceSegments![0].start = 3
      a.sourceSegments![0].end = 5
      b.sourceSegments![0].start = 0
      b.sourceSegments![0].end = 2
    }
    if (kind === 'nonspace-gap') {
      a.sourceSegments![0].end = 1
      a.text = '1'
    }
    if (kind === 'outer-gap') {
      a.regions[0].x += 0.01
      a.sourceSegments![0].region.x += 0.01
    }
    if (kind === 'region-overlap') {
      for (const region of [b.regions[0], b.sourceSegments![0].region]) {
        region.x = 0.47
        region.width = 0.13
      }
    }
    if (kind === 'wrong-cell-text') b.text = '20'
    if (kind === 'baseline') {
      b.regions[0].y += 0.01
      b.sourceSegments![0].region.y += 0.01
    }
    if (kind === 'wrong-text') b.sourceSegments![0].text = '20 20'
    if (kind === 'wrong-region') b.sourceSegments![0].region.x -= 0.01
    if (kind === 'legacy-mix') {
      delete b.sourceSegments
      b.sourceItems = [{ pageNumber: 1, index: 1, text: '10 10' }]
    }
    if (kind === 'different-table') {
      const other = structuredClone(f.cached.elements[0])
      other.id = 'table-2'
      other.table!.cells = [structuredClone(b)]
      f.cached.elements.push(other)
      f.table.cells.pop()
      expect(() => parsePdfStructureResult(f.cached, f.cached)).not.toThrow()
    }
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })

  it('coalesces multiple measured ranges and a whole item in the same cell', async () => {
    const f = measuredSegmentsSetup(),
      [label, first, second] = f.table.cells
    f.table.cells = [
      {
        ...label,
        columnSpan: 3,
        text: 'Row 10 10',
        regions: [...label.regions, ...first.regions, ...second.regions],
        sourceItems: undefined,
        sourceSegments: [
          {
            pageNumber: 1,
            index: 0,
            text: 'Row',
            start: 0,
            end: 3,
            region: { ...label.regions[0] }
          },
          ...first.sourceSegments!,
          ...second.sourceSegments!
        ]
      }
    ]
    expect(() => parsePdfStructureResult(f.cached, f.cached)).not.toThrow()
    const result = await applyCachedPdfTableSources(f.context)
    expect(result).not.toBe(f.context.extraction)
    expect(
      result.source.units
        .filter((u) => u.sourceOnly)
        .map((u) => ({ source: u.source, items: u.fragments.flatMap((f) => f.items) }))
    ).toEqual([
      {
        source: 'Row 10 10',
        items: [
          { index: 0, text: 'Row' },
          { index: 1, text: '10 10' }
        ]
      }
    ])
  })

  const mixedFusedSetup = () => {
    const f = setup()
    f.items[0].str = '10 20'
    f.items[1].str = 'Row'
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: [
          {
            ...f.extraction.source.units[0],
            source: '10 20 Row',
            fragments: [
              {
                ...f.extraction.source.units[0].fragments[0],
                items: [
                  { index: 0, text: '10 20' },
                  { index: 1, text: 'Row' }
                ]
              }
            ]
          },
          f.extraction.source.units[1]
        ]
      })
    }
    const table = f.cached.elements[0].table!
    table.cells = [
      {
        ...table.cells[0],
        text: '10',
        regions: [{ page: 1, ...f.rect(0.1), width: 0.1 }],
        sourceItems: [{ pageNumber: 1, index: 0, text: '10 20' }]
      },
      {
        ...table.cells[1],
        text: '20 Row',
        regions: [
          { page: 1, ...f.rect(0.2), width: 0.1 },
          { page: 1, ...f.rect(0.4) }
        ],
        sourceItems: [
          { pageNumber: 1, index: 0, text: '10 20' },
          { pageNumber: 1, index: 1, text: 'Row' }
        ]
      }
    ]
    return { ...f, table }
  }

  it.each([false, true])(
    'consumes each native source once when a mixed fused cell is visited in reverse order: %s',
    async (reverse) => {
      const f = mixedFusedSetup()
      if (reverse) f.table.cells.reverse()
      const result = await applyCachedPdfTableSources(f.context)
      expect(result).not.toBe(f.context.extraction)
      const units = result.source.units.filter((u) => u.sourceOnly)
      expect(units.map((u) => u.source)).toEqual(reverse ? ['10 20 Row'] : ['10 20', 'Row'])
      for (const unit of units)
        expect(unit.source).toBe(
          unit.fragments.flatMap((fragment) => fragment.items.map((item) => item.text)).join(' ')
        )
      const items = units.flatMap((u) => u.fragments.flatMap((fragment) => fragment.items))
      expect(items.sort((a, b) => a.index - b.index)).toEqual([
        { index: 0, text: '10 20' },
        { index: 1, text: 'Row' }
      ])
      const owner = units.find((u) =>
        u.fragments.some((fragment) => fragment.items.some((item) => item.index === 0))
      )!
      expect(owner.fragments[0].rect.x).toBeCloseTo(0.1)
      expect(owner.fragments[0].rect.width).toBeCloseTo(reverse ? 0.5 : 0.2)
      expect(result.source.units.find((u) => u.id === 'prose')).toEqual(
        f.extraction.source.units[1]
      )
    }
  )

  it.each([
    'partial',
    'gap',
    'overlap',
    'reordered-text',
    'missing-new-region',
    'wrong-new-source'
  ])('keeps the complete original source for a %s mixed fused claim', async (kind) => {
    const f = mixedFusedSetup(),
      second = f.table.cells[1]
    if (kind === 'partial') f.table.cells.shift()
    if (kind === 'gap') {
      second.regions[0].x += 0.01
      second.regions[0].width -= 0.01
    }
    if (kind === 'overlap') {
      second.regions[0].x -= 0.01
      second.regions[0].width += 0.01
    }
    if (kind === 'reordered-text') second.text = 'Row 20'
    if (kind === 'missing-new-region') second.regions.pop()
    if (kind === 'wrong-new-source') second.sourceItems![1].text = 'Different'
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })

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
    expect(f.readCached).toHaveBeenCalledWith({ sourceId: 'version', page: 1 })
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
  it('coalesces clipped cells that came from one fused native text item', async () => {
    const f = setup(),
      base = f.extraction.source
    f.page.getTextContent.mockResolvedValue({
      items: [
        {
          str: 'Row',
          dir: 'ltr',
          fontName: 'f',
          transform: [10, 0, 0, 10, 10, 80],
          width: 20,
          height: 10
        },
        {
          str: '10 20',
          dir: 'ltr',
          fontName: 'f',
          transform: [10, 0, 0, 10, 40, 80],
          width: 20,
          height: 10
        },
        {
          str: 'Prose',
          dir: 'ltr',
          fontName: 'f',
          transform: [10, 0, 0, 10, 10, 30],
          width: 20,
          height: 10
        }
      ],
      styles: {}
    })
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...base,
        units: [
          {
            id: 'group',
            source: 'Row 10 20',
            fragments: [
              {
                pageNumber: 1,
                rect: { ...f.rect(0.1), width: 0.5 },
                items: [
                  { index: 0, text: 'Row' },
                  { index: 1, text: '10 20' }
                ]
              }
            ]
          },
          base.units[1]
        ]
      })
    }
    const table = f.cached.elements[0].table!
    table.columnCount = 3
    table.cells = [
      {
        ...table.cells[0],
        text: 'Row 10',
        regions: [
          { page: 1, ...f.rect(0.1) },
          { page: 1, ...f.rect(0.4), width: 0.1 }
        ],
        sourceItems: [
          { pageNumber: 1, index: 0, text: 'Row' },
          { pageNumber: 1, index: 1, text: '10 20' }
        ]
      },
      {
        ...table.cells[1],
        text: '20',
        regions: [{ page: 1, ...f.rect(0.5), width: 0.1 }],
        sourceItems: [{ pageNumber: 1, index: 1, text: '10 20' }]
      }
    ]
    const result = await applyCachedPdfTableSources(f.context),
      sourceOnly = result.source.units.filter((unit) => unit.sourceOnly)
    expect(sourceOnly.map((unit) => unit.source)).toEqual(['Row 10 20'])
    expect(sourceOnly[0].fragments[0].items).toEqual([
      { index: 0, text: 'Row' },
      { index: 1, text: '10 20' }
    ])
    const fusedRect = sourceOnly[0].fragments[0].rect
    expect(fusedRect?.x).toBeCloseTo(0.1)
    expect(fusedRect?.width).toBeCloseTo(0.5)
  })
  it('accepts one native item represented by multiple exact glyph regions', async () => {
    const f = setup(),
      table = f.cached.elements[0].table!
    table.cells[1] = {
      ...table.cells[1],
      text: '10',
      regions: [
        { page: 1, ...f.rect(0.4), width: 0.08 },
        { page: 1, ...f.rect(0.48), width: 0.12 }
      ],
      sourceItems: [{ pageNumber: 1, index: 1, text: '10' }]
    }
    const result = await applyCachedPdfTableSources(f.context),
      sourceOnly = result.source.units.filter((unit) => unit.sourceOnly)
    expect(sourceOnly.map((unit) => unit.source)).toEqual(['Row', '10'])
    const rect = sourceOnly[1].fragments[0].rect
    expect(rect.x).toBeCloseTo(0.4)
    expect(rect.y).toBeCloseTo(0.1)
    expect(rect.width).toBeCloseTo(0.2)
    expect(rect.height).toBeCloseTo(0.1)
  })
  it.each(['incomplete', 'ambiguous'] as const)(
    'keeps the original extraction for %s fused provenance',
    async (kind) => {
      const f = setup(),
        base = f.extraction.source
      f.items[1].str = kind === 'ambiguous' ? '10 10' : '10 20'
      f.context.extraction = {
        ...f.extraction,
        source: createPdfTranslationSource({
          ...base,
          units: [
            {
              id: 'group',
              source: `Row ${f.items[1].str}`,
              fragments: [
                {
                  pageNumber: 1,
                  rect: { ...f.rect(0.1), width: 0.5 },
                  items: [
                    { index: 0, text: 'Row' },
                    { index: 1, text: f.items[1].str }
                  ]
                }
              ]
            },
            base.units[1]
          ]
        })
      }
      const table = f.cached.elements[0].table!
      table.cells[1] = {
        ...table.cells[1],
        text: '10',
        regions: [{ page: 1, ...f.rect(0.4), width: 0.1 }],
        sourceItems: [{ pageNumber: 1, index: 1, text: f.items[1].str }]
      }
      expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
    }
  )
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
    'extra-source-item',
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
    if (kind === 'extra-source-item')
      table.cells[0].sourceItems!.push({ ...table.cells[0].sourceItems![0] })
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
