import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativeMatrixFigureScope, nativeClosedNodeSources } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-vector-scope.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)

function scene(): ReturnType<typeof JSON.parse> {
  const operators = { fnArray: [] as number[], argsArray: [] as unknown[][] },
    items: ReturnType<typeof JSON.parse>[] = [],
    tokens: ReturnType<typeof JSON.parse>[] = [],
    glyphs = new Map<string, Map<string, unknown>>()
  const viewport = {
    width: 600,
    height: 800,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 800],
    convertToViewportPoint: (x: number, y: number) => [x, 800 - y]
  }
  const add = (op: number, args: unknown[] = []): void => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
  }
  const text = (str: string, x: number, baseline: number, fontName = 'labels'): void => {
    const index = items.length,
      raw = {
        str,
        fontName,
        dir: 'ltr',
        transform: [10, 0, 0, 10, x, 800 - baseline],
        width: str.length * 5,
        height: 10,
        sourceItem: { pageNumber: 1, index, text: str }
      }
    items.push(raw)
    tokens.push(tableTextToken(raw, viewport, 0))
    if (!glyphs.has(fontName)) glyphs.set(fontName, new Map())
    for (const ch of str) glyphs.get(fontName)!.set(ch, { fontChar: ch, bounds: [0, 0, 0.5, 1] })
    add(OPS.beginText)
    add(OPS.setFont, [fontName, 10])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, 800 - baseline]])
    add(OPS.showText, [
      [...str].map((ch) => ({
        unicode: ch,
        fontChar: ch,
        width: 500,
        isInFont: true,
        accent: null
      }))
    ])
    add(OPS.endText)
  }
  const rectangle = ([l, t, r, b]: number[]): void => {
    add(OPS.constructPath, [
      OPS.stroke,
      [[0, l, 800 - t, 1, r, 800 - t, 1, r, 800 - b, 1, l, 800 - b, 4]],
      [l, 800 - b, r, 800 - t]
    ])
  }
  const caption = { page: 1, lines: ['Figure 1: Diagram.'], rect: [30, 190, 120, 204] }
  const context = (): ReturnType<typeof JSON.parse> => ({
    operators,
    viewport,
    content: {
      items,
      styles: Object.fromEntries(
        [...glyphs.keys()].map((f) => [f, { ascent: 0.8, descent: -0.2, vertical: false }])
      )
    },
    graphicsBounds: [],
    glyphBounds: [...glyphs].map(([fontName, entries]) => ({
      fontName,
      glyphs: [...entries.values()]
    }))
  })
  return {
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      rotation: 0,
      graphicsBounds: [],
      invalidGraphicsBounds: 0
    },
    operators,
    items,
    tokens,
    add,
    text,
    rectangle,
    caption,
    context
  }
}
function matrix(dimensions = false): ReturnType<typeof JSON.parse> {
  const s = scene()
  s.add(OPS.save)
  for (const r of [
    [50, 100, 80, 140],
    [90, 100, 120, 140],
    [140, 100, 170, 140]
  ])
    s.rectangle(r)
  s.text('C=AB', 28, 122)
  s.text('A', 60, 122)
  s.text('B', 100, 122)
  s.text('=', 128, 122)
  s.text('C', 150, 122)
  if (dimensions) {
    s.text('n', 60, 150, 'dimensions')
    const original = s.context
    s.context = () => {
      const context = original()
      context.glyphBounds.find(
        (font: { fontName: string }) => font.fontName === 'dimensions'
      ).glyphs[0].bounds[1] = -0.1
      return context
    }
  }
  s.add(OPS.restore)
  s.text(s.caption.lines[0], 30, 202, 'prose')
  s.text('External prose.', 30, 250, 'prose')
  s.figure = { rect: [45, 95, 175, 150], caption: s.caption }
  s.captions = [s.caption]
  s.tables = []
  s.run = () =>
    nativeMatrixFigureScope(s.page, s.figure, s.captions, s.tables, s.tokens, s.context())
  return s
}
function nodes(): ReturnType<typeof JSON.parse> {
  const s = scene()
  s.add(OPS.save)
  for (const r of [
    [30, 40, 180, 95],
    [40, 50, 90, 80],
    [120, 50, 170, 80],
    [30, 110, 180, 165],
    [40, 120, 90, 150],
    [120, 120, 170, 150]
  ])
    s.rectangle(r)
  s.text('Node A', 48, 68)
  s.text('Node B', 128, 68)
  s.text('Node C', 48, 138)
  s.text('Node D', 128, 138)
  s.text('Group', 94, 92, 'other')
  s.add(OPS.restore)
  s.text(s.caption.lines[0], 30, 202, 'prose')
  s.text('External prose.', 30, 250, 'prose')
  s.figure = { rect: [25, 35, 185, 170], caption: s.caption }
  s.captions = [s.caption]
  s.tables = []
  s.run = () =>
    nativeClosedNodeSources(s.page, s.figure, s.captions, s.tables, s.tokens, s.context())
  return s
}

