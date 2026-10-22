/* eslint-disable @typescript-eslint/explicit-function-return-type -- inferred native fixture types */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import { parsePdfStructureResult, type PdfStructureResult } from '@aipoch/pdf-structure/result'
import { applyCachedPdfStructureSources } from '../../src/reader/structure-source.js'
import { applyCachedPdfTableSources } from '../../src/reader/table-source.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'
import { nativeLabelRegion } from '../../src/reader/native-source-geometry.js'
import type { PdfTranslationExtraction } from '../../src/reader/extraction.js'

async function fixture(kind: 'table' | 'figure' = 'table', segmented = false) {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    page = pdf.addPage([400, 500])
  for (const [text, x, y] of [
    [segmented ? '10 10' : 'Row A', 40, 400],
    ['10', 200, 400],
    ['Row B', 40, 370],
    ['20', 200, 370],
    ['Table 1. Results', 40, 320],
    ['Adjacent prose must remain translated.', 40, 200]
  ] as const)
    page.drawText(text, { x, y, size: 10, font })
  const bytes = await pdf.save(),
    sourceIdentity = {
      sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
      sourceSizeBytes: bytes.length
    },
    loading = getDocument({
      data: bytes,
      standardFontDataUrl: `${path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`
    }),
    document = await loading.promise,
    nativePage = await document.getPage(1),
    content = await nativePage.getTextContent(),
    viewport = nativePage.getViewport({ scale: 1 }),
    items = content.items.flatMap((item, index) =>
      'str' in item && item.str.trim() ? [{ index, item }] : []
    )
  const source = createPdfTranslationSource({
    resourceRequestKey: 'native-fixture',
    fingerprint: document.fingerprints[0],
    pages: [{ width: viewport.width, height: viewport.height }],
    units: items.map(({ item, index }) => {
      const region = nativeLabelRegion(item, content.styles[item.fontName], viewport, 1)!,
        rect = { x: region.x, y: region.y, width: region.width, height: region.height }
      return {
        id: `native-${index}`,
        source: item.str,
        fragments: [{ pageNumber: 1, rect, items: [{ index, text: item.str }] }]
      }
    })
  })
  const origins = items
    .slice(0, 4)
    .map(({ index, item }) => ({ pageNumber: 1, index, text: item.str }))
  const cellRegion = (item: TextItem) => ({
    page: 1,
    x: item.transform[4] / 400,
    y: (500 - item.transform[5] - item.height) / 500,
    width: item.width / 400,
    height: item.height / 500
  })
  const cached: PdfStructureResult = {
    schemaVersion: 1,
    extractionId: 'native-structure',
    engineFingerprint: 'b'.repeat(64),
    ...sourceIdentity,
    pageCount: 1,
    requestedPages: [1],
    processedPages: [1],
    pages: [{ page: 1, width: 400, height: 500, rotation: 0 }],
    elements: [
      {
        id: 'structure',
        kind,
        issues: [],
        regions: [{ page: 1, x: 0.08, y: 0.15, width: 0.6, height: 0.15 }],
        caption: {
          text: items[4].item.str,
          regions: [{ page: 1, ...source.units[4].fragments[0].rect }]
        },
        ...(kind === 'figure'
          ? { sourceItems: origins }
          : {
              table: {
                rowCount: 2,
                columnCount: 2,
                issues: [],
                unassignedText: [],
                cells: items.slice(0, 4).map(({ item }, i) => ({
                  row: Math.floor(i / 2),
                  column: i % 2,
                  rowSpan: 1,
                  columnSpan: 1,
                  text: item.str,
                  regions: [cellRegion(item)],
                  sourceItems: [origins[i]]
                }))
              }
            })
      }
    ],
    thumbnails: [],
    navigation: [],
    issues: []
  }
  const extraction: PdfTranslationExtraction = {
    source,
    coverage: {
      pageCount: 1,
      textItemCount: items.length,
      includedItemCount: items.length,
      excludedItemCount: 0,
      pagesWithoutText: [],
      exclusions: [],
      warnings: []
    }
  }
  return {
    loading,
    font,
    cached,
    extraction,
    args: {
      preserveUnitIdentity: true,
      extraction,
      document,
      sourceIdentity,
      sourceId: 'native-version',
      signal: new AbortController().signal,
      readCached: async (): Promise<PdfStructureResult | undefined> => cached
    }
  }
}

