import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const { recoverOrdinaryThreeLineTables: recover, ordinaryTableCompetitionRect } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-ordinary-three-line.mjs')).href
)

it('retains the full competing region of an existing graphical table', () => {
  const f = ordinaryExample()
  const owner = { region: [0.025, 0.125, 0.975, 0.625] }
  const competition = ordinaryTableCompetitionRect(owner, f.page, 1.5)
  expect(competition).toEqual([10, 20, 390, 100])
  expect(recover(f.page, f.tokens, f.context, [competition])).toEqual([])
})

it('suspends recovery across an existing owner with unknown bounds', () => {
  const f = ordinaryExample()
  const competition = ordinaryTableCompetitionRect({}, f.page, 1.5)
  expect(competition).toEqual([0, 0, f.page.width, f.page.height])
  expect(recover(f.page, f.tokens, f.context, [competition])).toEqual([])
})

it('preserves the existing rendered crop projection at its actual scale', () => {
  const f = ordinaryExample()
  const owner = { cropRect: [400, 200, 600, 250] },
    scale = 2
  const oldProjection = owner.cropRect.map((n) => n / scale)
  const competition = ordinaryTableCompetitionRect(owner, f.page, scale)
  expect(competition).toEqual(oldProjection)
  expect(recover(f.page, f.tokens, f.context, [competition])).toEqual(
    recover(f.page, f.tokens, f.context, [oldProjection])
  )
})
const { ordinaryExample } = await import(
  pathToFileURL(resolve('test/ordinary-three-line-fixture.mjs')).href
)

it('recovers three rows and four columns while preserving whole literal fields', () => {
  const f = ordinaryExample(),
    before = JSON.stringify(f)
  const result = recover(f.page, f.tokens, f.context)
  expect(result).toHaveLength(1)
  expect(result[0].grid).toEqual(f.rows)
  expect(result[0].table.cells).toHaveLength(12)
  expect(
    result[0].table.cells.every(
      (c: ReturnType<typeof JSON.parse>) =>
        c.rowSpan === 1 && c.colSpan === 1 && c.sourceItems.length === 1
    )
  ).toBe(true)
  expect(result[0].table.issues).toEqual([])
  expect(result[0].table.caption).toBeUndefined()
  expect(result[0].table.notes).toEqual([])
  expect(result[0].table.sourceViewport).toEqual({ width: 600, height: 240, scale: 1.5 })
  expect(JSON.stringify(f)).toBe(before)
})

it.each(['grouped', 'merged-header', 'missing-rule', 'foreign-ink'])(
  'preserves an incompatible native %s layout',
  (mode) => {
    const f = ordinaryExample(mode),
      before = JSON.stringify(f)
    expect(recover(f.page, f.tokens, f.context)).toEqual([])
    expect(JSON.stringify(f)).toBe(before)
  }
)

