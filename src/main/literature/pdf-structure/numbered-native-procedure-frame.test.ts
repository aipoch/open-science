import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { findAlgorithmCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
interface ProcedureInput {
  case: string
  page: {
    pageNumber: number
    width: number
    height: number
    lines: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[]
    graphicsBounds: { kind: string; normalizedRect: number[] }[]
  }
}
const inputs: ProcedureInput[] = readFileSync(
  resolve(
    'src/main/literature/pdf-structure/fixtures/numbered-native-procedures-without-line-ordinals.jsonl'
  ),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

it.each(inputs)('preserves the complete numbered $case native procedure frame', ({ page }) => {
  const result = findAlgorithmCandidates(page)
  expect(result).toHaveLength(1)
  expect(result[0].caption.lines).toEqual([page.lines[0].text])
  expect(result[0].rect[1]).toBeLessThanOrEqual(98)
  expect(result[0].rect[3]).toBeGreaterThanOrEqual(283)
})

it.each(['no-number', 'no-opening', 'no-closing', 'no-structure', 'listing'])(
  'does not turn %s text into a numbered algorithm',
  (missing) => {
    for (const { page: original } of inputs) {
      const page = structuredClone(original)
      if (missing === 'no-number') page.lines[0].text = 'Native procedure'
      if (missing === 'listing') page.lines[0].text = 'Listing 1 Native procedure'
      if (missing === 'no-opening') page.graphicsBounds.shift()
      if (missing === 'no-closing') page.graphicsBounds.pop()
      if (missing === 'no-structure') page.lines = page.lines.slice(0, 2)
      expect(findAlgorithmCandidates(page)).toEqual([])
    }
  }
)

it('requires consecutive Step headings and complete loop controls', () => {
  const [loop, steps] = inputs.map(({ page }) => structuredClone(page))
  loop.lines = loop.lines.filter((line) => !/^end/i.test(line.text))
  expect(findAlgorithmCandidates(loop)).toEqual([])
  const secondStep = steps.lines.find((line) => /^Step 2/.test(line.text))!
  secondStep.text = 'Step 4: Native action'
  expect(findAlgorithmCandidates(steps)).toEqual([])
})

it('requires an indented native body before a conditional can close by dedenting', () => {
  const page = structuredClone(inputs[0].page)
  page.lines.find((line) => line.text === 'Apply the native action')!.x = 65
  expect(findAlgorithmCandidates(page)).toEqual([])
})
