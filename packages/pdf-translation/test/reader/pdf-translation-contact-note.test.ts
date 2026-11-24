import { expect, test } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const run = (
  str: string,
  fontName: string,
  height: number,
  x: number,
  y: number,
  width: number,
  hasEOL: boolean
): PdfLayoutTextItem => ({
  str,
  dir: 'ltr',
  width,
  height,
  transform: [height, 0, 0, height, x, y],
  fontName,
  fontAscent: 0.89,
  fontDescent: -0.216,
  fontVertical: false,
  hasEOL
})

test.each([true, false])(
  'preserves a marked contact above an independent prose note (%s)',
  (paired) => {
    const items = [
      run('A review of seasonal surveys', 'heading', 15, 188, 738, 221, true),
      run('Survey observations were recorded at the marked sites.', 'body', 10, 72, 715, 390, true),
      run('The measurements use the same units at each site.', 'body', 10, 72, 703, 390, true),
      run('Observers kept the complete record for the review.', 'body', 10, 72, 691, 390, true),
      run('∗', 'mark', 6, 83, 114.2, 3.65, false),
      run(
        'Coastal Survey Office, Field division, {rivera, patel}@example.invalid',
        'note',
        8,
        87.2,
        111.3,
        432,
        true
      ),
      run('1', paired ? 'mark' : 'foreign', 6, 83, 104.7, 3.65, false),
      run(
        'Specifically, we kept the observations collected during the daytime survey only.',
        'note',
        8,
        87.2,
        101.8,
        430,
        true
      ),
      run('1', 'body', 10, 295, 72, 5, true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const contact = units.find((unit) => unit.items.includes('1:4'))
    const prose = units.find((unit) => unit.items.includes('1:6'))
    if (paired) {
      expect(contact?.sourceOnly).toBe(true)
      expect(contact?.items).toEqual(['1:4', '1:5'])
      expect(prose?.sourceOnly).not.toBe(true)
      expect(prose?.items).toEqual(['1:6', '1:7'])
    } else {
      expect(contact?.sourceOnly).not.toBe(true)
      expect(prose).toBe(contact)
    }
  }
)
