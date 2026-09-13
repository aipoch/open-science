import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { isAdjacentTableScript } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-geometry.mjs')).href
)
const fixture = readPdfFixture(
  resolve(
    'src/main/literature/pdf-structure/fixtures/source-grids/repeated-measurement-section.jsonl'
  )
)

it('separates a repeated measurement section and preserves every source value', () => {
  const x = structuredClone(fixture)
  const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  const expected = structuredClone(x.previousGrid)
  expected[0].splice(9, 3, 'DHDEa', 'DHGEa', 'Qa')
  const section = expected.findIndex((r: string[]) => r[0] === 'Plasma Plasma level (nM)')
  expected[section][0] = 'Plasma level (nM)'
  expected.splice(section, 0, ['Plasma', ...Array(11).fill('')])
  expect(result.grid).toEqual(expected)
  expect(result.unassigned).toEqual([])
  for (const name of ['DHDE', 'DHGE', 'Q']) {
    const cell = result.cells.find((c: { text: string }) => c.text === name + 'a')
    expect(cell.textRuns).toEqual([
      { text: name, position: 'normal' },
      { text: 'a', position: 'superscript' }
    ])
  }
})

it.each(['no-counterpart', 'different-quantity', 'too-few-repetitions'])(
  'preserves a section without sufficient repeated-source evidence: %s',
  (condition) => {
    const x = structuredClone(fixture)
    if (condition === 'no-counterpart')
      x.tokens = x.tokens.filter((t: { text: string }) => t.text !== 'Urine')
    if (condition === 'different-quantity')
      for (const t of x.tokens)
        if (t.text.startsWith('Urine level')) t.text = t.text.replace('level', 'amount')
    if (condition === 'too-few-repetitions')
      x.tokens = x.tokens.filter(
        (t: { text: string; rect: number[] }) =>
          !(t.text.startsWith('Plasma level') && t.rect[1] > 620)
      )
    const result = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(result.repairs).not.toContain('repeated-measurement-section-separated')
  }
)

it('recognizes an attached script exactly half an em above its anchor', () => {
  const anchor = fixture.tokens.find((t: { text: string }) => t.text === 'DHDE')
  const marker = fixture.tokens.find(
    (t: { text: string; rect: number[] }) => t.text === 'a' && t.rect[0] > 639 && t.rect[0] < 640
  )
  expect(anchor.baseline - marker.baseline).toBe(anchor.height / 2)
  expect(isAdjacentTableScript(marker, anchor)).toBe(true)
  expect(isAdjacentTableScript({ ...marker, baseline: marker.baseline - 0.01 }, anchor)).toBe(false)
  expect(isAdjacentTableScript({ ...marker, height: anchor.height }, anchor)).toBe(false)
  expect(
    isAdjacentTableScript({ ...marker, rect: [650, marker.rect[1], 653, marker.rect[3]] }, anchor)
  ).toBe(false)
})
