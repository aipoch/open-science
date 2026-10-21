import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const { nativeCaptionedRasterVectorStrip, nativeCaptionedRasterHorizontalArray } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-captioned-illustration.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('test/fixtures/source-grids/native-captioned-raster-plate-ownership.jsonl')
  )

it('keeps a neighboring independently captioned vector chart outside a raster inset chart', () => {
  const { page, captions } = fixture().column
  const before = structuredClone({ page, captions })
  const ownCaption = captions.find((c: ReturnType<typeof JSON.parse>) => c.rect[0] < page.width / 2)
  const recovered = nativeCaptionedRasterVectorStrip(page, ownCaption, captions, [])
  if (recovered) expect(recovered.rect[2]).toBeLessThan(306)
  const figures = associateFigures(page, captions, [])
  const left = figures.find(
    (f: ReturnType<typeof JSON.parse>) => f.caption.rect[0] < page.width / 2
  )
  expect(left.rect).toBeDefined()
  expect(left.rect[0]).toBeLessThanOrEqual(47.8125)
  expect(left.rect[1]).toBeLessThanOrEqual(49.5)
  expect(left.rect[2]).toBeGreaterThanOrEqual(303.609375)
  expect(left.rect[2]).toBeLessThan(306)
  expect(left.rect[3]).toBeGreaterThanOrEqual(194.90625)
  expect({ page, captions }).toEqual(before)
})

it.each([0.75, 1.5])('preserves complete raster plate ownership at scale %s', (scale) => {
  const { page, captions } = fixture().rows
  page.width *= scale
  page.height *= scale
  for (const line of page.lines)
    for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
  for (const caption of captions) caption.rect = caption.rect.map((v: number) => v * scale)
  page.lines.reverse()
  page.graphicsBounds.reverse()
  const before = structuredClone({ page, captions })
  const plate = nativeCaptionedRasterHorizontalArray(page, captions[0], captions, [])
  expect(plate.graphicsCount).toBe(20)
  expect(plate.rect[1]).toBeLessThanOrEqual(315.446596 * scale)
  expect(plate.rect[3]).toBeGreaterThanOrEqual(542.535383 * scale)
  expect(plate.rect[3]).toBeLessThan(captions[0].rect[1])
  expect({ page, captions }).toEqual(before)
})

it.each([
  'missing label',
  'duplicate label',
  'missing key',
  'prose',
  'table',
  'caption',
  'misaligned row',
  'nonfinite label'
])('does not join two raster rows without complete native ownership: %s', (change) => {
  const { page, captions } = fixture().rows
  const tables: number[][] = []
  const label = page.lines.find((line: ReturnType<typeof JSON.parse>) => /^\(a\)/u.test(line.text))
  if (change === 'missing label') page.lines = page.lines.filter((line: unknown) => line !== label)
  if (change === 'duplicate label') page.lines.push(structuredClone(label))
  if (change === 'missing key') page.graphicsBounds.splice(1, 1)
  if (change === 'prose')
    page.lines.push({
      text: 'An independent paragraph intervenes.',
      x: 100,
      y: 425,
      width: 300,
      height: 9,
      fontSize: 9
    })
  if (change === 'table') tables.push([70, 424, 527, 439])
  if (change === 'caption')
    captions.push({
      page: page.pageNumber,
      text: 'Figure 2: Independent results.',
      lines: ['Figure 2: Independent results.'],
      rect: [70, 424, 527, 439]
    })
  if (change === 'misaligned row')
    for (const graphic of page.graphicsBounds.slice(10))
      graphic.normalizedRect = graphic.normalizedRect.map(
        (v: number, i: number) => v + (i % 2 ? 0 : 0.02)
      )
  if (change === 'nonfinite label') label.x = Number.NaN
  const before = structuredClone({ page, captions, tables })
  const plate = nativeCaptionedRasterHorizontalArray(page, captions[0], captions, tables)
  expect(plate?.graphicsCount ?? 0).toBeLessThan(20)
  expect({ page, captions, tables }).toEqual(before)
})

