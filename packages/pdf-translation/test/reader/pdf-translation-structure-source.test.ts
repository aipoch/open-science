/* eslint-disable @typescript-eslint/explicit-function-return-type -- inferred native fixture types */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as fontkit from 'fontkit'
import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it, vi } from 'vitest'
import { PDFDocument, PDFDict, PDFName, StandardFonts } from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import { parsePdfStructureResult, type PdfStructureResult } from '@aipoch/pdf-structure/result'
import { applyCachedPdfStructureSources } from '../../src/reader/structure-source.js'
import { applyCachedPdfTableSources } from '../../src/reader/table-source.js'
import {
  applyCachedPdfFigureSources,
  preservePdfFigureSources
} from '../../src/reader/figure-source.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'
import { pdfReflowContentKinds } from '../../src/reader/reflow-content.js'
import {
  nativeLabelRegion,
  nativeAlgorithmInkRegions,
  nativePartialNavigation
} from '../../src/reader/native-source-geometry.js'
import {
  verifiedPdfStructureRegions,
  verifiedPdfTableRegions
} from '../../src/reader/structure-regions.js'
import type { PdfTranslationExtraction } from '../../src/reader/extraction.js'

async function foreignTableInkFixture() {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(
    await readFile(
      path.join(
        path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
        'standard_fonts/LiberationSans-Regular.ttf'
      )
    )
  )
  const sheet = pdf.addPage([400, 500])
  sheet.drawText('Outside', { x: 40, y: 410, size: 12, font })
  const key = sheet.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0].toString()
  sheet.node.set(
    PDFName.of('Contents'),
    pdf.context.register(
      pdf.context.flateStream(
        `BT ${key} 12 Tf 40 410 Td ${font.encodeText('Outside')} Tj ET\nBT ${key} 12 Tf 40 390 Td ${font.encodeText('Body')} Tj ET`
      )
    )
  )
  const bytes = await pdf.save(),
    task = getDocument({
      data: bytes.slice(),
      fontExtraProperties: true,
      disableFontFace: true,
      isEvalSupported: false
    }),
    document = await task.promise,
    proxy = await document.getPage(1),
    content = await proxy.getTextContent(),
    viewport = proxy.getViewport({ scale: 1 }),
    body = content.items.findIndex((i) => 'str' in i && i.str === 'Body'),
    outside = content.items.findIndex((i) => 'str' in i && i.str === 'Outside'),
    selected = new Set([body]),
    ink = await nativeAlgorithmInkRegions(proxy, content, viewport, 1, selected)
  expect(ink).toBeDefined()
  const native = (index: number) =>
      nativeLabelRegion(
        content.items[index] as TextItem,
        content.styles[(content.items[index] as TextItem).fontName],
        viewport,
        1
      )!,
    exterior = native(outside),
    actual = ink!.get(outside)!,
    owned = native(body),
    top = (exterior.y + exterior.height + actual.y + actual.height) / 2,
    crop = { page: 1, x: 0.05, y: top, width: 0.8, height: 0.3 - top },
    source = createPdfTranslationSource({
      resourceRequestKey: 'foreign-table-ink',
      fingerprint: document.fingerprints[0],
      pages: [{ width: 400, height: 500 }],
      units: [
        {
          id: 'body',
          source: 'Body',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: owned.x, y: owned.y, width: owned.width, height: owned.height },
              items: [{ index: body, text: 'Body' }]
            }
          ]
        }
      ]
    }),
    candidates = [{ regions: [crop], owners: new Set([`1:${body}`]) }],
    pages = new Map([[1, { proxy, content, viewport }]]),
    options = {
      document,
      sourceIdentity: {
        sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
        sourceSizeBytes: bytes.length
      }
    }
  expect(actual.y + actual.height).toBeLessThan(top)
  expect(exterior.y + exterior.height).toBeGreaterThan(top)
  return {
    task,
    proxy,
    content,
    viewport,
    source,
    candidates,
    pages,
    options,
    outside,
    body,
    crop,
    actual
  }
}

it('proves table foreign ink outside a crop without shrinking the owned native box', async () => {
  const f = await foreignTableInkFixture()
  try {
    expect(verifiedPdfStructureRegions(f.source, f.candidates, f.pages, [])).toEqual([])
    const result = await verifiedPdfTableRegions(f.source, f.candidates, f.pages, [], f.options)
    expect(result.current()).toBe(true)
    expect(result.regions).toEqual([
      {
        pageNumber: 1,
        rect: { x: f.crop.x, y: f.crop.y, width: f.crop.width, height: f.crop.height }
      }
    ])
  } finally {
    await f.task.destroy()
  }
})

it.each([
  'partial-content',
  'missing-outline',
  'ink-overlap',
  'pixel-overlap',
  'owned-overflow',
  'caption-overlap',
  'foreign-fragment'
] as const)('rejects table foreign ink fallback with %s', async (mode) => {
  const f = await foreignTableInkFixture()
  try {
    let source = f.source
    const captions: (typeof f.crop)[] = []
    if (mode === 'partial-content') f.content.items.splice(f.outside, 1)
    if (mode === 'missing-outline') {
      const has = f.proxy.commonObjs.has.bind(f.proxy.commonObjs)
      vi.spyOn(f.proxy.commonObjs, 'has').mockImplementation(
        (key) => !key.includes('_path_') && has(key)
      )
    }
    if (mode === 'ink-overlap') {
      f.crop.height += f.crop.y - f.actual.y
      f.crop.y = f.actual.y
    }
    if (mode === 'pixel-overlap') f.crop.y = f.actual.y + f.actual.height + 0.000001
    if (mode === 'owned-overflow') {
      f.crop.x = 0.1
      f.crop.width = 0.001
      source = createPdfTranslationSource({
        ...source,
        units: source.units.map((u) => ({
          ...u,
          fragments: u.fragments.map((g) => ({ ...g, rect: { ...g.rect, width: 0.001 } }))
        }))
      })
    }
    if (mode === 'caption-overlap') captions.push({ ...f.crop })
    if (mode === 'foreign-fragment')
      source = createPdfTranslationSource({
        ...source,
        units: [
          ...source.units,
          {
            id: 'foreign',
            source: 'Outside',
            fragments: [
              {
                pageNumber: 1,
                rect: { ...source.units[0].fragments[0].rect },
                items: [{ index: f.outside, text: 'Outside' }]
              }
            ]
          }
        ]
      })
    const result = await verifiedPdfTableRegions(source, f.candidates, f.pages, captions, f.options)
    expect(result.regions).toEqual([])
  } finally {
    vi.restoreAllMocks()
    await f.task.destroy()
  }
})

