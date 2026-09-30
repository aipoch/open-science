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
      'src/main/literature/pdf-structure/fixtures/source-grids/omitted-terminal-factor-interaction.jsonl'
    )
  )

it('retains a complete terminal interaction test below the two witnessed main effects', () => {
  const x = fixture()
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid.at(-1)).toEqual(['', '', '', '', '', 'Group × Time', '0.697', '.469'])
  expect(r.unassigned).toEqual([])
})

it.each(['unknown factor', 'missing statistic', 'closing rule'])(
  'does not infer an interaction record from incomplete evidence: %s',
  (guard) => {
    const x = fixture()
    const statistic = x.tokens.find((i: { text: string }) => i.text === '0.697')
    const tail = x.tokens.filter(
      (i: { baseline: number }) => Math.abs(i.baseline - statistic.baseline) < 1
    )
    if (guard === 'unknown factor')
      tail.find((i: { text: string }) => i.text === 'Time').text = 'Visit'
    if (guard === 'missing statistic') x.tokens = x.tokens.filter((i: unknown) => i !== statistic)
    if (guard === 'closing rule') {
      const y = statistic.rect[1] - 0.1
      x.rules.push([x.table.cropRect[0], y, x.table.cropRect[2], y])
    }
    const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(r.grid.at(-1)).toEqual(['', '', '', '', '', 'Time', '0.297', '.693'])
  }
)
