import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { recoverNativeClippedHeaderCrop: recover } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-boundary-ink.mjs')).href
)
const { completeNativeTableVisualCrop: complete } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-text-record-grid.mjs')).href
)
const { collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function clippedHeader() {
  const s = {
    pageNumber: 1,
    viewport: { width: 200, height: 200, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 200] },
    content: {
      items: [] as {
        str: string
        width: number
        height: number
        dir: string
        fontName: string
        transform: number[]
      }[],
      styles: { F: { vertical: false } }
    },
    operators: { fnArray: [] as number[], argsArray: [] as unknown[] },
    glyphBounds: [{ fontName: 'F', glyphs: [] as { fontChar: string; bounds: number[] }[] }],
    graphicsBounds: [] as { kind: string; operationIndex: number; normalizedRect: number[] }[]
  }
  const add = (op: number, args: unknown = null): void => {
      s.operators.fnArray.push(op)
      s.operators.argsArray.push(args)
    },
    allGlyphs = new Map<string, { fontChar: string; bounds: number[] }>()
  function text(
    str: string,
    x: number,
    baseline: number,
    width: number,
    clip = [0, 0, 200, 200]
  ): { index: number; rect: number[]; text: string } {
    const index = s.content.items.length
    s.content.items.push({
      str,
      width,
      height: 10,
      dir: 'ltr',
      fontName: 'F',
      transform: [10, 0, 0, 10, x, 200 - baseline]
    })
    add(OPS.save)
    add(OPS.eoClip)
    const [a, b, c, d] = clip
    add(OPS.constructPath, [
      OPS.endPath,
      [new Float32Array([0, a, 200 - d, 1, c, 200 - d, 1, c, 200 - b, 1, a, 200 - b, 4])]
    ])
    add(OPS.beginText)
    add(OPS.setFont, ['F', 10])
    add(OPS.setTextMatrix, [new Float32Array([1, 0, 0, 1, x, 200 - baseline])])
    const glyphs = [...str].map((ch) => {
      if (!allGlyphs.has(ch)) allGlyphs.set(ch, { fontChar: ch, bounds: [0, 0, 0.6, 0.7] })
      return {
        unicode: ch,
        fontChar: ch,
        width: width === 0 ? 0 : 600,
        isInFont: true,
        accent: null
      }
    })
    add(OPS.showText, [glyphs])
    add(OPS.endText)
    add(OPS.restore)
    return { index, rect: [x, baseline - 10, x + width, baseline], text: str }
  }
  text('𝑋', 70, 28, 7, [55, 10, 100, 39.8])
  text('̂', 72, 26, 0, [55, 10, 100, 39.8])
  text('𝑌', 115, 28, 7, [100, 10, 145, 39.8])
  text('𝑍', 160, 28, 7, [145, 10, 190, 39.8])
  s.graphicsBounds.push({
    kind: 'path',
    operationIndex: s.operators.fnArray.length,
    normalizedRect: [0.05, 0.1975, 0.95, 0.2025]
  })
  add(OPS.constructPath, [
    OPS.fill,
    [new Float32Array([0, 10, 159.8, 1, 190, 159.8, 1, 190, 160.2, 1, 10, 160.2, 4])],
    [10, 159.8, 190, 160.2]
  ])
  const cells = []
  for (let row = 0; row < 2; row++)
    for (let column = 0; column < 4; column++) {
      const item = text(
        column ? String(row + column) : 'Entry',
        20 + 45 * column,
        60 + 20 * row,
        column ? 12 : 25
      )
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        sourceItems: [{ pageNumber: 1, index: item.index, text: item.text }],
        sourceRects: [item.rect],
        text: item.text
      })
    }
  text('Table 1. Example records.', 10, 120, 170)
  s.glyphBounds[0].glyphs = [...allGlyphs.values()]
  return {
    table: {
      page: 1,
      cropRect: [10, 24, 185, 95],
      cells,
      grid: [
        ['Entry', '1', '2', '3'],
        ['Entry', '2', '3', '4']
      ],
      unassigned: [],
      clipped: [],
      issues: ['native-table-structure-ambiguous'],
      caption: { page: 1, text: 'Table 1. Example records.', rect: [10, 110, 180, 120] }
    },
    snapshot: s,
    scale: 1
  }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function input(f = clippedHeader()) {
  const s = f.snapshot,
    content = {
      ...s.content,
      items: s.content.items.map((i, index) => ({
        ...i,
        sourceItem: { pageNumber: 1, index, text: i.str }
      }))
    },
    rulePaintBounds = new Map(),
    rules = collectTableRules(s.operators, s.viewport, rulePaintBounds)
  return {
    ...f,
    rules,
    context: {
      content,
      sourceContent: content,
      viewport: s.viewport,
      nativeGlyphContext: s,
      rulePaintBounds,
      nativeEvidenceGraphics: s.graphicsBounds.map((g) => ({
        kind: g.kind,
        rect: g.normalizedRect.map((x) => x * 200)
      }))
    }
  }
}
it.each([185, 190])(
  'completes the native clipped mathematical header and separator at right %s without changing semantics',
  (right) => {
    const f = input()
    f.table.cropRect[2] = right
    const before = structuredClone(f.table),
      out = complete(
        f.table,
        null,
        f.snapshot.content.items.map((i) => ({
          rect: [
            i.transform[4],
            200 - i.transform[5] - i.height,
            i.transform[4] + i.width,
            200 - i.transform[5]
          ]
        })),
        f.rules,
        f.context
      )
    expect(out).toBeDefined()
    expect(out.cropRect[0]).toBe(10)
    expect(out.cropRect[1]).toBeCloseTo(10)
    expect(out.cropRect[2]).toBe(190)
    expect(out.cropRect[3]).toBe(95)
    expect({ ...out, cropRect: before.cropRect }).toEqual(before)
    expect(f.table).toEqual(before)
  }
)

