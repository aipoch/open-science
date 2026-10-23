import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { removeClippedFormText } = await import(
  pathToFileURL(resolve('resources/literature-pdf-symbol-text.mjs')).href
)

it('matches PDF.js expanded ligatures before removing text outside a form clip', () => {
  const { content, operators } = readPdfFixture(
    resolve('test/fixtures/clipped-form-ligatures.jsonl')
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
    resolve('test/fixtures/clipped-form-trailing-text.jsonl')
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

it.each(['prefix', 'both ends'])(
  'removes off-clip duplicate captions when PDF.js omits the %s of a uniform form stream',
  async (omission) => {
    const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const item = (
      str: string,
      y: number
    ): { str: string; fontName: string; width: number; height: number; transform: number[] } => ({
      str,
      fontName: 'form',
      width: 60,
      height: 10,
      transform: [10, 0, 0, 10, 20, y]
    })
    const content = {
      items: [
        item('Figure 2. Sample measurements.', 120),
        item('Visible axis label', 20),
        item('Partially clipped label', 95)
      ]
    }
    const operators = {
      fnArray: [OPS.setFont, OPS.paintFormXObjectBegin, OPS.showText, OPS.paintFormXObjectEnd],
      argsArray: [
        ['form', 10],
        [null, [0, 0, 100, 100]],
        [
          [
            {
              unicode:
                'Omitted running header' +
                content.items.map((i) => i.str).join('') +
                (omission === 'both ends' ? 'Omitted footer' : '')
            }
          ]
        ],
        []
      ]
    }
    const before = structuredClone({ content, operators })
    expect(removeClippedFormText(content, operators).items).toEqual(content.items.slice(1))
    expect({ content, operators }).toEqual(before)
    // Interior omissions do not establish a contiguous source stream.
    const unmatched = { items: [content.items[0], content.items[2]] }
    expect(removeClippedFormText(unmatched, operators).items).toEqual(unmatched.items)
    // The same text outside the form makes an omitted prefix ambiguous.
    operators.fnArray.push(OPS.setFont, OPS.showText)
    operators.argsArray.push(['form', 10], [[{ unicode: 'Outside text' }]])
    expect(removeClippedFormText(content, operators).items).toEqual(content.items)
  }
)
