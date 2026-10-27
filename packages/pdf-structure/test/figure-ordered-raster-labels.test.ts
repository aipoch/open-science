import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas } from '@napi-rs/canvas'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousOrderedRasterLabels } = await import(
  pathToFileURL(resolve('test/fixtures/ordered-raster-labels.mjs')).href
)
const { nativeCompleteFormCrop, nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
it('keeps every ordered native label record below each raster panel in the complete crop', () => {
  const f = anonymousOrderedRasterLabels(),
    a = f.args,
    before = JSON.stringify(f),
    complete = nativeCompleteFormCrop(a[0], f.figure, a[1], a[2], a[5], a[6])
  // The last baseline is 173; the existing full 8-unit font domain reserves 2.4 below it.
  expect(complete?.rect).toEqual([50, 50, 350, 175.4])
  expect(complete.sourceItems).toEqual([
    { pageNumber: 1, index: 0, text: '(a)' },
    { pageNumber: 1, index: 1, text: 'Near' },
    { pageNumber: 1, index: 2, text: 'View' },
    { pageNumber: 1, index: 3, text: '(b)' },
    { pageNumber: 1, index: 4, text: 'Far' },
    { pageNumber: 1, index: 5, text: 'View' }
  ])
  expect(JSON.stringify(f)).toBe(before)
})
it('preserves association identity and fallback while carrying every complete panel label', () => {
  const f = anonymousOrderedRasterLabels(),
    before = JSON.stringify(f.args),
    figures = associateFigures(...f.args)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect).toEqual([50, 50, 350, 175.4])
  expect(figures[0].reason).toBe('native-raster-side-by-side')
  expect(figures[0].graphicsCount).toBe(2)
  expect(figures[0].caption).toEqual(f.figure.caption)
  expect(figures[0].sourceItems).toEqual(
    f.args[6].content.items.slice(0, 6).map((r: { sourceItem: unknown }) => r.sourceItem)
  )
  expect(figures[0].fallbackFigure.rect).toEqual([50, 50, 350, 150])
  expect(figures[0].fallbackFigure.reason).toBe('native-raster-side-by-side')
  expect(JSON.stringify(f.args)).toBe(before)
})
const prove = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> => {
  const a = f.args
  return nativeCompleteFormCrop(a[0], f.figure, a[1], a[2], a[5], a[6])
}
it('retains the same native ownership under a translated and enlarged source page', () => {
  const f = anonymousOrderedRasterLabels({ scale: 1.5, dx: 20 }),
    result = prove(f)
  expect(result?.rect.slice(0, 3)).toEqual([95, 75, 545])
  expect(result.rect[3]).toBeCloseTo(263.1, 10)
  expect(result.sourceItems.map((s: { index: number }) => s.index)).toEqual([0, 1, 2, 3, 4, 5])
})
it.each([
  'source literal',
  'source advance',
  'source origin',
  'missing source',
  'missing token',
  'font metrics',
  'font domain',
  'caption literal',
  'duplicate caption',
  'existing ownership',
  'composite',
  'white paint',
  'transparent paint',
  'clip',
  'foreign table',
  'caption crossing'
])('refuses incomplete native raster-label evidence: %s', (kind) => {
  const f = anonymousOrderedRasterLabels(),
    a = f.args,
    c = a[6]
  if (kind === 'source literal') c.content.items[0].str = '(z)'
  if (kind === 'source advance') c.content.items[0].width += 1
  if (kind === 'source origin') c.content.items[0].sourceItem.index = 999
  if (kind === 'missing source') c.content.items.splice(0, 1)
  if (kind === 'missing token') a[5].splice(0, 1)
  if (kind === 'font metrics') delete c.content.styles.F.ascent
  if (kind === 'font domain') delete a[5][0].nativeLabelRect
  if (kind === 'caption literal') f.figure.caption.lines[0] += ' altered'
  if (kind === 'duplicate caption') a[1].push({ ...f.figure.caption })
  if (kind === 'existing ownership')
    f.figure.sourceItems = [{ pageNumber: 1, index: 0, text: '(a)' }]
  if (kind === 'composite') f.figure.parts = [{}]
  if (kind === 'white paint') {
    c.operators.fnArray.unshift(OPS.setFillRGBColor)
    c.operators.argsArray.unshift(['#ffffff'])
  }
  if (kind === 'transparent paint') {
    c.operators.fnArray.unshift(OPS.setGState)
    c.operators.argsArray.unshift([[['ca', 0.5]]])
  }
  if (kind === 'clip') {
    c.operators.fnArray.unshift(OPS.clip)
    c.operators.argsArray.unshift([])
  }
  if (kind === 'foreign table') a[2].push([60, 165, 100, 175])
  if (kind === 'caption crossing') f.figure.caption.rect = [40, 170, 300, 190]
  expect(prove(f)).toBeUndefined()
})
it('requires the actual PNG to protect complete label fonts and later image paint', () => {
  const f = anonymousOrderedRasterLabels(),
    candidate = prove(f),
    page = f.args[0],
    rect = [48, 48, 352, 177.4],
    png = (scale: number): Buffer =>
      createCanvas(Math.ceil(304 * scale), Math.ceil(129.4 * scale)).toBuffer('image/png')
  expect(nativeCompleteFormCropPngSafe(png(4), rect, page, candidate)).toBe(true)
  expect(nativeCompleteFormCropPngSafe(png(0.5), rect, page, candidate)).toBe(false)
  expect(nativeCompleteFormCropPngSafe(Buffer.from('invalid'), rect, page, candidate)).toBe(false)
  const overlap = structuredClone(candidate)
  overlap.formCropRaster.paintSeparations[0].laterPaintRect = [50, 155, 70, 165]
  expect(nativeCompleteFormCropPngSafe(png(4), rect, page, overlap)).toBe(false)
})
