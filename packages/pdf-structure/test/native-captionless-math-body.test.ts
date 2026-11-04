import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
const { anonymousCaptionlessMathBody: fixture } = await import(
  pathToFileURL(resolve('test/fixtures/native-captionless-math-body.mjs')).href
)
const { retainCaptionlessMathTableBody: retain } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-captionless-math-body.mjs')).href
)

it('retains a closed symbolic table without inventing cells or changing its original PNG', async () => {
  const f = fixture(),
    before = JSON.stringify(f.table),
    out = await retain(f.table, f.options, () => Promise.resolve(f.png))
  assert(out.nativeBody)
  assert.equal(out.nativeBody.kind, 'math-table')
  assert.equal(out.nativeBody.boundary.kind, 'three-rail')
  assert.equal(out.nativeBody.boundary.raster.width, 648)
  assert.equal(out.nativeBody.boundary.raster.height, 288)
  assert.equal(out.grid, f.table.grid)
  assert.equal(out.cells, f.table.cells)
  assert.equal(out.region, f.table.region)
  assert.equal(out.thumbnail, f.table.thumbnail)
  assert.equal(out.reviewCandidate, false)
  assert(out.issues.includes('native-table-structure-ambiguous'))
  assert.equal(JSON.stringify(f.table), before)
  assert.equal(await retain(out, f.options, () => Promise.resolve(f.png)), out)
})

it.each([
  [
    'caption',
    (f: ReturnType<typeof fixture>) => Object.assign(f.table, { caption: { text: 'Table 1' } })
  ],
  [
    'admitted mapping',
    (f: ReturnType<typeof fixture>) => {
      f.table.reviewCandidate = true
      f.table.issues = []
    }
  ],
  [
    'ordinary text only',
    (f: ReturnType<typeof fixture>) => f.table.cells.forEach((c) => delete c.textRuns)
  ],
  ['missing source', (f: ReturnType<typeof fixture>) => f.table.cells[0].sourceItems.pop()],
  [
    'foreign literal',
    (f: ReturnType<typeof fixture>) =>
      (f.table.cells[0].sourceItems[0] = { pageNumber: 1, index: 0, text: 'Q' })
  ],
  [
    'missing native font',
    (f: ReturnType<typeof fixture>) => {
      f.options.nativeContext.glyphBounds = []
    }
  ],
  [
    'invalid native width',
    (f: ReturnType<typeof fixture>) => {
      f.options.nativeContext.content.items[0].width = 0
    }
  ],
  [
    'extra note',
    (f: ReturnType<typeof fixture>) => f.table.notes.push({ text: 'Independent note' })
  ],
  [
    'competing region',
    (f: ReturnType<typeof fixture>) => f.options.competingRects.push([100, 70, 120, 100])
  ],
  [
    'foreign caption',
    (f: ReturnType<typeof fixture>) => f.options.captionRects.push([100, 70, 120, 100])
  ],
  [
    'wrong PNG',
    (f: ReturnType<typeof fixture>) => {
      f.png = Buffer.from('wrong')
    }
  ]
])('retains the existing refusal with %s', async (_name, mutate) => {
  const f = fixture()
  mutate(f)
  assert.equal(await retain(f.table, f.options, () => Promise.resolve(f.png)), f.table)
})

it('rejects a source mutation while the actual PNG is loading', async () => {
  const f = fixture()
  assert.equal(
    await retain(f.table, f.options, async () => {
      f.options.tokens[0].text = 'Q'
      return f.png
    }),
    f.table
  )
})

