import { expect, it } from 'vitest'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'

const row = (
  str: string,
  x: number,
  y: number,
  width: number,
  face = 'Body'
): PdfLayoutTextItem[] => [
  {
    str: '',
    width: 0,
    height: 0,
    dir: 'ltr',
    transform: [12, 0, 0, 12, x, y],
    hasEOL: true,
    fontName: face
  },
  {
    str,
    width,
    height: 12,
    dir: 'ltr',
    transform: [12, 0, 0, 12, x, y],
    hasEOL: false,
    fontName: face,
    fontAscent: 0.72,
    fontDescent: -0.22,
    fontVertical: false
  }
]

const group = (items: PdfLayoutTextItem[]): ReturnType<typeof groupPdfTranslationPages>['units'] =>
  groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
    pageCount: 1
  }).units

it.each([true, false])('joins a named body wrap on the same native face (%s)', (sameFace) => {
  const first =
    'The seasonal gradient in this region, which is sometimes referred to as the Brindle'
  const second =
    'Effect, is apparent in the rainfall measurements collected across the northern valley'
  const third =
    'where the shorter days limit the number of observation windows available to the team.'
  const units = group([
    ...row(first, 108.15, 647, 391),
    ...row(second, 72, 630.44, 451, sameFace ? 'Body' : 'Heading'),
    ...row(third, 72, 613.88, 449)
  ])
  const lead = units.find((unit) => unit.items.includes('1:1'))
  expect(lead?.source.startsWith(first + ' ' + second)).toBe(sameFace)
  expect(lead?.items.includes('1:3')).toBe(sameFace)
})

it.each([true, false])('joins a final contraction at the body row pitch (%s)', (samePitch) => {
  const first =
    'The team describes how its method adapts to a wide range of environmental conditions'
  const second =
    'and verifies the reliability of the results through observations from several stations'
  const third =
    'so the instructions say to inspect the sample we can and then return to the sample we'
  const ending = 'can’t.'
  const units = group([
    ...row(first, 72, 118, 460),
    ...row(second, 72, 101.44, 459),
    ...row(third, 72, 84.88, 444),
    ...row(ending, 72, samePitch ? 68.32 : 63.5, 26)
  ])
  const lead = units.find((unit) => unit.items.includes('1:5'))
  expect(lead?.source.endsWith(third + ' ' + ending)).toBe(samePitch)
  expect(lead?.items.includes('1:7')).toBe(samePitch)
})
