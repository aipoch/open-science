import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Fixture = {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; rect: number[] }[] }
  }
  tokens: { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }[]
  captions: { page: number; lines: string[]; rect: number[] }[]
  rules: number[][]
}
function fixture(): Fixture {
  const cuts = [0, 100, 250, 400, 550, 600],
    tokens = [] as {
      text: string
      rect: number[]
      baseline: number
      height: number
      horizontal: boolean
    }[]
  const line = (values: string[], y: number): void =>
    values.forEach((text, c) => {
      if (text)
        tokens.push({
          text,
          rect: [cuts[c] + 5, y, cuts[c + 1] - 5, y + 10],
          baseline: y + 10,
          height: 10,
          horizontal: true
        })
    })
  line(['Construct', 'Measure', 'Description', 'Properties', 'No. of items'], 5)
  for (let n = 0; n < 3; n++) {
    line(
      [
        `Record ${n + 1}`,
        'A source measure',
        'A source description',
        'A source property',
        String(n + 2)
      ],
      35 + n * 40
    )
    line(['', 'Measure ending', 'Description ending', 'Property ending', ''], 50 + n * 40)
  }
  const objects = cuts
    .slice(1)
    .map((x, c) => ({ label: 'table column', rect: [cuts[c], 0, x, 155] }))
  objects.push(
    { label: 'table row', rect: [0, 0, 600, 25] },
    { label: 'table row', rect: [0, 25, 600, 110] },
    { label: 'table row', rect: [0, 110, 600, 155] }
  )
  return {
    table: { id: 'page-1-table-1', cropRect: [0, 0, 600, 155], structure: { objects } },
    tokens,
    captions: [{ page: 1, lines: ['Table 1. Measures.'], rect: [0, -30, 600, -10] }],
    rules: cuts.slice(1).flatMap((x, c) => [0, 25, 155].map((y) => [cuts[c], y, x, y]))
  }
}
it('uses a native item-count baseline to keep long constructs independent of merged model bands', () => {
  const f = fixture(),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(t.grid).toHaveLength(4)
  expect(t.grid.slice(1).map((r: string[]) => r[4])).toEqual(['2', '3', '4'])
  expect(t.grid[1][1]).toBe('A source measure Measure ending')
  expect(t.grid[2][1]).toBe('A source measure Measure ending')
  expect(t.unassigned).toEqual([])
})
const { recoverStudyParagraphGrid } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-ruled-narrative-grid.mjs')).href
)
it.each(['item count heading', 'aligned count', 'closed native frame', 'whole narrative cell'])(
  'declines count-anchored paragraphs without %s',
  (kind) => {
    const f = fixture()
    if (kind === 'item count heading')
      f.tokens.find((i) => i.text === 'No. of items')!.text = 'Other'
    if (kind === 'aligned count') {
      const i = f.tokens.find((i) => i.text === '3')!
      i.rect[1] += 20
      i.rect[3] += 20
      i.baseline += 20
    }
    if (kind === 'closed native frame') f.rules = f.rules.filter((r) => r[1] !== 155)
    if (kind === 'whole narrative cell')
      f.tokens.find((i) => i.text === 'Measure ending')!.rect[2] = 270
    expect(recoverStudyParagraphGrid(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)
