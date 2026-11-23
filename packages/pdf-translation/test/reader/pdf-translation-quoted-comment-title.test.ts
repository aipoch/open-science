import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([3, 4])(
  'joins a quoted comment title when its abstract cites the same work (%s)',
  (reference) => {
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
      dir: 'ltr',
      width,
      height,
      transform: [height, 0, 0, height, x, y],
      fontName,
      hasEOL,
      fontAscent: 0.72,
      fontDescent: -0.22,
      fontVertical: false
    })
    const head = 'Comment on ‘A careful method for estimating variation in'
    const tail = 'rivers’ [3]'
    const items = [
      item(head, 72, 708, 452, 12, 'Title', true),
      item(tail, 264, 694.5, 68, 12, 'Title'),
      item('', 0, 0, 0, 0, 'Title', true),
      item('Example Writer', 251, 673, 89, 11),
      item('1', 340, 677, 4, 8, 'Mark'),
      item('', 0, 0, 0, 0, 'Body', true),
      item('Institute of Applied Measurements', 201, 652, 196, 10),
      item('Somewhere, Example Country', 205, 638, 186, 10, 'Body', true),
      item('Abstract', 273, 602, 50, 10, 'Heading', true),
      item('', 0, 0, 0, 0, 'Body', true),
      item(
        `Reference [${reference}] compares data collected in two regions.`,
        118,
        585,
        350,
        10,
        'Body',
        true
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const title = units.find((unit) => unit.items.includes('1:0'))
    const closing = units.find((unit) => unit.items.includes('1:1'))
    if (reference === 3) {
      expect(closing).toBe(title)
      expect(title?.source).toBe(`${head} ${tail}`)
      expect(title?.fragments).toHaveLength(2)
    } else {
      expect(closing?.source).toBe(tail)
      expect(title?.source).toBe(head)
    }
    expect(units.find((unit) => unit.items.includes('1:3'))?.items).toEqual(['1:3', '1:4'])
  }
)
