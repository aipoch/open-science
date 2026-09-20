import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/side-table-notes.jsonl')
)
it('attaches marked notes aligned with a side caption and cited in the table', () => {
  const x = structuredClone(fixture)
  const notes = associateTableNotes(x.page, x.tables)
  expect(notes[0].map((n: { text: string }) => n.text)).toEqual([
    '#Wilcoxon 2-sample test',
    '*Only those with the given can-cer treatment are included'
  ])
  expect(notes[1]).toEqual([])
})
it.each(['missing-caption', 'missing-marker', 'different-column'])(
  'does not attach a side note with %s',
  (condition) => {
    const x = structuredClone(fixture)
    if (condition === 'missing-caption')
      x.page.lines = x.page.lines.filter((l: { text: string }) => !l.text.startsWith('Table 2'))
    if (condition === 'missing-marker')
      for (const l of x.page.lines) if (l.x > 170) l.text = l.text.replace(/[#*]/g, '')
    if (condition === 'different-column')
      for (const l of x.page.lines) if (l.x < 170 && l.y > 250 && l.y < 290) l.x -= 30
    expect(associateTableNotes(x.page, x.tables)[0]).toEqual([])
  }
)

const abbreviations = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/side-abbreviation-notes.jsonl')
)
it('attaches a wrapped marginal abbreviation list when every key is cited in the aligned table', () => {
  const x = structuredClone(abbreviations)
  const notes = associateTableNotes(x.page, x.tables)
  expect(notes[0].map((n: { text: string }) => n.text)).toEqual([
    'ER estrogen receptor, PR progesterone receptor, WBRT whole brain radiotherapy, SRS stereotactic radiosurgery, CNS central nervous system, ECOG Eastern Cooperative Oncology Group, PS performance status'
  ])
  expect(x).toEqual(abbreviations)
})
it.each(['missing-caption', 'uncited-key', 'misaligned-note', 'interrupted-list'])(
  'does not attach a marginal definition list with %s',
  (condition) => {
    const x = structuredClone(abbreviations)
    if (condition === 'missing-caption')
      x.page.lines = x.page.lines.filter((l: { text: string }) => !l.text.startsWith('Table 1'))
    for (const l of x.page.lines) {
      if (condition === 'uncited-key' && l.x > 170)
        l.text = l.text.replace('WBRT', 'Whole brain RT')
      if (condition === 'misaligned-note' && l.x < 170 && l.y > 390 && l.y < 470) l.x -= 10
      if (condition === 'interrupted-list' && l.x < 170 && l.y > 415 && l.y < 470) l.y += 50
    }
    expect(associateTableNotes(x.page, x.tables)[0]).toEqual([])
  }
)

const captionAbbreviations = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/side-caption-abbreviations.jsonl')
)
it('attaches two complete marginal definitions cited across the caption and table', () => {
  const x = structuredClone(captionAbbreviations)
  expect(associateTableNotes(x.page, x.tables)[0].map((n: { text: string }) => n.text)).toEqual([
    'CTCAE Common Terminology Criteria for Adverse Events, PPE palmar-plantar erythrodysesthesia'
  ])
  expect(x).toEqual(captionAbbreviations)
})
it.each(['uncited-caption-key', 'uncited-table-key', 'single-definition'])(
  'rejects a short marginal list with %s',
  (condition) => {
    const x = structuredClone(captionAbbreviations)
    for (const l of x.page.lines) {
      if (condition === 'uncited-caption-key' && l.y < 120)
        l.text = l.text.replace('CTCAE', 'grading')
      if (condition === 'uncited-table-key' && l.x > 170)
        l.text = l.text.replace('PPE', 'Other event')
    }
    if (condition === 'single-definition')
      x.page.lines = x.page.lines.filter(
        (l: { x: number; y: number }) => !(l.x < 170 && l.y > 280 && l.y < 310)
      )
    expect(associateTableNotes(x.page, x.tables)[0]).toEqual([])
  }
)
