/* eslint-disable @typescript-eslint/explicit-function-return-type -- inferred test fixture types */
import { expect, it, vi } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import { applyCachedPdfFigureSources } from '../../src/reader/figure-source.js'
import { applyCachedPdfStructureSources } from '../../src/reader/structure-source.js'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'
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

it.each(['math-table', 'algorithm'] as const)(
  'keeps existing %s retention and diagnostics through default structure preparation',
  async (kind) => {
    const f = setup(kind)
    const { extraction, retainedUnitIds } = await applyCachedPdfStructureSources(f.context)
    expect(extraction.source.units).toEqual(
      f.extraction.source.units.map((unit, index) =>
        index === 0 ? { ...unit, sourceOnly: true } : unit
      )
    )
    expect(extraction.coverage.warnings).toEqual(
      kind === 'algorithm'
        ? f.extraction.coverage.warnings
        : [
            { unitId: 'second', reasons: ['formula-extraction', 'table-structure-unreliable'] },
            { unitId: 'first', reasons: ['table-structure-unreliable'] }
          ]
    )
    expect(retainedUnitIds).toEqual([])
    expect(extraction.source.originalRegions).toBeUndefined()
  }
)

function captionAndBodyOwner() {
  const f = setup('algorithm'),
    label = 'Algorithm 1 Update values'
  f.items[2].str = label
  f.items[2].width = 60
  f.cached.elements[0].caption!.text = label
  const [first, second, caption, prose] = f.items
  f.items.splice(0, 4, caption, first, second, prose)
  f.cached.elements[0].nativeBody!.sourceItems = [1, 2].map((index) => ({
    pageNumber: 1,
    index,
    text: f.items[index].str
  }))
  f.context.extraction = {
    ...f.extraction,
    source: createPdfTranslationSource({
      ...f.extraction.source,
      units: [
        {
          id: 'caption',
          source: label + ' x + y',
          fragments: [...f.unit(0, 'caption').fragments, ...f.unit(1, 'body').fragments]
        },
        { ...f.unit(2, 'second'), sourceOnly: true },
        f.unit(3, 'prose')
      ]
    })
  }
  f.page.getTextContent.mockImplementation(async () => ({
    items: f.items,
    styles: { f: { ascent: 0.8, descent: -0.2, vertical: false } }
  }))
  f.page.getViewport.mockImplementation(() => ({
    width: 100,
    height: 100,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 100],
    convertToViewportPoint: (x: number, y: number) => [x, 100 - y]
  }))
  return f
}

