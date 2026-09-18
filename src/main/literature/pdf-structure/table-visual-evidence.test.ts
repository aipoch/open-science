import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const refine = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table ?? f.models?.[0], f.tokens, f.captions ?? [], [], f.rules ?? [])

it.each(['wrapped-education', 'recurrence-group-spans'])(
  'restores categorical labels and shared statistics from native records: %s',
  (name) => {
    const f = fixture(name),
      original = structuredClone(f),
      t = refine(f)
    const groups =
      name === 'wrapped-education'
        ? [
            [3, 4],
            [7, 4],
            [11, 2],
            [13, 4]
          ]
        : [
            [3, 2],
            [5, 2],
            [7, 2]
          ]
    for (const [row, rowSpan] of groups)
      for (const column of name === 'wrapped-education' ? [0, 5, 6] : [0, 6]) {
        expect(t.cells).toContainEqual(
          expect.objectContaining({ row, column, rowSpan, colSpan: 1 })
        )
      }
    const owned = t.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
    expect(new Set(owned.map((token: unknown) => JSON.stringify(token))).size).toBe(owned.length)
    expect(f).toEqual(original)
  }
)

it.each(['indented-overlapping-record', 'rotated-followup-headers'])(
  'does not infer categorical spans from unrelated percentage rows: %s',
  (name) => {
    expect(refine(fixture(name)).repairs).not.toContain('categorical-group-spans-recovered')
  }
)

it('retains per-row tests when a second category has its own P value', () => {
  const f = fixture('recurrence-group-spans'),
    baseline = refine(f)
  const anchor = baseline.cells.find(
    (c: { row: number; column: number }) => c.row === 4 && c.column === 5
  ).sourceTokens[0]
  const target = baseline.cells.find(
    (c: { row: number; column: number }) => c.row === 3 && c.column === 6
  ).sourceTokens[0]
  f.tokens.push({
    ...anchor,
    horizontal: true,
    text: '0.04',
    rect: [target.rect[0], anchor.rect[1], target.rect[0] + 20, anchor.rect[3]]
  })
  const t = refine(f)
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 3 && c.column === 6)
  ).toMatchObject({ rowSpan: 1, text: '1' })
  expect(t.cells).toContainEqual(
    expect.objectContaining({ row: 4, column: 6, rowSpan: 1, text: '0.04' })
  )
})

it('makes all repeated threshold section headings full-width, including a lowered VO2max fragment', () => {
  const t = refine(fixture('moderator-statistic-rows'))
  for (const row of [2, 6, 10, 14, 19, 23, 27, 31])
    expect(t.cells).toContainEqual(
      expect.objectContaining({ row, column: 0, colSpan: 7, rowSpan: 1 })
    )
  expect(t.grid[2][0]).toBe('Physical fitness (VO2max)')
  expect(t.grid.flat().filter((text: string) => /^Pe? =/.test(text))).toHaveLength(18)
})

it.each(['clipped-resource-header', 'wrapped-resource-records'])(
  'joins wrapped URLs without removing path hyphens or changing source tokens: %s',
  (name) => {
    const f = fixture(name),
      t = refine(f)
    const urls = t.grid.flat().filter((text: string) => /^https?:/.test(text))
    expect(urls.length).toBeGreaterThan(3)
    expect(urls.every((text: string) => !text.includes(' '))).toBe(true)
    if (name === 'clipped-resource-header')
      expect(urls).toContain(
        'https://support.10xgenomics.com/single-cell-vdj/software/analysis-of-multiple-libraries/latest/lcb'
      )
    else expect(urls).toContain('https://www.gsea-msigdb.org/gsea/downloads.jsp')
  }
)

it.each(['prose', 'second-url', 'gap'])(
  'does not concatenate unrelated content after a URL: %s',
  (variant) => {
    const f = fixture('wrapped-resource-records')
    const tail = f.tokens.find((t: { text: string }) => t.text === 'downloads.jsp')
    if (variant === 'prose') tail.text = 'Download the software'
    if (variant === 'second-url') tail.text = 'https://example.org/'
    if (variant === 'gap') {
      tail.rect[0] += 30
      tail.rect[2] += 30
    }
    const t = refine(f)
    expect(t.grid[15][2]).toContain('gsea/ ')
  }
)

it('preserves the raised yen-shaped source marker after its label using matching dagger geometry', () => {
  const f = fixture('centered-fatty-acid-stub'),
    t = refine(f)
  const c = t.cells.find((c: { row: number; column: number }) => c.row === 14 && c.column === 0)
  expect(c.text).toBe('Fatty acid kcal ¥')
  expect(c.textRuns.at(-1)).toEqual({ text: '¥', position: 'superscript' })
  for (const variant of ['missing-dagger', 'ordinary-baseline']) {
    const altered = structuredClone(f)
    if (variant === 'missing-dagger')
      altered.tokens = altered.tokens.filter((i: { text: string }) => i.text !== '†')
    else {
      const yen = altered.tokens.find((i: { text: string }) => i.text === '¥')
      yen.baseline += 7
      yen.rect[1] += 7
      yen.rect[3] += 7
    }
    const cell = refine(altered).cells.find(
      (c: { row: number; column: number }) => c.row === 14 && c.column === 0
    )
    expect(
      cell.textRuns?.some(
        (r: { text: string; position: string }) => r.text === '¥' && r.position === 'superscript'
      ) ?? false
    ).toBe(false)
  }
})

it.each([
  'centered-fatty-acid-stub',
  'clipped-resource-header',
  'wrapped-resource-records',
  'spaced-resection-note'
])('records source-confirmed model rejections as repairs: %s', (name) => {
  const t = refine(fixture(name))
  expect(t.issues.filter((code: string) => /spanning|span-conflicts/.test(code))).toEqual([])
  expect(
    t.repairs.some((code: string) => /source-(?:cell-span|record-boundary)|model-span/.test(code))
  ).toBe(true)
})

it('keeps a resource merge conflict when the source column contract is missing', () => {
  const f = fixture('wrapped-resource-records')
  for (const token of f.tokens) if (/^SOURCE$/i.test(token.text.trim())) token.text = 'Device'
  expect(refine(f).issues).toContain('span-conflicts-with-source-rows')
})
