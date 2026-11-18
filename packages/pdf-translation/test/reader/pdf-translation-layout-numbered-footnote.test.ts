import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'numbered-footnote-native-wrap.jsonl'
)[0]
function extract(page: PdfLayoutPage): ReturnType<typeof groupPdfTranslationPages> {
  const result = groupPdfTranslationPages({ pages: [page] })
  const native = page.items.flatMap((item, index) =>
    item.str.trim() ? [[`1:${index}`, item.str]] : []
  )
  const actual = result.units.flatMap((unit) =>
    unit.items.map((key, index) => [key, unit.originalStrings[index]])
  )
  expect(actual.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual(
    native.toSorted((a, b) => a[0].localeCompare(b[0]))
  )
  expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
  return result
}

it('keeps complete paired numeric notes separate from each other and the body', () => {
  const { units } = extract(structuredClone(fixture.page))
  for (const [number, head] of [1, 4, 7].entries()) {
    const owner = units.find((unit) => unit.items.includes(`1:${head}`))!
    expect(owner.items).toEqual([head, head + 1, head + 2].map((index) => `1:${index}`))
    expect(owner.source).toBe(
      [String(number + 1), fixture.page.items[head + 1].str, fixture.page.items[head + 2].str].join(
        ' '
      )
    )
    expect(owner.sourceOnly).toBeUndefined()
    expect(owner.items).not.toContain('1:0')
  }
})

it.each([
  'missing-peer',
  'marker-font',
  'body-font',
  'body-rail',
  'marker-rise',
  'marker-size',
  'marker-gap',
  'native-interruption',
  'same-row-foreign',
  'high-on-page',
  'missing-eol'
])('rejects an unproven numeric note continuation: %s', (fault) => {
  const page = structuredClone(fixture.page),
    items = page.items
  if (fault === 'missing-peer') items.splice(4)
  if (fault === 'marker-font') items[1].fontFamily = 'serif'
  if (fault === 'body-font') items[3].fontName = 'different'
  if (fault === 'body-rail') items[3].transform[4] += 5
  if (fault === 'marker-rise') items[1].transform[5] = items[2].transform[5]
  if (fault === 'marker-size') {
    items[1].transform[0] = items[1].transform[3] = items[1].height = 9
  }
  if (fault === 'marker-gap') items[1].transform[4] -= 8
  if (fault === 'native-interruption' || fault === 'same-row-foreign') {
    items.splice(3, 0, {
      ...items[3],
      str: 'Independent neighboring text.',
      width: 100,
      transform: [9, 0, 0, 9, 360, fault === 'same-row-foreign' ? 173 : 178.5]
    })
  }
  if (fault === 'high-on-page') for (const item of items) item.transform[5] += 150
  if (fault === 'missing-eol') items[2].hasEOL = false
  const { units } = extract(page),
    owner = units.find((unit) => unit.items.includes('1:1'))!
  const tailIndex = fault === 'native-interruption' || fault === 'same-row-foreign' ? 4 : 3
  expect(owner.items).not.toContain(`1:${tailIndex}`)
  if (fault === 'same-row-foreign') expect(owner.items).not.toContain('1:3')
})
