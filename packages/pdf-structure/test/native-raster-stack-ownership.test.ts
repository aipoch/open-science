import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { nativeCaptionedRasterFrameBands, nativeCaptionedRasterMapStack } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)
const { associateFigures, associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`test/fixtures/source-grids/${name}.jsonl`))

// All visible panel content is baked into independent native image paints.
// The only native text is a complete generic caption below the contiguous stack.
const nativeContiguousStack = (
  heights = [100, 120, 110],
  dy = 0
): ReturnType<typeof JSON.parse> => {
  const width = 600,
    height = 800,
    left = 60,
    right = 260
  const operators = { fnArray: [] as number[], argsArray: [] as unknown[][] }
  const emit = (op: number, args: unknown[] = []): number => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
    return operators.fnArray.length - 1
  }
  const graphics: ReturnType<typeof JSON.parse>[] = []
  let y = 60 + dy
  for (const [i, h] of heights.entries()) {
    emit(OPS.save)
    emit(OPS.transform, [right - left, 0, 0, h, left, height - y - h])
    const operationIndex = emit(OPS.paintImageXObject, ['generic-component-' + i, 400, h * 2])
    emit(OPS.restore)
    graphics.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [left / width, y / height, right / width, (y + h) / height]
    })
    y += h + 1
  }
  const text = 'Figure 1. Independent schematic panels.'
  const caption = { page: 1, rect: [50, y + 7, 280, y + 17], lines: [text] }
  const item = {
    str: text,
    width: 230,
    height: 10,
    dir: 'ltr',
    fontName: 'Body',
    hasEOL: true,
    transform: [10, 0, 0, 10, 50, height - y - 17],
    sourceItem: { pageNumber: 1, index: 0, text }
  }
  emit(OPS.beginText)
  emit(OPS.setFont, ['Body', 10])
  emit(OPS.moveText, [50, height - y - 17])
  emit(OPS.showText, [
    Array.from(text, (unicode) => ({
      unicode,
      fontChar: unicode,
      width: 23000 / text.length,
      isSpace: unicode === ' '
    }))
  ])
  emit(OPS.endText)
  return {
    page: {
      pageNumber: 1,
      width,
      height,
      invalidGraphicsBounds: 0,
      graphicsBounds: graphics,
      lines: [{ text, x: 50, y: y + 7, width: 230, height: 10, fontSize: 10 }]
    },
    captions: [caption],
    tables: [],
    tokens: [
      {
        text,
        sourceItem: { ...item.sourceItem },
        rect: caption.rect,
        horizontal: true,
        fontSize: 10
      }
    ],
    context: {
      operators,
      content: { items: [item], styles: { Body: { ascent: 0.8, descent: -0.2, vertical: false } } },
      viewport: { width, height, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, height] }
    }
  }
}
const stackAssociation = (
  f: ReturnType<typeof nativeContiguousStack>,
  native = true
): ReturnType<typeof JSON.parse> =>
  associateFigures(f.page, f.captions, f.tables, [], [], f.tokens, native ? f.context : undefined)

// Complete anonymous paint/text stream: one labeled column and an independent
// neighboring image/caption. No sampled document data or image bytes are needed.
const nativeLabeledColumn = (
  count = 3,
  extraText: boolean | 'coincident' = false
): ReturnType<typeof nativeContiguousStack> => {
  const f = nativeContiguousStack(Array.from({ length: count }, () => 100))
  const { operators: o, content } = f.context
  const addText = (text: string, x: number, y: number, width: number, size = 10): void => {
    const index = content.items.length
    content.items.push({
      str: text,
      dir: 'ltr',
      width,
      height: size,
      fontName: 'Body',
      hasEOL: true,
      transform: [size, 0, 0, size, x, 800 - y - size],
      sourceItem: { pageNumber: 1, index, text }
    })
    o.fnArray.push(OPS.beginText, OPS.setFont, OPS.moveText, OPS.showText, OPS.endText)
    o.argsArray.push(
      [],
      ['Body', size],
      [x, 800 - y - size],
      [
        Array.from(text, (unicode) => ({
          unicode,
          fontChar: unicode,
          width: (width * 1000) / size / text.length,
          isSpace: unicode === ' '
        }))
      ],
      []
    )
    f.tokens.push({
      text,
      rect: [x, y, x + width, y + size],
      horizontal: true,
      fontSize: size,
      sourceItem: { pageNumber: 1, index, text }
    })
    f.page.lines.push({ text, x, y, width, height: size, fontSize: size })
  }
  for (let i = 0; i < count; i++)
    addText(`(${String.fromCharCode(97 + i)})`, 250, 65 + i * 101, 15, 8)
  if (extraText === 'coincident') addText('Ink', 250, 65, 15, 8)
  else if (extraText) addText('Separate note.', 100, 163, 90, 8)
  const operationIndex = o.fnArray.length + 2
  o.fnArray.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore)
  o.argsArray.push([], [150, 0, 0, 120, 350, 620], ['independent-column', 300, 240], [])
  f.page.graphicsBounds.push({
    kind: 'image',
    operationIndex,
    normalizedRect: [350 / 600, 60 / 800, 500 / 600, 180 / 800]
  })
  const text = 'Figure 2. Separate view.'
  addText(text, 340, 190, 170)
  f.captions.push({ page: 1, lines: [text], rect: [340, 190, 510, 200] })
  f.context.graphicsBounds = structuredClone(f.page.graphicsBounds)
  return f
}

it.each([2, 3, 4])(
  'retains all %s labeled native panels in their exclusive caption column',
  (count) => {
    const f = nativeLabeledColumn(count),
      before = structuredClone(f)
    const found = stackAssociation(f)
    const column = found.find(
      (g: { caption: { lines: string[] } }) => g.caption.lines[0] === f.captions[0].lines[0]
    )
    expect(column.rect).toEqual([60, 60, 265, 60 + count * 100 + count - 1])
    expect(column.graphicsCount).toBe(count)
    expect(column.sourceItems).toBeUndefined()
    expect(found).toHaveLength(2)
    expect(f).toEqual(before)
  }
)

function overlappingLabeledColumn(overlap = 0.25): ReturnType<typeof nativeLabeledColumn> {
  const f = nativeLabeledColumn(),
    o = f.context.operators
  // Extend the first two images into the next one without moving any label.
  // Each full label remains above the next image's actual top edge.
  for (let i = 0; i < 2; i++) {
    const g = f.page.graphicsBounds[i],
      matrix = o.argsArray[g.operationIndex - 1]
    matrix[3] += 1 + overlap
    matrix[5] -= 1 + overlap
    g.normalizedRect[3] += (1 + overlap) / 800
  }
  f.context.graphicsBounds = structuredClone(f.page.graphicsBounds)
  return f
}

