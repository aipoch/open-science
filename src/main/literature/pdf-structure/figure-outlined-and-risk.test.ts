import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('src/main/literature/pdf-structure/fixtures', `${name}.jsonl`))
it('retains both stacked survival panels across long numeric risk rows', () => {
  const x = fixture('stacked-survival-curves-with-long-risk-rows')
  const [figure] = associateFigures(x.page, x.captions)
  expect(figure.reason).toBeUndefined()
  expect(figure.rect[1]).toBeLessThan(75)
  expect(figure.rect[3]).toBeGreaterThan(530)
  expect(figure.rect[3]).toBeLessThan(x.captions[0].rect[1])
})
it('recovers a flowchart whose node labels are entirely outlined paths', () => {
  const x = fixture('outlined-flowchart-without-native-labels')
  const [figure] = associateFigures(x.page, x.captions)
  expect(figure.reason).toBeUndefined()
  expect(figure.rect[1]).toBeLessThan(60)
  expect(figure.rect[3]).toBeGreaterThan(600)
})
it('retains small risk counts beneath both survival panels', () => {
  const x = fixture('stacked-survival-curves-with-small-risk-counts'),
    [f] = associateFigures(x.page, x.captions)
  expect(f.rect[1]).toBeLessThan(80)
  expect(f.rect[3]).toBeGreaterThan(700)
})
it('associates a forest plot drawn only with thin axes and outlined labels', () => {
  const x = fixture('outlined-forest-plot-with-thin-reference-axes'),
    [f] = associateFigures(x.page, x.captions)
  expect(f.reason).toBeUndefined()
  expect(f.rect[1]).toBeLessThan(330)
  expect(f.rect[3]).toBeGreaterThan(490)
})
it('keeps native titles and axes when a flowchart is one panel in a larger figure', () => {
  const x = fixture('mixed-flowchart-and-plots-with-native-panel-titles'),
    [f] = associateFigures(x.page, x.captions)
  expect(f.rect[0]).toBeLessThan(92)
  expect(f.rect[1]).toBeLessThan(50)
  expect(f.rect[3]).toBeGreaterThan(478)
})
it('uses repeated rotated axis titles to retain the outer labels of stacked plots', () => {
  const x = fixture('stacked-plots-with-repeated-outdented-axis-titles'),
    [f] = associateFigures(x.page, x.captions)
  expect(f.rect[0]).toBeLessThan(120)
  expect(f.rect[3]).toBeGreaterThan(470)
})
const { excludeRepeatedMarginContent, excludeRemovedMarginTokens } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
)
it('removes diagonal publisher text without removing upright cells covered by its bounding box', () => {
  const x = fixture('diagonal-publication-watermark-over-numeric-cells'),
    pages = excludeRepeatedMarginContent(x.pages)
  expect(pages[0].lines).toEqual([])
  expect(excludeRemovedMarginTokens(x.tokens, x.pages[0], pages[0], 1.5)).toEqual(x.tokens)
})
it('retains risk labels and parenthesized events beneath survival curves', () => {
  const x = fixture('survival-plot-with-parenthesized-risk-events')
  const [figure] = associateFigures(x.page, x.captions)
  expect(figure.rect[0]).toBeLessThan(80)
  expect(figure.rect[3]).toBeGreaterThan(558)
})
it('retains complete confidence intervals beyond both comparison plot axes', () => {
  const x = fixture('paired-comparison-plots-with-outdented-confidence-intervals')
  const figures = associateFigures(x.page, x.captions).sort(
    (a: { rect: number[] }, b: { rect: number[] }) => a.rect[0] - b.rect[0]
  )
  expect(figures).toHaveLength(2)
  expect(figures[0].rect[2]).toBeGreaterThan(260)
  expect(figures[1].rect[2]).toBeGreaterThan(525)
})
it('retains a long middle legend entry aligned with two short neighbours', () => {
  const x = fixture('flowchart-with-long-middle-legend-entry')
  const [figure] = associateFigures(x.page, x.captions)
  expect(figure.rect[2]).toBeGreaterThan(370)
  expect(figure.rect[2]).toBeLessThan(380)
})
it('excludes repeated publisher logos beside a vertical copyright notice', () => {
  const x = fixture('repeated-side-publisher-logo-beside-vertical-copyright')
  const clean = excludeRepeatedMarginContent(x.pages)
  for (const page of clean) {
    expect(page.graphicsBounds).toHaveLength(1)
    expect(page.graphicsBounds[0].normalizedRect[1]).toBeLessThan(0.05)
  }
  const noNotice = x.pages.map((p: { lines: unknown[]; graphicsBounds: unknown[] }) => ({
    ...p,
    lines: []
  }))
  expect(
    excludeRepeatedMarginContent(noNotice).map(
      (p: { graphicsBounds: unknown[] }) => p.graphicsBounds.length
    )
  ).toEqual(noNotice.map((p: { graphicsBounds: unknown[] }) => p.graphicsBounds.length))
})
