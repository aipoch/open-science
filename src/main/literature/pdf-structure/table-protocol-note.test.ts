import { readPdfFixture } from './read-fixture'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/double-spaced-protocol-note.jsonl'
    )
  )
it('recovers a cited symbol footnote touching the rule and its uniform double-spaced protocol block', () => {
  const x = load(),
    notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toContain('*centers without access to Ramipril')
  expect(notes[0].text).toContain('Perindopril), # similarly')
  expect(notes[0].text).toContain('HR < 50 beats/min')
  expect(notes[0].text).toMatch(/but the patients remained in the study\.$/)
  expect(notes[0].text).not.toContain('Journal Pre-proof')
  const i = x.input
  const before = refineTable(i.table, i.tokens, i.captions, [], i.rules)
  const after = refineTable(
    i.table,
    i.tokens,
    i.captions,
    notes.map((n: { rect: number[] }) => ({ ...n, rect: n.rect.map((v) => v * 1.5) })),
    i.rules
  )
  expect(after.grid).toEqual(before.grid)
  expect(after.unassigned).toEqual([])
})
it.each(['no-border', 'broken-border', 'uncited-marker', 'inside-table'])(
  'does not move a symbol across the table boundary without evidence: %s',
  (kind) => {
    const x = load()
    if (kind === 'no-border') x.rules = []
    if (kind === 'broken-border')
      x.rules = x.rules.filter(
        (r: number[]) => !(Math.abs(r[1] - x.tables[0].rect[3]) < 0.5 && r[0] > 260 && r[0] < 290)
      )
    if (kind === 'inside-table') x.tables[0].rect[3] += 12
    if (kind === 'uncited-marker')
      x.page.lines
        .filter((l: { y: number }) => l.y < x.tables[0].rect[3])
        .forEach((l: { text: string }) => (l.text = l.text.replaceAll('*', '')))
    expect(associateTableNotes(x.page, x.tables, x.rules)).toEqual([[]])
  }
)
it.each(['irregular-spacing', 'different-indent', 'caption', 'upright-notice'])(
  'does not follow a broken protocol continuation: %s',
  (kind) => {
    const x = load(),
      line = x.page.lines.find((l: { text: string }) => l.text.startsWith('Patients who developed'))
    if (kind === 'irregular-spacing') line.y += 7
    if (kind === 'different-indent') line.x += 8
    if (kind === 'caption') line.text = 'Table 3. Independent results.'
    if (kind === 'upright-notice') {
      const watermark = x.page.lines.find(
        (l: { text: string; y: number }) => l.text === 'Journal Pre-proof' && l.y > 200
      )
      watermark.height = watermark.fontSize
    }
    expect(
      associateTableNotes(x.page, x.tables, x.rules)
        .flat()
        .map((n: { text: string }) => n.text)
        .join(' ')
    ).not.toContain('but the patients remained in the study.')
  }
)

it('stops at the short final line of the validated protocol block', () => {
  const x = load()
  const final = x.page.lines.find(
    (l: { text: string }) => l.text === 'but the patients remained in the study.'
  )
  x.page.lines.push({
    ...final,
    y: final.y + final.height * 1.5,
    text: 'Unrelated results begin here.'
  })
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes[0].text).toMatch(/but the patients remained in the study\.$/)
  expect(notes[0].text).not.toContain('Unrelated results')
})
