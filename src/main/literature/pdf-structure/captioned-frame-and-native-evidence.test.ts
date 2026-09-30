import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const resource = (name: string): string =>
  pathToFileURL(resolve('resources/pdf-structure', `literature-pdf-${name}.mjs`)).href
const { findCaptionCandidates } = await import(resource('caption-group'))
const { associateFigures } = await import(resource('association'))
const { associateTableNotes } = await import(resource('table-notes'))
const { hasTableEvidence } = await import(resource('table-evidence'))
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )

it.each([
  'raster-plate-inside-captioned-frame',
  'flowchart-below-caption-inside-frame',
  'localized-numbered-figure-caption'
])('retains the complete caption-owned graphic: %s', (name) => {
  const { page, rules } = fixture(name)
  const captions = findCaptionCandidates([page])
  const figures = associateFigures(
    page,
    captions,
    [],
    rules.map((r: number[]) => r.map((v) => v / 1.5))
  )
  expect(figures.filter((f: { rect?: number[] }) => f.rect)).toHaveLength(1)
  const rect = figures[0].rect
  if (name === 'flowchart-below-caption-inside-frame') {
    expect(rect[1]).toBeGreaterThan(captions[0].rect[3])
    expect(rect[3]).toBeGreaterThan(573)
  }
})

it('retains a double-spaced continuation below an isolated figure', () => {
  const { page } = fixture('double-spaced-caption-below-isolated-plate')
  expect(findCaptionCandidates([page])[0].lines).toHaveLength(2)
})

it.each([
  'structured-abstract-with-clipped-prose',
  'bibliographic-tail-with-page-number',
  'numbered-affiliations-in-model-columns'
])('rejects native non-table evidence: %s', (name) => {
  const { table, tokens } = fixture(name)
  expect(hasTableEvidence(table, undefined, tokens)).toBe(false)
})

it('associates separately painted raised note letters despite their full-size font boxes', () => {
  const { page, tables, rules } = fixture('full-size-raised-letter-table-notes')
  const notes = associateTableNotes(page, tables, rules)[0]
  expect(notes).toHaveLength(3)
  expect(notes[1].text).toMatch(/^a Adjusted/)
  expect(notes[2].text).toMatch(/^b Adjusted/)
})
it.each([
  [
    'framed-vector-plots-beside-prose',
    (rect: number[]) => rect[0] > 50 && rect[2] < 290 && rect[3] > 715
  ],
  ['legend-section-heading-above-raster-plate', (rect: number[]) => rect[1] > 90],
  ['running-logo-and-rule-above-raster-plate', (rect: number[]) => rect[1] > 65 && rect[2] < 400]
] as const)('excludes external text and page furniture: %s', (name, check) => {
  const { page, rules } = fixture(name),
    captions = findCaptionCandidates([page])
  const figures = associateFigures(page, captions, [], rules)
  expect(figures).toHaveLength(1)
  expect(check(figures[0].rect)).toBe(true)
})
