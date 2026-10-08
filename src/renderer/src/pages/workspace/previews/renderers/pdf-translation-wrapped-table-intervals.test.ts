import assert from 'node:assert/strict'
import { it as test } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from './pdf-translation-layout'

const item = (
  str: string,
  x: number,
  y: number,
  width: number,
  fontName = 'table',
  font = 8
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  fontName,
  dir: 'ltr',
  transform: [font, 0, 0, font, x, 800 - y]
})

const table = (
  options: {
    rows?: number
    tail?: string
    start?: string
    x?: number
    gap?: number
    font?: string
    size?: number
    intervening?: boolean
    drift?: boolean
  } = {}
): PdfLayoutTextItem[] => {
  const runs: PdfLayoutTextItem[] = []
  for (let row = 0; row < (options.rows ?? 3); row++) {
    const y = 120 + row * 24
    runs.push(
      item(`Day ${row + 1}`, 50, y, 25),
      item(String(30 + row), 120 + (options.drift ? row * 14 : 0), y, 12),
      item(String(40 + row), 172 + (options.drift ? row * 14 : 0), y, 12),
      item(options.start ?? '-2 (-4 to', 220, y, 25)
    )
    if (options.intervening) runs.push(item('Independent caption.', 350, y + 60, 100))
    runs.push(
      item(
        options.tail ?? '-1)',
        options.x ?? 220,
        y + (options.gap ?? 10),
        10,
        options.font,
        options.size
      ),
      item('0.005*', 260 + (options.drift ? row * 14 : 0), y, 21)
    )
  }
  return runs
}

const extract = (items: PdfLayoutTextItem[]): ReturnType<typeof groupPdfTranslationPages> =>
  groupPdfTranslationPages({
    pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
  })

test.each([
  { start: '-2 (-4 to', tail: '-1)', complete: '-2 (-4 to -1)' },
  { start: '-2 (-4', tail: 'to 0)', complete: '-2 (-4 to 0)' },
  { start: '+2 (.4 to', tail: '+3.5)', complete: '+2 (.4 to +3.5)' }
])('keeps a wrapped closed measured interval intact: $complete', ({ start, tail, complete }) => {
  const items = table({ start, tail })
  const result = extract(items)
  const values = result.units.filter((unit) => unit.source === complete)
  assert.equal(values.length, 3, JSON.stringify(result.units))
  assert.ok(values.every((unit) => unit.sourceOnly && unit.items.length === 2))
  assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, items.length)
  assert.equal(result.units.flatMap((unit) => unit.items).length, items.length)
  assert.ok(
    !result.units.some((unit) => unit.source.includes('0.005*') && unit.source.includes('to'))
  )
})

test.each([
  { name: 'one unproven row', rows: 1 },
  { name: 'two unproven rows', rows: 2 },
  { name: 'a different column', x: 320 },
  { name: 'a distant next row', gap: 24 },
  { name: 'a different font', font: 'body' },
  { name: 'a different size', size: 9 },
  { name: 'an unclosed interval', tail: '-1' },
  { name: 'a symbolic operand', tail: 'x)' },
  { name: 'an added operator', tail: '-1 + 2)' },
  { name: 'intervening native content', intervening: true },
  { name: 'drifting value columns', drift: true }
])('$name retains independent ownership', (options) => {
  const result = extract(table(options))
  assert.ok(!result.units.some((unit) => /^-2 \(-4 to -1\)$/u.test(unit.source)))
})

const descriptors = (
  options: {
    rows?: number
    x?: number
    tail?: string
    font?: string
    intervening?: boolean
    independentMeasurements?: boolean
  } = {}
): PdfLayoutTextItem[] => {
  const runs: PdfLayoutTextItem[] = []
  for (let row = 0; row < (options.rows ?? 3); row++) {
    const y = 120 + row * 24
    runs.push(item(row === 0 ? 'Iterative Hessian' : 'Local convergence', 50, y, 68))
    if (row === 0) {
      if (options.intervening) runs.push(item('Independent annotation.', 350, 220, 100))
      runs.push(item(options.tail ?? 'factorization', options.x ?? 50, y + 10, 40, options.font))
      if (options.independentMeasurements) {
        runs.push(item('0.8', 150, y + 10, 12), item('1.4', 200, y + 10, 12))
      }
    }
    runs.push(item('0.6', 150, y, 12), item('1.2', 200, y, 12), item('0.005', 260, y, 21))
  }
  return runs
}

test('a measured first-column descriptor retains its complete native wrap', () => {
  const runs = descriptors(),
    result = extract(runs)
  const label = result.units.find((unit) => unit.source === 'Iterative Hessian factorization')
  assert.ok(label && !label.sourceOnly && label.items.length === 2, JSON.stringify(result.units))
  assert.equal(new Set(result.units.flatMap((unit) => unit.items)).size, runs.length)
})

test.each([
  { name: 'an unproven table', rows: 2 },
  { name: 'a different descriptor column', x: 150 },
  { name: 'a changed descriptor typeface', font: 'foreign' },
  { name: 'another capitalized label', tail: 'Factorization' },
  { name: 'an independent measured row', independentMeasurements: true },
  { name: 'intervening descriptor content', intervening: true }
])('$name does not merge descriptor ownership', (options) => {
  const result = extract(descriptors(options))
  assert.ok(!result.units.some((unit) => unit.source === 'Iterative Hessian factorization'))
})
