import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { expect, it } from 'vitest'
import { resolve } from './paths'

const { getDocument, OPS } = await import(
  pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
)
const { collectGraphicsBounds } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { recordPaintedOperationBounds } = await import(
  pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href
)

const pdfBytes = (content: string): Uint8Array => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf))
}

type Geometry = {
  graphicsBounds: { kind: string; normalizedRect: number[] }[]
  invalidGraphicsBounds: number
}
const render = async (content: string): Promise<{ pixels: Buffer; geometry: Geometry }> => {
  const task = getDocument({ data: pdfBytes(content), verbosity: 0, isEvalSupported: false })
  const canvas = createCanvas(300, 300)
  try {
    const page = await (await task.promise).getPage(1)
    const rendering = page.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport: page.getViewport({ scale: 1.5 }),
      recordOperations: true
    })
    recordPaintedOperationBounds(rendering)
    await rendering.promise
    const result = collectGraphicsBounds(rendering, page.recordedBBoxes)
    return {
      pixels: Buffer.from(canvas.getContext('2d').getImageData(0, 0, 300, 300).data),
      // Inserting a clipped operation changes render-stream indices, not ink.
      geometry: {
        ...result,
        graphicsBounds: result.graphicsBounds.map(
          ({ kind, normalizedRect }: { kind: string; normalizedRect: number[] }) => ({
            kind,
            normalizedRect
          })
        )
      }
    }
  } finally {
    await task.destroy()
  }
}

it.each(['20 20 10 10', '20 110 10 10', '110 20 10 10'])(
  'ignores an empty native clip intersection for %s without changing visible pixels',
  async (rectangle) => {
    const baseline = await render('30 30 20 20 re f')
    const clipped = await render(`q 100 100 40 40 re W n ${rectangle} re f Q 30 30 20 20 re f`)
    expect(clipped.pixels).toEqual(baseline.pixels)
    expect(baseline.geometry.graphicsBounds).toHaveLength(1)
    expect(clipped.geometry).toEqual(baseline.geometry)
    expect(clipped.geometry.invalidGraphicsBounds).toBe(0)
  }
)

it.each([NaN, Infinity, -Infinity, undefined])(
  'retains an invalid boundary for nonfinite coordinates %s',
  (bad) => {
    const task = {
      _internalRenderTask: {
        operatorList: { fnArray: [OPS.constructPath], argsArray: [[OPS.fill]] }
      }
    }
    const boxes = {
      isEmpty: (): boolean => false,
      minX: (): number | undefined => bad,
      minY: (): number => 0.6,
      maxX: (): number => 0.2,
      maxY: (): number => 0.1
    }
    expect(collectGraphicsBounds(task, boxes)).toMatchObject({
      graphicsBounds: [],
      invalidGraphicsBounds: 1
    })
  }
)

it.each(['20 20 m 100 20 l', '20 20 m 20 100 l'])(
  'preserves a visible native hairline %s',
  async (path) => {
    const result = await render(`0 w ${path} S`)
    expect(result.geometry.invalidGraphicsBounds).toBe(0)
    expect(result.geometry.graphicsBounds).toHaveLength(1)
    const rect = result.geometry.graphicsBounds[0].normalizedRect
    expect(rect[2]).toBeGreaterThan(rect[0])
    expect(rect[3]).toBeGreaterThan(rect[1])
    expect([...result.pixels].some((value, index) => index % 4 !== 3 && value < 200)).toBe(true)
  }
)

it.each([{ rect: [0.2, 0.2, 0.2, 0.4] }, { rect: [0.2, 0.4, 0.3, 0.4] }])(
  'ignores a finite zero-area recorded intersection $rect',
  ({ rect }) => {
    const task = {
      _internalRenderTask: {
        operatorList: { fnArray: [OPS.constructPath], argsArray: [[OPS.fill]] }
      }
    }
    const boxes = {
      isEmpty: (): boolean => false,
      minX: (): number => rect[0],
      minY: (): number => rect[1],
      maxX: (): number => rect[2],
      maxY: (): number => rect[3]
    }
    expect(collectGraphicsBounds(task, boxes)).toMatchObject({
      graphicsBounds: [],
      invalidGraphicsBounds: 0
    })
  }
)