it.each([
  'missing rail',
  'translucent rail',
  'round cap',
  'dashed rail',
  'foreign whitespace',
  'foreign empty Unicode'
])('rejects incomplete paint or unowned glyph ink: %s', async (name) => {
  const f = fixture(),
    o = f.options.nativeContext.operators,
    lastRail = o.fnArray.lastIndexOf(OPS.constructPath)
  if (name === 'missing rail') o.argsArray[lastRail][0] = OPS.endPath
  else if (name === 'translucent rail') {
    o.fnArray.splice(lastRail, 0, OPS.setGState)
    o.argsArray.splice(lastRail, 0, [[['CA', 0.5]]])
  } else if (name === 'round cap') {
    o.fnArray.splice(lastRail, 0, OPS.setLineCap)
    o.argsArray.splice(lastRail, 0, [1])
  } else if (name === 'dashed rail') {
    o.fnArray.splice(lastRail, 0, OPS.setDash)
    o.argsArray.splice(lastRail, 0, [[1, 1], 0])
  } else {
    const show = o.fnArray.lastIndexOf(OPS.showText),
      raw = f.options.nativeContext.content.items.at(-1),
      value = name === 'foreign whitespace' ? ' ' : ''
    raw.str = value
    raw.sourceItem.text = value
    raw.transform[4] = 60
    raw.transform[5] = 145
    o.argsArray[show - 1][0][4] = 60
    o.argsArray[show - 1][0][5] = 145
    o.argsArray[show][0][0].unicode = value
    if (value === ' ') o.argsArray[show][0][0].isSpace = true
    f.options.tokens.pop()
  }
  assert.equal(await retain(f.table, f.options, () => Promise.resolve(f.png)), f.table)
})

it('rejects an actual PNG with an erased glyph while all rails remain', async () => {
  const f = fixture(),
    image = await loadImage(f.png),
    canvas = createCanvas(image.width, image.height),
    ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  ctx.fillStyle = 'white'
  ctx.fillRect(60, 28, 28, 36)
  const png = canvas.toBuffer('image/png')
  canvas.width = canvas.height = 1
  assert.equal(await retain(f.table, f.options, () => Promise.resolve(png)), f.table)
})

it('keeps multiple canonical characters of one whole source record', async () => {
  const f = fixture(),
    o = f.options.nativeContext.operators,
    show = o.fnArray.indexOf(OPS.showText),
    raw = f.options.nativeContext.content.items[0]
  raw.str = 'e\u0301'
  raw.sourceItem.text = raw.str
  f.options.tokens[0].text = raw.str
  f.table.cells[0].text = raw.str
  o.argsArray[show][0][0].unicode = raw.str
  o.argsArray[show][0][0].fontChar = 'é'
  f.options.nativeContext.glyphBounds[0].glyphs.find((g) => g.fontChar === 'H').fontChar = 'é'
  assert((await retain(f.table, f.options, () => Promise.resolve(f.png))).nativeBody)
})

it('rejects two different whole source records sharing one physical glyph', async () => {
  const f = fixture(),
    o = f.options.nativeContext.operators,
    shows = o.fnArray.flatMap((op: number, i: number) => (op === OPS.showText ? [i] : [])),
    raw = f.options.nativeContext.content.items,
    a = raw[0],
    b = raw[1],
    glyph = o.argsArray[shows[0]][0][0]
  glyph.unicode = 'HJ'
  glyph.fontChar = '!'
  o.argsArray[shows[1]] = [[]]
  f.options.nativeContext.glyphBounds[0].glyphs.push({ fontChar: '!', bounds: [0, -0.1, 0.5, 0.7] })
  b.transform = [...a.transform]
  b.width = a.width
  f.options.tokens[1].rect = [...f.options.tokens[0].rect]
  f.options.tokens[1].baseline = f.options.tokens[0].baseline
  f.table.cells[1].sourceRects = [[...f.table.cells[0].sourceRects[0]]]
  assert.equal(await retain(f.table, f.options, () => Promise.resolve(f.png)), f.table)
})

