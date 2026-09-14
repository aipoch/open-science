import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids/ruled-comparison-note.jsonl')
  )
it('recovers a ruled comparison note with two P values and cited definitions on its continuation', () => {
  const x = load(),
    n = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(n).toHaveLength(1)
  expect(n[0].text).toBe(
    'P=0.44 for chemotherapy interruption between the two groups, and p=0.91 for chemotherapy discontinuation; EF = ejection fraction; GLS = global longitudinal strain'
  )
  expect(x).toEqual(load())
})
it.each(['no-rule', 'one-p-value', 'uncited-keys', 'shifted-continuation'])(
  'does not attach an ambiguous comparison note with %s',
  (condition) => {
    const x = load()
    if (condition === 'no-rule') x.rules = []
    if (condition === 'one-p-value')
      x.page.lines.find((l: { text: string }) => l.text.startsWith('P=')).text =
        'P=0.44 for chemotherapy interruption between the two groups'
    if (condition === 'uncited-keys')
      for (const l of x.page.lines)
        if (l.y < x.tables[0].rect[3] - 3)
          l.text = l.text.replaceAll('EF', 'AB').replaceAll('GLS', 'CD')
    if (condition === 'shifted-continuation')
      x.page.lines.find((l: { text: string }) => l.text.startsWith('discontinuation;')).x += 30
    expect(associateTableNotes(x.page, x.tables, x.rules)).toEqual([[]])
  }
)
