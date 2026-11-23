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
  fontAscent: 0.75,
  fontDescent: -0.25,
  fontVertical: false,
  hasEOL
})

it.each(['paired', 'shifted limit', 'different lower index', 'different raised label'] as const)(
  'keeps an exact pair of displayed unions native (%s)',
  (shape) => {
    const packet = (x: number, label: 'int' | 'ext'): PdfLayoutTextItem[] => {
      const second = label === 'ext'
      return [
        item('r', x + 3.7, second && shape === 'shifted limit' ? 594.5 : 592.5, 3.6, 7, 'Index'),
        item('⋃', x, 589.5, 11, 10, 'Operator'),
        item(
          second && shape === 'different lower index' ? 'j' : 'd',
          x - 1.5,
          568,
          4.2,
          7,
          'Index'
        ),
        item('=2', x + 2.7, 568, 10, 7, 'SmallRelation'),
        item('V', x + 14.2, 580, 5.8, 10, 'Base'),
        item(label, x + 22.2, 584.2, 11, 7, 'Index', true),
        item('d', x + 20, 577.6, 4.2, 7, 'Index'),
        item('=', x + 36.4, 580, 7.7, 10, 'Relation'),
        item('V', x + 47, 580, 5.8, 10, 'Base'),
        item(
          second && shape === 'different raised label' ? 'int' : label,
          x + 55,
          584.2,
          11,
          7,
          'Index'
        ),
        item(',', x + 66.4, 580, 2.8, 10, 'Base', second)
      ]
    }
    const page: PdfLayoutPage = {
      page: 1,
      width: 612,
      height: 792,
      rotation: 0,
      items: [
        item(
          'The following observations clarify the contributions.',
          80,
          642,
          318,
          10,
          'Body',
          true
        ),
        item(
          'We can separate the two indexed families as follows.',
          80,
          630,
          315,
          10,
          'Body',
          true
        ),
        ...packet(180, 'int'),
        ...packet(264, 'ext'),
        item(
          'The two alternatives represent disjoint cases in this argument.',
          80,
          550,
          320,
          10,
          'Body',
          true
        ),
        item('We now consider the next step of the proof.', 80, 538, 236, 10, 'Body', true)
      ]
    }
    const { units } = groupPdfTranslationPages({ pages: [page] })
    const owner = (index: number): (typeof units)[number] | undefined =>
      units.find(({ items }) => items.includes('1:' + index))
    expect(units.flatMap(({ items }) => items).toSorted()).toEqual(
      page.items.map((_, index) => '1:' + index).toSorted()
    )
    for (const index of [2, 6, 13, 17]) {
      expect(owner(index)?.sourceOnly).toBe(shape === 'paired' ? true : undefined)
      expect(owner(index)?.preserve).toBe(shape === 'paired' ? 'formula' : undefined)
    }
    expect(owner(0)?.sourceOnly).toBeUndefined()
    expect(owner(24)?.sourceOnly).toBeUndefined()
  }
)
