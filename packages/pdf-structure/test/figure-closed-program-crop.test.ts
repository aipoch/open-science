import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousClosedSaveFigure, addAnonymousUnclaimedFigureGlyph } = await import(
  pathToFileURL(resolve('test/fixtures/closed-save-figure.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { anonymousPairedProgramFigure } = await import(
  pathToFileURL(resolve('test/fixtures/closed-program-figure.mjs')).href
)
const {
  nativeClosedProgramFigureCrop,
  nativeClosedProgramPngSafe,
  nativeClosedProgramPixelCrop,
  nativeClosedPaintPixelCrop,
  nativeClosedPaintPixelPngSafe,
  nativeSavedPaintPixelCrop,
  nativeSavedPaintPixelPngSafe,
  nativeClosedProgramPixelPngSafe,
  nativeCaptionedProgramPixelCrop,
  nativeCaptionedProgramPixelPngSafe
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-closed-program.mjs')).href
)
const { nativeClosedSaveFigureCrop } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-closed-save.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
import { OPS, version as nativePdfVersion } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createCanvas } from '@napi-rs/canvas'

function anonymousCaptionedWorkflow(): ReturnType<typeof anonymousClosedSaveFigure> {
  const fixture = anonymousPixelProgram(),
    a = fixture.args,
    [page, , , , , context] = a,
    o = context.operators,
    insert = o.fnArray.indexOf(OPS.restore),
    extraOps: number[] = [],
    extraArgs: unknown[] = [],
    extraItems: typeof context.content.items = [],
    addText = (str: string, x: number, baseline: number): void => {
      extraOps.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
      extraArgs.push(
        null,
        ['F', 10],
        [[1, 0, 0, 1, x, page.height - baseline]],
        [[{ unicode: str, fontChar: str, width: 500 * str.length, isInFont: true }]],
        null
      )
      extraItems.push({
        str,
        dir: 'ltr',
        width: str.length * 5,
        height: 10,
        transform: [10, 0, 0, 10, x, page.height - baseline],
        fontName: 'F'
      })
    }
  for (let i = 0; i < 62; i++)
    addText('First block', 60 + (i % 8) * 20, 80 + Math.floor(i / 8) * 12)
  extraOps.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore)
  extraArgs.push(null, [20, 0, 0, 20, 300, 200], ['anonymous-image', 20, 20], null)
  const imageIndex = insert + extraOps.length - 2
  o.fnArray.splice(insert, 0, ...extraOps)
  o.argsArray.splice(insert, 0, ...extraArgs)
  context.content.items.splice(3, 0, ...extraItems)
  const title = 'Figure 1. MODEL is a complete pipeline with labelled parts.',
    tail = 'All visible panels belong to one saved program.',
    first = context.content.items.at(-1),
    old = first.str
  first.str = title
  first.width = title.length * 5
  const captionShow = o.argsArray.find(
    (args: unknown, i: number) =>
      o.fnArray[i] === OPS.showText && Array.isArray(args) && args[0][0].unicode === old
  )
  captionShow[0][0] = { unicode: title, fontChar: title, width: title.length * 500, isInFont: true }
  context.glyphBounds[0].glyphs.push(
    { fontChar: title, bounds: [0, -0.1, title.length * 0.5, 0.7] },
    { fontChar: tail, bounds: [0, -0.1, tail.length * 0.5, 0.7] }
  )
  extraOps.length = extraArgs.length = extraItems.length = 0
  addText(tail, 40, 237)
  o.fnArray.push(...extraOps)
  o.argsArray.push(...extraArgs)
  context.content.items.push(...extraItems)
  context.content.items.forEach((item: { str: string; sourceItem: unknown }, index: number) => {
    item.sourceItem = { pageNumber: 1, index, text: item.str }
  })
  a[4] = context.content.items.map((item: unknown) => tableTextToken(item, context.viewport, 0))
  page.lines = [
    { text: title, x: 40, y: 215, width: title.length * 5, height: 10, fontSize: 10 },
    { text: tail, x: 40, y: 227, width: tail.length * 5, height: 10, fontSize: 10 }
  ]
  page.graphicsBounds.push({
    operationIndex: imageIndex,
    kind: 'image',
    imageHash: 'c'.repeat(64),
    normalizedRect: [300 / 400, 80 / 300, 320 / 400, 100 / 300]
  })
  a[2] = []
  return fixture
}

