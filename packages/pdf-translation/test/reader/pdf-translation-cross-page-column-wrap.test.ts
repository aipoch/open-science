import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'

function row(
  text: string,
  x: number,
  y: number,
  width: number,
  font = 10,
  fontName = 'Body',
  hasEOL = true
): PdfLayoutTextItem {
  return {
    str: text,
    width,
    height: font,
    dir: 'ltr',
    fontName,
    fontAscent: 0.75,
    fontDescent: -0.2,
    fontVertical: false,
    transform: [font, 0, 0, font, x, 840 - y],
    hasEOL
  }
}

it.each([true, false])(
  'continues a hyphenated word below a float with native-order evidence (%s)',
  (witnessed) => {
    const pages: PdfLayoutPage[] = [
      {
        page: 1,
        width: 600,
        height: 840,
        rotation: 0,
        items: [
          row('The old material was measured in a temperature-controlled chamber.', 36, 64, 252),
          row('The resulting values remained within the permitted limit.', 36, 75, 222),
          row(
            'The calibrated instrument measured the residual signal in each group and compared',
            302,
            734,
            252
          ),
          row(
            'the observations using several independent procedures for the test of the new ma-',
            302,
            745,
            252,
            10,
            'Body',
            false
          )
        ]
      },
      {
        page: 2,
        width: 600,
        height: 840,
        rotation: 0,
        items: [
          row('0.00', 48, 55, 13, 8, 'Axes'),
          row('0.25', 48, 128.3, 13, 8, 'Axes'),
          row('0.50', 48, 201.7, 13, 8, 'Axes'),
          row('0.75', 292, 275, 13, 8, 'Axes'),
          row('time', 146, 290, 18, 8, 'Axes'),
          row(
            'Fig. 1. The two curves describe the calibration for both instruments.',
            36,
            320,
            252,
            9
          ),
          row(
            'The illustrated deviations are smaller than the measurement error.',
            36,
            330,
            252,
            9,
            'Body',
            false
          ),
          row(
            witnessed
              ? 'terial in the smaller chamber, using the same environmental settings.'
              : 'traces in the smaller chamber, using the same environmental settings.',
            36,
            352,
            252
          ),
          row('Each replacement followed the procedure described in the methods.', 36, 363, 252),
          row('Measurements were collected with two different instruments.', 36, 374, 252),
          row(
            'All recorded values were included in the analysis.',
            36,
            385,
            198,
            10,
            'Body',
            false
          ),
          row('3. Secondary analysis', 36, 641, 122, 10.4, 'Heading'),
          row('The second series of measurements covers a longer time span and', 36, 725, 252),
          row(
            'the test results for all samples from the second group',
            36,
            736,
            252,
            10,
            'Body',
            false
          ),
          row('were recorded with the instrument configured at a different setting.', 302, 61, 252),
          row('The residual error remained small across the entire measured range.', 302, 72, 252),
          row('The last run measured an independently prepared control sample.', 302, 83, 252),
          row('An additional instrument recorded the signal at the same interval.', 302, 94, 252),
          row(
            'The earliest observations were repeated several times.',
            302,
            105,
            230,
            10,
            'Body',
            false
          )
        ]
      }
    ]
    const { units } = groupPdfTranslationPages({ pages })
    const previous = units.find((u) => u.items.includes('1:3'))
    const wrongLane = units.find((u) => u.items.includes('2:14'))
    const caption = units.find((u) => u.items.includes('2:5'))
    expect(previous).toBeDefined()
    expect(caption?.items).toEqual(['2:5', '2:6'])
    expect(previous?.items.includes('2:7')).toBe(witnessed)
    expect(previous === wrongLane).toBe(!witnessed)
    if (witnessed) {
      expect(previous?.source).toContain('new material in the smaller chamber')
      expect(wrongLane?.items).toContain('2:13')
    }
  }
)
