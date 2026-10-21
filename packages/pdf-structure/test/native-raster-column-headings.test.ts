import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { createRequire } from 'node:module'
const { OPS } = await import(
  pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
)
const { nativeOwnedRasterColumnHeadings } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-owned-figure-labels.mjs')).href
)
function fixture(columns = 3, rows = 2, scale = 1): ReturnType<typeof JSON.parse> {
  const width = 600 * scale,
    height = 700 * scale,
    em = 8 * scale,
    unit = 500 / columns
  const rect = [50 * scale, 100 * scale, 550 * scale, (100 + rows * 110 - 10) * scale]
  const token = (
    text: string,
    x: number,
    y: number,
    w: number,
    index: number
  ): {
    text: string
    horizontal: boolean
    height: number
    baseline: number
    fontDescent: number
    rect: number[]
    sourceItem: { pageNumber: number; index: number; text: string }
  } => ({
    text,
    horizontal: true,
    height: em,
    baseline: (y + 8) * scale,
    fontDescent: -0.2,
    rect: [x * scale, y * scale, (x + w) * scale, (y + 8) * scale],
    sourceItem: { pageNumber: 1, index, text }
  })
  const tokens = Array.from({ length: columns }, (_, i) =>
    token(
      `(${String.fromCharCode(97 + i)}) Metric ${i + 1}`,
      50 + i * unit + unit / 2 - 30,
      84,
      60,
      i
    )
  )
  const text =
    'Figure 3: Columns ' +
    tokens.map((t: { text: string }) => t.text.slice(0, 3)).join(', ') +
    ' compare the measured responses.'
  const caption = {
    page: 1,
    lines: [text],
    rect: [50 * scale, rect[3] + 10 * scale, 550 * scale, rect[3] + 18 * scale]
  }
  tokens.push(token(text, 50, rect[3] / scale + 10, 500, 20))
  const graphicsBounds = Array.from({ length: columns * rows }, (_, i) => {
    const col = i % columns,
      row = Math.floor(i / columns),
      r = [
        (50 + col * unit) / 600,
        (100 + row * 110) / 700,
        (50 + (col + 1) * unit - 6) / 600,
        (200 + row * 110) / 700
      ]
    return { kind: 'image', operationIndex: i + 30, normalizedRect: r, paintedNormalizedRect: r }
  })
  return {
    page: {
      pageNumber: 1,
      width,
      height,
      invalidGraphicsBounds: 0,
      graphicsBounds,
      lines: tokens.map((t: { text: string; rect: number[] }) => ({
        text: t.text,
        x: t.rect[0],
        y: t.rect[1],
        width: t.rect[2] - t.rect[0],
        height: em,
        fontSize: em
      }))
    },
    figure: { caption, rect, reason: 'native-raster-composite-grid' },
    captions: [caption],
    tables: [],
    tokens,
    foreignOwns: () => false
  }
}
const invoke = (
  f: ReturnType<typeof fixture>
):
  | { rects: number[][]; sourceItems?: { pageNumber: number; index: number; text: string }[] }
  | undefined =>
  nativeOwnedRasterColumnHeadings(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.foreignOwns,
    f.context
  )

