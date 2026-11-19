import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'inline-function-definition-native.jsonl'
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

it('joins a native closed function subject with its copular body without acquiring the display', () => {
  const { units } = extract(structuredClone(fixture.page)),
    owner = units.find((u) => u.items.includes('1:2'))!
  expect(owner.items).toEqual(['1:2', '1:3', '1:4', '1:5', '1:6', '1:7', '1:8'])
  expect(owner.source).toBe(
    'where f(·) is an ordinary non-linear function with stable outputs and gives a complete description for every tested input.'
  )
  expect(owner.sourceOnly).toBeUndefined()
  expect(units.find((u) => u.items.includes('1:1'))).toMatchObject({
    sourceOnly: true,
    preserve: 'formula'
  })
})

it.each(['raised-callee', 'wrong-body-font', 'native-eol'])(
  'rejects an unproven inline function definition: %s',
  (fault) => {
    const page = structuredClone(fixture.page)
    if (fault === 'raised-callee') page.items[3].transform[5] += 3
    if (fault === 'wrong-body-font') page.items[7].fontName = 'other'
    if (fault === 'native-eol') page.items[6].hasEOL = true
    const { units } = extract(page),
      owner = units.find((u) => u.items.includes('1:2'))!
    expect(owner.items).not.toContain('1:7')
    expect(units.find((u) => u.items.includes('1:1'))).toMatchObject({
      sourceOnly: true,
      preserve: 'formula'
    })
  }
)
