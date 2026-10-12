import { expect, it } from 'vitest'
import { joinPdfTextItems, type PdfTextItem } from './pdf-text'

it('separates an independently placed pair of small centered labels from closed prose', () => {
  const prose = {
    str: 'A complete preceding line describes the general process.',
    width: 300,
    height: 10,
    transform: [10, 0, 0, 10, 100, 610],
    hasEOL: true
  }
  const tail = {
    ...prose,
    str: 'The final stage produces the complete result of the process.',
    width: 290,
    transform: [10, 0, 0, 10, 100, 598],
    hasEOL: false
  }
  const label = { str: 'Source', width: 18, height: 5, transform: [5, 0, 0, 5, 230, 520] }
  const next = { ...label, str: 'data', width: 12, transform: [5, 0, 0, 5, 233, 514] }
  const items = [prose, tail, label, { str: '', hasEOL: true }, next]
  expect(joinPdfTextItems(items)).toContain('process.\nSource\ndata')
  for (const changed of [
    { ...label, width: -18 },
    { ...label, transform: [5, 0, 0, 5, 230, 597] },
    { ...label, transform: [0, 5, -5, 0, 230, 520] }
  ])
    expect(joinPdfTextItems([prose, tail, changed, items[3], next])).toContain('process.Source')
  expect(joinPdfTextItems([prose, tail, label])).toContain('process.Source')
})

it('separates a detached figure label band from the final author affiliation line', () => {
  const items: PdfTextItem[] = [
    {
      str: 'A paper title',
      width: 100,
      height: 17,
      transform: [17, 0, 0, 17, 52, 680],
      hasEOL: true
    },
    { str: '', hasEOL: true },
    {
      str: 'WRITER ONE,',
      width: 72,
      height: 12,
      transform: [12, 0, 0, 12, 52, 630],
      hasEOL: false
    },
    { str: ' ', width: 3, height: 0, transform: [12, 0, 0, 12, 124, 630] },
    {
      str: 'Research Group, Example City',
      width: 160,
      height: 10,
      transform: [10, 0, 0, 10, 127, 630],
      hasEOL: false
    },
    { str: 'Move', width: 22, height: 9, transform: [9, 0, 0, 9, 96, 460] },
    { str: ' ', width: 66, height: 0, transform: [9, 0, 0, 9, 118, 460] },
    { str: 'Trap', width: 17, height: 9, transform: [9, 0, 0, 9, 160, 461] },
    { str: ' ', width: 189, height: 0, transform: [9, 0, 0, 9, 177, 461] },
    { str: 'Dribble', width: 29, height: 9, transform: [9, 0, 0, 9, 296, 461] },
    { str: ' ', width: 204, height: 0, transform: [9, 0, 0, 9, 325, 461] },
    { str: 'Kick', width: 16, height: 9, transform: [9, 0, 0, 9, 452, 461] },
    { str: '', hasEOL: true }
  ]
  expect(joinPdfTextItems(items)).toContain('Example City\nMove Trap Dribble Kick')
  expect(joinPdfTextItems(items)).not.toContain('Example CityMove')
})

it('keeps an open same-line panel label band attached to following prose', () => {
  const items: PdfTextItem[] = [
    { str: 'coordinate system.', width: 69, height: 9, transform: [9, 0, 0, 9, 51, 101] },
    { str: 'Reference', width: 33, height: 7.5, transform: [7.5, 0, 0, 7.5, 412, 677] },
    { str: 'Goal', width: 15, height: 7.5, transform: [7.5, 0, 0, 7.5, 460, 677] },
    { str: 'Latent', width: 21, height: 7.5, transform: [7.5, 0, 0, 7.5, 500, 677] },
    { str: 'prose', width: 30, height: 7.5, transform: [7.5, 0, 0, 7.5, 550, 677] }
  ]
  expect(joinPdfTextItems(items)).not.toContain('system.\nReference')
})

it.each([
  [
    'panel prefix',
    [
      { str: 'Appendix B.', width: 45, height: 9, transform: [9, 0, 0, 9, 51, 103] },
      {
        str: '(a) STI Buffer Construction',
        width: 95,
        height: 7.4,
        transform: [7.4, 0, 0, 7.4, 335, 702]
      },
      { str: '', hasEOL: true },
      {
        str: '(b) Dribble Policy Training with STI',
        width: 124,
        height: 7.4,
        transform: [7.4, 0, 0, 7.4, 335, 622]
      },
      { str: '', hasEOL: true }
    ]
  ],
  [
    'short panel labels',
    [
      { str: 'coordinate system.', width: 69, height: 9, transform: [9, 0, 0, 9, 51, 101] },
      { str: 'Reference', width: 33, height: 7.5, transform: [7.5, 0, 0, 7.5, 412, 677] },
      { str: '', hasEOL: true },
      { str: 'Goal', width: 15, height: 7.5, transform: [7.5, 0, 0, 7.5, 421, 668] },
      { str: '', hasEOL: true },
      { str: 'Reference', width: 33, height: 7.5, transform: [7.5, 0, 0, 7.5, 452, 677] },
      { str: '', hasEOL: true },
      { str: 'Latent', width: 21, height: 7.5, transform: [7.5, 0, 0, 7.5, 458, 668] },
      { str: '', hasEOL: true }
    ]
  ]
])('separates cross-column figure panel labels from narrative text: %s', (_name, items) => {
  const typed = items as PdfTextItem[]
  expect(joinPdfTextItems(typed)).toContain(`${typed[0].str}\n${typed[1].str}`)
  expect(joinPdfTextItems(typed)).not.toContain(`${typed[0].str}${typed[1].str}`)
})

