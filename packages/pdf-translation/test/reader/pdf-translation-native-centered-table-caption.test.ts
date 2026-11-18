import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'centered-table-caption-native.jsonl'
)[0]
function extract(page: PdfLayoutPage): ReturnType<typeof groupPdfTranslationPages> {
  const result = groupPdfTranslationPages({ pages: [page] })
  const actual = result.units.flatMap((u) => u.items.map((key, n) => [key, u.originalStrings[n]]))
  const expected = page.items.flatMap((item, n) => (item.str.trim() ? [[`1:${n}`, item.str]] : []))
  expect(actual.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual(
    expected.toSorted((a, b) => a[0].localeCompare(b[0]))
  )
  expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
  return result
}

it('keeps a complete centered table caption apart from its label and native grid', () => {
  const { units } = extract(structuredClone(fixture.page)),
    owner = units.find((u) => u.items.includes('1:1'))!
  expect(owner.items).toEqual(['1:1', '1:2', '1:3'])
  expect(owner.source).toBe(
    'The complete comparison reports reliable results for every evaluated method and describes the common evaluation protocol for all observed systems including the final independent assessment.'
  )
  expect(owner.items).not.toContain('1:0')
  expect(owner.items).not.toContain('1:5')
  expect(owner.sourceOnly).toBeUndefined()
})

it.each([
  'no-peer',
  'peer-font',
  'line-font',
  'line-size',
  'center',
  'pitch',
  'missing-eol',
  'missing-final-eol',
  'unclosed',
  'header-font',
  'missing-grid',
  'native-interruption'
])('rejects an unproven centered native caption: %s', (fault) => {
  const page = structuredClone(fixture.page),
    items = page.items
  if (fault === 'no-peer') items[11].str = 'SECOND SUMMARY'
  if (fault === 'peer-font') items[11].fontName = 'other'
  if (fault === 'line-font') items[2].fontName = 'other'
  if (fault === 'line-size') items[2].height = items[2].transform[0] = items[2].transform[3] = 8.8
  if (fault === 'center') items[2].transform[4] += 4
  if (fault === 'pitch') items[2].transform[5] -= 3
  if (fault === 'missing-eol') items[1].hasEOL = false
  if (fault === 'missing-final-eol') items[4].hasEOL = false
  if (fault === 'unclosed') items[3].str = items[3].str.slice(0, -1)
  if (fault === 'header-font') items[5].fontName = items[6].fontName = 'caption'
  if (fault === 'missing-grid') items.splice(5, 6)
  if (fault === 'native-interruption')
    items.splice(2, 0, {
      ...items[2],
      str: 'Independent neighboring text.',
      width: 150,
      fontName: 'other',
      transform: [8, 0, 0, 8, 330, 726.7]
    })
  const { units } = extract(page),
    owner = units.find((u) => u.items.includes('1:1'))!
  expect(owner.items).not.toContain(`1:${fault === 'native-interruption' ? 4 : 3}`)
})
