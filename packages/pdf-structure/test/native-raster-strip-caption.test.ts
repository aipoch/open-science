import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { findCaptionCandidates, captionKind, nativeRasterStripCaption } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
type Line = { text: string; x: number; y: number; width: number; height: number; fontSize: number }
const line = (text: string, y: number, width: number, fontSize = 8): Line => ({
  text,
  x: 55,
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
  graphicsBounds: { kind: string; imageHash: string; normalizedRect: number[] }[]
} => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  invalidGraphicsBounds: 0,
  lines: [
    line('Anonymous authors and affiliation', 145, 400, 12),
    line('Fig. 7. Our method enables autonomous evaluation across several conditions', 288, 500),
    line('All panels show the same independent trial.', 297, 270),
    line('The following discussion begins independently.', 315, 240, 10),
    { ...line('A separate right column begins here.', 314, 240, 10), x: 315 }
  ],
  graphicsBounds: Array.from({ length: 4 }, (_, index) => ({
    kind: 'image',
    imageHash: `anonymous-panel-${index}`,
    normalizedRect: [(55 + index * 125) / 600, 170 / 800, (180 + index * 125) / 600, 281 / 800]
  }))
})

it('admits a complete smaller caption below an independently bounded native raster strip', () => {
  const page = fixture(),
    before = structuredClone(page)
  expect(captionKind(page.lines[1].text)).toBeUndefined()
  const captions = findCaptionCandidates([page])
  expect(captions).toHaveLength(1)
  expect(captions[0].lines).toEqual(page.lines.slice(1, 3).map((l) => l.text))
  expect(nativeRasterStripCaption(page, captions[0])).toBe(true)
  const figures = associateFigures(page, captions)
  expect(figures).toHaveLength(1)
  figures[0].rect.forEach((value, axis) => expect(value).toBeCloseTo([55, 170, 555, 281][axis], 8))
  expect(page).toEqual(before)
})

it.each([
  'unknown',
  'single-image',
  'unhashed',
  'unequal-band',
  'far-image',
  'body-font',
  'open-tail',
  'foreign-text',
  'separator',
  'foreign-graphic'
])(
  'does not admit a finite-sentence reference without complete independent context: %s',
  (kind) => {
    const page = fixture(),
      rules: number[][] = []
    if (kind === 'unknown') page.invalidGraphicsBounds = 1
    if (kind === 'single-image') page.graphicsBounds.splice(1)
    if (kind === 'unhashed') page.graphicsBounds[1].imageHash = ''
    if (kind === 'unequal-band') page.graphicsBounds[1].normalizedRect[1] -= 0.05
    if (kind === 'far-image')
      for (const graphic of page.graphicsBounds) graphic.normalizedRect[3] -= 0.05
    if (kind === 'body-font')
      for (const row of page.lines.slice(1, 3)) row.height = row.fontSize = 10
    if (kind === 'open-tail') page.lines[2].text = 'The same trial continues into'
    if (kind === 'foreign-text') page.lines.push(line('An unrelated label.', 283, 180))
    if (kind === 'separator') rules.push([55, 285, 555, 285])
    if (kind === 'foreign-graphic')
      page.graphicsBounds.push({
        kind: 'path',
        imageHash: '',
        normalizedRect: [0.2, 283 / 800, 0.4, 285 / 800]
      })
    expect(findCaptionCandidates([page], new Map([[1, rules]]))).toHaveLength(0)
  }
)

it('rechecks the exact caption paragraph, page and bounds during association', () => {
  const page = fixture(),
    caption = findCaptionCandidates([page])[0]
  for (const mode of ['extra-row', 'page', 'bounds']) {
    const changed = structuredClone(caption)
    if (mode === 'extra-row') changed.lines.push('An invented continuation.')
    if (mode === 'page') changed.page = 2
    if (mode === 'bounds') changed.rect[0] -= 2
    expect(nativeRasterStripCaption(page, changed)).toBe(false)
  }
})
