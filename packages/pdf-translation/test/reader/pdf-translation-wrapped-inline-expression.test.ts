import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'
import { readPdfTranslationCases } from '../fixtures/read-cases'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>(
  'wrapped-inline-expression-native.jsonl'
)[0]

it('keeps a wrapped inline expression in the sentence without losing its native fragments', () => {
  const { units } = groupPdfTranslationPages({ pages: [fixture.page] })
  expect(units).toHaveLength(1)
  expect(units[0]).toMatchObject({
    source:
      'Each value describes a distinct sampling position. Let each mapping be a linear projection (A z + c for some A and c). The result forms an estimate for the current sample under the conditions given in the example.',
    items: fixture.page.items.map((_, index) => `1:${index}`),
    originalStrings: fixture.page.items.map(({ str }) => str)
  })
  expect(units[0].fragments).toHaveLength(3)
  expect(units[0].preserve).toBeUndefined()
})

const controls: [string, (page: PdfLayoutPage) => void][] = [
  ['different opening face', ({ items }) => (items[1].fontName = 'foreign')],
  ['nonhorizontal expression', ({ items }) => (items[3].transform[1] = 0.4)],
  ['expression on a separate row', ({ items }) => (items[3].transform[5] += 6)],
  [
    'open parentheses',
    ({ items }) => (items[9].str = '. The result supports the current estimate')
  ],
  ['broken return rail', ({ items }) => (items[10].transform[4] += 5)],
  ['different right edge', ({ items }) => (items[9].width -= 7)]
]

it.each(controls)('does not join without continuous native body evidence: %s', (_, change) => {
  const page = structuredClone(fixture.page)
  change(page)
  const { units } = groupPdfTranslationPages({ pages: [page] })
  expect(units.some((unit) => unit.items.includes('1:0') && unit.items.includes('1:10'))).toBe(
    false
  )
})