it.each([0.25, 7])(
  'retains an ordered whole-label raster column with %s points of real paint overlap',
  (overlap) => {
    const f = overlappingLabeledColumn(overlap),
      before = structuredClone(f)
    const column = stackAssociation(f).find(
      (g: { caption: { lines: string[] } }) => g.caption.lines[0] === f.captions[0].lines[0]
    )
    expect(column.rect).toEqual([60, 60, 265, 362])
    expect(column.graphicsCount).toBe(3)
    expect(column.sourceItems).toBeUndefined()
    expect(f).toEqual(before)
  }
)

it.each([
  'nested-image',
  'covered-label',
  'reversed-paint',
  'unknown-paint',
  'foreign-caption',
  'duplicate-domain'
])('refuses overlapping packets with %s ambiguity', async (change) => {
  const { nativeCaptionedLabeledRasterStack } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
  )
  const f = overlappingLabeledColumn(),
    o = f.context.operators
  if (change === 'nested-image') {
    const g = f.page.graphicsBounds[0],
      m = o.argsArray[g.operationIndex - 1]
    m[3] += 150
    m[5] -= 150
    g.normalizedRect[3] += 150 / 800
    f.context.graphicsBounds = structuredClone(f.page.graphicsBounds)
  }
  if (change === 'covered-label') {
    const g = f.page.graphicsBounds[1],
      matrix = o.argsArray[g.operationIndex - 1]
    matrix[3] += 91
    g.normalizedRect[1] -= 91 / 800
    f.context.graphicsBounds = structuredClone(f.page.graphicsBounds)
    f.context.content.items[2].transform[5] += 91
    const shows = o.fnArray.flatMap((n: number, i: number) => (n === OPS.showText ? [i] : []))
    o.argsArray[shows[2] - 1][1] += 91
  }
  if (change === 'reversed-paint') {
    const a = f.page.graphicsBounds[0].operationIndex,
      b = f.page.graphicsBounds[1].operationIndex
    ;[o.argsArray[a - 1], o.argsArray[b - 1]] = [o.argsArray[b - 1], o.argsArray[a - 1]]
    ;[f.page.graphicsBounds[0].normalizedRect, f.page.graphicsBounds[1].normalizedRect] = [
      f.page.graphicsBounds[1].normalizedRect,
      f.page.graphicsBounds[0].normalizedRect
    ]
    f.context.graphicsBounds = structuredClone(f.page.graphicsBounds)
  }
  if (change === 'unknown-paint') {
    o.fnArray.push(OPS.shadingFill)
    o.argsArray.push(['unproved'])
  }
  if (change === 'foreign-caption')
    f.captions.push({ page: 1, lines: ['Figure 3. Separate.'], rect: [60, 150, 250, 160] })
  if (change === 'duplicate-domain')
    f.context.content.items[1].sourceItems = [{ ...f.context.content.items[1].sourceItem }]
  expect(
    nativeCaptionedLabeledRasterStack(f.page, f.captions[0], f.captions, f.tables, f.context, {
      caption: f.captions[0],
      rect: [60, 262, 260, 362],
      graphicsCount: 1
    })
  ).toBeUndefined()
})

it.each(['valid', 'missing', 'duplicate', 'different-paint', 'wrong-domain', 'wrong-kind'])(
  'binds a painted raster inset to its complete native image domain: %s',
  (evidence) => {
    const f = nativeContiguousStack([100, 120])
    for (const g of f.page.graphicsBounds)
      g.paintedNormalizedRect = g.normalizedRect.map(
        (n: number, i: number) => n + (i < 2 ? 9 : -9) / (i % 2 ? 800 : 600)
      )
    f.context.graphicsBounds = structuredClone(f.page.graphicsBounds)
    if (evidence === 'missing') f.context.graphicsBounds = []
    if (evidence === 'duplicate') f.context.graphicsBounds.push(f.context.graphicsBounds[0])
    if (evidence === 'different-paint') f.context.graphicsBounds[0].paintedNormalizedRect[0] += 0.01
    if (evidence === 'wrong-domain') f.context.graphicsBounds[0].normalizedRect[0] += 0.1
    if (evidence === 'wrong-kind') f.context.graphicsBounds[0].kind = 'path'
    const before = structuredClone(f)
    const found = stackAssociation(f)
    if (evidence === 'valid') {
      expect(found[0].rect).toEqual([60, 60, 260, 281])
      expect(found[0].graphicsCount).toBe(2)
    } else expect(found[0].rect[1]).toBeGreaterThan(150)
    expect(found[0].sourceItems).toBeUndefined()
    expect(f).toEqual(before)
  }
)

it.each([
  'table',
  'malformed-table',
  'caption',
  'duplicate-caption',
  'unknown-paint',
  'native-literal',
  'native-alias',
  'missing-font',
  'missing-image',
  'unknown-image',
  'independent-native-text',
  'coincident-native-domain',
  'coincident-unmapped-paint',
  'missing-context'
])('rejects labeled column recovery with %s evidence', async (failure) => {
  const { nativeCaptionedLabeledRasterStack } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
  )
  const f = nativeLabeledColumn(
    3,
    failure === 'coincident-native-domain' ? 'coincident' : failure === 'independent-native-text'
  )
  if (failure === 'coincident-unmapped-paint') {
    f.context.content.styles.Body.ascent = 0.75
    f.context.content.styles.Body.descent = -0.25
    f.context.operators.fnArray.push(
      OPS.beginText,
      OPS.setFont,
      OPS.moveText,
      OPS.showText,
      OPS.endText
    )
    f.context.operators.argsArray.push(
      [],
      ['Body', 8],
      [250, 727],
      [
        [
          {
            unicode: ' ',
            fontChar: '\u0001',
            width: 1875,
            isSpace: false,
            isInFont: true
          }
        ]
      ],
      []
    )
    f.context.glyphBounds = [
      { fontName: 'Body', glyphs: [{ fontChar: '\u0001', bounds: [0, -0.25, 1.875, 0.75] }] }
    ]
  }
  if (failure === 'table') f.tables.push([80, 90, 200, 120])
  if (failure === 'malformed-table') f.tables.push([80, Number.NaN, 200, 120])
  if (failure === 'caption')
    f.captions.push({ page: 1, lines: ['Figure 3. Other.'], rect: [80, 90, 200, 100] })
  if (failure === 'duplicate-caption') f.captions.push(structuredClone(f.captions[0]))
  if (failure === 'unknown-paint') {
    f.context.operators.fnArray.push(999999)
    f.context.operators.argsArray.push([])
  }
  if (failure === 'native-literal') f.context.content.items[2].str = '(z)'
  if (failure === 'native-alias') f.context.content.items[2].sourceItem.index = 1
  if (failure === 'missing-font') delete f.context.content.styles.Body.ascent
  if (failure === 'missing-image') f.context.graphicsBounds.pop()
  if (failure === 'unknown-image')
    f.page.graphicsBounds.push({ ...f.page.graphicsBounds[0], operationIndex: 999999 })
  const before = structuredClone(f)
  expect(
    nativeCaptionedLabeledRasterStack(
      f.page,
      f.captions[0],
      f.captions,
      f.tables,
      failure === 'missing-context' ? undefined : f.context,
      { caption: f.captions[0], rect: [60, 262, 260, 362], graphicsCount: 1 }
    )
  ).toBeUndefined()
  expect(f).toEqual(before)
})

