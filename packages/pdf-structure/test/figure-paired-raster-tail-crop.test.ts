import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { resolve } from './paths'
const {
  nativePairedRasterTailCrop,
  nativePairedRasterTailCropRect,
  nativePairedRasterTailPngSafe
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-paired-raster-tail.mjs')).href
)
const { nativeCompleteFormCropPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-complete-form.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { nativeClosedProgramInkPacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture(unequalColumn = false, shortParagraphs = false, stackedPanels = false) {
  const width = 600,
    height = 400,
    operators = { fnArray: [] as number[], argsArray: [] as unknown[] },
    graphicsBounds = [] as object[],
    items = [] as ReturnType<typeof JSON.parse>[],
    glyphs = [] as object[],
    tokens = [] as object[],
    lines = [] as object[],
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    add = (op: number, args: unknown): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    text = (str: string, x: number, baseline: number): void => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 10])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
      add(OPS.showText, [
        [{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
      add(OPS.endText, null)
      const raw = {
        str,
        dir: 'ltr',
        width: str.length * 5,
        height: 10,
        transform: [10, 0, 0, 10, x, height - baseline],
        fontName: 'F',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(raw)
      if (!glyphs.some((g) => (g as { fontChar: string }).fontChar === str))
        glyphs.push({ fontChar: str, bounds: [0, -0.2, str.length * 0.5, 0.7] })
      tokens.push(tableTextToken(raw, viewport, 0))
      lines.push({ text: str, x, y: baseline - 10, width: raw.width, height: 10, fontSize: 10 })
    },
    image = (left: number, imageHeight = 100, bottom = 150): void => {
      add(OPS.save, null)
      add(OPS.transform, [160, 0, 0, imageHeight, left, height - bottom])
      const operationIndex = operators.fnArray.length
      add(OPS.paintImageXObject, ['image-' + operationIndex, 640, 400])
      graphicsBounds.push({
        operationIndex,
        kind: 'image',
        normalizedRect: [
          left / width,
          (bottom - imageHeight) / height,
          (left + 160) / width,
          bottom / height
        ],
        ...(stackedPanels ? { imageHash: 'a'.repeat(64) } : {}),
        paintedNormalizedRect: [(left + 2) / width, 52 / height, (left + 158) / width, 148 / height]
      })
      add(OPS.restore, null)
    }
  if (stackedPanels) {
    image(50, 130, 150)
    text('Panel A.', 70, 163)
    text('Original first panel.', 112, 163)
    image(50, 130, 300)
    text('Panel B.', 70, 313)
    text('Original second panel.', 112, 313)
  }
  for (const [n, left] of (stackedPanels ? [] : [50, 285]).entries()) {
    image(left, shortParagraphs && n === 1 ? 95 : 100)
    if (shortParagraphs) {
      text(
        n === 0 ? '(a) One complete diagram caption.' : '(b) One complete diagram with the',
        left,
        163
      )
      if (n === 1) text('continuation.', left, 175)
      continue
    }
    text(
      '(' +
        String.fromCharCode(97 + n) +
        ') Independent complete column label tex' +
        (n === 1 && unequalColumn ? '' : 't'),
      left,
      163
    )
    text('continued description on one native line.', left, 175)
  }
  const title = 'Figure 1. Complete independent diagram panels.',
    caption = {
      page: 1,
      lines: [title],
      rect: stackedPanels ? [40, 314, 40 + title.length * 5, 324] : [160, 190, 390, 200]
    }
  text(title, stackedPanels ? 40 : 160, stackedPanels ? 324 : 200)
  const figure = {
      rect: stackedPanels ? [52, 202, 208, 298] : [50, 52, 500, 163],
      caption,
      graphicsCount: 2,
      ...(shortParagraphs ? { reason: 'no-unambiguous-adjacent-graphics' } : {})
    },
    page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      invalidGraphicsBounds: 0,
      lines,
      graphicsBounds
    },
    context = {
      ...(stackedPanels ? { pageNumber: 1, sourceSha256: 'a'.repeat(64) } : {}),
      operators,
      viewport,
      content: { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }],
      graphicsBounds
    }
  return { page, figure, captions: [caption], tables: [] as number[][], tokens, context, text }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const prove = (f: ReturnType<typeof fixture>) =>
  nativePairedRasterTailCrop(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)
it('preserves complete stacked panel sources with a private fixed crop beside a close caption', () => {
  const f = fixture(false, false, true),
    before = JSON.stringify(f),
    proof = prove(f),
    candidate = { ...f.figure, ...proof, fallbackFigure: f.figure },
    crop = nativePairedRasterTailCropRect(candidate, f.page)
  expect(proof?.rect).toEqual([50, 20, 222, 315])
  expect(crop).toEqual([49.5, 19.5, 222.5, 315.5])
  expect(candidate.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const png = (scale: number): Buffer =>
    createCanvas(
      Math.ceil((crop[2] - crop[0]) * scale),
      Math.ceil((crop[3] - crop[1]) * scale)
    ).toBuffer('image/png')
  expect(nativePairedRasterTailPngSafe(png(4), crop, f.page, candidate)).toBe(true)
  expect(nativePairedRasterTailPngSafe(png(0.5), crop, f.page, candidate)).toBe(false)
  expect(nativePairedRasterTailCropRect(structuredClone(candidate), f.page)).toBeUndefined()
  expect(nativePairedRasterTailCropRect(candidate, { ...f.page })).toBeUndefined()
  expect(
    nativePairedRasterTailPngSafe(
      png(4),
      crop.map((x: number) => x + 0.01),
      f.page,
      candidate
    )
  ).toBe(false)
})
it.each(['font', 'source', 'image', 'table', 'foreign-ink', 'opacity', 'caption'])(
  'declines incomplete stacked panel evidence: %s',
  (mode) => {
    const f = fixture(false, false, true)
    if (mode === 'font') delete (f.context.content.styles.F as { descent?: number }).descent
    if (mode === 'source') f.context.content.items[1].sourceItem.text += ' absent'
    if (mode === 'image') delete (f.page.graphicsBounds[0] as { imageHash?: string }).imageHash
    if (mode === 'table') f.tables.push([60, 250, 100, 290])
    if (mode === 'foreign-ink') f.text('Other material.', 80, 314)
    if (mode === 'caption') f.captions.push({ ...f.captions[0] })
    if (mode === 'opacity') {
      f.context.operators.fnArray.unshift(OPS.setGState)
      f.context.operators.argsArray.unshift([[['ca', 0]]])
    }
    expect(prove(f)).toBeUndefined()
  }
)
it.each(['native-bytes', 'reference', 'foreign-prefix', 'source-owner', 'output'])(
  'rechecks retained stacked panel inputs and native foreign paint at the actual PNG: %s',
  (mode) => {
    const f = fixture(false, false, true),
      proof = prove(f),
      candidate = { ...f.figure, ...proof, fallbackFigure: f.figure },
      crop = nativePairedRasterTailCropRect(candidate, f.page),
      png = createCanvas(
        Math.ceil((crop[2] - crop[0]) * 4),
        Math.ceil((crop[3] - crop[1]) * 4)
      ).toBuffer('image/png')
    expect(nativePairedRasterTailPngSafe(png, crop, f.page, candidate)).toBe(true)
    if (mode === 'native-bytes')
      (f.context.glyphBounds[0].glyphs[0] as { bounds: number[] }).bounds[0] += 0.01
    if (mode === 'reference') f.context.content = { ...f.context.content }
    if (mode === 'foreign-prefix')
      candidate.formCropRaster = { ...candidate.formCropRaster, foreignPaints: [] }
    if (mode === 'source-owner')
      candidate.sourceItems = [{ pageNumber: 1, index: 0, text: 'Panel A.' }]
    if (mode === 'output') proof.rect[0] -= 1
    expect(nativePairedRasterTailPngSafe(png, crop, f.page, candidate)).toBe(false)
  }
)
it('restores complete paired native text columns beyond the image margin without adding owners', () => {
  const f = fixture(),
    before = JSON.stringify(f),
    proof = prove(f)
  expect(proof?.rect).toEqual([50, 52, 500, 177])
  expect(proof?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it('refuses additional native lines and a competing parent', () => {
  const third = fixture()
  third.text('another unresolved continuation', 50, 187)
  expect(prove(third)).toBeUndefined()
  const competitor = fixture()
  competitor.text('(a) Other independently printed label', 50, 163)
  expect(prove(competitor)).toBeUndefined()
})
it('refuses missing font or source evidence and unequal independent text columns', () => {
  const font = fixture()
  delete (font.context.content.styles.F as { descent?: number }).descent
  expect(prove(font)).toBeUndefined()
  const source = fixture()
  source.context.content.items[1].sourceItem.text += ' absent'
  expect(prove(source)).toBeUndefined()
  const width = fixture(true)
  expect(prove(width)).toBeUndefined()
})
it('refuses invisible source text and foreign paint crossing a completed tail', () => {
  const hidden = fixture(),
    o = hidden.context.operators,
    i = o.fnArray.indexOf(OPS.beginText)
  o.fnArray.splice(i, 0, OPS.setGState)
  o.argsArray.splice(i, 0, [[['ca', 0]]])
  expect(prove(hidden)).toBeUndefined()
  const foreign = fixture()
  foreign.context.operators.fnArray.push(OPS.constructPath)
  foreign.context.operators.argsArray.push([
    OPS.fill,
    [new Float32Array([0, 80, 225, 1, 100, 225, 1, 100, 229, 1, 80, 229, 4])],
    [80, 225, 100, 229]
  ])
  expect(prove(foreign)).toBeUndefined()
})
it('checks the fixed actual PNG certificate and refuses unsafe low scale', () => {
  const f = fixture(),
    proof = prove(f)
  expect(proof).toBeDefined()
  const rect = proof.rect.map((n: number, i: number) => n + (i < 2 ? -4 / 3 : 4 / 3)),
    png = (scale: number): Buffer =>
      createCanvas(
        Math.ceil((rect[2] - rect[0]) * scale),
        Math.ceil((rect[3] - rect[1]) * scale)
      ).toBuffer('image/png')
  expect(nativeCompleteFormCropPngSafe(png(3), rect, f.page, proof)).toBe(true)
  expect(nativeCompleteFormCropPngSafe(png(0.25), rect, f.page, proof)).toBe(false)
})

// One complete left sentence and a right sentence with one final native word.
// Different raster heights share their original baseline; no new text owners.
it('restores complete short ordered panel sentences after unequal-height native rasters', () => {
  const f = fixture(false, true),
    before = JSON.stringify(f),
    proof = prove(f)
  expect(proof?.rect).toEqual([50, 50, 450, 177])
  expect(proof?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it('refuses a second caption and an unrelated reason for short panel sentences', () => {
  const duplicate = fixture(false, true)
  duplicate.captions.push({ ...duplicate.captions[0] })
  expect(prove(duplicate)).toBeUndefined()
  const unrelated = fixture(false, true)
  unrelated.figure.reason = 'native-raster-vector-strip'
  expect(prove(unrelated)).toBeUndefined()
})
it('keeps foreign native outlines outside a short panel crop even when their advances are outside', () => {
  const f = fixture(false, true)
  f.text('Foreign material below the main caption.', 80, 260)
  expect(prove(f)).toBeDefined()
  const foreign = f.context.glyphBounds[0].glyphs.at(-1) as { bounds: number[] }
  foreign.bounds[3] = 15
  expect(f.tokens.at(-1)?.rect[1]).toBeGreaterThan(200)
  expect(
    nativeClosedProgramInkPacket(
      f.page,
      f.tokens,
      f.context,
      f.context.content.items.slice(0, 4).map((r) => r.sourceItem)
    )
  ).toBeDefined()
  expect(prove(f)).toBeUndefined()
})
it('refuses invisible short subcaptions and foreign tables without relaxing page packets', () => {
  for (const mode of ['alpha', 'white', 'render', 'mask'] as const) {
    const f = fixture(false, true),
      o = f.context.operators,
      starts = o.fnArray.flatMap((op, i) => (op === OPS.beginText ? [i] : [])),
      i = starts[2]
    o.fnArray.splice(
      i,
      0,
      mode === 'white'
        ? OPS.setFillRGBColor
        : mode === 'render'
          ? OPS.setTextRenderingMode
          : OPS.setGState
    )
    o.argsArray.splice(
      i,
      0,
      mode === 'white'
        ? ['#ffffff']
        : mode === 'render'
          ? [3]
          : [[[mode === 'alpha' ? 'ca' : 'SMask', mode === 'alpha' ? 0 : true]]]
    )
    expect(prove(f), mode).toBeUndefined()
  }
  const table = fixture(false, true)
  table.tables.push([60, 160, 100, 170])
  expect(prove(table)).toBeUndefined()
})
it('checks the actual short panel PNG footprint and rejects a larger foreign footprint', () => {
  const f = fixture(false, true),
    proof = prove(f)
  expect(proof).toBeDefined()
  const rect = proof.rect.map((n: number, i: number) => n + (i < 2 ? -4 / 3 : 4 / 3)),
    png = (scale: number): Buffer =>
      createCanvas(
        Math.ceil((rect[2] - rect[0]) * scale),
        Math.ceil((rect[3] - rect[1]) * scale)
      ).toBuffer('image/png')
  expect(nativeCompleteFormCropPngSafe(png(4), rect, f.page, proof)).toBe(true)
  expect(nativeCompleteFormCropPngSafe(png(0.1), rect, f.page, proof)).toBe(false)
})

it('uses exact native caption bounds after the caller rescales its token rectangles', () => {
  const f = fixture(false, true)
  const caption = f.tokens.at(-1) as { rect: number[] }
  caption.rect[3] += Number.EPSILON * caption.rect[3]
  expect(caption.rect[3]).toBeGreaterThan(f.figure.caption.rect[3])
  expect(prove(f)?.rect).toEqual([50, 50, 450, 177])
})

it('does not establish short panel ownership from an invisible main caption', () => {
  const f = fixture(false, true),
    o = f.context.operators,
    i = o.fnArray.lastIndexOf(OPS.beginText)
  o.fnArray.splice(i, 0, OPS.setFillRGBColor)
  o.argsArray.splice(i, 0, ['#ffffff'])
  expect(prove(f)).toBeUndefined()
})