// Existing fragments preserve the native body-before-caption order even when
// their font-wide navigation rectangles overlap. Only loaded glyph ink can
// prove their actual separation; this fixture contains no external document.
function bodyBeforeCaptionOwner() {
  const f = setup('algorithm')
  const item = (str: string, x: number, y: number) => f.item(str, x, y, str.length * 0.4)
  f.items.splice(
    0,
    f.items.length,
    item('Input:', 10, 70),
    item('Output:', 10, 50),
    item('Algorithm', 10, 40.2),
    item('S1:', 20, 40.2),
    item('Update values with bounded iterations', 25, 40.2),
    item('and preserve sources.', 10, 28),
    item('External prose', 10, 10)
  )
  const text = f.items
    .slice(2, 6)
    .map((i) => i.str)
    .join(' ')
  const element = f.cached.elements[0]
  element.regions = [{ page: 1, x: 0.05, y: 0.1, width: 0.9, height: 0.41 }]
  element.caption = {
    text,
    regions: [{ page: 1, x: 0.05, y: 0.518, width: 0.9, height: 0.3 }]
  }
  element.nativeBody!.sourceItems = [0, 1].map((index) => ({
    pageNumber: 1,
    index,
    text: f.items[index].str
  }))
  const fragments = [
    ...f.unit(1, 'output').fragments,
    {
      ...f.unit(2, 'title').fragments[0],
      rect: { x: 0.1, y: 0.518, width: 0.9, height: 0.1 },
      items: [2, 3, 4].map((index) => ({ index, text: f.items[index].str }))
    },
    ...f.unit(5, 'title-end').fragments
  ]
  f.context.extraction = {
    ...f.extraction,
    source: createPdfTranslationSource({
      ...f.extraction.source,
      units: [
        f.unit(0, 'input'),
        { id: 'mixed', source: f.items[1].str + ' ' + text, fragments },
        f.unit(6, 'prose')
      ]
    }),
    coverage: {
      ...f.extraction.coverage,
      textItemCount: f.items.length,
      includedItemCount: f.items.length,
      warnings: []
    }
  }
  const fnArray: number[] = [],
    argsArray: unknown[] = []
  const add = (op: number, args: unknown = null) => {
    fnArray.push(op)
    argsArray.push(args)
  }
  for (const i of f.items) {
    add(OPS.beginText)
    add(OPS.setFont, ['f', 10])
    add(OPS.setTextMatrix, [1, 0, 0, 1, i.transform[4], i.transform[5]])
    add(OPS.showText, [
      Array.from(i.str, (c) => ({
        unicode: c,
        fontChar: c,
        width: 40,
        isInFont: true,
        isSpace: c === ' ',
        accent: null
      }))
    ])
    add(OPS.endText)
  }
  const outlines = new Map<string, unknown>([
    [
      'f',
      {
        missingFile: false,
        isInvalidPDFjsFont: false,
        remeasure: false,
        vertical: false,
        isType3Font: false,
        loadedName: 'loaded',
        fontMatrix: [0.001, 0, 0, 0.001, 0, 0]
      }
    ]
  ])
  for (const c of new Set(f.items.flatMap((i) => Array.from(i.str))))
    outlines.set('loaded_path_' + c, {
      path: c === ' ' ? [] : [0, 0, -0.05, 1, 0.04, -0.05, 1, 0.04, 0.45, 1, 0, 0.45, 4]
    })
  const page = Object.assign(f.page, {
    commonObjs: {
      has: (key: string) => outlines.has(key),
      get: (key: string) => outlines.get(key)
    },
    getOperatorList: vi.fn(async () => ({ fnArray, argsArray }))
  })
  page.getViewport.mockImplementation(() => ({
    width: 100,
    height: 100,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 100],
    convertToViewportPoint: (x: number, y: number) => [x, 100 - y]
  }))
  page.getTextContent.mockImplementation(async () => ({
    items: f.items,
    styles: { f: { ascent: 0.8, descent: -0.2, vertical: false } }
  }))
  return { ...f, page, fnArray, argsArray, outlines }
}

it('separates a complete body prefix from a multiline caption using independent loaded glyph ink', async () => {
  const f = bodyBeforeCaptionOwner(),
    before = structuredClone(f.context.extraction)
  const result = await applyCachedPdfFigureSources(f.context)
  expect(result.source.units.map((u) => [u.id, u.sourceOnly])).toEqual([
    ['input', true],
    ['mixed:algorithm-body', true],
    ['mixed', undefined],
    ['prose', undefined]
  ])
  expect(result.source.units[1].fragments).toEqual(before.source.units[1].fragments.slice(0, 1))
  expect(result.source.units[2].fragments).toEqual(before.source.units[1].fragments.slice(1))
  expect(result.coverage).toEqual(before.coverage)
  expect(structuredClone(f.context.extraction)).toEqual(before)
})

