import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { nativeRasterCaptionColumn } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-raster-column.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> => {
  const captions = [
    { page: 1, lines: ['Figure 1: Three panels.'], rect: [60, 650, 290, 680] },
    { page: 1, lines: ['Figure 2: Another panel.'], rect: [320, 280, 550, 310] }
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: captions.map((c) => ({
      text: c.lines[0],
      x: c.rect[0],
      y: c.rect[1],
      width: 230,
      height: 10,
      fontSize: 10
    })),
    graphicsBounds: [
      ...[60, 250, 440].map((y) => ({
        kind: 'image',
        normalizedRect: [70 / 600, y / 800, 285 / 600, (y + 180) / 800]
      })),
      { kind: 'image', normalizedRect: [325 / 600, 60 / 800, 545 / 600, 265 / 800] }
    ]
  }
  page.lines.push(
    ...[230, 420, 610].map((y, i) => ({
      text: `(${String.fromCharCode(97 + i)})`,
      x: 50,
      y,
      width: 10,
      height: 10,
      fontSize: 10
    }))
  )
  return { page, captions }
}
it('recovers both disjoint caption columns with all three native raster panels', () => {
  const f = input()
  const r = associateFigures(f.page, f.captions)
  expect(r.map((v: ReturnType<typeof JSON.parse>) => v.rect)).toEqual([
    [50, 60, 285, 620],
    [325, 60, 545, 265]
  ])
})
it.each([
  'missing-panel-label',
  'foreign-prose',
  'large-gap',
  'competing-caption',
  'foreign-table'
])('rejects an unproved raster column: %s', (reason) => {
  const f = input()
  if (reason === 'missing-panel-label') f.page.lines.pop()
  if (reason === 'foreign-prose')
    f.page.lines.push({
      text: 'Independent prose sentence. '.repeat(4),
      x: 80,
      y: 300,
      width: 190,
      height: 10,
      fontSize: 10
    })
  if (reason === 'large-gap') f.page.graphicsBounds[1].normalizedRect[1] = 0.5
  if (reason === 'competing-caption') f.captions[1].rect = [80, 280, 310, 310]
  expect(
    nativeRasterCaptionColumn(
      f.page,
      f.captions[0],
      f.captions,
      reason === 'foreign-table' ? [[80, 300, 260, 320]] : []
    )
  ).toBeUndefined()
})
