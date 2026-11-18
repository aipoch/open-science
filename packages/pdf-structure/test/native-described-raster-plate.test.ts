import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { nativeCaptionedRaster, nativeCaptionedRasterFullWidth } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- synthetic geometry
function fixture() {
  const line = (text: string, rect: number[]): Record<string, unknown> => ({
    text,
    x: rect[0],
    y: rect[1],
    width: rect[2] - rect[0],
    height: rect[3] - rect[1],
    fontSize: 10
  })
  const caption = {
    page: 1,
    rect: [80, 325, 420, 355],
    lines: [
      'Figure 1: Top left: Input. Top right: Output.',
      'Bottom: Combined measurement.',
      'The complete caption remains available.'
    ]
  }
  const image = (rect: number[], operationIndex: number): Record<string, unknown> => ({
    kind: 'image',
    operationIndex,
    normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600)),
    paintedNormalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: caption.lines.map((s, i) => line(s, [80, 325 + i * 10, 420, 335 + i * 10])),
    graphicsBounds: [
      image([100, 100, 240, 200], 1),
      image([260, 100, 400, 200], 2),
      image([180, 210, 320, 310], 3)
    ]
  }
  const captions = [caption],
    tables: number[][] = []
  const run = (): { rect: number[]; caption: typeof caption } | undefined =>
    nativeCaptionedRaster(page, caption, captions, tables)
  return { page, caption, captions, tables, run, line, image }
}

it('keeps all explicitly described raster positions and the complete caption', () => {
  const f = fixture(),
    result = f.run()
  expect(result?.rect).toEqual([100, 100, 400, 310])
  expect(result?.caption).toBe(f.caption)
  expect(result?.caption.lines).toHaveLength(3)
})

it.each([
  'independent caption',
  'table',
  'body text',
  'foreign paint',
  'missing position',
  'duplicate position',
  'extra image',
  'misaligned upper row',
  'off-center lower row',
  'large gap',
  'missing native description',
  'unreliable geometry',
  'duplicate operation',
  'missing paint bounds',
  'paint outside source'
])('does not complete the plate with %s', (condition) => {
  const f = fixture()
  if (condition === 'independent caption')
    f.captions.push({
      page: 1,
      rect: [100, 201, 240, 209],
      lines: ['Figure 2: Independent image.']
    })
  if (condition === 'table') f.tables.push([100, 100, 240, 200])
  if (condition === 'body text')
    f.page.lines.push(f.line('Independent body text.', [100, 201, 400, 209]))
  if (condition === 'foreign paint')
    f.page.graphicsBounds.push({ ...f.image([245, 130, 255, 170], 4), kind: 'path' })
  if (condition === 'missing position') f.caption.lines[0] = 'Figure 1: Top left: Input.'
  if (condition === 'duplicate position') f.caption.lines[1] += ' Top left: Another image.'
  if (condition === 'extra image') f.page.graphicsBounds.push(f.image([450, 120, 550, 220], 4))
  if (condition === 'misaligned upper row')
    f.page.graphicsBounds[1] = f.image([260, 120, 400, 220], 2)
  if (condition === 'off-center lower row')
    f.page.graphicsBounds[2] = f.image([200, 210, 340, 310], 3)
  if (condition === 'large gap') f.page.graphicsBounds[0] = f.image([100, 60, 240, 160], 1)
  if (condition === 'missing native description') f.page.lines.splice(0, 1)
  if (condition === 'unreliable geometry') f.page.invalidGraphicsBounds = 1
  if (condition === 'duplicate operation') f.page.graphicsBounds[0].operationIndex = 2
  if (condition === 'missing paint bounds') delete f.page.graphicsBounds[0].paintedNormalizedRect
  if (condition === 'paint outside source')
    f.page.graphicsBounds[0].paintedNormalizedRect = [0, 0, 1, 1]
  expect(f.run()?.rect[1] ?? Infinity).toBeGreaterThan(200)
})

it.each(['complete', 'missing label', 'body text', 'foreign paint', 'same operation', 'table'])(
  'joins two independently painted wide rows only with native caption evidence: %s',
  (mode) => {
    const f = fixture()
    const origin = [50, 289, 550, 309]
    const caption = {
      page: 1,
      rect: origin,
      lines: ['Figure 1: (a,e) Initial; (b,f) Middle; (c,g) Final; (d) Left; (h) Right.']
    }
    const lower = [50, 180, 550, 280]
    const upper = [50, 75, 550, 175]
    const p = {
      ...f.page,
      rotation: 0,
      renderRotation: 0,
      lines: [f.line(caption.lines[0], origin)],
      graphicsBounds: [f.image(upper, 1), f.image(lower, 2)]
    }
    const tables: number[][] = []
    if (mode === 'missing label') caption.lines[0] = caption.lines[0].replace('(c,g)', '(c)')
    if (mode === 'body text') p.lines.push(f.line('Separate body row', [52, 175, 400, 179]))
    if (mode === 'foreign paint')
      p.graphicsBounds.push({ ...f.image([52, 175, 400, 179], 3), kind: 'path' })
    if (mode === 'same operation') p.graphicsBounds[0].operationIndex = 2
    if (mode === 'table') tables.push([80, 100, 200, 130])
    const result = nativeCaptionedRasterFullWidth(p, caption, [caption], tables)
    expect(result?.caption).toBe(caption)
    expect(result?.rect).toEqual(mode === 'complete' ? [50, 75, 550, 280] : lower)
    expect(result?.graphicsCount).toBe(mode === 'complete' ? 2 : 1)
  }
)