function legendFixture(backdrop = false): ReturnType<typeof JSON.parse> {
  const f = fixture(),
    ops = { fnArray: [] as number[], argsArray: [] as unknown[] }
  const add = (op: number, args: unknown): number => {
    ops.fnArray.push(op)
    ops.argsArray.push(args)
    return ops.fnArray.length - 1
  }
  f.page.rotation = 0
  f.tokens.slice(0, 3).forEach((t: { text: string; sourceItem: { text: string } }, i: number) => {
    t.text = `Metric ${i + 1}`
    t.sourceItem.text = t.text
  })
  f.figure.caption.lines = ['Figure 3: Comparison grid.']
  f.tokens.at(-1).text = f.figure.caption.lines[0]
  f.tokens.at(-1).sourceItem.text = f.figure.caption.lines[0]
  const graphics = f.page.graphicsBounds
  add(OPS.setGState, [[['ca', 1]]])
  let backdropIndex
  if (backdrop) {
    add(OPS.setFillRGBColor, ['#ffffff'])
    backdropIndex = add(OPS.constructPath, [
      OPS.fill,
      [Float32Array.from([0, 0, 0, 1, 600, 0, 1, 600, 700, 1, 0, 700, 4])],
      [0, 0, 600, 700]
    ])
  }
  for (const g of graphics) {
    const r = g.paintedNormalizedRect.map((v: number, n: number) => v * (n % 2 ? 700 : 600))
    add(OPS.save, null)
    add(OPS.transform, [r[2] - r[0], 0, 0, r[3] - r[1], r[0], 700 - r[3]])
    g.operationIndex = add(OPS.paintImageXObject, [`image-${ops.fnArray.length}`, 100, 100])
    add(OPS.restore, null)
  }
  if (backdropIndex !== undefined)
    graphics.push({ kind: 'path', operationIndex: backdropIndex, normalizedRect: [0, 0, 1, 1] })
  const draw = (r: number[], rounded = false): void => {
    const [l, top, right, bottom] = r,
      b = 700 - bottom,
      t = 700 - top
    const path = rounded
      ? [
          0,
          l + 3,
          b,
          1,
          right - 3,
          b,
          2,
          right,
          b,
          right,
          b,
          right,
          b + 3,
          1,
          right,
          t - 3,
          2,
          right,
          t,
          right,
          t,
          right - 3,
          t,
          1,
          l + 3,
          t,
          2,
          l,
          t,
          l,
          t,
          l,
          t - 3,
          1,
          l,
          b + 3,
          2,
          l,
          b,
          l,
          b,
          l + 3,
          b,
          4
        ]
      : [0, l, b, 1, right, b, 1, right, t, 1, l, t, 4]
    add(OPS.setFillRGBColor, ['#236b45'])
    const index = add(OPS.constructPath, [
      OPS.closeFillStroke,
      [Float32Array.from(path)],
      [l, b, right, t]
    ])
    const normalizedRect = r.map((v, n) => v / (n % 2 ? 700 : 600))
    graphics.push({ kind: 'path', operationIndex: index, normalizedRect })
  }
  draw([55, 55, 545, 77], true)
  for (let i = 0; i < 3; i++) {
    draw([60 + 160 * i, 64, 76 + 160 * i, 70])
    const text = `Group ${i + 1}`
    f.tokens.push({
      text,
      rect: [82 + 160 * i, 62, i === 2 ? 540 : 142 + 160 * i, 70],
      height: 8,
      baseline: 70,
      fontDescent: -0.2,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: 10 + i, text }
    })
  }
  const content: ReturnType<typeof JSON.parse> = {
    items: Array.from({ length: 21 }, () => ({ str: '' })),
    styles: {
      packet: { ascent: 0.75, descent: -0.2, vertical: false },
      body: { ascent: 0.75, descent: -0.2, vertical: false }
    }
  }
  for (const token of f.tokens) {
    const font = token.sourceItem.index === 20 ? 'body' : 'packet'
    content.items[token.sourceItem.index] = {
      str: token.text,
      dir: 'ltr',
      fontName: font,
      width: token.rect[2] - token.rect[0],
      height: 8,
      transform: [8, 0, 0, 8, token.rect[0], 700 - token.baseline],
      sourceItem: { ...token.sourceItem }
    }
    add(OPS.setFillRGBColor, ['#111111'])
    add(OPS.beginText, null)
    add(OPS.setFont, [font, 8])
    add(OPS.moveText, [token.rect[0], 700 - token.baseline])
    add(OPS.showText, [
      Array.from(token.text as string).map((char) => ({
        unicode: char,
        fontChar: char,
        originalCharCode: char.charCodeAt(0),
        isInFont: true,
        width: (((token.rect[2] - token.rect[0]) / 8) * 1000) / token.text.length
      }))
    ])
    add(OPS.endText, null)
  }
  f.context = {
    operators: ops,
    content,
    viewport: { width: 600, height: 700, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 700] }
  }
  return f
}
it.each([false, true])(
  'includes unkeyed grid headings with a complete boxed legend and backdrop=%s',
  (backdrop) => {
    const f = legendFixture(backdrop),
      before = structuredClone(f.tokens)
    const result = invoke(f)
    expect(result).toBeDefined()
    expect(Math.min(...result!.rects.map((r) => r[1]))).toBe(55)
    expect(result!.sourceItems).toEqual(
      before
        .filter((t: { sourceItem: { index: number } }) => t.sourceItem.index !== 20)
        .map((t: { sourceItem: { pageNumber: number; index: number; text: string } }) => ({
          pageNumber: t.sourceItem.pageNumber,
          index: t.sourceItem.index,
          text: t.sourceItem.text
        }))
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    )
    expect(Object.keys(result!).sort()).toEqual(['rects', 'sourceItems'])
    expect(f.tokens).toEqual(before)
  }
)
it.each(['wrong-page', 'unsafe-index', 'alias', 'partial'])(
  'refuses a whole legend source with %s',
  (mode) => {
    const f = legendFixture(),
      label = f.tokens.at(-1)
    if (mode === 'wrong-page') label.sourceItem.pageNumber = 2
    if (mode === 'unsafe-index') label.sourceItem.index = Number.MAX_SAFE_INTEGER + 1
    if (mode === 'alias') f.tokens.push({ ...label, rect: [0, 0, 20, 8] })
    if (mode === 'partial') label.sourceSegment = { ...label.sourceItem, start: 0, end: 3 }
    const before = structuredClone(f.tokens)
    expect(invoke(f)).toBeUndefined()
    expect(f.tokens).toEqual(before)
  }
)
it.each([
  'missing-swatch',
  'unpaired-legend',
  'missing-title',
  'ambiguous-column',
  'foreign-prose',
  'foreign-caption',
  'foreign-table',
  'other-owner',
  'alias',
  'font-matrix',
  'invisible',
  'unknown-op',
  'extra-path',
  'font-outside-packet',
  'caption-shared-font',
  'missing-image-size',
  'zero-image-size',
  'filtered-native-prose'
])('refuses a boxed raster legend with %s', (mode) => {
  const f = legendFixture(),
    o = f.context.operators
  if (mode === 'missing-swatch') f.page.graphicsBounds.splice(7, 1)
  if (mode === 'unpaired-legend') f.tokens[4].rect[0] += 40
  if (mode === 'missing-title') f.tokens.splice(0, 1)
  if (mode === 'ambiguous-column')
    f.page.graphicsBounds[1].paintedNormalizedRect = [
      ...f.page.graphicsBounds[0].paintedNormalizedRect
    ]
  if (mode === 'foreign-prose' || mode === 'alias')
    f.tokens.push({
      ...f.tokens[0],
      text: mode === 'alias' ? f.tokens[0].text : 'Other prose',
      rect: [50, 77, 100, 83],
      sourceItem:
        mode === 'alias'
          ? { ...f.tokens[0].sourceItem }
          : { pageNumber: 1, index: 99, text: 'Other prose' }
    })
  if (mode === 'foreign-caption')
    f.captions.push({ page: 1, rect: [45, 56, 200, 64], lines: ['Figure 4: Independent.'] })
  if (mode === 'foreign-table') f.tables.push([45, 56, 200, 64])
  if (mode === 'other-owner') f.foreignOwns = () => true
  if (mode === 'font-matrix') f.context.content.items[0].transform[4] += 2
  if (mode === 'invisible') o.argsArray[0][0][0][1] = 0
  if (mode === 'unknown-op') {
    o.fnArray.push(OPS.shadingFill)
    o.argsArray.push(['unknown'])
  }
  if (mode === 'extra-path')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 999,
      normalizedRect: [0.1, 0.1, 0.2, 0.2]
    })
  if (mode === 'font-outside-packet')
    f.context.content.items.push({
      ...f.context.content.items[0],
      str: 'Body text',
      sourceItem: { pageNumber: 1, index: 21, text: 'Body text' }
    })
  if (mode === 'caption-shared-font') f.context.content.items[20].fontName = 'packet'
  if (mode === 'missing-image-size') o.argsArray[f.page.graphicsBounds[0].operationIndex].pop()
  if (mode === 'zero-image-size') o.argsArray[f.page.graphicsBounds[0].operationIndex][1] = 0
  if (mode === 'filtered-native-prose')
    f.context.content.items.push({
      ...f.context.content.items[0],
      str: 'Body text',
      fontName: 'body',
      transform: [8, 0, 0, 8, 50, 625],
      sourceItem: { pageNumber: 1, index: 21, text: 'Body text' }
    })
  expect(invoke(f)).toBeUndefined()
})
it('bounds rendered edge samples by one original native image pixel', () => {
  for (const fraction of [0.5, 1.5]) {
    const f = legendFixture(),
      g = f.page.graphicsBounds[1],
      r = [...g.paintedNormalizedRect],
      pixel = (r[2] - r[0]) / 100
    g.normalizedRect = [r[0] - pixel * 2, r[1], r[2], r[3]]
    g.paintedNormalizedRect = [r[0] - pixel * fraction, r[1], r[2], r[3]]
    if (fraction < 1) expect(invoke(f)).toBeDefined()
    else expect(invoke(f)).toBeUndefined()
  }
})
it.each(['colored', 'translucent', 'incomplete clip', 'late fill'])(
  'rejects a %s plate backdrop',
  (mode) => {
    const f = legendFixture(true),
      o = f.context.operators
    if (mode === 'colored') o.argsArray[1][0] = '#ff0000'
    if (mode === 'translucent') o.argsArray[0][0][0][1] = 0.5
    if (mode === 'incomplete clip') {
      o.argsArray[2][1][0][4] = 590
      o.argsArray[2][1][0][7] = 590
    }
    if (mode === 'late fill') {
      o.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
      o.argsArray.push(['#ffffff'], structuredClone(o.argsArray[2]))
      f.page.graphicsBounds.push({
        kind: 'path',
        operationIndex: o.fnArray.length - 1,
        normalizedRect: [0, 0, 1, 1]
      })
    }
    expect(invoke(f)).toBeUndefined()
  }
)
it.each([
  [2, 2, 1],
  [3, 2, 1],
  [4, 3, 1.5]
])(
  'includes complete native column headings on a %s by %s raster grid at scale%s',
  (columns, rows, scale) => {
    const f = fixture(columns, rows, scale)
    const result = invoke(f)
    expect(result?.rects).toHaveLength(columns)
    expect(Object.keys(result!)).toEqual(['rects'])
  }
)
it.each([
  'missing-source',
  'duplicate-item',
  'segment-alias',
  'partial-segment-alias',
  'nonhorizontal-alias',
  'missing-operator',
  'duplicate-operator',
  'invalid-operator',
  'extra-small-raster',
  'extra-path',
  'foreign-text',
  'missing-label',
  'repeated-key',
  'misaligned-label',
  'missing-raster',
  'overlapping-caption',
  'overlapping-table',
  'other-owner',
  'unknown-paint',
  'unreferenced-keys',
  'not-grid',
  'invalid-glyph-metrics',
  'caption-source-mismatch',
  'caption-source-alias',
  'label-dual-carrier',
  'caption-dual-carrier',
  'label-source-token',
  'caption-source-token'
])('refuses new heading ownership with %s', (variant) => {
  const f = fixture(),
    t = f.tokens[0]
  if (variant.includes('dual-carrier') || variant.includes('source-token')) {
    const target = variant.startsWith('caption-') ? f.tokens.at(-1) : t
    target[variant.includes('dual-carrier') ? 'sourceSegment' : 'sourceToken'] = {
      ...target.sourceItem,
      start: 0,
      end: target.text.length
    }
  }
  if (variant === 'caption-source-mismatch')
    f.tokens.at(-1).sourceItem.text = 'Unrelated description'
  if (variant === 'caption-source-alias') {
    const original = f.tokens.at(-1)
    f.tokens.push({
      ...original,
      rect: [0, 0, 20, 8],
      sourceItem: undefined,
      sourceSegment: { ...original.sourceItem, start: 0, end: 3 }
    })
  }
  if (variant === 'missing-source') delete t.sourceItem
  if (variant === 'duplicate-item') f.tokens.push({ ...t, rect: [0, 0, 20, 8] })
  if (['segment-alias', 'partial-segment-alias', 'nonhorizontal-alias'].includes(variant)) {
    const alias = {
      ...t,
      rect: [0, 0, 20, 8],
      sourceSegment: {
        ...t.sourceItem,
        start: 0,
        end: variant === 'partial-segment-alias' ? 3 : t.text.length,
        rect: [0, 0, 20, 8]
      }
    }
    delete alias.sourceItem
    if (variant === 'nonhorizontal-alias') alias.horizontal = false
    f.tokens.push(alias)
  }
  if (variant === 'missing-operator') delete f.page.graphicsBounds[0].operationIndex
  if (variant === 'duplicate-operator') f.page.graphicsBounds[1].operationIndex = 30
  if (variant === 'invalid-operator') f.page.graphicsBounds[0].operationIndex = -1
  if (variant === 'extra-small-raster')
    f.page.graphicsBounds.push({
      kind: 'image',
      operationIndex: 99,
      normalizedRect: [0.49, 0.127, 0.5, 0.14],
      paintedNormalizedRect: [0.49, 0.127, 0.5, 0.14]
    })
  if (variant === 'extra-path')
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 99,
      normalizedRect: [0.49, 0.127, 0.5, 0.14]
    })
  if (variant === 'foreign-text')
    f.tokens.push({
      ...t,
      text: 'Unrelated prose',
      sourceItem: { pageNumber: 1, index: 99, text: 'Unrelated prose' },
      rect: [280, 85, 320, 93]
    })
  if (variant === 'missing-label') f.tokens.splice(1, 1)
  if (variant === 'repeated-key') {
    f.tokens[1].text = '(a) Another metric'
    f.tokens[1].sourceItem.text = f.tokens[1].text
  }
  if (variant === 'misaligned-label') {
    t.rect[0] += 60
    t.rect[2] += 60
  }
  if (variant === 'missing-raster') f.page.graphicsBounds.pop()
  if (variant === 'overlapping-caption')
    f.captions.push({ page: 1, lines: ['Figure 4: Other'], rect: [50, 85, 100, 93] })
  if (variant === 'overlapping-table') f.tables.push([50, 85, 100, 93])
  if (variant === 'other-owner') f.foreignOwns = () => true
  if (variant === 'unknown-paint') f.page.invalidGraphicsBounds = 1
  if (variant === 'unreferenced-keys') f.figure.caption.lines = ['Figure 3: Unrelated description.']
  if (variant === 'not-grid') f.figure.reason = 'generic'
  if (variant === 'invalid-glyph-metrics') t.fontDescent = 2
  expect(invoke(f)).toBeUndefined()
})

