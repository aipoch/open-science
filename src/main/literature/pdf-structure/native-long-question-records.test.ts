import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const module = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_QUESTION_GRID_MODULE ??
        'resources/pdf-structure/literature-pdf-long-question-record-grid.mjs'
    )
  ).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const recover = (x: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  module.recoverNativeQuestionRecordGrid?.(x.table, x.items, x.captions, x.rules)
it('retains one quantitative record per source question and all 8 values', () => {
  const x = fixture('native-numbered-questions-with-wrapped-stubs'),
    proof = recover(x)
  expect(proof?.rows).toHaveLength(5)
  expect(proof?.columns).toHaveLength(4)
  expect(proof?.ownedTokens.size).toBe(x.items.length)
})
it('retains quote continuations and one source question spanning both themes', () => {
  const x = fixture('native-qualitative-quotes-with-shared-question'),
    proof = recover(x)
  expect(proof?.rows).toHaveLength(3)
  expect(proof?.columns).toHaveLength(3)
  expect(proof?.spans).toContainEqual({ row: 1, column: 0, rowSpan: 2, colSpan: 1 })
  expect(proof?.ownedTokens.size).toBe(x.items.length)
})
it.each(['missing band', 'crossing field', 'uncounted theme', 'unquoted example', 'article prose'])(
  'rejects a qualitative block with %s',
  (variant) => {
    const x = fixture('native-qualitative-quotes-with-shared-question')
    if (variant === 'missing band') x.rules = x.rules.slice(0, -3)
    if (variant === 'crossing field') x.items[7].rect[2] = 245
    if (variant === 'uncounted theme') x.items[7].text = 'unrelated material'
    if (variant === 'unquoted example') x.items[8].text = 'An independent choice'
    if (variant === 'article prose')
      x.items.push({
        text: 'Another ordinary paragraph.',
        horizontal: true,
        height: 8,
        baseline: 213,
        rect: [44, 205, 250, 213]
      })
    expect(recover(x)).toBeUndefined()
  }
)
it.each(['missing caption', 'nonsequential questions', 'missing value', 'crossing field'])(
  'rejects a quantitative question grid with %s',
  (variant) => {
    const x = fixture('native-numbered-questions-with-wrapped-stubs')
    if (variant === 'missing caption') x.captions = []
    if (variant === 'nonsequential questions')
      x.items[10].text = '4. the diagram support an independent'
    if (variant === 'missing value') x.items.splice(14, 1)
    if (variant === 'crossing field') x.items[5].rect[2] = 245
    expect(recover(x)).toBeUndefined()
  }
)
const { groupTableParts } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-group.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
function mixedFixture(): ReturnType<typeof fixture> {
  const a = fixture('native-numbered-questions-with-wrapped-stubs'),
    b = fixture('native-qualitative-quotes-with-shared-question'),
    delta = 136
  for (const i of b.items) {
    i.rect[1] += delta
    i.rect[3] += delta
    i.baseline += delta
  }
  for (const r of b.rules) {
    r[1] += delta
    r[3] += delta
  }
  return { ...a, items: [...a.items, ...b.items], rules: [...a.rules, ...b.rules] }
}
it('keeps quantitative and qualitative grids in one captioned table after ordinary grouping', () => {
  const x = mixedFixture(),
    split = module.recoverMixedQuestionSections?.([x.table], x.items, x.captions, x.rules, 1)
  expect(split?.tables).toHaveLength(2)
  if (!split) return
  const refined = split.tables.map((table: ReturnType<typeof fixture>['table'], n: number) => ({
    ...refineTable(table, x.items, x.captions, [], x.rules),
    page: 1,
    caption:
      n === 0 ? { text: x.captions[0].lines[0], page: 1, rect: x.captions[0].rect } : undefined,
    sourceViewport: { page: 1, rect: table.cropRect }
  }))
  const grouped = module.groupMixedQuestionSections(groupTableParts(refined, { lines: [] }))
  expect(grouped).toHaveLength(1)
  expect(grouped[0].caption).toEqual(refined[0].caption)
  expect(grouped[0].parts.map((p: ReturnType<typeof JSON.parse>) => p.grid[0].length)).toEqual([
    4, 3
  ])
  expect(grouped[0].parts[1].cells).toEqual(refined[1].cells)
  expect(grouped[0].grid).toBeUndefined()
  expect(grouped[0].cells).toBeUndefined()
})
it.each(['missing numbered caption', 'overlapping model candidate', 'nonadjacent section'])(
  'does not create an extra qualitative table with %s',
  (variant) => {
    const x = mixedFixture(),
      tables = [x.table]
    if (variant === 'missing numbered caption') x.captions = []
    if (variant === 'overlapping model candidate')
      tables.push({ ...x.table, cropRect: [40, 256, 360, 346] })
    if (variant === 'nonadjacent section') {
      x.items
        .filter((i: ReturnType<typeof JSON.parse>) => i.rect[1] > 230)
        .forEach((i: ReturnType<typeof JSON.parse>) => {
          i.rect[1] += 60
          i.rect[3] += 60
          i.baseline += 60
        })
      x.rules
        .filter((r: number[]) => r[1] > 230)
        .forEach((r: number[]) => {
          r[1] += 60
          r[3] += 60
        })
    }
    expect(
      module.recoverMixedQuestionSections?.(tables, x.items, x.captions, x.rules, 1)
    ).toBeUndefined()
  }
)
