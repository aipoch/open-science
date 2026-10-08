/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readPdfFixture } from './read-fixture'

const {
  readingRotation,
  isUprightText,
  originalRect,
  rotatedTextRect,
  restoreCaptionCoordinates,
  tableTextToken
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-orientation.mjs')).href
)

it.each([
  [0, 0],
  [90, 270],
  [270, 90],
  [180, 0],
  [0, 180]
])('restores each continued caption part with its own page rotation (%s, %s)', (first, second) => {
  const rotations = [first, second],
    pages = rotations.map((rotation, n) => ({
      pageNumber: n + 1,
      width: 600,
      height: 800,
      rotation: n ? 90 : 270,
      renderRotation: ((n ? 90 : 270) + rotation) % 360
    }))
  const rects = [
      [110, 680, 470, 710],
      [90, 45, 460, 75]
    ],
    expected = (rotation: number, [x0, y0, x1, y1]: number[]): number[] =>
      rotation === 90
        ? [y0, 600 - x1, y1, 600 - x0]
        : rotation === 270
          ? [800 - y1, x0, 800 - y0, x1]
          : rotation === 180
            ? [600 - x1, 800 - y1, 600 - x0, 800 - y0]
            : [x0, y0, x1, y1]
  const parts = rects.map((rect, n) => ({ page: n + 1, rect })),
    caption = { page: 1, rect: rects[0], regions: parts },
    otherOwner = structuredClone(caption)
  otherOwner.regions = parts
  restoreCaptionCoordinates(caption, pages)
  restoreCaptionCoordinates(otherOwner, pages)
  expect(caption.rect).toEqual(expected(first, rects[0]))
  expect(caption.regions.map((r: { rect: number[] }) => r.rect)).toEqual(
    rects.map((r, n) => expected(rotations[n], r))
  )
  expect(otherOwner.regions).toEqual(caption.regions)
  expect(parts).toEqual(rects.map((rect, n) => ({ page: n + 1, rect })))
})

it('preserves single-page captions and unavailable page geometry without inventing a source', () => {
  const caption = { page: 1, rect: [10, 20, 100, 40] },
    pages = [{ pageNumber: 1, width: 600, height: 800, rotation: 0, renderRotation: 90 }]
  restoreCaptionCoordinates(undefined, pages)
  restoreCaptionCoordinates(caption, pages)
  expect(caption.rect).toEqual([20, 500, 40, 590])
  expect(caption).not.toHaveProperty('regions')
  const unknown = {
      page: 2,
      rect: [10, 20, 100, 40],
      regions: [{ page: 3, rect: [50, 60, 70, 80] }]
    },
    before = structuredClone(unknown)
  restoreCaptionCoordinates(unknown, pages)
  expect(unknown).toEqual(before)
})
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
it('orients a short count-mean-range continuation despite upright manuscript margins', () => {
  const f = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/rotated-count-mean-range-beside-manuscript-margins.jsonl'
    )
  )
  expect(readingRotation(f.page, f.content)).toBe(90)
  const fragmented = structuredClone(f)
  fragmented.content.items = fragmented.content.items.filter(
    (i: { str: string }) => !['0–36', '0–99', '0–54', '0–33'].includes(i.str)
  )
  expect(readingRotation(fragmented.page, fragmented.content)).toBe(0)
})
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
it('excludes a long vertical publisher mark outside every source row', () => {
  const table = {
    id: 'vertical-publisher-mark',
    cropRect: [80, 100, 200, 220],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 120, 100] },
        { label: 'table column', rect: [0, 0, 120, 100] }
      ]
    }
  }
  const result = refineTable(table, [
    {
      text: '10',
      rect: [90, 120, 105, 135],
      height: 15,
      baseline: 135,
      horizontal: true
    },
    {
      text: 'John Wiley & Sons Ltd, MENCAP & IASSID',
      rect: [72, 145, 84, 215],
      height: 12,
      baseline: 215,
      horizontal: false
    }
  ])
  expect(result.issues).not.toContain('text-crosses-crop-boundary')
  expect(result.issues).not.toContain('unsupported-text-orientation')
  expect(result.clipped).toEqual([])
})
it('keeps a detached definition line out of the final source row', () => {
  const table = {
    id: 'detached-definition-note',
    cropRect: [80, 100, 200, 220],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 120, 40] },
        { label: 'table column', rect: [0, 0, 120, 40] }
      ]
    }
  }
  const result = refineTable(table, [
    {
      text: '10',
      rect: [90, 120, 105, 135],
      height: 15,
      baseline: 135,
      horizontal: true
    },
    {
      text: 'ADLs = activities of daily living.',
      rect: [90, 155, 190, 165],
      height: 10,
      baseline: 165,
      horizontal: true
    }
  ])
  expect(result.grid[0][0]).toBe('10')
  expect(result.unassigned).toEqual([])
})
it('excludes a two-part running header that only grazes a continuation crop', () => {
  const table = {
    id: 'running-header-continuation',
    cropRect: [80, 100, 200, 220],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 120, 120] },
        { label: 'table column', rect: [0, 0, 120, 120] }
      ]
    }
  }
  const body = {
    text: '10',
    rect: [90, 120, 105, 135],
    height: 15,
    baseline: 135,
    horizontal: true
  }
  const header = (text: string, rect: number[]): object => ({
    text,
    rect,
    height: 15,
    baseline: 100.9,
    horizontal: true
  })
  const result = refineTable(table, [
    body,
    header('JOURNAL OF MEDICAL INTERNET RESEARCH', [82, 85, 170, 100.9]),
    header('Wang et al', [175, 85, 198, 100.9])
  ])
  expect(result.issues).not.toContain('text-crosses-crop-boundary')
  expect(result.clipped).toEqual([])
  expect(result.repairs).toContain('top-running-header-excluded')
})

