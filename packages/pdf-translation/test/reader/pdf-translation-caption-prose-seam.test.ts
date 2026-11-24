import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([true, false])(
  'continues prose past a page-opening caption (shared margin=%s)',
  (aligned) => {
    const line = (str: string, x: number, y: number, width: number): PdfLayoutTextItem => ({
      str,
      width,
      height: 10,
      dir: 'ltr',
      fontName: 'Body',
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false,
      transform: [10, 0, 0, 10, x, y],
      hasEOL: true
    })
    const pages = [
      [
        line(
          'The earliest records show modest variations in the measured stream.',
          125,
          177.2,
          358
        ),
        line('These observations reflect the width of the channel.', 125, 164.8, 215),
        line('In the field, changing levels may alter the current over the bank,', 125, 135.4, 358),
        line('and the higher sustained flow can create visible', 125, 123, 358),
        line('1', 303.5, 95.5, 5)
      ],
      [
        line('Figure 1: Overview of the measurement sites along the lower bank.', 125, 478.5, 358),
        line('The marked points show the limits of the surveyed area.', 125, 466.1, 272),
        line('marks such as channels, grooves and shallow pits.', aligned ? 125 : 132, 438.6, 255),
        line(
          'In this study, we compare the measured width of the different marks',
          125,
          426.2,
          358
        ),
        line(
          'along the river with measurements taken in a controlled channel at several',
          125,
          413.8,
          358
        ),
        line('points during the full monitoring period.', 125, 401.4, 223),
        line('2', 303.5, 95.5, 5)
      ]
    ].map((items, index) => ({ page: index + 1, width: 612, height: 792, rotation: 0, items }))
    const { units } = groupPdfTranslationPages({ pages })
    const owner = units.find((unit) => unit.items.includes('1:3'))
    const next = units.find((unit) => unit.items.includes('2:3'))
    expect(owner?.items.includes('2:2')).toBe(aligned)
    expect(owner?.fragments.map(({ page }) => page)).toEqual(aligned ? [1, 2] : [1])
    if (aligned) expect(next?.source).toMatch(/^In this study,/u)
    expect(units.flatMap(({ items }) => items).sort()).toEqual(
      pages.flatMap((page) => page.items.map((_, i) => `${page.page}:${i}`)).sort()
    )
  }
)

it.each(['matched', 'wrong panel', 'drifting rail', 'different typeface'])(
  'keeps the proved terminal panel text with its three-line caption (%s)',
  (variant) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL: boolean,
      fontName = 'caption',
      size = 9
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      fontName,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false,
      transform: [size, 0, 0, size, x, y],
      hasEOL
    })
    const items = [
      row(
        'Figure 1: (A) The top row shows paired model geometries with a shared reference scale; (B)',
        54,
        332,
        417,
        false
      ),
      row('Contours', 474, 332, 63, false, 'caption-emphasis'),
      row('dis-', 541, 332, 18, true),
      row(
        'play the aligned edge colors of the expanded records (C) and the illustration of measured',
        54,
        321,
        504,
        true
      ),
      row(
        variant === 'wrong panel' ? 'diffusion(E).' : 'diffusion(D).',
        variant === 'drifting rail' ? 59 : 54,
        310,
        64,
        false,
        variant === 'different typeface' ? 'body' : 'caption'
      ),
      row('Abstract', 54, 291, 42, true, 'caption', 11),
      row('The measurement uses a stable reference at', 54, 275, 207, true, 'body', 11),
      row('the origin to limit the change of scale.', 54, 262, 190, true, 'body', 11)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const caption = units.find((unit) => unit.items.includes('1:0'))!
    expect(caption.items.includes('1:4')).toBe(variant === 'matched')
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(items.map((_, i) => '1:' + i))
    if (variant === 'matched') {
      expect(caption.fragments).toHaveLength(1)
      expect(caption.source.endsWith('measured diffusion(D).')).toBe(true)
    }
  }
)
