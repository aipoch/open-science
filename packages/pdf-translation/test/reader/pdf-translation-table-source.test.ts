/* eslint-disable @typescript-eslint/explicit-function-return-type -- inferred test fixture types */
import { describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { applyCachedPdfTableSources } from '../../src/reader/table-source.js'
import { applyCachedPdfFigureSources } from '../../src/reader/figure-source.js'
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

function incompleteComponentSetup() {
  const f = setup()
  f.cached.elements[0].table!.cells.pop()
  f.cached.elements[0].table!.columnCount = 1
  f.cached.elements.push({
    ...structuredClone(f.cached.elements[0]),
    id: 'independent',
    regions: [{ page: 1, ...f.rect(0.1, 0.6) }],
    table: {
      rowCount: 1,
      columnCount: 1,
      issues: [],
      unassignedText: [],
      cells: [
        {
          row: 0,
          column: 0,
          rowSpan: 1,
          columnSpan: 1,
          text: 'Prose',
          regions: [{ page: 1, ...f.rect(0.1, 0.6) }],
          sourceItems: [{ pageNumber: 1, index: 2, text: 'Prose' }]
        }
      ]
    }
  })
  return f
}

describe('transactional fallback for incomplete whole-unit allocations', () => {
  it.each([false, true])(
    'retains an unmeasured multi-region shared source without disabling independent tables, reverse: %s',
    async (reverse) => {
      const f = incompleteComponentSetup(),
        origin = { pageNumber: 1, index: 0, text: 'Alpha Beta Gamma' }
      f.items[0].str = origin.text
      f.context.extraction = {
        ...f.extraction,
        source: createPdfTranslationSource({
          ...f.extraction.source,
          units: [
            {
              ...f.extraction.source.units[0],
              source: 'Alpha Beta Gamma 10',
              fragments: [
                {
                  ...f.extraction.source.units[0].fragments[0],
                  items: [
                    { index: 0, text: origin.text },
                    { index: 1, text: '10' }
                  ]
                }
              ]
            },
            f.extraction.source.units[1]
          ]
        })
      }
      const table = f.cached.elements[0].table!
      table.columnCount = 2
      table.cells = [
        {
          ...table.cells[0],
          text: 'Alpha Beta',
          regions: [
            { page: 1, ...f.rect(0.1), width: 0.04 },
            { page: 1, ...f.rect(0.15), width: 0.04 }
          ],
          sourceItems: [origin]
        },
        {
          ...table.cells[0],
          column: 1,
          text: 'Gamma',
          regions: [{ page: 1, ...f.rect(0.22), width: 0.08 }],
          sourceItems: [{ ...origin }]
        }
      ]
      if (reverse) f.cached.elements.reverse()
      const before = structuredClone(f.cached)
      const result = await applyCachedPdfTableSources(f.context)
      expect(result.source.units.find((u) => u.id === 'group')).toEqual(
        f.context.extraction.source.units[0]
      )
      expect(
        result.source.units.filter((u) => u.id.startsWith('table-source:')).map((u) => u.source)
      ).toEqual(['Prose'])
      expect(result.coverage.warnings).toContainEqual({
        unitId: 'group',
        reasons: ['table-layout', 'table-structure-unreliable']
      })
      expect(f.cached).toEqual(before)
      f.items[0].str = 'Different native source'
      expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
    }
  )
  it.each([false, true])(
    'quarantines an unpartitionable shared parent without blocking an independent table, reverse: %s',
    async (reverse) => {
      const f = incompleteComponentSetup()
      f.items[0].str = 'Alpha 12'
      f.items[1].str = '.'
      f.context.extraction = {
        ...f.extraction,
        source: createPdfTranslationSource({
          ...f.extraction.source,
          units: [
            {
              ...f.extraction.source.units[0],
              source: 'Alpha 12.',
              fragments: [
                {
                  ...f.extraction.source.units[0].fragments[0],
                  items: [
                    { index: 0, text: 'Alpha 12' },
                    { index: 1, text: '.' }
                  ]
                }
              ]
            },
            f.extraction.source.units[1]
          ]
        })
      }
      const table = f.cached.elements[0].table!
      table.columnCount = 2
      const origin = { pageNumber: 1, index: 0, text: 'Alpha 12' }
      table.cells = [
        {
          ...table.cells[0],
          text: 'Alpha',
          regions: [{ page: 1, ...f.rect(0.1), width: 0.1 }],
          sourceItems: [origin]
        },
        {
          ...table.cells[0],
          column: 1,
          text: '12.',
          regions: [
            { page: 1, ...f.rect(0.2), width: 0.1 },
            { page: 1, ...f.rect(0.4) }
          ],
          sourceItems: [{ ...origin }, { pageNumber: 1, index: 1, text: '.' }]
        }
      ]
      if (reverse) f.cached.elements.reverse()
      const before = structuredClone(f.cached)
      expect(() => parsePdfStructureResult(f.cached, f.cached)).not.toThrow()
      const result = await applyCachedPdfTableSources(f.context)
      expect(result.source.units.find((u) => u.id === 'group')).toEqual(
        f.context.extraction.source.units[0]
      )
      expect(
        result.source.units.filter((u) => u.id.startsWith('table-source:')).map((u) => u.source)
      ).toEqual(['Prose'])
      expect(result.coverage.warnings).toContainEqual({
        unitId: 'group',
        reasons: ['table-layout', 'table-structure-unreliable']
      })
      expect(f.cached).toEqual(before)
      f.items[0].str = 'Changed native source'
      expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
    }
  )

  it('uses grid coordinates when cell serialization puts a header after its body', async () => {
    const f = setup()
    const table = f.cached.elements[0].table!
    table.rowCount = 2
    table.columnCount = 1
    table.cells[1].row = 1
    table.cells[1].column = 0
    table.cells.reverse()
    const before = structuredClone(f.cached)
    const result = await applyCachedPdfTableSources(f.context)
    expect(
      result.source.units.filter((u) => u.id.startsWith('table-source:')).map((u) => u.source)
    ).toEqual(['Row', '10'])
    expect(f.cached).toEqual(before)
  })

  it.each([false, true])(
    'keeps an incomplete component and applies an independent table, reverse: %s',
    async (reverse) => {
      const f = incompleteComponentSetup()
      if (reverse) f.cached.elements.reverse()
      const before = structuredClone(f.cached)
      const result = await applyCachedPdfTableSources(f.context)
      expect(result.source.units.find((u) => u.id === 'group')).toEqual(
        f.extraction.source.units[0]
      )
      expect(
        result.source.units.filter((u) => u.id.startsWith('table-source:')).map((u) => u.source)
      ).toEqual(['Prose'])
      expect(
        result.source.units
          .flatMap((u) => u.fragments.flatMap((fr) => fr.items))
          .sort((a, b) => a.index - b.index)
      ).toEqual([
        { index: 0, text: 'Row' },
        { index: 1, text: '10' },
        { index: 2, text: 'Prose' }
      ])
      expect(result.coverage.warnings).toContainEqual({
        unitId: 'group',
        reasons: ['table-layout', 'table-structure-unreliable']
      })
      expect(result.coverage.includedItemCount).toBe(3)
      expect(f.cached).toEqual(before)
    }
  )

  it('retains both tables sharing one original unit but publishes a disconnected table', async () => {
    const f = incompleteComponentSetup()
    f.cached.elements.push({
      ...structuredClone(f.cached.elements[0]),
      id: 'dependent',
      table: {
        ...structuredClone(f.cached.elements[0].table!),
        cells: [
          {
            row: 0,
            column: 0,
            rowSpan: 1,
            columnSpan: 1,
            text: '10',
            regions: [{ page: 1, ...f.rect(0.4) }],
            sourceItems: [{ pageNumber: 1, index: 1, text: '10' }]
          }
        ]
      }
    })
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units.find((u) => u.id === 'group')).toEqual(f.extraction.source.units[0])
    expect(result.source.units.filter((u) => u.sourceOnly).map((u) => u.source)).toEqual(['Prose'])
  })

  it('rolls back a transitive unit-table component without leaving staged replacements', async () => {
    const f = setup()
    f.items.push(
      { ...f.items[2], str: 'Tail', transform: [10, 0, 0, 10, 40, 30] },
      { ...f.items[2], str: 'Independent', transform: [10, 0, 0, 10, 10, 10] }
    )
    const unit = (id: string, indices: number[], y: number) => ({
      id,
      source: indices.map((index) => f.items[index].str).join(' '),
      fragments: [
        {
          pageNumber: 1,
          rect: { ...f.rect(0.1, y), width: 0.5 },
          items: indices.map((index) => ({ index, text: f.items[index].str }))
        }
      ]
    })
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: [
          f.extraction.source.units[0],
          unit('bridge', [2, 3], 0.6),
          unit('independent', [4], 0.8)
        ]
      }),
      coverage: { ...f.extraction.coverage, textItemCount: 5, includedItemCount: 5 }
    }
    const base = structuredClone(f.cached.elements[0])
    f.cached.elements = [[0], [1, 2], [3], [4]].map((indices, tableIndex) => ({
      ...structuredClone(base),
      id: `component-${tableIndex}`,
      regions: indices.map((index) => ({
        page: 1,
        ...f.rect(index === 1 || index === 3 ? 0.4 : 0.1, index < 2 ? 0.1 : index === 4 ? 0.8 : 0.6)
      })),
      table: {
        rowCount: 1,
        columnCount: indices.length,
        issues: [],
        unassignedText: [],
        cells: indices.map((index, column) => ({
          row: 0,
          column,
          rowSpan: 1,
          columnSpan: 1,
          text: f.items[index].str,
          regions: [
            {
              page: 1,
              ...f.rect(
                index === 1 || index === 3 ? 0.4 : 0.1,
                index < 2 ? 0.1 : index === 4 ? 0.8 : 0.6
              )
            }
          ],
          sourceItems: [{ pageNumber: 1, index, text: f.items[index].str }]
        }))
      }
    }))
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units.filter((u) => u.sourceOnly).map((u) => u.source)).toEqual([
      'Independent'
    ])
    expect(result.source.units.filter((u) => !u.sourceOnly)).toEqual(
      f.context.extraction.source.units.slice(0, 2)
    )
    expect(
      result.source.units
        .flatMap((u) => u.fragments.flatMap((fr) => fr.items))
        .sort((a, b) => a.index - b.index)
    ).toEqual(f.items.map((item, index) => ({ index, text: item.str })))
    expect(result.coverage.warnings.map((w) => w.unitId)).toEqual(['group', 'bridge'])
  })

  it('withdraws every cell of a complete shared parent when its original unit is incomplete', async () => {
    const f = incompleteComponentSetup()
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
    table.columnCount = 2
    table.cells = [0, 1].map((column) => {
      const region = { page: 1, ...f.rect(column === 0 ? 0.4 : 0.52), width: 0.08 }
      return {
        row: 0,
        column,
        rowSpan: 1,
        columnSpan: 1,
        text: '10',
        regions: [region],
        sourceSegments: [
          {
            pageNumber: 1,
            index: 1,
            text: '10 10',
            start: column * 3,
            end: column * 3 + 2,
            region: { ...region }
          }
        ]
      }
    })
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units.find((u) => u.id === 'group')).toEqual(
      f.context.extraction.source.units[0]
    )
    expect(result.source.units.filter((u) => u.sourceOnly).map((u) => u.source)).toEqual(['Prose'])
    expect(
      result.source.units
        .flatMap((u) => u.fragments.flatMap((fr) => fr.items))
        .filter((i) => i.index === 1)
    ).toEqual([{ index: 1, text: '10 10' }])
  })

  it.each([
    'claimed-literal',
    'claimed-box',
    'omitted-literal',
    'incomplete-parent',
    'independent-literal'
  ] as const)('still fails closed on invalid native proof: %s', async (kind) => {
    const f = incompleteComponentSetup()
    if (kind === 'claimed-literal')
      f.cached.elements[0].table!.cells[0].sourceItems![0].text = 'other'
    if (kind === 'claimed-box') f.cached.elements[0].table!.cells[0].regions[0].x += 0.01
    if (kind === 'omitted-literal') f.items[1].str = 'other'
    if (kind === 'independent-literal')
      f.cached.elements[1].table!.cells[0].sourceItems![0].text = 'other'
    if (kind === 'incomplete-parent') {
      const cell = f.cached.elements[0].table!.cells[0]
      cell.text = 'Ro'
      cell.regions[0].width = 0.1
      delete cell.sourceItems
      cell.sourceSegments = [
        { pageNumber: 1, index: 0, text: 'Row', start: 0, end: 2, region: { ...cell.regions[0] } }
      ]
    }
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })

  it('propagates cancellation during final omitted-item verification before publishing any component', async () => {
    const f = incompleteComponentSetup()
    Object.defineProperty(f.items[1], 'str', {
      get: () => {
        queueMicrotask(() => f.controller.abort())
        return '10'
      }
    })
    await expect(applyCachedPdfTableSources(f.context)).rejects.toThrow()
    expect(f.controller.signal.aborted).toBe(true)
  })
})

