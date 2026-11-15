/* eslint-disable @typescript-eslint/explicit-function-return-type -- inferred test fixture types */
import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { applyCachedPdfStructureSources } from '../../src/reader/structure-source.js'
import {
  applyCachedPdfTableSources,
  getPdfTableOriginalRetention
} from '../../src/reader/table-source.js'
import {
  applyCachedPdfFigureSources,
  preservePdfFigureSources
} from '../../src/reader/figure-source.js'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'
import { bindPdfTranslation, createPdfTranslationSource } from '../../src/reader/source.js'
import type { PdfTranslationExtraction } from '../../src/reader/extraction.js'
import { parsePdfStructureResult, type PdfStructureResult } from '@aipoch/pdf-structure/result'

describe('unchanged original formula owners in table cells', () => {
  const fixture = () => {
    const f = setup()
    f.items[0].str = '(7)'
    f.cached.elements[0].table!.cells[0].text = '(7)'
    f.cached.elements[0].table!.cells[0].sourceItems![0].text = '(7)'
    f.items[1].transform[5] = 60
    f.cached.elements[0].table!.cells[1].regions[0].y = 0.3
    f.cached.elements[0].table!.cells[1].row = 1
    f.cached.elements[0].table!.cells[1].column = 0
    f.cached.elements[0].table!.rowCount = 2
    f.cached.elements[0].table!.columnCount = 1
    // The crop includes independently owned prose; it cannot replace the
    // existing formula's original fragment with a whole-table original region.
    f.cached.elements[0].regions[0].height = 0.6
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: [
          {
            id: 'header',
            source: '(7)',
            sourceOnly: true,
            preserve: 'formula',
            fragments: [
              {
                pageNumber: 1,
                rect: { x: 0.095, y: 0.095, width: 0.21, height: 0.115 },
                items: [{ index: 0, text: '(7)' }]
              }
            ]
          },
          {
            id: 'body',
            source: '10',
            fragments: [
              { pageNumber: 1, rect: f.rect(0.4, 0.3), items: [{ index: 1, text: '10' }] }
            ]
          },
          f.extraction.source.units[1]
        ]
      }),
      coverage: {
        ...f.extraction.coverage,
        warnings: [{ unitId: 'header', reasons: ['table-layout'] }]
      }
    }
    return f
  }
  const mutableUnits = (f: ReturnType<typeof fixture>) =>
    f.context.extraction.source.units.map((u) => ({
      ...u,
      fragments: u.fragments.map((g) => ({
        ...g,
        rect: { ...g.rect },
        items: g.items.map((i) => ({ ...i }))
      }))
    }))
  it.each(['foreign-crop', 'complete-crop'] as const)(
    'keeps the exact literal formula owner, position, crop and diagnostics: %s',
    async (mode) => {
      const f = fixture(),
        before = f.context.extraction.source
      if (mode === 'complete-crop') f.cached.elements[0].regions[0].height = 0.35
      const result = await applyCachedPdfTableSources(f.context)
      expect(result.source.units[0]).toEqual(before.units[mode === 'foreign-crop' ? 0 : 2])
      expect(
        result.source.units.filter((u) => u.id.startsWith('table-source:')).map((u) => u.source)
      ).toEqual(mode === 'foreign-crop' ? ['10'] : ['(7)', '10'])
      if (mode === 'foreign-crop') expect(result.source.originalRegions).toBeUndefined()
      else
        expect(result.source.originalRegions).toEqual([
          {
            pageNumber: 1,
            rect: {
              x: 0.095,
              y: 0.095,
              width: expect.closeTo(0.505),
              height: expect.closeTo(0.355)
            }
          }
        ])
      const header = result.source.units.find((u) => u.source === '(7)')!
      expect(header.sourceOnly).toBe(true)
      expect(result.coverage.warnings).toContainEqual({
        unitId: header.id,
        reasons: ['table-layout']
      })
      const content = applyPdfContentFirstPolicy(result.source)
      if (mode === 'foreign-crop')
        expect(content.originalRegions).toContainEqual({
          pageNumber: 1,
          rect: before.units[0].fragments[0].rect
        })
      else {
        expect(header.id).not.toBe('header')
        expect(header.preserve).toBeUndefined()
        expect(content.originalRegions).toEqual(result.source.originalRegions)
      }
      const native = (source: typeof before) =>
        source.units
          .flatMap((u) =>
            u.fragments.flatMap((g) => g.items.map((i) => [g.pageNumber, i.index, i.text]))
          )
          .sort((a, b) => Number(a[1]) - Number(b[1]))
      expect(native(result.source)).toEqual(native(before))
      expect(native(content)).toEqual(native(before))
      for (const source of [before, result.source, content])
        expect(
          await bindPdfTranslation(
            source,
            {
              source,
              units: [{ id: 'prose', translationSource: 'Prose', translation: 'Translation' }]
            },
            f.context.document,
            'reader',
            f.context.signal
          )
        ).not.toBeNull()
    }
  )
  it.each([
    'literal',
    'shared-cell',
    'split-owner',
    'no-later-row',
    'overlapping-row',
    'spanning-row',
    'cross-page',
    'ordinary-source',
    'non-formula',
    'mixed-first-row'
  ] as const)(
    'does not retain a leading formula through an unproved one-to-one band: %s',
    async (mode) => {
      const f = fixture(),
        table = f.cached.elements[0].table!,
        units = mutableUnits(f)
      if (mode === 'literal') units[0].source = '( 7 )'
      if (mode === 'ordinary-source') delete units[0].sourceOnly
      if (mode === 'non-formula') delete units[0].preserve
      if (mode === 'mixed-first-row') {
        f.items.push({ ...f.items[0], str: 'Label', transform: [10, 0, 0, 10, 70, 80] })
        units.push({
          id: 'ordinary-header',
          source: 'Label',
          fragments: [{ pageNumber: 1, rect: f.rect(0.7), items: [{ index: 3, text: 'Label' }] }]
        })
        table.columnCount = 2
        table.cells.push({
          row: 0,
          column: 1,
          rowSpan: 1,
          columnSpan: 1,
          text: 'Label',
          regions: [{ page: 1, ...f.rect(0.7) }],
          sourceItems: [{ pageNumber: 1, index: 3, text: 'Label' }]
        })
        f.cached.elements[0].regions[0].width = 0.8
      }
      if (mode === 'shared-cell') {
        table.cells[0].text = '(7) 10'
        table.cells[0].sourceItems!.push(...table.cells[1].sourceItems!)
        table.cells[0].regions.push(...table.cells[1].regions)
        table.cells.pop()
      }
      if (mode === 'split-owner') {
        units[0].source = '(7) 10'
        units[0].fragments.push(...units[1].fragments)
        units.splice(1, 1)
      }
      if (mode === 'no-later-row') {
        table.cells[1].row = 0
        table.cells[1].column = 1
        table.rowCount = 1
        table.columnCount = 2
      }
      if (mode === 'overlapping-row') {
        f.items[1].transform[5] = 85
        table.cells[1].regions[0].y = 0.05
        units[1].fragments[0].rect.y = 0.05
      }
      if (mode === 'spanning-row') {
        table.cells[0].rowSpan = 2
        table.cells[1].column = 1
        table.columnCount = 2
      }
      if (mode === 'cross-page') {
        f.document.numPages = 2
        f.cached.pageCount = 2
        f.cached.requestedPages.push(2)
        f.cached.processedPages.push(2)
        f.cached.pages.push({ ...f.cached.pages[0], page: 2 })
        table.cells[1].regions[0].page = 2
        table.cells[1].sourceItems![0].pageNumber = 2
        units[1].fragments[0].pageNumber = 2
        f.cached.elements[0].regions.push({ page: 2, ...f.rect(0.4, 0.3) })
      }
      f.context.extraction = {
        ...f.context.extraction,
        source: createPdfTranslationSource({
          ...f.context.extraction.source,
          units,
          ...(mode === 'cross-page'
            ? {
                pages: [f.context.extraction.source.pages[0], f.context.extraction.source.pages[0]]
              }
            : {})
        })
      }
      const result = await applyCachedPdfTableSources(f.context)
      expect(result.source.units.some((u) => u.id === 'header')).toBe(false)
      expect(
        result.source.units
          .flatMap((u) =>
            u.fragments.flatMap((g) => g.items.map((i) => [g.pageNumber, i.index, i.text]))
          )
          .sort((a, b) => Number(a[1]) - Number(b[1]))
      ).toEqual([
        [1, 0, '(7)'],
        [mode === 'cross-page' ? 2 : 1, 1, '10'],
        [1, 2, 'Prose'],
        ...(mode === 'mixed-first-row' ? [[1, 3, 'Label']] : [])
      ])
    }
  )
  it('keeps the existing whole-unit rejection when only part of the formula is claimed', async () => {
    const f = fixture(),
      units = mutableUnits(f)
    units[0].source = '(7) 10'
    units[0].fragments.push(...units[1].fragments)
    units.splice(1, 1)
    f.cached.elements[0].table!.cells.pop()
    f.context.extraction = {
      ...f.context.extraction,
      source: createPdfTranslationSource({ ...f.context.extraction.source, units })
    }
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source.units).toEqual(f.context.extraction.source.units)
    expect(result.coverage.warnings).toContainEqual({
      unitId: 'header',
      reasons: ['table-layout', 'table-structure-unreliable']
    })
  })
})

