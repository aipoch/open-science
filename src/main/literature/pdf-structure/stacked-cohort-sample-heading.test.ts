import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { coalesceSampleSizeHeader } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/stacked-cohort-sample-heading.jsonl'
    )
  )

it('keeps superscripted cohort names and their sample sizes in one ruled header band', () => {
  const x = fixture()
  const r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid[0]).toEqual([
    'Variable',
    'Marker Xnegative (n = 129)',
    'Marker Xlow (n = 102)',
    'Marker Xhigh (n = 154)',
    'p-value'
  ])
  expect(r.grid[1]).toEqual(['Age*', '', '', '', '0.04'])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    x.tokens.map((i: { rect: number[] }) => i.rect).sort()
  )
})

it('only replaces the two header rows and retains their original source tokens', () => {
  const x = fixture()
  const body = structuredClone(x.rows.slice(2))
  const tokens = structuredClone(x.tokens)
  coalesceSampleSizeHeader({ ...x, items: x.tokens, repairs: [] })
  expect(x.rows[0].origin).toBe('source-native-header')
  expect(x.rows.slice(1)).toEqual(body)
  expect(x.tokens).toEqual(tokens)
})

it.each([
  'missing sample',
  'numeric child heading',
  'crossed column',
  'distant sample',
  'internal divider',
  'missing frame',
  'interrupted frame',
  'missing model header',
  'incomplete body'
])('leaves ambiguous stacked headings intact: %s', (kind) => {
  const x = fixture()
  const sample = x.tokens.find((i: { text: string }) => i.text === '(n = 129)')
  if (kind === 'missing sample') x.tokens = x.tokens.filter((i: unknown) => i !== sample)
  if (kind === 'numeric child heading') sample.text = '129'
  if (kind === 'crossed column') sample.rect[2] = x.columnRects[1][2] + 1
  if (kind === 'distant sample') {
    for (const i of x.tokens.filter((i: { rect: number[] }) => i.rect[1] < 119)) {
      i.rect[1] -= 20
      i.rect[3] -= 20
      i.baseline -= 20
    }
    x.rows[0].rect[1] -= 20
    x.rows[0].rect[3] -= 20
  }
  if (kind === 'internal divider') x.rules.push([330, 119, 410, 119])
  if (kind === 'missing frame') x.rules = []
  if (kind === 'interrupted frame') {
    const top = x.rules.find((r: number[]) => r[1] < 106 && r[1] === r[3])
    x.rules = x.rules.filter((r: number[]) => r !== top)
    x.rules.push([top[0], top[1], 450, top[3]], [453, top[1], top[2], top[3]])
  }
  if (kind === 'missing model header') x.headers = []
  if (kind === 'incomplete body')
    x.tokens = x.tokens.filter((i: { rect: number[] }) => i.rect[1] < 139)
  const rows = structuredClone(x.rows)
  coalesceSampleSizeHeader({ ...x, items: x.tokens, repairs: [] })
  expect(x.rows).toEqual(rows)
})
