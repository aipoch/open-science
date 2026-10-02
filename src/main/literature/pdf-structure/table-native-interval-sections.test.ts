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
  const labels = [
    ['', 'Group A', 'Group B'],
    ['', 'Adjusted means [95 % CI]', ''],
    ['(a) First stage', '', ''],
    ['Up to 48 months', '0.701 [0.671–0.731]', '0.708 [0.682–0.735]'],
    ['(b) Second stage', '', ''],
    ['Up to 24 months', '0.711 [0.684–0.739]', '']
  ]
  const tokens = labels.flatMap((r, n) =>
    r.flatMap((text, c) =>
      text
        ? [
            {
              text,
              rect: [c * 130 + 5, n * 20 + 5, c * 130 + (n === 1 ? 245 : 120), n * 20 + 15],
              baseline: n * 20 + 15,
              height: 10,
              horizontal: true
            }
          ]
        : []
    )
  )
  const objects = [0, 1, 2].map((c) => ({
    label: 'table column',
    rect: [c * 130, 0, (c + 1) * 130, 130]
  }))
  objects.push(
    ...[0, 1, 2, 3, 4].map((n) => ({ label: 'table row', rect: [0, n * 24, 390, (n + 1) * 24] }))
  )
  return {
    table: { id: 'page-1-table-1', cropRect: [0, 0, 390, 130], structure: { objects } },
    tokens,
    captions: [{ page: 1, lines: ['Table 1. Period summaries.'], rect: [0, -30, 390, -10] }],
    rules: [
      [0, 0, 390, 0],
      [0, 40, 390, 40],
      [0, 130, 390, 130]
    ]
  }
}
it('keeps lettered section headings independent of complete and source-empty interval records', () => {
  const f = fixture(),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(
    t.grid.some(
      (r: string[]) => r[0] === 'Up to 24 months' && r[1] === '0.711 [0.684–0.739]' && r[2] === ''
    )
  ).toBe(true)
  expect(
    t.cells.find((c: { text: string }) => c.text === 'Adjusted means [95 % CI]')?.colSpan
  ).toBe(2)
  expect(
    t.grid.some((r: string[]) => r[0] === '(a) First stage' && r.slice(1).every((s) => !s))
  ).toBe(true)
})
const { recoverClinicalCountSections } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-sectional-records.mjs')).href
)
it.each(['CI heading', 'section sequence', 'closed border', 'numeric record'])(
  'declines sparse interval recovery without %s proof',
  (reason) => {
    const f = fixture()
    if (reason === 'CI heading')
      f.tokens.find((i) => i.text === 'Adjusted means [95 % CI]')!.text = 'Description'
    if (reason === 'section sequence')
      f.tokens.find((i) => i.text === '(b) Second stage')!.text = '(d) Second stage'
    if (reason === 'closed border') f.rules.pop()
    if (reason === 'numeric record')
      f.tokens.find((i) => i.text === '0.711 [0.684–0.739]')!.text = 'explanatory sentence'
    expect(recoverClinicalCountSections(f.table, f.tokens, f.rules)?.repair).not.toBe(
      'native-body-records-recovered'
    )
  }
)
