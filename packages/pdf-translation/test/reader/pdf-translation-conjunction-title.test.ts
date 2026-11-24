import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([true, false])(
  'joins a centered conjunction title above its numbered byline when the tail shares its center (%s)',
  (centered) => {
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
      width,
      height,
      dir: 'ltr',
      transform: [height, 0, 0, height, x, y],
      hasEOL,
      fontName,
      fontAscent: 0.72,
      fontDescent: -0.22,
      fontVertical: false
    })
    const title =
      'Shared Methods for Geoscience: Lessons from a Community Project on Atmospheric Data Collection'
    const tail = 'and Observation Network Planning'
    const items = [
      item('Draft version March 11, 2024', 51, 737, 118, 8, 'Front', true),
      item('Typeset using the article class', 51, 725, 174, 8, 'Front', true),
      item(title, 51, 678, 510, 10, 'Title', true),
      item(tail, centered ? 227 : 237, 665.5, 158, 10, 'Title'),
      item('', 86, 646.5, 0, 0, 'Byline', true),
      item('Dana Brook,', 86, 646.5, 64, 9, 'Byline'),
      item('1', 150, 650.5, 4, 6, 'Mark'),
      item('Eli Field,', 469, 646.5, 52, 9, 'Byline'),
      item('2', 521, 650.5, 5, 6, 'Mark'),
      item('', 275, 548, 0, 0, 'Body', true),
      item('ABSTRACT', 275, 548, 62, 10, 'Body', true),
      item('This report describes a framework for a network.', 60, 531, 251, 10, 'Body', true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const head = units.find((unit) => unit.items.includes('1:2'))
    const continuation = units.find((unit) => unit.items.includes('1:3'))
    if (centered) {
      expect(head?.source).toBe(title + ' ' + tail)
      expect(head?.items).toEqual(['1:2', '1:3'])
      expect(continuation).toBe(head)
    } else {
      expect(head?.source).toBe(title)
      expect(continuation?.source).toBe(tail)
    }
  }
)