it('recovers a literal native multiline caption and complete mixed workflow without Source claims', () => {
  const a = anonymousCaptionedWorkflow().args,
    before = JSON.stringify(a),
    plan = nativeCaptionedProgramPixelCrop(a[0], a[2], a[3], a[4], a[5])
  expect(plan).toEqual({
    rect: [48.666666666666664, 68.66666666666667, 321.3333333333333, 187.33333333333334],
    caption: {
      page: 1,
      lines: a[0].lines.map((l: { text: string }) => l.text),
      rect: [40, 215, 335, 237]
    }
  })
  expect(JSON.stringify(a)).toBe(before)
  const rect = plan.rect,
    canvas = createCanvas(Math.ceil((rect[2] - rect[0]) * 4), Math.ceil((rect[3] - rect[1]) * 4))
  try {
    const png = canvas.toBuffer('image/png')
    expect(nativeCaptionedProgramPixelPngSafe(plan, png, rect, a[0])).toBe(true)
    expect(nativeCaptionedProgramPixelPngSafe(structuredClone(plan), png, rect, a[0])).toBe(false)
    a[0].lines[1] = { ...a[0].lines[1] }
    expect(nativeCaptionedProgramPixelPngSafe(plan, png, rect, a[0])).toBe(false)
  } finally {
    canvas.width = canvas.height = 1
  }
})

it('requires actual image provenance for a recovered mixed workflow', () => {
  const a = anonymousCaptionedWorkflow().args
  delete a[0].graphicsBounds.at(-1).imageHash
  expect(nativeCaptionedProgramPixelCrop(a[0], a[2], a[3], a[4], a[5])).toBeUndefined()
})

function anonymousPixelProgram(mode = 'normal'): ReturnType<typeof anonymousClosedSaveFigure> {
  const fixture = anonymousClosedSaveFigure(mode)
  fixture.args[5].pageNumber = 1
  fixture.args[5].sourceSha256 = 'b'.repeat(64)
  return fixture
}

function missingNativeForm(): ReturnType<typeof anonymousClosedSaveFigure> {
  const f = anonymousPixelProgram(),
    a = f.args,
    o = a[5].operators,
    start = o.fnArray.indexOf(OPS.save),
    end = o.fnArray.indexOf(OPS.restore)
  o.fnArray[start] = OPS.paintFormXObjectBegin
  o.argsArray[start] = [
    [1, 0, 0, 1, 0, 0],
    [40, 100, 300, 250]
  ]
  o.fnArray[end] = OPS.paintFormXObjectEnd
  o.argsArray[end] = []
  delete a[1].rect
  a[1].reason = 'ambiguous-graphic-direction'
  return f
}

it('recovers a missing independently captioned transformed Form through a pixel-only proof', () => {
  const f = missingNativeForm(),
    a = f.args,
    before = JSON.stringify(f),
    plan = nativeClosedPaintPixelCrop(...a)
  expect(plan?.rect[0]).toBeLessThan(50)
  expect(plan?.rect[3]).toBeGreaterThan(185)
  expect(plan?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 3),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 3)
  )
  try {
    expect(nativeClosedPaintPixelPngSafe(plan, canvas.toBuffer('image/png'), plan.rect, a[0])).toBe(
      true
    )
  } finally {
    canvas.width = canvas.height = 1
  }
})

it.each(['shear', 'reflection', 'missing-bbox', 'foreign-caption', 'not-missing'])(
  'retains the original missing-figure fallback without a bounded native Form: %s',
  (kind) => {
    const f = missingNativeForm(),
      a = f.args,
      o = a[5].operators,
      start = o.fnArray.indexOf(OPS.paintFormXObjectBegin)
    if (kind === 'shear') o.argsArray[start][0][1] = 0.1
    if (kind === 'reflection') o.argsArray[start][0][0] = -1
    if (kind === 'missing-bbox') o.argsArray[start][1] = null
    if (kind === 'foreign-caption')
      a[2].push({ page: 1, lines: ['Figure 2. Other.'], rect: [80, 170, 250, 195] })
    if (kind === 'not-missing') a[1].reason = 'other-fallback'
    expect(nativeClosedPaintPixelCrop(...a)).toBeUndefined()
  }
)

it.each(['missing', 'incomplete'])(
  'recovers a whole saved drawing image without text claims: %s',
  (mode) => {
    const fixture = anonymousPixelProgram(),
      a = fixture.args
    if (mode === 'missing') delete a[1].rect
    const before = JSON.stringify(a),
      plan = nativeClosedProgramPixelCrop(...a)
    expect(plan).toEqual({
      rect: [
        48.666666666666664,
        mode === 'missing' ? 68.66666666666667 : 60,
        281.3333333333333,
        187.33333333333334
      ]
    })
    expect(JSON.stringify(a)).toBe(before)
    const rect = plan.rect,
      canvas = createCanvas(
        Math.ceil((rect[2] - rect[0]) * 1.5),
        Math.ceil((rect[3] - rect[1]) * 1.5)
      )
    try {
      const png = canvas.toBuffer('image/png')
      expect(nativeClosedProgramPixelPngSafe(plan, png, rect, a[0])).toBe(true)
      expect(nativeClosedProgramPixelPngSafe(structuredClone(plan), png, rect, a[0])).toBe(false)
      a[5].operators.argsArray = [...a[5].operators.argsArray]
      expect(nativeClosedProgramPixelPngSafe(plan, png, rect, a[0])).toBe(false)
    } finally {
      canvas.width = canvas.height = 1
    }
  }
)

