import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'

const { completeNativeLetteredPairCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

function figureWithNativePair(stacked = false): ReturnType<typeof JSON.parse> {
  const width = 500,
    height = 600
  const frame = stacked ? [63, 40, 245, 260] : [63, 40, 430, 175]
  const caption = {
    page: 1,
    rect: [53, 280, 430, 310],
    lines: ['Fig. 1: Measurements in two panels. (a) Input. (b) Output.']
  }
  const source = (text: string, x: number, y: number, index: number): object => ({
    text,
    rect: [x, y, x + 5, y + 10],
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text }
  })
  const graphics = stacked
    ? [
        [70, 45, 235, 130],
        [70, 155, 235, 248]
      ]
    : [
        [70, 45, 195, 150],
        [251, 45, 420, 158]
      ]
  return {
    page: {
      pageNumber: 1,
      width,
      height,
      graphicsBounds: graphics.map((rect) => ({
        kind: 'path',
        normalizedRect: rect.map((value, axis) => value / (axis % 2 ? height : width))
      }))
    },
    figure: { caption, rect: frame },
    captions: [caption],
    tokens: [source('a', 55, 46, 3), source('b', stacked ? 55.2 : 236, stacked ? 155 : 46, 4)]
  }
}

it.each([false, true])('retains both native panel tags (stacked %s)', (stacked) => {
  const { page, figure, captions, tokens } = figureWithNativePair(stacked)
  const result = completeNativeLetteredPairCrop(page, figure, captions, [], tokens, () => false)
  expect(result?.rect).toEqual([54, 40, ...figure.rect.slice(2)])
  expect(result?.sourceItems).toEqual(tokens.map((token) => token.sourceItem))
})

it.each([
  'unrelated ink',
  'foreign ownership',
  'missing second panel',
  'missing caption reference'
])('leaves the established crop alone for %s', (variant) => {
  const { page, figure, captions, tokens } = figureWithNativePair()
  if (variant === 'unrelated ink') tokens.push({ text: 'z', rect: [58, 90, 62, 98] })
  if (variant === 'missing second panel') page.graphicsBounds.pop()
  if (variant === 'missing caption reference') captions[0].lines[0] = 'Fig. 1: A single panel.'
  const foreignOwns = (): boolean => variant === 'foreign ownership'
  expect(
    completeNativeLetteredPairCrop(page, figure, captions, [], tokens, foreignOwns)
  ).toBeUndefined()
})