it.each([
  'missing-outline',
  'empty-outline',
  'painted-space',
  'native-origin',
  'native-width',
  'caption-width',
  'font-transform',
  'unclosed-text',
  'unknown-text-state',
  'foreign-ink',
  'mixed-fragment',
  'missing-body-source',
  'caption-literal',
  'warning',
  'competing-claim',
  'crossing-ink'
])('keeps a mixed body/caption owner when independent %s proof fails', async (mode) => {
  const f = bodyBeforeCaptionOwner()
  if (mode === 'missing-outline') f.outlines.delete('loaded_path_O')
  if (mode === 'empty-outline') f.outlines.set('loaded_path_O', { path: [] })
  if (mode === 'painted-space') f.outlines.set('loaded_path_ ', f.outlines.get('loaded_path_O'))
  if (mode === 'native-origin') f.items[1].transform[4]++
  if (mode === 'native-width') f.items[1].width++
  if (mode === 'caption-width') f.items[4].width++
  if (mode === 'font-transform')
    (f.outlines.get('f') as { fontMatrix: number[] }).fontMatrix[0] = 0.002
  if (mode === 'unclosed-text') {
    f.fnArray.pop()
    f.argsArray.pop()
  }
  if (mode === 'unknown-text-state') {
    const at = f.fnArray.indexOf(OPS.showText)
    f.fnArray.splice(at, 0, OPS.setTextRenderingMode)
    f.argsArray.splice(at, 0, [1])
  }
  if (mode === 'foreign-ink')
    f.outlines.set('loaded_path_E', { path: [0, 0, 0, 1, 0.04, 0, 1, 0.04, 5.5, 1, 0, 5.5, 4] })
  if (mode === 'crossing-ink')
    f.outlines.set('loaded_path_O', {
      path: [0, 0, -0.8, 1, 0.04, -0.8, 1, 0.04, 0.45, 1, 0, 0.45, 4]
    })
  if (mode === 'missing-body-source') f.cached.elements[0].nativeBody!.sourceItems.shift()
  if (mode === 'caption-literal') f.cached.elements[0].caption!.text += ' Other'
  if (mode === 'mixed-fragment' || mode === 'warning') {
    const extraction = f.context.extraction
    f.context.extraction = {
      ...extraction,
      ...(mode === 'mixed-fragment'
        ? {
            source: createPdfTranslationSource({
              ...extraction.source,
              units: extraction.source.units.map((u) =>
                u.id !== 'mixed'
                  ? u
                  : {
                      ...u,
                      fragments: [{ ...u.fragments[0], items: u.fragments.flatMap((g) => g.items) }]
                    }
              )
            })
          }
        : {
            coverage: {
              ...extraction.coverage,
              warnings: [{ unitId: 'mixed', reasons: ['formula-extraction'] }]
            }
          })
    }
  }
  if (mode === 'competing-claim')
    f.cached.elements.push({
      id: 'other',
      kind: 'figure',
      issues: [],
      regions: [{ page: 1, x: 0.1, y: 0.45, width: 0.1, height: 0.06 }],
      sourceItems: [{ pageNumber: 1, index: 1, text: f.items[1].str }]
    })
  const before = structuredClone(f.context.extraction)
  expect(await applyCachedPdfFigureSources(f.context)).toBe(f.context.extraction)
  expect(structuredClone(f.context.extraction)).toEqual(before)
})