describe('cached PDF table source ownership', () => {
  it('preserves page-only font advisories through actual table replacements and figure ownership', async () => {
    const f = setup()
    const prior = await applyCachedPdfTableSources(f.context)
    const diagnostics = [{ pageNumber: 1, reason: 'unreliable-font-unicode' as const }]
    f.context.extraction = {
      ...f.extraction,
      coverage: { ...f.extraction.coverage, pageDiagnostics: diagnostics }
    }
    const tables = await applyCachedPdfTableSources(f.context)
    expect(tables.source).toEqual(prior.source)
    expect(tables.coverage).toEqual({ ...prior.coverage, pageDiagnostics: diagnostics })
    f.cached.elements = [
      {
        id: 'figure-1',
        kind: 'figure',
        issues: [],
        regions: [{ page: 1, x: 0.05, y: 0.05, width: 0.7, height: 0.3 }],
        caption: {
          text: 'Figure 1. Measured signals.',
          regions: [{ page: 1, x: 0.05, y: 0.4, width: 0.7, height: 0.1 }]
        },
        sourceItems: [
          { pageNumber: 1, index: 0, text: 'Row' },
          { pageNumber: 1, index: 1, text: '10' }
        ]
      }
    ]
    const figures = await applyCachedPdfFigureSources(f.context)
    expect(figures.source.units).toEqual([
      { ...f.extraction.source.units[0], sourceOnly: true },
      f.extraction.source.units[1]
    ])
    expect(figures.coverage).toEqual(f.context.extraction.coverage)
  })
  it.each([
    'overlapping-predicted-columns',
    'conflicting-spanning-cells',
    'unresolved-spanning-cells',
    'span-conflicts-with-source-rows',
    'span-conflicts-with-source-columns',
    'native-table-structure-ambiguous'
  ])('preserves native units for an explicitly unresolved conflict: %s', async (code) => {
    const f = setup()
    f.cached.elements[0].table!.issues = [{ code, detail: 'No unique structural owner' }]
    const before = structuredClone(f.cached)
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source).toEqual(f.extraction.source)
    expect(result.coverage.warnings).toEqual([
      { unitId: 'group', reasons: ['table-layout', 'table-structure-unreliable'] }
    ])
    expect(f.cached).toEqual(before)
  })

  it.each(['literal', 'page'])(
    'does not publish an unverified fallback warning: %s',
    async (mutation) => {
      const f = setup()
      f.cached.elements[0].table!.issues = [
        { code: 'native-table-structure-ambiguous', detail: 'Uncertain ownership' }
      ]
      if (mutation === 'literal')
        f.cached.elements[0].table!.cells[0].sourceItems![0].text = 'Other'
      else f.cached.pages[0].width += 1
      const before = structuredClone(f.cached)
      expect(await applyCachedPdfTableSources(f.context)).toBe(f.extraction)
      expect(f.cached).toEqual(before)
    }
  )

  it('does not disable a source-proved table merely because unassigned text is reported', async () => {
    const f = setup()
    f.cached.elements[0].table!.issues = [
      { code: 'unassigned-source-text', detail: 'Separate note' }
    ]
    f.cached.elements[0].table!.unassignedText = [
      { text: 'Prose', regions: [{ page: 1, ...f.rect(0.1, 0.6) }] }
    ]
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units.filter((unit) => unit.sourceOnly)).toHaveLength(2)
    expect(result.source.units.find((unit) => unit.id === 'prose')).toEqual(
      f.extraction.source.units[1]
    )
    expect(
      result.coverage.warnings.some((warning) =>
        warning.reasons.includes('table-structure-unreliable')
      )
    ).toBe(false)
  })

  it('keeps uncertain table native units while applying an independent reliable table', async () => {
    const f = setup()
    f.cached.elements[0].table!.issues = [
      { code: 'native-table-structure-ambiguous', detail: 'No unique row owner' }
    ]
    f.cached.elements.push({
      ...structuredClone(f.cached.elements[0]),
      id: 'independent',
      regions: [{ page: 1, ...f.rect(0.1, 0.6) }],
      table: {
        rowCount: 1,
        columnCount: 1,
        issues: [],
        unassignedText: [],
        cells: [
          {
            row: 0,
            column: 0,
            rowSpan: 1,
            columnSpan: 1,
            text: 'Prose',
            regions: [{ page: 1, ...f.rect(0.1, 0.6) }],
            sourceItems: [{ pageNumber: 1, index: 2, text: 'Prose' }]
          }
        ]
      }
    })
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units.find((unit) => unit.id === 'group')).toEqual(
      f.extraction.source.units[0]
    )
    expect(
      result.source.units
        .filter((unit) => unit.id.startsWith('table-source:'))
        .map((unit) => unit.source)
    ).toEqual(['Prose'])
    expect(result.coverage.warnings).toContainEqual({
      unitId: 'group',
      reasons: ['table-layout', 'table-structure-unreliable']
    })
    expect(f.cached.elements).toHaveLength(2)
  })

  it('keeps the entire native unit when a reliable table shares it with a conflicting table', async () => {
    const f = setup()
    const original = structuredClone(f.cached.elements[0])
    f.cached.elements[0].table!.cells = [original.table!.cells[0]]
    f.cached.elements[0].table!.columnCount = 1
    f.cached.elements[0].table!.issues = [
      { code: 'span-conflicts-with-source-rows', detail: 'Ambiguous record' }
    ]
    f.cached.elements.push({
      ...original,
      id: 'dependent',
      table: {
        ...original.table!,
        columnCount: 1,
        cells: [{ ...original.table!.cells[1], column: 0 }],
        issues: []
      }
    })
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source).toEqual(f.extraction.source)
    expect(result.coverage.warnings).toContainEqual({
      unitId: 'group',
      reasons: ['table-layout', 'table-structure-unreliable']
    })
  })

  it('propagates fallback through a transitive shared-unit dependency without dropping native text', async () => {
    const f = setup()
    const original = f.cached.elements[0].table!
    const make = (
      id: string,
      indices: number[],
      conflict = false
    ): PdfStructureResult['elements'][number] => ({
      ...structuredClone(f.cached.elements[0]),
      id,
      table: {
        ...structuredClone(original),
        columnCount: indices.length,
        issues: conflict ? [{ code: 'native-table-structure-ambiguous', detail: 'Ambiguous' }] : [],
        cells: indices.map((index, column) =>
          index < 2
            ? { ...structuredClone(original.cells[index]), column }
            : {
                row: 0,
                column,
                rowSpan: 1,
                columnSpan: 1,
                text: 'Prose',
                regions: [{ page: 1, ...f.rect(0.1, 0.6) }],
                sourceItems: [{ pageNumber: 1, index: 2, text: 'Prose' }]
              }
        )
      }
    })
    f.cached.elements = [make('conflict', [0], true), make('bridge', [1, 2]), make('last', [2])]
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source).toEqual(f.extraction.source)
    expect(result.coverage.warnings.map((warning) => warning.unitId)).toEqual(['group', 'prose'])
    expect(
      result.coverage.warnings.every((warning) =>
        warning.reasons.includes('table-structure-unreliable')
      )
    ).toBe(true)
  })

  it.each([false, true])(
    'isolates grouped parts unless a genuine parent conflict exists: %s',
    async (parentConflict) => {
      const f = setup()
      const table = f.cached.elements[0].table!
      table.issues = [{ code: 'unresolved-spanning-cells', detail: 'Ambiguous' }]
      f.cached.elements[0] = {
        ...f.cached.elements[0],
        // The same code/detail may also describe an independent whole-group
        // conflict. Readers must not subtract parent issues matching a part.
        issues: parentConflict ? structuredClone(table.issues) : [],
        table: undefined,
        caption: {
          text: 'Table. Two domains',
          regions: structuredClone(f.cached.elements[0].regions)
        },
        regions: [...f.cached.elements[0].regions, { page: 1, ...f.rect(0.1, 0.6) }],
        tableParts: [
          { title: 'Unresolved', table },
          {
            title: 'Reliable',
            table: {
              rowCount: 1,
              columnCount: 1,
              issues: [],
              unassignedText: [],
              cells: [
                {
                  row: 0,
                  column: 0,
                  rowSpan: 1,
                  columnSpan: 1,
                  text: 'Prose',
                  regions: [{ page: 1, ...f.rect(0.1, 0.6) }],
                  sourceItems: [{ pageNumber: 1, index: 2, text: 'Prose' }]
                }
              ]
            }
          }
        ]
      }
      expect(() => parsePdfStructureResult(f.cached, f.cached)).not.toThrow()
      const result = await applyCachedPdfTableSources(f.context)
      expect(
        result.source.units.filter((unit) => unit.sourceOnly).map((unit) => unit.source)
      ).toEqual(parentConflict ? [] : ['Prose'])
      expect(result.source.units.find((unit) => unit.id === 'group')).toEqual(
        f.extraction.source.units[0]
      )
      if (parentConflict) {
        expect(result.source.units).toEqual(f.extraction.source.units)
        expect(
          result.coverage.warnings.every((warning) =>
            warning.reasons.includes('table-structure-unreliable')
          )
        ).toBe(true)
      }
    }
  )

  // Insert inside the existing cached PDF table source ownership describe, using setup().
  it('remaps removed-unit warnings to the native owners created by table replacement', async () => {
    const f = setup()
    const unchanged = { unitId: 'prose', reasons: ['ambiguous-line-hyphen'] }
    f.context.extraction = {
      ...f.extraction,
      coverage: {
        ...f.extraction.coverage,
        warnings: [
          { unitId: 'group', reasons: ['table-layout', 'unreliable-font-unicode'] },
          unchanged
        ]
      }
    }
    const result = await applyCachedPdfTableSources(f.context)
    const owners = result.source.units.filter((unit) => unit.sourceOnly)
    expect(owners).toHaveLength(2)
    expect(result.coverage.warnings).toEqual([
      unchanged,
      ...owners.map((unit) => ({
        unitId: unit.id,
        reasons: ['table-layout', 'unreliable-font-unicode']
      }))
    ])
    expect(result.coverage.warnings[0]).toBe(unchanged)
    expect(
      result.coverage.warnings.every((warning) =>
        result.source.units.some((unit) => unit.id === warning.unitId)
      )
    ).toBe(true)
    expect({ ...result.coverage, warnings: [] }).toEqual({ ...f.extraction.coverage, warnings: [] })
    expect(f.context.extraction.coverage.warnings[0].unitId).toBe('group')
  })

  it('preserves warning identity when table ownership has no removed warning or is rejected', async () => {
    const f = setup()
    f.context.extraction = {
      ...f.extraction,
      coverage: {
        ...f.extraction.coverage,
        warnings: [{ unitId: 'prose', reasons: ['unreliable-font-unicode'] }]
      }
    }
    const accepted = await applyCachedPdfTableSources(f.context)
    expect(accepted.coverage).toBe(f.context.extraction.coverage)
    const rejected = setup()
    rejected.cached.elements[0].table!.cells.pop()
    const retained = await applyCachedPdfTableSources(rejected.context)
    expect(retained.source).toEqual(rejected.extraction.source)
    expect(retained.coverage.warnings).toEqual([
      { unitId: 'group', reasons: ['table-layout', 'table-structure-unreliable'] }
    ])
  })

  it('unions warning reasons when separate native reader units acquire one table owner', async () => {
    const f = setup()
    const [group, prose] = f.extraction.source.units
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: [
          {
            ...group,
            id: 'left',
            source: 'Row',
            fragments: [{ ...group.fragments[0], items: [{ index: 0, text: 'Row' }] }]
          },
          {
            ...group,
            id: 'right',
            source: '10',
            fragments: [{ ...group.fragments[0], items: [{ index: 1, text: '10' }] }]
          },
          prose
        ]
      }),
      coverage: {
        ...f.extraction.coverage,
        warnings: [
          { unitId: 'left', reasons: ['unreliable-font-unicode'] },
          { unitId: 'right', reasons: ['table-layout', 'unreliable-font-unicode'] }
        ]
      }
    }
    const table = f.cached.elements[0].table!
    table.cells = [
      {
        ...table.cells[0],
        columnSpan: 2,
        text: 'Row 10',
        regions: table.cells.flatMap((cell) => cell.regions),
        sourceItems: table.cells.flatMap((cell) => cell.sourceItems!)
      }
    ]
    const result = await applyCachedPdfTableSources(f.context)
    const owner = result.source.units.find((unit) => unit.sourceOnly)!
    expect(owner).toBeDefined()
    expect(result.coverage.warnings).toEqual([
      { unitId: owner.id, reasons: ['unreliable-font-unicode', 'table-layout'] }
    ])
  })

  it.each([
    'missing-proof',
    'partial-unit',
    'wrong-literal',
    'stale-source',
    'duplicate-origin',
    'wrong-page',
    'caption-overlap',
    'competing-figure',
    'outside-native-ink',
    'outside-unit',
    'missing-caption',
    'uncertain-figure',
    'unsafe-figure'
  ])('keeps prose when figure ownership is not complete: %s', async (variant) => {
    const fixture = setup()
    const figure: PdfStructureResult['elements'][number] = {
      id: 'figure-1',
      kind: 'figure',
      issues: [{ code: 'native-raster-composite-grid', detail: 'native-raster-composite-grid' }],
      regions: [{ page: 1, x: 0.05, y: 0.05, width: 0.7, height: 0.3 }],
      caption: {
        text: 'Figure 1. Measured signals.',
        regions: [{ page: 1, x: 0.05, y: 0.4, width: 0.7, height: 0.1 }]
      },
      sourceItems: [
        { pageNumber: 1, index: 0, text: 'Row' },
        { pageNumber: 1, index: 1, text: '10' }
      ]
    }
    fixture.cached.elements = [figure]
    if (variant === 'missing-proof') delete figure.sourceItems
    if (variant === 'partial-unit') figure.sourceItems!.pop()
    if (variant === 'wrong-literal') figure.sourceItems![0].text = 'Different'
    if (variant === 'stale-source') fixture.cached.sourceChecksum = 'd'.repeat(64)
    if (variant === 'duplicate-origin') figure.sourceItems![1] = { ...figure.sourceItems![0] }
    if (variant === 'wrong-page') figure.sourceItems![0].pageNumber = 2
    if (variant === 'caption-overlap') figure.caption!.regions = structuredClone(figure.regions)
    if (variant === 'competing-figure')
      fixture.cached.elements.push({
        id: 'figure-2',
        kind: 'figure',
        issues: [],
        regions: structuredClone(figure.regions)
      })
    if (variant === 'outside-native-ink') fixture.items[0].transform[5] = 20
    if (variant === 'outside-unit') figure.regions[0].height = 0.12
    if (variant === 'missing-caption') delete figure.caption
    if (variant === 'uncertain-figure')
      figure.issues.push({ code: 'uncertain', detail: 'Unproved' })
    if (variant === 'unsafe-figure')
      figure.issues.push({ code: 'text-dominant-graphics', detail: 'text-dominant-graphics' })
    expect(await applyCachedPdfFigureSources(fixture.context)).toBe(fixture.extraction)
    expect(fixture.extraction.source.units[0].sourceOnly).toBeUndefined()
  })

  it('propagates cancellation and retains source when a figure cache read fails', async () => {
    const fixture = setup()
    fixture.readCached.mockRejectedValueOnce(new Error('Unavailable cache'))
    expect(await applyCachedPdfFigureSources(fixture.context)).toBe(fixture.extraction)
    fixture.controller.abort()
    await expect(applyCachedPdfFigureSources(fixture.context)).rejects.toThrow()
  })

  it.each([false, true])(
    'retains proved figure text with informational recovery %s while keeping prose and captions eligible',
    async (informational) => {
      const fixture = setup()
      fixture.cached.elements = [
        {
          id: 'figure-1',
          kind: 'figure',
          issues: informational
            ? [{ code: 'native-raster-composite-grid', detail: 'native-raster-composite-grid' }]
            : [],
          regions: [{ page: 1, x: 0.05, y: 0.05, width: 0.7, height: 0.3 }],
          caption: {
            text: 'Figure 1. Measured signals.',
            regions: [{ page: 1, x: 0.05, y: 0.4, width: 0.7, height: 0.1 }]
          },
          sourceItems: [
            { pageNumber: 1, index: 0, text: 'Row' },
            { pageNumber: 1, index: 1, text: '10' }
          ]
        }
      ]
      const result = await applyCachedPdfFigureSources(fixture.context)
      expect(result.source.units).toEqual([
        { ...fixture.extraction.source.units[0], sourceOnly: true },
        fixture.extraction.source.units[1]
      ])
      expect(result.coverage).toEqual(fixture.extraction.coverage)
      expect(fixture.extraction.source.units[0].sourceOnly).toBeUndefined()
      expect(fixture.document.destroy).not.toHaveBeenCalled()
      expect(fixture.page.cleanup).not.toHaveBeenCalled()
    }
  )

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
      expect(units.map((u) => u.source)).toEqual(['10 20', 'Row'])
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
      expect(owner.fragments[0].rect.width).toBeCloseTo(0.2)
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
    expect({ ...result.coverage, warnings: [] }).toEqual({ ...f.extraction.coverage, warnings: [] })
    expect(result.coverage.warnings).toEqual(
      result.source.units
        .filter((unit) => unit.sourceOnly)
        .map((unit) => ({ unitId: unit.id, reasons: ['table-layout'] }))
    )
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
    const result = await applyCachedPdfTableSources(f.context)
    if (kind === 'mixed-unit') {
      expect(result.source).toEqual(f.context.extraction.source)
      expect(result.coverage.warnings).toEqual([
        { unitId: 'group', reasons: ['table-layout', 'table-structure-unreliable'] }
      ])
    } else expect(result).toBe(f.context.extraction)
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

