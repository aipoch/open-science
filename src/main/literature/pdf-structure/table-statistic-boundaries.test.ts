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
  refineTable(f.table, f.tokens, f.captions, [], f.rules)

it('separates a unit-bearing section from the preceding repeated treatment record', () => {
  const t = refine(fixture('biomarker-section-boundary'))
  expect(t.grid).toHaveLength(10)
  expect(t.grid[6][0]).toBe('Moderate')
  expect(t.grid[7]).toEqual(['TNFa (pg/mL)', '', '', '', '', '', '', ''])
  expect(t.cells.find((c: { text: string }) => c.text === 'TNFa (pg/mL)')).toMatchObject({
    row: 7,
    colSpan: 8,
    rowSpan: 1
  })
  expect(t.grid[8].slice(1)).toEqual([
    '2.84 (2.65–3.04)',
    '2.80 (2.62–3.00)',
    '2.78 (2.60–2.98)',
    '193',
    '−1.91',
    '1.00 (0.95–1.05)',
    '0.96'
  ])
})

it('keeps independent P-value baselines and their footnotes out of the preceding intervals', () => {
  const t = refine(fixture('moderator-statistic-rows'))
  const rows = t.grid.filter((r: string[]) => r.some((v) => /Pe =/.test(v)))
  expect(rows).toHaveLength(8)
  for (const row of rows) {
    expect(row[0]).toBe('')
    expect(row.filter(Boolean).every((v: string) => /^Pe = 0\.\d+$/.test(v))).toBe(true)
  }
  expect(rows.at(-1)).toEqual(['', '', '', '', '', '', 'Pe = 0.08'])
  expect(t.grid.flat()).toContain('1.13 (1.00, 1.29)')
})

it.each(['missing-unit', 'different-arms', 'unindented-arm', 'missing-interval', 'own-value'])(
  'does not infer a repeated section with %s',
  (variant) => {
    const f = fixture('biomarker-section-boundary')
    const heading = f.tokens.find(
      (i: { text: string; baseline: number }) =>
        i.text === 'TNF' && i.baseline > f.table.cropRect[1]
    )
    const first = f.tokens.find(
      (i: { text: string; baseline: number }) => i.text === 'High' && i.baseline > heading.baseline
    )
    if (variant === 'missing-unit')
      f.tokens.find(
        (i: { text: string; baseline: number }) =>
          i.text === '(pg/mL)' && i.baseline === heading.baseline
      ).text = 'Description'
    if (variant === 'different-arms') first.text = 'Other'
    if (variant === 'unindented-arm') {
      first.rect[2] -= first.rect[0] - heading.rect[0]
      first.rect[0] = heading.rect[0]
    }
    if (variant === 'missing-interval')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '2.84 (2.65')
    if (variant === 'own-value')
      f.tokens.push({ ...heading, text: '42', rect: [635, heading.rect[1], 648, heading.rect[3]] })
    expect(refine(f).repairs).not.toContain('repeated-unit-section-separated')
  }
)

it.each(['missing-peers', 'missing-count', 'detached-script', 'own-value', 'own-label'])(
  'keeps an uncertain final statistic boundary with %s',
  (variant) => {
    const f = fixture('moderator-statistic-rows')
    const last = f.tokens.find((i: { text: string }) => i.text === '0.08')
    if (variant === 'missing-peers')
      for (const i of f.tokens) if (i.text === 'P' && i.baseline < 600) i.text = 'Q'
    if (variant === 'missing-count')
      f.tokens = f.tokens.filter(
        (i: { text: string; baseline: number }) => !(i.text === '89/102' && i.baseline > 600)
      )
    if (variant === 'detached-script') {
      const script = f.tokens.find(
        (i: { text: string; baseline: number }) => i.text === 'e' && i.baseline > 620
      )
      script.rect[0] += 30
      script.rect[2] += 30
    }
    if (variant === 'own-value')
      f.tokens.push({ ...last, text: '42', rect: [680, last.rect[1], 693, last.rect[3]] })
    if (variant === 'own-label')
      f.tokens.push({ ...last, text: 'Adjusted', rect: [134, last.rect[1], 170, last.rect[3]] })
    const t = refine(f)
    expect(
      t.cells.some(
        (c: { text: string }) => c.text.includes('0.99 (0.94, 1.04)') && c.text.includes('0.08')
      )
    ).toBe(true)
  }
)

it.each([
  ['biomarker-section-boundary', 115],
  ['moderator-statistic-rows', 223]
] as const)(
  'preserves source tokens exactly once and leaves inputs unchanged in %s',
  (name, count) => {
    const f = fixture(name),
      original = structuredClone(f),
      t = refine(f)
    const owned = t.cells.flatMap(
      (c: { sourceTokens: { text: string; rect: number[] }[] }) => c.sourceTokens
    )
    expect(owned).toHaveLength(count)
    expect(
      new Set(owned.map((i: { text: string; rect: number[] }) => JSON.stringify([i.text, i.rect])))
        .size
    ).toBe(count)
    expect(f).toEqual(original)
  }
)