it('declines a correctly rendered crop that cuts part of a retained rail stroke', async () => {
  const f = fixture(),
    page = f.options.page,
    crop = [19, 39.9, 181, 111],
    scale = f.table.sourceViewport.scale,
    { getInitialPdfCropRaster, matchesInitialPdfCropPng } = await import(
      pathToFileURL(resolve('resources/literature-pdf-crop.mjs')).href
    ),
    raster = getInitialPdfCropRaster(crop, page)
  assert(raster)
  f.table.cropRect = crop.map((x) => x * scale)
  f.table.region = crop.map((x, i) => x / (i % 2 ? page.height : page.width))
  const canvas = createCanvas(raster.pixelWidth, raster.pixelHeight),
    paint = canvas.getContext('2d')
  paint.fillStyle = 'white'
  paint.fillRect(0, 0, canvas.width, canvas.height)
  paint.scale(raster.scale, raster.scale)
  paint.translate(-crop[0], -crop[1])
  paint.strokeStyle = 'black'
  paint.lineWidth = 0.6
  for (const y of [40, 60, 110]) {
    paint.beginPath()
    paint.moveTo(20, y)
    paint.lineTo(180, y)
    paint.stroke()
  }
  paint.fillStyle = 'black'
  const claimed = new Set(
    f.table.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems)
      .map((o: ReturnType<typeof JSON.parse>) => o.index)
  )
  for (const item of f.options.nativeContext.content.items.filter(
    (i: ReturnType<typeof JSON.parse>) => claimed.has(i.sourceItem.index)
  )) {
    const [size, , , , x, y] = item.transform
    paint.fillRect(x, page.height - y - size * 0.7, size * 0.5, size * 0.8)
  }
  const png = canvas.toBuffer('image/png')
  canvas.width = canvas.height = 1
  assert(matchesInitialPdfCropPng(png, raster))
  const out = await retain(f.table, f.options, () => Promise.resolve(png))
  // The old positive helper reaches the real strict boundary failure; the PNG
  // already matches the new crop's exact dimensions and original paint program.
  if (out.nativeBody) {
    const { parsePdfStructureResult } = await import('../src/result.js'),
      ambiguity = { code: 'native-table-structure-ambiguous', detail: 'Unreliable structure' },
      identity = {
        extractionId: 'anonymous-body',
        engineFingerprint: 'b'.repeat(64),
        sourceChecksum: f.options.nativeContext.sourceSha256,
        sourceSizeBytes: 100,
        requestedPages: [1]
      },
      region = {
        page: 1,
        x: f.table.region[0],
        y: f.table.region[1],
        width: f.table.region[2] - f.table.region[0],
        height: f.table.region[3] - f.table.region[1]
      },
      value = {
        schemaVersion: 1,
        ...identity,
        pageCount: 1,
        processedPages: [1],
        pages: [{ page: 1, width: page.width, height: page.height, rotation: 0 }],
        elements: [
          {
            id: f.table.id,
            kind: 'table',
            regions: [region],
            thumbnailId: f.table.id,
            nativeBody: out.nativeBody,
            issues: [ambiguity],
            table: {
              rowCount: f.table.grid.length,
              columnCount: f.table.grid[0].length,
              cells: f.table.cells.map((c: ReturnType<typeof JSON.parse>) => ({
                row: c.row,
                column: c.column,
                rowSpan: c.rowSpan,
                columnSpan: c.colSpan,
                text: c.text,
                ...(c.textRuns ? { textRuns: c.textRuns } : {}),
                sourceItems: c.sourceItems,
                regions: c.sourceRects.map((r: ReturnType<typeof JSON.parse>) => ({
                  page: 1,
                  x: r[0] / f.table.sourceViewport.width,
                  y: r[1] / f.table.sourceViewport.height,
                  width: (r[2] - r[0]) / f.table.sourceViewport.width,
                  height: (r[3] - r[1]) / f.table.sourceViewport.height
                }))
              })),
              unassignedText: [],
              issues: [ambiguity]
            }
          }
        ],
        thumbnails: [
          {
            id: f.table.id,
            mimeType: 'image/png',
            sizeBytes: png.byteLength,
            ...out.nativeBody.boundary.raster
          }
        ],
        navigation: [],
        issues: []
      }
    assert.throws(
      () => parsePdfStructureResult(JSON.parse(JSON.stringify(value)), identity),
      /Bounded mathematical body does not match its native page and PNG inventory\./u
    )
  }
  assert.equal(out, f.table)
  assert.equal(out.nativeBody, undefined)
})