describe('verified structure source bridge', () => {
  it.each(['table', 'figure'] as const)(
    'retains native %s labels as a whole crop while preserving prose, captions and identities',
    async (kind) => {
      const f = await fixture(kind)
      try {
        const before = structuredClone(f.extraction.source),
          result = await applyCachedPdfStructureSources(f.args)
        expect(result.retainedUnitIds).toEqual(
          f.extraction.source.units.slice(0, 4).map((u) => u.id)
        )
        expect(result.extraction.source.units).toEqual(
          f.extraction.source.units.map((u, i) => (i < 4 ? { ...u, sourceOnly: true } : u))
        )
        expect(result.extraction.source.originalRegions).toEqual([
          { pageNumber: 1, rect: { x: 0.08, y: 0.15, width: 0.6, height: 0.15 } }
        ])
        expect(structuredClone(f.extraction.source)).toEqual(before)
      } finally {
        await f.loading.destroy()
      }
    }
  )

  it.each(['table', 'figure'] as const)(
    'also retains previously source-only %s labels in their verified crop',
    async (kind) => {
      const f = await fixture(kind)
      try {
        f.args.extraction = {
          ...f.extraction,
          source: createPdfTranslationSource({
            ...f.extraction.source,
            units: f.extraction.source.units.map((unit, index) =>
              index < 4 ? { ...unit, sourceOnly: true } : unit
            )
          })
        }
        const result = await applyCachedPdfStructureSources(f.args)
        expect(result.retainedUnitIds).toHaveLength(4)
        expect(result.extraction.source.originalRegions).toHaveLength(1)
        expect(result.extraction.source.units.slice(4)).toEqual(f.extraction.source.units.slice(4))
      } finally {
        await f.loading.destroy()
      }
    }
  )

  it('keeps complete parent ownership when a native text item has verified cell segments', async () => {
    const f = await fixture('table', true)
    try {
      const table = f.cached.elements[0].table!,
        cell = table.cells[0],
        origin = cell.sourceItems![0],
        rect = cell.regions[0]
      const pieces = [
        {
          start: 0,
          end: 2,
          column: 0,
          text: '10',
          x: rect.x,
          width: f.font.widthOfTextAtSize('10', 10) / 400
        },
        {
          start: 3,
          end: 5,
          column: 1,
          text: '10',
          x: rect.x + f.font.widthOfTextAtSize('10 ', 10) / 400,
          width: f.font.widthOfTextAtSize('10', 10) / 400
        }
      ]
      table.columnCount = 3
      table.cells = [
        ...pieces.map(({ start, end, column, text, x, width }) => {
          const region = { ...rect, x, width }
          const split = {
            ...cell,
            column,
            text,
            regions: [region],
            sourceItems: undefined,
            sourceSegments: [{ ...origin, start, end, region: { ...region } }]
          }
          delete split.sourceItems
          return split
        }),
        ...table.cells.slice(1).map((entry) => ({ ...entry, column: entry.column === 1 ? 2 : 0 }))
      ]
      expect(() => parsePdfStructureResult(f.cached, f.cached)).not.toThrow()
      const tableResult = await applyCachedPdfTableSources(f.args)
      expect(tableResult.source.units.map((unit) => unit.id)).not.toEqual(
        f.extraction.source.units.map((unit) => unit.id)
      )
      expect(tableResult.source.originalRegions).toHaveLength(1)
      const result = await applyCachedPdfStructureSources(f.args)
      expect(result.retainedUnitIds).toEqual(f.extraction.source.units.slice(0, 4).map((u) => u.id))
      expect(result.extraction.source.units[0]).toEqual({
        ...f.extraction.source.units[0],
        sourceOnly: true
      })
      expect(result.extraction.source.originalRegions).toHaveLength(1)
    } finally {
      await f.loading.destroy()
    }
  })

  it.each(['owned-padding', 'caption', 'adjacent-prose'] as const)(
    'revalidates the entire crop after extending native-owned fragment padding: %s',
    async (variant) => {
      const f = await fixture()
      try {
        const crop = f.cached.elements[0].regions[0],
          units = [...f.extraction.source.units],
          fragment = units[0].fragments[0],
          rect = {
            ...fragment.rect,
            x: crop.x - 0.005,
            width: fragment.rect.x + fragment.rect.width - crop.x + 0.005
          }
        if (variant === 'caption') rect.height = 0.22
        if (variant === 'adjacent-prose') {
          rect.height = 0.45
          // Isolate the unclaimed native-prose guard from the caption-region guard.
          delete f.cached.elements[0].caption
        }
        units[0] = { ...units[0], fragments: [{ ...fragment, rect }] }
        f.args.extraction = {
          ...f.extraction,
          source: createPdfTranslationSource({ ...f.extraction.source, units })
        }
        const result = await applyCachedPdfStructureSources(f.args)
        if (variant === 'owned-padding') {
          expect(result.retainedUnitIds).toEqual(units.slice(0, 4).map((u) => u.id))
          expect(result.extraction.source.originalRegions).toEqual([
            {
              pageNumber: 1,
              rect: {
                x: crop.x - 0.005,
                y: crop.y,
                width: expect.closeTo(crop.width + 0.005),
                height: expect.closeTo(crop.height)
              }
            }
          ])
          expect(result.extraction.source.units.slice(4)).toEqual(units.slice(4))
        } else {
          expect(result.retainedUnitIds).toEqual([])
          expect(result.extraction).toBe(f.args.extraction)
          expect(result.extraction.source.originalRegions).toBeUndefined()
        }
      } finally {
        await f.loading.destroy()
      }
    }
  )

  describe.each(['table', 'figure'] as const)('%s failure boundaries', (kind) => {
    it.each([
      'no-cache',
      'stale-cache',
      'invalid-cache',
      'missing-native',
      'wrong-native',
      'oversized-crop',
      'unclaimed-prose',
      'mixed-prose',
      'mixed-caption',
      'caption-claimed'
    ] as const)('keeps all original units eligible for %s', async (variant) => {
      const f = await fixture(kind)
      try {
        const element = f.cached.elements[0]
        if (variant === 'no-cache') f.args.readCached = async () => undefined
        if (variant === 'stale-cache') f.cached.sourceChecksum = 'c'.repeat(64)
        if (variant === 'invalid-cache') f.cached.schemaVersion = 2 as 1
        if (variant === 'missing-native') {
          if (element.table) for (const cell of element.table.cells) delete cell.sourceItems
          else delete element.sourceItems
        }
        if (variant === 'wrong-native') {
          const origins = element.table ? element.table.cells[0].sourceItems! : element.sourceItems!
          origins[0].text = 'Changed'
        }
        if (variant === 'oversized-crop' || variant === 'unclaimed-prose')
          element.regions[0].height = 0.6
        if (variant === 'unclaimed-prose') {
          // Even omitted extraction units cannot make real native body text safe to crop.
          element.caption!.regions = [{ page: 1, x: 0.08, y: 0.8, width: 0.6, height: 0.1 }]
          f.args.extraction = {
            ...f.extraction,
            source: createPdfTranslationSource({
              ...f.extraction.source,
              units: f.extraction.source.units.slice(0, 4)
            })
          }
        }
        if (variant === 'mixed-prose' || variant === 'mixed-caption') {
          const units = [...f.extraction.source.units],
            otherIndex = variant === 'mixed-prose' ? 5 : 4,
            other = units.splice(otherIndex, 1)[0]
          units[0] = {
            ...units[0],
            source: `${units[0].source} ${other.source}`,
            fragments: [...units[0].fragments, ...other.fragments]
          }
          f.args.extraction = {
            ...f.extraction,
            source: createPdfTranslationSource({ ...f.extraction.source, units })
          }
        }
        if (variant === 'caption-claimed') {
          element.regions[0].height = 0.25
          const item = f.extraction.source.units[4].fragments[0].items[0]
          if (element.sourceItems) element.sourceItems.push({ pageNumber: 1, ...item })
          else element.caption!.regions = [{ ...element.regions[0] }]
        }
        const result = await applyCachedPdfStructureSources(f.args)
        expect(result.retainedUnitIds).toEqual([])
        expect(result.extraction).toBe(f.args.extraction)
        expect(result.extraction.source.originalRegions).toBeUndefined()
      } finally {
        await f.loading.destroy()
      }
    })
  })
})
