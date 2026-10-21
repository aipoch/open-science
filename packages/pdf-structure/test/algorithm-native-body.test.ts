import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { findNativeAlgorithmCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-algorithm-native-body.mjs')).href
)
const { findAlgorithmCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-numbered-native-procedure.mjs')).href
)

function sample(bottom = false): ReturnType<typeof JSON.parse> {
  const rows = bottom
    ? [
        ['1', 42, 100, 6],
        ['Function Collect(values)', 60, 98, 10],
        ['2', 42, 120, 6],
        ['for value in values do', 70, 118, 10],
        ['3', 42, 140, 6],
        ['Add value', 90, 138, 10],
        ['4', 42, 160, 6],
        ['return total', 70, 158, 10],
        ['Algorithm 1: Collect values', 60, 185, 10]
      ]
    : [
        ['Algorithm 1 Collect values', 50, 100, 10],
        ['Input: values', 65, 120, 10],
        ['for value in values do', 65, 140, 10],
        ['Add value', 85, 160, 10],
        ['end for', 65, 180, 10],
        ['Return: total', 65, 200, 10]
      ]
  rows.push(['Independent paragraph.', 50, 250, 10])
  const items = rows.map(([str, x, y, height], index) => ({
    str,
    dir: 'ltr',
    width: String(str).length * 4,
    height,
    transform: [height, 0, 0, height, x, 800 - Number(y) - Number(height)],
    fontName: 'native',
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  const rules = bottom
    ? [
        [58, 115, 58, 185],
        [78, 135, 78, 153]
      ]
    : [
        [50, 99, 350, 99],
        [50, 115, 350, 115],
        [50, 220, 350, 220]
      ]
  const page = {
    pageNumber: 1,
    width: 400,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines: items.map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: 800 - item.transform[5] - Number(item.height),
      width: item.width,
      height: item.height,
      fontSize: item.height
    })),
    graphicsBounds: rules.map((r, i) => ({
      kind: 'path',
      operationIndex: i,
      normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 400))
    }))
  }
  return {
    page,
    context: {
      rules,
      content: { items, styles: { native: { ascent: 0.8, descent: -0.2 } } },
      viewport: { width: 400, height: 800, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 800] }
    }
  }
}
it.each([false, true])(
  'preserves the complete native algorithm body with bottom caption=%s',
  (bottom) => {
    const f = sample(bottom),
      before = structuredClone(f),
      result = findNativeAlgorithmCandidates(f.page, f.context)
    expect(result).toHaveLength(1)
    const sources = result[0].nativeBody.sourceItems
    expect(sources).toEqual(
      f.context.content.items
        .filter((i: { str: string }) => !/^(Algorithm|Independent)/.test(i.str))
        .map((i: { sourceItem: unknown }) => i.sourceItem)
    )
    expect(result[0].nativeBody.kind).toBe('algorithm')
    expect(f).toEqual(before)
  }
)
it.each([
  'opening',
  'closing',
  'control',
  'caption',
  'native-text',
  'crossing',
  'wrong-page',
  'alias',
  'missing-native-item',
  'caption-source',
  'unknown-font',
  'embedded-image'
])('refuses whole body ownership with incomplete %s proof', (mode) => {
  const f = sample()
  if (mode === 'opening') f.context.rules.shift()
  if (mode === 'closing') f.context.rules.pop()
  if (mode === 'control') f.page.lines[4].text = 'Unrelated words'
  if (mode === 'caption') f.page.lines[0].text = 'Ordinary heading'
  if (mode === 'native-text') f.context.content.items[2].sourceItem.text = 'Other'
  if (mode === 'crossing') f.context.content.items[2].width = 500
  if (mode === 'wrong-page') f.context.content.items[2].sourceItem.pageNumber = 2
  if (mode === 'alias')
    f.context.content.items[2].sourceSegment = {
      ...f.context.content.items[2].sourceItem,
      start: 0,
      end: 3
    }
  if (mode === 'missing-native-item') f.context.content.items[3].str = ''
  if (mode === 'caption-source') f.context.content.items[0].sourceItem.index = 50
  if (mode === 'unknown-font') delete f.context.content.styles.native.ascent
  if (mode === 'embedded-image')
    f.page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.2, 0.2, 0.3, 0.21] })
  expect(
    findNativeAlgorithmCandidates(f.page, f.context).every(
      (a: { nativeBody?: unknown }) => !a.nativeBody
    )
  ).toBe(true)
})
it.each(['gap', 'root-rule', 'nested-rule', 'last-return'])(
  'refuses a bottom-caption numbered body with %s',
  (mode) => {
    const f = sample(true)
    if (mode === 'gap') f.page.lines[4].text = '9'
    if (mode === 'root-rule') f.context.rules.shift()
    if (mode === 'nested-rule') f.context.rules.pop()
    if (mode === 'last-return') f.page.lines[7].text = 'Ordinary paragraph'
    expect(
      findNativeAlgorithmCandidates(f.page, f.context).every(
        (a: { nativeBody?: unknown }) => !a.nativeBody
      )
    ).toBe(true)
  }
)

