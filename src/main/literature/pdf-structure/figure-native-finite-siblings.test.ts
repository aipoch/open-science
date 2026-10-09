import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { associateFigures, nativeOwnedTimelineStroke, excludeOwnedFigurePriorProse } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const {
  nativeRasterRowLabels,
  nativeTableDividerGraphic,
  nativeOwnedFigureBottomLabels,
  nativeOwnedRasterTitleRows,
  nativeOwnedFigureTopLabel,
  nativeOwnedPairedFacePanelKeys
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-owned-figure-labels.mjs'))
    .href
)
const {
  nativeCaptionedAlignedRasterPair,
  nativeCaptionedKeyedRasterTriple,
  nativeOwnedAnnotationFrame,
  nativeCaptionedVectorBarChart,
  nativeCaptionedRasterVectorStrip,
  nativeCaptionedRasterFrameBands,
  nativeCaptionedRepeatedRasterRows,
  nativeCaptionedRasterCompositeGrid,
  nativeCaptionedPairedRasterGrid
} = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-figure-native-captioned-illustration.mjs')
  ).href
)
const { nativeFigureRunningHead } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-native-plot-bands.mjs')).href
)
const input = (index: number): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-finite-figure-siblings.jsonl'
    )
  )[index]

const completeRasterTitleRows = (): ReturnType<typeof JSON.parse> => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 600,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: []
  } as ReturnType<typeof JSON.parse>
  const rect = [60, 60, 460, 350]
  const nativeTokens: ReturnType<typeof JSON.parse>[] = []
  const operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] }
  const add = (op: number, args: ReturnType<typeof JSON.parse>): void => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
  }
  for (const [i, image] of [
    [60, 60, 220, 180],
    [300, 60, 460, 180],
    [60, 230, 220, 350],
    [300, 230, 460, 350]
  ].entries()) {
    const normalizedRect = image.map((v) => v / 600)
    page.graphicsBounds.push({
      kind: 'image',
      normalizedRect,
      paintedNormalizedRect: [...normalizedRect]
    })
    add(OPS.save, [])
    add(OPS.transform, [160, 0, 0, 120, image[0], 600 - image[3]])
    add(OPS.paintImageXObject, [`image-${i}`, 3000, 2400])
    add(OPS.restore, [])
  }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.beginText, [])
  const token = (text: string, x: number, baseline: number, height: number): void => {
    x = Math.fround(x)
    const width = [...text].length * height * 0.6
    nativeTokens.push({
      text,
      rect: [x, baseline - height, x + width, baseline],
      baseline,
      height,
      fontDescent: -0.2,
      horizontal: true,
      inlineSymbol: false
    })
    add(OPS.setFont, ['native-font', height])
    add(OPS.setTextMatrix, [new Float32Array([1, 0, 0, 1, x, 600 - baseline])])
    add(OPS.showText, [
      [...text].map((unicode) => ({ unicode, fontChar: unicode, width: 600, isInFont: true }))
    ])
  }
  for (const [i, key] of ['a', 'b', 'c', 'd'].entries()) {
    const parts = [`(${key}) Native summary`, ' (p,', ' q)']
    const total = parts.join('').length * 8 * 0.6
    let x = (i % 2 ? 380 : 140) - total / 2
    const baseline = i < 2 ? 196 : 366
    for (const text of parts) {
      token(text, x, baseline, 8)
      x = nativeTokens.at(-1).rect[2]
    }
  }
  const captionText = 'Figure 1: Repeated native panels.'
  const captionWidth = captionText.length * 6
  token(captionText, 260 - captionWidth / 2, 388, 10)
  const caption = { page: 1, lines: [captionText], rect: [...nativeTokens.at(-1).rect] }
  add(OPS.endText, [])
  for (const row of [nativeTokens.slice(0, 6), nativeTokens.slice(6, 12), nativeTokens.slice(12)]) {
    const left = row[0].rect[0],
      right = row.at(-1).rect[2]
    page.lines.push({
      text: row.map((t) => t.text).join(' '),
      x: left,
      y: row[0].rect[1],
      width: right - left,
      height: row[0].height,
      fontSize: row[0].height
    })
  }
  return {
    page,
    caption,
    captions: [caption],
    tables: [],
    rect,
    nativeTokens,
    context: {
      operators,
      viewport: { width: 600, height: 600, rotation: 0, transform: [1, 0, 0, -1, 0, 600] }
    }
  }
}

it('completes full ordinary title packets below four already owned rasters', () => {
  const f = completeRasterTitleRows()
  const before = structuredClone(f)
  const legacy = associateFigures(f.page, f.captions, [], [], [], f.nativeTokens)
  const expected = structuredClone(legacy)
  expect(expected).toHaveLength(1)
  expected[0].rect[3] = 367.6
  expect(associateFigures(f.page, f.captions, [], [], [], f.nativeTokens, f.context)).toEqual(
    expected
  )
  expect(f).toEqual(before)
})

it('retains the complete raster title legacy result when raw context is unavailable', () => {
  const f = completeRasterTitleRows()
  const before = associateFigures(f.page, f.captions, [], [], [], f.nativeTokens)
  expect(associateFigures(f.page, f.captions, [], [], [], f.nativeTokens, undefined)).toEqual(
    before
  )
  expect(
    nativeOwnedRasterTitleRows(
      f.page,
      f.caption,
      f.captions,
      [],
      f.rect,
      f.nativeTokens,
      () => false,
      undefined
    )
  ).toBeUndefined()
})

it.each([
  'missing-font',
  'clipped-font',
  'wrapped-font',
  'script-font',
  'missing-calibrator',
  'foreign-font',
  'foreign-paint',
  'competing-caption',
  'table-strip',
  'foreign-owner',
  'unknown-operator',
  'invisible-text',
  'graphics-state',
  'type3-glyph',
  'unsupported-matrix',
  'nonfinite-viewport',
  'malformed-caption',
  'already-complete'
])('refuses a four-raster ordinary title completion with %s', (reason) => {
  const f = completeRasterTitleRows()
  const lower = f.nativeTokens[6]
  const ops = f.context.operators
  const append = (op: number, args: ReturnType<typeof JSON.parse>): void => {
    ops.fnArray.push(op)
    ops.argsArray.push(args)
  }
  if (reason === 'missing-font') f.nativeTokens.splice(8, 1)
  if (reason === 'clipped-font') lower.rect[3] -= 1
  if (reason === 'wrapped-font') {
    lower.baseline += 8
    lower.rect[1] += 8
    lower.rect[3] += 8
  }
  if (reason === 'script-font') {
    lower.height /= 2
    lower.rect[1] = lower.baseline - lower.height
  }
  if (reason === 'missing-calibrator') f.nativeTokens[0].text = '(x) Other summary'
  if (reason === 'foreign-font')
    f.nativeTokens.push({ ...lower, text: 'foreign', rect: [250, 358, 275, 366] })
  if (reason === 'foreign-paint')
    f.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.4, 0.59, 0.5, 0.61] })
  if (reason === 'competing-caption')
    f.captions.push({ page: 1, lines: ['Figure 2: Separate.'], rect: [250, 358, 275, 366] })
  if (reason === 'table-strip') f.tables.push([250, 358, 275, 366])
  if (reason === 'unknown-operator') append(999999, [])
  if (reason === 'invisible-text') append(OPS.setTextRenderingMode, [3])
  if (reason === 'graphics-state') append(OPS.setGState, [[['ca', 0.5]]])
  if (reason === 'type3-glyph')
    ops.argsArray[ops.fnArray.indexOf(OPS.showText)][0][0].operatorListId = 'unknown-program'
  if (reason === 'unsupported-matrix') {
    const i = ops.fnArray.indexOf(OPS.setTextMatrix)
    ops.argsArray[i] = [new Float64Array(ops.argsArray[i][0])]
  }
  if (reason === 'nonfinite-viewport') f.context.viewport.width = NaN
  if (reason === 'malformed-caption') f.caption.lines = 'Figure 1: Separate.'
  if (reason === 'already-complete') f.rect[3] = 367.6
  expect(
    nativeOwnedRasterTitleRows(
      f.page,
      f.caption,
      f.captions,
      f.tables,
      f.rect,
      f.nativeTokens,
      () => reason === 'foreign-owner',
      f.context
    )
  ).toBeUndefined()
})

const ordinaryClosedBottomPair = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['Figure 1: Paired native embeddings.'],
    rect: [70, 250, 350, 260]
  }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: caption.lines[0], x: 70, y: 250, width: 280, height: 10, fontSize: 10 }],
    graphicsBounds: []
  } as ReturnType<typeof JSON.parse>
  const tokens: ReturnType<typeof JSON.parse>[] = []
  const frames = [
    [80, 80, 180, 180],
    [220, 80, 320, 180]
  ]
  for (const [n, face] of frames.entries()) {
    for (const bounds of [
      [face[0] - 2, face[1] - 2, face[2] + 2, face[3] + 2],
      [face[0] + 5, face[1] + 5, face[2] - 5, face[3] - 5],
      [face[0] + 8, face[1] + 8, face[2] - 8, face[3] - 8]
    ])
      page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: bounds.map((v, i) => v / (i % 2 ? 800 : 600))
      })
    page.graphicsBounds.push({
      kind: 'image',
      imageHash: String(n + 1).repeat(64),
      normalizedRect: [face[0] + 10, face[1] + 10, face[2] - 10, face[3] - 10].map(
        (v, i) => v / (i % 2 ? 800 : 600)
      )
    })
    const text = n === 0 ? '(a) Local destinations' : '(b) Relative transitions'
    const rect = [face[0] + 10, 190, face[2] - 10, 198]
    tokens.push({ text, rect, height: 8, horizontal: true, baseline: 198, fontDescent: -0.2 })
    page.lines.push({ text, x: rect[0], y: 190, width: 80, height: 8, fontSize: 8 })
  }
  return {
    page,
    caption,
    captions: [caption],
    tables: [],
    rect: [78, 78, 322, 182],
    frames,
    tokens
  }
}

it('completes ordinary explanatory label font boxes below two independently closed faces', () => {
  const f = ordinaryClosedBottomPair()
  expect(
    nativeOwnedFigureBottomLabels(
      f.page,
      f.caption,
      f.captions,
      f.tables,
      f.rect,
      f.frames,
      f.tokens
    )
  ).toEqual([[78, 78, 322, 199.6]])
  const result = associateFigures(f.page, f.captions, f.tables, [], f.frames, f.tokens)
  expect(result).toHaveLength(1)
  expect(result[0].rect[3]).toBeGreaterThanOrEqual(199.6)
  expect(result[0].caption).toBe(f.caption)
})

it.each([
  'missing-face',
  'unequal-face',
  'duplicate-face',
  'missing-font',
  'clipped-font',
  'nonfinite-baseline',
  'foreign-font',
  'foreign-paint',
  'unknown-paint',
  'competing-caption',
  'table-strip',
  'caption-font-overlap',
  'foreign-owner'
])('refuses a complete closed ordinary label pair with %s evidence', (reason) => {
  const f = ordinaryClosedBottomPair()
  if (reason === 'missing-face') f.frames.pop()
  if (reason === 'unequal-face') f.frames[1][3] -= 4
  if (reason === 'duplicate-face') f.frames.push([...f.frames[0]])
  if (reason === 'missing-font') f.tokens.pop()
  if (reason === 'clipped-font') f.tokens[0].rect[3] -= 1
  if (reason === 'nonfinite-baseline') f.tokens[0].baseline = NaN
  if (reason === 'foreign-font') {
    f.tokens.push({
      text: 'foreign',
      rect: [190, 188, 210, 196],
      height: 8,
      baseline: 196,
      horizontal: true,
      fontDescent: -0.2
    })
    f.page.lines.push({ text: 'foreign', x: 190, y: 188, width: 20, height: 8, fontSize: 8 })
  }
  if (reason === 'foreign-paint' || reason === 'unknown-paint')
    f.page.graphicsBounds.push({
      kind: reason === 'unknown-paint' ? 'unknown' : 'path',
      normalizedRect: [190 / 600, 188 / 800, 210 / 600, 196 / 800]
    })
  if (reason === 'competing-caption')
    f.captions.push({ page: 1, lines: ['Figure 2: Other plate.'], rect: [190, 188, 210, 196] })
  if (reason === 'table-strip') f.tables.push([190, 188, 210, 196])
  if (reason === 'caption-font-overlap') f.caption.rect[1] = 199
  const result = nativeOwnedFigureBottomLabels(
    f.page,
    f.caption,
    f.captions,
    f.tables,
    f.rect,
    f.frames,
    f.tokens,
    () => reason === 'foreign-owner'
  )
  // Missing independent proof preserves legacy behavior; it cannot supply the
  // complete two-face source envelope or both full descent-bearing font boxes.
  expect(result).not.toEqual([[78, 78, 322, 199.6]])
})

it('preserves an already complete ordinary pair and ignores a different-page caption barrier', () => {
  const f = ordinaryClosedBottomPair()
  const complete = [78, 78, 322, 200]
  expect(
    nativeOwnedFigureBottomLabels(
      f.page,
      f.caption,
      f.captions,
      f.tables,
      complete,
      f.frames,
      f.tokens
    )
  ).toEqual(f.tokens.map((t: ReturnType<typeof JSON.parse>) => t.rect))
  f.captions.push({ page: 2, lines: ['Figure 2: Another page.'], rect: [190, 188, 210, 196] })
  expect(
    nativeOwnedFigureBottomLabels(
      f.page,
      f.caption,
      f.captions,
      f.tables,
      f.rect,
      f.frames,
      f.tokens
    )
  ).toEqual([[78, 78, 322, 199.6]])
})

it('rejects a neighboring owner across a lateral or upper painted extension', () => {
  const f = ordinaryClosedBottomPair()
  f.page.graphicsBounds[0].normalizedRect = [75 / 600, 75 / 800, 185 / 600, 185 / 800]
  const foreignOwns = (r: number[]): boolean => r[0] < f.rect[0] && r[1] < f.rect[1]
  expect(
    nativeOwnedFigureBottomLabels(
      f.page,
      f.caption,
      f.captions,
      f.tables,
      f.rect,
      f.frames,
      f.tokens,
      foreignOwns
    )
  ).not.toEqual([[75, 75, 322, 199.6]])
})

