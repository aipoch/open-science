/* eslint-disable @typescript-eslint/explicit-function-return-type -- infer anonymous fixture shapes */
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { proveNativeTableCaptionOwnership } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-caption-ownership.mjs')).href
)
const { associateGraphicalTables, associateRasterTables } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

// One complete 3x2 native table, an independently sourced caption, and a
// disjoint native plate. No paper text or downloaded document is retained.
function nativeCaptionOwner(): ReturnType<typeof JSON.parse> {
  const rows: [string, number, number][] = [
    ['A', 100, 135],
    ['A', 104, 135],
    ['BB', 200, 135],
    ['CC', 100, 160],
    ['DD', 200, 160],
    ['EE', 100, 175],
    ['FF', 200, 175],
    ['Units', 145, 145],
    ['Table 1: Recorded values.', 60, 210],
    ['Values remain as shown.', 60, 222],
    ['Independent prose.', 320, 90]
  ]
  const items = rows.map(([str, x, b], index) => ({
    str,
    width: str.length * 4,
    height: 10,
    dir: 'ltr',
    fontName: 'native',
    transform: [10, 0, 0, 10, x, 800 - b],
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  const operators: { fnArray: number[]; argsArray: unknown[] } = { fnArray: [], argsArray: [] }
  const graphicsBounds: ReturnType<typeof JSON.parse>[] = []
  operators.fnArray.push(OPS.setLineWidth)
  operators.argsArray.push([0.4])
  for (const y of [120, 150, 185]) {
    const operationIndex = operators.fnArray.length
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [[0, 80, 800 - y, 1, 250, 800 - y]],
      [80, 800 - y, 250, 800 - y]
    ])
    graphicsBounds.push({
      operationIndex,
      kind: 'path',
      normalizedRect: [80 / 600, (y - 0.2) / 800, 250 / 600, (y + 0.2) / 800]
    })
  }
  for (const item of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['native', 10],
      [[1, 0, 0, 1, item.transform[4], item.transform[5]]],
      [
        Array.from(item.str, (c) => ({
          originalCharCode: c.codePointAt(0),
          unicode: c,
          fontChar: c,
          width: 400,
          isInFont: true,
          isSpace: c === ' '
        }))
      ],
      null
    )
  }
  const plate = [320, 300, 540, 500],
    operationIndex = operators.fnArray.length
  operators.fnArray.push(OPS.constructPath)
  operators.argsArray.push([
    OPS.fill,
    [[0, 320, 300, 1, 540, 300, 1, 540, 500, 1, 320, 500, 4]],
    [320, 300, 540, 500]
  ])
  graphicsBounds.push({
    operationIndex,
    kind: 'path',
    normalizedRect: plate.map((v, i) => v / (i % 2 ? 800 : 600))
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    renderRotation: 0,
    invalidGraphicsBounds: 0,
    graphicsBounds,
    lines: []
  }
  const viewport = {
    width: 600,
    height: 800,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 800]
  }
  const content = { items, styles: { native: { ascent: 0.8, descent: -0.2, vertical: false } } }
  const native = {
    pageNumber: 1,
    sourceSha256: 'a'.repeat(64),
    viewport,
    content,
    operators,
    graphicsBounds,
    glyphBounds: [
      {
        fontName: 'native',
        glyphs: [...new Set(rows.flatMap(([s]) => [...s]))].map((c) => ({
          fontChar: c,
          bounds: c === ' ' ? [0, 0, 0, 0] : [0, -0.01, 0.4, 0.7]
        }))
      }
    ]
  }
  const context = {
    sourceSha256: native.sourceSha256,
    viewport: structuredClone(viewport),
    content: structuredClone(content),
    operators: structuredClone(operators),
    nativeGlyphContext: native
  }
  const caption = {
    page: 1,
    rect: [60, 200, 280, 222],
    lines: rows.slice(8, 10).map((r) => r[0]),
    text: rows
      .slice(8, 10)
      .map((r) => r[0])
      .join(' ')
  }
  const cells = [[0, 1], [2], [3], [4], [5], [6]].map((indexes, index) => ({
    row: Math.floor(index / 2),
    column: index % 2,
    rowSpan: 1,
    colSpan: 1,
    text: indexes.map((i) => items[i].str).join(''),
    sourceItems: indexes.map((i) => items[i].sourceItem),
    sourceRects: indexes
      .map((i) => {
        const item = items[i]
        return [
          item.transform[4] * 1.5,
          1200 - item.transform[5] * 1.5 - 15,
          (item.transform[4] + item.width) * 1.5,
          1200 - item.transform[5] * 1.5
        ]
      })
      .reverse()
  }))
  const sourceViewport = { width: 900, height: 1200, scale: 1.5 }
  const owner = {
    id: 'native-table',
    page: 1,
    grid: [
      ['AA', 'BB'],
      ['CC', 'DD'],
      ['EE', 'FF']
    ],
    cells,
    unassigned: ['Units'],
    issues: ['unassigned-source-text'],
    caption,
    sourceViewport
  }
  const graphical = {
    id: 'native-plate',
    page: 1,
    grid: [],
    cells: [],
    unassigned: [],
    issues: ['no-source-cell-grid'],
    caption: structuredClone(caption),
    sourceViewport,
    region: plate.map((v, i) => v / (i % 2 ? 800 : 600)),
    thumbnail: 'thumbnails/native-plate.png'
  }
  return { graphical, scope: { page, context, tables: [owner, graphical], captions: [caption] } }
}

