/* eslint-disable @typescript-eslint/explicit-function-return-type -- inferred test fixture types */
import { expect, it, vi } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import { applyCachedPdfFigureSources } from '../../src/reader/figure-source.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'
import type { PdfTranslationExtraction } from '../../src/reader/extraction.js'

function setup(kind: 'math-table' | 'algorithm' = 'math-table') {
  const sourceIdentity = { sourceChecksum: 'a'.repeat(64), sourceSizeBytes: 100 }
  const item = (str: string, x: number, y: number, width = 20) => ({
    str,
    dir: 'ltr',
    fontName: 'f',
    transform: [10, 0, 0, 10, x, y],
    width,
    height: 10
  })
  const items = [
    item('x + y', 10, 65),
    item('Return x', 40, 50),
    item('Body caption', 10, 85),
    item('External prose', 10, 15)
  ]
  const unit = (index: number, id: string) => ({
    id,
    source: items[index].str,
    fragments: [
      {
        pageNumber: 1,
        rect: {
          x: items[index].transform[4] / 100,
          y: (92 - items[index].transform[5]) / 100,
          width: items[index].width / 100,
          height: 0.1
        },
        items: [{ index, text: items[index].str }]
      }
    ]
  })
  const extraction: PdfTranslationExtraction = {
    source: createPdfTranslationSource({
      resourceRequestKey: 'body-test',
      fingerprint: 'fingerprint',
      pages: [{ width: 100, height: 100 }],
      units: [
        unit(0, 'first'),
        { ...unit(1, 'second'), sourceOnly: true },
        unit(2, 'caption'),
        unit(3, 'prose')
      ]
    }),
    coverage: {
      pageCount: 1,
      textItemCount: 4,
      includedItemCount: 4,
      excludedItemCount: 0,
      pagesWithoutText: [],
      exclusions: [],
      warnings: [{ unitId: 'second', reasons: ['formula-extraction'] }]
    }
  }
  const cached: PdfStructureResult = {
    schemaVersion: 1,
    extractionId: 'cached-body',
    engineFingerprint: 'b'.repeat(64),
    ...sourceIdentity,
    pageCount: 1,
    requestedPages: [1],
    processedPages: [1],
    pages: [{ page: 1, width: 100, height: 100, rotation: 0 }],
    elements: [
      {
        id: 'native-body',
        kind: kind === 'math-table' ? 'table' : 'algorithm',
        regions: [{ page: 1, x: 0.05, y: 0.05, width: 0.7, height: 0.55 }],
        caption: {
          text: 'Body caption',
          regions: [{ page: 1, x: 0.05, y: 0.05, width: 0.7, height: 0.15 }]
        },
        issues:
          kind === 'math-table'
            ? [{ code: 'no-source-cell-grid', detail: 'no-source-cell-grid' }]
            : [],
        nativeBody: {
          kind,
          sourceItems: [0, 1].map((index) => ({ pageNumber: 1, index, text: items[index].str }))
        }
      }
    ],
    thumbnails: [],
    navigation: [],
    issues: []
  }
  const page = {
    getViewport: vi.fn(() => ({
      width: 100,
      height: 100,
      convertToViewportPoint: (x: number, y: number) => [x, 100 - y]
    })),
    getTextContent: vi.fn(async () => ({ items, styles: {} }))
  }
  const document = { numPages: 1, fingerprints: ['fingerprint'], getPage: vi.fn(async () => page) },
    controller = new AbortController()
  const context = {
    extraction,
    document: document as unknown as PDFDocumentProxy,
    sourceId: 'body',
    sourceIdentity,
    signal: controller.signal,
    readCached: vi.fn(async () => cached)
  }
  return { context, extraction, cached, items, item, unit, controller, page }
}

it.each(['math-table', 'algorithm'] as const)(
  'retains the complete %s body without changing original text, caption or prose',
  async (kind) => {
    const f = setup(kind),
      before = structuredClone(f.cached)
    const result = await applyCachedPdfFigureSources(f.context)
    expect(result.source.units).toEqual(
      f.extraction.source.units.map((u, i) => (i === 0 ? { ...u, sourceOnly: true } : u))
    )
    expect(result.coverage).toEqual(
      kind === 'algorithm'
        ? f.extraction.coverage
        : {
            ...f.extraction.coverage,
            warnings: [
              { unitId: 'second', reasons: ['formula-extraction', 'table-structure-unreliable'] },
              { unitId: 'first', reasons: ['table-structure-unreliable'] }
            ]
          }
    )
    expect(f.cached).toEqual(before)
    expect(f.extraction.source.units[0].sourceOnly).toBeUndefined()
    expect(f.context.readCached).toHaveBeenCalledTimes(1)
  }
)