it.each(['ascent', 'descent', 'vertical', 'glyph', 'duplicate', 'overlap', 'caption', 'alpha'])(
  'requires complete native %s evidence',
  (mode) => {
    const f = ordinaryExample()
    if (mode === 'ascent') f.context.content.styles.F.ascent = 0
    if (mode === 'descent') f.context.content.styles.F.descent = NaN
    if (mode === 'vertical') f.context.content.styles.F.vertical = true
    if (mode === 'glyph') f.context.glyphBounds[0].glyphs = []
    if (mode === 'duplicate') f.tokens.push({ ...f.tokens[0] })
    if (mode === 'alpha') {
      f.context.operators.fnArray.unshift(OPS.setGState)
      f.context.operators.argsArray.unshift([[['ca', 0.5]]])
      for (const graphic of f.page.graphicsBounds) graphic.operationIndex++
    }
    const competing = mode === 'overlap' ? [[9, 19, 391, 101]] : []
    const captions = mode === 'caption' ? [{ rect: [20, 25, 90, 35] }] : []
    const before = JSON.stringify(f)
    expect(recover(f.page, f.tokens, f.context, competing, captions)).toEqual([])
    expect(JSON.stringify(f)).toBe(before)
  }
)
function lowerCaptionExample(completeTail = true): ReturnType<typeof JSON.parse> {
  const width = 400,
    height = 180,
    rows = [
      ['Item', 'First', 'Second'],
      ['East', '1.2', '0.3'],
      ['West', '-0.1', '2.3']
    ],
    values = rows.flatMap((row, r) =>
      row.map((text, c) => ({ text, x: [20, 160, 280][c], baseline: [33, 63, 85][r] }))
    ),
    first = 'TABLE 1: Native values for',
    last = completeTail ? 'each sample.' : 'each sample'
  values.push(
    { text: first, x: 200 - first.length * 2, baseline: 120 },
    { text: last, x: 200 - last.length * 2, baseline: 130 }
  )
  const viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    items = values.map((v, index) => ({
      str: v.text,
      width: v.text.length * 4,
      height: 8,
      dir: 'ltr',
      fontName: 'F',
      transform: [8, 0, 0, 8, v.x, height - v.baseline],
      sourceItem: { pageNumber: 1, index, text: v.text }
    })),
    tokens = values.map((v, index) => ({
      text: v.text,
      rect: [v.x, v.baseline - 8, v.x + v.text.length * 4, v.baseline],
      baseline: v.baseline,
      height: 8,
      horizontal: true,
      sourceItem: items[index].sourceItem
    })),
    operators: { fnArray: number[]; argsArray: unknown[] } = { fnArray: [], argsArray: [] }
  for (const i of items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', 8],
      [new Float32Array([1, 0, 0, 1, i.transform[4], i.transform[5]])],
      [Array.from(i.str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
  }
  operators.fnArray.push(OPS.setLineWidth, OPS.setLineCap, OPS.setStrokeRGBColor)
  operators.argsArray.push([0.5], [0], ['#000000'])
  const lines = [
      [10, 40, 390, 40],
      [10, 100, 390, 100],
      [110, 27, 110, 40],
      [110, 40, 110, 70],
      [110, 70, 110, 100]
    ],
    graphicsBounds = lines.map(([x, y, z, w]) => {
      const operationIndex = operators.fnArray.length
      operators.fnArray.push(OPS.constructPath)
      operators.argsArray.push([
        OPS.stroke,
        [new Float32Array([0, x, height - y, 1, z, height - w])],
        new Float32Array([
          Math.min(x, z),
          height - Math.max(y, w),
          Math.max(x, z),
          height - Math.min(y, w)
        ])
      ])
      return {
        kind: 'path',
        operationIndex,
        normalizedRect: [
          (Math.min(x, z) - 0.5) / width,
          (Math.min(y, w) - 0.5) / height,
          (Math.max(x, z) + 0.5) / width,
          (Math.max(y, w) + 0.5) / height
        ]
      }
    }),
    context = {
      content: { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } },
      viewport,
      operators,
      graphicsBounds,
      glyphBounds: [
        {
          fontName: 'F',
          glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((fontChar) => ({
            fontChar,
            bounds: fontChar === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
          }))
        }
      ]
    },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds },
    captions = [
      { page: 1, lines: [first], rect: [200 - first.length * 2, 112, 200 + first.length * 2, 120] }
    ]
  return { page, tokens, context, captions, rows }
}

it('recovers complete native fields above a lower two-line caption without an opening rule', async () => {
  const f = lowerCaptionExample(),
    before = JSON.stringify(f),
    result = recover(f.page, f.tokens, f.context, [], f.captions)
  expect(result).toHaveLength(1)
  expect(result[0].grid).toEqual(f.rows)
  expect(result[0].table.caption.lines).toEqual([f.captions[0].lines[0], 'each sample.'])
  expect(
    result[0].table.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems)
      .map((s: ReturnType<typeof JSON.parse>) => s.index)
  ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  expect(result[0].current()).toBe(true)
  expect(JSON.stringify(f)).toBe(before)
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path'),
    { inspectScratch } = await import(pathToFileURL(resolve('resources/scratch.mjs')).href),
    root = await mkdtemp(join(tmpdir(), 'native-table-'))
  await mkdir(join(root, 'thumbnails'))
  await writeFile(
    join(root, result[0].table.thumbnail ?? `thumbnails/${result[0].table.id}.png`),
    new Uint8Array([1, 2, 3])
  )
  expect(await inspectScratch(root, true)).toBe(3)
})

it.each(['white-stroke', 'missing-stub', 'foreign-caption'] as const)(
  'declines a lower-caption table with %s evidence',
  (mode) => {
    const f = lowerCaptionExample()
    if (mode === 'white-stroke')
      f.context.operators.argsArray[f.context.operators.fnArray.indexOf(OPS.setStrokeRGBColor)] = [
        '#ffffff'
      ]
    if (mode === 'missing-stub') {
      const n = f.page.graphicsBounds[2].operationIndex
      f.context.operators.fnArray.splice(n)
      f.context.operators.argsArray.splice(n)
      f.page.graphicsBounds.splice(2)
    }
    if (mode === 'foreign-caption') f.captions[0].rect[1] = 95
    expect(recover(f.page, f.tokens, f.context, [], f.captions)).toEqual([])
  }
)

