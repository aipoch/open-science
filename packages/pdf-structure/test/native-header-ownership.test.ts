import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)

const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { reconcileNativeTieredHeader } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-cell-text.mjs')).href
)

const pairedHeaderHelpers = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-header-grid.mjs')).href
)
const pairedHeaderDonors = (mergedHeader: boolean, rich = false): ReturnType<typeof JSON.parse> => {
  const count = mergedHeader ? 2 : 3,
    width = 120 + count * 130,
    height = 230,
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
    },
    content = { items: [] as ReturnType<typeof JSON.parse>[], styles: { f: { vertical: false } } },
    operators = {
      fnArray: [OPS.dependency, OPS.setLineWidth],
      argsArray: [['f'], [0.5]] as ReturnType<typeof JSON.parse>[]
    },
    tokens: ReturnType<typeof JSON.parse>[] = [],
    cells: ReturnType<typeof JSON.parse>[] = [],
    grid: string[][] = []
  const draw = (text: string, x: number, y: number, size = 10): ReturnType<typeof JSON.parse> => {
    const sourceItem = { pageNumber: 1, index: content.items.length, text },
      rect = [x, y - size, x + (text.length * size) / 2, y],
      f = { text, rect, height: size, baseline: y, horizontal: true, sourceItem }
    content.items.push({
      str: text,
      width: (text.length * size) / 2,
      height: size,
      fontName: 'f',
      transform: [size, 0, 0, size, x, height - y],
      sourceItem
    })
    tokens.push(f)
    operators.fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      ['f', size],
      null,
      [new Float32Array([1, 0, 0, 1, x, height - y])],
      [
        [...text].map((unicode) => ({
          unicode,
          fontChar: unicode,
          originalCharCode: unicode.codePointAt(0),
          width: 500,
          isInFont: true,
          operatorListId: null
        }))
      ],
      null
    )
    return f
  }
  const put = (
    row: number,
    column: number,
    fonts: ReturnType<typeof JSON.parse>[],
    colSpan = 1,
    rowSpan = 1
  ): void => {
    const text = fonts.map((f: ReturnType<typeof JSON.parse>) => f.text).join(' ')
    grid[row] ??= Array(mergedHeader ? 5 : 6).fill('')
    grid[row][column] = text
    cells.push({
      row,
      column,
      rowSpan,
      colSpan,
      text,
      sourceItems: fonts.map((f: ReturnType<typeof JSON.parse>) => f.sourceItem),
      sourceRects: fonts.map((f: ReturnType<typeof JSON.parse>) => f.rect),
      opaque: { keep: 'cell' }
    })
  }
  const stubScripts: ReturnType<typeof JSON.parse>[] = [],
    topStub = mergedHeader ? draw('Kind', 20, 35) : undefined,
    parents = Array.from({ length: count }, (_, n) => draw(`Group${n + 1}`, 125 + n * 130, 35)),
    leaves = Array.from({ length: count * 2 }, (_, n) =>
      draw(n % 2 ? 'Share' : 'Count', 105 + Math.floor(n / 2) * 130 + (n % 2) * 70, 55)
    ),
    records = Array.from({ length: mergedHeader ? 2 : 3 }, (_, r) => {
      const stub = draw(rich && mergedHeader ? 'Row' : `Row${r + 1}`, 20, 75 + r * 25)
      if (rich && mergedHeader) stubScripts[r] = draw(String(r + 1), 35, 77 + r * 25, 7)
      return [
        stub,
        ...Array.from({ length: count * 2 }, (_, n) =>
          draw(
            n % 2 ? `${r + 1}%` : `${r + 1}/${r + 2}/${r + 3}`,
            105 + Math.floor(n / 2) * 130 + (n % 2) * 70,
            75 + r * 25
          )
        )
      ]
    })
  if (mergedHeader) {
    put(0, 0, [topStub, records[0][0], ...(stubScripts[0] ? [stubScripts[0]] : [])])
    for (let n = 0; n < 4; n++)
      put(0, n + 1, [...(n % 2 ? [] : [parents[n / 2]]), leaves[n], records[0][n + 1]])
    for (let n = 0; n < 5; n++)
      put(1, n, [records[1][n], ...(n === 0 && stubScripts[1] ? [stubScripts[1]] : [])])
    if (rich)
      for (let row = 0; row < 2; row++) {
        const c = cells.find((c: ReturnType<typeof JSON.parse>) => c.row === row && c.column === 0),
          normal = row ? 'Row' : 'Kind Row'
        c.text = normal + String(row + 1)
        c.textRuns = [
          { text: normal, position: 'normal' },
          { text: String(row + 1), position: 'subscript' }
        ]
        grid[row][0] = c.text
      }
  } else {
    put(0, 0, [])
    for (let n = 0; n < count; n++) put(0, 1 + n * 2, [parents[n]], n === count - 1 ? 1 : 2)
    put(1, 0, [draw('Kind', 20, 55)])
    for (let n = 0; n < 4; n++) put(1, n + 1, [leaves[n]])
    put(1, 5, leaves.slice(-2))
    for (let r = 0; r < records.length; r++) {
      for (let n = 0; n < 5; n++) put(r + 2, n, [records[r][n]])
      put(r + 2, 5, records[r].slice(-2))
    }
  }
  const lines = [
      [15, 20, width - 10, 20],
      [15, 60, width - 10, 60],
      [15, 140, width - 10, 140],
      ...Array.from({ length: count }, (_, n) => [100 + n * 130, 40, 225 + n * 130, 40])
    ],
    paint = new Map()
  for (const [x, y, z, w] of lines) {
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, x, height - y, 1, z, height - w])],
      new Float32Array([x, height - y, z, height - w])
    ])
  }
  const rules = collectTableRules(operators, viewport, paint),
    q = (v: number, n: number): number =>
      ((n < 2
        ? Math.floor((v / (n % 2 ? height : width)) * 256)
        : Math.ceil((v / (n % 2 ? height : width)) * 256) + 1) *
        (n % 2 ? height : width)) /
      256,
    nativeEvidenceGraphics = lines.map(([x, y, z, w]) => ({
      kind: 'path',
      rect: [x - 0.25, y - 0.25, z + 0.25, w + 0.25].map(q)
    }))
  return {
    table: {
      page: 1,
      sourceViewport: { width, height, scale: 1 },
      cropRect: [15, 20, width - 10, 140],
      grid,
      cells,
      unassigned: [],
      clipped: [],
      notes: [],
      issues: [],
      opaque: { preserve: true }
    },
    tokens,
    rules,
    context: { content, operators, viewport, rulePaintBounds: paint, nativeEvidenceGraphics }
  }
}
const pairedDonorOutput = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  pairedHeaderHelpers.recoverNativePairedHeaderRecordOwners?.(
    f.table,
    f.tokens,
    [],
    f.rules,
    f.context
  )