it('proves only the independently owned caption is removable from a disjoint native plate', () => {
  const f = nativeCaptionOwner(),
    before = JSON.stringify(f)
  const proof = proveNativeTableCaptionOwnership(f.graphical, f.scope)
  expect(proof?.caption).toBe(f.graphical.caption)
  expect(proof?.ownerId).toBe('native-table')
  expect(proof?.unassigned).toEqual(['Units'])
  expect(proof?.bodySourceCount).toBe(8)
  expect(proof?.assignedSourceCount).toBe(7)
  expect(JSON.stringify(f)).toBe(before)
})

it('binds loaded font aliases and permits independently verified renderer folding outside the closed source packets', () => {
  const f = nativeCaptionOwner(),
    c = f.scope.context
  for (const item of c.content.items) item.fontName = 'current'
  c.content.styles.current = c.content.styles.native
  delete c.content.styles.native
  for (const [i, op] of c.operators.fnArray.entries())
    if (op === OPS.setFont) c.operators.argsArray[i][0] = 'current'
  const at = c.operators.fnArray.length - 1
  c.operators.fnArray.splice(at, 1, OPS.save, OPS.transform, OPS.constructPath, OPS.restore)
  c.operators.argsArray.splice(
    at,
    1,
    null,
    [1, 0, 0, 1, 320, 300],
    [OPS.fill, [[0, 0, 0, 1, 220, 0, 1, 220, 200, 1, 0, 200, 4]], [0, 0, 220, 200]],
    null
  )
  expect(proveNativeTableCaptionOwnership(f.graphical, f.scope)?.ownerId).toBe('native-table')
})

function addLateOwnerPaint(f: ReturnType<typeof nativeCaptionOwner>, rect: number[]): void {
  const c = f.scope.context,
    n = c.nativeGlyphContext,
    index = n.operators.fnArray.length
  const path = [
    0,
    rect[0],
    800 - rect[3],
    1,
    rect[2],
    800 - rect[3],
    1,
    rect[2],
    800 - rect[1],
    1,
    rect[0],
    800 - rect[1],
    4
  ]
  for (const context of [c, n]) {
    context.operators.fnArray.push(OPS.constructPath)
    context.operators.argsArray.push([
      OPS.fill,
      [path],
      [rect[0], 800 - rect[3], rect[2], 800 - rect[1]]
    ])
  }
  f.scope.page.graphicsBounds.push({
    operationIndex: index,
    kind: 'path',
    normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
  })
}

