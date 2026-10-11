import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
type Token = { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean }
const token = (text: string, x: number, y: number, w: number): Token => ({
  text,
  rect: [x, y, x + w, y + 10],
  height: 10,
  baseline: y + 10,
  horizontal: true
})
const input = (): ReturnType<typeof JSON.parse> => ({
  table: {
    id: 'page-7-table-1',
    cropRect: [35, 70, 555, 300],
    structure: {
      objects: [
        ...[
          [0, 110],
          [112, 210],
          [215, 315],
          [320, 520]
        ].map(([a, b]) => ({ label: 'table column', score: 0.9, rect: [a, 10, b, 225] })),
        ...[
          [10, 22],
          [24, 38],
          [50, 95],
          [100, 150],
          [155, 200],
          [202, 225]
        ].map(([a, b]) => ({ label: 'table row', score: 0.9, rect: [0, a, 520, b] }))
      ]
    }
  },
  tokens: [
    token('Published result', 40, 80, 100),
    token('Dominant', 260, 80, 65),
    token('component', 335, 80, 60),
    token('interpretation', 420, 80, 120),
    token('continued', 260, 95, 65),
    ...[115, 175, 235].flatMap((y, n) => [
      token(`Synthetic result ${n}`, 40, y, 200),
      token('Summary', 260, y, 130),
      token('Interpretation of evidence', 420, y, 130),
      token('continues with evidence', 40, y + 15, 200),
      token('continuation', 260, y + 15, 90),
      token('and its documented limits', 420, y + 15, 130),
      token('with final details', 40, y + 30, 200),
      token('remain attached to this record.', 420, y + 30, 130),
      token('final qualification.', 420, y + 45, 110)
    ])
  ],
  captions: [{ lines: ['Table 1: Synthetic prose records.'], rect: [35, 45, 555, 60] }],
  rules: [
    [40, 75, 550, 75],
    [40, 110, 550, 110],
    [40, 298, 550, 298]
  ]
})
it('recovers complete prose lanes and keeps long tails under native paragraph starts', () => {
  const f = input(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(4)
  expect(r.grid[0]).toHaveLength(3)
  expect(r.grid[0][1]).toBe('Dominant component continued')
  expect(r.grid[3][2]).toContain('final qualification.')
  expect(r.unassigned).toEqual([])
})

it('declines a crossing lane or a missing closing frame', async () => {
  const { recoverNativeProseLaneRecords } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-bounded-text-record-grid.mjs')).href
  )
  const f = input()
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules.slice(0, 2))
  ).toBeUndefined()
  expect(
    recoverNativeProseLaneRecords(
      f.table,
      [...f.tokens, token('Crossing source field', 200, 130, 150)],
      f.captions,
      f.rules
    )
  ).toBeUndefined()
})

const { recoverNativeProseLaneRecords } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-bounded-text-record-grid.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)

// Whole original fonts are drawn cell by cell. The stub may wrap before its
// peer paragraph starts; no lexical rule distinguishes a tail from a record.
const sourceOrdered = (columns: 2 | 4 | 6, paired = false): ReturnType<typeof JSON.parse> => {
  const width = columns === 2 ? 310 : columns === 4 ? 420 : 620
  const viewport = {
    width: 800,
    height: 500,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 500],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 500 - y]
  }
  const items: object[] = []
  const fnArray: number[] = [OPS.dependency, OPS.setFont]
  const argsArray: unknown[] = [['ordinary-font'], ['ordinary-font', 10]]
  const draw = (str: string, x: number, y: number): void => {
    items.push({
      str,
      fontName: 'ordinary-font',
      transform: [10, 0, 0, 10, x, 490 - y],
      width: str.length * 5,
      height: 10,
      dir: 'ltr',
      sourceItem: { pageNumber: 7, index: items.length, text: str }
    })
    fnArray.push(OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    argsArray.push(
      null,
      [new Float32Array([1, 0, 0, 1, x, 490 - y])],
      [[...str].map((unicode) => ({ unicode, width: 500, isInFont: true, operatorListId: null }))],
      null
    )
  }
  draw('Table 1: Records.', 20, paired ? 230 : 10)
  for (let c = 0; c < columns; c++)
    if (!paired || c % 2 === 0) draw(`Field ${c}`, columns === 2 ? 20 + c * 130 : 20 + c * 100, 45)
  for (let n = 0; n < 3; n++) {
    const y = 75 + n * 48
    for (let c = 0; c < columns; c++) {
      if (paired && n === 2 && c < 2) continue
      const x = columns === 2 ? 20 + c * 130 : 20 + c * 100
      draw(
        (paired && c % 2) || (columns === 6 && c > 0 && c < 4) ? `${n + c}.0` : `Entry ${n} ${c}`,
        x,
        y
      )
      if (columns === 6 ? c >= 4 : paired ? c % 2 === 0 && n !== 1 : c || n !== 1)
        draw('continued', x, y + 12)
      if (!paired && c === columns - 1) draw('final detail', x, y + 24)
    }
  }
  const rules = [40, 65, 215].map((y) => [20, y, width, y])
  for (const [left, y, right] of rules) {
    fnArray.push(OPS.constructPath)
    argsArray.push([
      OPS.stroke,
      [new Float32Array([0, left, 500 - y, 1, right, 500 - y])],
      new Float32Array([left, 500 - y, right, 500 - y])
    ])
  }
  const sourceContent = {
    items,
    styles: { 'ordinary-font': { ascent: 0.8, descent: -0.2, vertical: false } }
  }
  return {
    table: { id: 'page-7-table-1', cropRect: [20, 40, width, 215] },
    tokens: items.map((i) => tableTextToken(i, viewport, 0)),
    captions: [
      {
        page: 7,
        lines: ['Table 1: Records.'],
        rect: [20, paired ? 230 : 10, width, paired ? 240 : 20]
      }
    ],
    rules,
    context: { operators: { fnArray, argsArray }, viewport, sourceContent }
  }
}

