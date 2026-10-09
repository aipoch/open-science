import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas, Path2D } from '@napi-rs/canvas'
const { collectGraphicsBounds } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
)
const { OPS, getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { recordPaintedOperationBounds } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-render-bounds.mjs')).href
)
const raster = (
  rgba = false
): { width: number; height: number; kind: number; data: Uint8Array } => {
  const channels = rgba ? 4 : 3,
    data = new Uint8Array(10 * 10 * channels).fill(255)
  for (let y = 2; y < 8; y++)
    for (let x = 2; x < 8; x++) {
      const i = (y * 10 + x) * channels
      data[i] = 0
    }
  return { width: 10, height: 10, kind: rgba ? 3 : 2, data }
}
const collect = (
  decoded: ReturnType<typeof raster>,
  matrix = [100, 0, 0, 100, 0, 0],
  viewport = true
): { paintedNormalizedRect?: number[]; normalizedRect: number[] } => {
  const internal = {
    operatorList: {
      fnArray: [OPS.transform, OPS.paintImageXObject],
      argsArray: [matrix, ['image']]
    },
    objs: { has: () => true, get: () => decoded },
    params: viewport
      ? { viewport: { width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] } }
      : {}
  }
  return collectGraphicsBounds(
    { _internalRenderTask: internal },
    { isEmpty: () => false, minX: () => 0, minY: () => 0, maxX: () => 1, maxY: () => 1 }
  ).graphicsBounds[0]
}
it.each([false, true])('records only provable white raster borders (rgba=%s)', (rgba) => {
  const g = collect(raster(rgba))
  expect(g.paintedNormalizedRect).toEqual([0.1, 0.1, 0.9, 0.9])
  expect(g.normalizedRect).toEqual([0, 0, 1, 1])
})

it('proves complete blank edge strips within the inspection budget of an already decoded large raster', () => {
  const width = 4100,
    height = 4000,
    data = new Uint8Array(width * height * 3)
  data.fill(255, 0, width * 3 * 2)
  data.fill(255, width * 3 * (height - 2))
  const g = collect({ width, height, kind: 2, data })
  expect(g.paintedNormalizedRect?.[0]).toBe(0)
  expect(g.paintedNormalizedRect?.[1]).toBeCloseTo(1 / height, 12)
  expect(g.paintedNormalizedRect?.[2]).toBe(1)
  expect(g.paintedNormalizedRect?.[3]).toBeCloseTo((height - 1) / height, 12)
  expect(g.normalizedRect).toEqual([0, 0, 1, 1])
})

it('does not assume unfinished strips in an all-white raster beyond the inspection budget', () => {
  const width = 4100,
    height = 4000,
    data = new Uint8Array(width * height * 3).fill(255)
  expect(collect({ width, height, kind: 2, data }).paintedNormalizedRect).toBeUndefined()
})
it.each(['border-ink', 'off-white', 'skew', 'rotate', 'missing-viewport', 'short-buffer'])(
  'preserves complete raster bounds without a strict decoded border proof: %s',
  (variant) => {
    const r = raster(),
      matrix = [100, 0, 0, 100, 0, 0]
    if (variant === 'border-ink')
      for (let y = 0; y < 10; y++)
        for (let x = 0; x < 10; x++)
          if (x === 0 || x === 9 || y === 0 || y === 9) r.data[(y * 10 + x) * 3] = 0
    if (variant === 'off-white')
      for (let i = 0; i < r.data.length; i++) if (r.data[i] === 255) r.data[i] = 254
    if (variant === 'skew') matrix[1] = 1
    if (variant === 'rotate') {
      matrix[0] = 0
      matrix[1] = 100
      matrix[2] = -100
      matrix[3] = 0
    }
    if (variant === 'short-buffer') r.data = new Uint8Array(3)
    const g = collect(r, matrix, variant !== 'missing-viewport')
    expect(g.paintedNormalizedRect).toBeUndefined()
  }
)
it('treats fully transparent pixels as unpainted and retains partially opaque pixels', () => {
  const r = raster(true)
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 10; x++)
      if (x < 2 || x >= 8 || y < 2 || y >= 8) {
        const i = (y * 10 + x) * 4
        r.data[i] = 0
        r.data[i + 3] = 0
      }
  expect(collect(r).paintedNormalizedRect).toEqual([0.1, 0.1, 0.9, 0.9])
  r.data[3] = 1
  expect(collect(r).paintedNormalizedRect?.slice(0, 2)).toEqual([0, 0])
})
it('does not scan decoded rasters beyond its independent pixel budget', () => {
  const r = { width: 4001, height: 4000, kind: 2, data: new Uint8Array(4001 * 4000 * 3) }
  expect(collect(r).paintedNormalizedRect).toBeUndefined()
})

