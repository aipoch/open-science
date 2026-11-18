import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { completeCaptionLocalRasterPair } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

function localPair(): ReturnType<typeof JSON.parse> {
  const width = 620,
    height = 760
  const caption = {
    page: 1,
    rect: [315, 270, 550, 298],
    lines: ['Fig. 1: Response to (a) input size and (b) delay.']
  }
  const image = (rect: number[]): object => ({
    kind: 'image',
    normalizedRect: rect.map((value, axis) => value / (axis % 2 ? height : width))
  })
  const label = (text: string, rect: number[], index: number): object => ({
    text,
    rect,
    horizontal: true,
    baseline: rect[3],
    sourceItem: { pageNumber: 1, index, text }
  })
  return {
    page: {
      pageNumber: 1,
      width,
      height,
      graphicsBounds: [
        image([60, 152, 180, 243]),
        image([320, 152, 427, 243]),
        image([429, 153, 539, 242])
      ],
      lines: [{ x: 315, y: 270, width: 235, height: 10, fontSize: 10 }]
    },
    figure: { rect: [318, 151, 428, 254], caption },
    captions: [caption],
    tokens: [
      label('(a) Input', [353, 244, 394, 252], 1),
      label('(b) Delay', [464, 244, 504, 252], 2)
    ]
  }
}

it('completes only the native raster pair under its own sublabels and shared caption', () => {
  const { page, figure, captions, tokens } = localPair()
  expect(completeCaptionLocalRasterPair(page, figure, captions, [], tokens, () => false)).toEqual([
    318, 151, 539, 254
  ])
})

it.each(['missing sublabel', 'detached sublabel', 'foreign text', 'foreign figure'])(
  'leaves the crop alone with %s',
  (variant) => {
    const { page, figure, captions, tokens } = localPair()
    if (variant === 'missing sublabel') tokens.pop()
    if (variant === 'detached sublabel') tokens[1].rect = [445, 260, 485, 268]
    if (variant === 'foreign text')
      tokens.push({ text: 'Separate note', rect: [470, 233, 520, 241] })
    expect(
      completeCaptionLocalRasterPair(
        page,
        figure,
        captions,
        [],
        tokens,
        () => variant === 'foreign figure'
      )
    ).toBeUndefined()
  }
)
