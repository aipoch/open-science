import { expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { installPdfCanvasReset } = await import(
  pathToFileURL(resolve('resources/literature-pdf-canvas-reset.mjs')).href
)
const pixels = (c: ReturnType<typeof createCanvas>): number[] => [
  ...c.getContext('2d').getImageData(0, 0, c.width, c.height).data
]

it('clears pixels, clipping, transforms, saved states, paths and styles like a size reset', () => {
  const a = createCanvas(40, 30),
    b = createCanvas(40, 30)
  const targets = [a, b].map((canvas) => ({ canvas, context: canvas.getContext('2d') }))
  const original = vi.fn((t, w, h) => {
    t.canvas.width = w
    t.canvas.height = h
  })
  const factory = { reset: original }
  installPdfCanvasReset(factory)
  for (const { context: c } of targets) {
    c.fillStyle = 'red'
    c.fillRect(0, 0, 40, 30)
    c.save()
    c.translate(12, 10)
    c.beginPath()
    c.rect(1, 1, 2, 2)
    c.clip()
    c.globalAlpha = 0.3
    c.globalCompositeOperation = 'xor'
    c.setLineDash([2, 3])
    c.lineDashOffset = 3
    c.lineWidth = 8
    c.shadowBlur = 4
    c.shadowColor = 'red'
    c.filter = 'blur(2px)'
    c.font = 'bold 20px serif'
    c.textAlign = 'right'
    c.textBaseline = 'top'
    c.imageSmoothingEnabled = false
    c.imageSmoothingQuality = 'high'
  }
  factory.reset(targets[0], 40, 30)
  b.width = 40
  b.height = 30
  expect(original).toHaveBeenCalledTimes(1)
  expect(pixels(a)).toEqual(pixels(b))
  for (const { context: c } of targets) {
    // Restore must not resurrect the previous clip or transform.
    c.restore()
    c.stroke()
    c.fillStyle = 'blue'
    c.fillRect(0, 0, 30, 20)
  }
  expect(pixels(a)).toEqual(pixels(b))
  const props = [
    'fillStyle',
    'strokeStyle',
    'globalAlpha',
    'globalCompositeOperation',
    'lineWidth',
    'lineDashOffset',
    'shadowBlur',
    'shadowColor',
    'filter',
    'font',
    'textAlign',
    'textBaseline',
    'imageSmoothingEnabled',
    'imageSmoothingQuality'
  ] as const
  for (const prop of props) expect(targets[0].context[prop]).toEqual(targets[1].context[prop])
  expect(targets[0].context.getLineDash()).toEqual([])
  expect(targets[0].context.getTransform()).toEqual(targets[1].context.getTransform())
})

it('delegates changed dimensions, invalid sizes, missing canvases and older contexts', () => {
  const reset = vi.fn(),
    factory = { reset },
    canvas = createCanvas(20, 10)
  installPdfCanvasReset(factory)
  for (const [target, width, height] of [
    [{ canvas, context: canvas.getContext('2d') }, 21, 10],
    [{ canvas, context: canvas.getContext('2d') }, 0, 10],
    [{ canvas, context: {} }, 20, 10],
    [{ canvas: null, context: {} }, 20, 10]
  ] as const)
    factory.reset(target, width, height)
  expect(reset).toHaveBeenCalledTimes(4)
})

function maskedPdf(): Uint8Array {
  const stream = (body: string, dictionary = ''): string =>
    `<< /Length ${Buffer.byteLength(body)} ${dictionary} >>\nstream\n${body}\nendstream`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 64 64] /Resources << /XObject << /F 5 0 R >> /ExtGState << /G 7 0 R >> >> /Contents 4 0 R >>',
    stream(
      Array.from({ length: 50 }, (_, i) => `q 1 0 0 1 ${i % 8} ${i % 5} cm /G gs /F Do Q`).join(
        '\n'
      )
    ),
    stream(
      '0.2 0.5 0.8 rg 0 0 48 48 re f',
      '/Type /XObject /Subtype /Form /BBox [0 0 48 48] /Group << /S /Transparency /CS /DeviceRGB >> /Resources << >>'
    ),
    stream(
      '0.7 g 0 0 48 48 re f',
      '/Type /XObject /Subtype /Form /BBox [0 0 48 48] /Group << /S /Transparency /CS /DeviceGray >> /Resources << >>'
    ),
    '<< /Type /ExtGState /SMask << /S /Luminosity /G 6 0 R >> >>'
  ]
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [n, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${n + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf))
}

it('renders repeated native transparency masks with identical pixels and fresh reset state', async () => {
  const outputs: number[][] = [],
    resetCounts: number[] = []
  for (const patched of [false, true]) {
    const task = getDocument({ data: maskedPdf(), isEvalSupported: false, verbosity: 0 })
    const doc = await task.promise,
      factory = doc.canvasFactory
    let count = 0
    const original = factory.reset
    factory.reset = function (...args) {
      count++
      return original.apply(this, args)
    }
    if (patched) installPdfCanvasReset(factory)
    try {
      const page = await doc.getPage(1),
        canvas = createCanvas(96, 96)
      await page.render({
        canvas,
        canvasContext: canvas.getContext('2d'),
        viewport: page.getViewport({ scale: 1.5 })
      }).promise
      outputs.push(pixels(canvas))
      resetCounts.push(count)
    } finally {
      await task.destroy()
    }
  }
  expect(resetCounts[0]).toBeGreaterThan(40)
  expect(resetCounts[1]).toEqual(resetCounts[0])
  expect(outputs[1]).toEqual(outputs[0])
  expect(outputs[1].some((v) => v !== 255)).toBe(true)
})

it('keeps the native factory validation and rejects missing or nonpositive surfaces', async () => {
  const task = getDocument({ data: maskedPdf(), isEvalSupported: false, verbosity: 0 })
  try {
    const doc = await task.promise,
      factory = doc.canvasFactory
    installPdfCanvasReset(factory)
    expect(() => factory.reset({ canvas: null }, 10, 10)).toThrow('Canvas is not specified')
    const target = factory.create(10, 10)
    expect(() => factory.reset(target, 0, 10)).toThrow('Invalid canvas size')
    expect(() => factory.reset(target, 10, -1)).toThrow('Invalid canvas size')
    expect(target.canvas.width).toBe(10)
    expect(target.canvas.height).toBe(10)
    factory.destroy(target)
  } finally {
    await task.destroy()
  }
})