it('keeps an existing algorithm crop without upgrading an unproved body', () => {
  const f = sample()
  f.page.lines = f.page.lines.slice(0, 4)
  f.page.lines[1].text = 'Require: values'
  f.page.lines[2].text = '1: Initialize'
  f.page.lines[3].text = '2: return result'
  const previous = findAlgorithmCandidates(f.page, f.context.rules)
  expect(previous).toHaveLength(1)
  expect(findNativeAlgorithmCandidates(f.page, f.context)).toEqual(previous)
  expect(previous[0].nativeBody).toBeUndefined()
})

function outlinedEnding(): ReturnType<typeof JSON.parse> {
  const f = sample(),
    index = f.context.content.items.length
  const item = {
    str: '..Q',
    dir: 'ltr',
    width: 14,
    height: 10,
    transform: [10, 0, 0, 10, 336, 590],
    fontName: 'outline',
    sourceItem: { pageNumber: 1, index, text: '..Q' }
  }
  f.context.content.items.push(item)
  f.context.content.styles.outline = { ascent: 0.8, descent: -0.2 }
  f.page.lines.push({ text: '..Q', x: 336, y: 200, width: 14, height: 10, fontSize: 10 })
  const glyph = (unicode: string, fontChar: string, width: number): Record<string, unknown> => ({
    unicode,
    fontChar,
    width,
    isInFont: true,
    isSpace: false,
    accent: null
  })
  f.context.nativeGlyphContext = {
    content: structuredClone(f.context.content),
    viewport: structuredClone(f.context.viewport),
    operators: {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [
        ['outline', 10],
        [[glyph('.', 'dot', 250), glyph('.', 'dot', 250), glyph('Q', 'tail', 900)]]
      ]
    },
    partialFontGlyphBounds: [
      {
        fontName: 'outline',
        glyphs: [
          { fontChar: 'dot', bounds: [0, 0, 0.2, 0.2] },
          { fontChar: 'tail', bounds: [0, 0, 1, 0.7] }
        ]
      }
    ]
  }
  return f
}

it('includes exact whole-run outline overhang without changing original claims', () => {
  const f = outlinedEnding(),
    before = structuredClone(f),
    without = structuredClone(f)
  delete without.context.nativeGlyphContext
  const old = findNativeAlgorithmCandidates(without.page, without.context)[0]
  const result = findNativeAlgorithmCandidates(f.page, f.context)[0]
  expect(old.rect[2]).toBe(350)
  expect(result.rect[2]).toBe(351)
  expect(result.nativeBody).toEqual(old.nativeBody)
  expect(result.caption).toEqual(old.caption)
  expect(f).toEqual(before)
})

