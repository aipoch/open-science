import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/centered-category-stubs-with-shared-and-independent-probabilities.jsonl'
    )
  )
it('recovers an omitted category and separates its shared probability from the preceding summary', () => {
  const x = fixture(),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.find((r: string[]) => r[1] === 'Level B')?.slice(2)).toEqual([
    '16 (59.3%)',
    '20 (60.6%)',
    ''
  ])
  expect(t.grid.find((r: string[]) => r[0] === 'Duration (years)')?.at(-1)).toBe('0.75')
  expect(t.unassigned).toEqual([])
})
it('distinguishes a group probability from probabilities aligned with individual categories', () => {
  const x = fixture(),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const shared = t.cells.find((c: { text: string }) => c.text === '0.91')
  expect(shared).toMatchObject({ rowSpan: 2, colSpan: 1 })
  expect(t.cells.find((c: { text: string }) => c.text === 'Grade n (%)')).toMatchObject({
    rowSpan: 2
  })
  for (const value of ['0.90 *', '0.67 **'])
    expect(t.cells.find((c: { text: string }) => c.text === value)).toMatchObject({ rowSpan: 1 })
})
it('keeps a long outdented section and its raised marker before the first probability column', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/outdented-section-label-crossing-empty-cohort-columns.jsonl'
    )
  ) as ReturnType<typeof JSON.parse>
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const label = t.cells.find((c: { text: string }) => c.text === 'Long assessment section d')
  expect(label).toMatchObject({ column: 0, colSpan: 3, rowSpan: 1 })
  expect(t.grid[label.row][3]).toBe('< 0.05')
  expect(t.unassigned).toEqual([])
})
const { recoverRuledCategoricalRecords } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
it.each(['incomplete-record', 'misaligned-statistic', 'missing-frame', 'extra-group'])(
  'does not infer category spans from contradictory native evidence: %s',
  (variant) => {
    const x = fixture()
    if (variant === 'incomplete-record')
      x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '20 (60.6%)')
    if (variant === 'misaligned-statistic')
      x.tokens = x.tokens.map(
        (i: { text: string; baseline: number; rect: number[]; height: number }) =>
          i.text === '0.91'
            ? { ...i, baseline: i.baseline - 8, rect: i.rect.map((v, n) => (n % 2 ? v - 8 : v)) }
            : i
      )
    if (variant === 'missing-frame') x.rules = x.rules.filter((r: number[]) => r[1] < 760)
    if (variant === 'extra-group') {
      const label = x.tokens.find((i: { text: string }) => i.text === 'Grade')
      x.tokens.push({
        ...label,
        text: 'Additional label',
        baseline: label.baseline + 45,
        rect: label.rect.map((v: number, n: number) => (n % 2 ? v + 45 : v))
      })
    }
    expect(recoverRuledCategoricalRecords(x.table, x.tokens, x.rules)).toBeUndefined()
  }
)
it.each(['occupied-cohort-cell', 'missing-probability-header', 'unindented-records'])(
  'does not move a long label without independent section evidence: %s',
  (variant) => {
    const x = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/outdented-section-label-crossing-empty-cohort-columns.jsonl'
      )
    ) as ReturnType<typeof JSON.parse>
    if (variant === 'occupied-cohort-cell')
      x.tokens.push({
        text: '7',
        baseline: 222.574995,
        height: 11.25,
        horizontal: true,
        rect: [350, 211.324995, 356, 222.574995]
      })
    if (variant === 'missing-probability-header')
      x.tokens = x.tokens.map((i: { text: string }) =>
        i.text === '-value' ? { ...i, text: '-score' } : i
      )
    if (variant === 'unindented-records')
      x.tokens = x.tokens.map((i: { text: string; rect: number[] }) =>
        /^(?:No|Yes)$/.test(i.text) ? { ...i, rect: i.rect.map((v, n) => (n % 2 ? v : v - 12)) } : i
      )
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(
      t.cells.some(
        (c: { text: string; column: number; colSpan: number }) =>
          c.text.includes('Long assessment section') && c.column === 0 && c.colSpan === 3
      )
    ).toBe(false)
  }
)
