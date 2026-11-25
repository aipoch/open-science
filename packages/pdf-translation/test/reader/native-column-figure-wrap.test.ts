import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([true, false])(
  'continues a witnessed broken word below a column figure (%s)',
  (witness) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'body',
      size = 10,
      hasEOL = true
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      transform: [size, 0, 0, size, x, y],
      fontName,
      fontAscent: 0.74,
      fontDescent: -0.22,
      fontVertical: false,
      hasEOL
    })
    const items = [
      item(
        witness
          ? 'The reconstruction uses signals collected from the same apparatus'
          : 'The new method uses signals collected from the same apparatus',
        54,
        104.3,
        245
      ),
      item('to avoid false detections after the reference was set. How-', 54, 92.4, 245),
      item('ever, the same readings can provide a useful mea-', 54, 80.4, 245),
      item('surement that requires a complete recon-', 54, 68.4, 245, 'body', 10, false),
      item('a', 325.2, 448.8, 5.3, 'panel', 9.5),
      item('b', 325.2, 382.9, 5.8, 'panel', 9.5, false),
      item('Input', 386, 334, 16, 'figure', 7.2),
      item('FIG.', 317, 301.9, 19.1, 'caption', 9, false),
      item('2.', 341.9, 301.9, 7.1, 'caption', 9, false),
      item('(a)', 361.3, 301.9, 11.7, 'caption', 9, false),
      item(
        'The calibration path and the timing of the sampled signal.',
        317,
        291.5,
        245,
        'caption',
        9
      ),
      item(
        'The second panel shows the comparison apparatus.',
        317,
        270.5,
        243,
        'caption',
        9,
        false
      ),
      item('struction can also test the consistency of the baseline', 317, 236, 245),
      item('against the independent records.', 317, 224, 135),
      item('The second experiment evaluates recovery under small loads', 327, 212, 235),
      item('from each of the sampling sites using the same instrument.', 317, 200, 245)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const head = units.find((unit) => unit.items.includes('1:3'))
    const tail = units.find((unit) => unit.items.includes('1:12'))
    expect(head === tail).toBe(witness)
    expect(head?.source.includes('reconstruction can also test')).toBe(witness)
    expect(units.find((unit) => unit.items.includes('1:7'))?.items).toEqual([
      '1:7',
      '1:8',
      '1:9',
      '1:10',
      '1:11'
    ])
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.map((_, i) => '1:' + i).toSorted()
    )
  }
)

it.each(['continuous', 'offset', 'different-face', 'nearby-body'])(
  'joins native centered figure caption rows only with the shared heading rail (%s)',
  (condition) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'body',
      size = 10,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: size,
      transform: [size, 0, 0, size, x, y],
      fontName,
      hasEOL,
      dir: 'ltr',
      fontAscent: 0.82,
      fontDescent: -0.18,
      fontVertical: false
    })
    const items = [
      row('The experiment uses three independent measurements.', 54, 710, 243, 'body', 10, true),
      row('The calibration procedure is given in the lab manual.', 54, 698.6, 243),
      row('Independent image labels for the first panel.', 90, 310, 160, 'diagram', 6),
      row('FIG. 2: Three test images. The remaining panel is', 68.5, 276.6, 214, 'body', 10, true),
      row('excluded from the final presentation.', 110.5, 265.1, 130),
      row('B.', 141, 224.7, 9, 'heading', 9),
      row('Data review', 159, 224.7, 51, 'heading', 9),
      row('We compared the results from the repeated trial.', 64, 199.1, 233, 'body', 10, true),
      row('The procedure described above was used throughout.', 54, 187.7, 243),
      row('All numbers and units are defined below.', 315, 710, 243, 'body', 10, true),
      row('The amount was estimated by the sample average.', 315, 698.6, 243),
      row('3', 550, 36, 5)
    ]
    if (condition === 'offset') items[4].transform[4] += 4
    if (condition === 'different-face') items[4].fontName = 'other'
    if (condition === 'nearby-body') items[5].str = 'Additional'
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const head = units.find((unit) => unit.items.includes('1:3'))
    expect(head?.items).toEqual(condition === 'continuous' ? ['1:3', '1:4'] : ['1:3'])
    if (condition === 'continuous')
      expect(head?.source).toBe(
        'FIG. 2: Three test images. The remaining panel is excluded from the final presentation.'
      )
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.map((_, index) => '1:' + index).toSorted()
    )
  }
)