it.each([
  'complete',
  'missing-body',
  'caption-text',
  'native-text',
  'caption-boundary',
  'mixed-prose',
  'mixed-fragment',
  'source-only',
  'warning',
  'id-collision',
  'competing-caption',
  'stale-cache'
])('splits a native algorithm caption/body owner only after full body proof: %s', async (mode) => {
  const f = captionAndBodyOwner(),
    source = f.context.extraction.source
  if (mode === 'missing-body') f.cached.elements[0].nativeBody!.sourceItems.pop()
  if (mode === 'caption-text') f.cached.elements[0].caption!.text += ' Other'
  if (mode === 'native-text') f.items[1].str = 'Different'
  if (mode === 'caption-boundary') f.cached.elements[0].caption!.regions[0].height = 0.08
  if (mode === 'stale-cache') f.cached.sourceChecksum = 'c'.repeat(64)
  if (mode === 'competing-caption')
    f.cached.elements.push({
      id: 'other',
      kind: 'figure',
      regions: [{ page: 1, x: 0.1, y: 0.07, width: 0.6, height: 0.1 }],
      issues: [],
      sourceItems: [{ pageNumber: 1, index: 0, text: f.items[0].str }]
    })
  if (mode === 'warning')
    f.context.extraction = {
      ...f.context.extraction,
      coverage: {
        ...f.extraction.coverage,
        warnings: [
          ...f.extraction.coverage.warnings,
          { unitId: 'caption', reasons: ['formula-extraction'] }
        ]
      }
    }
  if (
    mode === 'source-only' ||
    mode === 'mixed-prose' ||
    mode === 'mixed-fragment' ||
    mode === 'id-collision'
  )
    f.context.extraction = {
      ...f.context.extraction,
      source: createPdfTranslationSource({
        ...source,
        units: source.units.map((u) =>
          u.id === 'caption'
            ? {
                ...u,
                ...(mode === 'source-only' ? { sourceOnly: true as const } : {}),
                ...(mode === 'mixed-prose'
                  ? { fragments: [...u.fragments, ...source.units[2].fragments] }
                  : {}),
                ...(mode === 'mixed-fragment'
                  ? {
                      fragments: [
                        {
                          ...u.fragments[0],
                          rect: { x: 0.1, y: 0.07, width: 0.6, height: 0.3 },
                          items: u.fragments.flatMap((f) => f.items)
                        }
                      ]
                    }
                  : {})
              }
            : mode === 'id-collision' && u.id === 'prose'
              ? { ...u, id: 'caption:algorithm-body' }
              : u
        )
      })
    }
  const original = f.context.extraction,
    result = await applyCachedPdfFigureSources(f.context)
  if (mode !== 'complete') expect(result).toBe(original)
  else {
    expect(
      result.source.units.map((u) => ({ id: u.id, source: u.source, sourceOnly: u.sourceOnly }))
    ).toEqual([
      { id: 'caption', source: f.cached.elements[0].caption!.text, sourceOnly: undefined },
      { id: 'caption:algorithm-body', source: 'x + y', sourceOnly: true },
      { id: 'second', source: 'Return x', sourceOnly: true },
      { id: 'prose', source: 'External prose', sourceOnly: undefined }
    ])
    expect(result.source.units.flatMap((u) => u.fragments.flatMap((v) => v.items))).toEqual(
      original.source.units.flatMap((u) => u.fragments.flatMap((v) => v.items))
    )
    expect(result.source.units[0].fragments).toEqual(original.source.units[0].fragments.slice(0, 1))
    expect(result.source.units[1].fragments).toEqual(original.source.units[0].fragments.slice(1))
    expect(result.source.units.slice(2)).toEqual(original.source.units.slice(1))
    expect(result.coverage).toEqual(original.coverage)
  }
})

