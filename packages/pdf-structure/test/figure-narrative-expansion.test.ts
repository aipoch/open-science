import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

it.each([
  'Figure 2 expands the task of Figure 1(b).',
  'Fig. 2 expands this independent comparison.',
  'Figure 2 (a) expands our earlier measurement.',
  'Figure S2 expands a source comparison.'
])('keeps the finite expansion reference in ordinary prose: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})

it.each([
  'Figure 2: Expands the task of the baseline.',
  'Figure 2. Expands the task of the baseline.',
  'Figure 2 Expansion of the evaluation task.',
  'Figure 2 Expansions across independent scales.',
  'Figure 2 Expanded task states.',
  'Figure 2 expands in the illustrated domain.'
])('preserves the existing caption admission outside the finite object shape: %s', (text) => {
  expect(captionKind(text)).toBe('figure')
})

it('associates one figure when its genuine caption is followed by a two-line expansion reference', () => {
  const line = (text: string, y: number): Record<string, string | number> => ({
    text,
    x: 60,
    y,
    width: 400,
    height: 10,
    fontSize: 10
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    renderRotation: 0,
    invalidGraphicsBounds: 0,
    lines: [
      line('Figure 2: Three independent strategies.', 400),
      line('Figure 2 expands the task of Figure 1(b),', 450),
      line('placing the same query in a wider context.', 464)
    ],
    graphicsBounds: [{ operationIndex: 0, kind: 'image', normalizedRect: [0.1, 0.1, 0.9, 0.48] }]
  }
  const captions = findCaptionCandidates([page])
  const figures = associateFigures(page, captions)
  expect(captions).toHaveLength(1)
  expect(figures).toHaveLength(1)
  expect(figures[0].caption.lines).toEqual(['Figure 2: Three independent strategies.'])
  expect(figures[0].rect).toEqual([60, 80, 540, 384])
})
