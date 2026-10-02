import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverQuestionnaireGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/numbered-session-with-long-paragraphs.jsonl'
    )
  )
it('keeps each consecutive session and its two long paragraphs in one record', (): void => {
  const f = fixture(),
    r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toHaveLength(6)
  for (let n = 1; n <= 5; n++) expect(r.grid[n][0]).toMatch(new RegExp('^' + n + '\\.'))
  expect(r.unassigned).toEqual([])
  expect(r.cropRect).toEqual(f.table.cropRect)
  const assigned = r.cells.flatMap((c: { sourceRects: number[][] }) =>
    c.sourceRects.map((v) => JSON.stringify(v))
  )
  expect(new Set(assigned).size).toBe(assigned.length)
  expect(assigned.length).toBe(f.tokens.length)
})
for (const name of ['caption', 'sequence', 'header', 'separator', 'segment', 'foreign'] as const)
  it(`rejects unproved session geometry: ${name}`, (): void => {
    const f = fixture()
    if (name === 'caption') f.captions = []
    if (name === 'sequence')
      f.tokens.find(
        (t: { text: string; rect: number[]; baseline: number; height: number }) => t.text === '3.'
      )!.text = '9.'
    if (name === 'header')
      f.tokens.find(
        (t: { text: string; rect: number[]; baseline: number; height: number }) =>
          t.text === 'ontent'
      )!.text = 'Other'
    if (name === 'separator')
      f.rules = f.rules.filter((r: number[]) => Math.abs(r[1] - 137.59275) > 0.01)
    if (name === 'segment')
      f.rules = f.rules.filter((r: number[]) => !(Math.abs(r[1] - 408.5) < 0.01 && r[0] > 570))
    if (name === 'foreign') {
      const t = f.tokens.at(-1)!
      f.tokens.push({ ...t, text: 'Foreign', rect: [570, 370, 600, 383], baseline: 383 })
    }
    expect(recoverQuestionnaireGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  })