it.each([true, false])(
  'recovers paired ruled headers and whole leaf owners (merged header=%s)',
  (merged) => {
    const f = pairedHeaderDonors(merged),
      before = structuredClone(f.table),
      out = pairedDonorOutput(f)
    expect(out).toBeDefined()
    expect(out.grid[0]).toEqual(
      merged ? ['Kind', 'Group1', '', 'Group2', ''] : ['', 'Group1', '', 'Group2', '', 'Group3', '']
    )
    expect(out.grid[1]).toEqual(
      merged
        ? ['', 'Count', 'Share', 'Count', 'Share']
        : ['Kind', 'Count', 'Share', 'Count', 'Share', 'Count', 'Share']
    )
    expect(out.grid[2]).toEqual(
      merged
        ? ['Row1', '1/2/3', '1%', '1/2/3', '1%']
        : ['Row1', '1/2/3', '1%', '1/2/3', '1%', '1/2/3', '1%']
    )
    expect({ ...out, cells: before.cells, grid: before.grid }).toEqual(before)
    if (!merged)
      expect(out.cells.filter((c: ReturnType<typeof JSON.parse>) => c.column < 5)).toEqual(
        before.cells.filter((c: ReturnType<typeof JSON.parse>) => c.column < 5)
      )
    expect(
      out.cells
        .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems)
        .map((i: ReturnType<typeof JSON.parse>) => i.index)
        .sort((a: number, b: number) => a - b)
    ).toEqual(
      f.tokens
        .map((i: ReturnType<typeof JSON.parse>) => i.sourceItem.index)
        .sort((a: number, b: number) => a - b)
    )
    expect(f.table).toEqual(before)
  }
)
it.each([
  'missing packet',
  'incomplete source',
  'duplicate claim',
  'missing parent fence',
  'rich donor',
  'foreign rect'
])('refuses paired ruled donor reconstruction with %s atomically', (kind) => {
  const f = pairedHeaderDonors(false)
  if (kind === 'missing packet') f.context = {}
  if (kind === 'incomplete source') f.tokens.pop()
  if (kind === 'duplicate claim')
    f.table.cells.at(-1).sourceItems[1] = f.table.cells.at(-1).sourceItems[0]
  if (kind === 'missing parent fence') f.rules.pop()
  if (kind === 'rich donor')
    f.table.cells.at(-1).textRuns = [{ text: f.table.cells.at(-1).text, position: 'subscript' }]
  if (kind === 'foreign rect') f.table.cells.at(-1).sourceRects[0][0] += 1
  const before = structuredClone(f.table)
  expect(pairedDonorOutput(f)).toBeUndefined()
  expect(f.table).toEqual(before)
})
it('partitions only a source-proved rich header donor and preserves the later rich record', () => {
  const f = pairedHeaderDonors(true, true),
    before = structuredClone(f.table),
    out = pairedDonorOutput(f)
  expect(
    out?.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 0)
  ).toMatchObject({
    text: 'Kind',
    textRuns: [{ text: 'Kind', position: 'normal' }],
    rowSpan: 2
  })
  expect(
    out?.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 2 && c.column === 0)
  ).toMatchObject({
    text: 'Row1',
    textRuns: [
      { text: 'Row', position: 'normal' },
      { text: '1', position: 'subscript' }
    ]
  })
  expect(
    out?.cells
      .filter((c: ReturnType<typeof JSON.parse>) => c.row === 3)
      .map((c: ReturnType<typeof JSON.parse>) => ({ ...c, row: 1 }))
  ).toEqual(before.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row === 1))
  for (const change of [
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells[0].textRuns[1].position = 'superscript'
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells[0].textRuns[1].opaque = { keep: true }
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells[0].textRuns[0].text = 'foreign'
    }
  ]) {
    const f = pairedHeaderDonors(true, true)
    change(f)
    const before = structuredClone(f.table)
    expect(pairedDonorOutput(f)).toBeUndefined()
    expect(f.table).toEqual(before)
  }
  expect(f.table).toEqual(before)
})

it.each([true, false])(
  'recovers internal paired donors with unique permuted source rectangles (%s)',
  (merged) => {
    const f = pairedHeaderDonors(merged, true)
    for (const c of f.table.cells) {
      c.sourceTokens = (c.sourceItems ?? []).map((o: ReturnType<typeof JSON.parse>) =>
        structuredClone(
          f.tokens.find((i: ReturnType<typeof JSON.parse>) => i.sourceItem.index === o.index)
        )
      )
      for (const t of c.sourceTokens) t.opaque = { keep: t.sourceItem.index }
      c.rect = [
        15,
        c.row === 0 ? 20 : c.row === 1 ? (merged ? 95 : 40) : 60,
        f.table.cropRect[2],
        c.row === 0 ? (merged ? 90 : 40) : 140
      ]
    }
    f.table.rows = f.table.grid.map((_r: string[], n: number) => ({
      rect: [
        15,
        n === 0 ? 20 : n === 1 ? (merged ? 95 : 40) : 60,
        f.table.cropRect[2],
        n === 0 ? (merged ? 90 : 40) : 140
      ],
      opaque: { keep: 'row' }
    }))
    const target = f.table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 3
    )
    target.sourceTokens.reverse()
    const before = structuredClone(f.table),
      out = pairedDonorOutput(f)
    expect(out).toBeDefined()
    expect(out.grid[0]).toHaveLength(merged ? 5 : 7)
    if (merged)
      expect(
        out.cells
          .filter((c: ReturnType<typeof JSON.parse>) => c.row === 3)
          .map((c: ReturnType<typeof JSON.parse>) => ({ ...c, row: 1 }))
      ).toEqual(before.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row === 1))
    else {
      expect(out.cells.filter((c: ReturnType<typeof JSON.parse>) => c.column < 5)).toEqual(
        before.cells.filter((c: ReturnType<typeof JSON.parse>) => c.column < 5)
      )
      expect(out.rows).toEqual(before.rows)
    }
    expect({ ...out, cells: before.cells, grid: before.grid, rows: before.rows }).toEqual(before)
    const tokens = (t: ReturnType<typeof JSON.parse>): string[] =>
      t.cells
        .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens ?? [])
        .map((t: ReturnType<typeof JSON.parse>) => JSON.stringify(t))
        .sort()
    expect(tokens(out)).toEqual(tokens(before))
    expect(f.table).toEqual(before)
    target.sourceRects[1] = target.sourceRects[0]
    expect(pairedDonorOutput(f)).toBeUndefined()
  }
)

const threeTierNativeFences = (): ReturnType<typeof JSON.parse> => {
  const viewport = {
    width: 500,
    height: 220,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 220],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 220 - y]
  }
  const raw: ReturnType<typeof JSON.parse>[] = [],
    operators = { fnArray: [OPS.dependency, OPS.setLineWidth], argsArray: [['font'], [0.5]] }
  const op = (code: number, args: unknown): void => {
    operators.fnArray.push(code)
    operators.argsArray.push(args as ReturnType<typeof JSON.parse>)
  }
  const draw = (str: string, x: number, y: number, size = 10): void => {
    raw.push({
      str,
      fontName: 'font',
      transform: [size, 0, 0, size, x, 220 - y],
      width: (str.length * size) / 2,
      height: size,
      dir: 'ltr',
      sourceItem: { pageNumber: 1, index: raw.length, text: str }
    })
    op(OPS.setFont, ['font', size])
    op(OPS.beginText, null)
    op(OPS.setTextMatrix, [new Float32Array([1, 0, 0, 1, x, 220 - y])])
    op(OPS.showText, [
      [...str].map((unicode) => ({
        unicode,
        fontChar: unicode,
        originalCharCode: unicode.codePointAt(0),
        width: 500,
        isInFont: true,
        operatorListId: null
      }))
    ])
    op(OPS.endText, null)
  }
  draw('Table 1: Three tiers.', 20, 15)
  draw('ParentA', 165, 32.5)
  draw('ParentB', 365, 32.5)
  for (const x of [125, 225, 325, 425]) {
    draw('Q', x, 48.5)
    draw('xy', x + 5, 50, 7)
  }
  const xs = [20, 80, 130, 180, 230, 280, 330, 380, 430, 480]
  for (let c = 0; c < 9; c++) draw(c === 0 ? 'Size' : 'Leaf', xs[c] + 10, 70)
  draw('Section', 225, 90)
  for (let r = 0; r < 4; r++) for (let c = 0; c < 9; c++) draw('1.25', xs[c] + 10, 110 + r * 20)
  const ys = [25, 41, 57, 73, 95, 115, 135, 155, 175],
    lines: number[][] = []
  for (const y of ys) lines.push([20, y, 480, y])
  for (let r = 0; r < ys.length - 1; r++) {
    const fences =
      r === 0
        ? [20, 80, 280, 480]
        : r === 1
          ? [20, 80, 180, 280, 380, 480]
          : r === 3
            ? [20, 480]
            : xs
    for (const x of fences) lines.push([x, ys[r] + 0.25, x, ys[r + 1] - 0.25])
  }
  for (const r of lines)
    op(OPS.constructPath, [
      OPS.stroke,
      [new Float32Array([0, r[0], 220 - r[1], 1, r[2], 220 - r[3]])],
      new Float32Array([
        Math.min(r[0], r[2]),
        Math.min(220 - r[1], 220 - r[3]),
        Math.max(r[0], r[2]),
        Math.max(220 - r[1], 220 - r[3])
      ])
    ])
  const paint = new Map(),
    rules = collectTableRules(operators, viewport, paint),
    content = {
      items: raw,
      styles: { font: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false } }
    }
  return {
    table: {
      readingRotation: 0,
      cropRect: [20, 20, 480, 175],
      spans: [],
      structure: {
        objects: [
          ...xs
            .slice(1)
            .map((x, c) => ({ label: 'table column', rect: [xs[c] - 20, 0, x - 20, 155] })),
          ...[
            [41, 57],
            [57, 73],
            [73, 95],
            [95, 115],
            [115, 135],
            [135, 155],
            [155, 175]
          ].map(([a, b]) => ({ label: 'table row', rect: [0, a - 20, 460, b - 20] })),
          { label: 'table column header', rect: [0, 21, 460, 71] }
        ]
      }
    },
    tokens: raw.map((i) => tableTextToken(i, viewport, 0)),
    rules,
    captions: [{ page: 1, lines: [raw[0].str], rect: [20, 5, 20 + raw[0].width, 15] }],
    context: {
      operators,
      viewport,
      sourceContent: content,
      content,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: lines.map((r) => ({
        kind: 'path',
        rect: [
          Math.min(r[0], r[2]) - 0.25,
          Math.min(r[1], r[3]) - 0.25,
          Math.max(r[0], r[2]) + 0.25,
          Math.max(r[1], r[3]) + 0.25
        ].map(
          (v: number, n: number) =>
            ((n < 2
              ? Math.floor((v / (n % 2 ? 220 : 500)) * 256)
              : Math.ceil((v / (n % 2 ? 220 : 500)) * 256) + 1) *
              (n % 2 ? 220 : 500)) /
            256
        )
      }))
    }
  }
}

