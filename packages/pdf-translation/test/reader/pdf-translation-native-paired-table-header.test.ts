import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'
const word = (
  str: string,
  x: number,
  y: number,
  width: number,
  eol = false,
  face = 'header'
): PdfLayoutTextItem => ({
  str,
  width,
  height: 10,
  dir: 'ltr',
  transform: [10, 0, 0, 10, x, y],
  fontName: face,
  fontFamily: 'serif',
  fontAscent: 0.8,
  fontDescent: -0.2,
  fontVertical: false,
  hasEOL: eol
})
const blank = (): PdfLayoutTextItem => ({
  str: '',
  width: 0,
  height: 0,
  dir: 'ltr',
  transform: [0, 0, 0, 0, 0, 0],
  hasEOL: true
})
it.each([0, 6])(
  'separates neighboring three-row headers using their own numeric columns (%s)',
  (offset) => {
    const part = (str: string, x: number, y: number, width: number): PdfLayoutTextItem => ({
      ...word(str, x, y, width),
      height: 12,
      transform: [12, 0, 0, 12, x, y]
    })
    const items = [
      part('Spacing between', 73.6, 752.4, 84.8),
      part('three', 107, 738.6, 18),
      part('reference rods (m)', 74, 724.8, 84),
      part('Trigger delay', 168.6, 752.4, 64.8),
      part('between', 181, 738.6, 40),
      part('three pulses (s)', 169, 724.8, 64),
      part('0.120', 102.5 + offset, 686.3, 27),
      part('1.10', 190.6, 704.7, 21),
      part('0.0410', 255.4, 704.7, 33),
      part('0.130', 102.5 + offset, 627.8, 27),
      part('1.12', 190.6, 509.7, 21),
      part('0.0412', 255.4, 509.7, 33),
      part('1.08', 190.6, 490.3, 21),
      part('0.0409', 255.4, 490.3, 33),
      part('0.140', 102.5 + offset, 452.2, 27)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }]
    })
    const left = units.find((unit) => unit.items.includes('1:0'))
    const right = units.find((unit) => unit.items.includes('1:3'))
    if (offset) {
      expect(left).toBe(right)
    } else {
      expect(left?.items).toEqual(['1:0', '1:1', '1:2'])
      expect(right?.items).toEqual(['1:3', '1:4', '1:5'])
      expect(left?.source).toBe('Spacing between three reference rods (m)')
      expect(right?.source).toBe('Trigger delay between three pulses (s)')
    }
    expect(units.find((unit) => unit.items.includes('1:7'))?.preserve).toBe('literal')
  }
)