describe('unreliable mathematical source witnesses', () => {
  const fixture = () => {
    const f = setup()
    f.items[0].str = 'b'
    f.items[1].str = 'β'
    f.items.push({ ...f.items[0], str: 'Min.', transform: [10, 0, 0, 10, 70, 80] })
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: [
          {
            ...f.extraction.source.units[0],
            source: 'b β',
            fragments: [
              {
                ...f.extraction.source.units[0].fragments[0],
                items: [
                  { index: 0, text: 'b' },
                  { index: 1, text: 'β' }
                ]
              }
            ]
          },
          f.extraction.source.units[1],
          {
            id: 'label',
            source: 'Min.',
            fragments: [{ pageNumber: 1, rect: f.rect(0.7), items: [{ index: 3, text: 'Min.' }] }]
          }
        ]
      }),
      coverage: { ...f.extraction.coverage, textItemCount: 4, includedItemCount: 4 }
    }
    const table = f.cached.elements[0].table!
    table.columnCount = 1
    table.cells = [
      {
        ...table.cells[0],
        text: 'Min. βb',
        sourceItems: [
          { pageNumber: 1, index: 0, text: 'b' },
          { pageNumber: 1, index: 1, text: 'β' },
          { pageNumber: 1, index: 3, text: 'Min.' }
        ],
        regions: [...table.cells.flatMap((c) => c.regions), { page: 1, ...f.rect(0.7) }]
      }
    ]
    table.issues = [{ code: 'native-table-structure-ambiguous', detail: 'Distorted accent' }]
    f.cached.elements[0].regions[0].width = 0.8
    table.unreliableMathSourceItems = structuredClone(table.cells[0].sourceItems!.slice(0, 2))
    return f
  }
  const independent = (f: ReturnType<typeof fixture>) => {
    const element = structuredClone(f.cached.elements[0])
    element.id = 'independent'
    element.regions = [{ page: 1, ...f.rect(0.1, 0.6) }]
    element.table = {
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
          regions: structuredClone(element.regions)
        }
      ]
    }
    f.cached.elements.push(element)
    return element
  }
  it.each(['alone', 'independent', 'shared-owner', 'late-fallback'] as const)(
    'protects the complete affected owner while preserving literal, identity and independent mapping: %s',
    async (mode) => {
      const f = fixture()
      if (mode === 'independent' || mode === 'late-fallback') {
        const other = independent(f)
        if (mode === 'late-fallback') other.table!.cells[0].regions[0].x += 0.01
      }
      if (mode === 'shared-owner') {
        const shared = structuredClone(f.cached.elements[0])
        shared.id = 'shared'
        shared.table!.issues = []
        delete shared.table!.unreliableMathSourceItems
        shared.table!.cells[0].sourceItems = [{ pageNumber: 1, index: 1, text: 'β' }]
        shared.table!.cells[0].regions = [{ page: 1, ...f.rect(0.4) }]
        shared.table!.cells[0].text = 'β'
        f.cached.elements.push(shared)
      }
      const before = structuredClone(f.cached),
        source = f.context.extraction.source
      expect(() => parsePdfStructureResult(f.cached, f.cached)).not.toThrow()
      const result = await applyCachedPdfTableSources(f.context)
      expect(result.source.units.find((u) => u.id === 'group')).toEqual({
        ...source.units[0],
        sourceOnly: true
      })
      expect(result.source.units.find((u) => u.id === 'label')).toEqual(source.units[2])
      if (mode === 'independent') {
        expect(
          result.source.units.some((u) => u.id.startsWith('table-source:') && u.source === 'Prose')
        ).toBe(true)
      } else expect(result.source.units.find((u) => u.id === 'prose')).toEqual(source.units[1])
      expect(
        result.source.units.filter((u) => u.id.includes(':table-1:') || u.id.includes(':shared:'))
      ).toEqual([])
      expect(result.source.originalRegions).toBeUndefined()
      expect(result.coverage.warnings).toContainEqual({
        unitId: 'group',
        reasons: ['table-layout', 'table-structure-unreliable']
      })
      expect(f.cached).toEqual(before)
    }
  )
  it('keeps legacy ordinary conflict eligibility without an explicit mathematical witness', async () => {
    const f = fixture()
    delete f.cached.elements[0].table!.unreliableMathSourceItems
    const result = await applyCachedPdfTableSources(f.context)
    expect(result.source).toEqual(f.context.extraction.source)
  })
  it.each(['member', 'page', 'literal', 'native', 'geometry', 'whole-owner'] as const)(
    'does not protect or modify source on an invalid mathematical proof: %s',
    async (mutation) => {
      const f = fixture(),
        table = f.cached.elements[0].table!
      const origins = table.unreliableMathSourceItems!
      if (mutation === 'member') origins[0].index = 2
      if (mutation === 'page') origins[0].pageNumber = 2
      if (mutation === 'literal') origins[0].text = 'other'
      if (mutation === 'native') f.items[0].str = 'other'
      if (mutation === 'geometry') table.cells[0].regions[0].x += 0.01
      if (mutation === 'whole-owner') {
        table.cells[0].sourceItems = [origins[0]]
        table.cells[0].regions = [table.cells[0].regions[0]]
        origins.splice(1)
        f.items[1].str = 'other'
      }
      const before = structuredClone(f.cached)
      expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
      expect(f.cached).toEqual(before)
    }
  )
})