it.each(['missing parent row', 'merged first row'])(
  'recovers three native fenced tiers through production refinement for %s',
  (variant) => {
    const f = threeTierNativeFences(),
      before = structuredClone(f.tokens)
    if (variant === 'merged first row')
      f.table.structure.objects.find(
        (o: ReturnType<typeof JSON.parse>) => o.label === 'table row'
      ).rect[1] = 2.5
    const fresh = refineTable(
      structuredClone(f.table),
      f.tokens,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      f.context.rulePaintBounds,
      f.context
    )
    expect(fresh.grid.slice(0, 3)).toEqual([
      ['', 'ParentA', '', '', '', 'ParentB', '', '', ''],
      ['', 'Qxy', '', 'Qxy', '', 'Qxy', '', 'Qxy', ''],
      ['Size', 'Leaf', 'Leaf', 'Leaf', 'Leaf', 'Leaf', 'Leaf', 'Leaf', 'Leaf']
    ])
    expect(fresh.cells).toContainEqual(
      expect.objectContaining({ row: 0, column: 1, text: 'ParentA', colSpan: 4 })
    )
    expect(fresh.cells).toContainEqual(
      expect.objectContaining({
        row: 1,
        column: 1,
        text: 'Qxy',
        colSpan: 2,
        textRuns: [
          { text: 'Q', position: 'normal' },
          { text: 'xy', position: 'subscript' }
        ]
      })
    )
    expect(fresh.grid.slice(4)).toEqual(Array.from({ length: 4 }, () => Array(9).fill('1.25')))
    expect(fresh.cropRect).toEqual(f.table.cropRect)
    expect(fresh.unassigned).toEqual([])
    expect(f.tokens).toEqual(before)
  }
)

it.each([
  'missing fence',
  'crossing fence',
  'crossing font',
  'missing child',
  'extra parent',
  'missing scalar',
  'source alias',
  'origin mismatch',
  'missing viewport',
  'malformed rules',
  'unknown glyph',
  'invisible paint',
  'partial caption',
  'competing caption'
])('refuses three-tier ownership for %s without mutating the input', (variant) => {
  const f = threeTierNativeFences()
  if (variant === 'missing fence')
    f.rules.splice(
      f.rules.findIndex((r: number[]) => r[0] === 180 && r[2] === 180 && r[1] < 57),
      1
    )
  if (variant === 'crossing fence')
    f.rules.find((r: number[]) => r[0] === 180 && r[2] === 180 && r[1] < 57)[3] += 2
  if (variant === 'crossing font')
    f.tokens.find((i: ReturnType<typeof JSON.parse>) => i.text === 'ParentA').rect[2] = 300
  if (variant === 'missing child')
    f.tokens.splice(
      f.tokens.findIndex((i: ReturnType<typeof JSON.parse>) => i.text === 'xy'),
      1
    )
  if (variant === 'extra parent')
    f.tokens.push(
      structuredClone(f.tokens.find((i: ReturnType<typeof JSON.parse>) => i.text === 'ParentA'))
    )
  if (variant === 'missing scalar')
    f.tokens.splice(
      f.tokens.findIndex((i: ReturnType<typeof JSON.parse>) => i.text === '1.25'),
      1
    )
  if (variant === 'source alias') f.tokens[1].sourceToken = structuredClone(f.tokens[1])
  if (variant === 'origin mismatch') f.tokens[1].sourceItem.text = 'Other'
  if (variant === 'missing viewport') delete f.context.viewport
  if (variant === 'malformed rules') f.rules[0] = [0, 0, 1]
  if (variant === 'unknown glyph')
    f.context.operators.argsArray.find(
      (a: unknown[], n: number) => f.context.operators.fnArray[n] === OPS.showText
    )[0][0].operatorListId = 'unknown'
  if (variant === 'invisible paint') {
    f.context.operators.fnArray.unshift(OPS.setFillRGBColor)
    f.context.operators.argsArray.unshift(['#ffffff'])
  }
  if (variant === 'partial caption') f.captions[0].rect[2] -= 5
  if (variant === 'competing caption') f.captions.push(structuredClone(f.captions[0]))
  const before = JSON.stringify(f)
  expect(() => recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)).not.toThrow()
  expect(recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)).toBeUndefined()
  expect(JSON.stringify(f)).toEqual(before)
})

it('keeps a healthy three-tier model on its existing refinement path', () => {
  const f = threeTierNativeFences(),
    first = f.table.structure.objects.find(
      (o: ReturnType<typeof JSON.parse>) => o.label === 'table row'
    )
  first.rect[1] = 2.5
  first.rect[3] = 21
  f.table.structure.objects.push({ label: 'table row', rect: [0, 21, 460, 37] })
  const old = refineTable(structuredClone(f.table), f.tokens, f.captions, [], f.rules)
  expect(recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)).toBeUndefined()
  const fresh = refineTable(
    structuredClone(f.table),
    f.tokens,
    f.captions,
    [],
    f.rules,
    [],
    undefined,
    f.context.rulePaintBounds,
    f.context
  )
  expect(fresh).toEqual(old)
})

it('retains the existing path when a missing parent prediction has a header ending before the independent body title', () => {
  const f = threeTierNativeFences()
  f.table.structure.objects.find(
    (o: ReturnType<typeof JSON.parse>) => o.label === 'table column header'
  ).rect[3] = 53
  const old = refineTable(structuredClone(f.table), f.tokens, f.captions, [], f.rules)
  expect(recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)).toBeUndefined()
  expect(
    refineTable(
      structuredClone(f.table),
      f.tokens,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      f.context.rulePaintBounds,
      f.context
    )
  ).toEqual(old)
})

