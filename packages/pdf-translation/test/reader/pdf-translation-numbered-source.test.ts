import { expect, it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutPage,
  type PdfLayoutTextItem
} from '../../src/reader/layout.js'
import { numberedSourcePackets } from '../../src/reader/numbered-source.js'

const text = (
  str: string,
  x: number,
  y: number,
  height = 9,
  fontName = 'Code'
): PdfLayoutTextItem => ({
  str,
  width: str.length * height * 0.55,
  height,
  dir: 'ltr',
  transform: [height, 0, 0, height, x, 800 - y],
  fontName,
  fontAscent: 0.9,
  fontDescent: -0.2,
  hasEOL: true
})
const line = (ordinal: number, body: string, y: number): PdfLayoutTextItem[] => [
  text(String(ordinal), 48 - String(ordinal).length * 3.3, y, 6),
  ...(body ? [text(body, 60, y)] : [])
]
function sample(): PdfLayoutPage[] {
  return [
    {
      page: 1,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        text('A.1', 40, 80, 12, 'Heading'),
        text('Example.lean', 80, 80, 12, 'FileHeading'),
        ...line(1, 'import Library.Core', 110),
        ...line(2, 'import Library.Measure', 122),
        ...line(3, '/-!', 134),
        ...line(4, 'This complete comment belongs to the printed source file.', 146),
        text('Further original comment text.', 100, 158),
        text('↪', 83, 158, 6, 'Wrap'),
        text('→', 84, 158, 6, 'WrapArrow'),
        ...line(5, 'The comment continues on the next page.', 170),
        text('1', 298, 760, 10, 'Body')
      ]
    },
    {
      page: 2,
      width: 600,
      height: 800,
      rotation: 0,
      items: [
        ...line(6, '-/', 80),
        ...line(7, 'namespace Example', 92),
        ...line(8, 'theorem result : True := by trivial', 104),
        ...line(9, 'end Example', 116),
        text('Discussion', 40, 180, 12, 'Heading'),
        text(
          'This ordinary explanation after the listing remains available for translation.',
          40,
          210,
          10,
          'Body'
        )
      ]
    }
  ]
}

it('retains a named numbered source file, including wrapped and cross-page comments', () => {
  const pages = sample(),
    result = groupPdfTranslationPages({ pages })
  expect([...numberedSourcePackets(pages).keys()]).toEqual([1, 2])
  for (const [page, packets] of numberedSourcePackets(pages))
    for (const packet of packets)
      for (const index of packet)
        expect(
          result.units.find((unit) => unit.items.includes(`${page}:${index}`))?.sourceOnly
        ).toBe(true)
  for (const literal of [
    'import Library.Core',
    'This complete comment',
    'Further original comment',
    'The comment continues',
    'theorem result'
  ]) {
    const owners = result.units.filter((u) => u.originalStrings.some((s) => s.includes(literal)))
    expect(owners.length).toBeGreaterThan(0)
    expect(owners.every((u) => u.sourceOnly)).toBe(true)
  }
  expect(
    result.units.find((u) => u.source.startsWith('This ordinary explanation'))?.sourceOnly
  ).not.toBe(true)
  const seen = new Map<string, string>()
  for (const u of result.units)
    for (const [i, key] of u.items.entries()) {
      expect(seen.has(key)).toBe(false)
      seen.set(key, u.originalStrings[i])
    }
  for (const p of pages)
    for (const [i, item] of p.items.entries()) expect(seen.get(`${p.page}:${i}`)).toBe(item.str)
})

it.each([
  'reference-only',
  'missing-ordinal',
  'foreign-font',
  'broken-continuation',
  'distant-wrap',
  'intervening-heading',
  'missing-wrap-marker',
  'foreign-continuation-gutter'
])('requires the complete native file frame: %s', (fault) => {
  const pages = sample()
  if (fault === 'reference-only')
    pages[0].items[1].str = 'The file Example.lean is discussed below.'
  if (fault === 'missing-ordinal') pages[0].items[4].str = '3'
  if (fault === 'foreign-font')
    pages[0].items.find((i) => i.str.startsWith('This complete comment'))!.fontName = 'Body'
  if (fault === 'broken-continuation') pages[1].items[0].str = '12'
  if (fault === 'foreign-continuation-gutter')
    for (const item of pages[1].items) if (item.height === 6) item.fontName = 'ForeignNumbers'
  if (fault === 'intervening-heading')
    pages[1].items.unshift(text('Another example', 40, 45, 12, 'Heading'))
  if (fault === 'missing-wrap-marker') pages[0].items.find((i) => i.str === '→')!.str = ' '
  if (fault === 'distant-wrap')
    for (const item of pages[0].items) {
      const y = 800 - item.transform[5]
      if (y === 158 || y === 170) item.transform[5] -= 292
    }
  const result = groupPdfTranslationPages({ pages })
  expect(numberedSourcePackets(pages).size).toBe(0)
  expect(
    result.units
      .filter((u) => u.originalStrings.includes('import Library.Core'))
      .every((u) => !u.sourceOnly)
  ).toBe(true)
  expect(
    result.units.find((u) => u.source.startsWith('This ordinary explanation'))?.sourceOnly
  ).not.toBe(true)
})
