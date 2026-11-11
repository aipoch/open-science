import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const { groupTableParts, matchesGroupedTableCropPng } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-group.mjs')).href
)
const line = (
  text: string,
  y: number
): { text: string; x: number; y: number; width: number; height: number } => ({
  text,
  x: 10,
  y,
  width: 90,
  height: 10
})
const page = {
  lines: [line('Table 1. Sample data.', 0), line('A. Tricco data', 15), line('B. Dewa data', 110)]
}
const table = (
  id: string,
  top: number,
  bottom: number,
  columns: number
): {
  id: string
  page: number
  cropRect: number[]
  rows: { rect: number[] }[]
  grid: string[][]
  cells: never[]
  unassigned: string[]
  issues: string[]
  notes: { text: string; rect: number[] }[]
  sourceViewport: { width: number; height: number }
} => ({
  id,
  page: 1,
  cropRect: [0, top * 1.5, 300, bottom * 1.5],
  rows: [{ rect: [0, top * 1.5, 300, bottom * 1.5] }],
  grid: [Array(columns).fill('Value')],
  cells: [],
  unassigned: [],
  issues: [],
  notes: [],
  sourceViewport: { width: 300, height: 600 }
})
const parts = [
  {
    ...table('table-1', 30, 100, 5),
    caption: { text: 'Table 1. Sample data.', rect: [0, 0, 200, 10] }
  },
  {
    ...table('table-2', 125, 200, 7),
    notes: [{ text: 'Shared note', rect: [0, 205, 200, 215] }],
    captionIssue: 'unmatched-caption'
  }
]