it.each([
  'missing-claim',
  'mixed-owner',
  'wrong-native-text',
  'wrong-claim',
  'outside-native',
  'caption-crossing',
  'claimed-caption',
  'competing-region',
  'unknown-geometry',
  'stale-cache'
])('rejects the entire body when evidence is incomplete: %s', async (variant) => {
  const f = setup(),
    body = f.cached.elements[0]
  if (variant === 'missing-claim') body.nativeBody!.sourceItems.pop()
  if (variant === 'mixed-owner')
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: [
          {
            ...f.extraction.source.units[0],
            source: 'x + y External prose',
            fragments: [
              ...f.extraction.source.units[0].fragments,
              ...f.extraction.source.units[3].fragments
            ]
          },
          ...f.extraction.source.units.slice(1, 3)
        ]
      })
    }
  if (variant === 'wrong-native-text') f.items[0].str = 'Different'
  if (variant === 'wrong-claim') body.nativeBody!.sourceItems[0].text = 'Different'
  if (variant === 'outside-native') f.items[0].transform[4] = 80
  if (variant === 'caption-crossing') body.caption!.regions[0].height = 0.08
  if (variant === 'claimed-caption')
    body.nativeBody!.sourceItems.push({ pageNumber: 1, index: 2, text: f.items[2].str })
  if (variant === 'competing-region')
    f.cached.elements.push({
      id: 'other',
      kind: 'figure',
      issues: [],
      regions: [{ page: 1, x: 0.1, y: 0.25, width: 0.3, height: 0.15 }]
    })
  if (variant === 'unknown-geometry') f.items[3].width = 0
  if (variant === 'stale-cache') f.cached.sourceChecksum = 'c'.repeat(64)
  expect(await applyCachedPdfFigureSources(f.context)).toBe(f.context.extraction)
})

it('rejects one incomplete body without blocking an independently proved body', async () => {
  const f = setup()
  f.cached.elements[0].nativeBody!.sourceItems.pop()
  f.items.push(f.item('Step', 80, 65, 10), f.item('Title', 80, 85, 10))
  f.context.extraction = {
    ...f.extraction,
    source: createPdfTranslationSource({
      ...f.extraction.source,
      units: [
        ...f.extraction.source.units,
        f.unit(4, 'independent'),
        f.unit(5, 'independent-caption')
      ]
    }),
    coverage: { ...f.extraction.coverage, textItemCount: 6, includedItemCount: 6 }
  }
  f.cached.elements.push({
    id: 'independent-body',
    kind: 'algorithm',
    issues: [],
    regions: [{ page: 1, x: 0.78, y: 0.05, width: 0.2, height: 0.55 }],
    caption: { text: 'Title', regions: [{ page: 1, x: 0.78, y: 0.05, width: 0.2, height: 0.15 }] },
    nativeBody: { kind: 'algorithm', sourceItems: [{ pageNumber: 1, index: 4, text: 'Step' }] }
  })
  const result = await applyCachedPdfFigureSources(f.context)
  expect(result.source.units).toEqual(
    f.context.extraction.source.units.map((u) =>
      u.id === 'independent' ? { ...u, sourceOnly: true } : u
    )
  )
  expect(result.coverage).toEqual(f.context.extraction.coverage)
})

it('propagates cancellation during body verification', async () => {
  const f = setup()
  f.page.getTextContent.mockImplementationOnce(async () => {
    f.controller.abort()
    return { items: f.items, styles: {} }
  })
  await expect(applyCachedPdfFigureSources(f.context)).rejects.toThrow()
})

function zeroAdvanceEvidence() {
  const f = setup('algorithm')
  f.items[3].width = 0
  const font = {
    loadedName: 'f',
    missingFile: false,
    isInvalidPDFjsFont: false,
    vertical: false,
    isType3Font: false,
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0]
  }
  const glyph = { unicode: 'External prose', fontChar: 'z', width: 0, isInFont: true, accent: null }
  const outline = { path: [0, 0, 0, 1, 0.5, 0, 1, 0.5, 0.7, 1, 0, 0.7, 4] }
  const objects = new Map<string, unknown>([
    ['f', font],
    ['f_path_z', outline]
  ])
  const operators = { fnArray: [OPS.setFont, OPS.showText], argsArray: [['f', 10], [[glyph]]] }
  Object.assign(f.page, {
    commonObjs: { has: (key: string) => objects.has(key), get: (key: string) => objects.get(key) },
    getOperatorList: vi.fn(async () => operators)
  })
  return { ...f, font, glyph, outline, objects, operators }
}