it.each([
  [100, 120, 110],
  [100, 150],
  [90, 115, 96, 105]
])('retains all native contiguous raster components with heights %j', (...heights) => {
  const f = nativeContiguousStack(heights, 15),
    before = structuredClone(f)
  const found = stackAssociation(f)
  expect(found).toHaveLength(1)
  expect(found[0].rect).toEqual([
    60,
    75,
    260,
    75 + heights.reduce((a, b) => a + b, 0) + heights.length - 1
  ])
  expect(found[0].graphicsCount).toBe(heights.length)
  expect(found[0].sourceItems).toBeUndefined()
  expect(f).toEqual(before)
})

it.each([
  'table',
  'caption',
  'native-font',
  'unrecorded-path',
  'side-raster',
  'duplicate-operation',
  'missing-record',
  'wrong-geometry',
  'source-alias',
  'viewport',
  'unknown-paint',
  'wide-gap',
  'unknown-font',
  'active-mask',
  'unbalanced-state',
  'unmapped-text-paint',
  'overlapping-images'
])(
  'leaves the legacy crop unchanged when contiguous raster proof has %s competition',
  (failure) => {
    const f = nativeContiguousStack(),
      o = f.context.operators
    if (failure === 'table') f.tables.push([90, 159, 130, 163])
    if (failure === 'caption')
      f.captions.push({
        page: 1,
        rect: [60, 155, 250, 164],
        lines: ['Figure 2. Separate component.']
      })
    if (failure === 'native-font') {
      f.context.content.items.push({
        ...f.context.content.items[0],
        str: 'Independent sentence.',
        width: 120,
        transform: [10, 0, 0, 10, 80, 642],
        sourceItem: { pageNumber: 1, index: 1, text: 'Independent sentence.' }
      })
      const text = 'Independent sentence.'
      o.fnArray.push(OPS.beginText, OPS.setFont, OPS.moveText, OPS.showText, OPS.endText)
      o.argsArray.push(
        [],
        ['Body', 10],
        [80, 642],
        [Array.from(text, (unicode) => ({ unicode, width: 12000 / text.length }))],
        []
      )
    }
    if (failure === 'unrecorded-path') {
      o.fnArray.push(OPS.constructPath)
      o.argsArray.push([OPS.fill, [], [70, 620, 200, 625]])
    }
    if (failure === 'side-raster') {
      const i = o.fnArray.length
      o.fnArray.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore)
      o.argsArray.push([], [100, 0, 0, 100, 400, 600], ['independent', 200, 200], [])
      f.page.graphicsBounds.push({
        kind: 'image',
        operationIndex: i + 2,
        normalizedRect: [400 / 600, 100 / 800, 500 / 600, 200 / 800]
      })
    }
    if (failure === 'duplicate-operation')
      f.page.graphicsBounds[0].operationIndex = f.page.graphicsBounds[1].operationIndex
    if (failure === 'missing-record') f.page.graphicsBounds.shift()
    if (failure === 'wrong-geometry') f.page.graphicsBounds[0].normalizedRect[0] += 0.1
    if (failure === 'source-alias')
      f.context.content.items[0].sourceItems = [f.context.content.items[0].sourceItem]
    if (failure === 'viewport') f.context.viewport.transform = [1, 0, 0]
    if (failure === 'unknown-paint') {
      o.fnArray.push(OPS.paintImageMaskXObject)
      o.argsArray.push([{}])
    }
    if (failure === 'unknown-font') delete f.context.content.styles.Body
    if (failure === 'active-mask') {
      o.fnArray.push(OPS.setGState)
      o.argsArray.push([[['SMask', true]]])
    }
    if (failure === 'unbalanced-state') {
      o.fnArray.push(OPS.save)
      o.argsArray.push([])
    }
    if (failure === 'unmapped-text-paint') {
      o.fnArray.push(OPS.showText)
      o.argsArray.push([[{ unicode: 'Unaccounted ink', width: 500 }]])
    }
    if (failure === 'overlapping-images') {
      o.argsArray[5][5] += 10
      f.page.graphicsBounds[1].normalizedRect = f.page.graphicsBounds[1].normalizedRect.map(
        (v: number, i: number) => v + (i % 2 ? -10 / 800 : 0)
      )
    }
    if (failure === 'wide-gap') {
      o.argsArray[1][5] += 20
      f.page.graphicsBounds[0].normalizedRect = f.page.graphicsBounds[0].normalizedRect.map(
        (v: number, i: number) => v - (i % 2 ? 20 / 800 : 0)
      )
    }
    expect(stackAssociation(f)).toEqual(stackAssociation(f, false))
  }
)

it('preserves a single raster and refuses to use a missing native context as stack evidence', () => {
  const f = nativeContiguousStack([100])
  expect(stackAssociation(f)).toEqual(stackAssociation(f, false))
  const stack = nativeContiguousStack()
  expect(stackAssociation(stack, false)[0].graphicsCount).toBe(1)
})

it('retains both framed upper panels and the lower raster-backed framework without mutation', () => {
  const input = fixture('raster-backed-paired-framework')
  const before = structuredClone(input)
  const found = nativeCaptionedRasterFrameBands(input.page, input.captions[0], input.captions, [])
  expect(found?.rect[1]).toBeLessThan(73)
  expect(found?.rect[3]).toBeGreaterThan(237)
  expect(associateFigures(input.page, input.captions)[0].rect).toEqual(found.rect)
  expect(input).toEqual(before)
})

it.each(['raster', 'frame', 'caption', 'table', 'prose', 'misaligned'])(
  'declines a paired framework with missing or conflicting %s evidence',
  (failure) => {
    const { page, captions } = fixture('raster-backed-paired-framework')
    const tables: number[][] = []
    if (failure === 'raster') for (const g of page.graphicsBounds) delete g.imageHash
    if (failure === 'frame')
      page.graphicsBounds = page.graphicsBounds.filter(
        (g: ReturnType<typeof JSON.parse>) => g.kind !== 'path'
      )
    if (failure === 'caption')
      captions.push({
        page: 1,
        rect: [125, 155, 490, 167],
        lines: ['Figure 2. Independent plate.']
      })
    if (failure === 'table') tables.push([300, 75, 485, 150])
    if (failure === 'prose')
      page.lines.push({
        text: 'A separately typeset paragraph explains the previous results and continues with an independent discussion of the method.',
        fontSize: 9,
        x: 125,
        y: 152,
        width: 360,
        height: 10
      })
    if (failure === 'misaligned') page.graphicsBounds[0].paintedNormalizedRect[0] += 0.05
    expect(nativeCaptionedRasterFrameBands(page, captions[0], captions, tables)).toBeUndefined()
  }
)

