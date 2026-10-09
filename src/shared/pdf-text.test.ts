import { expect, it } from 'vitest'
import { joinPdfTextItems, type PdfTextItem } from './pdf-text'

const item = (str: string, x: number, y: number, height = 10): PdfTextItem => ({
  str,
  width: str.length * height * 0.5,
  height,
  transform: [height, 0, 0, height, x, y]
})

it('honors explicit empty native line ends between paragraph and heading items', () => {
  expect(
    joinPdfTextItems([
      item('A closed paragraph.', 0, 40),
      { str: '', hasEOL: true, width: 0, height: 0 },
      item('1. Introduction', 0, 20),
      { str: '', hasEOL: true },
      item('The next paragraph.', 0, 0)
    ])
  ).toBe('A closed paragraph.\n1. Introduction\nThe next paragraph.')
})

it('retains explicit consecutive line ends without lending geometry to empty items', () => {
  expect(
    joinPdfTextItems([
      item('before', 0, 40),
      { str: '', hasEOL: true },
      { str: '', hasEOL: true },
      item('after', 0, 20),
      { str: '', hasEOL: true }
    ])
  ).toBe('before\n\nafter')
  expect(joinPdfTextItems([{ str: '', hasEOL: true }])).toBe('')
})

it('keeps glyph, style and scientific script runs literal when empty items have no line end', () => {
  const items = [
    item('C', 0, 40),
    { str: '', width: 0, height: 0 },
    item('H', 5, 40),
    item('3', 10, 37, 6),
    item('CN', 13, 40),
    item(' and ', 23, 40),
    item('x', 48, 40),
    item('2', 53, 44, 6)
  ]
  expect(joinPdfTextItems(items)).toBe('CH3CN and x2')
  expect(joinPdfTextItems([item('same', 0, 40), item('line', 25, 40)])).toBe('same line')
})

const nativeFont = (str: string, transform: readonly number[], width: number): PdfTextItem => ({
  str,
  transform,
  width,
  height: transform[3],
  dir: 'ltr',
  hasEOL: false
})

const numericCaptionBoundary = {
  name: 'standalone four-digit axis label',
  previous: nativeFont('2047', [6, 0, 0, 6, 400, 400], 20),
  current: nativeFont('Figure 3: Comparison summary.', [12, 0, 0, 12, 100, 360], 250),
  expected: '2047\nFigure 3: Comparison summary.'
}

const captionBoundaries = [
  {
    name: 'separate panel label',
    previous: nativeFont(
      'Panel Label',
      [5.7913596, 0, 0, 5.7913596, 321.1246072176, 356.4164091632],
      62.10596121444003
    ),
    current: nativeFont('Figure 1:', [9.8330862, 0, 0, 9.9626, 108, 292.795], 41.289128953799995),
    expected: 'Panel Label\nFigure 1:'
  },
  {
    name: 'separate axis label',
    previous: nativeFont(
      'Axis Label',
      [6.104159389584, 0, 0, 6.104159389584, 447.993242478, 668.3863855999999],
      27.902112569788414
    ),
    current: nativeFont('Figure 2:', [9.9626, 0, 0, 9.9626, 108, 580.869], 36.86161999999999),
    expected: 'Axis Label\nFigure 2:'
  },
  {
    name: 'separate legend label',
    previous: nativeFont(
      'Legend Group',
      [3.09177, 0, 0, 3.09177, 453.545327375, 706.8439222562499],
      43.17442489125003
    ),
    current: nativeFont(
      'Figure 3: Caption summary.',
      [9.9426748, 0, 0, 9.9626, 108, 617.407],
      143.75119225840007
    ),
    expected: 'Legend Group\nFigure 3: Caption summary.'
  },
  numericCaptionBoundary
]

it.each(captionBoundaries)(
  'separates a complete native caption after a $name',
  ({ previous, current, expected }) => {
    expect(joinPdfTextItems([previous, current])).toBe(expected)
  }
)

