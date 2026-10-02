import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { expect, it } from 'vitest'

const { getDocument } = await import(
  pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
)
const { collectGraphicsBounds } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
)
const { recordPaintedOperationBounds } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-render-bounds.mjs')).href
)

function pdfBytes(content: string): Uint8Array {
  const form = '0 0 20 20 re 0 0 1 rg f'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R /Fm 6 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n00ff00>\nendstream',
    `<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Resources << >> /Length ${form.length} >>\nstream\n${form}\nendstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf))
}

async function render(
  content: string,
  paintedOnly: boolean
): Promise<{
  geometry: { graphicsBounds: unknown[]; invalidGraphicsBounds: number }
  pixels: Buffer
}> {
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
    if (paintedOnly) recordPaintedOperationBounds(rendering)
    await rendering.promise
    return {
      geometry: collectGraphicsBounds(rendering, page.recordedBBoxes),
      pixels: Buffer.from(canvas.getContext('2d').getImageData(0, 0, 300, 300).data)
    }
  } finally {
    canvas.width = canvas.height = 1
    await task.destroy()
  }
}

it.each([
  [
    'cumulative transforms',
    Array.from({ length: 100 }, () => '1 0 0 1 0.25 0.25 cm 0 0 10 10 re S').join('\n')
  ],
  [
    'nested clips and restores',
    'q 5 5 180 180 re W n q 1 0 0 1 10 20 cm 0 0 40 40 re W n 0 0 100 100 re f Q 60 60 40 40 re S Q 190 190 5 5 re f'
  ],
  ['reused form paths', 'q 1 0 0 1 10 20 cm /Fm Do Q q 2 0 0 2 60 70 cm /Fm Do Q'],
  [
    'optimized image groups',
    Array.from({ length: 5 }, (_, index) => `q 20 0 0 20 ${20 + index * 30} 100 cm /Im Do Q`).join(
      '\n'
    ) + '\nq 30 100 40 20 re W n 160 0 0 20 20 100 cm /Im Do Q'
  ]
])('preserves actual painted geometry and pixels with %s', async (_name, content) => {
  const baseline = await render(content, false)
  const optimized = await render(content, true)
  expect(baseline.geometry.graphicsBounds.length).toBeGreaterThan(0)
  expect(optimized.geometry).toEqual(baseline.geometry)
  expect(optimized.pixels.equals(baseline.pixels)).toBe(true)
})

it('rejects an unavailable operation tracker instead of silently losing bounds', () => {
  expect(() => recordPaintedOperationBounds({})).toThrow()
})
