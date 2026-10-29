import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { findCaptionCandidates, groupPageLines, captionKind } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { nativeConditionalFigureReference } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-conditional-figure-reference.mjs')).href
)
type NativeLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}
type NativePage = {
  pageNumber: number
  width: number
  height: number
  rotation: number
  invalidGraphicsBounds: number
  graphicsBounds: { kind: string; operationIndex: number; normalizedRect: number[] }[]
  lines: NativeLine[]
}
function page(): NativePage {
  const line = (text: string, x: number, y: number, width: number): NativeLine => ({
    text,
    x,
    y,
    width,
    height: 10,
    fontSize: 10
  })
  return {
    pageNumber: 1,
    width: 400,
    height: 300,
    rotation: 0,
    invalidGraphicsBounds: 0,
    graphicsBounds: [
      { kind: 'image', operationIndex: 1, normalizedRect: [0.15, 0.1, 0.85, 1 / 3] }
    ],
    lines: [
      line('Figure 2: A complete independent picture', 60, 110, 280),
      line('showing the resolved directions.', 60, 124, 250),
      line('Fig. 2. If A has the retained columns, the general-', 40, 155, 320),
      line('ized problem is restricted to their span,', 40, 169, 280),
      line('A x = b, (3)', 150, 185, 180),
      line('with the complete solution in this subspace.', 40, 210, 300)
    ]
  }
}
it('excludes the complete conditional body reference beside its independently printed figure caption', () => {
  const p = page(),
    before = JSON.stringify(p),
    out = findCaptionCandidates([p])
  expect(out.filter((c: { lines: string[] }) => c.lines[0].startsWith('Fig. 2. If '))).toHaveLength(
    0
  )
  expect(out.filter((c: { lines: string[] }) => c.lines[0].startsWith('Figure 2: '))).toHaveLength(
    1
  )
  expect(JSON.stringify(p)).toBe(before)
})
it.each([
  'missing-caption',
  'other-number',
  'duplicate-caption',
  'incomplete-caption',
  'missing-graphic',
  'intervening-graphic',
  'next-independent-graphic',
  'incomplete-body',
  'no-equation',
  'invalid-native-bounds',
  'unsafe-font',
  'independent-if-caption'
])('retains caption candidates without the complete independent context: %s', (fault) => {
  const p = page()
  if (fault === 'missing-caption') p.lines.splice(0, 2)
  if (fault === 'other-number') p.lines[0].text = p.lines[0].text.replace('2:', '3:')
  if (fault === 'duplicate-caption') p.lines.unshift({ ...p.lines[0], y: 95 })
  if (fault === 'incomplete-caption') p.lines[1].text = 'continuing caption without an ending'
  if (fault === 'missing-graphic') p.graphicsBounds = []
  if (fault === 'intervening-graphic')
    p.graphicsBounds.push({
      kind: 'image',
      operationIndex: 2,
      normalizedRect: [0.2, 0.5, 0.7, 0.7]
    })
  if (fault === 'next-independent-graphic')
    p.graphicsBounds.push({
      kind: 'image',
      operationIndex: 2,
      normalizedRect: [0.2, 0.76, 0.8, 0.96]
    })
  if (fault === 'incomplete-body') p.lines.at(-1)!.text = 'with a continuing argument'
  if (fault === 'no-equation') p.lines[4].text = 'Unrelated centered text'
  if (fault === 'invalid-native-bounds') p.invalidGraphicsBounds = 1
  if (fault === 'unsafe-font') p.lines[3].fontSize = 0
  if (fault === 'independent-if-caption')
    p.lines[2].text = 'Fig. 2. If the parameter is small, errors in the two panels.'
  const runs = groupPageLines(p),
    start = runs.find((r: { text: string }) => r.text.startsWith('Fig. 2. If '))
  expect(nativeConditionalFigureReference(start, runs, p)).toBe(false)
})
it('keeps the isolated conditional string as a candidate without inventing page context', () => {
  expect(captionKind('Fig. 2. If a parameter is small, the errors are reduced.')).toBe('figure')
})