describe('independent original regions for grouped tables', () => {
  it.each(['complete', 'legacy', 'foreign-text', 'blocked-part'] as const)(
    'keeps only independently proved part crops without consuming the intervening prose: %s',
    async (mode) => {
      const f = setup()
      const top = { page: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.13 }
      const bottom = { page: 1, x: 0.1, y: 0.6, width: 0.2, height: 0.13 }
      f.items.push({ ...f.items[2], str: 'Explanation', transform: [10, 0, 0, 10, 10, 50] })
      const source = createPdfTranslationSource({
        ...f.extraction.source,
        units: [
          ...f.extraction.source.units,
          {
            id: 'between',
            source: 'Explanation',
            fragments: [
              {
                pageNumber: 1,
                rect: f.rect(0.1, 0.4),
                items: [{ index: 3, text: 'Explanation' }]
              }
            ]
          },
          ...(mode === 'foreign-text'
            ? [
                {
                  id: 'foreign',
                  source: 'Foreign',
                  fragments: [
                    {
                      pageNumber: 1,
                      rect: f.rect(0.2, 0.16),
                      items: [{ index: 4, text: 'Foreign' }]
                    }
                  ]
                }
              ]
            : [])
        ]
      })
      if (mode === 'foreign-text')
        f.items.push({ ...f.items[2], str: 'Foreign', transform: [10, 0, 0, 10, 20, 76] })
      f.context.extraction = {
        ...f.extraction,
        source,
        coverage: {
          ...f.extraction.coverage,
          textItemCount: f.items.length,
          includedItemCount: f.items.length
        }
      }
      const table = f.cached.elements[0].table!
      if (mode === 'blocked-part')
        table.issues = [{ code: 'unresolved-spanning-cells', detail: 'Unproved span' }]
      f.cached.elements[0] = {
        ...f.cached.elements[0],
        table: undefined,
        caption: {
          text: 'Table 1. Separate measurements.',
          regions: [{ page: 1, x: 0.1, y: 0.02, width: 0.5, height: 0.04 }]
        },
        regions: [{ page: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.63 }],
        tableParts: [
          { title: 'First', table, ...(mode === 'legacy' ? {} : { regions: [top] }) },
          {
            title: 'Second',
            ...(mode === 'legacy' ? {} : { regions: [bottom] }),
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
      const expected = mode === 'legacy' ? [] : mode === 'complete' ? [top, bottom] : [bottom]
      expect(result.source.originalRegions ?? []).toEqual(
        expected.map(({ page: pageNumber, ...rect }) => ({
          pageNumber,
          rect: { ...rect, width: expect.closeTo(rect.width, 12) }
        }))
      )
      expect(result.source.units.find((unit) => unit.id === 'between')).toEqual(source.units[2])
      if (mode === 'foreign-text')
        expect(result.source.units.find((unit) => unit.id === 'foreign')).toEqual(source.units[3])
      const origins = (value: typeof source) =>
        value.units
          .flatMap((unit) =>
            unit.fragments.flatMap((fragment) =>
              fragment.items.map((item) =>
                JSON.stringify([fragment.pageNumber, item.index, item.text])
              )
            )
          )
          .sort()
      const before = origins(source)
      const after = origins(result.source)
      expect(after).toEqual(before)
      expect(new Set(after).size).toBe(after.length)
      expect(
        result.source.units.filter((unit) => unit.id.startsWith('table-source:'))
      ).toHaveLength(mode === 'blocked-part' ? 1 : 3)
    }
  )
})

function setup() {
  const sourceIdentity = { sourceChecksum: 'a'.repeat(64), sourceSizeBytes: 100 }
  const item = (
    str: string,
    x: number,
    y = 80
  ): {
    str: string
    dir: string
    fontName: string
    transform: number[]
    width: number
    height: number
    hasEOL?: boolean
  } => ({
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
    getViewport: vi.fn<
      () => {
        width: number
        height: number
        transform?: number[]
        convertToViewportPoint: (x: number, y: number) => number[]
      }
    >(() => ({
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
  const readCached = vi.fn<Parameters<typeof applyCachedPdfTableSources>[0]['readCached']>(
    async () => cached
  )
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
  it('retains clipped native owners and linked tables without disabling an independent table', async () => {
    const f = setup()
    f.items[0].transform[4] = 90
    f.page.getViewport.mockReturnValue({
      width: 100,
      height: 100,
      transform: [1, 0, 0, -1, 0, 100],
      convertToViewportPoint: (x: number, y: number) => [x, 100 - y]
    })
    f.page.getTextContent.mockResolvedValue({
      items: f.items,
      styles: { f: { vertical: false, ascent: 0.8, descent: -0.2 } }
    })
    const source = createPdfTranslationSource({
      ...f.extraction.source,
      units: [
        {
          id: 'clip',
          source: 'Row',
          sourceOnly: true,
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.9, y: 0.12, width: 1 - 0.9, height: 0.12 + 0.1 - 0.12 },
              unclippedRect: { x: 0.9, y: 0.12, width: 0.2, height: 0.1 },
              items: [{ index: 0, text: 'Row' }]
            }
          ]
        },
        {
          id: 'value',
          source: '10',
          fragments: [{ pageNumber: 1, rect: f.rect(0.4), items: [{ index: 1, text: '10' }] }]
        },
        f.extraction.source.units[1]
      ]
    })
    f.context.extraction = {
      ...f.extraction,
      source,
      coverage: {
        ...f.extraction.coverage,
        warnings: [{ unitId: 'clip', reasons: ['partially-outside-page'] }]
      }
    }
    const linked = structuredClone(f.cached.elements[0])
    linked.id = 'linked'
    linked.table!.columnCount = 1
    linked.table!.cells = [{ ...linked.table!.cells[1], column: 0 }]
    const independent = structuredClone(linked)
    independent.id = 'independent'
    independent.table!.cells = [
      {
        ...independent.table!.cells[0],
        text: 'Prose',
        regions: [{ page: 1, ...f.rect(0.1, 0.6) }],
        sourceItems: [{ pageNumber: 1, index: 2, text: 'Prose' }]
      }
    ]
    f.cached.elements.push(linked, independent)
    const actual = await applyCachedPdfTableSources(f.context)
    expect(actual.source.units.find((u) => u.id === 'clip')).toEqual(source.units[0])
    expect(actual.source.units.find((u) => u.id === 'value')).toEqual(source.units[1])
    expect(actual.coverage.warnings).toContainEqual({
      unitId: 'clip',
      reasons: ['partially-outside-page', 'table-structure-unreliable']
    })
    expect(actual.coverage.warnings).toContainEqual({
      unitId: 'value',
      reasons: ['table-structure-unreliable']
    })
    expect(actual.source.units.some((u) => u.id === 'prose')).toBe(false)
    expect(actual.source.units.find((u) => u.source === 'Prose')?.sourceOnly).toBe(true)
    f.cached.elements.push({
      id: 'figure',
      kind: 'figure',
      issues: [],
      regions: [{ page: 1, x: 0.9, y: 0.1, width: 0.1, height: 0.2 }],
      sourceItems: [{ pageNumber: 1, index: 0, text: 'Row' }]
    })
    const figureApplied = await applyCachedPdfFigureSources({ ...f.context, extraction: actual })
    expect(figureApplied.source.units.find((u) => u.id === 'clip')).toEqual(source.units[0])
  })
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
      expect(result.source.units.find((u) => u.id === 'group')).toEqual({
        ...f.extraction.source.units[0],
        sourceOnly: true
      })
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
    expect(result.source.units.find((u) => u.id === 'group')).toEqual({
      ...f.extraction.source.units[0],
      sourceOnly: true
    })
    expect(result.source.units.filter((u) => u.sourceOnly).map((u) => u.source)).toEqual([
      result.source.units.find((u) => u.id === 'group')!.source,
      'Prose'
    ])
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
      ...f.context.extraction.source.units.slice(0, 2).map((u) => u.source),
      'Independent'
    ])
    expect(result.source.units.filter((u) => ['group', 'bridge'].includes(u.id))).toEqual(
      f.context.extraction.source.units
        .slice(0, 2)
        .map((u) => ({ ...u, sourceOnly: true as const }))
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
    expect(result.source.units.find((u) => u.id === 'group')).toEqual({
      ...f.context.extraction.source.units[0],
      sourceOnly: true
    })
    expect(result.source.units.filter((u) => u.sourceOnly).map((u) => u.source)).toEqual([
      result.source.units.find((u) => u.id === 'group')!.source,
      'Prose'
    ])
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
    f.page.getTextContent.mockResolvedValue({
      items: f.items,
      styles: { f: { vertical: false, ascent: 0.8, descent: -0.2 } }
    })
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
      { ...f.extraction.source.units[0], sourceOnly: true, figure: true },
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
    expect(retained.source.units).toEqual(
      rejected.extraction.source.units.map((u) =>
        u.id === 'group' ? { ...u, sourceOnly: true } : u
      )
    )
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
    'vector-missing-proof',
    'vector-partial-unit',
    'vector-wrong-literal',
    'vector-caption-overlap',
    'vector-competing-figure',
    'vector-uncertain-figure',
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
    'unsafe-figure',
    'generic-strip',
    'uncertain-group',
    'horizontal-missing-proof',
    'horizontal-partial-unit',
    'horizontal-uncertain'
  ])('keeps prose when figure ownership is not complete: %s', async (variant) => {
    const fixture = setup()
    fixture.page.getTextContent.mockResolvedValue({
      items: fixture.items,
      styles: { f: { vertical: false, ascent: 0.8, descent: -0.2 } }
    })
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
    const fault = variant.replace(/^vector-/u, '')
    if (variant.startsWith('vector-'))
      figure.issues = [{ code: 'native-vector-bar-chart', detail: 'native-vector-bar-chart' }]
    if (variant.startsWith('horizontal-')) {
      figure.issues = [
        { code: 'native-raster-horizontal-array', detail: 'native-raster-horizontal-array' }
      ]
      if (fault === 'horizontal-missing-proof') delete figure.sourceItems
      if (fault === 'horizontal-partial-unit') figure.sourceItems!.pop()
      if (fault === 'horizontal-uncertain')
        figure.issues.push({ code: 'uncertain', detail: 'Unproved' })
    }
    if (fault === 'missing-proof') delete figure.sourceItems
    if (fault === 'partial-unit') figure.sourceItems!.pop()
    if (fault === 'wrong-literal') figure.sourceItems![0].text = 'Different'
    if (fault === 'stale-source') fixture.cached.sourceChecksum = 'd'.repeat(64)
    if (fault === 'duplicate-origin') figure.sourceItems![1] = { ...figure.sourceItems![0] }
    if (fault === 'wrong-page') figure.sourceItems![0].pageNumber = 2
    if (fault === 'caption-overlap') figure.caption!.regions = structuredClone(figure.regions)
    if (fault === 'competing-figure')
      fixture.cached.elements.push({
        id: 'figure-2',
        kind: 'figure',
        issues: [],
        regions: structuredClone(figure.regions)
      })
    if (fault === 'outside-native-ink') fixture.items[0].transform[5] = 20
    if (fault === 'outside-unit') figure.regions[0].height = 0.12
    if (fault === 'missing-caption') delete figure.caption
    if (fault === 'uncertain-figure') figure.issues.push({ code: 'uncertain', detail: 'Unproved' })
    if (fault === 'unsafe-figure')
      figure.issues.push({ code: 'text-dominant-graphics', detail: 'text-dominant-graphics' })
    if (fault === 'generic-strip')
      figure.issues = [{ code: 'native-raster-vector-strip', detail: 'native-raster-vector-strip' }]
    if (fault === 'uncertain-group')
      figure.issues = [
        { code: 'native-disjoint-mixed-group', detail: 'native-disjoint-mixed-group' },
        { code: 'uncertain', detail: 'Unproved' }
      ]
    expect(await applyCachedPdfFigureSources(fixture.context)).toBe(fixture.extraction)
    expect(fixture.extraction.source.units[0].sourceOnly).toBeUndefined()
  })

  it.each([
    'stable',
    'early replacement',
    'late replacement',
    'late in-place fingerprint',
    'key-stage replacement'
  ] as const)(
    'publishes figure ownership only while the source remains current: %s',
    async (mode) => {
      const f = setup()
      f.context.extraction = {
        ...f.extraction,
        source: createPdfTranslationSource({
          ...f.extraction.source,
          units: f.extraction.source.units.map((unit) =>
            unit.id === 'prose'
              ? { ...unit, sourceOnly: true as const, preserve: 'formula' as const }
              : unit
          )
        })
      }
      f.page.getTextContent.mockResolvedValue({
        items: f.items,
        styles: { f: { vertical: false, ascent: 0.8, descent: -0.2 } }
      })
      f.cached.elements = [
        {
          id: 'figure',
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
        },
        {
          id: 'math',
          kind: 'table',
          issues: [{ code: 'no-source-cell-grid', detail: 'no-source-cell-grid' }],
          regions: [{ page: 1, x: 0.05, y: 0.6, width: 0.7, height: 0.3 }],
          caption: {
            text: 'Table 1. Expressions.',
            regions: [{ page: 1, x: 0.05, y: 0.92, width: 0.7, height: 0.05 }]
          },
          nativeBody: {
            kind: 'math-table',
            sourceItems: [{ pageNumber: 1, index: 2, text: 'Prose' }]
          }
        }
      ]
      const fingerprints = f.document.fingerprints,
        originalFingerprint = fingerprints[0],
        originalExtraction = structuredClone(f.context.extraction)
      let pageReads = 0,
        changedAtRead: number | undefined
      f.document.getPage.mockImplementation(async () => {
        pageReads++
        if (mode === 'early replacement' && pageReads === 1) {
          changedAtRead = pageReads
          f.document.fingerprints = ['replacement']
        }
        if (mode === 'late replacement' && pageReads === 2) {
          changedAtRead = pageReads
          f.document.fingerprints = ['replacement']
        }
        if (mode === 'late in-place fingerprint' && pageReads === 2) {
          changedAtRead = pageReads
          fingerprints[0] = 'replacement'
        }
        if (mode === 'key-stage replacement' && pageReads === 4) {
          changedAtRead = pageReads
          f.document.fingerprints = ['replacement']
        }
        return f.page
      })
      const result = await applyCachedPdfFigureSources(f.context)
      if (mode === 'stable') expect(result.source.units[0].sourceOnly).toBe(true)
      else {
        expect(result).toBe(f.context.extraction)
        expect(result.source.units[0].sourceOnly).toBeUndefined()
        expect(result.coverage).toBe(f.context.extraction.coverage)
      }
      // After the figure and original whole-region checks, an independent
      // captioned-math proof reads this page once more. A stable source then
      // reaches the detached-key candidate read. Neither stage may publish
      // earlier figure ownership after a source-failure injection.
      expect(pageReads).toBe(
        mode === 'early replacement'
          ? 1
          : mode === 'stable' || mode === 'key-stage replacement'
            ? 4
            : 3
      )
      expect(changedAtRead).toBe(
        mode === 'stable'
          ? undefined
          : mode === 'early replacement'
            ? 1
            : mode === 'key-stage replacement'
              ? 4
              : 2
      )
      expect(f.document.getPage.mock.calls).toEqual(Array.from({ length: pageReads }, () => [1]))
      if (mode === 'stable' || mode === 'late in-place fingerprint') {
        expect(f.document.fingerprints).toBe(fingerprints)
        expect(fingerprints).toEqual([mode === 'stable' ? originalFingerprint : 'replacement'])
      } else {
        expect(f.document.fingerprints).not.toBe(fingerprints)
        expect(f.document.fingerprints).toEqual(['replacement'])
        expect(fingerprints).toEqual([originalFingerprint])
      }
      if (mode === 'stable')
        expect(result.coverage).toEqual({
          ...originalExtraction.coverage,
          warnings: [
            ...originalExtraction.coverage.warnings,
            { unitId: 'prose', reasons: ['table-structure-unreliable'] }
          ]
        })
      expect(result.source.fingerprint).toBe(originalExtraction.source.fingerprint)
      expect(result.source.units[1]).toEqual(originalExtraction.source.units[1])
      expect(structuredClone(f.context.extraction)).toEqual(originalExtraction)
      expect(result.source.units.map((unit) => unit.source)).toEqual(['Row 10', 'Prose'])
    }
  )

  it('propagates cancellation and retains source when a figure cache read fails', async () => {
    const fixture = setup()
    fixture.readCached.mockRejectedValueOnce(new Error('Unavailable cache'))
    expect(await applyCachedPdfFigureSources(fixture.context)).toBe(fixture.extraction)
    fixture.controller.abort()
    await expect(applyCachedPdfFigureSources(fixture.context)).rejects.toThrow()
  })

  it.each([
    '',
    'native-raster-composite-grid',
    'native-vector-bar-chart',
    'native-disjoint-mixed-group',
    'native-raster-horizontal-array',
    'native-raster-side-by-side',
    'native-raster-quad'
  ])(
    'retains proved figure text with informational recovery %s while keeping prose and captions eligible',
    async (informational) => {
      const fixture = setup()
      fixture.page.getTextContent.mockResolvedValue({
        items: fixture.items,
        styles: { f: { vertical: false, ascent: 1.2, descent: -1.2 } }
      })
      fixture.cached.elements = [
        {
          id: 'figure-1',
          kind: 'figure',
          issues: informational ? [{ code: informational, detail: informational }] : [],
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
        { ...fixture.extraction.source.units[0], sourceOnly: true, figure: true },
        fixture.extraction.source.units[1]
      ])
      expect(result.coverage).toEqual(fixture.extraction.coverage)
      expect(fixture.extraction.source.units[0].sourceOnly).toBeUndefined()
      expect(fixture.document.destroy).not.toHaveBeenCalled()
      expect(fixture.page.cleanup).not.toHaveBeenCalled()
    }
  )

  it.each(['missing', 'nonfinite', 'zero-ascent', 'positive-descent'] as const)(
    'does not substitute guessed figure font metrics when native metrics are %s',
    async (fault) => {
      for (const mechanism of [
        'native-raster-composite-grid',
        'native-vector-bar-chart',
        'native-disjoint-mixed-group',
        'native-raster-horizontal-array',
        'native-raster-side-by-side',
        'native-raster-quad'
      ]) {
        const f = setup()
        f.cached.elements = [
          {
            id: 'figure',
            kind: 'figure',
            issues: [{ code: mechanism, detail: mechanism }],
            regions: [{ page: 1, x: 0.05, y: 0.05, width: 0.7, height: 0.3 }],
            caption: {
              text: 'Figure 1. Complete measurements.',
              regions: [{ page: 1, x: 0.05, y: 0.4, width: 0.7, height: 0.1 }]
            },
            sourceItems: [
              { pageNumber: 1, index: 0, text: 'Row' },
              { pageNumber: 1, index: 1, text: '10' }
            ]
          }
        ]
        const metrics = { vertical: false, ascent: 0.8, descent: -0.2 }
        if (fault === 'nonfinite') metrics.ascent = Number.NaN
        if (fault === 'zero-ascent') metrics.ascent = 0
        if (fault === 'positive-descent') metrics.descent = 0.2
        f.page.getTextContent.mockResolvedValue({
          items: f.items,
          styles: fault === 'missing' ? {} : { f: metrics }
        })
        expect(await applyCachedPdfFigureSources(f.context)).toBe(f.extraction)
      }
    }
  )

  it.each(['success', 'operator-error', 'page-error', 'abort-page', 'abort-operators'] as const)(
    'releases graphic detection page caches after %s',
    async (outcome) => {
      const f = setup()
      const page = {
        ...f.page,
        getOperatorList: vi.fn(async () => {
          expect(f.page.cleanup).not.toHaveBeenCalled()
          if (outcome === 'operator-error') throw new Error('Invalid graphics')
          if (outcome === 'abort-operators') f.controller.abort()
          return { fnArray: [], argsArray: [] }
        })
      }
      const getPage = vi.fn(async () => {
        if (outcome === 'page-error') throw new Error('Page unavailable')
        if (outcome === 'abort-page') f.controller.abort()
        return page
      })
      const result = preservePdfFigureSources({
        extraction: f.extraction,
        document: { ...f.document, getPage } as unknown as PDFDocumentProxy,
        operators: OPS,
        signal: f.controller.signal
      })
      if (outcome.startsWith('abort'))
        await expect(result).rejects.toMatchObject({ name: 'AbortError' })
      else await expect(result).resolves.toBe(f.extraction)
      expect(f.page.cleanup).toHaveBeenCalledTimes(outcome === 'page-error' ? 0 : 1)
      expect(page.getOperatorList).toHaveBeenCalledTimes(
        outcome === 'page-error' || outcome === 'abort-page' ? 0 : 1
      )
      expect(f.document.destroy).not.toHaveBeenCalled()
    }
  )

  it('requests cleanup before scanning the next page even when a shared render defers it', async () => {
    const f = setup()
    const pages = [false, true].map((cleaned) => ({
      ...f.page,
      getOperatorList: vi.fn(async () => ({ fnArray: [], argsArray: [] })),
      cleanup: vi.fn(() => cleaned)
    }))
    const extraction = {
      source: createPdfTranslationSource({
        ...f.extraction.source,
        pages: [...f.extraction.source.pages, ...f.extraction.source.pages],
        units: [
          ...f.extraction.source.units,
          ...f.extraction.source.units.map((unit) => ({
            ...unit,
            id: `${unit.id}-page-2`,
            fragments: unit.fragments.map((fragment) => ({ ...fragment, pageNumber: 2 }))
          }))
        ]
      })
    }
    const getPage = vi.fn(async (number: number) => {
      if (number === 2) expect(pages[0].cleanup).toHaveBeenCalledOnce()
      return pages[number - 1]
    })
    await expect(
      preservePdfFigureSources({
        extraction,
        document: { ...f.document, getPage } as unknown as PDFDocumentProxy,
        operators: OPS,
        signal: f.controller.signal
      })
    ).resolves.toBe(extraction)
    expect(getPage.mock.calls).toEqual([[1], [2]])
    for (const page of pages) {
      expect(page.getOperatorList).toHaveBeenCalledOnce()
      expect(page.cleanup).toHaveBeenCalledOnce()
    }
    expect(f.document.destroy).not.toHaveBeenCalled()
  })

  it('keeps cached ownership when graphic regions are added before choosing content-first', async () => {
    const f = setup()
    f.page.getTextContent.mockResolvedValue({
      items: f.items,
      styles: { f: { vertical: false, ascent: 0.8, descent: -0.2 } }
    })
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
    const verified = await applyCachedPdfFigureSources(f.context)
    const page = {
      ...f.page,
      getViewport: () => ({ width: 100, height: 100, transform: [1, 0, 0, 1, 0, 0] }),
      getOperatorList: async () => ({
        fnArray: [OPS.transform, OPS.paintImageXObject],
        argsArray: [[20, 0, 0, 10, 10, 60], ['image']]
      })
    }
    const prepared = await preservePdfFigureSources({
      extraction: verified,
      document: { getPage: async () => page } as unknown as PDFDocumentProxy,
      operators: OPS,
      signal: f.controller.signal,
      skipTranslation: false
    })
    expect(prepared.source.units[0].sourceOnly).toBe(true)
    expect(prepared.source.units[1].figure).toBe(true)
    expect(prepared.source.units[1].sourceOnly).toBeUndefined()
    expect(prepared.source.originalRegions).toEqual([
      {
        pageNumber: 1,
        rect: { x: 0.05, y: 0.05, width: 0.7, height: 0.3 }
      },
      {
        pageNumber: 1,
        rect: {
          x: 0.1,
          y: 0.6,
          width: expect.closeTo(0.2),
          height: expect.closeTo(0.1)
        }
      }
    ])
    const contentFirst = applyPdfContentFirstPolicy(prepared.source)
    expect(contentFirst.units[1].sourceOnly).toBe(true)
    expect(contentFirst.units.map((unit) => unit.id)).toEqual(
      f.extraction.source.units.map((unit) => unit.id)
    )
    expect(prepared.coverage).toEqual(f.extraction.coverage)
    expect(f.extraction.source.units[0].sourceOnly).toBeUndefined()
  })

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
      expect(result.source.units).toEqual(
        f.context.extraction.source.units.map((u) =>
          u.id === 'group' ? { ...u, sourceOnly: true } : u
        )
      )
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
    expect(result.source.units).toEqual(
      f.context.extraction.source.units.map((u) =>
        u.id === 'native-glyphs' ? { ...u, sourceOnly: true } : u
      )
    )
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
        sourceOnly: true as const,
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

function sourceFreePageSetup() {
  const f = setup()
  const second = structuredClone(f.cached)
  second.extractionId = 'cached-2'
  second.requestedPages = [2]
  second.processedPages = [2]
  second.pages[0].page = 2
  second.elements[0].regions[0].page = 2
  for (const cell of second.elements[0].table!.cells) {
    cell.regions[0].page = 2
    delete cell.sourceItems
  }
  f.cached.pageCount = second.pageCount = f.document.numPages = 2
  f.context.extraction = {
    ...f.extraction,
    source: createPdfTranslationSource({
      ...f.extraction.source,
      pages: [
        { width: 100, height: 100 },
        { width: 100, height: 100 }
      ],
      units: [
        ...f.extraction.source.units,
        ...f.extraction.source.units.map((unit) => ({
          ...unit,
          id: `second-${unit.id}`,
          fragments: unit.fragments.map((fragment) => ({ ...fragment, pageNumber: 2 }))
        }))
      ]
    }),
    coverage: {
      ...f.extraction.coverage,
      pageCount: 2,
      textItemCount: 6,
      includedItemCount: 6
    }
  }
  f.readCached.mockImplementation(async ({ page }: { page: number }) =>
    page === 1 ? f.cached : second
  )
  return { ...f, second }
}

describe('source-free worker page isolation', () => {
  it('does not turn overlapping read-only context into shared table ownership', async () => {
    const f = sourceFreePageSetup()
    f.cached.auxiliaryPages = [2]
    f.cached.pages.push({ page: 2, width: 100, height: 100, rotation: 0 })
    f.second.auxiliaryPages = [1]
    f.second.pages.unshift({ page: 1, width: 100, height: 100, rotation: 0 })
    const result = await applyCachedPdfTableSources(f.context)
    expect(
      result.source.units
        .filter((unit) => unit.id.startsWith('table-source:'))
        .map((unit) => unit.source)
    ).toEqual(['Row', '10'])
    expect(result.source.units.filter((unit) => unit.id.startsWith('second-'))).toEqual(
      f.context.extraction.source.units.filter((unit) => unit.id.startsWith('second-'))
    )
  })

  it('retains a complete overlapping worker batch when one of its pages is source-free', async () => {
    const f = sourceFreePageSetup()
    f.cached.requestedPages = [1, 2]
    f.cached.processedPages = [1, 2]
    f.cached.pages.push({ page: 2, width: 100, height: 100, rotation: 0 })
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })

  it('retains a source-free page while applying an independently verified table on another page', async () => {
    const f = sourceFreePageSetup()
    const result = await applyCachedPdfTableSources(f.context)
    expect(
      result.source.units
        .filter((unit) => unit.id.startsWith('table-source:'))
        .map((unit) => unit.source)
    ).toEqual(['Row', '10'])
    expect(result.source.units.filter((unit) => unit.id.startsWith('second-'))).toEqual(
      f.context.extraction.source.units.filter((unit) => unit.id.startsWith('second-'))
    )
    expect({ ...result.coverage, warnings: [] }).toEqual({
      ...f.context.extraction.coverage,
      warnings: []
    })
    expect(result.coverage.warnings).toEqual(
      result.source.units
        .filter((unit) => unit.id.startsWith('table-source:'))
        .map((unit) => ({ unitId: unit.id, reasons: ['table-layout'] }))
    )
  })

  it('retains all pages connected by one original unit', async () => {
    const f = sourceFreePageSetup()
    const units = f.context.extraction.source.units
    f.context.extraction = {
      ...f.context.extraction,
      source: createPdfTranslationSource({
        ...f.context.extraction.source,
        units: [
          {
            ...units[0],
            source: 'Row 10 Row 10',
            fragments: [...units[0].fragments, ...units[2].fragments]
          },
          units[1],
          units[3]
        ]
      })
    }
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })

  it('still rejects a false native claim on the independent page', async () => {
    const f = sourceFreePageSetup()
    f.cached.elements[0].table!.cells[0].sourceItems![0].text = 'Foreign'
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })

  it('keeps the transactional refusal for a partially missing proof', async () => {
    const f = sourceFreePageSetup()
    f.second.elements[0].table!.cells[0].sourceItems = [{ pageNumber: 2, index: 0, text: 'Row' }]
    expect(await applyCachedPdfTableSources(f.context)).toBe(f.context.extraction)
  })
})

function canonicalAccentSetup(kind: string) {
  const f = setup(),
    canonical = kind === 'native-order' ? '˜A' : 'A˜'
  Object.assign(f.items[0], {
    str: '˜',
    width: 10,
    transform: [10, 0, 0, 10, 15, kind === 'baseline-mark' ? 80 : 83]
  })
  Object.assign(f.items[1], { str: 'A', width: 20, transform: [10, 0, 0, 10, 10, 80] })
  f.page.getTextContent.mockResolvedValue({
    items: f.items,
    styles: { f: { ascent: 0.8, descent: -0.2, vertical: false } }
  })
  const origins = [
    { pageNumber: 1, index: 0, text: '˜' },
    { pageNumber: 1, index: 1, text: 'A' }
  ]
  f.context.extraction = {
    ...f.extraction,
    source: createPdfTranslationSource({
      ...f.extraction.source,
      units: [
        {
          ...f.extraction.source.units[0],
          source: canonical,
          ...(kind !== 'ordinary' ? { sourceOnly: true } : {}),
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.07, width: 0.2, height: 0.13 },
              items: origins.map(({ index, text }) => ({ index, text }))
            }
          ]
        },
        f.extraction.source.units[1]
      ]
    })
  }
  const element = f.cached.elements[0],
    table = element.table!
  element.regions = [{ page: 1, x: 0.1, y: 0.07, width: 0.2, height: 0.13 }]
  table.columnCount = 1
  table.cells = [
    {
      ...table.cells[0],
      text: canonical,
      sourceItems: origins,
      regions: [
        { page: 1, x: 0.15, y: kind === 'baseline-mark' ? 0.1 : 0.07, width: 0.1, height: 0.1 },
        { page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.1 }
      ]
    }
  ]
  return f
}
it.each(['canonical', 'ordinary', 'native-order', 'baseline-mark'])(
  'preserves only a completely witnessed canonical accent order: %s',
  async (kind) => {
    const f = canonicalAccentSetup(kind),
      before = structuredClone(f.cached),
      result = await applyCachedPdfTableSources(f.context)
    if (kind === 'canonical') {
      expect(result.source.units).toEqual(f.context.extraction.source.units)
      expect(result.coverage.warnings).toContainEqual({
        unitId: 'group',
        reasons: ['table-layout', 'table-structure-unreliable']
      })
    } else {
      expect(
        result.source.units.filter((u) => u.id.startsWith('table-source:')).map((u) => u.source)
      ).toEqual(['˜ A'])
      expect(result.coverage.warnings.flatMap((w) => w.reasons)).not.toContain(
        'table-structure-unreliable'
      )
    }
    expect(f.cached).toEqual(before)
  }
)

