import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )

it('retains both indented figure legends through their unindented final line', () => {
  const x = fixture('first-line-indented-figure-legends')
  const captions = findCaptionCandidates([x.page])
  expect(captions).toHaveLength(2)
  for (const caption of captions) {
    expect(caption.lines.join(' ')).toMatch(/SD, standard deviation\.$/)
    expect(caption.lines.join(' ')).not.toContain('spine remained stable')
  }
})

it('retains a short abbreviation tail after a first-line indent', () => {
  const x = fixture('indented-abbreviation-with-short-tail')
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toMatch(/Prevention of Shoulder Problems\.$/)
  expect(notes[0].text).not.toContain('Supplementary Material')
})

it('owns an indented adjustment paragraph under a closing rule and its abbreviation note', () => {
  const x = fixture('indented-adjustment-note-under-rule')
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(2)
  expect(notes[0].text).toMatch(/^Baseline scores are adjusted for age/)
  expect(notes[0].text).toMatch(/differences at each time point\.$/)
  expect(notes[1].text).toMatch(/^Abbreviations:/)
  expect(notes[1].text).toMatch(/Shoulder Problems\.$/)
})

it.each(['further-outdent', 'different-font', 'finished-opening'])(
  'does not attach an unproven figure continuation: %s',
  (variant) => {
    const x = fixture('first-line-indented-figure-legends')
    for (const line of x.page.lines) {
      if (/^Fig\./.test(line.text)) {
        if (variant === 'finished-opening') line.text += '.'
      } else {
        if (variant === 'further-outdent') line.x -= 20
        if (variant === 'different-font') line.fontSize += 3
      }
    }
    for (const caption of findCaptionCandidates([x.page])) expect(caption.lines).toHaveLength(1)
  }
)

it.each(['missing-rule', 'unrelated-header', 'methods-paragraph'])(
  'requires native ownership for an unmarked adjustment note: %s',
  (variant) => {
    const x = fixture('indented-adjustment-note-under-rule')
    if (variant === 'missing-rule') x.rules = []
    if (variant === 'unrelated-header')
      x.page.lines.find((line: { text: string }) => line.text.startsWith('Trial arm')).text =
        'Trial arm Initial 6 months 12 months'
    if (variant === 'methods-paragraph')
      x.page.lines.find((line: { text: string }) => line.text.startsWith('Baseline scores')).text =
        'The baseline measurement was collected by trained assessors at scheduled visits.'
    const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
    expect(notes).toEqual([])
  }
)

it('stops a recovered legend before a new indented paragraph at the same line spacing', () => {
  const x = fixture('first-line-indented-figure-legends')
  const tail = x.page.lines.find((line: { text: string }) => line.text.startsWith('sity; SD'))
  x.page.lines.push({
    text: 'This independent paragraph describes the interpretation of the results.',
    x: tail.x + 12,
    y: tail.y + 11.45,
    height: tail.height,
    width: 236,
    fontSize: tail.fontSize
  })
  const captions = findCaptionCandidates([x.page])
  expect(captions[0].lines.join(' ')).toMatch(/standard deviation\.$/)
  expect(captions[0].lines.join(' ')).not.toContain('independent paragraph')
})