const wholeKeyedRasterTriple = (): ReturnType<typeof JSON.parse> => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: []
  } as ReturnType<typeof JSON.parse>
  const caption = {
    page: 1,
    lines: ['Figure 7: Native comparison'],
    rect: [220, 198, 380, 208]
  }
  const tokens: ReturnType<typeof JSON.parse>[] = []
  const normal = (text: string, rect: number[], height = 9): void => {
    tokens.push({ text, rect, height, horizontal: true, baseline: rect[3], fontDescent: -0.2 })
  }
  const operators: { fnArray: number[]; argsArray: ReturnType<typeof JSON.parse>[] } = {
    fnArray: [],
    argsArray: []
  }
  const op = (operation: number, args: ReturnType<typeof JSON.parse>): void => {
    operators.fnArray.push(operation)
    operators.argsArray.push(args)
  }
  for (let i = 0; i < 3; i++) {
    const left = 80 + i * 150
    const image = [left, 62 - i * 3, left + 140, 165]
    const painted = [left + 4, 65 - i * 3, left + 136, 159]
    page.graphicsBounds.push({
      kind: 'image',
      imageHash: String.fromCharCode(97 + i).repeat(64),
      normalizedRect: image.map((v, n) => v / (n % 2 ? 800 : 600)),
      paintedNormalizedRect: painted.map((v, n) => v / (n % 2 ? 800 : 600))
    })
    op(OPS.save, [])
    op(OPS.transform, [140, 0, 0, 103 + i * 3, left, 635])
    op(OPS.paintImageXObject, ['image-' + i, 140, 103 + i * 3])
    op(OPS.restore, [])
    const x = left + 1
    normal('(' + 'abc'[i] + ')', [x, 167, x + 12, 176])
    normal('Panel', [x + 15, 167, x + 38, 176])
    if (i === 1) normal('2', [x + 38.5, 166.2, x + 43.5, 172.5], 6.3)
    normal('comparison across measurements', [x + 45, 167, x + 137, 176])
    normal('Complete', [x, 178, x + 33, 187])
    normal('detail', [x + 36, 178, x + 63, 187])
    page.lines.push({
      text: '(' + 'abc'[i] + ') Panel' + (i === 1 ? '2' : '') + ' comparison across measurements',
      x,
      y: i === 1 ? 166.2 : 167,
      width: 137,
      height: i === 1 ? 9.8 : 9,
      fontSize: 9
    })
    page.lines.push({ text: 'Complete detail', x, y: 178, width: 63, height: 9, fontSize: 9 })
  }
  normal(caption.lines[0], [...caption.rect], 10)
  page.lines.push({ text: caption.lines[0], x: 220, y: 198, width: 160, height: 10, fontSize: 10 })
  op(OPS.setFillRGBColor, ['#000000'])
  op(OPS.beginText, [])
  op(OPS.setFont, ['native-font', 10])
  op(OPS.showText, [
    Array.from(tokens.map((t) => t.text).join('')).map((character, index) => ({
      unicode: character,
      fontChar: character,
      width: 500,
      originalCharCode: index + 1,
      isInFont: true,
      accent: null
    }))
  ])
  op(OPS.endText, [])
  const peerCaption = {
    page: 1,
    lines: ['Figure 8: Further comparison'],
    rect: [220, 468, 380, 478]
  }
  const peerFonts = structuredClone(tokens)
  for (const font of peerFonts) {
    font.rect[1] += 270
    font.rect[3] += 270
    font.baseline += 270
    if (font.text === caption.lines[0]) font.text = peerCaption.lines[0]
  }
  tokens.push(...peerFonts)
  for (const line of structuredClone(page.lines)) {
    line.y += 270
    if (line.text === caption.lines[0]) line.text = peerCaption.lines[0]
    page.lines.push(line)
  }
  for (let i = 0; i < 3; i++) {
    const image = structuredClone(page.graphicsBounds[i])
    image.imageHash = String.fromCharCode(100 + i).repeat(64)
    for (const bounds of [image.normalizedRect, image.paintedNormalizedRect]) {
      bounds[1] += 270 / 800
      bounds[3] += 270 / 800
    }
    page.graphicsBounds.push(image)
    op(OPS.save, [])
    op(OPS.transform, [140, 0, 0, 103 + i * 3, 80 + i * 150, 365])
    op(OPS.paintImageXObject, ['peer-image-' + i, 140, 103 + i * 3])
    op(OPS.restore, [])
  }
  op(OPS.beginText, [])
  op(OPS.setFont, ['native-font', 10])
  op(OPS.showText, [
    Array.from(peerFonts.map((t) => t.text).join('')).map((character, index) => ({
      unicode: character,
      fontChar: character,
      width: 500,
      originalCharCode: index + 1,
      isInFont: true,
      accent: null
    }))
  ])
  op(OPS.endText, [])
  return {
    page,
    captions: [caption, peerCaption],
    tableRects: [],
    nativeTokens: tokens,
    operatorContext: {
      operators,
      viewport: { scale: 1, rotation: 0, width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }
    }
  }
}

it('recovers all three whole rasters and two-row native titles at the actual consumer', () => {
  const f = wholeKeyedRasterTriple()
  const before = structuredClone(f)
  const result = associateFigures(
    f.page,
    f.captions,
    f.tableRects,
    [],
    [],
    f.nativeTokens,
    f.operatorContext
  )
  expect(result).toHaveLength(2)
  expect(result[0].rect).toEqual([81, 59, 518, 188.8])
  expect(result[0].caption).toBe(f.captions[0])
  expect(result[0].graphicsCount).toBe(3)
  expect(result[0].issue).toBeUndefined()
  expect(result[1].rect).toEqual([81, 329, 518, 458.8])
  expect(result[1].caption).toBe(f.captions[1])
  expect(result[1].graphicsCount).toBe(3)
  expect(f).toEqual(before)
})

it.each([
  'missing-context',
  'unknown-opcode',
  'hidden-text',
  'shading',
  'path',
  'clip',
  'form',
  'alpha',
  'reflection',
  'zero-glyph-width',
  'type3',
  'incomplete-raw-stream',
  'missing-font-array',
  'null-font',
  'invalid-font-box',
  'clipped-font-height',
  'foreign-caption-font',
  'duplicate-key',
  'detached-script',
  'missing-paint',
  'duplicate-hash',
  'ctm-mismatch',
  'foreign-graphic',
  'invalid-graphics',
  'interposed-caption',
  'table',
  'already-complete-raster-and-titles',
  'malformed-source-lines',
  'malformed-caption',
  'wrong-page'
])('requires complete independent whole raster/title ownership: %s', (reason) => {
  const f = wholeKeyedRasterTriple()
  const ops = f.operatorContext.operators
  let ownedRect: number[] | undefined
  const prepend = (operation: number, args: ReturnType<typeof JSON.parse>): void => {
    ops.fnArray.unshift(operation)
    ops.argsArray.unshift(args)
  }
  if (reason === 'missing-context') f.operatorContext = undefined
  if (reason === 'unknown-opcode') prepend(99999, [])
  if (reason === 'hidden-text') prepend(OPS.setTextRenderingMode, [3])
  if (reason === 'shading') prepend(OPS.shadingFill, ['unknown'])
  if (reason === 'path') prepend(OPS.constructPath, [OPS.stroke, [[0, 0, 0, 1, 10, 10]]])
  if (reason === 'clip') prepend(OPS.clip, [])
  if (reason === 'form') prepend(OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 0, 0], null])
  if (reason === 'alpha') prepend(OPS.setGState, [[['ca', 0.5]]])
  if (reason === 'reflection') ops.argsArray[1][0] *= -1
  const glyph = (): ReturnType<typeof JSON.parse> =>
    ops.argsArray[ops.fnArray.indexOf(OPS.showText)][0][0]
  if (reason === 'zero-glyph-width') glyph().width = 0
  if (reason === 'type3') glyph().operatorListId = 'unknown-program'
  if (reason === 'incomplete-raw-stream') ops.argsArray.pop()
  if (reason === 'missing-font-array') f.nativeTokens = undefined
  if (reason === 'null-font') f.nativeTokens[0] = null
  if (reason === 'invalid-font-box') f.nativeTokens[0].rect[0] = NaN
  if (reason === 'clipped-font-height') f.nativeTokens[0].rect[3] -= 1
  if (reason === 'foreign-caption-font') {
    const token = {
      text: 'foreign',
      rect: [260, 202, 290, 206],
      height: 4,
      baseline: 206,
      horizontal: true,
      fontDescent: 0
    }
    f.nativeTokens.push(token)
    f.page.lines.push({ text: token.text, x: 260, y: 202, width: 30, height: 4, fontSize: 4 })
  }
  if (reason === 'duplicate-key') f.nativeTokens.push(structuredClone(f.nativeTokens[0]))
  if (reason === 'detached-script') {
    const script = f.nativeTokens.find((token: ReturnType<typeof JSON.parse>) => token.text === '2')
    script.rect[0] += 9
    script.rect[2] += 9
  }
  if (reason === 'missing-paint') delete f.page.graphicsBounds[0].paintedNormalizedRect
  if (reason === 'duplicate-hash')
    f.page.graphicsBounds[1].imageHash = f.page.graphicsBounds[0].imageHash
  if (reason === 'ctm-mismatch') ops.argsArray[1][4] += 2
  if (reason === 'foreign-graphic')
    f.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.2, 0.3, 0.3] })
  if (reason === 'invalid-graphics') f.page.invalidGraphicsBounds = 1
  if (reason === 'interposed-caption')
    f.captions.push({
      page: 1,
      lines: ['Figure 8: Independent plate.'],
      rect: [200, 160, 400, 170]
    })
  if (reason === 'table') f.tableRects.push([80, 120, 200, 180])
  if (reason === 'already-complete-raster-and-titles') ownedRect = [81, 59, 518, 188.8]
  if (reason === 'malformed-source-lines') f.page.lines.push(null)
  if (reason === 'malformed-caption') f.captions[0].lines = null
  if (reason === 'wrong-page') f.captions[0].page = 2
  const before = structuredClone(f)
  expect(
    nativeCaptionedKeyedRasterTriple(
      f.page,
      f.captions[0],
      f.captions,
      f.tableRects,
      f.nativeTokens,
      f.operatorContext,
      ownedRect
    )
  ).toBeUndefined()
  expect(f).toEqual(before)
})

const completePaintedRasterRows = (): ReturnType<typeof JSON.parse> => {
  const norm = (rect: number[]): number[] => rect.map((value, i) => value / (i % 2 ? 800 : 600))
  const caption = {
    page: 1,
    lines: ['Figure 3. Complete source comparisons across both rows.'],
    rect: [40, 320, 560, 330]
  }
  return {
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      rotation: 0,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      lines: [{ text: caption.lines[0], x: 40, y: 320, width: 520, height: 10, fontSize: 10 }],
      graphicsBounds: [
        {
          kind: 'image',
          imageHash: 'a'.repeat(64),
          normalizedRect: norm([55, 75, 545, 185]),
          paintedNormalizedRect: norm([60, 80, 540, 180])
        },
        {
          kind: 'image',
          imageHash: 'b'.repeat(64),
          normalizedRect: norm([55, 195, 545, 305]),
          paintedNormalizedRect: norm([60, 200, 540, 300])
        }
      ]
    },
    captions: [caption],
    tables: []
  }
}

it('owns two complete painted raster rows under their single native caption', () => {
  const f = completePaintedRasterRows()
  const before = structuredClone(f)
  const figures = associateFigures(f.page, f.captions, f.tables, [], [], [])
  expect(figures).toHaveLength(1)
  expect(figures[0].rect).toEqual([60, 80, 540, 300])
  expect(figures[0].graphicsCount).toBe(2)
  expect(figures[0].caption).toEqual(f.captions[0])
  expect(f).toEqual(before)
})

it('refuses complete raster rows with an independent source font inside their caption', () => {
  const f = completePaintedRasterRows()
  f.page.lines.push({
    text: 'foreign',
    x: 100,
    y: 324,
    width: 30,
    height: 4,
    fontSize: 4
  })
  const before = structuredClone(f)
  expect(
    nativeCaptionedAlignedRasterPair(f.page, f.captions[0], f.captions, f.tables, [])
  ).toBeUndefined()
  expect(f).toEqual(before)
})

it.each([
  'missing-paint',
  'duplicate-hash',
  'foreign-paint',
  'intervening-prose',
  'separate-caption',
  'table',
  'overlapping-rows',
  'large-gap',
  'caption-literal',
  'clipped-caption-font',
  'unknown-graphics'
])('refuses unkeyed painted rows without complete %s ownership', (missing) => {
  const f = completePaintedRasterRows()
  const graphics = f.page.graphicsBounds
  if (missing === 'missing-paint') delete graphics[0].paintedNormalizedRect
  if (missing === 'duplicate-hash') graphics[1].imageHash = graphics[0].imageHash
  if (missing === 'foreign-paint')
    graphics.push({ kind: 'path', normalizedRect: [0.1, 0.1, 0.5, 0.2] })
  if (missing === 'intervening-prose')
    f.page.lines.push({
      text: 'An independent intervening source paragraph.',
      x: 80,
      y: 185,
      width: 250,
      height: 10,
      fontSize: 10
    })
  if (missing === 'separate-caption')
    f.captions.push({
      page: 1,
      lines: ['Figure 4. A separate source plate.'],
      rect: [80, 185, 500, 195]
    })
  if (missing === 'table') f.tables.push([80, 90, 300, 150])
  if (missing === 'overlapping-rows') graphics[1].paintedNormalizedRect[1] = 175 / 800
  if (missing === 'large-gap') graphics[0].paintedNormalizedRect[3] = 160 / 800
  if (missing === 'caption-literal') f.captions[0].lines[0] += ' Independent extra words.'
  if (missing === 'clipped-caption-font') f.page.lines[0].height = 1
  if (missing === 'unknown-graphics') f.page.invalidGraphicsBounds = 1
  const before = structuredClone(f)
  expect(
    nativeCaptionedAlignedRasterPair(f.page, f.captions[0], f.captions, f.tables)
  ).toBeUndefined()
  expect(f).toEqual(before)
})

it.each([0.73, 1.7])(
  'preserves complete painted rows under source scaling and permutation (%s)',
  (scale) => {
    const f = completePaintedRasterRows()
    f.page.width *= scale
    f.page.height *= scale
    for (const line of f.page.lines)
      for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
    f.page.lines.reverse()
    f.page.graphicsBounds.reverse()
    f.captions[0].rect = f.captions[0].rect.map((value: number) => value * scale)
    const before = structuredClone(f)
    const result = associateFigures(f.page, f.captions, f.tables, [], [], [])[0]
    for (const [i, value] of [60, 80, 540, 300].entries())
      expect(result.rect[i]).toBeCloseTo(value * scale, 8)
    expect(result.caption).toEqual(f.captions[0])
    expect(result.graphicsCount).toBe(2)
    expect(f).toEqual(before)
  }
)

it('fails closed on an empty legacy line without complete native font metrics', () => {
  const f = completePaintedRasterRows()
  f.page.lines.push({ text: '' })
  const before = structuredClone(f)
  expect(
    nativeCaptionedAlignedRasterPair(f.page, f.captions[0], f.captions, f.tables)
  ).toBeUndefined()
  expect(f).toEqual(before)
})