it('keeps an already complete published image unchanged', () => {
  const a = anonymousPixelProgram().args
  a[1].rect = [45, 65, 285, 190]
  expect(nativeClosedProgramPixelCrop(...a)).toBeUndefined()
})

it.each(['foreign-paint', 'table', 'open-save'])(
  'does not publish an ambiguous or contaminated drawing: %s',
  (mode) => {
    expect(nativeClosedProgramPixelCrop(...anonymousPixelProgram(mode).args)).toBeUndefined()
  }
)

it('owns two complete native panels and their exterior whole subcaptions', () => {
  const f = anonymousPairedProgramFigure(),
    [page, , captions, tables, tokens, context] = f.args,
    before = JSON.stringify(f),
    result = associateFigures(page, captions, tables, [], [], tokens, context)
  expect(result[0]?.sourceItems).toEqual(
    context.content.items.slice(0, 8).map((r: { sourceItem: unknown }) => r.sourceItem)
  )
  expect(result[0]?.graphicsCount).toBe(6)
  expect(JSON.stringify(f)).toBe(before)
})

it('retains a complete isolated ordinary drawing through public association', () => {
  const f = anonymousClosedSaveFigure('isolated-group'),
    [page, , captions, tables, tokens, context] = f.args,
    result = associateFigures(page, captions, tables, [], [], tokens, context)
  expect(result[0]?.sourceItems).toHaveLength(3)
})

it('retains complete owners while preserving foreign zero-metric glyph envelopes', () => {
  const f = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure(), {
      text: '•',
      x: 330
    }),
    [page, , captions, tables, tokens, context] = f.args
  context.content.styles.Unclaimed = { ascent: 0, descent: 0, vertical: false }
  const before = JSON.stringify(f),
    result = associateFigures(page, captions, tables, [], [], tokens, context)
  expect(result[0]?.sourceItems).toHaveLength(3)
  expect(result[0]?.formCropRaster.foreignPaints).toContainEqual({
    rect: [330, 170, 335, 181],
    floor: 0
  })
  expect(JSON.stringify(f)).toBe(before)
})

it.each([
  'knockout',
  'translucent',
  'matrix',
  'curve',
  'bbox',
  'width',
  'missing-font',
  'table',
  'open-form'
])('refuses an incomplete paired native program: %s', (fault) => {
  const f = anonymousPairedProgramFigure(),
    a = f.args,
    context = a[5],
    o = context.operators
  if (fault === 'knockout') o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0].knockout = true
  if (fault === 'translucent') {
    const i = o.fnArray.indexOf(OPS.beginGroup)
    o.fnArray.splice(i, 0, OPS.setGState)
    o.argsArray.splice(i, 0, [[['ca', 0.5]]])
  }
  if (fault === 'matrix')
    o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0].matrix = [1, 0, 0, 1, 0, 0]
  const stroke = o.fnArray.findIndex(
    (op: number, i: number) => op === OPS.constructPath && o.argsArray[i][0] === OPS.stroke
  )
  if (fault === 'curve') o.argsArray[stroke][1][0][3] = 2
  if (fault === 'bbox') o.argsArray[stroke][2][0] += 1
  if (fault === 'width') context.content.items[0].width += 1
  if (fault === 'missing-font') context.glyphBounds = []
  if (fault === 'table') a[3].push([50, 100, 100, 150])
  if (fault === 'open-form') o.fnArray[o.fnArray.indexOf(OPS.paintFormXObjectEnd)] = OPS.dependency
  expect(nativeClosedProgramFigureCrop(...a)).toBeUndefined()
})

it.each([{ rightLabel: 'Ordinary paragraph' }, { labelOffset: 2 }])(
  'requires two independently aligned whole subcaptions: %j',
  (options) => {
    expect(
      nativeClosedProgramFigureCrop(...anonymousPairedProgramFigure(options).args)
    ).toBeUndefined()
  }
)

it.each([' ', '', '\t', '\u00a0'])(
  'retains and rejects an unowned painted glyph inside a complete program: %j',
  (text) => {
    const f = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure('isolated-group'), {
      text,
      insideScope: true
    })
    expect(nativeClosedProgramFigureCrop(...f.args)).toBeUndefined()
  }
)

it('keeps the old default group and font-metrics guards unchanged', () => {
  const f = anonymousClosedSaveFigure('isolated-group')
  expect(nativeClosedSaveFigureCrop(...f.args)).toBeUndefined()
  expect(nativeClosedProgramFigureCrop(...f.args)?.sourceItems).toHaveLength(3)
})