it.each(['outline', 'operators', 'projection', 'owners', 'source', 'document'] as const)(
  'invalidates table foreign ink after %s drift',
  async (mode) => {
    const f = await foreignTableInkFixture()
    try {
      const result = await verifiedPdfTableRegions(f.source, f.candidates, f.pages, [], f.options)
      expect(result.regions).toHaveLength(1)
      expect(result.current()).toBe(true)
      const ops = await f.proxy.getOperatorList(),
        item = f.content.items[f.outside] as TextItem,
        font = f.proxy.commonObjs.get(item.fontName)
      if (mode === 'outline') {
        const index = ops.fnArray.indexOf(OPS.showText),
          glyph = ops.argsArray[index][0].find((g: unknown) => typeof g === 'object')
        f.proxy.commonObjs.get(font.loadedName + '_path_' + glyph.fontChar).path[1] += 0.01
      }
      if (mode === 'operators') ops.argsArray[ops.fnArray.indexOf(OPS.moveText)][0] += 1
      if (mode === 'projection') f.viewport.convertToViewportPoint = () => [0, 0]
      if (mode === 'owners') f.candidates[0].owners.add(`1:${f.outside}`)
      if (mode === 'source') f.candidates[0].regions[0].height += 0.01
      if (mode === 'document') vi.spyOn(f.options.document, 'getPage').mockResolvedValue(f.proxy)
      expect(result.current()).toBe(false)
    } finally {
      vi.restoreAllMocks()
      await f.task.destroy()
    }
  }
)

it('rejects table foreign ink when native content changes across a page await', async () => {
  const f = await foreignTableInkFixture()
  try {
    vi.spyOn(f.options.document, 'getPage').mockImplementation(async () => {
      await Promise.resolve()
      ;(f.content.items[f.outside] as TextItem).width += 0.001
      return f.proxy
    })
    const result = await verifiedPdfTableRegions(f.source, f.candidates, f.pages, [], f.options)
    expect(result.regions).toEqual([])
    expect(result.current()).toBe(false)
  } finally {
    vi.restoreAllMocks()
    await f.task.destroy()
  }
})

it.each(['text', 'style', 'projection', 'text-api'] as const)(
  'binds the synchronous table crop path across its new await: %s',
  async (mode) => {
    const f = await foreignTableInkFixture()
    try {
      f.crop.y = 0.2
      f.crop.height = 0.1
      expect(verifiedPdfStructureRegions(f.source, f.candidates, f.pages, [])).toHaveLength(1)
      const pending = verifiedPdfTableRegions(f.source, f.candidates, f.pages, [], f.options)
      const item = f.content.items[f.outside] as TextItem
      if (mode === 'text') item.str += '!'
      if (mode === 'style') f.content.styles[item.fontName].ascent! += 0.01
      if (mode === 'projection') f.viewport.convertToViewportPoint = () => [0, 0]
      if (mode === 'text-api') vi.spyOn(f.proxy, 'getTextContent').mockResolvedValue(f.content)
      const result = await pending
      expect(result.current()).toBe(false)
    } finally {
      vi.restoreAllMocks()
      await f.task.destroy()
    }
  }
)

it('retains baseline crop eligibility when the optional native operator API is unavailable', async () => {
  const f = await foreignTableInkFixture()
  try {
    vi.spyOn(f.proxy, 'getOperatorList').mockRejectedValue(
      new Error('Unavailable native outline capability')
    )
    const result = await verifiedPdfTableRegions(f.source, f.candidates, f.pages, [], f.options)
    expect(result.current()).toBe(true)
    expect(result.regions).toEqual(verifiedPdfStructureRegions(f.source, f.candidates, f.pages, []))
  } finally {
    vi.restoreAllMocks()
    await f.task.destroy()
  }
})

it.each(['complete', 'operator-unavailable', 'late-style-drift'] as const)(
  'retains the table foreign ink contract through the complete structure entry: %s',
  async (mode) => {
    const f = await foreignTableInkFixture()
    try {
      const body = f.content.items[f.body] as TextItem,
        extraction: PdfTranslationExtraction = {
          source: f.source,
          coverage: {
            pageCount: 1,
            textItemCount: 1,
            includedItemCount: 1,
            excludedItemCount: 0,
            pagesWithoutText: [],
            exclusions: [],
            warnings: []
          }
        },
        result: PdfStructureResult = {
          schemaVersion: 1,
          extractionId: 'foreign-crop',
          engineFingerprint: 'b'.repeat(64),
          ...f.options.sourceIdentity,
          pageCount: 1,
          requestedPages: [1],
          processedPages: [1],
          pages: [{ page: 1, width: 400, height: 500, rotation: 0 }],
          elements: [
            {
              id: 'table',
              kind: 'table',
              issues: [],
              regions: [f.crop],
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
                    text: body.str,
                    regions: [
                      {
                        page: 1,
                        x: body.transform[4] / 400,
                        y: (500 - body.transform[5] - body.height) / 500,
                        width: body.width / 400,
                        height: body.height / 500
                      }
                    ],
                    sourceItems: [{ pageNumber: 1, index: f.body, text: body.str }]
                  }
                ]
              }
            }
          ],
          thumbnails: [],
          navigation: [],
          issues: []
        }
      vi.spyOn(f.proxy, 'getTextContent').mockResolvedValue(f.content)
      if (mode === 'operator-unavailable')
        vi.spyOn(f.proxy, 'getOperatorList').mockRejectedValue(new Error('No operators'))
      let reads = 0
      const applied = await applyCachedPdfStructureSources({
        extraction,
        ...f.options,
        sourceId: 'foreign-crop',
        signal: new AbortController().signal,
        readCached: async () => {
          if (++reads === 2 && mode === 'late-style-drift')
            f.content.styles[body.fontName].ascent! += 0.01
          return result
        }
      })
      if (mode === 'late-style-drift') expect(applied.extraction).toBe(extraction)
      else {
        expect(applied.extraction.source.units).toHaveLength(1)
        expect(applied.extraction.source.units[0]).toMatchObject({
          source: 'Body',
          sourceOnly: true
        })
        expect(applied.extraction.source.originalRegions ?? []).toHaveLength(
          mode === 'complete' ? 1 : 0
        )
      }
    } finally {
      vi.restoreAllMocks()
      await f.task.destroy()
    }
  }
)

