import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = <T>(name: string): T =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))

it.each(['fragmented-three-column-prose', 'disclosure-directory'])(
  'rejects source-supported non-table regions: %s',
  (name) => {
    const { table, tokens } = fixture<{ table: { grid: string[][] }; tokens: unknown[] }>(name)
    expect(hasTableEvidence(table, undefined, tokens)).toBe(false)
    expect(hasTableEvidence(table, { lines: ['Table 1. Reported outcomes.'] }, tokens)).toBe(true)
    const measured = structuredClone(table)
    measured.grid.push(measured.grid[0].map((_: string, index: number) => String(index + 1)))
    expect(hasTableEvidence(measured, undefined, tokens)).toBe(true)
  }
)

it('associates a rotated flowchart despite a full-height publisher strip', () => {
  const { page, captions } = fixture<{ page: { width: number }; captions: { lines: string[] }[] }>(
    'rotated-publisher-strip'
  )
  const results = associateFigures(
    page,
    captions.filter((c: { lines: string[] }) => c.lines[0].startsWith('Fig. 1.'))
  )
  expect(results).toHaveLength(1)
  expect(results[0].reason).not.toBe('ambiguous-graphic-direction')
  expect(results[0].rect).toBeDefined()
  expect(results[0].rect[2]).toBeLessThan(page.width * 0.94)
})

it('does not attach repeated isotope-prefixed body text as numbered table notes', () => {
  const { page, tables } = fixture<{ page: object; tables: object[] }>('repeated-isotope-prose')
  expect(associateTableNotes(page, tables)).toEqual([[]])
})
