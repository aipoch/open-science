import assert from 'node:assert/strict'
import { it } from 'vitest'
import {
  groupPdfTranslationPages,
  type PdfLayoutTextItem,
  type PdfTranslationLayout
} from '../../src/reader/layout.js'

const label = (
  str: string,
  x: number,
  y: number,
  width: number,
  font: number,
  eol = true,
  fontName = 'plot'
): PdfLayoutTextItem => ({
  str,
  width,
  height: font,
  fontName,
  dir: 'ltr',
  hasEOL: eol,
  transform: [font, 0, 0, font, x, y],
  fontAscent: 0.91,
  fontDescent: -0.23
})

function plot(drift = 0): PdfLayoutTextItem[] {
  const ticks = (y: number, change = 0): PdfLayoutTextItem[] =>
    Array.from({ length: 6 }, (_, n) => {
      const width = n ? 12 : 3.5
      return label(
        n ? `${n * 10}%` : '0',
        408 + n * 21 - width / 2 + (n === 2 ? change : 0),
        y,
        width,
        5.45,
        n === 5
      )
    })
  const edges = (y: number): PdfLayoutTextItem[] => [
    label('0', 400, y, 3.5, 5.45),
    label('50%', 391, y + 46, 12, 5.45),
    label('100%', 388, y + 92, 15.5, 5.45),
    { ...label('Rate', 385, y + 30, 26, 5.85), transform: [0, 5.85, -5.85, 0, 385, y + 30] }
  ]
  return [
    ...ticks(596),
    ...edges(603),
    label('(b) Share in the top 5%', 408, 701, 73, 6.25),
    ...ticks(473, drift),
    label('Share of events read, highest scores first', 406.4, 466.4, 113, 5.85),
    ...edges(480),
    label('(c) Share in the top 15%', 408, 578, 77, 6.25),
    label('Silver points', 471, 507, 34, 4.8),
    label('Golden points', 471, 499.8, 35, 4.8),
    label('AB-CD', 471, 492.6, 17, 4.8),
    label('Metric', 471, 485.4, 15, 4.8),
    label('(a)', 94, 721, 9, 6.7),
    label('Figure 1.', 51, 442, 42, 9, false, 'bold'),
    label(
      '(a) The observations from each group before calibration.',
      97,
      442,
      465,
      9,
      true,
      'body'
    ),
    label('Readings in the two later panels use the same interval.', 51, 431, 360, 9, true, 'body'),
    ...Array.from({ length: 8 }, (_, row) =>
      label(
        'Further observations are described using examples and independent supporting data.',
        51,
        387 - row * 12,
        510,
        11,
        true,
        'body'
      )
    )
  ]
}

it('retains the native axis ticks and separate legend rows of a repeated plot', () => {
  const parse = (drift: number): PdfTranslationLayout['units'] =>
    groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items: plot(drift) }]
    }).units
  const units = parse(0)
  const axis = units.find(
    (u) => u.source === '0 10% 20% 30% 40% 50% Share of events read, highest scores first'
  )
  const legend = units.find((u) => u.source === 'Silver points Golden points')
  assert.equal(axis?.sourceOnly, true)
  assert.equal(legend?.sourceOnly, true)
  assert.equal(Boolean(units.find((u) => u.source.startsWith('Figure 1.'))?.sourceOnly), false)
  const misaligned = parse(2).find((u) => u.source === legend.source)
  assert.ok(misaligned)
  assert.equal(Boolean(misaligned.sourceOnly), false)
})