const closedPairedParentFences = (single = false): ReturnType<typeof JSON.parse> => {
  const viewport = {
    width: 500,
    height: 300,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 300],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 300 - y]
  }
  const raw: ReturnType<typeof JSON.parse>[] = [],
    operators = { fnArray: [OPS.dependency, OPS.setLineWidth], argsArray: [['font'], [0.5]] }
  const op = (code: number, args: unknown): void => {
    operators.fnArray.push(code)
    operators.argsArray.push(args as ReturnType<typeof JSON.parse>)
  }
  const draw = (str: string, x: number, baseline: number): void => {
    raw.push({
      str,
      fontName: 'font',
      transform: [10, 0, 0, 10, x, 300 - baseline],
      width: str.length * 5,
      height: 10,
      dir: 'ltr',
      sourceItem: { pageNumber: 1, index: raw.length, text: str }
    })
    op(OPS.setFont, ['font', 10])
    op(OPS.beginText, null)
    op(OPS.setTextMatrix, [new Float32Array([1, 0, 0, 1, x, 300 - baseline])])
    op(OPS.showText, [
      [...str].map((unicode) => ({
        unicode,
        fontChar: unicode,
        originalCharCode: unicode.codePointAt(0),
        width: 500,
        isInFont: true,
        operatorListId: null
      }))
    ])
    op(OPS.endText, null)
  }
  draw('Table 1: Paired measurements.', 20, 15)
  if (single) {
    draw('Shared', 135, 38)
    for (const x of [250, 325, 400]) draw('Upper', x, 38)
  } else {
    draw('GroupA', 235, 38)
    draw('GroupB', 375, 38)
  }
  draw(single ? 'α' : 'Kind', 30, single ? 64 : 58)
  if (single) {
    for (const [c, x] of [100, 175, 250, 325, 400].entries())
      draw(['Left', 'Right', 'Third', 'Fourth', 'Fifth'][c], x, 64)
  } else {
    draw('Text', 100, 58)
    for (const x of [190, 240, 290, 330, 380, 430]) draw('Leaf', x, 58)
  }
  for (let row = 0; row < (single ? 3 : 4); row++) {
    const y = 82 + row * 16
    if (single || row !== 1) draw(single ? String(row + 1) + '.0' : 'Kind' + row, 30, y)
    if (!single) draw('Text' + row, 100, y)
    for (const [c, x] of (single
      ? [100, 175, 250, 325, 400]
      : [190, 240, 290, 330, 380, 430]
    ).entries())
      draw('0.' + String(10 + row + c) + (single && c >= 3 ? 'e-4' : ''), x, y)
  }
  for (const r of [
    [20, 25, 460, 25],
    ...(single
      ? [[105, 43, 192, 43]]
      : [
          [185, 43, 315, 43],
          [325, 43, 455, 43]
        ]),
    [20, 66, 460, 66],
    [20, 142, 460, 142]
  ])
    op(OPS.constructPath, [
      OPS.stroke,
      [new Float32Array([0, r[0], 300 - r[1], 1, r[2], 300 - r[3]])],
      new Float32Array([r[0], 300 - r[1], r[2], 300 - r[3]])
    ])
  const paint = new Map(),
    rules = collectTableRules(operators, viewport, paint)
  const content = {
    items: raw,
    styles: { font: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false } }
  }
  const xs = single
    ? [20, 80, 125, 225, 300, 375, 460]
    : [20, 80, 180, 225, 275, 320, 365, 415, 460]
  return {
    table: {
      readingRotation: 0,
      cropRect: [20, 25, 460, 142],
      spans: [],
      structure: {
        objects: [
          ...xs.slice(1).map((x, c) => ({
            label: 'table column',
            rect: [xs[c] - 20, single ? 18 : 0, x - 20, 117]
          })),
          { label: 'table column header', rect: [0, single ? 18 : 0, 440, 41] },
          ...(single
            ? [
                [18, 41],
                [41, 65],
                [65, 81],
                [81, 101]
              ].map(([top, bottom]) => ({ label: 'table row', rect: [0, top, 440, bottom] }))
            : [])
        ]
      }
    },
    tokens: raw.map((i) => tableTextToken(i, viewport, 0)),
    rules,
    captions: [{ page: 1, lines: [raw[0].str], rect: [20, 5, 165, 15] }],
    context: {
      operators,
      viewport,
      sourceContent: content,
      content,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: [...paint.values()].map((r) => ({
        kind: 'path',
        rect: r.map((value: number, n: number) => {
          const v = value + (n === 0 ? -0.25 : n === 2 ? 0.25 : 0)
          return (
            ((n < 2
              ? Math.floor((v / (n % 2 ? 300 : 500)) * 256)
              : Math.ceil((v / (n % 2 ? 300 : 500)) * 256) + 1) *
              (n % 2 ? 300 : 500)) /
            256
          )
        })
      }))
    }
  }
}

it('keeps a single native partial fence over two complete leaf lanes without clipping their fonts', () => {
  const f = closedPairedParentFences(true)
  expect(recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)?.spans).toContainEqual({
    row: 0,
    column: 1,
    rowSpan: 1,
    colSpan: 2
  })
  const before = structuredClone(f.tokens)
  const result = refineTable(
    f.table,
    f.tokens,
    f.captions,
    [],
    f.rules,
    [],
    undefined,
    f.context.rulePaintBounds,
    f.context
  )
  expect(result.cells).toContainEqual(
    expect.objectContaining({ text: 'Shared', row: 0, column: 1, colSpan: 2 })
  )
  expect(result.grid.slice(2)).toEqual([
    ['1.0', '0.10', '0.11', '0.12', '0.13e-4', '0.14e-4'],
    ['2.0', '0.11', '0.12', '0.13', '0.14e-4', '0.15e-4'],
    ['3.0', '0.12', '0.13', '0.14', '0.15e-4', '0.16e-4']
  ])
  expect(result.unassigned).toEqual([])
  expect(
    result.cells.flatMap((c) => c.sourceItems ?? []).sort((a, b) => a.index - b.index)
  ).toEqual(
    f.tokens
      .filter((i) => i.baseline > 25)
      .map((i) => i.sourceItem)
      .sort((a, b) => a.index - b.index)
  )
  expect(f.tokens).toEqual(before)
})

it('retains two closed three-leaf parent fences without interpreting a sparse body stub', () => {
  const f = closedPairedParentFences(),
    before = structuredClone(f.tokens)
  const proof = recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)
  expect(proof?.spans).toContainEqual({ row: 0, column: 2, rowSpan: 1, colSpan: 3 })
  expect(proof?.spans).toContainEqual({ row: 0, column: 5, rowSpan: 1, colSpan: 3 })
  const old = refineTable(structuredClone(f.table), f.tokens, f.captions, [], f.rules)
  const fresh = refineTable(
    structuredClone(f.table),
    f.tokens,
    f.captions,
    [],
    f.rules,
    [],
    undefined,
    f.context.rulePaintBounds,
    f.context
  )
  expect(fresh.grid.slice(0, 2)).toEqual([
    ['Kind', 'Text', 'GroupA', '', '', 'GroupB', '', ''],
    ['', '', 'Leaf', 'Leaf', 'Leaf', 'Leaf', 'Leaf', 'Leaf']
  ])
  expect(fresh.grid.slice(2)).toEqual(old.grid.slice(1))
  expect(fresh.cells).toContainEqual(
    expect.objectContaining({ text: 'GroupA', row: 0, column: 2, colSpan: 3 })
  )
  expect(fresh.cells).toContainEqual(
    expect.objectContaining({ text: 'GroupB', row: 0, column: 5, colSpan: 3 })
  )
  expect(fresh.unassigned).toEqual([])
  expect(f.tokens).toEqual(before)
})

const rebindPairedFencePaint = (f: ReturnType<typeof JSON.parse>): void => {
  const paint = new Map()
  f.rules = collectTableRules(f.context.operators, f.context.viewport, paint)
  f.context.rulePaintBounds = paint
  f.context.nativeEvidenceGraphics = [...paint.values()].map((r) => ({
    kind: 'path',
    rect: r.map((value: number, n: number) => {
      const v = value + (n === 0 ? -0.25 : n === 2 ? 0.25 : 0)
      return (
        ((n < 2
          ? Math.floor((v / (n % 2 ? 300 : 500)) * 256)
          : Math.ceil((v / (n % 2 ? 300 : 500)) * 256) + 1) *
          (n % 2 ? 300 : 500)) /
        256
      )
    })
  }))
}

it.each([
  'missing fence',
  'missing body font',
  'changed model owner',
  'shifted fence',
  'duplicate whole identity',
  'external segment alias',
  'external nested alias',
  'external direct token alias',
  'external nested segment alias',
  'missing source packet',
  'unknown paint operator',
  'moved original glyph'
])('preserves existing output when a single parent fence lacks full proof: %s', (variant) => {
  const f = closedPairedParentFences(true)
  const op = f.context.operators
  if (variant === 'missing fence' || variant === 'shifted fence') {
    const n = op.fnArray.findIndex(
      (code: number, i: number) => code === OPS.constructPath && op.argsArray[i][2][0] === 105
    )
    if (variant === 'missing fence') {
      op.fnArray.splice(n, 1)
      op.argsArray.splice(n, 1)
    } else {
      op.argsArray[n][1][0][4] = 170
      op.argsArray[n][2][2] = 170
    }
    rebindPairedFencePaint(f)
  }
  if (variant === 'missing body font')
    f.tokens.splice(
      f.tokens.findIndex((i) => i.text === '0.10'),
      1
    )
  if (variant === 'changed model owner') {
    const cols = f.table.structure.objects.filter((o) => o.label === 'table column')
    cols[1].rect[2] = cols[2].rect[0] = 80
  }
  if (variant === 'duplicate whole identity')
    f.tokens.push(structuredClone(f.tokens.find((i) => i.text === 'Shared')))
  if (variant.startsWith('external ')) {
    const original = f.tokens.find((i) => i.text === 'Shared').sourceItem
    f.tokens.push({
      text: 'Shared',
      rect: [470, 180, 490, 190],
      baseline: 190,
      height: 10,
      horizontal: true,
      ...(variant === 'external segment alias'
        ? { sourceSegment: { ...original, start: 0, end: 6 } }
        : variant === 'external direct token alias'
          ? { sourceToken: original }
          : variant === 'external nested segment alias'
            ? { sourceToken: { sourceSegment: { ...original, start: 0, end: 6 } } }
            : { sourceToken: { sourceItem: original } })
    })
  }
  if (variant === 'missing source packet') f.context.content = undefined
  if (variant === 'unknown paint operator') {
    op.fnArray.push(OPS.setGState)
    op.argsArray.push([])
  }
  if (variant === 'moved original glyph') {
    const n = op.fnArray.findIndex((code: number) => code === OPS.setTextMatrix)
    op.argsArray[n][0][4] += 20
  }
  expect(recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)).toBeUndefined()
  const old = refineTable(structuredClone(f.table), f.tokens, f.captions, [], f.rules)
  const result = refineTable(
    structuredClone(f.table),
    f.tokens,
    f.captions,
    [],
    f.rules,
    [],
    undefined,
    f.context.rulePaintBounds,
    f.context
  )
  expect(result).toEqual(old)
})