it('retains the independent caption when it shares a BT with the subcaption', () => {
  const f = anonymousPairedProgramFigure(),
    o = f.args[5].operators,
    shows = o.fnArray.flatMap((op: number, i: number) => (op === OPS.showText ? [i] : [])),
    at = shows[7] + 1
  expect(o.fnArray.slice(at, at + 2)).toEqual([OPS.endText, OPS.beginText])
  o.fnArray.splice(at, 2)
  o.argsArray.splice(at, 2)
  const result = nativeClosedProgramFigureCrop(...f.args)
  expect(result?.sourceItems).toHaveLength(8)
  expect(result?.sourceItems.some((s: { index: number }) => s.index === 8)).toBe(false)
})

it('rejects two whole records sharing one physical glyph', () => {
  const f = anonymousPairedProgramFigure(),
    a = f.args,
    c = a[5],
    o = c.operators,
    shows = o.fnArray.flatMap((op: number, i: number) => (op === OPS.showText ? [i] : [])),
    first = c.content.items[0],
    second = c.content.items[1],
    glyph = o.argsArray[shows[0]][0][0]
  glyph.unicode = 'AB'
  glyph.fontChar = '!'
  c.glyphBounds[0].glyphs.push({ fontChar: '!', bounds: [0, -0.1, 2, 0.7] })
  o.argsArray[shows[1]] = [[]]
  for (const [i, raw] of [first, second].entries()) {
    raw.str = raw.sourceItem.text = i ? 'B' : 'A'
    raw.width = first.width
    raw.transform = [...first.transform]
    a[4][i] = tableTextToken(raw, c.viewport, 0)
  }
  expect(nativeClosedProgramFigureCrop(...a)).toBeUndefined()
})

it('requires complete advances for foreign zero-metric sources', () => {
  const f = addAnonymousUnclaimedFigureGlyph(anonymousClosedSaveFigure(), { text: '•', x: 330 }),
    c = f.args[5]
  c.content.styles.Unclaimed = { ascent: 0, descent: 0, vertical: false }
  c.content.items.at(-1).width += 1
  expect(nativeClosedProgramFigureCrop(...f.args)).toBeUndefined()
})

it('bounds native program search before partitioning every scope', () => {
  const f = anonymousPairedProgramFigure(),
    o = f.args[5].operators
  for (let i = 0; i < 513; i++) {
    o.fnArray.push(OPS.save, OPS.restore)
    o.argsArray.push(null, null)
  }
  expect(nativeClosedProgramFigureCrop(...f.args)).toBeUndefined()
})

it('rejects extreme anisotropy even when both axis scales are near zero', () => {
  const f = anonymousPairedProgramFigure({ anisotropicStroke: true })
  expect(nativeClosedProgramFigureCrop(...f.args)).toBeUndefined()
})

it.each(['native', 'owners', 'proof', 'clone', 'token-text', 'token-rect', 'invalid-page'])(
  'binds final PNG validation to its exact proposal and native context: %s',
  (fault) => {
    const f = anonymousPairedProgramFigure(),
      a = f.args,
      candidate = nativeClosedProgramFigureCrop(...a),
      rect = candidate.rect.map((v: number, i: number) => v + (i < 2 ? -2 : 2)),
      canvas = createCanvas(Math.ceil((rect[2] - rect[0]) * 4), Math.ceil((rect[3] - rect[1]) * 4))
    try {
      const png = canvas.toBuffer('image/png')
      expect(nativeClosedProgramPngSafe(png, rect, a[0], candidate)).toBe(true)
      if (fault === 'native') a[5].content.items[0].str += 'changed'
      if (fault === 'token-text') a[4][0].text += 'changed'
      if (fault === 'token-rect') a[4][0].rect[0] += 1
      if (fault === 'invalid-page') a[0].invalidGraphicsBounds = 1
      if (fault === 'owners') candidate.sourceItems = candidate.sourceItems.slice(1)
      if (fault === 'proof') candidate.formCropRaster.foreignPaints = []
      const actual = fault === 'clone' ? structuredClone(candidate) : candidate
      expect(nativeClosedProgramPngSafe(png, rect, a[0], actual)).toBe(false)
    } finally {
      canvas.width = canvas.height = 1
    }
  }
)

it.each(['page-number', 'rotation', 'same-dimensions-other-page', 'mutated-page'])(
  'binds PNG verification to its exact page instance and geometry: %s',
  (fault) => {
    const f = anonymousPairedProgramFigure(),
      a = f.args,
      candidate = nativeClosedProgramFigureCrop(...a),
      rect = candidate.rect.map((v: number, i: number) => v + (i < 2 ? -2 : 2)),
      canvas = createCanvas(Math.ceil((rect[2] - rect[0]) * 4), Math.ceil((rect[3] - rect[1]) * 4))
    try {
      const png = canvas.toBuffer('image/png')
      expect(nativeClosedProgramPngSafe(png, rect, a[0], candidate)).toBe(true)
      let page = { ...a[0] }
      if (fault === 'page-number') page.pageNumber++
      if (fault === 'rotation') page.rotation = 90
      if (fault === 'mutated-page') {
        page = a[0]
        page.rotation = 90
      }
      expect(nativeClosedProgramPngSafe(png, rect, page, candidate)).toBe(false)
    } finally {
      canvas.width = canvas.height = 1
    }
  }
)

