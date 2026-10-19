import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverRuledRecordFaces } = await import(
  pathToFileURL(resolve('resources/literature-pdf-ruled-record-faces.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(resolve('test/fixtures/ruled-scientific-record-with-missing-model-row.jsonl'))
it('retains a complete scientific record outside predicted row bands', () => {
  const x = fixture(),
    r = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(r.grid).toHaveLength(5)
  expect(r.grid.map((v: string[]) => v[0])).toEqual([
    'Record',
    'Case A',
    'Case B',
    'Case C',
    'Case D'
  ])
  expect(r.unassigned).toEqual([])
  const rects = r.cells
    .flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
    .map((v: number[]) => JSON.stringify(v))
  expect(new Set(rects).size).toBe(x.tokens.length)
})
it.each([
  'missing-footer',
  'missing-value',
  'competing-caption',
  'crossing-column',
  'detached-exponent'
])('declines incomplete scientific native proof: %s', (mode) => {
  const x = fixture()
  if (mode === 'missing-footer') x.rules.pop()
  if (mode === 'missing-value')
    x.tokens = x.tokens.filter(
      (i: { rect: number[]; baseline: number }) =>
        !(i.rect[0] > 395 && i.baseline > 299 && i.baseline < 306)
    )
  if (mode === 'competing-caption') x.captions.push(structuredClone(x.captions[0]))
  if (mode === 'crossing-column')
    x.tokens.push({ ...x.tokens[0], text: 'Extra', rect: [300, 294, 315, 304], baseline: 304 })
  if (mode === 'detached-exponent') {
    const i = x.tokens.find(
      (t: { height: number; baseline: number }) =>
        t.height < 10 && t.baseline > 295 && t.baseline < 304
    )
    expect(i).toBeDefined()
    if (i) {
      i.rect = i.rect.map((v: number, n: number) => (n % 2 === 0 ? v + 15 : v))
      i.baseline -= 5
    }
  }
  const r = recoverRuledRecordFaces(x.table, x.tokens, x.captions, x.rules)
  expect(r?.repair).not.toBe('native-body-records-recovered')
})

const { recoverUnownedSourceRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-row-repair.mjs')).href
)
const { groupSourceRowsWithScripts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-source-records.mjs')).href
)
function closedSharedRecordFixture(): ReturnType<typeof readPdfFixture> {
  const items = [],
    xs = [0, 30, 70, 110, 150]
  let index = 0
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const add = (text: string, c: number, y: number) => {
    const i = {
      text,
      rect: [xs[c] + 4, y, xs[c] + Math.min(26, text.length * 2 + 4), y + 8],
      baseline: y + 8,
      height: 8,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: index++, text }
    }
    items.push(i)
    return i
  }
  for (const [c, s] of ['Group', 'Label', 'Value', 'Score'].entries()) add(s, c, 4)
  for (const [n, y] of [28, 42, 56].entries()) {
    if (!n) add('Set', 0, y)
    add(['Alpha', 'Beta', 'Gamma'][n], 1, y)
    add(['2[1,3]', '3[2,4]', '4[3,5]'][n], 2, y)
    add(['0.1', '0.2', '0.3'][n], 3, y)
  }
  return {
    items,
    inventory: items.slice(),
    columnRects: xs.slice(1).map((x, c) => [xs[c], 0, x, 100]),
    rules: [
      [0, 0, 150, 0],
      [0, 20, 150, 20],
      [0, 73, 150, 73]
    ],
    rows: [{ rect: [0, 0, 150, 15] }, { rect: [0, 24, 150, 38] }, { rect: [0, 52, 150, 66] }],
    repairs: []
  }
}

it('recovers a complete shared-stub record inside its native closed group', () => {
  const x = closedSharedRecordFixture()
  x.groups = groupSourceRowsWithScripts(x.items, 8, 0.35)
  const originals = structuredClone(x.items)
  recoverUnownedSourceRows(x)
  expect(x.rows).toHaveLength(4)
  expect(x.items).toEqual(originals)
  expect(x.repairs).toContain('native-closed-shared-records-recovered')
})
it.each([
  'missing-opening',
  'missing-closing',
  'missing-field',
  'external-alias',
  'unknown-ink',
  'rotated-ink',
  'malformed-ink',
  'vertical-rule',
  'slanted-rule',
  'crossing-glyph',
  'header-missing'
])('preserves native rows when the shared-group proof is incomplete: %s', (mode) => {
  const x = closedSharedRecordFixture()
  if (mode === 'missing-opening') x.rules.splice(1, 1)
  if (mode === 'missing-closing') x.rules.pop()
  if (mode === 'missing-field') {
    const i = x.items.findIndex((v: { text: string }) => v.text === '0.2')
    x.inventory.splice(x.inventory.indexOf(x.items[i]), 1)
    x.items.splice(i, 1)
  }
  if (mode === 'external-alias')
    x.inventory.push({
      rect: [170, 0, 180, 8],
      sourceSegments: [{ ...x.items[5].sourceItem, start: 0, end: 1 }]
    })
  if (mode === 'unknown-ink' || mode === 'rotated-ink')
    x.inventory.push({ text: '?', rect: [50, 40, 55, 44], horizontal: mode !== 'rotated-ink' })
  if (mode === 'malformed-ink')
    x.inventory.push({ text: '?', rect: [50, NaN, 55, 44], horizontal: true })
  if (mode === 'vertical-rule') x.rules.push([85, 24, 85, 65])
  if (mode === 'slanted-rule') x.rules.push([20, 24, 130, 65])
  if (mode === 'crossing-glyph') x.items.at(-1).rect[3] = 74
  if (mode === 'header-missing') {
    x.inventory.splice(0, 1)
    x.items.splice(0, 1)
  }
  x.groups = groupSourceRowsWithScripts(x.items, 8, 0.35)
  const rows = structuredClone(x.rows)
  recoverUnownedSourceRows(x)
  expect(x.rows).toEqual(rows)
  expect(x.repairs).not.toContain('native-closed-shared-records-recovered')
})
