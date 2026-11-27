import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([false, true])(
  'keeps numbered scientific table records in distinct rows (missing exponent=%s)',
  (missingExponent) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      font = 'body',
      height = 9,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height,
      transform: [height, 0, 0, height, x, y],
      fontName: font,
      fontAscent: 0.75,
      fontDescent: -0.25,
      fontVertical: false,
      hasEOL
    })
    const labels = ['Static', 'Axial drift', 'Radial pickup', 'Coupling']
    const items = [
      item('Term', 110, 730, 22),
      item('Size (Hz)', 189, 730, 40),
      item('Interpretation', 234, 730, 56, 'body', 9, true),
      ...labels.flatMap((label, offset) => {
        const y = 717 - offset * 13
        return [
          item(`${offset + 1}.`, 62, y, 8),
          item('−', 100, y, 7, 'symbol'),
          item('q', 109, y, 5, 'italic'),
          item('T', 116, y, 6, 'italic'),
          item('2', 123, y + 4, 4, 'script', 6),
          item(String(offset + 2), 192, y, 5),
          item('×', 201, y, 7, 'symbol'),
          item('10', 211, y, 9),
          ...(!missingExponent || offset !== 2
            ? [item('−', 220, y + 4, 4, 'script', 6), item('5', 224, y + 4, 4, 'script', 6)]
            : []),
          item(label, 242, y, 39, 'body', 9, true)
        ]
      }),
      item(
        'TABLE I: Independent measurements for a synthetic experiment.',
        53,
        658,
        244,
        'body',
        9,
        true
      ),
      item('The surrounding prose remains independently writable.', 53, 620, 225, 'body', 10, true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const owned = (text: string): (typeof units)[number] | undefined =>
      units.find((unit) => unit.source === text)
    const numbers = units.filter((unit) => unit.source.includes('×'))
    if (!missingExponent) {
      expect(owned('Axial drift')?.items).toHaveLength(1)
      expect(owned('Radial pickup')?.items).toHaveLength(1)
      expect(owned('Axial drift')?.sourceOnly).toBeUndefined()
      expect(owned('Radial pickup')?.sourceOnly).toBeUndefined()
      expect(numbers).toHaveLength(4)
      expect(numbers.every((unit) => unit.sourceOnly && unit.items.length === 5)).toBe(true)
    } else {
      expect(numbers.some((unit) => !unit.sourceOnly || unit.items.length !== 5)).toBe(true)
    }
    const ownedItems = units.flatMap((unit) => unit.items)
    expect(ownedItems).toHaveLength(items.length)
    expect(new Set(ownedItems).size).toBe(items.length)
    const prose = owned('The surrounding prose remains independently writable.')
    expect(prose).toBeDefined()
    expect(prose?.sourceOnly).toBeUndefined()
  }
)