it('keeps captions on adjacent pages outside this page ownership', () => {
  const f = fixture()
  f.captions.push({ page: 2, lines: ['Figure 4: Other'], rect: [50, 85, 100, 93] })
  expect(invoke(f)?.rects).toHaveLength(3)
})

it('requires the proved native caption source to contain the claimed keys', () => {
  const f = fixture()
  f.tokens.at(-1).text = 'Figure 3: Unrelated description.'
  f.tokens.at(-1).sourceItem.text = f.tokens.at(-1).text
  expect(invoke(f)).toBeUndefined()
})

it.each([
  ['label', 'direct'],
  ['label', 'sourceItem'],
  ['label', 'sourceSegment'],
  ['caption', 'direct'],
  ['caption', 'sourceItem'],
  ['caption', 'sourceSegment']
])('rejects external sourceToken aliases of a %s source through %s', (kind, carrier) => {
  const f = fixture()
  const original = kind === 'caption' ? f.tokens.at(-1) : f.tokens[0]
  const source = { ...original.sourceItem, start: 0, end: 3 }
  f.tokens.push({
    text: 'Other',
    horizontal: false,
    rect: [0, 0, 20, 8],
    sourceToken: carrier === 'direct' ? source : { [carrier]: source }
  })
  expect(invoke(f), carrier).toBeUndefined()
})