it('recovers only a complete native equality repeating its framed matrix labels', () => {
  const s = matrix(),
    before = JSON.stringify(s),
    result = s.run()
  expect(result.rect[0]).toBe(28)
  expect(result.sourceItems).toEqual(
    s.tokens.slice(0, 5).map((t: { sourceItem: unknown }) => t.sourceItem)
  )
  expect(JSON.stringify(s)).toBe(before)
})

it('retains complete ink beyond the seed for a dimension whose advance is inside', () => {
  const s = matrix(true),
    result = s.run()
  expect(result).toBeDefined()
  expect(result.sourceItems).toHaveLength(6)
  expect(result.rect[3]).toBeGreaterThan(150)
  expect(result.sourceItems.some((source: { text: string }) => source.text === 'n')).toBe(true)
})

it('rejects foreign native text touched by dimension ink expansion', () => {
  const s = matrix(true)
  s.text('Foreign', 58, 152, 'foreign')
  expect(s.run()).toBeUndefined()
})

it('rejects an unrelated advance packet outside the seed', () => {
  const s = matrix(true)
  s.figure.rect[3] = 149
  expect(s.run()).toBeUndefined()
})

it('rejects dimension ink extending into the independent caption', () => {
  const s = matrix(true),
    original = s.context
  s.context = () => {
    const context = original()
    context.glyphBounds.find(
      (font: { fontName: string }) => font.fontName === 'dimensions'
    ).glyphs[0].bounds[1] = -8
    return context
  }
  expect(s.run()).toBeUndefined()
})

it.each(['wrong equality', 'interrupted edge', 'open path', 'foreign prose', 'unknown glyph'])(
  'rejects incomplete matrix ownership: %s',
  (reason) => {
    const s = matrix()
    if (reason === 'wrong equality') {
      s.items[0].str = s.tokens[0].text = s.tokens[0].sourceItem.text = 'C=BA'
      const at = s.operators.fnArray.indexOf(OPS.showText)
      s.operators.argsArray[at][0] = [...'C=BA'].map((ch) => ({
        unicode: ch,
        fontChar: ch,
        width: 500,
        isInFont: true,
        accent: null
      }))
    }
    if (reason === 'interrupted edge') s.operators.argsArray[1][1][0][3] = 0
    if (reason === 'open path') s.operators.argsArray[1][1][0].pop()
    if (reason === 'foreign prose') s.text('Other', 29, 143, 'prose')
    if (reason === 'unknown glyph') {
      const original = s.context
      s.context = () => ({ ...original(), glyphBounds: [] })
    }
    expect(s.run()).toBeUndefined()
  }
)

it('claims whole fonts only inside an exact two-level closed-node hierarchy without expanding', () => {
  const s = nodes(),
    result = s.run()
  expect(result.rect).toEqual(s.figure.rect)
  expect(result.sourceItems).toEqual(
    s.tokens.slice(0, 4).map((t: { sourceItem: unknown }) => t.sourceItem)
  )
})

it.each([
  'nested leaf',
  'crossing frame',
  'font in prose',
  'source alias',
  'stroke ink',
  'invalid paint'
])('rejects ambiguous closed-node sources: %s', (reason) => {
  const s = nodes()
  if (reason === 'nested leaf') s.rectangle([50, 55, 80, 75])
  if (reason === 'crossing frame') s.rectangle([75, 50, 130, 80])
  if (reason === 'font in prose') s.text('Body', 30, 280)
  if (reason === 'source alias') s.tokens.push({ ...s.tokens[0] })
  if (reason === 'stroke ink') {
    // Centreline is outside the label; its actual wide stroke reaches the ink.
    s.add(OPS.setLineWidth, [4])
    s.add(OPS.constructPath, [OPS.stroke, [[0, 48, 744, 1, 78, 744]], [48, 744, 78, 744]])
  }
  if (reason === 'invalid paint') s.page.invalidGraphicsBounds = 1
  expect(s.run()).toBeUndefined()
})

it.each([matrix, nodes])(
  'requires unique caption, independent ownership and complete external geometry',
  (make) => {
    const duplicate = make()
    duplicate.captions.push(structuredClone(duplicate.caption))
    expect(duplicate.run()).toBeUndefined()
    const wrongCaption = make()
    wrongCaption.caption.lines = ['Figure 1: Different caption.']
    expect(wrongCaption.run()).toBeUndefined()
    const table = make()
    table.tables.push([...table.figure.rect])
    expect(table.run()).toBeUndefined()
    const unknownExternal = make()
    unknownExternal.items.at(-1).width = 0
    expect(unknownExternal.run()).toBeUndefined()
  }
)
