import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { mergeWrappedStubTails } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
type Item = { text: string; horizontal: boolean; height: number; baseline: number; rect: number[] }
type Input = {
  rows: { rect: number[] }[]
  items: Item[]
  columnRects: number[][]
  rules: number[][]
  repairs: string[]
}
const fixture = (): Input => ({
  ...readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/three-measured-records-with-hanging-stub-tails.jsonl'
    )
  ),
  repairs: []
})
it('learns matching hanging tails from three complete native measured records', (): void => {
  const x = fixture()
  mergeWrappedStubTails(x)
  expect(x.rows).toHaveLength(3)
  expect(x.repairs).toHaveLength(3)
  expect(x.rows.map((r) => r.rect[3])).toEqual([122.5, 146.5, 172])
})
for (const mode of [
  'two-peers',
  'closing',
  'numeric-tail',
  'font',
  'gutter',
  'indent',
  'separator'
] as const)
  it(`preserves independent rows with incomplete hanging proof: ${mode}`, (): void => {
    const x = fixture()
    if (mode === 'two-peers') {
      x.items = x.items.filter((i) => i.rect[1] < 145)
      x.rows = x.rows.slice(0, 4)
      x.rules[1][1] = x.rules[1][3] = 148
    }
    if (mode === 'closing') x.rules.pop()
    if (mode === 'numeric-tail')
      x.items.push({
        text: '2',
        horizontal: true,
        height: 9,
        baseline: 121,
        rect: [160, 112, 170, 121]
      })
    if (mode === 'font') x.items.find((i) => i.text === 'Capital detail')!.height = 12
    if (mode === 'gutter') x.items.find((i) => i.text === 'Axis B')!.rect[0] = 50
    if (mode === 'indent') x.items.find((i) => i.text === 'Capital detail')!.rect[0] = 60
    if (mode === 'separator') x.rules.push([40, 110, 150, 110])
    const before = structuredClone(x.rows)
    mergeWrappedStubTails(x)
    expect(x.rows).toEqual(before)
  })
it('keeps an ambiguously owned terminal tail even when earlier peers are safe', (): void => {
  const x = fixture()
  x.rows.push(structuredClone(x.rows.at(-1)!))
  mergeWrappedStubTails(x)
  expect(x.rows.filter((r) => r.rect[1] === 158.5)).toHaveLength(2)
  expect(x.rows.some((r) => r.rect[3] === 158.5)).toBe(true)
})
