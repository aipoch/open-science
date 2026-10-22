import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { pdfTableSourceItemsSchema } from '../src/result'

const { nativeNodeFigureLabels } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-node-labels.mjs')).href
)

// Three framed nodes and a complete, independently typeset annotation packet.
// No source document, original wording, or operator dump is needed for the proof.
function diagram(): ReturnType<typeof JSON.parse> {
  const frames = [
    [100, 100, 150, 125],
    [100, 140, 150, 165],
    [100, 180, 150, 205]
  ]
  const context = { content: { items: [] as ReturnType<typeof JSON.parse>[] } }
  const tokens: ReturnType<typeof JSON.parse>[] = []
  const text = (value: string, rect: number[], fontName: string): void => {
    const index = tokens.length
    context.content.items.push({ str: value, fontName })
    tokens.push({
      text: value,
      rect,
      height: rect[3] - rect[1],
      baseline: rect[3],
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text: value }
    })
  }
  frames.forEach((r, i) => text('Node ' + i, [r[0] + 10, r[1] + 7, r[2] - 10, r[1] + 17], 'node'))
  text('Top label', [105, 82, 145, 92], 'annotation')
  text('Left label', [55, 147, 90, 157], 'annotation')
  text('Right label', [165, 187, 200, 197], 'annotation')
  text('Figure: diagram.', [95, 225, 180, 235], 'body')
  text('Ordinary page explanation.', [95, 260, 250, 270], 'body')
  frames.push([96, 96, 154, 209])
  const caption = { page: 1, rect: [95, 225, 180, 235] }
  return {
    page: { width: 600, height: 800, pageNumber: 1, rotation: 0, graphicsBounds: [] },
    figure: { rect: [95, 95, 155, 210], caption },
    captions: [caption],
    tables: [],
    frames,
    tokens,
    context
  }
}
function complete(d: ReturnType<typeof diagram>): ReturnType<typeof JSON.parse> {
  return nativeNodeFigureLabels(
    d.page,
    d.figure,
    d.captions,
    d.tables,
    d.frames,
    d.tokens,
    d.context
  )
}
it('completes node-aligned font packets and retains only whole proved sources', () => {
  const d = diagram()
  d.figure.sourceItems = [d.tokens[0].sourceItem]
  const result = complete(d)
  expect(result.rect).toEqual([55, 82, 200, 210])
  expect(result.sourceItems).toEqual(
    d.tokens.slice(0, 6).map((t: { sourceItem: unknown }) => t.sourceItem)
  )
})
it('keeps source order when a later native item was already owned', () => {
  const d = diagram()
  d.figure.sourceItems = [d.tokens[2].sourceItem]
  const before = JSON.stringify(d)
  const result = complete(d)
  expect(pdfTableSourceItemsSchema.safeParse(result.sourceItems).success).toBe(true)
  expect(result.sourceItems).toEqual(
    d.tokens.slice(0, 6).map((t: { sourceItem: unknown }) => t.sourceItem)
  )
  expect(JSON.stringify(d)).toBe(before)
})
it.each([
  'prose font',
  'caption',
  'table',
  'unframed',
  'unaligned',
  'missing native item',
  'source alias',
  'foreign ink'
])('rejects ambiguous annotation ownership: %s', (reason) => {
  const d = diagram()
  if (reason === 'prose font') d.context.content.items[7].fontName = 'annotation'
  if (reason === 'caption') d.captions.push({ page: 1, rect: d.tokens[3].rect })
  if (reason === 'table') d.tables.push(d.tokens[4].rect)
  if (reason === 'unframed') d.frames.splice(0, 2)
  if (reason === 'unaligned') d.tokens[4].rect = [55, 127, 90, 137]
  if (reason === 'missing native item') d.tokens.splice(4, 1)
  if (reason === 'source alias') d.tokens.push({ ...d.tokens[4] })
  if (reason === 'foreign ink') {
    d.tokens[7].rect = [60, 100, 90, 110]
    d.context.content.items.push({ str: 'Continued prose.', fontName: 'body' })
  }
  expect(complete(d)).toBeUndefined()
})
it('does not claim an independent section heading above unframed nodes', () => {
  const d = diagram()
  d.frames.pop()
  d.context.content.items[3].fontName = 'section-heading'
  const result = complete(d)
  expect(result?.sourceItems.some((s: { index: number }) => s.index === 3) ?? false).toBe(false)
  expect(result?.rect[1] ?? d.figure.rect[1]).toBe(95)
})

it('does not claim a standalone margin note merely aligned to a node', () => {
  const d = diagram()
  d.context.content.items[4].fontName = 'margin-note'
  d.context.content.items[5].fontName = 'other-note'
  const result = complete(d)
  expect(result?.sourceItems.some((s: { index: number }) => s.index === 4) ?? false).toBe(false)
  expect(result?.rect[0] ?? d.figure.rect[0]).toBe(95)
})
