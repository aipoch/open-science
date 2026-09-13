import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { readingRotation } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-orientation.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))

it('keeps all wrapped measurements with their unique source code', () => {
  const x = fixture('coded-multiline-records')
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(15)
  expect(r.grid.find((row: string[]) => row[1] === 'HT')[4]).toContain('283.3 (83%)')
  expect(r.grid.find((row: string[]) => row[1] === 'DHDE')[4]).toContain('255.5 (100%),')
  expect(r.grid.find((row: string[]) => row[1] === 'DHDE')[5]).toBe('277 (13 600)')
  expect(r.grid.find((row: string[]) => row[1] === 'GLYE')[5]).toBe('256 (22 387)')
})

it('recognizes a sideways caption whose number is a separate native token', () => {
  expect(readingRotation({ rotate: 0 }, fixture('split-sideways-caption'))).toBe(90)
})

it('restores ruled timepoint and statistic groups without dropping any record', () => {
  const x = fixture('ruled-timepoint-statistics')
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(10)
  expect(r.grid[1].slice(1)).toEqual([
    'T0',
    'T1',
    'T2',
    'T3',
    'T0',
    'T1',
    'T2',
    'T3',
    'F',
    'P',
    'F',
    'P',
    'F',
    'P'
  ])
  expect(r.grid[2].slice(9, 11)).toEqual(['9.058882', '**'])
  expect(r.grid.at(-1).slice(9, 11)).toEqual(['3.817725', '0.053'])
  expect(r.unassigned).toEqual([])
  expect(
    r.cells
      .filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan > 1)
      .map((c: { colSpan: number }) => c.colSpan)
  ).toEqual([4, 4, 2, 2, 2])
})

it.each(['duplicate-code', 'unanchored-label', 'crossing-scalar'])(
  'rejects ambiguous coded records: %s',
  (condition) => {
    const x = fixture('coded-multiline-records')
    const code = x.tokens.find((i: { text: string }) => i.text === 'EL')
    if (condition === 'duplicate-code') code.text = 'ED'
    if (condition === 'unanchored-label')
      x.tokens.push({
        ...code,
        text: 'Unrelated section',
        rect: [70, 228, 175, 239],
        baseline: 239
      })
    if (condition === 'crossing-scalar')
      x.tokens.find((i: { text: string }) => i.text === '298.1205').rect[2] = 430
    expect(refineTable(x.table, x.tokens, x.captions, [], x.rules).grid).not.toHaveLength(15)
  }
)

it.each(['different-timepoints', 'missing-group-rule', 'unplaced-statistic'])(
  'retains review when timepoint source evidence conflicts: %s',
  (condition) => {
    const x = fixture('ruled-timepoint-statistics')
    if (condition === 'different-timepoints')
      x.tokens.find((i: { text: string }) => i.text === 'T2').text = 'T9'
    if (condition === 'missing-group-rule')
      x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 168.445198059) > 0.1)
    if (condition === 'unplaced-statistic')
      x.tokens.find((i: { text: string }) => i.text === '52.885687').rect[2] = 1105
    expect(refineTable(x.table, x.tokens, x.captions, [], x.rules).grid).not.toHaveLength(10)
  }
)

it.each(['distant-number', 'other-baseline', 'upright-caption'])(
  'does not rotate mixed prose from unsupported split captions: %s',
  (condition) => {
    const x = fixture('split-sideways-caption')
    const label = x.items.find((i: { str: string }) => i.str === 'Table')
    const number = x.items.find((i: { str: string }) => i.str === '5')
    if (condition === 'distant-number') number.transform[5] += 20
    if (condition === 'other-baseline') number.transform[4] += 10
    if (condition === 'upright-caption')
      x.items.push({ ...label, str: 'Table 6 Results', transform: [8.5, 0, 0, 8.5, 400, 700] })
    expect(readingRotation({ rotate: 0 }, x)).toBe(0)
  }
)

it('attaches a raised reference marker with slight source glyph overlap', () => {
  const x = fixture('coded-multiline-records')
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.cells.find((c: { text: string }) => c.text === 'Ref.d').textRuns).toEqual([
    { text: 'Ref.', position: 'normal' },
    { text: 'd', position: 'superscript' }
  ])
})

it('keeps a substantially overlapping marker out of the adjacent-script path', () => {
  const x = fixture('coded-multiline-records')
  const marker = x.tokens.find(
    (t: { text: string; rect: number[] }) => t.text === 'd' && t.rect[1] < 165
  )
  marker.rect[0] -= 2
  marker.rect[2] -= 2
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    r.cells.find((c: { column: number; row: number }) => c.row === 0 && c.column === 6).textRuns
  ).toBeUndefined()
})