it('retains all three raster maps, color keys and axis labels without changing source evidence', () => {
  const input = fixture('aligned-raster-map-stack')
  const before = structuredClone(input)
  const found = nativeCaptionedRasterMapStack(input.page, input.captions[0], input.captions, [])
  expect(found?.graphicsCount).toBe(6)
  expect(found?.rect[1]).toBeLessThan(65)
  expect(found?.rect[3]).toBeGreaterThan(670)
  expect(associateFigures(input.page, input.captions)[0].rect).toEqual(found.rect)
  expect(input).toEqual(before)
})

it.each(['key', 'raster', 'misalignment', 'spacing', 'caption', 'table', 'prose'])(
  'declines raster maps with %s ambiguity',
  (failure) => {
    const { page, captions } = fixture('aligned-raster-map-stack')
    const tables: number[][] = []
    if (failure === 'key') page.graphicsBounds.splice(1, 1)
    if (failure === 'raster') for (const g of page.graphicsBounds) delete g.imageHash
    if (failure === 'misalignment') page.graphicsBounds[0].normalizedRect[0] += 0.08
    if (failure === 'spacing')
      page.graphicsBounds[0].normalizedRect = page.graphicsBounds[0].normalizedRect.map(
        (v: number, i: number) => v - (i % 2 ? 0.07 : 0)
      )
    if (failure === 'caption')
      captions.push({ page: 1, rect: [100, 280, 500, 295], lines: ['Figure 2. Independent map.'] })
    if (failure === 'table') tables.push([100, 290, 400, 400])
    if (failure === 'prose')
      page.lines.push({
        text: 'An independent paragraph discusses the preceding experiment.',
        fontSize: 8,
        x: 100,
        y: 260,
        width: 370,
        height: 8
      })
    expect(nativeCaptionedRasterMapStack(page, captions[0], captions, tables)).toBeUndefined()
  }
)

it('pairs independently ruled tables across separate columns and reverse detector order', () => {
  const input = fixture('separate-ruled-table-caption-lanes')
  const before = structuredClone(input)
  const associated = associateTableCaptions(input.page, input.tables, input.captions, input.rules)
  expect(associated.map((a: ReturnType<typeof JSON.parse>) => a.caption?.lines[0])).toEqual([
    'TABLE III',
    'TABLE II',
    'TABLE I'
  ])
  expect(input).toEqual(before)
  const reversed = associateTableCaptions(
    input.page,
    input.tables.toReversed(),
    input.captions,
    input.rules
  )
  expect(reversed.map((a: ReturnType<typeof JSON.parse>) => a.caption?.lines[0])).toEqual([
    'TABLE I',
    'TABLE II',
    'TABLE III'
  ])
})

it('uses the native opening before a separator when predictions contain only body rows', () => {
  const { page, tables, captions, rules } = fixture('body-only-ruled-table-caption-stack')
  expect(
    associateTableCaptions(page, tables, captions, rules).map(
      (a: ReturnType<typeof JSON.parse>) => a.caption?.lines[0]
    )
  ).toEqual([
    'Table 2: Anonymous experimental metrics.',
    'Table 3: Anonymous experimental metrics.',
    'Table 1: Anonymous experimental metrics.'
  ])
})

it('does not let an upper vector form borrow the next captioned raster pair', () => {
  const captions = [
    { page: 1, lines: ['Figure 1. Vector form.'], rect: [40, 202, 285, 250] },
    { page: 1, lines: ['Figure 2. Raster maps.'], rect: [40, 605, 285, 650] }
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: captions.map((c) => ({
      text: c.lines[0],
      fontSize: 8,
      x: c.rect[0],
      y: c.rect[1],
      width: 230,
      height: 8
    })),
    graphicsBounds: [
      {
        kind: 'image',
        normalizedRect: [0.07, 0.07, 0.48, 0.25],
        paintedNormalizedRect: [0.075, 0.075, 0.475, 0.245]
      },
      { kind: 'image', normalizedRect: [0.07, 0.39, 0.48, 0.52], imageHash: 'first-map' },
      { kind: 'image', normalizedRect: [0.07, 0.6, 0.48, 0.73], imageHash: 'second-map' }
    ]
  }
  const matches = associateFigures(page, captions)
  expect(matches[0].rect?.[3] ?? 0).toBeLessThanOrEqual(captions[0].rect[1])
  expect(matches[1].rect?.[1]).toBeGreaterThan(captions[0].rect[3])
})

it('keeps a compact table title away from an oversized preceding fragment', () => {
  const input = fixture('compact-table-caption-with-competing-fragment')
  const before = structuredClone(input)
  const matches = associateTableCaptions(input.page, input.tables, input.captions, input.rules)
  expect(matches.map((m: ReturnType<typeof JSON.parse>) => m.caption?.lines[0])).toEqual([
    undefined,
    'Table 3: Anonymous experimental results.',
    'Table 1: Anonymous experimental results.',
    'Table 2: Anonymous experimental results.'
  ])
  expect(input).toEqual(before)
})

it('keeps native below-frame captions with their preceding complete tables', () => {
  const input = fixture('ruled-tables-below-caption-stack')
  const before = structuredClone(input)
  const matches = associateTableCaptions(input.page, input.tables, input.captions, input.rules)
  expect(matches.map((m: ReturnType<typeof JSON.parse>) => m.caption?.lines[0])).toEqual([
    'Table 2: Anonymous experimental results.',
    'Table 1: Anonymous experimental results.',
    'Table 3: Anonymous experimental results.'
  ])
  expect(input).toEqual(before)
})

it('keeps above and below caption orientations independent on the same page', () => {
  const below = fixture('ruled-tables-below-caption-stack')
  const above = fixture('body-only-ruled-table-caption-stack')
  const offset = 700
  const shiftedRect = (rect: number[]): number[] =>
    rect.map((value, index) => value + (index % 2 ? offset : 0))
  const tables = [
    ...below.tables,
    ...above.tables.map((table: { rect: number[] }) => ({
      ...table,
      rect: shiftedRect(table.rect)
    }))
  ]
  const captions = [
    ...below.captions,
    ...above.captions.map((caption: { rect: number[] }) => ({
      ...caption,
      rect: shiftedRect(caption.rect)
    }))
  ]
  const page = {
    ...below.page,
    height: 2000,
    lines: [
      ...below.page.lines,
      ...above.page.lines.map((line: { y: number }) => ({ ...line, y: line.y + offset }))
    ]
  }
  const rules = [...below.rules, ...above.rules.map(shiftedRect)]
  expect(
    associateTableCaptions(page, tables, captions, rules).map(
      (match: ReturnType<typeof JSON.parse>) => match.caption?.lines[0]
    )
  ).toEqual([
    'Table 2: Anonymous experimental results.',
    'Table 1: Anonymous experimental results.',
    'Table 3: Anonymous experimental results.',
    'Table 2: Anonymous experimental metrics.',
    'Table 3: Anonymous experimental metrics.',
    'Table 1: Anonymous experimental metrics.'
  ])
})

