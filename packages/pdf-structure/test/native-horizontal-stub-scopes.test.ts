import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { recoverNativeHorizontalStubScopes } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-horizontal-stub-scopes.mjs')).href
)

// Minimal anonymous native programs: two closed cohorts, compound method
// faces and percentage leaves. A second fixture nests independently shortened
// fences. Both use original text items and actual PDF.js path/TJ operators.
const fixture = (nested = false): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = [],
    fnArray: number[] = [OPS.dependency, OPS.setFont],
    argsArray: unknown[] = [['plain'], ['plain', 10]],
    xs = nested ? [25, 115, 195, 335, 405, 505] : [25, 115, 285, 385, 485],
    right = nested ? 580 : 560,
    step = nested ? 120 : 90,
    records = nested ? 4 : 3,
    closing = 70 + step * 2
  const viewport = {
    scale: 1,
    rotation: 0,
    width: 600,
    height: 500,
    transform: [1, 0, 0, -1, 0, 500],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 500 - y]
  }
  const draw = (str: string, x: number, baseline: number, height = 10): void => {
    const sourceItem = { pageNumber: 1, index: items.length, text: str }
    items.push({
      str,
      width: (str.length * height) / 2,
      height,
      transform: [height, 0, 0, height, x, 500 - baseline],
      fontName: 'plain',
      dir: 'ltr',
      sourceItem
    })
    fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    argsArray.push(
      ['plain', height],
      null,
      [new Float32Array([1, 0, 0, 1, x, 500 - baseline])],
      [[...str].map((unicode) => ({ unicode, width: 500, isInFont: true, operatorListId: null }))],
      null
    )
  }
  draw('Table 1: Independent cohorts.', 20, closing + 20)
  const headings = nested
    ? ['Cohort', 'Step', 'Method', 'R', 'Score', 'Length']
    : ['Budget', 'Method', 'Rate', 'Score', 'Length']
  for (const [c, h] of headings.entries()) draw(h, xs[c], 60)
  if (nested) {
    draw('x', 340, 61.25, 7.5)
    draw('|', 343.75, 61.25, 7.5)
    draw('y', 347.5, 61.25, 7.5)
  }
  for (let band = 0; band < 2; band++) {
    // Deliberately off-center: native fences, rather than text coordinates,
    // establish the outer scope in the nested case.
    draw(`Q${band}`, xs[0], (nested ? 100 : 110) + band * step)
    if (nested)
      for (let group = 0; group < 2; group++)
        draw(`${group + 1}`, xs[1], 100 + group * 40 + band * step)
    for (let row = 0; row < records; row++) {
      const baseline = 90 + row * 20 + band * step,
        method = nested ? 2 : 1
      if (nested && row % 2) {
        draw('a', xs[method], baseline)
        draw('z', xs[method] + 5, baseline + 1.25, 7.5)
        draw('= 0', xs[method] + 12, baseline)
      } else {
        draw(`Mode${row}`, xs[method], baseline)
        draw('(a)', xs[method] + 28, baseline)
      }
      draw(`${30 + row}%`, xs[method + 1], baseline)
      draw(`${band + row}.0`, xs[method + 2], baseline)
      draw(`${10 + row}.0`, xs[method + 3], baseline)
    }
  }
  const rules = [40, 70, 70 + step, closing].map((y) => [20, y, right, y])
  if (nested) rules.push([90, 115, right - 10, 115], [90, 115 + step, right - 10, 115 + step])
  for (const [left, y, end] of rules) {
    fnArray.push(OPS.constructPath)
    argsArray.push([
      OPS.stroke,
      [new Float32Array([0, left, 500 - y, 1, end, 500 - y])],
      new Float32Array([left, 500 - y, end, 500 - y])
    ])
  }
  const tokens = items.map((i) => ({
    text: i.str,
    rect: [
      i.transform[4],
      500 - i.transform[5] - i.height,
      i.transform[4] + i.width,
      500 - i.transform[5]
    ],
    baseline: 500 - i.transform[5],
    height: i.height,
    horizontal: true,
    sourceItem: i.sourceItem
  }))
  const sourceContent = {
    items,
    styles: { plain: { ascent: 0.8, descent: -0.2, vertical: false } }
  }
  return {
    table: {
      id: 'page-1-table-1',
      readingRotation: 0,
      cropRect: [19, 39, right + 1, closing + 1],
      structure: { objects: [] }
    },
    tokens,
    captions: [{ page: 1, lines: [items[0].str], rect: [20, closing + 10, 165, closing + 20] }],
    rules,
    context: { sourceContent, content: sourceContent, viewport, operators: { fnArray, argsArray } }
  }
}

