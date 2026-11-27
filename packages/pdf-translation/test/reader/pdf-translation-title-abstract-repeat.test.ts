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

it.each([true, false])('joins a one-word tail after two grouped title rows (%s)', (witness) => {
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
    fontAscent: 0.7,
    fontDescent: -0.2,
    fontVertical: false
  })
  const title = [
    'A PRACTICAL ERROR BOUND FOR ESTIMATORS',
    'UNDER WEIGHTED AND REGULARIZED',
    'MODELS'
  ]
  const author = 'RIVER SAMPLE'
  const pages = [
    [
      item(title[0], 125, 665, 350, 11, 'Title', true),
      item(title[1], 114, 651, 372, 11, 'Title', true),
      item(title[2], 275, 637, 50, 11, 'Title'),
      item('', 255, 607, 0, 0, 'Author', true),
      item(author, 255, 607, 90, 9, 'Author'),
      item('', 128, 578, 0, 0, 'Abstract', true),
      item('Abstract.', 128, 578, 44, 9, 'Abstract'),
      item(
        witness
          ? 'We compare a weighted model with several independent approximations.'
          : 'We compare a baseline model with several independent approximations.',
        176,
        578,
        299,
        9,
        'Author',
        true
      )
    ],
    [
      item('2', 86, 720, 5, 8, 'Running'),
      item(author, 262, 720, 76, 8, 'Running'),
      item('', 86, 692, 0, 0, 'Body', true),
      item('The remaining derivation appears below.', 86, 692, 275, 11, 'Body', true)
    ]
  ].map((items, index) => ({ page: index + 1, width: 600, height: 792, rotation: 0, items }))
  const { units } = groupPdfTranslationPages({ pages })
  expect(units[0].source).toBe(title.slice(0, witness ? 3 : 2).join(' '))
  expect(units[0].items).toEqual(witness ? ['1:0', '1:1', '1:2'] : ['1:0', '1:1'])
  expect(units[0].fragments).toHaveLength(witness ? 2 : 1)
  expect(units[witness ? 1 : 2].source).toBe(author)
})

it.each(['centered', 'off-center', 'unconfirmed'] as const)(
  'joins a short title continuation above a dated author block (%s)',
  (shape) => {
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
      fontFamily: 'serif',
      fontAscent: 0.85,
      fontDescent: -0.22,
      fontVertical: false,
      hasEOL
    })
    const lead = 'Measuring signals using phase contrast'
    const tail = 'in a compact instrument'
    const items = [
      item(lead, 184, 730, 248, 12, 'Title', true),
      item(tail, shape === 'off-center' ? 238 : 234, 716, 148, 12, 'Title'),
      item('', 182, 692, 0, 10, 'Body', true),
      item('A. Example,', 182, 692, 83),
      item('1', 265, 695.6, 4, 7, 'Sup'),
      item('B. Scholar,', 274, 692, 155),
      item('2', 430, 695.6, 4, 7, 'Sup'),
      item('', 204, 679, 0, 10, 'Body', true),
      item('C. Author,', 204, 679, 72),
      item('1', 276, 682.6, 4, 7, 'Sup'),
      item('D. Writer', 286, 679, 120),
      item('2', 406, 682.6, 4, 7, 'Sup'),
      item('', 147, 672, 0, 6, 'Sup', true),
      item('1', 147, 672, 4, 6, 'Sup'),
      item('First Institute of Experimental Studies', 153, 668, 316, 9, 'Italic'),
      item('', 118, 662, 0, 6, 'Sup', true),
      item('2', 118, 662, 4, 6, 'Sup'),
      item('Second Department of Applied Measurements', 124, 658, 374, 9, 'Italic'),
      item('', 254, 647, 0, 9, 'Summary', true),
      item('(Dated: May 4, 2020)', 254, 647, 108, 9, 'Summary', true),
      item(
        shape === 'unconfirmed'
          ? 'We measure each signal repeatedly under comparable conditions.'
          : 'We measure the phase contrast of repeated signals under comparable conditions.',
        119,
        630,
        388,
        9,
        'Summary',
        true
      ),
      item('PACS numbers: 01.23Ab, 45.67Cd, 89.10.Ef', 108, 536, 160, 8, 'Meta')
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })

    if (shape === 'centered') {
      expect(units[0]).toMatchObject({ source: lead + ' ' + tail, items: ['1:0', '1:1'] })
    } else {
      expect(units.slice(0, 2)).toMatchObject([{ source: lead }, { source: tail }])
    }
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.flatMap((item, index) => (item.str ? [`1:${index}`] : [])).sort()
    )
  }
)

