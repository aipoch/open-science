import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'same-face-dropcap-native.jsonl'
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

it('keeps the initial word joined and the following body word spaced across the complete native opening', () => {
  const { units } = extract(structuredClone(fixture.page)),
    owner = units.find((u) => u.items.includes('1:0'))!
  expect(owner.source).toBe(
    'CONSTRUCTIVE systems combine several simple image features to provide a useful description of the available signals and keep the complete reading order through the final row.'
  )
  expect(owner.items).toEqual(['1:0', '1:1', '1:2', '1:3', '1:4'])
  expect(owner.items).not.toContain('1:5')
})

it.each([
  'cap-font',
  'body-font',
  'small-size',
  'cap-size',
  'word-gap',
  'second-rail',
  'returned-rail',
  'line-eol',
  'missing-return',
  'raised-small',
  'row-right',
  'native-interruption'
])('rejects an unproven native small-cap opening: %s', (fault) => {
  const page = structuredClone(fixture.page),
    items = page.items
  if (fault === 'cap-font') items[0].fontName = 'other'
  if (fault === 'body-font') items[2].fontName = 'other'
  if (fault === 'small-size') items[1].height = items[1].transform[0] = items[1].transform[3] = 8.55
  if (fault === 'cap-size') items[0].height = items[0].transform[0] = items[0].transform[3] = 23.75
  if (fault === 'word-gap') items[2].transform[4] = items[1].transform[4] + items[1].width + 0.475
  if (fault === 'second-rail') items[3].transform[4] += 5
  if (fault === 'returned-rail') items[4].transform[4] += 5
  if (fault === 'line-eol') items[2].hasEOL = false
  if (fault === 'missing-return') items.splice(4, 1)
  if (fault === 'raised-small') items[1].transform[5] += 3
  if (fault === 'row-right') items[3].width -= 4
  if (fault === 'native-interruption')
    items.splice(3, 0, {
      ...items[3],
      str: 'Unowned independent material stays outside.',
      width: 200,
      transform: [9.5, 0, 0, 9.5, 330, 445]
    })
  const { units } = extract(page),
    owner = units.find((u) => u.items.includes('1:0'))!
  expect(owner.items).not.toContain(`1:${fault === 'native-interruption' ? 5 : 4}`)
})
