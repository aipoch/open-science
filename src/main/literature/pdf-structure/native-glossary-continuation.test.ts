import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const load = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/centered-native-glossary-continuation.jsonl'
    )
  )
it('keeps a centered digit-prefixed glossary and its unfinished definition across unequal line indents', () => {
  const f = load()
  expect(associateTableNotes(f.page, f.tables, f.rules)).toEqual([
    [
      {
        text: '3XYZ = Amber descriptor; ZQ = Azure descriptor; RT = Coral descriptor; K8 = Lavender descriptor.',
        rect: [50, 107, 340, 124.5]
      }
    ]
  ])
})
const { recoverCenteredRuledGlossaries } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-note-blocks.mjs')).href
)
const { groupPageLines } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
it.each([
  'missing closing',
  'uncited keys',
  'competing table',
  'foreign paragraph',
  'different font',
  'off-center tail',
  'overlapping lines'
])('declines an unproved glossary block: %s', (variant) => {
  const f = load()
  if (variant === 'missing closing') f.rules.pop()
  if (variant === 'uncited keys')
    for (const line of f.page.lines.slice(0, 3)) line.text = '31 42 53'
  if (variant === 'competing table') f.tables.push({ rect: [45, 30, 335, 98] })
  if (variant === 'foreign paragraph')
    f.page.lines.push({
      text: 'Following paragraph begins here.',
      x: 70,
      y: 111,
      width: 230,
      height: 8,
      fontSize: 8
    })
  if (variant === 'different font') f.page.lines[4].fontSize = 9
  if (variant === 'off-center tail') f.page.lines[4].x = 100
  if (variant === 'overlapping lines') f.page.lines[4].y = 114
  const notes = recoverCenteredRuledGlossaries(f.page, f.tables, f.rules, groupPageLines(f.page))
  expect(notes.every((group: unknown[]) => !group.length)).toBe(true)
})
it('retains ordinary prose after the terminal glossary as body content', () => {
  const f = load()
  const notes = associateTableNotes(f.page, f.tables, f.rules)
  expect(notes[0]).toHaveLength(1)
  expect(notes[0][0].text).not.toContain('Ordinary')
})
