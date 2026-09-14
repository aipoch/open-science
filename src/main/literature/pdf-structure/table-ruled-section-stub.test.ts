import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/centered-fatty-acid-stub.jsonl'
    )
  )
const refine = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules)
const stub = (t: ReturnType<typeof refine>): ReturnType<typeof JSON.parse> =>
  t.cells.find((c: { text: string }) => c.text.includes('Fatty acid kcal'))

it('extends a centered section stub to all four native records without changing values', () => {
  const f = fixture(),
    original = structuredClone(f),
    t = refine(f)
  expect(stub(t)).toMatchObject({ row: 14, column: 0, rowSpan: 4, colSpan: 1 })
  expect(t.grid.slice(14).map((r: string[]) => r[1])).toEqual(['SFA', 'MUFA', 'PUFA', 'n-3 FA'])
  expect(t.grid[14].slice(2)).toEqual([
    '0.18',
    '2.02',
    '0.17',
    '0.20',
    '0.42',
    '0.53',
    '0.14',
    '0.42'
  ])
  const owned = t.cells.flatMap(
    (c: { sourceTokens: { text: string; rect: number[] }[] }) => c.sourceTokens
  )
  expect(owned).toHaveLength(160)
  expect(
    new Set(owned.map((i: { text: string; rect: number[] }) => JSON.stringify([i.text, i.rect])))
      .size
  ).toBe(160)
  expect(t.unassigned).toEqual([])
  expect(f).toEqual(original)
})

it.each([
  'missing-border',
  'partial-border',
  'interior-divider',
  'independent-label',
  'incomplete-record',
  'misaligned-record',
  'missing-model-span'
])('does not extend the stub with %s', (variant) => {
  const f = fixture()
  if (variant === 'missing-border')
    f.rules = f.rules.filter((r: number[]) => Math.abs(r[1] - 602) > 1)
  if (variant === 'partial-border')
    f.rules = f.rules.map((r: number[]) => (Math.abs(r[1] - 602) < 1 ? [r[0], r[1], 490, r[3]] : r))
  if (variant === 'interior-divider') f.rules.push([178.5, 629, 824.23, 629])
  if (variant === 'independent-label')
    f.tokens.push({
      ...f.tokens.find((i: { text: string }) => i.text === 'Fatty acid kcal'),
      text: 'Separate category',
      baseline: 622,
      rect: [178.5, 610.5, 270, 622]
    })
  if (variant === 'incomplete-record')
    f.tokens = f.tokens.filter(
      (i: { text: string; rect: number[] }) => !(i.text === '0.18' && i.rect[1] > 600)
    )
  if (variant === 'misaligned-record') {
    const value = f.tokens.find(
      (i: { text: string; rect: number[] }) => i.text === '0.18' && i.rect[1] > 600
    )
    value.baseline += 5
    value.rect[1] += 5
    value.rect[3] += 5
  }
  if (variant === 'missing-model-span')
    f.table.structure.objects = f.table.structure.objects.filter(
      (o: { label: string }) => o.label !== 'table spanning cell'
    )
  expect(stub(refine(f))).not.toMatchObject({ row: 14, rowSpan: 4 })
})

it('preserves the source-supported span after a page-space translation', () => {
  const f = fixture(),
    dx = 27,
    dy = 19
  const translate = (rect: number[]): number[] => rect.map((value, n) => value + (n % 2 ? dy : dx))
  f.table.cropRect = translate(f.table.cropRect)
  for (const token of f.tokens) {
    token.rect = translate(token.rect)
    token.baseline += dy
  }
  for (const caption of f.captions) caption.rect = translate(caption.rect)
  f.rules = f.rules.map(translate)
  const t = refine(f)
  expect(stub(t)).toMatchObject({ row: 14, rowSpan: 4 })
  expect(t.grid).toEqual(refine(fixture()).grid)
})

it.each(['†', '‡'])('keeps a source-backed full-em %s after its label', (symbol) => {
  const f = fixture()
  for (const token of f.tokens) if (token.text === '†') token.text = symbol
  const t = refine(f)
  const cell = t.cells.find((c: { row: number; column: number }) => c.row === 6 && c.column === 0)
  expect(cell).toMatchObject({
    text: `Average total daily kcal ${symbol}`,
    textRuns: [
      { text: 'Average total daily kcal ', position: 'normal' },
      { text: symbol, position: 'superscript' }
    ]
  })
  expect(
    t.cells.find((c: { row: number; column: number }) => c.row === 7 && c.column === 0)
  ).toMatchObject({
    text: 'Macronutrient kcal ‡',
    textRuns: [
      { text: 'Macronutrient kcal ', position: 'normal' },
      { text: '‡', position: 'superscript' }
    ]
  })
  expect(cell.sourceTokens.map((token: { text: string }) => token.text)).toEqual([
    'Average total daily kcal',
    symbol
  ])
  expect(t.unassigned).toEqual([])
  expect(t.grid.map((row: string[]) => row.slice(1))).toEqual(
    refine(fixture()).grid.map((row: string[]) => row.slice(1))
  )
})

it.each([
  'missing-note',
  'different-note',
  'ordinary-baseline',
  'lowered-marker',
  'distant-marker',
  'oversized-marker',
  'numeric-anchor',
  'ordinary-letter',
  'currency-symbol'
])('does not infer a full-em footnote with %s', (variant) => {
  const f = fixture()
  const marker = f.tokens.find((t: { text: string }) => t.text === '†')
  const anchor = f.tokens.find((t: { text: string }) => t.text === 'Average total daily kcal')
  const note = f.tokens.find(
    (t: { text: string; rect: number[] }) => t.text === '†' && t.rect[1] > 690
  )
  if (variant === 'missing-note') f.tokens = f.tokens.filter((t: unknown) => t !== note)
  if (variant === 'different-note') note.text = '‡'
  if (variant === 'ordinary-baseline' || variant === 'lowered-marker') {
    const dy = anchor.baseline - marker.baseline + (variant === 'lowered-marker' ? 6 : 0)
    marker.baseline += dy
    marker.rect[1] += dy
    marker.rect[3] += dy
  }
  if (variant === 'distant-marker') {
    marker.rect[0] += 10
    marker.rect[2] += 10
  }
  if (variant === 'oversized-marker') marker.height = anchor.height * 1.2
  if (variant === 'numeric-anchor') anchor.text = '123.45'
  if (variant === 'ordinary-letter' || variant === 'currency-symbol')
    marker.text = note.text = variant === 'ordinary-letter' ? 'a' : '¥'
  const t = refine(f)
  const cell = t.cells.find((c: { row: number; column: number }) => c.row === 6 && c.column === 0)
  expect(cell.textRuns).toBeUndefined()
  expect(cell.sourceTokens).toHaveLength(2)
  expect(t.unassigned).toEqual([])
})