it.each(['no neighboring caption', 'other page', 'shared native frame'])(
  'preserves the established full width strip when independent neighboring ownership is not proved: %s',
  (change) => {
    const { page, captions } = fixture().column
    const own = captions.find(
      (caption: ReturnType<typeof JSON.parse>) => caption.rect[0] < page.width / 2
    )
    const neighbor = captions.find((caption: ReturnType<typeof JSON.parse>) => caption !== own)
    if (change === 'no neighboring caption') captions.splice(captions.indexOf(neighbor), 1)
    if (change === 'other page') neighbor.page += 1
    if (change === 'shared native frame')
      page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.08, 0.06, 0.92, 0.22] })
    const before = structuredClone({ page, captions })
    const plate = nativeCaptionedRasterVectorStrip(page, own, captions, [])
    expect(plate.rect[2]).toBeGreaterThan(page.width * 0.85)
    expect({ page, captions }).toEqual(before)
  }
)

it('retains both lettered raster rows, every native color key and their labels', () => {
  const { page, captions } = fixture().rows
  const before = structuredClone({ page, captions })
  const [figure] = associateFigures(page, captions, [])
  expect(figure.rect).toBeDefined()
  for (const graphic of page.graphicsBounds) {
    const rect = graphic.normalizedRect.map(
      (v: number, i: number) => v * (i % 2 ? page.height : page.width)
    )
    expect(figure.rect[0]).toBeLessThanOrEqual(rect[0])
    expect(figure.rect[1]).toBeLessThanOrEqual(rect[1])
    expect(figure.rect[2]).toBeGreaterThanOrEqual(rect[2])
    expect(figure.rect[3]).toBeGreaterThanOrEqual(rect[3])
  }
  for (const line of page.lines.filter((l: ReturnType<typeof JSON.parse>) =>
    /^\([a-j]\)/u.test(l.text)
  )) {
    expect(figure.rect[0]).toBeLessThanOrEqual(line.x)
    expect(figure.rect[1]).toBeLessThanOrEqual(line.y)
    expect(figure.rect[2]).toBeGreaterThanOrEqual(line.x + line.width)
    expect(figure.rect[3]).toBeGreaterThanOrEqual(line.y + line.height)
  }
  expect(figure.rect[3]).toBeLessThan(captions[0].rect[1])
  expect({ page, captions }).toEqual(before)
})

