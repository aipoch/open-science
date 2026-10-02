import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { associateTableNotes } = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_NOTES_REPLAY_MODULE ??
        'resources/pdf-structure/literature-pdf-table-notes.mjs'
    )
  ).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )
const texts = (x: ReturnType<typeof fixture>): string =>
  associateTableNotes(x.page, x.tables, x.rules)[0]
    .map((n: { text: string }) => n.text)
    .join(' ')

it('owns a classification definition before its marked agreement note', () => {
  const x = fixture('closed-classification-definition-before-marked-note')
  expect(texts(x)).toContain('Non-limited: AX/BY ratio <1.4, CX/BY ratio <1;')
})
it.each(['M, Mean, SD, standard deviation', 'SD, standard deviation.'])(
  'owns the native first statistic glossary %s',
  (text) => {
    const x = fixture('closed-classification-definition-before-marked-note')
    x.page.lines[3].text = text
    if (text.startsWith('SD,')) {
      x.rules[0][1] = x.rules[0][3] = 214
      x.page.lines[3].y = 220
      x.page.lines[4].y = 230
    }
    expect(texts(x)).toContain(text)
  }
)
it('retains a bounded method footer while excluding a later article paragraph', () => {
  const x = fixture('closed-statistical-method-with-external-prose')
  expect(texts(x)).toContain('including all available observations from the scheduled visits.')
  expect(texts(x)).not.toContain('unrelated paragraph')
})
it.each([
  'P‐values less than or equal to 0.04 are denoted in bold.',
  'Legend: *, p-value for difference between groups after'
])('owns the native statistical annotation %s', (text) => {
  const x = fixture('closed-statistical-method-with-external-prose')
  x.page.lines[3].text = text
  if (text.startsWith('P')) x.page.lines[0].text += ' P-value'
  if (text.startsWith('Legend')) {
    x.page.lines[3].x = x.page.lines[4].x = 76
    x.page.lines[3].width = 240
    x.page.lines[4].text = 'adjustment using ANCOVA'
    x.page.lines[4].width = 120
  }
  expect(texts(x)).toContain(text)
})
it.each([0.5, 1.5])('uses only closely joined native footer segments with gap %s', (gap) => {
  const x = fixture('closed-statistical-method-with-external-prose')
  x.page.lines[3].text = 'Legend: *, p-value for difference between groups after'
  x.page.lines[3].x = x.page.lines[4].x = 76
  x.page.lines[3].width = 240
  x.page.lines[4].text = 'adjustment using ANCOVA'
  x.rules = [
    [44, 203, 195, 203],
    [195 + gap, 203, 346, 203]
  ]
  expect(texts(x).includes('Legend:')).toBe(gap === 0.5)
})
it('retains a raised letter note that starts with an ordinary integer', () => {
  const x = fixture('raised-letter-note-with-integer-opening')
  expect(texts(x)).toContain('a 37 participants.')
  expect(texts(x)).toContain('b Repeated assessments were included.')
})
it('keeps an asterisk-operator note tail aligned with its native closing rule', () => {
  const x = fixture('asterisk-operator-note-with-outdented-definition-tail')
  expect(texts(x)).toContain('gamma and delta quantities.')
})
it.each([
  'no closing',
  'intervening prose',
  'uncited subject',
  'competing owner',
  'oversized font'
])('rejects an unmarked definition without %s proof', (variant) => {
  const x = fixture('closed-classification-definition-before-marked-note')
  if (variant === 'no closing') x.rules = []
  if (variant === 'intervening prose')
    x.page.lines.push({
      text: 'Ordinary article prose.',
      x: 44,
      y: 199,
      width: 180,
      height: 8,
      fontSize: 8
    })
  if (variant === 'uncited subject') x.page.lines[0].text = 'Another label M SD AX N *'
  if (variant === 'competing owner') x.tables.push(structuredClone(x.tables[0]))
  if (variant === 'oversized font') x.page.lines[3].fontSize = x.page.lines[3].height = 12
  expect(texts(x)).not.toContain('Non-limited:')
})
it.each(['no closing', 'no numeric body', 'caption', 'changed font', 'intervening prose'])(
  'rejects or stops a method footer with %s',
  (variant) => {
    const x = fixture('closed-statistical-method-with-external-prose')
    if (variant === 'no closing') x.rules = []
    if (variant === 'no numeric body')
      x.page.lines = x.page.lines.filter((l: { text: string }) => !/^\d/.test(l.text))
    if (variant === 'caption') x.page.lines[4].text = 'Figure 3. Another unrelated display.'
    if (variant === 'changed font') x.page.lines[4].height = x.page.lines[4].fontSize = 11
    if (variant === 'intervening prose')
      x.page.lines.push({
        text: 'Ordinary article prose.',
        x: 44,
        y: 199,
        width: 180,
        height: 8,
        fontSize: 8
      })
    expect(texts(x)).not.toContain('including all available observations')
  }
)
it('does not interpret an unraised letter and count in article prose as a note', () => {
  const x = fixture('raised-letter-note-with-integer-opening')
  x.page.lines[3].fontSize = x.page.lines[3].height = 8
  x.page.lines[3].y = 209
  x.page.lines[5].fontSize = x.page.lines[5].height = 8
  x.page.lines[5].y = 221
  expect(texts(x)).not.toContain('37 participants')
})
