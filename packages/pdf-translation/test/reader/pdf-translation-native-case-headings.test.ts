import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const run = (
  str: string,
  x: number,
  y: number,
  width: number,
  fontName: string,
  hasEOL = false
): PdfLayoutTextItem => ({
  str,
  width,
  height: str.trim() ? 10 : 0,
  dir: 'ltr',
  transform: [10, 0, 0, 10, x, y],
  fontName,
  fontFamily: 'serif',
  fontAscent: 0.85,
  fontDescent: -0.25,
  fontVertical: false,
  hasEOL
})

it.each([false, true])(
  'keeps native inline equations with repeated subsection labels (%s)',
  (shift) => {
    const items = ['A', 'B', 'C'].flatMap((letter, index) => {
      const y = 650 - 80 * index
      return [
        run(letter + '.', 50, y, 9, 'Heading'),
        run(' ', 59, y, 5, 'Heading'),
        run('k', 64, y, 6, 'Variable'),
        run(' ', 70, y, 3, 'Variable'),
        run('= ' + String(4 + index * 2), 73, y, 16, 'Math'),
        run(' ', 89, y, 3.5, 'Math'),
        run('case', 92.5, y - (shift && index === 1 ? 2 : 0), 18, 'Heading'),
        run('', 60, y - 17, 0, 'Body', true),
        run('The next estimate follows from the bound.', 60, y - 17, 225, 'Body', true),
        run('A separate check verifies the last step.', 50, y - 29, 200, 'Body', true)
      ]
    })
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const owner = units.find((unit) => unit.items.includes('1:0'))
    expect(owner?.source).toBe(shift ? 'A. k = 4' : 'A. k = 4 case')
    expect(owner?.sourceOnly).toBe(shift ? true : undefined)
    expect(owner?.items).toEqual(shift ? ['1:0', '1:2', '1:4'] : ['1:0', '1:2', '1:4', '1:6'])
    expect(owner?.fragments).toHaveLength(1)
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.flatMap((item, index) => (item.str.trim() ? ['1:' + index] : [])).toSorted()
    )
  }
)