it('does not commit a tentative caption split through an independently valid body', async () => {
  const f = captionAndBodyOwner()
  f.cached.elements[0].nativeBody!.sourceItems.pop()
  f.items.push(f.item('Step', 80, 65, 10), f.item('Title', 80, 85, 10))
  f.context.extraction = {
    ...f.context.extraction,
    source: createPdfTranslationSource({
      ...f.context.extraction.source,
      units: [
        ...f.context.extraction.source.units,
        f.unit(4, 'independent'),
        f.unit(5, 'independent-caption')
      ]
    }),
    coverage: { ...f.context.extraction.coverage, textItemCount: 6, includedItemCount: 6 }
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
              preserve: 'reference',
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
      delete caption.preserve
      return caption
    })
  )
  expect(result.coverage).toEqual(f.context.extraction.coverage)
  expect(f.cached).toEqual(before)
  expect(f.context.extraction.source.units[2].sourceOnly).toBe(true)
})
it('keeps verified algorithm captions translatable through default structure preparation', async () => {
  const f = protectedAlgorithmCaption()
  const { extraction } = await applyCachedPdfStructureSources(f.context)
  expect(extraction.source.units[0].sourceOnly).toBe(true)
  expect(extraction.source.units[2].sourceOnly).toBeUndefined()
  expect(extraction.source.units[2].preserve).toBeUndefined()
  expect(applyPdfContentFirstPolicy(extraction.source).units[2].sourceOnly).toBeUndefined()
  expect(extraction.source.units[2].source).toBe(f.context.extraction.source.units[2].source)
  expect(extraction.coverage).toEqual(f.context.extraction.coverage)
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

function nativeDiffCodePacket(split?: 'ordered' | 'reversed') {
  const f = setup('algorithm')
  f.items.splice(
    0,
    f.items.length,
    f.item('@@ sample @@', 10, 80, 48),
    f.item('-old()', 10, 65, 24),
    f.item('+new()', 10, 50, 24),
    f.item('External prose', 10, 15, 56)
  )
  if (split)
    f.items.splice(
      2,
      1,
      f.item('+', split === 'ordered' ? 10 : 34, 50, 4),
      f.item('new()', split === 'ordered' ? 14 : 10, 50, 20)
    )
  const source = createPdfTranslationSource({
    ...f.extraction.source,
    units: f.items.map((_, i) => f.unit(i, 'unit-' + i))
  })
  f.context.extraction = {
    ...f.extraction,
    source,
    coverage: {
      ...f.extraction.coverage,
      textItemCount: f.items.length,
      includedItemCount: f.items.length,
      warnings: []
    }
  }
  f.cached.elements = [
    {
      id: 'code',
      kind: 'figure',
      regions: [{ page: 1, x: 0.05, y: 0.12, width: 0.7, height: 0.45 }],
      sourceItems: f.items
        .slice(0, -1)
        .map((_, index) => ({ pageNumber: 1, index, text: f.items[index].str })),
      issues: [{ code: 'native-diff-code-packet', detail: 'native-diff-code-packet' }]
    }
  ]
  const font = {
    missingFile: false,
    isInvalidPDFjsFont: false,
    remeasure: false,
    vertical: false,
    isType3Font: false,
    loadedName: 'loaded',
    isMonospace: true,
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0]
  }
  const objects = new Map<string, unknown>([['f', font]])
  const fnArray: number[] = [],
    argsArray: unknown[] = []
  const emit = (op: number, args: unknown = null) => {
    fnArray.push(op)
    argsArray.push(args)
  }
  for (const i of f.items) {
    emit(OPS.beginText)
    emit(OPS.setFont, ['f', 10])
    emit(OPS.setTextMatrix, [1, 0, 0, 1, i.transform[4], i.transform[5]])
    emit(OPS.showText, [
      Array.from(i.str, (c) => {
        objects.set('loaded_path_' + c, {
          path: c === ' ' ? [] : [0, 0, 0, 1, 0.4, 0, 1, 0.4, 0.7, 1, 0, 0.7, 4]
        })
        return {
          unicode: c,
          fontChar: c,
          width: 400,
          isInFont: true,
          isSpace: c === ' ',
          accent: null
        }
      })
    ])
    emit(OPS.endText)
  }
  Object.assign(f.page, {
    commonObjs: { has: (k: string) => objects.has(k), get: (k: string) => objects.get(k) },
    getOperatorList: vi.fn(async () => ({ fnArray, argsArray }))
  })
  f.page.getViewport.mockImplementation(() => ({
    width: 100,
    height: 100,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 100],
    convertToViewportPoint: (x: number, y: number) => [x, 100 - y]
  }))
  f.page.getTextContent.mockImplementation(async () => ({
    items: f.items,
    styles: { f: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'monospace' } }
  }))
  return { ...f, font, objects, fnArray, argsArray }
}

it('protects a complete independently proved native diff packet and preserves external prose', async () => {
  const f = nativeDiffCodePacket(),
    before = structuredClone(f.context.extraction)
  const result = await applyCachedPdfFigureSources(f.context)
  expect(result.source.units).toEqual(
    before.source.units.map((u, i) => (i < 3 ? { ...u, sourceOnly: true } : u))
  )
  expect(result.coverage).toEqual(before.coverage)
  expect(structuredClone(f.context.extraction)).toEqual(before)
})