function anonymousMixedAdvance(): ReturnType<typeof anonymousClosedSaveFigure> {
  const f = anonymousClosedSaveFigure('isolated-group'),
    a = f.args,
    c = a[5],
    o = c.operators
  c.pageNumber = 1
  c.sourceSha256 = 'b'.repeat(64)
  const i = o.fnArray.findIndex(
      (op: number, j: number) =>
        op === OPS.showText && o.argsArray[j][0][0].unicode === 'Next block'
    ),
    glyph = (s: string): ReturnType<typeof JSON.parse> => ({
      unicode: s,
      fontChar: s,
      width: s.length * 500,
      isInFont: true
    })
  o.fnArray.splice(i, 1, OPS.showText, OPS.setTextMatrix, OPS.showText)
  o.argsArray.splice(i, 1, [[glyph('Next ')]], [[1, 0, 0, 1, 205, 159.4]], [[glyph('block')]])
  c.glyphBounds[0].glyphs.push(
    { fontChar: 'Next ', bounds: [0, -0.1, 2.5, 0.7] },
    { fontChar: 'block', bounds: [0, -0.1, 2.5, 0.7] }
  )
  return f
}

function anonymousStackedClipped(): ReturnType<typeof anonymousPairedProgramFigure> {
  const f = anonymousPairedProgramFigure(),
    a = f.args,
    [page, figure, , , , c] = a,
    o = c.operators,
    items = c.content.items
  page.height = 600
  page.graphicsBounds = []
  c.graphicsBounds = page.graphicsBounds
  c.viewport = {
    ...c.viewport,
    height: 600,
    transform: [1, 0, 0, -1, 0, 600],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 600 - y]
  }
  c.pageNumber = 1
  c.sourceSha256 = 'b'.repeat(64)
  items.forEach((r: ReturnType<typeof JSON.parse>, i: number) => {
    if (i < 3) r.transform[5] += 240
    else if (i === 3) {
      r.transform[4] = 90
      r.transform[5] = 360
    } else if (i < 7) {
      r.transform[4] -= 250
      r.transform[5] += 10
    } else if (i === 7) {
      r.transform[4] = 87.5
      r.transform[5] = 130
    } else r.transform[5] = 60
  })
  const oldF = [...o.fnArray],
    oldA = [...o.argsArray]
  o.fnArray = []
  o.argsArray = []
  let panel = 0,
    text = 0
  const add = (f: number, a: unknown): void => {
    o.fnArray.push(f)
    o.argsArray.push(a)
  }
  for (let i = 0; i < oldF.length; i++) {
    const op = oldF[i]
    let args = oldA[i]
    if (op === OPS.paintFormXObjectBegin) {
      add(OPS.save, null)
      add(OPS.transform, panel ? [1, 0, 0, 1, -250, 10] : [1, 0, 0, 1, 0, 240])
      args = [null, null]
    }
    if (op === OPS.setTextMatrix && [3, 7, 8].includes(text))
      args = [[1, 0, 0, 1, items[text].transform[4], items[text].transform[5]]]
    add(op, args)
    if (op === OPS.showText) text++
    if (op === OPS.paintFormXObjectEnd) {
      add(OPS.restore, null)
      panel++
    }
  }
  figure.rect = [25, 285, 225, 445]
  figure.caption.rect = [30, 530, 470, 550]
  a[4] = items.map((r: ReturnType<typeof JSON.parse>) => tableTextToken(r, c.viewport, 0))
  return f
}

