import { createRequire } from 'node:module'
import { randomFillSync } from 'node:crypto'
import type { SKRSContext2D } from '@napi-rs/canvas'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { expect, it } from 'vitest'

const { renderPdfCrop } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-crop.mjs')).href
)
const { getDocument } = await import(
  pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
)

// Quarter-point vector bars distinguish source rendering from an enlarged page bitmap.
const vectorPdf = (): Uint8Array => {
  const content = Array.from({ length: 40 }, (_, i) => `${100 + i / 2} 250 0.25 50 re f`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 800] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(pdf)
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf))
}

it('renders fine vector detail at native crop resolution with correct page offsets', async () => {
  const task = getDocument({ data: vectorPdf(), isEvalSupported: false, verbosity: 0 })
  try {
    const page = await (await task.promise).getPage(1)
    const png = await renderPdfCrop(page, [100, 500, 200, 550])
    const { data, info } = await sharp(png)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([info.width, info.height]).toEqual([400, 200])
    const row = Array.from({ length: 80 }, (_, x) => data[(100 * info.width + x) * 3])
    expect(row.filter((value, x) => x % 2 === 0 && value < 30)).toHaveLength(40)
    expect(row.filter((value, x) => x % 2 === 1 && value > 225)).toHaveLength(40)
    expect(data[(100 * info.width + 200) * 3]).toBe(255)
  } finally {
    await task.destroy()
  }
})

it('bounds large crops, clips at page edges and rejects empty regions', async () => {
  const task = getDocument({ data: vectorPdf(), isEvalSupported: false, verbosity: 0 })
  try {
    const page = await (await task.promise).getPage(1)
    const png = await renderPdfCrop(page, [-10, -10, 900, 900])
    const metadata = await sharp(png).metadata()
    expect([metadata.width, metadata.height]).toEqual([2400, 2400])
    expect(png.length).toBeLessThanOrEqual(4 * 1024 ** 2)
    await expect(renderPdfCrop(page, [900, 900, 1000, 1000])).rejects.toThrow()
  } finally {
    await task.destroy()
  }
})

it('keeps noisy photographic crops within the PNG budget by reducing resolution', async () => {
  let renders = 0
  const page = {
    getViewport: () => ({ width: 800, height: 800 }),
    render: ({ canvasContext }: { canvasContext: SKRSContext2D }) => {
      renders++
      const pixels = canvasContext.createImageData(
        canvasContext.canvas.width,
        canvasContext.canvas.height
      )
      randomFillSync(pixels.data)
      for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255
      canvasContext.putImageData(pixels, 0, 0)
      return { promise: Promise.resolve() }
    }
  }
  const png = await renderPdfCrop(page, [0, 0, 800, 800])
  expect(renders).toBeGreaterThan(1)
  expect(png.length).toBeLessThanOrEqual(4 * 1024 ** 2)
  const metadata = await sharp(png).metadata()
  expect(metadata.width).toBeGreaterThan(800)
  expect(metadata.width).toBeLessThan(2400)
}, 10000)

it('renders an upright crop from sideways PDF content', async () => {
  const task = getDocument({ data: vectorPdf(), isEvalSupported: false, verbosity: 0 })
  try {
    const page = await (await task.promise).getPage(1)
    // The vector bars at original viewport x=100..120,y=500..550 move
    // to x=250..300,y=100..120 after rotating the page 90 degrees.
    const png = await renderPdfCrop(page, [250, 100, 300, 200], 90)
    const { data, info } = await sharp(png)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([info.width, info.height]).toEqual([200, 400])
    const column = Array.from({ length: 80 }, (_, y) => data[(y * info.width + 100) * 3])
    expect(column.filter((v, y) => y % 2 === 0 && v < 30)).toHaveLength(40)
    expect(column.filter((v, y) => y % 2 === 1 && v > 225)).toHaveLength(40)
    expect(data[(200 * info.width + 100) * 3]).toBe(255)
  } finally {
    await task.destroy()
  }
})

it('recovers two scanned plot frames with a split OCR caption and rejects prose-only pages', async () => {
  const { recoverScannedFigures } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-crop.mjs')).href
  )
  let drawFrames = true
  const page = {
    rotate: 0,
    getViewport: ({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
      scale
    }),
    render: ({
      canvasContext: ctx,
      viewport
    }: {
      canvasContext: SKRSContext2D
      viewport: { scale: number }
    }) => {
      ctx.fillStyle = 'white'
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
      ctx.scale(viewport.scale, viewport.scale)
      ctx.strokeStyle = 'black'
      ctx.lineWidth = 1
      if (drawFrames) {
        ctx.strokeRect(340, 350, 190, 140)
        ctx.strokeRect(340, 520, 190, 140)
      }
      return { promise: Promise.resolve() }
    }
  }
  const geometry = {
    width: 600,
    height: 800,
    pageNumber: 1,
    graphicsBounds: [{ kind: 'image', normalizedRect: [0, 0, 1, 1] }],
    lines: [
      { text: 'Figure', x: 320, y: 680, width: 25, height: 10, fontSize: 10 },
      { text: '1', x: 348, y: 677, width: 3, height: 10, fontSize: 10 },
      {
        text: 'The continuous line represents survival.',
        x: 357,
        y: 675,
        width: 190,
        height: 13,
        fontSize: 13
      },
      {
        text: 'A second line describes both panels in this figure.',
        x: 320,
        y: 686,
        width: 230,
        height: 13,
        fontSize: 13
      }
    ]
  }
  const figures = await recoverScannedFigures(page, geometry)
  expect(figures).toHaveLength(1)
  expect(figures[0].graphicsCount).toBe(2)
  expect(figures[0].rect[1]).toBeLessThan(351)
  expect(figures[0].rect[3]).toBeLessThan(675)
  expect(figures[0].caption.lines[0]).toMatch(/^Figure 1 The continuous/)
  drawFrames = false
  expect(await recoverScannedFigures(page, geometry)).toEqual([])
  expect(await recoverScannedFigures(page, { ...geometry, graphicsBounds: [] })).toEqual([])
})
