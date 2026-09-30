import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const { associateFigures, resolveFigureCaption, associateGraphicalAbstract } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
it.each(['header', 'footer'])('keeps an isolated %s decoration outside the figure crop', (edge) => {
  const caption = { page: 1, lines: ['Figure 1. Recorded outcomes'], rect: [40, 310, 280, 325] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [0.06, 0.12, 0.48, 0.38] },
      edge === 'header'
        ? { kind: 'path', normalizedRect: [0.44, 0, 0.465, 0.067] }
        : { kind: 'image', normalizedRect: [0.035, 0.977, 0.77, 0.997] }
    ]
  }
  const figures = associateFigures(page, [caption])
  expect(figures[0].rect).toBeDefined()
  expect(figures[0].rect[1]).toBeGreaterThan(70)
  expect(figures[0].rect[3]).toBeLessThan(330)
})
it('retains a graphical abstract with a descriptive paragraph before its centered plate', () => {
  const page = {
    pageNumber: 2,
    width: 600,
    height: 800,
    lines: [
      { text: 'Graphical Abstract', x: 90, y: 180, width: 105, height: 12 },
      {
        text: 'Participants received a blinded intervention before collection.',
        x: 108,
        y: 200,
        width: 390,
        height: 10
      },
      {
        text: 'The samples were analyzed for repeated outcome measurements.',
        x: 108,
        y: 214,
        width: 390,
        height: 10
      },
      { text: 'Keywords', x: 90, y: 470, width: 55, height: 10 }
    ],
    graphicsBounds: [{ kind: 'image', normalizedRect: [0.25, 0.3, 0.76, 0.55] }]
  }
  const result = associateGraphicalAbstract(page)
  expect(result?.rect).toEqual([150, 240, 456, 440.00000000000006])
  expect(result?.caption.lines).toHaveLength(3)
  page.lines[2].y = 250
  expect(associateGraphicalAbstract(page)).toBeUndefined()
})
it('recognizes a printed next-page figure continuation cue without inventing a legend', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      {
        text: '(Figure 3 continues on next page)',
        x: 400,
        y: 730,
        width: 150,
        height: 7,
        fontSize: 7
      }
    ]
  }
  const captions = findCaptionCandidates([page])
  expect(captions).toHaveLength(1)
  const full = { page: 2, lines: ['Figure 3: Outcome estimates'], rect: [40, 600, 500, 620] }
  expect(resolveFigureCaption(captions[0], [...captions, full])).toBe(full)
})
