import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { recoverUnownedSourceRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-row-repair.mjs')).href
)

function sharedScientificFixture(): ReturnType<typeof JSON.parse> {
  const items: ReturnType<typeof JSON.parse>[] = [],
    groups: ReturnType<typeof JSON.parse>[] = []
  const add = (text: string, x: number, right: number, baseline: number, height = 10): void => {
    const i = {
      text,
      rect: [x, baseline - height, right, baseline],
      baseline,
      height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    }
    items.push(i)
    groups.at(-1).push(i)
  }
  groups.push([])
  for (const [text, x, right] of [
    ['Group', 5, 45],
    ['Class', 55, 72],
    ['Value', 90, 130],
    ['Rate', 160, 185]
  ] as const)
    add(text, x, right, 20)
  for (const [n, b] of [40, 60, 80, 100, 120].entries()) {
    groups.push([])
    if (n === 0) add('Alpha A', 5, 65, b)
    else {
      if (n >= 3) add(n === 3 ? 'Beta' : 'Gamma', 5, 45, b)
      add('B', 55, 65, b)
    }
    add('2', 90, 95, b)
    add('×', 98, 103, b)
    add('10', 106, 116, b)
    add('−', 116, 120, b - 4, 6)
    add('3', 120, 124, b - 4, 6)
    add('0.5', 160, 178, b)
  }
  return {
    items,
    groups,
    inventory: [...items],
    columnRects: [
      [0, 0, 50, 145],
      [50, 0, 80, 145],
      [80, 0, 140, 145],
      [140, 0, 200, 145]
    ],
    rows: [
      [0, 0, 200, 25],
      [0, 25, 200, 50],
      [0, 50, 200, 65],
      [0, 85, 200, 110],
      [0, 110, 200, 145]
    ].map((rect) => ({ rect })),
    repairs: [],
    rules: [
      [0, 5, 200, 5],
      [0, 25, 200, 25],
      [0, 85, 200, 85],
      [0, 140, 200, 140]
    ],
    observedRuns: [
      {
        text: 'Alpha A',
        rect: [5, 30, 65, 40],
        glyphRuns: [1, 1, 1, 1, 1, 1],
        literalGlyphs: ['A', 'l', 'p', 'h', 'a', 'A'],
        gaps: [{ index: 5, left: 45, right: 55 }]
      }
    ]
  }
}

it('preserves measured descriptor columns while recovering a complete terminal scientific record', () => {
  const x = sharedScientificFixture()
  recoverUnownedSourceRows(x)
  expect(x.rows).toHaveLength(6)
  expect(
    x.items
      .filter((i: { baseline: number; rect: number[] }) => i.baseline === 40 && i.rect[0] < 80)
      .map((i: { text: string }) => i.text)
  ).toEqual(['Alpha', 'A'])
  expect(x.repairs).toContain('native-complete-shared-scientific-record-recovered')
  expect(x.inventory[4].text).toBe('Alpha A')
})

it.each([
  'missing terminal rule',
  'partial record',
  'independent ink',
  'aliased native source',
  'missing ancestor'
])('does not manufacture a shared scientific record with %s', (variant) => {
  const x = sharedScientificFixture()
  if (variant === 'missing terminal rule') x.rules = x.rules.filter((r: number[]) => r[1] !== 85)
  if (variant === 'partial record')
    x.items = x.items.filter(
      (i: { baseline: number; text: string }) => !(i.baseline === 80 && i.text === '0.5')
    )
  if (variant === 'independent ink') {
    const i = {
      text: 'Note',
      rect: [5, 70, 40, 80],
      baseline: 80,
      height: 10,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: 100, text: 'Note' }
    }
    x.items.push(i)
    x.inventory.push(i)
  }
  if (variant === 'aliased native source')
    x.inventory.push({ sourceItems: [x.items[4].sourceItem] })
  if (variant === 'missing ancestor')
    x.items = x.items.filter((i: { text: string }) => i.text !== 'Alpha A')
  recoverUnownedSourceRows(x)
  expect(x.repairs).not.toContain('native-complete-shared-scientific-record-recovered')
})