const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
function formPlate(panelHeight = 100): ReturnType<typeof JSON.parse> {
  const page: ReturnType<typeof JSON.parse> = {
      pageNumber: 1,
      width: 600,
      height: 800,
      lines: [],
      graphicsBounds: [],
      invalidGraphicsBounds: 0
    },
    caption = { page: 1, lines: ['Figure 1. Maps.'], rect: [50, 680, 120, 690] },
    operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    content: ReturnType<typeof JSON.parse> = {
      items: [],
      styles: { f: { ascent: 0.8, descent: -0.2, vertical: false } }
    },
    tokens: ReturnType<typeof JSON.parse>[] = []
  const op = (n: keyof typeof OPS, a: ReturnType<typeof JSON.parse> = null): number => {
    const i = operators.fnArray.length
    operators.fnArray.push(OPS[n])
    operators.argsArray.push(a)
    return i
  }
  const text = (str: string, x: number, y: number, size = 10): void => {
    const i = content.items.length,
      sourceItem = { pageNumber: 1, index: i, text: str },
      width = str.length * size * 0.5
    content.items.push({
      str,
      width,
      height: size,
      dir: 'ltr',
      fontName: 'f',
      transform: [size, 0, 0, size, x, 800 - y - size],
      sourceItem,
      hasEOL: true
    })
    tokens.push({
      text: str,
      rect: [x, y, x + width, y + size],
      height: size,
      baseline: y + size,
      horizontal: true,
      fontDescent: -0.2,
      sourceItem: { ...sourceItem }
    })
    page.lines.push({ text: str, x, y, width, height: size, fontSize: size })
    op('beginText')
    op('setFont', ['f', size])
    op('setTextMatrix', [[1, 0, 0, 1, x, 800 - y - size]])
    op('showText', [[...str].map((unicode) => ({ unicode, width: 500 }))])
    op('endText')
  }
  text('Header', 250, 30)
  op('paintFormXObjectBegin', [null, [50, 150, 550, 730]])
  text('Key A   Key B', 220, 80)
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 2; col++) {
      const x = 100 + col * 250,
        y = 130 + row * 160,
        r = [x, y, x + 120, y + panelHeight]
      text('Panel ' + String.fromCharCode(65 + row * 2 + col), x + 25, y - 20)
      const p = [
          0,
          x,
          800 - y - panelHeight,
          1,
          x + 120,
          800 - y - panelHeight,
          1,
          x + 120,
          800 - y,
          1,
          x,
          800 - y,
          4
        ],
        b = [x, 800 - y - panelHeight, x + 120, 800 - y]
      op('setLineWidth', [1])
      const id = op('constructPath', [OPS.stroke, [p], b])
      page.graphicsBounds.push({
        kind: 'path',
        operationIndex: id,
        normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
      })
      op('save')
      op('clip')
      op('constructPath', [OPS.endPath, [p], b])
      op('transform', [120, 0, 0, panelHeight, x, 800 - y - panelHeight])
      const im = op('paintImageXObject', ['im' + row + col, 120, 100])
      page.graphicsBounds.push({
        kind: 'image',
        operationIndex: im,
        normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
      })
      op('restore')
    }
  op('paintFormXObjectEnd')
  text(caption.lines[0], 50, 680)
  caption.rect = [50, 680, 50 + caption.lines[0].length * 5, 690]
  return {
    page,
    caption,
    captions: [caption],
    tables: [],
    tokens,
    context: {
      operators,
      content,
      viewport: {
        width: 600,
        height: 800,
        scale: 1,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, 800],
        convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
      },
      graphicsBounds: structuredClone(page.graphicsBounds)
    }
  }
}

it('retains a native raster form legend above every panel row', () => {
  const f = formPlate()
  const figures = associateFigures(f.page, f.captions, [], [], [], f.tokens, f.context)
  expect(figures).toHaveLength(1)
  expect(figures[0].rect[1]).toBeLessThanOrEqual(80)
  expect(figures[0].rect[3]).toBeLessThan(f.caption.rect[1])
})

const { nativeRasterFormEnvelope } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-panel-labels.mjs')).href
)
const proveForm = (f: ReturnType<typeof formPlate>): ReturnType<typeof JSON.parse> =>
  nativeRasterFormEnvelope(
    f.page,
    { caption: f.caption, rect: [100, 130, 470, 550] },
    f.captions,
    f.tables,
    f.tokens,
    f.context
  )