it.each(['complete', 'detached', 'wide-mark', 'other-order-change'])(
  'retains an agreed mathematical accent owner with a bounded native overhang: %s',
  async (kind) => {
    const f = canonicalAccentSetup('canonical'),
      cell = f.cached.elements[0].table!.cells[0]
    Object.assign(f.items[0], {
      width: kind === 'wide-mark' ? 24 : 10,
      transform: [10, 0, 0, 10, kind === 'detached' ? 34 : 24, 83]
    })
    cell.regions[0] = {
      page: 1,
      x: kind === 'detached' ? 0.34 : 0.24,
      y: 0.07,
      width: kind === 'wide-mark' ? 0.24 : 0.1,
      height: 0.1
    }
    f.cached.elements[0].regions[0].width = 0.48
    if (kind === 'other-order-change') {
      const units = f.context.extraction.source.units
      f.context.extraction = {
        ...f.context.extraction,
        source: createPdfTranslationSource({
          ...f.context.extraction.source,
          units: [{ ...units[0], source: 'A˜B' }, units[1]]
        })
      }
      cell.text = 'A˜B'
    }
    const cachedBefore = structuredClone(f.cached),
      result = await applyCachedPdfTableSources(f.context)
    if (kind === 'complete') {
      expect(result.source.units).toEqual(f.context.extraction.source.units)
      expect(result.coverage.warnings).toContainEqual({
        unitId: 'group',
        reasons: ['table-layout', 'table-structure-unreliable']
      })
    } else {
      expect(result.source.units.find((u) => u.id.startsWith('table-source:'))?.source).toBe('˜ A')
      expect(result.coverage.warnings.flatMap((w) => w.reasons)).not.toContain(
        'table-structure-unreliable'
      )
    }
    expect(f.cached).toEqual(cachedBefore)
    expect({ ...result.coverage, warnings: [] }).toEqual({
      ...f.context.extraction.coverage,
      warnings: []
    })
  }
)

