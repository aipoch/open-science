import { readPdfFixture } from './read-fixture'
import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeIndexedDirectoryGrid } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-bounded-text-record-grid.mjs')
  ).href
)
type Token = { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean }
const item = (text: string, x: number, y: number, width: number): Token => ({
  text,
  rect: [x, y, x + width, y + 10],
  height: 10,
  baseline: y + 10,
  horizontal: true
})
const input = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/indexed-directory-with-long-source-records.jsonl'
    )
  )
it('keeps all wrapped fields under their independently printed indexed record starts', () => {
  const f = input(),
    r = refineTable(f.table, f.tokens, [], [], f.rules)
  expect(r.grid).toEqual([
    ['ID', 'Task', 'Source'],
    [
      'D07',
      'Alpha and its continuation',
      'scripts/run_alpha.py contains complete evidence. Further evidence is preserved and replayed in full.'
    ],
    ['D08', 'Beta', 'scripts/run_beta.py with final evidence.']
  ])
  expect(r.unassigned).toEqual([])
})
it('declines ambiguous record starts, source gutter crossings, and unbounded terminal text', () => {
  const f = input()
  f.tokens[10].text = 'D10'
  expect(recoverNativeIndexedDirectoryGrid(f.table, f.tokens, f.rules)).toBeUndefined()
  const g = input()
  g.tokens[6].rect[2] = 310
  expect(recoverNativeIndexedDirectoryGrid(g.table, g.tokens, g.rules)).toBeUndefined()
  const h = input()
  expect(recoverNativeIndexedDirectoryGrid(h.table, h.tokens, h.rules.slice(0, 2))).toBeUndefined()
  h.tokens.push(item('9', 290, 330, 10))
  expect(recoverNativeIndexedDirectoryGrid(h.table, h.tokens, h.rules.slice(0, 2))).toBeDefined()
  h.tokens.push(item('Ordinary prose beyond the candidate.', 50, 270, 250))
  expect(recoverNativeIndexedDirectoryGrid(h.table, h.tokens, h.rules.slice(0, 2))).toBeUndefined()
})