it('uses one complete Form clip without changing native inventories or claiming label sources', () => {
  const f = formPlate()
  const before = JSON.stringify(f)
  expect(proveForm(f)?.rect).toEqual([50, 70, 550, 650])
  expect(proveForm(f)?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

it.each([
  [
    'competing caption',
    (f: ReturnType<typeof formPlate>): void => {
      f.captions.push({ ...f.caption, rect: [60, 90, 150, 100] })
    }
  ],
  [
    'independent table',
    (f: ReturnType<typeof formPlate>): void => {
      f.tables.push([70, 90, 140, 110])
    }
  ],
  [
    'unknown paint',
    (f: ReturnType<typeof formPlate>): void => {
      f.context.operators.fnArray.push(99999)
      f.context.operators.argsArray.push(null)
    }
  ],
  [
    'missing raw item',
    (f: ReturnType<typeof formPlate>): void => {
      f.context.content.items.splice(2, 1)
    }
  ],
  [
    'nested source alias',
    (f: ReturnType<typeof formPlate>): void => {
      f.tokens[0].other = { nested: { ...f.tokens[1].sourceItem } }
    }
  ],
  [
    'plural source alias',
    (f: ReturnType<typeof formPlate>): void => {
      f.tokens[0].sourceItems = [f.tokens[1].sourceItem]
    }
  ],
  [
    'altered native literal',
    (f: ReturnType<typeof formPlate>): void => {
      f.context.content.items[1].sourceItem.text = 'Changed'
    }
  ],
  [
    'altered text matrix',
    (f: ReturnType<typeof formPlate>): void => {
      const n = f.context.operators.fnArray.indexOf(OPS.setTextMatrix)
      f.context.operators.argsArray[n][0][4] += 2
    }
  ],
  [
    'duplicate paint identity',
    (f: ReturnType<typeof formPlate>): void => {
      f.context.graphicsBounds.push({ ...f.context.graphicsBounds[0] })
    }
  ],
  [
    'missing complete panel frame',
    (f: ReturnType<typeof formPlate>): void => {
      const n = f.context.operators.fnArray.indexOf(OPS.constructPath)
      f.context.operators.argsArray[n][0] = OPS.endPath
    }
  ],
  [
    'missing font metrics',
    (f: ReturnType<typeof formPlate>): void => {
      delete f.context.content.styles.f.ascent
    }
  ],
  [
    'invalid viewport',
    (f: ReturnType<typeof formPlate>): void => {
      f.context.viewport.transform = [1, 0]
    }
  ],
  [
    'unproven paint bounds',
    (f: ReturnType<typeof formPlate>): void => {
      f.page.invalidGraphicsBounds = 1
    }
  ],
  [
    'caption literal mismatch',
    (f: ReturnType<typeof formPlate>): void => {
      f.caption.lines = ['Figure 2. Different.']
    }
  ]
] as const)('declines raster Form completion with %s', (_name, mutate) => {
  const f = formPlate()
  mutate(f)
  expect(proveForm(f)).toBeUndefined()
})

it('declines independent painted ink intersecting the Form from outside its operator scope', () => {
  const f = formPlate(),
    o = f.context.operators,
    index = o.fnArray.length
  o.fnArray.push(OPS.constructPath)
  o.argsArray.push([
    OPS.fill,
    [[0, 60, 700, 1, 80, 700, 1, 80, 710, 1, 60, 710, 4]],
    [60, 700, 80, 710]
  ])
  const g = {
    kind: 'path',
    operationIndex: index,
    normalizedRect: [60 / 600, 90 / 800, 80 / 600, 100 / 800]
  }
  f.page.graphicsBounds.push(g)
  f.context.graphicsBounds.push({ ...g })
  expect(proveForm(f)).toBeUndefined()
})

it.each([70, 90, 120])('retains the same proved Form with panel height %s', (height) => {
  const f = formPlate(height)
  expect(proveForm(f)?.rect).toEqual([50, 70, 550, 650])
})

it('rejects an omitted image identity even if its native operator is still present', () => {
  const f = formPlate(),
    i = f.context.graphicsBounds.findIndex((g: ReturnType<typeof JSON.parse>) => g.kind === 'image')
  f.context.graphicsBounds.splice(i, 1)
  f.page.graphicsBounds.splice(i, 1)
  expect(proveForm(f)).toBeUndefined()
})

it('does not shrink an existing crop that includes a detached external legend', () => {
  const f = formPlate()
  const proof = nativeRasterFormEnvelope(
    f.page,
    { caption: f.caption, rect: [50, 60, 550, 650] },
    f.captions,
    [],
    f.tokens,
    f.context
  )
  expect(proof).toBeUndefined()
})

it('proves redundant closed rectangle vertices without broadening open clip paths', () => {
  const f = formPlate()
  const ops = f.context.operators
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] !== OPS.constructPath) continue
    const a = ops.argsArray[i],
      p = a[1][0],
      corners = [p.slice(1, 3), p.slice(4, 6), p.slice(7, 9), p.slice(10, 12)]
    a[1][0] = [
      0,
      ...corners[0],
      1,
      ...corners[1],
      1,
      ...corners[1],
      1,
      ...corners[2],
      1,
      ...corners[2],
      1,
      ...corners[3],
      1,
      ...corners[3],
      1,
      ...corners[0]
    ]
  }
  expect(proveForm(f)?.rect).toEqual([50, 70, 550, 650])
  const clip = ops.fnArray.findIndex(
    (n: number, i: number) => n === OPS.constructPath && ops.argsArray[i][0] === OPS.endPath
  )
  ops.argsArray[clip][1][0].splice(-3)
  expect(proveForm(f)).toBeUndefined()
})

