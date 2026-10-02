import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { matchFigureSequence, rasterPlateRect } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-sequence.mjs')).href
)

it('keeps raster plates and external panel letters without proof graphics, page numbers or highlights', () => {
  const page = {
    width: 600,
    height: 800,
    graphicsBounds: [
      { kind: 'image', normalizedRect: [0.1, 0.2, 0.9, 0.6] },
      { kind: 'path', normalizedRect: [0.05, 0.03, 0.95, 0.06] },
      { kind: 'path', normalizedRect: [0.1, 0.3, 0.9, 0.8] }
    ],
    lines: [
      { text: '(A)', x: 290, y: 130, width: 20, height: 12 },
      { text: 'Fig. 1.', x: 40, y: 60, width: 40, height: 12 },
      { text: '24', x: 290, y: 700, width: 20, height: 10 },
      { text: 'Highlights:', x: 40, y: 600, width: 60, height: 12 },
      { text: 'An independent narrative paragraph.', x: 40, y: 650, width: 480, height: 12 }
    ]
  }
  expect(rasterPlateRect(page)).toEqual([60, 130, 540, 480])
})
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/standalone-panels-with-lagging-figure-labels.jsonl'
    )
  )

it('owns a complete lettered plate sequence despite running footers and lagging figure labels', () => {
  const { pages } = fixture(),
    original = structuredClone(pages)
  const result = matchFigureSequence(pages)
  expect([...result.keys()]).toEqual([3, 4, 5, 6, 7, 8])
  expect(result.get(4)).toBe(result.get(7))
  expect(result.get(4).lines.join(' ')).toBe('Figure 2. Outcomes (A), (B), (C), and (D).')
  expect(result.get(8).lines).toEqual(['Figure 3. Changes over time.'])
  expect(pages).toEqual(original)
})

it.each([
  'missing-panel',
  'duplicate-panel',
  'uncited-panel',
  'wrong-figure',
  'no-graphics',
  'unheaded'
])('rejects ambiguous standalone plate ownership: %s', (mode) => {
  const { pages } = fixture()
  if (mode === 'missing-panel') pages.splice(4, 1)
  if (mode === 'duplicate-panel') pages[4].lines[0].text = '(A)'
  if (mode === 'uncited-panel') pages[1].lines[1].text = 'Figure 2. Outcomes (A) and (B).'
  if (mode === 'wrong-figure') pages[6].lines[1].text = 'Fig. 4.'
  if (mode === 'no-graphics') pages[4].graphicCount = 0
  if (mode === 'unheaded') pages[0].lines.shift()
  expect(matchFigureSequence(pages).size).toBe(0)
})
