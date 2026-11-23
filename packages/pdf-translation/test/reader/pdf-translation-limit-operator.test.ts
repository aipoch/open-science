import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([false, true])(
  'preserves a limit operator with a centered native index, shifted=%s',
  (shifted) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height: number,
      fontName: string,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height,
      transform: [height, 0, 0, height, x, y],
      fontName,
      hasEOL,
      fontVertical: false,
      fontAscent: fontName === 'Index' ? 0.695 : fontName === 'Arrow' ? 0.589 : 0.75,
      fontDescent: fontName === 'Index' ? -0.01 : fontName === 'Arrow' ? -0.089 : -0.25
    })
    const items = [
      item('lim sup', 268, 285, 28.15, 9, 'Roman'),
      item('', 273.5, 277.6, 0, 0, 'Index', true),
      item('r', 273.5, 277.6, 2.4, 6, 'Index'),
      item('→∞', shifted ? 277.5 : 275.9, 277.6, 14.6, 6, 'Arrow'),
      item('', 298.8, 290.8, 0, 0, 'Math', true),
      item('μ', 298.8, 290.8, 5.55, 9, 'Math'),
      item('(', 304.3, 290.8, 3.6, 9, 'Roman'),
      item('r', 314.8, 289.7, 2.4, 6, 'Index'),
      item('r', 312, 277.8, 2.4, 6, 'Index'),
      item('|', 314.9, 278.9, 2.55, 9, 'Symbols')
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const operator = units.find((unit) => unit.items.includes('1:0'))
    expect(operator?.source).toBe('lim sup')
    expect(operator?.sourceOnly).toBe(shifted ? undefined : true)
    expect(operator?.preserve).toBe(shifted ? undefined : 'formula')
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.flatMap(({ str }, n) => (str ? [`1:${n}`] : [])).toSorted()
    )
  }
)

it.each([false, true])(
  'retains accented variables in an aligned numbered display, shifted=%s',
  (shifted) => {
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
      transform: [height, 0, 0, height, x, y],
      dir: 'ltr',
      fontName,
      fontVertical: false,
      fontAscent: 0.75,
      fontDescent: -0.25,
      hasEOL
    })
    const variable = (index: number, x: number, y: number): PdfLayoutTextItem[] => [
      item('ˆ', x + 1.7, y + 2.5, 5),
      item('R', x, y, 6, 10, 'Symbol'),
      item(String(index), x + 6, y - 1.5, 4, 7, 'Subscript')
    ]
    const expression = (
      x: number,
      y: number,
      first: string,
      second: string
    ): PdfLayoutTextItem[] => [
      item('= ˆ', x, y, 15.5),
      item('b', x + 10.4, y, 5.3, 10, 'Symbol'),
      item('†', x + 15.7, y + 3.6, 3.6, 7, 'Mark'),
      item('', x + 15.7, y - 2.5, 0, 0, 'Subscript', true),
      item(first, x + 15.7, y - 2.5, 4.5, 7, 'Subscript'),
      item('ˆ', x + 20.9, y, 5),
      item('c', x + 20.8, y, 5.3, 10, 'Symbol'),
      item(second, x + 26.1, y - 1.5, 4.5, 7, 'Subscript')
    ]
    const items = [
      item('The four components satisfy the following relations:', 60, 720, 240, 10, 'Body', true),
      ...variable(1, 86, 700),
      ...expression(107, 700, 'm', 'n'),
      item(',', 138.4, 700, 3, 10, 'Symbol'),
      ...variable(2, 154, 700),
      ...expression(175, 700, 'n', 'm'),
      item('', 86, 683, 0, 0, 'Body', true),
      ...variable(3, 86, 683),
      ...expression(107, 683, 'r', 's'),
      item(',', 138.4, 683, 3, 10, 'Symbol'),
      ...variable(4, shifted ? 156 : 154, 683),
      ...expression(175, 683, 's', 'r'),
      item('(3)', 287, 683, 13, 10, 'Body', true),
      item(
        'The differences are measured under independent conditions.',
        60,
        663,
        240,
        10,
        'Body',
        true
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 620, height: 800, rotation: 0, items }]
    })
    for (const index of [1, 2, 3, 4]) {
      const itemIdx = items.findIndex((part) => part.str === String(index))
      const owner = units.find((unit) => unit.items.includes('1:' + itemIdx))
      expect(owner?.preserve).toBe(shifted ? undefined : 'formula')
      expect(owner?.sourceOnly).toBe(shifted ? undefined : true)
    }
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.flatMap(({ str }, index) => (str ? ['1:' + index] : [])).toSorted()
    )
  }
)
