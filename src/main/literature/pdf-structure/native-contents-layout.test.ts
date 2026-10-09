import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
type Token = { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean }
const item = (text: string, x: number, y: number, width: number): Token => ({
  text,
  rect: [x, y, x + width, y + 10],
  height: 10,
  baseline: y + 10,
  horizontal: true
})
const input = (): ReturnType<typeof JSON.parse> => {
  const titles = ['Introduction', 'Independent bounds', 'Boundary relations', 'Completion']
  const grid = titles.map((t, n) => [String(n + 1) + '.', t, String(n * 3 + 1)])
  return {
    table: {
      cropRect: [40, 80, 550, 210],
      grid,
      repairs: [],
      issues: [],
      unassigned: [],
      cells: grid.flatMap((row, r) =>
        row.map((text, c) => ({
          row: r,
          column: c,
          rowSpan: 1,
          colSpan: 1,
          text,
          rect: [[50, 90, 460][c], 110 + r * 20, [85, 450, 540][c], 120 + r * 20]
        }))
      )
    },
    tokens: [
      item('Contents', 245, 85, 70),
      ...grid.flatMap((row, r) =>
        row.map((t, c) => item(t, [50, 90, 500][c], 110 + r * 20, [15, 200, 15][c]))
      )
    ]
  }
}
it('rejects native section navigation even though its right lane has repeated scalars', () => {
  const { table, tokens } = input()
  expect(hasTableEvidence(table, undefined, tokens, [])).toBe(false)
})
it('keeps captioned and ruled directories, and ordinary independent record grids', () => {
  const { table, tokens } = input()
  expect(hasTableEvidence(table, { lines: ['Table 2. Records.'] }, tokens, [])).toBe(true)
  expect(hasTableEvidence(table, undefined, tokens, [[40, 80, 550, 80]])).toBe(true)
  tokens[0].text = 'Executable source'
  expect(hasTableEvidence(table, undefined, tokens, [])).toBe(true)
})

const wholeFontDirectory = (): ReturnType<typeof input> => {
  const original = input()
  const titles = ['Opening definitions', 'Independent bounds', 'Boundary relations', 'Completion']
  original.tokens = [
    item('CONTENTS', 245, 85, 70),
    ...titles.flatMap((title, n) => [
      item(`S${n + 1}. ${title}`, 50, 110 + n * 20, 220),
      item(String(n * 3 + 1), 500, 110 + n * 20, 15)
    ])
  ]
  original.table.grid = titles.map((title, n) => [`S${n + 1}. ${title}`, '', String(n * 3 + 1)])
  original.table.cells.forEach((cell: { text: string; row: number; column: number }) => {
    cell.text = original.table.grid[cell.row][cell.column]
  })
  return original
}

it('rejects whole-font letter-prefixed navigation without slicing section titles into cells', () => {
  const { table, tokens } = wholeFontDirectory()
  expect(hasTableEvidence(table, undefined, tokens, [])).toBe(false)
})

type DirectoryControl = ReturnType<typeof wholeFontDirectory> & {
  rules: number[][] | undefined
  caption?: { lines: string[] }
}
const directoryTitle = (x: DirectoryControl): Token =>
  x.tokens.find((i: Token) => /^S3\./.test(i.text))
const directoryTarget = (x: DirectoryControl): Token =>
  x.tokens.find((i: Token) => i.baseline === directoryTitle(x).baseline && /^\d+$/.test(i.text))
const directoryRefusals: [string, (x: DirectoryControl) => void][] = [
  ['missing title', (x) => (x.tokens[0].text = 'SECTION RECORDS')],
  ['skipped section ordinal', (x) => (directoryTitle(x).text = 'S8. Boundary relations')],
  ['mixed section prefix', (x) => (directoryTitle(x).text = 'A3. Boundary relations')],
  ['decreasing target', (x) => (directoryTarget(x).text = '1')],
  ['decimal measurement', (x) => (directoryTarget(x).text = '7.4')],
  ['independent field', (x) => x.tokens.push(item('kg', 350, 150, 20))],
  ['missing whole target', (x) => x.tokens.splice(x.tokens.indexOf(directoryTarget(x)), 1)],
  ['crossing full font', (x) => (directoryTarget(x).rect[2] = 551)],
  ['incomplete font height', (x) => (directoryTitle(x).height += 1)],
  ['wrong native baseline', (x) => (directoryTitle(x).baseline -= 1)],
  ['unavailable native rules', (x) => (x.rules = undefined)],
  ['spanning table rule', (x) => x.rules?.push([40, 82, 550, 82])],
  ['explicit table caption', (x) => (x.caption = { lines: ['Table 2. Directory records.'] })]
]

it.each(directoryRefusals)('retains whole-font record directories with %s', (_, mutate) => {
  const x: DirectoryControl = { ...wholeFontDirectory(), rules: [] }
  mutate(x)
  expect(hasTableEvidence(x.table, x.caption, x.tokens, x.rules)).toBe(true)
})

it.each(['non-finite', 'missing'])(
  'preserves a meaningful independent native field with %s coordinates',
  (geometry) => {
    const { table, tokens } = wholeFontDirectory()
    const field = item('Independent kg field', 350, 150, 80)
    field.rect = geometry === 'non-finite' ? [NaN, 150, 430, 160] : []
    tokens.push(field)
    expect(hasTableEvidence(table, undefined, tokens, [])).toBe(true)
  }
)
