import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { recoverNativeSegmentedStubRecords } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-shared-stub-record-grid.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

const fixture = (leaves = 4, otherPeer = false, shift = 0): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = [],
    fnArray: number[] = [OPS.dependency, OPS.setFont],
    argsArray: unknown[] = [['plain'], ['plain', 10]]
  const viewport = {
    scale: 1,
    rotation: 0,
    width: 640,
    height: 500,
    transform: [1, 0, 0, -1, 0, 500],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 500 - y]
  }
  const draw = (str: string, x: number, baseline: number): void => {
    const sourceItem = { pageNumber: 1, index: items.length, text: str }
    items.push({
      str,
      width: str.length * 5,
      height: 10,
      transform: [10, 0, 0, 10, x, 500 - baseline],
      fontName: 'plain',
      dir: 'ltr',
      sourceItem
    })
    fnArray.push(OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    argsArray.push(
      null,
      [new Float32Array([1, 0, 0, 1, x, 500 - baseline])],
      [[...str].map((unicode) => ({ unicode, width: 500, isInFont: true, operatorListId: null }))],
      null
    )
  }
  draw('Table 1: Independent groups.', 20, 380)
  draw('Base', 185, 55)
  draw('Group A', 295, 55)
  draw('Group B', 455, 55)
  for (const [c, text] of [
    'Category',
    'Method',
    'Score',
    'Score',
    'Rate',
    'Score',
    'Rate'
  ].entries())
    draw(text, 25 + c * 80, 80)
  for (let band = 0; band < 2; band++) {
    draw(`Group_${band}`, 25, 110 + (leaves - 1) * 15 + band * 130 + shift)
    for (let r = 0; r < leaves; r++) {
      const baseline = 110 + band * 130 + r * 30
      draw(otherPeer && band === 1 && r === leaves - 1 ? 'Other' : `Mode_${r}`, 105, baseline)
      for (let c = 2; c < 7; c++) draw(`${band + r + c}.0`, 25 + c * 80, baseline)
    }
  }
  const rules = [40, 90, 220, 350].map((y) => [20, y, 580, y])
  rules.push([180, 65, 240, 65], [260, 65, 400, 65], [420, 65, 560, 65])
  for (const [left, y, right] of rules) {
    fnArray.push(OPS.constructPath)
    argsArray.push([
      OPS.stroke,
      [new Float32Array([0, left, 500 - y, 1, right, 500 - y])],
      new Float32Array([left, 500 - y, right, 500 - y])
    ])
  }
  const tokens = items.map((i) => ({
    text: i.str,
    rect: [
      i.transform[4],
      500 - i.transform[5] - 10,
      i.transform[4] + i.width,
      500 - i.transform[5]
    ],
    baseline: 500 - i.transform[5],
    height: 10,
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
      cropRect: [19, 39, 581, 351],
      structure: { objects: [] }
    },
    tokens,
    captions: [{ page: 1, lines: [items[0].str], rect: [20, 370, 160, 380] }],
    rules,
    context: { sourceContent, content: sourceContent, viewport, operators: { fnArray, argsArray } }
  }
}

it.each(
  ['top', 'bottom', 'both'].flatMap((boundary) =>
    ['native-and-declared', 'native-only', 'declared-only'].map((witness) => ({
      boundary,
      witness
    }))
  )
)(
  'declines a foreign cohort stroke crossing $boundary with $witness evidence',
  ({ boundary, witness }) => {
    const f = fixture(),
      top = boundary === 'bottom' ? 100 : 30,
      bottom = boundary === 'top' ? 130 : 360,
      before = structuredClone(f.tokens)
    if (witness !== 'native-only') f.rules.push([30, top, 30, bottom])
    if (witness !== 'declared-only') {
      f.context.operators.fnArray.push(OPS.constructPath)
      f.context.operators.argsArray.push([
        OPS.stroke,
        [new Float32Array([0, 30, 500 - top, 1, 30, 500 - bottom])],
        new Float32Array([30, 500 - bottom, 30, 500 - top])
      ])
    }
    expect(
      recoverNativeSegmentedStubRecords(f.table, f.tokens, f.captions, f.rules, f.context)
    ).toBeUndefined()
    expect(f.tokens).toEqual(before)
  }
)

it('retains complete even peer bands under independently underlined parent scopes', () => {
  const f = fixture(),
    before = structuredClone(f.tokens)
  const p = recoverNativeSegmentedStubRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  expect(p?.rows).toHaveLength(10)
  expect(p?.columns).toHaveLength(7)
  expect(p?.spans).toContainEqual({ row: 2, column: 0, rowSpan: 4, colSpan: 1 })
  expect(p?.spans).toContainEqual({ row: 6, column: 0, rowSpan: 4, colSpan: 1 })
  expect(p?.spans).toContainEqual({ row: 0, column: 3, rowSpan: 1, colSpan: 2 })
  const r = refineTable(
    f.table,
    f.tokens,
    f.captions,
    [],
    f.rules,
    [],
    undefined,
    undefined,
    f.context
  )
  expect(r.grid).toHaveLength(10)
  expect(r.grid[5].slice(1)).toEqual(['Mode_3', '5.0', '6.0', '7.0', '8.0', '9.0'])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c) => c.sourceItems).sort((a, b) => a.index - b.index)).toEqual(
    before.slice(1).map((i) => i.sourceItem)
  )
  expect(
    r.cells
      .flatMap((c) => c.sourceRects)
      .map(JSON.stringify)
      .sort()
  ).toEqual(
    before
      .slice(1)
      .map((i) => JSON.stringify(i.rect))
      .sort()
  )
  expect(f.tokens).toEqual(before)
})