it.each([false, true])(
  'closes auxiliary table ink evidence before publication (font drift %s)',
  async (drift) => {
    const f = await foreignTableInkFixture()
    vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
    try {
      const has = f.proxy.commonObjs.has.bind(f.proxy.commonObjs)
      vi.spyOn(f.proxy.commonObjs, 'has').mockImplementation(
        (key) => !key.includes('_path_') && has(key)
      )
      let destroyed = 0
      const factory = vi.fn((options: Parameters<typeof getDocument>[0]) => {
        const task = getDocument(options),
          destroy = task.destroy.bind(task)
        task.destroy = async () => {
          const document = await task.promise,
            page = await document.getPage(1),
            content = await page.getTextContent(),
            item = content.items.find((i) => 'str' in i && i.str.trim()) as TextItem
          if (drift) page.commonObjs.get(item.fontName).data[0] ^= 1
          await destroy()
          destroyed++
        }
        return task
      })
      const result = await verifiedPdfTableRegions(f.source, f.candidates, f.pages, [], {
        ...f.options,
        nativeDocumentFactory: factory
      })
      expect(factory).toHaveBeenCalledTimes(1)
      expect(destroyed).toBe(1)
      expect(result.regions).toHaveLength(drift ? 0 : 1)
      expect(result.current()).toBe(!drift)
    } finally {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      await f.task.destroy()
    }
  }
)

it.each(['left', 'right', 'edge'] as const)(
  'keeps explicit %s page clipping out of original crops without changing ordinary edge admission',
  async (placement) => {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      text = 'Native edge label',
      width = font.widthOfTextAtSize(text, 10),
      x = placement === 'left' ? -0.0002 : placement === 'right' ? 400 - width + 0.0002 : 0
    pdf.addPage([400, 500]).drawText(text, { x, y: 400, size: 10, font })
    const loading = getDocument({
      data: await pdf.save(),
      standardFontDataUrl: `${path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`
    })
    try {
      const document = await loading.promise,
        page = await document.getPage(1),
        content = await page.getTextContent(),
        viewport = page.getViewport({ scale: 1 }),
        index = content.items.findIndex((item) => 'str' in item && item.str === text),
        item = content.items[index] as TextItem,
        style = content.styles[item.fontName],
        partial = nativePartialNavigation(item, style, viewport),
        native = nativeLabelRegion(item, style, viewport, 1)!,
        rect = partial?.rect ?? {
          x: native.x,
          y: native.y,
          width: native.width,
          height: native.height
        },
        source = createPdfTranslationSource({
          resourceRequestKey: 'native-edge',
          fingerprint: document.fingerprints[0],
          pages: [{ width: viewport.width, height: viewport.height }],
          units: [
            {
              id: 'edge-label',
              source: text,
              sourceOnly: true,
              fragments: [{ pageNumber: 1, rect, ...partial, items: [{ index, text: item.str }] }]
            }
          ]
        })
      expect(index).toBeGreaterThanOrEqual(0)
      expect(Boolean(partial)).toBe(placement !== 'edge')
      const regions = verifiedPdfStructureRegions(
        source,
        [
          {
            regions: [{ page: 1, x: 0, y: rect.y, width: 1, height: rect.height }],
            owners: new Set([`1:${index}`])
          }
        ],
        new Map([[1, { content, viewport }]]),
        []
      )
      if (partial) expect(regions).toEqual([])
      else
        expect(regions).toEqual([
          {
            pageNumber: 1,
            rect: { x: 0, y: rect.y, width: 1, height: expect.closeTo(rect.height) }
          }
        ])
    } finally {
      await loading.destroy()
    }
  }
)

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