const shallowPairedRasterGrid = (): ReturnType<typeof JSON.parse> => {
  const f = {
    page: { pageNumber: 1, width: 600, height: 780, invalidGraphicsBounds: 0, lines: [] },
    captions: [],
    tableRects: [],
    rules: [],
    closedFrames: [],
    nativeTokens: []
  } as ReturnType<typeof JSON.parse>
  const norm = (r: number[]): number[] => r.map((v, n) => v / (n % 2 ? 780 : 600))
  const graphics: ReturnType<typeof JSON.parse>[] = [
    { kind: 'path', normalizedRect: norm([50, 80, 530, 335]) }
  ]
  const font = (text: string, rect: number[], size: number, horizontal = true): void => {
    f.nativeTokens.push({ text, rect, height: size, horizontal, baseline: rect[3], fontDescent: 0 })
    f.page.lines.push({
      text,
      x: rect[0],
      y: rect[1],
      width: rect[2] - rect[0],
      height: rect[3] - rect[1],
      fontSize: size
    })
  }
  const headers = [
    [104, 116],
    [173, 242],
    [288, 357],
    [477, 493]
  ]
  for (const [c, x] of headers.entries()) font(`Header${c}`, [x[0], 85, x[1], 97], 12)
  const centers = [110, 190, 225, 305, 340, 485]
  for (let group = 0; group < 3; group++) {
    const top = 100 + group * 75
    graphics.push({ kind: 'path', normalizedRect: norm([60, top, 500, top + 75]) })
    font(`Group${group}`, [70, top + 16, 80, top + 60], 10, false)
    for (let row = 0; row < 2; row++)
      for (const [column, x] of centers.entries()) {
        const height = group === 0 && row === 0 ? 14 : 28
        const y = top + (row === 0 ? 20 : 55)
        const rect = norm([x - 15, y - height / 2, x + 15, y + height / 2])
        graphics.push({
          kind: 'image',
          imageHash: `source-${group}-${row}-${column}`,
          normalizedRect: rect,
          paintedNormalizedRect: [...rect]
        })
      }
  }
  graphics.push({
    kind: 'image',
    imageHash: 'source-key',
    normalizedRect: norm([508, 260, 522, 335])
  })
  font('8', [510, 262, 516, 270], 8)
  font('0', [510, 326, 516, 334], 8)
  font('Scale', [520, 278, 528, 294], 8, false)
  font('Value', [520, 296, 528, 312], 8, false)
  const caption = {
    page: 1,
    lines: ['Figure 9. Complete paired raster comparison.'],
    rect: [40, 341, 560, 349]
  }
  f.captions.push(caption)
  font(caption.lines[0], caption.rect, 8)
  const peerCaption = {
    page: 1,
    lines: ['Figure 10. Separate complete source plate.'],
    rect: [40, 610, 560, 618]
  }
  f.captions.push(peerCaption)
  font(peerCaption.lines[0], peerCaption.rect, 8)
  graphics.push({
    kind: 'image',
    imageHash: 'source-independent',
    normalizedRect: norm([60, 400, 540, 600]),
    paintedNormalizedRect: norm([60, 400, 540, 600])
  })
  f.page.graphicsBounds = graphics
  return f
}
const shallowResult = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  nativeCaptionedRasterCompositeGrid(
    f.page,
    f.captions[0],
    f.captions,
    f.tableRects,
    f.nativeTokens
  )

const pairedClosedFaceKeys = (): ReturnType<typeof JSON.parse> => {
  const f = {
    page: { pageNumber: 1, width: 600, height: 800, invalidGraphicsBounds: 0, lines: [] },
    captions: [],
    tableRects: [],
    rules: [],
    closedFrames: [],
    nativeTokens: [],
    ownedRect: [76, 116, 534, 412]
  } as ReturnType<typeof JSON.parse>
  const norm = (r: number[]): number[] => r.map((v, n) => v / (n % 2 ? 800 : 600))
  const graphics = [{ kind: 'path', normalizedRect: norm(f.ownedRect) }] as ReturnType<
    typeof JSON.parse
  >[]
  for (const top of [120, 280]) {
    for (const [left, right] of [
      [110, 220],
      [224, 280],
      [350, 460],
      [464, 520]
    ]) {
      const face = [left, top, right, top + 110]
      f.closedFrames.push(face)
      graphics.push(
        { kind: 'path', normalizedRect: norm(face) },
        { kind: 'path', normalizedRect: norm([left + 10, top + 15, right - 10, top + 80]) }
      )
    }
    for (const [left, right] of [
      [110, 280],
      [350, 520]
    ])
      graphics.push({
        kind: 'image',
        imageHash: `plate-${left}-${top}`,
        normalizedRect: norm([left, top, right, top + 110])
      })
  }
  const font = (text: string, rect: number[], descent = -0.2): void => {
    f.nativeTokens.push({
      text,
      rect,
      height: 10,
      baseline: rect[3],
      fontDescent: descent,
      horizontal: true
    })
  }
  const line = (text: string, rect: number[]): void => {
    f.page.lines.push({
      text,
      x: rect[0],
      y: rect[1],
      width: rect[2] - rect[0],
      height: rect[3] - rect[1],
      fontSize: 10
    })
  }
  font('A separate preceding paragraph.', [76, 70, 400, 80])
  line('A separate preceding paragraph.', [76, 70, 400, 80])
  for (const [key, x, y] of [
    ['a', 70, 100],
    ['b', 308, 100],
    ['c', 70, 260],
    ['d', 308, 260.004]
  ] as [string, number, number][])
    font(`(${key})`, [x, y, x + 12, y + 10])
  line('(a) (b)', [70, 100, 320, 110])
  line('(c) (d)', [70, 260, 320, 270.004])
  f.captions.push({
    page: 1,
    lines: ['Figure 4. Responses (a), (b), (c), and (d).'],
    rect: [60, 430, 540, 440]
  })
  font(f.captions[0].lines[0], f.captions[0].rect, 0)
  line(f.captions[0].lines[0], f.captions[0].rect)
  f.page.graphicsBounds = graphics
  return f
}

it('completes four whole native panel keys on two rows of already owned paired closed faces', () => {
  const f = pairedClosedFaceKeys(),
    before = JSON.stringify(f)
  expect(
    nativeOwnedFigureBottomLabels(
      f.page,
      f.captions[0],
      f.captions,
      f.tableRects,
      f.ownedRect,
      f.closedFrames,
      f.nativeTokens
    )
  ).toEqual([
    [70, 100, 82, 112],
    [308, 100, 320, 112],
    [70, 260, 82, 272],
    [308, 260.004, 320, 272.004]
  ])
  expect(JSON.stringify(f)).toBe(before)
})

it('completes the four paired-face keys at the actual association consumer without borrowing preceding prose', () => {
  const f = pairedClosedFaceKeys()
  const result = associateFigures(
    f.page,
    f.captions,
    f.tableRects,
    f.rules,
    f.closedFrames,
    f.nativeTokens
  )
  expect(result).toHaveLength(1)
  expect(result[0].rect).toEqual([70, 100, 534, 412])
  expect(result[0].caption).toBe(f.captions[0])
})

const pairedFaceKeyResult = (
  f: ReturnType<typeof JSON.parse>,
  foreignOwns: (rect: number[]) => boolean = () => false
): ReturnType<typeof JSON.parse> =>
  nativeOwnedPairedFacePanelKeys(
    f.page,
    f.captions?.[0],
    f.captions,
    f.tableRects,
    f.ownedRect,
    f.closedFrames,
    f.nativeTokens,
    foreignOwns
  )

it.each([
  'native-array',
  'frame-array',
  'table-array',
  'caption-array',
  'page-lines',
  'graphics-array',
  'caption-lines',
  'caption-text',
  'native-text',
  'page-width',
  'caption-rect',
  'font-rect',
  'paint-rect',
  'line-text',
  'paint-envelope',
  'missing-face',
  'foreign-face',
  'row-height',
  'pair-seam',
  'group-gutter',
  'missing-key',
  'duplicate-key',
  'key-baseline',
  'clipped-key',
  'cross-gutter-key',
  'clipped-key-row',
  'caption-key',
  'caption-font',
  'foreign-font',
  'crossing-font',
  'foreign-paint',
  'crossing-paint',
  'table',
  'caption',
  'unknown-paint',
  'opaque-font',
  'different-page',
  'prose-in-strip'
])('refuses paired-face key completion without complete source ownership: %s', (reason) => {
  const f = pairedClosedFaceKeys()
  const key = (value: string): ReturnType<typeof JSON.parse> =>
    f.nativeTokens.find((t: ReturnType<typeof JSON.parse>) => t.text === value)
  if (reason === 'native-array') delete f.nativeTokens
  if (reason === 'frame-array') delete f.closedFrames
  if (reason === 'table-array') delete f.tableRects
  if (reason === 'caption-array') delete f.captions
  if (reason === 'page-lines') delete f.page.lines
  if (reason === 'graphics-array') delete f.page.graphicsBounds
  if (reason === 'caption-lines') delete f.captions[0].lines
  if (reason === 'caption-text') f.captions[0].lines[0] = 5
  if (reason === 'native-text') f.nativeTokens[0].text = 5
  if (reason === 'page-width') f.page.width = Infinity
  if (reason === 'caption-rect') f.captions[0].rect[0] = NaN
  if (reason === 'font-rect') f.nativeTokens[0].rect[0] = NaN
  if (reason === 'paint-rect') f.page.graphicsBounds[0].normalizedRect[0] = NaN
  if (reason === 'line-text') f.page.lines[0].text = 5
  if (reason === 'paint-envelope') f.page.graphicsBounds[0].paintedNormalizedRect = [0, 0, 1, 1]
  if (reason === 'missing-face') f.closedFrames.pop()
  if (reason === 'foreign-face') f.closedFrames.push([130, 150, 190, 200])
  if (reason === 'row-height') f.closedFrames[4][3] -= 3
  if (reason === 'pair-seam') f.closedFrames[1][0] += 8
  if (reason === 'group-gutter') f.closedFrames[2][0] -= 50
  if (reason === 'missing-key')
    f.nativeTokens = f.nativeTokens.filter((t: ReturnType<typeof JSON.parse>) => t.text !== '(a)')
  if (reason === 'duplicate-key') f.nativeTokens.push(structuredClone(key('(a)')))
  if (reason === 'key-baseline') key('(a)').baseline = NaN
  if (reason === 'clipped-key') key('(a)').rect[3] -= 1
  if (reason === 'cross-gutter-key') key('(b)').rect[0] = 80
  if (reason === 'clipped-key-row') f.page.lines[2].height -= 0.01
  if (reason === 'caption-key')
    f.captions[0].lines[0] = f.captions[0].lines[0].replace('(a)', '(x)')
  if (reason === 'caption-font') f.nativeTokens.pop()
  if (reason === 'foreign-font' || reason === 'crossing-font') {
    const top = reason === 'foreign-font' ? 103 : 95
    f.nativeTokens.push({
      text: 'Foreign text',
      rect: [140, top, 210, top + 10],
      height: 10,
      baseline: top + 10,
      fontDescent: 0,
      horizontal: true
    })
    f.page.lines.push({ text: 'Foreign text', x: 140, y: top, width: 70, height: 10, fontSize: 10 })
  }
  if (reason === 'foreign-paint')
    f.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.13, 0.3, 0.145] })
  if (reason === 'crossing-paint')
    f.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.05, 0.2, 0.2, 0.3] })
  if (reason === 'table') f.tableRects.push([70, 100, 100, 130])
  if (reason === 'caption')
    f.captions.push({ page: 1, lines: ['Figure 8. Other source.'], rect: [100, 105, 200, 115] })
  if (reason === 'unknown-paint') f.page.invalidGraphicsBounds = 1
  if (reason === 'opaque-font') key('(a)').fontDescent = NaN
  if (reason === 'different-page') f.captions[0].page = 2
  if (reason === 'prose-in-strip') {
    f.nativeTokens[0].rect[1] += 33
    f.nativeTokens[0].rect[3] += 33
    f.nativeTokens[0].baseline += 33
    f.page.lines[0].y += 33
  }
  expect(pairedFaceKeyResult(f)).toBeUndefined()
})

it('requires peer ownership clearance for paired-face key completion', () => {
  expect(pairedFaceKeyResult(pairedClosedFaceKeys(), (rect) => rect[0] < 76)).toBeUndefined()
})

it('keeps different-page equal-coordinate captions out of paired-face barriers', () => {
  const f = pairedClosedFaceKeys(),
    expected = pairedFaceKeyResult(f)
  f.captions.push({ page: 2, lines: ['Figure 8. Other page.'], rect: [100, 105, 200, 115] })
  expect(pairedFaceKeyResult(f)).toEqual(expected)
})

it('preserves an independent lower raster peer whole while completing the four key fonts', () => {
  const f = pairedClosedFaceKeys()
  f.captions.push({
    page: 1,
    lines: ['Figure 5. Independent raster peer.'],
    rect: [60, 700, 540, 710]
  })
  f.nativeTokens.push({
    text: f.captions[1].lines[0],
    rect: f.captions[1].rect,
    height: 10,
    baseline: 710,
    fontDescent: 0,
    horizontal: true
  })
  f.page.lines.push({
    text: f.captions[1].lines[0],
    x: 60,
    y: 700,
    width: 480,
    height: 10,
    fontSize: 10
  })
  f.page.graphicsBounds.push({
    kind: 'image',
    imageHash: 'independent-peer',
    normalizedRect: [0.1, 0.65, 0.9, 0.85]
  })
  const before = JSON.stringify(f)
  const current = associateFigures(
    f.page,
    f.captions,
    f.tableRects,
    f.rules,
    f.closedFrames,
    f.nativeTokens
  )
  const missing = structuredClone(f)
  missing.closedFrames = []
  const legacy = associateFigures(
    missing.page,
    missing.captions,
    missing.tableRects,
    missing.rules,
    missing.closedFrames,
    missing.nativeTokens
  )
  expect(current[0].rect).toEqual([70, 100, 534, 412])
  expect(current[1]).toEqual(legacy[1])
  expect(JSON.stringify(f)).toBe(before)
})

