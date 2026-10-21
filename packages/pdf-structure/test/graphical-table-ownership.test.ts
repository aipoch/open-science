/* eslint-disable @typescript-eslint/explicit-function-return-type -- infer anonymous fixture shapes */
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { associateGraphicalTables, associateRasterTables } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const fixture = () => {
  const captions = [
    {
      page: 1,
      rect: [70, 225, 520, 237],
      lines: ['Table 1. Summary of independent measurements.']
    },
    { page: 1, rect: [70, 430, 520, 442], lines: ['Table 2. Results for the complete comparison.'] }
  ]
  const image = (rect: number[]) => ({
    kind: 'image',
    normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600)),
    paintedNormalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600)),
    imageHash: 'anonymous-image'
  })
  const previous = {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    renderRotation: 0,
    invalidGraphicsBounds: 0,
    lines: captions.map((c) => ({
      text: c.lines[0],
      x: c.rect[0],
      y: c.rect[1],
      width: c.rect[2] - c.rect[0],
      height: 12,
      fontSize: 12
    })),
    graphicsBounds: [image([70, 250, 400, 400])]
  }
  const page = {
    ...previous,
    pageNumber: 2,
    lines: [] as typeof previous.lines,
    graphicsBounds: [image([70, 70, 530, 190])]
  }
  const detections = [
    {
      readingRotation: 0,
      detection: { score: 0.999 },
      cropRect: [105, 105, 795, 285],
      structure: {
        objects: [
          { label: 'table', score: 0.999 },
          ...Array.from({ length: 2 }, () => ({ label: 'table row', score: 0.99 })),
          ...Array.from({ length: 2 }, () => ({ label: 'table column', score: 0.99 }))
        ]
      }
    }
  ]
  return { page, previous, captions, detections, pages: [previous, page] }
}
it('gives one graphical image its independently selected complete caption', () => {
  const f = fixture(),
    all = associateGraphicalTables(f.previous, f.captions)
  expect(all).toHaveLength(1)
  expect(all[0].caption).toEqual(f.captions[0])
  expect(associateGraphicalTables(f.previous, [f.captions[0]])).toEqual(all)
})
it('recovers only a sequential terminal caption on an otherwise empty raster page', () => {
  const f = fixture()
  expect(associateRasterTables(f.page, f.detections)).toEqual([])
  const result = associateRasterTables(f.page, f.detections, [], f)
  expect(result).toEqual([{ rect: [70, 70, 530, 190], graphicsCount: 1, caption: f.captions[1] }])
  expect(result[0].cells).toBeUndefined()
  expect(result[0].nativeBody).toBeUndefined()
})
it.each([
  'unowned-previous',
  'nonsequential',
  'incomplete',
  'unmatched-native',
  'following-text',
  'following-paint',
  'current-text',
  'extra-image',
  'scan',
  'low-image',
  'weak-model',
  'one-column',
  'one-row',
  'occupied'
])('does not transfer a caption with %s', (fault) => {
  const f = fixture()
  let occupied: number[][] = []
  if (fault === 'unowned-previous') f.previous.graphicsBounds = []
  if (fault === 'nonsequential') {
    f.captions[1].lines[0] = f.captions[1].lines[0].replace('2.', '4.')
    f.previous.lines[1].text = f.captions[1].lines[0]
  }
  if (fault === 'incomplete') {
    f.captions[1].lines[0] = f.captions[1].lines[0].slice(0, -1)
    f.previous.lines[1].text = f.captions[1].lines[0]
  }
  if (fault === 'unmatched-native') f.previous.lines[1].text += ' Omitted explanation.'
  if (fault === 'following-text')
    f.previous.lines.push({
      ...f.previous.lines[1],
      y: 480,
      text: 'Independent ordinary prose follows here.'
    })
  if (fault === 'following-paint')
    f.previous.graphicsBounds.push({
      ...f.previous.graphicsBounds[0],
      normalizedRect: [0.2, 0.7, 0.3, 0.8],
      paintedNormalizedRect: [0.2, 0.7, 0.3, 0.8]
    })
  if (fault === 'current-text')
    f.page.lines.push({
      ...f.previous.lines[1],
      y: 400,
      text: 'Independent text outside the image.'
    })
  if (fault === 'extra-image')
    f.page.graphicsBounds.push({
      ...f.page.graphicsBounds[0],
      normalizedRect: [0.2, 0.7, 0.3, 0.8]
    })
  if (fault === 'scan') f.page.graphicsBounds[0].normalizedRect = [0, 0, 1, 1]
  if (fault === 'low-image') {
    f.page.graphicsBounds[0].normalizedRect = [70 / 600, 0.4, 530 / 600, 0.55]
    f.detections[0].cropRect = [105, 480, 795, 660]
  }
  if (fault === 'weak-model') f.detections[0].detection.score = 0.98
  if (fault === 'one-column') f.detections[0].structure.objects.splice(-1, 1)
  if (fault === 'one-row') f.detections[0].structure.objects.splice(1, 1)
  if (fault === 'occupied') occupied = [[70, 70, 530, 190]]
  expect(associateRasterTables(f.page, f.detections, occupied, f)).toEqual([])
})

it('keeps one image without guessing between equally supported captions', () => {
  const f = fixture()
  f.captions[1].rect = [70, 413, 520, 425]
  f.previous.lines[1].y = 413
  const result = associateGraphicalTables(f.previous, f.captions)
  expect(result).toHaveLength(1)
  expect(result[0].caption).toBeUndefined()
  expect(result[0].rect).toEqual([70, 250, 400, 400])
})
