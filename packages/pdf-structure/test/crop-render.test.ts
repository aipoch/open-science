import { createRequire } from 'node:module'
import { randomFillSync } from 'node:crypto'
import type { SKRSContext2D } from '@napi-rs/canvas'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { expect, it } from 'vitest'

const {
  renderPdfCrop,
  getInitialPdfCropRaster,
  matchesInitialPdfCropPng,
  getPdfCropRasterProtectionFromPng,
  MAX_EDGE,
  MAX_BYTES,
  MAX_SCALE
} = await import(pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href)
const { getDocument } = await import(
  pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
)

const pngHeader = (width: number, height: number): Buffer => {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

it('bounds the actual ceil raster and antialias pixels across output scales', () => {
  const rect = [10, 20, 523.071, 412.283],
    bounds = { width: 600, height: 800 }
  for (const scale of [4, 3.2, 0.4294967296]) {
    const width = Math.ceil((rect[2] - rect[0]) * scale),
      height = Math.ceil((rect[3] - rect[1]) * scale),
      proof = getPdfCropRasterProtectionFromPng(pngHeader(width, height), rect, bounds)
    expect(proof).toBeDefined()
    expect(proof.scaleLower).toBeLessThan(scale)
    expect(proof.scaleUpper).toBeGreaterThanOrEqual(scale - 1e-12)
    expect(proof.protection[0]).toBeLessThanOrEqual(rect[0] - 1 / scale)
    expect(proof.protection[1]).toBeLessThanOrEqual(rect[1] - 1 / scale)
    expect(proof.protection[2]).toBeGreaterThanOrEqual(rect[0] + (width + 1) / scale)
    expect(proof.protection[3]).toBeGreaterThanOrEqual(rect[1] + (height + 1) / scale)
  }
})

it('refuses impossible, unbounded, oversized and malformed actual raster proofs', () => {
  const rect = [0, 0, 100, 100],
    bounds = { width: 800, height: 800 }
  for (const [width, height] of [
    [1, 1],
    [400, 800],
    [2000, 2000],
    [MAX_EDGE + 1, 100],
    [0, 100]
  ])
    expect(
      getPdfCropRasterProtectionFromPng(pngHeader(width, height), rect, bounds)
    ).toBeUndefined()
  const large = Buffer.alloc(MAX_BYTES + 1)
  pngHeader(400, 400).copy(large)
  expect(getPdfCropRasterProtectionFromPng(large, rect, bounds)).toBeUndefined()
  const header = pngHeader(400, 400)
  expect(getPdfCropRasterProtectionFromPng(header.subarray(0, 32), rect, bounds)).toBeUndefined()
  for (const offset of [0, 11, 12]) {
    const bad = Buffer.from(header)
    bad[offset] ^= 1
    expect(getPdfCropRasterProtectionFromPng(bad, rect, bounds)).toBeUndefined()
  }
  expect(getPdfCropRasterProtectionFromPng(header, [-1, 0, 99, 100], bounds)).toBeUndefined()
})

it('proves the exact initial ceil raster and one-pixel paint protection', () => {
  expect([MAX_EDGE, MAX_BYTES, MAX_SCALE]).toEqual([2400, 4 * 1024 ** 2, 4])
  expect(getInitialPdfCropRaster([10, 20, 111.13, 30.07], { width: 300, height: 100 })).toEqual({
    scale: 4,
    pixelWidth: 405,
    pixelHeight: 41,
    protection: [9.75, 19.75, 111.5, 30.5]
  })
  expect(getInitialPdfCropRaster([1, 1, 3001, 11], { width: 4000, height: 100 })).toEqual({
    scale: 0.8,
    pixelWidth: 2400,
    pixelHeight: 8,
    protection: [-0.25, -0.25, 3002.25, 12.25]
  })
})

it('declines invalid, outside-page and byte-retry-sized initial rasters', () => {
  for (const rect of [
    [0, 0, 800, 800],
    [-1, 10, 20, 20],
    [10, 10, 801, 20],
    [10, 10, 10, 20],
    [10, 20, 20, 10],
    [0, 0, Number.NaN, 20],
    [0, 0, 20]
  ])
    expect(getInitialPdfCropRaster(rect, { width: 800, height: 800 })).toBeUndefined()
  for (const bounds of [
    { width: 0, height: 100 },
    { width: Infinity, height: 100 }
  ])
    expect(getInitialPdfCropRaster([1, 1, 2, 2], bounds)).toBeUndefined()
})

it('keeps an admitted noisy raster at its proven initial scale and PNG budget', async () => {
  const rect = [10, 20, 400.13, 74.85]
  const bounds = { width: 600, height: 800 }
  const geometry = getInitialPdfCropRaster(rect, bounds)
  expect(geometry).toBeDefined()
  let renders = 0
  const page = {
    getViewport: () => bounds,
    render: ({ canvasContext }: { canvasContext: SKRSContext2D }) => {
      renders++
      const pixels = canvasContext.createImageData(
        canvasContext.canvas.width,
        canvasContext.canvas.height
      )
      randomFillSync(pixels.data)
      canvasContext.putImageData(pixels, 0, 0)
      return { promise: Promise.resolve() }
    }
  }
  const png = await renderPdfCrop(page, rect)
  const metadata = await sharp(png).metadata()
  expect(renders).toBe(1)
  expect([metadata.width, metadata.height]).toEqual([geometry.pixelWidth, geometry.pixelHeight])
  expect(png.length).toBeLessThanOrEqual(MAX_BYTES)
  expect(matchesInitialPdfCropPng(png, geometry)).toBe(true)
  expect(matchesInitialPdfCropPng(png, { ...geometry, pixelWidth: geometry.pixelWidth - 1 })).toBe(
    false
  )
  expect(matchesInitialPdfCropPng(png.subarray(0, 32), geometry)).toBe(false)
  for (const offset of [0, 11, 12]) {
    const invalid = Buffer.from(png)
    invalid[offset] ^= 1
    expect(matchesInitialPdfCropPng(invalid, geometry)).toBe(false)
  }
})

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
  const proof = getPdfCropRasterProtectionFromPng(png, [0, 0, 800, 800], {
    width: 800,
    height: 800
  })
  expect(proof).toBeDefined()
  expect(proof.scaleUpper).toBeLessThan(MAX_SCALE)
  expect([proof.pixelWidth, proof.pixelHeight]).toEqual([metadata.width, metadata.height])
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
    pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
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
it('keeps only disjoint source regions without moving their coordinates', async () => {
  const task = getDocument({ data: vectorPdf(), isEvalSupported: false, verbosity: 0 })
  try {
    const page = await (await task.promise).getPage(1)
    const png = await renderPdfCrop(page, [100, 500, 120, 550], 0, [
      [100, 500, 105, 550],
      [115, 500, 120, 520]
    ])
    const { data, info } = await sharp(png)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const pixel = (x: number, y: number): number => data[(y * info.width + x) * 3]
    expect(pixel(0, 100)).toBeLessThan(30)
    expect(pixel(60, 40)).toBeLessThan(30)
    expect(pixel(40, 40)).toBe(255)
    expect(pixel(60, 100)).toBe(255)
    await expect(
      renderPdfCrop(page, [100, 500, 120, 550], 0, [[99, 500, 105, 550]])
    ).rejects.toThrow('Invalid PDF crop parts')
  } finally {
    await task.destroy()
  }
})
