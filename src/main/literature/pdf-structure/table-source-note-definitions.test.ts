import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const firstPass = (x: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  x.models.map((model: unknown) => refineTable(model, x.tokens, x.captions, [], x.rules))
const regions = (tables: ReturnType<typeof firstPass>): ReturnType<typeof JSON.parse> =>
  tables.map((t: { cropRect: number[]; rows: { rect: number[] }[] }) => ({
    rect: [
      t.cropRect[0],
      Math.min(...t.rows.map((r) => r.rect[1])),
      t.cropRect[2],
      Math.max(...t.rows.map((r) => r.rect[3]))
    ].map((v) => v / 1.5)
  }))
const notes = (x: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  associateTableNotes(
    x.page,
    regions(firstPass(x)),
    x.rules.map((r: number[]) => r.map((v) => v / 1.5))
  )

it('assigns each repeated count/mean note to its own table', () => {
  const x = fixture('count-mean-notes'),
    n = notes(x)
  for (const parts of n)
    expect(parts[0].text).toMatch(/^All values are expressed as the number \(%\) and mean ± SD\./)
  expect(n[0][0].text).toBe(
    'All values are expressed as the number (%) and mean ± SD. P > 0.05 showed that there was no significant difference between treatment and non‐treatment groups.'
  )
  expect(n[1]).toHaveLength(1)
  expect(n[1][0].text).toBe('All values are expressed as the number (%) and mean ± SD.')
  expect(n[2][0].text).toBe(
    'All values are expressed as the number (%) and mean ± SD. ALT, alanine aminotransferase; AST, aspartate aminotransferase; BUN, Blood urea nitrogen; GI, gastrointestinal.'
  )
})
it.each(['resection-pair-note', 'spaced-resection-note'])(
  'preserves the bilingual cited glossary in %s',
  (name) => {
    const n = notes(fixture(name))[0]
    expect(n).toHaveLength(1)
    expect(n[0].text).toBe(
      name === 'resection-pair-note'
        ? 'CR: complete resection group; IR: incomplete resection group. CR : exérèse complète ; IR : exérèse incomplete.'
        : 'CR : complete resection group; IR: incomplete resection group. CR : exérèse complète ; IR : exérèse incomplète.'
    )
  }
)
it('retains the cited change-symbol definition and its wrapped abbreviation list', () => {
  const n = notes(fixture('change-symbol-note'))[0]
  expect(n[0].text).toBe(
    '∆ represents the change from baseline to 12 months for patients with paired values. 6MWT indicates 6-minute walk test; IQR, interquartile range; and SF-36, 36-item short-form.'
  )
  expect(n[1].text).toMatch(/^\*P values represent/)
})
it.each(['indentation', 'font-size', 'caption'])(
  'stops a cited-symbol continuation at changed %s evidence',
  (variant) => {
    const x = fixture('change-symbol-note')
    const continuation = x.page.lines.find((line: { text: string }) =>
      line.text.startsWith('interquartile range;')
    )
    if (variant === 'indentation') continuation.x -= 20
    else if (variant === 'font-size') continuation.fontSize += 2
    else continuation.text = 'Table 2. A separate comparison.'
    const n = notes(x)[0]
    expect(n[0].text).toMatch(/IQR,$/)
    expect(n[1].text).toMatch(/^\*P values represent/)
  }
)
it('preserves the complete parenthesized glossary without assigning corrupted clinical values', () => {
  const n = notes(fixture('parenthesized-treatment-note'))[0]
  expect(n).toHaveLength(1)
  expect(n[0].text).toBe(
    '(AI: Aromatase Inhibitor, ET: Endocrine Therapy; n: number of patients; ns: not significant, p: p-value).'
  )
})
it.each([
  'count-mean-notes',
  'resection-pair-note',
  'spaced-resection-note',
  'change-symbol-note',
  'parenthesized-treatment-note'
])(
  'keeps all data cells and source geometry unchanged while removing clipped notes in %s',
  (name) => {
    const x = fixture(name),
      original = structuredClone(x),
      before = firstPass(x),
      n = notes(x)
    const after = x.models.map((model: unknown, index: number) =>
      refineTable(
        model,
        x.tokens,
        x.captions,
        n[index].map((part: { rect: number[] }) => ({
          ...part,
          rect: part.rect.map((v) => v * 1.5)
        })),
        x.rules
      )
    )
    for (let index = 0; index < after.length; index++) {
      expect(after[index].grid).toEqual(before[index].grid)
      expect(after[index].cells).toEqual(before[index].cells)
      expect(after[index].cropRect).toEqual(before[index].cropRect)
      expect(after[index].unassigned).toEqual(before[index].unassigned)
      expect(after[index].clipped).toEqual([])
    }
    if (name === 'parenthesized-treatment-note') expect(after[0].unassigned).toEqual([])
    expect(x).toEqual(original)
  }
)

it.each([
  'count-mean-notes',
  'resection-pair-note',
  'spaced-resection-note',
  'change-symbol-note',
  'parenthesized-treatment-note'
])('does not attach definitions to distant or equally near competing tables in %s', (name) => {
  const x = fixture(name),
    frames = regions(firstPass(x)),
    rules = x.rules.map((r: number[]) => r.map((v) => v / 1.5))
  const competing = frames.flatMap((r: { rect: number[] }) => [r, structuredClone(r)])
  expect(associateTableNotes(x.page, competing, rules).every((n: unknown[]) => !n.length)).toBe(
    true
  )
  const distant = frames.map((r: { rect: number[] }) => ({
    rect: [...r.rect.slice(0, 3), r.rect[3] - 90]
  }))
  expect(associateTableNotes(x.page, distant, rules).every((n: unknown[]) => !n.length)).toBe(true)
})
it.each(['resection-pair-note', 'spaced-resection-note'])(
  'requires cited abbreviations and a native separator for the extended gap in %s',
  (name) => {
    const x = fixture(name),
      frames = regions(firstPass(x)),
      rules = x.rules.map((r: number[]) => r.map((v) => v / 1.5))
    expect(associateTableNotes(x.page, frames, [])[0]).toEqual([])
    for (const line of x.page.lines)
      if (line.y < frames[0].rect[3])
        line.text = line.text.replace(/\bCR\b/g, 'AA').replace(/\bIR\b/g, 'BB')
    expect(associateTableNotes(x.page, frames, rules)[0]).toEqual([])
  }
)
it.each(['resection-pair-note', 'spaced-resection-note'])(
  'does not give cited definitions to a closer table without those abbreviations in %s',
  (name) => {
    const x = fixture(name),
      frames = regions(firstPass(x)),
      rules = x.rules.map((r: number[]) => r.map((v) => v / 1.5))
    const other = { rect: [...frames[0].rect] }
    other.rect[1] =
      Math.max(
        ...x.page.lines
          .filter(
            (line: { text: string; y: number }) =>
              /\b(?:CR|IR)\b/.test(line.text) && line.y < frames[0].rect[3]
          )
          .map((line: { y: number; height: number }) => line.y + line.height)
      ) + 1
    other.rect[3] += 3
    const result = associateTableNotes(x.page, [...frames, other], rules)
    expect(result[0][0]?.text).toMatch(/^CR\s*: complete resection group/)
    expect(result.at(-1)).toEqual([])
  }
)
it('requires the change symbol in the actual recipient table', () => {
  const x = fixture('change-symbol-note'),
    frames = regions(firstPass(x)),
    rules = x.rules.map((r: number[]) => r.map((v) => v / 1.5))
  const other = { rect: [...frames[0].rect] }
  other.rect[1] =
    Math.max(
      ...x.page.lines
        .filter(
          (line: { text: string; y: number }) =>
            /[∆Δ]/.test(line.text) && line.y < frames[0].rect[3]
        )
        .map((line: { y: number; height: number }) => line.y + line.height)
    ) + 1
  other.rect[3] += 1
  const result = associateTableNotes(x.page, [...frames, other], rules)
  expect(result[0][0].text).toMatch(/^∆ represents/)
  expect(result.at(-1).some((n: { text: string }) => n.text.startsWith('∆'))).toBe(false)
  for (const line of x.page.lines)
    if (line.y < frames[0].rect[3]) line.text = line.text.replace(/[∆Δ]/g, 'Change')
  expect(
    associateTableNotes(x.page, frames, rules)[0].some((n: { text: string }) =>
      n.text.startsWith('∆')
    )
  ).toBe(false)
})
it.each(['ordinary-parenthetical', 'single-acronym'])(
  'keeps %s prose outside the glossary recognizer',
  (variant) => {
    const x = fixture('parenthesized-treatment-note')
    const first = x.page.lines.find((line: { text: string }) => line.text.startsWith('(AI:'))
    first.text =
      variant === 'ordinary-parenthetical'
        ? '(Patient characteristics are compared between the groups.)'
        : '(AI: Aromatase Inhibitor; n: number of patients; ns: not significant; p: p-value).'
    x.page.lines = x.page.lines.filter(
      (line: { y: number }) => line.y <= first.y || line.y > first.y + 15
    )
    expect(notes(x)[0]).toEqual([])
  }
)
it('does not remove a note-shaped value inside the table body', () => {
  const x = fixture('count-mean-notes'),
    frames = regions(firstPass(x)),
    rules = x.rules.map((r: number[]) => r.map((v) => v / 1.5))
  for (const frame of frames) frame.rect[3] += 30
  const result = associateTableNotes(x.page, frames, rules)
  expect(result.flat().some((n: { text: string }) => n.text.startsWith('All values'))).toBe(false)
})

it('keeps note ownership and consumed lines local when different pages reuse text classifiers', () => {
  const pages = ['count-mean-notes', 'resection-pair-note', 'change-symbol-note'].map(fixture)
  const expected = structuredClone(pages.map(notes))
  notes(pages[0])[0][0].text = 'Changed returned note'
  for (const index of [2, 0, 1, 0]) expect(notes(pages[index])).toEqual(expected[index])
})

it.each([
  ['raised-letter-model-notes', ['a Akaike information criterion.', 'b Not available.']],
  [
    'raised-letter-followup-glossary',
    [
      'a FUP1: first follow-up.',
      'b FUP2: second follow-up.',
      'c NCQ: Nijmegen Continuity Questionnaire.',
      'd TCC: team and cross-boundary continuity.',
      'e GAD-7: Generalized Anxiety Disorder Screener.',
      'f P≤.05 (t tests were used to compare change scores).',
      'g PHQ-9: Patient Health Questionnaire on Major Depression.',
      'h PPE-15: Picker Patient Experience Questionnaire.'
    ]
  ]
])('attaches closely raised source letters in %s', (name, expected) => {
  expect(notes(fixture(name))[0].map((n: { text: string }) => n.text)).toEqual(expected)
})
it.each(['same-baseline', 'same-size', 'distant-marker'])(
  'requires raised source evidence for a detached letter with %s',
  (variant) => {
    const x = fixture('raised-letter-model-notes')
    for (const line of x.page.lines) {
      if (!/^[ab]$/.test(line.text) || line.y < 640) continue
      if (variant === 'same-baseline') line.y += 3.825
      if (variant === 'same-size') line.fontSize = 8.5
      if (variant === 'distant-marker') line.x -= 10
    }
    expect(notes(x)[0]).toEqual([])
  }
)
it('stops a wrapped footnote before the next indented methods paragraph', () => {
  const n = notes(fixture('footnote-before-indented-methods'))[0]
  expect(n).toHaveLength(1)
  expect(n[0].text).toMatch(/by guessing the answers\.$/)
  expect(n[0].text).not.toContain('intention')
})