function scientificOwnerSetup(kind: string) {
  const f = setup()
  const values = ['1', '.', '5', '×', '10', '−', '2']
  const positions = [10, 14, 16, 23, 32, 40, 44]
  const widths = [4, 2, 4, 6, 8, 4, 3]
  f.items.splice(
    0,
    f.items.length,
    ...values.map((str, index) => ({
      str,
      dir: 'ltr',
      fontName: 'f',
      transform: [
        index < 5 ? 10 : 6,
        0,
        0,
        index < 5 ? 10 : 6,
        positions[index],
        index < 5 || kind === 'flat-native' ? 80 : 84
      ],
      width: widths[index],
      height: index < 5 ? 10 : 6,
      hasEOL: index === 6
    })),
    {
      str: 'Prose',
      dir: 'ltr',
      fontName: 'f',
      transform: [10, 0, 0, 10, 10, 30],
      width: 20,
      height: 10,
      hasEOL: true
    }
  )
  f.page.getTextContent.mockResolvedValue({
    items: f.items,
    styles: { f: { ascent: 0.8, descent: -0.2, vertical: false } }
  })
  const claims = values.map((text, index) => ({ pageNumber: 1, index, text }))
  f.context.extraction = {
    ...f.extraction,
    source: createPdfTranslationSource({
      ...f.extraction.source,
      units: [
        {
          id: 'scientific',
          source: '1.5 × 10⁻²' + (kind === 'partial-owner' ? ' Prose' : ''),
          ...(kind !== 'ordinary-owner' ? { sourceOnly: true } : {}),
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.1, width: 0.37, height: kind === 'partial-owner' ? 0.6 : 0.1 },
              items: (kind === 'partial-owner'
                ? [...claims, { pageNumber: 1, index: 7, text: 'Prose' }]
                : claims
              ).map(({ index, text }) => ({ index, text }))
            }
          ]
        },
        ...(kind === 'partial-owner'
          ? []
          : [
              {
                ...f.extraction.source.units[1],
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 0.1, y: 0.6, width: 0.2, height: 0.1 },
                    items: [{ index: 7, text: 'Prose' }]
                  }
                ]
              }
            ])
      ]
    }),
    coverage: {
      ...f.extraction.coverage,
      textItemCount: 8,
      includedItemCount: 8,
      warnings: [{ unitId: 'scientific', reasons: ['table-layout'] }]
    }
  }
  const element = f.cached.elements[0]
  element.regions = [{ page: 1, x: 0.1, y: 0.09, width: 0.37, height: 0.12 }]
  element.table!.columnCount = 1
  element.table!.issues = []
  element.table!.cells = [
    {
      row: 0,
      column: 0,
      rowSpan: 1,
      columnSpan: 1,
      text: '1.5 × 10−' + (kind === 'wrong-script' ? '3' : '2'),
      ...(kind === 'missing-runs'
        ? {}
        : {
            textRuns: [
              { text: '1.5 × 10', position: 'normal' as const },
              {
                text: '−' + (kind === 'wrong-script' ? '3' : '2'),
                position: 'superscript' as const
              }
            ]
          }),
      sourceItems: claims,
      regions: values.map((_, i) => ({
        page: 1,
        x: positions[i] / 100,
        y: 1 - (f.items[i].transform[5] + f.items[i].height) / 100,
        width: widths[i] / 100,
        height: f.items[i].height / 100
      }))
    }
  ]
  return f
}

