import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

it.each([true, false])('joins the repeated title with a matching running author=%s', (matching) => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    height = 9,
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
  const title = 'AN ASYMPTOTIC METHOD FOR REPEATED SAMPLE'
  const suffix = 'GROUPING'
  const pages = [
    {
      page: 1,
      width: 600,
      height: 792,
      rotation: 0,
      items: [
        {
          ...item('Sample preprint metadata', 32, 243, 373, 20, 'Margin'),
          transform: [0, 20, -20, 0, 32, 243]
        },
        { ...item(' ', 32, 616, 117, 0, 'Margin'), transform: [0, 20, -20, 0, 32, 616] },
        item(title, 145, 634, 310, 9, 'Title', true),
        item(suffix, 263, 620, 74, 9, 'Title'),
        item('', 271, 590, 0, 0, 'Author', true),
        item('RIVER SAMPLE', 271, 590, 58, 7, 'Author'),
        item('', 158, 564, 0, 0, 'Abstract', true),
        item('Abstract.', 158, 564, 34, 7, 'Abstract'),
        item(
          'We describe a method in an independent family of examples.',
          198,
          564,
          244,
          7,
          'Body',
          true
        ),
        item(
          'This implies an asymptotic method for repeated sample grouping in the next section.',
          158,
          556,
          284,
          7,
          'Body',
          true
        ),
        item(
          'A separate paragraph presents the details and the relevant checks below.',
          126,
          495,
          330,
          9,
          'Main',
          true
        )
      ]
    },
    {
      page: 2,
      width: 600,
      height: 792,
      rotation: 0,
      items: [
        item('2', 124, 690, 5, 6),
        item(matching ? 'RIVER SAMPLE' : 'SAMPLE RIVER', 274, 690, 52, 6, 'Author'),
        item('', 123, 666, 0, 0, 'Body', true),
        item(
          'An independent argument completes the claim at the conclusion of the example.',
          124,
          666,
          352,
          9,
          'Body',
          true
        )
      ]
    }
  ]
  const { units } = groupPdfTranslationPages({ pages })
  const [first, second] = units
  if (matching) {
    expect(first.source).toBe(title + ' ' + suffix)
    expect(first.items).toEqual(['1:2', '1:3'])
    expect(first.fragments).toHaveLength(2)
    expect(second.source).toBe('RIVER SAMPLE')
  } else {
    expect(first.source).toBe(title)
    expect(second.source).toBe(suffix)
  }
})
it.each([false, true])(
  'joins three centered title rows repeated in the abstract, detached=%s',
  (detached) => {
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
      fontAscent: 0.72,
      fontDescent: -0.22,
      fontVertical: false
    })
    const title = [
      'AN EFFICIENT BOUND FOR ORDERED',
      'SAMPLE SETS WITH AN EXACT LOCAL',
      'BALANCE CONDITION'
    ]
    const author = 'RIVER SAMPLE'
    const { units } = groupPdfTranslationPages({
      pages: [
        {
          page: 1,
          width: 600,
          height: 800,
          rotation: 0,
          items: [
            item(title[0], 154, 671, 292, 11, 'Title', true),
            item(title[1], 166, 657, 268, 11, 'Title', true),
            item(title[2], detached ? 192 : 220, 643, 160, 11, 'Title'),
            item('', 238, 618, 0, 0, 'Body', true),
            item(author, 238, 618, 124, 10, 'Body'),
            item('', 166, 576, 0, 0, 'Abstract', true),
            item('Abstract.', 166, 576, 43, 10, 'Abstract'),
            item(
              'We study ordered sample sets with an exact local',
              214,
              576,
              217,
              10,
              'Body',
              true
            ),
            item('balance condition and provide independent examples.', 154, 564, 277, 10, 'Body'),
            item('', 260, 528, 0, 0, 'Abstract', true),
            item('Introduction', 260, 528, 80, 11, 'Abstract')
          ]
        },
        {
          page: 2,
          width: 600,
          height: 800,
          rotation: 0,
          items: [
            item(author, 238, 700, 124, 10, 'Body'),
            item(' ', 362, 700, 109, 0, 'Body'),
            item('2', 471, 700, 5, 10, 'Body'),
            item('', 122, 662, 0, 0, 'Body', true),
            item(
              'We complete the argument with an independent construction.',
              122,
              662,
              354,
              11,
              'Body'
            )
          ]
        }
      ]
    })
    const first = units[0]
    expect(first.source).toBe(detached ? title[0] : title.join(' '))
    expect(first.items).toEqual(detached ? ['1:0'] : ['1:0', '1:1', '1:2'])
    expect(first.fragments).toHaveLength(detached ? 1 : 3)
    expect(units[detached ? 3 : 1].source).toBe(author)
  }
)

