import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { hasNativeLiteralColumnConflict, hasNativeMeasuredHeadingAmbiguity } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-column-conflicts.mjs')).href
)
type Data = ReturnType<typeof JSON.parse>
const font = (text: string, x: number, width: number, baseline = 20): Data => ({
  text,
  rect: [x, baseline - 10, x + width, baseline],
  baseline,
  height: 10,
  horizontal: true
})
const cell = (row: number, column: number, fonts: Data[], rect: number[], rowSpan = 1): Data => ({
  cell: { row, column, rowSpan, colSpan: 1, rect, text: fonts.map((i) => i.text).join(' ') },
  fonts
})
const run = (input: Data): boolean =>
  hasNativeLiteralColumnConflict(
    { proved: input.proved },
    input.inventory ?? input.proved.flatMap((p: Data) => p.fonts),
    input.rules ?? []
  )

function decimal(): Data {
  return {
    proved: [
      cell(0, 1, [font('+2', 10, 10)], [0, 0, 22, 25]),
      cell(0, 2, [font('.', 20, 2), font('4', 22, 5)], [22, 0, 40, 25])
    ]
  }
}
it('rejects a contiguous native decimal consumed by adjacent independent cells', () => {
  expect(run(decimal())).toBe(true)
})
it.each([
  'gap',
  'baseline',
  'height',
  'non-number',
  'same-owner',
  'legal-span',
  'different-row',
  'vertical-rule',
  'competing-item',
  'unassigned-slash',
  'unassigned-script',
  'unknown-position'
])('does not infer a split decimal from %s', (variant) => {
  const d = decimal(),
    [a, b] = d.proved
  if (variant === 'gap') b.fonts[1].rect[0] += 1
  if (variant === 'baseline') b.fonts[1].baseline += 1
  if (variant === 'height') b.fonts[1].height = 8
  if (variant === 'non-number') b.fonts[1].text = 'x'
  if (variant === 'same-owner') {
    a.fonts.push(...b.fonts)
    d.proved.pop()
  }
  if (variant === 'legal-span') a.cell.colSpan = 2
  if (variant === 'different-row') a.cell.row = 1
  if (variant === 'vertical-rule') d.rules = [[21, 0, 21, 25]]
  if (variant === 'competing-item')
    d.inventory = [...d.proved.flatMap((p: Data) => p.fonts), font('7', 22, 5)]
  if (variant === 'unassigned-slash')
    d.inventory = [...d.proved.flatMap((p: Data) => p.fonts), font('/', 15, 3)]
  if (variant === 'unassigned-script')
    d.inventory = [...d.proved.flatMap((p: Data) => p.fonts), font('x', 19, 4, 13)]
  if (variant === 'unknown-position')
    d.inventory = [...d.proved.flatMap((p: Data) => p.fonts), { text: 'unknown' }]
  expect(run(d)).toBe(false)
})

function repeated(): Data {
  const proved = [
    cell(1, 0, [font('Rate', 0, 15)], [0, 10, 20, 20]),
    cell(1, 1, [font('Gain', 30, 15)], [20, 10, 50, 20]),
    cell(1, 2, [font('Rate', 60, 15), font('Gain', 90, 15)], [50, 10, 110, 20])
  ]
  for (let row = 2; row < 4; row++)
    proved.push(
      cell(
        row,
        2,
        [font('0.4', 60, 15, row * 15), font('0.8', 90, 15, row * 15)],
        [50, row * 15 - 10, 110, row * 15]
      )
    )
  return { proved }
}
it('rejects repeated independent leaf fields merged in every numeric record', () => {
  expect(run(repeated())).toBe(true)
})
it.each([
  'single-record',
  'different-peer',
  'legal-span',
  'text-record',
  'offset-field',
  'stacked-header',
  'stacked-record',
  'extra-value',
  'unequal-font',
  'unassigned-operator',
  'unassigned-conjunction',
  'peer-conjunction'
])('does not infer repeated leaf conflict from %s', (variant) => {
  const d = repeated()
  if (variant === 'single-record') d.proved.pop()
  if (variant === 'different-peer') d.proved[0].fonts[0].text = 'Other'
  if (variant === 'legal-span') d.proved[2].cell.colSpan = 2
  if (variant === 'text-record') d.proved[3].fonts[0].text = 'pair'
  if (variant === 'offset-field') d.proved[3].fonts[0].rect = [70, 20, 85, 30]
  if (variant === 'stacked-header') d.proved[2].fonts[1].baseline += 10
  if (variant === 'stacked-record') d.proved[3].fonts[1].baseline += 10
  if (variant === 'extra-value') d.proved[3].fonts.push(font('0.1', 110, 15, 30))
  if (variant === 'unequal-font') d.proved[3].fonts[1].height = 7
  if (variant === 'unassigned-operator')
    d.inventory = [...d.proved.flatMap((p: Data) => p.fonts), font('×', 80, 5, 30)]
  if (variant === 'unassigned-conjunction')
    d.inventory = [...d.proved.flatMap((p: Data) => p.fonts), font('/', 80, 5)]
  if (variant === 'peer-conjunction')
    d.inventory = [...d.proved.flatMap((p: Data) => p.fonts), font('/', 20, 5)]
  expect(run(d)).toBe(false)
})

