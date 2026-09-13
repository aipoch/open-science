import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (n: number): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(`src/main/literature/pdf-structure/fixtures/source-grids/closed-directory-${n}.jsonl`)
  )
it.each([1, 2])('recovers complete source-closed directory cells on layout %s', (n) => {
  const x = load(n),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.map((r: string[]) => r[0])).toEqual(
    n === 1
      ? [
          'Country',
          'Australia',
          'Belgium',
          'Bulgaria',
          'Canada',
          'India',
          'Italy',
          'Japan',
          'Korea'
        ]
      : ['Norway', 'Poland', 'Romania', 'Russia', 'USA']
  )
  expect(t.unassigned).toEqual([])
  const row = t.grid.find((r: string[]) => r[0] === (n === 1 ? 'Canada' : 'Poland'))
  expect(row[1]).toContain(
    n === 1 ? 'University Health Network (65' : 'Medical University of Warsaw (1'
  )
  expect(row[2]).toContain(n === 1 ? 'Jonathan Deblois' : 'Maciej Sinski')
  expect(x).toEqual(load(n))
})
it.each(['no-rules', 'open-bottom', 'partial-divider', 'numeric-fields', 'wrapped-stub'])(
  'retains the fallback when closed-directory evidence is incomplete: %s',
  async (condition) => {
    const { recoverRuledHeaderGrid } = await import(
      pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-stub-grid.mjs')).href
    )
    const x = load(2)
    const grid = recoverRuledHeaderGrid(x.table, x.tokens, x.captions, x.rules)
    expect(grid).toBeDefined()
    if (condition === 'no-rules') x.rules = []
    if (condition === 'open-bottom')
      x.rules = x.rules.filter((r: number[]) => r[1] !== grid.rows.at(-1)[3] || r[3] !== r[1])
    if (condition === 'partial-divider') {
      const line = x.rules.find(
        (r: number[]) => r[0] === r[2] && Math.abs(r[0] - grid.columns[1][0]) < 1
      )
      line[3] -= 10
    }
    if (condition === 'numeric-fields')
      for (const i of x.tokens) if (i.rect[0] > grid.columns[1][0]) i.text = '123'
    if (condition === 'wrapped-stub') {
      const i = x.tokens.find((i: { text: string }) => i.text === 'Poland'),
        other = structuredClone(i)
      other.baseline += i.height * 1.2
      other.rect[1] += i.height * 1.2
      other.rect[3] += i.height * 1.2
      x.tokens.push(other)
    }
    expect(recoverRuledHeaderGrid(x.table, x.tokens, x.captions, x.rules)).toBeUndefined()
  }
)