it.each([true, false])(
  'joins cover rows when the running title repeats their subject (%s)',
  (matches) => {
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
    const lead = 'A CRITERION FOR FAMILIES WITH AN'
    const opener = lead + ' ℓ-CHAIN CROSSING'
    const tail = 'ADJACENT TRACKS: A DIRECT METHOD'
    const cover = [
      item(lead, 105, 743, 235, 11, 'Title'),
      item(' ', 340, 743, 5, 0, 'Title'),
      item('ℓ', 345, 743, 4, 11, 'Math'),
      item('-CHAIN CROSSING', 349, 743, 146, 11, 'Title', true),
      item(tail, 150, 729, 300, 11, 'Title'),
      item('', 90, 699, 0, 0, 'Author', true),
      item('ALEX RIVER, DREW HILL,', 90, 699, 420, 9, 'Author', true),
      item('AND SKY BROOK', 240, 688, 120, 9, 'Author'),
      item('', 94, 660, 0, 0, 'Abstract', true),
      item('Abstract.', 94, 660, 44, 9, 'Abstract'),
      item(
        'We provide a new criterion for separating two classes.',
        142,
        660,
        362,
        9,
        'Author',
        true
      )
    ]
    const runningTitle = (subject: string, folio: string): PdfLayoutTextItem[] => [
      item('FAMILIES WITH AN', 140, 800, 90, 8, 'Running'),
      item('ℓ', 234, 800, 4, 8, 'RunningMath'),
      item('-CHAIN CROSSING ' + subject + ' TRACKS', 238, 800, 222, 8, 'Running'),
      item(folio, 536, 800, 4, 8, 'Running')
    ]
    const runningAuthor = (folio: string): PdfLayoutTextItem[] => [
      item(folio, 58, 800, 4, 8, 'Running'),
      item('A. RIVER, D. HILL, AND S. BROOK', 142, 800, 316, 8, 'Running')
    ]
    const body = [
      item('', 58, 776, 0, 0, 'Body', true),
      item('This paragraph proves the claim from the sample.', 58, 776, 480, 11, 'Body', true)
    ]
    const rows = [
      cover,
      [...runningAuthor('2'), ...body],
      [...runningTitle('ADJACENT', '3'), ...body],
      [...runningAuthor('4'), ...body],
      [...runningTitle(matches ? 'ADJACENT' : 'DISTANT', '5'), ...body]
    ]
    const pages = rows.map((items, i) => ({
      page: i + 1,
      width: 600,
      height: 840,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages })
    expect(units[0].source).toBe(matches ? opener + ' ' + tail : opener)
    expect(units[0].items).toEqual(matches ? ['1:0', '1:2', '1:3', '1:4'] : ['1:0', '1:2', '1:3'])
    expect(units[0].fragments).toHaveLength(matches ? 2 : 1)
    expect(units[1].source).toBe(matches ? 'ALEX RIVER, DREW HILL,' : tail)
  }
)

it.each([true, false])(
  'joins a centered title corroborated by two shortened running titles (%s)',
  (matches) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      size: number,
      fontName: string,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      width,
      height: size,
      fontName,
      transform: [size, 0, 0, size, x, y],
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL
    })
    const first = 'REPEATED PATTERNS IN THE'
    const second = 'RECORDS OF CONTROL MEASUREMENTS'
    const shorter = 'PATTERNS IN THE ' + second
    const cover = [
      item(first, 161, 634, 290, 10, 'Title', true),
      item(second, 181, 620, 250, 10, 'Title'),
      item('', 252, 590, 0, 0, 'Name', true),
      item('A', 252, 590, 7, 8, 'Name'),
      item('´', 259, 592, 4, 8, 'Name'),
      item('DA STONE', 258, 590, 102, 8, 'Name'),
      item('', 161, 563, 0, 0, 'Label', true),
      item('Abstract.', 161, 562, 43, 8, 'Label'),
      item(
        'These records describe measurements from each independent trial.',
        209,
        562,
        240,
        8,
        'Body'
      )
    ]
    const rows = [
      cover,
      ...[2, 3, 4, 5].map((page) => [
        item(
          page % 2 ? (page === 5 && !matches ? 'NOTES ON CONTROL RECORDS' : shorter) : 'ADA STONE',
          141,
          690,
          330,
          7,
          'Running'
        ),
        item(' ', 471, 690, 11, 0, 'Running'),
        item(String(page), 482, 690, 4, 7, 'Running'),
        item('', 140, 666, 0, 0, 'Body', true),
        item('Each group reported measurements at the end of the trial.', 140, 666, 340, 10, 'Body')
      ])
    ]
    const pages = rows.map((items, i) => ({
      page: i + 1,
      width: 612,
      height: 792,
      rotation: 0,
      items
    }))
    const { units } = groupPdfTranslationPages({ pages })
    expect(units[0].source).toBe(matches ? first + ' ' + second : first)
    expect(units[0].items).toEqual(matches ? ['1:0', '1:1'] : ['1:0'])
    expect(units[0].fragments).toHaveLength(matches ? 2 : 1)
    expect(units.find((unit) => unit.items.includes('1:3'))?.source).toContain('STONE')
  }
)