it.each([0, 6])(
  'keeps a stacked measurement heading together on a proven table rail (%s)',
  (offset) => {
    const part = (
      str: string,
      x: number,
      y: number,
      width: number,
      size = 12,
      face = 'header'
    ): PdfLayoutTextItem => ({
      ...word(str, x, y, width, false, face),
      height: size,
      transform: [size, 0, 0, size, x, y]
    })
    const items = [
      part('Change in outlet flow when', 304.5, 579, 108),
      part('the valve rotates and', 314.5, 563, 88),
      part('the probe remains', 308, 547, 101),
      part('within the duct,', 303, 531, 67.5),
      part('Q', 373.5, 531, 7.3, 12, 'variable'),
      part('2', 380.8, 530.1, 4, 8, 'variable'),
      part('(Lpm)', 388, 531, 26),
      part('setting', 425, 547, 49),
      ...[511, 487.5, 461].flatMap((y, row) =>
        [87, 164, 336 + offset, 442].map((x, column) =>
          part(`${270 + row * 7 + column}.81`, x, y, column === 3 ? 27 : 45)
        )
      )
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const head = units.find((unit) => unit.items.includes('1:0'))
    expect(head?.items).toEqual(
      offset ? ['1:0'] : ['1:0', '1:1', '1:2', '1:3', '1:4', '1:5', '1:6']
    )
    if (!offset)
      expect(head?.source).toBe(
        'Change in outlet flow when the valve rotates and the probe remains within the duct, Q2 (Lpm)'
      )
    expect(units.find((unit) => unit.items.includes('1:7'))?.source).toBe('setting')
  }
)

const fixture = (): { pageCount: number; pages: PdfLayoutPage[] } => ({
  pageCount: 1,
  pages: [
    {
      page: 1,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        word('Kind', 40, 600, 20),
        blank(),
        word('Kernel/', 100, 606, 30, true),
        word('step', 105, 594, 20),
        blank(),
        word('Output', 160, 606, 30, true),
        word('shape', 162.5, 594, 25),
        blank(),
        word('Depth', 220, 600, 25),
        blank(),
        ...[580, 566, 552, 538].flatMap((y, i) => [
          word(['convolve', 'pool', 'convolve', 'pool'][i], 40, y, 40),
          word('3×3/2', 102.5, y, 25, false, 'math'),
          word('64×64', 160, y, 30, false, 'math'),
          word(String(i + 1), 230, y, 5),
          blank()
        ])
      ]
    }
  ]
})
const controls: [string, (r: ReturnType<typeof fixture>) => void][] = [
  ['rotated first label', (r) => (r.pages[0].items[0].transform[1] = 1)],
  ['invalid next width', (r) => (r.pages[0].items[8].width = NaN)],
  ['negative header scale', (r) => (r.pages[0].items[2].transform[0] = -10)],
  ['missing pair', (r) => (r.pages[0].items[5].str = '')],
  ['missing EOL', (r) => (r.pages[0].items[2].hasEOL = false)],
  ['foreign face', (r) => (r.pages[0].items[3].fontName = 'foreign')],
  ['rotated header', (r) => (r.pages[0].items[2].transform[1] = 1)],
  ['skewed lower header', (r) => (r.pages[0].items[6].transform[2] = 1)],
  ['asymmetric header', (r) => (r.pages[0].items[3].transform[5] -= 2)],
  ['off-center header', (r) => (r.pages[0].items[6].transform[4] += 4)],
  ['foreign native interval', (r) => r.pages[0].items.splice(4, 0, word('foreign', 135, 600, 20))],
  ['insufficient rows', (r) => r.pages[0].items.splice(20)],
  [
    'body prose',
    (r) => {
      for (let i = 11; i < r.pages[0].items.length; i += 5) r.pages[0].items[i].str = 'prose'
    }
  ],
  [
    'drifting value rail',
    (r) => {
      for (let i = 12; i < r.pages[0].items.length; i += 5) r.pages[0].items[i].transform[4] += 8
    }
  ],
  [
    'rotated body',
    (r) => {
      for (let i = 11; i < r.pages[0].items.length; i += 5) r.pages[0].items[i].transform[1] = 1
    }
  ]
]
it('bounds first-label capacity before two proved paired headers', () => {
  const owner = groupPdfTranslationPages(fixture()).units.find((unit) => unit.source === 'Kind')!
  expect(owner.items).toEqual(['1:0'])
  expect(owner.originalStrings).toEqual(['Kind'])
  expect(owner.fragments[0].rect).toEqual({ x: 40, y: 191.5, right: 90, bottom: 202.5, font: 10 })
})
for (const [name, mutate] of controls)
  it(`requires closed native header proof: ${name}`, () => {
    const raw = fixture()
    mutate(raw)
    const owner = groupPdfTranslationPages(raw).units.find((unit) => unit.source === 'Kind')!
    expect(owner.fragments[0].rect.right).toBe(
      name === 'rotated first label' ? 60 : name === 'foreign native interval' ? 125 : 210
    )
  })

it.each(['aligned', 'shifted scores', 'independent values'])(
  'keeps compact metric headers on their individual rails (%s)',
  (shape) => {
    const names = ['Group', 'Method', 'Near-hit', 'Far-hit']
    const header = names.map((name, index) =>
      word(name, [70, 120, 220, 260][index], 600, [28, 30, 32, 34][index])
    )
    const rows = [583, 565.5, 554.25].flatMap((y, index) => [
      ...(index === 0 ? [word('Sample', 70, y, 32, false, 'metrics')] : []),
      word(
        index === 0 && shape !== 'independent values' ? 'Sample' : 'Probe',
        120,
        y,
        38,
        false,
        'metrics'
      ),
      word(['15.5', '19.9', '40.0'][index], 230, y, 12, false, 'metrics'),
      word(
        ['16.2', '26.3', '41.1'][index],
        271 + (index > 0 && shape === 'shifted scores' ? 5 : 0),
        y,
        12,
        true,
        'metrics'
      )
    ])
    const other = word(
      'The adjacent explanation concerns a separate experiment.',
      320,
      600,
      240,
      true,
      'prose'
    )
    other.transform[0] = other.transform[3] = other.height = 11.25
    const items = [...header, blank(), ...rows, other]
    const { units, pages } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
    })
    const headerCells = pages[0].blocks
      .filter((block) => block.tableCell && block.items.some((id) => /^1:[0-3]$/.test(id)))
      .map((block) => block.source)
    expect(headerCells).toEqual(
      shape === 'aligned' ? names : shape === 'shifted scores' ? [] : ['Method', 'Near-hit Far-hit']
    )
    expect(units.find((unit) => unit.source === other.str)?.items).toHaveLength(1)
    for (const index of [7, 8, 10, 11, 13, 14]) {
      const key = '1:' + index
      const owner = units.find((unit) => unit.items.includes(key))
      expect(owner?.sourceOnly, key).toBe(true)
    }
  }
)
