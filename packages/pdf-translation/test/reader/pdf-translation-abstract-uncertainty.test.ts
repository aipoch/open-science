import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  height = 10,
  fontName = 'Body',
  hasEOL = false
): PdfLayoutTextItem => ({
  str,
  width,
  height,
  dir: 'ltr',
  fontName,
  fontAscent: 0.694,
  fontDescent: -0.194,
  fontVertical: false,
  hasEOL,
  transform: [height, 0, 0, height, x, y]
})

it.each(['closed abstract row', 'independent heading', 'displaced lower bound'])(
  'requires the entire native abstract uncertainty row and its continuation (%s)',
  (shape) => {
    const shift = shape === 'displaced lower bound' ? 1 : 0
    const items = [
      item(
        shape === 'independent heading' ? 'RESULTS' : 'ABSTRACT',
        260,
        690,
        50,
        10,
        'Body',
        true
      ),
      item('The reported signal repeats on a 12', 95, 675, 180),
      item('.', 275, 675, 3, 10, 'Point'),
      item('3456', 278, 675, 20),
      item('+0', 298, 679.3, 10, 7, 'Script'),
      item('.', 308, 679.3, 2.4, 7, 'ScriptPoint'),
      item('0056', 310.4, 679.3, 16, 7, 'Script'),
      item('', 298, 672.3, 0, 0, 'Sign', true),
      item('−', 298 + shift, 672.3, 6.2, 7, 'Sign'),
      item('0', 304.2 + shift, 672.3, 4, 7, 'Script'),
      item('.', 308.2 + shift, 672.3, 2.4, 7, 'ScriptPoint'),
      item('0078', 310.6 + shift, 672.3, 16, 7, 'Script'),
      item('d cycle with measurable variation', 329, 675, 174, 10, 'Body', true),
      item('across the time series collected during the study.', 87, 663.5, 416, 10, 'Body', true),
      item(
        'Further measurements will test the evidence for this pattern.',
        87,
        652,
        307,
        10,
        'Body',
        true
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
    })
    const retained = units.find((unit) => unit.preserve === 'literal')
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.flatMap(({ str }, index) => (str ? [`1:${index}`] : [])).sort()
    )
    if (shape === 'closed abstract row') {
      expect(retained?.sourceOnly).toBe(true)
      expect(retained?.source).toBe(
        'The reported signal repeats on a 12.3456+0.0056−0.0078 d cycle with measurable variation'
      )
      expect(retained?.items).toEqual(
        items.flatMap(({ str }, index) => (str && index >= 1 && index <= 12 ? [`1:${index}`] : []))
      )
      const continuation = units.find((unit) => unit.items.includes('1:13'))
      expect(continuation?.source).toMatch(/^across the time series/u)
      expect(continuation?.sourceOnly).toBeFalsy()
    } else {
      expect(retained).toBeUndefined()
    }
  }
)
