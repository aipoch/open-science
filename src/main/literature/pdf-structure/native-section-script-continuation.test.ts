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

it('orders full-em letter notes after their labels using independent note definitions', () => {
  const x = fixture('full-em-letter-notes-with-separated-advance')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  for (const marker of ['d', 'e', 'f', 'g']) {
    const cells = t.cells.filter(
      (c: { column: number; sourceTokens: { text: string }[] }) =>
        c.column === 0 && c.sourceTokens.some((i) => i.text === marker)
    )
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) {
      expect(cell.text.endsWith(marker)).toBe(true)
      expect(cell.textRuns.at(-1)).toEqual({ text: marker, position: 'superscript' })
    }
  }
})

it('recovers an omitted stub section from an owned peer and indented signed records', () => {
  const x = fixture('unowned-section-before-indented-signed-record')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const row = t.grid.findIndex((r: string[]) => r[0] === 'Section two')
  expect(row).toBeGreaterThan(0)
  expect(t.grid[row].slice(1).every((s: string) => !s)).toBe(true)
  expect(t.grid[row + 1][1]).toBe('−2.222')
  expect(t.unassigned).toEqual([])
})

it('joins scripted parenthetical continuations to the preceding measured record', () => {
  const x = fixture('scripted-parenthetical-label-continuations')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const labels = t.cells.filter(
    (c: { column: number; text: string }) => c.column === 0 && c.text.startsWith('Relation between')
  )
  expect(labels).toHaveLength(2)
  for (const cell of labels) {
    expect(cell.text).toContain('(u2) and time')
    expect(cell.text).toContain('(b2) effect')
    expect(cell.textRuns.some((r: { position: string }) => r.position === 'subscript')).toBe(true)
  }
  expect(t.grid.some((r: string[]) => r[0].startsWith('(u'))).toBe(false)
  expect(t.unassigned).toEqual([])
})

it('keeps the terminal narrative record together when independent cells attest the same wrapping', () => {
  const x = fixture('terminal-narrative-record-with-parallel-wrapped-cells')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toHaveLength(4)
  expect(t.grid.at(-1)[0]).toContain('continued description')
  expect(t.grid.at(-1)[3]).toContain('continued description')
  expect(t.unassigned).toEqual([])
})

it('excludes a caption-only header band and keeps paired statistics on their source baseline', () => {
  const x = fixture('caption-only-header-band-above-repeated-statistics')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toHaveLength(5)
  expect(t.grid[0].some((s: string) => s === 'S0')).toBe(true)
  for (const column of [5, 10, 15, 20]) {
    const cell = t.cells.find(
      (c: { row: number; column: number }) => c.row === 4 && c.column === column
    )
    expect(cell.text).toBe('.222')
    expect(cell.rowSpan).toBe(1)
  }
  expect(t.unassigned).toEqual([])
})

it('requires an independent note before treating a separated full-em letter as a script', () => {
  const x = fixture('full-em-letter-notes-with-separated-advance')
  x.tokens = x.tokens.filter((i: { rect: number[] }) => i.rect[1] < x.table.cropRect[3])
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const cell = t.cells.find(
    (c: { column: number; sourceTokens: { text: string }[] }) =>
      c.column === 0 && c.sourceTokens.some((i) => i.text === 'g')
  )
  expect(cell.textRuns).toBeUndefined()
  expect(cell.text.startsWith('g ')).toBe(true)
})

it('does not invent a missing section without an independently owned peer', () => {
  const x = fixture('unowned-section-before-indented-signed-record')
  x.tokens = x.tokens.filter((i: { text: string }) => i.text !== 'Section one')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.unassigned).toContain('Section two')
})

it('keeps parenthetical subgroup rows separate without the continuation conjunction', () => {
  const x = fixture('scripted-parenthetical-label-continuations')
  for (const token of x.tokens) token.text = token.text.replace(') and time', ') versus time')
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid.filter((r: string[]) => r[0].startsWith('(u'))).toHaveLength(2)
})

it('does not merge a terminal narrative band without its closing border', () => {
  const x = fixture('terminal-narrative-record-with-parallel-wrapped-cells')
  const bottom = Math.max(...x.rules.map((r: number[]) => r[1]))
  x.rules = x.rules.filter((r: number[]) => r[1] !== bottom)
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.unassigned).toContain('continued description 26')
  expect(t.repairs).not.toContain('wrapped-comparison-record-recovered')
})

it('keeps shared probabilities when no adjacent statistic attests a record baseline', () => {
  const x = fixture('caption-only-header-band-above-repeated-statistics')
  for (const i of x.tokens.filter((i: { text: string }) => i.text === '.222')) {
    i.baseline -= 5
    i.rect[1] -= 5
    i.rect[3] -= 5
  }
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(
    t.cells.filter((c: { text: string; rowSpan: number }) => c.text === '.222' && c.rowSpan === 3)
  ).toHaveLength(4)
})
