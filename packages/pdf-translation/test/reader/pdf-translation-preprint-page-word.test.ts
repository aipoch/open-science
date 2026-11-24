import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  size = 10,
  fontName = 'Body',
  hasEOL = false
): PdfLayoutTextItem => ({
  str,
  dir: 'ltr',
  width,
  height: size,
  transform: [size, 0, 0, size, x, y],
  fontName,
  fontFamily: 'serif',
  fontAscent: 0.85,
  fontDescent: -0.25,
  fontVertical: false,
  hasEOL
})

it.each(['matching imprint', 'shifted imprint', 'equation number gap'])(
  'joins a word across a preprint page turn with consecutive native equations (%s)',
  (shape) => {
    const notice = 'ABC preprint 2020-06-01'
    const imprint = (x: number): PdfLayoutTextItem[] => [
      item('ABC preprint', x, 746, 47, 8, 'Imprint'),
      item('2020-06-01', x + 49, 746, 36, 8)
    ]
    const pages: PdfLayoutPage[] = [
      {
        page: 1,
        width: 612,
        height: 792,
        rotation: 0,
        items: [
          ...imprint(50),
          item('An Elementary Study of Numerical Schemes', 49, 696, 243, 12, 'Title'),
          item('Alex Example', 131, 674, 80),
          item('A Department of Applied Studies', 80, 652, 180),
          item(
            'We establish the convergence of the approximation.',
            49,
            620,
            243,
            10,
            'Body',
            true
          ),
          item('The estimates below show uniform convergence.', 307, 56, 242, 10, 'Body', true),
          item('A = B + C', 340, 24, 84),
          item('(7)', 534, 24, 16, 10, 'Body', true),
          item('shown by the next bound. We start from a di', 307, 6, 226),
          item('ff', 533, 6, 6, 10, 'Ligature'),
          item('er-', 539, 6, 11)
        ]
      },
      {
        page: 2,
        width: 612,
        height: 792,
        rotation: 0,
        items: [
          ...imprint(shape === 'shifted imprint' ? 54 : 50),
          item('ence equation of q,', 49, 712, 80, 10, 'Body', true),
          item('x = a + b', 111, 694, 118),
          item(shape === 'equation number gap' ? '(9)' : '(8)', 275, 694, 16, 10, 'Body', true),
          item(
            'This implies the desired uniform bound on each step.',
            49,
            676,
            241,
            10,
            'Body',
            true
          )
        ]
      }
    ]

    const { units } = groupPdfTranslationPages({ pages, pageCount: 2 })
    const head = units.find((unit) => unit.items.includes('1:9'))
    const tail = units.find((unit) => unit.items.includes('2:2'))
    const joined = shape === 'matching imprint'
    expect(head?.source).toBe(
      joined
        ? 'shown by the next bound. We start from a difference equation of q,'
        : 'shown by the next bound. We start from a differ-'
    )
    expect(tail === head).toBe(joined)
    expect(units.filter((unit) => unit.source === notice).map((unit) => !!unit.sourceOnly)).toEqual(
      [joined, joined]
    )
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      pages.flatMap((page) => page.items.map((_, index) => `${page.page}:${index}`)).toSorted()
    )
  }
)
