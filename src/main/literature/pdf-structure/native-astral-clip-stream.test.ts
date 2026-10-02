import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { removeClippedFormText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
it.each([
  ['𝑥', '𝑚'],
  ['😀', '🧪'],
  ['𠀀', '𠀁'],
  ['A𝑥', 'B𝑚']
])('assigns form clips by Unicode characters for %s followed by %s', async (first, second) => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const item = (
    str: string,
    y: number
  ): { str: string; fontName: string; width: number; height: number; transform: number[] } => ({
    str,
    fontName: 'native',
    width: 20,
    height: 10,
    transform: [10, 0, 0, 10, 20, y]
  })
  const content = { items: [item(first, 120), item(second, 20)] }
  const operators = {
    fnArray: [
      OPS.setFont,
      OPS.paintFormXObjectBegin,
      OPS.showText,
      OPS.showText,
      OPS.paintFormXObjectEnd
    ],
    argsArray: [
      ['native', 10],
      [null, [0, 0, 100, 100]],
      [[{ unicode: first }]],
      [[{ unicode: second }]],
      []
    ]
  }
  expect(removeClippedFormText(content, operators).items).toEqual([content.items[1]])
  expect(content.items.map((i) => i.str)).toEqual([first, second])
  const visible = { items: [item(first, 20), item(second, 40)] }
  expect(removeClippedFormText(visible, operators).items).toEqual(visible.items)
  const outside = { items: [item(first, 120), item(second, 140)] }
  expect(removeClippedFormText(outside, operators).items).toEqual([])
})