it('keeps complete native note descenders and refuses a foreign glyph in their raster strip', async () => {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const {
    captureNativeFigureRenderContext,
    matchNativeFigureRenderContext,
    recordPaintedOperationBounds
  } = await import(pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href)
  const { collectGraphicsBounds } = await import(
    pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
  )
  const { tableTextToken } = await import(
    pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
  )
  const { renderPdfCrop } = await import(
    pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
  )
  const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  for (const foreign of [false, true]) {
    const stream =
      'BT /F1 10 Tf 10 185 Td (Shared typography) Tj ET\n' +
      (foreign ? 'BT /F1 1 Tf 150 183.5 Td (x) Tj ET' : '')
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
    ]
    let pdf = '%PDF-1.4\n'
    const offsets = objects.map((object, i) => {
      const offset = pdf.length
      pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
      return offset
    })
    const xref = pdf.length
    pdf +=
      'xref\n0 6\n0000000000 65535 f \n' +
      offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
    pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    const task = getDocument({
      data: new Uint8Array(Buffer.from(pdf)),
      isEvalSupported: false,
      fontExtraProperties: true,
      useSystemFonts: false,
      standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + '/'
    })
    try {
      const doc = await task.promise,
        nativePage = await doc.getPage(1),
        viewport = nativePage.getViewport({ scale: 1 }),
        scaled = nativePage.getViewport({ scale: 1.5 }),
        canvas = createCanvas(scaled.width, scaled.height)
      const rendering = nativePage.render({
        canvas,
        canvasContext: canvas.getContext('2d'),
        viewport: scaled,
        recordOperations: true
      })
      recordPaintedOperationBounds(rendering)
      await rendering.promise
      const content = await nativePage.getTextContent(),
        graphics = collectGraphicsBounds(rendering, nativePage.recordedBBoxes),
        hash = '0'.repeat(64)
      const snapshot = captureNativeFigureRenderContext(
        rendering,
        1,
        content,
        viewport,
        graphics.graphicsBounds,
        hash,
        nativePage.commonObjs
      )
      const context = {
        ...matchNativeFigureRenderContext(
          snapshot,
          1,
          content,
          viewport,
          graphics.graphicsBounds,
          hash
        ),
        pageNumber: 1,
        sourceSha256: hash
      }
      const tokens = context.content.items.flatMap((item: ReturnType<typeof JSON.parse>) =>
        item.str.trim()
          ? [{ ...tableTextToken(item, viewport, 0), sourceItem: item.sourceItem }]
          : []
      )
      const native = { ...page, pageNumber: 1, width: 200, height: 400, rotation: 0, ...graphics }
      const members = [
        parts[0],
        { ...parts[1], notes: [{ text: 'Shared typography', rect: [0, 205, 200, 215] }] }
      ]
      const before = JSON.stringify(members)
      expect(groupTableParts(members, native, tokens)).toHaveLength(2)
      const grouped = groupTableParts(members, native, tokens, context)
      if (foreign) expect(grouped).toHaveLength(2)
      else {
        expect(grouped).toHaveLength(1)
        const rect = grouped[0].cropRect.map((v: number) => v / 1.5)
        expect(rect[3]).toBeGreaterThan(217)
        expect(rect[3]).toBeLessThan(218)
        expect(grouped[0].parts.map((part: { cropRects: number[][] }) => part.cropRects)).toEqual(
          members.map((member) => [member.cropRect])
        )
        const png = await renderPdfCrop(nativePage, rect, 0)
        expect(matchesGroupedTableCropPng(grouped[0], png)).toBe(true)
        const image = await loadImage(png),
          cropCanvas = createCanvas(image.width, image.height),
          ctx = cropCanvas.getContext('2d')
        ctx.drawImage(image, 0, 0)
        const last = ctx.getImageData(0, image.height - 1, image.width, 1).data
        expect([...last].every((v) => v === 255)).toBe(true)
        const reduced = createCanvas(Math.floor(image.width * 0.8), Math.floor(image.height * 0.8))
        reduced.getContext('2d').drawImage(image, 0, 0, reduced.width, reduced.height)
        expect(matchesGroupedTableCropPng(grouped[0], await reduced.encode('png'))).toBe(false)
        const wrong = [
          members[0],
          { ...members[1], notes: [{ ...members[1].notes[0], text: 'Different note' }] }
        ]
        expect(groupTableParts(wrong, native, tokens, context)).toHaveLength(2)
      }
      expect(JSON.stringify(members)).toBe(before)
    } finally {
      await task.destroy()
    }
  }
})
it('groups consecutive labelled parts under one caption without flattening their columns', () => {
  const groups = groupTableParts(parts, page)
  expect(groups).toHaveLength(1)
  expect(groups[0].parts.map((p: { title: string }) => p.title)).toEqual([
    'A. Tricco data',
    'B. Dewa data'
  ])
  expect(groups[0].parts.map((p: { grid: string[][] }) => p.grid[0].length)).toEqual([5, 7])
  expect(groups[0].parts.map((p: { cropRects: number[][] }) => p.cropRects)).toEqual(
    parts.map((part) => [part.cropRect])
  )
  expect(groups[0].notes).toEqual(parts[1].notes)
  expect(groups[0].parts.every((p: { notes: unknown[] }) => !p.notes.length)).toBe(true)
  expect(groups[0].cropRect).toEqual([0, 0, 300, 322.5])
  expect(groups[0].captionIssue).toBeUndefined()
})
it('groups consecutive parenthesized parts without borrowing a different heading convention', () => {
  const first = line('(a) Error rates', 15),
    second = line('(b) Power', 110)
  const origins = [{ pageNumber: 1, index: 7, text: 'x' }]
  const [joined] = groupTableParts(
    [{ ...parts[0], unreliableMathSourceItems: origins }, parts[1]],
    { lines: [page.lines[0], first, second] }
  )
  expect(joined.parts[0].unreliableMathSourceItems).toEqual(origins)
  expect(joined.parts[1].unreliableMathSourceItems).toBeUndefined()
  expect(joined.parts.map((part: { title: string }) => part.title)).toEqual([
    first.text,
    second.text
  ])
  expect(joined.parts.map((part: { grid: string[][] }) => part.grid[0].length)).toEqual([5, 7])
  expect(joined.parts.map((part: { cropRects: number[][] }) => part.cropRects)).toEqual(
    parts.map((part) => [part.cropRect])
  )
  expect(groupTableParts(parts, { lines: [page.lines[0], first, page.lines[2]] })).toHaveLength(2)
  expect(
    groupTableParts(parts, { lines: [page.lines[0], first, line('(c) Power', 110)] })
  ).toHaveLength(2)
})
it('keeps independent, unlabelled, interrupted and nonconsecutive tables separate', () => {
  expect(groupTableParts([{ ...parts[0], caption: undefined }, parts[1]], page)).toHaveLength(2)
  expect(
    groupTableParts(
      [parts[0], { ...parts[1], caption: { text: 'Table 2.', rect: [0, 110, 200, 120] } }],
      page
    )
  ).toHaveLength(2)
  for (const lines of [
    page.lines.slice(0, 2),
    [...page.lines.slice(0, 2), line('C. Other data', 110)],
    [...page.lines, line('Discussion of unrelated results.', 101)]
  ]) {
    expect(groupTableParts(parts, { lines })).toHaveLength(2)
  }
  expect(groupTableParts([{ ...parts[0], notes: parts[1].notes }, parts[1]], page)).toHaveLength(2)
})

