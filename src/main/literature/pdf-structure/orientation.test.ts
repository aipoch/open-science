import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { readingRotation, isUprightText, originalRect, rotatedTextRect } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-orientation.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const text = (str: string, rotation: number): object => {
  const angle = (rotation * Math.PI) / 180,
    a = Math.cos(angle) * 10,
    b = Math.sin(angle) * 10
  return { str, dir: 'ltr', transform: [a, b, -b, a, 50, 70] }
}
it.each([
  [
    [0, 10, -10, 0, 50, 70],
    [60, 900, 75, 1095]
  ],
  [
    [0, -10, 10, 0, 50, 200],
    [75, 900, 90, 1095]
  ],
  [
    [-10, 0, 0, -10, 200, 70],
    [105, 1095, 300, 1110]
  ]
])('bounds rotated text along its actual baseline (%j)', (transform, expected) => {
  const viewport = { convertToViewportPoint: (x: number, y: number) => [x * 1.5, (800 - y) * 1.5] }
  expect(rotatedTextRect({ transform, width: 130, height: 10 }, viewport)).toEqual(expected)
})
it('excludes sideways margin text but still warns about vertical text inside the table', () => {
  const viewport = { convertToViewportPoint: (x: number, y: number) => [x * 1.5, (800 - y) * 1.5] }
  const table = {
    id: 'sideways-margin',
    cropRect: [80, 900, 200, 1140],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 120, 240] },
        { label: 'table column', rect: [0, 0, 60, 240] },
        { label: 'table column', rect: [60, 0, 120, 240] }
      ]
    }
  }
  const body = {
    text: '10',
    rect: [90, 920, 110, 935],
    height: 15,
    baseline: 935,
    horizontal: true
  }
  const margin = (x: number): object => ({
    text: 'Volume',
    height: 15,
    baseline: 1095,
    horizontal: false,
    rect: rotatedTextRect({ transform: [0, 10, -10, 0, x, 70], width: 130, height: 10 }, viewport)
  })
  expect(refineTable(table, [body, margin(50)]).issues).not.toContain('text-crosses-crop-boundary')
  expect(refineTable(table, [body, margin(58)]).issues).toContain('text-crosses-crop-boundary')
  expect(refineTable(table, [body, margin(80)]).issues).toContain('unsupported-text-orientation')
  const watermark = { ...margin(58), text: 'Accepted Article' }
  expect(refineTable(table, [body, watermark]).issues).not.toContain('text-crosses-crop-boundary')
  expect(refineTable(table, [body, { ...watermark, horizontal: true }]).issues).toContain(
    'text-crosses-crop-boundary'
  )
})
it('keeps sheared italic text but rejects a genuinely diagonal baseline', () => {
  expect(isUprightText({ str: 'µ', dir: 'ltr', transform: [10, 0, 1.5, 10, 20, 30] }, 0)).toBe(true)
  expect(isUprightText({ str: 'µ', dir: 'ltr', transform: [0, 10, -10, 1.5, 20, 30] }, 90)).toBe(
    true
  )
  expect(isUprightText(text('Diagonal watermark', 20), 0)).toBe(false)
})
it.each([90, 270])(
  'reads sideways table text at %s degrees without rotating ordinary chart labels',
  (rotation) => {
    const content = {
      items: [text('Table I. Review', rotation), text('Clinical records '.repeat(12), rotation)]
    }
    expect(readingRotation({ rotate: 0 }, content)).toBe(rotation)
    expect(isUprightText(content.items[1], rotation)).toBe(true)
    expect(isUprightText(content.items[1], 0)).toBe(false)
    const mixed = { items: [...content.items, text('Ordinary paragraph '.repeat(100), 0)] }
    expect(readingRotation({ rotate: 0 }, mixed)).toBe(rotation)
    expect(
      readingRotation({ rotate: 0 }, { items: [text('Axis label', rotation), mixed.items[2]] })
    ).toBe(0)
    expect(
      readingRotation({ rotate: 0 }, { items: [...mixed.items, text('Fig. 1. Results', 0)] })
    ).toBe(0)
    expect(
      readingRotation({ rotate: 0 }, { items: [...content.items, text('Fig. 1. Results', 0)] })
    ).toBe(0)
    expect(readingRotation({ rotate: 180 }, content)).toBe(rotation)
    expect(
      readingRotation(
        { rotate: 0 },
        {
          items: [
            text('Table 2', rotation),
            text('Numeric records '.repeat(12), rotation),
            mixed.items[2]
          ]
        }
      )
    ).toBe(rotation)
  }
)
it.each([
  [0, 90],
  [0, 270],
  [270, 0],
  [90, 0],
  [180, 0]
])(
  'keeps source rectangles in original PDF coordinates with native %s and reading %s degrees',
  async (nativeRotation, rotation) => {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate ${nativeRotation} /Resources << >> >>`
    ]
    let pdf = '%PDF-1.4\n'
    const offsets = objects.map((object, i) => {
      const offset = pdf.length
      pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
      return offset
    })
    const xref = pdf.length
    pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    const task = getDocument({ data: new Uint8Array(Buffer.from(pdf)), verbosity: 0 })
    try {
      const page = await (await task.promise).getPage(1)
      const upright = page.getViewport({ scale: 1.5, rotation }),
        original = page.getViewport({ scale: 1.5 })
      const pdfRect = [40, 60, 120, 190]
      const sorted = (r: number[]): number[] => [
        Math.min(r[0], r[2]),
        Math.min(r[1], r[3]),
        Math.max(r[0], r[2]),
        Math.max(r[1], r[3])
      ]
      const rect = sorted(upright.convertToViewportRectangle(pdfRect)),
        expected = sorted(original.convertToViewportRectangle(pdfRect))
      const delta = (rotation - nativeRotation + 360) % 360
      expect(originalRect(rect, upright.width, upright.height, delta)).toEqual(expected)
      const normalized = originalRect(
        rect.map((v, i) => v / (i % 2 ? upright.height : upright.width)),
        1,
        1,
        delta
      )
      expected.forEach((v, i) =>
        expect(normalized[i]).toBeCloseTo(v / (i % 2 ? original.height : original.width), 12)
      )
    } finally {
      await task.destroy()
    }
  }
)
