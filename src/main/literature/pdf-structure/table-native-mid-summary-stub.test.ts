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
}
function fixture(): Fixture {
  const values = [
    ['', 'M (SD)', 'M (SD)', 't', 'p'],
    ['Size (years)', '41.1 (6.8)', '43.2 (5.4)', '−0.56', '0.55'],
    ['Duration', '20.1 (5.6)', '22.3 (6.7)', '1.52', '0.08']
  ]
  const tokens = values.flatMap((r, n) =>
    r.flatMap((text, c) =>
      text
        ? [
            {
              text,
              rect: [c * 100 + 5, n * 20 + 5, c * 100 + 90, n * 20 + 15],
              baseline: n * 20 + 15,
              height: 10,
              horizontal: true
            }
          ]
        : []
    )
  )
  const objects = [0, 1, 2, 3, 4].map((c) => ({
    label: 'table column',
    rect: [c * 100, 0, (c + 1) * 100, 60]
  }))
  objects.push(
    ...[0, 1, 2].map((n) => ({ label: 'table row', rect: [0, n * 20, 500, (n + 1) * 20] })),
    { label: 'table spanning cell', rect: [0, 0, 100, 40] }
  )
  return {
    table: { id: 'page-1-table-1', cropRect: [0, 0, 500, 60], structure: { objects } },
    tokens,
    captions: [{ page: 1, lines: ['Table 1. Summaries.'], rect: [0, -30, 500, -10] }]
  }
}
it('starts a stub aligned with measured values below a mid-table summary heading', () => {
  const f = fixture(),
    t = refineTable(f.table, f.tokens, f.captions, [], [])
  expect(t.grid.find((r: string[]) => r[1] === 'M (SD)')?.[0]).toBe('')
  expect(t.grid.find((r: string[]) => r[1] === '41.1 (6.8)')?.[0]).toBe('Size (years)')
  expect(t.cells.find((c: { text: string }) => c.text === 'Size (years)')?.rowSpan).toBe(1)
})
it.each(['summary heading', 'native baseline', 'native separator'])(
  'does not move the stub without %s',
  (kind) => {
    const f = fixture()
    if (kind === 'summary heading') f.tokens.find((i) => i.text === 't')!.text = 'Other'
    if (kind === 'native baseline') {
      const i = f.tokens.find((i) => i.text === 'Size (years)')!
      i.rect[1] += 5
      i.rect[3] += 5
      i.baseline += 5
    }
    const rules = kind === 'native separator' ? [[0, 30, 500, 30]] : []
    const t = refineTable(f.table, f.tokens, f.captions, [], rules)
    expect(t.cells.find((c: { text: string }) => c.text === 'Size (years)')?.rowSpan).toBe(2)
  }
)
