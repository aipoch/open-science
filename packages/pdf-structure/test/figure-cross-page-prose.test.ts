import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { nativeCrossPageProse } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-cross-page-prose.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> => {
  const line = (
    text: string,
    x: number,
    y: number,
    width: number
  ): ReturnType<typeof JSON.parse> => ({
    text,
    x,
    y,
    width,
    height: 10,
    fontSize: 10
  })
  const content = (lines: ReturnType<typeof line>[]): ReturnType<typeof JSON.parse> => ({
    styles: { body: { ascent: 0.8, descent: -0.2, vertical: false } },
    items: lines.map((l) => ({
      str: l.text,
      fontName: 'body',
      width: l.width,
      height: 10,
      dir: 'ltr',
      hasEOL: false,
      transform: [10, 0, 0, 10, l.x, 800 - l.y - 10]
    }))
  })
  const lines = [
    line('of the illustrated process.', 50, 60, 120),
    line('Figure 2. An anonymous process.', 50, 450, 250)
  ]
  const priorLines = [
    line('The preceding paragraph describes an ordinary processing method', 50, 680, 400),
    line('with several stages. Figure 2 presents the complete arrangement', 50, 692, 400),
    line('3/12', 420, 750, 30)
  ]
  const image = { kind: 'image', operationIndex: 1, normalizedRect: [0.1, 0.125, 0.9, 0.55] }
  const page = {
    pageNumber: 4,
    width: 500,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines,
    graphicsBounds: [image]
  }
  const caption = { page: 4, lines: [lines[1].text], rect: [50, 450, 300, 460] }
  const viewport = {
    width: 500,
    height: 800,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 800]
  }
  const current = {
    pageNumber: 4,
    sourceSha256: 'a'.repeat(64),
    viewport,
    content: content(lines),
    graphicsBounds: [image]
  }
  return {
    page,
    bounds: [50, 100, 450, 440],
    caption,
    captions: [caption],
    current,
    previous: {
      sourceSha256: current.sourceSha256,
      currentPageNumber: 4,
      documentPageCount: 12,
      currentContent: structuredClone(current.content),
      previousContent: content(priorLines),
      previousPage: { ...page, pageNumber: 3, lines: priorLines, graphicsBounds: [] },
      previousViewport: viewport
    }
  }
}
const prove = (x: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  nativeCrossPageProse(x.page, x.bounds, x.caption, x.captions, x.current, x.previous)
it('proves a complete cross-page paragraph tail without changing any native source', () => {
  const x = fixture(),
    before = JSON.stringify(x)
  expect(prove(x)?.sourceItems).toEqual([{ pageNumber: 4, index: 0, text: x.page.lines[0].text }])
  expect(JSON.stringify(x)).toBe(before)
})
it('excludes the proved prose at the actual figure association seam only with adjacent evidence', () => {
  const x = fixture()
  x.page.lines[0].y = 78
  x.current.content.items[0].transform[5] = 712
  x.previous.currentContent.items[0].transform[5] = 712
  // A quantized image edge overlaps the caption, so the full-width raster
  // shortcut must defer to the ordinary association and its prose exclusion.
  x.page.lines[1].y = 438
  x.caption.rect = [50, 438, 300, 448]
  x.current.content.items[1].transform[5] = 352
  x.previous.currentContent.items[1].transform[5] = 352
  x.bounds[3] = 436
  expect(prove(x)).toBeDefined()
  const candidates = findCaptionCandidates([x.previous.previousPage, x.page]),
    tokens = x.page.lines.map((line: ReturnType<typeof JSON.parse>, index: number) => ({
      text: line.text,
      sourceItem: { pageNumber: x.page.pageNumber, index, text: line.text },
      rect: [line.x, line.y, line.x + line.width, line.y + line.height],
      baseline: line.y + line.height,
      height: line.height,
      horizontal: true
    })),
    before = JSON.stringify(x),
    original = associateFigures(x.page, candidates, [], [], [], tokens, x.current),
    repaired = associateFigures(x.page, candidates, [], [], [], tokens, x.current, x.previous)
  expect(original).toHaveLength(1)
  expect(repaired).toHaveLength(1)
  expect(original[0].rect[1]).toBe(x.page.lines[0].y)
  expect(repaired[0].rect[1]).toBe(x.bounds[1])
  expect(repaired[0].caption).toEqual(original[0].caption)
  expect(repaired[0].graphicsCount).toBe(original[0].graphicsCount)
  expect(repaired[0].excludedProseLines).toEqual([x.page.lines[0]])
  expect(JSON.stringify(x)).toBe(before)
})
it.each([
  'missing previous',
  'different source',
  'different native font',
  'changed literal',
  'completed paragraph',
  'different reference',
  'other paint',
  'other native text',
  'wrong viewport',
  'incorrect footer total',
  'unmatched previous native item',
  'native geometry mismatch',
  'unlocated current paint',
  'unlocated previous paint',
  'inflated previous geometry',
  'two upper lines'
])('retains the original crop when complete external ownership is absent: %s', (reason) => {
  const x = fixture()
  if (reason === 'missing previous') x.previous = undefined
  if (reason === 'different source') x.previous.sourceSha256 = 'b'.repeat(64)
  if (reason === 'different native font') x.previous.previousContent.items[0].fontName = 'missing'
  if (reason === 'changed literal') x.previous.currentContent.items[0].str += ' changed'
  if (reason === 'completed paragraph') {
    x.previous.previousPage.lines[1].text += '.'
    x.previous.previousContent.items[1].str += '.'
  }
  if (reason === 'different reference') {
    x.previous.previousPage.lines[1].text = x.previous.previousPage.lines[1].text.replace(
      'Figure 2',
      'Figure 7'
    )
    x.previous.previousContent.items[1].str = x.previous.previousPage.lines[1].text
  }
  if (reason === 'other paint') {
    const paint = { kind: 'path', normalizedRect: [0.12, 0.1, 0.14, 0.11] }
    x.page.graphicsBounds.push(paint)
    x.current.graphicsBounds.push(paint)
  }
  if (reason === 'other native text') {
    const i = {
      ...x.previous.currentContent.items[0],
      str: 'Unrelated.',
      transform: [10, 0, 0, 10, 200, 710]
    }
    x.previous.currentContent.items.push(i)
    x.current.content.items.push(i)
  }
  if (reason === 'wrong viewport') x.previous.previousViewport.rotation = 90
  if (reason === 'incorrect footer total') x.previous.documentPageCount = 15
  if (reason === 'unmatched previous native item')
    x.previous.previousContent.items.push({
      ...x.previous.previousContent.items[1],
      str: 'Unreported intervening text.',
      transform: [10, 0, 0, 10, 50, 80]
    })
  if (reason === 'native geometry mismatch') x.previous.currentContent.items[0].transform[4] += 2
  if (reason === 'unlocated current paint') x.page.invalidGraphicsBounds = 1
  if (reason === 'unlocated previous paint') x.previous.previousPage.invalidGraphicsBounds = 1
  if (reason === 'inflated previous geometry') x.previous.previousPage.lines[0].width += 1
  if (reason === 'two upper lines') x.page.lines.unshift({ ...x.page.lines[0], y: 40 })
  expect(prove(x)).toBeUndefined()
})