it.each(['operator-font', 'native-font', 'missing-native-font'])(
  'rejects inconsistent native Form font identity: %s',
  (variant) => {
    const f = formPlate()
    if (variant === 'operator-font') {
      const i = f.context.operators.fnArray.indexOf(OPS.setFont)
      f.context.operators.argsArray[i][0] = 'other'
    } else if (variant === 'native-font') {
      f.context.content.styles.other = { ...f.context.content.styles.f }
      f.context.content.items[0].fontName = 'other'
    } else {
      f.context.content.styles.undefined = { ...f.context.content.styles.f }
      delete f.context.content.items[0].fontName
    }
    expect(proveForm(f)).toBeUndefined()
  }
)
function vectorFormStack(): ReturnType<typeof formPlate> {
  const f = formPlate()
  f.page.lines = []
  f.page.graphicsBounds = []
  f.tokens = []
  f.context.content.items = []
  f.context.operators = { fnArray: [], argsArray: [] }
  const op = (name: keyof typeof OPS, args: unknown[] = []): number => {
    f.context.operators.fnArray.push(OPS[name])
    f.context.operators.argsArray.push(args)
    return f.context.operators.fnArray.length - 1
  }
  const text = (str: string, x: number, y: number): void => {
    const width = str.length * 5,
      index = f.context.content.items.length
    const sourceItem = { pageNumber: 1, index, text: str }
    f.context.content.items.push({
      str,
      width,
      height: 10,
      dir: 'ltr',
      fontName: 'f',
      transform: [10, 0, 0, 10, x, 790 - y],
      sourceItem
    })
    f.tokens.push({
      text: str,
      rect: [x, y, x + width, y + 10],
      sourceItem: { ...sourceItem },
      horizontal: true
    })
    f.page.lines.push({ text: str, x, y, width, height: 10, fontSize: 10 })
    op('beginText')
    op('setFont', ['f', 10])
    op('moveText', [x, 790 - y])
    op('showText', [[...str].map((unicode) => ({ unicode, width: 500 }))])
    op('endText')
  }
  for (const [top, bottom, label] of [
    [100, 200, 'A'],
    [206, 326, 'B']
  ] as const) {
    op('paintFormXObjectBegin', [null, [50, 800 - bottom, 400, 800 - top]])
    text(label, 70, top + 10)
    const bounds = [60, 810 - bottom, 390, 790 - top]
    const id = op('constructPath', [
      OPS.stroke,
      [[0, bounds[0], bounds[1], 1, bounds[2], bounds[3]]],
      bounds
    ])
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: id,
      normalizedRect: [60 / 600, (top + 10) / 800, 390 / 600, (bottom - 10) / 800]
    })
    op('paintFormXObjectEnd')
  }
  f.caption.lines = ['Figure 1. Two stages.']
  text(f.caption.lines[0], 50, 334)
  f.caption.rect = [50, 334, 150, 344]
  f.context.graphicsBounds = structuredClone(f.page.graphicsBounds)
  return f
}