it('rejects stale native caption, viewport and output snapshots while pixels are awaited', async () => {
  for (const change of ['caption', 'viewport', 'witness', 'output'] as const) {
    const f = lowerCaptionExample(),
      witnessViewport = { ...f.context.viewport, transform: [...f.context.viewport.transform] }
    Object.assign(f.context, { runningHeadWitness: { witnessViewport } })
    const [proof] = recover(f.page, f.tokens, f.context, [], f.captions)
    expect(proof?.current()).toBe(true)
    await Promise.resolve()
    if (change === 'witness') witnessViewport.transform[5]++
    if (change === 'caption') f.context.content.items[9].str += ' altered'
    if (change === 'viewport') f.context.viewport.transform[5]++
    if (change === 'output') proof.table = { ...proof.table }
    expect(proof.current()).toBe(false)
  }
})
it('retains the existing three-rule ID when an earlier two-rule family shares the page', () => {
  const fresh = lowerCaptionExample(),
    legacy = ordinaryExample(),
    width = 600,
    height = 360,
    parts = [
      { example: fresh, offset: 0, dx: 0 },
      { example: legacy, offset: 180, dx: 100 }
    ],
    tokens: ReturnType<typeof JSON.parse>[] = [],
    items: ReturnType<typeof JSON.parse>[] = [],
    graphicsBounds: ReturnType<typeof JSON.parse>[] = [],
    operators: { fnArray: number[]; argsArray: unknown[] } = { fnArray: [], argsArray: [] },
    glyphs = new Map<string, ReturnType<typeof JSON.parse>>()
  for (const { example, offset, dx } of parts) {
    const itemOffset = items.length,
      operationOffset = operators.fnArray.length + 2,
      dy = height - example.page.height - offset
    operators.fnArray.push(
      OPS.save,
      OPS.transform,
      ...example.context.operators.fnArray,
      OPS.restore
    )
    operators.argsArray.push(
      null,
      [1, 0, 0, 1, dx, dy],
      ...example.context.operators.argsArray,
      null
    )
    for (const [index, item] of example.context.content.items.entries()) {
      const sourceItem = { ...item.sourceItem, index: itemOffset + index },
        transform = [...item.transform]
      transform[4] += dx
      transform[5] += dy
      items.push({ ...item, transform, sourceItem })
    }
    for (const token of example.tokens) {
      const rect = [...token.rect]
      rect[0] += dx
      rect[2] += dx
      rect[1] += offset
      rect[3] += offset
      tokens.push({
        ...token,
        rect,
        baseline: token.baseline + offset,
        sourceItem: items[itemOffset + token.sourceItem.index].sourceItem
      })
    }
    for (const g of example.page.graphicsBounds) {
      const r = g.normalizedRect.map(
        (n: number, i: number) => n * (i % 2 ? example.page.height : example.page.width)
      )
      r[0] += dx
      r[2] += dx
      r[1] += offset
      r[3] += offset
      graphicsBounds.push({
        ...g,
        operationIndex: g.operationIndex + operationOffset,
        normalizedRect: r.map(
          (n: number, i: number) => (n + (i < 2 ? -0.5 : 0.5)) / (i % 2 ? height : width)
        )
      })
    }
    for (const g of example.context.glyphBounds[0].glyphs) {
      if (glyphs.has(g.fontChar)) expect(glyphs.get(g.fontChar)).toEqual(g)
      glyphs.set(g.fontChar, g)
    }
  }
  const viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    context = {
      content: { items, styles: fresh.context.content.styles },
      viewport,
      operators,
      graphicsBounds,
      glyphBounds: [{ fontName: 'F', glyphs: [...glyphs.values()] }]
    },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds },
    result = recover(page, tokens, context, [], fresh.captions)
  expect(result.map((p: ReturnType<typeof JSON.parse>) => p.table.id)).toEqual([
    'p1-native-ordinary-three-line-1',
    'p1-open-rule-table-1'
  ])
  expect(result[0].grid).toEqual(legacy.rows)
  expect(result[1].grid).toEqual(fresh.rows)
})

it('requires a complete native sentence at the end of the lower caption', () => {
  const f = lowerCaptionExample(false)
  expect(recover(f.page, f.tokens, f.context, [], f.captions)).toEqual([])
})
