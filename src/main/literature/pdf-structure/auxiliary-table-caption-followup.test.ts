import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
const { findCaptionCandidates, recoverAuxiliaryTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/auxiliary-bare-table-title-with-quantized-opening.jsonl'
    )
  )
it('uses existing auxiliary native path evidence for the complete original caption', () => {
  const f = fixture(),
    before = findCaptionCandidates([f.page])
  expect(before[0].lines).toEqual(['Table 1'])
  expect(recoverAuxiliaryTableCaptions([f.page], before, [31, 32, 33, 34, 35])).toEqual([
    {
      page: 29,
      lines: ['Table 1', 'Patient, Tumor, and Treatment Characteristics (n = 693).'],
      rect: [70.9, 212.4949999999999, 343.58799999999997, 260.09300999999994]
    }
  ])
  expect(before[0].lines).toEqual(['Table 1'])
})
it.each([
  'requested',
  'image',
  'thick-path',
  'short-path',
  'wrong-title',
  'missing-source',
  'font-change',
  'intervening-caption',
  'figure'
])('keeps caption unchanged with %s', (variant) => {
  const f = fixture(),
    before = findCaptionCandidates([f.page])
  let requested = [31]
  if (variant === 'requested') requested = [29]
  if (variant === 'image') f.page.graphicsBounds[0].kind = 'image'
  if (variant === 'thick-path') f.page.graphicsBounds[0].normalizedRect[3] += 0.03
  if (variant === 'short-path') f.page.graphicsBounds[0].normalizedRect[2] = 0.4
  if (variant === 'wrong-title')
    f.page.lines[1].text = 'Patient characteristics were summarized here.'
  if (variant === 'missing-source') f.page.lines.pop()
  if (variant === 'font-change') f.page.lines[1].fontSize += 2
  if (variant === 'intervening-caption')
    f.page.lines.push({ ...f.page.lines[0], text: 'Table 2', y: 230 })
  if (variant === 'figure') before[0].lines = ['Figure 1']
  expect(recoverAuxiliaryTableCaptions([f.page], before, requested)).toEqual(before)
})
