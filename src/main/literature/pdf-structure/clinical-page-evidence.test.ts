import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const runtime = (name: string): string =>
  pathToFileURL(resolve(`resources/pdf-structure/literature-pdf-${name}.mjs`)).href
const { associateFigures } = await import(runtime('association'))
const { findCaptionCandidates } = await import(runtime('caption-group'))
const { associateTableNotes } = await import(runtime('table-notes'))
const { refineTable } = await import(runtime('table-refine'))
const load = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', `${name}.jsonl`)
  )

it.each([
  ['raster-with-outlined-prose', [52, 281, 562, 625]],
  ['dated-header-above-panels', [58, 103, 545, 443]],
  ['repeated-external-plot-legend', [49, 74, 508, 467]],
  ['consort-plate-title', [38, 71, 589, 622]]
] as const)('keeps native figure content and excludes surrounding prose: %s', (name, box) => {
  const f = load(name)
  const found = associateFigures(f.page, findCaptionCandidates([f.page]))
  expect(found).toHaveLength(1)
  expect(found[0].rect.every((v: number, n: number) => Math.abs(v - box[n]) < 1)).toBe(true)
  expect(found[0].reason).toBeUndefined()
})

it('rejects a wrapped body reference but retains a standalone numbered figure caption', () => {
  const f = load('wrapped-body-figure-reference')
  expect(
    findCaptionCandidates([f.page]).filter((c: { lines: string[] }) => /^Figure 2/.test(c.lines[0]))
  ).toEqual([])
  f.page.lines = f.page.lines.filter((l: { y: number }) => l.y > 217)
  expect(
    findCaptionCandidates([f.page]).filter((c: { lines: string[] }) => /^Figure 2/.test(c.lines[0]))
  ).toHaveLength(1)
})

it.each([
  ['segmented-rule-glossary', 'CI: confidence intervals; HR: hazard ratios.', 1],
  ['dose-definition-notes', 'SD 260, 260 mg/m²', 2],
  ['multivariate-symbol-notes', 'NOTE. ＊In multivariate Cox regression', 2],
  ['paired-procedure-definitions', 'PCSAPB serratus anterior block', 2],
  ['single-society-definition', 'BMAS, British Medical Acupuncture Society.', 1]
] as const)('assigns complete native notes to their own table: %s', (name, prefix, count) => {
  const f = load(name)
  const notes = readNotes(f)
  expect(
    notes.filter((list: { text: string }[]) => list.some((n) => n.text.startsWith(prefix)))
  ).toHaveLength(count)
  expect(notes.flat().every((n: { rect: number[] }) => n.rect.every(Number.isFinite))).toBe(true)
})

function readNotes(f: ReturnType<typeof JSON.parse>): { text: string; rect: number[] }[][] {
  const tables = f.models.map((m: unknown) => refineTable(m, f.tokens, f.captions, [], f.rules))
  const rects = tables.map((t: { cropRect: number[]; rows: { rect: number[] }[] }) => ({
    rect: [
      t.cropRect[0],
      Math.min(...t.rows.map((r) => r.rect[1])),
      t.cropRect[2],
      Math.max(...t.rows.map((r) => r.rect[3]))
    ].map((v) => v / 1.5)
  }))
  return associateTableNotes(
    f.page,
    rects,
    f.rules.map((r: number[]) => r.map((v) => v / 1.5))
  )
}

it('keeps a wrapped statistical method in its sentence but separates a new complete note', () => {
  const f = load('wrapped-statistical-method-note')
  const notes = readNotes(f)[0]
  expect(notes).toHaveLength(2)
  expect(notes[1].text.endsWith('using Fisher’s exact test.')).toBe(true)
  const line = f.page.lines.find((l: { text: string }) => l.text.endsWith('determined using'))
  expect(line).toBeDefined()
  line.text = line.text.replace(/using$/, 'separately.')
  expect(readNotes(f)[0].some((n) => n.text === 'Fisher’s exact test.')).toBe(true)
})
