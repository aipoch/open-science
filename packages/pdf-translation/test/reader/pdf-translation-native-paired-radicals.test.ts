import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  height = 10,
  fontName = 'Math',
  hasEOL = false
): PdfLayoutTextItem => ({
  str,
  width,
  height,
  dir: 'ltr',
  fontName,
  hasEOL,
  fontAscent: 0.75,
  fontDescent: -0.25,
  fontVertical: false,
  transform: [height, 0, 0, height, x, y]
})

it.each(['intact', 'displaced numerator', 'wrong denominator', 'missing fence'])(
  'protects detached powers in an independently closed pair of radicals (%s)',
  (shape) => {
    const term = (x: number, letter: string, second: boolean): PdfLayoutTextItem[] => {
      const raised = second && shape === 'displaced numerator' ? 1.5 : 0
      return [
        item('√', x, 576.2, 10, 10, 'Radical'),
        item('t', x + 10, 560, 4.5),
        item('2', x + 14.7, 562.9, 4, 7, 'Power'),
        item('−', x + 21.4, 560, 7.75, 10, 'Symbol'),
        item(letter, x + 32.6, 566.8 + raised, 4.75),
        item('2', x + 37.4, 569.7 + raised, 4, 7, 'Power'),
        item(second && shape === 'wrong denominator' ? '5' : '4', x + 34.5, 553.2, 5, 10, 'Symbol'),
        item(second && shape === 'missing fence' ? '' : '|', x + 43.2, 560, 2.75, 10, 'Symbol')
      ]
    }
    const items = [
      item(
        'The measurements give two independent geometric conditions.',
        80,
        604,
        340,
        10,
        'Body',
        true
      ),
      item(
        'It follows that the common product is given by the next relation.',
        80,
        590,
        350,
        10,
        'Body',
        true
      ),
      item('uv', 165, 560, 9.5),
      item('=', 177.25, 560, 7.75, 10, 'Symbol'),
      item('|', 187.8, 560, 2.75, 10, 'Symbol'),
      item('u', 190.55, 560, 5.2),
      ...term(195.8, 'u', false),
      item('+', 244, 560, 7.75, 10, 'Symbol'),
      item('|', 254, 560, 2.75, 10, 'Symbol'),
      item('v', 256.75, 560, 4.6),
      ...term(261.4, 'v', true),
      item('.', 307.35, 560, 2.75, 10, 'Math', true),
      item(
        'Both terms can be measured separately in the controlled design.',
        80,
        531,
        340,
        10,
        'Body',
        true
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.flatMap((entry, index) => (entry.str ? ['1:' + index] : [])).toSorted()
    )
    for (const value of ['u2', 'v2']) {
      const owner = units.find((entry) => entry.source === value)
      expect(owner?.items).toHaveLength(2)
      expect(owner?.sourceOnly).toBe(shape === 'intact' ? true : undefined)
      expect(owner?.preserve).toBe(shape === 'intact' ? 'formula' : undefined)
    }
    expect(units.at(-1)?.sourceOnly).toBeUndefined()
  }
)
