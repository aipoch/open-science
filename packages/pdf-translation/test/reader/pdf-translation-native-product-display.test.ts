import { describe, expect, it } from 'vitest'
import { nativeDisplayProductTerms } from '../../src/reader/native-display-packets.js'
import type { PdfLayoutTextItem, PdfLayoutPage } from '../../src/reader/layout.js'
import type { PdfTranslationSource } from '../../src/reader/source.js'

type Unit = PdfTranslationSource['units'][number]

function packet(): {
  page: PdfLayoutPage
  unit: (id: string, indices: number[], formula?: boolean) => Unit
} {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    height = 10
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    dir: 'ltr',
    transform: [height, 0, 0, height, x, y]
  })
  const items = [
    item('k', 104, 134, 4, 7),
    item('∏', 100, 130, 13),
    item('i', 100, 108, 3, 7),
    item('=1', 103, 108, 9, 7),
    item('q', 115, 120, 5),
    item('a', 120, 124, 4, 7),
    item('i', 120, 117, 3, 7),
    item('=', 129, 120, 8),
    item('r.', 139, 120, 8),
    item('for each prime', 157, 120, 58)
  ]
  const page: PdfLayoutPage = { page: 1, width: 600, height: 800, rotation: 0, items }
  const unit = (id: string, indices: number[], formula = false): Unit => ({
    id,
    source: indices.map((index) => items[index].str).join(' '),
    fragments: [
      {
        pageNumber: 1,
        rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
        items: indices.map((index) => ({ index, text: items[index].str }))
      }
    ],
    ...(formula ? { sourceOnly: true as const, preserve: 'formula' as const } : {})
  })
  return { page, unit }
}

describe('native display product terms', () => {
  it('preserves a scripted term next to protected display limits and keeps neighboring prose', () => {
    const { page, unit } = packet()
    expect(
      nativeDisplayProductTerms(
        [
          unit('upper', [0], true),
          unit('product', [1], true),
          unit('lower', [2, 3], true),
          unit('term', [4, 5, 6, 7, 8]),
          unit('prose', [9])
        ],
        [page]
      )
    ).toEqual(new Set(['term']))
  })

  it('requires display size, covered limits, and an entirely mathematical owner', () => {
    const { page, unit } = packet()
    const owners = [
      unit('upper', [0], true),
      unit('product', [1], true),
      unit('lower', [2, 3], true)
    ]
    const term = unit('term', [4, 5, 6, 7, 8])
    expect(nativeDisplayProductTerms([...owners.slice(0, 2), term], [page]).size).toBe(0)
    expect(
      nativeDisplayProductTerms([...owners, unit('mixed', [4, 5, 6, 7, 8, 9])], [page]).size
    ).toBe(0)
    page.items[1].width = 10
    expect(nativeDisplayProductTerms([...owners, term], [page]).size).toBe(0)
  })
})

it.each([
  ['combined', false, false, true],
  ['split', true, false, true],
  ['displaced', true, true, false]
] as const)('checks the complete stacked parity limit (%s)', (_, split, displaced, retained) => {
  const { page, unit } = packet()
  const text = (
    str: string,
    x: number,
    y: number,
    width: number,
    height: number,
    fontName: string
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    fontName,
    dir: 'ltr',
    transform: [height, 0, 0, height, x, y]
  })
  page.items.splice(
    0,
    page.items.length,
    text('∏', 100, 100, 12, 14, 'symbol'),
    text('q', 99.4, 92, 3.6, 7.2, 'italic'),
    text('∈', 103, 92, 4.4, 7.2, 'symbol'),
    text('S', 107.4, 92, 5.2, 7.2, 'set'),
    ...(split
      ? [
          text('q', 98, displaced ? 83 : 86, 3.6, 7.2, 'italic'),
          text('odd', 103.4, displaced ? 83 : 86, 10.6, 7.2, 'body')
        ]
      : [text('q odd', 98, 86, 16, 7.2, 'italic')]),
    text('2', 117, 108.7, 5, 9.8, 'body'),
    text('q', 122, 108.7, 5, 9.8, 'italic'),
    text('q odd', 45, 65, 30, 10, 'body')
  )
  const after = split ? 6 : 5
  expect(
    nativeDisplayProductTerms(
      [
        unit('product', [0], true),
        unit('membership', [1, 2, 3]),
        unit('parity', split ? [4, 5] : [4]),
        unit('factor', [after, after + 1]),
        unit('neighbor', [after + 2])
      ],
      [page]
    )
  ).toEqual(retained ? new Set(['parity']) : new Set())
})

it.each([0, 9])(
  'preserves only a centered prime condition beneath a native product (%s)',
  (shift) => {
    const { page, unit } = packet()
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height: number
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      transform: [height, 0, 0, height, x, y]
    })
    page.items.splice(
      0,
      page.items.length,
      item('∏', 100, 100, 13, 10),
      item('k>', 88 + shift, 79, 9, 7),
      item('3', 97 + shift, 79, 4, 7),
      item(',k', 101 + shift, 79, 6, 7),
      item('prime', 109 + shift, 79, 16, 7),
      item('The estimate comes next.', 72, 62, 126, 10)
    )
    const condition = { ...unit('limit', [1, 2, 3, 4]), source: 'k>3,k prime' }
    expect(
      nativeDisplayProductTerms([unit('product', [0], true), condition, unit('prose', [5])], [page])
    ).toEqual(shift ? new Set() : new Set(['limit']))
  }
)