async function isolatedPlotCaption(referenceContext = false, networkCaption = false) {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const fonts = path.join(
    path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    'standard_fonts'
  )
  const regular = await pdf.embedFont(
    await readFile(path.join(fonts, 'LiberationSans-Regular.ttf'))
  )
  const bold = await pdf.embedFont(await readFile(path.join(fonts, 'LiberationSans-Bold.ttf')))
  const positioned = (font: typeof regular, text: string) =>
    '[' +
    text
      .split(' ')
      .map((word) => font.encodeText(word).toString())
      .join(' ' + -font.widthOfTextAtSize(' ', 10) * 100 + ' ') +
    '] TJ'
  const page = pdf.addPage([400, 500])
  page.drawText('Figure 1:', { font: bold })
  page.drawText('Measurements follow the ordinary comparison protocol.', { font: regular })
  const fontDictionary = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
  const fontKey = (font: typeof regular) =>
    fontDictionary
      .entries()
      .find(([, ref]) => ref.toString() === font.ref.toString())![0]
      .toString()
  const image = (width: number, height: number) =>
    pdf.context.register(
      pdf.context.flateStream(new Uint8Array(width * height * 3).fill(120), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8
      })
    )
  const heat = image(2, 2),
    bar = image(1, 2)
  const plot = pdf.context.register(
    pdf.context.flateStream('q 180 0 0 120 20 40 cm /Heat Do Q q 8 0 0 120 210 40 cm /Bar Do Q', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 300, 180],
      Resources: { XObject: { Heat: heat, Bar: bar } }
    })
  )
  const other = pdf.context.register(
    pdf.context.flateStream(
      `${networkCaption ? '0 0 300 100 re W* n ' : ''}q /Fade gs 0.8 0.2 0.3 rg 0 0 300 100 re f Q ${networkCaption ? '0 0 0 RG 1 w 30 25 50 50 re S 210 25 50 50 re S 80 50 m 210 50 l S ' : ''}BT /Regular 10 Tf 20 40 Td ${positioned(regular, 'Other diagram label')} ET`,
      {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 300, 100],
        Resources: { Font: { Regular: regular.ref }, ExtGState: { Fade: { ca: 0.3, CA: 0.3 } } }
      }
    )
  )
  page.node.Resources()!.set(PDFName.of('XObject'), pdf.context.obj({ Plot: plot, Other: other }))
  const prefix = 'Figure 1:',
    body = 'Measurements follow the ordinary comparison protocol.',
    secondPrefix = 'Figure 2:',
    secondBody = 'An independent network diagram shows the comparison procedure.'
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(
      pdf.context.flateStream(
        `${referenceContext ? `BT ${fontKey(regular)} 10 Tf 40 480 Td ${positioned(regular, 'References')} ET ` : ''}q 1 0 0 1 40 280 cm /Plot Do Q BT ${fontKey(bold)} 10 Tf 50 250 Td ${positioned(bold, prefix)} ET BT ${fontKey(regular)} 10 Tf ${50 + bold.widthOfTextAtSize(prefix, 10) + 3} 250 Td ${positioned(regular, body)} ET q 1 0 0 1 40 60 cm /Other Do Q ${networkCaption ? `BT ${fontKey(bold)} 10 Tf 40 40 Td ${positioned(bold, secondPrefix)} ET BT ${fontKey(regular)} 10 Tf ${40 + bold.widthOfTextAtSize(secondPrefix, 10) + 3} 40 Td ${positioned(regular, secondBody)} ET ` : ''}BT ${fontKey(regular)} 10 Tf 40 ${networkCaption ? 15 : 30} Td ${positioned(regular, 'Other prose remains unchanged.')} ET 0.5 w 40 ${networkCaption ? 4 : 10} m 340 ${networkCaption ? 4 : 10} l S`
      )
    )
  )
  const bytes = await pdf.save(),
    sourceIdentity = {
      sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
      sourceSizeBytes: bytes.length
    },
    loading = getDocument({
      data: bytes.slice(),
      fontExtraProperties: true,
      isEvalSupported: false
    }),
    document = await loading.promise,
    native = await document.getPage(1),
    content = await native.getTextContent(),
    viewport = native.getViewport({ scale: 1 })
  const operators = await native.getOperatorList()
  await Promise.all(
    operators.fnArray.flatMap((op, index) =>
      op === OPS.paintImageXObject
        ? [
            new Promise<void>((resolve) => {
              native.objs.get(operators.argsArray[index][0], () => resolve())
            })
          ]
        : []
    )
  )
  const items = content.items.flatMap((item, index) =>
    'str' in item && item.str.trim() ? [{ item, index }] : []
  )
  const captionItems = items.filter(({ item }) => [prefix, body].includes(item.str))
  expect(captionItems).toHaveLength(2)
  const left = captionItems[0].item.transform[4],
    right = captionItems[1].item.transform[4] + captionItems[1].item.width,
    top = 500 - captionItems[0].item.transform[5] - captionItems[0].item.height
  const captionRect = { x: left / 400, y: top / 500, width: (right - left) / 400, height: 10 / 500 }
  const caption = {
    id: 'caption',
    source: `${prefix} ${body}`,
    sourceOnly: true as const,
    preserve: 'reference' as const,
    fragments: [
      {
        pageNumber: 1,
        rect: captionRect,
        items: captionItems.map(({ item, index }) => ({ index, text: item.str }))
      }
    ]
  }
  const secondItems = networkCaption
    ? items.filter(({ item }) => [secondPrefix, secondBody].includes(item.str))
    : []
  const secondRect = networkCaption
    ? {
        x: secondItems[0].item.transform[4] / 400,
        y: (500 - secondItems[0].item.transform[5] - secondItems[0].item.height) / 500,
        width:
          (secondItems[1].item.transform[4] +
            secondItems[1].item.width -
            secondItems[0].item.transform[4]) /
          400,
        height: 10 / 500
      }
    : undefined
  const secondCaption = secondRect
    ? {
        id: 'network-caption',
        source: `${secondPrefix} ${secondBody}`,
        sourceOnly: true as const,
        preserve: 'reference' as const,
        fragments: [
          {
            pageNumber: 1,
            rect: secondRect,
            items: secondItems.map(({ item, index }) => ({ index, text: item.str }))
          }
        ]
      }
    : undefined
  const source = createPdfTranslationSource({
    resourceRequestKey: 'anonymous-isolated-plot',
    fingerprint: document.fingerprints[0],
    pages: [{ width: 400, height: 500 }],
    units: [
      caption,
      ...(secondCaption ? [secondCaption] : []),
      ...items
        .filter(({ index }) => !captionItems.concat(secondItems).some((c) => c.index === index))
        .map(({ item, index }) => ({
          id: `native-${index}`,
          source: item.str,
          fragments: [
            {
              pageNumber: 1,
              rect: nativeLabelRegion(item, content.styles[item.fontName], viewport, 1)!,
              items: [{ index, text: item.str }]
            }
          ]
        }))
    ].toSorted((a, b) => Number(b.source === 'References') - Number(a.source === 'References'))
  })
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
  const cached: PdfStructureResult = {
    schemaVersion: 1,
    extractionId: 'isolated-plot',
    engineFingerprint: 'b'.repeat(64),
    ...sourceIdentity,
    pageCount: 1,
    requestedPages: [1],
    processedPages: [1],
    pages: [{ page: 1, width: 400, height: 500, rotation: 0 }],
    elements: [
      {
        id: 'plot',
        kind: 'figure',
        issues: [],
        regions: [{ page: 1, x: 0.095, y: 0.075, width: 0.76, height: 0.37 }],
        caption: { text: caption.source, regions: [{ page: 1, ...captionRect }] }
      },
      {
        id: 'other',
        kind: 'figure',
        issues: [],
        regions: [{ page: 1, x: 0.095, y: 0.675, width: 0.76, height: 0.21 }],
        ...(secondCaption
          ? { caption: { text: secondCaption.source, regions: [{ page: 1, ...secondRect! }] } }
          : {})
      }
    ],
    thumbnails: [],
    navigation: [],
    issues: []
  }
  return {
    loading,
    native,
    cached,
    extraction,
    args: {
      extraction,
      document,
      sourceId: source.resourceRequestKey!,
      sourceIdentity,
      nativeDocumentFactory: getDocument,
      signal: new AbortController().signal,
      readCached: async () => cached
    }
  }
}

it('restores only a complete isolated plot caption from reference carryover', async () => {
  const f = await isolatedPlotCaption()
  try {
    const result = await applyCachedPdfFigureSources(f.args)
    const caption = { ...f.extraction.source.units[0] }
    delete caption.sourceOnly
    delete caption.preserve
    expect(result.source.units).toEqual([caption, ...f.extraction.source.units.slice(1)])
    expect(result.coverage).toEqual(f.extraction.coverage)
    expect(f.extraction.source.units[0]).toMatchObject({ sourceOnly: true, preserve: 'reference' })
  } finally {
    await f.loading.destroy()
  }
})

