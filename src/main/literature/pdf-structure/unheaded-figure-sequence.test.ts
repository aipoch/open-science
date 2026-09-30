import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { matchFigureSequence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-sequence.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/unheaded-legends-before-exported-plates.jsonl'
    )
  )
it('uses the complete numbered export sequence to own an otherwise unlabelled raster plate', () => {
  const f = fixture(),
    original = structuredClone(f)
  const result = matchFigureSequence(f.pages)
  expect([...result.keys()]).toEqual([2, 3, 4])
  expect([...result.values()].map((c: { page: number }) => c.page)).toEqual([1, 1, 1])
  expect(f).toEqual(original)
})
it.each(['missing-plate', 'wrong-number', 'second-unlabelled', 'same-size', 'prose'])(
  'rejects insufficient sequence evidence: %s',
  (mode) => {
    const f = fixture()
    if (mode === 'missing-plate') f.pages.splice(1, 1)
    if (mode === 'wrong-number') f.pages[2].lines[0].text = 'Figure 4.'
    if (mode === 'second-unlabelled') f.pages[2].lines.shift()
    if (mode === 'same-size')
      Object.assign(f.pages[1], { width: f.pages[0].width, height: f.pages[0].height })
    if (mode === 'prose')
      f.pages[0].lines.unshift({
        ...f.pages[0].lines[0],
        text: 'A preceding paragraph of body prose.'
      })
    expect(matchFigureSequence(f.pages).size).toBe(0)
  }
)
