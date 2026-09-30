import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const load = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/wrapped-figure-reference-inside-statistical-prose.jsonl'
    )
  ).page

it('keeps a wrapped figure reference and the following sentence in body prose', () => {
  expect(findCaptionCandidates([load()])).toEqual([])
})

it.each(['separate-paragraph', 'other-column', 'different-font', 'complete-sentence'])(
  'retains a potential caption without contiguous prose-reference evidence: %s',
  (mode) => {
    const page = load()
    const start = page.lines.find((l: { text: string }) => l.text.startsWith('Figure 1.'))
    const preceding = page.lines.find((l: { text: string }) => /\bin$/.test(l.text))
    if (mode === 'separate-paragraph') {
      preceding.y -= 20
    }
    if (mode === 'other-column') {
      preceding.x -= 260
    }
    if (mode === 'different-font') {
      preceding.fontSize -= 2
    }
    if (mode === 'complete-sentence') {
      preceding.text = preceding.text.replace(/ in$/, '.')
    }
    expect(
      findCaptionCandidates([page]).some((c: { lines: string[] }) => c.lines[0] === start.text)
    ).toBe(true)
  }
)
