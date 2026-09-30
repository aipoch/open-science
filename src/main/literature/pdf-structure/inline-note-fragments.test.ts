import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
const referenceCase = 'detached-raised-reference-after-letter-note'
const letterCase = 'raised-letter-between-note-word-and-punctuation'
const extract = (x: ReturnType<typeof JSON.parse>): { text: string; rect: number[] }[] =>
  associateTableNotes(x.page, x.tables, x.rules)[0]

it('retains a terminal bracket reference split away from an accepted letter note', () => {
  const x = load(referenceCase)
  const notes = extract(x)
  expect(notes[0].text).toBe('a) According to the published measurement recommendations; [32]')
  expect(notes[0].rect[2]).toBeCloseTo(288.42365951)
  expect(notes.map((n) => n.text).join(' ')).not.toContain('neighboring column')
})

it('removes only invented spaces around a native raised letter and adjoining punctuation', () => {
  const x = load(letterCase)
  const notes = extract(x)
  expect(notes[0].text).toContain('shown. No, peak number')
  expect(notes[0].text.match(/\[33\]/g)).toHaveLength(1)
})

it.each([0.7, 1.8])('keeps source adjacency constraints at scale %s', (scale) => {
  for (const name of [referenceCase, letterCase]) {
    const x = load(name)
    for (const l of x.page.lines)
      for (const k of ['x', 'y', 'width', 'height', 'fontSize']) l[k] *= scale
    for (const t of x.tables) t.rect = t.rect.map((v: number) => v * scale)
    x.rules = x.rules.map((r: number[]) => r.map((v) => v * scale))
    const text = extract(x)
      .map((n) => n.text)
      .join(' ')
    expect(text).toContain(name === referenceCase ? '; [32]' : 'shown. No,')
  }
})

it.each(['normal-font', 'gutter', 'duplicate-source', 'unowned-anchor'])(
  'does not restore an unsupported reference: %s',
  (variant) => {
    const x = load(referenceCase)
    const ref = x.page.lines.find((l: { text: string }) => l.text === '[32]')
    const body = x.page.lines.find((l: { text: string }) => l.text.startsWith('According to the'))
    if (variant === 'normal-font') ref.fontSize = body.fontSize
    if (variant === 'gutter') ref.x += 25
    if (variant === 'duplicate-source') x.page.lines.push({ ...body })
    if (variant === 'unowned-anchor') x.tables[0].rect[3] = body.y + body.height
    expect(extract(x).some((n) => n.text.includes('[32]'))).toBe(false)
  }
)

it('preserves an already grouped reference exactly once', () => {
  const x = load(referenceCase)
  const ref = x.page.lines.find((l: { text: string }) => l.text === '[32]')
  const body = x.page.lines.find((l: { text: string }) => l.text.startsWith('According to the'))
  ref.y = body.y + body.height - ref.height
  expect(extract(x)[0].text.match(/\[32\]/g)).toHaveLength(1)
})

it.each(['normal-font', 'normal-baseline', 'gutter', 'not-punctuation', 'duplicate-source'])(
  'preserves spaces without complete native inline-letter evidence: %s',
  (variant) => {
    const x = load(letterCase)
    const letter = x.page.lines.find((l: { text: string }) => l.text === 'o')
    const body = x.page.lines.find((l: { text: string }) => l.text.startsWith('Values are shown'))
    const punctuation = x.page.lines.find((l: { text: string }) => l.text === ',')
    if (variant === 'normal-font') letter.fontSize = body.fontSize
    if (variant === 'normal-baseline') letter.y = body.y + body.height - letter.height
    if (variant === 'gutter') letter.x += 15
    if (variant === 'not-punctuation') punctuation.text = 'word'
    if (variant === 'duplicate-source') x.page.lines.push({ ...body })
    expect(extract(x).some((n) => n.text.includes('shown. No,'))).toBe(false)
  }
)
