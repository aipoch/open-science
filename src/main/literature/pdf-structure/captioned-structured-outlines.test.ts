import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const url = (name: string): string =>
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-' + name + '.mjs')).href
const { findCaptionCandidates } = await import(url('caption-group'))
const { refineTable, hasTableEvidence } = await import(url('table-refine'))
it.each([
  'captioned-survey-with-wrapped-question-and-ligatures',
  'two-column-box-with-final-paragraph-tail'
])('recovers explicit source structure in %s', (name) => {
  const x = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
  const captions = findCaptionCandidates(
    [x.page],
    new Map([[1, x.rules.map((r: number[]) => r.map((v) => v / 1.5))]])
  )
  expect(captions).toHaveLength(1)
  const t = refineTable(
    x.table,
    x.tokens,
    captions.map((c: { rect: number[] }) => ({ ...c, rect: c.rect.map((v) => v * 1.5) })),
    [],
    x.rules
  )
  expect(t.unassigned).toEqual([])
  expect(hasTableEvidence(t, captions[0], x.tokens)).toBe(true)
  if (name.startsWith('captioned')) {
    expect(t.grid).toHaveLength(15)
    expect(t.grid[0][0]).toMatch(/1\. Were.*this device\?$/)
    expect(t.grid.at(-1)[0]).toBe('Device B pneumatic compression device')
  } else {
    expect(t.grid).toHaveLength(7)
    expect(t.grid.at(-1)[1]).toContain('loss maintenance may improve.')
  }
})