it.each(['closing-rule', 'prose', 'overlapping-owner'])(
  'does not override shared compact-caption ambiguity without %s proof',
  (failure) => {
    const { page, tables, captions, rules } = fixture(
      'compact-table-caption-with-competing-fragment'
    )
    if (failure === 'closing-rule') {
      const last = rules.findIndex((r: number[]) => Math.abs(r[1] - 578.22845831) < 0.01)
      rules.splice(last, 1)
    }
    if (failure === 'prose')
      page.lines.push({
        text: 'An independent source paragraph separates this title from the later table.',
        x: 110,
        y: 481,
        width: 370,
        height: 10,
        fontSize: 10
      })
    if (failure === 'overlapping-owner') tables.push(structuredClone(tables[3]))
    expect(associateTableCaptions(page, tables, captions, rules)[3].caption).toBeUndefined()
  }
)

const { nativeRepeatedRowPanelEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
)
const repeatedRowPanels = (dy = 0): ReturnType<typeof JSON.parse> => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [] as ReturnType<typeof JSON.parse>[],
    graphicsBounds: [] as ReturnType<typeof JSON.parse>[]
  }
  const context = {
    viewport: { width: 600, height: 800, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 800] },
    content: {
      items: [] as ReturnType<typeof JSON.parse>[],
      styles: { Generic: { ascent: 0.8, descent: -0.2, vertical: false } }
    },
    operators: { fnArray: [] as number[], argsArray: [] as unknown[][] }
  }
  const emit = (op: number, args: unknown[] = []): number => {
    context.operators.fnArray.push(op)
    context.operators.argsArray.push(args)
    return context.operators.fnArray.length - 1
  }
  const tokens: ReturnType<typeof JSON.parse>[] = []
  const text = (str: string, x: number, y: number, width: number): void => {
    const sourceItem = { pageNumber: 1, index: context.content.items.length, text: str }
    const item = {
      str,
      width,
      height: 10,
      transform: [10, 0, 0, 10, x, 800 - y - 10 - dy],
      fontName: 'Generic',
      dir: 'ltr',
      hasEOL: true,
      sourceItem
    }
    context.content.items.push(item)
    tokens.push({
      text: str,
      rect: [x, y + dy, x + width, y + 10 + dy],
      horizontal: true,
      sourceItem
    })
    page.lines.push({ text: str, x, y: y + dy, width, height: 10, fontSize: 10 })
    emit(OPS.beginText)
    emit(OPS.setFont, ['Generic', 10])
    emit(OPS.moveText, [x, 800 - y - 10 - dy])
    emit(OPS.showText, [
      Array.from(str, (unicode) => ({ unicode, width: (width * 100) / str.length }))
    ])
    emit(OPS.endText)
  }
  const paint = (kind: string, rect: number[]): void => {
    const [x0, y0, x1, y1] = rect.map((v, i) => v + (i % 2 ? dy : 0))
    let operationIndex: number
    if (kind === 'image') {
      emit(OPS.save)
      emit(OPS.transform, [x1 - x0, 0, 0, y1 - y0, x0, 800 - y1])
      operationIndex = emit(OPS.paintImageXObject, ['generic-raster', 100, 100])
      emit(OPS.restore)
    } else
      operationIndex = emit(OPS.constructPath, [
        OPS.fill,
        [new Float32Array([0, x0, 800 - y1, 1, x1, 800 - y1, 1, x1, 800 - y0, 1, x0, 800 - y0, 4])],
        new Float32Array([x0, 800 - y1, x1, 800 - y0])
      ])
    page.graphicsBounds.push({
      kind,
      operationIndex,
      normalizedRect: [x0 / 600, y0 / 800, x1 / 600, y1 / 800]
    })
  }
  text('(a) First modality', 50, 100, 100)
  text('Input', 60, 120, 30)
  paint('path', [100, 119, 160, 134])
  text('3, 1, 4', 105, 120, 45)
  text('Query', 60, 140, 30)
  paint('path', [100, 139, 140, 154])
  text('3, 1', 105, 140, 30)
  text('(b) Other modality', 50, 170, 110)
  text('Input', 60, 195, 30)
  paint('image', [100, 190, 160, 220])
  paint('image', [160, 190, 220, 220])
  text('Query', 60, 235, 30)
  paint('image', [100, 230, 160, 260])
  const caption = {
    page: 1,
    rect: [45, 270 + dy, 300, 280 + dy],
    lines: ['Figure 1. Examples (a) and (b).']
  }
  text(caption.lines[0], 45, 270, 255)
  return { page, context, tokens, captions: [caption], tables: [] }
}
it.each([0, 27])(
  'retains native text-only and raster panels with the same repeated row headings (%s)',
  (dy) => {
    const f = repeatedRowPanels(dy),
      p = nativeRepeatedRowPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
    expect(p).toBeDefined()
    expect(p.bounds[1]).toBeLessThanOrEqual(100 + dy)
    expect(p.bounds[3]).toBeGreaterThanOrEqual(260 + dy)
    expect(p.accepts(p.bounds)).toBe(true)
  }
)
it.each([
  'caption',
  'table',
  'prose',
  'alias',
  'glyph',
  'missing-paint',
  'unknown-paint',
  'heading-order',
  'row-label',
  'viewport'
])('refuses repeated native rows with %s competition', (failure) => {
  const f = repeatedRowPanels()
  if (failure === 'caption')
    f.captions.push({ page: 1, rect: [50, 160, 220, 170], lines: ['Figure 2. Independent.'] })
  if (failure === 'table') f.tables.push([95, 185, 225, 225])
  if (failure === 'prose')
    f.page.lines.push({
      text: 'Independent paragraph.',
      x: 70,
      y: 158,
      width: 200,
      height: 10,
      fontSize: 10
    })
  if (failure === 'alias')
    f.context.content.items[0].sourceItems = [f.context.content.items[1].sourceItem]
  if (failure === 'glyph')
    f.context.operators.argsArray[f.context.operators.fnArray.indexOf(OPS.showText)][0][0].unicode =
      'X'
  if (failure === 'missing-paint') f.page.graphicsBounds.shift()
  if (failure === 'unknown-paint') {
    f.context.operators.fnArray.push(OPS.shadingFill)
    f.context.operators.argsArray.push(['unknown'])
  }
  if (failure === 'heading-order') f.tokens[4].text = '(c) Other modality'
  if (failure === 'row-label')
    f.tokens.find((t: { text: string }) => t.text === 'Query').text = 'Foreign'
  if (failure === 'viewport') f.context.viewport.transform[4] = 1
  expect(
    nativeRepeatedRowPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
  ).toBeUndefined()
})
it('uses the complete native repeated-row bound at the real association seam', () => {
  const f = repeatedRowPanels(),
    proof = nativeRepeatedRowPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
  const result = associateFigures(f.page, f.captions, f.tables, [], [], f.tokens, f.context)
  expect(result).toHaveLength(1)
  expect(result[0].rect).toEqual(proof.bounds)
  expect(result[0].sourceItems).toBeUndefined()
})
it.each([
  'missing-font',
  'missing-ascent',
  'NaN-ascent',
  'invalid-ascent',
  'duplicate-identity',
  'source-token-alias',
  'unknown-style',
  'caption-source',
  'image-order',
  'independent-font',
  'distant-number'
])('rejects a mixed-row proof with %s evidence', (failure) => {
  const f = repeatedRowPanels()
  if (failure === 'missing-font') f.context.content.styles = {}
  if (failure === 'missing-ascent') delete f.context.content.styles.Generic.ascent
  if (failure === 'NaN-ascent') f.context.content.styles.Generic.ascent = NaN
  if (failure === 'invalid-ascent') f.context.content.styles.Generic.ascent = 1.1
  if (failure === 'duplicate-identity')
    f.context.content.items[1].sourceItem = { ...f.context.content.items[0].sourceItem }
  if (failure === 'source-token-alias')
    f.tokens.at(-1).sourceToken = { sourceItem: f.tokens[0].sourceItem }
  if (failure === 'unknown-style') f.context.content.styles.Generic.vertical = true
  if (failure === 'caption-source') f.captions[0].lines = ['Figure 1. Alternative (a) and (b).']
  if (failure === 'image-order') {
    const i = f.context.operators.fnArray.indexOf(OPS.paintImageXObject),
      j = f.context.operators.fnArray.indexOf(OPS.showText)
    ;[f.context.operators.fnArray[i], f.context.operators.fnArray[j]] = [
      f.context.operators.fnArray[j],
      f.context.operators.fnArray[i]
    ]
    ;[f.context.operators.argsArray[i], f.context.operators.argsArray[j]] = [
      f.context.operators.argsArray[j],
      f.context.operators.argsArray[i]
    ]
  }
  if (failure === 'independent-font')
    f.page.lines.push({
      text: 'Unrelated note',
      x: 170,
      y: 145,
      width: 70,
      height: 10,
      fontSize: 10
    })
  if (failure === 'distant-number') {
    const item = f.context.content.items[2],
      t = f.tokens[2]
    item.transform[4] += 200
    t.rect = t.rect.map((n: number, i: number) => n + (i % 2 ? 0 : 200))
    f.page.lines[2].x += 200
  }
  expect(
    nativeRepeatedRowPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
  ).toBeUndefined()
})
it('revalidates the final envelope against native prose, tables and page furniture', () => {
  const f = repeatedRowPanels(),
    proof = nativeRepeatedRowPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
  expect(proof).toBeDefined()
  expect(proof.accepts([45, 100, 300, 285])).toBe(false)
  f.tables.push([300, 100, 360, 270])
  expect(proof.accepts([40, 90, 370, 265])).toBe(false)
})
const repeatedRowsWithFilteredMargin = (): ReturnType<typeof JSON.parse> => {
  const f = repeatedRowPanels()
  for (const g of f.page.graphicsBounds) g.operationIndex++
  f.context.operators.fnArray.unshift(OPS.constructPath)
  f.context.operators.argsArray.unshift([
    OPS.stroke,
    [new Float32Array([0, 10, 750, 1, 590, 750])],
    new Float32Array([10, 750, 590, 750])
  ])
  const margin = {
    kind: 'path',
    operationIndex: 0,
    normalizedRect: [9.5 / 600, 49.5 / 800, 590.5 / 600, 50.5 / 800]
  }
  f.context.graphicsBounds = [margin, ...structuredClone(f.page.graphicsBounds)]
  return f
}
it('checks the complete same-render inventory after production removes page furniture', () => {
  const f = repeatedRowsWithFilteredMargin(),
    proof = nativeRepeatedRowPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
  expect(proof).toBeDefined()
  expect(
    associateFigures(f.page, f.captions, f.tables, [], [], f.tokens, f.context)[0].rect
  ).toEqual(proof.bounds)
  expect(proof.accepts([9, 40, 591, 260])).toBe(false)
})
it.each([
  'changed-identity',
  'changed-rect',
  'missing-native-paint',
  'unknown-paint',
  'omitted-inside'
])('rejects filtered page graphics with %s', (failure) => {
  const f = repeatedRowsWithFilteredMargin()
  if (failure === 'changed-identity') f.page.graphicsBounds[0].operationIndex = 0
  if (failure === 'changed-rect') f.page.graphicsBounds[0].normalizedRect[0] += 0.01
  if (failure === 'missing-native-paint') f.context.graphicsBounds.shift()
  if (failure === 'unknown-paint') f.context.operators.fnArray[0] = OPS.shadingFill
  if (failure === 'omitted-inside') {
    f.context.operators.argsArray[0] = [
      OPS.stroke,
      [new Float32Array([0, 10, 650, 1, 590, 650])],
      new Float32Array([10, 650, 590, 650])
    ]
    f.context.graphicsBounds[0].normalizedRect = [9.5 / 600, 149.5 / 800, 590.5 / 600, 150.5 / 800]
  }
  expect(
    nativeRepeatedRowPanelEvidence(f.page, f.captions, f.tables, f.tokens, f.context)
  ).toBeUndefined()
})