it.each([
  'missing parent fence',
  'unequal parent fence',
  'missing scalar',
  'wrong model body lane',
  'unknown font dependency',
  'white glyphs',
  'raw glyph moved',
  'foreign original moved',
  'missing raw packet',
  'duplicate original font'
])('refuses a closed paired header without complete independent source proof: %s', (variant) => {
  const f = closedPairedParentFences(),
    op = f.context.operators
  if (variant === 'missing parent fence' || variant === 'unequal parent fence') {
    const n = op.fnArray.findIndex(
      (c: number, i: number) => c === OPS.constructPath && op.argsArray[i][2][0] === 185
    )
    if (variant === 'missing parent fence') {
      op.fnArray.splice(n, 1)
      op.argsArray.splice(n, 1)
    } else {
      op.argsArray[n][1][0][4] -= 1
      op.argsArray[n][2][2] -= 1
    }
    rebindPairedFencePaint(f)
  }
  if (variant === 'missing scalar')
    f.tokens.splice(
      f.tokens.findIndex((i) => i.text === '0.10'),
      1
    )
  if (variant === 'wrong model body lane') {
    const cols = f.table.structure.objects.filter((o) => o.label === 'table column')
    cols[2].rect[2] = cols[3].rect[0] = 180
  }
  if (variant === 'unknown font dependency') op.argsArray[0] = ['unbound']
  if (variant === 'white glyphs') {
    op.fnArray.splice(2, 0, OPS.setFillRGBColor)
    op.argsArray.splice(2, 0, ['#ffffff'])
    rebindPairedFencePaint(f)
  }
  if (variant === 'raw glyph moved' || variant === 'foreign original moved') {
    const matrices = op.fnArray
      .map((c: number, n: number) => (c === OPS.setTextMatrix ? n : -1))
      .filter((n: number) => n >= 0)
    const n = matrices[variant === 'foreign original moved' ? 0 : 5]
    op.argsArray[n][0][4] += 20
  }
  if (variant === 'missing raw packet') delete f.context.operators
  if (variant === 'duplicate original font') f.tokens.push(structuredClone(f.tokens[3]))
  const before = structuredClone(f.tokens)
  expect(recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)).toBeUndefined()
  expect(f.tokens).toEqual(before)
})

const aligned = (): ReturnType<typeof readPdfFixture> => {
  const f = load()
  f.tokens = f.tokens.filter((i: { baseline: number }) => i.baseline > 50)
  for (const [c, x] of [8, 73, 113, 161, 203].entries())
    f.tokens.push({
      text: ['Category', 'Leaf A', 'Leaf B', 'Leaf C', 'Leaf D'][c],
      rect: [x, 22, x + 24, 32],
      baseline: 32,
      height: 10,
      horizontal: true,
      font: 'Fixture-Regular'
    })
  for (const i of f.tokens.filter((i: { baseline: number }) => i.baseline === 97))
    f.tokens.push({
      ...i,
      text: i.text === 'Item coral' ? 'Item lilac' : String(Number(i.text) + 7),
      rect: [i.rect[0], i.rect[1] + 17, i.rect[2], i.rect[3] + 17],
      baseline: 114
    })
  f.rules = [
    [0, 20, 240, 20],
    [0, 40, 240, 40],
    [0, 129, 240, 129]
  ]
  f.table.cropRect = [0, 20, 240, 129]
  const columns = f.table.structure.objects.filter(
    (o: { label: string }) => o.label === 'table column'
  )
  columns.at(-2).rect[2] = columns.at(-1).rect[2]
  f.table.structure.objects.splice(f.table.structure.objects.indexOf(columns.at(-1)), 1)
  return f
}
it('restores complete repeated source leaves when the model combines the last two header and value columns', () => {
  const f = aligned(),
    result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid[0]).toEqual(['Category', 'Leaf A', 'Leaf B', 'Leaf C', 'Leaf D'])
  expect(result.grid[4]).toEqual(['Item lilac', '52', '55', '58', '61'])
  expect(result.unassigned).toHaveLength(0)
  expect(result.clipped).toHaveLength(0)
})
it.each(['missing leaf', 'overlapping leaf ink', 'missing footer', 'header crosses outer edge'])(
  'declines unproved repeated leaf ownership: %s',
  (variant) => {
    const f = aligned()
    if (variant === 'missing leaf')
      f.tokens.splice(
        f.tokens.findIndex((i: { text: string }) => i.text === '31'),
        1
      )
    if (variant === 'overlapping leaf ink')
      f.tokens.find((i: { text: string }) => i.text === 'Leaf B').rect[0] = 85
    if (variant === 'missing footer') f.rules.pop()
    if (variant === 'header crosses outer edge')
      f.tokens.find((i: { text: string }) => i.text === 'Leaf D').rect[2] = 248
    const plan = recover(f.table, f.tokens, f.captions, f.rules)
    if (variant === 'missing leaf') expect(plan?.columns.length ?? 0).not.toBe(5)
    else expect(plan).toBeUndefined()
  }
)
const {
  recoverNativeHeaderOwnershipGrid: recover,
  recoverNativeTwoTierParentHeaderGrid: recoverTwoTier
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-header-ownership.mjs')).href
)
const load = (): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(resolve('test/fixtures/native-underlined-two-tier-numeric-header.jsonl'))

const centeredParents = (): ReturnType<typeof readPdfFixture> => {
  const f = load()
  f.rules = [20, 54, 112].map((y) => [0, y, 240, y])
  f.tokens = f.tokens.filter((i: { text: string }) => i.text !== 'Measure')
  return f
}

it('recovers centered parent tiers above independently populated body leaves', () => {
  const f = centeredParents()
  expect(recover(f.table, f.tokens, f.captions, f.rules)?.columns).toHaveLength(5)
})

