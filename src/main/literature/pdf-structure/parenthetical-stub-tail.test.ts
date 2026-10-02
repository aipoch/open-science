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
      'src/main/literature/pdf-structure/fixtures/parenthetical-stub-tail-inside-following-model-row.jsonl'
    )
  )

it('keeps a native closing-parenthesis stub tail with its record before the following totals', () => {
  const f = fixture()
  const table = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(table.grid.map((r: string[]) => r[0])).toEqual([
    'localization of finding',
    'regional finding (suspected local tissue)',
    'Total observed findings',
    'Total participants'
  ])
  expect(table.grid[1].slice(1)).toEqual(['4 (8.0)', '2 (4.0)', '0', '', '3 (6.0)'])
  expect(table.unassigned).toEqual([])
})

it.each(['balanced-head', 'intervening-rule', 'populated-tail'])(
  'does not borrow a new source row without delimiter and whitespace evidence: %s',
  (mode) => {
    const f = fixture()
    const head = f.tokens.find((i: { text: string }) => i.text.endsWith('(suspected'))
    const tail = f.tokens.find((i: { text: string }) => i.text === 'local tissue)')
    if (mode === 'balanced-head') head.text += ')'
    if (mode === 'intervening-rule') f.rules.push([57, 247.5, 812, 247.5])
    if (mode === 'populated-tail')
      f.tokens.push({ ...tail, text: '1', rect: [265, tail.rect[1], 273, tail.rect[3]] })
    const table = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(
      table.grid.some((r: string[]) => r[0] === 'regional finding (suspected local tissue)')
    ).toBe(false)
  }
)
