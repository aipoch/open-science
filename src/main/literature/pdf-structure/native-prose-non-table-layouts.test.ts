import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
const item = (
  text: string,
  x: number,
  y: number,
  width: number,
  height = 10
): { text: string; rect: number[]; height: number; horizontal: boolean; baseline: number } => ({
  text,
  rect: [x, y, x + width, y + height],
  height,
  horizontal: true,
  baseline: y + height
})
const table = (
  grid: string[][],
  cropRect = [0, 0, 500, 180]
): {
  grid: string[][]
  cropRect: number[]
  cells: {
    text: string
    row: number
    column: number
    colSpan: number
    rowSpan: number
    rect: number[]
  }[]
  issues: string[]
  repairs: string[]
  unassigned: string[]
} => ({
  grid,
  cropRect,
  cells: grid.flatMap((r, row) =>
    r.map((text, column) => ({
      text,
      row,
      column,
      colSpan: 1,
      rowSpan: 1,
      rect: [column * 250, row * 40, (column + 1) * 250, row * 40 + 40]
    }))
  ),
  issues: [],
  repairs: [],
  unassigned: []
})
interface Input {
  case: string
  table: ReturnType<typeof table>
  tokens: ReturnType<typeof item>[]
  rules: number[][]
}
const inputs: Input[] = readFileSync(
  resolve('src/main/literature/pdf-structure/fixtures/native-prose-non-table-layouts.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

it.each(inputs)(
  'rejects $case without inventing a detector grid',
  ({ table: t, tokens, rules }) => {
    expect(hasTableEvidence(t, undefined, tokens, rules)).toBe(false)
    expect(hasTableEvidence(t, { lines: ['Table 1. Native comparison.'] }, tokens, rules)).toBe(
      true
    )
    expect(
      hasTableEvidence(t, undefined, tokens, [
        [0, 0, 500, 0],
        [0, 170, 500, 170]
      ])
    ).toBe(true)
    expect(hasTableEvidence(t, undefined, [], rules)).toBe(true)
    expect(hasTableEvidence(t, undefined, tokens)).toBe(true)
  }
)

it('preserves a citation column paired with independent values or descriptive records', () => {
  const original = inputs[0]
  for (const numeric of [true, false]) {
    const t = structuredClone(original.table)
    const tokens = structuredClone(original.tokens)
    t.grid.forEach((r, row) => {
      r[1] = numeric ? String(row + 4) : 'Independent native description'
      t.cells[row * 2 + 1].text = r[1]
      tokens.push(item(r[1], 300, 20 + row * 40, numeric ? 15 : 190))
    })
    expect(hasTableEvidence(t, undefined, tokens, [])).toBe(true)
  }
})

it('requires repeated right-hand ordinals and connecting native math rows', () => {
  const original = inputs[1]
  for (const missing of ['ordinal', 'connection', 'introduction']) {
    const tokens = original.tokens.filter((i) =>
      missing === 'ordinal'
        ? !/^\(A.2\)$/.test(i.text)
        : missing === 'connection'
          ? !/^\+/.test(i.text)
          : !/^Another/.test(i.text)
    )
    expect(hasTableEvidence(original.table, undefined, tokens, [])).toBe(true)
  }
})

it('recognizes native footnote separators and small raised ordinals in a partial footer crop', () => {
  const t = table(
    [
      ['A native paragraph continues with several ordinary words', '12'],
      ['An independent footnote starts with several ordinary words', 'tail']
    ],
    [0, 0, 500, 110]
  )
  t.cells.forEach((c) => {
    c.rect[0] = c.column === 0 ? 0 : 400
    c.rect[2] = c.column === 0 ? 400 : 500
  })
  const tokens = [
    item('A native paragraph continues with several ordinary words', 10, 5, 380, 12),
    item('12', 410, 25, 9, 8),
    item('11', 9, 45, 9, 8),
    item('An independent footnote starts with several ordinary words', 23, 45, 367, 12),
    item('A following native line ends here.', 10, 59, 190, 12),
    item('tail', 411, 59, 25, 12)
  ]
  const rules = [
    [10, 44, 170, 44],
    [410, 24, 570, 24]
  ]
  expect(hasTableEvidence(t, undefined, tokens, rules)).toBe(false)
  expect(hasTableEvidence(t, undefined, tokens, rules.slice(0, 1))).toBe(true)
  expect(
    hasTableEvidence(
      t,
      undefined,
      tokens.filter((i) => i.text !== '11'),
      rules
    )
  ).toBe(true)
})
