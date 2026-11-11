import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { completeNativePanelParagraphs } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-panel-paragraphs.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

function fixture(): ReturnType<typeof JSON.parse> {
  const caption = {
      page: 1,
      lines: ['Figure 1. Independent native panels.'],
      rect: [100, 166, 300, 176]
    },
    tokens: ReturnType<typeof JSON.parse>[] = []
  for (const [n, x] of [60, 210].entries())
    for (const [i, text] of [
      '(' + String.fromCharCode(97 + n) + ') Native values remain',
      'carefully measured by',
      'the original source.'
    ].entries())
      tokens.push({
        text,
        rect: [x, 122 + i * 12, x + (i === 2 ? 100 : 125), 132 + i * 12],
        height: 10,
        baseline: 132 + i * 12,
        fontDescent: -0.2,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: tokens.length, text }
      })
  tokens.push({
    text: caption.lines[0],
    rect: caption.rect,
    height: 10,
    baseline: 176,
    fontDescent: -0.2,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: tokens.length, text: caption.lines[0] }
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: tokens.map((t) => ({
      text: t.text,
      x: t.rect[0],
      y: t.rect[1],
      width: t.rect[2] - t.rect[0],
      height: 10,
      fontSize: 10
    })),
    graphicsBounds: [60, 210].map((x, n) => ({
      kind: 'image',
      operationIndex: 10 + n * 20,
      imageHash: (n ? 'b' : 'a').repeat(64),
      normalizedRect: [x / 600, 40 / 800, (x + 130) / 600, 120 / 800]
    }))
  }
  return { page, figure: { rect: [60, 40, 340, 144], caption }, captions: [caption], tokens }
}
const complete = (f: ReturnType<typeof fixture>): unknown =>
  completeNativePanelParagraphs(f.page, f.figure, f.captions, [], f.tokens)
it('retains both complete three-line native subcaptions below a horizontal raster row', () => {
  const f = fixture(),
    before = structuredClone(f)
  expect(complete(f)).toEqual([60, 40, 340, 158])
  expect(associateFigures(f.page, f.captions, [], [], [], f.tokens)[0].rect[3]).toBe(158)
  expect(f).toEqual(before)
})
it.each([
  'missing-descent',
  'missing-source',
  'aliased-source',
  'caption-source',
  'unclosed-paragraph',
  'foreign-text',
  'foreign-caption',
  'intervening-paint'
])('declines incomplete or competing paragraph evidence: %s', (kind) => {
  const f = fixture()
  if (kind === 'missing-descent') delete f.tokens[2].fontDescent
  if (kind === 'missing-source') delete f.tokens[2].sourceItem
  if (kind === 'aliased-source') f.tokens.push({ ...f.tokens[2] })
  if (kind === 'caption-source') delete f.tokens.at(-1).sourceItem
  if (kind === 'unclosed-paragraph') {
    f.tokens[2].text = 'unfinished source'
    f.tokens[2].sourceItem.text = 'unfinished source'
  }
  if (kind === 'foreign-text')
    f.tokens.push({
      text: 'Foreign.',
      rect: [180, 150, 215, 160],
      height: 10,
      fontDescent: -0.2,
      horizontal: true
    })
  if (kind === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [100, 148, 300, 158] })
  if (kind === 'intervening-paint')
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [100 / 600, 150 / 800, 300 / 600, 155 / 800]
    })
  expect(complete(f)).toBeUndefined()
})
