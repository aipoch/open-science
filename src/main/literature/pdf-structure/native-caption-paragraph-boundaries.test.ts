import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-caption-paragraph-boundaries.jsonl'
    )
  )

it('retains a long native caption after a full-width intermediate sentence', () => {
  const page = fixture()[0]
  const before = structuredClone(page)
  const [caption] = findCaptionCandidates([page])
  expect(caption.lines).toEqual(page.lines.slice(0, 12).map((l: { text: string }) => l.text))
  expect(caption.rect[3]).toBeCloseTo(page.lines[11].y + page.lines[11].height)
  expect(caption.lines.join(' ')).not.toContain('A separate body paragraph')
  expect(page).toEqual(before)
})

it('does not borrow formula evidence from a separate paragraph after a closed short caption', () => {
  const page = fixture()[1]
  const before = structuredClone(page)
  const [caption] = findCaptionCandidates([page])
  expect(caption.lines).toEqual(page.lines.slice(0, 3).map((l: { text: string }) => l.text))
  expect(caption.rect[3]).toBeCloseTo(page.lines[2].y + page.lines[2].height)
  expect(caption.lines.join(' ')).not.toContain('independent predictions')
  expect(page).toEqual(before)
})

it('keeps a two-line closed caption separate from neighboring body formula fragments', () => {
  const page = fixture()[1]
  const removed = page.lines.splice(1, 1)[0]
  const leading = page.lines[1].y - removed.y
  for (const line of page.lines) if (line.y > removed.y) line.y -= leading
  const before = structuredClone(page)
  const [caption] = findCaptionCandidates([page])
  expect(caption.lines).toEqual(page.lines.slice(0, 2).map((l: { text: string }) => l.text))
  expect(caption.rect[3]).toBeCloseTo(page.lines[1].y + page.lines[1].height)
  expect(page).toEqual(before)
})

it.each([
  [0, 0.73],
  [0, 1.7],
  [1, 0.73],
  [1, 1.7]
])(
  'keeps native paragraph ownership under source reordering and scale (%s, %s)',
  (index, scale) => {
    const page = fixture()[index]
    const expected = findCaptionCandidates([page])[0].lines
    page.width *= scale
    page.height *= scale
    for (const line of page.lines)
      for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
    page.lines.reverse()
    const before = structuredClone(page)
    expect(findCaptionCandidates([page])[0].lines).toEqual(expected)
    expect(page).toEqual(before)
  }
)

it.each(['B', 'C', 'G', 'H', 'T', 'Z'])(
  'distinguishes a finite-verb appendix reference from a literal title (%s)',
  (prefix) => {
    expect(
      captionKind(`Figure ${prefix}1 separates the measured values into independent groups.`)
    ).toBeUndefined()
    expect(captionKind(`Figure ${prefix}1: Separate measurements for independent groups.`)).toBe(
      'figure'
    )
  }
)
