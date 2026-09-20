import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverWrappedSummaryGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-wrapped-summary-grid.mjs')).href
)
type SourceToken = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
}
const token = (text: string, x: number, y: number, width = text.length * 7): SourceToken => ({
  text,
  rect: [x, y, x + width, y + 18],
  baseline: y + 18,
  height: 18,
  horizontal: true
})
function fixture(): {
  raw: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; rect: number[] }[] }
  }
  tokens: SourceToken[]
  captions: { lines: string[]; rect: number[] }[]
  rules: number[][]
} {
  const tokens = [token('Characteristic', 128, 446), token('P', 708, 344), token('value', 708, 384)]
  for (const [index, name] of ['Control', 'Education', 'Exercise'].entries()) {
    const x = 356 + index * 117
    tokens.push(token(name, x, 242), token('group', x, 282), token(`(n=${100 + index})`, x, 323))
    for (const [n, part] of ['Num', 'ber', 'of', 'patie', 'nts'].entries())
      tokens.push(token(part, x, 365 + n * 40.5))
    tokens.push(token('(%)', x + 57, 446))
  }
  for (const [r, label] of ['Age (years)', 'Height (cm)', 'Body weight (kg)'].entries()) {
    const y = 630 + r * 124
    tokens.push(token(label, 128, y - 62), token('mean (SD)', 178, y), token('0.733', 708, y))
    for (let c = 0; c < 3; c++) {
      const x = 356 + c * 117
      tokens.push(token('55.4', x, y), token('(11.', x + 57, y - 20), token('3)', x + 57, y + 21))
    }
  }
  const xs = [118, 300, 400, 450, 517, 567, 634, 684, 756]
  const ys = [227, 281, 322, 363, 403, 444, 484, 525, 556, 590, 670, 710, 790, 830, 916]
  const raw = {
    id: 'wrapped-summary',
    cropRect: [118, 227, 756, 930],
    structure: {
      objects: [
        ...xs
          .slice(1)
          .map((x, c) => ({ label: 'table column', rect: [xs[c] - 118, 0, x - 118, 703] })),
        ...ys.slice(1).map((y, r) => ({ label: 'table row', rect: [0, ys[r] - 227, 638, y - 227] }))
      ]
    }
  }
  return {
    raw,
    tokens,
    captions: [{ lines: ['Table 1. Patient characteristics'], rect: [128, 180, 500, 200] }],
    rules: [[120, 559, 758, 559]]
  }
}
it('recovers repeated wrapped count headers and complete mean/SD records from source geometry', () => {
  const f = fixture(),
    original = structuredClone(f)
  const t = refineTable(f.raw, f.tokens, f.captions, [], f.rules)
  expect(t.grid[0]).toHaveLength(8)
  for (let n = 0; n < 3; n++) {
    expect(t.cells).toContainEqual(
      expect.objectContaining({
        row: 0,
        column: 1 + n * 2,
        colSpan: 2,
        text: `${['Control', 'Education', 'Exercise'][n]} group (n=${100 + n})`
      })
    )
    expect(t.grid[1][1 + n * 2]).toBe('Number of patients')
  }
  for (const r of [3, 5, 7])
    expect(t.grid[r]).toEqual([
      'mean (SD)',
      '55.4',
      '(11.3)',
      '55.4',
      '(11.3)',
      '55.4',
      '(11.3)',
      '0.733'
    ])
  expect(t.cells).toContainEqual(expect.objectContaining({ text: 'Body weight (kg)' }))
  const sd = t.cells.find((c: { row: number; column: number }) => c.row === 3 && c.column === 2)
  expect(sd.sourceTokens.map((i: { text: string }) => i.text)).toEqual(['(11.', '3)'])
  expect(t.unassigned).toEqual([])
  expect(f).toEqual(original)
})
it.each([
  'missing SD suffix',
  'unbalanced SD',
  'different heading',
  'missing caption',
  'missing divider',
  'divided record',
  'extra data',
  'misaligned sample'
])('abstains for %s', (failure) => {
  const f = fixture()
  if (failure === 'missing SD suffix')
    f.tokens.splice(
      f.tokens.findIndex((i) => i.text === '3)'),
      1
    )
  if (failure === 'unbalanced SD') f.tokens.find((i) => i.text === '3)')!.text = '3'
  if (failure === 'different heading') f.tokens.find((i) => i.text === 'patie')!.text = 'other'
  if (failure === 'missing caption') f.captions = []
  if (failure === 'missing divider') f.rules = []
  if (failure === 'divided record') f.rules.push([120, 640, 758, 640])
  if (failure === 'extra data') f.tokens.push(token('Unknown', 600, 698))
  if (failure === 'misaligned sample') {
    const i = f.tokens.find((i) => i.text === '(n=101)')!
    i.baseline += 10
    i.rect[1] += 10
    i.rect[3] += 10
  }
  expect(recoverWrappedSummaryGrid(f.raw, f.tokens, f.captions, f.rules)).toBeUndefined()
})