it.each([2, 4, 6] as const)('uses complete visible native cell cycles for %i fields', (columns) => {
  const f = sourceOrdered(columns)
  const original = structuredClone(f.tokens)
  const r = recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  expect(r.rows).toHaveLength(4)
  expect(r.columns).toHaveLength(columns)
  expect(r.ownedTokens.size).toBe(f.tokens.length - 1)
  const first = [...r.ownedTokens].filter(
    (i: Token) => i.rect[1] >= r.rows[1][1] && i.rect[3] <= r.rows[1][3]
  )
  expect(first.map((i: Token) => i.text)).toContain('final detail')
  expect(r.preservePhysicalRows).toBe(true)
  expect(f.tokens).toEqual(original)
})

it('retains unequal closed prose/scalar pairs and the complete caption below the frame', () => {
  const f = sourceOrdered(4, true)
  f.table.structure = { objects: [] }
  const result = refineTable(
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
  expect(result.grid).toHaveLength(4)
  expect(result.grid[0]).toEqual(['Field 0', '', 'Field 2', ''])
  expect(result.grid[3]).toEqual(['', '', 'Entry 2 2 continued', '5.0'])
  expect(result.unassigned).toEqual([])
  expect(
    result.cells
      .flatMap((c) => c.sourceRects)
      .map((r) => JSON.stringify(r))
      .sort()
  ).toEqual(
    f.tokens
      .slice(1)
      .map((i) => JSON.stringify(i.rect))
      .sort()
  )
})

it('requires scalar peers for the six-field wrapped family', () => {
  const f = sourceOrdered(6),
    item = f.tokens.find((i) => i.text === '1.0')
  item.text = 'x.0'
  item.sourceItem.text = 'x.0'
  f.context.sourceContent.items[item.sourceItem.index].str = 'x.0'
  const raw = f.context.operators.argsArray.find(
    (a) => Array.isArray(a?.[0]) && a[0].map((g) => g.unicode ?? '').join('') === '1.0'
  )
  raw[0][0].unicode = 'x'
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
})

it('does not admit an opaque whole raw packet absent from native source content', () => {
  const f = sourceOrdered(4, true)
  f.context.operators.fnArray.push(OPS.showText)
  f.context.operators.argsArray.push([
    [{ unicode: 'X', width: 500, isInFont: true, operatorListId: null }]
  ])
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
})

it('requires runtime program, complete caption and closing fence for the new source cycles', () => {
  const f = sourceOrdered(2)
  expect(recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules.slice(0, 2), f.context)
  ).toBeUndefined()
  expect(
    recoverNativeProseLaneRecords(
      f.table,
      f.tokens,
      [{ ...f.captions[0], lines: ['Table 1:'] }],
      f.rules,
      f.context
    )
  ).toBeUndefined()
})

it.each([
  'white',
  'alpha',
  'unknown-font',
  'Type3',
  'width',
  'orphan',
  'duplicate-origin',
  'changed-origin',
  'missing-font',
  'unproved-rule'
])('refuses %s without mutating native source owners', (mutation) => {
  const f = sourceOrdered(4)
  const ops = f.context.operators
  const text = ops.fnArray.indexOf(OPS.showText)
  if (mutation === 'white') {
    ops.fnArray.unshift(OPS.setFillRGBColor)
    ops.argsArray.unshift(['#ffffff'])
  }
  if (mutation === 'alpha') {
    ops.fnArray.unshift(OPS.setGState)
    ops.argsArray.unshift([[['ca', 0]]])
  }
  if (mutation === 'unknown-font') ops.argsArray[1][0] = 'unbound-font'
  if (mutation === 'Type3') ops.argsArray[text][0][0].operatorListId = 'type3-paint'
  if (mutation === 'width') ops.argsArray[text][0][0].width = 700
  if (mutation === 'orphan')
    ops.argsArray[text][0].push({ unicode: 'x', width: 500, isInFont: true, operatorListId: null })
  if (mutation === 'duplicate-origin') f.tokens[2].sourceItem.index = f.tokens[1].sourceItem.index
  if (mutation === 'changed-origin') f.tokens[2].sourceItem.text = 'other'
  if (mutation === 'missing-font') f.tokens.splice(3, 1)
  if (mutation === 'unproved-rule') {
    ops.fnArray.push(OPS.setDash)
    ops.argsArray.push([[2, 2], 0])
    const path = ops.fnArray.indexOf(OPS.constructPath)
    ops.fnArray.splice(path, 0, OPS.setDash)
    ops.argsArray.splice(path, 0, [[2, 2], 0])
  }
  const before = structuredClone(f.tokens)
  expect(
    recoverNativeProseLaneRecords(f.table, f.tokens, f.captions, f.rules, f.context)
  ).toBeUndefined()
  expect(f.tokens).toEqual(before)
})