function warningFallbackFixture(): ReturnType<typeof setup> {
  const f = setup()
  f.cached.elements[0].table!.issues = [
    { code: 'unresolved-spanning-cells', detail: 'No unique owner' }
  ]
  f.cached.elements.push({
    id: 'independent-unproved',
    kind: 'table',
    regions: [{ page: 1, ...f.rect(0.1, 0.6) }],
    issues: [],
    table: {
      rowCount: 1,
      columnCount: 1,
      issues: [],
      unassignedText: [],
      cells: [
        {
          row: 0,
          column: 0,
          rowSpan: 1,
          columnSpan: 1,
          text: 'Prose',
          sourceItems: [{ pageNumber: 1, index: 2, text: 'Prose' }],
          regions: [{ page: 1, ...f.rect(0.1, 0.61) }]
        }
      ]
    }
  })
  return f
}

describe('independently proved conflict warnings on full native fallback', () => {
  it('propagates cancellation after the last whole-unit native proof before warning publication', async () => {
    const f = warningFallbackFixture()
    let reads = 0
    Object.defineProperty(f.items[1], 'str', {
      get: () => {
        // The first read proves the cached origin; the second proves the complete original unit.
        if (++reads === 2) queueMicrotask(() => f.controller.abort())
        return '10'
      }
    })
    await expect(applyCachedPdfTableSources(f.context)).rejects.toThrow()
    expect(f.controller.signal.aborted).toBe(true)
  })

  it('adds only the conflict warning when an independent cell fails native geometry proof', async () => {
    const f = warningFallbackFixture()
    const before = structuredClone(f.cached)
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source).toBe(f.extraction.source)
    expect(result.coverage).toEqual({
      ...f.extraction.coverage,
      warnings: [{ unitId: 'group', reasons: ['table-layout', 'table-structure-unreliable'] }]
    })
    expect(f.cached).toEqual(before)
  })

  it.each(['width', 'rotation'] as const)(
    'checks every shared-parent %s declaration in both cache orders',
    async (field) => {
      for (const invalidFirst of [true, false]) {
        const f = warningFallbackFixture()
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
        const invalid = structuredClone(f.cached)
        invalid.extractionId = 'distinct-cache'
        if (field === 'width') invalid.pages[0].width++
        else invalid.pages[0].rotation = 90
        f.readCached
          .mockResolvedValueOnce(invalidFirst ? invalid : f.cached)
          .mockResolvedValueOnce(invalidFirst ? f.cached : invalid)
        expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
      }
    }
  )

  it.each(['cache-literal', 'native-literal', 'missing-origin', 'source-identity'])(
    'does not attach warnings without whole native proof: %s',
    async (kind) => {
      const f = warningFallbackFixture()
      if (kind === 'cache-literal')
        f.cached.elements[0].table!.cells[0].sourceItems![0].text = 'Forged'
      if (kind === 'native-literal') f.items[0].str = 'Changed native'
      if (kind === 'missing-origin') delete f.cached.elements[0].table!.cells[0].sourceItems
      if (kind === 'source-identity') f.cached.sourceChecksum = 'c'.repeat(64)
      expect(await applyCachedPdfTableSources(f.context)).toBe(f.extraction)
    }
  )

  it('checks every native item in a blocked whole unit, including an item outside the cell claims', async () => {
    const f = warningFallbackFixture()
    f.items.push({ ...f.items[2], str: 'Tail' })
    const original = f.extraction.source.units[0]
    const group = {
      ...original,
      fragments: original.fragments.map((fragment) => ({
        ...fragment,
        items: [...fragment.items, { index: 3, text: 'Forged tail' }]
      }))
    }
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: [group, f.extraction.source.units[1]]
      })
    }
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })

  it('keeps the native-owner uniqueness guard before warning proof', async () => {
    const f = warningFallbackFixture()
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: [
          ...f.extraction.source.units,
          { ...f.extraction.source.units[0], id: 'duplicate-native-owner' }
        ]
      })
    }
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })

  it('keeps aggregate cache budget failure before warning publication', async () => {
    const f = warningFallbackFixture()
    for (let i = f.cached.elements.length; i < 513; i++)
      f.cached.elements.push({
        id: `extra-${i}`,
        kind: 'figure',
        regions: [{ page: 1, ...f.rect(0.1) }],
        issues: []
      })
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.extraction)
  })

  it('does not attach a conflict warning when there is no conflict seed', async () => {
    const f = warningFallbackFixture()
    f.cached.elements[0].table!.issues = []
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.extraction)
  })

  it('preserves abort propagation during independent warning proof', async () => {
    const f = warningFallbackFixture()
    f.page.getTextContent.mockImplementationOnce(async () => {
      f.controller.abort()
      return { items: f.items, styles: {} }
    })
    await expect(applyCachedPdfTableSources(f.context)).rejects.toThrow()
  })

  it('preserves the original extraction when native warning proof throws', async () => {
    const f = warningFallbackFixture()
    f.page.getTextContent.mockRejectedValueOnce(new Error('Native unavailable'))
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.extraction)
  })

  it('keeps independent valid mapping unchanged when no global guard fails', async () => {
    const f = warningFallbackFixture()
    f.cached.elements[1].table!.cells[0].regions[0].y = 0.6
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units[0]).toEqual(f.extraction.source.units[0])
    expect(result.source.units.filter((u) => u.id.startsWith('table-source:'))).toHaveLength(1)
    expect(result.coverage.warnings).toEqual([
      { unitId: 'group', reasons: ['table-layout', 'table-structure-unreliable'] }
    ])
  })
})

