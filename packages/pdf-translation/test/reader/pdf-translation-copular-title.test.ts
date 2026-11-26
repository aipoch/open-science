import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each(['matching', 'detached', 'different subject', 'different author'])(
  'joins the predicate of a centered title with a matching abstract and running byline (%s)',
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
      dir: 'ltr',
      width,
      height,
      transform: [height, 0, 0, height, x, y],
      fontName,
      hasEOL,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false
    })
    const first = 'EVIDENCE THAT THE SAMPLING'
    const second = ' CRITERION'
    const title = first + second
    const tail = 'IS LOCALLY VALID'
    const author = 'RIVER SAMPLE'
    const pages = [
      [
        item(first, 165, 680, 190, 10, 'Title'),
        item(second, 354, 680, 81, 10, 'Title', true),
        item(tail, evidence === 'detached' ? 232 : 226, 666, 148, 10, 'Title'),
        item('', 260, 636, 0, 0, 'Author', true),
        item(author, 260, 636, 80, 8, 'Author'),
        item('', 157, 609, 0, 0, 'Label', true),
        item('Abstract.', 157, 609, 43, 8, 'Label'),
        item(
          'We show that the ' +
            (evidence === 'different subject' ? 'measurement' : 'sampling') +
            ' criterion is valid at this scale.',
          205,
          609,
          238,
          8,
          'Author',
          true
        )
      ],
      [
        item('2', 118, 739, 4, 7, 'Rail'),
        item(' ', 122, 739, 142, 0, 'Rail'),
        item(evidence === 'different author' ? 'RIVER VALE' : author, 264, 739, 72, 7, 'Rail'),
        item('', 258, 715, 0, 0, 'Label', true),
        item('2. Results', 258, 715, 84, 10, 'Label'),
        item('The independent observations are described below.', 118, 696, 305, 10, 'Text')
      ]
    ].map((items, index) => ({ page: index + 1, width: 600, height: 840, rotation: 0, items }))
    const { units } = groupPdfTranslationPages({ pages })
    const joined = evidence === 'matching'
    expect(units[0].source).toBe(joined ? title + ' ' + tail : title)
    expect(units[0].items).toEqual(joined ? ['1:0', '1:1', '1:2'] : ['1:0', '1:1'])
    expect(units[0].fragments).toHaveLength(joined ? 2 : 1)
    expect(units[1].source).toBe(joined ? author : tail)
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      pages
        .flatMap(({ page, items }) =>
          items.flatMap((item, index) => (item.str.trim() ? [page + ':' + index] : []))
        )
        .toSorted()
    )
  }
)