it.each([
  [
    'unclosed label band',
    [
      { str: 'Narrative paragraph', width: 120, height: 10, transform: [10, 0, 0, 10, 52, 630] },
      { str: 'Move', width: 22, height: 9, transform: [9, 0, 0, 9, 96, 460] },
      { str: 'Trap', width: 17, height: 9, transform: [9, 0, 0, 9, 160, 461] }
    ]
  ],
  [
    'invalid label geometry',
    [
      { str: 'WRITER ONE,', width: 72, height: 12, transform: [12, 0, 0, 12, 52, 630] },
      {
        str: ', Research Group, Example City',
        width: 145,
        height: 10,
        transform: [10, 0, 0, 10, 127, 630]
      },
      { str: 'Move', width: -22, height: 9, transform: [9, 0, 0, 9, 96, 460] },
      { str: 'Trap', width: 17, height: 9, transform: [9, 0, 0, 9, 160, 461] },
      { str: 'Dribble', width: 29, height: 9, transform: [9, 0, 0, 9, 296, 461] },
      { str: 'Kick', width: 16, height: 9, transform: [9, 0, 0, 9, 452, 461] },
      { str: '', hasEOL: true }
    ]
  ]
])('does not split a metadata line without a closed valid label band: %s', (_name, raw) => {
  const items = raw as PdfTextItem[]
  expect(joinPdfTextItems(items)).not.toContain('City\nMove')
})

it('separates a skewed run-in heading on a new native paragraph baseline', () => {
  const tail = {
    str: 'The completed paragraph states an independently measured result.',
    width: 300,
    height: 10,
    transform: [10, 0, 0, 10, 60, 540]
  }
  const heading = {
    str: 'Methods.',
    width: 35,
    height: Math.hypot(9.5, 1.5),
    transform: [9.5, 0, 1.5, 9.5, 60, 528]
  }
  const body = {
    str: 'The next paragraph describes another measured observation.',
    width: 420,
    height: 10,
    transform: [10, 0, 0, 10, 99, 528],
    hasEOL: true
  }
  const continuation = {
    ...body,
    str: 'The observation is independently bounded.',
    width: 290,
    transform: [10, 0, 0, 10, 60, 516]
  }
  expect(joinPdfTextItems([tail, heading, { str: ' ' }, body, continuation])).toContain(
    'result.\nMethods. '
  )
  for (const changed of [
    { ...heading, width: -35 },
    { ...heading, transform: [9.5, 0, 1.5, 9.5, 60, 540] },
    { ...heading, transform: [9.5, 0, 1.5, 9.5, 360, 528] },
    { ...heading, transform: [9.5, 2, 1.5, 9.5, 60, 528] }
  ])
    expect(joinPdfTextItems([tail, changed, { str: ' ' }, body, continuation])).toContain(
      'result.Methods.'
    )
  expect(joinPdfTextItems([tail, heading])).toContain('result.Methods.')
})

it('separates a distant period caption below a complete native label band', () => {
  const labels = ['Alpha', 'Beta', '4'].map((str, i) => ({
    str,
    width: 18,
    height: 8,
    transform: [8, 0, 0, 8, 140 + i * 30, 180]
  }))
  const caption = {
    str: 'Figure 2. Independent response across complete groups.',
    width: 280,
    height: 9,
    transform: [9, 0, 0, 9, 100, 130]
  }
  expect(joinPdfTextItems([...labels, caption])).toBe(
    'Alpha Beta 4\nFigure 2. Independent response across complete groups.'
  )
  for (const str of [
    'Figure 2.Independent response across complete groups.',
    'Figure 2 illustrates the complete groups.'
  ])
    expect(joinPdfTextItems([...labels, { ...caption, str }])).toBe('Alpha Beta 4' + str)
  expect(joinPdfTextItems([...labels, { ...caption, transform: [9, 0, 0, 9, 100, 178] }])).toBe(
    'Alpha Beta 4' + caption.str
  )
})

const item = (str: string, x: number, y: number, height = 10): PdfTextItem => ({
  str,
  width: str.length * height * 0.5,
  height,
  transform: [height, 0, 0, height, x, y]
})

const captionAndLabelColumn = (): PdfTextItem[] => [
  { ...item('Figure 2: Comparison across complete groups', 100, 160), hasEOL: true },
  { ...item('with each independent response shown', 100, 148), hasEOL: true },
  item('in the final panel.', 100, 136),
  ...['Alpha', 'Beta', 'Gamma'].map((str, n) => ({
    ...item(str, 150 - str.length * 3.5, 110 - n * 9, 7),
    hasEOL: true
  }))
]

it('separates a complete multiline caption from a closed smaller label column', () => {
  const items = captionAndLabelColumn(),
    before = structuredClone(items)
  expect(joinPdfTextItems(items)).toBe(
    'Figure 2: Comparison across complete groups\nwith each independent response shown\nin the final panel.\nAlpha\nBeta\nGamma'
  )
  expect(items).toEqual(before)
})