const proveVectorStack = (f: ReturnType<typeof vectorFormStack>): ReturnType<typeof JSON.parse> =>
  nativeRasterFormEnvelope(
    f.page,
    { caption: f.caption, rect: [50, 206, 400, 326] },
    f.captions,
    f.tables,
    f.tokens,
    f.context
  )

// The upper complete packet is narrower on both sides. Its nested glyph path
// has an exact quarter-turn; all raw text and paint records remain explicit.
function nestedVectorColumn(): ReturnType<typeof vectorFormStack> {
  const f = vectorFormStack(),
    o = f.context.operators,
    begin = o.fnArray.indexOf(OPS.paintFormXObjectBegin),
    end = o.fnArray.indexOf(OPS.paintFormXObjectEnd)
  o.argsArray[begin][1] = [55, 600, 395, 700]
  o.fnArray.splice(end, 0, OPS.paintFormXObjectBegin, OPS.constructPath, OPS.paintFormXObjectEnd)
  o.argsArray.splice(
    end,
    0,
    [
      [0, 1, -1, 0, 100, 620],
      [0, 0, 10, 10]
    ],
    [OPS.stroke, [[0, 1, 1, 1, 8, 8]], [1, 1, 8, 8]],
    []
  )
  for (const g of f.page.graphicsBounds) if (g.operationIndex >= end) g.operationIndex += 3
  f.page.graphicsBounds.push({
    kind: 'path',
    operationIndex: end + 1,
    normalizedRect: [92 / 600, 172 / 800, 99 / 600, 179 / 800]
  })
  f.context.graphicsBounds = structuredClone(f.page.graphicsBounds)
  return f
}

