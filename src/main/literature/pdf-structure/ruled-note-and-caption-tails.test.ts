import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const moduleUrl = (name: string): string =>
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-' + name + '.mjs')).href
const { associateTableNotes } = await import(moduleUrl('table-notes'))
const { associateTableCaptions } = await import(moduleUrl('association'))
const { findCaptionCandidates } = await import(moduleUrl('caption-group'))
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
it('retains statistic definitions beyond the native footer despite padded model rows', () => {
  const x = fixture('statistical-notes-crossing-padded-crop')
  const notes = associateTableNotes(x.page, x.tables, x.rules)
  expect(notes[0].map((n: { text: string }) => n.text).join(' ')).toContain(
    'Values are presented as mean ± SD'
  )
  expect(notes[1].map((n: { text: string }) => n.text).join(' ')).toContain('median (Q1, Q3)')
})
it('retains a short capitalized definition cited in the data', () => {
  const x = fixture('cited-capitalized-single-definition')
  expect(
    associateTableNotes(x.page, x.tables, x.rules)[0].map((n: { text: string }) => n.text)
  ).toContain('TC = Treatment Complete.')
})
it.each([
  'centered-double-spaced-stacked-table-captions',
  'short-capitalized-double-spaced-caption-tail'
])('retains bounded double-spaced caption continuations: %s', (name) => {
  const x = fixture(name),
    captions = findCaptionCandidates([x.page], new Map([[1, x.rules]]))
  const matches = associateTableCaptions(x.page, x.tables, captions, x.rules)
  expect(matches.every((m: { caption?: unknown }) => m.caption)).toBe(true)
  expect(
    captions.find((c: { lines: string[] }) =>
      c.lines[0].startsWith(name.startsWith('centered') ? 'TABLE 2.' : 'TABLE 7.')
    ).lines
  ).toHaveLength(2)
})
it('retains model definitions and a footnote cited by the caption above a narrow grid', () => {
  const x = fixture('model-definition-and-caption-cited-footnote')
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0].map(
    (n: { text: string }) => n.text
  )
  expect(notes).toHaveLength(3)
  expect(notes[0]).toContain('were evaluated as a continuous variable')
  expect(notes[2]).toBe(
    'a Including patients in arm A and arm C of the Trial A and arm 1 and arm 2 of the Trial B trials.'
  )
  x.page.lines = x.page.lines.filter(
    (l: { text: string; y: number }) => !(l.text === 'a' && l.y < x.tables[0].rect[1])
  )
  expect(
    associateTableNotes(x.page, x.tables, x.rules)[0].some((n: { text: string }) =>
      n.text.startsWith('a Including')
    )
  ).toBe(false)
})
it('retains a native framed unstructured panel together with its glossary', () => {
  const x = fixture('framed-unstructured-dose-panel-and-glossary')
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toContain('Optimalizace ozařovacího plánu')
  expect(notes[0].text).toContain('V28,5 Gy = 100 %')
  expect(notes[0].text).toContain('WBI – ozáření celého prsu')
  expect(associateTableNotes({ ...x.page, graphicsBounds: [] }, x.tables, x.rules)[0]).toEqual([])
})
it('keeps the hanging caption tail and explicit symbol-definition note', () => {
  const x = fixture('hanging-caption-and-symbol-rating-note')
  const captions = findCaptionCandidates([x.page], new Map([[1, x.rules]]))
  expect(captions[0].lines.at(-1)).toBe('Neuropathy Severity')
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toContain('Note. ++ = statistically significant improvement')
  expect(notes[0].text).toContain('drop in skin temperature.')
})
it('keeps all centered title lines above a native opening rule', () => {
  const x = fixture('centered-three-line-adverse-event-caption')
  const captions = findCaptionCandidates([x.page], new Map([[1, x.rules]]))
  expect(captions).toHaveLength(1)
  expect(captions[0].lines).toHaveLength(3)
  expect(captions[0].lines.at(-1)).toBe('Treatment-Emergent Adverse Events')
})
