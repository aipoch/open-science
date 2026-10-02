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
      'src/main/literature/pdf-structure/fixtures/source-grids/native-statistic-block-with-early-stub-span.jsonl'
    )
  )
it('starts a native statistic stub at its N baseline, keeping the preceding category independent', () => {
  const f = load(),
    t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  const row = t.grid.findIndex((r: string[]) => r[1] === 'N')
  expect(t.cells.find((c: { text: string }) => c.text === 'Size')?.row).toBe(row)
  expect(t.cells.find((c: { text: string }) => c.text === 'Size')?.rowSpan).toBe(4)
  expect(t.grid.find((r: string[]) => r[1] === 'Second')?.[0]).toBe('')
})
it.each(['native baseline', 'statistic label'])(
  'keeps a model stub without matching %s evidence',
  (reason) => {
    const f = load()
    if (reason === 'native baseline')
      for (const i of f.tokens.filter((i: { text: string }) => i.text === 'Size')) {
        i.rect[1] -= 5
        i.rect[3] -= 5
        i.baseline -= 5
      }
    if (reason === 'statistic label')
      f.tokens.find((i: { text: string }) => i.text === 'N').text = 'Count'
    const t = refineTable(f.table, f.tokens, f.captions, [], f.rules)
    expect(t.cells.find((c: { text: string }) => c.text === 'Size')?.rowSpan).not.toBe(4)
  }
)