it('retains complete shallow raster rows with an independent native header partition and full painted carriers', () => {
  const f = shallowPairedRasterGrid(),
    before = JSON.stringify(f)
  expect(shallowResult(f)).toEqual({
    caption: f.captions[0],
    rect: [50, 80, 530, 335],
    graphicsCount: 37
  })
  expect(JSON.stringify(f)).toBe(before)
})
it('uses the complete shallow plate at the actual association consumer and preserves its independent raster peer', () => {
  const f = shallowPairedRasterGrid()
  const current = associateFigures(
    f.page,
    f.captions,
    f.tableRects,
    f.rules,
    f.closedFrames,
    f.nativeTokens
  )
  expect(current[0].rect).toEqual([50, 80, 530, 335])
  expect(current[0].graphicsCount).toBe(37)
  const missingProof = structuredClone(f)
  missingProof.nativeTokens = []
  const previous = associateFigures(
    missingProof.page,
    missingProof.captions,
    missingProof.tableRects,
    missingProof.rules,
    missingProof.closedFrames,
    missingProof.nativeTokens
  )
  expect(current[1]).toEqual(previous[1])
})
it('keeps margin furniture outside a source-complete shallow raster plate', () => {
  const f = shallowPairedRasterGrid()
  f.nativeTokens.unshift({
    text: '8 • Example et al.',
    rect: [45, 57, 115, 64],
    height: 7,
    baseline: 64,
    fontDescent: 0,
    horizontal: true
  })
  f.page.lines.unshift({
    text: '8 • Example et al.',
    x: 45,
    y: 57,
    width: 70,
    height: 7,
    fontSize: 7
  })
  const result = associateFigures(
    f.page,
    f.captions,
    f.tableRects,
    f.rules,
    f.closedFrames,
    f.nativeTokens
  )
  expect(result[0].rect).toEqual([50, 80, 530, 335])
  expect(result[0].graphicsCount).toBe(37)
})
it('retains the legacy detached-label path when the complete native font proof is missing', () => {
  const f = shallowPairedRasterGrid()
  f.page.lines.unshift({
    text: '8 • Example et al.',
    x: 45,
    y: 57,
    width: 70,
    height: 7,
    fontSize: 7
  })
  f.nativeTokens = []
  const result = associateFigures(
    f.page,
    f.captions,
    f.tableRects,
    f.rules,
    f.closedFrames,
    f.nativeTokens
  )
  expect(result[0].rect).toEqual([45, 57, 530, 335])
})
it.each(['font', 'paint'])(
  'refuses complete ownership for a foreign margin %s moved inside the shallow plate',
  (kind) => {
    const f = shallowPairedRasterGrid()
    if (kind === 'font') {
      f.nativeTokens.push({
        text: 'Foreign text',
        rect: [130, 110, 210, 117],
        height: 7,
        baseline: 117,
        fontDescent: 0,
        horizontal: true
      })
      f.page.lines.push({ text: 'Foreign text', x: 130, y: 110, width: 80, height: 7, fontSize: 7 })
    } else f.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.2, 0.22, 0.23] })
    expect(
      nativeCaptionedPairedRasterGrid(
        f.page,
        f.captions[0],
        f.captions,
        f.tableRects,
        f.nativeTokens
      )
    ).toBeUndefined()
  }
)
it.each([
  'missing-tokens',
  'missing-image',
  'unequal-row-length',
  'missing-paint',
  'missing-hash',
  'duplicate-all-hashes',
  'foreign-paint',
  'oversized-carrier',
  'missing-header',
  'clipped-header',
  'nonfinite-baseline',
  'missing-group-font',
  'missing-key',
  'foreign-caption',
  'foreign-table',
  'unknown-font'
])(
  'preserves legacy ownership when the complete shallow raster witness is missing: %s',
  (reason) => {
    const f = shallowPairedRasterGrid()
    if (reason === 'missing-tokens') f.nativeTokens = []
    if (reason === 'missing-image')
      f.page.graphicsBounds = f.page.graphicsBounds.filter(
        (g: ReturnType<typeof JSON.parse>) => g.imageHash !== 'source-0-0-0'
      )
    if (reason === 'unequal-row-length')
      f.page.graphicsBounds = f.page.graphicsBounds.filter(
        (g: ReturnType<typeof JSON.parse>) =>
          !['source-1-0-5', 'source-1-1-5'].includes(g.imageHash)
      )
    if (reason === 'missing-paint')
      delete f.page.graphicsBounds.find(
        (g: ReturnType<typeof JSON.parse>) => g.imageHash === 'source-0-0-0'
      ).paintedNormalizedRect
    if (reason === 'missing-hash')
      delete f.page.graphicsBounds.find(
        (g: ReturnType<typeof JSON.parse>) => g.imageHash === 'source-0-0-0'
      ).imageHash
    if (reason === 'duplicate-all-hashes')
      for (const g of f.page.graphicsBounds) if (g.kind === 'image') g.imageHash = 'same-source'
    if (reason === 'foreign-paint')
      f.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.2, 0.22, 0.23] })
    if (reason === 'oversized-carrier') f.page.graphicsBounds[0].normalizedRect[0] = 0.01
    if (reason === 'missing-header')
      f.nativeTokens = f.nativeTokens.filter(
        (t: ReturnType<typeof JSON.parse>) => t.text !== 'Header1'
      )
    if (reason === 'clipped-header') f.nativeTokens[0].rect[3] -= 1
    if (reason === 'nonfinite-baseline') f.nativeTokens[0].baseline = NaN
    if (reason === 'missing-group-font')
      f.nativeTokens = f.nativeTokens.filter(
        (t: ReturnType<typeof JSON.parse>) => t.text !== 'Group1'
      )
    if (reason === 'missing-key')
      f.page.graphicsBounds = f.page.graphicsBounds.filter(
        (g: ReturnType<typeof JSON.parse>) => g.imageHash !== 'source-key'
      )
    if (reason === 'foreign-caption')
      f.captions.push({ page: 1, lines: ['Figure 11. Another owner.'], rect: [100, 100, 450, 110] })
    if (reason === 'foreign-table') f.tableRects.push([100, 100, 450, 200])
    if (reason === 'unknown-font') f.nativeTokens[0].height = 0
    expect(shallowResult(f)?.graphicsCount).not.toBe(37)
  }
)

const denseVectorPage = (count: number): ReturnType<typeof JSON.parse> => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  invalidGraphicsBounds: 0,
  lines: [],
  graphicsBounds: [
    ...Array.from({ length: count }, (_, index) => ({
      kind: 'path',
      normalizedRect: [0.15 + index * 1e-9, 0.2, 0.1501 + index * 1e-9, 0.2001]
    })),
    { kind: 'path', normalizedRect: [0.1, 0.1, 0.9, 0.5] }
  ]
})

it('conserves a dense native vector plate beyond the runtime argument limit', () => {
  const captions = [
    { page: 1, lines: ['Figure 3. Native vector comparison.'], rect: [60, 430, 540, 440] }
  ]
  const expected = associateFigures(denseVectorPage(120), captions)
  const page = denseVectorPage(300_000)
  const [figure] = associateFigures(page, captions)
  expect(figure.rect).toEqual(expected[0].rect)
  expect(figure.rect).toBeDefined()
  expect(figure.issue).toBeUndefined()
  expect(page.graphicsBounds).toHaveLength(300_001)
  expect(page.graphicsBounds.at(-1).normalizedRect).toEqual([0.1, 0.1, 0.9, 0.5])
})

it.each([30, 700])(
  'keeps dense listing paths rejected at caption position %s without a runtime overflow',
  (top) => {
    // Retain the argument-overflow regression without repeating the 300k positive stress case.
    const page = denseVectorPage(160_000)
    page.graphicsBounds.pop()
    page.lines = Array.from({ length: 60 }, (_, index) => ({
      text: `Instruction ${index} contains enough ordinary words to prove a continuous prose listing.`,
      x: 60,
      y: 80 + index * 10,
      width: 480,
      height: 8,
      fontSize: 8
    }))
    page.graphicsBounds.push(
      ...Array.from({ length: 24 }, (_, index) => ({
        kind: 'path',
        normalizedRect: [0.1 + index * 0.03, 0.1, 0.105 + index * 0.03, 0.24]
      })),
      ...Array.from({ length: 24 }, (_, index) => ({
        kind: 'path',
        normalizedRect: [0.1, 0.1 + index * 0.025, 0.88, 0.105 + index * 0.025]
      }))
    )
    const [figure] = associateFigures(page, [
      { page: 1, lines: ['Figure 2. Listing block.'], rect: [60, top, 540, top + 15] }
    ])
    expect(figure.rect).toBeUndefined()
    expect(figure.issue).toBe('text-dominant-graphics')
  }
)

it('keeps the complete native ink boundary when excluding prose before a dense plate', () => {
  const page = denseVectorPage(300_000)
  page.graphicsBounds = page.graphicsBounds.map((g: ReturnType<typeof JSON.parse>) => ({
    ...g,
    normalizedRect: [g.normalizedRect[0] + 0.05, 0.2, g.normalizedRect[0] + 0.07, 0.22]
  }))
  page.lines = [
    {
      text: 'Before the chart, an independent sentence explains ',
      x: 60,
      y: 120,
      width: 230,
      height: 12,
      fontSize: 12
    },
    {
      text: 'the surrounding source paragraph.',
      x: 290,
      y: 120,
      width: 250,
      height: 12,
      fontSize: 12
    },
    {
      text: 'Figure 3. Native vector comparison.',
      x: 100,
      y: 510,
      width: 300,
      height: 10,
      fontSize: 8
    }
  ]
  const caption = { page: 1, lines: [page.lines[2].text], rect: [100, 510, 400, 520] }
  const figure = { caption, rect: [100, 120, 400, 500] }
  const result = excludeOwnedFigurePriorProse(page, figure, [caption])
  expect(result.rect).toEqual([100, 160, 400, 500])
  expect(result.excludedProseLines).toEqual(page.lines.slice(0, 2))
  expect(figure.rect).toEqual([100, 120, 400, 500])
})
const figures = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse>[] =>
  associateFigures(f.page, f.captions, f.tableRects, f.rules, f.closedFrames, f.nativeTokens)
const framedRasterBands = (): ReturnType<typeof JSON.parse> => {
  const page: {
      pageNumber: number
      width: number
      height: number
      lines: ReturnType<typeof JSON.parse>[]
      graphicsBounds: ReturnType<typeof JSON.parse>[]
    } = { pageNumber: 1, width: 600, height: 800, lines: [], graphicsBounds: [] },
    caption = {
      page: 1,
      lines: ['Figure 4: Three framed raster comparisons.'],
      rect: [75, 385, 525, 395]
    },
    frames = [100, 195, 290].map((top) => [80, top, 520, top + 90])
  page.lines.push({ text: caption.lines[0], x: 75, y: 385, width: 450, height: 10, fontSize: 10 })
  for (const [n, frame] of frames.entries()) {
    page.lines.push({
      text: ['Upper comparison', 'Middle comparison', 'Lower comparison'][n],
      x: 95,
      y: frame[1] + 4,
      width: 90,
      height: 6,
      fontSize: 6
    })
    for (const [k, rect] of [
      [95, frame[1] + 15, 225, frame[3] - 8],
      [255, frame[1] + 15, 505, frame[3] - 8]
    ].entries()) {
      page.graphicsBounds.push({
        kind: 'image',
        imageHash: `band-${n}-plate-${k}`,
        normalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600)),
        paintedNormalizedRect: rect.map((v, i) => v / (i % 2 ? 800 : 600))
      })
    }
  }
  return { page, caption, captions: [caption], frames }
}

const singletonRasterStack = (): ReturnType<typeof JSON.parse> => {
  const rows = [
    'Figure 3. A bounded repeated raster comparison.',
    'The three source rows contain distinct complete views.',
    'The insets and metrics are printed inside each image.',
    'All comparisons use the same caption and source lane.',
    'The final sentence closes the source description.'
  ]
  const caption = { page: 1, lines: rows, rect: [110, 620, 510, 678] }
  const painted = [
    [110, 122, 502, 269],
    [110, 306, 502, 437],
    [110, 473, 502, 610]
  ]
  return {
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: rows.map((text, index) => ({
        text,
        x: 110,
        y: 620 + index * 12,
        width: 398,
        height: 10,
        fontSize: 10
      })),
      graphicsBounds: painted.map((rect, index) => ({
        kind: 'image',
        operationIndex: 10 + index * 10,
        imageHash: ['a', 'b', 'c'][index].repeat(64),
        normalizedRect: [rect[0] - 1, rect[1] - 2, rect[2] + 2, rect[3] + 2].map(
          (value, axis) => value / (axis % 2 ? 800 : 600)
        ),
        paintedNormalizedRect: rect.map((value, axis) => value / (axis % 2 ? 800 : 600))
      }))
    },
    captions: [caption],
    tableRects: [],
    rules: [],
    closedFrames: [],
    nativeTokens: []
  }
}

it('recovers three complete singleton raster rows without manufacturing tile ownership', () => {
  const f = singletonRasterStack()
  const before = structuredClone(f)
  const result = nativeCaptionedRepeatedRasterRows(f.page, f.captions[0], f.captions, f.tableRects)
  expect(result?.rect).toEqual([expect.closeTo(110, 10), 122, 502, 610])
  expect(result?.graphicsCount).toBe(3)
  expect(f).toEqual(before)
})

it('completes the actual association consumer beyond the nearest singleton raster', () => {
  const f = singletonRasterStack()
  const result = figures(f)
  expect(result).toHaveLength(1)
  expect(result[0].rect).toEqual([expect.closeTo(110, 10), 122, 502, 610])
  expect(result[0].caption).toEqual(f.captions[0])
  expect(result[0].graphicsCount).toBe(3)
})

it.each([
  'missing-image',
  'unmeasured-paint',
  'duplicate-image',
  'clipped-font',
  'foreign-gap-prose',
  'foreign-path',
  'competing-caption',
  'table-crossing',
  'wide-gap',
  'misaligned-row',
  'wrong-caption-page'
])('refuses a singleton raster stack without complete independent source proof: %s', (reason) => {
  const f = singletonRasterStack()
  if (reason === 'missing-image') f.page.graphicsBounds.splice(1, 1)
  if (reason === 'unmeasured-paint') delete f.page.graphicsBounds[0].paintedNormalizedRect
  if (reason === 'duplicate-image')
    f.page.graphicsBounds[1].imageHash = f.page.graphicsBounds[0].imageHash
  if (reason === 'clipped-font') f.page.lines[0].height -= 1
  if (reason === 'foreign-gap-prose')
    f.page.lines.push({
      text: 'An independent paragraph occupies this source gutter.',
      x: 110,
      y: 281,
      width: 390,
      height: 10,
      fontSize: 10
    })
  if (reason === 'foreign-path')
    f.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.35, 0.8, 0.4] })
  if (reason === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
  if (reason === 'table-crossing') f.tableRects.push([115, 310, 490, 410])
  if (reason === 'wide-gap' || reason === 'misaligned-row') {
    const axis = reason === 'wide-gap' ? 1 : 0
    for (const field of ['normalizedRect', 'paintedNormalizedRect']) {
      f.page.graphicsBounds[0][field][axis] -= 0.05
      f.page.graphicsBounds[0][field][axis + 2] -= 0.05
    }
  }
  if (reason === 'wrong-caption-page') f.captions[0].page = 2
  expect(
    nativeCaptionedRepeatedRasterRows(f.page, f.captions[0], f.captions, f.tableRects)
  ).toBeUndefined()
})