it.each([
  'missing-font',
  'missing-glyph',
  'changed-source',
  'changed-width',
  'spacing',
  'kerning',
  'accent',
  'stroke',
  'ambiguous-glyph',
  'foreign-paint',
  'foreign-text'
])('does not expand an algorithm from incomplete outline proof: %s', (mode) => {
  const f = outlinedEnding(),
    p = f.context.nativeGlyphContext
  if (mode === 'missing-font') p.partialFontGlyphBounds = []
  if (mode === 'missing-glyph') p.partialFontGlyphBounds[0].glyphs.pop()
  if (mode === 'changed-source') p.content.items.at(-1).str = 'Other'
  if (mode === 'changed-width') p.operators.argsArray[1][0][2].width = 899
  if (mode === 'spacing') {
    p.operators.fnArray.unshift(OPS.setCharSpacing)
    p.operators.argsArray.unshift([1])
  }
  if (mode === 'kerning') p.operators.argsArray[1][0].splice(1, 0, 1)
  if (mode === 'accent') p.operators.argsArray[1][0][2].accent = { fontChar: 'mark' }
  if (mode === 'stroke') {
    p.operators.fnArray.unshift(OPS.setTextRenderingMode)
    p.operators.argsArray.unshift([1])
  }
  if (mode === 'ambiguous-glyph') {
    p.operators.fnArray.push(OPS.showText)
    const run = structuredClone(p.operators.argsArray[1])
    run[0][2].fontChar = 'other'
    p.operators.argsArray.push(run)
    p.partialFontGlyphBounds[0].glyphs.push({ fontChar: 'other', bounds: [0, 0, 2, 0.7] })
  }
  if (mode === 'foreign-paint')
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [350.5 / 400, 200 / 800, 360 / 400, 210 / 800]
    })
  if (mode === 'foreign-text') {
    const index = f.context.content.items.length,
      item = {
        str: 'Side note',
        dir: 'ltr',
        width: 20,
        height: 10,
        transform: [10, 0, 0, 10, 350.5, 590],
        fontName: 'native',
        sourceItem: { pageNumber: 1, index, text: 'Side note' }
      }
    f.context.content.items.push(item)
    p.content.items.push(structuredClone(item))
    f.page.lines.push({ text: 'Side note', x: 350.5, y: 200, width: 20, height: 10, fontSize: 10 })
  }
  expect(findNativeAlgorithmCandidates(f.page, f.context)[0].rect[2]).toBe(350)
})