const envelopeGraphic = (
  variant = 'complete'
): {
  normalizedRect: number[]
  paintedNormalizedRect?: number[]
  imageEnvelopeNormalizedRect?: number[]
} => {
  const decoded = { width: 32, height: 24, kind: 2, data: new Uint8Array(32 * 24 * 3) }
  const matrix = [270.7, 0, 0, 215.3, 150.2, 505.5]
  const viewport = {
    width: 900,
    height: 1200,
    scale: 1.5,
    rotation: 0,
    transform: [1.5, 0, 0, -1.5, 0, 1200]
  }
  const context = {
    filter: 'none',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  }
  const fnArray: number[] = [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore]
  const argsArray: unknown[][] = [[], matrix, ['image'], []]
  if (variant === 'reflection') matrix[0] *= -1
  if (variant === 'skew') matrix[1] = 1
  if (variant === 'rotation') {
    matrix[0] = 0
    matrix[1] = 270.7
    matrix[2] = -215.3
    matrix[3] = 0
  }
  if (variant === 'invalid-transform') matrix[0] = Number.NaN
  if (variant === 'short-data') decoded.data = new Uint8Array(3)
  if (variant === 'all-white') decoded.data.fill(255)
  if (variant === 'shadow') context.shadowBlur = 1
  if (variant === 'filter') context.filter = 'blur(1px)'
  if (variant === 'foreign-context')
    context.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 1, f: 0 })
  if (variant === 'viewport-rotation') viewport.rotation = 90
  if (variant === 'degenerate') matrix[0] = 0.1
  if (variant === 'underflow') {
    fnArray.unshift(OPS.restore)
    argsArray.unshift([])
  }
  if (variant === 'unbalanced') {
    fnArray.pop()
    argsArray.pop()
  }
  if (['soft-mask', 'blend', 'transfer', 'future-state'].includes(variant)) {
    const state =
      variant === 'soft-mask'
        ? ['SMask', false]
        : variant === 'blend'
          ? ['BM', 'source-over']
          : ['TR', null]
    if (variant === 'future-state') {
      fnArray.push(OPS.setGState)
      argsArray.push([[state]])
    } else {
      fnArray.unshift(OPS.setGState)
      argsArray.unshift([[state]])
    }
  }
  if (variant === 'form') {
    fnArray.unshift(OPS.paintFormXObjectBegin)
    argsArray.unshift([null, null])
  }
  if (variant === 'group') {
    fnArray.unshift(OPS.beginGroup)
    argsArray.unshift([{}])
  }
  if (variant === 'type3' || variant === 'missing-font') {
    fnArray.unshift(OPS.setFont)
    argsArray.unshift(['font', 10])
  }
  if (variant === 'text-clip') {
    fnArray.unshift(OPS.setTextRenderingMode)
    argsArray.unshift([7])
  }
  if (variant === 'rect-clip-unconsumed') {
    fnArray.unshift(OPS.eoClip)
    argsArray.unshift([])
  }
  if (variant === 'mask') fnArray[2] = OPS.paintImageMaskXObject
  if (variant === 'rect-clip' || variant === 'unknown-clip' || variant.startsWith('rendered-')) {
    fnArray.unshift(OPS.eoClip, OPS.constructPath)
    argsArray.unshift(
      [],
      [OPS.endPath, [[0, 0, 0, 1, 600, 0, 1, 600, 800, 1, 0, 800, 4]], [0, 0, 600, 800]]
    )
    if (variant === 'unknown-clip') argsArray[1][1] = [[0, 0, 0, 2, 0, 800, 600, 800, 600, 0, 4]]
    if (variant.startsWith('rendered-')) {
      const clip = new Path2D()
      clip.moveTo(0, 0)
      clip.lineTo(600, 0)
      if (variant === 'rendered-curved-clip') clip.bezierCurveTo(600, 300, 500, 800, 600, 800)
      else clip.lineTo(600, 800)
      clip.lineTo(variant === 'rendered-nonrect-clip' ? 10 : 0, 800)
      if (variant !== 'rendered-open-clip') {
        clip.lineTo(0, 0)
        clip.closePath()
      }
      if (variant === 'rendered-multiple-clip') clip.rect(40, 40, 10, 10)
      argsArray[1][1] = [
        variant === 'rendered-fake-clip' ? { toSVGString: () => clip.toSVGString() } : clip
      ]
    }
  }
  const imageIndex = fnArray.findIndex((v) =>
    [OPS.paintImageXObject, OPS.paintImageMaskXObject].includes(v)
  )
  return collectGraphicsBounds(
    {
      _internalRenderTask: {
        operatorList: { fnArray, argsArray },
        gfx:
          variant === 'missing-renderer-context'
            ? undefined
            : {
                ctx: variant === 'foreign-renderer-context' ? { ...context } : context,
                pageColors: variant === 'page-colors' ? { background: '#fff' } : null
              },
        objs: { has: () => true, get: () => decoded },
        commonObjs: {
          has: () => variant !== 'missing-font',
          get: () => ({
            type: variant === 'type3' ? 'Type3' : 'CIDFontType2',
            isType3Font: variant === 'type3'
          })
        },
        params: {
          viewport: variant === 'missing-viewport' ? undefined : viewport,
          canvasContext: variant === 'missing-context' ? undefined : context,
          ...(variant === 'custom-background' ? { background: '#fff' } : {}),
          ...(variant === 'task-transform' ? { transform: [1, 0, 0, 1, 0, 0] } : {})
        }
      }
    },
    {
      isEmpty: (i: number) => i !== imageIndex,
      minX: () => (variant === 'contradictory-box' ? 0.4 : 0.24),
      minY: () => 0.09,
      maxX: () => 0.72,
      maxY: () => 0.38
    }
  ).graphicsBounds[0]
}

