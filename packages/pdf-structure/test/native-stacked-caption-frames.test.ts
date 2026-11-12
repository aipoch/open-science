import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const helpers = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-regions.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

const fixture = (): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = []
  const font = (text: string, x: number, y: number, width: number): void => {
    items.push({
      text,
      rect: [x, y, x + width, y + 8],
      height: 8,
      baseline: y + 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    })
  }
  font('TABLE I', 0, 0, 80)
  for (let panel = 0; panel < 2; panel++) {
    const y = panel * 100
    font(`(${panel ? 'b' : 'a'}) Anonymous outcomes`, 0, y + 15, 100)
    for (const [text, x] of [
      ['Method', 0],
      ['First', 100],
      ['Second', 200]
    ] as const)
      font(text, x, y + 35, 40)
    for (let row = 0; row < 2; row++)
      for (const [text, x] of [
        [`Choice ${row}`, 0],
        [`${row + 1}.2`, 100],
        [`${row + 2}.3`, 200]
      ] as const)
        font(text, x, y + 55 + row * 12, 40)
  }
  const rules = [30, 50, 90, 130, 150, 190].map((y) => [0, y, 260, y])
  return {
    items,
    rules,
    captions: [{ page: 1, lines: ['TABLE I'], rect: [0, 0, 80, 8] }],
    tables: [
      { id: 'lower-copy', cropRect: [0, 130, 260, 190], structure: { objects: [] } },
      { id: 'lower', cropRect: [0, 125, 260, 195], structure: { objects: [] } }
    ],
    context: {
      graphics: rules.map((r) => ({ kind: 'path', rect: [r[0], r[1] - 0.2, r[2], r[3] + 0.2] })),
      runs: items.map((i) => ({
        ...i,
        gaps: [],
        glyphRuns: [...i.text].map(() => 1),
        literalGlyphs: [...i.text]
      })),
      rulePaintBounds: new Map(
        rules.map((r) => [r.join(','), [r[0], r[1] - 0.2, r[2], r[3] + 0.2]])
      )
    }
  }
}
const recover = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  helpers.recoverNativeStackedCaptionFrames?.(f.tables, f.items, f.captions, f.rules, 1, f.context)

it('recovers both native subtitle frames when detector proposals duplicate only the lower body', () => {
  const f = fixture(),
    before = structuredClone(f),
    result = recover(f)
  expect(result?.tables).toHaveLength(2)
  expect(result.replaced).toEqual(f.tables)
  expect(result.tables[0].cropRect[1]).toBe(15)
  expect(result.tables[1].cropRect[1]).toBe(115)
  for (const table of result.tables) {
    const output = refineTable(table, f.items, f.captions, [], f.rules, f.context.runs)
    expect(output.grid).toContainEqual(['Choice 0', '1.2', '2.3'])
    expect(output.grid).toContainEqual(['Choice 1', '2.2', '3.3'])
    expect(output.unassigned).toEqual([])
  }
  expect(f).toEqual(before)
})
it.each([
  'missing closing',
  'missing program',
  'duplicate original',
  'wrong subtitle',
  'crossing font',
  'foreign table',
  'native image',
  'unowned path'
])('retains detector evidence when stacked frame proof fails: %s', (reason) => {
  const f = fixture()
  if (reason === 'missing closing') f.rules.splice(2, 1)
  if (reason === 'native image')
    f.context.graphics.push({ kind: 'image', rect: [100, 35, 140, 45] })
  if (reason === 'unowned path')
    f.context.graphics.push({ kind: 'path', rect: [100, 99, 140, 109] })
  if (reason === 'missing program') f.context.runs.splice(2, 1)
  if (reason === 'duplicate original') f.items.push(structuredClone(f.items[2]))
  if (reason === 'wrong subtitle')
    f.items.find((i: { text: string }) => i.text.startsWith('(b)')).text = '(c) Anonymous outcomes'
  if (reason === 'crossing font')
    f.items.push({
      text: 'x',
      rect: [20, 85, 30, 110],
      height: 25,
      baseline: 110,
      horizontal: true
    })
  if (reason === 'foreign table')
    f.tables.push({ id: 'foreign', cropRect: [0, 210, 260, 300], structure: { objects: [] } })
  expect(recover(f)).toBeUndefined()
})
