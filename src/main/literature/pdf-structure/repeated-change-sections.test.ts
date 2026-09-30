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
      'src/main/literature/pdf-structure/fixtures/source-grids/repeated-change-records-with-unowned-sections.jsonl'
    )
  )
it('recovers every wrapped section around repeated complete change records', () => {
  const x = fixture(),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.unassigned).toEqual([])
  for (const label of [
    'FSI: Total Disruption Index',
    'FSI: Average Weekly Fatigue',
    'Physical Function SPPB: Ordinal Score'
  ])
    expect(t.grid.some((r: string[]) => r[0] === label && r.slice(1).every((s) => !s))).toBe(true)
  expect(t.grid.filter((r: string[]) => r[0] === 'End of RT - Baseline')).toHaveLength(10)
  expect(t.grid.filter((r: string[]) => r[0] === 'Follow-up – Baseline')).toHaveLength(10)
  expect(t.grid.find((r: string[]) => r[0].includes('PROMIS Pain'))?.slice(1)).toEqual([
    '',
    '',
    '',
    ''
  ])
})
it('declines a global rebuild when one section has a different record sequence', () => {
  const x = fixture()
  x.tokens.find((t: { text: string }) => t.text === 'End of RT - Baseline').text =
    'Independent outcome'
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.repairs).not.toContain('repeated-measurement-section-separated')
  expect(t.grid.find((r: string[]) => r[0] === 'Independent outcome')).toEqual([
    'Independent outcome',
    '2.7 (9.9)',
    '1.8 (14.0)',
    '0.88 (−6.01, 7.77)',
    '0.61'
  ])
  // Local ownership can recover a single heading without trusting the broken
  // global sequence. The ambiguous wrapped section must remain unresolved.
  expect(t.grid.find((r: string[]) => r[0] === 'PROMIS Fatigue SF8⁎:')?.slice(1)).toEqual([
    '',
    '',
    '',
    ''
  ])
  expect(t.unassigned).toContain('Physical Function SPPB:')
})