const controls: Record<string, (f: ReturnType<typeof clippedHeader>) => void> = {
  'painted-whitespace-not-native': (f) => {
    const ops = f.snapshot.operators,
      a = structuredClone(ops.fnArray.slice(0, 9)),
      b = structuredClone(ops.argsArray.slice(0, 9))
    ;(b[6] as [{ unicode: string }[]])[0][0].unicode = ' '
    ops.fnArray.push(...a)
    ops.argsArray.push(...b)
  },
  'unowned-text-packet': (f) => {
    const ops = f.snapshot.operators,
      a = structuredClone(ops.fnArray.slice(0, 9)),
      b = structuredClone(ops.argsArray.slice(0, 9))
    ;(b[6] as [{ unicode: string }[]])[0][0].unicode = 'Q'
    ops.fnArray.push(...a)
    ops.argsArray.push(...b)
  },
  'foreign-right-paint': (f) =>
    f.snapshot.graphicsBounds.push({
      kind: 'path',
      operationIndex: -1,
      normalizedRect: [0.93, 0.3, 0.95, 0.4]
    }),
  'malformed-outline': (f) => {
    f.snapshot.glyphBounds[0].glyphs[0].bounds[0] = NaN
  },
  'transparent-state': (f) => {
    f.snapshot.operators.fnArray.unshift(OPS.setGState)
    f.snapshot.operators.argsArray.unshift([[['ca', 0.5]]])
  },
  'missing-origin-rect': (f) => {
    f.table.cells[0].sourceRects = []
  },
  'duplicate-source-carrier': (f) => {
    f.table.cells[1].sourceItems = structuredClone(f.table.cells[0].sourceItems)
    f.table.cells[1].sourceRects = structuredClone(f.table.cells[0].sourceRects)
  },
  'incomplete-clip': (f) => {
    const a = (f.snapshot.operators.argsArray[2] as [number, Float32Array[]])[1][0]
    a[5] -= 10
    a[8] -= 10
  },
  'missing-outline': (f) => {
    f.snapshot.glyphBounds = []
  },
  'unknown-blend': (f) => {
    f.snapshot.operators.fnArray.unshift(OPS.setGState)
    f.snapshot.operators.argsArray.unshift([[['BM', 'multiply']]])
  },
  'unknown-annotation': (f) => {
    f.snapshot.operators.fnArray.unshift(OPS.beginAnnotation)
    f.snapshot.operators.argsArray.unshift([])
  },
  'additional-separator': (f) => {
    f.snapshot.operators.fnArray.push(OPS.constructPath)
    f.snapshot.operators.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 10, 130, 1, 190, 130])],
      [10, 130, 190, 130]
    ])
  },
  'foreign-paint': (f) =>
    f.snapshot.graphicsBounds.push({
      kind: 'path',
      operationIndex: -1,
      normalizedRect: [0.05, 0.06, 0.95, 0.09]
    }),
  'foreign-page-top-text': (f) =>
    f.snapshot.content.items.push({
      str: 'Heading',
      width: 30,
      height: 10,
      dir: 'ltr',
      fontName: 'F',
      transform: [10, 0, 0, 10, 10, 198]
    }),
  'incomplete-body': (f) => (f.table.cells[0].sourceItems = []),
  'wrong-native-literal': (f) => (f.table.cells[0].sourceItems[0].text = 'Other'),
  'wrong-caption': (f) => (f.table.caption.text = 'Table 2. Other data.'),
  'caption-overlap': (f) => (f.table.caption.rect[1] = 90),
  'unanchored-zero-mark': (f) => {
    f.snapshot.content.items[1].transform[4] = 95
  },
  'nonmath-column': (f) => {
    f.snapshot.content.items[2].str = 'Y'
  },
  'no-clipping-proof': (f) => {
    const i = f.snapshot.operators.fnArray.indexOf(OPS.eoClip)
    f.snapshot.operators.fnArray[i] = OPS.beginMarkedContent
  },
  'duplicated-header-paint': (f) => {
    const a = f.snapshot.operators.fnArray.slice(0, 9),
      b = f.snapshot.operators.argsArray.slice(0, 9)
    f.snapshot.operators.fnArray.push(...a)
    f.snapshot.operators.argsArray.push(...b)
  }
}
it.each(Object.entries(controls))(
  'keeps the crop when native header proof fails: %s',
  (_name, mutate) => {
    const f = clippedHeader()
    mutate(f)
    const g = input(f),
      before = structuredClone(g.table)
    expect(recover(g.table, g.context)).toBeUndefined()
    expect(g.table).toEqual(before)
  }
)
it('rejects a mismatched original source snapshot without changing table data', () => {
  const f = input()
  f.context.content.items[0].sourceItem.index = 1
  expect(recover(f.table, f.context)).toBeUndefined()
})

it.each([undefined, {}, { cropRect: [1, 2, 3, 4] }, { parts: null, cropRect: [1, 2, 3, 4] }])(
  'abstains on an incomplete early producer input %#',
  (table) => {
    expect(complete(table, null, [], [], undefined)).toBeUndefined()
  }
)

it.each([[], [20, 50, 45], [20, 50, NaN, 60], [20, 50, 20, 60]].map((rect) => ({ rect })))(
  'requires a complete nonempty native source rectangle %#',
  ({ rect }) => {
    const f = input()
    f.table.cells[0].sourceRects[0] = rect
    expect(complete(f.table, null, [], f.rules, f.context)).toBeUndefined()
  }
)