function glyphCellSetup(text = 'Summary') {
  const f = setup()
  const items = [...text].map((str, index) => ({
    str,
    dir: 'ltr',
    fontName: 'native-font',
    hasEOL: false,
    transform: [10, 0, 0, 10, 10 + index * 5, 80],
    width: 5,
    height: 10
  }))
  const regions = () =>
    items.map((item) => ({
      page: 1,
      x: item.transform[4] / 100,
      y: (90 - item.transform[5]) / 100,
      width: item.width / 100,
      height: 0.1
    }))
  const nativeItems = items.map((item, index) => ({ index, text: item.str }))
  f.page.getTextContent.mockImplementation(async () => ({ items, styles: {} }))
  const source = createPdfTranslationSource({
    ...f.extraction.source,
    units: [
      {
        id: 'native-glyphs',
        source: text,
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 0.1, y: 0.1, width: (10 + text.length * 5) / 100 - 0.1, height: 0.1 },
            items: nativeItems
          }
        ]
      }
    ]
  })
  f.context.extraction = {
    source,
    coverage: {
      ...f.extraction.coverage,
      textItemCount: items.length,
      includedItemCount: items.length,
      warnings: []
    }
  }
  f.cached.elements[0].table = {
    rowCount: 1,
    columnCount: 1,
    issues: [],
    unassignedText: [],
    cells: [
      {
        row: 0,
        column: 0,
        rowSpan: 1,
        columnSpan: 1,
        text,
        regions: regions(),
        sourceItems: nativeItems.map((item) => ({ pageNumber: 1, ...item }))
      }
    ]
  }
  return {
    ...f,
    glyphs: items,
    refreshRegions: () => {
      f.cached.elements[0].table!.cells[0].regions = regions()
    }
  }
}

