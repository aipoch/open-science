import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

function run(
  str: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontName: string,
  hasEOL = false
): PdfLayoutTextItem {
  return {
    str,
    width,
    height,
    dir: 'ltr',
    transform: [height, 0, 0, height, x, y],
    hasEOL,
    fontName,
    fontAscent: 0.7,
    fontDescent: -0.2,
    fontVertical: false
  }
}

it.each([0, 4])(
  'preserves a powered numerator centered above its denominator (shift %d)',
  (shift) => {
    const units = groupPdfTranslationPages({
      pageCount: 1,
      pages: [
        {
          page: 1,
          width: 612,
          height: 792,
          rotation: 0,
          items: [
            run('The upper estimate follows.', 72, 570, 130, 12, 'Roman', true),
            run('', 235, 540, 0, 12, 'Math', true),
            run('f', 235, 540, 6, 12, 'Math'),
            run('(', 241, 540, 4, 12, 'Roman'),
            run('m', 245, 540, 7, 12, 'Math'),
            run(') = (1 +', 252, 540, 63.3, 12, 'Roman'),
            run(' ', 315.3, 540, 2, 0, 'Roman'),
            run('o', 317.3, 540, 5, 12, 'Math'),
            run('(1))', 322.3, 540, 18.5, 12, 'Roman'),
            run(' ', 340.8, 540, 17.7, 0, 'Roman'),
            run('m', 358.5 + shift, 548.16, 7, 12, 'Math'),
            run('3', 365.5 + shift, 552.48, 4.3, 8, 'Script'),
            run('', 342, 531.84, 0, 12, 'Roman', true),
            run('2', 342, 531.84, 6, 12, 'Roman'),
            run('q', 348, 531.84, 4, 12, 'Math'),
            run('(', 352, 531.84, 4.5, 12, 'Roman'),
            run('q', 356.5, 531.84, 4, 12, 'Math'),
            run(' ', 360.5, 531.84, 2.5, 0, 'Math'),
            run('−', 363, 531.84, 9, 12, 'Symbol'),
            run(' ', 372, 531.84, 2.5, 0, 'Symbol'),
            run('2)', 374.5, 531.84, 11.5, 12, 'Roman', true),
            run('The estimates agree.', 72, 500, 100, 12, 'Roman', true)
          ]
        }
      ]
    }).units
    const power = units.find((unit) => unit.source === 'm3')
    expect(power).toBeDefined()
    expect(Boolean(power?.sourceOnly)).toBe(shift === 0)
    expect(power?.preserve).toBe(shift === 0 ? 'formula' : undefined)
  }
)
