import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { populateTableCellText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)
const fixture = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/narrative-word-wrap-with-independent-spelling.jsonl'
    )
  )
const populate = (f: ReturnType<typeof fixture>): string => {
  const before = structuredClone(f.items)
  const issues = new Set<string>()
  expect(populateTableCellText({ ...f, issues, repairs: [] })).toEqual([])
  expect(f.items).toEqual(before)
  expect(f.cells[0].sourceRects).toEqual(before.map((i: { rect: number[] }) => i.rect))
  expect(f.cells[0].sourceTokens.map((i: { text: string }) => i.text)).toEqual(
    before.map((i: { text: string }) => i.text)
  )
  return f.cells[0].text
}
it('reflows a narrative word split before a separate hyphen glyph using an independent source spelling', () => {
  expect(populate(fixture())).toBe('cognitive adaptation and support')
})
it.each(['missing spelling', 'competing spelling', 'nonhorizontal spelling'])(
  'preserves the source hyphen with %s',
  (kind) => {
    const f = fixture()
    if (kind === 'missing spelling') f.pageItems.pop()
    if (kind === 'competing spelling')
      f.pageItems.push({ ...f.pageItems.at(-1), text: 'adapt-ation' })
    if (kind === 'nonhorizontal spelling') f.pageItems.at(-1).horizontal = false
    expect(populate(f)).toBe('cognitive adapt-ation and support')
  }
)
it.each([
  'distant line',
  'different font',
  'new indent',
  'separate hyphen',
  'native separator',
  'uppercase tail',
  'numeric tail'
])('does not join independent lines with %s', (kind) => {
  const f = fixture(),
    tail = f.items[2]
  if (kind === 'distant line') {
    tail.baseline += 8
    tail.rect[1] += 8
    tail.rect[3] += 8
  }
  if (kind === 'different font') tail.height *= 0.6
  if (kind === 'new indent') {
    tail.rect[0] += 20
    tail.rect[2] += 20
  }
  if (kind === 'separate hyphen') {
    f.items[1].rect[0] += 5
    f.items[1].rect[2] += 5
  }
  if (kind === 'native separator') f.rules.push([704, 194, 817, 194])
  if (kind === 'uppercase tail') tail.text = 'Ation and support'
  if (kind === 'numeric tail') tail.text = '8 and support'
  expect(populate(f)).toContain('- ')
})
it.each([0.6, 1.8])('uses font-relative source geometry at scale %s', (scale) => {
  const f = fixture()
  for (const c of [...f.cells, ...f.rows]) c.rect = c.rect.map((v: number) => v * scale)
  f.columnRects = f.columnRects.map((r: number[]) => r.map((v) => v * scale))
  for (const i of new Set([...f.items, ...f.pageItems])) {
    i.rect = i.rect.map((v: number) => v * scale)
    i.height *= scale
    i.baseline *= scale
  }
  f.bottom *= scale
  expect(populate(f)).toBe('cognitive adaptation and support')
})
