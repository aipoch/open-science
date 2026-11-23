import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'
const height = 760
const run = (
  str: string,
  x: number,
  y: number,
  width: number,
  hasEOL = false,
  fontName = 'body',
  font = 8
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  dir: 'ltr',
  fontName,
  hasEOL,
  fontFamily: 'serif',
  fontAscent: 0.8,
  fontDescent: -0.2,
  fontVertical: false,
  transform: [font, 0, 0, font, x, height - y]
})
const fixture = (continued = true): Parameters<typeof groupPdfTranslationPages>[0] => ({
  pageCount: 2,
  pages: [1, 2].map((page) => ({
    page,
    width: 600,
    height,
    rotation: 0,
    items: [
      run('Table 7', 175, 59, 33, false, 'caption', 9),
      run(
        page === 2 && continued ? '(continued)' : '. Inventory of bench protocols',
        209,
        59,
        145,
        true,
        'caption',
        9
      ),
      run('Authors', 70, 89, 34),
      run('Signal', 174, 84, 32),
      run('Sampling', 247, 84, 37),
      run('Data', 353, 84, 19),
      run('References', 393, 89, 43, true),
      run('Mode', 182, 97, 24),
      run('Method', 247, 97, 31),
      run('Link', 354, 97, 17, true),
      ...['Absorption', 'Emission', 'Reflection', 'Scattering'].flatMap((mode, i) => {
        const y = 136 + i * 17
        return [
          run(`Trial ${String.fromCharCode(65 + i)}`, 70, y, 46),
          run(mode, 174, y, 42),
          run('FFT', 247, y, 13),
          run('—', 355, y, 8),
          run(`Mori et al. (${2014 + i})`, 393, y, 85, true)
        ]
      }),
      run('Sensors & Sensors', 70, 212, 75),
      run('Radiance', 174, 212, 33),
      run('FFT', 247, 212, 13),
      run('Link', 354, 212, 17),
      run('Ortiz et al. (2020)', 393, 212, 89, true),
      run('For short periods the detector samples both signals.', 70, 270, 210, true)
    ]
  }))
})
it('keeps repeated catalogue headers over separate native data columns', () => {
  const raw = fixture()
  const result = groupPdfTranslationPages(raw)
  for (const { blocks, page } of result.pages) {
    expect(blocks.find(({ source }) => source === 'Absorption')?.rect.right).toBe(216)
    expect(blocks.filter(({ source }) => source === 'FFT')).toHaveLength(5)
    expect(blocks.find(({ source }) => source === 'Sensors & Sensors')?.rect.right).toBe(145)
    expect(blocks.find(({ source }) => source === 'Radiance')?.rect.x).toBe(174)
    expect(blocks.some(({ source }) => source === 'Sensors & Sensors Radiance')).toBe(false)
    expect(blocks.some(({ source }) => source === 'Absorption FFT')).toBe(false)
    expect(
      blocks.some(({ source }) => source === 'For short periods the detector samples both signals.')
    ).toBe(true)
    const owners = blocks.flatMap(({ items }) => items)
    expect(new Set(owners).size).toBe(raw.pages[page - 1].items.length)
    expect(owners).toHaveLength(raw.pages[page - 1].items.length)
  }
})

it('keeps the legacy grouping when the second caption does not identify a continuation', () => {
  expect(
    groupPdfTranslationPages(fixture(false)).pages.every(({ blocks }) =>
      blocks.some(({ source }) => source === 'Absorption FFT')
    )
  ).toBe(true)
})

it('does not separate the first two columns without a complete native record', () => {
  const raw = fixture()
  for (const page of raw.pages) {
    const reference = page.items.find((item) => item.str === 'Ortiz et al. (2020)')!
    reference.str = 'Reference unavailable'
  }
  expect(
    groupPdfTranslationPages(raw).pages.every(
      ({ blocks }) =>
        blocks.some(({ source }) => source === 'Sensors & Sensors Radiance') &&
        !blocks.some(({ source }) => source === 'Absorption FFT')
    )
  ).toBe(true)
})

const withStackedCategory = (
  first = 'Absorption',
  reference = 'Mori et al. (2021)'
): Parameters<typeof groupPdfTranslationPages>[0] => {
  const raw = fixture()
  for (const page of raw.pages) {
    page.items.splice(
      -1,
      0,
      run('Trial F', 70, 247, 46),
      run(first, 174, 242, 42),
      run('FFT', 247, 247, 13),
      run('—', 355, 247, 8),
      run(reference, 393, 247, 85, true),
      run('Emission', 174, 252.6, 36, true)
    )
  }
  return raw
}

it('keeps independently witnessed stacked categories on their own native lines', () => {
  const raw = withStackedCategory()
  for (const { blocks, page } of groupPdfTranslationPages(raw).pages) {
    const stack = blocks.filter(({ rect }) => rect.x === 174 && rect.y > 230)
    expect(stack.map(({ source }) => source)).toEqual(['Absorption', 'Emission'])
    expect(stack[0].rect.bottom).toBeLessThan(stack[1].rect.y)
    expect(stack.every(({ items }) => items.length === 1)).toBe(true)
    const owners = blocks.flatMap(({ items }) => items)
    expect(owners).toHaveLength(raw.pages[page - 1].items.length)
    expect(new Set(owners).size).toBe(owners.length)
  }
})

it.each([
  ['an unwitnessed word', 'Secondary', 'Mori et al. (2021)'],
  ['a missing record citation', 'Absorption', 'Reference unavailable']
])('keeps a stacked block grouped with %s', (_, first, reference) => {
  for (const { blocks } of groupPdfTranslationPages(withStackedCategory(first, reference)).pages)
    expect(blocks.some(({ source }) => source === `${first} Emission`)).toBe(true)
})
