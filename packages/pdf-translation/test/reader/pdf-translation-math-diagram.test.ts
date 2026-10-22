import { describe, expect, it } from 'vitest'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

// Anonymous four-node geometry reduced from a typeset commutative diagram.
type TextItem = Extract<
  Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number],
  { str: string }
>
function fixture(
  obstruction = false,
  paintedTips = true,
  extraPath = false,
  label = false,
  dangling: false | 'solid' | 'dashed' = false
): {
  items: TextItem[]
  run: () => ReturnType<typeof extractPdfTranslationSource>
} {
  const text = (
    str: string,
    x: number,
    y: number,
    size = 10,
    width = 5,
    fontName = 'labels'
  ): TextItem => ({
    str,
    transform: [size, 0, 0, size, x, y],
    width,
    height: size,
    fontName,
    dir: 'ltr',
    hasEOL: false
  })
  const items = [text('Surrounding prose stays translatable.', 40, 650, 10, 210)]
  for (const [x, y] of [
    [100, 600],
    [160, 600],
    [100, 540],
    [160, 540]
  ]) {
    items.push(text('A', x, y), text('2', x + 6, y + 4, 7, 4))
  }
  const lines = [
    [112, 603, 154, 603],
    [105, 590, 105, 552],
    [112, 543, 154, 543],
    [165, 590, 165, 552]
  ]
  if (dangling) lines.push([178, 603, 215, 603])
  for (const [, , x, y] of lines) items.push(text('\u000f', x, y, 10, 0, 'tips'))
  if (obstruction) items.push(text('A normal sentence inside the gap.', 110, 575, 10, 170))
  if (label) items.push(text('f', 130, 609, 7, 3))
  const fnArray: number[] = [OPS.setLineWidth],
    argsArray: unknown[][] = [[0.4]]
  for (const [x, y, right, bottom] of lines) {
    if (dangling === 'dashed' && x === 178) {
      fnArray.push(OPS.setDash)
      argsArray.push([[2, 2], 0])
    }
    fnArray.push(OPS.constructPath)
    argsArray.push([
      OPS.stroke,
      [new Float32Array([0, x, y, 1, right, bottom])],
      new Float32Array([
        Math.min(x, right),
        Math.min(y, bottom),
        Math.max(x, right),
        Math.max(y, bottom)
      ])
    ])
  }
  if (extraPath) {
    fnArray.push(OPS.constructPath)
    argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 125, 570, 1, 145, 570])],
      new Float32Array([125, 570, 145, 570])
    ])
  }
  if (paintedTips) {
    fnArray.push(OPS.setFont, OPS.showText)
    argsArray.push(
      ['tips', 10],
      [[{ unicode: '\u000f', fontChar: 'tip', isInFont: true, width: 0 }]]
    )
  }
  const page = {
    rotate: 0,
    view: [0, 0, 600, 800],
    getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
    getTextContent: async () => ({
      items,
      styles: { labels: { ascent: 0.8, descent: -0.2 }, tips: { ascent: 0, descent: 0 } }
    }),
    getOperatorList: async () => ({ fnArray, argsArray }),
    commonObjs: {
      has: (key: string) => ['tips', 'tips_path_tip'].includes(key),
      get: (key: string) =>
        key === 'tips'
          ? { loadedName: 'tips', missingFile: false, vertical: false, isType3Font: false }
          : { path: new Float32Array([0, -0.4, 0.15, 1, 0, 0, 1, -0.4, -0.15, 4]) }
    }
  }
  const document = {
    numPages: 1,
    fingerprints: ['anonymous-diagram'],
    getPage: async () => page
  } as unknown as PDFDocumentProxy
  return {
    items,
    run: () =>
      extractPdfTranslationSource({
        document,
        resourceRequestKey: 'test',
        signal: new AbortController().signal
      })
  }
}

describe('native commutative diagram preservation', () => {
  it('keeps a proved graph together, including zero-advance arrow sources, without consuming prose', async () => {
    const f = fixture(),
      result = await f.run()
    const diagram = result.source.units.find((u) => u.id.startsWith('math-diagram:'))
    expect(diagram).toBeDefined()
    expect(diagram?.sourceOnly).toBe(true)
    expect(diagram?.fragments[0].items.map((i) => i.index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1)
    )
    expect(diagram?.fragments[0].rect.height).toBeGreaterThan(0.08)
    expect(
      result.source.units.find((u) => u.fragments.some((f) => f.items.some((i) => i.index === 0)))
        ?.sourceOnly
    ).toBeUndefined()
    const owners = [
      ...result.source.units.flatMap((u) =>
        u.fragments.flatMap((f) => f.items.map((i) => i.index))
      ),
      ...result.coverage.exclusions.flatMap((e) => e.items.map((i) => i.index))
    ]
    expect(owners.sort((a, b) => a - b)).toEqual(f.items.map((_, i) => i))
  })

  it.each(['prose intrusion', 'unproved arrow glyph'] as const)(
    'does not promote %s into a mathematical region',
    async (reason) => {
      const result = await fixture(
        reason === 'prose intrusion',
        reason !== 'unproved arrow glyph'
      ).run()
      expect(result.source.units.some((u) => u.id.startsWith('math-diagram:'))).toBe(false)
    }
  )

  it('owns a smaller label attached geometrically to the middle of an arrow', async () => {
    const result = await fixture(false, true, false, true).run()
    expect(
      result.source.units
        .find((u) => u.id.startsWith('math-diagram:'))
        ?.fragments[0].items.some((i) => i.text === 'f')
    ).toBe(true)
  })

  it('warns about a proved mathematical graph with an unowned path, without joining it', async () => {
    const result = await fixture(false, true, true).run()
    expect(result.source.units.some((u) => u.id.startsWith('math-diagram:'))).toBe(false)
    expect(result.coverage.warnings.some((w) => w.reasons.includes('formula-extraction'))).toBe(
      true
    )
    const prose = result.source.units.find((u) =>
      u.fragments.some((f) => f.items.some((i) => i.index === 0))
    )!
    expect(result.coverage.warnings.some((w) => w.unitId === prose.id)).toBe(false)
  })

  it.each(['solid', 'dashed'] as const)(
    'keeps a graph partial when a %s outward terminal connector starts beyond its current box',
    async (style) => {
      const f = fixture(false, true, false, false, style)
      const result = await f.run()
      expect(result.source.units.some((u) => u.id.startsWith('math-diagram:'))).toBe(false)
      expect(result.coverage.warnings.some((w) => w.reasons.includes('formula-extraction'))).toBe(
        true
      )
      const prose = result.source.units.find((u) =>
        u.fragments.some((fragment) => fragment.items.some((i) => i.index === 0))
      )!
      expect(result.coverage.warnings.some((w) => w.unitId === prose.id)).toBe(false)
      const native = [
        ...result.source.units.flatMap((u) => u.fragments.flatMap((fragment) => fragment.items)),
        ...result.coverage.exclusions.flatMap((e) => e.items)
      ]
      expect(native.map((i) => i.index).sort((a, b) => a - b)).toEqual(f.items.map((_, i) => i))
    }
  )
})
