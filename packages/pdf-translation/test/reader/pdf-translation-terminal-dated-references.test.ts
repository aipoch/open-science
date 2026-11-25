import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const row = (
  str: string,
  x: number,
  y: number,
  width: number,
  height = 8,
  fontName = 'Body',
  hasEOL = true
): PdfLayoutTextItem => ({
  str,
  width,
  height,
  dir: 'ltr',
  transform: [height, 0, 0, height, x, y],
  fontName,
  fontAscent: 0.7,
  fontDescent: -0.21,
  fontVertical: false,
  hasEOL
})

it.each(['paired year', 'unrelated year'] as const)(
  'retains the higher short bibliography column before the typesetting credit (%s)',
  (shape) => {
    const items = [
      row('Running title for a field study', 353, 744, 173, 12, 'Title', false),
      row('1', 543, 744, 6, 12),
      row('The field data have been archived for independent review.', 42, 720, 243, 9),
      row('Access instructions accompany the public metadata.', 42, 709, 205, 9),
      row('REFERENCES', 42, 674, 60, 9, 'Title'),
      row('Aster L., Dane M., 2009, Annals, 3, 7', 42, 658, 228),
      row('Baker J., Needle G., 2010, Reports, 15, 21', 42, 648, 230),
      row('Clarke D., Jordan P., 2011, Methods, 5, 8', 42, 60, 220),
      row('North A. B., Dawn L., 2013a, Reports, 16, 2', 42, 50, 237),
      row(
        shape === 'paired year'
          ? 'North A. B., Dale L., Morgan J., 2013b,'
          : 'North A. B., Dale L., Morgan J., 2014b,',
        305,
        720,
        243
      ),
      row('Reports, 16, 3', 318.5, 710, 47),
      row('Vance D., et al., 2015, arXiv e-prints, p. arXiv:0000.00000', 305, 700, 207),
      row('This article was typeset for the author.', 305, 676, 230),
      row('Research Journal 2, 1–2 (2015)', 470, 28, 79)
    ]
    const { units } = groupPdfTranslationPages({
      pageCount: 1,
      pages: [{ page: 1, width: 595, height: 782, rotation: 0, items }]
    })
    const first = units.find((unit) => unit.items.includes('1:9'))
    expect(Boolean(first?.sourceOnly && first.preserve === 'reference')).toBe(
      shape === 'paired year'
    )
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeFalsy()
  }
)