it.each([
  'complete',
  'missing-runs',
  'flat-native',
  'wrong-script',
  'partial-owner',
  'ordinary-owner'
])(
  'preserves a canonical scientific owner only with complete native script evidence: %s',
  async (kind) => {
    const f = scientificOwnerSetup(kind),
      before = structuredClone(f.cached)
    const result = await applyCachedPdfTableSources(f.context)
    if (kind === 'complete') {
      expect(result.source.units.find((u) => u.id.startsWith('table-source:'))?.source).toBe(
        '1.5 × 10⁻²'
      )
      expect(result.source.units.find((u) => u.id === 'prose')).toEqual(
        f.context.extraction.source.units[1]
      )
    } else {
      expect(result.source.units).toEqual(
        f.context.extraction.source.units.map((u) =>
          u.id === 'scientific' ? { ...u, sourceOnly: true } : u
        )
      )
      expect(result.source.units.some((u) => u.id.startsWith('table-source:'))).toBe(false)
      expect(
        result.coverage.warnings.some((w) => w.reasons.includes('table-structure-unreliable'))
      ).toBe(true)
    }
    expect(f.cached).toEqual(before)
    expect({ ...result.coverage, warnings: [] }).toEqual({
      ...f.context.extraction.coverage,
      warnings: []
    })
  }
)

it.each([
  'split-base',
  'many-normal',
  'mixed-format',
  'wrong-order',
  'missing-native',
  'split-script'
])('preserves scientific spelling across equivalent normal run packets: %s', async (kind) => {
  const f = scientificOwnerSetup('complete'),
    cell = f.cached.elements[0].table!.cells[0]
  cell.textRuns = [
    ...(kind === 'many-normal' ? ['1', '.', '5', ' ×', ' 10'] : ['1.5', ' ×', ' 10']).map(
      (text) => ({ text, position: 'normal' as const })
    ),
    { text: '−2', position: 'superscript' }
  ]
  if (kind === 'mixed-format') cell.textRuns[1].position = 'subscript'
  if (kind === 'wrong-order')
    [cell.textRuns[0], cell.textRuns[1]] = [cell.textRuns[1], cell.textRuns[0]]
  if (kind === 'missing-native') Object.assign(f.items[4], { fontName: '' })
  if (kind === 'split-script')
    cell.textRuns.splice(
      -1,
      1,
      { text: '−', position: 'superscript' },
      { text: '2', position: 'superscript' }
    )
  const before = structuredClone(f.cached),
    result = await applyCachedPdfTableSources(f.context),
    mapped = result.source.units.find((u) => u.id.startsWith('table-source:'))
  if (kind === 'split-base' || kind === 'many-normal') expect(mapped?.source).toBe('1.5 × 10⁻²')
  else expect(mapped?.source).not.toBe('1.5 × 10⁻²')
  expect(f.cached).toEqual(before)
  expect({ ...result.coverage, warnings: [] }).toEqual({
    ...f.context.extraction.coverage,
    warnings: []
  })
})

async function nativeCanonicalTable(kind: string) {
  const require = createRequire(import.meta.url),
    assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/',
    pdf = await PDFDocument.create()
  pdf.registerFontkit(require('fontkit') as Parameters<PDFDocument['registerFontkit']>[0])
  const regular = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf')),
    italic = await pdf.embedFont(await readFile(assets + 'LiberationSans-Italic.ttf')),
    page = pdf.addPage([400, 240])
  const draw = (text: string, x: number, y: number, size = 12, font = regular) => {
    page.drawText(text, { font, size, x, y })
    return x + font.widthOfTextAtSize(text, size)
  }
  const power = (label: string, y: number, value = '−3') => {
    let x = draw(label, 40, y)
    x = draw('10', x, y, 12, italic)
    const end = draw(value, x + 0.01, y + 4.5, 8)
    draw(')', end + 0.01, y)
  }
  if (kind === 'whole-scientific') {
    let x = draw('1.5 ', 40, 175)
    x = draw('× ', x, 175, 12, italic)
    x = draw('10', x, 175)
    draw('−2', x + 0.01, 179.5, 8)
    page.drawRectangle({ x: 35, y: 160, width: 200, height: 40, borderWidth: 0.5 })
    draw('Figure 1. Native measurements are retained in this independent specimen.', 35, 130, 8)
  } else if (kind === 'no-canonical') {
    const x = draw('Area R', 40, 175)
    draw('64', x + 0.01, 179.5, 8)
  } else if (kind === 'shared' || kind === 'maximal-run') {
    draw(kind === 'shared' ? 'First (10⁻³)' : 'First (10⁻³⁴)', 40, 175)
    draw('An independent ordinary paragraph separates the two original records.', 40, 135)
    power('Second (', 95)
  } else {
    power('Scale (', 175)
  }
  draw('Ordinary surrounding prose stays independent.', 40, 35)
  const bytes = await pdf.save(),
    sourceIdentity = {
      sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
      sourceSizeBytes: bytes.length
    },
    loading = getDocument({
      data: bytes,
      fontExtraProperties: true,
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets
    })
  try {
    const document = await loading.promise,
      original = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'generated-canonical-conservation',
        signal: new AbortController().signal,
        sourceIdentity
      }),
      extraction =
        kind === 'whole-scientific'
          ? await preservePdfFigureSources({
              document,
              extraction: original,
              operators: OPS,
              signal: new AbortController().signal
            })
          : original,
      nativePage = await document.getPage(1),
      content = await nativePage.getTextContent()
    const selected = extraction.source.units.filter(
      (u) =>
        u.fragments.some((f) => f.rect.y < 0.7) &&
        !u.source.includes('independent ordinary paragraph') &&
        !/^Figure 1\./u.test(u.source)
    )
    const origins = selected.flatMap((u) =>
      u.fragments.flatMap((f) => f.items.map((i) => ({ pageNumber: f.pageNumber, ...i })))
    )
    origins.sort((a, b) => a.index - b.index)
    const regions = origins.map(({ index }) => {
      const item = content.items[index]
      if (!('str' in item)) throw new Error('Missing real native text')
      return {
        page: 1,
        x: item.transform[4] / 400,
        y: (240 - item.transform[5] - item.height) / 240,
        width: item.width / 400,
        height: item.height / 240
      }
    })
    const text = origins.map((i) => i.text).join(' '),
      runs =
        kind === 'whole-scientific'
          ? [
              { text: '1.5 × 10', position: 'normal' as const },
              { text: '−2', position: 'superscript' as const }
            ]
          : kind === 'no-canonical'
            ? [
                { text: 'Area R', position: 'normal' as const },
                { text: '64', position: 'superscript' as const }
              ]
            : undefined,
      x = Math.min(...regions.map((r) => r.x)),
      y = Math.min(...regions.map((r) => r.y)),
      cached: PdfStructureResult = {
        schemaVersion: 1,
        extractionId: 'generated-native',
        engineFingerprint: 'b'.repeat(64),
        ...sourceIdentity,
        pageCount: 1,
        requestedPages: [1],
        processedPages: [1],
        pages: [{ page: 1, width: 400, height: 240, rotation: 0 }],
        elements: [
          {
            id: 'native-table',
            kind: 'table',
            regions: [
              {
                page: 1,
                x,
                y,
                width: Math.max(...regions.map((r) => r.x + r.width)) - x,
                height: Math.max(...regions.map((r) => r.y + r.height)) - y
              }
            ],
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
                  text,
                  ...(runs ? { textRuns: runs } : {}),
                  sourceItems: origins,
                  regions
                }
              ]
            }
          }
        ],
        thumbnails: [],
        navigation: [],
        issues: []
      }
    if (runs) cached.elements[0].table!.cells[0].text = runs.map((r) => r.text).join('')
    return {
      document,
      extraction,
      selected,
      cached,
      sourceIdentity,
      destroy: () => loading.destroy()
    }
  } catch (error) {
    await loading.destroy()
    throw error
  }
}

it.each(['compound', 'shared', 'maximal-run', 'whole-scientific', 'no-canonical'])(
  'conserves canonical scripts from real native Source parents transactionally: %s',
  async (kind) => {
    const f = await nativeCanonicalTable(kind)
    try {
      const before = JSON.parse(JSON.stringify(f.extraction.source)),
        input = structuredClone(f.cached),
        result = await applyCachedPdfTableSources({
          extraction: f.extraction,
          document: f.document,
          sourceId: 'generated-canonical-conservation',
          sourceIdentity: f.sourceIdentity,
          signal: new AbortController().signal,
          readCached: async () => f.cached
        }),
        mapped = result.source.units.filter((u) => u.id.startsWith('table-source:'))
      if (kind === 'whole-scientific') {
        expect(f.selected).toHaveLength(1)
        expect(f.selected[0].sourceOnly, JSON.stringify(f.selected)).toBe(true)
        expect(f.selected[0].source).toContain('⁻²')
        expect(mapped).toHaveLength(1)
        expect(mapped[0].source).toBe(f.selected[0].source)
      } else if (kind === 'no-canonical') {
        expect(f.selected.every((u) => !/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀₁₂₃₄₅₆₇₈₉]/u.test(u.source))).toBe(true)
        expect(mapped).toHaveLength(1)
      } else {
        if (kind === 'shared' || kind === 'maximal-run') {
          expect(f.selected).toHaveLength(2)
          expect(f.selected.every((u) => u.source.includes('⁻³'))).toBe(true)
        } else expect(f.selected.some((u) => u.source.includes('⁻³'))).toBe(true)
        expect(mapped).toHaveLength(0)
        expect(result.source.units).toEqual(f.extraction.source.units)
        expect(
          result.coverage.warnings.some((w) => w.reasons.includes('table-structure-unreliable'))
        ).toBe(true)
      }
      expect(JSON.parse(JSON.stringify(f.extraction.source))).toEqual(before)
      expect(f.cached).toEqual(input)
      expect({ ...result.coverage, warnings: [] }).toEqual({
        ...f.extraction.coverage,
        warnings: []
      })
    } finally {
      await f.destroy()
    }
  }
)

describe('original-only incomplete native owners', () => {
  it.each([false, true])(
    'protects the complete native owner without a crop, saved: %s',
    async (saved) => {
      const f = setup()
      f.cached.elements[0].table!.cells.pop()
      f.cached.elements[0].table!.columnCount = 1
      const before = JSON.stringify(f.extraction)
      const out = await applyCachedPdfStructureSources({
        ...f.context,
        preserveUnitIdentity: saved
      })
      expect(out.extraction.source.units.find((u) => u.id === 'group')).toEqual({
        ...f.extraction.source.units[0],
        sourceOnly: true
      })
      expect(out.extraction.source.units.find((u) => u.id === 'prose')).toEqual(
        f.extraction.source.units[1]
      )
      expect(out.retainedUnitIds).toEqual(['group'])
      expect(out.retainedSourcePageNumbers).toEqual([1])
      expect(out.extraction.source.originalRegions ?? []).toEqual([])
      expect(
        out.extraction.source.units
          .flatMap((u) => u.fragments.flatMap((f) => f.items.map((i) => i.index)))
          .sort()
      ).toEqual([0, 1, 2])
      expect(JSON.stringify(f.extraction)).toBe(before)
    }
  )
})

