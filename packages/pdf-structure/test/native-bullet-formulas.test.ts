import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths'

const { hasNativeBulletFormulaList } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-bullet-formulas.mjs')).href
)
const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-evidence.mjs')).href
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- inferred native fixture
function fixture() {
  const tokens: {
      text: string
      rect: number[]
      baseline: number
      height: number
      horizontal: boolean
      sourceItem: { pageNumber: number; index: number; text: string }
    }[] = [],
    rules: number[][] = []
  const token = (text: string, x: number, baseline: number, width: number, height = 10): void => {
    tokens.push({
      text,
      rect: [x, baseline - height, x + width, baseline],
      baseline,
      height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: tokens.length, text }
    })
  }
  for (const [n, label] of ['Difference of ratios', 'Normalized contrast difference'].entries()) {
    const y = 40 + n * 60
    token('•', 10, y, 3, 7)
    token(label, 20, y, 100)
    token('1', 85, y + 15, 10)
    token('u', 85, y + 30, 10)
    token('−', 110, y + 25, 8)
    token('v', 135, y + 15, 10)
    token('w', 135, y + 30, 10)
    rules.push([80, y + 20, 100, y + 20], [130, y + 20, 150, y + 20])
  }
  const grid = [
    ['1', 'u', '−', 'v'],
    ['w', '1', 'u', 'v'],
    ['1', 'u', '−', 'v']
  ]
  const table = {
    cropRect: [9, 20, 180, 150],
    grid,
    cells: grid.flatMap((r, row) =>
      r.map((text, column) => ({
        text,
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 30, row * 30, column * 30 + 20, row * 30 + 10]
      }))
    ),
    issues: [],
    repairs: [],
    unassigned: []
  }
  return { tokens, rules, table }
}

it('rejects a complete native bullet-and-fraction list through the table evidence caller', () => {
  const f = fixture()
  expect(hasNativeBulletFormulaList(f.table, f.tokens, f.rules)).toBe(true)
  expect(hasTableEvidence(f.table, undefined, f.tokens, f.rules)).toBe(false)
  expect(hasTableEvidence(f.table, { text: 'Table 1. Measured records.' }, f.tokens, f.rules)).toBe(
    true
  )
})

it.each([
  'missing-bullet',
  'native-literal',
  'foreign-native',
  'foreign-unbound',
  'foreign-crossing',
  'missing-bar',
  'table-rule',
  'parameter-matrix',
  'captionless-record-table'
])('does not reject other native layouts: %s', (fault) => {
  const f = fixture()
  if (fault === 'missing-bullet') f.tokens.splice(7, 1)
  if (fault === 'native-literal') f.tokens[1].sourceItem.text = 'Different source'
  if (fault === 'foreign-native') {
    f.tokens[3].text = 'Ordinary explanation'
    f.tokens[3].sourceItem.text = f.tokens[3].text
  }
  if (fault === 'missing-bar') f.rules.pop()
  if (fault === 'table-rule') f.rules.push([9, 80, 180, 80])
  if (fault === 'parameter-matrix')
    for (const i of [0, 7]) {
      f.tokens[i].text = 'I'
      f.tokens[i].sourceItem.text = 'I'
    }
  if (fault === 'foreign-unbound')
    f.tokens.push({ ...f.tokens[3], text: 'Foreign', horizontal: false })
  if (fault === 'foreign-crossing')
    f.tokens.push({
      ...f.tokens[3],
      text: 'Foreign',
      rect: [20, 50, 210, 60],
      sourceItem: { pageNumber: 1, index: 100, text: 'Foreign' }
    })
  if (fault === 'captionless-record-table')
    for (const t of f.tokens) {
      t.text = '12'
      t.sourceItem.text = '12'
    }
  expect(hasNativeBulletFormulaList(f.table, f.tokens, f.rules)).toBe(false)
})

it('keeps a genuine captionless numeric record grid', () => {
  const f = fixture()
  f.table.grid = [
    ['Method', 'Error'],
    ['First', '12'],
    ['Second', '14']
  ]
  f.table.cells = f.table.grid.flatMap((r, row) =>
    r.map((text, column) => ({
      text,
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [column * 50, row * 25, column * 50 + 30, row * 25 + 10]
    }))
  )
  const native = f.table.cells.map(({ text, row, column }, index) => ({
    text,
    rect: [20 + column * 80, 30 + row * 35, 60 + column * 80, 40 + row * 35],
    baseline: 40 + row * 35,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text }
  }))
  expect(hasNativeBulletFormulaList(f.table, native, [])).toBe(false)
  expect(hasTableEvidence(f.table, undefined, native, [])).toBe(true)
})