function wrappedSample(): ReturnType<typeof JSON.parse> {
  const rows: [string, number, number, number, string][] = [
    ['1', 42, 108, 6, 'number'],
    ['Procedure Collect(values)', 60, 108, 10, 'native'],
    ['2', 42, 128, 6, 'number'],
    ['Initialize values;', 70, 128, 10, 'native'],
    ['// explain', 250, 128, 10, 'comment'],
    ['continued explanation', 75, 142, 10, 'comment'],
    ['3', 42, 162, 6, 'number'],
    ['for value in values do', 70, 162, 10, 'native'],
    ['4', 42, 192, 6, 'number'],
    ['sum ←', 90, 192, 10, 'native'],
    ['(', 110, 181, 10, 'delimiter'],
    ['value', 115, 192, 10, 'native'],
    ['k', 135, 196, 6, 'native'],
    ['5', 42, 222, 6, 'number'],
    ['return total', 70, 222, 10, 'native'],
    ['Algorithm 1: Collect values', 60, 257, 10, 'native'],
    ['Independent paragraph.', 50, 290, 10, 'native']
  ]
  const items = rows.map(([str, x, b, height, fontName], index) => ({
    str,
    width: str.length * 4,
    height,
    dir: 'ltr',
    fontName,
    transform: [height, 0, 0, height, x, 800 - b],
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  const rules = [
    [58, 115, 58, 247],
    [78, 169, 78, 210]
  ]
  const page = {
    pageNumber: 1,
    width: 400,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines: items.map((t) => ({
      text: t.str,
      x: t.transform[4],
      y: 800 - t.transform[5] - t.height,
      width: t.width,
      height: t.height,
      fontSize: t.height
    })),
    graphicsBounds: rules.map((r, i) => ({
      kind: 'path',
      operationIndex: i,
      normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 400))
    }))
  }
  const context = {
    rules,
    content: {
      items,
      styles: {
        native: { ascent: 0.8, descent: -0.2 },
        number: { ascent: 0.8, descent: -0.2 },
        comment: { ascent: 0.8, descent: -0.2, fontFamily: 'monospace' },
        delimiter: { ascent: 0.1, descent: 0 }
      }
    },
    viewport: { width: 400, height: 800, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 800] }
  }
  return { page, context }
}
function replaceWrapped(f: ReturnType<typeof wrappedSample>, index: number, str: string): void {
  const t = f.context.content.items[index]
  t.str = str
  t.width = str.length * 4
  t.sourceItem.text = str
  f.page.lines[index].text = str
  f.page.lines[index].width = t.width
}
function moveWrapped(
  f: ReturnType<typeof wrappedSample>,
  index: number,
  dx: number,
  dy: number
): void {
  const t = f.context.content.items[index]
  t.transform[4] += dx
  t.transform[5] -= dy
  f.page.lines[index].x += dx
  f.page.lines[index].y += dy
}
const wrappedNegatives: Record<string, (f: ReturnType<typeof wrappedSample>) => void> = {
  'no-comment-start': (f) => replaceWrapped(f, 4, 'Explanation'),
  'foreign-comment-font': (f) => {
    f.context.content.items[5].fontName = 'native'
  },
  'comment-crosses-next-number': (f) => moveWrapped(f, 5, 0, 19),
  'comment-outside-indent': (f) => moveWrapped(f, 5, -20, 0),
  'unknown-delimiter-font': (f) => {
    delete f.context.content.styles.delimiter.ascent
  },
  'ordinary-raised-word-envelope': (f) => {
    f.context.content.styles.delimiter.ascent = 0.8
  },
  'delimiter-not-adjacent': (f) => moveWrapped(f, 10, 100, 0),
  'delimiter-between-rows': (f) => moveWrapped(f, 10, 0, -12),
  'ordinal-gap': (f) => replaceWrapped(f, 8, '7'),
  'missing-scope': (f) => {
    f.context.rules.pop()
  },
  'unrelated-prose': (f) => replaceWrapped(f, 5, 'Algorithm 8: An unrelated block'),
  'literal-mismatch': (f) => {
    f.context.content.items[5].sourceItem.text = 'Other'
  }
}

it('owns wrapped comments and raised delimiters only within their numbered native packet', () => {
  const f = wrappedSample(),
    before = structuredClone(f),
    result = findNativeAlgorithmCandidates(f.page, f.context)
  expect(result).toHaveLength(1)
  expect(result[0].nativeBody.sourceItems).toEqual(
    f.context.content.items.slice(0, -2).map((t: { sourceItem: unknown }) => t.sourceItem)
  )
  expect(f).toEqual(before)
})
it.each(Object.keys(wrappedNegatives))('rejects incomplete wrapped packet proof: %s', (name) => {
  const f = wrappedSample()
  wrappedNegatives[name](f)
  expect(findNativeAlgorithmCandidates(f.page, f.context)).toHaveLength(0)
})