it('derives odd single-stub scopes from complete native horizontal fences', () => {
  const f = fixture(),
    before = structuredClone(f.tokens)
  const p = recoverNativeHorizontalStubScopes(f.table, f.tokens, f.captions, f.rules, f.context)
  expect(p?.rows).toHaveLength(7)
  expect(p?.columns).toHaveLength(5)
  expect(p?.spans).toEqual([
    { row: 1, column: 0, rowSpan: 3, colSpan: 1 },
    { row: 4, column: 0, rowSpan: 3, colSpan: 1 }
  ])
  expect([...p.ownedTokens]).toEqual(f.tokens.slice(1))
  expect(f.tokens).toEqual(before)
})

it('separates scripted header faces and independently nested stub scopes', () => {
  const f = fixture(true),
    before = structuredClone(f.tokens)
  const p = recoverNativeHorizontalStubScopes(f.table, f.tokens, f.captions, f.rules, f.context)
  expect(p?.rows).toHaveLength(9)
  expect(p?.columns).toHaveLength(6)
  expect(p?.headerRows).toEqual([0])
  expect(p?.spans).toEqual([
    { row: 1, column: 0, rowSpan: 4, colSpan: 1 },
    { row: 1, column: 1, rowSpan: 2, colSpan: 1 },
    { row: 3, column: 1, rowSpan: 2, colSpan: 1 },
    { row: 5, column: 0, rowSpan: 4, colSpan: 1 },
    { row: 5, column: 1, rowSpan: 2, colSpan: 1 },
    { row: 7, column: 1, rowSpan: 2, colSpan: 1 }
  ])
  expect(p.rows[2][3]).toBe(115)
  expect(p.rows[6][3]).toBe(235)
  expect([...p.ownedTokens]).toEqual(f.tokens.slice(1))
  expect(f.tokens).toEqual(before)
})

const prove = (f: ReturnType<typeof fixture>): unknown =>
  recoverNativeHorizontalStubScopes(f.table, f.tokens, f.captions, f.rules, f.context)

it.each([false, true])(
  'declines incomplete or aliased original font inventories (nested=%s)',
  (nested) => {
    for (const mutation of ['omit', 'alias', 'index', 'text', 'rectangle']) {
      const f = fixture(nested),
        token = f.tokens.at(-1)
      if (mutation === 'omit') f.tokens.pop()
      if (mutation === 'alias') f.tokens.push({ ...token })
      if (mutation === 'index')
        token.sourceItem = { ...token.sourceItem, index: token.sourceItem.index - 1 }
      if (mutation === 'text') token.text = '91.2'
      if (mutation === 'rectangle') token.rect[0] += 1
      expect(prove(f), mutation).toBeUndefined()
    }
  }
)

const rewriteText = (f: ReturnType<typeof fixture>, index: number, text: string): void => {
  const item = f.context.sourceContent.items[index],
    token = f.tokens[index]
  expect(text.length).toBe(item.str.length)
  item.str = text
  item.sourceItem = { ...item.sourceItem, text }
  token.text = text
  token.sourceItem = { ...token.sourceItem, text }
  const positions = f.context.operators.fnArray.flatMap((op, n) => (op === OPS.showText ? [n] : []))
  f.context.operators.argsArray[positions[index]][0] = [...text].map((unicode) => ({
    unicode,
    width: 500,
    isInFont: true,
    operatorListId: null
  }))
}