it('ignores an equal-coordinate caption on another page for the complete singleton plate', () => {
  const f = singletonRasterStack()
  f.captions.push({ ...structuredClone(f.captions[0]), page: 2 })
  expect(
    nativeCaptionedRepeatedRasterRows(f.page, f.captions[0], f.captions, f.tableRects)?.rect
  ).toEqual([expect.closeTo(110, 10), 122, 502, 610])
})
it('conserves three independently closed bands and their six actual raster children', () => {
  const f = framedRasterBands(),
    before = structuredClone(f),
    result = nativeCaptionedRasterFrameBands(f.page, f.caption, f.captions, [], f.frames)
  expect(result?.rect).toEqual([80, 100, 520, 380])
  expect(result?.graphicsCount).toBe(6)
  expect(f).toEqual(before)
})
it.each([
  'missing-frame',
  'unpainted-raster',
  'duplicate-raster',
  'missing-child',
  'extra-child',
  'missing-title',
  'foreign-title-font',
  'crossing-glyph',
  'misaligned',
  'wide-gap',
  'foreign-caption',
  'foreign-table',
  'foreign-prose',
  'wrong-page',
  'extra-frame',
  'raster-crosses-frame'
])('requires complete framed raster-band source proof: %s', (reason) => {
  const f = framedRasterBands(),
    tables: number[][] = []
  if (reason === 'missing-frame') f.frames.shift()
  if (reason === 'unpainted-raster') delete f.page.graphicsBounds[0].paintedNormalizedRect
  if (reason === 'duplicate-raster')
    f.page.graphicsBounds[0].imageHash = f.page.graphicsBounds[1].imageHash
  if (reason === 'missing-child') f.page.graphicsBounds.shift()
  if (reason === 'extra-child')
    f.page.graphicsBounds.push({ ...f.page.graphicsBounds[0], imageHash: 'foreign-raster' })
  if (reason === 'missing-title') f.page.lines.splice(1, 1)
  if (reason === 'foreign-title-font') f.page.lines[1].fontSize = 12
  if (reason === 'crossing-glyph') f.page.lines[1].width = 430
  if (reason === 'misaligned') f.frames[0][2] -= 25
  if (reason === 'wide-gap') {
    f.frames[0][1] -= 30
    f.frames[0][3] -= 30
  }
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 5: Other owner.'], rect: [90, 192, 500, 204] })
  if (reason === 'foreign-table') tables.push([90, 192, 500, 204])
  if (reason === 'foreign-prose')
    f.page.lines.push({
      text: 'A separate article paragraph lies between the independent framed plates.',
      x: 90,
      y: 191,
      width: 410,
      height: 10,
      fontSize: 10
    })
  if (reason === 'wrong-page') f.caption.page = 2
  if (reason === 'extra-frame') f.frames.push([80, 150, 520, 180])
  if (reason === 'raster-crosses-frame')
    f.page.graphicsBounds[0].paintedNormalizedRect[0] = 79 / 600
  expect(
    nativeCaptionedRasterFrameBands(f.page, f.caption, f.captions, tables, f.frames)
  ).toBeUndefined()
})
it('conserves every painted face and native lower title in an independently keyed raster triple', () => {
  const f = input(16),
    [figure] = figures(f)
  expect(figures(f)).toHaveLength(1)
  expect(figure.caption).toEqual(f.captions[0])
  expect(figure.graphicsCount).toBe(3)
  expect(figure.issue).toBeUndefined()
  const source = [
    ...f.page.graphicsBounds.map((g: ReturnType<typeof JSON.parse>) =>
      g.paintedNormalizedRect.map(
        (v: number, n: number) => v * (n % 2 ? f.page.height : f.page.width)
      )
    ),
    ...f.nativeTokens.slice(0, 3).map((t: ReturnType<typeof JSON.parse>) => t.rect)
  ]
  for (const rect of source) {
    expect(figure.rect[0]).toBeLessThanOrEqual(rect[0])
    expect(figure.rect[1]).toBeLessThanOrEqual(rect[1])
    expect(figure.rect[2]).toBeGreaterThanOrEqual(rect[2])
    expect(figure.rect[3]).toBeGreaterThanOrEqual(rect[3])
  }
  expect(f.tableRects).toEqual([[124, 541.3333333333334, 485.3333333333333, 592]])
})
it.each([
  'missing-key',
  'repeated-key',
  'swapped-key',
  'crossing-gutter',
  'different-baseline',
  'invalid-descent',
  'missing-paint',
  'duplicate-image',
  'fourth-image',
  'foreign-caption',
  'foreign-table',
  'foreign-native',
  'foreign-paint',
  'foreign-owner',
  'wrong-page',
  'detached-plate',
  'caption-off-center',
  'unmatched-native-line',
  'missing-row-font',
  'title-ink-crosses-caption'
])(
  'requires complete three-key source qualification before recovering side rasters: %s',
  (reason) => {
    const f = input(16),
      owners: number[][] = []
    if (reason === 'missing-key') f.nativeTokens[2].text = 'Upper range comparison.'
    if (reason === 'repeated-key') f.nativeTokens[2].text = '(b) Upper range comparison.'
    if (reason === 'swapped-key') {
      f.nativeTokens[0].text = '(c) Lower curve.'
      f.nativeTokens[2].text = '(a) Upper range comparison.'
    }
    if (reason === 'crossing-gutter') f.nativeTokens[0].rect[2] = 241
    if (reason === 'different-baseline') f.nativeTokens[2].baseline -= 2
    if (reason === 'invalid-descent') delete f.nativeTokens[1].fontDescent
    if (reason === 'missing-paint') delete f.page.graphicsBounds[2].paintedNormalizedRect
    if (reason === 'duplicate-image')
      f.page.graphicsBounds[2].imageHash = f.page.graphicsBounds[0].imageHash
    if (reason === 'fourth-image')
      f.page.graphicsBounds.push({ ...f.page.graphicsBounds[0], imageHash: 'fourth-raster' })
    if (reason === 'foreign-caption')
      f.captions.push({ page: 1, rect: [380, 335, 499, 348], lines: ['Figure 7: Other panel.'] })
    if (reason === 'foreign-table') f.tableRects.push([380, 230, 496, 300])
    if (reason === 'foreign-native')
      f.nativeTokens.push({
        text: 'Independent body',
        rect: [230, 240, 237, 248],
        baseline: 248,
        height: 8,
        fontDescent: -0.2,
        horizontal: true
      })
    if (reason === 'foreign-paint')
      f.page.graphicsBounds.push({
        kind: 'path',
        normalizedRect: [230 / 612, 240 / 792, 237 / 612, 248 / 792]
      })
    if (reason === 'foreign-owner') owners.push([380, 222, 496, 333])
    if (reason === 'wrong-page') f.captions[0].page = 2
    if (reason === 'detached-plate') f.page.graphicsBounds[2].paintedNormalizedRect[1] += 0.03
    if (reason === 'caption-off-center') f.captions[0].rect[0] += 50
    if (reason === 'unmatched-native-line') f.page.lines[0].text += ' Extra.'
    if (reason === 'missing-row-font') delete f.page.lines[0].fontSize
    if (reason === 'title-ink-crosses-caption') f.nativeTokens[1].fontDescent = -1
    expect(
      nativeCaptionedAlignedRasterPair(
        f.page,
        f.captions[0],
        f.captions,
        f.tableRects,
        owners,
        f.nativeTokens,
        f.closedFrames
      )
    ).toBeUndefined()
  }
)
it('does not admit terminal title periods in the existing two-key branch', () => {
  const f = input(14)
  f.nativeTokens[1].text += '.'
  f.nativeTokens[2].text += '.'
  f.page.lines[0].text = '(a) First group. (b) Second group.'
  expect(
    nativeCaptionedAlignedRasterPair(
      f.page,
      f.captions[0],
      f.captions,
      f.tableRects,
      [],
      f.nativeTokens,
      f.closedFrames
    )
  ).toBeUndefined()
})
it('recovers one short caption for two fully painted rasters with complete native panel keys', () => {
  const f = input(14),
    [figure] = figures(f)
  expect(figure.caption).toEqual(f.captions[0])
  expect(figure.graphicsCount).toBe(2)
  expect(figure.rect).toEqual([150, 350, 450, 489])
  expect(figure.issue).toBeUndefined()
  expect(figures(f)).toHaveLength(1)
})
it('conserves an overlapping native accent fragment in the complete lower panel title', () => {
  const f = input(14)
  f.nativeTokens[0].text = '(a) Firs˝'
  f.nativeTokens[1].text = 't group'
  f.page.lines[0].text = '(a) Firs˝t group (b) Second group'
  expect(figures(f)[0].rect).toEqual([150, 350, 450, 489])
})
it.each([
  'missing-key',
  'repeated-key',
  'swapped-keys',
  'crossing-gutter',
  'different-font',
  'different-baseline',
  'invalid-descent',
  'invalid-source-graphics',
  'missing-row-font',
  'detached-title',
  'title-ink-crosses-caption',
  'third-raster',
  'duplicate-image',
  'foreign-native',
  'foreign-paint',
  'foreign-caption',
  'foreign-table',
  'foreign-owner',
  'different-page-owner'
])('requires the complete independent lower-keyed raster-pair proof: %s', (reason) => {
  const f = input(14)
  if (reason === 'missing-key') f.nativeTokens[2].text = 'Second group'
  if (reason === 'repeated-key') f.nativeTokens[2].text = '(a) Second group'
  if (reason === 'swapped-keys') {
    f.nativeTokens[0].text = '(b) First'
    f.nativeTokens[2].text = '(a) Second group'
  }
  if (reason === 'crossing-gutter') f.nativeTokens[1].rect[2] = 335
  if (reason === 'different-font') f.nativeTokens[2].height = 5
  if (reason === 'different-baseline') f.nativeTokens[2].baseline -= 2
  if (reason === 'invalid-descent') f.nativeTokens[2].fontDescent = NaN
  if (reason === 'invalid-source-graphics') f.page.invalidGraphicsBounds = 1
  if (reason === 'missing-row-font') delete f.page.lines[0].fontSize
  if (reason === 'detached-title') {
    f.nativeTokens.forEach((t: ReturnType<typeof JSON.parse>, n: number) => {
      if (n > 2) return
      t.rect[1] -= 15
      t.rect[3] -= 15
      t.baseline -= 15
    })
    f.page.lines[0].y -= 15
  }
  if (reason === 'title-ink-crosses-caption') {
    f.nativeTokens.forEach((t: ReturnType<typeof JSON.parse>, n: number) => {
      if (n > 2) return
      t.rect[1] += 6
      t.rect[3] += 6
      t.baseline += 6
      t.fontDescent = -1
    })
    f.page.lines[0].y += 6
  }
  if (reason === 'third-raster')
    f.page.graphicsBounds.push({
      kind: 'image',
      imageHash: 'third-raster',
      normalizedRect: [0.47, 0.44, 0.53, 0.55],
      paintedNormalizedRect: [0.47, 0.44, 0.53, 0.55]
    })
  if (reason === 'duplicate-image') f.page.graphicsBounds[1].imageHash = 'first-raster'
  if (reason === 'foreign-native')
    f.nativeTokens.push({
      text: 'unrelated',
      rect: [280, 480, 320, 489],
      horizontal: true,
      baseline: 489,
      height: 9,
      fontDescent: -0.2
    })
  if (reason === 'foreign-paint')
    f.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.48, 0.5, 0.52, 0.58] })
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, rect: [280, 475, 320, 495], lines: ['Figure 2: Separate.'] })
  if (reason === 'foreign-table') f.tableRects.push([280, 475, 320, 495])
  if (reason === 'different-page-owner') f.captions[0].page = 2
  expect(
    nativeCaptionedAlignedRasterPair(
      f.page,
      f.captions[0],
      f.captions,
      f.tableRects,
      reason === 'foreign-owner' ? [[150, 350, 270, 470]] : [],
      f.nativeTokens,
      f.closedFrames
    )
  ).toBeUndefined()
})
it('ignores equal-coordinate captions on other pages for the native lower-keyed pair', () => {
  const f = input(14)
  f.captions.push({ page: 2, rect: [280, 475, 320, 495], lines: ['Figure 2: Separate.'] })
  expect(figures(f)[0].rect).toEqual([150, 350, 450, 489])
})
it('completes the full perpendicular native axis pair of an already owned whole raster', () => {
  const f = input(15),
    records = figures(f)
  expect(records).toHaveLength(2)
  expect(records[0].rect).toEqual(
    f.page.graphicsBounds[0].paintedNormalizedRect.map(
      (v: number, n: number) => v * (n % 2 ? f.page.height : f.page.width)
    )
  )
  expect(records[0].caption).toEqual(f.captions[0])
  expect(records[1].rect).toEqual([315, 80, 550, 234])
  expect(records[1].caption).toEqual(f.captions[1])
  expect(
    nativeOwnedFigureBottomLabels(
      f.page,
      f.captions[1],
      f.captions,
      f.tableRects,
      [330, 80, 550, 220],
      [],
      f.nativeTokens
    )
  ).toEqual([
    [315, 125, 324, 160],
    [430, 225, 458, 234]
  ])
})
it.each([
  'no-raster',
  'partial-raster',
  'ambiguous-raster',
  'missing-side',
  'missing-bottom',
  'wrong-side-rotation',
  'off-center-bottom',
  'invalid-descent',
  'invalid-baseline',
  'large-type',
  'duplicate-side',
  'caption-crossing-descent',
  'missing-line-font',
  'foreign-native',
  'foreign-line',
  'foreign-paint',
  'foreign-caption',
  'foreign-table',
  'foreign-owner',
  'different-page-owner'
])('requires a unique full raster and clear independently paired native axes: %s', (reason) => {
  const f = input(15),
    rect = [330, 80, 550, 220]
  if (reason === 'no-raster') f.page.graphicsBounds.pop()
  if (reason === 'partial-raster') rect[2] = 470
  if (reason === 'ambiguous-raster') f.page.graphicsBounds.push({ ...f.page.graphicsBounds[1] })
  if (reason === 'missing-side') f.nativeTokens.shift()
  if (reason === 'missing-bottom') f.nativeTokens.splice(1, 1)
  if (reason === 'wrong-side-rotation') f.nativeTokens[0].horizontal = true
  if (reason === 'off-center-bottom') f.nativeTokens[1].rect = [335, 225, 363, 234]
  if (reason === 'invalid-descent') f.nativeTokens[1].fontDescent = NaN
  if (reason === 'invalid-baseline') f.nativeTokens[1].baseline += 2
  if (reason === 'large-type') f.nativeTokens[0].height = 15
  if (reason === 'duplicate-side') f.nativeTokens.push({ ...f.nativeTokens[0] })
  if (reason === 'caption-crossing-descent') f.nativeTokens[1].fontDescent = -1
  if (reason === 'missing-line-font') delete f.page.lines[3].fontSize
  if (reason === 'foreign-native')
    f.nativeTokens.push({
      text: 'unrelated',
      rect: [320, 180, 329, 189],
      height: 9,
      horizontal: true,
      baseline: 189,
      fontDescent: -0.2
    })
  if (reason === 'foreign-line')
    f.page.lines.push({ text: 'unrelated', x: 320, y: 180, width: 9, height: 9, fontSize: 9 })
  if (reason === 'foreign-paint')
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [320 / 600, 180 / 800, 329 / 600, 189 / 800]
    })
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, rect: [320, 180, 329, 189], lines: ['Figure 3: Separate.'] })
  if (reason === 'foreign-table') f.tableRects.push([320, 180, 329, 189])
  if (reason === 'different-page-owner') f.captions[1].page = 2
  expect(
    nativeOwnedFigureBottomLabels(
      f.page,
      f.captions[1],
      f.captions,
      f.tableRects,
      rect,
      [],
      f.nativeTokens,
      () => reason === 'foreign-owner'
    )
  ).toEqual([])
})
it('ignores different-page barriers when completing native raster axes', () => {
  const f = input(15)
  f.captions.push({ page: 2, rect: [320, 180, 329, 189], lines: ['Figure 3: Separate.'] })
  expect(figures(f)[1].rect).toEqual([315, 80, 550, 234])
})
it.each([
  'unowned-row',
  'crossing-row',
  'descent-crossing-frame',
  'foreign-paint',
  'foreign-image',
  'foreign-owner',
  'two-rows'
])(
  'requires complete existing native ownership and a clear painted completion strip: %s',
  (reason) => {
    const f = input(13),
      [figure] = associateFigures(f.page, f.captions, [], [], [], f.nativeTokens)
    if (reason === 'unowned-row') figure.rect[3] -= 3
    if (reason === 'crossing-row')
      f.nativeTokens.push({
        text: 'unrelated',
        horizontal: true,
        rect: [455, 220, 470, 225],
        baseline: 225,
        height: 5,
        fontDescent: -0.2
      })
    if (reason === 'descent-crossing-frame')
      f.nativeTokens.find(
        (t: ReturnType<typeof JSON.parse>) => t.rect[1] > 211 && t.rect[1] < 220
      ).fontDescent = -1
    if (reason === 'foreign-paint' || reason === 'foreign-image')
      f.page.graphicsBounds.push({
        kind: reason === 'foreign-paint' ? 'path' : 'image',
        normalizedRect: [
          120 / f.page.width,
          221 / f.page.height,
          150 / f.page.width,
          224 / f.page.height
        ]
      })
    if (reason === 'two-rows')
      f.page.lines = f.page.lines.filter(
        (l: ReturnType<typeof JSON.parse>) => l.y < 202 || l.y > 220
      )
    expect(
      nativeOwnedAnnotationFrame(
        f.page,
        figure,
        f.captions,
        [],
        f.closedFrames,
        f.nativeTokens,
        () => reason === 'foreign-owner'
      )
    ).toBeUndefined()
  }
)
it('retains the complete unique closed frame around already owned native annotation rows', () => {
  const f = input(13),
    [figure] = figures(f)
  expect(figure.rect[3]).toBeGreaterThanOrEqual(f.closedFrames[0][3])
  expect(figure.rect[3]).toBeLessThan(f.captions[0].rect[1])
  expect(figures(f)).toHaveLength(1)
})
it('ignores equal-coordinate captions on a different page when completing an owned annotation frame', () => {
  const f = input(13)
  f.captions.push({
    page: 2,
    lines: ['Figure 2. Separate annotation.'],
    rect: [120, 220, 200, 225]
  })
  expect(figures(f)[0].rect[3]).toBeGreaterThanOrEqual(f.closedFrames[0][3])
})
it.each([
  'no-frame',
  'competing-frame',
  'foreign-caption',
  'foreign-table',
  'no-font',
  'duplicate-carrier'
])(
  'preserves the original owner without a complete unique annotation-frame witness: %s',
  (reason) => {
    const f = input(13),
      bottom = f.closedFrames[0][3]
    if (reason === 'no-frame') f.closedFrames = []
    if (reason === 'competing-frame') f.closedFrames.push([101, 182, 459, 225])
    if (reason === 'foreign-caption')
      f.captions.push({
        page: 1,
        lines: ['Figure 2. Separate annotation.'],
        rect: [120, 220, 200, 225]
      })
    if (reason === 'foreign-table') f.tableRects.push([120, 220, 200, 225])
    if (reason === 'no-font')
      f.nativeTokens.forEach((t: ReturnType<typeof JSON.parse>) => {
        delete t.fontDescent
      })
    if (reason === 'duplicate-carrier') {
      const g = f.page.graphicsBounds.find(
        (g: ReturnType<typeof JSON.parse>) =>
          g.normalizedRect[1] > 0.23 && g.normalizedRect[3] < 0.3
      )
      f.page.graphicsBounds.push(structuredClone(g))
    }
    expect(figures(f)[0]?.rect?.[3] ?? 0).toBeLessThan(bottom)
  }
)
const nativeTimeline = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['Figure 3. An annotated action timeline.'],
    rect: [50, 290, 550, 300]
  }
  return {
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      graphicsBounds: [
        { kind: 'path', normalizedRect: [65 / 600, 247 / 800, 535 / 600, 254 / 800] }
      ],
      lines: [
        { text: caption.lines[0], x: 50, y: 290, width: 500, height: 10, fontSize: 10 },
        { text: 'time', x: 280, y: 253, width: 35, height: 14, fontSize: 14 }
      ]
    },
    figure: { caption, rect: [90, 80, 535, 267] },
    captions: [caption],
    rules: [[66, 249, 530, 249]]
  }
}
it('completes a uniquely painted timeline stem tied to its owned native time label', () => {
  const f = nativeTimeline()
  expect(nativeOwnedTimelineStroke(f.page, f.figure, f.captions, [], f.rules)).toEqual([
    65, 80, 535, 267
  ])
})
it.each([
  'no-time',
  'different-caption',
  'competing-rule',
  'missing-source',
  'foreign-caption',
  'foreign-table',
  'numeric-axis'
])('does not extend an unproved timeline stem: %s', (reason) => {
  const f = nativeTimeline()
  if (reason === 'no-time') f.page.lines.pop()
  if (reason === 'different-caption') f.figure.caption.lines = ['Figure 3. An unrelated plot.']
  if (reason === 'competing-rule') f.rules.push([66, 248, 530, 248])
  if (reason === 'missing-source') f.rules = []
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 4. Separate.'], rect: [60, 245, 80, 260] })
  if (reason === 'numeric-axis')
    f.page.lines.push({ text: '0 1 2 3 4', x: 160, y: 253, width: 110, height: 8, fontSize: 8 })
  expect(
    nativeOwnedTimelineStroke(
      f.page,
      f.figure,
      f.captions,
      reason === 'foreign-table' ? [[60, 245, 80, 260]] : [],
      f.rules
    )
  ).toBeUndefined()
})
const priorFragmentedProse = (): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['Figure 3. Owned response curves.'],
    rect: [80, 500, 520, 510]
  }
  return {
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      graphicsBounds: [
        {
          kind: 'image',
          imageHash: 'anonymous-response',
          normalizedRect: [330 / 600, 350 / 800, 440 / 600, 470 / 800]
        },
        { kind: 'path', normalizedRect: [200 / 600, 350 / 800, 270 / 600, 420 / 800] }
      ],
      lines: [
        { text: 'At the measured state, ', x: 70, y: 300, width: 155, height: 12, fontSize: 12 },
        { text: 'x', x: 225, y: 300, width: 8, height: 12, fontSize: 12 },
        { text: '*', x: 233, y: 299, width: 4, height: 8, fontSize: 8 },
        {
          text: '= u, which gives a strictly increasing response.',
          x: 238,
          y: 300,
          width: 300,
          height: 12,
          fontSize: 12
        },
        { text: 'x1', x: 220, y: 350, width: 15, height: 8, fontSize: 8 },
        { text: caption.lines[0], x: 80, y: 500, width: 440, height: 10, fontSize: 10 }
      ]
    },
    figure: { caption, rect: [200, 299, 450, 480] }
  }
}
it('excludes a full-width fragmented native prose/formula sentence before a separate owned plate', () => {
  const f = priorFragmentedProse(),
    result = excludeOwnedFigurePriorProse(f.page, f.figure, [f.figure.caption], [])
  expect(result.rect[1]).toBe(350)
  expect(result.excludedProseLines).toHaveLength(4)
})
it.each([
  'inside-plate',
  'short-axis',
  'different-font',
  'missing-font',
  'incomplete-sentence',
  'foreign-table'
])('preserves a native row without strict prior prose ownership: %s', (reason) => {
  const f = priorFragmentedProse()
  if (reason === 'inside-plate') f.page.graphicsBounds[0].normalizedRect[1] = 290 / 800
  if (reason === 'missing-font') delete f.page.lines[0].fontSize
  if (reason === 'short-axis') f.page.lines = f.page.lines.slice(1)
  if (reason === 'different-font')
    f.page.lines.slice(0, 4).forEach((l: ReturnType<typeof JSON.parse>) => {
      l.fontSize = 8
    })
  if (reason === 'incomplete-sentence') f.page.lines[3].text = f.page.lines[3].text.slice(0, -1)
  expect(
    excludeOwnedFigurePriorProse(
      f.page,
      f.figure,
      [f.figure.caption],
      reason === 'foreign-table' ? [[65, 295, 545, 320]] : []
    ).rect
  ).toEqual(f.figure.rect)
})
it('completes the partially owned native title enclosed by its raster title strip', () => {
  const f = titledRasterRow(2)
  f.page.lines = [
    { text: 'An anonymous measured system', x: 120, y: 195, width: 350, height: 10, fontSize: 10 },
    f.page.lines.at(-2)
  ]
  f.tokens = [
    { text: f.page.lines[0].text, rect: [120, 195, 470, 205], height: 10, horizontal: true }
  ]
  f.page.graphicsBounds = [
    {
      kind: 'image',
      imageHash: 'anonymous-title-strip',
      normalizedRect: [110 / 600, 190 / 800, 480 / 600, 215 / 800]
    }
  ]
  expect(
    nativeOwnedFigureTopLabel(f.page, f.caption, [f.caption], [], [80, 200, 520, 330], f.tokens)
  ).toEqual([120, 195, 470, 205])
  expect(
    nativeOwnedFigureTopLabel(
      f.page,
      f.caption,
      [f.caption, { page: 2, lines: ['Figure 9. A different page.'], rect: [175, 190, 240, 200] }],
      [],
      [80, 200, 520, 330],
      f.tokens
    )
  ).toEqual([120, 195, 470, 205])
})
it.each([
  'no-enclosing-raster',
  'outside-owner',
  'foreign-caption',
  'foreign-table',
  'different-source',
  'paragraph'
])('declines an unproved native title font extension: %s', (reason) => {
  const f = titledRasterRow(2)
  f.page.lines = [
    { text: 'An anonymous measured system', x: 120, y: 195, width: 350, height: 10, fontSize: 10 },
    f.page.lines.at(-2)
  ]
  f.tokens = [
    { text: f.page.lines[0].text, rect: [120, 195, 470, 205], height: 10, horizontal: true }
  ]
  f.page.graphicsBounds = [
    {
      kind: 'image',
      imageHash: 'anonymous-title-strip',
      normalizedRect: [110 / 600, 190 / 800, 480 / 600, 215 / 800]
    }
  ]
  if (reason === 'no-enclosing-raster') f.page.graphicsBounds[0].kind = 'path'
  if (reason === 'outside-owner') f.tokens[0].rect[0] = 50
  if (reason === 'different-source') f.tokens[0].text = 'Unrelated source text'
  if (reason === 'paragraph') f.page.lines[0].text += '.'
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 3. Separate.'], rect: [175, 190, 240, 200] })
  expect(
    nativeOwnedFigureTopLabel(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[175, 190, 240, 200]] : [],
      [80, 200, 520, 330],
      f.tokens
    )
  ).toBeUndefined()
})
const titledRasterRow = (count = 2): ReturnType<typeof JSON.parse> => {
  const caption = {
    page: 1,
    lines: ['Figure 2. Comparison of measured distributions.'],
    rect: [80, 360, 520, 370]
  }
  const previous = {
    page: 1,
    lines: ['Figure 1. Independent upper plate.'],
    rect: [80, 130, 520, 140]
  }
  const tokens = [
    {
      text: 'Distribution of measured categories',
      rect: [155, 178, 445, 188],
      height: 10,
      horizontal: true
    }
  ]
  const images = Array.from({ length: count }, (_, n) => ({
    kind: 'image',
    imageHash: `anonymous-panel-${n}`,
    normalizedRect: [
      (80 + (n * 440) / count) / 600,
      200 / 800,
      (80 + ((n + 1) * 440) / count) / 600,
      330 / 800
    ]
  }))
  images.push({
    kind: 'image',
    imageHash: 'anonymous-independent-upper',
    normalizedRect: [80 / 600, 60 / 800, 520 / 600, 120 / 800]
  })
  for (let n = 0; n < count; n++)
    tokens.push({
      text: `Model ${String.fromCharCode(65 + n)}`,
      rect: [90 + (n * 440) / count, 334, 145 + (n * 440) / count, 342],
      height: 8,
      horizontal: true
    })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds: images,
    lines: [
      { text: tokens[0].text, x: 155, y: 178, width: 290, height: 10, fontSize: 10 },
      {
        text: tokens
          .slice(1)
          .map((t: ReturnType<typeof JSON.parse>) => t.text)
          .join(''),
        x: 90,
        y: 334,
        width: 55 + ((count - 1) * 440) / count,
        height: 8,
        fontSize: 8
      },
      { text: caption.lines[0], x: 80, y: 360, width: 440, height: 10, fontSize: 10 },
      { text: previous.lines[0], x: 80, y: 130, width: 440, height: 10, fontSize: 10 }
    ]
  }
  return { page, caption, captions: [previous, caption], tokens }
}
it.each([2, 3])(
  'retains all %s same-caption rasters with their native common title and panel labels',
  (count) => {
    const f = titledRasterRow(count),
      r = nativeCaptionedAlignedRasterPair(f.page, f.caption, f.captions, [], [], f.tokens)
    expect(r?.rect).toEqual([80, 178, 520, 342])
  }
)
it('retains a uniquely painted enclosing native frame around each independently owned titled raster', () => {
  const f = titledRasterRow(2)
  f.frames = [
    [72, 195, 298, 332],
    [301, 195, 528, 332]
  ]
  // Leave a real panel gutter, rather than an overlapping synthetic tile boundary.
  f.page.graphicsBounds[0].normalizedRect[2] = 296 / 600
  f.page.graphicsBounds[1].normalizedRect[0] = 304 / 600
  expect(
    nativeCaptionedAlignedRasterPair(f.page, f.caption, f.captions, [], [], f.tokens, f.frames)
      ?.rect
  ).toEqual([72, 178, 528, 342])
  const r = associateFigures(f.page, f.captions, [], [], f.frames, f.tokens).find(
    (x: ReturnType<typeof JSON.parse>) => x.caption === f.caption
  )
  expect(r?.rect[0]).toBeLessThanOrEqual(72)
  expect(r?.rect[2]).toBeGreaterThanOrEqual(528)
})
it.each([
  'no-frame',
  'competing-frame',
  'uncontained-image',
  'whole-row-frame',
  'foreign-token',
  'foreign-image',
  'foreign-caption',
  'foreign-table'
])('keeps the original titled raster bounds without unique outer-frame ownership: %s', (reason) => {
  const f = titledRasterRow(2)
  f.page.graphicsBounds[0].normalizedRect[2] = 296 / 600
  f.page.graphicsBounds[1].normalizedRect[0] = 304 / 600
  const frames = [
    [72, 195, 298, 332],
    [301, 195, 528, 332]
  ]
  if (reason === 'no-frame') frames.length = 0
  if (reason === 'competing-frame') frames.push([71, 194, 299, 333])
  if (reason === 'uncontained-image') frames[0][0] = 82
  if (reason === 'whole-row-frame') frames.splice(0, 2, [72, 195, 528, 332])
  if (reason === 'foreign-token')
    f.tokens.push({ text: 'Other', rect: [73, 230, 79, 238], height: 8, horizontal: true })
  if (reason === 'foreign-image')
    f.page.graphicsBounds.push({
      kind: 'image',
      imageHash: 'anonymous-foreign-small-image',
      normalizedRect: [73 / 600, 230 / 800, 79 / 600, 238 / 800]
    })
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 3. Other.'], rect: [73, 230, 79, 238] })
  const r = nativeCaptionedAlignedRasterPair(
    f.page,
    f.caption,
    f.captions,
    reason === 'foreign-table' ? [[73, 230, 79, 238]] : [],
    [],
    f.tokens,
    frames
  )
  expect(r?.rect[0] ?? 80).toBeGreaterThanOrEqual(80)
})
it('does not make a different-page caption a same-page raster frame barrier', () => {
  const f = titledRasterRow(2)
  f.page.graphicsBounds[0].normalizedRect[2] = 296 / 600
  f.page.graphicsBounds[1].normalizedRect[0] = 304 / 600
  f.captions.push({ page: 2, lines: ['Figure 3. Other.'], rect: [73, 230, 79, 238] })
  expect(
    nativeCaptionedAlignedRasterPair(f.page, f.caption, f.captions, [], [], f.tokens, [
      [72, 195, 298, 332],
      [301, 195, 528, 332]
    ])?.rect[0]
  ).toBe(72)
})
it.each([
  'missing-label',
  'foreign-caption',
  'foreign-table',
  'foreign-prose',
  'unowned-title',
  'duplicate-image'
])('does not recover a titled raster row with ambiguous ownership: %s', (reason) => {
  const f = titledRasterRow(3)
  if (reason === 'missing-label') f.tokens.pop()
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 3. Independent.'], rect: [200, 250, 350, 262] })
  if (reason === 'foreign-prose')
    f.page.lines.push({
      text: 'The separate experiment describes the following result.',
      x: 100,
      y: 346,
      width: 390,
      height: 8,
      fontSize: 8
    })
  if (reason === 'unowned-title') f.page.lines[0].x -= 100
  if (reason === 'duplicate-image')
    f.page.graphicsBounds[1].imageHash = f.page.graphicsBounds[0].imageHash
  expect(
    nativeCaptionedAlignedRasterPair(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[100, 240, 490, 280]] : [],
      [],
      f.tokens
    )
  ).toBeUndefined()
})
it.each(['hashed-raster', 'already-owned-painted-plate'])(
  'preserves complete native keyed font boxes and their uniquely aligned continuation: %s',
  (kind) => {
    const f = titledRasterRow(2)
    f.page.lines = [
      f.page.lines.at(-1),
      f.page.lines.at(-2),
      { text: '(a) First panel', x: 110, y: 334, width: 90, height: 8, fontSize: 8 },
      { text: 'continued.', x: 125, y: 343, width: 60, height: 8, fontSize: 8 },
      { text: '(b) Second panel', x: 340, y: 334, width: 100, height: 8, fontSize: 8 }
    ]
    f.tokens = f.page.lines.slice(2).map((l: ReturnType<typeof JSON.parse>) => ({
      text: l.text,
      rect: [l.x, l.y, l.x + l.width, l.y + l.height],
      height: l.height,
      horizontal: true
    }))
    if (kind === 'already-owned-painted-plate')
      for (const g of f.page.graphicsBounds) {
        g.paintedNormalizedRect = [...g.normalizedRect]
        delete g.imageHash
      }
    const r = associateFigures(f.page, f.captions, [], [], [], f.tokens).find(
      (x: ReturnType<typeof JSON.parse>) => x.caption === f.caption
    )
    expect(r?.rect[3]).toBeGreaterThanOrEqual(351)
  }
)
const keyedTopBottomStrip = (): ReturnType<typeof JSON.parse> => {
  const f = titledRasterRow(3)
  f.caption.lines = ['Figure 2. (Top) Native networks; (Bottom) responses (a), (b), and (c).']
  f.caption.rect = [80, 290, 520, 300]
  f.page.lines = [{ text: f.caption.lines[0], x: 80, y: 290, width: 440, height: 10, fontSize: 10 }]
  f.page.graphicsBounds = [0, 1, 2].flatMap((n) => {
    const left = 80 + n * 145
    f.page.lines.push(
      { text: 'x1', x: left + 20, y: 85, width: 10, height: 8, fontSize: 8 },
      { text: 'u', x: left + 70, y: 85, width: 8, height: 8, fontSize: 8 }
    )
    return [
      {
        kind: 'image',
        imageHash: `anonymous-response-${n}`,
        normalizedRect: [left / 600, 160 / 800, (left + 130) / 600, 250 / 800]
      },
      ...[0, 1, 2, 3, 4].map((step) => ({
        kind: 'path',
        normalizedRect: [
          (left + 15 + step * 10) / 600,
          (85 + step * 8) / 800,
          (left + 25 + step * 10) / 600,
          (100 + step * 8) / 800
        ]
      }))
    ]
  })
  return f
}
it('retains top-row native nodes of the existing three-column raster and vector strip', () => {
  const f = keyedTopBottomStrip()
  expect(nativeCaptionedRasterVectorStrip(f.page, f.caption, [f.caption], [])?.rect[1]).toBe(85)
})
it.each([
  'no-caption-keys',
  'no-top-bottom',
  'missing-column-label',
  'different-raster-row',
  'foreign-prose'
])(
  'does not widen a raster and vector strip without its independent keyed-column witness: %s',
  (reason) => {
    const f = keyedTopBottomStrip()
    if (reason === 'no-caption-keys')
      f.caption.lines = ['Figure 2. (Top) Networks and (Bottom) response.']
    if (reason === 'no-top-bottom') f.caption.lines = ['Figure 2. Responses (a), (b), and (c).']
    if (reason === 'missing-column-label') f.page.lines = f.page.lines.slice(0, 5)
    if (reason === 'different-raster-row') f.page.graphicsBounds[6].normalizedRect[1] += 0.05
    if (reason === 'foreign-prose')
      f.page.lines.push({
        text: 'A separate preceding paragraph explains the experiment and the following result.',
        x: 90,
        y: 90,
        width: 400,
        height: 10,
        fontSize: 10
      })
    expect(
      nativeCaptionedRasterVectorStrip(f.page, f.caption, [f.caption], [])?.rect[1] ?? Infinity
    ).toBeGreaterThan(85)
  }
)
it.each(['quantized-raster', 'partly-owned-font'])(
  'completes the full keyed native font box from proved existing ownership: %s',
  (kind) => {
    const f = titledRasterRow(2)
    f.tokens = [{ text: '(a)', rect: [180, 334, 192, 342], height: 8, horizontal: true }]
    f.page.lines = [
      f.page.lines.at(-2),
      { text: '(a)', x: 180, y: 334, width: 12, height: 8, fontSize: 8 }
    ]
    const rect = [80, 200, 300, 330]
    if (kind === 'quantized-raster') {
      f.page.graphicsBounds = [
        {
          kind: 'image',
          imageHash: 'anonymous-quantized',
          normalizedRect: [80 / 600, 180 / 800, 300 / 600, 348 / 800],
          paintedNormalizedRect: [80 / 600, 200 / 800, 300 / 600, 330 / 800]
        }
      ]
    } else {
      f.page.graphicsBounds = []
      rect[3] = 338
    }
    expect(
      nativeOwnedFigureBottomLabels(f.page, f.caption, [f.caption], [], rect, [], f.tokens)
    ).toEqual([[180, 334, 192, 342]])
    expect(
      nativeOwnedFigureBottomLabels(
        f.page,
        f.caption,
        [
          f.caption,
          { page: 2, lines: ['Figure 9. A different page.'], rect: [175, 339, 240, 345] }
        ],
        [],
        rect,
        [],
        f.tokens
      )
    ).toEqual([[180, 334, 192, 342]])
  }
)
it.each([
  'unowned-font',
  'foreign-prose',
  'foreign-caption',
  'foreign-table',
  'foreign-owner',
  'non-key',
  'ambiguous-raster'
])('does not complete an ambiguous native keyed font boundary: %s', (reason) => {
  const f = titledRasterRow(2)
  f.tokens = [{ text: '(a)', rect: [180, 334, 192, 342], height: 8, horizontal: true }]
  f.page.lines = [
    f.page.lines.at(-2),
    { text: '(a)', x: 180, y: 334, width: 12, height: 8, fontSize: 8 }
  ]
  f.page.graphicsBounds = []
  const rect = [80, 200, 300, 338]
  if (reason === 'unowned-font') rect[3] = 330
  if (reason === 'foreign-prose')
    f.page.lines.push({ text: 'Separate text.', x: 240, y: 339, width: 50, height: 8, fontSize: 8 })
  if (reason === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 3. Separate.'], rect: [175, 339, 240, 345] })
  if (reason === 'non-key') f.tokens[0].text = 'ordinary annotation'
  if (reason === 'ambiguous-raster') {
    f.page.graphicsBounds = Array.from({ length: 2 }, (_, n) => ({
      kind: 'image',
      imageHash: `anonymous-competing-${n}`,
      normalizedRect: [80 / 600, 200 / 800, 300 / 600, 330 / 800]
    }))
    rect[3] = 330
  }
  expect(
    nativeOwnedFigureBottomLabels(
      f.page,
      f.caption,
      f.captions,
      reason === 'foreign-table' ? [[175, 339, 240, 345]] : [],
      rect,
      [],
      f.tokens,
      () => reason === 'foreign-owner'
    )
  ).toEqual([])
})
it('completes the owned key while a merged native row includes an unowned neighboring panel key', () => {
  const f = titledRasterRow(2)
  f.tokens = [
    { text: '(a)', rect: [180, 334, 192, 342], height: 8, horizontal: true },
    { text: '(b)', rect: [400, 334, 412, 342], height: 8, horizontal: true }
  ]
  f.page.lines = [
    f.page.lines.at(-2),
    { text: '(a) (b)', x: 180, y: 334, width: 232, height: 8, fontSize: 8 }
  ]
  expect(
    nativeOwnedFigureBottomLabels(
      f.page,
      f.caption,
      [f.caption],
      [],
      [300, 200, 520, 330],
      [],
      f.tokens
    )
  ).toEqual([[400, 334, 412, 342]])
})
const ownedNativeKeyPair = (captionKeys = true): ReturnType<typeof JSON.parse> => {
  const f = titledRasterRow(2)
  if (captionKeys) f.caption.lines = ['Figure 2. (a) Native network and (b) measured response.']
  f.page.lines = [
    { text: f.caption.lines[0], x: 80, y: 360, width: 440, height: 10, fontSize: 10 },
    {
      text: '(a) First sampling (r = 1) (b) Second sampling (r = 3)',
      x: 130,
      y: 334,
      width: 345,
      height: 8,
      fontSize: 8
    }
  ]
  f.tokens = [
    { text: '(a) First sampling (', rect: [130, 334, 220, 342], height: 8, horizontal: true },
    { text: 'r = 1)', rect: [220, 334, 260, 342], height: 8, horizontal: true },
    { text: '(b) Second sampling (', rect: [350, 334, 435, 342], height: 8, horizontal: true },
    { text: 'r = 3)', rect: [435, 334, 475, 342], height: 8, horizontal: true }
  ]
  f.page.graphicsBounds = [0, 1].flatMap((column) =>
    [0, 1, 2].map((n) => ({
      kind: 'path',
      normalizedRect: [
        (100 + column * 220 + n * 10) / 600,
        (220 + n * 20) / 800,
        (270 + column * 220) / 600,
        320 / 800
      ]
    }))
  )
  if (!captionKeys)
    for (const column of [0, 1]) {
      for (const n of [0, 1, 2, 3])
        f.tokens.push({
          text: String(n),
          rect: [100 + column * 220 + n * 45, 313, 105 + column * 220 + n * 45, 320],
          height: 7,
          horizontal: true
        })
      f.tokens.push({
        text: 'Sampling weight',
        rect: [140 + column * 220, 321, 230 + column * 220, 329],
        height: 8,
        horizontal: true
      })
    }
  return f
}
it.each([true, false])(
  'completes a paired keyed row on the already owned finite native plate (%s)',
  (captionKeys) => {
    const f = ownedNativeKeyPair(captionKeys)
    expect(
      nativeOwnedFigureBottomLabels(
        f.page,
        f.caption,
        [f.caption],
        [],
        [80, 200, 520, 330],
        [],
        f.tokens
      )
    ).toEqual([
      [130, 334, 260, 342],
      [350, 334, 475, 342]
    ])
    expect(
      nativeOwnedFigureBottomLabels(
        f.page,
        f.caption,
        [
          f.caption,
          { page: 2, lines: ['Figure 9. A different page.'], rect: [175, 339, 240, 345] }
        ],
        [],
        [80, 200, 520, 330],
        [],
        f.tokens
      )
    ).toEqual([
      [130, 334, 260, 342],
      [350, 334, 475, 342]
    ])
  }
)
it.each([
  'missing-key',
  'unowned-column',
  'caption-mismatch',
  'foreign-text',
  'no-axis-witness',
  'different-baseline'
])('preserves the boundary without unique native keyed-row ownership: %s', (reason) => {
  const f = ownedNativeKeyPair(reason !== 'no-axis-witness')
  if (reason === 'missing-key') f.tokens = f.tokens.slice(2)
  if (reason === 'unowned-column') f.page.graphicsBounds = f.page.graphicsBounds.slice(3)
  if (reason === 'caption-mismatch') f.caption.lines = ['Figure 2. (a) First and (c) second.']
  if (reason === 'foreign-text')
    f.tokens.push({ text: 'foreign', rect: [280, 334, 310, 342], height: 8, horizontal: true })
  if (reason === 'no-axis-witness') f.tokens = f.tokens.slice(0, 4)
  if (reason === 'different-baseline') {
    f.tokens[2].rect[1] += 2
    f.tokens[2].rect[3] += 2
  }
  expect(
    nativeOwnedFigureBottomLabels(
      f.page,
      f.caption,
      [f.caption],
      [],
      [80, 200, 520, 330],
      [],
      f.tokens
    )
  ).toEqual([])
})
it.each([0, 1])(
  'preserves every populated closed plot face and its final panel label (%s)',
  (index) => {
    const f = input(index),
      r = figures(f)[0]
    expect(r.rect[1]).toBeLessThan(index ? 160 : 85)
    expect(r.rect[3]).toBeGreaterThan(index ? 570 : 400)
  }
)
it('preserves the complete two-row raster plate and taller side siblings', () => {
  const r = figures(input(2))[0]
  expect(r.rect[1]).toBeLessThan(70)
  expect(r.rect[2]).toBeGreaterThan(540)
})
it('preserves five raster rows without borrowing the separately captioned lower mosaic', () => {
  const r = figures(input(3))
  expect(r[0].rect[1]).toBeLessThan(95)
  expect(r[0].rect[3]).toBeLessThan(400)
  expect(r[1].rect[1]).toBeGreaterThan(410)
})
it('retains native row labels and three uniquely aligned column headings beside inset waveform images', () => {
  const f = input(3),
    r = figures(f)
  expect(r[0].rect[0]).toBeLessThanOrEqual(58.808)
  expect(r[0].rect[1]).toBeLessThanOrEqual(78.979)
  expect(r[1].rect[1]).toBeGreaterThan(410)
})
it.each(['missing-row-anchor', 'foreign-caption', 'foreign-table', 'prose-strip'])(
  'declines mixed-height row labels without strict repeated-column ownership: %s',
  (reason) => {
    const f = input(3),
      c = f.captions[0],
      rect = [105.1875, 89.71875, 537.890625, 392.90625]
    if (reason === 'missing-row-anchor')
      f.page.graphicsBounds = f.page.graphicsBounds.filter(
        (g: ReturnType<typeof JSON.parse>) =>
          !(
            g.kind === 'image' &&
            g.normalizedRect[0] * f.page.width < 115 &&
            g.normalizedRect[1] * f.page.height > 200 &&
            g.normalizedRect[1] * f.page.height < 210
          )
      )
    if (reason === 'foreign-caption')
      f.captions.push({
        page: f.page.pageNumber,
        rect: [58, 260, 105, 280],
        lines: ['Figure 3. Independent.']
      })
    if (reason === 'foreign-table') f.tableRects.push([58, 90, 105, 393])
    if (reason === 'prose-strip')
      f.page.lines.push({
        text: 'An independent paragraph occupies the adjacent column.',
        fontSize: 8,
        x: 60,
        y: 280,
        width: 45,
        height: 9
      })
    expect(
      nativeRasterRowLabels(f.page, c, f.captions, f.tableRects, rect, f.nativeTokens)
    ).toEqual([])
  }
)
it.each([
  'two-headings',
  'different-baseline',
  'distant-heading',
  'unowned-column',
  'competing-caption'
])('keeps the native top margin without complete column-heading proof: %s', (reason) => {
  const f = input(3)
  if (reason === 'two-headings') f.nativeTokens.pop()
  if (reason === 'different-baseline') {
    f.nativeTokens[0].rect[1] -= 4
    f.nativeTokens[0].rect[3] -= 4
  }
  if (reason === 'distant-heading') {
    f.nativeTokens[0].rect[1] -= 15
    f.nativeTokens[0].rect[3] -= 15
  }
  if (reason === 'unowned-column') {
    f.nativeTokens[1].rect[0] += 400
    f.nativeTokens[1].rect[2] += 400
  }
  if (reason === 'competing-caption')
    f.captions.push({
      page: f.page.pageNumber,
      rect: [100, 77, 300, 87],
      lines: ['Figure 3. Independent.']
    })
  const labels = nativeRasterRowLabels(
    f.page,
    f.captions[0],
    f.captions,
    f.tableRects,
    [105.1875, 89.71875, 537.890625, 392.90625],
    f.nativeTokens
  )
  expect(labels.every((l: ReturnType<typeof JSON.parse>) => l.y >= 89.71875)).toBe(true)
})
it.each([4, 5])(
  'retains repeated native row labels beside an independently owned raster plate (%s)',
  (index) => {
    const r = figures(input(index))
    expect(r[0].rect[0]).toBeLessThan(index === 4 ? 180 : 109)
    if (index === 5) expect(r[1].rect[0]).toBeLessThan(165)
  }
)
it('preserves explicitly paired unequal raster widths in the same centered column', () => {
  const r = figures(input(6))[0]
  expect(r.rect[1]).toBeLessThan(180)
  expect(r.rect[2]).toBeGreaterThan(510)
})
it('owns the explicitly closed outer raster workflow instead of its lower subsets', () => {
  const r = figures(input(7))[0]
  expect(r.rect[1]).toBeLessThan(70)
  expect(r.rect[2]).toBeGreaterThan(540)
})
it.each(['missing-label', 'distant-column', 'foreign-prose', 'foreign-table', 'competing-caption'])(
  'declines row-label expansion without complete unique ownership: %s',
  (reason) => {
    const f = input(4),
      caption = f.captions.find((c: ReturnType<typeof JSON.parse>) => /^Figure/.test(c.lines[0]))
    const rect = [205.59375, 368.15625, 418.359375, 646.59375]
    if (reason === 'missing-label')
      f.page.lines = f.page.lines.filter((l: ReturnType<typeof JSON.parse>) => l.y < 600)
    if (reason === 'distant-column')
      f.page.lines.forEach((l: ReturnType<typeof JSON.parse>) => {
        if (l.x < 205 && l.y > 360) l.x -= 80
      })
    if (reason === 'foreign-prose')
      f.page.lines.push({
        text: 'Independent paragraph with many words in the printed left column.',
        x: 170,
        y: 490,
        width: 35,
        height: 9,
        fontSize: 9
      })
    if (reason === 'foreign-table') f.tableRects.push([170, 375, 205, 640])
    if (reason === 'competing-caption')
      f.captions.push({
        page: f.page.pageNumber,
        rect: [170, 400, 205, 420],
        lines: ['Figure 2. Independent.']
      })
    expect(nativeRasterRowLabels(f.page, caption, f.captions, f.tableRects, rect)).toEqual([])
  }
)
it.each(['no-keys', 'off-center', 'foreign-prose', 'third-image', 'foreign-table'])(
  'declines an unequal raster pair without its complete caption and geometry proof: %s',
  (reason) => {
    const f = input(6),
      caption = f.captions[0]
    if (reason === 'no-keys') caption.lines = ['Figure 7. Independent reconstruction.']
    if (reason === 'off-center') f.page.graphicsBounds[1].paintedNormalizedRect[0] += 0.05
    if (reason === 'foreign-prose')
      f.page.lines.push({
        text: 'Independent paragraph.',
        x: 130,
        y: 321,
        width: 300,
        height: 6,
        fontSize: 6
      })
    if (reason === 'third-image')
      f.page.graphicsBounds.push({
        ...f.page.graphicsBounds[0],
        imageHash: 'third-independent-image'
      })
    if (reason === 'foreign-table') f.tableRects.push([120, 200, 500, 280])
    expect(
      nativeCaptionedAlignedRasterPair(f.page, caption, f.captions, f.tableRects)
    ).toBeUndefined()
  }
)
it('keeps its own native caption first line out of a bar-chart crop', () => {
  const f = input(8),
    c = f.captions[0]
  const r = nativeCaptionedVectorBarChart(f.page, c, [c], [])
  expect(r).toBeDefined()
  expect(r.rect[3]).toBeLessThan(c.rect[1])
})
it('excludes an adjacent raised caption symbol and its vector formula rule from a chart crop', () => {
  const f = input(11),
    c = f.captions[0],
    r = figures(f)[0]
  expect(r).toBeDefined()
  expect(r.rect[3]).toBeLessThan(c.rect[1])
  expect(r.rect[3]).toBeGreaterThan(330)
})
it.each(['separate-symbol', 'different-font', 'absent-caption-symbol'])(
  'preserves a short native label without its caption-fragment proof: %s',
  (reason) => {
    const f = input(11),
      symbol = f.page.lines.find((l: ReturnType<typeof JSON.parse>) => l.text === '√')
    if (reason === 'separate-symbol') symbol.x -= 20
    if (reason === 'different-font') symbol.fontSize *= 0.75
    if (reason === 'absent-caption-symbol')
      f.captions[0].lines = f.captions[0].lines.map((text: string) => text.replace('√', ''))
    expect(figures(f)[0].rect[3]).toBeGreaterThan(337)
  }
)
it('keeps a native path intersecting the figure face even beside an owned scientific caption', () => {
  const f = input(11),
    rule = f.page.graphicsBounds.find(
      (g: ReturnType<typeof JSON.parse>) =>
        g.kind === 'path' && g.normalizedRect[1] * f.page.height > 335
    )
  rule.normalizedRect[1] = 330 / f.page.height
  rule.normalizedRect[3] = 336 / f.page.height
  expect(figures(f)[0].rect[3]).toBeGreaterThanOrEqual(336)
})
it('keeps the complete quantized bottom rule of a separate native ruled table out of a bar-chart crop', () => {
  const f = input(9),
    r = figures(f)[0]
  expect(r.rect[1]).toBeGreaterThan(278)
  expect(r.rect[3]).toBeGreaterThan(465)
})
it.each(['missing-rules', 'competing-owner', 'shifted-fences', 'remote-edge', 'tall-graphic'])(
  'does not exclude an unproved horizontal table divider: %s',
  (reason) => {
    const f = input(9)
    const rect = [125.56603125, 269.667890625, 472.03526562499997, 276.24515625]
    expect(nativeTableDividerGraphic(f.page, rect, f.tableRects, f.rules)).toBe(true)
    if (reason === 'missing-rules') f.rules = []
    if (reason === 'competing-owner') f.tableRects.push([...f.tableRects[0]])
    if (reason === 'shifted-fences') f.rules[0][0] += 1
    if (reason === 'remote-edge') f.tableRects[0][3] += 5
    if (reason === 'tall-graphic') rect[3] += 10
    expect(nativeTableDividerGraphic(f.page, rect, f.tableRects, f.rules)).toBe(false)
  }
)
it('keeps an independent native page numeral and centered running title out of its paired diagram', () => {
  const f = input(10),
    r = figures(f)[0]
  expect(r.rect[1]).toBeGreaterThan(60)
  expect(r.rect[3]).toBeGreaterThan(270)
})
it('excludes a separately painted header stroke whose native endpoint meets the proved separator', () => {
  const f = input(10)
  f.page.graphicsBounds.push(
    {
      kind: 'path',
      normalizedRect: [
        50 / f.page.width,
        53 / f.page.height,
        565 / f.page.width,
        55 / f.page.height
      ]
    },
    {
      kind: 'path',
      normalizedRect: [78 / f.page.width, 42 / f.page.height, 83 / f.page.width, 55 / f.page.height]
    }
  )
  f.rules.push([50, 54, 565, 54], [80, 42, 80, 54])
  expect(figures(f)[0].rect[1]).toBeGreaterThan(60)
})
it('keeps independent native separator proof after a previous margin pass removes its quantized graphic', () => {
  const f = input(10)
  f.page.graphicsBounds.push({
    kind: 'path',
    normalizedRect: [78 / f.page.width, 42 / f.page.height, 83 / f.page.width, 57 / f.page.height]
  })
  f.rules.push([50, 54, 565, 54], [80, 42, 80, 54])
  expect(figures(f)[0].rect[1]).toBeGreaterThan(60)
})
it.each(['missing-source-stroke', 'open-endpoint', 'body-connected'])(
  'preserves an unproved small header-adjacent graphic: %s',
  (reason) => {
    const f = input(10)
    f.page.graphicsBounds.push(
      {
        kind: 'path',
        normalizedRect: [
          50 / f.page.width,
          53 / f.page.height,
          565 / f.page.width,
          55 / f.page.height
        ]
      },
      {
        kind: 'path',
        normalizedRect: [
          78 / f.page.width,
          42 / f.page.height,
          83 / f.page.width,
          (reason === 'body-connected' ? 80 : 55) / f.page.height
        ]
      }
    )
    f.rules.push([50, 54, 565, 54])
    if (reason !== 'missing-source-stroke')
      f.rules.push([80, 42, 80, reason === 'open-endpoint' ? 50 : 80])
    expect(figures(f)[0].rect[1]).toBeLessThan(60)
  }
)
it('keeps a native ordinal and running title out of a uniquely captioned populated closed plot pair', () => {
  const f = input(12),
    r = figures(f)[0]
  expect(nativeFigureRunningHead(f.page, f.captions, f.nativeTokens, f.rules)).toBeDefined()
  expect(r.rect[1]).toBeGreaterThan(60)
  expect(r.rect[0]).toBeLessThan(55)
  expect(r.rect[2]).toBeGreaterThan(560)
  expect(r.rect[3]).toBeGreaterThan(250)
})
it.each([
  'open-face',
  'empty-faces',
  'missing-ticks',
  'missing-title-key',
  'repeated-title-key',
  'distant-title',
  'different-title-font',
  'different-title-baseline',
  'missing-caption-key',
  'competing-owner',
  'foreign-caption',
  'foreign-table',
  'ink-in-gap',
  'prose-in-gap',
  'figure-title',
  'wrong-page',
  'off-center',
  'different-header-font',
  'different-header-baseline',
  'wide-ordinal',
  'third-margin-item'
])('declines closed-pair margin cleanup without every independent owner witness: %s', (reason) => {
  const f = input(12),
    number = f.nativeTokens.find(
      (t: ReturnType<typeof JSON.parse>) => t.text.trim() === String(f.page.pageNumber)
    ),
    header = f.nativeTokens.find(
      (t: ReturnType<typeof JSON.parse>) => t !== number && t.rect[1] < 60
    ),
    title = f.nativeTokens.find(
      (t: ReturnType<typeof JSON.parse>) => /^\(b\)\s/.test(t.text) && t.rect[1] < 100
    )
  if (reason === 'open-face')
    f.rules = f.rules.filter((r: number[]) => !(r[1] === r[3] && r[1] > 70 && r[1] < 80))
  if (reason === 'empty-faces') f.page.graphicsBounds = f.page.graphicsBounds.slice(0, 1)
  if (reason === 'missing-ticks')
    f.page.lines = f.page.lines.filter(
      (l: ReturnType<typeof JSON.parse>) => !/^[−-]?\d+(?:\.\d+)?$/.test(l.text.trim())
    )
  if (reason === 'missing-title-key')
    f.nativeTokens = f.nativeTokens.filter((t: ReturnType<typeof JSON.parse>) => t !== title)
  if (reason === 'repeated-title-key') title.text = title.text.replace('(b)', '(a)')
  if (reason === 'distant-title')
    title.rect = title.rect.map((v: number, i: number) => (i % 2 ? v : v + 30))
  if (reason === 'different-title-font') title.height *= 1.2
  if (reason === 'different-title-baseline') title.rect[3] += 2
  if (reason === 'missing-caption-key')
    f.captions[0].lines = ['Figure 13. Captioned plots (a) and (c).']
  if (reason === 'competing-owner') f.captions.push(structuredClone(f.captions[0]))
  if (reason === 'foreign-caption')
    f.captions.push({ page: f.page.pageNumber, rect: [300, 70, 340, 75], lines: ['Figure 2.'] })
  if (reason === 'foreign-table') f.tableRects.push([100, 100, 300, 200])
  if (reason === 'ink-in-gap')
    f.page.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [
        100 / f.page.width,
        55 / f.page.height,
        400 / f.page.width,
        58 / f.page.height
      ]
    })
  if (reason === 'prose-in-gap')
    f.nativeTokens.push({
      text: 'Independent text.',
      horizontal: true,
      rect: [100, 55, 180, 59],
      height: 4
    })
  if (reason === 'figure-title') header.text = 'Figure title'
  if (reason === 'wrong-page') number.text = '15'
  if (reason === 'off-center')
    header.rect = header.rect.map((v: number, i: number) => (i % 2 ? v : v + 10))
  if (reason === 'different-header-font') header.height *= 0.8
  if (reason === 'different-header-baseline') header.rect[3] += 2
  if (reason === 'wide-ordinal') number.rect[2] += 1e-7
  if (reason === 'third-margin-item')
    f.nativeTokens.push({ ...header, text: 'Independent', rect: [380, 41.6554, 430, 51.618] })
  expect(
    nativeFigureRunningHead(f.page, f.captions, f.nativeTokens, f.rules, f.tableRects)
  ).toBeUndefined()
})
it.each([
  'figure-title',
  'wrong-page',
  'off-center',
  'different-baseline',
  'ink-in-band',
  'third-item',
  'no-panel-keys'
])('declines a separator-free header without unique independent source proof: %s', (reason) => {
  const f = input(10)
  if (reason === 'figure-title') f.nativeTokens[1].text = 'Figure 6. Paired views'
  if (reason === 'wrong-page') f.nativeTokens[0].text = '5'
  if (reason === 'off-center') f.nativeTokens[1].rect[0] += 30
  if (reason === 'different-baseline') f.nativeTokens[1].rect[1] += 3
  if (reason === 'ink-in-band')
    f.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.05, 0.6, 0.1] })
  if (reason === 'third-item')
    f.nativeTokens.push({
      ...f.nativeTokens[1],
      text: 'Independent',
      rect: [380, 41.6554, 430, 51.618]
    })
  if (reason === 'no-panel-keys') f.nativeTokens = f.nativeTokens.slice(0, 2)
  expect(nativeFigureRunningHead(f.page, f.captions, f.nativeTokens, f.rules)).toBeUndefined()
})