it.each([true, false])(
  'joins a dated title with a mixed-font parameter repeated in the abstract (%s)',
  (confirmed) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 17,
      fontName = 'Title',
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      fontName,
      hasEOL,
      dir: 'ltr',
      transform: [height, 0, 0, height, x, y],
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false
    })
    const head = 'A note on Geometric and Structural Bounds'
    const items = [
      item(head, 155, 706, 280, 17, 'Title', true),
      item('for the', 185, 682, 45),
      item('r', 235, 682, 8, 17, 'MathItalic'),
      item('-Covering Number', 243.5, 682, 161.5),
      item('', 0, 0, 0, 0, 'Break', true),
      item('Dana Reader', 178, 645, 46, 12, 'Byline'),
      item('∗', 224, 649.2, 4.2, 8, 'Mark'),
      item('Nari Sample', 262, 645, 54, 12, 'Byline'),
      item('†', 316, 649.2, 3.7, 8, 'Mark'),
      item('Remy Author', 357, 645, 55, 12, 'Byline'),
      item('∗', 412, 649.2, 4.2, 8, 'Mark'),
      item('', 0, 0, 0, 0, 'Break', true),
      item('April 12, 2024', 262.5, 613, 65, 12, 'Byline'),
      item('Abstract', 273, 554, 44, 10, 'Abstract'),
      item(
        confirmed
          ? 'The r-covering number satisfies a structural bound for this procedure.'
          : 'Our main result gives a structural bound for this procedure.',
        100,
        531,
        390,
        10,
        'Body',
        true
      )
    ]
    const { units } = groupPdfTranslationPages({
      pageCount: 1,
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const suffix = 'for the r-Covering Number'
    expect(units[0].source).toBe(confirmed ? head + ' ' + suffix : head)
    expect(units[0].fragments).toHaveLength(confirmed ? 2 : 1)
    expect(units[confirmed ? 1 : 2].items).toEqual(['1:5', '1:6', '1:7', '1:8', '1:9', '1:10'])
  }
)
