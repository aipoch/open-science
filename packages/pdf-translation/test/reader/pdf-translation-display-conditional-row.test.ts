import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

function run(
  str: string,
  x: number,
  y: number,
  width: number,
  face = 'Body',
  eol = false
): PdfLayoutTextItem {
  return {
    str,
    width,
    height: 11,
    dir: 'ltr',
    transform: [11, 0, 0, 11, x, y],
    fontName: face,
    fontAscent: 0.72,
    fontDescent: -0.2,
    fontVertical: false,
    hasEOL: eol
  }
}

it.each([false, true])('joins the condition before a numbered equation (offset=%s)', (offset) => {
  const y = offset ? 428 : 430
  const items = [
    run('The following calculation uses the measured count.', 72, 445, 273, 'Body', true),
    run('For', 72, 430, 16),
    run('n', 92, 430, 6, 'Math'),
    run('≤', 101, 430, 8, 'Symbol'),
    run('m', 112, 430, 7, 'Math'),
    run(', the difference between the measured values at time', 119.3, y, 255),
    run('t', 378, y, 4, 'Math'),
    run('is', 385.5, y, 7.5, 'Body', true),
    run('g(x) = 2x − 1.', 249, 405, 103, 'Math'),
    run('(6.2)', 518, 405, 22, 'Body', true),
    run('The remaining measurements are recorded separately.', 72, 374, 260, 'Body', true)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
  })
  const condition = units.find((unit) => unit.items.includes('1:1'))
  expect(condition?.items.includes('1:5')).toBe(!offset)
  expect(units.find((unit) => unit.items.includes('1:8'))?.preserve).toBe('formula')
  expect(units.flatMap((unit) => unit.items).sort()).toEqual(items.map((_, i) => '1:' + i).sort())
})