it.each([
  'checksum',
  'literal',
  'matrix',
  'font-style',
  'prefix-matrix',
  'prefix-font',
  'prefix-glyph',
  'unknown-state',
  'missing-cell',
  'duplicate-source',
  'cell-literal',
  'cell-geometry',
  'missing-cell-rect',
  'discarded-unassigned',
  'caption-source',
  'duplicate-owner',
  'duplicate-caption',
  'same-column',
  'missing-glyph',
  'closing-rule',
  'late-body-paint',
  'late-caption-paint',
  'late-prose-paint',
  'white-paint',
  'opacity',
  'source-viewport',
  'invalid-graphics',
  'current-only-body-paint',
  'current-only-caption-paint',
  'current-only-text-matrix'
])('keeps all caption metadata without complete native ownership: %s', (fault) => {
  const f = nativeCaptionOwner(),
    c = f.scope.context,
    n = c.nativeGlyphContext,
    owner = f.scope.tables[0]
  if (fault === 'checksum') c.sourceSha256 = 'b'.repeat(64)
  if (fault === 'invalid-graphics') f.scope.page.invalidGraphicsBounds = 1
  if (fault === 'current-only-body-paint' || fault === 'current-only-caption-paint') {
    const r = fault === 'current-only-body-paint' ? [100, 130, 108, 134] : [68, 204, 80, 209]
    c.operators.argsArray[c.operators.fnArray.length - 1] = [
      OPS.fill,
      [[0, r[0], 800 - r[3], 1, r[2], 800 - r[3], 1, r[2], 800 - r[1], 1, r[0], 800 - r[1], 4]],
      [r[0], 800 - r[3], r[2], 800 - r[1]]
    ]
  }
  if (fault === 'current-only-text-matrix') {
    const i = c.operators.fnArray.lastIndexOf(OPS.setTextMatrix)
    c.operators.argsArray[i][0][4] = 100
    c.operators.argsArray[i][0][5] = 670
  }
  if (fault === 'literal') c.content.items[0].str += 'x'
  if (fault === 'matrix') c.content.items[0].transform[4] += 0.01
  if (fault === 'font-style') c.content.styles.native.ascent += 0.01
  if (fault === 'prefix-matrix')
    c.operators.argsArray[c.operators.fnArray.indexOf(OPS.setTextMatrix)][0][4] += 0.01
  if (fault === 'prefix-font')
    c.operators.argsArray[c.operators.fnArray.indexOf(OPS.setFont)][0] = 'unknown-font'
  if (fault === 'prefix-glyph')
    c.operators.argsArray[c.operators.fnArray.indexOf(OPS.showText)][0][0].unicode += 'x'
  if (fault === 'unknown-state') c.operators.fnArray[0] = 999999
  if (fault === 'missing-cell') owner.cells.pop()
  if (fault === 'duplicate-source')
    owner.cells[1].sourceItems.push(structuredClone(owner.cells[0].sourceItems[0]))
  if (fault === 'cell-literal') owner.cells[0].sourceItems[0].text += 'x'
  if (fault === 'cell-geometry') owner.cells[0].sourceRects[0][0] += 0.001
  if (fault === 'missing-cell-rect') owner.cells[0].sourceRects.pop()
  if (fault === 'discarded-unassigned') owner.unassigned = []
  if (fault === 'caption-source') n.content.items[8].str += 'x'
  if (fault === 'duplicate-owner')
    f.scope.tables.push({ ...structuredClone(owner), id: 'other-table' })
  if (fault === 'duplicate-caption') f.scope.captions.push(structuredClone(f.graphical.caption))
  if (fault === 'same-column') f.graphical.region = [100 / 600, 300 / 800, 240 / 600, 500 / 800]
  if (fault === 'missing-glyph') n.glyphBounds = []
  if (fault === 'closing-rule')
    for (const context of [c, n]) {
      context.operators.fnArray[3] = OPS.endPath
      context.operators.argsArray[3] = []
    }
  if (fault === 'late-body-paint') addLateOwnerPaint(f, [100, 130, 108, 134])
  if (fault === 'late-caption-paint') addLateOwnerPaint(f, [68, 204, 80, 209])
  if (fault === 'late-prose-paint') addLateOwnerPaint(f, [325, 85, 335, 89])
  if (fault === 'source-viewport') owner.sourceViewport.width += 1
  if (fault === 'white-paint' || fault === 'opacity') {
    for (const context of [c, n]) {
      context.operators.fnArray.unshift(
        fault === 'white-paint' ? OPS.setFillRGBColor : OPS.setGState
      )
      context.operators.argsArray.unshift(fault === 'white-paint' ? ['#ffffff'] : [[['ca', 0.5]]])
    }
    for (const g of f.scope.page.graphicsBounds) g.operationIndex++
  }
  const before = JSON.stringify(f)
  expect(proveNativeTableCaptionOwnership(f.graphical, f.scope)).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
const fixture = () => {
  const captions = [
    {
      page: 1,
      rect: [70, 225, 520, 237],
      lines: ['Table 1. Summary of independent measurements.']
    },
    { page: 1, rect: [70, 430, 520, 442], lines: ['Table 2. Results for the complete comparison.'] }
  ]
  const image = (rect: number[]) => ({
    kind: 'image',
    normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600)),
    paintedNormalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600)),
    imageHash: 'anonymous-image'
  })
  const previous = {
    pageNumber: 1,
    width: 600,
    height: 800,
    rotation: 0,
    renderRotation: 0,
    invalidGraphicsBounds: 0,
    lines: captions.map((c) => ({
      text: c.lines[0],
      x: c.rect[0],
      y: c.rect[1],
      width: c.rect[2] - c.rect[0],
      height: 12,
      fontSize: 12
    })),
    graphicsBounds: [image([70, 250, 400, 400])]
  }
  const page = {
    ...previous,
    pageNumber: 2,
    lines: [] as typeof previous.lines,
    graphicsBounds: [image([70, 70, 530, 190])]
  }
  const detections = [
    {
      readingRotation: 0,
      detection: { score: 0.999 },
      cropRect: [105, 105, 795, 285],
      structure: {
        objects: [
          { label: 'table', score: 0.999 },
          ...Array.from({ length: 2 }, () => ({ label: 'table row', score: 0.99 })),
          ...Array.from({ length: 2 }, () => ({ label: 'table column', score: 0.99 }))
        ]
      }
    }
  ]
  return { page, previous, captions, detections, pages: [previous, page] }
}
it('gives one graphical image its independently selected complete caption', () => {
  const f = fixture(),
    all = associateGraphicalTables(f.previous, f.captions)
  expect(all).toHaveLength(1)
  expect(all[0].caption).toEqual(f.captions[0])
  expect(associateGraphicalTables(f.previous, [f.captions[0]])).toEqual(all)
})
it('recovers only a sequential terminal caption on an otherwise empty raster page', () => {
  const f = fixture()
  expect(associateRasterTables(f.page, f.detections)).toEqual([])
  const result = associateRasterTables(f.page, f.detections, [], f)
  expect(result).toEqual([{ rect: [70, 70, 530, 190], graphicsCount: 1, caption: f.captions[1] }])
  expect(result[0].cells).toBeUndefined()
  expect(result[0].nativeBody).toBeUndefined()
})
it.each([
  'unowned-previous',
  'nonsequential',
  'incomplete',
  'unmatched-native',
  'following-text',
  'following-paint',
  'current-text',
  'extra-image',
  'scan',
  'low-image',
  'weak-model',
  'one-column',
  'one-row',
  'occupied'
])('does not transfer a caption with %s', (fault) => {
  const f = fixture()
  let occupied: number[][] = []
  if (fault === 'unowned-previous') f.previous.graphicsBounds = []
  if (fault === 'nonsequential') {
    f.captions[1].lines[0] = f.captions[1].lines[0].replace('2.', '4.')
    f.previous.lines[1].text = f.captions[1].lines[0]
  }
  if (fault === 'incomplete') {
    f.captions[1].lines[0] = f.captions[1].lines[0].slice(0, -1)
    f.previous.lines[1].text = f.captions[1].lines[0]
  }
  if (fault === 'unmatched-native') f.previous.lines[1].text += ' Omitted explanation.'
  if (fault === 'following-text')
    f.previous.lines.push({
      ...f.previous.lines[1],
      y: 480,
      text: 'Independent ordinary prose follows here.'
    })
  if (fault === 'following-paint')
    f.previous.graphicsBounds.push({
      ...f.previous.graphicsBounds[0],
      normalizedRect: [0.2, 0.7, 0.3, 0.8],
      paintedNormalizedRect: [0.2, 0.7, 0.3, 0.8]
    })
  if (fault === 'current-text')
    f.page.lines.push({
      ...f.previous.lines[1],
      y: 400,
      text: 'Independent text outside the image.'
    })
  if (fault === 'extra-image')
    f.page.graphicsBounds.push({
      ...f.page.graphicsBounds[0],
      normalizedRect: [0.2, 0.7, 0.3, 0.8]
    })
  if (fault === 'scan') f.page.graphicsBounds[0].normalizedRect = [0, 0, 1, 1]
  if (fault === 'low-image') {
    f.page.graphicsBounds[0].normalizedRect = [70 / 600, 0.4, 530 / 600, 0.55]
    f.detections[0].cropRect = [105, 480, 795, 660]
  }
  if (fault === 'weak-model') f.detections[0].detection.score = 0.98
  if (fault === 'one-column') f.detections[0].structure.objects.splice(-1, 1)
  if (fault === 'one-row') f.detections[0].structure.objects.splice(1, 1)
  if (fault === 'occupied') occupied = [[70, 70, 530, 190]]
  expect(associateRasterTables(f.page, f.detections, occupied, f)).toEqual([])
})

it('keeps one image without guessing between equally supported captions', () => {
  const f = fixture()
  f.captions[1].rect = [70, 413, 520, 425]
  f.previous.lines[1].y = 413
  const result = associateGraphicalTables(f.previous, f.captions)
  expect(result).toHaveLength(1)
  expect(result[0].caption).toBeUndefined()
  expect(result[0].rect).toEqual([70, 250, 400, 400])
})
