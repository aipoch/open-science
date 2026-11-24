import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const run = (str: string, x: number, y: number, width: number, size = 11): PdfLayoutTextItem => ({
  str,
  width,
  height: size,
  dir: 'ltr',
  transform: [size, 0, 0, size, x, y],
  hasEOL: !str,
  fontName: 'Body',
  fontAscent: 0.75,
  fontDescent: -0.2,
  fontVertical: false
})

it.each([true, false])(
  'joins a matching raised rate across a native line break (%s)',
  (aligned) => {
    const items = [
      run(
        'The team records the position of the blue marker at several points along the track.',
        72,
        709,
        461
      ),
      run('', 72, 694.5, 0, 0),
      run(
        'It compares the readings at the start and end to check the accuracy of the method.',
        72,
        694.5,
        451
      ),
      run('', 72, 680, 0, 0),
      run('The two estimates from the instruments remained consistent at 1.4m/s', 72, 680, 429.7),
      run('2', 501.7, 684, 3.9, 7),
      run(' ', 505.6, 684, 3, 0),
      run('and', 508.6, 680, 18.3),
      run('', 72, 665.5, 0, 0),
      run('1.25 m/s', 72, 665.5, 42.3),
      run('2', 114.3, 669.5, 3.9, 7),
      run('.', 118.2, 665.5, 3),
      run('', 72, aligned ? 636.5 : 629, 0, 0),
      run(
        'Additional simulations can repeat this comparison for the same track.',
        72,
        aligned ? 636.5 : 629,
        421
      ),
      run('', 72, aligned ? 622 : 614.5, 0, 0),
      run(
        'The worksheet provides the complete sequence and a summary of the data.',
        72,
        aligned ? 622 : 614.5,
        447
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const paragraph = units.find(({ source }) => source.includes('consistent at'))
    expect(paragraph?.source.endsWith('and 1.25 m/s2.')).toBe(aligned)
    expect(units.some(({ source, sourceOnly }) => sourceOnly && source === '1.25 m/s2.')).toBe(
      !aligned
    )
  }
)
