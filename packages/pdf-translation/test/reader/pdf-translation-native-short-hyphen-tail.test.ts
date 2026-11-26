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
  fontName = 'body'
): PdfLayoutTextItem => ({
  str,
  width,
  height: 10,
  dir: 'ltr',
  transform: [10, 0, 0, 10, x, y],
  fontName,
  fontFamily: 'serif',
  fontAscent: 0.8,
  fontDescent: -0.2,
  fontVertical: false,
  hasEOL: eol
})
const fixture = (): { pageCount: number; pages: PdfLayoutPage[] } => ({
  pageCount: 1,
  pages: [
    {
      page: 1,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        word(
          'The shared baseline gives a stable reference for each observed sample.',
          60,
          660,
          220,
          true
        ),
        word(
          'The preceding ordinary paragraph retains its complete measured body column.',
          60,
          647.6,
          220,
          true
        ),
        word(
          'This complete body line describes a significant improvement for the sample.',
          60,
          635.2,
          220,
          true
        ),
        word('cant (a 300', 60, 622.8, 45),
        word('×', 105, 622.8, 8, false, 'math'),
        word(' ', 113, 622.8, 4, false, 'math'),
        word('speedup). We inspect several repre-', 117, 622.8, 163, true),
        word('sentative samples.', 60, 610.4, 70, true),
        word(
          'Following prose remains a separate paragraph below the native packet.',
          60,
          584,
          220,
          true
        )
      ]
    }
  ]
})
it('closes a native body hyphen tail without acquiring neighboring formula glyphs', () => {
  const raw = fixture(),
    units = groupPdfTranslationPages(raw).units,
    owner = units.find((u) => u.items.includes('1:6'))!
  expect(owner.items).toEqual(['1:6', '1:7'])
  expect(owner.source).toBe('speedup). We inspect several repre-sentative samples.')
  expect(owner.originalStrings).toEqual([raw.pages[0].items[6].str, raw.pages[0].items[7].str])
  expect(owner.fragments).toHaveLength(2)
  for (const [n, fragment] of owner.fragments.entries()) {
    const native = raw.pages[0].items[6 + n]
    expect(fragment.rect.x).toBe(native.transform[4])
    expect(fragment.rect.right).toBeCloseTo(native.transform[4] + native.width)
  }
  expect(units.find((u) => u.items.includes('1:4'))).toMatchObject({
    sourceOnly: true,
    preserve: 'formula'
  })
})
const cases: [string, (r: ReturnType<typeof fixture>) => void][] = [
  ['return rail', (r) => (r.pages[0].items[7].transform[4] += 3)],
  ['body face', (r) => (r.pages[0].items[7].fontName = 'foreign')],
  ['body pitch', (r) => (r.pages[0].items[7].transform[5] -= 8)],
  ['witness face', (r) => (r.pages[0].items[1].fontName = 'foreign')],
  ['witness right edge', (r) => (r.pages[0].items[1].width -= 5)],
  ['native end of line', (r) => (r.pages[0].items[6].hasEOL = false)],
  [
    'foreign overlapping glyph',
    (r) => r.pages[0].items.push(word('×', 230, 622.8, 30, false, 'math'))
  ],
  ['uppercase new sentence', (r) => (r.pages[0].items[7].str = 'Sentative samples.')],
  ['rotated tail', (r) => (r.pages[0].items[7].transform[1] = 1)],
  ['negative scale', (r) => (r.pages[0].items[6].transform[0] = -10)],
  ['invalid metric', (r) => (r.pages[0].items[6].fontAscent = NaN)],
  ['mathematical prefix collision', (r) => (r.pages[0].items[4].width += 8)]
]
for (const [name, mutate] of cases)
  it(`requires native body evidence: ${name}`, () => {
    const r = fixture()
    mutate(r)
    const items = r.pages[0].items,
      head = items.findIndex((i) => i.str.includes('repre-')),
      tail = items.findIndex((i) => i.str.endsWith('samples.'))
    const units = groupPdfTranslationPages(r).units
    expect(units.some((u) => u.items.includes(`1:${head}`) && u.items.includes(`1:${tail}`))).toBe(
      false
    )
  })