it.each(['single shared statistic', 'shared category and statistic'])(
  'leaves unresolved body scope to existing span recovery: %s',
  (variant) => {
    const f = centeredParents()
    if (variant === 'single shared statistic')
      f.tokens = f.tokens.filter(
        (i: { baseline: number; rect: number[] }) => !(i.baseline > 63 && i.rect[0] > 195)
      )
    if (variant === 'shared category and statistic')
      f.tokens = f.tokens.filter(
        (i: { baseline: number; rect: number[] }) =>
          !(i.baseline === 80 && (i.rect[0] < 65 || i.rect[0] > 195))
      )
    expect(recover(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  }
)

it('keeps two underlined parent header scopes above complete independent numeric leaves', () => {
  const f = load()
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(result.grid.slice(0, 2)).toEqual([
    ['Category', 'Cohort alpha', '', 'Cohort beta', ''],
    ['Measure', 'Low', 'High', 'Low', 'High']
  ])
  expect(result.cells).toContainEqual(
    expect.objectContaining({ row: 0, column: 1, colSpan: 2, text: 'Cohort alpha' })
  )
  expect(result.grid.slice(2).map((row: string[]) => row.slice(1))).toEqual([
    ['31', '34', '37', '40'],
    ['38', '41', '44', '47'],
    ['45', '48', '51', '54']
  ])
})

it.each([
  'missing footer',
  'foreign edge',
  'nonfinite baseline',
  'large opening overhang',
  'competing caption',
  'foreign body baseline'
])('declines incomplete native header ownership: %s', (variant) => {
  const f = load()
  if (variant === 'missing footer')
    f.rules = f.rules.filter((r: number[]) => r[1] !== 112 || r[3] !== 112)
  if (variant === 'foreign edge')
    f.tokens.push({
      text: 'Foreign',
      rect: [230, 70, 250, 80],
      baseline: 80,
      height: 10,
      horizontal: true
    })
  if (variant === 'nonfinite baseline') f.tokens[0].baseline = NaN
  if (variant === 'large opening overhang') f.tokens[0].rect[1] = 15
  if (variant === 'competing caption')
    f.captions.push({ ...f.captions[0], lines: ['Table 8. Comparison.'] })
  if (variant === 'foreign body baseline')
    f.tokens.push({
      text: 'Foreign',
      rect: [10, 58, 50, 68],
      baseline: 68,
      height: 10,
      horizontal: true
    })
  expect(recover(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})

const ruledPairHeader = (): ReturnType<typeof JSON.parse> => {
  const token = (
    text: string,
    left: number,
    right: number,
    baseline: number
  ): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [left, baseline - 10, right, baseline],
    baseline,
    height: 10,
    horizontal: true
  })
  const items = [
    token('Record', 8, 45, 40),
    token('Measured response', 85, 155, 30),
    token('Left', 76, 98, 45),
    token('Right', 135, 162, 45),
    ...[65, 80, 95].flatMap((y, n) => [
      token('Item ' + ['amber', 'violet', 'cyan'][n], 5, 50, y),
      token(String(n + 1) + '.25', 75, 100, y),
      token(String(n + 2) + '.50', 135, 165, y)
    ])
  ]
  return {
    items,
    captions: [
      {
        page: 1,
        lines: ['Table 2: Independently measured native comparisons.'],
        rect: [0, 0, 180, 10]
      }
    ],
    rules: [
      [0, 20, 180, 20],
      [60, 35, 180, 35],
      [0, 50, 180, 50],
      [0, 110, 180, 110]
    ],
    table: {
      cropRect: [0, 20, 180, 110],
      structure: {
        objects: [0, 60, 120].map((x) => ({ label: 'table column', rect: [x, 0, x + 60, 90] }))
      }
    }
  }
}

it('retains one native parent over two independently witnessed leaves and a separate stub', () => {
  const x = ruledPairHeader(),
    before = structuredClone(x)
  const p = recover(x.table, x.items, x.captions, x.rules)
  expect(p?.spans).toContainEqual({ row: 0, column: 1, rowSpan: 1, colSpan: 2 })
  expect(p?.spans).toContainEqual({ row: 0, column: 0, rowSpan: 2, colSpan: 1 })
  expect(p?.rows).toHaveLength(5)
  expect(p?.ownedTokens.size).toBe(x.items.length)
  expect(x).toEqual(before)
})

it.each(['missing parent stroke', 'one body witness', 'crossing leaf', 'competing caption'])(
  'declines a minimal parent scope without independent %s evidence',
  (variant) => {
    const x = ruledPairHeader()
    if (variant === 'missing parent stroke') x.rules.splice(1, 1)
    if (variant === 'one body witness')
      x.items = x.items.filter((i: { baseline: number }) => i.baseline < 80)
    if (variant === 'crossing leaf')
      x.items.find((i: { text: string }) => i.text === 'Right').rect[2] = 190
    if (variant === 'competing caption') x.captions.push(structuredClone(x.captions[0]))
    expect(recover(x.table, x.items, x.captions, x.rules)?.spans ?? []).not.toContainEqual({
      row: 0,
      column: 1,
      rowSpan: 1,
      colSpan: 2
    })
  }
)

const paddedWholeLeaves = (): ReturnType<typeof JSON.parse> => {
  let index = 0
  const token = (
    text: string,
    left: number,
    right: number,
    baseline: number
  ): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [left, baseline - 10, right, baseline],
    baseline,
    height: 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const title = 'Table 3: Independently counted records.'
  return {
    tokens: [
      token(title, 0, 280, 10),
      token('Record', 10, 45, 33),
      token('Key', 70, 110, 33),
      token('Excluding helper', 118, 198, 33),
      token('Including helper', 208, 268, 33),
      ...[48, 60, 72, 84].flatMap((y, n) => [
        token(`Item ${n + 1}`, 20, 48, y),
        token(String(n + 11), 80, 108, y),
        token(String(n + 21), 160, 190, y),
        token(String(n + 31), 240, 268, y)
      ]),
      token('Continued on next page.', 150, 268, 101)
    ],
    captions: [{ page: 1, lines: [title], rect: [0, 0, 280, 10] }],
    rules: [20, 38, 90].map((y) => [10, y, 270, y]),
    table: {
      readingRotation: 0,
      cropRect: [-12, 20, 282, 102],
      spans: [],
      structure: {
        objects: [10, 60, 158.01, 203].map((x, c, xs) => ({
          label: 'table column',
          rect: [x + 12, 18, (xs[c + 1] ?? 270) + 12, 70]
        }))
      }
    }
  }
}

it('recovers four whole above-caption leaves inside independent native frame padding', () => {
  const f = paddedWholeLeaves(),
    before = structuredClone(f),
    p = recover(f.table, f.tokens, f.captions, f.rules)
  expect(p?.rows).toHaveLength(5)
  expect(p?.columns).toHaveLength(4)
  expect(p?.spans).toEqual([])
  expect(p?.ownedTokens.size).toBe(20)
  expect(p?.cropRect[3]).toBe(90.5)
  expect(f).toEqual(before)
  const r = refineTable(f.table, f.tokens, f.captions, [], f.rules)
  expect(r.grid).toEqual([
    ['Record', 'Key', 'Excluding helper', 'Including helper'],
    ['Item 1', '11', '21', '31'],
    ['Item 2', '12', '22', '32'],
    ['Item 3', '13', '23', '33'],
    ['Item 4', '14', '24', '34']
  ])
  expect(r.unassigned).toEqual([])
  expect(r.cells.flatMap((c: { sourceItems: unknown[] }) => c.sourceItems)).toHaveLength(20)
})

it.each([
  'missing footer',
  'extra divider',
  'incomplete caption',
  'competing caption',
  'missing body field',
  'changed body lane',
  'crossing header ink',
  'multiple header baselines',
  'missing original font',
  'changed original literal',
  'duplicate original font',
  'foreign crossing ink',
  'already whole model leaves'
])('refuses unproved padded whole-leaf ownership without mutation: %s', (variant) => {
  const f = paddedWholeLeaves()
  if (variant === 'missing footer') f.rules.pop()
  if (variant === 'extra divider') f.rules.push([10, 65, 270, 65])
  if (variant === 'incomplete caption') f.captions[0].lines.push('Additional absent text.')
  if (variant === 'competing caption') f.captions.push(structuredClone(f.captions[0]))
  if (variant === 'missing body field') f.tokens.splice(7, 1)
  if (variant === 'changed body lane') f.tokens[7].rect.splice(0, 3, 111, 38, 117)
  if (variant === 'crossing header ink') f.tokens[3].rect[0] = 105
  if (variant === 'multiple header baselines') f.tokens[3].baseline = 37
  if (variant === 'missing original font') delete f.tokens[3].sourceItem
  if (variant === 'changed original literal') f.tokens[3].sourceItem.text += '!'
  if (variant === 'duplicate original font') f.tokens[3].sourceItem.index = 2
  if (variant === 'foreign crossing ink')
    f.tokens.push({ ...f.tokens[5], text: 'Foreign', rect: [5, 40, 25, 50], baseline: 50 })
  if (variant === 'already whole model leaves') {
    const cols = f.table.structure.objects
    cols[1].rect[2] = cols[2].rect[0] = 126
    cols[2].rect[2] = cols[3].rect[0] = 215
  }
  const before = structuredClone(f)
  expect(recover(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  expect(f).toEqual(before)
})

const wholeParentTiers = (
  lowerStub = false,
  terminal = false,
  ambiguous = false,
  fourLeaves = false
): ReturnType<typeof JSON.parse> => {
  const count = fourLeaves ? 9 : ambiguous ? 7 : terminal ? 6 : 5,
    step = ambiguous ? 10 : 50,
    width = count * step,
    tokens: ReturnType<typeof JSON.parse>[] = []
  const token = (text: string, left: number, right: number, baseline: number): void => {
    tokens.push({
      text,
      rect: [left, baseline - 10, right, baseline],
      baseline,
      height: 10,
      horizontal: true,
      inlineSymbol: false,
      sourceItem: { pageNumber: 1, index: tokens.length, text }
    })
  }
  const title = 'Table 3: Independent groups.'
  token(title, 0, width, 10)
  token('Record', ambiguous ? 2 : 10, ambiguous ? 5 : 40, lowerStub ? 44 : 32)
  if (ambiguous) {
    token('Group A', 19.5, 21.5, 32)
    token('Group B', 49.5, 51.5, 32)
  } else if (fourLeaves) {
    token('Group A', 124, 176, 32)
    token('Group B', 324, 376, 32)
  } else {
    token('Group A', 80, 120, 32)
    token('Group', 175, 201, 32)
    token('B', 201, 225, 32)
    if (terminal) token('Sole', 265, 285, 32)
  }
  for (let c = 1; c < count; c++)
    token(
      fourLeaves ? String(((c - 1) % 4) + 1) : `Leaf ${c}`,
      c * step + (ambiguous ? 2 : 15),
      c * step + (ambiguous ? 4 : 35),
      44
    )
  for (const [r, y] of [64, 76, 88, 100].entries())
    for (let c = 0; c < count; c++)
      token(
        c ? String(11 + r + c) : `Item ${r + 1}`,
        c * step + (ambiguous ? 2 : 15),
        c * step + (ambiguous ? 4 : 35),
        y
      )
  const sourceContent = {
    items: tokens.map((i) => ({
      str: i.text,
      dir: 'ltr',
      width: i.rect[2] - i.rect[0],
      height: 10,
      transform: [10, 0, 0, 10, i.rect[0], 200 - i.baseline],
      fontName: 'Regular',
      sourceItem: { ...i.sourceItem }
    })),
    styles: { Regular: { fontFamily: 'serif', ascent: 0.7, descent: -0.2, vertical: false } }
  }
  return {
    tokens,
    captions: [{ page: 1, lines: [title], rect: [0, 0, width, 10] }],
    rules: [20, 50, 110].map((y) => [0, y, width, y]),
    table: {
      readingRotation: 0,
      cropRect: [0, 20, width, 110],
      spans: [],
      structure: {
        objects: Array.from({ length: count }, (_, c) => ({
          label: 'table column',
          rect: [c * step, 0, (c + 1) * step, 90]
        }))
      }
    },
    context: {
      sourceContent,
      viewport: { rotation: 0, width, height: 200, transform: [1, 0, 0, -1, 0, 200] }
    }
  }
}

it.each([false, true])(
  'retains whole two-tier parents and independent records with a lower-tier stub: %s',
  (lowerStub) => {
    const f = wholeParentTiers(lowerStub, !lowerStub),
      before = structuredClone(f),
      p = recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)
    expect(p?.rows).toHaveLength(6)
    expect(p?.columns).toHaveLength(lowerStub ? 5 : 6)
    expect(p?.headerRows).toEqual([0, 1])
    expect(p?.spans).toContainEqual({ row: 0, column: 0, rowSpan: 2, colSpan: 1 })
    expect(p?.spans).toContainEqual({ row: 0, column: 1, rowSpan: 1, colSpan: 2 })
    expect(p?.spans).toContainEqual({ row: 0, column: 3, rowSpan: 1, colSpan: 2 })
    if (!lowerStub) expect(p?.spans).toContainEqual({ row: 0, column: 5, rowSpan: 1, colSpan: 1 })
    expect(p?.ownedTokens.size).toBe(f.tokens.length - 1)
    for (const i of f.tokens.slice(1)) expect(p?.ownedTokens.has(i)).toBe(true)
    expect(p?.cropRect).toEqual(f.table.cropRect)
    expect(f).toEqual(before)
    const oldInput = structuredClone(f),
      freshInput = structuredClone(f),
      old = refineTable(oldInput.table, oldInput.tokens, oldInput.captions, [], oldInput.rules),
      fresh = refineTable(
        freshInput.table,
        freshInput.tokens,
        freshInput.captions,
        [],
        freshInput.rules,
        [],
        undefined,
        undefined,
        freshInput.context
      )
    expect(fresh.grid.slice(2)).toEqual(old.grid.slice(1))
    // Logical grid bounds are remeasured; exported cell/source fields stay exact.
    const exported = (c: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
      Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'rect'))
    expect(fresh.cells.filter((c: { row: number }) => c.row >= 2).map(exported)).toEqual(
      old.cells
        .filter((c: { row: number }) => c.row >= 1)
        .map((c: { row: number }) => exported({ ...c, row: c.row + 1 }))
    )
    expect(fresh.cropRect).toEqual(old.cropRect)
    expect(fresh.unassigned).toEqual([])
  }
)

it.each([
  'missing upper font',
  'partial upper font',
  'missing lower leaf',
  'missing body field',
  'missing whole record',
  'changed body lane',
  'missing original packet',
  'missing original style',
  'malformed original style',
  'unknown original font',
  'changed original literal',
  'changed original pose',
  'rotated original font',
  'duplicate source origin',
  'foreign source origin',
  'partial source carrier',
  'missing caption font',
  'incomplete caption',
  'competing caption',
  'missing footer',
  'extra divider',
  'third header tier',
  'uncentered parent',
  'crossing native gutter',
  'interior singleton',
  'ambiguous parent partition'
])('refuses incomplete or nonunique original two-tier packet without mutation: %s', (variant) => {
  const f = wholeParentTiers(false, true, variant === 'ambiguous parent partition'),
    upper = f.tokens.find((i: { text: string }) => i.text === 'Group A'),
    leaf = f.tokens.find((i: { text: string }) => i.text === 'Leaf 2'),
    body = f.tokens.find(
      (i: { baseline: number; text: string }) => i.baseline === 64 && i.text === '13'
    )
  const syncPose = (i: ReturnType<typeof JSON.parse>): void => {
    const raw = f.context.sourceContent.items[i.sourceItem.index]
    raw.width = i.rect[2] - i.rect[0]
    raw.transform[4] = i.rect[0]
    raw.transform[5] = 200 - i.baseline
  }
  if (variant === 'missing upper font') f.tokens.splice(f.tokens.indexOf(upper), 1)
  if (variant === 'partial upper font') upper.text = 'Group'
  if (variant === 'missing lower leaf') f.tokens.splice(f.tokens.indexOf(leaf), 1)
  if (variant === 'missing body field') f.tokens.splice(f.tokens.indexOf(body), 1)
  if (variant === 'missing whole record')
    f.tokens = f.tokens.filter((i: { baseline: number }) => i.baseline !== 100)
  if (variant === 'changed body lane') {
    body.rect[0] += 50
    body.rect[2] += 50
    syncPose(body)
  }
  if (variant === 'missing original packet') delete f.context.sourceContent
  if (variant === 'missing original style') delete f.context.sourceContent.styles.Regular
  if (variant === 'malformed original style') f.context.sourceContent.styles.Regular = []
  if (variant === 'unknown original font')
    f.context.sourceContent.items[upper.sourceItem.index].fontName = 'Unknown'
  if (variant === 'changed original literal')
    f.context.sourceContent.items[upper.sourceItem.index].str += '!'
  if (variant === 'changed original pose')
    f.context.sourceContent.items[upper.sourceItem.index].width += 1
  if (variant === 'rotated original font')
    f.context.sourceContent.items[upper.sourceItem.index].transform[1] = 1
  if (variant === 'duplicate source origin') leaf.sourceItem.index = upper.sourceItem.index
  if (variant === 'foreign source origin') upper.sourceItem.pageNumber = 2
  if (variant === 'partial source carrier') upper.sourceToken = { text: upper.text }
  if (variant === 'missing caption font') f.tokens.shift()
  if (variant === 'incomplete caption') f.captions[0].lines.push('Absent continuation.')
  if (variant === 'competing caption') f.captions.push(structuredClone(f.captions[0]))
  if (variant === 'missing footer') f.rules.pop()
  if (variant === 'extra divider') f.rules.push([0, 80, 300, 80])
  if (variant === 'third header tier') {
    leaf.baseline += 4
    leaf.rect[1] += 4
    leaf.rect[3] += 4
    syncPose(leaf)
  }
  if (variant === 'uncentered parent') {
    upper.rect[0] += 20
    upper.rect[2] += 20
    syncPose(upper)
  }
  if (variant === 'crossing native gutter') {
    leaf.rect[2] = 166
    syncPose(leaf)
  }
  if (variant === 'interior singleton') {
    const sole = f.tokens.find((i: { text: string }) => i.text === 'Sole')
    sole.rect[0] -= 150
    sole.rect[2] -= 150
    syncPose(sole)
  }
  const before = structuredClone(f)
  expect(recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)).toBeUndefined()
  expect(f).toEqual(before)
})

const crossedWholeStubTiers = (fourLeaves = false): ReturnType<typeof JSON.parse> => {
  const f = wholeParentTiers(true, false, false, fourLeaves)
  for (const i of f.tokens) {
    if (i.baseline === 32 || i.baseline === 44) {
      const shift = i.baseline === 32 ? 2 : 2.5
      i.baseline += shift
      i.rect[1] += shift
      i.rect[3] += shift
    }
    if (i.text === 'Item 4') i.rect[2] = 58
    const raw = f.context.sourceContent.items[i.sourceItem.index]
    raw.width = i.rect[2] - i.rect[0]
    raw.transform[5] = 200 - i.baseline
  }
  f.rules[1][1] = f.rules[1][3] = 52
  return f
}

it.each([
  'complete',
  'body-only',
  'missing origins',
  'changed spans',
  'unassigned',
  'explicit',
  'fragment carrier',
  'origin literal mismatch'
])(
  'preserves only complete whole-font grouped header ownership before the legacy fallback: %s',
  async (variant) => {
    const f = crossedWholeStubTiers(true),
      p = recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context),
      r = refineTable(
        f.table,
        f.tokens,
        f.captions,
        [],
        f.rules,
        [],
        undefined,
        undefined,
        f.context
      ),
      cells = structuredClone(r.cells),
      rows = structuredClone(r.rows),
      recordGrid = { ...p },
      headerRows = [0, 1],
      repairs: string[] = [],
      unassigned: string[] = []
    if (variant === 'body-only') recordGrid.headerRows = []
    if (variant === 'missing origins')
      delete cells.find((c: { row: number }) => c.row === 0).sourceItems
    if (variant === 'changed spans') recordGrid.spans = p.spans.slice(1)
    if (variant === 'unassigned') unassigned.push('Unowned')
    const parent = [...p.ownedTokens].find((i: { text: string }) => i.text === 'Group A')
    if (variant === 'fragment carrier')
      parent.sourceToken = { ...parent, rect: parent.rect.slice() }
    if (variant === 'origin literal mismatch') {
      parent.sourceItem.text += ' whole original'
      cells
        .find((c: ReturnType<typeof JSON.parse>) =>
          c.sourceItems?.some((o: { index: number }) => o.index === parent.sourceItem.index)
        )
        .sourceItems.find((o: { index: number }) => o.index === parent.sourceItem.index).text =
        parent.sourceItem.text
    }
    if (variant === 'fragment carrier' || variant === 'origin literal mismatch')
      expect(recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)).toBeUndefined()
    if (variant === 'explicit') {
      const { proveNativeTieredHeader } = await import(
        pathToFileURL(resolve('resources/literature-pdf-native-header-grid.mjs')).href
      )
      recordGrid.nativeTieredHeader = proveNativeTieredHeader(
        f.table,
        f.tokens,
        f.captions,
        f.rules
      )
      expect(recordGrid.nativeTieredHeader).toBeDefined()
    }
    const before = structuredClone({ cells, rows, headerRows, unassigned, repairs }),
      changed = reconcileNativeTieredHeader({
        cells,
        rows,
        columnRects: p.columns,
        headerRows,
        pageItems: f.tokens,
        rules: f.rules,
        captions: f.captions,
        unassigned,
        repairs,
        recordGrid
      })
    if (variant === 'complete') {
      expect(changed).toBe(0)
      expect({ cells, rows, headerRows, unassigned, repairs }).toEqual(before)
    } else {
      expect(changed).toBe(1)
      expect(
        cells
          .filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan > 1)
          .map((c: { column: number; colSpan: number }) => [c.column, c.colSpan])
      ).toEqual([
        [2, 2],
        [6, 2]
      ])
    }
  }
)

