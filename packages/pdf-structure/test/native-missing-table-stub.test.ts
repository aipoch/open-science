import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { refineNativeTableBoundaryInk: refine } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-boundary-ink.mjs')).href
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function clippedStub() {
  const entries: [string, number, number][] = [
    ['Table 4. Estimates.', 10, 20],
    ['Native estimate summary', 100, 45],
    ['Model Group', 10, 70],
    ['Score', 150, 70],
    ['Count', 240, 70]
  ]
  const rows: number[][][] = [[[2], [3], [4]]]
  for (const [r, y] of [100, 130, 160].entries()) {
    const start = entries.length
    entries.push(
      [String.fromCharCode(65 + r), 32.5, y],
      ['Sample arm', 50, y],
      ['1.0', 155, y - 6],
      ['[0,2]', 150, y + 8],
      ['2.0', 245, y - 6],
      ['[1,3]', 240, y + 8]
    )
    rows.push([[start + 1], [start + 2, start + 3], [start + 4, start + 5]])
  }
  entries.push(['Q', 4.5, 100])
  const items = entries.map(([str, x, y], index) => ({
    str,
    width: str.length * 5,
    height: 10,
    dir: 'ltr',
    fontName: 'F',
    transform: [10, 0, 0, 10, x, 220 - y],
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  const content = { items, styles: { F: { vertical: false } } },
    viewport = { width: 300, height: 220, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 220] },
    box = (n: number): number[] => [
      entries[n][1],
      entries[n][2] - 10,
      entries[n][1] + items[n].width,
      entries[n][2]
    ],
    operators = { fnArray: [] as number[], argsArray: [] as unknown[] },
    add = (op: number, args: unknown): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    }
  const chars = [...new Set(items.flatMap((i) => Array.from(i.str)))]
  for (const i of items) {
    add(OPS.beginText, null)
    add(OPS.setFont, ['F', 10])
    add(OPS.setTextMatrix, [new Float32Array([1, 0, 0, 1, i.transform[4], i.transform[5]])])
    add(OPS.showText, [
      Array.from(i.str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))
    ])
    add(OPS.endText, null)
  }
  const rules = [55, 80, 180].map((y) => [10, y, 290, y]),
    rulePaintBounds = new Map(rules.map((r) => [r.join(','), [10, r[1] - 0.2, 290, r[1] + 0.2]]))
  const context = {
    content,
    sourceContent: content,
    viewport,
    rulePaintBounds,
    nativeEvidenceGraphics: [...rulePaintBounds.values()].map((rect) => ({ kind: 'path', rect })),
    nativeGlyphContext: {
      content: structuredClone(content),
      viewport,
      operators,
      graphicsBounds: [],
      glyphBounds: [
        {
          fontName: 'F',
          glyphs: chars.map((c) => ({
            fontChar: c,
            bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
          }))
        }
      ]
    }
  }
  const table = {
    page: 1,
    cropRect: [35, 40, 295, 185],
    cells: rows.flatMap((row, r) =>
      row.map((indexes, column) => ({
        row: r,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: indexes.map((n) => items[n].str).join(' '),
        sourceItems: indexes.map((n) => items[n].sourceItem),
        sourceRects: indexes.map(box)
      }))
    ),
    unassigned: [items[1].str],
    clipped: [{ text: items[1].str, rect: box(1) }],
    caption: { page: 1, text: items[0].str, rect: box(0) },
    issues: ['text-crosses-crop-boundary']
  }
  return { table, context, rules }
}
it('restores a missing native stub column using exact ink without changing the incomplete grid', () => {
  const f = clippedStub(),
    before = structuredClone(f.table)
  const result = refine(f.table, f.rules, f.context)
  expect(result?.cropRect).toEqual([10, 35, 295, 185])
  expect(result?.cells).toBe(f.table.cells)
  expect(result?.issues).toContain('native-table-structure-ambiguous')
  expect(result?.reviewCandidate).toBe(false)
  expect(f.table).toEqual(before)
})
it.each(['foreign ink', 'missing glyph', 'source', 'caption', 'rule', 'stub sequence', 'record'])(
  'does not complete a missing stub without %s evidence',
  (guard) => {
    const f = clippedStub()
    if (guard === 'foreign ink') {
      for (const content of [f.context.content, f.context.nativeGlyphContext.content])
        content.items.at(-1)!.transform[4] = 11
      f.context.nativeGlyphContext.operators.argsArray[
        (f.context.content.items.length - 1) * 5 + 2
      ] = [new Float32Array([1, 0, 0, 1, 11, 120])]
    }
    if (guard === 'missing glyph') f.context.nativeGlyphContext.glyphBounds[0].glyphs.pop()
    if (guard === 'source') f.table.cells[0].sourceRects[0] = []
    if (guard === 'caption') f.table.caption.text = 'Another caption'
    if (guard === 'rule') f.rules.pop()
    if (guard === 'stub sequence') {
      for (const content of [f.context.content, f.context.nativeGlyphContext.content]) {
        content.items[11].str = 'F'
        content.items[11].sourceItem.text = 'F'
      }
      f.context.nativeGlyphContext.operators.argsArray[11 * 5 + 3] = [
        [{ unicode: 'F', fontChar: 'F', width: 500, isInFont: true }]
      ]
      f.context.nativeGlyphContext.glyphBounds[0].glyphs.push({
        fontChar: 'F',
        bounds: [0, 0, 0.5, 0.7]
      })
    }
    if (guard === 'record') f.table.cells[5].sourceItems.pop()
    expect(refine(f.table, f.rules, f.context)).toBeUndefined()
  }
)
it.each([
  ['invisible fill', [['ca', 0]]],
  ['translucent fill', [['ca', 0.5]]],
  ['non-normal blend', [['BM', 'multiply']]],
  ['soft mask', [['SMask', true]]],
  ['unknown state', [['Unknown', 1]]],
  ['malformed state', [null]]
])('does not infer visible stub ink from %s', (_name, entries) => {
  const f = clippedStub()
  f.context.nativeGlyphContext.operators.fnArray.unshift(OPS.setGState)
  f.context.nativeGlyphContext.operators.argsArray.unshift([entries])
  expect(refine(f.table, f.rules, f.context)).toBeUndefined()
})
it('retains complete stub evidence under explicitly opaque unmasked paint', () => {
  const f = clippedStub()
  f.context.nativeGlyphContext.operators.fnArray.unshift(OPS.setGState)
  f.context.nativeGlyphContext.operators.argsArray.unshift([
    [
      ['ca', 1],
      ['SMask', false]
    ]
  ])
  expect(refine(f.table, f.rules, f.context)?.cropRect).toEqual([10, 35, 295, 185])
})
