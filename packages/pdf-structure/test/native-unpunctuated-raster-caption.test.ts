import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { findCaptionCandidates, captionKind } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
type Line = { text: string; x: number; y: number; width: number; height: number; fontSize: number }
const line = (text: string, y: number, width: number, fontSize = 10): Line => ({
  text,
  x: 80,
  y,
  width,
  height: fontSize,
  fontSize
})
const fixture = (): {
  pageNumber: number
  width: number
  height: number
  invalidGraphicsBounds: number
  lines: Line[]
  graphicsBounds: { kind: string; normalizedRect: number[]; imageHash: string }[]
} => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  invalidGraphicsBounds: 0,
  lines: [
    line('The preceding discussion ends here.', 218, 310, 12),
    line('Fig. 4 The response curves for the compared conditions', 470, 460),
    line('The middle panels show the independent measurements.', 493, 460),
    line('The final panel summarizes the measured differences.', 516, 460),
    line('All values are normalized.', 539, 160),
    { ...line('The following body paragraph starts independently.', 564, 435, 12), x: 104 }
  ],
  graphicsBounds: [
    {
      kind: 'image',
      imageHash: 'anonymous-plate',
      normalizedRect: [80 / 600, 248 / 800, 540 / 600, 462 / 800]
    }
  ]
})

it('associates a complete raster below body prose with its smaller unpunctuated caption', () => {
  const page = fixture(),
    before = structuredClone(page)
  expect(captionKind(page.lines[1].text)).toBeUndefined()
  const captions = findCaptionCandidates([page])
  expect(captions).toHaveLength(1)
  expect(captions[0].lines).toEqual(page.lines.slice(1, 5).map((l) => l.text))
  const figures = associateFigures(page, captions)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect[0]).toBeLessThanOrEqual(80)
  expect(figures[0].rect[1]).toBeLessThanOrEqual(248)
  expect(figures[0].rect[2]).toBeGreaterThanOrEqual(540)
  expect(figures[0].rect[3]).toBeGreaterThanOrEqual(462)
  expect(figures[0].rect[3]).toBeLessThan(470)
  expect(page).toEqual(before)
})

it.each(['body-font', 'intervening-text', 'unknown-paint', 'second-image', 'open-tail'])(
  'does not reclassify an unpunctuated reference without independent proof: %s',
  (kind) => {
    const page = fixture()
    if (kind === 'body-font') for (const l of page.lines.slice(1, 5)) l.fontSize = l.height = 12
    if (kind === 'intervening-text') page.lines.push(line('An unrelated body line.', 454, 300, 12))
    if (kind === 'unknown-paint') page.invalidGraphicsBounds = 1
    if (kind === 'second-image')
      page.graphicsBounds.push({
        kind: 'image',
        imageHash: 'other',
        normalizedRect: [0.2, 0.4, 0.8, 0.5]
      })
    if (kind === 'open-tail') page.lines[4].text = 'All values continue into'
    const captions = findCaptionCandidates([page])
    expect(associateFigures(page, captions).some((f) => f.rect)).toBe(false)
  }
)
