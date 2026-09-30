import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
it('retains a distant raster panel connected to a side-captioned vector panel', () => {
  const { page } = fixture('side-caption-mixed-raster-panels')
  const figures = associateFigures(page, findCaptionCandidates([page]))
  expect(figures).toHaveLength(1)
  expect(figures[0].rect[2]).toBeGreaterThan(550)
  expect(figures[0].rect[0]).toBeGreaterThan(190)
  expect(figures[0].rect[1]).toBeLessThan(512)
})
it.each(['no-panel-references', 'occupied-by-table'])(
  'does not attach a distant image with %s',
  (variant) => {
    const { page } = fixture('side-caption-mixed-raster-panels')
    if (variant === 'no-panel-references')
      for (const line of page.lines) line.text = line.text.replace(/\([AB]\)/g, '')
    const image = page.graphicsBounds.find((g: { kind: string }) => g.kind === 'image')
    const imageRect = image.normalizedRect.map(
      (v: number, i: number) => v * (i % 2 ? page.height : page.width)
    )
    const figures = associateFigures(
      page,
      findCaptionCandidates([page]),
      variant === 'occupied-by-table' ? [imageRect] : []
    )
    expect(figures.every((f: { rect?: number[] }) => !f.rect || f.rect[2] < 550)).toBe(true)
  }
)

it('keeps the outdented continuation of a first-line-indented NOTE paragraph', () => {
  const { page, tables, rules } = fixture('first-line-indented-note-paragraph')
  const notes = associateTableNotes(page, tables, rules)[0]
  expect(notes[0].text).toContain('Percentages use the observed population as the denominator.')
  expect(notes[1].text).toBe('Abbreviation: AE, adverse event.')
})
