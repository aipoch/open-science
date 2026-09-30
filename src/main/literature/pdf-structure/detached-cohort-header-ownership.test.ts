import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
it('recovers detached cohort names above a sample-only predicted header without a caption', () => {
  const x = fixture('detached-cohort-names-above-sample-size-row'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid[0]).toEqual(['', 'Cohort Alpha (n=27)', 'Cohort Beta (n=28)', 'P-value'])
  expect(t.grid[1].slice(1)).toEqual(['48 ± 7', '49 ± 8', '0.69'])
  expect(t.unassigned).toEqual([])
})
it('recovers underlined parents despite subpixel gaps and font boxes touching their underlines', () => {
  const x = fixture('segmented-underlines-with-overlapping-font-boxes'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.cells.find((c: { text: string }) => c.text === 'Cohort Alpha (n=27)')).toMatchObject({
    row: 0,
    column: 1,
    colSpan: 3
  })
  expect(t.cells.find((c: { text: string }) => c.text === 'Cohort Beta (n=28)')).toMatchObject({
    row: 0,
    column: 4,
    colSpan: 3
  })
  expect(t.cells.find((c: { text: string }) => c.text === 'Between-groups')).toMatchObject({
    row: 0,
    column: 8,
    colSpan: 2
  })
  expect(t.unassigned).toEqual([])
})
it('keeps wrapped left-aligned parents over their separately underlined child columns', () => {
  const x = fixture('wrapped-left-aligned-parents-over-underlined-child-columns'),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.cells.find((c: { text: string }) => c.text.startsWith('Estimated probability of change'))
  ).toMatchObject({
    row: 0,
    column: 2,
    colSpan: 2,
    text: 'Estimated probability of change across the observation period (%, 95% CI)†'
  })
  expect(t.cells.find((c: { text: string }) => c.text === 'Ratio (95% CI), p value')).toMatchObject(
    { row: 0, column: 4, colSpan: 2 }
  )
  expect(t.grid[1].slice(2, 4)).toEqual(['By 3 years', 'By 5 years'])
})
it.each(['missing-sample', 'incomplete-body', 'intervening-rule', 'extra-leading-line'])(
  'keeps detached text unassigned when sample-header evidence conflicts: %s',
  (variant) => {
    const x = fixture('detached-cohort-names-above-sample-size-row')
    if (variant === 'missing-sample')
      x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '(n=28)')
    if (variant === 'incomplete-body')
      x.tokens = x.tokens.filter((i: { text: string }) => i.text !== '0.29')
    if (variant === 'intervening-rule') x.rules.push([165, 163, 735, 163])
    if (variant === 'extra-leading-line') {
      const token = x.tokens.find((i: { text: string }) => i.text === 'Cohort Alpha')
      x.tokens.push({
        ...token,
        text: 'Separate annotation',
        baseline: token.baseline - 8,
        rect: token.rect.map((v: number, n: number) => (n % 2 ? v - 8 : v))
      })
    }
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(t.grid[0].join(' ')).not.toContain('Cohort Alpha')
  }
)
it.each(['no-underlines', 'large-stroke-gaps', 'deep-font-overlap'])(
  'does not infer parent spans without bounded native underline evidence: %s',
  (variant) => {
    const x = fixture('segmented-underlines-with-overlapping-font-boxes')
    if (variant === 'no-underlines') x.rules = []
    if (variant === 'large-stroke-gaps')
      x.rules = x.rules.map((r: number[]) => [r[0], r[1], r[2] - 3, r[3]])
    if (variant === 'deep-font-overlap')
      x.tokens = x.tokens.map((i: { rect: number[]; height: number }) =>
        i.rect[1] > 200 && i.rect[3] < 240
          ? { ...i, height: i.height + 3, rect: [i.rect[0], i.rect[1] - 3, i.rect[2], i.rect[3]] }
          : i
      )
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(
      t.cells.some(
        (c: { text: string; colSpan: number }) =>
          c.text === 'Cohort Alpha (n=27)' && c.colSpan === 3
      )
    ).toBe(false)
  }
)
it('does not combine a wrapped parent when its independently underlined peer is missing', () => {
  const x = fixture('wrapped-left-aligned-parents-over-underlined-child-columns')
  x.rules = x.rules.filter((r: number[]) => !(r[0] > 580 && r[1] < 250))
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.cells.some(
      (c: { text: string; colSpan: number }) =>
        c.text === 'Estimated probability of change across the observation period (%, 95% CI)†' &&
        c.colSpan === 2
    )
  ).toBe(false)
})
