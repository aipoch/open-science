import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { nativeRasterQuadBesideCaptionedFigure } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
it.each(['separate', 'shared-caption', 'paint-connector'])(
  'keeps a proven raster quad separate from its independently captioned neighbor (%s)',
  (variant) => {
    const width = 600,
      height = 800
    const normal = (rect: number[]): number[] => rect.map((v, i) => v / (i % 2 ? height : width))
    const graphicsBounds = [
      [43, 50, 160, 120],
      [167, 50, 285, 120],
      [43, 123, 160, 193],
      [167, 123, 285, 193]
    ].map((rect) => ({ kind: 'image', normalizedRect: normal(rect) }))
    if (variant === 'paint-connector')
      graphicsBounds.push({ kind: 'path', normalizedRect: normal([267, 108, 337, 108]) })
    const caption = {
      page: 1,
      rect: [42, 199, 285, 238],
      lines: ['Figure 1. Four sampled exposures.']
    }
    const peerCaption = {
      page: 1,
      rect: [314, 365, 556, 430],
      lines: [
        variant === 'shared-caption'
          ? 'Figure 1. Continued.'
          : 'Figure 2. An independent response plot.'
      ]
    }
    const lines = [caption, peerCaption].map((c) => ({
      text: c.lines[0],
      x: c.rect[0],
      y: c.rect[1],
      width: c.rect[2] - c.rect[0],
      height: 10,
      fontSize: 9
    }))
    const page = { width, height, lines, graphicsBounds }
    const figure = {
      rect: [42, 47, 558, 197],
      caption,
      reason: 'native-raster-vector-strip',
      graphicsCount: 110
    }
    const peer = { rect: [315, 48, 557, 362], caption: peerCaption, graphicsCount: 40 }
    const result = nativeRasterQuadBesideCaptionedFigure(
      page,
      figure,
      [figure, peer],
      [caption, peerCaption],
      []
    )
    if (variant === 'separate') {
      expect(result?.reason).toBe('native-raster-quad')
      expect(result.rect).toEqual([43, 50, 285, 193])
      expect(result.caption).toBe(caption)
    } else expect(result).toBeUndefined()
  }
)