it('requires a bounded formal caption and distinct aligned small label column', () => {
  for (const mutation of [
    'prose',
    'unfinished',
    'close',
    'same-font',
    'misaligned',
    'open-label',
    'single-label'
  ]) {
    const items = captionAndLabelColumn()
    if (mutation === 'prose')
      items[0] = { ...items[0], str: 'The comparison across complete groups' }
    if (mutation === 'unfinished') items[2] = { ...items[2], str: 'in the final panel' }
    if (mutation === 'close')
      for (let n = 3; n < items.length; n++)
        items[n] = {
          ...items[n],
          transform: [7, 0, 0, 7, items[n].transform![4], 125 - (n - 3) * 9]
        }
    if (mutation === 'same-font')
      for (let n = 3; n < items.length; n++)
        items[n] = {
          ...items[n],
          height: 10,
          transform: [10, 0, 0, 10, items[n].transform![4], items[n].transform![5]]
        }
    if (mutation === 'misaligned') items[4] = { ...items[4], transform: [7, 0, 0, 7, 180, 101] }
    if (mutation === 'open-label') items[4] = { ...items[4], hasEOL: false }
    if (mutation === 'single-label') items.splice(4)
    expect(joinPdfTextItems(items), mutation).not.toContain(`${items[2].str}\nAlpha`)
  }
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

const labelPlate = (last: PdfTextItem): PdfTextItem[] => [
  nativeFont('First key', [7, 0, 0, 7, 160, 430], 34),
  { str: '', hasEOL: true },
  nativeFont('Second key', [7, 0, 0, 7, 260, 425], 40),
  { str: '', hasEOL: true },
  last
]

it.each(['+1.25', 'Method (trial 2)', 'n = 80', 'η'])(
  'separates a complete descriptive caption from independently positioned native labels: %s',
  (label) => {
    const last = nativeFont(label, [9, 0, 0, 9, 360, 420], 65)
    const caption = nativeFont(
      'Figure 2: Independent comparison results.',
      [10, 0, 0, 10, 100, 380],
      250
    )
    expect(joinPdfTextItems([...labelPlate(last), caption])).toContain(label + '\n' + caption.str)
  }
)

it('binds a native split dotted prefix and small-cap caption runs to the same printed line', () => {
  const last = nativeFont('Method (trial 2)', [9, 0, 0, 9, 360, 420], 65)
  const parts = [
    nativeFont('Fig. 2', [10, 0, 0, 10, 100, 380], 28),
    nativeFont('. ', [10, 0, 0, 10, 128, 380], 5),
    nativeFont('Independent ', [10, 0, 0, 10, 133, 380], 60),
    nativeFont('RESULTS', [8, 0, 0, 8, 193, 380], 32)
  ]
  expect(joinPdfTextItems([...labelPlate(last), ...parts])).toContain(
    last.str + '\nFig. 2. Independent RESULTS'
  )
})

it('uses the entire oriented label envelope before separating a caption', () => {
  const angle = Math.PI / 18
  const last = {
    ...nativeFont(
      'Axis label',
      [
        8 * Math.cos(angle),
        -8 * Math.sin(angle),
        8 * Math.sin(angle),
        8 * Math.cos(angle),
        360,
        420
      ],
      50
    ),
    height: 8
  }
  const caption = nativeFont(
    'Fig. 2: Independent comparison results.',
    [10, 0, 0, 10, 100, 380],
    220
  )
  expect(joinPdfTextItems([...labelPlate(last), caption])).toContain(last.str + '\n' + caption.str)
  const approaching = { ...last, width: 250 }
  expect(joinPdfTextItems([...labelPlate(approaching), caption])).toContain(
    approaching.str! + caption.str
  )
})

it('refuses incomplete captions, unsupported transforms and insufficient independent label evidence', () => {
  const last = nativeFont('Method (trial 2)', [9, 0, 0, 9, 360, 420], 65)
  const caption = nativeFont(
    'Figure 2: Independent comparison results.',
    [10, 0, 0, 10, 100, 380],
    250
  )
  for (const next of [
    { ...caption, str: 'Figure 2: Short' },
    { ...caption, str: 'Figure 2.The results refer to another diagram.' },
    { ...caption, transform: [10, 0, 0, 10, 370, 380] },
    { ...caption, transform: [10, 0, 0, 10, 100, 410] },
    { ...caption, height: 11 }
  ])
    expect(joinPdfTextItems([...labelPlate(last), next])).toContain(last.str! + next.str)
  for (const previous of [
    { ...last, transform: [9, 2, 0, 9, 360, 420] },
    { ...last, transform: [-9, 0, 0, -9, 360, 420] },
    { ...last, width: Number.NaN },
    { ...last, str: 'Method\u0000 (trial 2)' }
  ])
    expect(joinPdfTextItems([...labelPlate(previous), caption])).toContain(
      previous.str! + caption.str
    )
  expect(joinPdfTextItems([last, caption])).toBe(last.str! + caption.str)
  expect(joinPdfTextItems([last, { ...caption, hasEOL: true }])).toBe(last.str! + caption.str)
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

it.each([...'0123456789'])(
  'separates a distant caption after an upright diagram digit: %s',
  (str) => {
    const previous = nativeFont(str, [6, 0, 0, 6, 400, 400], 4)
    const current = nativeFont('Figure 3:', [12, 0, 0, 12, 100, 360], 60)
    expect(joinPdfTextItems([previous, current])).toBe(str + '\n' + current.str)
  }
)

it('preserves digit-caption joins without complete independent native geometry', () => {
  const previous = nativeFont('7', [6, 0, 0, 6, 400, 400], 4)
  const current = nativeFont('Figure 3:', [12, 0, 0, 12, 100, 360], 60)
  const refused = [
    [{ ...previous, transform: [0, 6, -6, 0, 400, 400] }, current],
    [{ ...previous, dir: 'rtl' }, current],
    [{ ...previous, width: Number.NaN }, current],
    [nativeFont('7', [8, 0, 0, 8, 400, 400], 4), current],
    [previous, { ...current, transform: [12, 0, 0, 12, 400, 360] }],
    [previous, { ...current, transform: [12, 0, 0, 12, 100, 380] }],
    [previous, { ...current, height: 13 }],
    [previous, { ...current, str: 'Figure 3' }, nativeFont(':', [12, 0, 0, 12, 160, 360], 3)]
  ]
  for (const items of refused) expect(joinPdfTextItems(items)).toBe('7Figure 3:')
  for (const str of ['-1', '1.2', 'x2', '１２', '²', '7¹'])
    expect(joinPdfTextItems([{ ...previous, str }, current])).toBe(str + current.str)
})

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

const signedLabelCaptionPlate = (angle = 90): PdfTextItem[] => {
  const radians = (angle * Math.PI) / 180,
    a = angle === 90 ? 0 : 6 * Math.cos(radians),
    b = angle === 90 ? 6 : 6 * Math.sin(radians)
  return [
    nativeFont('+1.2', [6, 0, 0, 6, 100, 360], 20),
    { ...nativeFont('−0.4', [a, b, -b, a, 190, 360], 20), height: 6 },
    nativeFont('+0.3', [6, 0, 0, 6, 280, 350], 20),
    nativeFont('Figure 4:', [10, 0, 0, 10, 50, 300], 45),
    nativeFont(' Complete independently measured', [11, 0, 0, 11, 95, 300], 155),
    nativeFont(' comparison.', [10, 0, 0, 10, 250, 300], 60)
  ]
}

const initialIntegerAndClosedTicks = (): PdfTextItem[] => [
  nativeFont('7', [10, 0, 0, 10, 60, 700], 5),
  nativeFont('0', [4, 0, 0, 4, 80, 500], 2),
  { str: ' ' },
  nativeFont('1', [4, 0, 0, 4, 100, 500], 2),
  { str: ' ' },
  nativeFont('2', [4, 0, 0, 4, 120, 500], 2),
  { str: '', hasEOL: true },
  nativeFont('Axis', [6, 0, 0, 6, 90, 480], 12)
]

it('separates an initial solitary integer from a complete independent tick row', () => {
  const items = initialIntegerAndClosedTicks(),
    before = structuredClone(items)
  expect(joinPdfTextItems(items)).toBe('7\n0 1 2\nAxis')
  expect(items).toEqual(before)
  expect(joinPdfTextItems(items).replace(/\s/gu, '')).toBe(
    items
      .map((i) => i.str ?? '')
      .join('')
      .replace(/\s/gu, '')
  )
})

const initialIntegerAndWholeDecimalTicks = (values = ['-0.2', '0', '0.2']): PdfTextItem[] => [
  nativeFont('7', [10, 0, 0, 10, 60, 700], 5),
  ...values.flatMap((str, index) => [
    nativeFont(str, [4, 0, 0, 4, 80 + index * 25, 500], str.length * 2),
    ...(index < values.length - 1 ? [{ str: ' ' }] : [])
  ]),
  { str: '', hasEOL: true }
]

it.each([
  ['-0.2', '0', '0.2'],
  ['0.1', '0.2', '0.3'],
  ['−0.2', '0', '+0.2']
])('separates a closed row of three whole numeric carriers: %j', (...values) => {
  const items = initialIntegerAndWholeDecimalTicks(values),
    before = structuredClone(items),
    actual = joinPdfTextItems(items)
  expect(actual).toBe('7\n' + values.join(' '))
  expect(actual.replace(/\s/gu, '')).toBe(
    items
      .map((i) => i.str ?? '')
      .join('')
      .replace(/\s/gu, '')
  )
  expect(items).toEqual(before)
})

it.each([
  'missing EOL',
  'partial decimal',
  'standalone sign',
  'scientific exponent',
  'unit',
  'shared carrier',
  'foreign peer',
  'wrong font height',
  'raised peer',
  'crossing peer',
  'invalid peer geometry',
  'counter inside band',
  'noninteger counter'
])('keeps an unproved signed tick boundary with %s', (variant) => {
  const items = initialIntegerAndWholeDecimalTicks()
  if (variant === 'missing EOL') items.pop()
  if (variant === 'partial decimal') items[1] = { ...items[1], str: '-0.' }
  if (variant === 'standalone sign') items[1] = { ...items[1], str: '-' }
  if (variant === 'scientific exponent') items[3] = { ...items[3], str: '1e3' }
  if (variant === 'unit') items[3] = { ...items[3], str: '1mm' }
  if (variant === 'shared carrier') items[3] = { ...items[3], str: '0 0.1' }
  if (variant === 'foreign peer') items[3] = { ...items[3], str: 'Label' }
  if (variant === 'wrong font height') items[3] = nativeFont('0', [5, 0, 0, 5, 105, 500], 2)
  if (variant === 'raised peer') items[3] = nativeFont('0', [2, 0, 0, 2, 105, 502], 2)
  if (variant === 'crossing peer') items[3] = nativeFont('0', [4, 0, 0, 4, 82, 500], 2)
  if (variant === 'invalid peer geometry') items[3] = { ...items[3], width: Number.NaN }
  if (variant === 'counter inside band') items[0] = nativeFont('7', [10, 0, 0, 10, 100, 700], 5)
  if (variant === 'noninteger counter') items[0] = { ...items[0], str: '7.0' }
  const before = structuredClone(items),
    expected = joinPdfTextItems(items.slice(0, 1)) + joinPdfTextItems(items.slice(1))
  expect(joinPdfTextItems(items)).toBe(expected)
  expect(items).toEqual(before)
})

it.each([
  'missing line end',
  'two numbers',
  'foreign row glyph',
  'split decimal',
  'rotated last tick',
  'unknown last tick',
  'another initial glyph',
  'repeated initial carrier',
  'nearby baseline',
  'same size integer',
  'overlapping ticks',
  'noninitial integer',
  'short row',
  'foreign whitespace glyph'
])('preserves an unproved initial numeric block with %s', (variant) => {
  const items = initialIntegerAndClosedTicks()
  if (variant === 'missing line end') items[6] = { str: '' }
  if (variant === 'two numbers') items.splice(4, 2)
  if (variant === 'foreign row glyph') items[5] = { ...items[5], str: 'x' }
  if (variant === 'split decimal') items[5] = { ...items[5], str: '.2' }
  if (variant === 'rotated last tick')
    items[5] = { ...items[5], transform: [0, 4, -4, 0, 120, 500] }
  if (variant === 'unknown last tick') items[5] = { ...items[5], width: undefined }
  if (variant === 'another initial glyph')
    items.unshift(nativeFont('n', [10, 0, 0, 10, 40, 700], 5))
  if (variant === 'repeated initial carrier') items.unshift(items[0])
  if (variant === 'nearby baseline') items[0] = nativeFont('7', [10, 0, 0, 10, 60, 525], 5)
  if (variant === 'same size integer') items[0] = nativeFont('7', [4, 0, 0, 4, 60, 700], 5)
  if (variant === 'overlapping ticks') items[5] = nativeFont('2', [4, 0, 0, 4, 100, 500], 2)
  if (variant === 'noninitial integer') items.unshift({ str: 'Earlier text.', hasEOL: true })
  if (variant === 'short row') items[5] = nativeFont('2', [4, 0, 0, 4, 110, 500], 2)
  if (variant === 'foreign whitespace glyph') items[2] = { str: '\u0000' }
  const before = structuredClone(items),
    at = items.findIndex((i) => i.str === '0')
  const actual = joinPdfTextItems(items),
    expected = joinPdfTextItems(items.slice(0, at)) + joinPdfTextItems(items.slice(at))
  expect(actual).toBe(expected)
  expect(items).toEqual(before)
})

const independentNumericBlocks = (header = false): PdfTextItem[] => [
  ...(header ? [nativeFont('8', [10, 0, 0, 10, 30, 700], 5), item(' ', 35, 700)] : []),
  nativeFont(header ? 'Example, et al.' : '−0.73', [10, 0, 0, 10, 250, 700], 70),
  nativeFont('0', [6, 0, 0, 6, 80, 550], 3),
  nativeFont('.', [6, 0, 0, 6, 83, 550], 2),
  nativeFont('19', [6, 0, 0, 6, 85, 550], 6),
  { str: ' ', height: 0, width: 12, transform: [6, 0, 0, 6, 91, 550] },
  nativeFont('10', [6, 0, 0, 6, 115, 550], 6),
  nativeFont('2', [4, 0, 0, 4, 121, 553], 2)
]

it.each([false, true])(
  'separates independent numeric bands while retaining split decimals and powers: %s',
  (header) => {
    const items = independentNumericBlocks(header),
      before = structuredClone(items)
    expect(joinPdfTextItems(items)).toBe((header ? '8 Example, et al.' : '−0.73') + '\n0.19 102')
    expect(items).toEqual(before)
  }
)

it.each([
  'one tick',
  'overlapping columns',
  'nearby line',
  'same size',
  'unknown geometry',
  'control glyph',
  'rotated tick',
  'body sentence'
])('preserves an unproved numeric band boundary with %s', (variant) => {
  let items = independentNumericBlocks(variant === 'body sentence')
  const start = variant === 'body sentence' ? 3 : 1
  if (variant === 'one tick') items = items.slice(0, start + 3)
  if (variant === 'body sentence') items.unshift({ str: 'Earlier paragraph.', hasEOL: true })
  if (variant === 'unknown geometry') items[start] = { ...items[start], width: undefined }
  if (variant === 'control glyph') items[start + 2] = { ...items[start + 2], str: '1\u00002' }
  if (variant === 'rotated tick')
    items[start] = { ...items[start], transform: [0, 6, -6, 0, 80, 550] }
  if (variant === 'same size') items[0] = nativeFont('−0.73', [6, 0, 0, 6, 250, 700], 70)
  if (variant === 'overlapping columns' || variant === 'nearby line')
    items = items.map((i, n) =>
      n < start || !i.transform
        ? i
        : {
            ...i,
            transform: [
              ...i.transform.slice(0, 4),
              i.transform[4] + (variant === 'overlapping columns' ? 180 : 0),
              i.transform[5] + (variant === 'nearby line' ? 130 : 0)
            ]
          }
    )
  const boundary = variant === 'body sentence' ? 4 : start
  expect(joinPdfTextItems(items)).toBe(
    joinPdfTextItems(items.slice(0, boundary)) + joinPdfTextItems(items.slice(boundary))
  )
})

it.each([90, 15])(
  'separates a complete split caption after three whole signed labels including %s-degree text',
  (angle) => {
    const items = signedLabelCaptionPlate(angle),
      before = structuredClone(items),
      labels = joinPdfTextItems(items.slice(0, 3)),
      caption = items
        .slice(3)
        .map((i) => i.str)
        .join(''),
      result = joinPdfTextItems(items)
    expect(result).toBe(labels + '\n' + caption)
    expect(result.replace(/\s/gu, '')).toBe(
      items
        .map((i) => i.str)
        .join('')
        .replace(/\s/gu, '')
    )
    expect(items).toEqual(before)
  }
)

it.each([
  'two carriers',
  'missing carrier geometry',
  'foreign carrier lane',
  'missing previous geometry',
  'incomplete caption description',
  'detached caption font',
  'foreign caption column',
  'inconsistent caption height'
])('keeps a signed-label caption seam literal with %s', (variant) => {
  let items = signedLabelCaptionPlate()
  if (variant === 'two carriers') items = items.slice(1)
  if (variant === 'missing carrier geometry') items[0] = { ...items[0], width: 0 }
  if (variant === 'foreign carrier lane')
    items[0] = { ...items[0], transform: [6, 0, 0, 6, 700, 360] }
  if (variant === 'missing previous geometry') items[2] = { ...items[2], transform: undefined }
  if (variant === 'incomplete caption description')
    items = [...items.slice(0, 4), { ...items[4], str: ' tiny' }]
  if (variant === 'detached caption font')
    items[4] = { ...items[4], transform: [11, 0, 0, 11, 110, 300] }
  if (variant === 'foreign caption column')
    items = items.map((i, n) =>
      n < 3 ? i : { ...i, transform: [...i.transform!.slice(0, 4), i.transform![4] + 450, 300] }
    )
  if (variant === 'inconsistent caption height') items[3] = { ...items[3], height: 9 }
  const at = items.findIndex((i) => i.str === 'Figure 4:'),
    expected = joinPdfTextItems(items.slice(0, at)) + joinPdfTextItems(items.slice(at)),
    before = structuredClone(items)
  expect(joinPdfTextItems(items)).toBe(expected)
  expect(items).toEqual(before)
})

const initialLineAndClosedLabels = (): PdfTextItem[] => [
  nativeFont('Open ', [10, 0, 0, 10, 300, 300], 24),
  nativeFont('Study ', [8, 0, 0, 8, 324, 300], 30),
  nativeFont('Record', [10, 0, 0, 10, 354, 300], 34),
  nativeFont('Bias', [7, 0, 0, 7, 150, 100], 18),
  { str: ' ' },
  nativeFont('Error', [7, 0, 0, 7, 260, 100], 22),
  { str: '', hasEOL: true }
]

it.each(['empty EOL', 'label EOL', 'same initial size'])(
  'separates a complete initial line from independent smaller labels with %s',
  (variant) => {
    const items = initialLineAndClosedLabels()
    if (variant === 'label EOL') {
      items[5] = { ...items[5], hasEOL: true }
      items.pop()
    }
    if (variant === 'same initial size')
      items[1] = nativeFont('Study ', [10, 0, 0, 10, 324, 300], 30)
    const before = structuredClone(items),
      actual = joinPdfTextItems(items)
    expect(actual).toBe('Open Study Record\nBias Error')
    expect(actual.replace(/\s/gu, '')).toBe(
      items
        .map((i) => i.str ?? '')
        .join('')
        .replace(/\s/gu, '')
    )
    expect(items).toEqual(before)
  }
)

it.each([
  'initial EOL',
  'initial whitespace EOL',
  'foreign initial whitespace',
  'invalid prefix font',
  'interleaved prefix',
  'aliased prefix',
  'one initial font',
  'noninitial line',
  'one label',
  'missing closure',
  'foreign band whitespace',
  'same size labels',
  'larger labels',
  'script label',
  'invalid label font',
  'near label band',
  'overlapping labels',
  'numeric labels',
  'parenthesized labels',
  'right-edge crossing',
  'later prefix carrier',
  'later prefix alias',
  'later band carrier',
  'later band alias',
  'unknown later font'
])('respects independent initial-line evidence with %s', (variant) => {
  const items = initialLineAndClosedLabels()
  if (variant === 'initial EOL') items[2] = { ...items[2], hasEOL: true }
  if (variant === 'initial whitespace EOL') items[1] = { str: '', hasEOL: true }
  if (variant === 'foreign initial whitespace') items[1] = { str: '\t' }
  if (variant === 'invalid prefix font') items[1] = { ...items[1], width: Number.NaN }
  if (variant === 'interleaved prefix') items[1] = nativeFont('Study ', [8, 0, 0, 8, 324, 280], 30)
  if (variant === 'aliased prefix') items[1] = items[0]
  if (variant === 'one initial font') {
    items[0] = { str: '' }
    items[1] = { str: '' }
  }
  if (variant === 'one label') items[5] = { str: '' }
  if (variant === 'missing closure') items.pop()
  if (variant === 'foreign band whitespace') items[4] = { str: '\t' }
  if (variant === 'same size labels' || variant === 'larger labels') {
    const size = variant === 'same size labels' ? 10 : 12
    items[3] = nativeFont('Bias', [size, 0, 0, size, 150, 100], 18)
    items[5] = nativeFont('Error', [size, 0, 0, size, 260, 100], 22)
  }
  if (variant === 'script label') items[5] = nativeFont('Error', [4, 0, 0, 4, 260, 100], 22)
  if (variant === 'invalid label font') items[5] = { ...items[5], transform: [] }
  if (variant === 'near label band') {
    items[3] = nativeFont('Bias', [7, 0, 0, 7, 150, 280], 18)
    items[5] = nativeFont('Error', [7, 0, 0, 7, 260, 280], 22)
  }
  if (variant === 'overlapping labels') items[5] = nativeFont('Error', [7, 0, 0, 7, 150, 100], 22)
  if (variant === 'numeric labels') {
    items[3] = { ...items[3], str: '10' }
    items[5] = { ...items[5], str: '5' }
  }
  if (variant === 'parenthesized labels') {
    items[3] = { ...items[3], str: '(a)' }
    items[5] = { ...items[5], str: '(b)' }
  }
  if (variant === 'right-edge crossing') items[5] = nativeFont('Error', [7, 0, 0, 7, 500, 100], 22)
  if (variant === 'later prefix carrier')
    items.push(nativeFont('Extra', [10, 0, 0, 10, 400, 300], 25))
  if (variant === 'later prefix alias') items.push(items[1])
  if (variant === 'later band carrier') items.push(nativeFont('Extra', [7, 0, 0, 7, 300, 100], 25))
  if (variant === 'later band alias') items.push(items[3])
  if (variant === 'unknown later font')
    items.push({ ...nativeFont('Extra', [7, 0, 0, 7, 300, 50], 25), width: Number.NaN })
  let at = 3
  if (variant === 'noninitial line') {
    items.unshift({ str: 'Earlier.', hasEOL: true })
    at++
  }
  const before = structuredClone(items),
    expected =
      joinPdfTextItems(items.slice(0, at)) +
      ([
        'initial EOL',
        'one label',
        'missing closure',
        'same size labels',
        'larger labels',
        'script label',
        'overlapping labels',
        'numeric labels',
        'parenthesized labels',
        'right-edge crossing',
        'later band carrier'
      ].includes(variant)
        ? '\n'
        : '') +
      joinPdfTextItems(items.slice(at))
  expect(joinPdfTextItems(items)).toBe(expected)
  expect(items).toEqual(before)
})

const initialLineAndSingleRun = (): PdfTextItem[] => [
  nativeFont('Open ', [10, 0, 0, 10, 300, 300], 24),
  nativeFont('Study Record', [8, 0, 0, 8, 324, 300], 64),
  nativeFont('Outcome', [12, 0, 0, 12, 150, 100], 30)
]

it.each(['single larger font', 'numeric', 'script', 'supported rotation'])(
  'separates a globally isolated initial line from %s',
  (variant) => {
    const items = initialLineAndSingleRun()
    if (variant === 'numeric') items[2] = { ...items[2], str: '10' }
    if (variant === 'script') items[2] = nativeFont('Outcome', [4, 0, 0, 4, 150, 100], 30)
    if (variant === 'supported rotation')
      items[2] = { ...nativeFont('Outcome', [0, 7, -7, 0, 150, 100], 30), height: 7 }
    const before = structuredClone(items),
      actual = joinPdfTextItems(items)
    expect(actual).toBe('Open Study Record\n' + items[2].str)
    expect(actual.replace(/\s/gu, '')).toBe(
      items
        .map((i) => i.str)
        .join('')
        .replace(/\s/gu, '')
    )
    expect(items).toEqual(before)
  }
)

it.each([
  'highest late font',
  'strict threshold',
  'actual prefix minimum',
  'unknown later font',
  'later alias',
  'unsupported rotation',
  'partial prefix',
  'unsupported initial script',
  'rotated prefix'
])('keeps an unproved whole-page blank band with %s', (variant) => {
  const items = initialLineAndSingleRun()
  if (variant === 'highest late font') items.push(nativeFont('Extra', [7, 0, 0, 7, 500, 280], 20))
  if (variant === 'strict threshold') items[2] = nativeFont('Outcome', [12, 0, 0, 12, 150, 258], 30)
  if (variant === 'actual prefix minimum') {
    items[1] = nativeFont('Study Record', [8, 0, 0, 8, 324, 299.6], 64)
    items[2] = nativeFont('Outcome', [12, 0, 0, 12, 150, 257.8], 30)
  }
  if (variant === 'unknown later font') items[2] = { ...items[2], width: Number.NaN }
  if (variant === 'later alias') items.push(items[2])
  if (variant === 'unsupported rotation')
    items[2] = nativeFont('Outcome', [7, 2, 0, 7, 150, 100], 30)
  if (variant === 'partial prefix')
    items[1] = nativeFont('Study Record', [8, 0, 0, 8, 354, 300], 64)
  if (variant === 'unsupported initial script')
    items[1] = nativeFont('Study Record', [4, 0, 0, 4, 324, 304], 64)
  if (variant === 'rotated prefix')
    items[1] = { ...nativeFont('Study Record', [0, 8, -8, 0, 324, 300], 64), height: 8 }
  const before = structuredClone(items),
    expected = items.map((i) => i.str).join('')
  expect(joinPdfTextItems(items)).toBe(expected)
  expect(items).toEqual(before)
})

it('preserves the closed-label proof after a failed whole-page gap scan', () => {
  const items = initialLineAndClosedLabels()
  items.push(nativeFont('Other', [7, 0, 0, 7, 300, 268], 20))
  const before = structuredClone(items)
  expect(joinPdfTextItems(items)).toBe('Open Study Record\nBias Error\nOther')
  expect(items).toEqual(before)
})

const captionTailAndClosedLabels = (): PdfTextItem[] => [
  nativeFont('Figure 2:', [10, 0, 0, 10, 20, 300], 42),
  { str: ' ' },
  nativeFont('Measured response in two groups', [10, 0, 0, 10, 65, 300], 155),
  nativeFont('Bias', [7, 0, 0, 7, 55, 100], 18),
  { str: ' ' },
  nativeFont('Error', [7, 0, 0, 7, 163, 100], 22),
  { str: '', hasEOL: true }
]

it.each(['empty EOL', 'label EOL', 'prior paragraph', 'existing caption EOL'])(
  'separates a complete caption tail from a closed smaller label band with %s',
  (variant) => {
    const items = captionTailAndClosedLabels()
    if (variant === 'label EOL') {
      items[5] = { ...items[5], hasEOL: true }
      items.pop()
    }
    if (variant === 'prior paragraph') items.unshift({ str: 'Earlier paragraph.', hasEOL: true })
    if (variant === 'existing caption EOL') items[2] = { ...items[2], hasEOL: true }
    const before = structuredClone(items),
      actual = joinPdfTextItems(items)
    expect(actual).toBe(
      (variant === 'prior paragraph' ? 'Earlier paragraph.\n' : '') +
        'Figure 2: Measured response in two groups\nBias Error'
    )
    expect(actual.replace(/\s/gu, '')).toBe(
      items
        .map((i) => i.str ?? '')
        .join('')
        .replace(/\s/gu, '')
    )
    expect(items).toEqual(before)
  }
)

it.each([
  'body prefix',
  'unpunctuated reference',
  'short description',
  'unbounded preceding line',
  'invalid caption width',
  'caption baseline shift',
  'caption overlap',
  'unknown caption script',
  'near label band',
  'same size labels',
  'one label',
  'missing EOL',
  'label punctuation',
  'scientific label',
  'label overlap',
  'label outside caption',
  'label baseline shift',
  'invalid label matrix',
  'invalid label width',
  'rotated label',
  'rtl label',
  'unknown label script',
  'foreign whitespace',
  'aliased caption carrier'
])('respects independent block evidence at a caption tail with %s', (variant) => {
  const items = captionTailAndClosedLabels()
  if (variant === 'body prefix') items[0] = { ...items[0], str: 'Study 2:' }
  if (variant === 'unpunctuated reference') items[0] = { ...items[0], str: 'Figure 2' }
  if (variant === 'short description') items[2] = { ...items[2], str: 'Outcome' }
  if (variant === 'invalid caption width') items[2] = { ...items[2], width: Number.NaN }
  if (variant === 'caption baseline shift')
    items[2] = nativeFont('Measured response in two groups', [10, 0, 0, 10, 65, 302], 155)
  if (variant === 'caption overlap')
    items[2] = nativeFont('Measured response in two groups', [10, 0, 0, 10, 30, 300], 155)
  if (variant === 'unknown caption script')
    items[2] = nativeFont('Measured response in two groups', [4, 0, 0, 4, 65, 300], 155)
  if (variant === 'near label band') {
    items[3] = nativeFont('Bias', [7, 0, 0, 7, 55, 280], 18)
    items[5] = nativeFont('Error', [7, 0, 0, 7, 163, 280], 22)
  }
  if (variant === 'same size labels') {
    items[3] = nativeFont('Bias', [10, 0, 0, 10, 55, 100], 18)
    items[5] = nativeFont('Error', [10, 0, 0, 10, 163, 100], 22)
  }
  if (variant === 'one label') items[5] = { str: '' }
  if (variant === 'missing EOL') items.pop()
  if (variant === 'label punctuation') items[5] = { ...items[5], str: 'Error.' }
  if (variant === 'scientific label') items[5] = { ...items[5], str: '1e3' }
  if (variant === 'label overlap') items[5] = nativeFont('Error', [7, 0, 0, 7, 60, 100], 22)
  if (variant === 'label outside caption')
    items[5] = nativeFont('Error', [7, 0, 0, 7, 300, 100], 22)
  if (variant === 'label baseline shift') items[5] = nativeFont('Error', [7, 0, 0, 7, 163, 102], 22)
  if (variant === 'invalid label matrix') items[5] = { ...items[5], transform: [] }
  if (variant === 'invalid label width') items[5] = { ...items[5], width: Number.NaN }
  if (variant === 'rotated label') items[5] = nativeFont('Error', [0, 7, -7, 0, 163, 100], 22)
  if (variant === 'rtl label') items[5] = { ...items[5], dir: 'rtl' }
  if (variant === 'unknown label script') items[5] = nativeFont('Error', [4, 0, 0, 4, 163, 100], 22)
  if (variant === 'foreign whitespace') items[4] = { str: '\t' }
  if (variant === 'aliased caption carrier') items[1] = items[0]
  let at = 3
  if (variant === 'unbounded preceding line') {
    items.unshift(nativeFont('Continuation ', [10, 0, 0, 10, 0, 300], 20))
    at++
  }
  const before = structuredClone(items),
    expected =
      joinPdfTextItems(items.slice(0, at)) +
      ([
        'body prefix',
        'unpunctuated reference',
        'short description',
        'unbounded preceding line',
        'same size labels',
        'one label',
        'missing EOL',
        'label punctuation',
        'scientific label',
        'label overlap',
        'label outside caption',
        'label baseline shift',
        'unknown label script'
      ].includes(variant)
        ? '\n'
        : '') +
      joinPdfTextItems(items.slice(at))
  expect(joinPdfTextItems(items)).toBe(expected)
  expect(items).toEqual(before)
})
