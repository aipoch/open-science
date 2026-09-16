import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
type Fixture = {
  page: {
    pageNumber: number
    width: number
    height: number
    lines: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[]
    graphicsBounds: { kind: string; normalizedRect: number[] }[]
  }
  captions: { page: number; lines: string[]; rect: number[] }[]
}
const fixture = (name: string): Fixture =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', `${name}.jsonl`))

it('keeps all dispersed raster panels and native labels on a numbered landscape plate', () => {
  const f = fixture('standalone-dispersed-raster-panels'),
    original = structuredClone(f)
  const [figure] = associateFigures(f.page, f.captions)
  expect(figure.rect).toEqual([0, 0, 720, 537.890625])
  for (const g of f.page.graphicsBounds.filter((g) => g.kind === 'image')) {
    const r = g.normalizedRect.map((v, i) => v * (i % 2 ? f.page.height : f.page.width))
    expect(r[0]).toBeGreaterThanOrEqual(figure.rect[0])
    expect(r[2]).toBeLessThanOrEqual(figure.rect[2])
    expect(r[1]).toBeGreaterThanOrEqual(figure.rect[1])
    expect(r[3]).toBeLessThanOrEqual(figure.rect[3])
  }
  expect(f).toEqual(original)
})

it('includes the large panel labels and outer tick labels of a four-panel vector plate', () => {
  const f = fixture('standalone-vector-panel-labels')
  const [figure] = associateFigures(f.page, f.captions)
  expect(figure.rect[0]).toBeCloseTo(7.2)
  expect(figure.rect[1]).toBe(0)
  expect(figure.rect[2]).toBeCloseTo(700.3125)
  expect(figure.rect[3]).toBeCloseTo(536.46)
  // Repeated identical path bounds count once during association.
  expect(figure.graphicsCount).toBe(50)
  const repeated = {
    ...f.page,
    graphicsBounds: [...f.page.graphicsBounds, ...f.page.graphicsBounds]
  }
  expect(associateFigures(repeated, f.captions)[0]).toEqual(figure)
})

it('does not infer a standalone plate from ordinary prose, another caption, or a table', () => {
  const f = fixture('standalone-dispersed-raster-panels')
  const expectNotPlate = (
    page: Fixture['page'],
    captions = f.captions,
    tables: number[][] = []
  ): void => {
    expect(associateFigures(page, captions, tables)[0]?.rect).not.toEqual([0, 0, 720, 537.890625])
  }
  expectNotPlate({ ...f.page, lines: f.page.lines.map((l) => ({ ...l, fontSize: 9 })) })
  expectNotPlate({ ...f.page, width: 540, height: 720 })
  expectNotPlate(f.page, [
    ...f.captions,
    { page: 33, lines: ['Figure 2. Another result'], rect: [0, 250, 250, 280] }
  ])
  expectNotPlate(f.page, f.captions, [[0, 250, 250, 450]])
  expectNotPlate(
    f.page,
    f.captions.map((c) => ({ ...c, lines: ['Figure 1. A paragraph caption'] }))
  )
})
