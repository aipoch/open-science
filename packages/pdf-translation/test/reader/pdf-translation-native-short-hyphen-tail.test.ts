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
