import { expect, it } from 'vitest'
import type { PDFPageProxy } from 'pdfjs-dist'
import { verifiedPdfLatinAccentText } from './pdf-translation-latin-accents'

type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Item = Extract<Content['items'][number], { str: string }>
const item = (str: string, x: number, y: number, width: number, fontName: string): Item => ({
  str,
  width,
  height: 10,
  fontName,
  dir: 'ltr',
  hasEOL: false,
  transform: [10, 0, 0, 10, x, y]
})
const content = (items: Item[], fontName: string): Content => ({
  items,
  styles: { [fontName]: { fontFamily: 'serif', ascent: 0.7, descent: -0.2, vertical: false } },
  lang: null
})

it.each([
  'preserved',
  'segmented-citation-tail',
  'changed-action-geometry',
  'changed-font',
  'missing-mark',
  'changed-vowel',
  'changed-width',
  'changed-base-width',
  'changed-base-height',
  'changed-base-tail',
  'nonfinite-base-width',
  'changed-mark-height',
  'changed-size',
  'changed-relative-position',
  'outside-vowel',
  'inline-dots',
  'math-variable',
  'greek-variable',
  'missing-font-style'
])('proves both native accent glyphs and their movement: %s', (change) => {
  const before = [
      item('Kynk', 60, 700, 20, 'source'),
      item('¨', 80.5, 700.05, 3, 'source'),
      item('a', 80, 700, 4, 'source'),
      item('¨', 84.5, 700.05, 3, 'source'),
      item('anniemi et al., 2019)', 84, 700, 76, 'source')
    ],
    after = before.map((value) => ({
      ...value,
      fontName: 'target',
      transform: [...value.transform]
    }))
  for (const value of after) {
    value.transform[4] += 40
    value.transform[5] -= 20
  }
  if (change === 'changed-font') after[1].fontName = 'other'
  if (change === 'missing-mark') after.splice(1, 1)
  if (change === 'changed-vowel') after[2].str = 'e'
  if (change === 'changed-width') after[1].width += 0.02
  if (change === 'changed-base-width') after[4].width += 0.02
  if (change === 'changed-base-height') after[4].height += 0.02
  if (change === 'changed-base-tail') after[4].str = 'another et al., 2019)'
  if (change === 'segmented-citation-tail') {
    after[4].str = 'anniemi et al.'
    after[4].width = 56
    after.push(item(', 2019)', 180, 680, 20, 'target'))
  }
  if (change === 'nonfinite-base-width') after[4].width = NaN
  if (change === 'changed-mark-height') after[1].height += 0.02
  if (change === 'changed-size') after[1].transform[3] += 0.02
  if (change === 'changed-relative-position') after[1].transform[4] += 0.02
  if (change === 'outside-vowel') before[1].transform[4] += 10
  if (change === 'inline-dots') before[1].transform[5] -= 3
  if (change === 'math-variable') before[2].str = after[2].str = 'x'
  if (change === 'greek-variable') before[2].str = after[2].str = 'ξ'
  const source = content(before, 'source'),
    target = content(after, 'target')
  if (change === 'missing-font-style') target.styles = {}
  const snapshot = structuredClone([source, target])
  const mapped = verifiedPdfLatinAccentText(
    source,
    target,
    before,
    after,
    [60, 698, 140, 710],
    change === 'changed-action-geometry' ? [101, 678, 181, 690] : [100, 678, 180, 690]
  )
  if (change === 'preserved' || change === 'segmented-citation-tail') {
    expect(before.map((value) => mapped.get(value) ?? value.str).join('')).toBe(
      'Kynkäänniemi et al., 2019)'
    )
    expect(after.map((value) => mapped.get(value) ?? value.str).join('')).toBe(
      'Kynkäänniemi et al., 2019)'
    )
  } else expect(mapped.size).toBe(0)
  expect([source, target]).toEqual(snapshot)
})