it.each([
  'missing measurement',
  'ambiguous measurement',
  'wrong glyph literal',
  'mixed glyph runs',
  'untransportable narrow gap',
  'header crosses cut',
  'peer crosses cut',
  'nonmatching peer start',
  'intervening section rule'
])('keeps uncertain descriptor or terminal-record evidence conservative: %s', (variant) => {
  const x = sharedScientificFixture()
  if (variant === 'missing measurement') x.observedRuns = []
  if (variant === 'ambiguous measurement') x.observedRuns.push(structuredClone(x.observedRuns[0]))
  if (variant === 'wrong glyph literal') x.observedRuns[0].literalGlyphs[0] = 'X'
  if (variant === 'mixed glyph runs') x.observedRuns[0].glyphRuns[5] = 2
  if (variant === 'untransportable narrow gap')
    x.observedRuns[0].gaps[0] = { index: 5, left: 49, right: 52 }
  if (variant === 'header crosses cut') x.items[0].rect[2] = 52
  if (variant === 'peer crosses cut')
    x.items.find((i: { text: string }) => i.text === 'Beta').rect[2] = 52
  if (variant === 'nonmatching peer start')
    x.items.find((i: { text: string }) => i.text === 'Beta').rect[0] = 8
  if (variant === 'intervening section rule') x.rules.push([0, 45, 200, 45])
  recoverUnownedSourceRows(x)
  expect(x.repairs).not.toContain('native-complete-shared-scientific-record-recovered')
  if (variant !== 'intervening section rule')
    expect(x.items.some((i: { text: string }) => i.text === 'Alpha A')).toBe(true)
})
type Fixture = {
  groups: {
    text: string
    rect: number[]
    baseline: number
    height: number
    horizontal: boolean
  }[][]
  items: { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }[]
  columnRects: number[][]
  rows: { rect: number[] }[]
  repairs: string[]
}
function fixture(): Fixture {
  const values = [
    ['Measure', 'N', '%', 'N', '%', 'P'],
    ['Category A', '4', '40', '5', '50', '.20'],
    ['Size', 'N=12', '', 'N=14', '', '.15'],
    ['Category B', '6', '60', '7', '70', '.30']
  ]
  const columnRects = Array.from({ length: 6 }, (_, c) => [c * 100, 0, (c + 1) * 100, 80])
  const groups = values.map((r, n) =>
    r.flatMap((text, c) =>
      text
        ? [
            {
              text,
              rect: [c * 100 + 5, n * 20 + 5, c * 100 + 90, n * 20 + 15],
              baseline: n * 20 + 15,
              height: 10,
              horizontal: true
            }
          ]
        : []
    )
  )
  return {
    groups,
    items: groups.flat(),
    columnRects,
    rows: [0, 1, 3].map((n) => ({ rect: [0, n * 20, 600, (n + 1) * 20] })),
    repairs: [] as string[]
  }
}
it('retains a sparse sample-qualified metric only under explicit repeated N and percent leaves', () => {
  const f = fixture()
  recoverUnownedSourceRows(f)
  expect(f.rows).toHaveLength(4)
  expect(f.repairs).toContain('text-supported-row-recovered')
})
it.each(['sample leaves', 'paired sample', 'complete peer'])(
  'declines a sample metric without %s',
  (kind) => {
    const f = fixture()
    if (kind === 'sample leaves') f.groups[0][2].text = 'Other'
    if (kind === 'paired sample') f.groups[2][2].text = 'Value'
    if (kind === 'complete peer') {
      f.groups[1][1].text = 'Other'
      f.groups[3][1].text = 'Other'
    }
    recoverUnownedSourceRows(f)
    expect(f.rows).toHaveLength(3)
  }
)