// A complete unnumbered supplementary routine may close by its loop rather
// than Return. The native baseline packets keep inline math and then together.
function nestedDataLoop(): ReturnType<typeof JSON.parse> {
  const f = sample()
  const rows: [string, number, number, number][] = [
    ['Algorithm S2 Update values', 50, 100, 10],
    ['Input: bound', 65, 120, 10],
    ['Data: values', 65, 135, 10],
    ['for value in values do', 65, 150, 10],
    ['if value > limit', 80, 165, 10],
    ['then', 170, 165, 10],
    ['Set total ← value', 95, 180, 10],
    ['else', 80, 195, 10],
    ['Compute', 95, 210, 10],
    ['total = value / bound', 160, 225, 10],
    ['Set total ← total + 1', 95, 240, 10],
    ['end if', 80, 255, 10],
    ['end for', 65, 270, 10],
    ['Independent paragraph.', 50, 315, 10]
  ]
  f.context.content.items = rows.map(([str, x, y, height], index) => ({
    str,
    dir: 'ltr',
    width: str.length * 4,
    height,
    transform: [height, 0, 0, height, x, 800 - y - height],
    fontName: 'native',
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  f.page.lines = rows.map(([text, x, y, height]) => ({
    text,
    x,
    y,
    width: text.length * 4,
    height,
    fontSize: height
  }))
  f.context.rules[2] = [50, 284, 350, 284]
  f.page.graphicsBounds = f.context.rules.map((r: number[], operationIndex: number) => ({
    kind: 'path',
    operationIndex,
    normalizedRect: r.map((v, n) => v / (n % 2 ? 800 : 400))
  }))
  return f
}
it('proves a supplementary nested native loop closed without a return', () => {
  const f = nestedDataLoop(),
    before = structuredClone(f)
  const result = findNativeAlgorithmCandidates(f.page, f.context)
  expect(result).toHaveLength(1)
  expect(result[0].nativeBody.sourceItems).toEqual(
    f.context.content.items.slice(1, -1).map((i: { sourceItem: unknown }) => i.sourceItem)
  )
  expect(f).toEqual(before)
})
it.each([
  'input',
  'data',
  'title',
  'divider',
  'bottom',
  'unclosed',
  'wrong-close',
  'else-twice',
  'empty-branch',
  'outdented',
  'native-literal',
  'native-font',
  'unrelated-after-close',
  'detached-then',
  'foreign-source',
  'control-source-order',
  'small-tail'
])('rejects an unnumbered nested routine with %s', (mode) => {
  const f = nestedDataLoop()
  const replace = (index: number, str: string): void => {
    Object.assign(f.context.content.items[index], { str, width: str.length * 4 })
    f.context.content.items[index].sourceItem.text = str
    Object.assign(f.page.lines[index], { text: str, width: str.length * 4 })
  }
  if (mode === 'input') replace(1, 'A list of bounds')
  if (mode === 'data') replace(2, 'Some values')
  if (mode === 'title') replace(0, 'Prompt S2 Update values')
  if (mode === 'divider') f.context.rules.splice(1, 1)
  if (mode === 'bottom') f.context.rules.pop()
  if (mode === 'unclosed') replace(12, 'Keep the result')
  if (mode === 'wrong-close') replace(12, 'end if')
  if (mode === 'else-twice') replace(10, 'else')
  if (mode === 'empty-branch') replace(6, 'else')
  if (mode === 'outdented') {
    f.page.lines[6].x = 65
    f.context.content.items[6].transform[4] = 65
  }
  if (mode === 'native-literal') f.context.content.items[6].sourceItem.text = 'Other'
  if (mode === 'native-font') delete f.context.content.styles.native.ascent
  if (mode === 'unrelated-after-close') {
    f.page.lines[13].y = 281
    f.context.content.items[13].transform[5] = 509
  }
  if (mode === 'detached-then') {
    f.page.lines[5].y += 4
    f.context.content.items[5].transform[5] -= 4
  }
  if (mode === 'foreign-source') f.context.content.items[6].sourceItem.pageNumber = 2
  if (mode === 'control-source-order') {
    const items = f.context.content.items
    ;[items[3], items[4]] = [items[4], items[3]]
    items.forEach((item: { sourceItem: { index: number } }, index: number) => {
      item.sourceItem.index = index
    })
  }
  if (mode === 'small-tail') {
    Object.assign(f.context.content.items[13], { height: 2, transform: [2, 0, 0, 2, 65, 517] })
    Object.assign(f.page.lines[13], { x: 65, y: 281, height: 2, fontSize: 2 })
  }
  expect(
    findNativeAlgorithmCandidates(f.page, f.context).every(
      (r: { nativeBody?: unknown }) => !r.nativeBody
    )
  ).toBe(true)
})