it('recovers the ordinary caption below a complete independently bounded vector Form', async () => {
  const f = await isolatedPlotCaption(true, true)
  try {
    const result = await applyCachedPdfFigureSources(f.args)
    const expected = f.extraction.source.units.map((unit) => {
      if (!['caption', 'network-caption'].includes(unit.id)) return unit
      const next = { ...unit }
      delete next.sourceOnly
      delete next.preserve
      return next
    })
    expect(result.source.units).toEqual(expected)
    expect(result.coverage).toEqual(f.extraction.coverage)
    const prepared = applyPdfContentFirstPolicy(result.source)
    expect(prepared.units.find((unit) => unit.id === 'network-caption')).toEqual(
      expected.find((unit) => unit.id === 'network-caption')
    )
    expect(
      prepared.units.find((unit) => unit.source === 'Other prose remains unchanged.')
    ).toMatchObject({ sourceOnly: true, preserve: 'reference' })
  } finally {
    await f.loading.destroy()
  }
})

it.each([
  'gstate-line-cap',
  'gstate-line-join',
  'gstate-dash',
  'one-ulp',
  'minmax-mismatch',
  'nonrectangular-clip',
  'transparent-vector',
  'no-filled-rectangle',
  'no-straight-stroke'
])(
  'requires a complete native vector paint certificate for the second caption: %s',
  async (change) => {
    const f = await isolatedPlotCaption(true, true)
    try {
      const ops = await f.native.getOperatorList(),
        begin = ops.fnArray.flatMap((op, i) => (op === OPS.paintFormXObjectBegin ? [i] : []))[1],
        end = ops.fnArray.findIndex((op, i) => i > begin && op === OPS.paintFormXObjectEnd),
        fill = ops.fnArray.findIndex(
          (op, i) =>
            i > begin && i < end && op === OPS.constructPath && ops.argsArray[i][0] === OPS.fill
        )
      if (change.startsWith('gstate-')) {
        const key = change === 'gstate-line-cap' ? 'LC' : change === 'gstate-line-join' ? 'LJ' : 'D'
        ops.fnArray.splice(begin + 1, 0, OPS.setGState)
        ops.argsArray.splice(begin + 1, 0, [[[key, key === 'D' ? [[NaN], 0] : 99]]])
      }
      if (change === 'one-ulp' || change === 'minmax-mismatch') {
        const bounds = ops.argsArray[fill][2]
        bounds[2] += change === 'one-ulp' ? 2 ** (Math.floor(Math.log2(bounds[2])) - 23) : 1
      }
      if (change === 'nonrectangular-clip') {
        const clip = ops.fnArray.findIndex(
          (op, i) =>
            i > begin && i < end && op === OPS.constructPath && ops.argsArray[i][0] === OPS.endPath
        )
        ops.argsArray[clip][1][0][10] += 1
      }
      if (change === 'transparent-vector') {
        for (let i = begin; i < end; i++)
          if (ops.fnArray[i] === OPS.setGState)
            for (const entry of ops.argsArray[i][0])
              if (entry[0] === 'ca' || entry[0] === 'CA') entry[1] = 0
        ops.fnArray.splice(begin + 1, 0, OPS.setGState)
        ops.argsArray.splice(begin + 1, 0, [
          [
            ['ca', 0],
            ['CA', 0]
          ]
        ])
      }
      if (change === 'no-filled-rectangle')
        for (let i = begin; i < end; i++)
          if (ops.fnArray[i] === OPS.setFillRGBColor) ops.argsArray[i][0] = '#ffffff'
      if (change === 'no-straight-stroke') {
        const line = ops.fnArray.findIndex(
            (op, i) =>
              i > begin &&
              i < end &&
              op === OPS.constructPath &&
              ops.argsArray[i][0] === OPS.stroke &&
              ops.argsArray[i][1][0].length === 6
          ),
          path = ops.argsArray[line][1][0],
          bounds = ops.argsArray[line][2]
        path[4] = path[1]
        path[5] = path[2]
        bounds.set([path[1], path[2], path[1], path[2]])
      }
      const result = await applyCachedPdfFigureSources(f.args),
        unit = result.source.units.find((unit) => unit.id === 'network-caption')!
      if (change === 'one-ulp') expect(unit.sourceOnly).toBeUndefined()
      else expect(unit).toMatchObject({ sourceOnly: true, preserve: 'reference' })
      expect(result.coverage).toEqual(f.extraction.coverage)
    } finally {
      await f.loading.destroy()
    }
  }
)

it('keeps the second caption conservative when one auxiliary render cannot rebind its original operators', async () => {
  const f = await isolatedPlotCaption(true, true),
    has = f.native.commonObjs.has.bind(f.native.commonObjs)
  let renders = 0,
    destroyed = 0
  vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
  try {
    f.native.commonObjs.has = (key) => !key.includes('_path_') && has(key)
    const factory = vi.fn((params: Parameters<typeof getDocument>[0]) => {
      const owned = getDocument(params),
        destroy = owned.destroy.bind(owned)
      void owned.promise
        .then((document) => {
          const getPage = document.getPage.bind(document),
            seen = new WeakSet()
          document.getPage = async (number) => {
            const page = await getPage(number)
            if (!seen.has(page)) {
              seen.add(page)
              const render = page.render.bind(page)
              page.render = (...args) => {
                renders++
                return render(...args)
              }
            }
            return page
          }
        })
        .catch(() => undefined)
      owned.destroy = async () => {
        await destroy()
        destroyed++
      }
      return owned
    })
    const result = await applyCachedPdfFigureSources({ ...f.args, nativeDocumentFactory: factory })
    expect(factory).toHaveBeenCalledTimes(1)
    expect(renders).toBe(1)
    expect(destroyed).toBe(1)
    expect(result.source.units.find((unit) => unit.id === 'caption')?.sourceOnly).toBeUndefined()
    expect(result.source.units.find((unit) => unit.id === 'network-caption')).toMatchObject({
      sourceOnly: true,
      preserve: 'reference'
    })
    expect(result.coverage).toEqual(f.extraction.coverage)
  } finally {
    vi.unstubAllGlobals()
    await f.loading.destroy()
  }
})