// One short caption owns an adjacent raster band; other page figures remain separate.
const nativeHorizontalBand = (widths = [150, 190], scale = 1): ReturnType<typeof JSON.parse> => {
  const f = nativeContiguousStack([100, 100])
  const graphics: ReturnType<typeof JSON.parse>[] = []
  const operators = { fnArray: [] as number[], argsArray: [] as unknown[][] }
  const emit = (op: number, a: unknown[] = []): number => {
    operators.fnArray.push(op)
    operators.argsArray.push(a)
    return operators.fnArray.length - 1
  }
  let left = 60
  for (const [i, width] of widths.entries()) {
    emit(OPS.save)
    emit(OPS.transform, [width * scale, 0, 0, 120 * scale, left * scale, 580 * scale])
    const operationIndex = emit(OPS.paintImageXObject, [`native-photo-${i}`, width, 120])
    emit(OPS.restore)
    graphics.push({
      kind: 'image',
      operationIndex,
      normalizedRect: [left / 600, 100 / 800, (left + width) / 600, 220 / 800]
    })
    left += width + 8
  }
  const text = 'Figure 1. Independent views.'
  const caption = { page: 1, lines: [text], rect: [60, 228, 190, 238].map((n) => n * scale) }
  const item = {
    str: text,
    dir: 'ltr',
    width: 130 * scale,
    height: 10 * scale,
    fontName: 'Body',
    hasEOL: true,
    transform: [10 * scale, 0, 0, 10 * scale, 60 * scale, 562 * scale],
    sourceItem: { pageNumber: 1, index: 0, text }
  }
  emit(OPS.beginText)
  emit(OPS.setFont, ['Body', 10 * scale])
  emit(OPS.moveText, [60 * scale, 562 * scale])
  emit(OPS.showText, [
    Array.from(text, (unicode) => ({
      unicode,
      fontChar: unicode,
      width: 13000 / text.length,
      isSpace: unicode === ' '
    }))
  ])
  emit(OPS.endText)
  f.page = {
    ...f.page,
    width: 600 * scale,
    height: 800 * scale,
    graphicsBounds: graphics,
    lines: [
      {
        text,
        x: 60 * scale,
        y: 228 * scale,
        width: 130 * scale,
        height: 10 * scale,
        fontSize: 10 * scale
      }
    ]
  }
  f.captions = [caption]
  f.tokens = [
    {
      text,
      sourceItem: { ...item.sourceItem },
      rect: caption.rect,
      horizontal: true,
      fontSize: 10 * scale
    }
  ]
  f.context = {
    operators,
    graphicsBounds: structuredClone(graphics),
    content: { items: [item], styles: { Body: { ascent: 0.8, descent: -0.2, vertical: false } } },
    viewport: {
      width: 600 * scale,
      height: 800 * scale,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 800 * scale]
    }
  }
  return f
}

