import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { rejectNativeLetterFractionScriptMetadata } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-letter-fraction-metadata.jsonl'
    )
  )

it('refuses partial letter-fraction superscripts only when native bars prove stacked ownership', () => {
  const f = fixture(),
    original = structuredClone(f.unsupportedCells)
  expect(rejectNativeLetterFractionScriptMetadata(f.unsupportedCells, f.rules)).toBe(3)
  expect(f.unsupportedCells.every((c: { textRuns?: unknown }) => !c.textRuns)).toBe(true)
  for (const [n, cell] of f.unsupportedCells.entries()) {
    const expected = structuredClone(original[n])
    delete expected.textRuns
    expect(cell).toEqual(expected)
  }
})

it('keeps actual dimension squares, degree signs and cubic units with their native script metadata', () => {
  const f = fixture(),
    original = structuredClone(f.safeCells)
  expect(rejectNativeLetterFractionScriptMetadata(f.safeCells, f.rules)).toBe(0)
  expect(f.safeCells).toEqual(original)
  expect(
    f.safeCells.map((c: { textRuns: { text: string; position: string }[] }) =>
      c.textRuns.filter((r) => r.position === 'superscript').map((r) => r.text)
    )
  ).toEqual([['2'], ['◦'], ['3']])
})

it('does not reject raised glyphs merely because another source line lies below', () => {
  const f = fixture(),
    original = structuredClone(f.unsupportedCells)
  expect(rejectNativeLetterFractionScriptMetadata(f.unsupportedCells, [])).toBe(0)
  expect(f.unsupportedCells).toEqual(original)
  const displaced = fixture()
  for (const c of displaced.unsupportedCells)
    for (const i of c.sourceTokens)
      if (i.text === 's') i.rect = i.rect.map((v: number, n: number) => (n % 2 === 0 ? v + 20 : v))
  expect(
    rejectNativeLetterFractionScriptMetadata(displaced.unsupportedCells, displaced.rules)
  ).toBe(0)
})

it('preserves the complete production literal grid and native geometry while declining unsupported fraction formatting', () => {
  const f = fixture(),
    original = structuredClone(f)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toEqual(f.expectedGrid)
  for (const c of f.unsupportedCells) {
    const current = r.cells.find(
      (x: { row: number; column: number }) => x.row === c.row && x.column === c.column
    )
    expect(current.textRuns).toBeUndefined()
    expect(current.text).toBe(c.text)
    expect(current.sourceRects).toEqual(c.sourceRects)
  }
  expect(r.unassigned).toEqual([])
  expect(f).toEqual(original)
})
