import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { hasTableEvidence, refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { findCaptionCandidates, captionKind } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { matchFigureSequence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-sequence.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', `${name}.jsonl`))
it.each([
  'prose-column-crossing-a-numbered-reference',
  'equation-and-bulleted-parameter-explanations',
  'publisher-reporting-form-with-clipped-narrative-answers'
])('does not turn %s into a data grid', (name) => {
  const x = load(name),
    t = refineTable(x.table, x.tokens)
  expect(hasTableEvidence(t, undefined, x.tokens)).toBe(false)
})
it('does not treat a wrapped supplementary reference as a figure caption', () => {
  const { page } = load('wrapped-supplementary-reference-after-another-label')
  expect(findCaptionCandidates([page])).toEqual([])
})
it.each([
  'Supplementary Fig. 3 and Supplementary Table 5).',
  'Fig. 5 and Supplementary Fig. 6). Further details.',
  'Figure 4 and Supplementary Table 2 show the results.'
])('recognizes body-reference grammar in %s', (text) => expect(captionKind(text)).toBeUndefined())
it('matches separately numbered panels to their shared legend without shifting later plates', () => {
  const { pages } = load('ordered-panel-plates-after-shared-legends'),
    sequence = matchFigureSequence(pages)
  expect([...sequence.keys()]).toEqual([2, 3, 4, 5, 6])
  expect(sequence.get(3)).toBe(sequence.get(4))
  expect(sequence.get(4)).toBe(sequence.get(5))
  expect(sequence.get(6).lines[0]).toBe('Figure 3. Adverse events.')
})
it.each(['missing', 'duplicate', 'uncited', 'empty-plate'])(
  'rejects incomplete or unproved panel sequences: %s',
  (variant) => {
    const { pages } = load('ordered-panel-plates-after-shared-legends')
    if (variant === 'missing') pages.splice(3, 1)
    if (variant === 'duplicate') pages[3].lines[0].text = 'Figure 2A'
    if (variant === 'uncited') pages[0].lines[2].text = 'Figure 2. Outcomes (A) and change (B).'
    if (variant === 'empty-plate') pages[3].graphicCount = 0
    expect(matchFigureSequence(pages).size).toBe(0)
  }
)
const { readingRotation } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-orientation.mjs')).href
)
it.each([
  '(A, B, C)',
  '(A and B) and (C)',
  '(A, B, and C)',
  '(A & B & C)',
  '(A-C)',
  '(A–C)',
  '(A—C)',
  '(A–B, C)'
])('matches panel pages cited as %s in their shared legend', (references) => {
  const { pages } = load('ordered-panel-plates-after-shared-legends')
  const legend = pages[0].lines.find((line: { text: string }) => line.text.startsWith('Figure 2.'))
  legend.text = `Figure 2. Treatment effects ${references}.`
  const sequence = matchFigureSequence(pages)
  expect([...sequence.keys()]).toEqual([2, 3, 4, 5, 6])
  expect(sequence.get(3)).toBe(sequence.get(5))
  expect(sequence.get(6).lines[0]).toBe('Figure 3. Adverse events.')
})
it.each(['(A–D)', '(A, C)', '(C–A)', '(A and)', '(A–)'])(
  'rejects incomplete or invalid panel references %s',
  (references) => {
    const { pages } = load('ordered-panel-plates-after-shared-legends')
    const legend = pages[0].lines.find((line: { text: string }) =>
      line.text.startsWith('Figure 2.')
    )
    legend.text = `Figure 2. Treatment effects ${references}.`
    expect(matchFigureSequence(pages).size).toBe(0)
  }
)

it('keeps an upright numbered panel despite the longer vertical publisher notice', () => {
  const x = load('numbered-panel-plate-with-long-vertical-download-notice')
  expect(readingRotation(x.page, { items: x.items })).toBe(0)
})
