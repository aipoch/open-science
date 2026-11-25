import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each(['complete', 'displaced', 'no affiliation'])(
  'groups a compact title with %s native evidence',
  (evidence) => {
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
    const title = 'A paired model for small changes and delayed responses'
    const tail = 'in a mesh of elastic cells'
    const items = [
      {
        ...item('Sample preprint metadata', 32, 180, 380, 20, 'Margin'),
        transform: [0, 20, -20, 0, 32, 180]
      },
      item('', 159, 730, 0, 0, 'Title', true),
      item(title, 159, 730, 298, 12, 'Title', true),
      item(tail, evidence === 'displaced' ? 214 : 208, 716, 200, 12, 'Title'),
      item('', 200, 692, 0, 0, 'Author', true),
      item('A. Sample, M.B. van Field, and T.C. River', 200, 692, 216, 10, 'Author'),
      item('', 193, 681, 0, 0, 'Affiliation', true),
      item(
        evidence === 'no affiliation'
          ? 'Sample City, Research District, Mail Stop 200'
          : 'Sample University, Range Laboratory, Mail Stop 200',
        193,
        681,
        230,
        9,
        'Affiliation',
        true
      ),
      item('The main text begins here and describes the evidence.', 55, 580, 245, 10, 'Body', true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const head = units.find((unit) => unit.items.includes('1:2'))
    const continuation = units.find((unit) => unit.items.includes('1:3'))
    if (evidence === 'complete') {
      expect(head?.source).toBe(title + ' ' + tail)
      expect(head?.items).toEqual(['1:2', '1:3'])
      expect(head?.sourceOnly).toBeUndefined()
      expect(continuation).toBe(head)
    } else {
      expect(head?.source).toBe(title)
      expect(continuation?.source).toBe(tail)
    }
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.flatMap((item, index) => (item.str.trim() ? [`1:${index}`] : [])).toSorted()
    )
  }
)
