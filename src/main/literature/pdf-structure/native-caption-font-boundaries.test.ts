import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const input = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-caption-font-boundaries.jsonl'
    )
  )

it.each([0, 1])('retains a closed smaller-font native legend paragraph (%s)', (index) => {
  const page = input()[index]
  const before = structuredClone(page)
  const caption = findCaptionCandidates([page])[0]
  const expected = index === 0 ? 7 : 4
  expect(caption.lines).toEqual(
    page.lines.slice(0, expected).map((line: { text: string }) => line.text)
  )
  expect(caption.rect[3]).toBeCloseTo(page.lines[expected - 1].y + page.lines[expected - 1].height)
  expect(page).toEqual(before)
})

it.each(['graphic', 'spacing', 'font', 'closure'])('requires independent %s proof', (missing) => {
  const page = input()[0]
  if (missing === 'graphic') page.graphicsBounds = []
  if (missing === 'spacing') {
    for (const line of page.lines.slice(1, 7)) line.y += 30
  }
  if (missing === 'font') page.lines[2].fontSize += 0.7
  if (missing === 'closure') page.lines[6].text = 'while the source continues'
  expect(findCaptionCandidates([page])[0].lines).toEqual([page.lines[0].text])
})

it('preserves native geometry under scaling and source reordering', () => {
  const page = input()[1]
  const scale = 1.7
  page.width *= scale
  page.height *= scale
  for (const line of page.lines) {
    for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
  }
  page.lines.reverse()
  page.graphicsBounds.reverse()
  expect(findCaptionCandidates([page])[0].lines).toHaveLength(4)
})

it('keeps a following numbered section and its body outside a closed caption', () => {
  const page = input()[2]
  const before = structuredClone(page)
  const caption = findCaptionCandidates([page])[0]
  expect(caption.lines).toEqual(page.lines.slice(0, 3).map((line: { text: string }) => line.text))
  expect(caption.rect[3]).toBeCloseTo(page.lines[2].y + page.lines[2].height)
  expect(page).toEqual(before)
})

it('does not use a heading-shaped string alone as a paragraph boundary', () => {
  const page = input()[2]
  page.lines.splice(4)
  expect(findCaptionCandidates([page])[0].lines).toContain(page.lines[3].text)
})

it.each([
  'Figure 8 reveals an independent pattern in the measured results.',
  'Figure 8 also reveals an independent pattern in the measured results.',
  'Figure 2.2a. When the sampled value is larger, the measured boundary changes.',
  'Figure 2.2a. When the parameter lies between two bounds, the system passes through the threshold.',
  'Table 6 further confirms the advantage under balanced evaluation.'
])('keeps a narrative reference out of caption ownership: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})

it.each([
  'Figure 8: Reveals of the independent pattern.',
  'Figure 2.2a. Accuracy under the measured conditions.',
  'Figure 2.2a. When measuring independent layouts.',
  'Table 6: Further comparison of the measured records.',
  'Table 11, continued (items 10–17).',
  'Table IV, continued (rows 3-8).'
])('retains explicit caption labels: %s', (text) => {
  expect(captionKind(text)).toBe(text.startsWith('Table') ? 'table' : 'figure')
})

it('does not interpret a narrative continuation as a continued-table label', () => {
  expect(captionKind('Table 11, continued the discussion of the measured records.')).toBeUndefined()
})