it.each([
  'no header',
  'no addition',
  'no deletion',
  'not mono',
  'font incomplete',
  'missing outline',
  'unknown state',
  'foreign ink',
  'source literal',
  'source omitted',
  'source duplicate',
  'source order',
  'mixed owner',
  'competing region',
  'stale identity',
  'different size',
  'wrong mechanism'
])('keeps a native diff packet unchanged when %s evidence fails', async (mode) => {
  const f = nativeDiffCodePacket()
  if (mode === 'no header') f.items[0].str = 'Ordinary explanation'
  if (mode === 'no addition') f.items[2].str = 'new()'
  if (mode === 'no deletion') f.items[1].str = 'old()'
  if (mode === 'not mono') f.font.isMonospace = false
  if (mode === 'font incomplete') f.font.missingFile = true
  if (mode === 'missing outline') f.objects.delete('loaded_path_@')
  if (mode === 'unknown state') {
    f.fnArray.push(OPS.setGState)
    f.argsArray.push([])
  }
  if (mode === 'foreign ink')
    f.objects.set('loaded_path_E', { path: [0, 0, 0, 1, 0.4, 0, 1, 0.4, 7, 1, 0, 7, 4] })
  if (mode === 'source literal') f.cached.elements[0].sourceItems![0].text += 'other'
  if (mode === 'source omitted') f.cached.elements[0].sourceItems!.pop()
  if (mode === 'source duplicate')
    f.cached.elements[0].sourceItems!.push(f.cached.elements[0].sourceItems![0])
  if (mode === 'source order') f.cached.elements[0].sourceItems!.reverse()
  if (mode === 'mixed owner') {
    const units = f.context.extraction.source.units
    f.context.extraction = {
      ...f.context.extraction,
      source: createPdfTranslationSource({
        ...f.context.extraction.source,
        units: [
          { ...units[0], fragments: [...units[0].fragments, ...units[3].fragments] },
          units[1],
          units[2]
        ]
      })
    }
  }
  if (mode === 'competing region')
    f.cached.elements.push({
      id: 'other',
      kind: 'figure',
      regions: f.cached.elements[0].regions,
      issues: []
    })
  if (mode === 'stale identity') f.cached.sourceChecksum = 'c'.repeat(64)
  if (mode === 'different size') f.items[2].height = 9
  if (mode === 'wrong mechanism') f.cached.elements[0].issues[0].code = 'other'
  const before = structuredClone(f.context.extraction)
  expect(await applyCachedPdfFigureSources(f.context)).toEqual(f.context.extraction)
  expect(structuredClone(f.context.extraction)).toEqual(before)
})

it.each(['ordered', 'reversed'] as const)(
  'requires complete native diff row advances in visual source order: %s',
  async (mode) => {
    const f = nativeDiffCodePacket(mode),
      before = structuredClone(f.context.extraction)
    const result = await applyCachedPdfFigureSources(f.context)
    expect(result.source.units).toEqual(
      mode === 'ordered'
        ? before.source.units.map((u, i) => (i < 4 ? { ...u, sourceOnly: true } : u))
        : before.source.units
    )
    expect(result.coverage).toEqual(before.coverage)
  }
)

it('keeps native diff owners unchanged when page count changes during glyph verification', async () => {
  const f = nativeDiffCodePacket(),
    before = structuredClone(f.context.extraction)
  const page = f.page as typeof f.page & { getOperatorList: ReturnType<typeof vi.fn> }
  page.getOperatorList.mockImplementationOnce(async () => {
    ;(f.context.document as unknown as { numPages: number }).numPages = 2
    return { fnArray: f.fnArray, argsArray: f.argsArray }
  })
  expect(await applyCachedPdfFigureSources(f.context)).toEqual(f.context.extraction)
  expect(structuredClone(f.context.extraction)).toEqual(before)
})
