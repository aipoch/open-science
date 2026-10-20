import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-notes.mjs')).href
)
const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
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

const citedSymbolPage = (): ReturnType<typeof JSON.parse> => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  graphicsBounds: [],
  lines: [
    { text: 'Record amber (*)', x: 50, y: 180, width: 110, height: 10, fontSize: 10 },
    {
      text: '(*) These observations exclude the auxiliary measurement.',
      x: 55,
      y: 205,
      width: 260,
      height: 10,
      fontSize: 10
    }
  ]
})

it('retains a whole parenthesized symbol note cited inside one native closing fence', () => {
  const p = citedSymbolPage(),
    before = structuredClone(p)
  const notes = associateTableNotes(p, [{ rect: [45, 100, 330, 200] }], [[45, 200, 330, 200]])
  expect(notes[0].map((n: { text: string }) => n.text)).toEqual([p.lines[1].text])
  expect(p).toEqual(before)
})

it.each(['uncited marker', 'missing fence', 'foreign column'])(
  'declines an isolated parenthesized note without %s',
  (variant) => {
    const p = citedSymbolPage(),
      rules = [[45, 200, 330, 200]]
    if (variant === 'uncited marker') p.lines[0].text = 'Record amber'
    if (variant === 'missing fence') rules.splice(0)
    if (variant === 'foreign column') p.lines[1].x = 350
    expect(associateTableNotes(p, [{ rect: [45, 100, 330, 200] }], rules)[0]).toEqual([])
  }
)
