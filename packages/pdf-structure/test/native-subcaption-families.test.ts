import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativeSubcaptionFormFamilies } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-subcaption-families.mjs')).href
)

const fixture = (): ReturnType<typeof JSON.parse> => {
  const raw: ReturnType<typeof JSON.parse>[] = [],
    pieces: ReturnType<typeof JSON.parse>[] = []
  const viewport = {
    width: 400,
    height: 300,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 300],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 300 - y]
  }
  const font = (
    text: string,
    x: number,
    baseline: number,
    op: number,
    begin: number,
    end: number
  ): void => {
    const sourceItem = { pageNumber: 1, index: raw.length, text }
    raw.push({
      str: text,
      width: text.length * 5,
      height: 10,
      transform: [10, 0, 0, 10, x, 300 - baseline],
      fontName: 'f',
      dir: 'ltr',
      sourceItem
    })
    for (const [n, glyph] of [...text].entries()) {
      const rect = [x + n * 5, baseline - 10, x + n * 5 + 5, baseline]
      pieces.push({
        kind: 'glyph',
        text: glyph,
        fontName: 'f',
        operationIndex: op,
        packetBegin: begin,
        packetEnd: end,
        rect,
        advance: [...rect],
        bound: [...rect],
        fillAlpha: 1,
        serial: pieces.length
      })
    }
  }
  const scopes = [
    [10, 20],
    [30, 40],
    [60, 70],
    [80, 90]
  ].map(([begin, end]) => ({ begin, end, op: OPS.paintFormXObjectBegin }))
  for (const [n, left] of [10, 85, 210, 285].entries()) {
    const rect = [left, 20, left + 55, 80]
    pieces.push({
      kind: 'path',
      operationIndex: scopes[n].begin + 1,
      rect,
      bound: [...rect],
      serial: pieces.length
    })
  }
  font('(a) A', 20, 100, 25, 21, 29)
  font('(b) B', 95, 100, 45, 41, 59)
  font('Fig. 1: Left group.', 10, 120, 50, 41, 59)
  font('Body sentence.', 10, 160, 55, 41, 59)
  font('(a) A', 220, 100, 75, 71, 79)
  font('(b) B', 295, 100, 95, 91, 110)
  font('Fig. 2: Right group.', 210, 120, 100, 91, 110)
  font('Other sentence.', 210, 160, 105, 91, 110)
  const tokens = raw.map((i) => ({
    text: i.str,
    rect: [
      i.transform[4],
      300 - i.transform[5] - 10,
      i.transform[4] + i.width,
      300 - i.transform[5]
    ],
    baseline: 300 - i.transform[5],
    height: 10,
    horizontal: true,
    sourceItem: i.sourceItem
  }))
  const captions = [
    { page: 1, rect: [10, 110, 150, 120], lines: ['Fig. 1: Left group.'] },
    { page: 1, rect: [210, 110, 350, 120], lines: ['Fig. 2: Right group.'] }
  ]
  const peers = captions.map((caption, n) => ({
    caption,
    rect: [n ? 200 : 0, 15, n ? 355 : 215, 105]
  }))
  return {
    data: { scopes, pieces, pageNumber: 1 },
    pieces,
    captions,
    tokens,
    context: { content: { items: raw }, viewport },
    figure: peers[0],
    peers
  }
}
const prove = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  nativeSubcaptionFormFamilies(f.data, f.pieces, f.figure, f.captions, f.tokens, f.context, f.peers)