it.each([
  { tailOffset: 0, bylineFace: 'Byline', joined: true },
  { tailOffset: 6, bylineFace: 'Byline', joined: false },
  { tailOffset: 0, bylineFace: 'Title', joined: false }
])(
  'joins centered same-size title rows above a separate byline ($tailOffset, $bylineFace)',
  ({ tailOffset, bylineFace, joined }) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height: str ? 11 : 0,
      transform: [11, 0, 0, 11, x, y],
      fontName,
      hasEOL,
      fontAscent: 0.72,
      fontDescent: -0.22,
      fontVertical: false
    })
    const title = 'An Elementary Approach to Comparing a Sequence of Counts'
    const tail = 'on a Grid With Unequal Cells'
    const author = 'Mira Vale and Luca Rios'
    const items = [
      item(title, 106, 710, 400, 'Title', true),
      item(tail, 191 + tailOffset, 695, 230, 'Title'),
      item('', 0, 0, 0, 'Byline', true),
      item(author, 212, 669, 188, bylineFace, true),
      item('The observed values differ across columns.', 72, 620, 248, 'Body', true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    expect(units[0].source).toBe(joined ? title + ' ' + tail : title)
    expect(units[0].items).toEqual(joined ? ['1:0', '1:1'] : ['1:0'])
    expect(units[joined ? 1 : 2].source).toBe(author)
  }
)

it.each([true, false])(
  'joins a short title row confirmed by both running headers (%s)',
  (matching) => {
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
      fontAscent: 0.72,
      fontDescent: -0.22,
      fontVertical: false
    })
    const head = 'A METHOD FOR COMPARING DISCRETE SAMPLE'
    const tail = 'GROUPS'
    const author = 'RIVER SAMPLE'
    const nextLine = 'The rest of the proof gives a construction with a fixed interval.'
    const pages = [
      [
        item(head, 151, 634, 298, 10, 'Title', true),
        item(tail, 273, 620, 54, 10, 'Title'),
        item('', 265, 590, 0, 0, 'Author', true),
        item(author, 265, 590, 70, 8, 'Author'),
        item('', 160, 563, 0, 0, 'Abstract', true),
        item('Abstract.', 160, 563, 39, 8, 'Abstract'),
        item(
          'We compare discrete sample groups for several independent observations.',
          202,
          563,
          238,
          8,
          'Body',
          true
        )
      ],
      [
        item('2', 124, 690, 5, 7, 'Running'),
        item('R. SAMPLE', 274, 690, 52, 7, 'Running'),
        item('', 124, 666, 0, 0, 'Body', true),
        item(nextLine, 124, 666, 352, 10, 'Body', true)
      ],
      [
        item(
          matching ? 'METHOD DISCRETE SAMPLE GROUPS' : 'METHOD DISCRETE SAMPLE SETS',
          218,
          690,
          164,
          7,
          'Running'
        ),
        item('3', 471, 690, 5, 7, 'Running'),
        item('', 124, 666, 0, 0, 'Body', true),
        item(nextLine, 124, 666, 352, 10, 'Body', true)
      ]
    ].map((items, page) => ({ page: page + 1, width: 600, height: 792, rotation: 0, items }))
    const { units } = groupPdfTranslationPages({ pages })
    expect(units[0].source).toBe(matching ? head + ' ' + tail : head)
    expect(units[0].items).toEqual(matching ? ['1:0', '1:1'] : ['1:0'])
    expect(units[1].source).toBe(matching ? author : tail)
  }
)
