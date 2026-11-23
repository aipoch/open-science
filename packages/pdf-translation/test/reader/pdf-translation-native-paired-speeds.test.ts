import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const make = (
  str: string,
  x: number,
  y: number,
  width: number,
  size = 10,
  font = 'Text',
  hasEOL = false
): PdfLayoutPage['items'][number] => ({
  str,
  dir: 'ltr',
  width,
  height: size,
  transform: [size, 0, 0, size, x, y],
  fontName: font,
  fontFamily: 'serif',
  fontAscent: 0.75,
  fontDescent: -0.25,
  fontVertical: false,
  hasEOL
})
const blank = (x: number, y: number, width: number): PdfLayoutPage['items'][number] => ({
  ...make(' ', x, y, width),
  height: 0
})
const fresh = (): PdfLayoutPage => ({
  page: 1,
  width: 612,
  height: 792,
  rotation: 0,
  items: [
    make(
      'The distributions show clear differences in summer flows.',
      50,
      712.5,
      241,
      10,
      'Text',
      true
    ),
    make('Figure 2 shows the measured difference between the', 59, 700, 232, 10, 'Text', true),
    make('4 and 60 km s', 50, 687.5, 60),
    make('−', 110, 691.1, 6, 7, 'Symbol'),
    make('1', 116, 691.1, 4, 7, 'Exponent'),
    blank(120, 691.1, 3.5),
    make('river flow scenario probability dis-', 123.5, 687.5, 167.5, 10, 'Text', true),
    make('tributions under both strong and weak flows of water.', 50, 675, 241, 10, 'Text', true),
    make('The samples are recorded at regular intervals.', 50, 662.5, 241, 10, 'Text', true),
    make('We repeat the test with a smaller sensor.', 50, 650, 200, 10, 'Text', true)
  ]
})
const extract = (page: PdfLayoutPage) => {
  const { units } = groupPdfTranslationPages({ pages: [page] })
  const owners = units.flatMap((u) => u.items)
  expect(owners.toSorted()).toEqual(
    page.items.flatMap((item, i) => (item.str.trim() ? ['1:' + i] : [])).toSorted()
  )
  return (index: number) => units.find((u) => u.items.includes('1:' + index))!
}

it('joins paired speeds with the native rows of the surrounding prose', () => {
  const owner = extract(fresh())
  expect(owner(1)).toBe(owner(2))
  expect(owner(6)).toBe(owner(2))
  expect(owner(2).sourceOnly).toBeUndefined()
  expect(owner(2).source).toContain('between the 4 and 60 km s−1 river flow')
})

it.each(['displaced exponent', 'different prose font', 'displaced rail'])(
  'keeps the numeric prefix separate with a %s',
  (fault) => {
    const page = fresh()
    if (fault === 'displaced exponent') page.items[4].transform[5] -= 1.5
    if (fault === 'different prose font') page.items[6].fontName = 'Other'
    if (fault === 'displaced rail') page.items[7].transform[4] += 4
    const owner = extract(page)
    expect(owner(1)).not.toBe(owner(2))
  }
)

it.each(['intact', 'displaced exponent', 'different sign font', 'displaced prose rail'])(
  'joins or retains two approximate speeds with a %s source',
  (shape) => {
    const page = fresh()
    page.items = [
      make('Samples from the first survey were calibrated.', 50, 725, 242, 10, 'Text', true),
      make('The widest fluctuation was observed when the', 59, 712.5, 233, 10, 'Text', true),
      make('recorded speeds in the sample were near', 50, 700, 162),
      make('∼', 217, 700, 8, 10, 'Approximation'),
      make('4 km s', 229, 700, 34),
      make('−', 263, 703.6, 6, 7, 'Symbol'),
      make('1', 269, 703.6, 4, 7, 'Exponent'),
      make('and', 276, 700, 16),
      make('∼', 50, 687.5, 8, 10, 'Approximation'),
      make('12 km s', 61, 687.5, 34),
      make('−', 95, 691.1, 6, 7, 'Symbol'),
      make('1', 101, 691.1, 4, 7, 'Exponent'),
      make('are useful for comparing the measured', 108, 687.5, 184, 10, 'Text', true),
      make('velocity distributions.', 50, 675, 85, 10, 'Text', true),
      make('A separate instrument confirmed the readings.', 59, 662.5, 200, 10, 'Text', true)
    ]
    if (shape === 'displaced exponent') page.items[11].transform[5] -= 1.5
    if (shape === 'different sign font') page.items[8].fontName = 'Other'
    if (shape === 'displaced prose rail') page.items[13].transform[4] += 4
    const owner = extract(page)
    if (shape === 'intact') {
      expect(owner(8)).toBe(owner(7))
      expect(owner(8)).toBe(owner(12))
      expect(owner(8).source).toContain('near ∼ 4 km s−1 and ∼ 12 km s−1 are useful')
    } else {
      expect(owner(8)).not.toBe(owner(7))
      expect(owner(8).sourceOnly).toBe(true)
    }
  }
)
