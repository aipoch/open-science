import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'
const { findCaptionCandidates, groupNativeCaptionFragments } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
type NativeLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}
const line = (text: string, x: number, y: number, width: number): NativeLine => ({
  text,
  x,
  y,
  width,
  height: 9,
  fontSize: 9
})
const page = (
  lines: NativeLine[]
): {
  pageNumber: number
  width: number
  height: number
  lines: NativeLine[]
  graphicsBounds: { kind: string; normalizedRect: number[] }[]
} => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  lines,
  graphicsBounds: [{ kind: 'image', normalizedRect: [0.1, 0.1, 0.9, 0.23] }]
})

it('retains a uniformly spaced hanging caption below its native graphic', () => {
  const lines = [
    line('Figure 4 First native descriptor continues onto', 60, 200, 480),
    line('another line with complete source text and', 114, 215.5, 426),
    line('a final native descriptor.', 114, 231, 220)
  ]
  expect(findCaptionCandidates([page(lines)])[0].lines).toEqual(lines.map((l) => l.text))
})
it('keeps each native tall-formula fragment in the unique raster legend', () => {
  const { page: source } = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/native-raster-caption-with-tall-formula-fragments.jsonl'
    )
  ) as { page: ReturnType<typeof page> }
  const caption = findCaptionCandidates([source])[0]
  const rows = groupNativeCaptionFragments(source.lines, 9)
  expect(rows.flatMap((r: { parts: NativeLine[] }) => r.parts)).toHaveLength(source.lines.length)
  expect(new Set(rows.flatMap((r: { parts: NativeLine[] }) => r.parts))).toEqual(
    new Set(source.lines)
  )
  expect(caption.lines).toHaveLength(3)
  for (const part of source.lines) expect(caption.lines.join(' ')).toContain(part.text)
  expect(caption.rect).toEqual([60, 200, 530, 247])
  for (const altered of [
    { ...source, graphicsBounds: [] },
    { ...source, lines: source.lines.map((l, i) => (i === 2 ? { ...l, x: 100 } : l)) },
    { ...source, lines: source.lines.map((l, i) => (i === 2 ? { ...l, fontSize: 16 } : l)) }
  ]) {
    expect(findCaptionCandidates([altered])[0].lines.length).toBeLessThan(3)
  }
})
it('retains centered same-type caption tails below a full native closing rule', () => {
  const lines = [
    line('Table 3 First native descriptor continues with', 60, 200, 480),
    line('a centered descriptive continuation and', 64, 215.5, 472),
    line('a short final descriptor.', 220, 231, 160)
  ]
  const rules = new Map([[1, [[60, 190, 540, 190]]]])
  expect(findCaptionCandidates([page(lines)], rules)[0].lines).toEqual(lines.map((l) => l.text))
})
it('does not absorb a same-type neighboring paragraph across a changed indent', () => {
  const lines = [
    line('Figure 4 First native descriptor continues onto', 60, 200, 480),
    line('another line with complete source text and', 114, 215.5, 426),
    line('a final native descriptor.', 114, 231, 220),
    line('An unrelated paragraph begins here.', 60, 246.5, 250)
  ]
  expect(findCaptionCandidates([page(lines)])[0].lines).toEqual(
    lines.slice(0, 3).map((l) => l.text)
  )
})
it('requires native ownership, matching type and consistent leading', () => {
  const lines = [
    line('Figure 4 First native descriptor continues onto', 60, 200, 480),
    line('another line with complete source text and', 114, 215.5, 426),
    line('a final native descriptor.', 114, 231, 220)
  ]
  for (const changed of [
    { ...page(lines), graphicsBounds: [] },
    page(lines.map((l, i) => (i === 1 ? { ...l, fontSize: 12 } : l))),
    page(lines.map((l, i) => (i === 2 ? { ...l, y: 250 } : l)))
  ]) {
    expect(findCaptionCandidates([changed])[0].lines).toEqual([lines[0].text])
  }
})

it('keeps an unfinished mixed caption only at an otherwise empty page end', () => {
  const lines = [
    line('Figure 7. Native descriptor continues on the following', 60, 660, 420),
    {
      ...line('a formula ( ) with an unfinished native continuation', 60, 678, 470),
      fontSize: 13,
      height: 13
    },
    line('1', 294, 702, 12)
  ]
  const p = {
    ...page(lines),
    graphicsBounds: [{ kind: 'path', normalizedRect: [0.15, 0.4, 0.85, 0.81] }]
  }
  expect(findCaptionCandidates([p])[0].lines).toHaveLength(2)
  const foreign = {
    ...p,
    lines: [...lines, line('A foreign paragraph starts at another indent.', 80, 696, 350)]
  }
  expect(findCaptionCandidates([foreign])[0].lines).toHaveLength(1)
  expect(findCaptionCandidates([{ ...p, graphicsBounds: [] }])[0].lines).toHaveLength(1)
})