type EquationRun = [
  text: string,
  x: number,
  y: number,
  width: number,
  face?: 'math' | 'symbol' | 'italic' | 'script' | 'mark',
  end?: boolean
]
const equation = ([str, x, y, width, face, end = false]: EquationRun): PdfLayoutTextItem => {
  const h = face === 'script' ? 7 : 10
  const metrics = {
    math: [0, -0.207],
    symbol: [0, 0],
    italic: [0.668, -0.206],
    script: [0.668, -0.206],
    mark: [0.056, -0.438]
  }
  const [fontAscent, fontDescent] = face ? metrics[face] : [0.675, -0.218]
  return {
    ...word(str, x, y, width, end, face ?? 'body'),
    height: h,
    transform: [h, 0, 0, h, x, y],
    fontAscent,
    fontDescent
  }
}

const displayRows: EquationRun[] = [
  ['t', 180.41, 306.503, 2.77, 'italic'],
  [') in the previous sample', 208.781, 306.503, 83.184, undefined, true],
  ['window, the comparison gives precisely', 36.85, 295.544, 138.361, undefined, true],
  [')', 166.178, 275.4, 3.318],
  ['\x03', 169.493, 282.234, 3.317, 'mark'],
  ['+', 55.976, 259.347, 6.336, 'symbol'],
  [
    'When the spacing is small relative to the scale of sensor calibra-',
    36.382,
    239.82,
    257.251,
    undefined,
    true
  ],
  ['tion,', 36.85, 228.861, 17.992],
  ['∇', 36.85, 208.175, 6.615, 'math'],
  ['Ψ', 43.465, 208.175, 7.283, 'symbol'],
  ['(', 56.282, 208.175, 3.318],
  ['+', 66.185, 208.175, 6.336, 'symbol'],
  [',', 79.774, 208.175, 2.491, 'math'],
  [')', 86.877, 208.175, 3.318],
  ['− ∇', 92.406, 208.175, 15.163, 'math'],
  ['Ψ', 107.569, 208.175, 7.283, 'symbol'],
  ['(', 120.39, 208.175, 3.318],
  ['t', 132.236, 208.175, 2.77, 'italic'],
  ['=', 141.262, 208.175, 6.336, 'symbol']
]
const conditionalRows: EquationRun[] = [
  ['The result is stable. If', 302.998, 717.041, 110.165],
  ['μ', 416.592, 717.041, 5.33, 'math'],
  ['i', 421.922, 715.547, 1.939, 'script'],
  ['> ω', 428.86, 717.041, 17.724, 'math'],
  ['2', 446.582, 720.658, 3.487, 'script'],
  ['Λ', 446.582, 713.761, 5.035, 'symbol'],
  [', the signal in that orienta-', 452.116, 717.041, 107.97, undefined, true],
  ['tion remains stable. If', 303.307, 704.482, 84.587],
  ['μ', 390.852, 704.482, 5.33, 'math'],
  ['i', 396.182, 702.988, 1.939, 'script'],
  ['< ω', 402.26, 704.482, 16.857, 'math'],
  ['2', 419.122, 708.099, 3.487, 'script'],
  ['Λ', 419.122, 701.202, 5.035, 'symbol'],
  [
    'Every orientation yields the same response in the independent trial.',
    303.307,
    682.565,
    255.113,
    undefined,
    true
  ]
]

it.each([
  ['display', displayRows, 'sensor calibration,'],
  ['conditional', conditionalRows, 'that orientation remains']
] as const)('repairs a native word across an equation row: %s', (kind, rows, joined) => {
  const items = rows.map(equation),
    input = { pageCount: 1, pages: [{ page: 1, width: 595, height: 842, rotation: 0, items }] },
    head = items.findIndex((item) => /(?:calibra|orienta)-$/u.test(item.str)),
    keys = [`1:${head}`, `1:${head + 1}`]
  const owner = groupPdfTranslationPages(input).units.find((u) => u.items.includes(keys[0]))
  expect(owner?.source).toContain(joined)
  expect(owner?.items).toEqual(keys)
  expect(owner?.fragments).toHaveLength(2)
  if (kind === 'conditional') items[head + 4].str = '> ω'
  else items[head + 1].transform[5] -= 4
  expect(
    groupPdfTranslationPages(input).units.some((u) => keys.every((key) => u.items.includes(key)))
  ).toBe(false)
})
