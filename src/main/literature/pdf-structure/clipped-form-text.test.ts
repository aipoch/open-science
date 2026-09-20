import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { removeClippedFormText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)

it('matches PDF.js expanded ligatures before removing text outside a form clip', () => {
  const { content, operators } = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/clipped-form-ligatures.jsonl')
  )
  const result = removeClippedFormText(content, operators)
  expect(result.items.some((item: { str: string }) => ['ff', 'fi'].includes(item.str))).toBe(false)
  expect(
    result.items.some((item: { str: string }) => item.str.startsWith('Effect of magnetically'))
  ).toBe(true)
  expect(
    result.items.some((item: { str: string }) =>
      item.str.startsWith(') Changes in the quantification')
    )
  ).toBe(true)
})

it('removes clipped form text when PDF.js omits a trailing part of that uniformly clipped stream', () => {
  const { content, operators } = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/clipped-form-trailing-text.jsonl')
  )
  const result = removeClippedFormText(content, operators)
  expect(
    result.items.some((item: { str: string }) =>
      item.str.startsWith('or magnetic groups for 3 days.')
    )
  ).toBe(false)
  expect(
    result.items.some((item: { str: string }) => item.str.startsWith('magnetic groups for 3 days.'))
  ).toBe(true)
})

it.each([
  ['ﬀ', 'ff'],
  ['ﬁ', 'fi'],
  ['ﬂ', 'fl'],
  ['ﬃ', 'ffi'],
  ['ﬄ', 'ffl'],
  ['ﬅ', 'ſt'],
  ['ﬆ', 'st']
])('keeps visible %s ligatures while matching PDF.js normalization', async (glyph, expanded) => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const item = (
    y: number
  ): { str: string; fontName: string; width: number; height: number; transform: number[] } => ({
    str: expanded,
    fontName: 'f',
    width: 20,
    height: 10,
    transform: [10, 0, 0, 10, 20, y]
  })
  const content = { items: [item(120), item(20)] }
  const operators = {
    fnArray: [
      OPS.setFont,
      OPS.paintFormXObjectBegin,
      OPS.showText,
      OPS.showText,
      OPS.paintFormXObjectEnd
    ],
    argsArray: [
      ['f', 10],
      [null, [0, 0, 100, 100]],
      [[{ unicode: glyph }]],
      [[{ unicode: glyph }]],
      []
    ]
  }
  expect(removeClippedFormText(content, operators).items).toEqual([content.items[1]])
  expect(content.items).toHaveLength(2)
})

it('keeps an unmatched stream when an omitted suffix crosses different form clips', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const content = {
    items: [
      { str: 'first', fontName: 'f', width: 20, height: 10, transform: [10, 0, 0, 10, 20, 120] }
    ]
  }
  const operators = {
    fnArray: [
      OPS.setFont,
      OPS.paintFormXObjectBegin,
      OPS.showText,
      OPS.paintFormXObjectEnd,
      OPS.paintFormXObjectBegin,
      OPS.showText,
      OPS.paintFormXObjectEnd
    ],
    argsArray: [
      ['f', 10],
      [null, [0, 0, 100, 100]],
      [[{ unicode: 'first' }]],
      [],
      [null, [0, 0, 200, 200]],
      [[{ unicode: 'omitted' }]],
      []
    ]
  }
  expect(removeClippedFormText(content, operators).items).toEqual(content.items)
})
