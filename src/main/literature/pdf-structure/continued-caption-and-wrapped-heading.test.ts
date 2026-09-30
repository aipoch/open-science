import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { resolveFigureCaption, deduplicateFigureCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))

it('suppresses only a caption-only tail owned by a proved graphic, including an auxiliary page', () => {
  const captions = fixture('numbered-caption-with-next-page-sentence-tail')
  const combined = resolveFigureCaption(captions[0], captions)
  const owner = {
    region: [100, 100, 480, 660],
    caption: { ...combined, text: combined.lines.join(' ') }
  }
  const tail = { caption: { ...captions[1], text: captions[1].lines.join(' ') } }
  expect(deduplicateFigureCaptions([owner, tail])).toEqual([owner])
  expect(deduplicateFigureCaptions([tail], [owner])).toEqual([])
  expect(deduplicateFigureCaptions([tail], [{ ...owner, region: undefined }])).toEqual([tail])
  const different = { caption: { ...tail.caption, rect: [100, 100, 400, 120] } }
  expect(deduplicateFigureCaptions([different], [owner])).toEqual([different])
  const plate = { ...tail, region: [100, 120, 480, 500] }
  expect(deduplicateFigureCaptions([plate], [owner])).toEqual([plate])
})

it('joins an explicitly continued caption while retaining both source rectangles', () => {
  const captions = fixture('numbered-caption-with-next-page-sentence-tail')
  const result = resolveFigureCaption(captions[0], captions)
  expect(result.lines.join(' ')).toContain('for time to first subsequent chemotherapy')
  expect(result.lines.join(' ')).not.toMatch(/continued/i)
  expect(result.regions).toEqual(
    captions.map(({ page, rect }: { page: number; rect: number[] }) => ({ page, rect }))
  )
})

it.each(['number', 'page', 'marker', 'pointer', 'ambiguous', 'further-page'])(
  'does not join caption fragments with insufficient ownership: %s',
  (mode) => {
    const c = fixture('numbered-caption-with-next-page-sentence-tail')
    if (mode === 'number') c[1].lines[0] = c[1].lines[0].replace('2.', '3.')
    if (mode === 'page') c[1].page++
    if (mode === 'marker') c[1].lines[0] = c[1].lines[0].replace('(Continued).', '')
    if (mode === 'pointer')
      c[0].lines[2] = c[0].lines[2].replace('(continued on following page)', '')
    if (mode === 'ambiguous') c.push(structuredClone(c[1]))
    if (mode === 'further-page') c[1].lines.push('(continued on following page)')
    expect(resolveFigureCaption(c[0], c)).toBe(c[0])
  }
)

const tableFixture = (): ReturnType<typeof JSON.parse> =>
  fixture('scale-label-prefix-before-complete-cohort-record')
const parse = (x: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  refineTable(x.table, x.tokens, x.captions, x.notes, x.rules)
it('uses independent native prose to join a reverse-indented section heading', () => {
  const t = parse(tableFixture())
  expect(t.grid.some((row: string[]) => row[0] === 'Theory of Planned Behaviour')).toBe(true)
  expect(t.grid.some((row: string[]) => row[0] === 'Generalized distress')).toBe(true)
  expect(t.unassigned).toEqual([])
})

it.each([
  'absent',
  'different-phrase',
  'sentence-break',
  'different-column',
  'distant-line',
  'separator'
])('preserves ambiguous adjacent section labels without a trustworthy witness: %s', (mode) => {
  const x = tableFixture()
  const witnesses = x.tokens.filter((t: { rect: number[] }) => t.rect[1] > 850)
  if (mode === 'absent') x.tokens = x.tokens.filter((t: { rect: number[] }) => t.rect[1] < 850)
  if (mode === 'different-phrase')
    witnesses[1].text = witnesses[1].text.replace('Behaviour', 'Behavioral')
  if (mode === 'sentence-break')
    witnesses[1].text = witnesses[1].text.replace('Planned Behaviour', 'Planned. Behaviour')
  if (mode === 'different-column') {
    witnesses[1].rect[0] += 300
    witnesses[1].rect[2] += 300
  }
  if (mode === 'distant-line') {
    witnesses[1].baseline += 100
    witnesses[1].rect[1] += 100
    witnesses[1].rect[3] += 100
  }
  if (mode === 'separator') x.rules.push([72, 560, 680, 560])
  expect(parse(x).grid.some((row: string[]) => row[0] === 'Theory of Planned Behaviour')).toBe(
    false
  )
})