it('uses a complete native glyph outline only to exclude an unclaimed zero-advance item', async () => {
  const f = zeroAdvanceEvidence()
  const result = await applyCachedPdfFigureSources(f.context)
  expect(result.source.units).toEqual(
    f.extraction.source.units.map((u, i) => (i === 0 ? { ...u, sourceOnly: true } : u))
  )
  expect(result.coverage).toEqual(f.extraction.coverage)
})

it.each([
  'missing-outline',
  'ambiguous-glyph',
  'stroke',
  'clip',
  'font-fallback',
  'remeasure',
  'accent',
  'mirror',
  'inside',
  'claimed',
  'other-owner',
  'outline-crossing',
  'gstate',
  'wrong-unicode'
])('keeps the whole body unchanged for unproved zero-advance exclusion: %s', async (variant) => {
  const f = zeroAdvanceEvidence()
  if (variant === 'missing-outline') f.objects.delete('f_path_z')
  if (variant === 'ambiguous-glyph')
    f.operators.argsArray[1] = [[f.glyph, { ...f.glyph, fontChar: 'q' }]]
  if (variant === 'stroke' || variant === 'clip') {
    f.operators.fnArray.splice(1, 0, variant === 'stroke' ? OPS.setTextRenderingMode : OPS.clip)
    f.operators.argsArray.splice(1, 0, [1])
  }
  if (variant === 'font-fallback') f.font.missingFile = true
  if (variant === 'remeasure') Object.assign(f.font, { remeasure: true })
  if (variant === 'accent')
    Object.assign(f.glyph, { accent: { fontChar: 'a', offset: { x: 0, y: 0 } } })
  if (variant === 'mirror') f.items[3].transform[0] = -10
  if (variant === 'outline-crossing') f.outline.path = [0, 0, 0, 1, 0.5, 0, 1, 0.5, 4, 1, 0, 4, 4]
  if (variant === 'wrong-unicode') f.glyph.unicode = 'Different'
  if (variant === 'gstate') {
    f.operators.fnArray.splice(1, 0, OPS.setGState)
    f.operators.argsArray.splice(1, 0, [])
  }
  if (variant === 'inside') f.items[3].transform[5] = 60
  if (variant === 'claimed')
    f.cached.elements[0].nativeBody!.sourceItems.push({
      pageNumber: 1,
      index: 3,
      text: f.items[3].str
    })
  if (variant === 'other-owner')
    f.context.extraction = {
      ...f.extraction,
      source: createPdfTranslationSource({
        ...f.extraction.source,
        units: f.extraction.source.units.map((u, i) =>
          i === 2
            ? { ...u, fragments: u.fragments.map((g) => ({ ...g, rect: { ...g.rect, y: 0.8 } })) }
            : u
        )
      })
    }
  expect(await applyCachedPdfFigureSources(f.context)).toEqual(f.context.extraction)
})

