import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/terminal-paired-comparison-records.jsonl'
    )
  )
it.each([0, 1, 2])('retains the terminal comparison arm and its missing-value dash: %s', (n) => {
  const x = fixture().cases[n]
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid.at(-1)).toEqual(['', '', 'Control', '—', '', '', '', ''])
  expect(r.unassigned).not.toContain('Control')
  expect(r.unassigned).not.toContain('—')
  expect(
    r.cells.findLast((c: { text: string }) => /^Paired comparisons?$/.test(c.text))
  ).toMatchObject({ rowSpan: 2 })
})

it.each(['unknown arm', 'missing comparison label', 'missing value', 'closing rule'])(
  'does not append an unproven terminal comparison: %s',
  (guard) => {
    const x = fixture().cases[0]
    const tail = x.tokens.filter((i: { text: string }) => i.text === 'Control').at(-1)
    const dash = x.tokens.find(
      (i: { text: string; baseline: number }) =>
        i.text === '—' && Math.abs(i.baseline - tail.baseline) < 1
    )
    expect(dash).toBeDefined()
    if (guard === 'unknown arm') tail.text = 'Unobserved'
    if (guard === 'missing comparison label')
      x.tokens = x.tokens.filter((i: { text: string }) => !/^Paired/.test(i.text))
    if (guard === 'missing value') x.tokens = x.tokens.filter((i: unknown) => i !== dash)
    if (guard === 'closing rule') {
      const y = tail.rect[1] - 0.1
      x.rules.push([x.table.cropRect[0], y, x.table.cropRect[2], y])
    }
    const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(r.grid.at(-1)).not.toEqual(['', '', 'Control', '—', '', '', '', ''])
    expect(r.grid.at(-1)).not.toContain('Unobserved')
  }
)
