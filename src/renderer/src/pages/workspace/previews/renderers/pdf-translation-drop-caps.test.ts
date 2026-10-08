import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from './pdf-translation-layout'

const item = (
  str: string,
  x: number,
  baseline: number,
  width: number,
  font = 10,
  fontName = 'body'
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  fontName,
  dir: 'ltr',
  hasEOL: true,
  transform: [font, 0, 0, font, x, 800 - baseline]
})
const opening = (
  options: {
    cap?: string
    size?: number
    x?: number
    baseline?: number
    rows?: number
    foreign?: boolean
    intervening?: boolean
  } = {}
): PdfLayoutTextItem[] => {
  const runs = [
    item(options.cap ?? 'S', 40, options.baseline ?? 144, 20, options.size ?? 40, 'initial')
  ]
  runs[0].hasEOL = false
  if (options.intervening) runs.push(item('Independent figure label.', 350, 300, 130))
  const rows = [
    'cience brings numerical tools to researchers and practitioners',
    'building reliable programs for scientific data and analysis',
    'with libraries and reusable methods that support complete'
  ]
  for (let n = 0; n < (options.rows ?? 3); n++)
    runs.push(
      item(
        rows[n],
        options.x ?? 60,
        120 + n * 12,
        230,
        10,
        options.foreign && n === 1 ? 'foreign' : 'body'
      )
    )
  runs.push(item('workflows across many fields and areas of research.', 40, 156, 250))
  return runs
}
const extract = (items: PdfLayoutTextItem[]): ReturnType<typeof groupPdfTranslationPages> =>
  groupPdfTranslationPages({ pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }] })

test('an inset drop cap belongs to the first word and its full paragraph', () => {
  const items = opening(),
    before = structuredClone(items),
    result = extract(items)
  const paragraph = result.units.find((unit) => unit.source.startsWith('Science brings'))
  assert.ok(paragraph, JSON.stringify(result.units))
  assert.ok(paragraph.source.endsWith('areas of research.'))
  assert.equal(paragraph.items.length, 5)
  assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, items.length)
  assert.deepEqual(items, before, 'native transforms and original strings stay unchanged')
  assert.ok(!result.units.some((unit) => unit.source.startsWith('Sbuilding')))
})

test.each([
  { name: 'a numeral', cap: '5' },
  { name: 'a Greek variable', cap: 'Σ' },
  { name: 'an ordinary first-letter size', size: 10 },
  { name: 'an oversized title', size: 70 },
  { name: 'an unrelated horizontal initial', x: 90 },
  { name: 'an unrelated baseline', baseline: 180 },
  { name: 'one unproven inset row', rows: 1 },
  { name: 'two unproven inset rows', rows: 2 },
  { name: 'a different inset typeface', foreign: true },
  { name: 'intervening native content', intervening: true }
])('$name does not gain drop-cap paragraph ownership', (options) => {
  const result = extract(opening(options))
  assert.ok(
    !result.units.some(
      (unit) => unit.source.startsWith('Science brings') && unit.items.length === 5
    )
  )
})
