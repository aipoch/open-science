import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([false, true])(
  'retains a diagram fraction only with a native peer and caption, raised=%s',
  (raised) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 8,
      fontName = 'Label',
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height,
      transform: [height, 0, 0, height, x, y],
      fontName,
      fontAscent: 0.75,
      fontDescent: -0.25,
      fontVertical: false,
      hasEOL
    })
    const items = [
      item('proba', 235, 220, 21.5),
      item(' ', 256.5, 220, 6.3, 0),
      item('1', 263, 223.3, 3.7, 6, 'Number'),
      item('', 260.5, 216.8, 0, 0, 'Math', true),
      item('W', 260.5, 216.8, 4.5, 6, 'Math'),
      item('1', 265, 215.6, 3.5, 5, 'Index'),
      item('proba', 296, 220, 21.5),
      item(' ', 317.5, 220, 4, 0),
      item('W', 321.5, 223.8, 4.5, 6, 'Math'),
      item('1', 326, 222.6, 3.5, 5, 'Index'),
      item('', 321.5, 216.8, 0, 0, 'Math', true),
      item('W', 321.5, 216.8, 4.5, 6, 'Math'),
      item('2', 326, raised ? 217.6 : 215.6, 3.5, 5, 'Index'),
      item('round 1', 251, 181, 34, 10, 'Body'),
      item('round 2', 311, 181, 34, 10, 'Body'),
      item(
        'Figure 1: Independent selections across several rounds.',
        92,
        165,
        415,
        10,
        'Body',
        true
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const first = units.find((unit) => unit.items.includes('1:0'))
    const peer = units.find((unit) => unit.items.includes('1:6'))
    expect(first).toMatchObject({ source: 'proba 1W1', items: ['1:0', '1:2', '1:4', '1:5'] })
    expect(first?.sourceOnly).toBe(raised ? undefined : true)
    expect(first?.preserve).toBe(raised ? undefined : 'formula')
    expect(peer?.sourceOnly).toBe(raised ? undefined : true)
    expect(peer?.preserve).toBe(raised ? undefined : 'formula')
    expect(units.find((unit) => unit.items.includes('1:15'))?.sourceOnly).toBeUndefined()
    const covered = units.flatMap((unit) =>
      unit.items.map((key, index) => [key, unit.originalStrings[index]])
    )
    const native = items.flatMap((entry, index) =>
      entry.str.trim() ? [[`1:${index}`, entry.str]] : []
    )
    expect(covered.toSorted()).toEqual(native.toSorted())
  }
)
