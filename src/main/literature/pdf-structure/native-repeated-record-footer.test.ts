import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { recoverRepeatedRecordFooterNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const line = (
  text: string,
  y: number
): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
  text,
  x: 25,
  y,
  width: 245,
  height: 10,
  fontSize: 10
})
const fixture = (): ReturnType<typeof JSON.parse> => ({
  page: {
    pageNumber: 7,
    width: 310,
    height: 450,
    lines: [
      line('Note. A mark indicates that the corresponding entry', 302),
      line('could not be measured within the stated conditions.', 313)
    ]
  },
  proof: { tables: [{ cropRect: [30, 60, 180, 450] }, { cropRect: [210, 60, 420, 450] }] },
  rules: [
    [20, 300, 120, 300],
    [140, 300, 280, 300]
  ]
})
it('keeps a unique two-line footer on the union of two independently qualified closed parts', () => {
  const x = fixture(),
    before = JSON.stringify(x),
    notes = recoverRepeatedRecordFooterNotes(x.page, x.proof, x.rules)
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toContain('could not be measured within the stated conditions.')
  expect(notes[0].rect).toEqual([25, 302, 270, 323])
  expect(JSON.stringify(x)).toBe(before)
})
it.each([
  'missing closing',
  'competing footer',
  'intervening prose',
  'single part',
  'unequal closing',
  'different font',
  'distant footer'
])('refuses an unproved shared footer: %s', (variant) => {
  const x = fixture()
  if (variant === 'missing closing') x.rules.pop()
  if (variant === 'competing footer')
    x.page.lines.push(
      line('Note. A second independent footer definition starts.', 324),
      line('Additional prose must keep its separate source owner.', 335)
    )
  if (variant === 'intervening prose')
    x.page.lines[0].text = 'Ordinary paragraph preceding a separate explanation.'
  if (variant === 'single part') x.proof.tables.pop()
  if (variant === 'unequal closing') x.proof.tables[1].cropRect[3] += 15
  if (variant === 'different font') x.page.lines[1].fontSize = 12
  if (variant === 'distant footer') x.page.lines.forEach((l: { y: number }) => (l.y += 20))
  expect(recoverRepeatedRecordFooterNotes(x.page, x.proof, x.rules)).toBeUndefined()
})
