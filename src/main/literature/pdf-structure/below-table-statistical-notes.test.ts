import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const sample = (text: string): ReturnType<typeof JSON.parse> => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  graphicsBounds: [],
  lines: [
    { text, x: 45, y: 310, width: 390, height: 7, fontSize: 7 },
    {
      text: 'The estimates use all participants assigned to each study group.',
      x: 45,
      y: 320,
      width: 380,
      height: 7,
      fontSize: 7
    },
    { text: 'Table 1: Trial outcomes', x: 45, y: 338, width: 95, height: 7, fontSize: 7 }
  ]
})
it.each([
  'HR=hazard ratio. *Estimated at 5 years. †Log-rank test. ‡Exact test.',
  'Data are median (IQR) or n (%). All counts include the complete analysis population.',
  'Data are n/N (%) unless otherwise specified. The group assignment is retained for analysis.',
  'Data are n (%). The observed event counts include the complete analysis population.'
])('associates a statistical note before a below-table caption: %s', (text) => {
  const page = sample(text),
    tables = [{ rect: [40, 100, 450, 295] }]
  const notes = associateTableNotes(page, tables)
  expect(notes[0]).toHaveLength(1)
  expect(notes[0][0].text).toContain(text)
  expect(notes[0][0].text).not.toContain('Table 1')
  const captions = findCaptionCandidates([page])
  expect(associateTableCaptions(page, tables, captions)[0].caption).toBe(captions[0])
})
it('does not treat an ordinary data interpretation as a statistical-format note', () => {
  const page = sample(
    'Data are consistent with a meaningful improvement after treatment in all groups.'
  )
  expect(associateTableNotes(page, [{ rect: [40, 100, 450, 295] }])[0]).toEqual([])
})
