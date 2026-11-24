import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each(['within rule', 'shifted rule', 'without rule'] as const)(
  'requires valid paint to retain both native letter operands: %s',
  (shape) => {
    const font = {
      ascent: 0.72,
      descent: -0.2,
      vertical: false as const,
      nativeMetrics: true as const
    }
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'symbols',
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height: 12,
      transform: [12, 0, 0, 12, x, y],
      fontName,
      fontAscent: font.ascent,
      fontDescent: font.descent,
      fontVertical: font.vertical,
      hasEOL
    })
    const items = [
      row(
        'The estimates combine two independent measurements in the displayed relation.',
        48,
        632,
        395,
        'body',
        true
      ),
      row('f', 226.5, 611, 6, 'variables', true),
      row('m', 226, 595, 7, 'variables'),
      row('= 1', 237.5, 603, 18),
      row('−', 258.5, 603, 9.5),
      row('p', 272.5, 611, 5.5, 'variables', true),
      row('m', 272, 595, 7, 'variables'),
      row('≥', 283.5, 603, 9.5),
      row('0.', 296, 603, 9, 'symbols', true),
      row(
        'Therefore the displayed relation holds for each measured response.',
        48,
        579,
        340,
        'body',
        true
      )
    ]
    const left = shape === 'shifted rule' ? 222 : 226
    const rules =
      shape === 'without rule'
        ? []
        : [{ left, right: left + 7, baseline: 606, halfHeight: 0.24, operators: [1] }]
    const { units } = groupPdfTranslationPages({
      pages: [
        {
          page: 1,
          width: 600,
          height: 800,
          rotation: 0,
          items,
          nativeDisplayMathEvidence: {
            complete: true,
            rules,
            fonts: { body: font, variables: font, symbols: font }
          }
        }
      ]
    })
    for (const key of ['1:1', '1:2']) {
      const scope = units.find((unit) => unit.items.includes(key))
      expect(scope?.items).toEqual([key])
      expect(Boolean(scope?.sourceOnly)).toBe(shape === 'within rule')
    }
    expect(units.find((unit) => unit.items.includes('1:9'))?.sourceOnly).toBeUndefined()
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.map((_, index) => `1:${index}`).sort()
    )
  }
)
