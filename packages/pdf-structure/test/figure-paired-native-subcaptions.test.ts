import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { resolve } from './paths'
const { anonymousPairedNativeSubcaptions } = await import(
  pathToFileURL(resolve('test/fixtures/paired-native-subcaptions.mjs')).href
)
const { nativeCompleteFormCrop, nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)
const prove = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> => {
  const a = f.args
  return nativeCompleteFormCrop(a[0], f.figure, a[1], a[2], a[5], a[6])
}
it('completes two native subcaption rows independently of translation ownership', () => {
  for (const options of [{}, { scale: 1.5, dx: 10, labels: ['East', 'West'] }]) {
    const f = anonymousPairedNativeSubcaptions(options),
      before = JSON.stringify(f)
    const result = prove(f),
      scale = options.scale ?? 1
    expect(result?.rect.slice(0, 3)).toEqual(f.figure.rect.slice(0, 3))
    expect(result.rect[3]).toBeCloseTo(190.8 * scale, 10)
    expect(result.sourceItems).toBeUndefined()
    expect(result.formCropRaster.nativeTail.frames).toHaveLength(2)
    expect(JSON.stringify(f)).toBe(before)
  }
})
it.each(['white frame', 'transparent frame', 'open frame', 'nonidentity viewport'])(
  'requires complete visible frame evidence: %s',
  (mode) => {
    const f = anonymousPairedNativeSubcaptions(),
      o = f.args[6].operators
    if (mode === 'white frame') o.argsArray[o.fnArray.indexOf(OPS.setStrokeRGBColor)] = ['#ffffff']
    if (mode === 'transparent frame') {
      const index = o.fnArray.indexOf(OPS.setStrokeRGBColor)
      o.fnArray[index] = OPS.setGState
      o.argsArray[index] = [[['CA', 0]]]
    }
    if (mode === 'open frame') {
      const path = o.argsArray[o.fnArray.indexOf(OPS.constructPath)][1][0]
      path.pop()
    }
    if (mode === 'nonidentity viewport') f.args[6].viewport.scale = 2
    expect(prove(f)).toBeUndefined()
  }
)
it.each(['table', 'caption', 'paint'])(
  'keeps independent %s out of the added label strip',
  (mode) => {
    const f = anonymousPairedNativeSubcaptions(),
      a = f.args
    if (mode === 'table') a[2].push([70, 182, 150, 194])
    if (mode === 'caption')
      a[1].push({ page: 1, lines: ['Figure 2. Other.'], rect: [70, 182, 150, 194] })
    if (mode === 'paint') {
      a[6].operators.fnArray.push(OPS.constructPath)
      a[6].operators.argsArray.push([
        OPS.fill,
        [[0, 75, 107, 1, 80, 107, 1, 80, 113, 1, 75, 113, 4]],
        [75, 107, 80, 113]
      ])
    }
    expect(prove(f)).toBeUndefined()
  }
)
it('requires the complete original native source carrier', () => {
  const f = anonymousPairedNativeSubcaptions()
  delete f.args[6].content.items[1].sourceItem
  expect(prove(f)).toBeUndefined()
})
it('checks actual PNG minimum stroke widths against frame clips and added labels', () => {
  const f = anonymousPairedNativeSubcaptions(),
    candidate = prove(f)
  expect(candidate).toBeDefined()
  const page = f.args[0],
    rect = candidate.rect.map((v: number, i: number) => v + (i < 2 ? -2 : 2))
  const png = createCanvas(
    Math.ceil((rect[2] - rect[0]) * 2),
    Math.ceil((rect[3] - rect[1]) * 2)
  ).toBuffer('image/png')
  expect(nativeCompleteFormCropPngSafe(png, rect, page, candidate)).toBe(true)
  const clipped = structuredClone(candidate),
    frame = clipped.formCropRaster.nativeTail.frames[0]
  frame.strokeWidth = 0.001
  frame.clip = frame.rect.map((v: number, i: number) => v + (i < 2 ? -0.01 : 0.01))
  expect(nativeCompleteFormCropPngSafe(png, rect, page, clipped)).toBe(false)
  const overlap = structuredClone(candidate)
  overlap.formCropRaster.nativeTail.paints.push({ rect: [100, 180, 101, 181], floor: 100 })
  expect(nativeCompleteFormCropPngSafe(png, rect, page, overlap)).toBe(false)
})