it('retains nested-width complete Form packets with a quarter-turned glyph path', () => {
  const f = nestedVectorColumn(),
    before = JSON.stringify(f)
  expect(proveVectorStack(f)?.rect).toEqual([50, 100, 400, 326])
  expect(proveVectorStack(f)?.graphicsCount).toBe(3)
  expect(proveVectorStack(f)?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

it.each([
  'shear',
  'rotated-root',
  'offset-column',
  'font-outside-frame',
  'unknown-paint',
  'accent',
  'table',
  'missing-paint'
])('refuses a nested Form column with %s competition', (change) => {
  const f = nestedVectorColumn(),
    o = f.context.operators
  const forms = o.fnArray.flatMap((n: number, i: number) =>
    n === OPS.paintFormXObjectBegin ? [i] : []
  )
  if (change === 'shear') o.argsArray[forms[1]][0][0] = 0.1
  if (change === 'rotated-root') o.argsArray[forms[0]][0] = [0, 1, -1, 0, 0, 0]
  if (change === 'offset-column') o.argsArray[forms[0]][1] = [45, 600, 395, 700]
  if (change === 'font-outside-frame') o.argsArray[forms[0]][1] = [80, 600, 395, 700]
  if (change === 'unknown-paint') {
    o.fnArray.push(OPS.shadingFill)
    o.argsArray.push(['unproved'])
  }
  if (change === 'accent')
    o.argsArray[o.fnArray.indexOf(OPS.showText)][0][0].accent = {
      fontChar: '^',
      offset: { x: 0, y: 1 }
    }
  if (change === 'table') f.tables.push([60, 201, 200, 205])
  if (change === 'missing-paint') f.context.graphicsBounds.pop()
  expect(proveVectorStack(f)).toBeUndefined()
})

it('preserves every complete adjacent vector Form and its native text packets', () => {
  const f = vectorFormStack(),
    before = JSON.stringify(f)
  expect(proveVectorStack(f)?.rect).toEqual([50, 100, 400, 326])
  expect(proveVectorStack(f)?.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it.each([
  ['default', [10], true],
  ['non-default', [9], false],
  ['missing', [], false],
  ['extra', [10, 10], false],
  ['non-numeric', ['10'], false],
  ['restored non-default', [10], false],
  ['GState miter', [10], false]
] as const)('requires a proved default miter history: %s', (change, args, accepted) => {
  const f = vectorFormStack(),
    o = f.context.operators
  o.fnArray.unshift(OPS.setMiterLimit)
  o.argsArray.unshift([...args])
  for (const g of [...f.page.graphicsBounds, ...f.context.graphicsBounds]) g.operationIndex++
  if (change === 'restored non-default') {
    o.fnArray.push(OPS.save, OPS.setMiterLimit, OPS.restore, OPS.setMiterLimit)
    o.argsArray.push([], [5], [], [10])
  }
  if (change === 'GState miter') {
    o.fnArray.push(OPS.setGState)
    o.argsArray.push([[['ML', 10]]])
  }
  const before = JSON.stringify(f)
  expect(proveVectorStack(f)?.rect).toEqual(accepted ? [50, 100, 400, 326] : undefined)
  expect(JSON.stringify(f)).toBe(before)
})
it.each([
  'caption',
  'table',
  'missing-paint',
  'duplicate-paint',
  'unknown-paint',
  'unknown-state',
  'raw-alias',
  'missing-font',
  'font-mismatch',
  'accent',
  'glyph-mismatch',
  'missing-form-end',
  'wide-gap',
  'overlap',
  'different-width',
  'foreign-paint'
])('refuses incomplete or competing vector Form ownership: %s', (change) => {
  const f = vectorFormStack(),
    o = f.context.operators
  const forms = o.fnArray.flatMap((n: number, i: number) =>
    n === OPS.paintFormXObjectBegin ? [i] : []
  )
  if (change === 'caption')
    f.captions.push({ page: 1, lines: ['Figure 2. Separate.'], rect: [55, 170, 200, 180] })
  if (change === 'table') f.tables.push([60, 201, 200, 205])
  if (change === 'missing-paint') {
    f.page.graphicsBounds.pop()
    f.context.graphicsBounds.pop()
  }
  if (change === 'duplicate-paint')
    f.context.graphicsBounds.push({ ...f.context.graphicsBounds[0] })
  if (change === 'unknown-paint') {
    o.fnArray.push(OPS.shadingFill)
    o.argsArray.push(['foreign'])
  }
  if (change === 'unknown-state') {
    o.fnArray.push(OPS.setTextRenderingMode)
    o.argsArray.push([1])
  }
  if (change === 'raw-alias')
    f.context.content.items[0].sourceItems = [{ ...f.context.content.items[0].sourceItem }]
  if (change === 'missing-font') delete f.context.content.styles.f
  if (change === 'font-mismatch') o.argsArray[o.fnArray.indexOf(OPS.setFont)][0] = 'other'
  if (change === 'accent')
    o.argsArray[o.fnArray.indexOf(OPS.showText)][0][0].accent = {
      fontChar: '^',
      offset: { x: 0, y: 2 }
    }
  if (change === 'glyph-mismatch') o.argsArray[o.fnArray.indexOf(OPS.showText)][0][0].unicode = 'Z'
  if (change === 'missing-form-end')
    o.fnArray[o.fnArray.indexOf(OPS.paintFormXObjectEnd)] = OPS.restore
  if (change === 'wide-gap') o.argsArray[forms[1]][1][3] -= 20
  if (change === 'overlap') o.argsArray[forms[1]][1][3] += 20
  if (change === 'different-width') o.argsArray[forms[1]][1][2] -= 20
  if (change === 'foreign-paint') {
    const operationIndex = o.fnArray.length
    o.fnArray.push(OPS.constructPath)
    o.argsArray.push([OPS.stroke, [[0, 60, 600, 1, 200, 595]], [60, 595, 200, 600]])
    const g = {
      kind: 'path',
      operationIndex,
      normalizedRect: [60 / 600, 200 / 800, 200 / 600, 205 / 800]
    }
    f.page.graphicsBounds.push(g)
    f.context.graphicsBounds.push({ ...g })
  }
  expect(proveVectorStack(f)).toBeUndefined()
})