it.each(['complete', 'rect-clip', 'rendered-rect-clip'])(
  'records a distinct rounded raster upper envelope without inventing opaque ink borders: %s',
  (variant) => {
    const g = envelopeGraphic(variant)
    expect(g.normalizedRect).toEqual([0.24, 0.09, 0.72, 0.38])
    expect(g.paintedNormalizedRect).toBeUndefined()
    expect(g.imageEnvelopeNormalizedRect).toEqual([
      expect.closeTo((150.2 * 1.5 - 0.5) / 900, 12),
      expect.closeTo(((800 - 505.5 - 215.3) * 1.5 - 0.5) / 1200, 12),
      expect.closeTo(((150.2 + 270.7) * 1.5 + 0.5) / 900, 12),
      expect.closeTo(((800 - 505.5) * 1.5 + 0.5) / 1200, 12)
    ])
  }
)

it.each([
  'reflection',
  'skew',
  'rotation',
  'invalid-transform',
  'short-data',
  'all-white',
  'shadow',
  'filter',
  'foreign-context',
  'missing-renderer-context',
  'foreign-renderer-context',
  'page-colors',
  'custom-background',
  'viewport-rotation',
  'degenerate',
  'underflow',
  'unbalanced',
  'soft-mask',
  'blend',
  'transfer',
  'future-state',
  'form',
  'group',
  'type3',
  'missing-font',
  'text-clip',
  'mask',
  'rect-clip-unconsumed',
  'unknown-clip',
  'rendered-open-clip',
  'rendered-curved-clip',
  'rendered-nonrect-clip',
  'rendered-multiple-clip',
  'rendered-fake-clip',
  'missing-viewport',
  'missing-context',
  'task-transform',
  'contradictory-box'
])('refuses an unqualified raster envelope while preserving existing bounds: %s', (variant) => {
  expect(envelopeGraphic(variant).imageEnvelopeNormalizedRect).toBeUndefined()
})

