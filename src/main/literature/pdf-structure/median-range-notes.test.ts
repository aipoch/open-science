import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/median-range-notes-with-wrapped-definitions.jsonl'
    )
  )

it.each([0, 1, 2])(
  'retains the median/range definition and its wrapped glossary on source layout %s',
  (index) => {
    const x = fixture().cases[index]
    const notes = associateTableNotes(x.page, x.tables, x.rules)
    for (const table of notes) {
      const text = table.map((n: { text: string }) => n.text).join(' ')
      expect(text).toMatch(/^Values are/)
      expect(text).toMatch(/minimum[–-]maximum/)
      expect(text).toContain(
        index === 0
          ? 'sentinel node'
          : index === 1
            ? 'sleep efficiency'
            : 'Karolinska Sleepiness Scale'
      )
      expect(text).not.toMatch(
        /Table \d|No statistically significant|Visual Analogue Scale and Karolinska/
      )
    }
  }
)

it('does not classify ordinary interpretation of median values as a statistical note', () => {
  const x = fixture().cases[2]
  for (const line of x.page.lines)
    if (line.text.startsWith('Values are'))
      line.text = 'Values are lower in this group, and the median declined after follow-up.'
  expect(associateTableNotes(x.page, x.tables, x.rules).flat()).toEqual([])
})
