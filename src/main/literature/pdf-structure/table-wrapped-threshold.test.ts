import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = readPdfFixture(
  resolve('src/main/literature/pdf-structure/fixtures/source-grids/wrapped-threshold-label.jsonl')
)

it('joins a flush-left threshold continuation to its populated record', () => {
  const x = structuredClone(fixture)
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toContainEqual(['ECOG performance status <2 (%)', '55 (100)', '42 (100)', '-'])
  expect(r.grid).toContainEqual(['≤50', '30 (54.5)', '27 (64.3)', '0.334'])
  expect(r.grid).toContainEqual(['Pathologic grading', '', '', ''])
  expect(r.repairs).toContain('wrapped-threshold-label-recovered')
  expect(x).toEqual(fixture)
})

it.each(['indented', 'source-rule', 'without-counts'])(
  'preserves a threshold boundary with %s evidence',
  (condition) => {
    const x = structuredClone(fixture)
    const tail = x.tokens.filter(
      (t: { rect: number[] }) => t.rect[1] > 186 && t.rect[1] < 190 && t.rect[0] < 200
    )
    expect(tail.length).toBeGreaterThan(0)
    if (condition === 'indented')
      for (const t of tail) {
        t.rect[0] += 9
        t.rect[2] += 9
      }
    if (condition === 'source-rule') x.rules.push([80, 186, 465, 186])
    if (condition === 'without-counts')
      for (const t of x.tokens.filter(
        (t: { rect: number[] }) => t.rect[1] > 172 && t.rect[1] < 175 && t.rect[0] > 200
      ))
        t.text = 'not reported'
    const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(r.repairs).not.toContain('wrapped-threshold-label-recovered')
  }
)