it.each([0.8, 1.4])(
  'keeps the complete native raster band beyond a short caption at scale %s',
  (scale) => {
    const f = nativeHorizontalBand([150, 190], scale)
    const found = stackAssociation(f)
    expect(found).toHaveLength(1)
    expect(found[0].rect[2]).toBeCloseTo(408 * scale, 8)
    expect(found[0].graphicsCount).toBe(2)
    expect(found[0].sourceItems).toBeUndefined()
  }
)

it('preserves differently sized photographs sharing a native bottom alignment', async () => {
  const { nativeCaptionedRasterBand } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
  )
  const f = nativeHorizontalBand([130, 140, 120])
  for (const [i, height] of [150, 120, 110].entries()) {
    f.context.operators.argsArray[i * 4 + 1][3] = height
    f.page.graphicsBounds[i].normalizedRect[1] = (220 - height) / 800
    f.context.graphicsBounds[i].normalizedRect[1] = (220 - height) / 800
  }
  const nearest = { rect: [60, 70, 338, 220], graphicsCount: 2 }
  const result = nativeCaptionedRasterBand(
    f.page,
    f.captions[0],
    f.captions,
    [],
    f.context,
    nearest
  )
  expect(result?.rect).toEqual([60, 70, 466, 220])
  expect(result?.graphicsCount).toBe(3)
})

it('resolves an unassigned raster band from its unique caption-aligned native image', async () => {
  const { nativeCaptionedRasterBand } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
  )
  const f = nativeHorizontalBand()
  const unresolved = { issue: 'ambiguous-graphic-direction' }
  const result = nativeCaptionedRasterBand(
    f.page,
    f.captions[0],
    f.captions,
    [],
    f.context,
    unresolved
  )
  expect(result?.rect).toEqual([60, 100, 408, 220])
  expect(result?.graphicsCount).toBe(2)
  expect(result?.issue).toBeUndefined()
  expect(result?.sourceItems).toBeUndefined()
})

it.each([
  'competing-caption',
  'table',
  'unowned-font',
  'malformed-existing',
  'misaligned-caption',
  'accent'
])('refuses an unresolved raster band with %s', async (change) => {
  const { nativeCaptionedRasterBand } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
  )
  const f = nativeHorizontalBand()
  const unresolved = change === 'malformed-existing' ? { rect: [60, 100, NaN, 220] } : {}
  if (change === 'accent')
    f.context.operators.argsArray[f.context.operators.fnArray.indexOf(OPS.showText)][0][0].accent =
      { fontChar: '^', offset: { x: 0, y: 2 } }
  if (change === 'competing-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Other.'], rect: [220, 200, 390, 215] })
  if (change === 'table') f.tables.push([220, 190, 390, 210])
  if (change === 'unowned-font')
    f.context.content.items.push({
      ...f.context.content.items[0],
      str: 'Note',
      transform: [10, 0, 0, 10, 220, 650],
      sourceItem: { pageNumber: 1, index: 1, text: 'Note' }
    })
  if (change === 'misaligned-caption') f.captions[0].rect[0] += 20
  expect(
    nativeCaptionedRasterBand(f.page, f.captions[0], f.captions, f.tables, f.context, unresolved)
  ).toBeUndefined()
})

