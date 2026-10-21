import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- infer typed synthetic geometry
const page = (closed = false, terminal = true) => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  invalidGraphicsBounds: 0,
  lines: [
    {
      text: closed
        ? 'Figure 1: Independent observations. (a) Measured distributions.'
        : 'Figure 1: Independent observations and measured distributions with',
      x: 90,
      y: 400,
      width: 420,
      height: 9,
      fontSize: 9
    },
    {
      text: closed
        ? '(b) Remaining measured distributions.'
        : `additional independent measurements${terminal ? '.' : ''}`,
      x: 220,
      y: 410.5,
      width: 160,
      height: 9,
      fontSize: 9
    },
    { text: 'Independent discussion', x: 70, y: 442, width: 180, height: 12, fontSize: 12 }
  ],
  graphicsBounds: [{ kind: 'image', normalizedRect: [0.12, 0.1, 0.88, 0.49] }]
})

it('retains a page-end legend ending in a parenthesized bibliographic year', () => {
  const input = page()
  input.graphicsBounds[0].normalizedRect = [0.15, 0.1, 0.85, 0.48]
  input.lines = [
    {
      text: 'Figure 1. Independent measured observations and reference values.',
      x: 90,
      y: 400,
      width: 420,
      height: 10,
      fontSize: 10
    },
    {
      text: 'Open symbols: measured observations from the independent source',
      x: 90,
      y: 420,
      width: 420,
      height: 10,
      fontSize: 10
    },
    {
      text: 'and reference values. Solid lines: the complete predicted response.',
      x: 90,
      y: 440,
      width: 420,
      height: 10,
      fontSize: 10
    },
    {
      text: 'Dotted lines: predictions by Example (2001)',
      x: 90,
      y: 460,
      width: 210,
      height: 10,
      fontSize: 10
    },
    { text: '1', x: 295, y: 750, width: 10, height: 12, fontSize: 12 }
  ]
  expect(findCaptionCandidates([input])[0].lines).toEqual(
    input.lines.slice(0, 4).map((l) => l.text)
  )
  const noGraphic = { ...input, graphicsBounds: [] }
  expect(findCaptionCandidates([noGraphic])[0].lines).toHaveLength(1)
})

it.each([
  [false, true],
  [true, true],
  [false, false]
])(
  'retains a complete centered raster caption with a closed opener %s and terminal tail %s',
  (closed, terminal) => {
    const input = page(closed, terminal)
    expect(findCaptionCandidates([input])[0].lines).toEqual(
      input.lines.slice(0, 2).map((l) => l.text)
    )
  }
)

it.each(['graphic', 'center', 'font', 'gap', 'intervening', 'competing', 'body'])(
  'requires independent ownership of the centered tail (%s)',
  (missing) => {
    const input = page()
    if (missing === 'graphic') input.graphicsBounds = []
    if (missing === 'center') input.lines[1].x += 20
    if (missing === 'font') input.lines[1].fontSize = 11
    if (missing === 'gap') input.lines[1].y += 15
    if (missing === 'intervening')
      input.lines.push({
        text: 'An intervening native paragraph.',
        x: 90,
        y: 392,
        width: 280,
        height: 8,
        fontSize: 9
      })
    if (missing === 'competing') input.graphicsBounds.push({ ...input.graphicsBounds[0] })
    if (missing === 'body')
      input.lines.push({
        text: 'Another same-font paragraph continues.',
        x: 90,
        y: 422,
        width: 420,
        height: 9,
        fontSize: 9
      })
    expect(findCaptionCandidates([input])[0].lines).toEqual([input.lines[0].text])
  }
)
