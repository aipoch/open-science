import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const line = (
  str: string,
  x: number,
  y: number,
  width: number,
  hasEOL = true
): PdfLayoutTextItem => ({
  str,
  width,
  height: 10,
  dir: 'ltr',
  transform: [10, 0, 0, 10, x, y],
  fontName: 'Body',
  fontAscent: 0.82,
  fontDescent: -0.18,
  fontVertical: false,
  hasEOL
})

it.each([true, false])('joins the first objective on the peer hanging rail (%s)', (aligned) => {
  const items = [
    line('The group records the changes that occur during a sequence of repeated', 54, 429, 243),
    line(
      'observations. The method samples the same area several times and reports',
      54,
      417.5,
      243
    ),
    line('a measure of its stability. The aim is to compare the observations across', 54, 406, 243),
    line('conditions using the same equipment. This experiment has two main', 54, 394.5, 243),
    line('objectives:', 54, 383, 29),
    line('1. Describe the development of the sampling method to', 67.5, 371.5, 229.5),
    line('observe changes during sampling.', aligned ? 79 : 86, 360, 142),
    line('2. Present the initial observations collected with the method to', 67.5, 348.5, 229.5),
    line('illustrate its use for repeated tests.', 79, 337, 139, false),
    line('', 120, 302, 0),
    line('A. ANALYSIS', 120, 302, 74),
    line('These observations show the change expected across both intervals of', 315, 429, 243),
    line('the repeated sequence. Later observations give the same estimate.', 315, 417.5, 225)
  ]
  const result = groupPdfTranslationPages({
    pages: [
      { page: 1, width: 612, height: 792, rotation: 0, items: [] },
      { page: 2, width: 612, height: 792, rotation: 0, items }
    ],
    pageCount: 2
  })
  const objective = result.units.find((unit) => unit.items.includes('2:5'))
  expect(objective?.source).toBe(aligned ? items[5].str + ' ' + items[6].str : items[5].str)
  expect(objective?.items.includes('2:6')).toBe(aligned)
})