it('closes separate native panel families when a subcaption shares BT with caption and prose', () => {
  const f = fixture(),
    before = JSON.stringify(f)
  const p = prove(f)
  expect(p?.kind).toBe('complete-native-multiple-subcaption-families')
  expect(p.own.filter((i) => i.kind === 'path').map((i) => i.operationIndex)).toEqual([11, 31])
  expect(
    p.own
      .filter((i) => i.kind === 'glyph')
      .map((i) => i.text)
      .join('')
  ).toBe('(a) A(b) B')
  expect(p.excluded.filter((i) => i.kind === 'path').map((i) => i.operationIndex)).toEqual([61, 81])
  expect(
    p.excluded
      .filter((i) => i.kind === 'glyph')
      .map((i) => i.text)
      .join('')
  ).toBe('(a) A(b) BFig. 2: Right group.')
  expect(p.exteriorPeers).toEqual([f.peers[1]])
  expect(p.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toEqual(before)
})

it('cannot borrow a missing original subcaption glyph from its caption or prose packet', () => {
  const f = fixture(),
    part = f.pieces.findIndex((i) => i.operationIndex === 45 && i.text === 'B')
  f.pieces.splice(part, 1)
  expect(prove(f)).toBeUndefined()
})

it.each([
  'source-index',
  'source-page',
  'source-text',
  'source-rect',
  'source-alias',
  'glyph-alias',
  'glyph-opacity',
  'glyph-packet',
  'glyph-font'
])('declines altered whole-font closure: %s', (mutation) => {
  const f = fixture(),
    token = f.tokens[1],
    glyph = f.pieces.find((i) => i.operationIndex === 45)
  if (mutation === 'source-index') token.sourceItem = { ...token.sourceItem, index: 0 }
  if (mutation === 'source-page') token.sourceItem = { ...token.sourceItem, pageNumber: 2 }
  if (mutation === 'source-text') token.sourceItem = { ...token.sourceItem, text: '(b) C' }
  if (mutation === 'source-rect') token.rect[0] += 1
  if (mutation === 'source-alias') f.tokens.push({ ...token })
  if (mutation === 'glyph-alias') f.pieces.push({ ...glyph })
  if (mutation === 'glyph-opacity') glyph.fillAlpha = 0.5
  if (mutation === 'glyph-packet') glyph.packetEnd = glyph.operationIndex
  if (mutation === 'glyph-font') glyph.fontName = 'other'
  expect(prove(f)).toBeUndefined()
})

it.each([
  'missing-form',
  'overlapping-form',
  'missing-label',
  'wrong-letter',
  'missing-caption',
  'ambiguous-caption',
  'changed-caption',
  'foreign-peer',
  'unrelated-peer-box'
])('requires complete unique families: %s', (mutation) => {
  const f = fixture()
  if (mutation === 'missing-form') f.data.scopes.pop()
  if (mutation === 'overlapping-form') f.data.scopes[1].begin = 19
  if (mutation === 'missing-label') {
    f.context.content.items[1].str = 'Other'
    f.context.content.items[1].sourceItem.text = 'Other'
    f.tokens[1].text = 'Other'
  }
  if (mutation === 'wrong-letter') {
    const raw = f.context.content.items[1],
      token = f.tokens[1]
    raw.str = '(c) B'
    raw.sourceItem = { ...raw.sourceItem, text: raw.str }
    token.text = raw.str
    token.sourceItem = { ...token.sourceItem, text: raw.str }
    f.pieces.find((i) => i.operationIndex === 45 && i.text === 'b').text = 'c'
  }
  if (mutation === 'missing-caption') f.captions.pop()
  if (mutation === 'ambiguous-caption') f.captions.push(structuredClone(f.captions[1]))
  if (mutation === 'changed-caption') f.captions[1].lines = ['Fig. 2: Other text.']
  if (mutation === 'foreign-peer') f.peers[1].caption = { ...f.peers[1].caption }
  if (mutation === 'unrelated-peer-box') f.peers[1].rect = [0, 0, 5, 5]
  expect(prove(f)).toBeUndefined()
})

it('keeps the original main caption and subsequent prose outside the selected panel family', () => {
  const f = fixture(),
    p = prove(f),
    own = new Set(p.own),
    excluded = new Set(p.excluded)
  expect(
    f.pieces
      .filter((i) => [50, 55, 105].includes(i.operationIndex))
      .every((i) => !own.has(i) && !excluded.has(i))
  ).toBe(true)
  expect(p.own.some((i) => i.operationIndex === 45)).toBe(true)
  expect(p.own.some((i) => i.operationIndex === 50)).toBe(false)
})
