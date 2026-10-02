import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/native-caption-centered-tail-and-font-switch.jsonl'
    )
  )
it('keeps the centered final native sentence under its own raster caption', () => {
  const p = input().pages[0]
  const c = findCaptionCandidates([p])
  expect(c[0].lines).toHaveLength(2)
  expect(c[0].lines[1]).toBe(p.lines[1].text)
  expect(c[0].rect[3]).toBeCloseTo(p.lines[1].y + p.lines[1].height)
})
it.each([
  'complete-first-sentence',
  'foreign-graphic',
  'different-font',
  'far-leading',
  'foreign-row'
])('rejects an unproved centered tail: %s', (reason) => {
  const p = input().pages[0]
  if (reason === 'complete-first-sentence') p.lines[0].text += '.'
  if (reason === 'foreign-graphic') p.graphicsBounds = []
  if (reason === 'different-font') p.lines[1].fontSize *= 1.3
  if (reason === 'far-leading') p.lines[1].y += 20
  if (reason === 'foreign-row')
    p.lines.push({ ...p.lines[1], x: p.lines[0].x, width: 30, text: 'Foreign' })
  expect(findCaptionCandidates([p])[0].lines).not.toContain(p.lines[1].text)
})
it('keeps source pieces across same-line font switches and an adjoining radical fragment', () => {
  const p = input().pages[1]
  const c = findCaptionCandidates([p])[0]
  const tail = p.lines.at(-1).text
  expect(c.lines.join(' ')).toContain(tail)
  expect(c.lines.join(' ')).toContain(
    p.lines.find((l: ReturnType<typeof JSON.parse>) => l.x > 275 && l.y > 600 && l.y < 610).text
  )
})
it('does not bridge a detached same-line fragment across a column gutter', () => {
  const p = input().pages[1]
  const last = p.lines.at(-1)
  last.x += 30
  last.width -= 30
  expect(findCaptionCandidates([p])[0].lines.join(' ')).not.toContain(last.text)
})

const radicalInput = (): ReturnType<typeof JSON.parse> => ({
  pageNumber: 1,
  width: 612,
  height: 792,
  graphicsBounds: [],
  lines: [
    {
      text: 'FIG. S1. Native comparison of several independent measurements, with complete literal source pieces retained in this caption',
      fontSize: 8.9664,
      x: 54,
      y: 241.1316,
      width: 508.099,
      height: 8.9664
    },
    {
      text: 'The measurements use the same scale and the displayed native symbols, followed by a complete physical source caption line',
      fontSize: 8.9664,
      x: 54,
      y: 251.5926,
      width: 508.099,
      height: 8.9664
    },
    {
      text: 'The native dependence is shown by the literal source pair, q ∝',
      fontSize: 8.9664,
      x: 54,
      y: 262.0536,
      width: 227.91692,
      height: 8.9664
    },
    { text: '√', fontSize: 8.9664, x: 283.644, y: 254.5886, width: 7.4717, height: 8.9664 },
    {
      text: 'R, using the native source measurement and the matching displayed curve',
      fontSize: 8.9664,
      x: 291.113,
      y: 262.0536,
      width: 270.9825,
      height: 8.9664
    },
    {
      text: 'The complete source caption ends with this physical sentence.',
      fontSize: 8.9664,
      x: 54,
      y: 272.5146,
      width: 177.8037,
      height: 8.9664
    }
  ]
})
it('keeps a unique native radical bridge with overlapping font boxes inside a complete caption', () => {
  const p = radicalInput()
  const c = findCaptionCandidates([p])[0]
  expect(c.lines.join(' ')).toContain('q ∝ √ R, using the native source measurement')
  expect(c.rect).toEqual([54, 241.1316, 562.0989999999999, 281.481])
})
it.each(['foreign-font', 'far-gap', 'no-overlap', 'ambiguous-bridge', 'ordinary-short-run'])(
  'rejects an unproved radical caption bridge: %s',
  (reason) => {
    const p = radicalInput(),
      radical = p.lines[3]
    if (reason === 'foreign-font') radical.fontSize *= 1.3
    if (reason === 'far-gap') radical.x += 1
    if (reason === 'no-overlap') radical.y -= 3
    if (reason === 'ambiguous-bridge') p.lines.push({ ...radical })
    if (reason === 'ordinary-short-run') radical.text = 'XY'
    expect(findCaptionCandidates([p])[0].lines.join(' ')).not.toContain(p.lines[4].text)
  }
)
