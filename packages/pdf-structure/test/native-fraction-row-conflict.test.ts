import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { anonymousNativeFractionCell } = await import(
  pathToFileURL(resolve('test/fixtures/open-native-fraction-cell.mjs')).href
)
const { reviewFinalNativeTableSources } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)

// One native fraction; its numerator and denominator were assigned separate rows.
function example(numeric = false): ReturnType<typeof anonymousNativeFractionCell> {
  const f = anonymousNativeFractionCell(),
    p = f.context.nativeGlyphContext,
    glyphs = new Map<string, { fontChar: string; bounds: number[] }>()
  p.content.items = []
  p.operators = { fnArray: [OPS.setFillRGBColor], argsArray: [['#000000']] }
  const text = (str: string, x: number, baseline: number, size: number): void => {
    let width = 0
    const painted = [...str].map((unicode) => {
      const advance = unicode === '.' ? 250 : 500
      width += (advance * size) / 1000
      glyphs.set(unicode, {
        fontChar: unicode,
        bounds: [0.05, -0.1, unicode === '.' ? 0.2 : 0.45, 0.7]
      })
      return { unicode, fontChar: unicode, width: advance, isInFont: true }
    })
    p.operators.fnArray.push(
      OPS.beginText,
      OPS.setFont,
      OPS.setTextMatrix,
      OPS.showText,
      OPS.endText
    )
    p.operators.argsArray.push([], ['F', size], [[1, 0, 0, 1, x, 120 - baseline]], [painted], [])
    p.content.items.push({
      str,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, 120 - baseline],
      fontName: 'F',
      hasEOL: false,
      sourceItem: { pageNumber: 1, index: p.content.items.length, text: str }
    })
  }
  if (numeric) {
    text('87.82', 20, 26, 8)
    text('52.35', 20, 35, 8)
  } else {
    text('x', 25 + 1 / 3, 26, 8)
    text('1+', 20, 40, 8)
    text('x', 28, 40, 8)
    text('2', 32, 37 + 1 / 3, 16 / 3)
  }
  text('z', 100, 80, 10)
  const bar = numeric ? [20, 27.4, 38, 27.6] : [20, 29.8, 34 + 2 / 3, 30.2],
    operationIndex = p.operators.fnArray.length
  p.operators.fnArray.push(OPS.constructPath)
  p.operators.argsArray.push([
    OPS.fill,
    [
      [
        0,
        bar[0],
        120 - bar[1],
        1,
        bar[2],
        120 - bar[1],
        1,
        bar[2],
        120 - bar[3],
        1,
        bar[0],
        120 - bar[3],
        4
      ]
    ],
    [bar[0], 120 - bar[3], bar[2], 120 - bar[1]]
  ])
  p.glyphBounds = [{ fontName: 'F', glyphs: [...glyphs.values()] }]
  p.graphicsBounds = [
    {
      kind: 'path',
      operationIndex,
      normalizedRect: bar.map((n: number, i: number) => n / (i % 2 ? 120 : 200))
    }
  ]
  f.context.sourcePage.graphicsBounds = p.graphicsBounds
  f.context.sourceContent = structuredClone(p.content)
  f.context.content = f.context.sourceContent
  f.context.operators = structuredClone(p.operators)
  f.context.nativeEvidenceGraphics = [{ kind: 'path', rect: bar }]
  f.context.nativePaintIdentityGraphics = [{ kind: 'path', rect: bar, operationIndex }]
  f.inventory = p.content.items.map((i: object) => tableTextToken(i, f.context.viewport, 0))
  const owned = [f.inventory.slice(0, 1), f.inventory.slice(1, numeric ? 2 : 4)]
  f.table.cells = owned.map((parts, row) => ({
    row,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    rect: row === 0 ? [10, 15, 60, 30] : [10, 30, 60, 48],
    text: parts.map((i: { text: string }) => i.text).join(' '),
    sourceItems: parts.map((i: { sourceItem: object }) => i.sourceItem),
    sourceRects: parts.map((i: { rect: number[] }) => i.rect)
  }))
  f.table.grid = f.table.cells.map((c: { text: string }) => [c.text])
  f.rules = collectTableRules(f.context.operators, f.context.viewport)
  return f
}

it('suspends a proven fraction split across rows without replacing native text or the image', () => {
  const f = example(),
    before = JSON.stringify(f),
    checked = reviewFinalNativeTableSources(f.table, f.inventory, f.rules, [], f.context)
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.reviewCandidate).toBe(false)
  expect(checked.cells).toBe(f.table.cells)
  expect(checked.cropRect).toBe(f.table.cropRect)
  expect(JSON.stringify(f)).toBe(before)
})

it('requires the original painted relation and complete foreign outlines', () => {
  for (const mode of ['no bar', 'foreign outline missing', 'foreign ink enters fraction']) {
    const f = example(),
      p = f.context.nativeGlyphContext
    if (mode === 'no bar') f.rules = []
    if (mode === 'foreign outline missing') p.glyphBounds[0].glyphs.pop()
    if (mode === 'foreign ink enters fraction')
      p.glyphBounds[0].glyphs.find((g: { fontChar: string }) => g.fontChar === 'z').bounds = [
        -8, 4.5, -7.6, 5.7
      ]
    expect(reviewFinalNativeTableSources(f.table, f.inventory, f.rules, [], f.context)).toBe(
      f.table
    )
  }
})

it('keeps contiguous underlined decimal rows mapped as independent values', () => {
  const f = example(true)
  // Column-priority native order is closed: source continuity alone is insufficient.
  expect(
    f.table.cells.flatMap((c: { sourceItems: { index: number }[] }) =>
      c.sourceItems.map((i) => i.index)
    )
  ).toEqual([0, 1])
  expect(reviewFinalNativeTableSources(f.table, f.inventory, f.rules, [], f.context)).toBe(f.table)
})