function heading(): Data {
  const title = font('Group Variant', 10, 55)
  const proved = [cell(0, 1, [title, font('choice', 40, 25, 35)], [35, 0, 70, 40], 2)]
  for (let row = 2; row < 4; row++) {
    proved.push(cell(row, 0, [font('A', 15, 10, 20 + row * 15)], [0, 40, 35, 80]))
    proved.push(cell(row, 1, [font('B', 45, 10, 20 + row * 15)], [35, 40, 70, 80]))
  }
  return {
    proved,
    cells: [
      ...proved.map((p) => p.cell),
      { row: 0, column: 0, rowSpan: 1, colSpan: 1, rect: [0, 0, 35, 25], text: '' }
    ],
    rules: [[0, 40, 70, 40]],
    runs: [
      {
        text: title.text,
        rect: title.rect,
        literalGlyphs: [...'GroupVariant'],
        glyphRuns: Array(12).fill(0),
        gaps: [{ index: 5, left: 30, right: 40 }]
      }
    ]
  }
}
it('keeps a measured wrapped-title overhang out of confirmed conflicts', () => {
  const d = heading()
  expect(run(d)).toBe(false)
  expect(
    hasNativeMeasuredHeadingAmbiguity(
      { proved: d.proved },
      { cells: d.cells },
      d.proved.flatMap((p: Data) => p.fonts),
      d.rules,
      d.runs
    )
  ).toBe(true)
})
it.each([
  'no-measurement',
  'duplicate-measurement',
  'wrong-glyphs',
  'independent-runs',
  'no-divider',
  'short-divider',
  'single-record',
  'occupied-header',
  'legal-parent',
  'no-wrap',
  'extra-native-header',
  'extra-upper-title',
  'extra-body-operator'
])('does not infer displaced heading conflict from %s', (variant) => {
  const d = heading()
  if (variant === 'no-measurement') d.runs = []
  if (variant === 'duplicate-measurement') d.runs.push(structuredClone(d.runs[0]))
  if (variant === 'wrong-glyphs') d.runs[0].literalGlyphs[0] = 'X'
  if (variant === 'independent-runs') d.runs[0].glyphRuns[5] = 1
  if (variant === 'no-divider') d.rules = []
  if (variant === 'short-divider') d.rules[0][0] = 35
  if (variant === 'single-record') d.proved.splice(3)
  if (variant === 'occupied-header') d.cells.at(-1).text = 'Existing'
  if (variant === 'legal-parent') d.proved[0].cell.colSpan = 2
  if (variant === 'no-wrap') d.proved[0].fonts.pop()
  if (variant === 'extra-native-header')
    d.inventory = [...d.proved.flatMap((p: Data) => p.fonts), font('Extra', 10, 10, 35)]
  if (variant === 'extra-upper-title')
    d.inventory = [...d.proved.flatMap((p: Data) => p.fonts), font('Extra', 10, 10)]
  if (variant === 'extra-body-operator')
    d.inventory = [...d.proved.flatMap((p: Data) => p.fonts), font('=', 32, 5, 50)]
  expect(run(d)).toBe(false)
  expect(
    hasNativeMeasuredHeadingAmbiguity(
      { proved: d.proved },
      { cells: d.cells },
      d.inventory ?? d.proved.flatMap((p: Data) => p.fonts),
      d.rules,
      d.runs
    )
  ).toBe(false)
})

it('rejects a decimal tail fused with the following description across a cell boundary', () => {
  const d = decimal()
  d.proved[0].fonts.push(d.proved[1].fonts.shift())
  d.proved[1].fonts[0].text = '4 Description'
  d.proved[1].fonts[0].rect[2] = 90
  expect(run(d)).toBe(true)
})
it.each(['gap', 'non-number', 'different-baseline', 'crossing-rule', 'foreign-ink'])(
  'requires exact native continuity for a decimal tail with prose: %s',
  (mode) => {
    const d = decimal()
    d.proved[0].fonts.push(d.proved[1].fonts.shift())
    const tail = d.proved[1].fonts[0]
    tail.text = '4 Description'
    tail.rect[2] = 90
    if (mode === 'gap') tail.rect[0] += 1
    if (mode === 'non-number') tail.text = 'Description 4'
    if (mode === 'different-baseline') tail.baseline += 1
    if (mode === 'crossing-rule') d.rules = [[21, 0, 21, 25]]
    if (mode === 'foreign-ink')
      d.inventory = [...d.proved.flatMap((p: Data) => p.fonts), font('Other', 30, 10)]
    expect(run(d)).toBe(false)
  }
)