describe('native glyph spacing in table source replacements', () => {
  it('allows native advance rounding while preserving explicit word boundaries', async () => {
    const f = glyphCellSetup('Résumé')
    f.glyphs[0].width += 0.005
    f.glyphs[1].width -= 0.0005
    f.refreshRegions()
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units[0].source).toBe('Résumé')
    expect(result.source.units[0].fragments.flatMap((f) => f.items)).toEqual(
      f.context.extraction.source.units[0].fragments.flatMap((f) => f.items)
    )
  })

  it.each([
    'word-gap',
    'overlap',
    'baseline',
    'font',
    'missing-font',
    'eol',
    'scale',
    'cell-word-break',
    'cell-literal'
  ])('keeps native separators when %s prevents a unique complete word', async (variant) => {
    const f = glyphCellSetup()
    if (variant === 'word-gap') f.glyphs[0].width -= 1
    if (variant === 'overlap') f.glyphs[0].width += 1
    if (variant === 'baseline') f.glyphs[1].transform[5] += 0.5
    if (variant === 'font') f.glyphs[1].fontName = 'other-font'
    if (variant === 'missing-font')
      f.glyphs.forEach((item) => {
        item.fontName = ''
      })
    if (variant === 'eol') f.glyphs[0].hasEOL = true
    if (variant === 'scale') f.glyphs[1].transform[0] = 9
    if (variant === 'cell-word-break') f.cached.elements[0].table!.cells[0].text = 'Sum mary'
    if (variant === 'cell-literal') f.cached.elements[0].table!.cells[0].text = 'Summers'
    f.refreshRegions()
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units[0].id).toMatch(/^table-source:/)
    expect(result.source.units[0].source).toBe('S u m m a r y')
    expect(result.source.units[0].fragments.flatMap((f) => f.items)).toEqual(
      f.context.extraction.source.units[0].fragments.flatMap((f) => f.items)
    )
  })

  it('does not join across an omitted native whitespace item', async () => {
    const f = glyphCellSetup()
    f.glyphs.splice(3, 0, { ...f.glyphs[2], str: ' ', width: 0.1 })
    const cell = f.cached.elements[0].table!.cells[0]
    cell.sourceItems = cell.sourceItems!.map((item) => ({
      ...item,
      index: item.index >= 3 ? item.index + 1 : item.index
    }))
    const source = createPdfTranslationSource({
      ...f.context.extraction.source,
      units: f.context.extraction.source.units.map((unit) => ({
        ...unit,
        fragments: unit.fragments.map((fragment) => ({
          ...fragment,
          items: fragment.items.map((item) => ({
            ...item,
            index: item.index >= 3 ? item.index + 1 : item.index
          }))
        }))
      }))
    })
    f.context.extraction = { ...f.context.extraction, source }
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units[0].id).toMatch(/^table-source:/)
    expect(result.source.units[0].source).toBe('S u m m a r y')
  })

  it('preserves a complete word carried by contiguous native letter items', async () => {
    const f = glyphCellSetup()
    const before = structuredClone(f.context.extraction.source.units[0].fragments)
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units).toHaveLength(1)
    expect(result.source.units[0].id).toMatch(/^table-source:/)
    expect(result.source.units[0].source).toBe('Summary')
    expect(result.source.units[0].fragments).toEqual(before)
    expect(result.source.units[0].sourceOnly).toBe(true)
    expect(result.coverage.includedItemCount).toBe(7)
  })
})