it('keeps native-proved caption admission through repeated content policy and local source reconstruction', async () => {
  const f = await isolatedPlotCaption(true)
  try {
    const result = await applyCachedPdfFigureSources(f.args)
    const caption = result.source.units.find((unit) => unit.id === 'caption')!
    expect(caption.sourceOnly).toBeUndefined()
    const prepared = applyPdfContentFirstPolicy(result.source)
    expect(prepared.units.find((unit) => unit.id === caption.id)).toEqual(caption)
    expect(pdfReflowContentKinds(prepared).get(caption.id)).toBe('text')
    expect(applyPdfContentFirstPolicy(createPdfTranslationSource(prepared))).toEqual(prepared)
    for (const input of [result, { ...result, source: prepared }]) {
      const projected = await applyCachedPdfStructureSources({
        ...f.args,
        extraction: input,
        preserveUnitIdentity: true
      })
      const figures = await preservePdfFigureSources({
        document: f.args.document,
        extraction: projected.extraction,
        operators: OPS,
        signal: f.args.signal
      })
      const displayed = applyPdfContentFirstPolicy(figures.source)
      expect(displayed.units.find((unit) => unit.id === caption.id)).toEqual(caption)
      expect(pdfReflowContentKinds(displayed).get(caption.id)).toBe('text')
    }
    const exterior = prepared.units.find(
      (unit) => unit.source === 'Other prose remains unchanged.'
    )!
    expect(exterior).toMatchObject({ sourceOnly: true, preserve: 'reference' })
  } finally {
    await f.loading.destroy()
  }
})

it.each([
  'json',
  'caption-ref',
  'other-unit-ref',
  'order',
  'native-index',
  'literal',
  'resource',
  'fingerprint',
  'pages-ref'
])(
  'does not transfer native caption admission through an unproved Source change: %s',
  async (change) => {
    const f = await isolatedPlotCaption(true)
    try {
      const result = await applyCachedPdfFigureSources(f.args),
        source = result.source
      let input: Parameters<typeof createPdfTranslationSource>[0] = { ...source }
      if (change === 'json') input = JSON.parse(JSON.stringify(source))
      if (change === 'caption-ref' || change === 'other-unit-ref')
        input = {
          ...source,
          units: source.units.map((unit) =>
            (change === 'caption-ref' ? unit.id === 'caption' : unit.source === 'References')
              ? { ...unit }
              : unit
          )
        }
      if (change === 'order')
        input = { ...source, units: [source.units[0], ...source.units.slice(1).toReversed()] }
      if (change === 'native-index')
        input = {
          ...source,
          units: source.units.map((unit) =>
            unit.id !== 'caption'
              ? unit
              : {
                  ...unit,
                  fragments: unit.fragments.map((fragment) => ({
                    ...fragment,
                    items: fragment.items.map((item) => ({ ...item, index: item.index + 1 }))
                  }))
                }
          )
        }
      if (change === 'literal')
        input = {
          ...source,
          units: source.units.map((unit) =>
            unit.id === 'caption'
              ? { ...unit, source: unit.source.replace('Measurements', 'References') }
              : unit
          )
        }
      if (change === 'resource') input = { ...source, resourceRequestKey: 'another-source' }
      if (change === 'fingerprint') input = { ...source, fingerprint: 'another-fingerprint' }
      if (change === 'pages-ref')
        input = { ...source, pages: source.pages.map((page) => ({ ...page })) }
      const restored = createPdfTranslationSource(input),
        caption = restored.units.find((unit) => unit.id === 'caption')!
      expect(pdfReflowContentKinds(restored).get(caption.id)).toBe('reference')
      expect(
        applyPdfContentFirstPolicy(restored).units.find((unit) => unit.id === caption.id)
      ).toMatchObject({ sourceOnly: true, preserve: 'reference' })
    } finally {
      await f.loading.destroy()
    }
  }
)

it.each([
  'competing-caption',
  'second-source-claim',
  'foreign-region',
  'hidden-caption',
  'transparent-raster'
])('keeps a reference caption when isolated native ownership fails: %s', async (failure) => {
  const f = await isolatedPlotCaption()
  try {
    const target = f.cached.elements[0]
    if (failure === 'competing-caption')
      f.cached.elements.push({ ...structuredClone(target), id: 'competing' })
    if (failure === 'second-source-claim')
      f.cached.elements[1].sourceItems = f.extraction.source.units[0].fragments[0].items.map(
        (i) => ({ pageNumber: 1, ...i })
      )
    if (failure === 'foreign-region')
      f.cached.elements[1].regions = structuredClone(target.caption!.regions)
    const operators = await f.native.getOperatorList()
    if (failure === 'hidden-caption') {
      const at = operators.fnArray.indexOf(OPS.beginText)
      operators.fnArray.splice(at, 0, OPS.setTextRenderingMode)
      operators.argsArray.splice(at, 0, [3])
    }
    if (failure === 'transparent-raster') {
      const at = operators.fnArray.indexOf(OPS.paintImageXObject)
      const image = f.native.objs.get(operators.argsArray[at][0])
      image.kind = 3
      image.data = new Uint8ClampedArray(image.width * image.height * 4)
    }
    const factory = vi.fn(getDocument)
    const result = await applyCachedPdfFigureSources({ ...f.args, nativeDocumentFactory: factory })
    expect(result.source).toEqual(f.extraction.source)
    expect(result.coverage).toEqual(f.extraction.coverage)
    expect(factory).not.toHaveBeenCalled()
  } finally {
    await f.loading.destroy()
  }
})

it('refuses an equal-valued branded Source replacement through a mutable extraction alias', async () => {
  const f = await isolatedPlotCaption()
  try {
    const subject = { ...f.extraction },
      getOperators = f.native.getOperatorList.bind(f.native)
    let replaced = false
    f.native.getOperatorList = async (...args) => {
      const operators = await getOperators(...args)
      if (!replaced) {
        replaced = true
        subject.source = createPdfTranslationSource({ ...subject.source })
      }
      return operators
    }
    const result = await applyCachedPdfFigureSources({ ...f.args, extraction: subject })
    expect(replaced).toBe(true)
    expect(result.source).toEqual(f.extraction.source)
    expect(result.source.units[0]).toMatchObject({ sourceOnly: true, preserve: 'reference' })
  } finally {
    await f.loading.destroy()
  }
})

it('refuses duplicated Source unit identities before restoring any reference caption', async () => {
  const f = await isolatedPlotCaption()
  try {
    const units = [...f.extraction.source.units]
    units[1] = { ...units[1], id: units[0].id, sourceOnly: true, preserve: 'reference' }
    const extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({ ...f.extraction.source, units })
    }
    const result = await applyCachedPdfFigureSources({ ...f.args, extraction })
    expect(result.source).toEqual(extraction.source)
  } finally {
    await f.loading.destroy()
  }
})