it.each([false, true])(
  'proves taller physical tiers and a whole stub crossing only the initial model cut: %s',
  (fourLeaves) => {
    const f = crossedWholeStubTiers(fourLeaves),
      before = structuredClone(f),
      p = recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)
    expect(p?.rows).toHaveLength(6)
    expect(p?.columns).toHaveLength(fourLeaves ? 9 : 5)
    expect(p?.columns[0][2]).toBe(61.5)
    expect(p?.spans).toEqual([
      { row: 0, column: 0, rowSpan: 2, colSpan: 1 },
      { row: 0, column: 1, rowSpan: 1, colSpan: fourLeaves ? 4 : 2 },
      { row: 0, column: fourLeaves ? 5 : 3, rowSpan: 1, colSpan: fourLeaves ? 4 : 2 }
    ])
    expect(p?.ownedTokens.size).toBe(f.tokens.length - 1)
    expect(f).toEqual(before)
    const r = refineTable(
      f.table,
      f.tokens,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      undefined,
      f.context
    )
    expect(r.grid.slice(2)).toEqual(
      [0, 1, 2, 3].map((n) => [
        `Item ${n + 1}`,
        ...Array.from({ length: fourLeaves ? 8 : 4 }, (_, c) => String(12 + n + c))
      ])
    )
    expect(
      r.cells
        .filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan > 1)
        .map((c: { column: number; colSpan: number }) => [c.column, c.colSpan])
    ).toEqual(
      fourLeaves
        ? [
            [1, 4],
            [5, 4]
          ]
        : [
            [1, 2],
            [3, 2]
          ]
    )
    expect(r.unassigned).toEqual([])
    for (const i of before.tokens.slice(1)) {
      const owners = r.cells.filter((c: ReturnType<typeof JSON.parse>) =>
        c.sourceItems.some((s: { index: number }) => s.index === i.sourceItem.index)
      )
      expect(owners).toHaveLength(1)
      expect(owners[0].sourceRects).toContainEqual(i.rect)
      expect(owners[0].sourceItems).toContainEqual(i.sourceItem)
    }
  }
)