// Only a complete verified algorithm can give its whole caption a translation contract.
function protectedAlgorithmCaption() {
  const f = setup('algorithm'),
    label = f.items[2]
  label.str = 'Algorithm S2'
  label.width = 20
  const title = {
    ...f.item('Update values with bounded iterations', 31.6, 85, 42),
    fontName: 'title'
  }
  f.items.push(title)
  const text = label.str + ' ' + title.str
  f.cached.elements[0].caption!.text = text
  f.context.extraction = {
    ...f.extraction,
    source: createPdfTranslationSource({
      ...f.extraction.source,
      units: f.extraction.source.units.map((u, i) =>
        i !== 2
          ? u
          : {
              ...u,
              source: text,
              sourceOnly: true,
              fragments: [
                {
                  ...u.fragments[0],
                  rect: { ...u.fragments[0].rect, width: 0.636 },
                  items: [
                    { index: 2, text: label.str },
                    { index: 4, text: title.str }
                  ]
                }
              ]
            }
      )
    }),
    coverage: { ...f.extraction.coverage, textItemCount: 5, includedItemCount: 5 }
  }
  const styles: Record<
    string,
    { fontFamily: string; ascent: number; descent: number; vertical: boolean }
  > = {
    f: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false },
    title: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false }
  }
  f.page.getTextContent.mockImplementation(async () => ({ items: f.items, styles }))
  f.page.getViewport.mockImplementation(() => ({
    width: 100,
    height: 100,
    rotation: 0,
    scale: 1,
    transform: [1, 0, 0, -1, 0, 100],
    convertToViewportPoint: (x: number, y: number) => [x, 100 - y]
  }))
  return { ...f, styles }
}
it('restores only a complete native prose algorithm caption after full body verification', async () => {
  const f = protectedAlgorithmCaption(),
    before = structuredClone(f.cached)
  const result = await applyCachedPdfFigureSources(f.context)
  expect(result.source.units).toEqual(
    f.context.extraction.source.units.map((u, i) => {
      if (i === 0) return { ...u, sourceOnly: true }
      if (i !== 2) return u
      const caption = { ...u }
      delete caption.sourceOnly
      return caption
    })
  )
  expect(result.coverage).toEqual(f.context.extraction.coverage)
  expect(f.cached).toEqual(before)
  expect(f.context.extraction.source.units[2].sourceOnly).toBe(true)
})
it.each([
  'missing-body',
  'duplicate-body-claim',
  'literal',
  'font-metrics',
  'font-height',
  'unicode',
  'warning',
  'math-caption',
  'foreign-native',
  'mixed-owner',
  'competing-region',
  'figure-claim',
  'mixed-math-run'
])('keeps a protected algorithm caption without complete %s evidence', async (mode) => {
  const f = protectedAlgorithmCaption(),
    e = f.cached.elements[0]
  if (mode === 'missing-body') e.nativeBody!.sourceItems.pop()
  if (mode === 'duplicate-body-claim') e.nativeBody!.sourceItems.push(e.nativeBody!.sourceItems[0])
  if (mode === 'literal') e.caption!.text += ' Other'
  if (mode === 'font-metrics') delete (f.styles.title as Partial<(typeof f.styles)['title']>).ascent
  if (mode === 'font-height') f.items[4].height = 9
  if (mode === 'unicode')
    f.context.extraction = {
      ...f.context.extraction,
      coverage: {
        ...f.context.extraction.coverage,
        pageDiagnostics: [{ pageNumber: 1, reason: 'unreliable-font-unicode' }]
      }
    }
  if (mode === 'warning')
    f.context.extraction = {
      ...f.context.extraction,
      coverage: {
        ...f.context.extraction.coverage,
        warnings: [
          ...f.context.extraction.coverage.warnings,
          { unitId: 'caption', reasons: ['formula-extraction'] }
        ]
      }
    }
  if (mode === 'math-caption') {
    e.caption!.text += ' x = y'
    f.context.extraction = {
      ...f.context.extraction,
      source: createPdfTranslationSource({
        ...f.context.extraction.source,
        units: f.context.extraction.source.units.map((u) =>
          u.id === 'caption' ? { ...u, source: e.caption!.text } : u
        )
      })
    }
  }
  if (mode === 'foreign-native') f.items.push(f.item('x', 40, 85, 5))
  if (mode === 'mixed-owner')
    f.context.extraction = {
      ...f.context.extraction,
      source: createPdfTranslationSource({
        ...f.context.extraction.source,
        units: f.context.extraction.source.units
          .filter((u) => u.id !== 'prose')
          .map((u) =>
            u.id !== 'caption'
              ? u
              : {
                  ...u,
                  fragments: [...u.fragments, ...f.context.extraction.source.units[3].fragments]
                }
          )
      })
    }
  if (mode === 'competing-region' || mode === 'figure-claim')
    f.cached.elements.push({
      id: 'other',
      kind: 'figure',
      issues: [],
      regions: [{ page: 1, x: 0.1, y: 0.07, width: 0.64, height: 0.1 }],
      ...(mode === 'figure-claim'
        ? { sourceItems: [{ pageNumber: 1, index: 2, text: f.items[2].str }] }
        : {})
    })
  if (mode === 'mixed-math-run') {
    f.items.splice(4, 0, { ...f.item('p', 30.2, 85, 1), fontName: 'math' })
    f.styles.math = { ...f.styles.f }
    e.caption!.text = 'Algorithm S2 p Update values with bounded iterations'
    f.context.extraction = {
      ...f.context.extraction,
      source: createPdfTranslationSource({
        ...f.context.extraction.source,
        units: f.context.extraction.source.units.map((u) =>
          u.id !== 'caption'
            ? u
            : {
                ...u,
                source: e.caption!.text,
                fragments: [
                  {
                    ...u.fragments[0],
                    items: [2, 4, 5].map((index) => ({ index, text: f.items[index].str }))
                  }
                ]
              }
        )
      })
    }
  }
  const result = await applyCachedPdfFigureSources(f.context)
  expect(result.source.units.find((u) => u.id === 'caption')?.sourceOnly).toBe(true)
})