it('keeps unqualified caption boundaries literal', () => {
  const { previous, current } = captionBoundaries[0]
  const rotated = {
    ...previous,
    transform: [
      0,
      previous.height!,
      -previous.height!,
      0,
      previous.transform![4],
      previous.transform![5]
    ]
  }
  const unknown = {
    ...previous,
    transform: [...previous.transform!.slice(0, 4), Number.NaN, previous.transform![5]]
  }
  const incomplete = { ...current, height: current.height! + 1 }
  const noLeftReset = {
    ...current,
    transform: [...current.transform!.slice(0, 4), previous.transform![4], current.transform![5]]
  }
  const ordinaryHeight = current.height! / 1.5
  const ordinaryLabel = {
    ...previous,
    height: ordinaryHeight,
    width: (previous.width! * ordinaryHeight) / previous.height!,
    transform: [
      ordinaryHeight,
      0,
      0,
      ordinaryHeight,
      previous.transform![4],
      previous.transform![5]
    ]
  }
  const nearby = {
    ...current,
    transform: [...current.transform!.slice(0, 5), previous.transform![5] - current.height! * 1.9]
  }
  for (const pair of [
    [rotated, current],
    [unknown, current],
    [previous, incomplete],
    [previous, noLeftReset],
    [ordinaryLabel, current],
    [previous, nearby],
    [previous, { ...current, width: Number.NaN }],
    [previous, { ...current, dir: 'rtl' }]
  ]) {
    expect(joinPdfTextItems(pair)).toBe('Panel LabelFigure 1:')
  }
  expect(joinPdfTextItems([previous, { ...current, str: 'Fig. 1' }])).toBe('Panel LabelFig. 1')
  expect(joinPdfTextItems([{ ...previous, str: 'Panel\u0000 Label' }, current])).toBe(
    'Panel\u0000 LabelFigure 1:'
  )
  expect(
    joinPdfTextItems([previous, { ...current, str: 'Figure 1' }, item(':', 149.3, 292.795)])
  ).toBe('Panel LabelFigure 1:')
})

it.each(['47', '2.047', '2047+', 'A2047'])(
  'keeps an unqualified numeric label literal: %s',
  (str) => {
    const { previous, current } = numericCaptionBoundary
    expect(joinPdfTextItems([{ ...previous, str }, current])).toBe(str + current.str)
  }
)

it('preserves paragraph and cross-column references instead of treating them as captions', () => {
  expect(joinPdfTextItems([item('See below', 108, 520, 6), item('Figure 8:', 450, 300)])).toBe(
    'See belowFigure 8:'
  )
  expect(
    joinPdfTextItems([
      item('The comparison is described elsewhere', 320, 520),
      item('Figure 8:', 108, 480)
    ])
  ).toBe('The comparison is described elsewhereFigure 8:')
  expect(
    joinPdfTextItems([
      item('The comparison is described elsewhere', 108, 100),
      item('Fig. 8.', 450, 700)
    ])
  ).toBe('The comparison is described elsewhereFig. 8.')
})

it.each(['Group Epoch 24', 'Group, Epoch 7'])(
  'separates a complete caption after a short numeric panel label: %s',
  (str) => {
    const previous = nativeFont(str, [6, 0, 0, 6, 400, 400], 65)
    const current = nativeFont('Figure S3: Comparison summary.', [12, 0, 0, 12, 100, 360], 250)
    expect(joinPdfTextItems([previous, current])).toBe(str + '\n' + current.str)
  }
)

it.each([
  'Group Epoch 240',
  'Group2 24',
  'Group Epoch -24',
  'Group Epoch 2.4',
  'Group Epoch 24+',
  'x 24'
])('keeps an unqualified short numeric panel label literal: %s', (str) => {
  const previous = nativeFont(str, [6, 0, 0, 6, 400, 400], 65)
  const current = nativeFont('Figure S3: Comparison summary.', [12, 0, 0, 12, 100, 360], 250)
  expect(joinPdfTextItems([previous, current])).toBe(str + current.str)
})

it('keeps short numeric labels literal when native geometry or the caption is incomplete', () => {
  const previous = nativeFont('Group Epoch 24', [6, 0, 0, 6, 400, 400], 65)
  const current = nativeFont('Figure S3: Comparison summary.', [12, 0, 0, 12, 100, 360], 250)
  for (const pair of [
    [{ ...previous, width: 0 }, current],
    [{ ...previous, dir: 'rtl' }, current],
    [previous, { ...current, str: 'Figure S3 Comparison summary.' }],
    [previous, { ...current, transform: [12, 0, 0, 12, 400, 360] }],
    [previous, { ...current, transform: [12, 0, 0, 12, 100, 380] }],
    [previous, { ...current, height: 6, transform: [6, 0, 0, 6, 100, 360] }]
  ])
    expect(joinPdfTextItems(pair)).toBe(previous.str! + pair[1].str)
})