it.each([false, true])(
  'requires complete repeated method peers and scalar metrics (nested=%s)',
  (nested) => {
    const peers = fixture(nested),
      lastMethod = peers.tokens.findLastIndex((i) => i.text === 'Mode0')
    rewriteText(peers, lastMethod, 'Other')
    expect(prove(peers)).toBeUndefined()
    const metric = fixture(nested),
      rate = metric.tokens.findIndex((i) => i.text === '30%')
    rewriteText(metric, rate, 'bad')
    expect(prove(metric)).toBeUndefined()
  }
)

it.each([false, true])('requires one authentic adjacent table caption (nested=%s)', (nested) => {
  const absent = fixture(nested)
  absent.captions = []
  expect(prove(absent)).toBeUndefined()
  const duplicate = fixture(nested)
  duplicate.captions.push(structuredClone(duplicate.captions[0]))
  expect(prove(duplicate)).toBeUndefined()
  const changed = fixture(nested)
  changed.captions[0].lines = ['Table 1: Changed caption.']
  expect(prove(changed)).toBeUndefined()
})

it.each([false, true])(
  'requires every full native fence and exact declared agreement (nested=%s)',
  (nested) => {
    for (const ruleIndex of [0, 1, 2, 3]) {
      for (const witness of ['native-only', 'declared-only', 'both']) {
        const f = fixture(nested),
          pathIndex = f.context.operators.fnArray.findIndex((op) => op === OPS.constructPath)
        if (witness !== 'native-only') f.rules.splice(ruleIndex, 1)
        if (witness !== 'declared-only') {
          f.context.operators.fnArray.splice(pathIndex + ruleIndex, 1)
          f.context.operators.argsArray.splice(pathIndex + ruleIndex, 1)
        }
        expect(prove(f), `${ruleIndex}/${witness}`).toBeUndefined()
      }
    }
  }
)

it.each(
  [false, true].flatMap((nested) =>
    ['top', 'bottom', 'both'].flatMap((boundary) =>
      ['native-and-declared', 'native-only', 'declared-only'].map((witness) => ({
        nested,
        boundary,
        witness
      }))
    )
  )
)(
  'declines foreign strokes crossing $boundary ($witness, nested=$nested)',
  ({ nested, boundary, witness }) => {
    const f = fixture(nested),
      top = boundary === 'bottom' ? 100 : 30,
      bottom = boundary === 'top' ? 130 : f.table.cropRect[3] + 10
    if (witness !== 'native-only') f.rules.push([30, top, 30, bottom])
    if (witness !== 'declared-only') {
      f.context.operators.fnArray.push(OPS.constructPath)
      f.context.operators.argsArray.push([
        OPS.stroke,
        [new Float32Array([0, 30, 500 - top, 1, 30, 500 - bottom])],
        new Float32Array([30, 500 - bottom, 30, 500 - top])
      ])
    }
    expect(prove(f)).toBeUndefined()
  }
)

it('rejects shortened fences that cross an outer stub or leave an inner scope open', () => {
  for (const left of [30, 200]) {
    const f = fixture(true),
      pathIndex = f.context.operators.fnArray.findIndex((op) => op === OPS.constructPath)
    for (const i of [4, 5]) {
      f.rules[i][0] = left
      f.context.operators.argsArray[pathIndex + i][1][0][1] = left
      f.context.operators.argsArray[pathIndex + i][2][0] = left
    }
    expect(prove(f)).toBeUndefined()
  }
  const missing = fixture(true),
    pathIndex = missing.context.operators.fnArray.findIndex((op) => op === OPS.constructPath)
  missing.rules.pop()
  missing.context.operators.fnArray.splice(pathIndex + 5, 1)
  missing.context.operators.argsArray.splice(pathIndex + 5, 1)
  expect(prove(missing)).toBeUndefined()
})

it('requires a unique full-size anchor for each complete scripted header face', () => {
  const f = fixture(true),
    script = f.tokens.find((i) => i.text === 'x')
  script.baseline += 7
  script.rect[1] += 7
  script.rect[3] += 7
  const item = f.context.sourceContent.items[script.sourceItem.index]
  item.transform[5] -= 7
  expect(prove(f)).toBeUndefined()
})