it.each([
  'image-byte',
  'form-bbox',
  'operator-ref',
  'font-byte',
  'font-data-ref',
  'font-bbox-ref',
  'glyph-path-ref',
  'glyph-path-byte',
  'source-root-ref'
])('rechecks %s synchronously after the final image digest await', async (change) => {
  const f = await isolatedPlotCaption()
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle),
    subject = { ...f.extraction }
  let hashes = 0,
    mutations = 0
  try {
    const operators = await f.native.getOperatorList()
    const imageOperations = operators.fnArray.flatMap((op, i) =>
      op === OPS.paintImageXObject ? [i] : []
    )
    const first = f.native.objs.get(operators.argsArray[imageOperations[0]][0])
    const second = f.native.objs.get(operators.argsArray[imageOperations[1]][0])
    const content = await f.native.getTextContent()
    const prefix = content.items.find(
      (item) => 'str' in item && item.str === 'Figure 1:'
    ) as TextItem
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => {
      const result = await digest(algorithm, bytes)
      if (bytes.byteLength === second.data.byteLength && ++hashes === 4) {
        if (change === 'image-byte') first.data[0] ^= 1
        if (change === 'form-bbox')
          operators.argsArray[operators.fnArray.indexOf(OPS.paintFormXObjectBegin)][1][2] -= 1
        if (change === 'operator-ref') operators.argsArray = [...operators.argsArray]
        if (change === 'font-byte') f.native.commonObjs.get(prefix.fontName).data[0] ^= 1
        if (change === 'font-data-ref') {
          const font = f.native.commonObjs.get(prefix.fontName),
            data = font.data
          Object.defineProperty(font, 'data', {
            value: new Uint8Array(data.buffer, data.byteOffset, data.length),
            configurable: true
          })
        }
        if (change === 'font-bbox-ref') {
          const font = f.native.commonObjs.get(prefix.fontName)
          Object.defineProperty(font, 'bbox', { value: [...font.bbox], configurable: true })
        }
        if (change === 'glyph-path-ref' || change === 'glyph-path-byte') {
          const glyph = operators.argsArray
            .flatMap((args) => (Array.isArray(args?.[0]) ? args[0] : []))
            .find((g) => g?.unicode === 'F')
          const owner = f.native.commonObjs.get(prefix.fontName + '_path_' + glyph.fontChar)
          if (change === 'glyph-path-ref')
            Object.defineProperty(owner, 'path', {
              value: owner.path.slice(),
              configurable: true
            })
          else owner.path[1] += 1
        }
        if (change === 'source-root-ref')
          subject.source = createPdfTranslationSource({ ...subject.source })
        mutations++
      }
      return result
    })
    const result = await applyCachedPdfFigureSources({ ...f.args, extraction: subject })
    expect(mutations).toBe(1)
    expect(hashes).toBe(4)
    expect(result.source).toEqual(f.extraction.source)
  } finally {
    vi.restoreAllMocks()
    await f.loading.destroy()
  }
})

it.each([false, true])(
  'commits only after owned caption cleanup, replaced Source: %s',
  async (replace) => {
    const f = await isolatedPlotCaption()
    const subject = { ...f.extraction },
      actualHas = f.native.commonObjs.has.bind(f.native.commonObjs)
    let destroyed = 0
    vi.stubGlobal('document', { createElement: () => createCanvas(1, 1) })
    try {
      f.native.commonObjs.has = (key) => !key.includes('_path_') && actualHas(key)
      const factory = vi.fn((params: Parameters<typeof getDocument>[0]) => {
        const owned = getDocument(params),
          destroy = owned.destroy.bind(owned)
        owned.destroy = async () => {
          await destroy()
          destroyed++
          if (replace) subject.source = createPdfTranslationSource({ ...subject.source })
        }
        return owned
      })
      const result = await applyCachedPdfFigureSources({
        ...f.args,
        extraction: subject,
        nativeDocumentFactory: factory
      })
      expect(factory).toHaveBeenCalledTimes(1)
      expect(destroyed).toBe(1)
      if (replace) expect(result.source).toEqual(f.extraction.source)
      else {
        const caption = { ...f.extraction.source.units[0] }
        delete caption.sourceOnly
        delete caption.preserve
        expect(result.source.units).toEqual([caption, ...f.extraction.source.units.slice(1)])
      }
    } finally {
      vi.unstubAllGlobals()
      await f.loading.destroy()
    }
  }
)
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import {
  createNativeRuledAlgorithmCaptionReader,
  nativeRuledAlgorithmCaptionBlock
} from '../../src/reader/ruled-algorithm-packets.js'

async function anonymousRuledCaption(fault = '') {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(
    await readFile(
      path.join(
        path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
        'standard_fonts/LiberationSans-Regular.ttf'
      )
    ),
    { subset: false }
  )
  const page = pdf.addPage([600, 800])
  page.drawText('Register the embedded font.', { x: 50, y: 750, size: 10, font })
  const fontKey = page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys()[0].toString()
  const show = (s: string, x: number, y: number, size = 10) =>
    `BT ${fontKey} ${size} Tf ${x} ${y} Td ${font.encodeText(s).toString()} Tj ET`
  const foreign = pdf.context.register(
    pdf.context.flateStream(`q 0 0 0 rg 4 4 80 12 re f ${show('Independent plot.', 4, 24, 8)} Q`, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 120, 40],
      Resources: page.node.Resources()
    })
  )
  page.node.Resources()!.set(PDFName.of('XObject'), pdf.context.obj({ Foreign: foreign }))
  const rule = (y: number, white = false) =>
    `q ${white ? '1 1 1' : '0 0 0'} RG 0.5 w 50 ${y} m 280 ${y} l S Q`
  const body = [
    show('Require:', 50, 440, 9.2),
    show('a complete native packet', 92, 440, 9),
    show('Ensure:', 50, 428, 9.2),
    show('an independently checked result', 92, 428, 9),
    ...Array.from({ length: 8 }, (_, i) => [
      show(`${i + 1}:`, 56, 410 - i * 15, 8),
      show(i === 0 ? 'for' : i === 7 ? 'return' : 'if', 78, 410 - i * 15, 9.2),
      show(
        i === 0
          ? 'each candidate do'
          : i === 7
            ? 'the result'
            : 'a measurement is valid then retain it',
        i === 7 ? 112 : 98,
        410 - i * 15,
        9
      )
    ]).flat()
  ]
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(
      pdf.context.flateStream(
        [
          `q 1 0 0 1 50 ${fault === 'foreign-overlap' ? 450 : 650} cm /Foreign Do Q`,
          rule(500),
          show('Algorithm 1 Pick a stable candidate.', 50, 486),
          show('Use complete measurements for each candidate,', 50, 474),
          show('then report the independently checked result.', 50, 462),
          ...(fault === 'missing-divider' ? [] : [rule(450, fault === 'white-divider')]),
          ...body,
          rule(270),
          show('Ordinary text after the closed algorithm remains independent.', 50, 240)
        ].join('\n')
      )
    )
  )
  const bytes = await pdf.save(),
    task = getDocument({
      data: bytes.slice(),
      fontExtraProperties: true,
      disableFontFace: true,
      isEvalSupported: false
    })
  return { task, bytes, document: await task.promise }
}

