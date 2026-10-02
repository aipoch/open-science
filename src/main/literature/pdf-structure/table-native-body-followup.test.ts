import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const runtime = (name: string): string =>
  pathToFileURL(resolve(`resources/pdf-structure/literature-pdf-${name}.mjs`)).href
const { refineTable } = await import(runtime('table-refine'))
const { recoverRuledBodyRecords } = await import(runtime('ruled-body-records'))
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
it('retains the printed final section on an explicitly marked count-table continuation', () => {
  const f = load('sample-cohorts-with-final-continuation-section'),
    original = structuredClone(f)
  const t = refineTable(f.table, f.tokens, f.captions, f.notes, f.rules)
  expect(t.grid.at(-1)).toEqual(['Follow-up categories†', '', ''])
  expect(t.grid).toContainEqual(['Sentinel lymph node biopsy', '7', '4'])
  expect(t.grid).toHaveLength(13)
  expect(t.cells.find((c: { text: string }) => c.text === 'Follow-up categories†')?.colSpan).toBe(3)
  expect(t.unassigned).toEqual([])
  expect(f).toEqual(original)
})
it.each(['marker', 'samples', 'native-divider', 'model-row'])(
  'requires independent continuation evidence: %s',
  (variant) => {
    const f = load('sample-cohorts-with-final-continuation-section')
    if (variant === 'marker')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '(continue...)')
    if (variant === 'samples')
      f.tokens.find((i: { text: string }) => i.text === '(n = 18)').text = '(subset)'
    if (variant === 'native-divider') f.rules = []
    if (variant === 'model-row')
      f.table.structure.objects.push({ label: 'table row', rect: [0, 370, 335, 395] })
    expect(recoverRuledBodyRecords(f.table, f.tokens, f.rules)).toBeUndefined()
  }
)
it('keeps a wrapped dimensional unit in the complete dense measurement record', () => {
  const f = load('dense-comparison-with-wrapped-unit-tail'),
    t = refineTable(f.table, f.tokens, f.captions, f.notes, f.rules)
  expect(t.grid.find((r: string[]) => r[0].startsWith('Body mass index'))?.[0]).toBe(
    'Body mass index (kg/ m2)'
  )
  expect(t.grid.some((r: string[]) => r[0] === 'm2)')).toBe(false)
  expect(t.grid.find((r: string[]) => r[0].startsWith('Body mass index'))?.[1]).toBe('35')
  expect(t.unassigned).toEqual([])
})
it('keeps the terminal support-count unit with its complete numeric record', () => {
  const f = load('dense-continuation-with-terminal-count-unit'),
    t = refineTable(f.table, f.tokens, f.captions, f.notes, f.rules)
  expect(t.grid.at(-1)?.[0]).toBe('Postural balance (n NoS)')
  expect(t.grid).toHaveLength(7)
  expect(t.unassigned).toEqual([])
})
it.each(['closed-unit', 'native-boundary'])(
  'preserves ambiguous dimensional tails with %s',
  (variant) => {
    const f = load('dense-comparison-with-wrapped-unit-tail')
    const head = f.tokens.find((i: { text: string }) => i.text === 'Body mass index (kg/')
    if (variant === 'closed-unit') head.text += 'm2)'
    if (variant === 'native-boundary')
      f.rules.push([f.table.cropRect[0], 372, f.table.cropRect[2], 372])
    const t = refineTable(f.table, f.tokens, f.captions, f.notes, f.rules)
    expect(t.grid.some((r: string[]) => r[0] === 'm2)')).toBe(true)
  }
)
it.each([{ labels: [] }, { labels: ['First Author'] }])(
  'declines empty or header-only comparison candidates without throwing (%j)',
  ({ labels }) => {
    const f = load('study-comparison-with-sparse-primary-record')
    f.tokens = f.tokens.filter((i: { text: string }) => labels.includes(i.text))
    expect(() => recoverRuledBodyRecords(f.table, f.tokens, f.rules)).not.toThrow()
    expect(recoverRuledBodyRecords(f.table, f.tokens, f.rules)).toBeUndefined()
  }
)
it('owns each native count/percentage continuation record and its clipped section', () => {
  const f = load('native-count-continuation-with-clipped-section'),
    original = structuredClone(f)
  const t = refineTable(f.table, f.tokens, f.captions, f.notes, f.rules)
  expect(t.grid).toHaveLength(22)
  expect(t.grid[0]).toEqual(['T2', '77', '22.06', '83', '24.13', ''])
  expect(t.grid[1]).toEqual(['Resection margin', '', '', '', '', '0.627'])
  expect(t.grid[14]).toEqual(['Treatment characteristics', '', '', '', '', ''])
  expect(t.grid[15]).toEqual(['Adjuvant chemotherapy', '225', '64.47', '217', '63.08', '0.704'])
  expect(t.grid.at(-1)).toEqual(['Hormonal therapy', '252', '72.21', '253', '73.55', '0.737'])
  expect(t.cropRect[0]).toBeLessThanOrEqual(
    f.tokens.find((i: { text: string }) => i.text === 'Treatment characteristics').rect[0]
  )
  expect(t.issues).toEqual([])
  expect(t.unassigned).toEqual([])
  expect(f).toEqual(original)
})
it.each(['closing-rule', 'percentage', 'probability', 'section-indent'])(
  'declines a count continuation with contradictory %s evidence',
  (variant) => {
    const f = load('native-count-continuation-with-clipped-section')
    if (variant === 'closing-rule') f.rules = f.rules.filter((r: number[]) => r[1] < 1000)
    if (variant === 'percentage')
      f.tokens.find((i: { text: string }) => i.text === '22.06').text = '123.45'
    if (variant === 'probability')
      f.tokens.find((i: { text: string }) => i.text === '0.627').text = '2.627'
    if (variant === 'section-indent')
      f.tokens.find((i: { text: string }) => i.text === 'Treatment characteristics').rect[0] = 130
    expect(recoverRuledBodyRecords(f.table, f.tokens, f.rules)).toBeUndefined()
  }
)
