import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

function row(
  str: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontName: string,
  hasEOL = false
): PdfLayoutPage['items'][number] {
  return {
    str,
    dir: 'ltr',
    width,
    height,
    transform: [height, 0, 0, height, x, y],
    fontAscent: 0.7,
    fontDescent: -0.2,
    fontVertical: false,
    fontName,
    hasEOL
  }
}

it.each([
  ['complete evidence', true],
  ['unrelated surname', false],
  ['no abstract phrase', false],
  ['different title faces', false]
])('joins the short line of a centered article title with %s', (scenario, joined) => {
  const lead = 'RECONSTRUCTING TEST PATTERNS FROM THEIR ADJACENT'
  const tail = 'DIFFERENCES'
  const author = 'ERIN HART LI'
  const label = 'Abstract.'
  const pages = [
    {
      page: 1,
      width: 612,
      height: 792,
      rotation: 0,
      items: [
        row(lead, 65, 694, 482, 12, 'Title', true),
        row(tail, 266, 680, 80, 12, scenario === 'different title faces' ? 'Subtitle' : 'Title'),
        row('', 0, 0, 0, 0, 'Author', true),
        row(author, 268, 650, 76, 10, 'Author'),
        row('', 0, 0, 0, 0, 'Label', true),
        row(label, 93, 621, 48, 10, 'Label'),
        row(
          'We analyze a class of arrays recovered from independent records.',
          145,
          621,
          300,
          10,
          'Body',
          true
        ),
        row(
          scenario === 'no abstract phrase'
            ? 'The coefficients serve as constraints on the data.'
            : 'The adjacent differences serve as constraints on the data.',
          93,
          609,
          300,
          10,
          'Body',
          true
        )
      ]
    },
    {
      page: 2,
      width: 612,
      height: 792,
      rotation: 0,
      items: [
        row('2', 57, 749, 5, 9, 'Running'),
        row(' ', 62, 749, 239, 0, 'Running'),
        row(scenario === 'unrelated surname' ? 'YU' : 'LI', 301, 749, 10, 9, 'Running'),
        row('', 0, 0, 0, 0, 'Body', true),
        row(
          'Consider the following classification of admissible inputs.',
          70,
          724,
          350,
          12,
          'Body',
          true
        )
      ]
    }
  ]
  const { units } = groupPdfTranslationPages({ pages })
  const title = units.find((unit) => unit.items.includes('1:0'))!
  const ending = units.find((unit) => unit.items.includes('1:1'))!
  expect(title === ending).toBe(joined)
  expect(title.source).toBe(joined ? lead + ' ' + tail : lead)
  expect(title.fragments).toHaveLength(joined ? 2 : 1)
  expect(units.find((unit) => unit.items.includes('1:3'))?.source).toBe(author)
})