function originalBoundarySetup(parts = ['X', 'YZ'], text = parts.join('')) {
  const f = glyphCellSetup('AB')
  const prototype = f.glyphs[0]
  f.glyphs.splice(
    0,
    f.glyphs.length,
    ...parts.map((str, index) => ({
      ...prototype,
      str,
      width: 10,
      transform: [10, 0, 0, 10, 10 + index * 9.5, 80]
    }))
  )
  const items = parts.map((text, index) => ({ index, text }))
  const unit = f.context.extraction.source.units[0]
  f.context.extraction = {
    ...f.context.extraction,
    source: createPdfTranslationSource({
      ...f.context.extraction.source,
      units: [{ ...unit, source: text, fragments: [{ ...unit.fragments[0], items }] }]
    })
  }
  const cell = f.cached.elements[0].table!.cells[0]
  cell.text = text
  cell.sourceItems = items.map((item) => ({ pageNumber: 1, ...item }))
  f.refreshRegions()
  return f
}

describe('complete original native text boundary witnesses', () => {
  it('retains a complete original word when a cell would introduce an unproved internal space', async () => {
    const f = originalBoundarySetup(['Ordinary conte', 'nt stays available'])
    f.glyphs[1].transform[4] = 20.08
    f.refreshRegions()
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source).toEqual(f.context.extraction.source)
    expect(result.coverage.warnings).toEqual([
      { unitId: 'native-glyphs', reasons: ['table-structure-unreliable'] }
    ])
    expect(result.source.units[0].source).toBe('Ordinary content stays available')
    f.glyphs[1].str = 'different native text'
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })

  it('keeps explicit original word spaces and does not quarantine verified contiguous text', async () => {
    for (const separated of [false, true]) {
      const parts = ['Ordinary', 'words remain']
      const f = originalBoundarySetup(parts, parts.join(separated ? ' ' : ''))
      if (separated) f.glyphs[1].transform[4] = 22
      f.refreshRegions()
      const result = await applyCachedPdfTableSources(f.context)
      expect(result.source.units[0].id).toMatch(/^table-source:/)
      expect(result.source.units[0].source).toBe(f.context.extraction.source.units[0].source)
      expect(result.coverage.warnings).toEqual([])
    }
  })

  it.each([
    ['acronym', ['X', 'YZ'], 'XYZ'],
    ['number', ['12', '3'], '123'],
    ['punctuation', ['Word', '.'], 'Word.']
  ] as const)('preserves the exact original %s connection', async (kind, parts, text) => {
    const f = originalBoundarySetup([...parts], text)
    if (kind === 'punctuation') f.glyphs[1].fontName = 'other-style'
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units[0].id).toMatch(/^table-source:/)
    expect(result.source.units[0].source).toBe(text)
    expect(result.source.units[0].fragments.flatMap((f) => f.items)).toEqual(
      f.context.extraction.source.units[0].fragments.flatMap((f) => f.items)
    )
  })

  it.each([
    'whitespace',
    'cross-unit',
    'eol',
    'segment',
    'baseline',
    'word-gap',
    'reverse',
    'cell-break',
    'literal',
    'repeated-substring'
  ])('retains native separators without a complete %s witness', async (variant) => {
    const f = originalBoundarySetup()
    const unit = f.context.extraction.source.units[0]
    let units = [unit]
    if (variant === 'whitespace') units = [{ ...unit, source: 'X YZ' }]
    if (variant === 'literal') units = [{ ...unit, source: 'XQZ' }]
    if (variant === 'repeated-substring') units = [{ ...unit, source: 'XYZXYZ' }]
    if (variant === 'cross-unit')
      units = unit.fragments[0].items.map((item, index) => ({
        ...unit,
        id: `part-${index}`,
        source: item.text,
        fragments: [{ ...unit.fragments[0], items: [item] }]
      }))
    f.context.extraction = {
      ...f.context.extraction,
      source: createPdfTranslationSource({ ...f.context.extraction.source, units })
    }
    if (variant === 'eol') f.glyphs[0].hasEOL = true
    if (variant === 'baseline') f.glyphs[1].transform[5] += 1
    if (variant === 'word-gap') f.glyphs[1].transform[4] += 10
    if (variant === 'reverse') f.glyphs[1].transform[4] = 9
    if (variant === 'cell-break') f.cached.elements[0].table!.cells[0].text = 'X YZ'
    f.refreshRegions()
    if (variant === 'segment') {
      const cell = f.cached.elements[0].table!.cells[0]
      cell.sourceSegments = cell.sourceItems!.map((origin, index) => ({
        ...origin,
        start: 0,
        end: origin.text.length,
        region: cell.regions[index]
      }))
      delete cell.sourceItems
    }
    const result = await applyCachedPdfTableSources(f.context)
    if (variant === 'segment') expect(result).toBe(f.context.extraction)
    else {
      expect(result.source.units[0].id).toMatch(/^table-source:/)
      expect(result.source.units[0].source).toBe('X YZ')
    }
  })

  it('rejects contradictory original units sharing the same native identities', async () => {
    const f = originalBoundarySetup()
    const unit = f.context.extraction.source.units[0]
    f.context.extraction = {
      ...f.context.extraction,
      source: createPdfTranslationSource({
        ...f.context.extraction.source,
        units: [unit, { ...unit, id: 'alias', source: 'X YZ' }]
      })
    }
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })
})

