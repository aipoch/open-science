import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

function row(
  str: string,
  x: number,
  y: number,
  width: number,
  fontName = 'body',
  hasEOL = true
): PdfLayoutTextItem {
  return {
    str,
    dir: 'ltr',
    width,
    height: 9,
    transform: [9, 0, 0, 9, x, y],
    fontName,
    fontAscent: 0.8,
    fontDescent: -0.2,
    fontVertical: false,
    hasEOL
  }
}

it.each(['match', 'caption', 'other font', 'displaced row'])(
  'requires adjacent native prose for a wrapped inline table reference (%s)',
  (variant) => {
    const items = [
      row('The first group of measurements was collected in the morning.', 305, 341, 240),
      row('We compare the reported response with the baseline readings', 305, 330, 239),
      row('and check whether the reported score is', 305, 319, 156, 'body', false),
      row('AB C', 465, 319, 18, 'math', false),
      row('≥', 487, 319, 6, 'operator', false),
      row('5', 497, 319, 5, 'value', false),
      row('(see their', 506, 319, 38),
      row(
        variant === 'caption' ? 'Table 1. Independent readings' : 'Table I).',
        305,
        variant === 'displaced row' ? 298 : 308,
        35,
        variant === 'other font' ? 'caption' : 'body'
      ),
      row('A second test recorded the same measurements at night.', 323, 291, 221),
      row('We report the independent set of measurements in the appendix.', 305, 280, 240)
    ]
    const layout = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const owner = layout.units.find((unit) => unit.items.includes('1:6'))

    expect(owner?.items.includes('1:7')).toBe(variant === 'match')
    expect(owner?.items).not.toContain('1:8')
    if (variant === 'match') {
      expect(owner?.source).toMatch(/\(see their Table I\)\.$/u)
      expect(owner?.fragments).toHaveLength(1)
      expect(owner?.sourceOnly).toBeUndefined()
    }
    expect(
      layout.units.flatMap((unit) => unit.items).filter((item) => item === '1:7')
    ).toHaveLength(1)
  }
)
