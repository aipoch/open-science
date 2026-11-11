import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { createCanvas, loadImage } from '@napi-rs/canvas'

const { anonymousBoundedPixelProgram } = await import(
  pathToFileURL(resolve('test/fixtures/native-bounded-pixel-program.mjs')).href
)
const { nativeBoundedProgramPixelCrop: crop, nativeBoundedProgramPixelPngSafe: safe } =
  await import(
    pathToFileURL(resolve('resources/literature-pdf-figure-native-bounded-scope.mjs')).href
  )
const { renderPdfCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
)
const labels = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const whole = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)

function inputs(f: {
  page: unknown
  captions: { rect: number[] }[]
  tokens: unknown
  context: unknown
}): unknown[] {
  const figure = { caption: f.captions[0], rect: [55, 170, 145, 195] },
    peers = [figure]
  return [f.page, figure, f.captions, [], f.tokens, f.context, peers, figure.rect]
}

it.each([1, 2])(
  'recovers a complete real %i-level bounded figure without Source or exact-clip authority',
  async (depth) => {
    const f = await anonymousBoundedPixelProgram({ depth, mode: 'figure' })
    try {
      const a = inputs(f),
        plan = crop(...a)
      expect(plan).toBeDefined()
      expect(plan.rect[1]).toBeLessThan(100)
      expect(plan.rect[3]).toBeGreaterThan(200)
      expect(plan.sourceItems).toBeUndefined()
      expect(labels.createNativeFigurePaintCertificate(f.page, f.tokens, f.context)).toBeUndefined()
      const png = await renderPdfCrop(f.nativePage, plan.rect)
      expect(safe(plan, png, plan.rect, f.page)).toBe(true)
      const integrated = whole.nativeCertifiedFigurePixelCrop(...a)
      expect(integrated?.rect).toEqual(plan.rect)
      expect(
        whole.nativeCertifiedFigurePixelPngSafe(integrated, png, integrated.rect, f.page)
      ).toBe(true)
      const image = await loadImage(png),
        canvas = createCanvas(image.width, image.height),
        ctx = canvas.getContext('2d'),
        scale = Math.min(
          4,
          2400 / Math.max(plan.rect[2] - plan.rect[0], plan.rect[3] - plan.rect[1])
        ),
        pixel = (x: number, y: number): number[] => [
          ...ctx.getImageData(
            Math.floor((x - plan.rect[0]) * scale),
            Math.floor((y - plan.rect[1]) * scale),
            1,
            1
          ).data
        ]
      ctx.drawImage(image, 0, 0)
      expect(pixel(50.7, 100.7)).toEqual([255, 255, 255, 255])
      expect(pixel(100, 170)).toEqual([0, 0, 255, 255])
      canvas.width = canvas.height = 1
      expect(safe({ ...plan }, png, plan.rect, f.page)).toBeUndefined()
      expect(safe(plan, png, [...plan.rect], f.page)).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
)

it.each(['caption-copy', 'caption-text', 'foreign-peer', 'table', 'complete-old-crop'])(
  'declines an ambiguous or non-recovery figure: %s',
  async (mode) => {
    const f = await anonymousBoundedPixelProgram({ mode: 'figure' })
    try {
      const a = inputs(f),
        figure = a[1] as { caption: { lines: string[] }; rect: number[] }
      if (mode === 'caption-copy') figure.caption = { ...figure.caption }
      if (mode === 'caption-text')
        figure.caption.lines[0] = 'Figure 1: A different anonymous panel.'
      if (mode === 'foreign-peer')
        (a[6] as { rect: number[] }[]).push({ rect: [70, 110, 100, 130] })
      if (mode === 'table') (a[3] as number[][]).push([70, 110, 100, 130])
      if (mode === 'complete-old-crop') a[7] = [45, 95, 155, 205]
      expect(crop(...a)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it('declines an original foreign glyph inside the complete owner envelope', async () => {
  const f = await anonymousBoundedPixelProgram({ mode: 'foreign' })
  try {
    expect(crop(...inputs(f))).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it('declines an original foreign path inside the complete owner envelope', async () => {
  const f = await anonymousBoundedPixelProgram({ mode: 'foreign-path' })
  try {
    expect(f.captions[0].lines[0]).toMatch(/^Figure 1:/u)
    expect(crop(...inputs(f))).toBeUndefined()
    expect(whole.nativeCertifiedFigurePixelCrop(...inputs(f))).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it.each(['touching-clip', 'tiny-gap-clip', 'far-disjoint-clip'])(
  'refuses a mathematical empty clip without assuming native raster emptiness: %s',
  async (mode) => {
    const f = await anonymousBoundedPixelProgram({ mode })
    try {
      expect(f.captions[0].lines[0]).toMatch(/^Figure 1:/u)
      expect(
        labels.createNativeBoundedFigurePixelCertificate(f.page, f.tokens, f.context)
      ).toBeUndefined()
      expect(crop(...inputs(f))).toBeUndefined()
      expect(whole.nativeCertifiedFigurePixelCrop(...inputs(f))).toBeUndefined()
      if (mode === 'touching-clip') {
        const data = f.canvas.getContext('2d').getImageData(220, 190, 12, 70).data
        let blue = 0
        for (let i = 0; i < data.length; i += 4) if (data[i + 2] > data[i]) blue++
        expect(blue).toBeGreaterThan(0)
      }
    } finally {
      await f.cleanup()
    }
  }
)

it.each(['caption', 'old-crop', 'raw-path', 'token', 'output-rect'])(
  'withdraws a bound crop after %s mutation',
  async (mode) => {
    const f = await anonymousBoundedPixelProgram({ mode: 'figure' })
    try {
      const a = inputs(f),
        plan = crop(...a)
      expect(plan).toBeDefined()
      const png = await renderPdfCrop(f.nativePage, plan.rect)
      if (mode === 'caption') f.captions[0].lines[0] += ' altered'
      if (mode === 'old-crop') (a[7] as number[])[0] += 1
      if (mode === 'raw-path') {
        const i = f.context.operators.fnArray.findIndex((op: number) => op === OPS.constructPath)
        // Locate the original path by its actual typed-view shape, not an id.
        const args = i < 0 ? undefined : f.context.operators.argsArray[i]
        if (args?.[1]?.[0]) args[1][0][1] += 1
        else f.context.operators.argsArray = [...f.context.operators.argsArray]
      }
      if (mode === 'token') f.tokens[0].text += ' altered'
      if (mode === 'output-rect') plan.rect[0] -= 1
      expect(safe(plan, png, plan.rect, f.page)).toBe(false)
    } finally {
      await f.cleanup()
    }
  }
)

it('does not turn a bounded-only envelope into a missing-content visibility witness', async () => {
  const f = await anonymousBoundedPixelProgram({ mode: 'figure' })
  try {
    const a = inputs(f)
    // The exact original label is already contained. Only the blue shape lies
    // outside, and its rounded clip provides no positive visible-point proof.
    a[7] = [60, 125, 100, 150]
    expect(crop(...a)).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})
