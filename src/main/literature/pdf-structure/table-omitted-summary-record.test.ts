import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/omitted-wrapped-median.jsonl')
  )
it('recovers the omitted median record and its wrapped label without changing neighboring counts', () => {
  const x = load(),
    t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.grid).toContainEqual([
    'Median number of visits to a nurse (IQR)',
    '4 (2)',
    '6 (3)',
    '0.002'
  ])
  expect(t.grid).toContainEqual(['None', '2', '0', '0.027'])
  expect(t.unassigned).toEqual([])
})
it('keeps the underlined patient-count parent over both treatment columns', () => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/underlined-patient-header.jsonl'
    )
  )
  const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
  expect(t.cells).toContainEqual(
    expect.objectContaining({ text: 'Patients (n)', row: 0, column: 2, colSpan: 2 })
  )
})
it.each(['missing-value', 'intervening-rule', 'uppercase-label', 'foreign-record'])(
  'does not join an unsupported summary record: %s',
  (kind) => {
    const x = load()
    if (kind === 'missing-value')
      x.tokens = x.tokens.filter(
        (i: { text: string; baseline: number }) => !(i.text === '6 (3)' && i.baseline < 950)
      )
    if (kind === 'intervening-rule') x.rules.push([53, 930, 442, 930])
    if (kind === 'uppercase-label')
      x.tokens.find((i: { text: string }) => i.text === 'nurse (IQR)').text = 'Nurse (IQR)'
    if (kind === 'foreign-record')
      x.tokens.push({
        ...structuredClone(x.tokens.find((i: { text: string }) => i.text === 'nurse (IQR)')),
        text: '7',
        rect: [250, 932, 257, 944]
      })
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(t.repairs).not.toContain('overlapping-wrapped-summary-recovered')
  }
)
it.each(['missing-underline', 'off-center'])(
  'does not expand the count heading without matching native evidence: %s',
  (kind) => {
    const x = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/underlined-patient-header.jsonl'
      )
    )
    if (kind === 'missing-underline')
      x.rules = x.rules.filter((r: number[]) => Math.abs(r[1] - 703.22445) > 1)
    if (kind === 'off-center')
      for (const i of x.tokens.filter(
        (i: { text: string; baseline: number }) =>
          ['Patients (', 'n', ')'].includes(i.text) && i.baseline > 690 && i.baseline < 700
      )) {
        i.rect[0] += 8
        i.rect[2] += 8
      }
    const t = refineTable(x.table, x.tokens, x.captions, [], x.rules)
    expect(t.cells).not.toContainEqual(
      expect.objectContaining({ text: 'Patients (n)', row: 0, column: 2, colSpan: 2 })
    )
  }
)
