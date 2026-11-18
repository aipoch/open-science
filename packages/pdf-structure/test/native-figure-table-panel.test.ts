/* eslint-disable @typescript-eslint/explicit-function-return-type -- fixture geometry */
import { expect, it } from 'vitest'
import { nativeFigureTablePanel } from '../resources/literature-pdf-figure-native-table-panel.mjs'

function fixture() {
  const page = {
    pageNumber: 1,
    width: 400,
    height: 600,
    rotation: 0,
    renderRotation: 0,
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.535, 0.105, 0.88, 0.225] },
      { kind: 'path', normalizedRect: [0.52, 0.287, 0.9, 0.289] },
      { kind: 'path', normalizedRect: [0.52, 0.32, 0.9, 0.322] },
      { kind: 'path', normalizedRect: [0.52, 0.398, 0.9, 0.401] }
    ]
  }
  const token = (index: number, text: string, rect: number[]) => ({
    text,
    rect,
    nativeLabelRect: rect,
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text },
    height: 8,
    fontAscent: 0.7,
    fontDescent: -0.2
  })
  const chart = token(1, 'Response', [226, 85, 260, 93])
  const a = token(2, '(a) Observed response.', [238, 154, 330, 162])
  const b = token(9, '(b) Summary values.', [244, 247, 324, 255])
  const grid = [
    ['Group', 'Rate'],
    ['Trial A', '12.4'],
    ['Trial B', '14.1']
  ]
  const rows = grid.flatMap((values, row) =>
    values.map((text, col) =>
      token(3 + row * 2 + col, text, [
        220 + col * 100,
        178 + row * 22,
        250 + col * 100,
        186 + row * 22
      ])
    )
  )
  const caption = {
    page: 1,
    rect: [205, 265, 362, 286],
    lines: ['Figure 1. Response (Figure 1a) and summary values (Figure 1b).']
  }
  const tableRect = [207, 170, 361, 249]
  const scale = (rect: number[]) => rect.map((n) => n * 1.5)
  const table = {
    page: 1,
    caption: undefined as typeof caption | undefined,
    captionIssue: 'no-adjacent-table-caption',
    issues: ['text-crosses-crop-boundary'],
    clipped: [{ text: b.text, rect: scale(b.rect) }],
    grid,
    region: tableRect.map((n, i) => n / (i % 2 ? page.height : page.width)),
    cropRect: scale(tableRect),
    sourceViewport: { scale: 1.5, width: 600, height: 900 },
    cells: rows.map((source, i) => ({
      row: Math.floor(i / 2),
      column: i % 2,
      text: source.text,
      rowSpan: 1,
      colSpan: 1,
      sourceItems: [source.sourceItem]
    }))
  }
  return {
    page,
    figure: { caption },
    rect: [205, 60, 362, 174],
    table,
    tokens: [chart, a, ...rows, b],
    rules: [173, 193, 240].map((y) => scale([208, y, 360, y])),
    viewport: { rotation: 0, width: 400, height: 600 },
    peers: [] as number[][],
    captions: [caption]
  }
}

it('includes both original figure panels and excludes the shared caption', () => {
  const input = fixture()
  const proof = nativeFigureTablePanel(input)
  expect(proof?.rect).toEqual([205, 60, 362, 256])
  expect(proof?.current()).toBe(true)
  input.table.cells[0].text = 'Changed'
  expect(proof?.current()).toBe(false)
})

it.each([
  'standalone table',
  'missing panel reference',
  'missing table source',
  'foreign owner',
  'foreign paint',
  'foreign native text'
])('keeps separate owners when mixed figure proof has %s', (reason) => {
  const input = fixture()
  if (reason === 'standalone table') input.table.caption = input.figure.caption
  if (reason === 'missing panel reference')
    input.figure.caption.lines[0] = 'Figure 1. Response (Figure 1a).'
  if (reason === 'missing table source') input.table.cells[0].sourceItems = []
  if (reason === 'foreign owner') input.peers.push([208, 192, 360, 241])
  if (reason === 'foreign paint')
    input.page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.525, 0.29, 0.9, 0.38] })
  if (reason === 'foreign native text')
    input.tokens.push({ ...input.tokens[0], text: 'Unrelated', rect: [215, 165, 285, 171] })
  expect(nativeFigureTablePanel(input)).toBeUndefined()
})
