import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Fixture = {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; rect: number[] }[] }
  }
  tokens: { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }[]
  captions: { page: number; lines: string[]; rect: number[] }[]
  rules: number[][]
}
function fixture(): Fixture {
  const lines = [
    ['Variable', 'Measure', 'T0', 'T1', 'T2'],
    ['First [1]', 'First measure', 'X', 'X', 'X'],
    ['', 'First measure ending', '', '', ''],
    ['Second [2]', 'Second measure', 'X', '', ''],
    ['', 'Second measure ending', '', '', ''],
    ['Third [3]', 'Third measure', 'X', 'X', 'X'],
    ['Fourth [4]', 'Fourth measure', 'X', 'X', 'X']
  ]
  const cuts = [0, 120, 340, 390, 440, 490]
  const tokens = lines.flatMap((r, n) =>
    r.flatMap((text, c) =>
      text
        ? [
            {
              text,
              rect: [cuts[c] + 5, n * 15 + 7, cuts[c + 1] - 5, n * 15 + 17],
              baseline: n * 15 + 17,
              height: 10,
              horizontal: true
            }
          ]
        : []
    )
  )
  const objects = cuts
    .slice(1)
    .map((x, c) => ({ label: 'table column', rect: [cuts[c], 0, x, 150] }))
  objects.push(
    ...[0, 1, 2, 3, 4].map((n) => ({ label: 'table row', rect: [0, n * 30, 490, (n + 1) * 30] }))
  )
  return {
    table: { id: 'page-1-table-1', cropRect: [0, 0, 490, 150], structure: { objects } },
    tokens,
    captions: [{ page: 1, lines: ['Table 1. Measures.'], rect: [0, -30, 490, -10] }],
    rules: [
      [0, 0, 490, 0],
      [0, 20, 490, 20],
      [0, 150, 490, 150]
    ]
  }
}
it('assigns citation-labelled variable and measure tails to the X-anchored record', () => {
  const f = fixture(),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid.find((r: string[]) => r[0] === 'First [1]')?.[1]).toBe(
    'First measure First measure ending'
  )
  expect(t.grid.find((r: string[]) => r[0] === 'Second [2]')?.[1]).toBe(
    'Second measure Second measure ending'
  )
  expect(t.grid).toHaveLength(5)
})
const { recoverStudyParagraphGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
)
it.each(['citation labels', 'timepoint heading', 'native closure', 'measured anchor'])(
  'declines cited timepoint paragraphs without %s',
  (kind) => {
    const f = fixture()
    if (kind === 'citation labels') f.tokens.find((i) => i.text === 'First [1]')!.text = 'First'
    if (kind === 'timepoint heading') f.tokens.find((i) => i.text === 'T1')!.text = 'Other'
    if (kind === 'native closure') f.rules.pop()
    if (kind === 'measured anchor') f.tokens.find((i) => i.text === 'X')!.text = 'Word'
    expect(recoverStudyParagraphGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)