describe('complete native mathematical source preservation', () => {
  it.each(['1/2', '1 2', '12'])(
    'preserves an original fraction separator without treating ordinary gaps as fractions: %s',
    async (source) => {
      const f = incompleteComponentSetup()
      f.items[0].str = '1'
      f.items[1].str = '2'
      f.items[1].transform = [10, 0, 0, 10, 10, 60]
      const original = {
        ...f.extraction.source.units[0],
        source,
        sourceOnly: true,
        fragments: [
          {
            pageNumber: 1,
            rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 },
            items: [
              { index: 0, text: '1' },
              { index: 1, text: '2' }
            ]
          }
        ]
      }
      f.context.extraction = {
        ...f.extraction,
        source: createPdfTranslationSource({
          ...f.extraction.source,
          units: [original, f.extraction.source.units[1]]
        })
      }
      f.cached.elements[0].table!.cells = [
        {
          ...f.cached.elements[0].table!.cells[0],
          text: '12',
          regions: [
            { page: 1, ...f.rect(0.1) },
            { page: 1, ...f.rect(0.1, 0.3) }
          ],
          sourceItems: [
            { pageNumber: 1, index: 0, text: '1' },
            { pageNumber: 1, index: 1, text: '2' }
          ]
        }
      ]
      const result = await applyCachedPdfTableSources(f.context)
      if (!source.includes('/')) {
        expect(
          result.source.units.filter((u) => u.id.startsWith('table-source:')).map((u) => u.source)
        ).toEqual(['1 2', 'Prose'])
        expect(
          result.coverage.warnings.some((w) => w.reasons.includes('table-structure-unreliable'))
        ).toBe(false)
        return
      }
      expect(result.source.units.find((u) => u.id === 'group')).toEqual(original)
      expect(
        result.source.units.filter((u) => u.id.startsWith('table-source:')).map((u) => u.source)
      ).toEqual(['Prose'])
      expect(result.coverage.warnings).toContainEqual({
        unitId: 'group',
        reasons: ['table-layout', 'table-structure-unreliable']
      })
    }
  )
})
it.each([false, true])(
  'keeps an unpartitionable two-parent component and an independent table: %s',
  async (reverse) => {
    const f = incompleteComponentSetup()
    f.items[0].str = 'Alpha One'
    f.items[1].str = 'Beta Two'
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: [
          {
            ...f.extraction.source.units[0],
            source: 'Alpha One Beta Two',
            fragments: [
              {
                ...f.extraction.source.units[0].fragments[0],
                items: [
                  { index: 0, text: 'Alpha One' },
                  { index: 1, text: 'Beta Two' }
                ]
              }
            ]
          },
          f.extraction.source.units[1]
        ]
      })
    }
    const table = f.cached.elements[0].table!,
      cell = table.cells[0]
    table.columnCount = 2
    const origins = [
      { pageNumber: 1, index: 0, text: 'Alpha One' },
      { pageNumber: 1, index: 1, text: 'Beta Two' }
    ]
    table.cells = [
      {
        ...cell,
        text: 'AlphaBeta',
        regions: [
          { page: 1, ...f.rect(0.1) },
          { page: 1, ...f.rect(0.4) }
        ],
        sourceItems: origins
      },
      {
        ...cell,
        column: 1,
        text: 'OneTwo',
        regions: [
          { page: 1, ...f.rect(0.1) },
          { page: 1, ...f.rect(0.4) }
        ],
        sourceItems: structuredClone(origins)
      }
    ]
    if (reverse) f.cached.elements.reverse()
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units.find((u) => u.id === 'group')).toEqual(
      f.context.extraction.source.units[0]
    )
    expect(
      result.source.units.filter((u) => u.id.startsWith('table-source:')).map((u) => u.source)
    ).toEqual(['Prose'])
    expect(result.coverage.warnings).toContainEqual({
      unitId: 'group',
      reasons: ['table-layout', 'table-structure-unreliable']
    })
    f.items[1].str = 'Foreign native'
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  }
)