it.each(['odd-complete-band', 'different-complete-peer', 'shifted-native-stub'])(
  'declines an otherwise complete original peer program: %s',
  (kind) => {
    const f =
      kind === 'odd-complete-band'
        ? fixture(3)
        : kind === 'different-complete-peer'
          ? fixture(4, true)
          : fixture(4, false, 5)
    const before = structuredClone(f.tokens)
    expect(
      recoverNativeSegmentedStubRecords(f.table, f.tokens, f.captions, f.rules, f.context)
    ).toBeUndefined()
    expect(f.tokens).toEqual(before)
  }
)

it.each([
  'unclosed-band',
  'missing-leaf',
  'different-method',
  'uncentered-stub',
  'missing-stub',
  'foreign-stub',
  'source-conflict',
  'source-alias',
  'unsupported-paint',
  'missing-underline',
  'ambiguous-scope',
  'missing-original-font'
])('declines an incomplete or ambiguous centered peer packet: %s', (kind) => {
  const f = fixture(),
    stub = f.tokens.find((i) => i.text === 'Group_0')
  if (kind === 'unclosed-band') f.rules.splice(2, 1)
  if (kind === 'missing-leaf')
    f.tokens.splice(
      f.tokens.findIndex((i) => i.text === '2.0'),
      1
    )
  if (kind === 'different-method') f.tokens.filter((i) => i.text === 'Mode_3')[1].text = 'Other'
  if (kind === 'uncentered-stub') {
    stub.baseline += 5
    stub.rect[1] += 5
    stub.rect[3] += 5
  }
  if (kind === 'missing-stub') f.tokens.splice(f.tokens.indexOf(stub), 1)
  if (kind === 'foreign-stub')
    f.tokens.push({
      ...stub,
      text: 'Other',
      rect: [25, 150, 50, 160],
      baseline: 160,
      sourceItem: { pageNumber: 1, index: 999, text: 'Other' }
    })
  if (kind === 'source-conflict') stub.sourceItem.text += '!'
  if (kind === 'source-alias')
    f.tokens.push({
      ...stub,
      sourceItem: undefined,
      sourceToken: { ...stub },
      rect: [600, 400, 630, 410],
      baseline: 410
    })
  if (kind === 'unsupported-paint') {
    f.context.operators.fnArray.push(OPS.paintImageXObject)
    f.context.operators.argsArray.push(['image', 10, 10])
  }
  if (kind === 'missing-underline') f.rules.pop()
  if (kind === 'ambiguous-scope') f.rules.push([180, 65, 400, 65])
  if (kind === 'missing-original-font')
    f.context.sourceContent.items[stub.sourceItem.index].str += '!'
  const before = structuredClone(f.tokens)
  expect(
    recoverNativeSegmentedStubRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
  expect(f.tokens).toEqual(before)
})
