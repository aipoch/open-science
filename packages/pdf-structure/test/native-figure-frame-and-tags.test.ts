import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { completeCenteredNativeRasterTags } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

function fixture(): ReturnType<typeof JSON.parse> {
  const page = {
    width: 500,
    height: 700,
    pageNumber: 1,
    graphicsBounds: [
      [100, 300, 260, 451],
      [280, 300, 440, 451]
    ].map((rect, index) => ({
      kind: 'image',
      imageHash: String(index),
      normalizedRect: rect.map((v, i) => v / (i % 2 ? 700 : 500))
    }))
  }
  const caption = {
    page: 1,
    rect: [90, 480, 450, 495],
    lines: ['Figure 1. (a) Initial state and (b) final state.']
  }
  const figure = { caption, rect: [90, 299, 450, 460], reason: 'native-aligned-raster-pair' }
  const tokens = [180, 360].map((x, n) => {
    const text = '(' + 'ab'[n] + ')'
    return {
      text,
      rect: [x - 6, 284, x + 6, 294],
      height: 10,
      baseline: 294,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: n, text }
    }
  })
  return { page, caption, figure, tokens }
}

it('includes both native centered panel tags above a paired raster crop', () => {
  const { page, caption, figure, tokens } = fixture()
  expect(
    completeCenteredNativeRasterTags(page, figure, [caption], [], tokens, () => false)
  ).toEqual([90, 283, 450, 460])
})

it.each(['shifted tag', 'unrelated text', 'unlisted panel'])(
  'preserves existing bounds for %s',
  (kind) => {
    const { page, caption, figure, tokens } = fixture()
    if (kind === 'shifted tag') {
      tokens[1].rect[0] += 12
      tokens[1].rect[2] += 12
    }
    if (kind === 'unrelated text')
      tokens.push({ ...tokens[0], text: 'Lead', rect: [204, 284, 224, 294] })
    if (kind === 'unlisted panel') caption.lines = ['Figure 1. Two states.']
    expect(
      completeCenteredNativeRasterTags(page, figure, [caption], [], tokens, () => false)
    ).toBeUndefined()
  }
)

const { nativeFigureRunningHead } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-bands.mjs')).href
)

function framedHeadFixture(): ReturnType<typeof JSON.parse> {
  const width = 500,
    height = 700,
    pageNumber = 2
  const graphicsBounds = [
    [88, 51, 412, 54],
    [88, 52, 92, 66],
    [90, 52, 157, 64],
    [155, 52, 159, 66],
    [408, 52, 412, 66],
    [88, 63, 412, 66],
    [105, 120, 398, 315]
  ].map((rect, n) => ({
    kind: n === 6 ? 'image' : 'path',
    normalizedRect: rect.map((v, k) => v / (k % 2 ? height : width))
  }))
  const lines = [{ text: 'Journal page 2', x: 100, y: 55, width: 301, height: 6, fontSize: 6 }]
  const tokens = [
    { text: 'Journal page', horizontal: true, height: 6, rect: [100, 55, 148, 61] },
    { text: '2', horizontal: true, height: 6, rect: [397, 55, 401, 61] }
  ]
  const page = { width, height, pageNumber, graphicsBounds, lines }
  const rules = [
    [90, 52, 410, 52],
    [90, 64, 410, 64],
    ...[90.2, 157, 409.8].map((x) => [x, 52.2, x, 63.8])
  ]
  const captions = [{ page: 2, rect: [110, 325, 400, 350], lines: ['Figure 1. Samples.'] }]
  return { page, rules, captions, tokens }
}

it('identifies a complete narrow folio frame and removes only its native decorations', () => {
  const { page, rules, captions, tokens } = framedHeadFixture()
  const head = nativeFigureRunningHead(page, captions, tokens, rules)
  expect(head.tokens).toEqual(tokens)
  expect(head.lines).toEqual(page.lines)
  expect(head.decorations).toEqual(page.graphicsBounds.slice(0, 6))
})

it.each(['missing divider', 'nonmatching folio', 'foreign raster'])(
  'keeps the source margin with a %s',
  (kind) => {
    const { page, rules, captions, tokens } = framedHeadFixture()
    if (kind === 'missing divider') rules.splice(3, 1)
    if (kind === 'nonmatching folio') tokens[1].text = '3'
    if (kind === 'foreign raster') page.graphicsBounds[0].kind = 'image'
    expect(nativeFigureRunningHead(page, captions, tokens, rules)).toBeUndefined()
  }
)

function compactFolioFixture(): ReturnType<typeof JSON.parse> {
  const width = 500,
    height = 700,
    pageNumber = 3
  const graphicsBounds = [
    [48, 21, 52, 37],
    [50, 21, 74, 37],
    [72, 21, 76, 37],
    [448, 21, 452, 37],
    [52, 51, 447, 295]
  ].map((rect, index) => ({
    kind: index === 4 ? 'image' : 'path',
    normalizedRect: rect.map((value, part) => value / (part % 2 ? height : width))
  }))
  const tokens = [
    { text: 'Article', horizontal: true, height: 6, rect: [55, 25, 68, 31] },
    { text: 'Research Notes', horizontal: true, height: 6, rect: [350, 25, 417, 31] },
    { text: '3', horizontal: true, height: 6, rect: [439, 25, 443, 31] }
  ]
  const lines = [{ text: 'Article Research Notes 3', x: 55, y: 25, width: 388, height: 6 }]
  const page = { width, height, pageNumber, graphicsBounds, lines }
  const rules = [
    [50, 22, 450, 22],
    [50, 36, 450, 36],
    ...[50.2, 74, 449.8].map((x) => [x, 22.2, x, 35.8]),
    [52, 48, 448, 48]
  ]
  const captions = [{ page: 3, rect: [62, 301, 448, 325], lines: ['Figure 1. Sketch.'] }]
  return { page, rules, captions, tokens }
}

it('separates a compact running folio from the raster frame that follows it', () => {
  const { page, rules, captions, tokens } = compactFolioFixture()
  const head = nativeFigureRunningHead(page, captions, tokens, rules)
  expect(head.tokens).toEqual(tokens)
  expect(head.lines).toEqual(page.lines)
  expect(head.decorations).toEqual(page.graphicsBounds.slice(0, 4))
})

it.each(['touching rule', 'foreign raster'])('keeps a compact margin with %s', (kind) => {
  const { page, rules, captions, tokens } = compactFolioFixture()
  if (kind === 'touching rule') rules.at(-1).splice(1, 3, 39, 448, 39)
  if (kind === 'foreign raster') page.graphicsBounds[1].kind = 'image'
  expect(nativeFigureRunningHead(page, captions, tokens, rules)).toBeUndefined()
})
