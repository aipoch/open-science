import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/sparse-dose-record-in-native-gap.jsonl'
    )
  )
it('retains a complete native dose record with an empty ancestor and shared probability', () => {
  const f = load()
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid).toContainEqual(['', '12 / 6', '8 (80%)', '7 (70%)', ''])
  expect(t.unassigned).toEqual([])
})
it('gives a sparse measured baseline one owner when two predicted bands overlap it', () => {
  const f = load()
  f.table.structure.objects.push(
    { label: 'table row', rect: [0, 31, 400, 41] },
    { label: 'table row', rect: [0, 35, 400, 45] }
  )
  const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid.filter((r: string[]) => r[1] === '12 / 6')).toEqual([
    ['', '12 / 6', '8 (80%)', '7 (70%)', '']
  ])
  expect(t.unassigned).toEqual([])
})
it.each(['probability-header', 'partial-record', 'neighbor', 'prose', 'column-overlap'])(
  'declines an unsupported sparse baseline with %s',
  (variant) => {
    const f = load()
    if (variant === 'probability-header') f.tokens[3].text = 'Observation'
    if (variant === 'partial-record')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '7 (70%)')
    if (variant === 'neighbor')
      f.tokens = f.tokens.filter((i: { baseline: number }) => i.baseline !== 56)
    if (variant === 'prose') f.tokens[9].text = 'Possible interpretation'
    if (variant === 'column-overlap') f.tokens[9].rect[2] = 180
    const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(t.repairs).not.toContain('text-supported-row-recovered')
    expect(t.grid.some((r: string[]) => r.includes('8 (80%)'))).toBe(false)
  }
)