function blockedCaptionedRecordTable() {
  const f = setup(),
    labels = ['Record', 'Models', 'One', 'First model', 'Two', 'Second model'],
    native = labels.map((str, index) => ({
      ...f.items[0],
      str,
      transform: [10, 0, 0, 10, index % 2 ? 40 : 10, 80 - Math.floor(index / 2) * 20]
    }))
  native.push({
    ...native[0],
    str: 'Table 1: Comparative records.',
    width: 70,
    height: 5,
    transform: [5, 0, 0, 5, 10, 95]
  })
  native.push({ ...native[0], str: 'Independent prose', transform: [10, 0, 0, 10, 10, 10] })
  f.items.splice(0, f.items.length, ...native)
  const fragment = (indices: number[]) => ({
    pageNumber: 1,
    rect: {
      x: Math.min(...indices.map((i) => native[i].transform[4])) / 100,
      y: (100 - Math.max(...indices.map((i) => native[i].transform[5] + native[i].height))) / 100,
      width:
        (Math.max(...indices.map((i) => native[i].transform[4] + native[i].width)) -
          Math.min(...indices.map((i) => native[i].transform[4]))) /
        100,
      height:
        (Math.max(...indices.map((i) => native[i].transform[5] + native[i].height)) -
          Math.min(...indices.map((i) => native[i].transform[5]))) /
        100
    },
    items: indices.map((index) => ({ index, text: native[index].str }))
  })
  f.context.extraction = {
    ...f.extraction,
    source: createPdfTranslationSource({
      ...f.extraction.source,
      units: [[0], [1], [2], [3, 5], [4], [6], [7]].map((indices, index) => ({
        id: 'owner-' + index,
        source: indices.map((i) => native[i].str).join(' '),
        fragments: [fragment(indices)]
      }))
    })
  }
  f.cached.elements[0].regions = [{ page: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.5 }]
  f.cached.elements[0].caption = {
    text: native[6].str,
    regions: [{ page: 1, ...fragment([6]).rect }]
  }
  f.cached.elements[0].table = {
    rowCount: 3,
    columnCount: 2,
    unassignedText: [],
    issues: [{ code: 'native-table-structure-ambiguous', detail: 'Uncertain row allocation' }],
    cells: labels.map((text, index) => ({
      row: Math.floor(index / 2),
      column: index % 2,
      rowSpan: 1,
      columnSpan: 1,
      text,
      regions: [{ page: 1, ...fragment([index]).rect }],
      sourceItems: [{ pageNumber: 1, index, text }]
    }))
  }
  return f
}

it.each([false, true])(
  'retains native captioned blocked record owners, saved: %s',
  async (saved) => {
    const f = blockedCaptionedRecordTable(),
      before = JSON.stringify(f.context.extraction.source)
    const out = await applyCachedPdfStructureSources({ ...f.context, preserveUnitIdentity: saved })
    expect(out.extraction.source.units.find((u) => u.id === 'owner-3')).toEqual({
      ...f.context.extraction.source.units[3],
      sourceOnly: true
    })
    expect(out.retainedUnitIds).toEqual(['owner-0', 'owner-1', 'owner-2', 'owner-3', 'owner-4'])
    expect(out.retainedSourcePageNumbers).toEqual([1])
    expect(out.extraction.source.units.slice(5)).toEqual(f.context.extraction.source.units.slice(5))
    expect(out.extraction.source.originalRegions ?? []).toEqual([])
    expect(JSON.stringify(f.context.extraction.source)).toBe(before)
  }
)

it.each(['no-caption', 'foreign-caption', 'cell-region', 'native-literal', 'mixed-prose'])(
  'does not infer blocked record retention without exact native closure: %s',
  async (fault) => {
    const f = blockedCaptionedRecordTable()
    if (fault === 'no-caption') delete f.cached.elements[0].caption
    if (fault === 'foreign-caption') f.cached.elements[0].caption!.text = 'Table 1: Other records.'
    if (fault === 'cell-region') f.cached.elements[0].table!.cells[3].regions[0].y += 0.1
    if (fault === 'native-literal') f.items[3].str = 'Changed model'
    if (fault === 'mixed-prose') {
      const units = structuredClone(f.context.extraction.source.units)
      units[3].fragments.push(...units[6].fragments)
      units[3].source += ' Independent prose'
      units.splice(6, 1)
      f.context.extraction = {
        ...f.context.extraction,
        source: createPdfTranslationSource({ ...f.context.extraction.source, units })
      }
    }
    const out = await applyCachedPdfTableSources(f.context)
    expect(out.source.units.find((u) => u.id === 'owner-3')?.sourceOnly).toBeUndefined()
    expect(out.source.originalRegions ?? []).toEqual([])
  }
)

it.each(['clone', 'native-text', 'method', 'fingerprint', 'abort'])(
  'withdraws current blocked-record exclusion proof: %s',
  async (fault) => {
    const f = blockedCaptionedRecordTable(),
      out = await applyCachedPdfTableSources(f.context)
    expect(getPdfTableOriginalRetention(out)?.retainedUnitIds).toContain('owner-3')
    if (fault === 'clone') expect(getPdfTableOriginalRetention({ ...out })).toBeUndefined()
    else {
      if (fault === 'native-text') f.items[3].str = 'Changed model'
      if (fault === 'method')
        f.page.getTextContent = vi.fn(async () => ({ items: f.items, styles: {} }))
      if (fault === 'fingerprint') f.document.fingerprints[0] = 'changed'
      if (fault === 'abort') f.controller.abort()
      expect(getPdfTableOriginalRetention(out)).toBeUndefined()
    }
  }
)

it('retains blocked owners when an independent saved cell already has its replacement ID', async () => {
  const f = blockedCaptionedRecordTable(),
    units = structuredClone(f.context.extraction.source.units)
  units[6].id = 'table-source:cached-1:independent:0:0:0'
  f.context.extraction = {
    ...f.context.extraction,
    source: createPdfTranslationSource({ ...f.context.extraction.source, units })
  }
  const prose = units[6].fragments[0]
  f.cached.elements.push({
    id: 'independent',
    kind: 'table',
    issues: [],
    regions: [{ page: 1, ...prose.rect }],
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
          text: units[6].source,
          regions: [{ page: 1, ...prose.rect }],
          sourceItems: prose.items.map((item) => ({ pageNumber: 1, ...item }))
        }
      ]
    }
  })
  const out = await applyCachedPdfTableSources(f.context)
  expect(out.source.units.find((u) => u.id === 'owner-3')?.sourceOnly).toBe(true)
  expect(getPdfTableOriginalRetention(out)?.retainedUnitIds).toContain('owner-3')
  expect(out.source.units[6]).toEqual(units[6])
  expect(out.source.originalRegions ?? []).toEqual([])
})

it.each(['clone', 'native-text', 'method', 'fingerprint', 'abort'])(
  'never transfers stale incomplete-owner retention: %s',
  async (fault) => {
    const f = setup()
    f.cached.elements[0].table!.cells.pop()
    const out = await applyCachedPdfTableSources(f.context)
    expect(getPdfTableOriginalRetention(out)?.retainedUnitIds).toEqual(['group'])
    if (fault === 'clone') {
      expect(getPdfTableOriginalRetention({ ...out })).toBeUndefined()
      return
    }
    if (fault === 'native-text') f.items[1].str = 'changed'
    if (fault === 'method')
      f.page.getTextContent = vi.fn(async () => ({ items: f.items, styles: {} }))
    if (fault === 'fingerprint') f.document.fingerprints[0] = 'changed'
    if (fault === 'abort') f.controller.abort()
    expect(getPdfTableOriginalRetention(out)).toBeUndefined()
  }
)
it('does not mint incomplete-owner retention when an omitted native item differs', async () => {
  const f = setup()
  f.cached.elements[0].table!.cells.pop()
  f.items[1].str = 'changed'
  const out = await applyCachedPdfTableSources(f.context)
  expect(out).toBe(f.extraction)
  expect(getPdfTableOriginalRetention(out)).toBeUndefined()
})

it('carries every page of a proved incomplete whole owner for reflow without inventing a crop', async () => {
  const f = setup()
  f.document.numPages = 2
  f.cached.pageCount = 2
  f.cached.elements[0].table!.cells.pop()
  const [group, prose] = f.extraction.source.units
  f.context.extraction = {
    ...f.extraction,
    source: createPdfTranslationSource({
      ...f.extraction.source,
      pages: [...f.extraction.source.pages, ...f.extraction.source.pages],
      units: [
        {
          ...group,
          fragments: [
            { ...group.fragments[0], items: [group.fragments[0].items[0]] },
            { ...group.fragments[0], pageNumber: 2, items: [group.fragments[0].items[1]] }
          ]
        },
        prose
      ]
    })
  }
  f.readCached.mockImplementation(async ({ page }) => (page === 1 ? f.cached : undefined))
  const stored = JSON.stringify(f.context.extraction.source)
  const out = await applyCachedPdfStructureSources({ ...f.context, preserveUnitIdentity: true })
  expect(out.retainedUnitIds).toEqual(['group'])
  expect(out.retainedSourcePageNumbers).toEqual([1, 2])
  expect(out.extraction.source.originalRegions ?? []).toEqual([])
  expect(out.extraction.source.units[0]).toEqual({
    ...f.context.extraction.source.units[0],
    sourceOnly: true
  })
  expect(out.extraction.source.units[1]).toEqual(prose)
  expect(JSON.stringify(f.context.extraction.source)).toBe(stored)
})