// PDF.js replaces numeric DrawOPS with the actual native Path2D while painting.
// Exercise that post-render call site, rather than a pre-render operator mock.
const renderClippedImage = async (
  curved: boolean
): Promise<{
  normalizedRect: number[]
  paintedNormalizedRect?: number[]
  imageEnvelopeNormalizedRect?: number[]
}> => {
  const pixels = Buffer.alloc(32 * 24 * 3)
  const content = Buffer.from(
    `q ${curved ? '0 0 m 600 0 l 600 300 500 800 600 800 c 0 800 l h' : '0 0 600 800 re'} W n 270.7 0 0 215.3 151.2 505.5 cm /Plate Do Q`
  )
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Plate 5 0 R >> >> /Contents 4 0 R >>'
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from('\nendstream')
    ]),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 32 /Height 24 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`
      ),
      pixels,
      Buffer.from('\nendstream')
    ])
  ]
  const chunks = [Buffer.from('%PDF-1.4\n')],
    offsets = [0]
  for (const [i, object] of objects.entries()) {
    offsets.push(chunks.reduce((n, chunk) => n + chunk.length, 0))
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n'))
  }
  const startXref = chunks.reduce((n, chunk) => n + chunk.length, 0)
  chunks.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`
    )
  )
  const loading = getDocument({
    data: new Uint8Array(Buffer.concat(chunks)),
    isEvalSupported: false,
    verbosity: 0
  })
  try {
    const document = await loading.promise,
      page = await document.getPage(1)
    const viewport = page.getViewport({ scale: 1.5 }),
      canvas = createCanvas(900, 1200)
    const rendering = page.render({
      // PDF.js's declarations use browser DOM types for the supported Node canvas.
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
      viewport,
      recordOperations: true
    })
    recordPaintedOperationBounds(rendering)
    await rendering.promise
    const internal = (
      rendering as unknown as {
        _internalRenderTask?: { operatorList: { fnArray: number[]; argsArray: unknown[] } }
      }
    )._internalRenderTask
    if (!internal) throw new Error('Completed native rendering task is unavailable.')
    const clipIndex = internal.operatorList.fnArray.indexOf(OPS.clip)
    const clip = internal.operatorList.argsArray[clipIndex + 1]
    if (!Array.isArray(clip) || !Array.isArray(clip[1]))
      throw new Error('Completed native clipping path is unavailable.')
    expect(clip[1][0]).toBeInstanceOf(Path2D)
    return collectGraphicsBounds(rendering, page.recordedBBoxes).graphicsBounds.find(
      (g: { kind: string }) => g.kind === 'image'
    )
  } finally {
    await loading.destroy()
  }
}

it('retains the strict image upper envelope after actual optimized rectangular-clip rendering', async () => {
  const image = await renderClippedImage(false)
  expect(image.paintedNormalizedRect).toBeUndefined()
  expect(image.imageEnvelopeNormalizedRect).toEqual([
    expect.closeTo((151.2 * 1.5 - 0.5) / 900, 12),
    expect.closeTo(((800 - 505.5 - 215.3) * 1.5 - 0.5) / 1200, 12),
    expect.closeTo(((151.2 + 270.7) * 1.5 + 0.5) / 900, 12),
    expect.closeTo(((800 - 505.5) * 1.5 + 0.5) / 1200, 12)
  ])
  expect(image.normalizedRect[0]).toBeLessThanOrEqual(image.imageEnvelopeNormalizedRect![0])
  expect(image.normalizedRect[3]).toBeGreaterThanOrEqual(image.imageEnvelopeNormalizedRect![3])
})

it('refuses an actual rendered curved clip without changing recorded image bounds', async () => {
  const image = await renderClippedImage(true)
  expect(image.paintedNormalizedRect).toBeUndefined()
  expect(image.imageEnvelopeNormalizedRect).toBeUndefined()
  expect(image.normalizedRect).toEqual((await renderClippedImage(false)).normalizedRect)
})