it('bounds mixed-baseline paint without granting the incomplete source an owning contract', () => {
  const a = anonymousMixedAdvance().args,
    before = JSON.stringify(a)
  expect(nativeClosedProgramFigureCrop(...a)).toBeUndefined()
  expect(nativeClosedProgramPixelCrop(...a)).toBeUndefined()
  const plan = nativeClosedPaintPixelCrop(...a)
  expect(plan).toEqual({ rect: [48.666666666666664, 60, 281.3333333333333, 187.33333333333334] })
  expect(JSON.stringify(a)).toBe(before)
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
  )
  try {
    const png = canvas.toBuffer('image/png')
    expect(nativeClosedPaintPixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
    expect(nativeClosedPaintPixelPngSafe(structuredClone(plan), png, plan.rect, a[0])).toBe(false)
    a[5].content.items[1] = { ...a[5].content.items[1] }
    expect(nativeClosedPaintPixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
  } finally {
    canvas.width = canvas.height = 1
  }
})
it('contains two clipped native panels and their whole labels without treating null Form BBoxes as boundaries', () => {
  const a = anonymousStackedClipped().args,
    plan = nativeClosedPaintPixelCrop(...a)
  expect(plan).toEqual({ rect: [25, 58.666666666666664, 225, 472.3333333333333] })
  expect(nativeClosedProgramPixelCrop(...a)).toBeUndefined()
  const canvas = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
  )
  try {
    const png = canvas.toBuffer('image/png')
    expect(nativeClosedPaintPixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
    const group = a[5].operators.argsArray[a[5].operators.fnArray.indexOf(OPS.beginGroup)][0]
    group.knockout = true
    expect(nativeClosedPaintPixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
    expect(nativeClosedPaintPixelCrop(...a)).toBeUndefined()
  } finally {
    canvas.width = canvas.height = 1
  }
  const missingLabel = anonymousStackedClipped().args
  const context = missingLabel[5],
    source = context.content.items[7],
    oldText = source.str,
    text = 'Independent paragraph.',
    show = context.operators.argsArray.find(
      (args: unknown, index: number) =>
        context.operators.fnArray[index] === OPS.showText &&
        Array.isArray(args) &&
        args[0][0].unicode === oldText
    )
  // Keep the complete literal/font/source bridge valid: only the independent
  // whole panel label is missing, rather than rejecting a corrupted stream.
  source.str = source.sourceItem.text = text
  source.width = text.length * 5
  show[0][0] = { unicode: text, fontChar: text, width: text.length * 500, isInFont: true }
  context.glyphBounds[0].glyphs.push({
    fontChar: text,
    bounds: [0, -0.1, text.length * 0.5, 0.7]
  })
  missingLabel[4] = context.content.items.map((item: unknown) =>
    tableTextToken(item, context.viewport, 0)
  )
  expect(nativeClosedPaintPixelCrop(...missingLabel)).toBeUndefined()
})

// These outlined marks have no text-layer owner. Only the complete native
// save/restore program and its separate literal caption can bound a preview.
function anonymousSavedPaint(mode = 'outlined'): ReturnType<typeof anonymousClosedSaveFigure> {
  const fixture = anonymousPixelProgram(mode === 'alpha' ? 'owned-alpha' : 'normal'),
    a = fixture.args,
    context = a[5],
    o = context.operators
  delete a[1].rect
  if (mode === 'outlined') {
    const begin = o.fnArray.indexOf(OPS.beginText),
      end = o.fnArray.indexOf(OPS.restore)
    o.fnArray.splice(begin, end - begin)
    o.argsArray.splice(begin, end - begin)
    // An outlined L-shaped label, painted as an ordinary PDF path.
    o.fnArray.splice(begin, 0, OPS.constructPath)
    o.argsArray.splice(begin, 0, [
      OPS.fill,
      [[0, 60, 122, 1, 62, 122, 1, 62, 116, 1, 66, 116, 1, 66, 114, 1, 60, 114, 4]],
      [60, 114, 66, 122]
    ])
    context.content.items.splice(0, 3)
    context.content.items.forEach((item: { str: string; sourceItem: unknown }, index: number) => {
      item.sourceItem = { pageNumber: 1, index, text: item.str }
    })
    a[4] = context.content.items.map((item: unknown) => tableTextToken(item, context.viewport, 0))
  }
  return fixture
}

it.each(['outlined', 'alpha'])(
  'bounds a complete saved %s preview without Source claims',
  (mode) => {
    const a = anonymousSavedPaint(mode).args,
      before = JSON.stringify(a)
    expect(nativeClosedPaintPixelCrop(...a)).toBeUndefined()
    expect(nativeClosedProgramFigureCrop(...a)).toBeUndefined()
    const plan = nativeSavedPaintPixelCrop(...a)
    expect(plan).toEqual({
      rect: [48.666666666666664, 68.66666666666667, 281.3333333333333, 187.33333333333334]
    })
    expect(JSON.stringify(a)).toBe(before)
    const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    )
    try {
      const png = canvas.toBuffer('image/png')
      expect(nativeSavedPaintPixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
      expect(nativeClosedPaintPixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
      expect(nativeSavedPaintPixelPngSafe(structuredClone(plan), png, plan.rect, a[0])).toBe(false)
      a[5].operators.argsArray = [...a[5].operators.argsArray]
      expect(nativeSavedPaintPixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
    } finally {
      canvas.width = canvas.height = 1
    }
  }
)

function appendSavedForeignText(
  a: ReturnType<typeof anonymousClosedSaveFigure>['args'],
  text = 'Foreign',
  x = 320,
  baseline = 270,
  narrowInk = false
): void {
  const context = a[5],
    o = context.operators,
    index = context.content.items.length,
    item = {
      str: text,
      dir: 'ltr',
      width: text.length * 5,
      height: 10,
      transform: [10, 0, 0, 10, x, a[0].height - baseline],
      fontName: 'Foreign',
      sourceItem: { pageNumber: 1, index, text }
    }
  o.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
  o.argsArray.push(
    null,
    ['Foreign', 10],
    [[1, 0, 0, 1, x, a[0].height - baseline]],
    [[{ unicode: text, fontChar: text, width: text.length * 500, isInFont: true }]],
    null
  )
  context.content.items.push(item)
  context.content.styles.Foreign = { ascent: 0.7, descent: -0.1, vertical: false }
  context.glyphBounds.push({
    fontName: 'Foreign',
    glyphs: [{ fontChar: text, bounds: [0, -0.1, narrowInk ? 0.5 : text.length * 0.5, 0.7] }]
  })
  a[4].push(tableTextToken(item, context.viewport, 0))
}

function anonymousSavedDualPaint(): ReturnType<typeof anonymousClosedSaveFigure> {
  const fixture = anonymousSavedPaint('alpha'),
    a = fixture.args,
    context = a[5]
  appendSavedForeignText(a, 'µ')
  const r = context.content.items.at(-1)
  context.operators.argsArray.at(-2)[0][0].originalCharCode = 181
  r.str = r.sourceItem.text = a[4].at(-1).text = 'μ'
  const defaultContent = structuredClone(context.content)
  defaultContent.items.forEach((item: { sourceItem?: unknown }) => delete item.sourceItem)
  const rawContent = structuredClone(defaultContent)
  rawContent.items.at(-1).str = 'µ'
  const viewport = { ...context.viewport }
  delete viewport.convertToViewportPoint
  context.dualApiEvidence = {
    schema: 'same-pdfjs-page-dual-api-capture-v1',
    pdfjsVersion: nativePdfVersion,
    apiDefaultOptions: {},
    apiRawOptions: { disableNormalization: true },
    pageNumber: 1,
    sourceSha256: context.sourceSha256,
    defaultContent,
    rawContent,
    renderContext: {
      pageNumber: 1,
      sourceSha256: context.sourceSha256,
      viewport,
      operators: structuredClone(context.operators),
      content: structuredClone(defaultContent),
      glyphBounds: structuredClone(context.glyphBounds),
      graphicsBounds: structuredClone(a[0].graphicsBounds)
    }
  }
  return fixture
}

it('consumes only a complete dual API witness for a saved preview without changing source text', () => {
  const a = anonymousSavedDualPaint().args,
    before = JSON.stringify(a),
    plan = nativeSavedPaintPixelCrop(...a)
  expect(plan).toBeDefined()
  expect(Object.keys(plan)).toEqual(['rect'])
  expect(nativeClosedPaintPixelCrop(...a)).toBeUndefined()
  expect(JSON.stringify(a)).toBe(before)
})

it.each(['missing', 'raw-text', 'operator', 'source'])(
  'rejects incomplete saved-preview dual API evidence: %s',
  (variant) => {
    const a = anonymousSavedDualPaint().args,
      c = a[5],
      e = c.dualApiEvidence
    if (variant === 'missing') delete c.dualApiEvidence
    if (variant === 'raw-text') e.rawContent.items.at(-1).str = 'u'
    if (variant === 'operator') c.operators.argsArray.at(-2)[0][0].originalCharCode++
    if (variant === 'source') a[4].at(-1).sourceItem.index--
    expect(nativeSavedPaintPixelCrop(...a)).toBeUndefined()
  }
)

it.each(['raw-reference', 'caption', 'paint'])(
  'revokes saved-preview publication after late %s drift',
  (variant) => {
    const a = anonymousSavedDualPaint().args,
      c = a[5],
      plan = nativeSavedPaintPixelCrop(...a)
    expect(plan).toBeDefined()
    const canvas = createCanvas(
      Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
      Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
    )
    try {
      const png = canvas.toBuffer('image/png')
      expect(nativeSavedPaintPixelPngSafe(plan, png, plan.rect, a[0])).toBe(true)
      if (variant === 'raw-reference')
        c.dualApiEvidence.rawContent = structuredClone(c.dualApiEvidence.rawContent)
      if (variant === 'caption') a[1].caption.lines = [...a[1].caption.lines]
      if (variant === 'paint')
        c.operators.argsArray[c.operators.fnArray.indexOf(OPS.setGState)][0][0][1] = 0.8
      expect(nativeSavedPaintPixelPngSafe(plan, png, plan.rect, a[0])).toBe(false)
    } finally {
      canvas.width = canvas.height = 1
    }
  }
)

it.each([
  'caption',
  'duplicate-caption',
  'missing-outline',
  'open-save',
  'blend',
  'alpha-zero',
  'table'
])('rejects incomplete or foreign saved-preview evidence: %s', (variant) => {
  const a = anonymousSavedPaint('alpha').args,
    c = a[5],
    o = c.operators
  if (variant === 'caption')
    a[2].push({ page: 1, lines: ['Figure 2. Adjacent.'], rect: [60, 175, 140, 190] })
  if (variant === 'duplicate-caption') a[2].push({ ...a[1].caption, rect: [39, 209, 351, 236] })
  if (variant === 'missing-outline') c.glyphBounds = []
  if (variant === 'open-save') o.fnArray[o.fnArray.indexOf(OPS.restore)] = OPS.dependency
  const state = o.argsArray[o.fnArray.indexOf(OPS.setGState)][0]
  if (variant === 'blend') state.push(['BM', 'multiply'])
  if (variant === 'alpha-zero') state[0][1] = 0
  if (variant === 'table') a[3].push([60, 175, 140, 190])
  expect(nativeSavedPaintPixelCrop(...a)).toBeUndefined()
})

it.each([false, true])('inventories an unlisted exterior paint, crossing=%s', (crossing) => {
  const a = anonymousSavedPaint().args,
    o = a[5].operators,
    x = crossing ? 70 : 320
  // Intentionally absent from graphicsBounds: the native operator inventory
  // must still see the real paint and apply the same foreign guard.
  o.fnArray.push(OPS.constructPath)
  o.argsArray.push([
    OPS.fill,
    [[0, x, 190, 1, x + 10, 190, 1, x + 10, 200, 1, x, 200, 4]],
    [x, 190, x + 10, 200]
  ])
  expect(!!nativeSavedPaintPixelCrop(...a)).toBe(!crossing)
})

it.each([false, true])('checks complete foreign font advances, crossing=%s', (crossing) => {
  const a = anonymousSavedPaint().args
  // The actual glyph is outside; only the complete native advance reaches
  // the candidate. A tiny outline must not hide a foreign text occurrence.
  appendSavedForeignText(a, 'Foreign advance', crossing ? 20 : 320, 110, true)
  expect(!!nativeSavedPaintPixelCrop(...a)).toBe(!crossing)
})

it.each([false, true])(
  'does not choose the final part of same-caption scopes, same lane=%s',
  (sameLane) => {
    const a = anonymousSavedPaint().args,
      o = a[5].operators,
      x = sameLane ? 70 : 320
    o.fnArray.unshift(OPS.save, OPS.constructPath, OPS.restore)
    o.argsArray.unshift(
      null,
      [
        OPS.fill,
        [[0, x, 270, 1, x + 10, 270, 1, x + 10, 280, 1, x, 280, 4]],
        [x, 270, x + 10, 280]
      ],
      null
    )
    a[0].graphicsBounds.forEach((g: { operationIndex: number }) => {
      g.operationIndex += 3
    })
    expect(!!nativeSavedPaintPixelCrop(...a)).toBe(!sameLane)
  }
)

it('keeps a strict saved-preview packet independent of unused extra API evidence', () => {
  const a = anonymousSavedPaint().args
  a[5].dualApiEvidence = { unrelated: true }
  expect(nativeSavedPaintPixelCrop(...a)).toBeDefined()
})

it('separates earlier same-lane programs by their own complete native caption', () => {
  const a = anonymousSavedPaint().args,
    c = a[5],
    o = c.operators,
    text = 'Figure 2. Earlier drawing.'
  appendSavedForeignText(a, text, 40, 40)
  const capOps = o.fnArray.splice(-5),
    capArgs = o.argsArray.splice(-5),
    earlier = c.content.items.pop()
  o.fnArray.unshift(OPS.save, OPS.constructPath, OPS.restore, ...capOps)
  o.argsArray.unshift(
    null,
    [OPS.fill, [[0, 70, 280, 1, 80, 280, 1, 80, 290, 1, 70, 290, 4]], [70, 280, 80, 290]],
    null,
    ...capArgs
  )
  a[0].graphicsBounds.forEach((g: { operationIndex: number }) => {
    g.operationIndex += 8
  })
  c.content.items.unshift(earlier)
  c.content.items.forEach((item: { str: string; sourceItem: unknown }, index: number) => {
    item.sourceItem = { pageNumber: 1, index, text: item.str }
  })
  a[4] = c.content.items.map((item: unknown) => tableTextToken(item, c.viewport, 0))
  a[2].unshift({ page: 1, lines: [text], rect: [40, 30, 350, 45] })
  expect(nativeSavedPaintPixelCrop(...a)).toBeDefined()
})

it('rejects an unlisted native image even outside the candidate', () => {
  const a = anonymousSavedPaint().args,
    o = a[5].operators
  o.fnArray.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore)
  o.argsArray.push(null, [10, 0, 0, 10, 350, 40], ['unlisted-image', 10, 10], null)
  expect(nativeSavedPaintPixelCrop(...a)).toBeUndefined()
})

it('rejects foreign rendered whitespace even without a token owner', () => {
  const fixture = anonymousSavedPaint()
  addAnonymousUnclaimedFigureGlyph(fixture)
  expect(nativeSavedPaintPixelCrop(...fixture.args)).toBeUndefined()
})