it('joins explicitly marked same-page column continuations and keeps their caption and notes', () => {
  const header = ['Variable', 'Group A', 'Group B']
  const first = {
    ...table('left', 10, 100, 3),
    grid: [header, ['Age', '60', '61']],
    cells: [{ row: 1, column: 0, text: 'Age' }]
  }
  const next = {
    ...table('right', 10, 50, 3),
    cropRect: [315, 15, 615, 75],
    caption: { text: 'Table 1: Baseline characteristics.', rect: [210, 50, 410, 60] },
    grid: [header, ['(Continued from previous column)', '', ''], ['R0', '48', '43']],
    cells: [
      { row: 0, column: 0, text: 'Variable' },
      { row: 2, column: 0, text: 'R0' }
    ],
    notes: [{ text: 'Abbreviations: R0 = complete resection.', rect: [210, 60, 410, 70] }]
  }
  const page = { lines: [line('(Table 1 continued on next column)', 90)] }
  const [joined] = groupTableParts([next, first], page)
  expect(groupTableParts([next, first], page)).toHaveLength(1)
  expect(joined.grid).toEqual([header, ['Age', '60', '61'], ['R0', '48', '43']])
  expect(joined.cells.at(-1)).toMatchObject({ row: 2, text: 'R0' })
  expect(joined.caption).toEqual(next.caption)
  expect(joined.notes).toEqual(next.notes)
  const clipped = { text: 'Variable', rect: [314, 16, 350, 28] }
  const diagnosed = groupTableParts(
    [first, { ...next, clipped: [clipped], issues: ['text-crosses-crop-boundary'] }],
    page
  )[0]
  expect(diagnosed.clipped).toEqual([clipped])
  expect(diagnosed.issues).toContain('text-crosses-crop-boundary')
  expect(groupTableParts([first, next], { lines: [] })).toHaveLength(2)
  expect(
    groupTableParts(
      [first, { ...next, caption: { ...next.caption, text: 'Table 2: Other data.' } }],
      page
    )
  ).toHaveLength(2)
  expect(
    groupTableParts(
      [first, { ...next, grid: [['Different', 'A', 'B'], ...next.grid.slice(1)] }],
      page
    )
  ).toHaveLength(2)
})

it('joins explicitly labelled column continuations in source reading order', () => {
  const first = {
    ...table('left', 70, 600, 3),
    cropRect: [20, 105, 320, 900],
    caption: { text: 'Table 1. Characteristics', rect: [15, 50, 200, 65] },
    grid: [
      ['Characteristic', 'Treatment', 'Control'],
      ['Age', '51', '52']
    ],
    cells: [{ row: 1, column: 0, rowSpan: 1, colSpan: 1, text: 'Age' }]
  }
  const next = {
    ...table('right', 62, 180, 3),
    cropRect: [340, 93, 640, 270],
    caption: { text: 'Table 1 (continued)', rect: [225, 45, 400, 60] },
    grid: [
      ['Characteristic', 'Treatment', 'Control'],
      ['Statin', '2', '0']
    ],
    cells: [{ row: 1, column: 0, rowSpan: 1, colSpan: 1, text: 'Statin' }],
    notes: [{ text: 'Data are counts.', rect: [230, 185, 410, 195] }]
  }
  const result = groupTableParts([next, first], { lines: [] })
  expect(result).toHaveLength(1)
  expect(result[0].grid).toEqual([...first.grid, next.grid[1]])
  expect(result[0].cells.at(-1)).toMatchObject({ text: 'Statin', row: 2 })
  expect(result[0].notes).toEqual(next.notes)
  expect(result[0].caption).toEqual(first.caption)
  expect(result[0].cropRects).toEqual([first.cropRect, next.cropRect])
  const headerClip = { text: 'Characteristic', rect: [338, 103, 380, 115] }
  const bodyClip = { text: 'Statin', rect: [341, 130, 370, 142] }
  const diagnosedNext = {
    ...next,
    clipped: [headerClip, bodyClip],
    issues: ['text-crosses-crop-boundary']
  }
  expect(groupTableParts([first, diagnosedNext], { lines: [] })[0].clipped).toEqual([
    headerClip,
    bodyClip
  ])
  const marker = { text: '(Continued )', x: 180, y: 606, width: 28, height: 10 }
  const withFooter = {
    ...first,
    cropRect: [20, 105, 320, 918],
    unassigned: ['(', 'Continued', ')'],
    clipped: [{ text: 'Continued', rect: [270, 909, 312, 924] }],
    issues: ['unassigned-source-text', 'text-crosses-crop-boundary']
  }
  const joined = groupTableParts([withFooter, next], { lines: [marker] })[0]
  expect(joined.unassigned).toEqual([])
  expect(joined.clipped).toEqual([])
  expect(joined.issues).toEqual([])
  expect(joined.cropRect[3]).toBeLessThan(909)
  expect(joined.cropRects[0][3]).toBeLessThan(909)
  expect(joined.grid).toEqual(result[0].grid)
  const diagnosed = groupTableParts([withFooter, diagnosedNext], { lines: [marker] })[0]
  expect(diagnosed.clipped).toEqual([headerClip, bodyClip])
  expect(diagnosed.issues).toEqual(['text-crosses-crop-boundary'])
  for (const lines of [[], [{ ...marker, y: 300 }]]) {
    expect(groupTableParts([withFooter, next], { lines })[0].unassigned).toEqual(
      withFooter.unassigned
    )
  }
  const unresolved = { ...withFooter, unassigned: [...withFooter.unassigned, 'Missing count'] }
  expect(groupTableParts([unresolved, next], { lines: [marker] })[0].unassigned).toContain(
    'Missing count'
  )
  for (const other of [
    { ...next, caption: { ...next.caption, text: 'Table 2 (continued)' } },
    { ...next, grid: [['Different', 'A', 'B'], next.grid[1]] },
    { ...next, page: 2 }
  ])
    expect(groupTableParts([other, first], { lines: [] })).toHaveLength(2)
})