it.each([
  'missing source gutter',
  'small source gutter',
  'tied model center',
  'changed model owner',
  'large opening margin',
  'large divider margin',
  'upper ink crosses opening',
  'lower baseline crosses divider',
  'extra header tier',
  'missing body record'
])('refuses a crossed whole stub without complete physical qualification: %s', (variant) => {
  const f = crossedWholeStubTiers(),
    stub = f.tokens.find((i: { text: string }) => i.text === 'Item 4')
  if (variant === 'missing source gutter') stub.rect[2] = 66
  if (variant === 'small source gutter') stub.rect[2] = 61
  if (variant === 'tied model center') stub.rect[0] = 42
  if (variant === 'changed model owner') stub.rect[0] = 54
  if (variant === 'large opening margin') {
    for (const i of f.tokens.slice(1)) {
      i.baseline += 15
      i.rect[1] += 15
      i.rect[3] += 15
    }
    for (const rule of f.rules.slice(1)) rule[1] = rule[3] += 15
    f.table.cropRect[3] += 15
  }
  if (variant === 'large divider margin') f.rules[1][1] = f.rules[1][3] = 58.5
  if (variant === 'upper ink crosses opening') {
    for (const i of f.tokens.filter(
      (i: { baseline: number }) => i.baseline === 34 || i.baseline === 46.5
    )) {
      i.baseline -= 6
      i.rect[1] -= 6
      i.rect[3] -= 6
    }
    f.rules[1][1] = f.rules[1][3] = 46
  }
  if (variant === 'lower baseline crosses divider') {
    for (const i of f.tokens.filter((i: { baseline: number }) => i.baseline === 46.5)) {
      i.baseline += 6.5
      i.rect[1] += 6.5
      i.rect[3] += 6.5
    }
  }
  if (variant === 'extra header tier') {
    const leaf = f.tokens.find((i: { text: string }) => i.text === 'Leaf 2')
    leaf.baseline += 4
    leaf.rect[1] += 4
    leaf.rect[3] += 4
  }
  if (variant === 'missing body record')
    f.tokens = f.tokens.filter((i: { baseline: number }) => i.baseline !== 100)
  for (const i of f.tokens) {
    const raw = f.context.sourceContent.items[i.sourceItem.index]
    raw.width = i.rect[2] - i.rect[0]
    raw.transform[4] = i.rect[0]
    raw.transform[5] = 200 - i.baseline
  }
  const before = structuredClone(f)
  expect(recoverTwoTier(f.table, f.tokens, f.captions, f.rules, f.context)).toBeUndefined()
  expect(f).toEqual(before)
})