it('reproves negative table eligibility after serializing source, without changing saved target strings', async () => {
  const f = setup()
  f.cached.elements[0].table!.cells.pop()
  const fresh = await applyCachedPdfStructureSources(f.context)
  const stored = JSON.stringify({
    source: fresh.extraction.source,
    targets: [{ id: 'group', translation: 'Historical accepted text' }]
  })
  const restored = JSON.parse(stored)
  const extraction = { ...f.extraction, source: createPdfTranslationSource(restored.source) }
  expect(getPdfTableOriginalRetention(extraction)).toBeUndefined()
  const saved = await applyCachedPdfStructureSources({
    ...f.context,
    extraction,
    preserveUnitIdentity: true
  })
  expect(saved.retainedUnitIds).toEqual(['group'])
  expect(saved.retainedSourcePageNumbers).toEqual([1])
  expect(saved.extraction.source.units).toEqual(extraction.source.units)
  expect(JSON.stringify(restored)).toBe(stored)
})

async function blockedNativeSpanningHeaders(offBaseline = false) {
  const pdf = await PDFDocument.create(),
    sheet = pdf.addPage([400, 300]),
    specs = [
      ['Samples', 150, 250],
      ['Features', 250, 250],
      ['Group', 40, 232],
      ['Clean', 150, 232],
      ['Altered', 200, 232],
      ['Raw', 250, 232],
      ['Used', 300, 232],
      ['Alpha', 40, 210],
      ['11', 150, 210],
      ['12', 200, 210],
      ['13', 250, 210],
      ['14', 300, 210],
      ['Beta', 40, 190],
      ['21', 150, 190],
      ['22', 200, 190],
      ['23', 250, 190],
      ['24', 300, 190],
      ['Table 1: Example counts.', 40, 275],
      ['Independent prose', 40, 150]
    ] as const
  for (const [text, x, y] of specs)
    sheet.drawText(text, { x, y: offBaseline && text === 'Clean' ? y - 2 : y, size: 10 })
  const bytes = await pdf.save(),
    assets = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    task = getDocument({
      data: bytes.slice(),
      standardFontDataUrl: path.join(assets, 'standard_fonts') + '/'
    }),
    document = await task.promise,
    page = await document.getPage(1),
    content = await page.getTextContent(),
    entries = specs.map(([text]) => {
      const index = content.items.findIndex((i) => 'str' in i && i.str === text),
        raw = content.items[index]
      if (!raw || !('str' in raw)) throw Error('Missing anonymous native item')
      return {
        index,
        raw,
        rect: {
          x: raw.transform[4] / 400,
          y: (300 - raw.transform[5] - raw.height) / 300,
          width: raw.width / 400,
          height: raw.height / 300
        }
      }
    }),
    fragment = (indices: number[]) => ({
      pageNumber: 1,
      rect: {
        x: Math.min(...indices.map((i) => entries[i].rect.x)),
        y: Math.min(...indices.map((i) => entries[i].rect.y)),
        width:
          Math.max(...indices.map((i) => entries[i].rect.x + entries[i].rect.width)) -
          Math.min(...indices.map((i) => entries[i].rect.x)),
        height:
          Math.max(...indices.map((i) => entries[i].rect.y + entries[i].rect.height)) -
          Math.min(...indices.map((i) => entries[i].rect.y))
      },
      items: indices.map((i) => ({ index: entries[i].index, text: entries[i].raw.str }))
    }),
    groups = [[0, 1], [2, 3, 4, 5, 6], ...entries.slice(7).map((_, i) => [i + 7])],
    source = createPdfTranslationSource({
      resourceRequestKey: 'anonymous-records',
      fingerprint: document.fingerprints[0],
      pages: [{ width: 400, height: 300 }],
      units: groups.map((indices, i) => ({
        id: 'native-owner-' + i,
        source: indices.map((i) => entries[i].raw.str).join(' '),
        fragments: [fragment(indices)]
      }))
    }),
    f = setup(),
    sourceIdentity = {
      sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
      sourceSizeBytes: bytes.length
    },
    cached: PdfStructureResult = {
      ...f.cached,
      ...sourceIdentity,
      pages: [{ page: 1, width: 400, height: 300, rotation: 0 }],
      elements: [
        {
          id: 'records',
          kind: 'table',
          issues: [{ code: 'native-table-structure-ambiguous', detail: 'Uncertain record rows' }],
          regions: [{ page: 1, x: 0.08, y: 0.12, width: 0.8, height: 0.3 }],
          caption: { text: entries[17].raw.str, regions: [{ page: 1, ...entries[17].rect }] },
          table: {
            rowCount: 5,
            columnCount: 5,
            issues: [],
            unassignedText: [],
            cells: [
              ...entries.slice(0, 17).map((e, i) => ({
                row: i < 3 ? 0 : i < 7 ? 1 : i < 12 ? 2 : 3,
                column:
                  i === 0 ? 1 : i === 1 ? 3 : i === 2 ? 0 : i < 7 ? i - 2 : i < 12 ? i - 7 : i - 12,
                rowSpan: i === 2 ? 2 : 1,
                columnSpan: i < 2 ? 2 : 1,
                text: e.raw.str,
                sourceItems: [{ pageNumber: 1, index: e.index, text: e.raw.str }],
                regions: [{ page: 1, ...e.rect }]
              })),
              ...Array.from({ length: 5 }, (_, column) => ({
                row: 4,
                column,
                rowSpan: 1,
                columnSpan: 1,
                text: '',
                regions: []
              }))
            ]
          }
        }
      ]
    },
    extraction: PdfTranslationExtraction = {
      source,
      coverage: {
        pageCount: 1,
        textItemCount: entries.length,
        includedItemCount: entries.length,
        excludedItemCount: 0,
        pagesWithoutText: [],
        exclusions: [],
        warnings: []
      }
    },
    context = {
      ...f.context,
      extraction,
      document,
      sourceIdentity,
      nativeDocumentFactory: getDocument,
      readCached: async () => cached
    }
  return { context, cached, entries, fragment, destroy: () => task.destroy() }
}

it.each([false, true])(
  'protects only complete multi-cell native header owners, saved: %s',
  async (saved) => {
    const f = await blockedNativeSpanningHeaders()
    try {
      const before = JSON.stringify(f.context.extraction),
        cached = JSON.stringify(f.cached),
        out = await applyCachedPdfStructureSources({ ...f.context, preserveUnitIdentity: saved })
      expect(out.retainedUnitIds).toEqual(['native-owner-0', 'native-owner-1'])
      expect(out.extraction.source.units.slice(0, 2).map((u) => u.sourceOnly)).toEqual([true, true])
      expect(out.extraction.source.units.slice(2)).toEqual(
        f.context.extraction.source.units.slice(2)
      )
      expect(out.extraction.source.originalRegions ?? []).toEqual([])
      expect(out.retainedSourcePageNumbers).toEqual([1])
      expect(JSON.stringify(f.context.extraction)).toBe(before)
      expect(JSON.stringify(f.cached)).toBe(cached)
    } finally {
      await f.destroy()
    }
  }
)

it.each([
  'no-caption',
  'foreign-caption',
  'foreign-native',
  'cell-region',
  'no-records',
  'one-record',
  'off-baseline',
  'mixed-prose',
  'partial-cell',
  'empty-region'
] as const)(
  'does not infer multi-cell header exclusion from incomplete evidence: %s',
  async (fault) => {
    const f = await blockedNativeSpanningHeaders(fault === 'off-baseline')
    try {
      const element = f.cached.elements[0],
        table = element.table!
      if (fault === 'no-caption') delete element.caption
      if (fault === 'foreign-caption') element.caption!.text = 'Table 1: Different counts.'
      if (fault === 'foreign-native') table.cells[3].sourceItems![0].text = 'Different label'
      if (fault === 'cell-region') table.cells[3].regions[0].x += 0.01
      if (fault === 'empty-region') table.cells.at(-1)!.regions = [table.cells[3].regions[0]]
      if (fault === 'no-records')
        table.cells = table.cells.filter((c) => c.row < 2 || c.column === 0)
      if (fault === 'one-record')
        table.cells = table.cells.filter((c) => c.row < 3 || c.column === 0)
      if (fault === 'mixed-prose' || fault === 'partial-cell') {
        const units = structuredClone(f.context.extraction.source.units)
        if (fault === 'mixed-prose') {
          const prose = units.pop()!
          units[1].source += ' ' + prose.source
          units[1].fragments.push(...prose.fragments)
        } else {
          const used = table.cells[6]
          table.cells[5].text += ' ' + used.text
          table.cells[5].sourceItems!.push(...used.sourceItems!)
          table.cells[5].regions.push(...used.regions)
          table.cells[5].columnSpan = 2
          table.cells.splice(6, 1)
          units[1].fragments = [f.fragment([2, 3, 4, 5])]
          units[1].source = units[1].fragments[0].items.map((i) => i.text).join(' ')
          units.push({ id: 'separate-native-owner', source: 'Used', fragments: [f.fragment([6])] })
        }
        f.context.extraction = {
          ...f.context.extraction,
          source: createPdfTranslationSource({ ...f.context.extraction.source, units })
        }
      }
      const before = JSON.stringify(f.context.extraction),
        out = await applyCachedPdfStructureSources({ ...f.context, preserveUnitIdentity: true })
      expect(out.retainedUnitIds).not.toContain('native-owner-1')
      expect(
        out.extraction.source.units.find((u) => u.id === 'native-owner-1')?.sourceOnly
      ).toBeUndefined()
      expect(JSON.stringify(f.context.extraction)).toBe(before)
      expect(out.extraction.source.originalRegions ?? []).toEqual([])
    } finally {
      await f.destroy()
    }
  }
)

it('withdraws real native spanning-header retention on clone or source epoch change', async () => {
  const f = await blockedNativeSpanningHeaders()
  try {
    const out = await applyCachedPdfTableSources(f.context)
    expect(getPdfTableOriginalRetention(out)?.retainedUnitIds).toEqual([
      'native-owner-0',
      'native-owner-1'
    ])
    expect(getPdfTableOriginalRetention({ ...out })).toBeUndefined()
    f.context.document.fingerprints[0] = 'different-source'
    expect(getPdfTableOriginalRetention(out)).toBeUndefined()
  } finally {
    await f.destroy()
  }
})

it('keeps normal cell publication for a valid native spanning header', async () => {
  const f = await blockedNativeSpanningHeaders()
  try {
    f.cached.elements[0].issues = []
    const before = JSON.stringify(f.context.extraction),
      out = await applyCachedPdfTableSources(f.context)
    expect(getPdfTableOriginalRetention(out)?.retainedUnitIds).toEqual([])
    expect(out.source.units.some((u) => u.id.startsWith('table-source:'))).toBe(true)
    expect(JSON.stringify(f.context.extraction)).toBe(before)
  } finally {
    await f.destroy()
  }
})
