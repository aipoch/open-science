import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/ruled-measurement-note.jsonl')
  )
it('recovers a wrapped ruled glossary and its native comparison explanation', () => {
  const x = load(),
    n = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(n).toHaveLength(1)
  expect(n[0].text).toBe(
    '3D-LVEF = 3-dimensional left ventricular ejection fraction; EF = ejection fraction; GLS = global longitudinal strain; CI = confidence interval; LV = left ventricular. *p values are for comparisons of changes in LVEF between baseline and 1 year.'
  )
  expect(x).toEqual(load())
})
it.each(['no-rule', 'uncited-keys', 'shifted-continuation'])(
  'does not attach an ambiguous ruled glossary with %s',
  (condition) => {
    const x = load()
    if (condition === 'no-rule') x.rules = []
    if (condition === 'uncited-keys')
      for (const l of x.page.lines)
        if (l.y < x.tables[0].rect[3] - 3)
          l.text = l.text.replaceAll('EF', 'AB').replaceAll('GLS', 'CD').replaceAll('CI', 'XY')
    if (condition === 'shifted-continuation')
      x.page.lines.find((l: { text: string }) => l.text.startsWith('interval;')).x += 30
    expect(associateTableNotes(x.page, x.tables, x.rules)).toEqual([[]])
  }
)