it('assigns a vertical SNR stub label to the table while leaving ordinary vertical furniture unowned', () => {
  const table = {
    id: 'rotated-snr-stub',
    readingRotation: 90,
    cropRect: [0, 0, 300, 100],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 300, 100], score: 1 },
        { label: 'table column', rect: [0, 0, 80, 100], score: 1 },
        { label: 'table column', rect: [80, 0, 180, 100], score: 1 },
        { label: 'table column', rect: [180, 0, 300, 100], score: 1 }
      ]
    }
  }
  const vertical = (text: string) => ({
    text,
    rect: [20, 20, 32, 90],
    height: 12,
    baseline: 90,
    horizontal: false
  })
  const values = [
    { text: '10', rect: [100, 20, 115, 32], height: 12, baseline: 32, horizontal: true },
    { text: '20', rect: [200, 20, 215, 32], height: 12, baseline: 32, horizontal: true }
  ]

  const accepted = refineTable(table, [vertical('SNR 15'), ...values])
  expect(accepted.grid[0]).toEqual(['SNR 15', '10', '20'])
  expect(accepted.issues).not.toContain('unsupported-text-orientation')
  expect(accepted.unassigned).toEqual([])

  const furniture = refineTable(table, [vertical('Volume'), ...values])
  expect(furniture.grid[0][0]).toBe('')
  expect(furniture.issues).toContain('unsupported-text-orientation')
  expect(furniture.unassigned).toEqual(['Volume'])
})
it('keeps a real clipped body line when a running header shares the crop edge', () => {
  const table = {
    id: 'running-header-with-clipped-body',
    cropRect: [80, 100, 200, 220],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 120, 120] },
        { label: 'table column', rect: [0, 0, 120, 120] }
      ]
    }
  }
  const header = (text: string, rect: number[]): object => ({
    text,
    rect,
    height: 15,
    baseline: 100.9,
    horizontal: true
  })
  const result = refineTable(table, [
    {
      text: '10',
      rect: [90, 120, 105, 135],
      height: 15,
      baseline: 135,
      horizontal: true
    },
    header('JOURNAL OF MEDICAL INTERNET RESEARCH', [82, 85, 170, 100.9]),
    header('Wang et al', [175, 85, 198, 100.9]),
    {
      text: 'continued source line',
      rect: [90, 218, 180, 226],
      height: 8,
      baseline: 226,
      horizontal: true
    }
  ])
  expect(result.issues).toContain('text-crosses-crop-boundary')
  expect(result.clipped).toEqual([{ text: 'continued source line', rect: [90, 218, 180, 226] }])
  expect(result.repairs).toContain('top-running-header-excluded')
})
it('excludes an isolated footnote marker just beyond a table crop', () => {
  const table = {
    id: 'bottom-footnote-marker',
    cropRect: [80, 100, 200, 220],
    structure: {
      objects: [
        { label: 'table row', rect: [0, 0, 120, 120] },
        { label: 'table column', rect: [0, 0, 120, 120] }
      ]
    }
  }
  const result = refineTable(table, [
    {
      text: '10',
      rect: [90, 120, 105, 135],
      height: 15,
      baseline: 135,
      horizontal: true
    },
    {
      text: 'a',
      rect: [120, 219.1, 124, 225],
      height: 5.9,
      baseline: 225,
      horizontal: true
    }
  ])
  expect(result.issues).not.toContain('text-crosses-crop-boundary')
  expect(result.clipped).toEqual([])
  expect(result.repairs).toContain('bottom-footnote-marker-excluded')
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
it.each(
  [0, 90, 180, 270].flatMap((nativeRotation) =>
    [0, 90, 180, 270].flatMap((rotation) =>
      [1, 2].flatMap((userUnit) =>
        [0.75, 1.5].map((scale) => [nativeRotation, rotation, userUnit, scale])
      )
    )
  )
)(
  'keeps cropped source bounds with native %s, reading %s degrees, UserUnit %s and scale %s',
  async (nativeRotation, rotation, userUnit, scale) => {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /CropBox [20 30 580 770] /UserUnit ${userUnit} /Rotate ${nativeRotation} /Resources << >> >>`
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
      const upright = page.getViewport({ scale, rotation }),
        original = page.getViewport({ scale })
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
      for (const angle of [rotation, (rotation + 90) % 360]) {
        const radians = (angle * Math.PI) / 180,
          ux = Math.cos(radians),
          uy = Math.sin(radians)
        const sourceItem = { pageNumber: 1, index: 7, text: 'µ' }
        const item = {
          str: 'µ',
          dir: 'ltr',
          width: 40,
          height: 10,
          inlineSymbol: true,
          sourceItem,
          transform: [10 * ux, 10 * uy, -10 * uy, 10 * ux, 200, 300]
        }
        const token = tableTextToken(item, upright, rotation)
        const corners = [
          [200, 300],
          [200 + 40 * ux, 300 + 40 * uy],
          [200 - 10 * uy, 300 + 10 * ux],
          [200 + 40 * ux - 10 * uy, 300 + 40 * uy + 10 * ux]
        ].map(([x, y]) => original.convertToViewportPoint(x, y))
        const expectedToken = [
          Math.min(...corners.map((p) => p[0])),
          Math.min(...corners.map((p) => p[1])),
          Math.max(...corners.map((p) => p[0])),
          Math.max(...corners.map((p) => p[1]))
        ]
        const restored = originalRect(token.rect, upright.width, upright.height, delta)
        expectedToken.forEach((v, i) => expect(restored[i]).toBeCloseTo(v, 10))
        expect(token.height).toBeCloseTo(10 * userUnit * scale, 10)
        expect(token.horizontal).toBe(angle === rotation)
        expect(token.sourceItem).toBe(sourceItem)
        expect(token.inlineSymbol).toBe(true)
      }
    } finally {
      await task.destroy()
    }
  }
)