it('translates only a complete native algorithm caption continuation without regrouping its source', async () => {
  const f = await anonymousRuledCaption()
  try {
    const extraction = await extractPdfTranslationSource({
        document: f.document,
        resourceRequestKey: 'anonymous-algorithm',
        signal: new AbortController().signal
      }),
      caption = extraction.source.units.find((u) =>
        u.source.startsWith('Use complete measurements')
      )!
    expect(caption).toBeDefined()
    expect(caption.sourceOnly).toBeUndefined()
    expect(caption.preserve).toBeUndefined()
    expect(
      extraction.source.units.some(
        (u) => u.preserve === 'code' && u.source.includes('return the result')
      )
    ).toBe(true)
    expect(pdfReflowContentKinds(extraction.source).get(caption.id)).toBe('text')
  } finally {
    await f.task.destroy()
  }
})
it.each(['missing-divider', 'white-divider', 'foreign-overlap'])(
  'retains the original listing when native caption proof has %s',
  async (fault) => {
    const f = await anonymousRuledCaption(fault)
    try {
      const extraction = await extractPdfTranslationSource({
          document: f.document,
          resourceRequestKey: 'anonymous-algorithm',
          signal: new AbortController().signal
        }),
        caption = extraction.source.units.find((u) =>
          u.source.startsWith('Use complete measurements')
        )!
      expect(caption).toBeDefined()
      expect(caption).toMatchObject({ sourceOnly: true, preserve: 'code' })
    } finally {
      await f.task.destroy()
    }
  }
)
it.each([
  'equal-content-replacement',
  'raw-array-length',
  'unreliable-member',
  'viewport-change',
  'raw-prototype',
  'raw-nonenumerable',
  'operator-budget',
  'unknown-operator'
])('rejects stale native caption evidence across the operators await: %s', async (fault) => {
  const f = await anonymousRuledCaption()
  try {
    const page = await f.document.getPage(1),
      content = await page.getTextContent(),
      viewport = page.getViewport({ scale: 1 }),
      rawPage = {
        page: 1,
        width: viewport.width,
        height: viewport.height,
        rotation: 0,
        items: content.items.map((i) =>
          'str' in i
            ? {
                ...i,
                fontAscent: content.styles[i.fontName].ascent,
                fontDescent: content.styles[i.fontName].descent,
                fontVertical: false
              }
            : { str: '', width: 0, height: 0, transform: [0, 0, 0, 0, 0, 0] }
        )
      },
      unreliable = new Set<number>(),
      index = content.items.findIndex(
        (i) => 'str' in i && i.str.startsWith('Use complete measurements')
      ),
      input = { page, content, viewport, rawPage, unreliable } as Parameters<
        ReturnType<typeof createNativeRuledAlgorithmCaptionReader>['observe']
      >[0]
    const getOperators = page.getOperatorList.bind(page)
    page.getOperatorList = async () => {
      const value = await getOperators()
      if (fault === 'operator-budget')
        return {
          ...value,
          fnArray: new Array(100001).fill(OPS.dependency),
          argsArray: new Array(100001).fill([])
        }
      if (fault === 'unknown-operator')
        return {
          ...value,
          fnArray: [...value.fnArray, OPS.beginGroup],
          argsArray: [...value.argsArray, []]
        }
      if (fault === 'equal-content-replacement') content.items[index] = { ...content.items[index] }
      if (fault === 'raw-array-length') rawPage.items.length++
      if (fault === 'unreliable-member') unreliable.add(index)
      if (fault === 'viewport-change') viewport.width++
      if (fault === 'raw-prototype')
        Object.setPrototypeOf(rawPage.items, Object.create(Array.prototype))
      if (fault === 'raw-nonenumerable')
        Object.defineProperty(rawPage, 'unobserved', { value: true })
      return value
    }
    await createNativeRuledAlgorithmCaptionReader({
      document: f.document,
      signal: new AbortController().signal
    }).observe(input)
    expect(
      nativeRuledAlgorithmCaptionBlock(input.rawPage, [
        { index, str: (content.items[index] as TextItem).str }
      ])
    ).toBe(false)
  } finally {
    await f.task.destroy()
  }
})
it('keeps a native caption proof live through cleanup and never grants it to a cloned raw page', async () => {
  const f = await anonymousRuledCaption()
  try {
    const page = await f.document.getPage(1),
      content = await page.getTextContent(),
      viewport = page.getViewport({ scale: 1 }),
      rawPage = {
        page: 1,
        width: viewport.width,
        height: viewport.height,
        rotation: 0,
        items: content.items.map((i) =>
          'str' in i
            ? {
                ...i,
                fontAscent: content.styles[i.fontName].ascent,
                fontDescent: content.styles[i.fontName].descent,
                fontVertical: false
              }
            : { str: '', width: 0, height: 0, transform: [0, 0, 0, 0, 0, 0] }
        )
      },
      unreliable = new Set<number>(),
      input = { page, content, viewport, rawPage, unreliable } as Parameters<
        ReturnType<typeof createNativeRuledAlgorithmCaptionReader>['observe']
      >[0],
      index = content.items.findIndex(
        (i) => 'str' in i && i.str.startsWith('Use complete measurements')
      ),
      block = [{ index, str: (content.items[index] as TextItem).str }]
    await createNativeRuledAlgorithmCaptionReader({
      document: f.document,
      signal: new AbortController().signal
    }).observe(input)
    expect(nativeRuledAlgorithmCaptionBlock(input.rawPage, block)).toBe(true)
    page.cleanup()
    expect(nativeRuledAlgorithmCaptionBlock(input.rawPage, block)).toBe(true)
    expect(nativeRuledAlgorithmCaptionBlock(structuredClone(input.rawPage), block)).toBe(false)
    unreliable.add(index)
    expect(nativeRuledAlgorithmCaptionBlock(input.rawPage, block)).toBe(false)
  } finally {
    await f.task.destroy()
  }
})
