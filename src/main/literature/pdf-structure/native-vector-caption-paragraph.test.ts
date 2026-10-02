import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
type NativePage = {
  pageNumber: number
  width: number
  height: number
  lines: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[]
  graphicsBounds: { kind: string; normalizedRect: number[] }[]
}
const source = (): NativePage =>
  (
    readPdfFixture(
      resolve('src/main/literature/pdf-structure/fixtures/native-vector-caption-paragraph.jsonl')
    ) as { page: NativePage }
  ).page

it('keeps a complete uniformly spaced caption under fragmented native vector panels', () => {
  const p = source()
  const result = findCaptionCandidates([p])
  expect(result).toHaveLength(1)
  expect(result[0].lines).toEqual(p.lines.slice(0, 3).map((l) => l.text))
  expect(result[0].rect).toEqual([50, 200, 530, 246])
})

it('requires numbered source ownership, full fragment geometry and consistent paragraph type', () => {
  const p = source()
  for (const changed of [
    { ...p, graphicsBounds: [] },
    { ...p, graphicsBounds: p.graphicsBounds.slice(0, 1) },
    { ...p, lines: p.lines.map((l, i) => (i === 2 ? { ...l, y: 255 } : l)) },
    { ...p, lines: p.lines.map((l, i) => (i === 2 ? { ...l, fontSize: 12 } : l)) },
    { ...p, lines: p.lines.map((l, i) => (i === 2 ? { ...l, x: 80 } : l)) }
  ])
    expect(findCaptionCandidates([changed])[0].lines.length).toBeLessThan(3)
})

it('does not include a separate Note or an intervening native prose block', () => {
  const p = source()
  const note = {
    ...p.lines[2],
    text: 'Note: Separate annotation remains outside the numbered caption.',
    y: 254
  }
  expect(findCaptionCandidates([{ ...p, lines: [...p.lines.slice(0, 3), note] }])[0].lines).toEqual(
    p.lines.slice(0, 3).map((l) => l.text)
  )
  const foreign = {
    text: 'An intervening full-width native prose paragraph has independent source ownership.',
    x: 50,
    y: 178,
    width: 480,
    height: 10,
    fontSize: 10
  }
  expect(findCaptionCandidates([{ ...p, lines: [...p.lines, foreign] }])[0].lines).toHaveLength(1)
})

it('keeps a lowercase figure word inside the uniquely owned numbered paragraph', () => {
  const p = source()
  p.lines = p.lines.slice(0, 3).map((l, i) => ({
    ...l,
    y: 200 + i * 13,
    text: i === 1 ? 'figure. This continuation describes the same native panels and' : l.text
  }))
  const result = findCaptionCandidates([p])
  expect(result).toHaveLength(1)
  expect(result[0].lines).toEqual(p.lines.map((l) => l.text))
  const separate = {
    ...p,
    lines: p.lines.map((l, i) =>
      i === 1 ? { ...l, text: 'Figure 9. Independent descriptor of another native figure.' } : l
    )
  }
  expect(findCaptionCandidates([separate])).toHaveLength(2)
  expect(findCaptionCandidates([separate])[0].lines).toHaveLength(1)
})

it('uses the same source paragraph proof for a fragmented native image array', () => {
  const p = source()
  p.graphicsBounds = p.graphicsBounds.map((g) => ({ ...g, kind: 'image' }))
  expect(findCaptionCandidates([p])[0].lines).toEqual(p.lines.slice(0, 3).map((l) => l.text))
})
