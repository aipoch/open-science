import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { findCaptionCandidates, applyRuledCaptionRecovery } = await import(
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
const line = (text: string, x: number, y: number, width: number, fontSize = 10): NativeLine => ({
  text,
  x,
  y,
  width,
  fontSize,
  height: fontSize
})
const page = (
  lines: NativeLine[]
): { pageNumber: number; width: number; height: number; lines: NativeLine[] } => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  lines
})

it('keeps the hanging terminal line below the measured table closing rule', () => {
  const p = page([
    line('Table 2: Measured results and their independently observed comparisons', 50, 250, 450),
    line('are described by the controlled experiment.', 90, 264, 250),
    line('The next body paragraph has its own measured paragraph gap.', 65, 304, 430)
  ])
  const result = findCaptionCandidates([p], new Map([[1, [[50, 238, 500, 238]]]]))
  expect(result[0].lines).toEqual(p.lines.slice(0, 2).map((l) => l.text))
})

it('keeps a slightly outdented short caption definition above the table opening', () => {
  const p = page([
    line('Table 3: Recorded measurements from the independent validation.', 50, 250, 450),
    line('“Offset” is the measured residual; see §4.', 47.5, 264, 240),
    line('Group count response', 90, 290, 240, 9)
  ])
  expect(findCaptionCandidates([p], new Map([[1, [[45, 282, 510, 282]]]]))[0].lines).toEqual(
    p.lines.slice(0, 2).map((l) => l.text)
  )
})

it('keeps a terminal bare table reference inside its proven figure paragraph', () => {
  const p = page([
    line('Figure 2: The complete plotted result complements the analysis in', 50, 250, 430),
    line('Table 7', 50, 264, 35),
    line('A separate body paragraph starts below the caption.', 50, 294, 400, 12)
  ])
  const result = findCaptionCandidates([p])
  expect(result).toHaveLength(1)
  expect(result[0].lines).toEqual(p.lines.slice(0, 2).map((l) => l.text))
})

it('retains same-baseline prose across an owned formula and literal negative exponent', () => {
  const p = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/native-caption-negative-exponent.jsonl')
  ).page
  const result = findCaptionCandidates([p])[0]
  expect(result.lines[1]).toBe('A density of 8 units⁻² belongs to the measured contour.')
})

it('does not bridge a column gutter, absorb a separate caption or a body paragraph', () => {
  const p = page([
    line('Table 2: Complete caption.', 50, 250, 230),
    line('Foreign prose in the other column.', 350, 264, 200),
    line('Table 3: A separate caption.', 50, 284, 230),
    line('A separate body paragraph.', 65, 304, 230)
  ])
  const result = findCaptionCandidates([p], new Map([[1, [[50, 238, 280, 238]]]]))
  expect(result[0].lines).toEqual([p.lines[0].text])
})

it('retains both literal operands of a source-witnessed short fraction without synthesizing punctuation', () => {
  const p = page([
    line('Figure 5: Complete native probability comparison.', 50, 250, 420),
    line('The measured probability is', 50, 264, 120),
    line('k+1', 174, 262, 20, 7),
    line('2', 181, 270, 6, 7),
    line('in the complete source statement.', 198, 264, 230),
    line('The native terminal sentence.', 50, 278, 300)
  ])
  const c = findCaptionCandidates([p], new Map([[1, [[174, 271, 194, 271]]]]))[0]
  expect(c.lines[1]).toBe('The measured probability is k+1 2 in the complete source statement.')
  expect(c.lines.join(' ')).not.toContain('/')
})

it('recovers only a unique figure with the same formal ordinal and source position', () => {
  const original = { page: 1, lines: ['Figure A.2: Probability P ≈ 1.'], rect: [50, 250, 480, 278] }
  const recovered = {
    ...original,
    lines: ['Figure A.2: Probability P ≈ 1 2.'],
    rect: [50, 250, 480, 282]
  }
  const p = page([])
  for (const wrong of [
    { ...recovered, lines: ['Figure A.3: Probability P ≈ 1 2.'] },
    { ...recovered, rect: [50, 280, 480, 310] },
    { ...recovered, rect: [350, 250, 580, 282] },
    { ...recovered, page: 2 }
  ]) {
    const c = structuredClone(original)
    applyRuledCaptionRecovery([c], [wrong], p, [])
    expect(c).toEqual(original)
  }
  const ambiguous = structuredClone(original)
  applyRuledCaptionRecovery([ambiguous], [recovered, structuredClone(recovered)], p, [])
  expect(ambiguous).toEqual(original)
  const c = structuredClone(original)
  applyRuledCaptionRecovery([c], [recovered], p, [])
  expect(c).toEqual(recovered)
})

it('does not move a distant source fraction into the closest caption row', () => {
  const p = page([
    line('1', 120, 80, 6, 7),
    line('2', 120, 88, 6, 7),
    line('Figure 8: A complete measured native comparison.', 50, 250, 420),
    line('The measured density is', 50, 264, 120),
    line('units', 174, 264, 22),
    line('−2', 196, 262, 8, 7),
    line('in the independent measurement.', 208, 264, 225),
    line('The complete terminal description.', 50, 278, 420)
  ])
  const result = findCaptionCandidates([p], new Map([[1, [[120, 89, 126, 89]]]]))[0]
  expect(result.lines).toEqual(findCaptionCandidates([p])[0].lines)
  expect(result.lines.join(' ')).not.toContain('1 2')
})
