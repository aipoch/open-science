import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { findCaptionCandidates, groupPageLines } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { findNativeCenteredVectorCaptionTail } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-centered-vector-caption-tail.mjs')).href
)

function input(): ReturnType<typeof JSON.parse> {
  const line = (
    text: string,
    x: number,
    y: number,
    width: number,
    fontSize = 10
  ): ReturnType<typeof JSON.parse> => ({
    text,
    x,
    y,
    width,
    height: fontSize,
    fontSize
  })
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    invalidGraphicsBounds: 0,
    lines: [
      line('Figure 1: Complete independent measurements. Vertical markers show', 70, 320, 460),
      line('reference counts for the three independent groups (12, 24, and 36).', 111, 332, 378),
      line('Appendix B. Independent evaluation', 70, 364, 340, 12),
      line('A separate body paragraph remains outside the caption.', 70, 386, 460)
    ],
    graphicsBounds: [{ kind: 'path', normalizedRect: [70 / 600, 160 / 800, 530 / 600, 308 / 800] }]
  }
}

it('retains the unique complete centered vector tail before a distinct larger section heading', () => {
  const p = input(),
    before = structuredClone(p)
  expect(findCaptionCandidates([p])[0].lines).toEqual(
    p.lines.slice(0, 2).map((l: ReturnType<typeof JSON.parse>) => l.text)
  )
  expect(p).toEqual(before)
})

it.each([
  'body-boundary',
  'other-caption',
  'unfinished-tail',
  'extra-line',
  'foreign-paint',
  'no-figure',
  'misaligned-tail',
  'font-change'
])('does not extend the vector caption with %s', (reason) => {
  const p = input()
  if (reason === 'body-boundary') p.lines[2].fontSize = p.lines[2].height = 10
  if (reason === 'other-caption') p.lines[1].text = 'Figure 2: Independent panel.'
  if (reason === 'unfinished-tail') p.lines[1].text = 'reference counts for independent groups and'
  if (reason === 'extra-line')
    p.lines.push({ ...p.lines[1], y: 347, text: 'A distinct neighboring paragraph.' })
  if (reason === 'foreign-paint')
    p.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 330 / 800, 0.4, 340 / 800] })
  if (reason === 'no-figure') p.graphicsBounds = []
  if (reason === 'misaligned-tail') p.lines[1].x += 20
  if (reason === 'font-change') p.lines[1].fontSize = 11
  const runs = groupPageLines(p)
  expect(
    findNativeCenteredVectorCaptionTail(
      runs.find((r: ReturnType<typeof JSON.parse>) => r.text.startsWith('Figure 1:')),
      runs,
      p,
      []
    )
  ).toBeUndefined()
  if (reason !== 'extra-line')
    expect(findCaptionCandidates([p])[0].lines).not.toContain(input().lines[1].text)
})