const completeVariantCaptionBoundaries = [
  {
    name: 'complete abbreviated caption',
    previous: nativeFont(
      'Neighbor Groups',
      [4.52469175, 0, 0, 4.52469175, 364.5469655, 692.825388],
      114.05842963399955
    ),
    current: nativeFont('Fig. 3.', [9.145728, 0, 0, 8.9664, 153, 519.267], 24.858088703999982)
  },
  {
    name: 'complete axis label with a direction marker',
    previous: nativeFont(
      'Metric distance ↓',
      [5.598901, 0, 0, 5.598901, 137.0537397885, 460.7805761388],
      51.61066941800006
    ),
    current: nativeFont('Figure 2:', [8.9664, 0, 0, 8.9664, 72, 339.636], 43.11672768000001)
  }
]

it.each(completeVariantCaptionBoundaries)(
  'separates a distant independent caption for a $name',
  ({ previous, current }) => {
    expect(joinPdfTextItems([previous, current])).toBe(previous.str + '\n' + current.str)
    expect(joinPdfTextItems([{ ...previous, hasEOL: true }, current])).toBe(
      previous.str + '\n' + current.str
    )
  }
)

it.each(completeVariantCaptionBoundaries)(
  'preserves incomplete geometry for a $name',
  ({ previous, current }) => {
    const height = current.height!
    const ordinaryHeight = height / 1.5
    const refused = [
      [
        {
          ...previous,
          transform: [
            0,
            previous.height!,
            -previous.height!,
            0,
            previous.transform![4],
            previous.transform![5]
          ]
        },
        current
      ],
      [{ ...previous, dir: 'rtl' }, current],
      [{ ...previous, width: 0 }, current],
      [
        {
          ...previous,
          height: ordinaryHeight,
          transform: [
            ordinaryHeight,
            0,
            0,
            ordinaryHeight,
            previous.transform![4],
            previous.transform![5]
          ]
        },
        current
      ],
      [
        previous,
        {
          ...current,
          transform: [
            ...current.transform!.slice(0, 4),
            previous.transform![4],
            current.transform![5]
          ]
        }
      ],
      [
        previous,
        {
          ...current,
          transform: [...current.transform!.slice(0, 5), previous.transform![5] - height * 1.9]
        }
      ],
      [previous, { ...current, width: Number.NaN }],
      [previous, { ...current, height: height + 1 }]
    ]
    for (const pair of refused) expect(joinPdfTextItems(pair)).toBe(previous.str! + current.str)
  }
)

it.each(['Fig. 3', 'Fig. 3:', 'Fig 3.', 'Fig. 3.14', 'Fig. III.', 'Figure 3.'])(
  'preserves an incomplete or unqualified abbreviated caption: %s',
  (str) => {
    const { previous, current } = completeVariantCaptionBoundaries[0]
    expect(joinPdfTextItems([previous, { ...current, str }])).toBe(previous.str! + str)
  }
)

it.each([
  'x ↓',
  'distance ↓',
  'Metric 2 ↓',
  'Metric distance ↓↓',
  'Metric distance ↑',
  'Metric distance + ↓',
  'Metric\u0000 distance ↓'
])('preserves an unqualified scientific direction label: %s', (str) => {
  const { previous, current } = completeVariantCaptionBoundaries[1]
  expect(joinPdfTextItems([{ ...previous, str }, current])).toBe(str + current.str)
})

it('keeps split caption fonts and inline abbreviated references in native order', () => {
  const { previous, current } = completeVariantCaptionBoundaries[0]
  expect(
    joinPdfTextItems([previous, { ...current, str: 'Fig. 3' }, item('.', 178, 519.267, 8.9664)])
  ).toBe('Neighbor GroupsFig. 3.')
  expect(joinPdfTextItems([item('See', 20, 400, 6), item('Fig. 3.', 30, 400, 9)])).toBe(
    'SeeFig. 3.'
  )
})