it.each([
  'other-caption',
  'table',
  'foreign-font',
  'font-operation-mismatch',
  'raw-literal',
  'missing-image',
  'duplicate-operation',
  'unknown-paint',
  'mask',
  'nondefault-text',
  'unmeasured-font',
  'different-row',
  'wide-gap',
  'overlapping-images',
  'image-corridor',
  'invalid-paint-count',
  'raw-alias'
])('does not widen a raster band with competing or unproved content: %s', async (change) => {
  const { nativeCaptionedRasterBand } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
  )
  const f = nativeHorizontalBand()
  const nearest = { caption: f.captions[0], rect: [60, 100, 210, 220], graphicsCount: 1 }
  if (change === 'other-caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Independent view.'], rect: [240, 215, 400, 225] })
  if (change === 'table') f.tables.push([215, 130, 218, 180])
  if (change === 'foreign-font') {
    const text = 'Independent note'
    f.context.content.items.push({
      ...f.context.content.items[0],
      str: text,
      width: 60,
      transform: [10, 0, 0, 10, 210, 630],
      sourceItem: { pageNumber: 1, index: 1, text }
    })
    f.context.operators.fnArray.push(
      OPS.beginText,
      OPS.setFont,
      OPS.moveText,
      OPS.showText,
      OPS.endText
    )
    f.context.operators.argsArray.push(
      [],
      ['Body', 10],
      [210, 630],
      [
        Array.from(text, (unicode) => ({
          unicode,
          width: 6000 / text.length,
          isSpace: unicode === ' '
        }))
      ],
      []
    )
  }
  if (change === 'font-operation-mismatch') f.context.operators.argsArray[9][0] = 'Other'
  if (change === 'raw-literal') f.context.content.items[0].str += 'Other'
  if (change === 'missing-image') f.context.graphicsBounds.pop()
  if (change === 'duplicate-operation')
    f.context.graphicsBounds[1].operationIndex = f.context.graphicsBounds[0].operationIndex
  if (change === 'unknown-paint') {
    f.context.operators.fnArray.push(OPS.shadingFill)
    f.context.operators.argsArray.push(['unknown'])
  }
  if (change === 'mask') {
    f.context.operators.fnArray.push(OPS.setGState)
    f.context.operators.argsArray.push([[['SMask', true]]])
  }
  if (change === 'nondefault-text') {
    f.context.operators.fnArray.push(OPS.setTextRenderingMode)
    f.context.operators.argsArray.push([1])
  }
  if (change === 'unmeasured-font') delete f.context.content.styles.Body.ascent
  if (change === 'different-row' || change === 'wide-gap' || change === 'overlapping-images') {
    const dx = change === 'wide-gap' ? 40 : change === 'overlapping-images' ? -30 : 0
    const dy = change === 'different-row' ? 20 : 0
    f.context.operators.argsArray[5][4] += dx
    f.context.operators.argsArray[5][5] -= dy
    for (const list of [f.page.graphicsBounds, f.context.graphicsBounds]) {
      list[1].normalizedRect[0] += dx / 600
      list[1].normalizedRect[2] += dx / 600
      list[1].normalizedRect[1] += dy / 800
      list[1].normalizedRect[3] += dy / 800
    }
  }
  if (change === 'image-corridor') {
    const operationIndex = f.context.operators.fnArray.length + 2
    f.context.operators.fnArray.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore)
    f.context.operators.argsArray.push(
      [],
      [4, 0, 0, 30, 212, 650],
      ['independent-image', 4, 30],
      []
    )
    const g = {
      kind: 'image',
      operationIndex,
      normalizedRect: [212 / 600, 120 / 800, 216 / 600, 150 / 800]
    }
    f.page.graphicsBounds.push(g)
    f.context.graphicsBounds.push(structuredClone(g))
  }
  if (change === 'invalid-paint-count') f.page.invalidGraphicsBounds = 1
  if (change === 'raw-alias')
    f.context.content.items[0].sourceSegments = [
      { ...f.context.content.items[0].sourceItem, start: 0, end: 1 }
    ]
  const before = structuredClone(f)
  expect(
    nativeCaptionedRasterBand(f.page, f.captions[0], f.captions, f.tables, f.context, nearest)
  ).toBeUndefined()
  expect(f).toEqual(before)
})

it('completes a raster band when the existing crop already owns two whole images', async () => {
  const { nativeCaptionedRasterBand } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
  )
  const f = nativeHorizontalBand([130, 140, 120])
  const nearest = { caption: f.captions[0], rect: [60, 100, 338, 220], graphicsCount: 2 }
  const result = nativeCaptionedRasterBand(
    f.page,
    f.captions[0],
    f.captions,
    f.tables,
    f.context,
    nearest
  )
  expect(result?.graphicsCount).toBe(3)
  expect(result?.rect).toEqual([60, 100, 466, 220])
})

it.each(['outside', 'inside', 'missing-path', 'duplicate-path'])(
  'uses an unmapped glyph only as exact paint exclusion evidence: %s',
  async (position) => {
    const { nativeCaptionedRasterBand } = await import(
      pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
    )
    const f = nativeHorizontalBand(),
      y = position === 'inside' ? 650 : 760
    f.context.operators.fnArray.push(
      OPS.beginText,
      OPS.setFont,
      OPS.moveText,
      OPS.showText,
      OPS.endText
    )
    f.context.operators.argsArray.push(
      [],
      ['Body', 10],
      [215, y],
      [[{ unicode: ' ', fontChar: '\u0001', width: 500, isSpace: false }]],
      []
    )
    f.context.glyphBounds = [
      { fontName: 'Body', glyphs: [{ fontChar: '\u0001', bounds: [0, 0, 0.5, 0.8] }] }
    ]
    if (position === 'missing-path') f.context.glyphBounds = []
    if (position === 'duplicate-path')
      f.context.glyphBounds[0].glyphs.push({ ...f.context.glyphBounds[0].glyphs[0] })
    const nearest = { caption: f.captions[0], rect: [60, 100, 210, 220], graphicsCount: 1 }
    const result = nativeCaptionedRasterBand(
      f.page,
      f.captions[0],
      f.captions,
      f.tables,
      f.context,
      nearest
    )
    if (position === 'outside') {
      expect(result?.graphicsCount).toBe(2)
      expect(result?.sourceItems).toBeUndefined()
    } else expect(result).toBeUndefined()
  }
)
it.each([
  'unpainted-space',
  'painted-space',
  'control-code',
  'control-font-char',
  'missing-font',
  'duplicate-font',
  'duplicate-path',
  'accent'
])('requires the complete native non-painting space contract: %s', async (change) => {
  const { nativeCaptionedRasterBand } = await import(
    pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
  )
  const f = nativeHorizontalBand()
  f.context.operators.fnArray.push(
    OPS.beginText,
    OPS.setFont,
    OPS.moveText,
    OPS.showText,
    OPS.endText
  )
  f.context.operators.argsArray.push(
    [],
    ['Body', 10],
    [212, 650],
    [
      [
        {
          originalCharCode: 32,
          fontChar: ' ',
          unicode: ' ',
          accent: null,
          width: 250,
          isSpace: true,
          isInFont: false
        }
      ]
    ],
    []
  )
  f.context.glyphBounds = [
    { fontName: 'Body', glyphs: [{ fontChar: ' ', bounds: [0.1, 0, 0.6, 0.6] }] }
  ]
  const glyph = f.context.operators.argsArray.at(-2)[0][0]
  if (change === 'painted-space') glyph.isInFont = true
  if (change === 'control-code') glyph.originalCharCode = 1
  if (change === 'control-font-char') {
    glyph.fontChar = '\u0001'
    f.context.glyphBounds[0].glyphs[0].fontChar = '\u0001'
  }
  if (change === 'missing-font') f.context.glyphBounds = []
  if (change === 'duplicate-font')
    f.context.glyphBounds.push(structuredClone(f.context.glyphBounds[0]))
  if (change === 'duplicate-path')
    f.context.glyphBounds[0].glyphs.push(structuredClone(f.context.glyphBounds[0].glyphs[0]))
  if (change === 'accent') glyph.accent = { fontChar: '^', offset: { x: 0, y: 2 } }
  const before = structuredClone(f)
  const result = nativeCaptionedRasterBand(f.page, f.captions[0], f.captions, [], f.context, {
    rect: [60, 100, 210, 220],
    graphicsCount: 1
  })
  if (change === 'unpainted-space') expect(result?.rect[2]).toBe(408)
  else expect(result).toBeUndefined()
  expect(f).toEqual(before)
})
