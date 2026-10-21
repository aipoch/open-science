import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readWorkerResult } from '../src/worker-result.js'
import { readPdfFixture } from './read-fixture'

const { refineTable, recoverCaptionedRuledTables } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const panelRefineHelpers = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { nativeWhitespaceGaps: measureOrdinaryPrograms } = await import(
  pathToFileURL(resolve('resources/literature-pdf-symbol-text.mjs')).href
)
const {
  proveNativeCompleteOrdinaryRecordOwners,
  proveNativeSingleOrdinaryRecordOwners,
  proveNativeFencedMergedRecordOwners,
  proveNativeCalibratedWrappedLeafOwners
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-leaf-record-repair.mjs')).href
)
const { recoverNativeMixedSectionParts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-mixed-section-parts.mjs')).href
)
const { repairWrappedTableRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-row-repair.mjs')).href
)
const examples = readFileSync(resolve('test/fixtures/native-complete-records.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const fixture = (kind: string): ReturnType<typeof JSON.parse> =>
  structuredClone(examples.find((f: ReturnType<typeof JSON.parse>) => f.kind === kind))
const run = (f: ReturnType<typeof fixture>): ReturnType<typeof refineTable> => {
  const table =
    f.table ?? recoverCaptionedRuledTables(f.items, f.rules, f.captions, 1, [], f.runs)[0]
  return table && refineTable(table, f.items, f.captions, [], f.rules, f.runs)
}
const characters = (text: string): string => [...text.replace(/\s/gu, '')].sort().join('')

const lateFencedGroupHelpers = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-leaf-record-repair.mjs')).href
)

// Small synthetic source, including real marked/Tj and opaque rectangular paint
// programs. Tag-child positions intentionally disagree with the native columns.
const taggedHeaderGroupSource = (): ReturnType<typeof JSON.parse> => {
  const viewport = { width: 256, height: 256, transform: [1, 0, 0, -1, 0, 256] },
    content: ReturnType<typeof JSON.parse> = { items: [], styles: { f: { vertical: false } } },
    operators: ReturnType<typeof JSON.parse> = { fnArray: [OPS.dependency], argsArray: [['f']] },
    marked: ReturnType<typeof JSON.parse>[] = [],
    items: ReturnType<typeof JSON.parse>[] = [],
    graphics: ReturnType<typeof JSON.parse>[] = [],
    rules: ReturnType<typeof JSON.parse>[] = [],
    paint = new Map(),
    taggedRows: ReturnType<typeof JSON.parse>[][] = Array.from({ length: 6 }, () => []),
    grid = Array.from({ length: 5 }, () => Array(5).fill('')),
    cells: ReturnType<typeof JSON.parse>[] = [],
    edges = [32, 58, 82, 107, 132, 157, 182]
  let mcid = 0
  const emit = (op: number, args: unknown): void => {
    operators.fnArray.push(op)
    operators.argsArray.push(args)
  }
  const box = (r: number[], clip = false, color = '#000000'): void => {
    if (clip) emit(OPS.eoClip, null)
    else emit(OPS.setFillRGBColor, [color])
    const [left, top, right, bottom] = r,
      p = [
        0,
        left,
        256 - bottom,
        1,
        right,
        256 - bottom,
        1,
        right,
        256 - top,
        1,
        left,
        256 - top,
        4
      ]
    emit(OPS.constructPath, [
      clip ? OPS.endPath : OPS.eoFill,
      [new Float32Array(p)],
      new Float32Array([left, 256 - bottom, right, 256 - top])
    ])
    if (!clip)
      graphics.push({
        kind: 'path',
        rect: r.map((v, k) => (k < 2 ? Math.floor(v) : Math.ceil(v)) + (k < 2 ? 0 : 1))
      })
  }
  box([0, 5, 256, 256], true)
  const draw = (
    text: string,
    x: number,
    baseline: number,
    row?: number,
    role = 'TD',
    size = 10
  ): ReturnType<typeof JSON.parse> => {
    const sourceItem = { pageNumber: 1, index: content.items.length, text },
      raw = {
        str: text,
        dir: 'ltr',
        width: (text.length * size) / 2,
        height: size,
        fontName: 'f',
        transform: [size, 0, 0, size, x, 256 - baseline],
        sourceItem
      },
      font = {
        text,
        sourceItem,
        rect: [x, baseline - size, x + (text.length * size) / 2, baseline],
        baseline,
        height: size,
        horizontal: true,
        fontDescent: 0
      },
      id = mcid++
    content.items.push(raw)
    items.push(font)
    emit(OPS.beginMarkedContentProps, ['Span', id])
    marked.push({ type: 'beginMarkedContentProps', id: `p1_mc${id}`, tag: 'Span' })
    const originalRaw: ReturnType<typeof JSON.parse> = { ...raw }
    delete originalRaw.sourceItem
    marked.push(originalRaw)
    emit(OPS.setFont, ['f', size])
    emit(OPS.beginText, null)
    emit(OPS.setTextMatrix, [new Float32Array([1, 0, 0, 1, x, 256 - baseline])])
    emit(OPS.showText, [
      [...text].map((unicode) => ({
        unicode,
        fontChar: unicode,
        originalCharCode: unicode.codePointAt(0),
        width: 500,
        isInFont: true,
        isSpace: false,
        accent: null
      }))
    ])
    emit(OPS.endText, null)
    emit(OPS.endMarkedContent, null)
    marked.push({ type: 'endMarkedContent' })
    if (row !== undefined)
      taggedRows[row].push({ role, children: [{ type: 'content', id: `p1_mc${id}` }] })
    return font
  }
  draw('T', 5, 14)
  const parents = [
    draw('P', 70, 48, 0, 'TH'),
    draw('Q', 110, 48, 0, 'TH'),
    draw('R', 175, 48, 0, 'TH')
  ]
  const add = (row: number, column: number, fs: ReturnType<typeof JSON.parse>[]): void => {
    const text = fs.map((f) => f.text).join('')
    grid[row][column] = text
    cells.push({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text,
      sourceRects: fs.map((f) => [...f.rect]),
      ...(fs.length ? { sourceItems: fs.map((f) => structuredClone(f.sourceItem)) } : {})
    })
  }
  for (let column = 0; column < 5; column++)
    add(0, column, [draw(String.fromCharCode(65 + column), 30 + column * 40, 75, 1)])
  for (let row = 1; row < 5; row++) {
    if (row === 2) add(row, 0, [draw('G', 35, 116, 2, 'TH')])
    else if (row === 3) add(row, 0, [draw('H', 35, 150, 4, 'TH')])
    else add(row, 0, [])
    if (row === 4)
      taggedRows[5].push(
        { role: 'TH', children: [] },
        { role: 'TD', children: [] },
        { role: 'TD', children: [] }
      )
    for (let column = 1; column < 5; column++) {
      if (row === 1 && column === 2) {
        const base = draw('x', 105, 100, 2),
          script = draw('2', 110, 96, 2, 'TD', 6),
          scriptTag = taggedRows[2].pop()
        taggedRows[2].at(-1).children.push(...scriptTag.children)
        add(row, column, [base, script])
      } else
        add(row, column, [
          draw(`${row}${column}`, 65 + column * 40 - 40, edges[row + 1] + 18, row + 1)
        ])
    }
  }
  for (const y of [32, 82, 132, 182]) {
    const segments =
      y === 32
        ? [
            [20.5, 59.5],
            [60.5, 99.5],
            [100.5, 139.5],
            [140.5, 219.5]
          ]
        : Array.from({ length: 5 }, (_, c) => [20.5 + c * 40, 59.5 + c * 40])
    for (const [left, right] of segments) {
      rules.push([left, y, right, y])
      box([left, y - 0.125, right, y + 0.125])
      paint.set(rules.at(-1), [left, y - 0.125, right, y + 0.125])
    }
  }
  for (const y of [107, 157])
    for (let c = 1; c < 5; c++) {
      rules.push([20.5 + c * 40, y, 59.5 + c * 40, y])
      box([20.5 + c * 40, y - 0.125, 59.5 + c * 40, y + 0.125])
      paint.set(rules.at(-1), [20.5 + c * 40, y - 0.125, 59.5 + c * 40, y + 0.125])
    }
  const table = {
    page: 1,
    cropRect: [20, 30, 220, 185],
    grid,
    cells,
    unassigned: parents.map((f) => f.text),
    caption: { text: 'Values', rect: [20, 190, 100, 200] },
    notes: [],
    issues: ['unassigned-source-text', 'existing-diagnostic'],
    repairs: ['existing-repair'],
    sourceViewport: viewport,
    rows: grid.map((_, n) => ({ rect: [20, edges[n + 1], 220, edges[n + 2]] }))
  }
  cells.find((c) => c.row === 1 && c.column === 2).textRuns = [
    { text: 'x', position: 'normal' },
    { text: '2', position: 'superscript' }
  ]
  const glyphPaths = [...new Set(items.flatMap((f) => [...f.text]))].map((char) => ({
    id: `f_path_${char}`,
    path: [0, 0, 0, 1, 0.45, 0, 1, 0.45, 0.8, 1, 0, 0.8, 4]
  }))
  return {
    table,
    items,
    rules,
    context: {
      content,
      sourceContent: content,
      operators,
      viewport,
      nativeEvidenceGraphics: graphics,
      rulePaintBounds: paint,
      nativeMarkedSource: {
        structureTree: {
          role: 'Root',
          children: [
            { role: 'Table', children: taggedRows.map((children) => ({ role: 'TR', children })) }
          ]
        },
        markedContent: { items: marked, styles: content.styles },
        fonts: [
          { id: 'f', missingFile: false, isType3Font: false, vertical: false, remeasure: false }
        ],
        glyphPaths
      }
    }
  }
}

it('restores tagged header groups through complete native visible ownership', () => {
  const f = taggedHeaderGroupSource(),
    before = structuredClone(f.table),
    result =
      lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
        f.table,
        f.items,
        f.rules,
        f.context
      ) ?? f.table
  expect(result.grid).toHaveLength(6)
  expect(
    result.cells
      .filter((c: ReturnType<typeof JSON.parse>) => c.row === 0)
      .map((c: ReturnType<typeof JSON.parse>) => [c.column, c.colSpan, c.text])
  ).toEqual([
    [1, 1, 'P'],
    [2, 1, 'Q'],
    [3, 2, 'R']
  ])
  expect(
    result.cells
      .filter((c: ReturnType<typeof JSON.parse>) => ['G', 'H'].includes(c.text))
      .map((c: ReturnType<typeof JSON.parse>) => [c.row, c.column, c.rowSpan])
  ).toEqual([
    [2, 0, 2],
    [4, 0, 2]
  ])
  expect(result.unassigned).toEqual([])
  expect(f.table).toEqual(before)
  for (const cell of before.cells) {
    if (!cell.text && cell.column === 0) continue
    const expected = {
      ...cell,
      row: cell.text === 'G' ? 2 : cell.row + 1,
      ...(cell.text === 'G' || cell.text === 'H' ? { rowSpan: 2 } : {})
    }
    expect(
      result.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === expected.row && c.column === expected.column
      )
    ).toEqual(expected)
  }
  for (const field of ['cropRect', 'caption', 'notes']) expect(result[field]).toEqual(before[field])
  expect(result.issues).toEqual(['existing-diagnostic'])
  expect(result.repairs).toEqual([...before.repairs, 'native-tagged-header-group-owners-recovered'])
})

it('rejects tagged parent ink that crosses into a different native parent domain', () => {
  const f = taggedHeaderGroupSource(),
    before = structuredClone(f.table),
    outline = f.context.nativeMarkedSource.glyphPaths.find(
      (p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_P'
    )
  // Raw metrics and the tag still place P in column 1, but its actual glyph
  // paints inside the separate, two-column R parent domain.
  outline.path = [0, 10, 0, 1, 10.45, 0, 1, 10.45, 0.8, 1, 10, 0.8, 4]
  expect(
    lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      f.table,
      f.items,
      f.rules,
      f.context
    )
  ).toBeUndefined()
  expect(f.table).toEqual(before)
})

it('preserves tagged parent ink overhang within its complete native parent domain', () => {
  const f = taggedHeaderGroupSource(),
    reference = lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      f.table,
      f.items,
      f.rules,
      f.context
    ),
    before = structuredClone(f.table),
    outline = f.context.nativeMarkedSource.glyphPaths.find(
      (p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_P'
    )
  // Ink extends beyond both metric edges while staying within P's native fence.
  outline.path = [0, -0.2, 0, 1, 0.7, 0, 1, 0.7, 0.8, 1, -0.2, 0.8, 4]
  // R spans two leaf columns: its valid ink can cross their internal gutter.
  f.context.nativeMarkedSource.glyphPaths.find(
    (p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_R'
  ).path = [0, -0.7, 0, 1, 0.7, 0, 1, 0.7, 0.8, 1, -0.7, 0.8, 4]
  expect(reference).toBeDefined()
  expect(
    lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      f.table,
      f.items,
      f.rules,
      f.context
    )
  ).toEqual(reference)
  expect(f.table).toEqual(before)
})

it.each([
  [
    'rejects tagged fences hidden on an earlier same-fill background',
    false,
    [20, 30, 220, 35],
    [19, 29, 221, 36]
  ],
  [
    'preserves tagged fences after a complete opaque background repaint',
    true,
    [20, 30, 220, 35],
    [19, 29, 221, 36]
  ],
  [
    'rejects tagged parent ink hidden on an earlier same-fill background',
    false,
    [69, 39, 76, 49],
    [68, 38, 77, 50]
  ],
  [
    'preserves tagged parent ink after a complete opaque background repaint',
    true,
    [69, 39, 76, 49],
    [68, 38, 77, 50]
  ]
] as const)('%s', (_name, restoreContrast, blackBackground, whiteRepaint) => {
  const f = taggedHeaderGroupSource(),
    reference = lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      f.table,
      f.items,
      f.rules,
      f.context
    ),
    before = structuredClone(f.table),
    prefix: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [], graphics: [] }
  for (const [rect, color] of [
    [[...blackBackground], '#000000'],
    ...(restoreContrast ? [[[...whiteRepaint], '#ffffff']] : [])
  ] as [number[], string][]) {
    const [left, top, right, bottom] = rect
    prefix.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
    prefix.argsArray.push(
      [color],
      [
        OPS.eoFill,
        [
          new Float32Array([
            0,
            left,
            256 - bottom,
            1,
            right,
            256 - bottom,
            1,
            right,
            256 - top,
            1,
            left,
            256 - top,
            4
          ])
        ],
        new Float32Array([left, 256 - bottom, right, 256 - top])
      ]
    )
    prefix.graphics.push({
      kind: 'path',
      rect: rect.map((v, k) => (k < 2 ? Math.floor(v) : Math.ceil(v)) + (k < 2 ? 0 : 1))
    })
  }
  prefix.fnArray.push(OPS.setFillRGBColor)
  prefix.argsArray.push(['#000000'])
  // Both backgrounds are painted after the native clip but before source text
  // and fences. The positive repaints the complete strip and its surrounding gap.
  f.context.operators.fnArray.splice(3, 0, ...prefix.fnArray)
  f.context.operators.argsArray.splice(3, 0, ...prefix.argsArray)
  f.context.nativeEvidenceGraphics.unshift(...prefix.graphics)
  expect(lateRules(f.context.operators, f.context.viewport)).toEqual(f.rules)
  const result = lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
    f.table,
    f.items,
    f.rules,
    f.context
  )
  expect(reference).toBeDefined()
  if (restoreContrast) expect(result).toEqual(reference)
  else expect(result).toBeUndefined()
  expect(f.table).toEqual(before)
})

it('preserves tagged ownership across a native thin black endpoint join', () => {
  const f = taggedHeaderGroupSource(),
    reference = lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      f.table,
      f.items,
      f.rules,
      f.context
    ),
    before = structuredClone(f.table)
  f.context.operators.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
  f.context.operators.argsArray.push(
    ['#000000'],
    [
      OPS.eoFill,
      [
        new Float32Array([
          0, 219.494, 223.875, 1, 219.506, 223.875, 1, 219.506, 224.125, 1, 219.494, 224.125, 4
        ])
      ],
      new Float32Array([219.494, 223.875, 219.506, 224.125])
    ]
  )
  f.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [219, 31, 221, 34] })
  const result = lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
    f.table,
    f.items,
    f.rules,
    f.context
  )
  expect(reference).toBeDefined()
  expect(result).toEqual(reference)
  expect(f.table).toEqual(before)
})

it('preserves tagged ownership when a native outline returns exactly to its start', () => {
  const f = taggedHeaderGroupSource(),
    reference = lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      f.table,
      f.items,
      f.rules,
      f.context
    ),
    outline = f.context.nativeMarkedSource.glyphPaths.find(
      (p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_P'
    )
  outline.path.splice(-1, 1, 1, 0, 0)
  expect(reference).toBeDefined()
  expect(
    lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      f.table,
      f.items,
      f.rules,
      f.context
    )
  ).toEqual(reference)
})

it.each([
  ['retraced line', [0, 0, 0, 1, 0.45, 0.8, 1, 0, 0, 4]],
  [
    'opposite contours',
    [
      0, 0, 0, 1, 0.45, 0, 1, 0.45, 0.8, 1, 0, 0.8, 4, 0, 0, 0, 1, 0, 0.8, 1, 0.45, 0.8, 1, 0.45, 0,
      4
    ]
  ],
  ['retraced quadratic', [0, 0, 0, 3, 0.2, 0.8, 0.45, 0, 3, 0.2, 0.8, 0, 0, 4]],
  ['retraced cubic', [0, 0, 0, 2, 0, 0.8, 0.45, 0.8, 0.45, 0, 2, 0.45, 0.8, 0, 0.8, 0, 0, 4]],
  [
    'disjoint reverse contours with ambiguous total area',
    [
      0, 0, 0, 1, 0.2, 0, 1, 0.2, 0.8, 1, 0, 0.8, 4, 0, 0.25, 0, 1, 0.25, 0.8, 1, 0.45, 0.8, 1,
      0.45, 0, 4
    ]
  ],
  [
    'nearly cancelling contours',
    [
      0,
      0,
      0,
      1,
      0.45,
      0,
      1,
      0.45,
      0.8,
      1,
      0,
      0.8,
      4,
      0,
      0,
      0,
      1,
      0,
      0.8,
      1,
      0.45 + Number.EPSILON,
      0.8,
      1,
      0.45 + Number.EPSILON,
      0,
      4
    ]
  ]
])('refuses tagged filled-ink evidence with %s', (_name, path) => {
  const f = taggedHeaderGroupSource(),
    before = structuredClone(f.table)
  f.context.nativeMarkedSource.glyphPaths.find(
    (p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_P'
  ).path = path
  expect(
    lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners(
      f.table,
      f.items,
      f.rules,
      f.context
    )
  ).toBeUndefined()
  expect(f.table).toEqual(before)
})

it.each([
  ['quadratic', [0, 0, 0, 3, 0.2, 0.8, 0.45, 0, 4]],
  ['cubic', [0, 0, 0, 2, 0, 0.8, 0.45, 0.8, 0.45, 0, 4]]
])('preserves tagged filled-ink evidence for a normal %s outline', (_name, path) => {
  const f = taggedHeaderGroupSource(),
    reference = lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners(
      f.table,
      f.items,
      f.rules,
      f.context
    )
  f.context.nativeMarkedSource.glyphPaths.find(
    (p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_P'
  ).path = path
  expect(reference).toBeDefined()
  expect(
    lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners(
      f.table,
      f.items,
      f.rules,
      f.context
    )
  ).toEqual(reference)
})

it.each([
  ['painted whitespace', true, false, 'P', false, false],
  ['painted isSpace glyph', true, true, 'P', false, false],
  ['painted space fontChar', true, true, ' ', false, false],
  ['missing whitespace outline', true, true, 'Z', false, false],
  ['empty native whitespace path', true, true, ' ', true, false],
  ['native font skips missing glyph', false, false, 'P', false, false],
  ['native whitespace clip outside target', true, false, 'P', false, true]
])(
  'checks tagged whitespace ink for %s',
  (_name, isInFont, isSpace, fontChar, emptyPath, outsideClip) => {
    const f = taggedHeaderGroupSource(),
      before = structuredClone(f.table),
      sourceItem = { pageNumber: 1, index: f.context.content.items.length, text: ' ' },
      raw = {
        str: ' ',
        dir: 'ltr',
        width: 5,
        height: 10,
        fontName: 'f',
        transform: [10, 0, 0, 10, 70, 208],
        sourceItem
      },
      marked: ReturnType<typeof JSON.parse> = { ...raw }
    delete marked.sourceItem
    f.context.content.items.push(raw)
    f.context.nativeMarkedSource.markedContent.items.push(
      { type: 'beginMarkedContentProps', tag: 'Artifact' },
      marked,
      { type: 'endMarkedContent' }
    )
    if (fontChar === ' ')
      f.context.nativeMarkedSource.glyphPaths.push({
        id: 'f_path_ ',
        path: emptyPath ? [] : [0, 0, 0, 1, 0.45, 0, 1, 0.45, 0.8, 1, 0, 0.8, 4]
      })
    if (outsideClip) {
      f.context.operators.fnArray.push(OPS.eoClip, OPS.constructPath)
      f.context.operators.argsArray.push(null, [
        OPS.endPath,
        [new Float32Array([0, 0, 236, 1, 10, 236, 1, 10, 251, 1, 0, 251, 4])],
        new Float32Array([0, 236, 10, 251])
      ])
    }
    f.context.operators.fnArray.push(
      OPS.beginMarkedContentProps,
      OPS.setFillRGBColor,
      OPS.setFont,
      OPS.beginText,
      OPS.setTextMatrix,
      OPS.showText,
      OPS.endText,
      OPS.setFillRGBColor,
      OPS.endMarkedContent
    )
    f.context.operators.argsArray.push(
      ['Artifact', null],
      ['#ffffff'],
      ['f', 10],
      null,
      [new Float32Array([1, 0, 0, 1, 70, 208])],
      [
        [
          {
            unicode: ' ',
            fontChar,
            originalCharCode: 32,
            width: 500,
            isInFont,
            isSpace,
            accent: null
          }
        ]
      ],
      null,
      ['#000000'],
      null
    )
    const result = lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners(
      f.table,
      f.items,
      f.rules,
      f.context
    )
    if (emptyPath || !isInFont || outsideClip) expect(result?.grid).toHaveLength(6)
    else expect(result).toBeUndefined()
    expect(f.table).toEqual(before)
  }
)

it.each([
  ['clip', 1000],
  ['target crop', 16]
])(
  'refuses tagged selected ink outside its %s despite contained nominal metrics',
  (_name, shift) => {
    const f = taggedHeaderGroupSource(),
      before = structuredClone(f.table)
    f.context.nativeMarkedSource.glyphPaths.find(
      (p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_P'
    ).path = [0, shift, 0, 1, +shift + 0.45, 0, 1, +shift + 0.45, 0.8, 1, shift, 0.8, 4]
    expect(
      lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners(
        f.table,
        f.items,
        f.rules,
        f.context
      )
    ).toBeUndefined()
    expect(f.table).toEqual(before)
  }
)

it.each([
  [
    'white header overhang',
    '#ffffff',
    [0, -16.1, -1.9, 1, -15.4, -1.9, 1, -15.4, -0.9, 1, -16.1, -0.9, 4],
    false
  ],
  [
    'black header overhang',
    '#000000',
    [0, -16.1, -1.9, 1, -15.4, -1.9, 1, -15.4, -0.9, 1, -16.1, -0.9, 4],
    false
  ],
  [
    'white supporting-rule overhang',
    '#ffffff',
    [0, -17, -0.3, 1, -13, -0.3, 1, -13, -0.1, 1, -17, -0.1, 4],
    false
  ],
  ['missing late outline', '#ffffff', null, false],
  ['empty late outline', '#ffffff', [], true],
  ['missing late outline outside clip', '#ffffff', null, true, true],
  [
    'zero-area late outline remains potentially painted',
    '#ffffff',
    [
      0, -16.1, -1.9, 1, -15.4, -1.9, 1, -15.4, -0.9, 1, -16.1, -0.9, 4, 0, -16.1, -1.9, 1, -16.1,
      -0.9, 1, -15.4, -0.9, 1, -15.4, -1.9, 4
    ],
    false
  ],
  [
    'ordinary paint outside target',
    '#ffffff',
    [0, 0, 0, 1, 0.45, 0, 1, 0.45, 0.8, 1, 0, 0.8, 4],
    true
  ]
])('checks tagged late ordinary glyph ink for %s', (_name, color, path, accepted, outsideClip) => {
  const f = taggedHeaderGroupSource(),
    before = structuredClone(f.table),
    sourceItem = { pageNumber: 1, index: f.context.content.items.length, text: 'Z' },
    raw = {
      str: 'Z',
      dir: 'ltr',
      width: 5,
      height: 10,
      fontName: 'f',
      transform: [10, 0, 0, 10, 230, 226],
      sourceItem
    },
    marked: ReturnType<typeof JSON.parse> = { ...raw }
  delete marked.sourceItem
  f.context.content.items.push(raw)
  f.items.push({
    text: 'Z',
    sourceItem,
    rect: [230, 20, 235, 30],
    baseline: 30,
    height: 10,
    horizontal: true,
    fontDescent: 0
  })
  f.context.nativeMarkedSource.markedContent.items.push(
    { type: 'beginMarkedContentProps', tag: 'Artifact' },
    marked,
    { type: 'endMarkedContent' }
  )
  if (path) f.context.nativeMarkedSource.glyphPaths.push({ id: 'f_path_Z', path })
  if (outsideClip) {
    f.context.operators.fnArray.push(OPS.eoClip, OPS.constructPath)
    f.context.operators.argsArray.push(null, [
      OPS.endPath,
      [new Float32Array([0, 225, 216, 1, 240, 216, 1, 240, 246, 1, 225, 246, 4])],
      new Float32Array([225, 216, 240, 246])
    ])
  }
  f.context.operators.fnArray.push(
    OPS.beginMarkedContentProps,
    OPS.setFillRGBColor,
    OPS.setFont,
    OPS.beginText,
    OPS.setTextMatrix,
    OPS.showText,
    OPS.endText,
    OPS.setFillRGBColor,
    OPS.endMarkedContent
  )
  f.context.operators.argsArray.push(
    ['Artifact', null],
    [color],
    ['f', 10],
    null,
    [new Float32Array([1, 0, 0, 1, 230, 226])],
    [
      [
        {
          unicode: 'Z',
          fontChar: 'Z',
          originalCharCode: 90,
          width: 500,
          isInFont: true,
          isSpace: false,
          accent: null
        }
      ]
    ],
    null,
    ['#000000'],
    null
  )
  const result = lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners(
    f.table,
    f.items,
    f.rules,
    f.context
  )
  if (accepted) expect(result?.grid).toHaveLength(6)
  else expect(result).toBeUndefined()
  expect(f.table).toEqual(before)
})

it('preserves the bound production reconciliation provider in tagged header groups', () => {
  const f = taggedHeaderGroupSource(),
    fonts = f.items
      .filter(
        (item: ReturnType<typeof JSON.parse>) =>
          item.rect[0] >= 20 && item.rect[2] <= 220 && item.rect[1] >= 30 && item.rect[3] <= 185
      )
      .map((item: ReturnType<typeof JSON.parse>) => {
        const token = { ...item }
        delete token.fontDescent
        return token
      })
  Object.defineProperty(f.table.unassigned, 'reconciliationItems', { value: fonts })
  f.table.captionIssue = undefined
  for (const cell of f.table.cells.filter(
    (c: ReturnType<typeof JSON.parse>) => !c.text && c.column === 0
  )) {
    const row = f.table.rows[cell.row].rect
    cell.rect = [20.5, row[1] + 0.5, 59.5, row[3] - 0.5]
    cell.origin = 'model-grid'
    cell.sourceTokens = []
  }
  const witness = Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems'),
    result = lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      f.table,
      f.items,
      f.rules,
      f.context
    )
  expect(result).toBeDefined()
  expect(result.grid).toHaveLength(6)
  expect(Object.getOwnPropertyDescriptor(result.unassigned, 'reconciliationItems')).toEqual(witness)
  expect(Object.hasOwn(result, 'captionIssue')).toBe(true)
  expect(result.captionIssue).toBeUndefined()
})

it('rejects unbound tagged reconciliation and opaque getters without reading them', () => {
  const f = taggedHeaderGroupSource()
  Object.defineProperty(f.table.unassigned, 'reconciliationItems', {
    value: [structuredClone(f.items[0])]
  })
  expect(
    lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      f.table,
      f.items,
      f.rules,
      f.context
    )
  ).toBeUndefined()
  const opaque = taggedHeaderGroupSource()
  let calls = 0
  Object.defineProperty(opaque.table.cells[0], 'privatePayload', {
    get() {
      calls++
      return 'opaque'
    }
  })
  expect(
    lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      opaque.table,
      opaque.items,
      opaque.rules,
      opaque.context
    )
  ).toBeUndefined()
  expect(calls).toBe(0)
  const provider = taggedHeaderGroupSource(),
    token = provider.items[1],
    sourceItem = token.sourceItem
  Object.defineProperty(provider.table.unassigned, 'reconciliationItems', { value: [{ ...token }] })
  Object.defineProperty(token, 'sourceItem', {
    enumerable: true,
    get() {
      calls++
      return sourceItem
    }
  })
  expect(
    lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      provider.table,
      provider.items,
      provider.rules,
      provider.context
    )
  ).toBeUndefined()
  expect(calls).toBe(0)
})

it.each([
  'missing evidence',
  'missing font',
  'missing file',
  'type3',
  'vertical font',
  'remeasured font',
  'nonfinite outline',
  'clipped outline',
  'missing outline',
  'empty selected outline',
  'open selected outline',
  'move-only selected outline',
  'wrong derived font geometry',
  'duplicate MCID',
  'changed TR',
  'late white paint',
  'mixed white glyph fill',
  'changed quantized geometry',
  'opaque blank',
  'array metadata',
  'wrong native column',
  'missing parent fence',
  'forged fence center',
  'late white fence paint',
  'late black fence cover',
  'unknown model blank origin',
  'model blank token metadata',
  'nonfinite model blank rectangle'
])('refuses tagged header groups with %s', (kind) => {
  const f = taggedHeaderGroupSource(),
    source = f.context.nativeMarkedSource
  if (kind === 'missing evidence') delete f.context.nativeMarkedSource
  if (kind === 'missing font') source.fonts = []
  if (kind === 'missing file') source.fonts[0].missingFile = true
  if (kind === 'type3') source.fonts[0].isType3Font = true
  if (kind === 'vertical font') source.fonts[0].vertical = true
  if (kind === 'remeasured font') source.fonts[0].remeasure = true
  if (kind === 'nonfinite outline')
    source.glyphPaths.find((p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_T').path[1] = NaN
  if (kind === 'clipped outline')
    source.glyphPaths.find((p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_T').path[8] = 1
  if (kind === 'missing outline')
    source.glyphPaths = source.glyphPaths.filter(
      (p: ReturnType<typeof JSON.parse>) => p.id !== 'f_path_T'
    )
  if (kind === 'empty selected outline')
    source.glyphPaths.find((p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_P').path = []
  if (kind === 'open selected outline')
    source.glyphPaths.find((p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_P').path.pop()
  if (kind === 'move-only selected outline')
    source.glyphPaths.find((p: ReturnType<typeof JSON.parse>) => p.id === 'f_path_P').path = [
      0, 0, 0
    ]
  if (kind === 'wrong derived font geometry')
    [f.items[1].rect, f.items[2].rect] = [f.items[2].rect, f.items[1].rect]
  if (
    kind.startsWith('unknown model blank') ||
    kind.startsWith('model blank') ||
    kind.startsWith('nonfinite model blank')
  ) {
    const cell = f.table.cells.find(
        (c: ReturnType<typeof JSON.parse>) => !c.text && c.column === 0
      ),
      row = f.table.rows[cell.row].rect
    cell.rect = [20.5, row[1] + 0.5, 59.5, row[3] - 0.5]
    cell.origin = 'model-grid'
    cell.sourceTokens = []
    if (kind === 'unknown model blank origin') cell.origin = 'foreign'
    if (kind === 'model blank token metadata') cell.sourceTokens.privatePayload = 'opaque'
    if (kind === 'nonfinite model blank rectangle') cell.rect[0] = NaN
  }
  const rows = source.structureTree.children[0].children
  if (kind === 'duplicate MCID')
    rows[0].children[1].children[0].id = rows[0].children[0].children[0].id
  if (kind === 'changed TR') [rows[2], rows[3]] = [rows[3], rows[2]]
  if (kind === 'late white paint') {
    f.context.operators.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
    f.context.operators.argsArray.push(
      ['#ffffff'],
      [
        OPS.eoFill,
        [new Float32Array([0, 20, 121, 1, 220, 121, 1, 220, 176, 1, 20, 176, 4])],
        new Float32Array([20, 121, 220, 176])
      ]
    )
    f.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [20, 80, 221, 136] })
  }
  if (kind === 'mixed white glyph fill') {
    const font = f.items[1],
      raw = f.context.content.items[1],
      marked = source.markedContent.items.find(
        (item: ReturnType<typeof JSON.parse>) => item.str === 'P'
      ),
      operators = f.context.operators,
      index = operators.fnArray.findIndex(
        (code: number, n: number) =>
          code === OPS.showText && operators.argsArray[n][0][0].unicode === 'P'
      ),
      glyph = operators.argsArray[index][0][0]
    font.text = font.sourceItem.text = raw.str = marked.str = 'PP'
    font.rect[2] += 5
    raw.width = marked.width = 10
    f.table.unassigned[0] = 'PP'
    operators.fnArray.splice(
      index,
      1,
      OPS.showText,
      OPS.setFillRGBColor,
      OPS.showText,
      OPS.setFillRGBColor
    )
    operators.argsArray.splice(index, 1, [[glyph]], ['#ffffff'], [[{ ...glyph }]], ['#000000'])
  }
  if (kind === 'changed quantized geometry') f.context.nativeEvidenceGraphics[0].rect[0] += 4
  if (kind === 'forged fence center') {
    const rule = f.rules.find((r: number[]) => r[1] === 132 && r[0] > 60 && r[0] < 100)
    rule[1] += 0.5
    rule[3] += 0.5
  }
  if (kind === 'late white fence paint' || kind === 'late black fence cover') {
    f.context.operators.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
    f.context.operators.argsArray.push(
      [kind === 'late white fence paint' ? '#ffffff' : '#000000'],
      [
        OPS.eoFill,
        [new Float32Array([0, 59, 122, 1, 101, 122, 1, 101, 126, 1, 59, 126, 4])],
        new Float32Array([59, 122, 101, 126])
      ]
    )
    f.context.nativeEvidenceGraphics.push({ kind: 'path', rect: [59, 130, 102, 135] })
  }
  if (kind === 'opaque blank')
    f.table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 0
    ).privatePayload = { keep: true }
  if (kind === 'array metadata') f.table.grid.privatePayload = true
  if (kind === 'wrong native column') {
    const left = f.table.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === 4 && c.column === 1
      ),
      right = f.table.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === 4 && c.column === 3
      )
    ;[left.column, right.column] = [right.column, left.column]
    ;[f.table.grid[4][1], f.table.grid[4][3]] = [f.table.grid[4][3], f.table.grid[4][1]]
  }
  if (kind === 'missing parent fence') {
    const removed = f.rules.find((r: number[]) => r[1] === 32 && r[0] > 140)
    f.context.rulePaintBounds.delete(removed)
    f.rules = f.rules.filter((r: number[]) => r !== removed)
    const index = f.context.operators.fnArray.findIndex(
      (op: number, n: number) =>
        op === OPS.constructPath &&
        f.context.operators.argsArray[n][2][0] === 140.5 &&
        f.context.operators.argsArray[n][2][3] === 224.125
    )
    expect(index).toBeGreaterThan(0)
    f.context.operators.fnArray.splice(index, 1)
    f.context.operators.argsArray.splice(index, 1)
    f.context.nativeEvidenceGraphics = f.context.nativeEvidenceGraphics.filter(
      (g: ReturnType<typeof JSON.parse>) => !(g.rect[0] === 140 && g.rect[1] === 31)
    )
  }
  const before = structuredClone(f.table)
  expect(
    lateFencedGroupHelpers.recoverNativeTaggedHeaderGroupOwners?.(
      f.table,
      f.items,
      f.rules,
      f.context
    )
  ).toBeUndefined()
  expect(f.table).toEqual(before)
})

// Full native sections include two missing scalar pairs and one displaced peer.
// Ordinary printed order, rather than the model's blank band, establishes rows.
const residualSectionedRecords = (): ReturnType<typeof JSON.parse> => {
  const viewport = {
      width: 250,
      height: 250,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 250]
    },
    content: ReturnType<typeof JSON.parse> = { items: [], styles: { f: { vertical: false } } },
    operators: ReturnType<typeof JSON.parse> = {
      fnArray: [OPS.dependency, OPS.setLineWidth],
      argsArray: [['f'], [0.5]]
    },
    items: ReturnType<typeof JSON.parse>[] = [],
    grid = Array.from({ length: 10 }, () => ['', '']),
    cells: ReturnType<typeof JSON.parse>[] = [],
    fences = [20, 40, 60, 120, 140, 225]
  const draw = (text: string, x: number, baseline: number): ReturnType<typeof JSON.parse> => {
    const sourceItem = { pageNumber: 1, index: content.items.length, text },
      f = {
        text,
        rect: [x, baseline - 10, x + text.length * 5, baseline],
        baseline,
        height: 10,
        horizontal: true,
        sourceItem
      }
    items.push(f)
    content.items.push({
      str: text,
      width: text.length * 5,
      height: 10,
      fontName: 'f',
      transform: [10, 0, 0, 10, x, 250 - baseline],
      sourceItem
    })
    operators.fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      ['f', 10],
      null,
      [new Float32Array([1, 0, 0, 1, x, 250 - baseline])],
      [
        [...text].map((unicode) => ({
          unicode,
          fontChar: unicode,
          originalCharCode: unicode.codePointAt(0),
          width: 500,
          isInFont: true,
          accent: null,
          operatorListId: null,
          isSpace: unicode === ' '
        }))
      ],
      null
    )
    return f
  }
  const caption = draw('Table 1: Values.', 10, 12),
    captions = [{ page: 1, rect: caption.rect, lines: [caption.text] }]
  const add = (row: number, column: number, fs: ReturnType<typeof JSON.parse>[]): void => {
    grid[row][column] = fs.map((f) => f.text).join(' ')
    cells.push({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: grid[row][column],
      sourceRects: fs.map((f) => f.rect),
      ...(fs.length ? { sourceItems: fs.map((f) => f.sourceItem) } : {})
    })
  }
  for (const [row, text, baseline] of [
    [0, 'Field', 35],
    [1, 'Alpha', 55],
    [5, 'Beta', 135]
  ] as const) {
    add(row, 0, [draw(text, 15, baseline)])
    add(row, 1, row ? [] : [draw('Value', 160, baseline)])
  }
  const residual: ReturnType<typeof JSON.parse>[] = []
  for (const [row, text, value, baseline, missing] of [
    [2, 'First', '11', 75, false],
    [3, 'Missing', '12', 95, true],
    [4, 'Last', '13', 115, false],
    [6, 'Begin', '21', 155, false],
    [7, 'Absent', '22', 175, true],
    [8, 'Moved', '23', 195, false],
    [9, 'End', '24', 215, false]
  ] as const) {
    const pair = [draw(text, 15, baseline), draw(value, 160, baseline)]
    if (missing) residual.push(...pair)
    else for (let col = 0; col < 2; col++) add(row === 8 ? 7 : row, col, [pair[col]])
  }
  for (const row of [3, 8]) for (let col = 0; col < 2; col++) add(row, col, [])
  cells.sort((a, b) => a.row - b.row || a.column - b.column)
  for (const y of fences) {
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 10, 250 - y, 1, 220, 250 - y])],
      new Float32Array([10, 250 - y, 220, 250 - y])
    ])
  }
  const rules = fences.map((y) => [10, y, 220, y]),
    paint = new Map(rules.map((r) => [r.join(','), [r[0], r[1] - 0.25, r[2], r[3] + 0.25]])),
    graphics = rules.map((r) => ({
      kind: 'path',
      rect: [r[0] - 0.25, r[1] - 0.25, r[2] + 0.25, r[3] + 0.25].map(
        (v, k) =>
          ((k < 2 ? Math.floor((v / 250) * 256) : Math.ceil((v / 250) * 256) + 1) * 250) / 256
      )
    })),
    table = {
      page: 1,
      grid,
      cells,
      cropRect: [9, 19, 221, 226],
      caption: captions[0],
      sourceViewport: { width: 250, height: 250, scale: 1 },
      unassigned: residual.map((f) => f.text),
      clipped: [],
      notes: [],
      issues: ['unassigned-source-text', 'span-conflicts-with-source-columns'],
      repairs: []
    },
    context = {
      viewport,
      content,
      operators,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: graphics
    }
  return { table, items, rules, captions, context }
}
const residualSectionedOutput = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativeSectionedOrdinaryRecordOwners(
    f.table,
    f.items,
    f.captions,
    f.rules,
    f.context
  )

it('recovers only complete residual section pairs and preserves the displaced ordinary donor', () => {
  const f = residualSectionedRecords(),
    before = structuredClone(f.table),
    donor = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.text === 'Moved')
  donor.opaque = { diagnostic: ['keep'] }
  donor.textRuns = [{ text: donor.text, position: 'normal', bold: true }]
  const result = residualSectionedOutput(f)
  expect(result).toBeDefined()
  expect(result.grid[3]).toEqual(['Missing', '12'])
  expect(result.grid[7]).toEqual(['Absent', '22'])
  expect(result.grid[8]).toEqual(['Moved', '23'])
  expect(result.cells.find((c: ReturnType<typeof JSON.parse>) => c.text === 'Moved')).toEqual({
    ...donor,
    row: 8
  })
  expect(
    result.cells.filter((c: ReturnType<typeof JSON.parse>) => ![3, 7, 8].includes(c.row))
  ).toEqual(before.cells.filter((c: ReturnType<typeof JSON.parse>) => ![3, 7, 8].includes(c.row)))
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual(['span-conflicts-with-source-columns'])
  expect(result.cropRect).toBe(f.table.cropRect)
  expect(
    lateFencedGroupHelpers.nativeWholeOwnerRepairPacket(f.table, f.items, f.rules, f.context)
  ).toBeUndefined()
  expect(f.table.grid).toEqual(before.grid)
})

it('preserves a uniquely owned clipped carrier outside the residual sections', () => {
  const f = residualSectionedRecords(),
    header = f.table.cells[0],
    original = { text: header.text, rect: header.sourceRects[0] }
  f.table.clipped.push(original)
  const result = residualSectionedOutput(f)
  expect(result).toBeDefined()
  expect(result.clipped).toBe(f.table.clipped)
  expect(result.clipped[0]).toBe(original)
  expect(result.cells[0]).toBe(header)
})

const internalResidualSectionedRecords = (
  ordinaryProvider = false
): ReturnType<typeof JSON.parse> => {
  const f = residualSectionedRecords()
  f.context.content.styles.f.descent = -0.2
  for (const item of f.items) item.fontDescent = -0.2
  for (const c of f.table.cells)
    c.sourceTokens = (c.sourceItems ?? []).map((o: ReturnType<typeof JSON.parse>) =>
      f.items.find((item: ReturnType<typeof JSON.parse>) => item.sourceItem.index === o.index)
    )
  const first = f.table.cells[0],
    second = f.table.cells[1]
  first.colSpan = 2
  first.text = `${first.text} ${second.text}`
  first.sourceItems.push(...second.sourceItems)
  first.sourceRects.push(...second.sourceRects)
  first.sourceTokens.push(...second.sourceTokens)
  first.sourceTokens.reverse()
  f.table.cells.splice(1, 1)
  f.table.grid[0] = [first.text, '']
  Object.defineProperty(f.table.unassigned, 'reconciliationItems', {
    value: f.items
      .filter((item: ReturnType<typeof JSON.parse>) => item !== f.items[0])
      .map((item: ReturnType<typeof JSON.parse>) => {
        if (!ordinaryProvider) return item
        const original = { ...item }
        delete original.fontDescent
        return original
      }),
    writable: false,
    configurable: false,
    enumerable: false
  })
  return f
}

it('preserves the ordinary production reconciliation provider with full metric source proof', () => {
  const f = internalResidualSectionedRecords(true),
    witness = Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems'),
    result = residualSectionedOutput(f)
  expect(result).toBeDefined()
  expect(result.grid[3]).toEqual(['Missing', '12'])
  expect(result.grid[7]).toEqual(['Absent', '22'])
  expect(Object.getOwnPropertyDescriptor(result.unassigned, 'reconciliationItems')).toEqual(witness)
})

it.each([
  'missing-baseline',
  'unknown-field',
  'wrong-metric',
  'wrong-origin',
  'wrong-literal',
  'wrong-rect',
  'wrong-order'
])('refuses incomplete ordinary reconciliation provider: %s', (kind) => {
  const f = internalResidualSectionedRecords(true),
    witness = Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems')!.value
  if (kind === 'missing-baseline') delete witness[0].baseline
  if (kind === 'unknown-field') witness[0].diagnostic = 1
  if (kind === 'wrong-metric') witness[0].fontDescent = -0.4
  if (kind === 'wrong-origin') witness[0].sourceItem = { ...witness[0].sourceItem, index: 999 }
  if (kind === 'wrong-literal') witness[0].text = 'Foreign'
  if (kind === 'wrong-rect') witness[0].rect = [1, 2, 3, 4]
  if (kind === 'wrong-order') witness.reverse()
  expect(residualSectionedOutput(f)).toBeUndefined()
})

it.each([false, true])(
  'retains complete internal source arrays with independent order (tokens only: %s)',
  (tokensOnly) => {
    const f = internalResidualSectionedRecords(),
      header = f.table.cells[0],
      witness = Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems')
    if (tokensOnly) for (const c of f.table.cells) delete c.sourceItems
    const result = residualSectionedOutput(f)
    expect(result).toBeDefined()
    expect(result.cells[0]).toBe(header)
    expect(result.cells[0].sourceTokens).toBe(header.sourceTokens)
    expect(Object.getOwnPropertyDescriptor(result.unassigned, 'reconciliationItems')).toEqual(
      witness
    )
    expect(result.grid[3]).toEqual(['Missing', '12'])
    expect(result.grid[7]).toEqual(['Absent', '22'])
    expect(result.grid[8]).toEqual(['Moved', '23'])
  }
)

it.each([
  'duplicate-token',
  'missing-token',
  'foreign-token',
  'origin-conflict',
  'glyph-conflict',
  'rect-conflict',
  'witness-missing'
])('refuses incomplete independent internal source arrays: %s', (kind) => {
  const f = internalResidualSectionedRecords(),
    header = f.table.cells[0]
  header.sourceTokens = header.sourceTokens.map((item: ReturnType<typeof JSON.parse>) =>
    structuredClone(item)
  )
  if (kind === 'duplicate-token') header.sourceTokens[1] = header.sourceTokens[0]
  if (kind === 'missing-token') header.sourceTokens.pop()
  if (kind === 'foreign-token') header.sourceTokens[0] = f.items[0]
  if (kind === 'origin-conflict') header.sourceTokens[0].sourceItem.index += 1
  if (kind === 'glyph-conflict') header.sourceTokens[0].text = 'Other'
  if (kind === 'rect-conflict') header.sourceTokens[0].rect[0] += 1
  if (kind === 'witness-missing')
    Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems')!.value.pop()
  expect(residualSectionedOutput(f)).toBeUndefined()
})

it.each([
  'duplicate-origin',
  'missing-source',
  'literal-conflict',
  'rich-conflict',
  'blank-opaque',
  'blank-array-opaque',
  'hidden-payload',
  'ambiguous-row',
  'crossing-column',
  'missing-rule',
  'clip',
  'extra-residual',
  'reordered-source',
  'clipped-target',
  'clipped-unknown',
  'internal-rule',
  'sparse-grid',
  'sparse-source',
  'null-cell',
  'malformed-source-array'
])('refuses incomplete residual section ownership: %s', (kind) => {
  const f = residualSectionedRecords(),
    donor = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.text === 'Moved'),
    blank = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 8 && c.column === 0)
  if (kind === 'duplicate-origin') donor.sourceItems[0] = f.table.cells[0].sourceItems[0]
  if (kind === 'missing-source') delete donor.sourceItems
  if (kind === 'literal-conflict') {
    donor.text = 'Changed'
    f.table.grid[7][0] = donor.text
  }
  if (kind === 'rich-conflict') donor.textRuns = [{ text: 'Moved', position: 'superscript' }]
  if (kind === 'blank-opaque') blank.diagnostic = { keep: 1 }
  if (kind === 'blank-array-opaque') blank.sourceRects.diagnostic = 1
  if (kind === 'hidden-payload') Object.defineProperty(donor, 'hidden', { value: 1 })
  if (kind === 'ambiguous-row')
    f.items.find((i: ReturnType<typeof JSON.parse>) => i.text === 'Absent').baseline = 195
  if (kind === 'crossing-column')
    f.items.find((i: ReturnType<typeof JSON.parse>) => i.text === 'Absent').rect[2] = 170
  if (kind === 'missing-rule') f.rules.splice(2, 1)
  if (kind === 'clip') {
    f.context.operators.fnArray.push(OPS.clip)
    f.context.operators.argsArray.push(null)
  }
  if (kind === 'extra-residual') f.table.unassigned.push('Unknown')
  if (kind === 'reordered-source') donor.sourceItems[0].index = donor.sourceItems[0].index + 1
  if (kind === 'clipped-target')
    f.table.clipped.push({ text: donor.text, rect: donor.sourceRects[0] })
  if (kind === 'clipped-unknown')
    f.table.clipped.push({ text: 'Unknown', rect: donor.sourceRects[0] })
  if (kind === 'internal-rule') f.rules.push([20, 85, 200, 85])
  if (kind === 'sparse-grid') delete f.table.grid[3][0]
  if (kind === 'sparse-source') delete donor.sourceItems[0]
  if (kind === 'null-cell') f.table.cells[0] = null
  if (kind === 'malformed-source-array') donor.sourceTokens = false
  expect(residualSectionedOutput(f)).toBeUndefined()
})

// Two complete native groups contain three independent scalar records each.
// The first centered multiline stub starts one row late; the second is correct.
const centeredMultilineOwners = (): ReturnType<typeof JSON.parse> => {
  const viewport = {
      width: 250,
      height: 220,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 220]
    },
    content: ReturnType<typeof JSON.parse> = { items: [], styles: { f: { vertical: false } } },
    operators: ReturnType<typeof JSON.parse> = {
      fnArray: [OPS.dependency, OPS.setLineWidth],
      argsArray: [['f'], [0.5]]
    },
    items: ReturnType<typeof JSON.parse>[] = [],
    cells: ReturnType<typeof JSON.parse>[] = [],
    grid = Array.from({ length: 7 }, () => Array(3).fill('')),
    cuts = [10, 80, 140, 220],
    fences = [20, 40, 115, 190]
  const draw = (text: string, x: number, baseline: number): ReturnType<typeof JSON.parse> => {
    const sourceItem = { pageNumber: 1, index: content.items.length, text },
      f = {
        text,
        rect: [x, baseline - 10, x + text.length * 5, baseline],
        baseline,
        height: 10,
        horizontal: true,
        sourceItem
      }
    items.push(f)
    content.items.push({
      str: text,
      width: text.length * 5,
      height: 10,
      fontName: 'f',
      transform: [10, 0, 0, 10, x, 220 - baseline],
      sourceItem
    })
    operators.fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      ['f', 10],
      null,
      [new Float32Array([1, 0, 0, 1, x, 220 - baseline])],
      [
        [...text].map((unicode) => ({
          unicode,
          fontChar: unicode,
          originalCharCode: unicode.codePointAt(0),
          width: 500,
          isInFont: true,
          accent: null,
          operatorListId: null,
          isSpace: unicode === ' '
        }))
      ],
      null
    )
    return f
  }
  const captionFont = draw('Table 1: Values.', 10, 12),
    captions = [{ page: 1, rect: captionFont.rect, lines: [captionFont.text] }]
  const add = (
    row: number,
    column: number,
    fonts: ReturnType<typeof JSON.parse>[],
    rowSpan = 1
  ): void => {
    const text = fonts.map((f) => f.text).join(' ')
    grid[row][column] = text
    cells.push({
      row,
      column,
      rowSpan,
      colSpan: 1,
      rect: [
        cuts[column],
        row ? [45, 65, 85, 120, 145, 165][row - 1] : 20,
        cuts[column + 1],
        row ? [64, 84, 110, 144, 164, 185][row + rowSpan - 2] : 40
      ],
      text,
      sourceTokens: fonts,
      sourceRects: fonts.map((f) => f.rect),
      sourceItems: fonts.map((f) => f.sourceItem),
      origin: 'model-grid'
    })
  }
  for (let c = 0; c < 3; c++) {
    const font = draw(['Group', 'N', 'Value'][c], cuts[c] + 5, 35)
    add(0, c, [{ ...font, sourceToken: font }])
  }
  for (let g = 0; g < 2; g++) {
    const groupFonts = [
      draw(['Alpha', 'Beta'][g], 20, 77 + g * 75),
      draw('family', 20, 89 + g * 75)
    ]
    if (!g) add(1, 0, [])
    add(g ? 4 : 2, 0, groupFonts, g ? 3 : 2)
    for (let r = 0; r < 3; r++)
      for (let c = 1; c < 3; c++)
        add(1 + g * 3 + r, c, [
          draw(String(c === 1 ? r + 1 : 20 + g * 3 + r), cuts[c] + 5, 60 + g * 75 + r * 20)
        ])
  }
  const rules = fences.map((y) => [10, y, 220, y]),
    paint = new Map(rules.map((r) => [r.join(','), [r[0], r[1] - 0.25, r[2], r[3] + 0.25]]))
  for (const y of fences) {
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 10, 220 - y, 1, 220, 220 - y])],
      new Float32Array([10, 220 - y, 220, 220 - y])
    ])
  }
  const graphics = rules.map((r) => ({
      kind: 'path',
      rect: [r[0] - 0.25, r[1] - 0.25, r[2] + 0.25, r[3] + 0.25].map(
        (v, k) =>
          ((k < 2
            ? Math.floor((v / (k % 2 ? 220 : 250)) * 256)
            : Math.ceil((v / (k % 2 ? 220 : 250)) * 256) + 1) *
            (k % 2 ? 220 : 250)) /
          256
      )
    })),
    context = {
      content,
      operators,
      viewport,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: graphics
    },
    table = {
      page: 1,
      grid,
      cells,
      readingRotation: 0,
      cropRect: [9, 19, 221, 191],
      sourceViewport: { width: 250, height: 220, scale: 1 },
      caption: captions[0],
      notes: [],
      unassigned: [],
      clipped: [],
      issues: []
    }
  return { table, items, captions, rules, paint, graphics, context }
}
const centeredMultilineOutput = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativeFencedGroupLabels(
    f.table,
    f.items,
    f.captions,
    f.rules,
    [],
    f.paint,
    f.graphics,
    f.context
  )

it('repairs only the late centered multiline stub owner with complete native groups', () => {
  const f = centeredMultilineOwners(),
    previous = structuredClone(f.table),
    result = centeredMultilineOutput(f)
  expect(result).toBeDefined()
  expect(
    result.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.column === 0 && c.text === 'Alpha family'
    )
  ).toMatchObject({ row: 1, rowSpan: 3 })
  expect(
    result.cells.filter((c: ReturnType<typeof JSON.parse>) => c.column > 0 || c.row === 0)
  ).toEqual(
    previous.cells.filter((c: ReturnType<typeof JSON.parse>) => c.column > 0 || c.row === 0)
  )
  expect(result.cells.find((c: ReturnType<typeof JSON.parse>) => c.text === 'Beta family')).toEqual(
    previous.cells.find((c: ReturnType<typeof JSON.parse>) => c.text === 'Beta family')
  )
  expect(result.cropRect).toEqual(previous.cropRect)
  expect(f.table).toEqual(previous)
})

it.each([
  'hidden-table',
  'hidden-cell',
  'hidden-source',
  'blank-origin',
  'blank-rect',
  'blank-unknown',
  'blank-array-metadata',
  'stub-rect-metadata',
  'stub-order',
  'stub-superscript',
  'duplicate-origin',
  'missing-origin',
  'unknown-wrapper',
  'horizontal-mismatch',
  'descent-mismatch',
  'nonfinite-font',
  'clipped',
  'clipping-operator',
  'missing-fence'
])('refuses incomplete late centered multiline ownership: %s', (control) => {
  const f = centeredMultilineOwners(),
    blank = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 0),
    stub = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.text === 'Alpha family'),
    body = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 1),
    header = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 0)
  if (control === 'hidden-table') Object.defineProperty(f.table, 'opaque', { value: 1 })
  else if (control === 'hidden-cell') Object.defineProperty(stub, 'opaque', { value: 1 })
  else if (control === 'hidden-source')
    Object.defineProperty(header.sourceTokens[0], 'opaque', { value: 1 })
  else if (control === 'blank-origin') blank.origin = { unknownDiagnostic: 1 }
  else if (control === 'blank-rect') blank.rect = [1, 1, 2, 2]
  else if (control === 'blank-unknown') blank.opaque = { value: 1 }
  else if (control === 'blank-array-metadata') blank.sourceTokens.opaque = { value: 1 }
  else if (control === 'stub-rect-metadata') stub.rect.opaque = { value: 1 }
  else if (control === 'stub-order') {
    stub.text = 'family Alpha'
    f.table.grid[2][0] = stub.text
  } else if (control === 'stub-superscript')
    stub.textRuns = [{ text: stub.text, position: 'superscript' }]
  else if (control === 'duplicate-origin') body.sourceItems = header.sourceItems
  else if (control === 'missing-origin') {
    body.sourceTokens = body.sourceTokens.map((token: ReturnType<typeof JSON.parse>) => {
      const next = { ...token }
      delete next.sourceItem
      return next
    })
    delete body.sourceItems
  } else if (control === 'unknown-wrapper') header.sourceTokens[0].opaque = 1
  else if (control === 'horizontal-mismatch')
    body.sourceTokens = body.sourceTokens.map((token: ReturnType<typeof JSON.parse>) => ({
      ...token,
      horizontal: false
    }))
  else if (control === 'descent-mismatch')
    body.sourceTokens = body.sourceTokens.map((token: ReturnType<typeof JSON.parse>) => ({
      ...token,
      fontDescent: 1
    }))
  else if (control === 'nonfinite-font') f.items[1].baseline = NaN
  else if (control === 'clipped') f.table.clipped = [{ text: 'foreign', rect: [1, 2, 3, 4] }]
  else if (control === 'clipping-operator') {
    f.context.operators.fnArray.push(OPS.clip)
    f.context.operators.argsArray.push(null)
  } else if (control === 'missing-fence') f.rules.splice(2, 1)
  expect(centeredMultilineOutput(f)).toBeUndefined()
})

// Two six-leaf blocks share four inset parent underlines. Three parent donors
// start on their second leaf; their original complete payloads must survive.
const repeatedParentOwners = (): ReturnType<typeof JSON.parse> => {
  const viewport = {
      width: 600,
      height: 260,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 260],
      convertToViewportPoint: (x: number, y: number): number[] => [x, 260 - y]
    },
    content: ReturnType<typeof JSON.parse> = { items: [], styles: { f: { vertical: false } } },
    operators: ReturnType<typeof JSON.parse> = {
      fnArray: [OPS.dependency, OPS.setLineWidth],
      argsArray: [['f'], [0.5]]
    },
    items: ReturnType<typeof JSON.parse>[] = [],
    cuts = [10, 50, 80, 120, 180, 220, 280, 320, 350, 390, 450, 490, 550],
    rowCuts = [5, 35, 60, 85, 105, 125, 145, 165, 190],
    cells: ReturnType<typeof JSON.parse>[] = [],
    grid = Array.from({ length: 8 }, () => Array(12).fill('')),
    rules = [
      ...[10, 60, 105, 145, 185].map((y) => [10, y, 550, y]),
      ...[82, 182, 352, 452].map((x) => [x, 35, x + 96, 35])
    ]
  const draw = (
    text: string,
    x: number,
    baseline: number,
    height = 10
  ): ReturnType<typeof JSON.parse> => {
    const width = (text.length * height) / 2,
      sourceItem = { pageNumber: 1, index: content.items.length, text },
      font = {
        text,
        rect: [x, baseline - height, x + width, baseline],
        baseline,
        height,
        horizontal: true,
        sourceItem
      }
    content.items.push({
      str: text,
      width,
      height,
      fontName: 'f',
      transform: [height, 0, 0, height, x, 260 - baseline],
      sourceItem
    })
    operators.fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      ['f', height],
      null,
      [new Float32Array([1, 0, 0, 1, x, 260 - baseline])],
      [
        [...text].map((unicode) => ({
          unicode,
          fontChar: unicode,
          originalCharCode: unicode.codePointAt(0),
          width: 500,
          isInFont: true,
          accent: null,
          operatorListId: null,
          isSpace: unicode === ' '
        }))
      ],
      null
    )
    items.push(font)
    return font
  }
  const cell = (
    row: number,
    column: number,
    fonts: ReturnType<typeof JSON.parse>[],
    colSpan = 1
  ): void => {
    const text = fonts.map((f) => f.text).join('')
    cells.push({
      row,
      column,
      rowSpan: 1,
      colSpan,
      text,
      rect: [cuts[column], rowCuts[row], cuts[column + colSpan], rowCuts[row + 1]],
      origin: fonts.length ? 'source-ruled-stub' : 'model-grid',
      sourceRects: fonts.map((f) => f.rect),
      sourceItems: fonts.map((f) => f.sourceItem),
      sourceTokens: fonts.map(({ text, rect, baseline, height }) => ({
        text,
        rect,
        baseline,
        height
      })),
      ...(fonts.length === 2
        ? {
            textRuns: [
              { text: fonts[0].text, position: 'normal' },
              { text: fonts[1].text, position: 'superscript' }
            ]
          }
        : {})
    })
    grid[row][column] = text
  }
  const parents = [
    [draw('Method A', 125, 30)],
    [draw('Method B', 225, 30), draw('2', 265, 25, 7)],
    [draw('Method A', 395, 30)],
    [draw('Method B', 495, 30), draw('2', 535, 25, 7)]
  ]
  for (const c of [0, 1, 2, 6, 7, 8, 10]) cell(0, c, [])
  for (const [n, c] of [3, 4, 9, 11].entries()) cell(0, c, parents[n], c === 4 ? 2 : 1)
  for (let c = 0; c < 12; c++)
    cell(
      1,
      c,
      [0, 1, 6, 7].includes(c) ? [] : [draw(c % 2 ? 'band' : 'avg', cuts[c] + (c % 2 ? 10 : 0), 50)]
    )
  for (let row = 2; row < 8; row++)
    for (let c = 0; c < 12; c++)
      cell(row, c, [
        draw(
          c % 6 === 0 ? 'x' : c % 2 && c % 6 !== 1 ? '[3,4]' : '2',
          cuts[c] + (c % 2 && c % 6 !== 1 ? 10 : 5),
          80 + (row - 2) * 20
        )
      ])
  operators.fnArray.push(OPS.setStrokeRGBColor)
  operators.argsArray.push(['#000000'])
  for (const [left, y, right] of rules) {
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [[0, left, 260 - y, 1, right, 260 - y]],
      [left, 260 - y, right, 260 - y]
    ])
  }
  const table = {
    id: 'anonymous-repeated-parents',
    page: 1,
    cropRect: [5, 5, 555, 190],
    sourceViewport: { width: 600, height: 260, scale: 1 },
    grid,
    cells: cells.sort((a, b) => a.row - b.row || a.column - b.column),
    rows: rowCuts.slice(1).map((bottom, r) => ({ rect: [5, rowCuts[r], 555, bottom] })),
    notes: [],
    unassigned: [],
    clipped: [],
    repairs: [],
    opaque: { preserve: 'all payloads' }
  }
  const context = {
    content,
    operators,
    viewport,
    rulePaintBounds: new Map(
      rules.map((r) => [r.join(','), [r[0], r[1] - 0.25, r[2], r[3] + 0.25]])
    ),
    nativeEvidenceGraphics: rules.map((r) => ({
      kind: 'path',
      rect: [r[0] - 0.25, r[1] - 0.25, r[2] + 0.25, r[3] + 0.25].map(
        (v, k) =>
          ((k < 2
            ? Math.floor((v / (k % 2 ? 260 : 600)) * 256)
            : Math.ceil((v / (k % 2 ? 260 : 600)) * 256) + 1) *
            (k % 2 ? 260 : 600)) /
          256
      )
    }))
  }
  return { table, items, rules, context }
}

const repeatedParentOutput = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativeSectionedOrdinaryRecordOwners(
    f.table,
    f.items,
    [],
    f.rules,
    f.context
  )

it('moves only the three inset ruled parent owners and their empty covered placeholders', () => {
  const f = repeatedParentOwners(),
    before = structuredClone(f.table),
    result = repeatedParentOutput(f)
  expect(
    lateFencedGroupHelpers.nativeWholeOwnerRepairPacket(f.table, f.items, f.rules, f.context)
  ).toBeDefined()
  expect(result).toBeDefined()
  expect(result.cells).toHaveLength(before.cells.length - 3)
  expect(
    result.cells
      .filter((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.text)
      .map((c: ReturnType<typeof JSON.parse>) => [c.column, c.colSpan])
  ).toEqual([
    [2, 2],
    [4, 2],
    [8, 2],
    [10, 2]
  ])
  expect(result.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row > 0)).toEqual(
    before.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row > 0)
  )
  expect(
    result.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 4)
  ).toEqual(before.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 4))
  for (const [oldCol, newCol] of [
    [3, 2],
    [9, 8],
    [11, 10]
  ]) {
    const donor = before.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === oldCol
      ),
      changed = result.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === newCol
      )
    expect({ ...changed, column: donor.column, colSpan: donor.colSpan, rect: donor.rect }).toEqual(
      donor
    )
  }
  expect({ ...result, cells: before.cells, grid: before.grid, repairs: before.repairs }).toEqual(
    before
  )
  expect(f.table).toEqual(before)
})

const changeRepeatedParentRules = (f: ReturnType<typeof JSON.parse>): void => {
  const op = f.context.operators
  for (let n = op.fnArray.length - 1; n >= 0; n--)
    if (op.fnArray[n] === OPS.constructPath) {
      op.fnArray.splice(n, 1)
      op.argsArray.splice(n, 1)
    }
  for (const [left, top, right, bottom] of f.rules) {
    op.fnArray.push(OPS.constructPath)
    op.argsArray.push([
      OPS.stroke,
      [[0, left, 260 - top, 1, right, 260 - bottom]],
      [
        Math.min(left, right),
        Math.min(260 - top, 260 - bottom),
        Math.max(left, right),
        Math.max(260 - top, 260 - bottom)
      ]
    ])
  }
  f.context.rulePaintBounds = new Map()
  expect(lateRules(op, f.context.viewport, f.context.rulePaintBounds)).toEqual(f.rules)
  f.context.nativeEvidenceGraphics = f.rules.map((r: number[]) => ({
    kind: 'path',
    rect: [r[0] - 0.25, r[1] - 0.25, r[2] + 0.25, r[3] + 0.25].map(
      (v, k) =>
        ((k < 2
          ? Math.floor((v / (k % 2 ? 260 : 600)) * 256)
          : Math.ceil((v / (k % 2 ? 260 : 600)) * 256) + 1) *
          (k % 2 ? 260 : 600)) /
        256
    )
  }))
}

it.each([
  'missing underline',
  'overlapping underline',
  'missing section fence',
  'unequal record sections',
  'noncoextensive opening fence'
])('refuses inset ruled parent owners with %s despite a complete source program', (kind) => {
  const f = repeatedParentOwners()
  if (kind === 'missing underline') f.rules.splice(5, 1)
  if (kind === 'overlapping underline') f.rules[5][2] = 200
  if (kind === 'missing section fence') f.rules.splice(2, 1)
  if (kind === 'unequal record sections') f.rules[2][1] = f.rules[2][3] = 135
  if (kind === 'noncoextensive opening fence') f.rules[0][2] += 1
  changeRepeatedParentRules(f)
  expect(
    lateFencedGroupHelpers.nativeWholeOwnerRepairPacket(f.table, f.items, f.rules, f.context)
  ).toBeDefined()
  const before = structuredClone(f.table)
  expect(repeatedParentOutput(f)).toBeUndefined()
  expect(f.table).toEqual(before)
})

it.each([
  'unknown blank payload',
  'foreign blank origin',
  'missing blank rectangle',
  'orphan blank rectangle',
  'nonfinite blank rectangle',
  'nonadjacent blank rectangle',
  'opaque repair tag',
  'parent text order',
  'rich script order',
  'false rich position',
  'duplicate source',
  'wrong parent slot',
  'missing packet',
  'unsupported operation'
])('refuses inset ruled parent owners with %s atomically', (kind) => {
  const f = repeatedParentOwners(),
    blank = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 2),
    donor = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 3),
    rich = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 11)
  if (kind === 'unknown blank payload') blank.diagnostic = { preserve: true }
  if (kind === 'foreign blank origin') blank.origin = 'unrecognized'
  if (kind === 'missing blank rectangle') delete blank.rect
  if (kind === 'orphan blank rectangle') delete donor.rect
  if (kind === 'nonfinite blank rectangle') blank.rect[0] = NaN
  if (kind === 'nonadjacent blank rectangle') blank.rect[2]--
  if (kind === 'opaque repair tag') f.table.repairs = [{ preserve: 'diagnostic' }]
  if (kind === 'parent text order') {
    donor.text = [...donor.text].reverse().join('')
    f.table.grid[0][3] = donor.text
  }
  if (kind === 'rich script order') rich.textRuns.reverse()
  if (kind === 'false rich position') rich.textRuns[1].position = 'normal'
  if (kind === 'duplicate source') donor.sourceItems[0] = rich.sourceItems[0]
  if (kind === 'wrong parent slot') {
    donor.column = 2
    blank.column = 3
    f.table.grid[0][2] = donor.text
    f.table.grid[0][3] = ''
  }
  if (kind === 'missing packet') f.context = {}
  if (kind === 'unsupported operation') {
    f.context.operators.fnArray.push(OPS.setLineJoin)
    f.context.operators.argsArray.push([0])
  }
  if (
    [
      'unknown blank payload',
      'foreign blank origin',
      'missing blank rectangle',
      'orphan blank rectangle',
      'nonfinite blank rectangle',
      'nonadjacent blank rectangle',
      'opaque repair tag',
      'parent text order',
      'rich script order',
      'false rich position',
      'wrong parent slot'
    ].includes(kind)
  )
    expect(
      lateFencedGroupHelpers.nativeWholeOwnerRepairPacket(f.table, f.items, f.rules, f.context)
    ).toBeDefined()
  const before = structuredClone(f.table)
  expect(repeatedParentOutput(f)).toBeUndefined()
  expect(f.table).toEqual(before)
})

it('preserves serialized inset parent sources and rejects accessor payloads without evaluating them', () => {
  const f = repeatedParentOwners()
  for (const c of f.table.cells) {
    delete c.rect
    delete c.sourceTokens
    delete c.origin
  }
  const result = repeatedParentOutput(f)
  expect(result).toBeDefined()
  expect(
    result.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems)
      .sort(
        (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) => a.index - b.index
      )
  ).toEqual(f.items.map((i: ReturnType<typeof JSON.parse>) => i.sourceItem))
  const blank = f.table.cells.find(
    (c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 2
  )
  let reads = 0
  Object.defineProperty(blank, 'diagnostic', {
    enumerable: true,
    get: () => {
      reads++
      return 'opaque'
    }
  })
  expect(repeatedParentOutput(f)).toBeUndefined()
  expect(reads).toBe(0)
})

it('preserves already recovered inset parents through refine and transports the repaired worker provenance', async () => {
  const f = repeatedParentOwners(),
    cuts = [10, 50, 80, 120, 180, 220, 280, 320, 350, 390, 450, 490, 550],
    objects = [
      ...cuts.slice(1).map((right, c) => ({
        label: 'table column',
        score: 1,
        rect: [cuts[c] - 5, 0, right - 5, 185]
      })),
      ...f.table.rows.map((r: ReturnType<typeof JSON.parse>) => ({
        label: 'table row',
        score: 1,
        rect: r.rect.map((v: number, n: number) => v - f.table.cropRect[n % 2])
      })),
      { label: 'table spanning cell', score: 1, rect: [175, 0, 275, 30] },
      { label: 'table column header', score: 1, rect: [0, 0, 550, 55] }
    ],
    refined = refineTable(
      { ...f.table, structure: { objects }, columnCount: 12, rowCount: 8 },
      f.items,
      [],
      [],
      f.rules,
      [],
      undefined,
      f.context.rulePaintBounds,
      f.context
    ),
    input = { ...refined, page: 1, sourceViewport: f.table.sourceViewport, notes: [] },
    result = repeatedParentOutput(f)
  // This smaller input is already proved by the older refine header recovery.
  // The late branch must leave it alone; the original page replay exercises
  // the late repair after refine, while this worker reads its compact donor.
  expect(repeatedParentOutput({ ...f, table: input })).toBeUndefined()
  expect(
    input.cells
      .filter((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.text)
      .map((c: ReturnType<typeof JSON.parse>) => [c.column, c.colSpan])
  ).toEqual([
    [2, 2],
    [4, 2],
    [8, 2],
    [10, 2]
  ])
  expect(result).toBeDefined()
  expect(
    result.cells
      .filter((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.text)
      .map((c: ReturnType<typeof JSON.parse>) => [c.column, c.colSpan])
  ).toEqual([
    [2, 2],
    [4, 2],
    [8, 2],
    [10, 2]
  ])
  expect(result.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row > 0)).toEqual(
    f.table.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row > 0)
  )
  const scratch = await mkdtemp(join(tmpdir(), 'pdf-inset-parents-')),
    identity = {
      extractionId: '00000000-0000-4000-8000-000000000001',
      engineFingerprint: 'b'.repeat(64),
      sourceChecksum: 'c'.repeat(64),
      sourceSizeBytes: 100,
      requestedPages: [1]
    }
  try {
    await mkdir(join(scratch, 'thumbnails'))
    await writeFile(
      join(scratch, 'thumbnails/anonymous-repeated-parents.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
        'base64'
      )
    )
    const cells = result.cells.map(
      ({
        row,
        column,
        rowSpan,
        colSpan,
        text,
        textRuns,
        sourceItems,
        sourceRects
      }: ReturnType<typeof JSON.parse>) => ({
        row,
        column,
        rowSpan,
        colSpan,
        text,
        ...(textRuns ? { textRuns } : {}),
        ...(sourceItems?.length ? { sourceItems } : {}),
        sourceRects
      })
    )
    await writeFile(
      join(scratch, 'structure.json'),
      JSON.stringify({
        sourceSha256: identity.sourceChecksum,
        pageCount: 1,
        requestedPages: [1],
        processedPages: [1],
        pages: [{ page: 1, width: 600, height: 260, rotation: 0 }],
        figures: [],
        algorithms: [],
        tables: [
          {
            id: result.id,
            page: 1,
            region: [5 / 600, 5 / 260, 555 / 600, 190 / 260],
            thumbnail: 'thumbnails/anonymous-repeated-parents.png',
            sourceViewport: result.sourceViewport,
            grid: result.grid,
            cells,
            unassigned: [],
            notes: [],
            issues: []
          }
        ],
        navigation: { entries: [] }
      })
    )
    const read = await readWorkerResult(scratch, identity, new Map()),
      actual = read.elements[0].table!
    expect(actual.rowCount).toBe(8)
    expect(actual.columnCount).toBe(12)
    expect(actual.cells).toEqual(
      cells.map((c: ReturnType<typeof JSON.parse>) => ({
        row: c.row,
        column: c.column,
        rowSpan: c.rowSpan,
        columnSpan: c.colSpan,
        text: c.text,
        ...(c.textRuns ? { textRuns: c.textRuns } : {}),
        ...(c.sourceItems?.length ? { sourceItems: c.sourceItems } : {}),
        regions: c.sourceRects.map((r: number[]) => ({
          page: 1,
          x: r[0] / 600,
          y: r[1] / 260,
          width: r[2] / 600 - r[0] / 600,
          height: r[3] / 260 - r[1] / 260
        }))
      }))
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

// Two source-fenced sections calibrate ordinary records; only one donor owns
// two complete baselines. Keep this generated example smaller than a PDF page.
const sectionedMergedRecord = (): ReturnType<typeof JSON.parse> => {
  const viewport = {
      width: 300,
      height: 240,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 240],
      convertToViewportPoint: (x: number, y: number): number[] => [x, 240 - y]
    },
    content = { items: [] as ReturnType<typeof JSON.parse>[], styles: { f: { vertical: false } } },
    operators = {
      fnArray: [OPS.dependency, OPS.setLineWidth],
      argsArray: [['f'], [0.5]] as ReturnType<typeof JSON.parse>[]
    },
    items: ReturnType<typeof JSON.parse>[] = []
  const draw = (text: string, x: number, baseline: number): ReturnType<typeof JSON.parse> => {
    const sourceItem = { pageNumber: 1, index: content.items.length, text },
      rect = [x, baseline - 10, x + text.length * 5, baseline],
      item = { text, rect, baseline, height: 10, horizontal: true, sourceItem }
    content.items.push({
      str: text,
      width: text.length * 5,
      height: 10,
      fontName: 'f',
      transform: [10, 0, 0, 10, x, 240 - baseline],
      sourceItem
    })
    operators.fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      ['f', 10],
      null,
      [new Float32Array([1, 0, 0, 1, x, 240 - baseline])],
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
    items.push(item)
    return item
  }
  const cells: ReturnType<typeof JSON.parse>[] = [],
    grid: string[][] = []
  const cell = (
    row: number,
    column: number,
    fonts: ReturnType<typeof JSON.parse>[],
    colSpan = 1
  ): void => {
    const text = fonts.map((f: ReturnType<typeof JSON.parse>) => f.text).join(' ')
    cells.push({
      row,
      column,
      rowSpan: 1,
      colSpan,
      text,
      sourceRects: fonts.map((f: ReturnType<typeof JSON.parse>) => f.rect),
      sourceItems: fonts.map((f: ReturnType<typeof JSON.parse>) => f.sourceItem),
      opaque: { keep: true }
    })
    grid[row] ??= ['', '', '', '']
    grid[row][column] = text
  }
  for (let c = 0; c < 4; c++)
    cell(0, c, [draw(['Name', 'One', 'Two', 'Three'][c], [20, 145, 200, 250][c], 35)])
  for (let section = 0; section < 2; section++) {
    const row = 1 + section * 4,
      y = 55 + section * 85
    cell(row, 0, [draw(section ? 'Beta' : 'Alpha', 95, y)], 4)
    for (let r = 0; r < 3; r++) {
      const target = section === 1 && r === 2 ? row + 2 : row + 1 + r
      for (let c = 0; c < 4; c++) {
        const f = draw(
            c === 0 ? `Item${r + 1}` : String((r + 1) * (c + 1)),
            [20, 145, 200, 250][c],
            y + 20 + r * 20
          ),
          old = cells.find((v: ReturnType<typeof JSON.parse>) => v.row === target && v.column === c)
        if (old) {
          old.text += ' ' + f.text
          old.sourceItems.push(f.sourceItem)
          old.sourceRects.push(f.rect)
          grid[target][c] = old.text
        } else cell(target, c, [f])
      }
    }
  }
  const ys = [20, 40, 60, 125, 145, 210],
    paint = new Map(),
    graphics: ReturnType<typeof JSON.parse>[] = []
  for (const y of ys) {
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 15, 240 - y, 1, 285, 240 - y])],
      new Float32Array([15, 240 - y, 285, 240 - y])
    ])
    const q = (v: number, n: number): number =>
      ((n < 2
        ? Math.floor((v / (n % 2 ? 240 : 300)) * 256)
        : Math.ceil((v / (n % 2 ? 240 : 300)) * 256) + 1) *
        (n % 2 ? 240 : 300)) /
      256
    graphics.push({ kind: 'path', rect: [14.75, y - 0.25, 285.25, y + 0.25].map(q) })
  }
  const rules = lateRules(operators, viewport, paint)
  return {
    table: {
      page: 1,
      sourceViewport: { width: 300, height: 240, scale: 1 },
      cropRect: [15, 20, 285, 210],
      grid,
      cells,
      unassigned: [],
      clipped: [],
      notes: [],
      issues: [],
      opaque: { keep: ['table'] }
    },
    items,
    rules,
    context: {
      operators,
      content,
      viewport,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: graphics
    }
  }
}
const { collectTableRules: lateRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const sectionedRecordOutput = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativeSectionedOrdinaryRecordOwners?.(
    f.table,
    f.items,
    [],
    f.rules,
    f.context
  )

it('separates a section-calibrated four-field donor without changing other owners', () => {
  const f = sectionedMergedRecord(),
    before = structuredClone(f.table),
    out = sectionedRecordOutput(f)
  expect(out).toBeDefined()
  expect(out.grid.slice(-2)).toEqual([
    ['Item2', '4', '6', '8'],
    ['Item3', '6', '9', '12']
  ])
  expect(out.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row < 6)).toEqual(
    before.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row < 6)
  )
  expect({ ...out, cells: before.cells, grid: before.grid }).toEqual(before)
  expect(
    out.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems)
      .map((i: ReturnType<typeof JSON.parse>) => i.index)
      .sort((a: number, b: number) => a - b)
  ).toEqual(
    f.items
      .map((i: ReturnType<typeof JSON.parse>) => i.sourceItem.index)
      .sort((a: number, b: number) => a - b)
  )
  expect(f.table).toEqual(before)
})
it.each(['missing packet', 'duplicate claim', 'missing rule', 'rich donor', 'foreign source'])(
  'refuses a section-calibrated donor with %s atomically',
  (kind) => {
    const f = sectionedMergedRecord()
    if (kind === 'missing packet') f.context = {}
    if (kind === 'duplicate claim')
      f.table.cells.at(-1).sourceItems[1] = f.table.cells.at(-1).sourceItems[0]
    if (kind === 'missing rule') f.rules.splice(4, 1)
    if (kind === 'rich donor')
      f.table.cells.at(-1).textRuns = [{ text: f.table.cells.at(-1).text, position: 'superscript' }]
    if (kind === 'foreign source') f.table.cells.at(-1).sourceItems[0].index = 999
    const before = structuredClone(f.table)
    expect(sectionedRecordOutput(f)).toBeUndefined()
    expect(f.table).toEqual(before)
  }
)

it('repairs the internal section donor when model bounds clip both complete records', () => {
  const f = sectionedMergedRecord()
  f.table.rows = f.table.grid.map((_row: string[], row: number) => {
    const fonts = f.table.cells
      .filter((c: ReturnType<typeof JSON.parse>) => c.row === row)
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems)
      .map((o: ReturnType<typeof JSON.parse>) =>
        f.items.find((i: ReturnType<typeof JSON.parse>) => i.sourceItem.index === o.index)
      )
    return {
      rect: [
        15,
        Math.min(...fonts.map((i: ReturnType<typeof JSON.parse>) => i.rect[1])),
        285,
        Math.max(...fonts.map((i: ReturnType<typeof JSON.parse>) => i.rect[3]))
      ],
      opaque: { keep: 'row' }
    }
  })
  for (const c of f.table.cells) {
    c.sourceTokens = c.sourceItems.map((o: ReturnType<typeof JSON.parse>) =>
      structuredClone(
        f.items.find((i: ReturnType<typeof JSON.parse>) => i.sourceItem.index === o.index)
      )
    )
    c.rect = [15, f.table.rows[c.row].rect[1], 285, f.table.rows[c.row].rect[3]]
  }
  const row = f.table.grid.length - 1
  f.table.rows[row].rect.splice(1, 1, 177)
  f.table.rows[row].rect[3] = 193
  for (const c of f.table.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row === row)) {
    c.rect[1] = 177
    c.rect[3] = 193
  }
  const before = structuredClone(f.table),
    out = sectionedRecordOutput(f)
  expect(out).toBeDefined()
  expect(out.grid.slice(-2)).toEqual([
    ['Item2', '4', '6', '8'],
    ['Item3', '6', '9', '12']
  ])
  expect(out.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row < row)).toEqual(
    before.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row < row)
  )
  expect(out.rows.slice(0, row)).toEqual(before.rows.slice(0, row))
  expect({ ...out, cells: before.cells, grid: before.grid, rows: before.rows }).toEqual(before)
  expect(f.table).toEqual(before)
})
// This source-calibrated family keeps complete old field owners. The second
// variant has an internal label column and three ordinary paragraph lines.
const sourceFencedExistingLabels = (internal: boolean): ReturnType<typeof JSON.parse> => {
  const column = internal ? 1 : 0,
    cuts = [20, 80, 150, 210, 280],
    fences = [20, 44, 140, 236],
    items: ReturnType<typeof JSON.parse>[] = [],
    runs: ReturnType<typeof JSON.parse>[] = [],
    cells: ReturnType<typeof JSON.parse>[] = [],
    rules: number[][] = [],
    paint: [string, number[]][] = [],
    graphics: ReturnType<typeof JSON.parse>[] = []
  const font = (
    text: string,
    x: number,
    width: number,
    baseline: number,
    height = 10
  ): ReturnType<typeof JSON.parse> => {
    const token = { text, rect: [x, baseline - height, x + width, baseline], baseline, height }
    items.push({ ...structuredClone(token), horizontal: true, inlineSymbol: false })
    runs.push({
      ...structuredClone(token),
      gaps: [],
      literalGlyphs: [...text],
      glyphRuns: Array.from(text, () => runs.length)
    })
    return token
  }
  const cell = (
    row: number,
    col: number,
    tokens: ReturnType<typeof JSON.parse>[],
    rect: number[],
    rowSpan = 1,
    origin = 'model-grid'
  ): ReturnType<typeof JSON.parse> => ({
    row,
    column: col,
    rowSpan,
    colSpan: 1,
    rect,
    origin,
    text: tokens.map((t) => t.text).join(' '),
    sourceTokens: tokens,
    sourceRects: tokens.map((t) => t.rect)
  })
  const headers = cuts.slice(0, -1).map((left, col) => {
    const token =
      col === column
        ? font(internal ? 'Type' : 'Key', internal ? 105 : 42, internal ? 20 : 16, 38)
        : font('Field', left + 12, 20, 38)
    const result = cell(0, col, [token], [left, 24, cuts[col + 1], 43])
    if (col === 3) {
      const child = font('q', token.rect[2], 4, 42, 8)
      result.sourceTokens.push(child)
      result.sourceRects.push(child.rect)
      result.text = 'Fieldq'
      result.textRuns = [
        { text: 'Field', position: 'normal', style: { source: 'unchanged' } },
        { text: 'q', position: 'subscript' }
      ]
    }
    return result
  })
  const correctLabels = [
    internal
      ? [font('North', 107, 16, 82), font('Middle', 105, 20, 94), font('South', 107, 16, 106)]
      : [font('Aaaa', 42, 16, 94)],
    internal
      ? [font('Shared', 105, 20, 184), font('Label', 107, 16, 196)]
      : [font('Bbbb', 42, 16, 190)]
  ]
  for (let row = 1; row <= 6; row++) {
    const group = row > 3 ? 1 : 0,
      local = (row - 1) % 3,
      baseline = 70 + group * 96 + local * 24,
      top = 50 + group * 96 + local * 24,
      bottom = top + 22
    for (let col = 0; col < 4; col++) {
      if (col === column) {
        if (group === 1 && local !== 0) continue
        if (group === 1)
          cells.push(
            cell(row, col, correctLabels[1], [cuts[col], 146, cuts[col + 1], 232], 3, 'model-span')
          )
        else if (internal)
          cells.push(
            cell(row, col, [correctLabels[0][local]], [cuts[col], top, cuts[col + 1], bottom])
          )
        else if (local === 0)
          cells.push(cell(row, col, [], [cuts[col], top, cuts[col + 1], bottom]))
        else if (local === 1)
          cells.push(
            cell(row, col, correctLabels[0], [cuts[col], top, cuts[col + 1], 136], 2, 'model-span')
          )
        continue
      }
      const fields =
        !internal && col === 1 && local === 0
          ? [font('Left', 100, 16, baseline - 5), font('Wrap', 94, 28, baseline + 4)]
          : [font(`R${row}`, cuts[col] + 12, 16, baseline)]
      const owner = cell(row, col, fields, [cuts[col], top - 2, cuts[col + 1], bottom])
      owner.opaquePeer = { preserve: row * 10 + col }
      cells.push(owner)
    }
  }
  cells.push(...headers)
  const addRule = (r: number[]): void => {
    const bounds =
      r[0] === r[2] ? [r[0] - 0.5, r[1], r[2] + 0.5, r[3]] : [r[0], r[1] - 0.5, r[2], r[3] + 0.5]
    rules.push(r)
    paint.push([r.join(','), bounds])
    const carrier = [...bounds]
    if (r[0] === r[2]) {
      carrier[1] -= 0.5
      carrier[3] += 0.5
    } else {
      carrier[0] -= 0.5
      carrier[2] += 0.5
    }
    graphics.push({
      kind: 'path',
      rect: carrier.map((v, axis) => (axis < 2 ? Math.floor(v / 2) : Math.ceil(v / 2) + 1) * 2)
    })
  }
  for (const y of fences) addRule([20, y, 280, y])
  if (!internal)
    for (const [top, bottom] of [
      [26, 42],
      [50, 136],
      [146, 232]
    ])
      addRule([140, top, 140, bottom])
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 4 }, () => ''))
  for (const c of cells) grid[c.row][c.column] = c.text
  const caption = {
      page: 7,
      lines: ['Table 4: Complete literal fields.'],
      text: 'Table 4: Complete literal fields.',
      rect: [20, 2, 200, 10]
    },
    table = {
      id: 'anonymous-source-fenced-labels',
      cells,
      grid,
      cropRect: [18, 18, 282, 242],
      sourceViewport: { width: 512, height: 512, scale: 1.5 },
      page: 7,
      caption,
      notes: [],
      clipped: [],
      issues: [],
      unassigned: [],
      repairs: ['old-owner-proof'],
      reviewCandidate: true,
      opaque: { keep: ['whole'] }
    },
    donors = cells.filter((c) => c.column === column && c.row > 0 && c.row < 4),
    expected = structuredClone(table),
    replacement = {
      ...structuredClone(donors.find((c) => c.sourceTokens.length)),
      row: 1,
      rowSpan: 3,
      rect: [cuts[column], 50, cuts[column + 1], internal ? 120 : 136],
      text: correctLabels[0].map((t) => t.text).join(' '),
      sourceTokens: correctLabels[0],
      sourceRects: correctLabels[0].map((t) => t.rect)
    }
  expected.cells = cells.flatMap((c) =>
    c === donors[0] ? [replacement] : donors.includes(c) ? [] : [structuredClone(c)]
  )
  for (let row = 1; row <= 3; row++) expected.grid[row][column] = row === 1 ? replacement.text : ''
  return {
    table,
    items,
    runs,
    rules,
    paint,
    graphics,
    captions: [{ ...caption, rect: caption.rect.map((v) => v * 1.5) }],
    expected,
    donors,
    column
  }
}
const lateFencedGroupOutput = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativeFencedGroupLabels?.(
    f.table,
    f.items,
    f.captions,
    f.rules,
    f.runs,
    new Map(f.paint),
    f.graphics
  )

it.each([false, true])(
  'repairs only calibrated native fenced group labels while keeping complete rich field owners: %s',
  (internal) => {
    const f = sourceFencedExistingLabels(internal),
      before = structuredClone(f),
      result = lateFencedGroupOutput(f) ?? f.table
    expect(result).toEqual(f.expected)
    expect(
      result.cells
        .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
        .sort(
          (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) =>
            a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1]
        )
    ).toEqual(
      f.table.cells
        .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
        .sort(
          (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) =>
            a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1]
        )
    )
    expect(result.repairs).toEqual(f.table.repairs)
    expect(f).toEqual(before)
  }
)

const changeFencedExistingFont = (
  f: ReturnType<typeof JSON.parse>,
  token: ReturnType<typeof JSON.parse>,
  change: (font: ReturnType<typeof JSON.parse>) => void
): void => {
  const original = structuredClone(token),
    updated = structuredClone(token)
  change(updated)
  const matches = (font: ReturnType<typeof JSON.parse>): boolean =>
    font.text === original.text &&
    font.baseline === original.baseline &&
    font.height === original.height &&
    JSON.stringify(font.rect) === JSON.stringify(original.rect)
  for (const list of [f.items, f.runs])
    for (const font of list.filter(matches)) {
      Object.assign(font, {
        rect: [...updated.rect],
        baseline: updated.baseline,
        height: updated.height
      })
    }
  for (const cell of f.table.cells)
    for (const font of cell.sourceTokens.filter(matches)) {
      const index = cell.sourceRects.findIndex(
        (rect: number[]) => JSON.stringify(rect) === JSON.stringify(original.rect)
      )
      Object.assign(font, {
        rect: [...updated.rect],
        baseline: updated.baseline,
        height: updated.height
      })
      cell.sourceRects[index] = [...updated.rect]
    }
}

it.each([
  'missing closing fence',
  'header whole font crosses leaf',
  'body whole font crosses leaf',
  'whole font crosses group fence',
  'foreign ordinary font',
  'foreign rotated font',
  'missing observed label',
  'competing observed program',
  'invalid program identifier',
  'expanded glyph count mismatch',
  'duplicated source rect',
  'missing calibration literal',
  'calibration clips its own label',
  'label center differs from complete calibration',
  'label vertical offset differs from complete calibration',
  'no complete calibration',
  'native image in apparently blank row',
  'native icon in apparently blank row',
  'missing painted rule',
  'missing native paint carrier',
  'non-stub row span',
  'unknown donor field',
  'unknown normal run field',
  'native wall crosses full font',
  'competing caption',
  'foreign-page caption',
  'incorrect viewport scale',
  'fractional canvas',
  'invalid meaningful font rect',
  'null old cell',
  'null note container',
  'nonempty notes',
  'unsupported parts',
  'nonempty issues',
  'nonempty unassigned',
  'nonempty clipped',
  'null reading rotation',
  'false reading rotation',
  'nonfinite reading rotation',
  'non-string grid slot',
  'null source caption rect',
  'invalid source caption line'
])('refuses incomplete late native fenced group evidence: %s', (reason) => {
  const f = sourceFencedExistingLabels(false),
    printed = f.table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 2 && c.column === 0
    ),
    correct = f.table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 4 && c.column === 0
    ),
    peer = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 2),
    header = f.table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 2
    ),
    observed = f.runs.find((r: ReturnType<typeof JSON.parse>) => r.text === printed.text)
  switch (reason) {
    case 'missing closing fence':
      f.rules = f.rules.filter((r: number[]) => r[1] !== 236 || r[3] !== 236)
      break
    case 'header whole font crosses leaf':
      changeFencedExistingFont(f, header.sourceTokens[0], (i) => {
        i.rect[2] = 223
      })
      break
    case 'body whole font crosses leaf':
      changeFencedExistingFont(f, peer.sourceTokens[0], (i) => {
        i.rect[0] = 149
      })
      break
    case 'whole font crosses group fence':
      changeFencedExistingFont(f, peer.sourceTokens[0], (i) => {
        i.rect[1] = 138
        i.rect[3] = i.baseline = 148
      })
      break
    case 'foreign ordinary font':
    case 'foreign rotated font':
      f.items.push({
        text: 'Z',
        rect: [155, 80, 160, 85],
        height: 5,
        baseline: 85,
        horizontal: reason === 'foreign ordinary font'
      })
      break
    case 'missing observed label':
      f.runs = f.runs.filter((r: ReturnType<typeof JSON.parse>) => r !== observed)
      break
    case 'competing observed program':
      f.runs.push({ ...structuredClone(observed), height: observed.height + 1 })
      break
    case 'invalid program identifier':
      observed.glyphRuns.fill(-1)
      break
    case 'expanded glyph count mismatch':
      observed.glyphRuns.pop()
      break
    case 'duplicated source rect':
      f.table.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.sourceRects.length > 1
      ).sourceRects[1] = f.table.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.sourceRects.length > 1
      ).sourceRects[0]
      break
    case 'missing calibration literal':
      correct.text = correct.text.slice(1)
      f.table.grid[4][0] = correct.text
      break
    case 'calibration clips its own label':
      correct.rect[2] = correct.sourceTokens[0].rect[2] - 1
      break
    case 'label center differs from complete calibration':
      changeFencedExistingFont(f, printed.sourceTokens[0], (i) => {
        i.rect[0]++
        i.rect[2]++
      })
      break
    case 'label vertical offset differs from complete calibration':
      changeFencedExistingFont(f, printed.sourceTokens[0], (i) => {
        i.rect[1]++
        i.rect[3]++
        i.baseline++
      })
      break
    case 'no complete calibration':
      correct.rowSpan = 1
      for (const row of [5, 6])
        f.table.cells.push({
          ...structuredClone(correct),
          row,
          text: '',
          sourceTokens: [],
          sourceRects: []
        })
      break
    case 'native image in apparently blank row':
      f.graphics.push({ kind: 'image', rect: [30, 52, 40, 62] })
      break
    case 'native icon in apparently blank row':
      f.graphics.push({ kind: 'path', rect: [30, 52, 40, 62] })
      break
    case 'missing painted rule':
      f.paint = f.paint.slice(1)
      break
    case 'missing native paint carrier':
      f.graphics.shift()
      break
    case 'non-stub row span':
      peer.rowSpan = 2
      break
    case 'unknown donor field':
      printed.unknownOwner = { preserve: true }
      break
    case 'unknown normal run field':
      printed.textRuns = [{ text: printed.text, position: 'normal', unknownOwner: true }]
      break
    case 'native wall crosses full font': {
      const wall = f.rules.find((r: number[]) => r[0] === r[2]),
        old = wall.join(',')
      wall[0] = wall[2] = 165
      f.paint = f.paint.filter(([key]: [string, number[]]) => key !== old)
      f.paint.push([wall.join(','), [164.5, wall[1], 165.5, wall[3]]])
      break
    }
    case 'competing caption':
      f.captions.push(structuredClone(f.captions[0]))
      break
    case 'foreign-page caption':
      f.captions[0].page++
      break
    case 'incorrect viewport scale':
      f.table.sourceViewport.scale = 1
      break
    case 'fractional canvas':
      f.table.sourceViewport.width += 0.1
      break
    case 'invalid meaningful font rect':
      f.items.find((i: ReturnType<typeof JSON.parse>) => i.text === printed.text).rect[0] = NaN
      break
    case 'null old cell':
      f.table.cells[0] = null
      break
    case 'null note container':
      f.table.notes = null
      break
    case 'nonempty notes':
      f.table.notes.push({ text: 'Keep this note', rect: [20, 245, 100, 255] })
      break
    case 'unsupported parts':
      f.table.parts = [{}]
      break
    case 'nonempty issues':
      f.table.issues.push('unresolved-owner')
      break
    case 'nonempty unassigned':
      f.table.unassigned.push(peer.sourceTokens[0])
      break
    case 'nonempty clipped':
      f.table.clipped.push(peer.sourceTokens[0])
      break
    case 'null reading rotation':
      f.table.readingRotation = null
      break
    case 'false reading rotation':
      f.table.readingRotation = false
      break
    case 'nonfinite reading rotation':
      f.table.readingRotation = NaN
      break
    case 'non-string grid slot':
      f.table.grid[0][0] = null
      break
    case 'null source caption rect':
      f.captions[0].rect = null
      break
    case 'invalid source caption line':
      f.captions[0].lines[0] = null
      break
  }
  const before = structuredClone(f)
  expect(lateFencedGroupOutput(f)).toBeUndefined()
  expect(f).toEqual(before)
})

// Every compound value is one independently printed leaf. Scalar fragments
// alone cannot prove extra lanes through a complete intervening source font.
const nativeCompoundMeasurements = (): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = [],
    font = (text: string, x: number, width: number, baseline: number): void => {
      items.push({
        text,
        rect: [x, baseline - 12, x + width, baseline],
        height: 12,
        baseline,
        horizontal: true,
        inlineSymbol: false
      })
    }
  font('Variant', 24, 40, 53)
  font('Earlier Measures', 180, 110, 53)
  font('Later Measures', 490, 100, 53)
  for (let column = 0; column < 8; column++) {
    font(`M${column + 1}`, 100 + column * 80, 27, 76)
    font('↓', 135 + column * 80, 6, 76)
  }
  for (let row = 0; row < 6; row++) {
    const baseline = 105 + row * 22
    font(`Choice${row + 1}`, 24, 55, baseline)
    for (let column = 0; column < 8; column++) {
      font('0.25', 100 + column * 80, 23, baseline)
      font('±', 123 + column * 80, 7, baseline)
      font('0.01', 130 + column * 80, 23, baseline)
    }
  }
  const cropRect = [19, 39, 742, 230],
    cuts = [20, 90, ...Array.from({ length: 7 }, (_, column) => 170 + column * 80), 740],
    edges = [40, 82, ...Array.from({ length: 6 }, (_, row) => 116 + row * 22)],
    objects = [
      ...cuts.slice(1).map((right, column) => ({
        label: 'table column',
        rect: [cuts[column] - cropRect[0], 1, right - cropRect[0], 189]
      })),
      ...edges.slice(1).map((bottom, row) => ({
        label: 'table row',
        rect: [1, edges[row] - cropRect[1], 721, bottom - cropRect[1]]
      }))
    ]
  return {
    table: { id: 'page-1-table-1', cropRect, structure: { objects } },
    items,
    captions: [{ lines: ['Table 1: Anonymous measurements.'], rect: [20, 10, 500, 30] }],
    rules: [
      [20, 40, 740, 40],
      [100, 60, 413, 60],
      [420, 60, 736, 60],
      [20, 82, 740, 82],
      [20, 228, 740, 228]
    ]
  }
}

function nativeTieredMarkerRecords(): ReturnType<typeof JSON.parse> {
  const f = nativeCompoundMeasurements()
  f.items = f.items.filter((item: { text: string }) => !['±', '0.01', '↓'].includes(item.text))
  for (const item of f.items.filter((item: { baseline: number }) => item.baseline > 82)) {
    item.baseline += 12
    item.rect[1] += 12
    item.rect[3] += 12
  }
  f.table.cropRect[3] += 12
  f.rules.at(-1)[1] += 12
  f.rules.at(-1)[3] += 12
  f.items.push({
    text: 'Section',
    rect: [24, 84, 74, 96],
    height: 12,
    baseline: 96,
    horizontal: true
  })
  const label = f.items.find((item: { text: string }) => item.text === 'Choice2')
  f.items.push({
    text: '∗',
    rect: [label.rect[2], label.baseline - 13, label.rect[2] + 5, label.baseline - 5],
    baseline: label.baseline - 5,
    height: 8,
    horizontal: true
  })
  f.items.forEach((item: { sourceItem: unknown; text: string }, index: number) => {
    item.sourceItem = { pageNumber: 1, index, text: item.text }
  })
  return f
}

it.each([false, true])(
  'keeps a raised native marker with its complete record beneath a proved tiered header with numeric underline %s',
  (underline) => {
    const f = nativeTieredMarkerRecords()
    const label = f.items.find((item: { text: string }) => item.text === 'Choice2')
    if (underline) f.rules.push([100, label.baseline - 9, 123, label.baseline - 9])
    const result = refineTable(f.table, f.items, f.captions, [], f.rules, [])
    expect(result.repairs).toContain('native-tiered-header-body-records-recovered')
    expect(result.grid).toHaveLength(9)
    expect(result.grid[4][0]).toBe('Choice2∗')
    expect(result.grid.slice(3).map((row: string[]) => row.slice(1))).toEqual(
      Array.from({ length: 6 }, () => Array.from({ length: 8 }, () => '0.25'))
    )
    expect(
      result.cells
        .flatMap((cell: { sourceItems?: { index: number }[] }) => cell.sourceItems ?? [])
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    ).toEqual(f.items.map((item: { sourceItem: unknown }) => item.sourceItem))
  }
)

it.each(['stub rule', 'external alias', 'distant script'])(
  'does not pair a tiered stub script without a unique unobstructed native anchor: %s',
  (change) => {
    const f = nativeTieredMarkerRecords()
    const label = f.items.find((item: { text: string }) => item.text === 'Choice2')
    const script = f.items.find((item: { text: string }) => item.text === '∗')
    if (change === 'stub rule') f.rules.push([24, label.baseline - 9, 85, label.baseline - 9])
    if (change === 'external alias') f.items.push({ ...script, rect: [800, 10, 805, 18] })
    if (change === 'distant script') {
      script.rect[0] += 8
      script.rect[2] += 8
    }
    const result = refineTable(f.table, f.items, f.captions, [], f.rules, [])
    expect(result.grid).toHaveLength(10)
    expect(
      result.grid.some((row: string[]) => row[0] === '∗' && row.slice(1).every((s) => !s))
    ).toBe(true)
  }
)

it('keeps complete compound source leaves when a later scalar header plan crosses their fonts', () => {
  const f = nativeCompoundMeasurements(),
    before = structuredClone(f),
    result = refineTable(f.table, f.items, f.captions, [], f.rules, [])
  expect(result.grid).toEqual([
    ['Variant', 'Earlier Measures', '', '', '', 'Later Measures', '', '', ''],
    ['', ...Array.from({ length: 8 }, (_, column) => `M${column + 1} ↓`)],
    ...Array.from({ length: 6 }, (_, row) => [
      `Choice${row + 1}`,
      ...Array.from({ length: 8 }, () => '0.25±0.01')
    ])
  ])
  expect(result.cells).toHaveLength(65)
  expect(result.repairs).not.toContain('native-tiered-header-body-records-recovered')
  expect(result.unassigned).toEqual([])
  const sourceKey = (item: { text: string; rect: number[] }): string =>
    JSON.stringify([item.text, item.rect])
  expect(
    result.cells
      .flatMap((cell: { sourceTokens: unknown[] }) => cell.sourceTokens)
      .map(sourceKey)
      .sort()
  ).toEqual(f.items.map(sourceKey).sort())
  expect(
    result.cells.every(
      (cell: { sourceTokens: { rect: number[] }[]; sourceRects: number[][] }) =>
        JSON.stringify(cell.sourceRects) ===
        JSON.stringify(cell.sourceTokens.map((item) => item.rect))
    )
  ).toBe(true)
  expect(f).toEqual(before)
})

it('retains an independently printed full-width section before checking numeric leaf ownership', () => {
  const f = readPdfFixture(
    resolve('test/fixtures/source-grids/native-underlined-independent-header.jsonl')
  )
  const body = f.tokens.filter(
    (item: { baseline: number; rect: number[] }) => item.baseline > 646.32 && item.rect[3] < 779.647
  )
  const baseline = [...new Set(body.map((item: { baseline: number }) => item.baseline))].sort(
    (a, b) => Number(a) - Number(b)
  )[4] as number
  const removed = f.tokens.filter((item: { baseline: number }) => item.baseline === baseline)
  f.tokens = f.tokens.filter((item: { baseline: number }) => item.baseline !== baseline)
  f.measuredRuns = (f.measuredRuns ?? []).filter(
    (run: { text: string; rect: number[] }) =>
      !removed.some(
        (item: { text: string; rect: number[] }) =>
          run.text === item.text && run.rect.every((value, index) => value === item.rect[index])
      )
  )
  const section = {
    text: 'Neutral configuration section',
    inlineSymbol: false,
    baseline,
    height: removed[0].height,
    rect: [162, baseline - removed[0].height, 650, baseline],
    horizontal: true
  }
  const literalGlyphs = [...section.text.replace(/\s/gu, '')]
  f.tokens.push(section)
  f.measuredRuns.push({
    ...section,
    gaps: [],
    literalGlyphs,
    glyphRuns: literalGlyphs.map(() => 10001)
  })
  const before = structuredClone(f)
  const result = refineTable(f.table, f.tokens, f.captions, [], f.rules, f.measuredRuns)
  expect(result.repairs).toContain('native-tiered-header-body-records-recovered')
  expect(result.cells).toHaveLength(123)
  expect(result.cells.find((cell: { text: string }) => cell.text === section.text)).toMatchObject({
    row: 6,
    column: 0,
    rowSpan: 1,
    colSpan: 10,
    sourceTokens: [section],
    sourceRects: [section.rect]
  })
  expect(f).toEqual(before)
})

it('assigns conserved native header glyphs to their independently proved scalar leaves', () => {
  const f = fixture('conserved-native-scalar-header-owners'),
    before = structuredClone(f),
    result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs, [])
  expect(result.grid[0]).toEqual(f.expectedHeader)
  expect(result.cells).toHaveLength(36)
  expect(result.cells.filter((cell: { row: number }) => cell.row > 0)).toEqual(
    f.expectedBefore.cells.filter((cell: { row: number }) => cell.row > 0)
  )
  const bodyFonts = f.items.slice(3)
  for (let row = 1; row <= 8; row++)
    for (let column = 0; column < 4; column++) {
      const font = bodyFonts[(row - 1) * 4 + column]
      expect(
        result.cells.find(
          (cell: { row: number; column: number }) => cell.row === row && cell.column === column
        )
      ).toMatchObject({ text: font.text, rowSpan: 1, colSpan: 1, sourceRects: [font.rect] })
    }
  expect(
    Object.fromEntries(
      Object.entries(result).filter(([key]) => !['grid', 'cells', 'rows', 'repairs'].includes(key))
    )
  ).toEqual(
    Object.fromEntries(
      Object.entries(f.expectedBefore).filter(
        ([key]) => !['grid', 'cells', 'rows', 'repairs'].includes(key)
      )
    )
  )
  expect(result.repairs).toEqual([
    ...f.expectedBefore.repairs.filter(
      (repair: string) => repair !== 'native-empty-slot-rectangle-restored'
    ),
    'native-peer-scalar-header-ownership-recovered'
  ])
  expect(f).toEqual(before)
})

it('retains native item origins when recovering conserved scalar header leaves', () => {
  const f = fixture('conserved-native-scalar-header-owners')
  for (const [index, item] of f.items.entries())
    item.sourceItem = { pageNumber: 1, index, text: item.text }
  const before = structuredClone(f)
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs, [])
  expect(result.grid[0]).toEqual(f.expectedHeader)
  for (const [column, sourceIndex] of [0, 1, 2, 2].entries()) {
    const cell = result.cells.find(
      (c: { row: number; column: number }) => c.row === 0 && c.column === column
    )
    expect(cell.sourceItems).toEqual([f.items[sourceIndex].sourceItem])
  }
  expect(f).toEqual(before)
})

it.each([
  'missing observed program',
  'crossed measured owner',
  'competing observed program',
  'missing closing frame'
])('requires complete scalar header source ownership: %s', (reason) => {
  const f = fixture('conserved-native-scalar-header-owners')
  if (reason === 'missing observed program') f.runs.splice(2, 1)
  if (reason === 'crossed measured owner') f.runs[2].glyphRuns[4] += 10000
  if (reason === 'competing observed program') f.runs.push(structuredClone(f.runs[2]))
  if (reason === 'missing closing frame')
    f.rules = f.rules.filter(
      (rule: number[]) => rule[1] !== f.rules.at(-1)[1] || rule[0] === rule[2]
    )
  const before = structuredClone(f)
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs, [])
  expect(result.repairs).not.toContain('native-peer-scalar-header-ownership-recovered')
  expect(f).toEqual(before)
})

it('keeps already complete scalar header leaf owners out of the conserved-owner repair', () => {
  const f = fixture('conserved-native-scalar-header-owners'),
    parent = f.items[2],
    program = f.runs[2],
    gap = program.gaps.find((g: { index: number }) => g.index === 4),
    children = [
      {
        ...parent,
        text: 'Key 2',
        rect: [parent.rect[0], parent.rect[1], gap.left, parent.rect[3]]
      },
      {
        ...parent,
        text: 'Key 3',
        rect: [gap.right, parent.rect[1], parent.rect[2], parent.rect[3]]
      }
    ]
  f.items.splice(2, 1, ...children)
  f.runs.splice(
    2,
    1,
    ...children.map((child) => ({
      ...child,
      gaps: [],
      literalGlyphs: [...child.text.replace(/\s/gu, '')],
      glyphRuns: [...child.text.replace(/\s/gu, '')].map(() => program.glyphRuns[0])
    }))
  )
  const fields = [
      f.items.slice(0, 4),
      ...Array.from({ length: 8 }, (_, row) => f.items.slice(4 + row * 4, 8 + row * 4))
    ],
    domains = Array.from({ length: 4 }, (_, column) => [
      Math.min(...fields.map((row) => row[column].rect[0])),
      Math.max(...fields.map((row) => row[column].rect[2]))
    ]),
    full = f.rules.filter((rule: number[]) => rule[1] === rule[3]),
    cuts = [
      full[0][0],
      ...domains.slice(1).map((domain, column) => (domains[column][1] + domain[0]) / 2),
      full[0][2]
    ],
    crop = f.table.cropRect,
    relative = (rect: number[]): number[] => rect.map((v, index) => v - crop[index % 2]),
    objects = [
      ...f.expectedBefore.rows.map((row: { rect: number[] }) => ({
        label: 'table row',
        rect: relative(row.rect)
      })),
      ...cuts.slice(1).map((right, column) => ({
        label: 'table column',
        rect: relative([cuts[column], full[0][1], right, full.at(-1)[1]])
      }))
    ]
  f.table.structure.objects = objects
  const before = structuredClone(f),
    result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs, [])
  expect(result.grid[0]).toEqual(f.expectedHeader)
  expect(result.repairs).not.toContain('native-peer-scalar-header-ownership-recovered')
  expect(result.cells).toHaveLength(36)
  expect(f).toEqual(before)
})

it('preserves the complete group projection under reversed native evidence order', () => {
  const f = sourceFencedExistingLabels(true)
  for (const key of ['items', 'runs', 'rules', 'graphics']) f[key].reverse()
  expect(lateFencedGroupOutput(f)).toEqual(f.expected)
})

it.each([null, [], 0])('safely refuses an invalid late source group table: %s', (table) => {
  const f = sourceFencedExistingLabels(true)
  f.table = table
  expect(lateFencedGroupOutput(f)).toBeUndefined()
})

it('keeps a complete already-correct source group table outside the repair path', () => {
  const f = sourceFencedExistingLabels(true)
  f.table = structuredClone(f.expected)
  const before = structuredClone(f)
  expect(lateFencedGroupOutput(f)).toBeUndefined()
  expect(f).toEqual(before)
})

it('separates two independent native captions without changing any complete literal or rich owner', () => {
  const f = fixture('native-independent-captioned-tables'),
    before = structuredClone(f),
    current = run(f)
  expect(current).toEqual(f.expectedBefore)
  const owner = {
      ...current,
      page: f.ownerBefore.page,
      notes: f.ownerBefore.notes,
      captionIssue: f.ownerBefore.captionIssue,
      sourceViewport: f.ownerBefore.sourceViewport
    },
    result = panelRefineHelpers.recoverNativeIndependentCaptionedTables?.(
      owner,
      f.items,
      f.captions,
      f.rules,
      f.runs,
      new Map(f.rulePaintBounds),
      f.sourceGraphics
    ) ?? [owner]
  expect(result).toHaveLength(2)
  expect(result).toEqual(f.expectedTables)
  expect(result.flatMap((t: ReturnType<typeof JSON.parse>) => t.cells)).toHaveLength(36)
  expect(
    result.flatMap((t: ReturnType<typeof JSON.parse>) =>
      t.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
    )
  ).toHaveLength(49)
  expect(f).toEqual(before)
})

const independentCaptionedOutput = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  panelRefineHelpers.recoverNativeIndependentCaptionedTables(
    f.ownerBefore,
    f.items,
    f.captions,
    f.rules,
    f.runs,
    f.rulePaintBounds && new Map(f.rulePaintBounds),
    f.sourceGraphics
  )
const independentSameFont = (
  a: ReturnType<typeof JSON.parse>,
  b: ReturnType<typeof JSON.parse>
): boolean =>
  a.text === b.text && a.rect.every((v: number, n: number) => Math.abs(v - b.rect[n]) < 0.02)
const independentBodyFonts = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse>[] =>
  f.items.filter(
    (i: ReturnType<typeof JSON.parse>) =>
      i.text.trim() && i.rect[1] > 488.874 && i.rect[3] < 535.293
  )
const independentModifyFont = (
  f: ReturnType<typeof fixture>,
  item: ReturnType<typeof JSON.parse>,
  update: (item: ReturnType<typeof JSON.parse>) => void
): void => {
  const original = structuredClone(item),
    owners = f.ownerBefore.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
      .filter((t: ReturnType<typeof JSON.parse>) => independentSameFont(t, original)),
    observed = f.runs.filter((r: ReturnType<typeof JSON.parse>) => independentSameFont(r, original))
  update(item)
  for (const t of owners) {
    const c = f.ownerBefore.cells.find((c: ReturnType<typeof JSON.parse>) =>
        c.sourceTokens.includes(t)
      ),
      n = c.sourceTokens.indexOf(t)
    Object.assign(t, { rect: [...item.rect], baseline: item.baseline, height: item.height })
    c.sourceRects[n] = [...item.rect]
  }
  for (const r of observed)
    Object.assign(r, { rect: [...item.rect], baseline: item.baseline, height: item.height })
}

it.each([
  'missing-caption',
  'duplicate-caption',
  'caption-unprinted-tail',
  'wrong-page-caption',
  'missing-closing',
  'missing-paint',
  'internal-fence',
  'native-vertical-wall',
  'foreign-gutter-font',
  'nonhorizontal-foreign',
  'invalid-source-coordinate',
  'missing-program',
  'competing-program',
  'mixed-program',
  'negative-whole-program',
  'nan-whole-program',
  'body-gutter-crossing',
  'script-divider-crossing',
  'true-blank-field',
  'wrapped-field',
  'wrong-rich-position',
  'duplicate-sourceRects',
  'mixed-field-owner',
  'nonempty-model-slot',
  'notes',
  'prior-parts',
  'reading-rotation',
  'missing-slot',
  'invalid-slot',
  'other-caption-issue',
  'missing-graphics',
  'missing-carrier',
  'duplicate-carrier',
  'phantom-row-image',
  'phantom-row-icon',
  'inflated-carrier',
  'invalid-graphic',
  'invalid-viewport',
  'fractional-viewport',
  'near-carrier-mismatch'
])(
  'refuses unproved independent captioned tables and preserves the complete evidence: %s',
  (control) => {
    const f = fixture('native-independent-captioned-tables'),
      source = independentBodyFonts(f)[0],
      observed = f.runs.find((r: ReturnType<typeof JSON.parse>) => independentSameFont(r, source))
    if (control === 'missing-caption') f.captions.pop()
    if (control === 'duplicate-caption') f.captions.push(structuredClone(f.captions.at(-1)))
    if (control === 'caption-unprinted-tail') f.captions.at(-1).lines.push('Unprinted words')
    if (control === 'wrong-page-caption') f.captions.at(-1).page++
    if (control === 'missing-closing')
      f.rules = f.rules.filter((r: number[]) => !(r[0] > 510 && r[1] > 530 && r[1] < 536))
    if (control === 'missing-paint') f.rulePaintBounds = undefined
    if (control === 'internal-fence') f.rules.push([162, 502.17525, 506.52149963378906, 502.17525])
    if (control === 'native-vertical-wall') f.rules.push([280, 470.4, 280, 535.293])
    if (control === 'foreign-gutter-font')
      f.items.push({
        text: 'x',
        rect: [510, 500, 515, 506],
        baseline: 506,
        height: 6,
        horizontal: true
      })
    if (control === 'nonhorizontal-foreign')
      f.items.push({
        text: 'x',
        rect: [280, 496, 284, 500],
        baseline: 500,
        height: 4,
        horizontal: false
      })
    if (control === 'invalid-source-coordinate') source.rect[0] = NaN
    if (control === 'missing-program')
      f.runs = f.runs.filter((r: ReturnType<typeof JSON.parse>) => r !== observed)
    if (control === 'competing-program')
      f.runs.push({ ...structuredClone(observed), baseline: observed.baseline + 1 })
    if (control === 'mixed-program') observed.glyphRuns[0] = -1
    if (control === 'negative-whole-program') observed.glyphRuns.fill(-1)
    if (control === 'nan-whole-program') observed.glyphRuns.fill(NaN)
    if (control === 'body-gutter-crossing') {
      const next = independentBodyFonts(f)
        .filter((g: ReturnType<typeof JSON.parse>) => g.baseline === source.baseline)
        .sort(
          (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) =>
            a.rect[0] - b.rect[0]
        )[1]
      independentModifyFont(f, source, (i) => {
        i.rect[2] = next.rect[0] + 1
      })
    }
    if (control === 'script-divider-crossing') {
      const child = f.items.find(
        (i: ReturnType<typeof JSON.parse>) =>
          i.height === 7.47195 && i.rect[1] > 470 && i.rect[3] < 490
      )
      independentModifyFont(f, child, (i) => {
        i.rect[3] = 489.874
        i.baseline = 489.874
      })
    }
    if (control === 'true-blank-field') {
      const c = f.ownerBefore.cells.find((c: ReturnType<typeof JSON.parse>) =>
        c.sourceTokens.some((t: ReturnType<typeof JSON.parse>) => independentSameFont(t, source))
      )
      f.items = f.items.filter((i: ReturnType<typeof JSON.parse>) => i !== source)
      f.runs = f.runs.filter((r: ReturnType<typeof JSON.parse>) => r !== observed)
      c.text = ''
      c.sourceTokens = []
      c.sourceRects = []
      delete c.textRuns
      f.ownerBefore.grid[c.row][c.column] = ''
    }
    if (control === 'wrapped-field')
      independentModifyFont(f, independentBodyFonts(f)[1], (i) => {
        i.baseline += 5
        i.rect[1] += 5
        i.rect[3] += 5
      })
    if (control === 'wrong-rich-position')
      f.ownerBefore.cells.find((c: ReturnType<typeof JSON.parse>) =>
        c.textRuns?.some((r: ReturnType<typeof JSON.parse>) => r.position === 'subscript')
      ).textRuns[1].position = 'normal'
    if (control === 'duplicate-sourceRects') {
      const c = f.ownerBefore.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.sourceRects.length > 1
      )
      c.sourceRects[1] = [...c.sourceRects[0]]
    }
    if (control === 'mixed-field-owner') {
      const other = independentBodyFonts(f)[1],
        a = f.ownerBefore.cells.find((c: ReturnType<typeof JSON.parse>) =>
          c.sourceTokens.some((t: ReturnType<typeof JSON.parse>) => independentSameFont(t, source))
        ),
        b = f.ownerBefore.cells.find((c: ReturnType<typeof JSON.parse>) =>
          c.sourceTokens.some((t: ReturnType<typeof JSON.parse>) => independentSameFont(t, other))
        )
      a.sourceTokens.push(...b.sourceTokens)
      a.sourceRects.push(...b.sourceRects)
      a.text += ` ${b.text}`
      f.ownerBefore.grid[a.row][a.column] = a.text
      b.sourceTokens = []
      b.sourceRects = []
      b.text = ''
      f.ownerBefore.grid[b.row][b.column] = ''
    }
    if (control === 'nonempty-model-slot') {
      const c = f.ownerBefore.cells.find(
        (c: ReturnType<typeof JSON.parse>) => !c.sourceTokens.length
      )
      c.text = 'unprinted'
      f.ownerBefore.grid[c.row][c.column] = c.text
    }
    if (control === 'notes') f.ownerBefore.notes = [{ text: 'note' }]
    if (control === 'prior-parts') f.ownerBefore.parts = [{}]
    if (control === 'reading-rotation') f.ownerBefore.readingRotation = 90
    if (control === 'missing-slot') f.ownerBefore.cells.pop()
    if (control === 'invalid-slot') f.ownerBefore.cells[0].column = NaN
    if (control === 'other-caption-issue') f.ownerBefore.captionIssue = 'unknown-caption-owner'
    if (control === 'missing-graphics') f.sourceGraphics = undefined
    if (control === 'missing-carrier')
      f.sourceGraphics = f.sourceGraphics.filter(
        (g: ReturnType<typeof JSON.parse>) =>
          !(g.rect[0] < 510 && g.rect[1] > 530 && g.rect[1] < 536)
      )
    if (control === 'duplicate-carrier')
      f.sourceGraphics.push(
        structuredClone(
          f.sourceGraphics.find((g: ReturnType<typeof JSON.parse>) => g.rect[1] > 460)
        )
      )
    if (control === 'phantom-row-image' || control === 'phantom-row-icon')
      f.sourceGraphics.push({
        kind: control === 'phantom-row-image' ? 'image' : 'path',
        rect: [280, 508, 290, 513]
      })
    if (control === 'inflated-carrier')
      f.sourceGraphics.find((g: ReturnType<typeof JSON.parse>) => g.rect[1] > 460).rect[3] += 10
    if (control === 'invalid-graphic') f.sourceGraphics[0].rect[0] = NaN
    if (control === 'invalid-viewport') f.ownerBefore.sourceViewport.width = Infinity
    if (control === 'fractional-viewport') f.ownerBefore.sourceViewport.width += 1e-10
    if (control === 'near-carrier-mismatch')
      f.sourceGraphics.find((g: ReturnType<typeof JSON.parse>) => g.rect[1] > 460).rect[0] += 0.01
    const before = structuredClone(f)
    expect(independentCaptionedOutput(f)).toBeUndefined()
    expect(f).toEqual(before)
  }
)

it.each([
  'table',
  'items',
  'captions',
  'rules',
  'runs',
  'cell',
  'rich-runs',
  'rich-child',
  'source-token',
  'sourceRects',
  'grid-row',
  'glyphRuns',
  'literalGlyphs',
  'infinite-height',
  'sourceGraphics',
  'graphic',
  'viewport'
])('fails closed for incomplete independent Table evidence containers: %s', (control) => {
  const f = fixture('native-independent-captioned-tables')
  if (control === 'table') f.ownerBefore = null
  if (control === 'items') f.items = null
  if (control === 'captions') f.captions = null
  if (control === 'rules') f.rules = null
  if (control === 'runs') f.runs = null
  if (control === 'cell') f.ownerBefore.cells[0] = null
  if (control === 'rich-runs') f.ownerBefore.cells[0].textRuns = {}
  if (control === 'rich-child') f.ownerBefore.cells[0].textRuns = [null]
  if (control === 'source-token') f.ownerBefore.cells[0].sourceTokens[0] = null
  if (control === 'sourceRects') f.ownerBefore.cells[0].sourceRects = null
  if (control === 'grid-row') f.ownerBefore.grid[0] = null
  if (control === 'sourceGraphics') f.sourceGraphics = null
  if (control === 'graphic') f.sourceGraphics[0] = null
  if (control === 'viewport') f.ownerBefore.sourceViewport = null
  const source = f.items && independentBodyFonts(f)[0],
    observed =
      source && f.runs?.find((r: ReturnType<typeof JSON.parse>) => independentSameFont(r, source))
  if (control === 'glyphRuns') observed.glyphRuns = null
  if (control === 'literalGlyphs') observed.literalGlyphs = null
  if (control === 'infinite-height')
    independentModifyFont(f, source, (i) => {
      i.height = Infinity
    })
  const before = structuredClone(f)
  expect(independentCaptionedOutput(f)).toBeUndefined()
  expect(f).toEqual(before)
})

it('keeps independent tables exact under reversed source traversal', () => {
  const f = fixture('native-independent-captioned-tables')
  f.items.reverse()
  f.rules.reverse()
  f.runs.reverse()
  f.captions.reverse()
  expect(independentCaptionedOutput(f)).toEqual(f.expectedTables)
})

it('preserves original ligature groups while proving their complete expanded literal program', () => {
  const f = fixture('native-independent-captioned-tables'),
    before = structuredClone(f)
  expect(
    f.runs.some((r: ReturnType<typeof JSON.parse>) =>
      r.literalGlyphs.some((g: string) => [...g].length > 1)
    )
  ).toBe(true)
  expect(independentCaptionedOutput(f)).toEqual(f.expectedTables)
  expect(f).toEqual(before)
})

it('restores calibrated ordinary wrapped leaves without replacing any correct record or header', () => {
  const f = fixture('native-calibrated-wrapped-leaf-owners'),
    before = structuredClone(f),
    result = run(f)
  expect(result).toEqual(f.expectedResult)
  for (const cell of f.retainedCells)
    expect(
      result.cells.find(
        (c: { row: number; column: number }) => c.row === cell.row && c.column === cell.column
      )
    ).toEqual(cell)
  for (const token of f.expectedBefore.cells.flatMap(
    (c: { sourceTokens: unknown[] }) => c.sourceTokens
  ))
    expect(result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)).toContainEqual(
      token
    )
  expect(f).toEqual(before)
})

const wrappedRecordText =
  (f: ReturnType<typeof fixture>) =>
  (tokens: { text: string; rect: number[] }[]): string => {
    const candidates = [...f.expectedBefore.cells, ...f.expectedResult.cells]
    return (
      candidates.find(
        (cell: ReturnType<typeof JSON.parse>) =>
          cell.sourceTokens.length === tokens.length &&
          cell.sourceTokens.every((t: { text: string; rect: number[] }) =>
            tokens.some(
              (i) => i.text === t.text && JSON.stringify(i.rect) === JSON.stringify(t.rect)
            )
          )
      )?.text ?? tokens.map((i) => i.text).join(' ')
    )
  }

it('proves the full source continuation partition using a readonly local serializer', () => {
  const f = fixture('native-calibrated-wrapped-leaf-owners'),
    table = structuredClone(f.expectedBefore),
    before = structuredClone(f),
    original = structuredClone(table),
    proof = proveNativeCalibratedWrappedLeafOwners(
      table,
      f.items,
      f.captions,
      f.rules,
      f.runs,
      wrappedRecordText(f)
    )
  expect(
    proof?.replacements.map((p: ReturnType<typeof JSON.parse>) => [p.cell.row, p.cell.column])
  ).toEqual(f.changedSlots)
  for (const p of proof.replacements)
    expect(p.replacement).toEqual(
      f.expectedResult.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === p.cell.row && c.column === p.cell.column
      )
    )
  expect(table).toEqual(original)
  expect(f).toEqual(before)
})

const nativeFixtureOrigins = (
  items: ReturnType<typeof JSON.parse>[],
  tokens: ReturnType<typeof JSON.parse>[]
): ReturnType<typeof JSON.parse>[] => {
  const origins = tokens.map((token) => {
    const matches = items.filter(
      (item) =>
        item.text === token.text &&
        item.rect.every((v: number, n: number) => Math.abs(v - token.rect[n]) < 0.02)
    )
    expect(matches).toHaveLength(1)
    return matches[0].sourceItem
  })
  return [
    ...new Map(origins.map((origin) => [`${origin.pageNumber}:${origin.index}`, origin])).values()
  ].sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
}

it.each([
  'native-calibrated-wrapped-leaf-owners',
  'native-fenced-merged-records',
  'fenced-two-line-native-stubs',
  'terminal-complete-ordinary-peer-records',
  'single-ordinary-record',
  'terminal-literal-peers',
  'fenced-multiline-stub-owners',
  'fenced-paired-native-records'
])('retains exact native origins after changing complete record owners: %s', (kind) => {
  const f =
    kind === 'single-ordinary-record'
      ? singleOrdinaryLeafRecord()
      : kind === 'terminal-literal-peers'
        ? terminalLiteralPeers()
        : fixture(kind)
  const baseline = refineTable(
    f.table,
    f.items,
    f.captions,
    f.notes ?? [],
    f.rules,
    f.runs,
    undefined,
    f.paint ? new Map(f.paint) : undefined
  )
  for (const [index, item] of f.items.entries())
    item.sourceItem = { pageNumber: 1, index, text: item.text }
  const before = structuredClone(f)
  const result = refineTable(
    f.table,
    f.items,
    f.captions,
    f.notes ?? [],
    f.rules,
    f.runs,
    undefined,
    f.paint ? new Map(f.paint) : undefined
  )
  const expectedGrid =
    kind === 'single-ordinary-record'
      ? f.expectedGrid
      : kind === 'terminal-complete-ordinary-peer-records'
        ? middleOrdinarySourceOracle(f).expected.grid
        : kind === 'fenced-two-line-native-stubs'
          ? undefined
          : [
                'terminal-literal-peers',
                'fenced-multiline-stub-owners',
                'fenced-paired-native-records'
              ].includes(kind)
            ? f.expectedGrid
            : f.expectedResult.grid
  if (expectedGrid) expect(result.grid).toEqual(expectedGrid)
  if (kind === 'fenced-two-line-native-stubs')
    expect(result.repairs).toContain('native-fenced-two-line-stub-owners-recovered')
  for (const cell of result.cells)
    if (cell.sourceTokens.length)
      expect(cell.sourceItems).toEqual(nativeFixtureOrigins(f.items, cell.sourceTokens))
    else expect(cell.sourceItems).toBeUndefined()
  const withoutOrigins = (value: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
    JSON.parse(
      JSON.stringify(value, (key, data) =>
        ['sourceItem', 'sourceItems'].includes(key) ? undefined : data
      )
    )
  expect(withoutOrigins(result)).toEqual(withoutOrigins(baseline))
  expect(f).toEqual(before)
})

it.each(['conflicting origin', 'duplicate origin', 'opaque origin', 'missing continuation origin'])(
  'refuses changing complete owners with %s',
  (kind) => {
    const f = fixture('native-calibrated-wrapped-leaf-owners')
    for (const [index, item] of f.items.entries())
      item.sourceItem = { pageNumber: 1, index, text: item.text }
    const table = structuredClone(f.expectedBefore)
    for (const cell of table.cells)
      if (cell.sourceTokens.length)
        cell.sourceItems = nativeFixtureOrigins(f.items, cell.sourceTokens)
    const [row, column] = f.changedSlots[0]
    const donor = table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === row && c.column === column
    )
    if (kind === 'conflicting origin')
      donor.sourceItems[0] = { ...donor.sourceItems[0], text: 'Another original item' }
    if (kind === 'duplicate origin') donor.sourceItems.push({ ...donor.sourceItems[0] })
    if (kind === 'opaque origin')
      donor.sourceItems[0] = { ...donor.sourceItems[0], unprovedOpaque: true }
    if (kind === 'missing continuation origin') {
      const expected = f.expectedResult.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === row && c.column === column
      )
      const absent = expected.sourceTokens.find(
        (token: ReturnType<typeof JSON.parse>) =>
          !donor.sourceTokens.some(
            (t: ReturnType<typeof JSON.parse>) =>
              t.text === token.text && JSON.stringify(t.rect) === JSON.stringify(token.rect)
          )
      )
      delete f.items.find(
        (item: ReturnType<typeof JSON.parse>) =>
          item.text === absent.text && JSON.stringify(item.rect) === JSON.stringify(absent.rect)
      ).sourceItem
    }
    const before = structuredClone({ f, table })
    expect(
      proveNativeCalibratedWrappedLeafOwners(
        table,
        f.items,
        f.captions,
        f.rules,
        f.runs,
        wrappedRecordText(f)
      )
    ).toBeUndefined()
    expect({ f, table }).toEqual(before)
  }
)

const wrappedSourceRefusals = [
  'missing-caption',
  'competing-caption',
  'missing-closing-segment',
  'competing-closing-family',
  'missing-anchor',
  'font-crosses-gutter',
  'distinct-continuation-start',
  'next-record-baseline',
  'duplicate-font',
  'stale-observed-baseline',
  'competing-observed-program',
  'foreign-rotated-font',
  'invalid-source-box',
  'unobserved-fullfont',
  'rotation'
]
const mutateWrappedSource = (f: ReturnType<typeof fixture>, kind: string): void => {
  const target = f.items.find((i: ReturnType<typeof JSON.parse>) => i.text === '9.864%'),
    run = f.runs.find(
      (r: ReturnType<typeof JSON.parse>) =>
        r.text === target.text && JSON.stringify(r.rect) === JSON.stringify(target.rect)
    ),
    closing = Math.max(...f.rules.map((r: number[]) => r[1]))
  if (kind === 'missing-caption') f.captions = []
  if (kind === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
  if (kind === 'missing-closing-segment')
    f.rules = f.rules.filter((r: number[]) => !(r[1] === closing && r[0] < 60))
  if (kind === 'competing-closing-family')
    f.rules.push(
      ...f.rules
        .filter((r: number[]) => r[1] === closing)
        .map((r: number[]) => [r[0], r[1] + 2, r[2], r[3] + 2])
    )
  if (kind === 'missing-anchor') {
    const anchor = f.items.find((i: ReturnType<typeof JSON.parse>) => i.text === '70.8%')
    f.items = f.items.filter((i: ReturnType<typeof JSON.parse>) => i !== anchor)
    f.runs = f.runs.filter(
      (r: ReturnType<typeof JSON.parse>) =>
        !(r.text === anchor.text && JSON.stringify(r.rect) === JSON.stringify(anchor.rect))
    )
  }
  if (kind === 'font-crosses-gutter') {
    target.rect[2] =
      f.expectedBefore.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 2
      ).rect[2] + 1
    run.rect = [...target.rect]
  }
  if (kind === 'distinct-continuation-start') {
    target.rect[0] += 1
    run.rect = [...target.rect]
  }
  if (kind === 'next-record-baseline') {
    const delta = 232.41000000000008 - target.baseline
    target.baseline += delta
    target.rect[1] += delta
    target.rect[3] += delta
    run.baseline = target.baseline
    run.rect = [...target.rect]
  }
  if (kind === 'duplicate-font') f.items.push(structuredClone(target))
  if (kind === 'stale-observed-baseline') run.baseline += 1
  if (kind === 'competing-observed-program')
    f.runs.push({ ...structuredClone(run), height: run.height + 1 })
  if (kind === 'foreign-rotated-font')
    f.items.push({
      text: 'x',
      inlineSymbol: false,
      rect: [720, 195, 722, 198],
      height: 3,
      baseline: 198,
      horizontal: false
    })
  if (kind === 'invalid-source-box') target.rect[0] = NaN
  if (kind === 'unobserved-fullfont')
    f.runs = f.runs.filter((r: ReturnType<typeof JSON.parse>) => r !== run)
  if (kind === 'rotation') f.table.readingRotation = 90
}
for (const kind of wrappedSourceRefusals) {
  it(`refuses incomplete source evidence for calibrated wrapped leaves: ${kind}`, () => {
    const f = fixture('native-calibrated-wrapped-leaf-owners'),
      table = structuredClone(f.expectedBefore)
    mutateWrappedSource(f, kind)
    if (kind === 'rotation') table.readingRotation = f.table.readingRotation
    const before = structuredClone({ f, table })
    expect(
      proveNativeCalibratedWrappedLeafOwners(
        table,
        f.items,
        f.captions,
        f.rules,
        f.runs,
        wrappedRecordText(f)
      )
    ).toBeUndefined()
    expect({ f, table }).toEqual(before)
  })
}
for (const kind of wrappedSourceRefusals.filter((k) => k !== 'invalid-source-box')) {
  it(`keeps the final wrapped repair closed without complete proof: ${kind}`, () => {
    const f = fixture('native-calibrated-wrapped-leaf-owners')
    mutateWrappedSource(f, kind)
    const before = structuredClone(f),
      result = run(f)
    expect(result.repairs).not.toContain('native-calibrated-wrapped-leaf-owners-recovered')
    expect(f).toEqual(before)
  })
}
for (const kind of [
  'missing-slot',
  'out-of-range-row',
  'out-of-range-column',
  'fractional-row',
  'duplicate-slot',
  'missing-token-array',
  'missing-rect-array',
  'duplicate-sourceRect',
  'missing-sourceRect',
  'calibration-not-owned',
  'existing-script',
  'true-blank',
  'missing-serializer',
  'existing-normal-donor-runs',
  'stale-normal-peer-run'
]) {
  it(`rejects malformed existing owners before accessing wrapped slots: ${kind}`, () => {
    const f = fixture('native-calibrated-wrapped-leaf-owners'),
      table = structuredClone(f.expectedBefore),
      peer = table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 3 && c.column === 1),
      donor = table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 2)
    if (kind === 'missing-slot') table.cells.shift()
    if (kind === 'out-of-range-row') peer.row = table.grid.length
    if (kind === 'out-of-range-column') peer.column = table.grid[0].length
    if (kind === 'fractional-row') peer.row = 1.5
    if (kind === 'duplicate-slot') peer.row = 2
    if (kind === 'missing-token-array') delete peer.sourceTokens
    if (kind === 'missing-rect-array') delete peer.sourceRects
    if (kind === 'duplicate-sourceRect') peer.sourceRects[1] = structuredClone(peer.sourceRects[0])
    if (kind === 'missing-sourceRect') peer.sourceRects.pop()
    if (kind === 'calibration-not-owned') {
      const missing = peer.sourceTokens.pop()
      peer.sourceRects.pop()
      peer.text = peer.sourceTokens[0].text
      table.grid[peer.row][peer.column] = peer.text
      table.unassigned.push(missing.text)
    }
    if (kind === 'existing-script') peer.textRuns = [{ text: peer.text, position: 'superscript' }]
    if (kind === 'true-blank') {
      peer.text = ''
      peer.sourceTokens = []
      peer.sourceRects = []
      table.grid[peer.row][peer.column] = ''
    }
    if (kind === 'existing-normal-donor-runs')
      donor.textRuns = [{ text: donor.text, position: 'normal' }]
    if (kind === 'stale-normal-peer-run') peer.textRuns = [{ text: 'stale', position: 'normal' }]
    const before = structuredClone(table)
    expect(
      proveNativeCalibratedWrappedLeafOwners(
        table,
        f.items,
        f.captions,
        f.rules,
        f.runs,
        kind === 'missing-serializer' ? undefined : wrappedRecordText(f)
      )
    ).toBeUndefined()
    expect(table).toEqual(before)
  })
}

it('splits only the merged records inside a fully fenced ordinary group', () => {
  const f = fixture('native-fenced-merged-records')
  const before = structuredClone(f)
  const result = run(f)
  expect(result?.grid).toEqual(f.expectedResult.grid)
  expect(result).toEqual(f.expectedResult)
  expect(f).toEqual(before)
})

for (const kind of [
  'missing-caption',
  'competing-caption',
  'missing-footer',
  'crossing-group-fence',
  'missing-field',
  'missing-header',
  'duplicate-font',
  'foreign-rotated-font',
  'body-crosses-cut',
  'true-wrapped-continuation',
  'program-baseline',
  'program-height',
  'program-glyph',
  'competing-program',
  'multiple-source-programs',
  'rotation'
]) {
  it(`refuses a merged fenced record without complete source proof: ${kind}`, () => {
    const f = fixture('native-fenced-merged-records')
    const target = f.items.find((i: ReturnType<typeof JSON.parse>) => i.text === '14')
    const run = f.runs.find(
      (r: ReturnType<typeof JSON.parse>) =>
        r.text === target.text && JSON.stringify(r.rect) === JSON.stringify(target.rect)
    )
    if (kind === 'missing-caption') f.captions = []
    if (kind === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
    if (kind === 'missing-footer') f.rules.pop()
    if (kind === 'crossing-group-fence') f.rules[2] = [f.rules[2][0], 480, f.rules[2][2], 480]
    if (kind === 'missing-field') {
      f.items = f.items.filter((i: ReturnType<typeof JSON.parse>) => i !== target)
      f.runs = f.runs.filter((r: ReturnType<typeof JSON.parse>) => r !== run)
    }
    if (kind === 'missing-header')
      f.items = f.items.filter((i: ReturnType<typeof JSON.parse>) => i.text !== 'Method')
    if (kind === 'duplicate-font') f.items.push(structuredClone(target))
    if (kind === 'foreign-rotated-font')
      f.items.push({
        ...target,
        text: 'foreign',
        horizontal: false,
        rect: [400, 493, 410, 498],
        baseline: 498,
        height: 5
      })
    if (kind === 'body-crosses-cut') {
      target.rect[0] = 380
      run.rect = [...target.rect]
    }
    if (kind === 'true-wrapped-continuation') {
      const gone = f.items.filter(
        (i: ReturnType<typeof JSON.parse>) =>
          Math.abs(i.baseline - target.baseline) < 0.02 && i.rect[0] > 380
      )
      f.items = f.items.filter((i: ReturnType<typeof JSON.parse>) => !gone.includes(i))
      f.runs = f.runs.filter(
        (r: ReturnType<typeof JSON.parse>) =>
          !gone.some(
            (i: ReturnType<typeof JSON.parse>) => JSON.stringify(i.rect) === JSON.stringify(r.rect)
          )
      )
    }
    if (kind === 'program-baseline') run.baseline += 1
    if (kind === 'program-height') run.height += 1
    if (kind === 'program-glyph') run.literalGlyphs.pop()
    if (kind === 'competing-program')
      f.runs.push({ ...structuredClone(run), height: run.height + 1 })
    if (kind === 'multiple-source-programs') run.glyphRuns[0] = Math.max(...run.glyphRuns) + 1
    if (kind === 'rotation') f.table.readingRotation = 90
    const before = structuredClone(f),
      result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
    expect(result.repairs).not.toContain('native-fenced-merged-records-recovered')
    expect(f).toEqual(before)
  })
}

for (const kind of [
  'duplicate-owner-box',
  'missing-owner-box',
  'stale-owner',
  'peer-fullfont-outside-cell',
  'crossing-owner-span',
  'rich-owner',
  'malformed-owner-box',
  'no-complete-calibration'
]) {
  it(`rejects damaged old owners for merged fenced records: ${kind}`, () => {
    const f = fixture('native-fenced-merged-records'),
      table = structuredClone(f.expectedBefore)
    const peer = table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 3 && c.column === 2
    )
    if (kind === 'duplicate-owner-box') {
      const donor = table.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 2
      )
      donor.sourceRects[1] = [...donor.sourceRects[0]]
    }
    if (kind === 'missing-owner-box') peer.sourceRects = []
    if (kind === 'stale-owner') peer.sourceTokens[0].baseline += 1
    if (kind === 'peer-fullfont-outside-cell') peer.rect[0] = peer.sourceTokens[0].rect[0] + 1
    if (kind === 'crossing-owner-span') peer.rowSpan = 2
    if (kind === 'rich-owner') peer.textRuns = [{ text: peer.text, position: 'superscript' }]
    if (kind === 'malformed-owner-box') peer.sourceRects[0] = null
    if (kind === 'no-complete-calibration') {
      const rows = table.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row > 1),
        first = table.rows[2],
        last = table.rows[4],
        rect = [first.rect[0], first.rect[1], first.rect[2], last.rect[3]]
      table.cells = table.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row <= 1)
      for (let column = 0; column < 5; column++) {
        const donors = rows
            .filter((c: ReturnType<typeof JSON.parse>) => c.column === column)
            .sort(
              (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) => a.row - b.row
            ),
          tokens = donors.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
        table.cells.push({
          ...donors[0],
          row: 2,
          rowSpan: 1,
          rect: [donors[0].rect[0], rect[1], donors[0].rect[2], rect[3]],
          text: tokens.map((t: ReturnType<typeof JSON.parse>) => t.text).join(' '),
          sourceTokens: tokens,
          sourceRects: tokens.map((t: ReturnType<typeof JSON.parse>) => t.rect)
        })
      }
      table.grid.splice(
        2,
        3,
        table.cells
          .filter((c: ReturnType<typeof JSON.parse>) => c.row === 2)
          .map((c: ReturnType<typeof JSON.parse>) => c.text)
      )
      table.rows.splice(2, 3, { ...first, rect })
    }
    const before = structuredClone(table)
    expect(
      proveNativeFencedMergedRecordOwners(table, f.items, f.captions, f.rules, f.runs)
    ).toBeUndefined()
    expect(table).toEqual(before)
  })
}

// One ordinary source record and four independently printed header faces.
// Native rule paint, rather than the detector's narrower crop, owns the right edge.
const singleOrdinaryLeafRecord = (): ReturnType<typeof JSON.parse> => {
  const text = [
    'Metric',
    'CohortA',
    'CohortB',
    'All versions',
    'Score weighted',
    '0.1234',
    '0.2345',
    '0.3456'
  ]
  const boxes = [
    [299.0565, 648.6141, 338.8969374, 663.558],
    [419.4893901, 648.6141, 463.4991756, 663.558],
    [481.4318556, 648.6141, 531.2398743, 663.558],
    [549.1725543, 648.6141, 618.9456234, 663.558],
    [299.0565, 672.7851, 401.5567101, 687.729],
    [420.9389484, 672.7851, 462.0346734, 687.729],
    [485.7805305, 672.7851, 526.8762555, 687.729],
    [563.5037544, 672.7851, 604.5994794, 687.729]
  ]
  const items = boxes.map((rect, n) => ({
    text: text[n],
    rect,
    baseline: rect[3],
    height: 14.9439,
    horizontal: true,
    inlineSymbol: false
  }))
  const rules = [647.1345, 671.5305, 695.9265].map((y) => [290.0895, y, 627.9089961547852, y])
  const paint = rules.map((r, n) => [
    r.join(','),
    [r[0], r[1] - (n === 1 ? 0.3735 : 0.59775), r[2], r[3] + (n === 1 ? 0.3735 : 0.59775)]
  ])
  const table = {
    id: 'anonymous-single-record',
    readingRotation: 0,
    cropRect: [285, 644, 622, 706],
    rowCount: 1,
    columnCount: 3,
    spans: [],
    structure: {
      objects: [
        ...[
          [13.0924130082, 28.1485540867, 124.9914436936, 46.8656611443],
          [188.7833193094, 28.6659944654, 258.7206453532, 46.6230985522],
          [258.4688677937, 28.0740160942, 318.4981959909, 46.338958025]
        ].map((rect) => ({ label: 'table column', rect, score: 0.9 })),
        {
          label: 'table row',
          rect: [13.6841590703, 28.2221663594, 317.4182260334, 47.5328463912],
          score: 0.9
        }
      ]
    }
  }
  const runs = items.map((i) => ({
    text: i.text,
    rect: [...i.rect],
    baseline: i.baseline,
    height: i.height,
    literalGlyphs: [...i.text.replace(/\s/gu, '')],
    glyphRuns: [...i.text.replace(/\s/gu, '')].map(() => 0),
    gaps: []
  }))
  return {
    table,
    items,
    rules,
    runs,
    paint,
    captions: [
      {
        page: 1,
        lines: ['Table 4: A single ordinary record.'],
        rect: [257.019, 616.4016, 660.97971015, 631.3455]
      }
    ],
    expectedGrid: [text.slice(0, 4), text.slice(4)]
  }
}

it('recovers one fully painted ordinary record into its independent native leaves', () => {
  const f = singleOrdinaryLeafRecord(),
    before = structuredClone(f)
  const result = refineTable(
    f.table,
    f.items,
    f.captions,
    [],
    f.rules,
    f.runs,
    undefined,
    new Map(f.paint)
  )
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.cells).toHaveLength(8)
  expect(
    result.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
      .map((t: ReturnType<typeof JSON.parse>) => [t.text, t.rect, t.baseline, t.height])
      .sort()
  ).toEqual(
    f.items.map((t: ReturnType<typeof JSON.parse>) => [t.text, t.rect, t.baseline, t.height]).sort()
  )
  expect(result.cropRect).toEqual([285, 644, 628.4089961547852, 706])
  expect(result.unassigned).toEqual([])
  expect(result.clipped).toEqual([])
  expect(f).toEqual(before)
})

for (const mode of [
  'missing-paint',
  'missing-caption',
  'competing-caption',
  'missing-footer',
  'competing-edge',
  'missing-body-field',
  'duplicate-font',
  'program-baseline',
  'program-height',
  'competing-program',
  'program-glyph',
  'whole-font-gutter',
  'foreign-rotated-font',
  'foreign-expansion-font',
  'incomplete-painted-edge',
  'wrapped-extra-font',
  'reading-rotation',
  'malformed-font'
] as const) {
  it(`refuses one painted ordinary record without full independent ownership: ${mode}`, () => {
    const f = singleOrdinaryLeafRecord()
    let paint: Map<string, number[]> | undefined = new Map(f.paint)
    if (mode === 'missing-paint') paint = undefined
    if (mode === 'missing-caption') f.captions = []
    if (mode === 'competing-caption')
      f.captions.push({ ...f.captions[0], lines: ['Table 5: Another owner.'] })
    if (mode === 'missing-footer') f.rules.pop()
    if (mode === 'competing-edge') f.rules.push([290.0895, 694, 627.9089961547852, 694])
    if (mode === 'missing-body-field') {
      f.items.pop()
      f.runs.pop()
    }
    if (mode === 'duplicate-font') {
      f.items.push(structuredClone(f.items[5]))
      f.runs.push(structuredClone(f.runs[5]))
    }
    if (mode === 'program-baseline') f.runs[5].baseline += 0.1
    if (mode === 'program-height') f.runs[5].height += 0.1
    if (mode === 'competing-program')
      f.runs.push({ ...structuredClone(f.runs[5]), baseline: f.runs[5].baseline + 1 })
    if (mode === 'program-glyph') f.runs[5].literalGlyphs.pop()
    if (mode === 'whole-font-gutter') {
      f.items[4].rect[2] = 421
      f.runs[4].rect[2] = 421
    }
    if (mode === 'foreign-rotated-font')
      f.items.push({
        text: 'x',
        rect: [410, 673, 413, 687],
        baseline: 687,
        height: 14,
        horizontal: false
      })
    if (mode === 'foreign-expansion-font')
      f.items.push({
        text: 'x',
        rect: [628.1, 681, 628.4, 685],
        baseline: 685,
        height: 4,
        horizontal: true
      })
    if (mode === 'incomplete-painted-edge')
      paint?.set(f.rules[0].join(','), [291, 646.53675, 627, 647.73225])
    if (mode === 'wrapped-extra-font') {
      f.items.push({
        ...f.items[4],
        text: 'continued',
        rect: [299, 690, 360, 695],
        baseline: 695,
        height: 5
      })
      f.runs.push({
        ...f.runs[4],
        text: 'continued',
        rect: [299, 690, 360, 695],
        baseline: 695,
        height: 5
      })
    }
    if (mode === 'reading-rotation') f.table.readingRotation = 90
    if (mode === 'malformed-font') f.items[3].rect[0] = NaN
    const before = structuredClone(f),
      result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs, undefined, paint)
    expect(result.repairs).not.toContain('native-single-ordinary-record-leaves-recovered')
    expect(f).toEqual(before)
  })
}

it('preserves legacy seven-argument behavior and the shared painted evidence', () => {
  const f = singleOrdinaryLeafRecord(),
    paint = new Map<string, number[]>(f.paint),
    before = structuredClone(paint)
  const legacy = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
  expect(legacy.grid[0]).toEqual(['Metric CohortA', 'CohortB', 'All versions'])
  refineTable(f.table, f.items, f.captions, [], f.rules, f.runs, undefined, paint)
  expect(paint).toEqual(before)
})

for (const mode of [
  'duplicate-owner-rect',
  'missing-owner-rect',
  'stale-owner-text',
  'rich-owner',
  'malformed-owner-rect',
  'missing-owner-token'
] as const) {
  it(`refuses malformed single ordinary leaf donors: ${mode}`, () => {
    const f = singleOrdinaryLeafRecord(),
      owner = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
    const cell = owner.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 0
    )
    if (mode === 'duplicate-owner-rect') cell.sourceRects[1] = [...cell.sourceRects[0]]
    if (mode === 'missing-owner-rect') cell.sourceRects.pop()
    if (mode === 'stale-owner-text') cell.text += 'z'
    if (mode === 'rich-owner') cell.textRuns = [{ text: cell.text, position: 'superscript' }]
    if (mode === 'malformed-owner-rect') cell.sourceRects[0] = null
    if (mode === 'missing-owner-token') cell.sourceTokens.pop()
    const before = structuredClone(owner)
    expect(
      proveNativeSingleOrdinaryRecordOwners(
        owner,
        f.items,
        f.captions,
        f.rules,
        f.runs,
        new Map(f.paint)
      )
    ).toBeUndefined()
    expect(owner).toEqual(before)
  })
}

// Anonymous closed native frame: six ordinary eight-leaf records, each with
// complete upper/lower glyph programs. The middle rule is a shared row edge.
const completeScriptRecords = (): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = []
  const token = (
    text: string,
    x: number,
    baseline: number,
    width: number,
    height = 12
  ): ReturnType<typeof JSON.parse> => {
    const item = {
      text,
      rect: [x, baseline - height, x + width, baseline],
      height,
      baseline,
      horizontal: true
    }
    items.push(item)
    return item
  }
  const headings = Array.from({ length: 8 }, (_, c) => token(`Leaf${c + 1}`, 140 + c * 90, 138, 30))
  const expectedCells: ReturnType<typeof JSON.parse>[] = []
  for (let r = 0; r < 6; r++)
    for (let c = 0; c < 8; c++) {
      const x = 140 + c * 90,
        baseline = 168 + r * 23
      const base = token(`${r + 1}.${c + 1}0`, x, baseline, 24)
      const upper = [
        token('+', x + 24.6, baseline - 4, 4, 9),
        token('0.1', x + 28.6, baseline - 4, 10, 9)
      ]
      const lower = [
        token('−', x + 24.6, baseline + 5, 4, 9),
        token('0.2', x + 28.6, baseline + 5, 10, 9)
      ]
      const textRuns = [
        { text: base.text, position: 'normal' },
        { text: '+0.1', position: 'superscript' },
        { text: '−0.2', position: 'subscript' }
      ]
      expectedCells.push({
        row: r + 1,
        column: c,
        rowSpan: 1,
        colSpan: 1,
        text: textRuns.map((t) => t.text).join(''),
        textRuns,
        sourceTokens: [base, ...upper, ...lower].map(({ text, rect, height, baseline }) => ({
          text,
          rect,
          height,
          baseline
        })),
        sourceRects: [base, ...upper, ...lower].map((t) => t.rect)
      })
    }
  const crop = [128, 113, 852, 304]
  const columns = Array.from({ length: 8 }, (_, c) => [
    128 + c * 90.5,
    113,
    128 + (c + 1) * 90.5,
    304
  ])
  const rowEdges = [118, 150, 181.5, 204.5, 225.5, 250.5, 273.5, 302]
  const modelRows = rowEdges.slice(1).map((bottom, n) => [130, rowEdges[n], 850, bottom])
  // A wrong retained empty prediction band overlaps the fourth complete record.
  modelRows.splice(4, 0, [130, 225, 850, 242])
  const object = (label: string, rect: number[]): ReturnType<typeof JSON.parse> => ({
    label,
    score: 1,
    rect: rect.map((v, n) => v - crop[n % 2])
  })
  const runs = items.map((i) => ({
    ...i,
    literalGlyphs: [...i.text.replace(/\s/gu, '')],
    glyphRuns: [...i.text.replace(/\s/gu, '')].map(() => 100),
    gaps: []
  }))
  return {
    items,
    runs,
    rules: [115, 118, 150, 221.5, 302].map((y) => [130, y, 850, y]),
    captions: [{ page: 1, lines: ['Table 1. Native records'], rect: [130, 86, 320, 98] }],
    table: {
      id: 'anonymous-script-records',
      readingRotation: 0,
      detection: { label: 'table', score: 1, rect: [130, 115, 850, 302] },
      cropRect: crop,
      structure: {
        objects: [
          ...modelRows.map((r) => object('table row', r)),
          ...columns.map((c) => object('table column', c)),
          object('table column header', [130, 118, 850, 150])
        ]
      },
      rowCount: modelRows.length,
      columnCount: 8,
      spans: [],
      grid: [],
      unassigned: []
    },
    expectedCells,
    expectedGrid: [
      headings.map((i) => i.text),
      ...Array.from({ length: 6 }, (_, r) =>
        expectedCells.filter((c) => c.row === r + 1).map((c) => c.text)
      )
    ]
  }
}

it('recovers complete native script records and removes only the proved empty prediction artifact', () => {
  const f = completeScriptRecords(),
    before = structuredClone(f)
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs, null)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.cells).toHaveLength(56)
  expect(result.unassigned).toEqual([])
  for (const expected of f.expectedCells) {
    const cell = result.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === expected.row && c.column === expected.column
    )
    expect(cell).toMatchObject(expected)
  }
  expect(result.cropRect).toEqual(f.table.cropRect)
  expect(f).toEqual(before)
})

for (const [scale, dx, dy] of [
  [1, 17, 23],
  [0.5, 0, 0]
]) {
  it(`keeps complete native script owners at scale ${scale} and offset ${dx}`, () => {
    const f = completeScriptRecords(),
      seen = new Set<number[]>()
    const transform = (rect: number[]): void => {
      if (seen.has(rect)) return
      seen.add(rect)
      for (let n = 0; n < 4; n++) rect[n] = rect[n] * scale + (n % 2 ? dy : dx)
    }
    for (const font of [
      ...f.items,
      ...f.runs,
      ...f.expectedCells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
    ]) {
      transform(font.rect)
      font.baseline = font.baseline * scale + dy
      font.height *= scale
    }
    for (const cell of f.expectedCells) for (const rect of cell.sourceRects) transform(rect)
    for (const rule of f.rules) transform(rule)
    for (const caption of f.captions) transform(caption.rect)
    transform(f.table.cropRect)
    transform(f.table.detection.rect)
    for (const object of f.table.structure.objects)
      object.rect = object.rect.map((v: number) => v * scale)
    const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs, null)
    expect(result.grid).toEqual(f.expectedGrid)
    for (const expected of f.expectedCells)
      expect(
        result.cells.find(
          (c: ReturnType<typeof JSON.parse>) =>
            c.row === expected.row && c.column === expected.column
        )
      ).toMatchObject(expected)
    expect(result.cropRect).toEqual(f.table.cropRect)
    expect(result.unassigned).toEqual([])
  })
}

const misownedScriptRecords = (): ReturnType<typeof JSON.parse> => {
  const f = completeScriptRecords()
  const table = structuredClone(
    refineTable(f.table, f.items, f.captions, [], f.rules, f.runs, null)
  )
  const first = table.cells.find(
    (c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 0
  )
  const second = table.cells.find(
    (c: ReturnType<typeof JSON.parse>) => c.row === 2 && c.column === 0
  )
  first.row = 2
  second.row = 1
  return { ...f, table }
}

it('refuses projection for already complete native row and script owners', () => {
  const f = completeScriptRecords()
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs, null)
  const before = structuredClone(result)
  expect(
    proveNativeCompleteOrdinaryRecordOwners(result, f.items, f.captions, f.rules, f.runs)
  ).toBeUndefined()
  expect(result).toEqual(before)
  const wrong = misownedScriptRecords()
  expect(
    proveNativeCompleteOrdinaryRecordOwners(
      wrong.table,
      wrong.items,
      wrong.captions,
      wrong.rules,
      wrong.runs
    )?.groups
  ).toHaveLength(7)
})

for (const mode of [
  'missing-program',
  'incomplete-program',
  'wrong-program-baseline',
  'nonfinite-program-height',
  'missing-closing',
  'missing-double-opening',
  'missing-middle-fence',
  'middle-rule-crosses-font',
  'competing-caption',
  'rotation',
  'incomplete-header-owner',
  'header-span',
  'crossing-whole-font',
  'distinct-same-cell-parent-ambiguity',
  'nonterminal-native-script-parent',
  'leading-isotope-script',
  'nonadjacent-script',
  'clipped-native-script-box',
  'displaced-native-script-baseline',
  'second-upper-rail',
  'foreign-font-after-closing',
  'extra-unassigned'
]) {
  it(`refuses complete script record projection with ${mode}`, () => {
    const f = misownedScriptRecords()
    const base = f.items.find((i: ReturnType<typeof JSON.parse>) => i.text === '1.10')
    const upper = f.items.filter(
      (i: ReturnType<typeof JSON.parse>) => i.baseline === 164 && i.rect[0] < 180
    )
    const sync = (
      font: ReturnType<typeof JSON.parse>,
      mutate: (target: ReturnType<typeof JSON.parse>) => void
    ): void => {
      const before = structuredClone(font)
      const program = f.runs.find(
        (p: ReturnType<typeof JSON.parse>) =>
          p.text === before.text && JSON.stringify(p.rect) === JSON.stringify(before.rect)
      )
      const cell = f.table.cells.find((c: ReturnType<typeof JSON.parse>) =>
        c.sourceTokens.some(
          (t: ReturnType<typeof JSON.parse>) =>
            t.text === before.text && JSON.stringify(t.rect) === JSON.stringify(before.rect)
        )
      )
      const token = cell.sourceTokens.find(
        (t: ReturnType<typeof JSON.parse>) =>
          t.text === before.text && JSON.stringify(t.rect) === JSON.stringify(before.rect)
      )
      const rectIndex = cell.sourceRects.findIndex(
        (r: ReturnType<typeof JSON.parse>) => JSON.stringify(r) === JSON.stringify(before.rect)
      )
      mutate(font)
      Object.assign(program, {
        text: font.text,
        rect: [...font.rect],
        baseline: font.baseline,
        height: font.height,
        literalGlyphs: [...font.text.replace(/\s/gu, '')],
        glyphRuns: [...font.text.replace(/\s/gu, '')].map(() => 100)
      })
      Object.assign(token, {
        text: font.text,
        rect: [...font.rect],
        baseline: font.baseline,
        height: font.height
      })
      cell.sourceRects[rectIndex] = [...font.rect]
    }
    if (mode === 'missing-program')
      f.runs.splice(
        f.runs.findIndex(
          (p: ReturnType<typeof JSON.parse>) => p.text === base.text && p.baseline === base.baseline
        ),
        1
      )
    if (mode === 'incomplete-program')
      f.runs
        .find(
          (p: ReturnType<typeof JSON.parse>) => p.text === base.text && p.baseline === base.baseline
        )
        .literalGlyphs.pop()
    if (mode === 'wrong-program-baseline')
      f.runs.find(
        (p: ReturnType<typeof JSON.parse>) => p.text === base.text && p.baseline === base.baseline
      ).baseline += 1
    if (mode === 'nonfinite-program-height')
      f.runs.find(
        (p: ReturnType<typeof JSON.parse>) => p.text === base.text && p.baseline === base.baseline
      ).height = NaN
    if (mode === 'missing-closing') f.rules.pop()
    if (mode === 'missing-double-opening') f.rules.splice(1, 1)
    if (mode === 'missing-middle-fence') f.rules.splice(3, 1)
    if (mode === 'middle-rule-crosses-font') f.rules[3] = [130, 225.5, 850, 225.5]
    if (mode === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
    if (mode === 'rotation') f.table.readingRotation = 90
    if (mode === 'incomplete-header-owner') {
      const head = f.table.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 0
      )
      head.sourceTokens = []
      head.sourceRects = []
      f.table.unassigned.push('Leaf1')
    }
    if (mode === 'header-span')
      f.table.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 0
      ).colSpan = 2
    if (mode === 'crossing-whole-font')
      sync(base, (i) => {
        i.rect[2] = 241
      })
    if (mode === 'distinct-same-cell-parent-ambiguity') {
      const alternate = {
        ...structuredClone(base),
        text: '9.99',
        rect: base.rect.map((v: number, n: number) => (n % 2 === 0 ? v + 0.02 : v))
      }
      f.items.push(alternate)
      f.runs.push({
        ...alternate,
        literalGlyphs: [...alternate.text],
        glyphRuns: [...alternate.text].map(() => 100),
        gaps: []
      })
      const owner = f.table.cells.find((c: ReturnType<typeof JSON.parse>) =>
        c.sourceTokens.some(
          (t: ReturnType<typeof JSON.parse>) =>
            t.text === base.text && JSON.stringify(t.rect) === JSON.stringify(base.rect)
        )
      )
      owner.sourceTokens.push(alternate)
      owner.sourceRects.push(alternate.rect)
    }
    if (mode === 'nonterminal-native-script-parent') {
      const lower = f.items.filter(
        (i: ReturnType<typeof JSON.parse>) => i.baseline === 173 && i.rect[0] < 180
      )
      const excluded = (t: ReturnType<typeof JSON.parse>): boolean =>
        lower.some(
          (i: ReturnType<typeof JSON.parse>) =>
            i.text === t.text && JSON.stringify(i.rect) === JSON.stringify(t.rect)
        )
      f.items = f.items.filter((i: ReturnType<typeof JSON.parse>) => !lower.includes(i))
      f.runs = f.runs.filter((p: ReturnType<typeof JSON.parse>) => !excluded(p))
      for (const cell of f.table.cells) {
        cell.sourceTokens = cell.sourceTokens.filter(
          (t: ReturnType<typeof JSON.parse>) => !excluded(t)
        )
        cell.sourceRects = cell.sourceRects.filter(
          (r: ReturnType<typeof JSON.parse>) =>
            !lower.some(
              (i: ReturnType<typeof JSON.parse>) => JSON.stringify(i.rect) === JSON.stringify(r)
            )
        )
      }
      for (const font of upper)
        sync(font, (i) => {
          i.baseline = 162.01
          i.rect[1] = i.baseline - i.height
          i.rect[3] = i.baseline
        })
      const suffix = {
        text: 'kg',
        rect: [164.2, 156.015, 164.6, 168.015],
        height: 12,
        baseline: 168.015,
        horizontal: true
      }
      f.items.push(suffix)
      f.runs.push({ ...suffix, literalGlyphs: [...suffix.text], glyphRuns: [100, 100], gaps: [] })
      const owner = f.table.cells.find((c: ReturnType<typeof JSON.parse>) =>
        c.sourceTokens.some(
          (t: ReturnType<typeof JSON.parse>) =>
            t.text === base.text && JSON.stringify(t.rect) === JSON.stringify(base.rect)
        )
      )
      owner.sourceTokens.push(suffix)
      owner.sourceRects.push(suffix.rect)
    }
    if (mode === 'nonadjacent-script')
      for (const font of upper)
        sync(font, (i) => {
          i.rect = i.rect.map((v: number, n: number) => (n % 2 === 0 ? v + 8 : v))
        })
    if (mode === 'leading-isotope-script') {
      const removed = f.items.filter(
          (i: ReturnType<typeof JSON.parse>) =>
            (i.baseline === 173 && i.rect[0] < 180) || i === upper[1]
        ),
        has = (i: ReturnType<typeof JSON.parse>): boolean =>
          removed.some(
            (r: ReturnType<typeof JSON.parse>) =>
              r.text === i.text && JSON.stringify(r.rect) === JSON.stringify(i.rect)
          )
      f.items = f.items.filter((i: ReturnType<typeof JSON.parse>) => !removed.includes(i))
      f.runs = f.runs.filter((i: ReturnType<typeof JSON.parse>) => !has(i))
      for (const cell of f.table.cells) {
        cell.sourceTokens = cell.sourceTokens.filter((i: ReturnType<typeof JSON.parse>) => !has(i))
        cell.sourceRects = cell.sourceRects.filter(
          (r: ReturnType<typeof JSON.parse>) =>
            !removed.some(
              (i: ReturnType<typeof JSON.parse>) => JSON.stringify(i.rect) === JSON.stringify(r)
            )
        )
      }
      sync(base, (i) => {
        i.text = 'C-14'
        i.rect = [148, 156, 172, 168]
      })
      sync(upper[0], (i) => {
        i.text = '14'
        i.rect = [137.4, 155, 147.4, 164]
        i.height = 9
        i.baseline = 164
      })
    }
    if (mode === 'second-upper-rail') {
      for (const font of upper) {
        const extra = {
          ...structuredClone(font),
          baseline: font.baseline - 1,
          rect: font.rect.map((v: number, n: number) => (n % 2 === 1 ? v - 1 : v))
        }
        f.items.push(extra)
        f.runs.push({
          ...extra,
          literalGlyphs: [...extra.text],
          glyphRuns: [...extra.text].map(() => 100),
          gaps: []
        })
        const owner = f.table.cells.find((c: ReturnType<typeof JSON.parse>) =>
          c.sourceTokens.some(
            (t: ReturnType<typeof JSON.parse>) =>
              t.text === font.text && JSON.stringify(t.rect) === JSON.stringify(font.rect)
          )
        )
        owner.sourceTokens.push(extra)
        owner.sourceRects.push(extra.rect)
      }
    }
    if (mode === 'clipped-native-script-box')
      for (const font of upper)
        sync(font, (i) => {
          i.rect[1] += 1
        })
    if (mode === 'displaced-native-script-baseline')
      for (const font of upper)
        sync(font, (i) => {
          i.baseline += 0.5
        })
    if (mode === 'foreign-font-after-closing') {
      f.items.push({
        text: 'outside',
        rect: [140, 302.5, 170, 304],
        baseline: 304,
        height: 1.5,
        horizontal: true
      })
    }
    if (mode === 'extra-unassigned') f.table.unassigned.push('unproved source')
    const before = structuredClone(f)
    expect(
      proveNativeCompleteOrdinaryRecordOwners(f.table, f.items, f.captions, f.rules, f.runs)
    ).toBeUndefined()
    expect(f).toEqual(before)
  })
}

it('restores complete ordinary native records without inventing predicted empty records', () => {
  const f = fixture('complete-ordinary-native-records')
  const before = structuredClone(f)
  const result = run(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.cells).toHaveLength(f.expectedGrid.length * f.expectedGrid[0].length)
  expect(result.unassigned).toEqual([])
  expect(result.cropRect).toEqual(f.table.cropRect)
  expect(f).toEqual(before)
  const source = f.expectedSources
  const tokens = result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
  for (const item of source) {
    expect(
      tokens.filter(
        (t: { text: string; rect: number[] }) =>
          t.text === item.text && JSON.stringify(t.rect) === JSON.stringify(item.rect)
      )
    ).toHaveLength(1)
  }
  expect(tokens).toHaveLength(source.length)
})

const anonymousLoweredSuffix = (): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = []
  const runs: ReturnType<typeof JSON.parse>[] = []
  const font = (
    text: string,
    x: number,
    width: number,
    baseline: number,
    height = 12
  ): ReturnType<typeof JSON.parse> => {
    const token = {
      text,
      rect: [x, baseline - height, x + width, baseline],
      baseline,
      height,
      horizontal: true,
      inlineSymbol: false
    }
    items.push(token)
    runs.push({
      text,
      rect: [...token.rect],
      baseline,
      height,
      gaps: [],
      literalGlyphs: [...text],
      glyphRuns: Array.from(text, () => runs.length)
    })
    return token
  }
  font('Entry', 42, 36, 100)
  font('Reading', 170, 48, 100)
  font('q', 42, 8, 130)
  font('4', 50, 6, 132.4, 8)
  font(',z', 56, 10, 132.4, 8)
  font('7.25', 176, 32, 130)
  font('r', 42, 8, 158)
  font('8.50', 176, 32, 158)
  const cropRect = [24, 74, 300, 178]
  const object = (label: string, rect: number[]): ReturnType<typeof JSON.parse> => ({
    label,
    score: 0.95,
    rect
  })
  const table = {
    id: 'anonymous-terminal-suffix',
    detection: { label: 'table', score: 0.98, rect: [28, 78, 296, 174] },
    readingRotation: 0,
    cropRect,
    structure: {
      objects: [
        object('table', [4, 4, 272, 100]),
        object('table column', [4, 4, 116, 100]),
        object('table column', [116, 4, 272, 100]),
        object('table row', [4, 4, 272, 34]),
        object('table row', [4, 34, 272, 66]),
        object('table row', [4, 66, 272, 100]),
        object('table column header', [4, 4, 272, 34])
      ]
    },
    rowCount: 3,
    columnCount: 2,
    spans: [],
    grid: [
      ['Entry', 'Reading'],
      ['q4,z', '7.25'],
      ['r', '8.50']
    ],
    unassigned: []
  }
  const captions = [{ page: 1, lines: ['Table 1: Neutral readings.'], rect: [28, 44, 230, 56] }]
  return {
    table,
    items,
    captions,
    rules: [
      [28, 78, 296, 78],
      [28, 108, 296, 108],
      [28, 174, 296, 174]
    ],
    runs
  }
}

it.each(['complete', 'missing-program', 'wrong-literal', 'ordinary-baseline', 'duplicate-program'])(
  'retains a shallow native subscript only with complete source programs: %s',
  (condition) => {
    const f = anonymousLoweredSuffix()
    f.items.splice(4, 1)
    f.runs.splice(4, 1)
    Object.assign(f.items[3], {
      text: 'AB',
      baseline: 131.2,
      height: 8,
      rect: [50, 123.2, 62, 131.2]
    })
    if (condition === 'ordinary-baseline')
      Object.assign(f.items[3], { baseline: 130, rect: [50, 122, 62, 130] })
    Object.assign(f.runs[3], {
      ...f.items[3],
      literalGlyphs: ['A', 'B'],
      glyphRuns: [3, 3]
    })
    f.items.forEach((item: ReturnType<typeof JSON.parse>, index: number) => {
      item.sourceItem = { pageNumber: 1, index, text: item.text }
    })
    if (condition === 'missing-program') f.runs.splice(3, 1)
    if (condition === 'wrong-literal') f.runs[3].literalGlyphs = ['A', '?']
    if (condition === 'duplicate-program') f.runs.push(structuredClone(f.runs[3]))
    const before = structuredClone(f)
    const result = refineTable(
      f.table,
      f.items,
      f.captions,
      [],
      f.rules,
      f.runs,
      undefined,
      new Map()
    )
    const cell = result.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 0
    )
    if (condition === 'complete') {
      expect(result.repairs).toContain('native-closed-leaf-complete-records-recovered')
      expect(cell.textRuns).toEqual([
        { text: 'q', position: 'normal' },
        { text: 'AB', position: 'subscript' }
      ])
      expect(cell.sourceItems).toEqual(
        f.items.slice(2, 4).map((i: ReturnType<typeof JSON.parse>) => i.sourceItem)
      )
    } else
      expect(cell.textRuns?.some((r: { position: string }) => r.position === 'subscript')).not.toBe(
        true
      )
    expect(f).toEqual(before)
  }
)

it('keeps a touching terminal lowered fragment with its unique native script parent', () => {
  const f = anonymousLoweredSuffix(),
    before = structuredClone(f)
  const result = refineTable(
    f.table,
    f.items,
    f.captions,
    [],
    f.rules,
    f.runs,
    undefined,
    new Map()
  )
  expect(result.repairs).toContain('native-closed-leaf-complete-records-recovered')
  expect(result.grid).toEqual([
    ['Entry', 'Reading'],
    ['q4,z', '7.25'],
    ['r', '8.50']
  ])
  expect(result.cells).toHaveLength(6)
  expect(
    result.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 0).textRuns
  ).toEqual([
    { text: 'q', position: 'normal' },
    { text: '4,z', position: 'subscript' }
  ])
  const sourceRects = result.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceRects)
  for (const item of f.items)
    expect(
      sourceRects.filter((r: number[]) => JSON.stringify(r) === JSON.stringify(item.rect))
    ).toHaveLength(1)
  expect(sourceRects).toHaveLength(f.items.length)
  expect(result.cropRect).toEqual([28, 78, 296, 174])
  expect(result.issues).toEqual([])
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(before)
})

for (const control of ['terminal-gap', 'different-script-baseline', 'missing-complete-program']) {
  it('keeps a terminal fragment ordinary with ' + control, () => {
    const f = anonymousLoweredSuffix(),
      suffix = f.items[4],
      program = f.runs[4]
    if (control === 'terminal-gap') {
      suffix.rect[0] += 0.2
      suffix.rect[2] += 0.2
      program.rect = [...suffix.rect]
    }
    if (control === 'different-script-baseline') {
      suffix.baseline += 0.1
      suffix.rect[1] += 0.1
      suffix.rect[3] += 0.1
      program.baseline = suffix.baseline
      program.rect = [...suffix.rect]
    }
    if (control === 'missing-complete-program') f.runs.splice(4, 1)
    const before = structuredClone(f)
    const result = refineTable(
      f.table,
      f.items,
      f.captions,
      [],
      f.rules,
      f.runs,
      undefined,
      new Map()
    )
    expect(result.repairs).toContain('native-closed-leaf-complete-records-recovered')
    expect(
      result.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 0)
        .textRuns
    ).toEqual([
      { text: 'q', position: 'normal' },
      { text: '4', position: 'subscript' },
      { text: ',z', position: 'normal' }
    ])
    expect(f).toEqual(before)
  })
}

it('preserves an already complete direct-parent lowered run', () => {
  const f = anonymousLoweredSuffix()
  f.items[3].rect[2] = 53
  f.items[4].rect[0] = 53
  f.items[4].rect[2] = 63
  f.runs[3].rect = [...f.items[3].rect]
  f.runs[4].rect = [...f.items[4].rect]
  const before = structuredClone(f)
  const result = refineTable(
    f.table,
    f.items,
    f.captions,
    [],
    f.rules,
    f.runs,
    undefined,
    new Map()
  )
  expect(
    result.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 0).textRuns
  ).toEqual([
    { text: 'q', position: 'normal' },
    { text: '4,z', position: 'subscript' }
  ])
  expect(f).toEqual(before)
})

const recoverVariableFencedGroups = (
  f: ReturnType<typeof fixture>
): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativeFencedGroupLabels(
    f.table,
    f.items,
    f.captions,
    f.rules,
    f.runs,
    new Map(f.paint),
    f.graphics,
    f.operatorContext
  ) ?? f.table

it('recovers variable native fenced groups while preserving every complete peer and provenance', () => {
  const f = fixture('variable-native-fenced-groups')
  const original = structuredClone(f)
  const repaired = recoverVariableFencedGroups(f)
  expect(repaired).toEqual(f.expected)
  expect(repaired.cells).toHaveLength(23)
  for (const peer of f.expectedWholePeers) {
    expect(
      repaired.cells.find(
        (cell: ReturnType<typeof JSON.parse>) =>
          cell.row === peer.row && cell.column === peer.column
      )
    ).toEqual(peer)
  }
  expect(f).toEqual(original)
})

const convertFencedGroupPrograms = (
  f: ReturnType<typeof fixture>,
  convert: (program: number[]) => unknown
): void => {
  for (const args of f.operatorContext.operators.argsArray) {
    if (Array.isArray(args) && Array.isArray(args[1]) && Array.isArray(args[1][0])) {
      args[1][0] = convert(args[1][0])
    }
  }
}

it('recovers variable native fenced groups from complete PDF.js Float32Array programs', () => {
  const f = fixture('variable-native-fenced-groups')
  convertFencedGroupPrograms(f, (program) => new Float32Array(program))
  const original = structuredClone(f)
  expect(recoverVariableFencedGroups(f)).toEqual(f.expected)
  expect(f).toEqual(original)
})

it('refuses variable native fenced groups when their boundary programs paint dashed strokes', () => {
  const f = fixture('variable-native-fenced-groups')
  f.operatorContext.operators.fnArray.unshift(OPS.setDash)
  f.operatorContext.operators.argsArray.unshift([[7, 7], 0])
  const original = structuredClone(f)
  expect(recoverVariableFencedGroups(f)).toEqual(f.table)
  expect(f).toEqual(original)
})

it('refuses variable native fenced groups whose boundary strokes are pure white', () => {
  const f = fixture('variable-native-fenced-groups')
  f.operatorContext.operators.fnArray.unshift(OPS.setStrokeRGBColor)
  f.operatorContext.operators.argsArray.unshift(['#ffffff'])
  const original = structuredClone(f)
  expect(recoverVariableFencedGroups(f)).toEqual(f.table)
  expect(f).toEqual(original)
})

it('refuses variable native fenced groups with an unproved color transfer function', () => {
  const f = fixture('variable-native-fenced-groups')
  f.operatorContext.operators.fnArray.unshift(OPS.setGState)
  f.operatorContext.operators.argsArray.unshift([[['TR', [new Uint8Array(256).fill(255)]]]])
  const original = structuredClone(f)
  expect(recoverVariableFencedGroups(f)).toEqual(f.table)
  expect(f).toEqual(original)
})

it.each([
  ['Float64Array', (program: number[]) => new Float64Array(program)],
  ['DataView', (program: number[]) => new DataView(new Float32Array(program).buffer)]
])(
  'keeps variable native fenced groups unchanged for unsupported %s programs',
  (_name, convert) => {
    const f = fixture('variable-native-fenced-groups')
    convertFencedGroupPrograms(f, convert)
    const original = structuredClone(f)
    expect(recoverVariableFencedGroups(f)).toEqual(f.table)
    expect(f).toEqual(original)
  }
)

it.each([
  [
    'missing operator context',
    (f: ReturnType<typeof fixture>) => {
      delete f.operatorContext
    }
  ],
  [
    'missing complete glyph program',
    (f: ReturnType<typeof fixture>) => {
      f.runs.splice(4, 1)
    }
  ],
  [
    'negative glyph program identity',
    (f: ReturnType<typeof fixture>) => {
      f.runs[4].glyphRuns[0] = -1
    }
  ],
  [
    'missing closing paint evidence',
    (f: ReturnType<typeof fixture>) => {
      f.paint.pop()
    }
  ],
  [
    'unknown blank cell payload',
    (f: ReturnType<typeof fixture>) => {
      f.table.cells.find(
        (cell: ReturnType<typeof JSON.parse>) => cell.column === 0 && cell.row === 1
      ).opaque = 'retain me'
    }
  ]
])('leaves variable native fenced groups unchanged with %s', (_name, mutate) => {
  const f = fixture('variable-native-fenced-groups')
  mutate(f)
  const original = structuredClone(f)
  expect(recoverVariableFencedGroups(f)).toEqual(f.table)
  expect(f).toEqual(original)
})

it('combines only independently fenced two-line stub donors and preserves every rich peer', () => {
  const f = fixture('fenced-two-line-native-stubs'),
    before = structuredClone(f),
    result = refineTable(f.table, f.items, f.captions, f.notes, f.rules, f.runs)
  expect(result.grid).toHaveLength(f.expectedBeforeGrid.length)
  expect(result.cells).toHaveLength(f.expectedBeforeCells.length - f.expectedGroups.length)
  for (const group of f.expectedGroups) {
    const cell = result.cells.find(
      (c: { row: number; column: number }) => c.row === group.row && c.column === 0
    )
    expect(cell.rowSpan).toBe(group.rowSpan)
    expect(cell.text).toBe(group.text)
    expect(cell.rect).toEqual(group.rect)
    expect(cell.sourceTokens).toEqual(group.sourceTokens)
  }
  for (const cell of f.expectedRetainedCells)
    expect(
      result.cells.find(
        (c: { row: number; column: number }) => c.row === cell.row && c.column === cell.column
      )
    ).toEqual(cell)
  expect(result.cropRect).toEqual(f.table.cropRect)
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(before)
})

// Anonymous native geometry: two independent centered descriptive faces and
// a right face whose two printed lines share their unique baseline center.
const centeredNarrativePeers = (): ReturnType<typeof JSON.parse> => {
  const font = 13.4496
  const token = (
    text: string,
    x: number,
    baseline: number,
    width: number,
    height = font
  ): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [x, baseline - height, x + width, baseline],
    baseline,
    height,
    horizontal: true
  })
  const anchors = [159.519, 175.9575, 200.6895, 225.273, 241.7115, 258.15, 274.5885]
  const left = [
    [213.285, 66.4948224],
    [225.618, 41.828256],
    [208.995, 75.0756672],
    [188.451, 116.1641952],
    [190.5825, 111.900672],
    [208.41, 76.2457824],
    [213.6615, 65.7416448]
  ]
  const middle = [
    [393.5903376, 41.4651168],
    [371.5327104, 85.5663552],
    [343.5716976, 117.2939616],
    [341.709192, 121.0329504],
    [322.5499752, 159.3508608],
    [363.551136, 77.3486496],
    [354.5864088, 95.2635168]
  ]
  const quantities = [
    [],
    [],
    [464.2280592, 478.34206944],
    [466.1045424, 480.21855264],
    [485.263236, 499.37724624],
    [444.2621856, 458.37619584],
    [453.2123256, 467.32633584]
  ]
  const right = [
    [578.1322992, 97.307856],
    [545.8395264, 161.9062848],
    [],
    [531.32703264, 190.917072],
    [551.42719824, 150.7296672],
    [534.68922624, 184.2057216],
    [580.27607664, 93.0308832]
  ]
  const items = [
    token('Component', 216.798, 133.5165, 59.4672393, 13.15065),
    token('Device', 395.3312244, 133.5165, 37.99222785, 13.15065),
    token('Printed role', 564.0014613, 133.5165, 125.5624062, 13.15065)
  ]
  for (const [r, baseline] of anchors.entries()) {
    items.push(
      token(`Component ${String.fromCharCode(65 + r)}`, left[r][0], baseline, left[r][1]),
      token(`Device ${String.fromCharCode(65 + r)}`, middle[r][0], baseline, middle[r][1])
    )
    if (r >= 2)
      items.push(
        token('×', quantities[r][0], baseline, 10.75161024),
        token(r === 5 ? '2' : '1', quantities[r][1], baseline, 6.7248)
      )
    if (r === 2)
      items.push(
        token('First printed line', 524.028, 192.396, 205.5233376),
        token('Second printed line', 549.408, 208.8345, 154.7645472)
      )
    else
      items.push(
        token(`Printed role ${String.fromCharCode(65 + r)}`, right[r][0], baseline, right[r][1])
      )
  }
  return {
    items,
    captions: [
      {
        page: 1,
        lines: ['Table 1. Independently printed component records.'],
        rect: [178, 85, 739, 106]
      }
    ],
    rules: [117.228, 143.2305, 279.819].map((y) => [179.484, y, 738.515982421875, y]),
    table: {
      id: 'anonymous-centered-narrative-records',
      cropRect: [178, 111, 739, 288],
      structure: {
        objects: [
          {
            label: 'table column',
            rect: [14.159876346588135, 35.94163075089455, 135.26907831430435, 160.0654579102993]
          },
          {
            label: 'table column',
            rect: [133.85179996490479, 35.78093281388283, 337.00872856378555, 160.052038282156]
          },
          {
            label: 'table column',
            rect: [335.09880512952805, 35.998679995536804, 548.7438610196114, 159.93027520179749]
          },
          {
            label: 'table row',
            rect: [13.672915756702423, 36.41830448806286, 547.9528468251228, 60.34015788137913]
          },
          {
            label: 'table row',
            rect: [13.575577139854431, 56.18046350777149, 547.8099653720856, 82.85194806754589]
          },
          {
            label: 'table row',
            rect: [13.494288861751556, 94.71215897798538, 547.9617413878441, 160.5283243060112]
          }
        ]
      }
    }
  }
}

it('keeps centered wrapped narrative fields in their independently paired native records', () => {
  const f = centeredNarrativePeers(),
    before = structuredClone(f)
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, [])
  expect(result.grid).toHaveLength(8)
  expect(result.grid[0]).toEqual(['Component', 'Device', 'Printed role'])
  expect(result.grid.slice(1).map((r: string[]) => r[0])).toEqual(
    Array.from({ length: 7 }, (_, r) => `Component ${String.fromCharCode(65 + r)}`)
  )
  expect(result.grid[3]).toEqual([
    'Component C',
    'Device C × 1',
    'First printed line Second printed line'
  ])
  expect(result.unassigned).toEqual([])
  const literal = (i: { text: string; rect: number[]; baseline: number; height: number }): string =>
    JSON.stringify([i.text, i.rect, i.baseline, i.height])
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literal)
      .sort()
  ).toEqual(f.items.map(literal).sort())
  expect(f).toEqual(before)
})

const independentPanelParts = (f: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> => {
  const refined = run(f)
  return (
    recoverNativeMixedSectionParts(refined, f.items, f.captions, f.rules, f.runs) ??
    panelRefineHelpers.recoverNativeIndependentPanelParts?.(
      refined,
      f.items,
      f.captions,
      f.rules,
      f.runs
    )
  )
}

it('keeps independently ruled panels as separate complete literal record grids', () => {
  const f = fixture('independent-native-ruled-panels'),
    before = structuredClone(f),
    result = independentPanelParts(f)
  expect(result?.parts?.map((p: { grid: string[][] }) => p.grid)).toEqual(
    f.expectedParts.map((p: { grid: string[][] }) => p.grid)
  )
  expect(result.cropRect).toEqual(f.expectedCropRect)
  for (const [index, part] of result.parts.entries()) {
    expect(part.title).toBe(f.expectedParts[index].title)
    expect(
      part.cells.map((cell: Record<string, unknown>) => {
        const projected = { ...cell }
        delete projected.sourceTokens
        return projected
      })
    ).toEqual(
      f.expectedParts[index].cells.map((cell: Record<string, unknown>) => {
        // Source fixtures retain empty run arrays as the physical blank oracle;
        // the existing worker contract omits this optional field for blanks.
        const projected = { ...cell }
        if (Array.isArray(projected.textRuns) && projected.textRuns.length === 0)
          delete projected.textRuns
        return projected
      })
    )
    expect(part.unassigned).toEqual([])
    expect(part.issues).toEqual([])
    for (const cell of part.cells) {
      expect(cell.sourceRects).toEqual(cell.sourceTokens.map((t: { rect: number[] }) => t.rect))
      expect((cell.textRuns ?? []).map((r: { text: string }) => r.text).join('')).toBe(cell.text)
      if (!cell.sourceTokens.length) expect(cell).not.toHaveProperty('textRuns')
      for (const token of cell.sourceTokens) {
        const source = token.sourceToken ?? token
        expect(
          f.items.filter(
            (i: { text: string; rect: number[] }) =>
              i.text === source.text && JSON.stringify(i.rect) === JSON.stringify(source.rect)
          )
        ).toEqual([source])
      }
    }
  }
  expect(f).toEqual(before)
})

const indexedIndependentPanels = (): ReturnType<typeof JSON.parse> => {
  const f = fixture('independent-native-ruled-panels')
  for (const [index, item] of f.items.entries())
    item.sourceItem = { pageNumber: 1, index, text: item.text }
  return f
}

it('conserves whole native origins when publishing independent panels', () => {
  const f = indexedIndependentPanels(),
    refined = run(f),
    before = structuredClone({ f, refined }),
    baseline = independentPanelParts(fixture('independent-native-ruled-panels')),
    result = panelRefineHelpers.recoverNativeIndependentPanelParts(
      refined,
      f.items,
      f.captions,
      f.rules,
      f.runs
    )
  expect(result.parts).toHaveLength(2)
  for (const part of result.parts)
    for (const cell of part.cells) {
      const origins = cell.sourceTokens.map((t: ReturnType<typeof JSON.parse>) => {
        const owner = t.sourceToken ?? t
        const matches = f.items.filter(
          (i: ReturnType<typeof JSON.parse>) =>
            i.text === owner.text &&
            i.baseline === owner.baseline &&
            i.height === owner.height &&
            i.rect.every((v: number, n: number) => v === owner.rect[n])
        )
        expect(matches).toHaveLength(1)
        return matches[0].sourceItem
      })
      const expected = [
        ...new Map(origins.map((o: ReturnType<typeof JSON.parse>) => [o.index, o])).values()
      ].sort(
        (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) => a.index - b.index
      )
      if (expected.length) expect(cell.sourceItems).toEqual(expected)
      else expect(cell).not.toHaveProperty('sourceItems')
    }
  const semantics = (value: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
    JSON.parse(
      JSON.stringify(value, (key, item) =>
        key === 'sourceItems' || key === 'sourceItem' ? undefined : item
      )
    )
  expect(semantics(result)).toEqual(semantics(baseline))
  expect({ f, refined }).toEqual(before)
})

it.each(['conflicting text', 'duplicate origin', 'opaque origin', 'empty origins'])(
  'refuses independent panel projection with invalid donor origins: %s',
  (kind) => {
    const f = indexedIndependentPanels(),
      refined = run(f)
    const donor = refined.cells.find((c: ReturnType<typeof JSON.parse>) => c.sourceItems?.length)
    expect(donor).toBeDefined()
    if (kind === 'conflicting text') donor.sourceItems[0].text = 'unknown-owner'
    if (kind === 'duplicate origin') donor.sourceItems.push({ ...donor.sourceItems[0] })
    if (kind === 'opaque origin') donor.sourceItems[0].unprovedOpaque = true
    if (kind === 'empty origins') donor.sourceItems = []
    const before = structuredClone({ f, refined })
    expect(
      panelRefineHelpers.recoverNativeIndependentPanelParts(
        refined,
        f.items,
        f.captions,
        f.rules,
        f.runs
      )
    ).toBeUndefined()
    expect({ f, refined }).toEqual(before)
  }
)

it('reads independent panel blank cells and origins through the actual application worker boundary', async () => {
  const f = indexedIndependentPanels(),
    result = independentPanelParts(f),
    scratch = await mkdtemp(join(tmpdir(), 'native-independent-panel-worker-')),
    id = 'anonymous-independent-native-panels',
    identity = {
      extractionId: '00000000-0000-4000-8000-000000000001',
      engineFingerprint: 'b'.repeat(64),
      sourceChecksum: 'c'.repeat(64),
      sourceSizeBytes: 100,
      requestedPages: [1]
    }
  try {
    await mkdir(join(scratch, 'thumbnails'))
    await writeFile(
      join(scratch, `thumbnails/${id}.png`),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
        'base64'
      )
    )
    await writeFile(
      join(scratch, 'structure.json'),
      JSON.stringify(
        {
          sourceSha256: identity.sourceChecksum,
          pageCount: 1,
          requestedPages: [1],
          processedPages: [1],
          pages: [{ page: 1, width: 900, height: 1200, rotation: 0 }],
          figures: [],
          algorithms: [],
          tables: [
            {
              id,
              page: 1,
              region: [0.2, 0.4, 0.8, 0.6],
              thumbnail: `thumbnails/${id}.png`,
              caption: { text: f.captions[0].lines[0], rect: f.captions[0].rect },
              parts: result.parts.map((part: Record<string, unknown>) => ({
                ...part,
                sourceViewport: { width: 900, height: 1200 }
              })),
              notes: []
            }
          ],
          navigation: { entries: [] }
        },
        (key, value) => (key === 'sourceTokens' || key === 'rect' ? undefined : value)
      )
    )
    // Caption rectangles are public provenance, so preserve them after the
    // internal cell rectangle projection used by the worker serializer.
    const bytes = JSON.parse(readFileSync(join(scratch, 'structure.json'), 'utf8'))
    bytes.tables[0].caption.rect = f.captions[0].rect
    await writeFile(join(scratch, 'structure.json'), JSON.stringify(bytes))
    const read = await readWorkerResult(scratch, identity, new Map()),
      parts = read.elements[0].tableParts!
    expect(parts.map((part) => [part.table.rowCount, part.table.columnCount])).toEqual([
      [9, 5],
      [8, 5]
    ])
    const blanks = parts[0].table.cells.filter((cell) => !cell.text)
    expect(blanks).toHaveLength(4)
    expect(blanks.every((cell) => cell.textRuns === undefined && cell.regions.length === 0)).toBe(
      true
    )
    expect(parts.reduce((count, part) => count + part.table.cells.length, 0)).toBe(80)
    for (const [index, part] of parts.entries()) {
      const expected = f.expectedParts[index]
      expect(part.title).toBe(expected.title)
      expect(part.table.cells).toEqual(
        expected.cells.map(
          (
            cell: {
              row: number
              column: number
              rowSpan: number
              colSpan: number
              text: string
              textRuns: { text: string; position: string }[]
              sourceRects: number[][]
            },
            cellIndex: number
          ) => ({
            row: cell.row,
            column: cell.column,
            rowSpan: cell.rowSpan,
            columnSpan: cell.colSpan,
            text: cell.text,
            ...(cell.textRuns.length ? { textRuns: cell.textRuns } : {}),
            ...(result.parts[index].cells[cellIndex].sourceItems
              ? { sourceItems: result.parts[index].cells[cellIndex].sourceItems }
              : {}),
            regions: cell.sourceRects.map((box) => ({
              page: 1,
              x: box[0] / 900,
              y: box[1] / 1200,
              width: box[2] / 900 - box[0] / 900,
              height: box[3] / 1200 - box[1] / 1200
            }))
          })
        )
      )
      expect(part.table.unassignedText).toEqual([])
      expect(part.table.issues).toEqual([])
    }
  } finally {
    expect(dirname(resolve(scratch))).toBe(resolve(tmpdir()))
    await rm(scratch, { recursive: true, force: true })
  }
})

it.each([555.4, 572.99])(
  'rejects native panel group fences crossing full font boxes at %s',
  (y) => {
    const f = fixture('independent-native-ruled-panels')
    f.rules[5][1] = f.rules[5][3] = y
    expect(independentPanelParts(f)).toBeUndefined()
  }
)

it('refuses an unsupported script attached to a split panel header parent', () => {
  const f = fixture('independent-native-ruled-panels'),
    script = {
      text: 'x',
      rect: [695.95, 522, 696.25, 526],
      baseline: 526,
      height: 4,
      horizontal: true
    }
  f.items.push(script)
  f.runs.push({ ...structuredClone(script), gaps: [], literalGlyphs: ['x'], glyphRuns: [999999] })
  expect(independentPanelParts(f)).toBeUndefined()
})

it('refuses a panel subtitle with a mismatched observed source program', () => {
  const f = fixture('independent-native-ruled-panels')
  f.runs.find((r: { text: string }) => r.text.startsWith('(b)')).baseline += 1
  expect(independentPanelParts(f)).toBeUndefined()
})

it.each([
  'missing-caption',
  'competing-caption',
  'missing-subtitle',
  'nonconsecutive-subtitle',
  'missing-closing',
  'wrong-closing-endpoint',
  'competing-opening',
  'missing-group-fence',
  'missing-measured-face',
  'body-gutter-crossing',
  'missing-header-face',
  'duplicate-program',
  'competing-program-font',
  'wrong-program-height',
  'wrong-glyph-stream',
  'duplicate-native-owner',
  'rotated-foreign-source',
  'foreign-panel-gap',
  'detached-script',
  'shifted-record-anchor'
])('refuses independent native panels with %s', (control) => {
  const f = fixture('independent-native-ruled-panels'),
    item = f.items.find(
      (i: { rect: number[]; baseline: number }) =>
        i.rect[0] > 620 && i.baseline > 580 && i.baseline < 591
    ),
    program = f.runs.find(
      (r: { text: string; rect: number[] }) =>
        r.text === item.text && JSON.stringify(r.rect) === JSON.stringify(item.rect)
    ),
    remove = (source: { text: string; rect: number[] }): void => {
      f.runs = f.runs.filter(
        (r: { text: string; rect: number[] }) =>
          r.text !== source.text || JSON.stringify(r.rect) !== JSON.stringify(source.rect)
      )
      f.items = f.items.filter((i: unknown) => i !== source)
    }
  if (control === 'missing-caption') f.captions = []
  if (control === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'missing-subtitle')
    remove(f.items.find((i: { text: string }) => i.text.startsWith('(b)')))
  if (control === 'nonconsecutive-subtitle')
    f.items.find((i: { text: string }) => i.text.startsWith('(b)')).text = '(a) repeated title'
  if (control === 'missing-closing') f.rules.pop()
  if (control === 'wrong-closing-endpoint') f.rules.at(-1)[2] -= 2
  if (control === 'competing-opening')
    f.rules.push(f.rules[3].map((v: number, n: number) => v + (n % 2 ? 2 : 0)))
  if (control === 'missing-group-fence') f.rules.splice(5, 1)
  if (control === 'missing-measured-face') remove(item)
  if (control === 'body-gutter-crossing') {
    item.rect[0] -= 8
    program.rect[0] -= 8
  }
  if (control === 'missing-header-face')
    remove(
      f.items.find(
        (i: { rect: number[]; baseline: number }) =>
          i.rect[0] > 310 && i.rect[0] < 320 && i.baseline < 535
      )
    )
  if (control === 'duplicate-program') f.runs.push(structuredClone(program))
  if (control === 'competing-program-font')
    f.runs.push({ ...structuredClone(program), baseline: 2 })
  if (control === 'wrong-program-height') program.height -= 1
  if (control === 'wrong-glyph-stream') program.literalGlyphs[0] = '9'
  if (control === 'duplicate-native-owner') f.items.push(structuredClone(item))
  if (control === 'rotated-foreign-source')
    f.items.push({
      text: 'foreign',
      rect: [650, 600, 653, 604],
      baseline: 604,
      height: 4,
      horizontal: false
    })
  if (control === 'foreign-panel-gap')
    f.items.push({
      text: 'foreign',
      rect: [509, 580, 513, 590],
      baseline: 590,
      height: 10,
      horizontal: true
    })
  if (control === 'detached-script') {
    const script = f.items.find(
        (i: { height: number; baseline: number }) =>
          i.height < 8 && i.baseline > 541 && i.baseline < 550
      ),
      run = f.runs.find(
        (r: { rect: number[] }) => JSON.stringify(r.rect) === JSON.stringify(script.rect)
      )
    for (const i of [script, run]) {
      i.rect[0] += 4
      i.rect[2] += 4
    }
  }
  if (control === 'shifted-record-anchor')
    for (const i of [item, program]) {
      i.baseline += 2
      i.rect[1] += 2
      i.rect[3] += 2
    }
  const before = structuredClone(f)
  expect(independentPanelParts(f)).toBeUndefined()
  expect(f).toEqual(before)
})

it.each(['equivalent-paint', 'translated-reversed', 'renamed-descriptions'])(
  'keeps independent panel source ownership with %s',
  (control) => {
    const f = fixture('independent-native-ruled-panels')
    if (control === 'equivalent-paint')
      f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1], r[2] - 1, r[3]]))
    if (control === 'translated-reversed') {
      const move = (r: number[]): number[] => r.map((v, n) => v + (n % 2 ? 37 : 19))
      f.table.cropRect = move(f.table.cropRect)
      for (const key of ['items', 'runs'])
        for (const i of f[key]) {
          i.rect = move(i.rect)
          i.baseline += 37
        }
      for (const r of f.runs)
        for (const g of r.gaps) {
          g.left += 19
          g.right += 19
        }
      for (const c of f.captions) c.rect = move(c.rect)
      f.rules = f.rules.map(move).reverse()
      f.items.reverse()
      f.runs.reverse()
      f.expectedCropRect = move(f.expectedCropRect)
    }
    if (control === 'renamed-descriptions') {
      for (const key of ['items', 'runs'])
        for (const i of f[key]) i.text = i.text.replace(/X/g, 'Q')
      for (const r of f.runs)
        r.literalGlyphs = r.literalGlyphs.map((s: string) => s.replace(/X/g, 'Q'))
      for (const p of f.expectedParts)
        p.grid = p.grid.map((r: string[]) => r.map((s) => s.replace(/X/g, 'Q')))
    }
    const before = structuredClone(f),
      result = independentPanelParts(f)
    expect(result?.parts.map((p: { grid: string[][] }) => p.grid)).toEqual(
      f.expectedParts.map((p: { grid: string[][] }) => p.grid)
    )
    expect(result.cropRect).toEqual(f.expectedCropRect)
    expect(result.parts.map((p: { cells: unknown[] }) => p.cells.length)).toEqual([45, 35])
    expect(f).toEqual(before)
  }
)

it('retains centered native ownership after scaling, translation and reversed glyph order', () => {
  const f = centeredNarrativePeers()
  const rect = (r: number[], relative = false): number[] =>
    r.map((v, n) => v * 1.7 + (relative ? 0 : n % 2 ? 70 : 30))
  f.table.cropRect = rect(f.table.cropRect)
  for (const object of f.table.structure.objects) object.rect = rect(object.rect, true)
  f.rules = f.rules.map((r: number[]) => rect(r)).reverse()
  f.captions = f.captions.map((c: { rect: number[] }) => ({ ...c, rect: rect(c.rect) }))
  f.items = f.items
    .map((i: { rect: number[]; baseline: number; height: number }) => ({
      ...i,
      rect: rect(i.rect),
      baseline: i.baseline * 1.7 + 70,
      height: i.height * 1.7
    }))
    .reverse()
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, [])
  expect(result.grid).toHaveLength(8)
  expect(result.grid[3]).toEqual([
    'Component C',
    'Device C × 1',
    'First printed line Second printed line'
  ])
  expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toBe(
    characters(f.items.map((i: { text: string }) => i.text).join(''))
  )
})

it.each([
  'caption',
  'closing',
  'divider',
  'competing-frame',
  'missing-left-peer',
  'missing-middle-peer',
  'shift-right-center',
  'midpoint-right',
  'foreign-row',
  'crossed-leaf',
  'duplicate'
])('refuses centered narrative ownership without unique %s source proof', (change) => {
  const f = centeredNarrativePeers()
  if (change === 'caption') f.captions = []
  if (change === 'closing') f.rules.pop()
  if (change === 'divider') f.rules.splice(1, 1)
  if (change === 'competing-frame') f.rules.push([179.484, 142, 738.515982421875, 142])
  if (change === 'missing-left-peer')
    f.items = f.items.filter((i: { text: string }) => i.text !== 'Component C')
  if (change === 'missing-middle-peer')
    f.items = f.items.filter((i: { text: string }) => i.text !== 'Device C')
  if (change === 'shift-right-center' || change === 'midpoint-right') {
    const i = f.items.find((i: { text: string }) => i.text === 'Second printed line'),
      offset = change === 'shift-right-center' ? 3 : 5
    i.baseline += offset
    i.rect[1] += offset
    i.rect[3] += offset
  }
  if (change === 'foreign-row')
    f.items.push({
      text: 'Other',
      rect: [200, 194, 220, 207.4496],
      baseline: 207.4496,
      height: 13.4496,
      horizontal: true
    })
  if (change === 'crossed-leaf')
    f.items.find((i: { text: string }) => i.text === 'Component C').rect[2] = 350
  if (change === 'duplicate') f.items.push(structuredClone(f.items.at(-1)))
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, [])
  expect(result.repairs).not.toContain('native-centered-literal-peer-records-recovered')
})

// Anonymous native geometry: three descriptive leaves, paired measurements
// and a printed dash. Only the first two complete records share a model band.
const completeDescriptivePeers = (): ReturnType<typeof JSON.parse> => {
  const font = 11.794921392
  const cuts = [90, 212.278676, 346.273259, 420.488422, 497.360456, 649.959791, 801]
  const token = (
    text: string,
    x: number,
    baseline: number,
    width: number,
    height = font
  ): { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean } => ({
    text,
    rect: [x, baseline - height, x + width, baseline],
    baseline,
    height,
    horizontal: true
  })
  const anchors = [
    267.476424, 281.6301876, 297.5539116, 311.7076752, 327.6313992, 343.55393928, 357.70770288
  ]
  const prefixes = [
    ['Suite-A', 'Model-A', 'Runner-A'],
    ['Suite-A', 'Model-B', 'Runner-A'],
    ['Suite-B', 'Model-C', 'Runner-B'],
    ['Suite-B', 'Model-D', 'Runner-A'],
    ['Suite-C', 'Model-C', 'Runner-B'],
    ['Suite-D', 'Model-C', 'Runner-B'],
    ['Suite-D', 'Model-E', 'Runner-B']
  ]
  const items = [
    token('Dataset', 100.620474, 233.54409288, 67.229872),
    token('Model', 218.827996, 233.54409288, 37.556209),
    token('Runner', 353.090766, 233.54409288, 47.248096),
    token('Baseline', 426.582562, 233.54409288, 64.351912),
    token('Measure', 611.503264, 226.46661912, 75.948678),
    token('Direct', 546.361618, 246.84306624, 56.338442),
    token('Adjusted', 699.50098, 246.84306624, 49.848876)
  ]
  for (let r = 0; r < anchors.length; r++) {
    const baseline = anchors[r]
    items.push(
      ...prefixes[r].map((text, c) =>
        token(
          text,
          [100.620474, 218.827996, 353.095484][c],
          baseline,
          [102.260789, 120.120659, 57.765628][c]
        )
      )
    )
    items.push(token(`${40 + r}.48 / ${60 + r}.20`, 425.015017, baseline, 67.485822))
    if (r < 2 || r === anchors.length - 1) {
      items.push(
        token(`${42 + r}.52`, 509.167063, baseline, 30.895617),
        token('/', 571.582666, baseline, 5.897461),
        token(`${61 - r}.22`, 581.407835, baseline, 30.895617)
      )
      // The smaller annotation is just above 0.8 of the ordinary height.
      // Its offset baseline must not become an independent record anchor.
      const scriptBaseline = baseline + (r ? 2.28614952 : 2.2849656)
      const parts: [string, number, number][] = [
        ['+2', 542.029655, 12.811204],
        ['.', 554.840859, 2.784552],
        ['04', 557.625411, 10.026652],
        ['+1', 614.273637, 12.811204],
        ['.', 627.084841, 2.784552],
        ['02', 629.869393, 10.026652]
      ]
      items.push(
        ...parts.map(([text, x, width]) => token(text, x, scriptBaseline, width, 9.435960792))
      )
    } else items.push(token(`${42 + r}.52 / ${61 - r}.22`, 509.167063, baseline, 130.728982))
    items.push(token('–', 721.477593, baseline, 5.897461))
  }
  const rules = [
    [93.543, 212.43124752, 799.373645, 212.43124752],
    [506.005337, 233.12972088, 792.953214, 233.12972088],
    [93.543, 253.63403136, 799.373645, 253.63403136],
    [93.543, 364.69164696, 799.373645, 364.69164696]
  ]
  const rows = [
    { rect: [90, 214.671697728, 801, 250.479302287], origin: 'model' },
    { rect: [90, 251.31635499, 801, 285.998645214], origin: 'model' },
    ...anchors.slice(2).map((b) => ({ rect: [90, b - font, 801, b], origin: 'source-text' }))
  ]
  const columnRects = cuts.slice(0, -1).map((left, c) => [left, 204, cuts[c + 1], 372])
  const headers = [
    { label: 'table column header', rect: [103.30884, 222.110386, 786.396866, 251.012673] }
  ]
  const predictedRows = rows.slice(0, 2)
  const table = {
    id: 'complete-descriptive-peers',
    cropRect: [90, 204, 801, 372],
    structure: {
      objects: [
        ...columnRects.map((rect) => ({
          label: 'table column',
          rect: [rect[0] - 90, 0, rect[2] - 90, 168]
        })),
        ...predictedRows.map((row) => ({
          label: 'table row',
          rect: [0, row.rect[1] - 204, 711, row.rect[3] - 204]
        })),
        { label: 'table column header', rect: [13.30884, 18.110386, 696.396866, 47.012673] }
      ]
    }
  }
  return {
    rows,
    items,
    columnRects,
    rules,
    right: 801,
    repairs: [],
    captioned: true,
    headers,
    table,
    captions: [
      { page: 1, lines: ['Table 1. Literal paired measurements.'], rect: [90, 180, 801, 195] }
    ]
  }
}

it('splits two complete descriptive peer records while preserving their native header and annotations', () => {
  const input = completeDescriptivePeers(),
    before = structuredClone(input)
  const result = refineTable(input.table, input.items, input.captions, [], input.rules, [])
  expect(result.grid).toHaveLength(9)
  expect(result.grid.slice(0, 2)).toEqual([
    ['Dataset', 'Model', 'Runner', 'Baseline', 'Measure', ''],
    ['', '', '', '', 'Direct', 'Adjusted']
  ])
  expect(result.grid.slice(2, 4)).toEqual([
    ['Suite-A', 'Model-A', 'Runner-A', '40.48 / 60.20', '42.52 +2.04 / 61.22 +1.02', '–'],
    ['Suite-A', 'Model-B', 'Runner-A', '41.48 / 61.20', '43.52 +2.04 / 60.22 +1.02', '–']
  ])
  expect(
    result.cells
      .filter((c: { row: number }) => c.row < 2)
      .map((c: { row: number; column: number; rowSpan: number; colSpan: number }) => [
        c.row,
        c.column,
        c.rowSpan,
        c.colSpan
      ])
  ).toEqual([
    [0, 0, 2, 1],
    [0, 1, 2, 1],
    [0, 2, 2, 1],
    [0, 3, 2, 1],
    [0, 4, 1, 2],
    [1, 4, 1, 1],
    [1, 5, 1, 1]
  ])
  const owned = result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
  const literal = (i: { text: string; rect: number[]; baseline: number; height: number }): string =>
    JSON.stringify([i.text, i.rect, i.baseline, i.height])
  expect(owned.map(literal).sort()).toEqual(input.items.map(literal).sort())
  expect(result.unassigned).toEqual([])
  expect(input).toEqual(before)
})

it('keeps descriptive source anchors independent of scaling and reversed glyph order', () => {
  const input = completeDescriptivePeers()
  const rect = (r: number[]): number[] => r.map((v, n) => v * 1.7 + (n % 2 ? 70 : 30))
  for (const row of input.rows) row.rect = rect(row.rect)
  for (const header of input.headers) header.rect = rect(header.rect)
  input.columnRects = input.columnRects.map(rect)
  input.rules = input.rules.map(rect).reverse()
  input.items = input.items
    .map((i: { rect: number[]; baseline: number; height: number }) => ({
      ...i,
      rect: rect(i.rect),
      baseline: i.baseline * 1.7 + 70,
      height: i.height * 1.7
    }))
    .reverse()
  input.right = input.right * 1.7 + 30
  const headerRow = structuredClone(input.rows[0])
  repairWrappedTableRows(input)
  expect(input.rows).toHaveLength(8)
  expect(input.rows[0]).toEqual(headerRow)
  expect(input.repairs).toContain('source-record-boundary-restored')
})

it.each([
  'caption',
  'closing',
  'divider',
  'descriptive-leaf',
  'printed-dash',
  'competing-owner',
  'foreign-token',
  'header-owner',
  'complete-peers',
  'independent-peer-owner',
  'leaf-gutter'
])('refuses descriptive record splitting without the unique %s witness', (missing) => {
  const input = completeDescriptivePeers()
  if (missing === 'caption') input.captioned = false
  if (missing === 'closing') input.rules = input.rules.filter((r: number[]) => r[1] < 360)
  if (missing === 'divider')
    input.rules = input.rules.filter((r: number[]) => Math.abs(r[1] - 253.63403136) > 1)
  if (missing === 'descriptive-leaf')
    input.items = input.items.filter((i: { text: string }) => i.text !== 'Model-B')
  if (missing === 'printed-dash')
    input.items = input.items.filter(
      (i: { text: string; baseline: number }) =>
        !(i.text === '–' && i.baseline > 280 && i.baseline < 282)
    )
  if (missing === 'competing-owner') input.rows.push(structuredClone(input.rows[1]))
  if (missing === 'foreign-token')
    input.items.push({
      text: 'continuation',
      rect: [220, 269.77, 260, 269.82],
      height: 0.05,
      baseline: 269.82,
      horizontal: true
    })
  if (missing === 'header-owner') input.headers[0].rect[3] = 270
  if (missing === 'complete-peers') input.rows = input.rows.slice(0, 4)
  if (missing === 'independent-peer-owner')
    input.rows = [...input.rows.slice(0, 2), { rect: [90, input.rows[2].rect[1], 801, 372] }]
  if (missing === 'leaf-gutter')
    input.items.find((i: { text: string }) => i.text === 'Model-B').rect[2] =
      input.columnRects[1][2]
  const firstBody = structuredClone(input.rows[1])
  repairWrappedTableRows(input)
  expect(input.rows[1]).toEqual(firstBody)
  expect(input.repairs).not.toContain('source-record-boundary-restored')
})

for (const [kind, rows, columns] of [
  ['dense-deviation', 25, 6],
  ['scalar-pairs', 7, 10],
  ['wrapped-fields', 16, 2],
  ['compact-configuration', 5, 7],
  ['compact-measured', 13, 10]
] as const) {
  it(`recovers every complete ${kind} record without changing the input or its source text`, () => {
    const input = fixture(kind)
    const before = structuredClone(input)
    const result = run(input)
    expect(result).toBeDefined()
    expect(result.grid).toHaveLength(rows)
    expect(result.grid.every((row: string[]) => row.length === columns)).toBe(true)
    expect(result.unassigned).toEqual([])
    const [left, top, right, bottom] = result.cropRect
    const selected = input.items.filter(
      (i: { rect: number[] }) =>
        i.rect[0] >= left && i.rect[2] <= right && i.rect[1] >= top && i.rect[3] <= bottom
    )
    expect(characters(result.cells.map((cell: { text: string }) => cell.text).join(''))).toBe(
      characters(selected.map((i: { text: string }) => i.text).join(''))
    )
    expect(input).toEqual(before)
  })

  it(`keeps ${kind} stable after translation, scaling and reversed source order`, () => {
    const input = fixture(kind)
    const expected = run(input).grid
    const rect = (r: number[]): number[] => r.map((v, n) => v * 1.7 + (n % 2 ? 70 : 30))
    input.crop = rect(input.crop)
    if (input.table) {
      input.table.cropRect = rect(input.table.cropRect)
      for (const object of input.table.structure.objects)
        object.rect = object.rect.map((v: number) => v * 1.7)
    }
    input.items = input.items
      .map((item: { rect: number[]; baseline: number; height: number }) => ({
        ...item,
        rect: rect(item.rect),
        baseline: item.baseline * 1.7 + 70,
        height: item.height * 1.7
      }))
      .reverse()
    input.rules = input.rules.map(rect).reverse()
    input.captions = input.captions.map((c: { rect: number[] }) => ({ ...c, rect: rect(c.rect) }))
    input.runs = input.runs.map(
      (r: {
        rect: number[]
        baseline: number
        height: number
        gaps: { left: number; right: number }[]
      }) => ({
        ...r,
        rect: rect(r.rect),
        baseline: r.baseline * 1.7 + 70,
        height: r.height * 1.7,
        gaps: r.gaps.map((g) => ({ ...g, left: g.left * 1.7 + 30, right: g.right * 1.7 + 30 }))
      })
    )
    expect(run(input)?.grid).toEqual(expected)
  })
}

it('owns the two explicit mode labels only when each physical face has three complete records', () => {
  const input = fixture('scalar-pairs')
  const result = run(input)
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 0).rowSpan
  ).toBe(3)
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 4 && c.column === 0).rowSpan
  ).toBe(3)
  const full = input.rules
    .filter((r: number[]) => r[1] === r[3] && r[2] - r[0] > 570)
    .sort((a: number[], b: number[]) => a[1] - b[1])
  const separator = full[2]
  separator[1] = separator[3] = 319
  for (const item of input.items.filter(
    (i: { rect: number[]; baseline: number }) =>
      i.rect[0] < 220 && i.baseline > 300 && i.baseline < 335
  )) {
    item.rect[1] -= 17
    item.rect[3] -= 17
    item.baseline -= 17
  }
  expect(run(input).repairs).not.toContain('native-scalar-pair-records-recovered')
})

it('refuses dense record reconstruction when one metric has unknown source text', () => {
  const input = fixture('dense-deviation')
  input.items.find((i: { text: string }) => i.text.includes('±')).text = 'uncertain'
  expect(run(input).repairs).not.toContain('native-dense-deviation-records-recovered')
})

it('leaves the parameter footnote outside the recovered body crop and cells', () => {
  const input = fixture('wrapped-fields'),
    result = run(input)
  const notes = input.items.filter((i: { rect: number[] }) => i.rect[1] > result.cropRect[3])
  expect(notes.length).toBeGreaterThan(0)
  const selected = result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
  expect(notes.some((i: unknown) => selected.includes(i))).toBe(false)
})

it('requires a caption and the complete native closing frame for a tiny table', () => {
  for (const kind of ['compact-configuration', 'compact-measured']) {
    const noCaption = fixture(kind)
    noCaption.captions = []
    expect(run(noCaption)).toBeUndefined()
    const missingFrame = fixture(kind)
    missingFrame.rules = missingFrame.rules.filter(
      (r: number[]) => Math.abs(r[1] - missingFrame.crop[3]) > 0.05
    )
    expect(run(missingFrame)).toBeUndefined()
  }
})

it('refuses a measured native recovery without original glyph gap evidence', () => {
  const input = fixture('compact-measured')
  input.runs = []
  expect(run(input)?.repairs).not.toContain('native-measured-leaf-body-records-recovered')
})

it('orders a proved stacked fraction numerator before its denominator while retaining literal text runs', () => {
  const input = fixture('literal-fraction'),
    before = structuredClone(input),
    result = run(input)
  expect(result.grid[1][0]).toBe('A + 1 2 B ≥ 0.5')
  expect(result.cells[1].textRuns).toEqual([
    { text: 'A + ', position: 'normal' },
    { text: '1', position: 'superscript' },
    { text: ' ', position: 'normal' },
    { text: '2', position: 'subscript' },
    { text: ' B ≥ 0.5', position: 'normal' }
  ])
  expect(result.repairs).toContain('native-literal-fraction-order-reconciled')
  expect(input).toEqual(before)
})

it('refuses fraction ordering without one unique native fraction bar', () => {
  for (const count of [0, 2]) {
    const input = fixture('literal-fraction')
    input.rules = Array.from({ length: count }, () => structuredClone(input.rules[0]))
    expect(run(input).repairs).not.toContain('native-literal-fraction-order-reconciled')
  }
})

// Anonymous exact native geometry. Literal observed TJ boundaries are backed
// by independently printed peers; model lanes are deliberately incomplete.
type LiteralNativeData = {
  name: string
  items: [string, number, number, number, number, number][]
  observed: [number, { left: number; right: number; index: number }[], number][]
  rules: number[][]
  caption: number[]
  crop: number[]
  objects: [string, ...number[]][]
}
const literalSourceFixture = (d: LiteralNativeData): ReturnType<typeof JSON.parse> => {
  const items = d.items.map(([text, x0, y0, x1, y1, height]) => ({
    text,
    rect: [x0, y0, x1, y1],
    baseline: y1,
    height,
    horizontal: true,
    inlineSymbol: false
  }))
  const runs = d.observed.map(([n, gaps, group]) => {
    const item = items[n],
      literalGlyphs = [...item.text.replace(/\s/gu, '')]
    return { ...item, gaps, glyphRuns: literalGlyphs.map(() => group), literalGlyphs }
  })
  return {
    items,
    runs,
    rules: structuredClone(d.rules),
    captions: [
      {
        page: 1,
        lines: ['Table 1. Explicitly printed literal source fields and records.'],
        rect: [...d.caption]
      }
    ],
    table: {
      id: 'anonymous-' + d.name,
      cropRect: [...d.crop],
      readingRotation: 0,
      structure: { objects: d.objects.map(([label, ...rect]) => ({ label, rect })) }
    }
  }
}
const jointDescriptiveHeader = (): ReturnType<typeof JSON.parse> =>
  literalSourceFixture({
    name: 'jointDescriptiveHeader',
    items: [
      ['CohortXX SourceX', 321.729, 428.15039999999993, 424.0535568, 441.5999999999999, 13.4496],
      ['Max', 572.362296, 428.15039999999993, 596.2756848, 441.5999999999999, 13.4496],
      ['XXXX', 321.729, 450.59790000000004, 350.12110559999996, 464.0475, 13.4496],
      [
        'XXXXXXXXXX-1.5 (XX-XX, 2025)',
        380.73239520000004,
        450.59790000000004,
        560.0290128000001,
        464.0475,
        13.4496
      ],
      ['100k', 569.3764848, 450.59790000000004, 596.2756847999999, 464.0475, 13.4496],
      ['XXXXXXXX', 321.729, 465.5424000000001, 372.5281392, 478.9920000000001, 13.4496],
      [
        'XXXXX (XXX XX XX., 2021)',
        380.73239520000004,
        465.5424000000001,
        515.9546736000001,
        478.9920000000001,
        13.4496
      ],
      ['9,178', 566.0140848, 465.5424000000001, 596.2756848, 478.9920000000001, 13.4496],
      ['XXX', 321.729, 480.4854000000001, 345.42719519999997, 493.93500000000006, 13.4496],
      [
        'XXXX-XXX (XXX XX XX., 2023)',
        380.7323952,
        480.4854000000001,
        535.9138800000001,
        493.93500000000006,
        13.4496
      ],
      ['50k', 576.1012847999999, 480.4854000000001, 596.2756847999999, 493.93500000000006, 13.4496],
      ['XXXXXXX', 321.729, 495.42990000000003, 364.29698399999995, 508.8795, 13.4496],
      [
        'XXXXXXXXXXXXXXXX (XX XX XX., 2025X)',
        380.73239520000004,
        495.42990000000003,
        554.8105680000001,
        508.8795,
        13.4496
      ],
      ['10k', 576.1012848, 495.42990000000003, 596.2756848, 508.8795, 13.4496]
    ],
    observed: [
      [0, [{ left: 374.7607728, right: 380.7323952, index: 8 }], 1],
      [1, [], 1],
      [2, [], 2],
      [
        3,
        [
          { left: 473.74982880000005, right: 477.1122288, index: 14 },
          { left: 525.2886960000001, right: 528.651096, index: 21 }
        ],
        2
      ],
      [4, [], 2],
      [5, [], 3],
      [
        6,
        [
          { left: 424.80673440000004, right: 428.1691344000001, index: 5 },
          { left: 448.34353440000007, right: 451.70593440000005, index: 9 },
          { left: 461.41654560000006, right: 464.77894560000004, index: 11 },
          { left: 481.21435680000013, right: 484.5767568000001, index: 15 }
        ],
        3
      ],
      [7, [], 3],
      [8, [], 4],
      [
        9,
        [
          { left: 439.54749599999997, right: 442.909896, index: 8 },
          { left: 468.3027408, right: 471.6651408, index: 12 },
          { left: 481.37575200000003, right: 484.738152, index: 14 },
          { left: 501.1735632, right: 504.5359632, index: 18 }
        ],
        4
      ],
      [10, [], 4],
      [11, [], 5],
      [
        12,
        [
          { left: 461.4299952, right: 464.79239520000004, index: 16 },
          { left: 481.2278064000001, right: 484.59020640000006, index: 19 },
          { left: 494.3008176000001, right: 497.66321760000005, index: 21 },
          { left: 514.0986288000001, right: 517.4610288000001, index: 25 }
        ],
        5
      ],
      [13, [], 5]
    ],
    rules: [
      [318.7395, 426.36, 599.2605113525391, 426.36],
      [318.7395, 449.03099999999995, 599.2605113525391, 449.03099999999995],
      [318.7395, 516.534, 599.2605113525391, 516.534]
    ],
    caption: [161.5365, 380.6841, 756.0048419999997, 412.0665],
    crop: [306, 422, 603, 525],
    objects: [
      ['table row', 14.400481939315796, 58.32114964723587, 266.54026901721954, 73.31718438863754],
      ['table row', 14.132606506347656, 44.35829867422581, 266.63904941082, 59.99039028584957],
      ['table column', 14.213489592075348, 29.34874677658081, 70.17445904016495, 88.4573632478714],
      ['table row', 14.317386031150818, 29.449232950806618, 266.71718859672546, 43.98647020757198],
      [
        'table column',
        71.05679985880852,
        29.124914824962616,
        256.42782095074654,
        88.45642393827438
      ],
      ['table column', 256.37518233060837, 29.11943244934082, 267.73361760377884, 88.1498590707779],
      ['table row', 14.375609815120697, 74.03967922925949, 266.63977521657944, 88.31141418218613],
      ['table', 14.671366810798645, 29.22329369187355, 266.7798911333084, 88.42881867289543]
    ]
  })
const twoWrappedLiteralRecords = (): ReturnType<typeof JSON.parse> =>
  literalSourceFixture({
    name: 'twoWrappedLiteralRecords',
    items: [
      ['Platform', 68.742, 229.8753, 105.23938229999999, 240.336, 10.4607],
      ['Toolchain', 217.95000000000002, 229.8753, 259.8764856, 240.336, 10.4607],
      ['task 01 byte-equal', 503.964, 229.8753, 580.4317169999999, 240.336, 10.4607],
      ['task 02 byte-equal', 696.9314999999999, 229.8753, 773.3887563, 240.336, 10.4607],
      ['(', 493.7579999999999, 243.32430000000008, 497.24141309999993, 253.78500000000008, 10.4607],
      ['7', 497.241, 243.32430000000008, 503.1931383, 253.78500000000008, 10.4607],
      ['×', 503.1975, 243.32430000000008, 512.5284444, 253.78500000000008, 10.4607],
      ['200=1400', 512.5379999999999, 243.32430000000008, 563.377002, 253.78500000000008, 10.4607],
      ['trials)', 566.025, 243.32430000000008, 590.6181057, 253.78500000000008, 10.4607],
      ['(', 686.7239999999999, 243.32430000000008, 690.2074130999999, 253.78500000000008, 10.4607],
      ['3', 690.207, 243.32430000000008, 696.1591383, 253.78500000000008, 10.4607],
      ['×', 696.165, 243.32430000000008, 705.4959444, 253.78500000000008, 10.4607],
      ['500=1500', 705.5039999999999, 243.32430000000008, 756.343002, 253.78500000000008, 10.4607],
      ['trials)', 758.991, 243.32430000000008, 783.5945664, 253.78500000000008, 10.4607],
      ['SysAA', 68.742, 264.61080000000004, 99.5383008, 275.0715, 10.4607],
      ['14', 102.15449999999998, 264.61080000000004, 114.05877659999999, 275.0715, 10.4607],
      ['.', 114.0675, 264.61080000000004, 116.68267499999999, 275.0715, 10.4607],
      ['5', 116.68350000000001, 264.61080000000004, 122.63563830000001, 275.0715, 10.4607],
      ['Vm', 217.95000000000002, 264.61080000000004, 229.00695990000003, 275.0715, 10.4607],
      ['3', 231.6225, 264.61080000000004, 237.5746383, 275.0715, 10.4607],
      ['.', 237.579, 264.61080000000004, 240.194175, 275.0715, 10.4607],
      ['11', 240.195, 264.61080000000004, 252.0992766, 275.0715, 10.4607],
      ['.', 252.108, 264.61080000000004, 254.723175, 275.0715, 10.4607],
      ['7', 254.724, 264.61080000000004, 260.6761383, 275.0715, 10.4607],
      ['+ Engine', 263.29650000000004, 264.61080000000004, 308.9365341, 275.0715, 10.4607],
      ['3', 311.562, 264.61080000000004, 317.5141383, 275.0715, 10.4607],
      ['.', 317.5185, 264.61080000000004, 320.13367500000004, 275.0715, 10.4607],
      ['1', 320.1345, 264.61080000000004, 326.0866383, 275.0715, 10.4607],
      ['.', 326.091, 264.61080000000004, 328.70617500000003, 275.0715, 10.4607],
      ['4', 328.70550000000003, 264.61080000000004, 334.65763830000003, 275.0715, 10.4607],
      ['1400', 499.27799999999996, 264.61080000000004, 523.0865531999999, 275.0715, 10.4607],
      ['/', 523.1054999999999, 264.61080000000004, 526.0135745999999, 275.0715, 10.4607],
      ['1400', 526.014, 264.61080000000004, 549.8225532, 275.0715, 10.4607],
      ['(', 552.4559999999999, 264.61080000000004, 555.9394130999999, 275.0715, 10.4607],
      ['100', 555.939, 264.61080000000004, 573.7954149, 275.0715, 10.4607],
      ['%)', 573.81, 264.61080000000004, 585.1075559999999, 275.0715, 10.4607],
      ['1500', 692.2455, 264.61080000000004, 716.0540532, 275.0715, 10.4607],
      ['/', 716.0729999999999, 264.61080000000004, 718.9810745999998, 275.0715, 10.4607],
      ['1500', 718.9799999999999, 264.61080000000004, 742.7885531999999, 275.0715, 10.4607],
      ['(', 745.4234999999999, 264.61080000000004, 748.9069130999999, 275.0715, 10.4607],
      ['100', 748.9064999999999, 264.61080000000004, 766.7629148999999, 275.0715, 10.4607],
      ['%)', 766.7774999999999, 264.61080000000004, 778.0750559999999, 275.0715, 10.4607],
      [
        'HostBB',
        68.74199999999988,
        278.0613000000001,
        100.12409999999987,
        288.52200000000005,
        10.4607
      ],
      [
        '24',
        102.73949999999986,
        278.0613000000001,
        114.64377659999987,
        288.52200000000005,
        10.4607
      ],
      ['.', 114.65399999999988, 278.0613000000001, 117.26917499999988, 288.52200000000005, 10.4607],
      [
        '04',
        117.26849999999988,
        278.0613000000001,
        129.17277659999988,
        288.52200000000005,
        10.4607
      ],
      [
        'Vm',
        217.94999999999985,
        278.0613000000001,
        229.00695989999986,
        288.52200000000005,
        10.4607
      ],
      ['3', 231.62249999999986, 278.0613000000001, 237.57463829999986, 288.52200000000005, 10.4607],
      ['.', 237.57899999999987, 278.0613000000001, 240.19417499999986, 288.52200000000005, 10.4607],
      [
        '11',
        240.19499999999988,
        278.0613000000001,
        252.09927659999988,
        288.52200000000005,
        10.4607
      ],
      ['.', 252.1079999999999, 278.0613000000001, 254.72317499999988, 288.52200000000005, 10.4607],
      ['15', 254.72399999999988, 278.0613000000001, 266.6282765999999, 288.52200000000005, 10.4607],
      [
        '+ Engine',
        269.2529999999999,
        278.0613000000001,
        314.89303409999985,
        288.52200000000005,
        10.4607
      ],
      ['3', 317.5184999999999, 278.0613000000001, 323.4706382999999, 288.52200000000005, 10.4607],
      ['.', 323.4749999999999, 278.0613000000001, 326.09017499999993, 288.52200000000005, 10.4607],
      ['1', 326.0909999999999, 278.0613000000001, 332.0431382999999, 288.52200000000005, 10.4607],
      ['.', 332.0474999999999, 278.0613000000001, 334.6626749999999, 288.52200000000005, 10.4607],
      ['4', 334.66199999999986, 278.0613000000001, 340.61413829999987, 288.52200000000005, 10.4607],
      [
        '1400',
        499.2779999999999,
        278.0613000000001,
        523.0865531999999,
        288.52200000000005,
        10.4607
      ],
      ['/', 523.1054999999999, 278.0613000000001, 526.0135745999999, 288.52200000000005, 10.4607],
      [
        '1400',
        526.0139999999999,
        278.0613000000001,
        549.8225531999999,
        288.52200000000005,
        10.4607
      ],
      ['(', 552.4559999999999, 278.0613000000001, 555.9394130999999, 288.52200000000005, 10.4607],
      ['100', 555.9389999999999, 278.0613000000001, 573.7954148999999, 288.52200000000005, 10.4607],
      ['%)', 573.8099999999998, 278.0613000000001, 585.1075559999998, 288.52200000000005, 10.4607],
      [
        '1500',
        692.2454999999999,
        278.0613000000001,
        716.0540531999999,
        288.52200000000005,
        10.4607
      ],
      ['/', 716.0729999999999, 278.0613000000001, 718.9810745999998, 288.52200000000005, 10.4607],
      [
        '1500',
        718.9799999999998,
        278.0613000000001,
        742.7885531999998,
        288.52200000000005,
        10.4607
      ],
      ['(', 745.4234999999999, 278.0613000000001, 748.9069130999999, 288.52200000000005, 10.4607],
      ['100', 748.9064999999998, 278.0613000000001, 766.7629148999998, 288.52200000000005, 10.4607],
      ['%)', 766.7774999999998, 278.0613000000001, 778.0750559999998, 288.52200000000005, 10.4607]
    ],
    observed: [
      [0, [], 1],
      [1, [], 2],
      [
        2,
        [
          { left: 520.9207947, right: 523.5359697, index: 4 },
          { left: 533.9966697, right: 536.6118447, index: 6 }
        ],
        3
      ],
      [
        3,
        [
          { left: 713.8778339999999, right: 716.4930089999999, index: 4 },
          { left: 726.9537089999999, right: 729.5688839999999, index: 6 }
        ],
        4
      ],
      [4, [], 5],
      [5, [], 6],
      [6, [], 7],
      [7, [], 8],
      [8, [], 9],
      [9, [], 10],
      [10, [], 11],
      [11, [], 12],
      [12, [], 13],
      [13, [], 14],
      [14, [], 15],
      [15, [], 16],
      [16, [], 17],
      [17, [], 18],
      [18, [], 19],
      [19, [], 20],
      [20, [], 21],
      [21, [], 22],
      [22, [], 23],
      [23, [], 24],
      [24, [{ left: 270.4620795, right: 273.0667938, index: 1 }], 25],
      [25, [], 26],
      [26, [], 27],
      [27, [], 28],
      [28, [], 29],
      [29, [], 30],
      [30, [], 31],
      [31, [], 32],
      [32, [], 33],
      [33, [], 34],
      [34, [], 35],
      [35, [], 36],
      [36, [], 37],
      [37, [], 38],
      [38, [], 39],
      [39, [], 40],
      [40, [], 41],
      [41, [], 42],
      [42, [], 43],
      [43, [], 44],
      [44, [], 45],
      [45, [], 46],
      [46, [], 47],
      [47, [], 48],
      [48, [], 49],
      [49, [], 50],
      [50, [], 51],
      [51, [], 52],
      [52, [{ left: 276.41857949999985, right: 279.02329379999986, index: 1 }], 53],
      [53, [], 54],
      [54, [], 55],
      [55, [], 56],
      [56, [], 57],
      [57, [], 58],
      [58, [], 59],
      [59, [], 60],
      [60, [], 61],
      [61, [], 62],
      [62, [], 63],
      [63, [], 64],
      [64, [], 65],
      [65, [], 66],
      [66, [], 67],
      [67, [], 68],
      [68, [], 69],
      [69, [], 70]
    ],
    rules: [
      [68.74199867248535, 225.93300082397468, 822.6764831542969, 225.93300082397468],
      [68.74199867248535, 260.8949988098145, 822.6764831542969, 260.8949988098145],
      [68.74199867248535, 295.85699679565437, 822.6764831542969, 295.85699679565437]
    ],
    caption: [68.24700000000001, 181.58550000000002, 822.6824999999995, 216.08550000000002],
    crop: [58, 217, 795, 301],
    objects: [
      [
        'table column',
        329.87661466002464,
        20.640958070755005,
        432.08389261364937,
        64.74764513969421
      ],
      [
        'table column',
        28.494125723838806,
        21.44652557373047,
        101.29264008998871,
        64.08723449707031
      ],
      ['table row', 27.373682260513306, 19.107029020786285, 720.5014634132385, 34.34434121847153],
      [
        'table column',
        373.40358747541904,
        21.022653222084045,
        585.9054688066244,
        63.93566644191742
      ],
      [
        'table column',
        214.78503857553005,
        21.302104711532593,
        341.9839911609888,
        64.90373682975769
      ],
      ['table column', 583.5124900043011, 20.639285802841187, 719.9329611361027, 64.57444024085999],
      [
        'table column header',
        27.055353492498398,
        18.755383372306824,
        720.5119403898716,
        33.600000500679016
      ],
      [
        'table column',
        101.67388562858105,
        21.385340094566345,
        267.5996095687151,
        63.68233788013458
      ],
      ['table', 27.565891951322556, 20.99695336818695, 719.6479522287846, 63.90456926822662]
    ]
  })
const joinedExistingDescriptiveFaces = (): ReturnType<typeof JSON.parse> =>
  literalSourceFixture({
    name: 'joinedExistingDescriptiveFaces',
    items: [
      ['Training set', 136.0365, 536.1678, 198.88438559999997, 546.6285, 10.4607],
      ['Sources', 226.5947799, 536.1678, 265.77323961, 546.6285, 10.4607],
      [
        'MethodA Algo Model BaselineXYZ MethodA',
        424.9327901099999,
        536.1678,
        710.5057158299999,
        546.6285,
        10.4607
      ],
      ['−', 714.5226246299999, 536.1678, 723.8629836599998, 546.6285, 10.4607],
      ['Algo', 727.8903531599999, 536.1678, 762.7621426799999, 546.6285, 10.4607],
      ['Set-AA', 136.0365, 555.6243000000001, 175.15219550999998, 566.085, 10.4607],
      ['Set Exampletown, C2', 226.59791811, 555.6243000000001, 343.54331376, 566.085, 10.4607],
      ['0.425', 439.77129306000006, 555.6243000000001, 466.9743434100001, 566.085, 10.4607],
      ['0.500', 489.8414336100001, 555.6243000000001, 517.0444839600001, 566.085, 10.4607],
      ['0.467', 532.4949378600002, 555.6243000000001, 559.6979882100002, 566.085, 10.4607],
      ['0.148', 596.7811697100001, 555.6243000000001, 623.9842200600001, 566.085, 10.4607],
      ['Set-BBBB', 136.0365, 567.5793, 184.36702613999998, 578.04, 10.4607],
      ['Set Lab’s, C2', 226.59687203999997, 567.5793, 300.19417295999995, 578.04, 10.4607],
      ['0.407', 439.77129305999995, 567.5793, 466.97434340999996, 578.04, 10.4607],
      ['0.576', 489.84143360999997, 567.5793, 517.04448396, 578.04, 10.4607],
      ['0.507', 532.49493786, 567.5793, 559.6979882100001, 578.04, 10.4607],
      ['0.158', 596.7811697100001, 567.5793, 623.9842200600001, 578.04, 10.4607],
      ['Set-AA+BBBB', 136.0365, 579.5343000000001, 211.17780023999998, 589.9950000000001, 10.4607],
      [
        'Set, both sites, C2',
        226.59687203999994,
        579.5343000000001,
        324.3426989099999,
        589.9950000000001,
        10.4607
      ],
      [
        '0.497',
        439.7765234099999,
        579.5343000000001,
        466.97957375999994,
        589.9950000000001,
        10.4607
      ],
      ['0.539', 489.83620325999993, 579.5343000000001, 517.03925361, 589.9950000000001, 10.4607],
      [
        '0.519',
        532.5001682099999,
        579.5343000000001,
        559.7032185599999,
        589.9950000000001,
        10.4607
      ],
      ['0.166', 596.7759393599999, 579.5343000000001, 623.97898971, 589.9950000000001, 10.4607],
      ['−', 653.61415281, 579.5343000000001, 662.9545118399999, 589.9950000000001, 10.4607],
      ['0', 662.9545118399999, 579.5343000000001, 668.9118804899999, 589.9950000000001, 10.4607],
      ['.', 668.9118804899999, 579.5343000000001, 672.461196, 589.9950000000001, 10.4607],
      ['042', 672.4611959999999, 579.5343000000001, 690.3333019499998, 589.9950000000001, 10.4607],
      ['[', 694.3606714499998, 579.5343000000001, 697.7426157599998, 589.9950000000001, 10.4607],
      ['−', 697.7426157599998, 579.5343000000001, 707.0829747899998, 589.9950000000001, 10.4607],
      ['0', 707.0829747899998, 579.5343000000001, 713.0403434399998, 589.9950000000001, 10.4607],
      ['.', 713.0403434399998, 579.5343000000001, 716.5896589499998, 589.9950000000001, 10.4607],
      ['060', 716.5896589499998, 579.5343000000001, 734.4513041999998, 589.9950000000001, 10.4607],
      [',', 734.4513041999996, 579.5343000000001, 737.8332485099996, 589.9950000000001, 10.4607],
      ['−', 741.8606180099997, 579.5343000000001, 751.2009770399997, 589.9950000000001, 10.4607],
      ['0', 751.2009770399997, 579.5343000000001, 757.1583456899997, 589.9950000000001, 10.4607],
      ['.', 757.1583456899997, 579.5343000000001, 760.7076611999997, 589.9950000000001, 10.4607],
      ['025', 760.7076611999996, 579.5343000000001, 778.5797671499996, 589.9950000000001, 10.4607],
      [']', 778.5797671499996, 579.5343000000001, 781.9617114599996, 589.9950000000001, 10.4607],
      [
        'Base+Set-AA Base, Set Exampletown, C1 + C2',
        136.0365,
        591.4893000000001,
        420.7485101099999,
        601.95,
        10.4607
      ],
      ['0.521', 439.7765234100001, 591.4893000000001, 466.9795737600001, 601.95, 10.4607],
      ['0.496', 489.8362032600001, 591.4893000000001, 517.0392536100001, 601.95, 10.4607],
      ['0.417', 532.5001682100001, 591.4893000000001, 559.7032185600001, 601.95, 10.4607],
      ['0.152', 596.77593936, 591.4893000000001, 623.9789897100001, 601.95, 10.4607],
      ['Base+Set', 136.0365, 603.4458000000001, 200.74743626999998, 613.9065, 10.4607],
      [
        'Base, all Set, C1 + C2',
        226.59582597000002,
        603.4458000000001,
        359.88397323,
        613.9065,
        10.4607
      ],
      ['0.552', 439.7723391300001, 603.4458000000001, 466.9753894800001, 613.9065, 10.4607],
      ['0.452', 489.8424796800001, 603.4458000000001, 517.0455300300001, 613.9065, 10.4607],
      ['0.216', 532.4959839300002, 603.4458000000001, 559.6990342800002, 613.9065, 10.4607],
      ['0.161', 596.7717550800002, 603.4458000000001, 623.9748054300002, 613.9065, 10.4607],
      ['+0', 653.6099685300001, 603.4458000000001, 668.74137108, 613.9065, 10.4607],
      ['.', 668.7413710800001, 603.4458000000001, 672.2906865900002, 613.9065, 10.4607],
      ['100', 672.2906865900002, 603.4458000000001, 690.1627925400002, 613.9065, 10.4607],
      ['[0.079, 0.121]', 694.19016204, 603.4458000000001, 762.76946517, 613.9065, 10.4607]
    ],
    observed: [
      [0, [{ left: 180.14299547999997, right: 184.17036498, index: 8 }], 1],
      [1, [], 1],
      [
        2,
        [
          { left: 481.82121492, right: 486.00549492, index: 7 },
          { left: 520.87728444, right: 525.06156444, index: 11 },
          { left: 567.1428683999999, right: 571.3271483999999, index: 16 },
          { left: 649.43301102, right: 653.61729102, index: 27 }
        ],
        1
      ],
      [3, [], 2],
      [4, [], 3],
      [5, [], 4],
      [
        6,
        [
          { left: 244.04950392, right: 248.07687341999997, index: 3 },
          { left: 325.03205904, right: 329.05942854, index: 15 }
        ],
        4
      ],
      [7, [], 4],
      [8, [], 4],
      [9, [], 4],
      [10, [], 4],
      [11, [], 5],
      [
        12,
        [
          { left: 244.04845784999995, right: 248.07582734999994, index: 3 },
          { left: 281.69337893999995, right: 285.71028773999996, index: 9 }
        ],
        5
      ],
      [13, [], 5],
      [14, [], 5],
      [15, [], 5],
      [16, [], 5],
      [17, [], 6],
      [
        18,
        [
          { left: 247.43040215999991, right: 251.45777165999993, index: 4 },
          { left: 275.5926986999999, right: 279.62006819999993, index: 8 },
          { left: 305.8314441899999, right: 309.8588136899999, index: 14 }
        ],
        6
      ],
      [19, [], 6],
      [20, [], 6],
      [21, [], 6],
      [22, [], 6],
      [23, [], 7],
      [24, [], 8],
      [25, [], 9],
      [26, [], 10],
      [27, [], 11],
      [28, [], 12],
      [29, [], 13],
      [30, [], 14],
      [31, [], 15],
      [32, [], 16],
      [33, [], 17],
      [34, [], 18],
      [35, [], 19],
      [36, [], 20],
      [37, [], 21],
      [
        38,
        [
          { left: 222.41154597, right: 226.59582597, index: 11 },
          { left: 268.06517898, right: 272.09254847999995, index: 16 },
          { left: 289.54413428999993, right: 293.57150378999995, index: 19 },
          { left: 370.53715010999986, right: 374.55405890999987, index: 31 },
          { left: 389.0379441299999, right: 393.0653136299999, index: 33 },
          { left: 402.2372553899999, right: 406.2646248899999, index: 34 }
        ],
        22
      ],
      [39, [], 22],
      [40, [], 22],
      [41, [], 22],
      [42, [], 22],
      [43, [], 23],
      [
        44,
        [
          { left: 268.06517898, right: 272.09254848, index: 5 },
          { left: 284.81171360999997, right: 288.83908311, index: 8 },
          { left: 309.6726132299999, right: 313.69998272999993, index: 12 },
          { left: 328.1734072499999, right: 332.20077674999993, index: 14 },
          { left: 341.3727185099999, right: 345.4000880099999, index: 15 }
        ],
        23
      ],
      [45, [], 23],
      [46, [], 23],
      [47, [], 23],
      [48, [], 23],
      [49, [], 24],
      [50, [], 25],
      [51, [], 26],
      [52, [{ left: 728.15710101, right: 732.18447051, index: 7 }], 27]
    ],
    rules: [
      [136.0365, 533.481, 781.9620065917968, 533.481],
      [136.0365, 553.1624999999999, 781.9620065917968, 553.1624999999999],
      [136.0365, 620.6624999999999, 781.9620065917968, 620.6624999999999]
    ],
    caption: [81, 481.96559999999994, 836.9937407999996, 513.084],
    crop: [127, 528, 792, 630],
    objects: [
      ['table row', 15.159184783697128, 64.28780490159988, 651.3819845020771, 75.98703664541245],
      ['table column', 398.29898439347744, 28.29447340965271, 451.7737177759409, 87.2864842414856],
      [
        'table column',
        307.2350322455168,
        28.233497321605682,
        355.47719426453114,
        87.34882217645645
      ],
      ['table column', 356.00164249539375, 28.15356481075287, 401.4332376420498, 87.31832349300385],
      ['table row', 15.13700783252716, 39.33644986152649, 651.1206769943237, 51.3515510559082],
      [
        'table column',
        14.554045349359512,
        28.347114264965057,
        88.36853101849556,
        86.97196751832962
      ],
      ['table row', 15.001191347837448, 52.495508551597595, 651.5769197046757, 64.25032675266266],
      ['table row', 15.232374668121338, 28.146015375852585, 651.345340013504, 39.42505958676338],
      ['table column', 455.4365811496973, 28.178573548793793, 517.3033978790045, 87.42478162050247],
      ['table column', 514.9710326641798, 28.22565758228302, 652.0482344180346, 87.32548534870148],
      ['table row', 15.288599878549576, 75.88019853830338, 651.1308042705059, 87.06568568944931],
      ['table column', 91.3383200764656, 28.44838947057724, 300.3076285123825, 87.24924927949905],
      ['table', 15.096498727798462, 28.055785417556763, 651.1994755268097, 87.24049758911133]
    ]
  })

const jointLiteralGrid = [
  ['CohortXX', 'SourceX', 'Max'],
  ['XXXX', 'XXXXXXXXXX-1.5 (XX-XX, 2025)', '100k'],
  ['XXXXXXXX', 'XXXXX (XXX XX XX., 2021)', '9,178'],
  ['XXX', 'XXXX-XXX (XXX XX XX., 2023)', '50k'],
  ['XXXXXXX', 'XXXXXXXXXXXXXXXX (XX XX XX., 2025X)', '10k']
]
const wrappedLiteralGrid = [
  [
    'Platform',
    'Toolchain',
    'task 01 byte-equal (7×200=1400 trials)',
    'task 02 byte-equal (3×500=1500 trials)'
  ],
  ['SysAA 14.5', 'Vm 3.11.7 + Engine 3.1.4', '1400/1400 (100%)', '1500/1500 (100%)'],
  ['HostBB 24.04', 'Vm 3.11.15 + Engine 3.1.4', '1400/1400 (100%)', '1500/1500 (100%)']
]
const existingLiteralGrid = [
  ['Training set', 'Sources', 'MethodA', 'Algo', 'Model', 'BaselineXYZ', 'MethodA − Algo'],
  ['Set-AA', 'Set Exampletown, C2', '0.425', '0.500', '0.467', '0.148', ''],
  ['Set-BBBB', 'Set Lab’s, C2', '0.407', '0.576', '0.507', '0.158', ''],
  [
    'Set-AA+BBBB',
    'Set, both sites, C2',
    '0.497',
    '0.539',
    '0.519',
    '0.166',
    '−0.042 [−0.060, −0.025]'
  ],
  ['Base+Set-AA', 'Base, Set Exampletown, C1 + C2', '0.521', '0.496', '0.417', '0.152', ''],
  [
    'Base+Set',
    'Base, all Set, C1 + C2',
    '0.552',
    '0.452',
    '0.216',
    '0.161',
    '+0.100 [0.079, 0.121]'
  ]
]
const literalNativeSignature = (i: ReturnType<typeof JSON.parse>): string =>
  JSON.stringify([i.text, i.rect, i.baseline, i.height])
const splitLiteralExpectation = (
  f: ReturnType<typeof JSON.parse>,
  text: string,
  labels: string[]
): ReturnType<typeof JSON.parse>[] => {
  const original = f.items.find((i: { text: string }) => i.text === text),
    observed = f.runs.find((i: { text: string }) => i.text === text),
    gap = observed.gaps[0]
  return labels.map((label, n) => ({
    ...original,
    text: label,
    rect: [
      n ? gap.right : original.rect[0],
      original.rect[1],
      n ? original.rect[2] : gap.left,
      original.rect[3]
    ]
  }))
}
const literalOutput = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof refineTable> =>
  refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)

it('preserves singleton and blank stub owners without a complete correct fenced calibration', () => {
  const f = fixture('uncalibrated-fenced-singleton-stubs'),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result).toEqual(f.expectedBefore)
  expect(result.cells).toHaveLength(45)
  expect(result.repairs).not.toContain('native-fenced-composite-stub-owners-recovered')
  expect(f).toEqual(before)
})

it('moves only a one-line fenced stub into its proved complete record group', () => {
  const f = fixture('fenced-single-line-stub-owners'),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.cells).toHaveLength(f.expectedCells.length)
  for (const expected of f.expectedCells)
    expect(
      result.cells.find(
        (c: { row: number; column: number }) =>
          c.row === expected.row && c.column === expected.column
      )
    ).toEqual(expected)
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(f.items.map(literalNativeSignature).sort())
  expect(result.cropRect).toEqual(f.expectedCropRect)
  expect(result.rows).toEqual(f.expectedBefore.rows)
  expect(result.unassigned).toEqual(f.expectedBefore.unassigned)
  expect(result.clipped).toEqual(f.expectedBefore.clipped)
  expect(result.issues).toEqual(f.expectedBefore.issues)
  expect(result.reviewCandidate).toBe(f.expectedBefore.reviewCandidate)
  expect(result.repairs).toEqual([
    ...f.expectedBefore.repairs,
    'native-fenced-single-line-stub-owners-recovered'
  ])
  expect(f).toEqual(before)
})

it.each([
  'missing-title',
  'missing-fence',
  'missing-peer',
  'unsupported-underline',
  'rotated-foreign'
])('refuses the one-line fenced stub consumer repair with %s', (change) => {
  const f = fixture('fenced-single-line-stub-owners'),
    closing = [...f.rules]
      .filter((r: number[]) => r[2] - r[0] > 400)
      .sort((a: number[], b: number[]) => a[1] - b[1])[2]
  if (change === 'missing-title') f.captions = []
  if (change === 'missing-fence') f.rules = f.rules.filter((r: unknown) => r !== closing)
  if (change === 'missing-peer') {
    const peer = f.retainedCells.find(
      (c: { row: number; column: number }) => c.row === 1 && c.column === 2
    )
    f.items = f.items.filter(
      (i: { rect: number[] }) => JSON.stringify(i.rect) !== JSON.stringify(peer.sourceRects[0])
    )
  }
  if (change === 'unsupported-underline') {
    const rule = f.rules.find((r: number[]) => r[0] > 350 && r[2] - r[0] < 40)
    rule[2] -= 2
  }
  if (change === 'rotated-foreign')
    f.items.push({
      text: 'foreign',
      rect: [350, 320, 360, 330],
      baseline: 330,
      height: 10,
      horizontal: false
    })
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.repairs).not.toContain('native-fenced-single-line-stub-owners-recovered')
  expect(f).toEqual(before)
})

it.each(['paired-native-ci-multilevel-records', 'paired-native-ci-marked-records'])(
  'recovers native paired literal CI records with complete existing header and rich ownership: %s',
  (kind) => {
    const f = fixture(kind),
      before = structuredClone(f),
      result = literalOutput(f)
    expect(result).toEqual({
      ...f.expected,
      repairs: [...f.expected.repairs, 'native-paired-literal-row-bands-recovered']
    })
    for (const header of f.originalHeaderCells)
      expect(
        result.cells.find(
          (c: { row: number; column: number }) => c.row === header.row && c.column === header.column
        )
      ).toEqual(header)
    expect(f).toEqual(before)
  }
)

const pairedCiSourceChange = (f: ReturnType<typeof JSON.parse>, change: string): void => {
  const field = f.expected.cells.find(
      (c: { row: number; column: number }) =>
        c.row === f.headerRows && c.column === f.expected.grid[0].length - 1
    ),
    matches = (
      i: { text: string; rect: number[] },
      token: { text: string; rect: number[] }
    ): boolean => i.text === token.text && JSON.stringify(i.rect) === JSON.stringify(token.rect),
    leaf = f.items.find((i: { text: string; rect: number[] }) => matches(i, field.sourceTokens[0])),
    run = f.runs.find((i: { text: string; rect: number[] }) => matches(i, leaf)),
    full = f.rules
      .filter((r: number[]) => r[2] - r[0] > (f.table.cropRect[2] - f.table.cropRect[0]) * 0.9)
      .sort((a: number[], b: number[]) => a[1] - b[1]),
    partial = f.rules.find((r: number[]) => r[2] - r[0] < 200 && r[2] - r[0] > 50)
  if (change === 'missing-title') f.captions = []
  if (change === 'competing-title')
    f.captions.push(
      structuredClone(f.captions.find((c: { lines: string[] }) => /^TABLE\b/u.test(c.lines[0])))
    )
  if (change === 'missing-opening') f.rules = f.rules.filter((r: unknown) => r !== full[0])
  if (change === 'missing-divider') f.rules = f.rules.filter((r: unknown) => r !== full[1])
  if (change === 'missing-closing') f.rules = f.rules.filter((r: unknown) => r !== full.at(-1))
  if (change === 'missing-parent-rule') f.rules = f.rules.filter((r: unknown) => r !== partial)
  if (change === 'competing-parent-rule')
    f.rules.push(partial.map((v: number, n: number) => v + (n % 2 ? 0.5 : 0)))
  if (change === 'missing-measured-face') {
    f.items = f.items.filter(
      (i: { text: string; rect: number[] }) =>
        !field.sourceTokens.some((t: { text: string; rect: number[] }) => matches(i, t))
    )
    f.runs = f.runs.filter(
      (i: { text: string; rect: number[] }) =>
        !field.sourceTokens.some((t: { text: string; rect: number[] }) => matches(i, t))
    )
  }
  if (change === 'miscentered-literal-face') {
    leaf.rect[0] += 1
    leaf.rect[2] += 1
    run.rect = [...leaf.rect]
  }
  if (change === 'inside-font-gutter') {
    leaf.rect[0] -= 12
    leaf.rect[2] += 12
    run.rect = [...leaf.rect]
  }
  if (change === 'wrong-native-baseline') {
    leaf.baseline += 1
    run.baseline = leaf.baseline
  }
  if (change === 'nonhorizontal-foreign')
    f.items.push({
      text: 'foreign',
      rect: [550, 730, 560, 740],
      baseline: 740,
      height: 10,
      horizontal: false
    })
  if (change === 'duplicate-native') f.items.push(structuredClone(leaf))
  if (change === 'missing-program') f.runs = f.runs.filter((r: unknown) => r !== run)
  if (change === 'duplicate-program') f.runs.push(structuredClone(run))
  if (change === 'competing-program-font') {
    const duplicate = structuredClone(run)
    duplicate.baseline += 0.01
    f.runs.push(duplicate)
  }
  if (change === 'program-baseline') run.baseline += 0.01
  if (change === 'program-height') run.height += 0.01
  if (change === 'program-glyphs') run.literalGlyphs[0] = 'X'
  if (change === 'multiple-programs') run.glyphRuns[0] += 1
  if (change === 'model-missing-leaf') {
    const column = f.table.structure.objects.find(
      (o: { label: string }) => o.label === 'table column'
    )
    f.table.structure.objects = f.table.structure.objects.filter((o: unknown) => o !== column)
  }
  if (change === 'model-cut-inside-body') {
    const columns = f.table.structure.objects
        .filter((o: { label: string }) => o.label === 'table column')
        .sort((a: { rect: number[] }, b: { rect: number[] }) => a.rect[0] - b.rect[0]),
      cut = leaf.rect[0] + 1 - f.table.cropRect[0]
    columns.at(-2).rect[2] = cut
    columns.at(-1).rect[0] = cut
  }
  if (change === 'invalid-model-column')
    f.table.structure.objects.find((o: { label: string }) => o.label === 'table column').rect[0] =
      Number.NaN
  if (change === 'record-cut-native-rule')
    f.rules.push([full[0][0], leaf.baseline - 1, full[0][2], leaf.baseline - 1])
}

it.each([
  'missing-title',
  'competing-title',
  'missing-opening',
  'missing-divider',
  'missing-closing',
  'missing-parent-rule',
  'competing-parent-rule',
  'missing-measured-face',
  'miscentered-literal-face',
  'inside-font-gutter',
  'wrong-native-baseline',
  'nonhorizontal-foreign',
  'duplicate-native',
  'missing-program',
  'duplicate-program',
  'competing-program-font',
  'program-baseline',
  'program-height',
  'program-glyphs',
  'multiple-programs',
  'model-missing-leaf',
  'model-cut-inside-body',
  'invalid-model-column',
  'record-cut-native-rule'
])(
  'requires complete native header, record, program and leaf proof for paired CI rows: %s',
  (change) => {
    const f = fixture('paired-native-ci-multilevel-records')
    pairedCiSourceChange(f, change)
    const before = structuredClone(f),
      result = literalOutput(f)
    expect(result.repairs).not.toContain('native-paired-literal-row-bands-recovered')
    expect(f).toEqual(before)
  }
)

it.each(['paired-native-ci-multilevel-records', 'paired-native-ci-marked-records'])(
  'preserves CI literal/rich records with equivalent native paint and translated reversed source: %s',
  (kind) => {
    const f = fixture(kind),
      grid = structuredClone(f.expected.grid),
      translate = (r: number[]): number[] => r.map((v, n) => v + (n % 2 ? 37 : 19))
    f.rules.push(
      ...f.rules
        .filter((r: number[]) => r[2] - r[0] > 350)
        .map((r: number[]) => [r[0], r[1], r[2] - 1, r[3]])
    )
    f.table.cropRect = translate(f.table.cropRect)
    f.rules = f.rules.map((r: number[]) => translate(r)).reverse()
    for (const c of f.captions) c.rect = translate(c.rect)
    for (const i of [...f.items, ...f.runs]) {
      i.rect = translate(i.rect)
      i.baseline += 37
      if (i.gaps)
        i.gaps = i.gaps.map((g: { left: number; right: number }) => ({
          ...g,
          left: g.left + 19,
          right: g.right + 19
        }))
    }
    f.items.reverse()
    f.runs.reverse()
    const before = structuredClone(f),
      result = literalOutput(f)
    expect(result.grid).toEqual(grid)
    expect(result.repairs).toContain('native-paired-literal-row-bands-recovered')
    const body = result.cells.filter((c: { row: number }) => c.row >= f.headerRows)
    const originalBody = f.expected.cells.filter((c: { row: number }) => c.row >= f.headerRows)
    expect(body.map((c: { text: string; textRuns?: unknown }) => [c.text, c.textRuns])).toEqual(
      originalBody.map((c: { text: string; textRuns?: unknown }) => [c.text, c.textRuns])
    )
    expect(f).toEqual(before)
  }
)

it('uses a witnessed native header TJ gutter without merging descriptive body fields', () => {
  const f = jointDescriptiveHeader(),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(jointLiteralGrid)
  const expected = [
    ...f.items.filter((i: { text: string }) => i.text !== 'CohortXX SourceX'),
    ...splitLiteralExpectation(f, 'CohortXX SourceX', ['CohortXX', 'SourceX'])
  ]
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(expected.map(literalNativeSignature).sort())
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(before)
})

it('keeps two complete literal version records and uniquely centered wrapped headings inside the native frame', () => {
  const f = twoWrappedLiteralRecords(),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(wrappedLiteralGrid)
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(f.items.map(literalNativeSignature).sort())
  expect(result.cropRect[2]).toBeGreaterThanOrEqual(f.rules[0][2])
  expect(
    result.cells
      .filter((c: { row: number }) => c.row === 0)
      .map((c: { rowSpan: number; colSpan: number }) => [c.rowSpan, c.colSpan])
  ).toEqual([
    [1, 1],
    [1, 1],
    [1, 1],
    [1, 1]
  ])
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(before)
})

it('splits one descriptive donor into two existing leaves while retaining printed terminal blanks and interval glyphs', () => {
  const f = joinedExistingDescriptiveFaces(),
    before = structuredClone(f),
    result = literalOutput(f),
    joined = 'Base+Set-AA Base, Set Exampletown, C1 + C2'
  expect(result.grid).toEqual(existingLiteralGrid)
  const body = f.items.filter((i: { baseline: number }) => i.baseline > f.rules[1][1]),
    expected = [
      ...body.filter((i: { text: string }) => i.text !== joined),
      ...splitLiteralExpectation(f, joined, ['Base+Set-AA', 'Base, Set Exampletown, C1 + C2'])
    ]
  expect(
    result.cells
      .filter((c: { row: number }) => c.row > 0)
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(expected.map(literalNativeSignature).sort())
  expect(
    result.cells
      .filter((c: { column: number; row: number }) => c.column === 6 && [1, 2, 4].includes(c.row))
      .map((c: { text: string; sourceRects: number[][] }) => [c.text, c.sourceRects])
  ).toEqual([
    ['', []],
    ['', []],
    ['', []]
  ])
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(before)
})

it.each(['no-title', 'no-closing', 'no-TJ', 'bad-glyphs', 'body-gutter'])(
  'retains the unsplit descriptive header without unique native proof: %s',
  (control) => {
    const f = jointDescriptiveHeader()
    if (control === 'no-title') f.captions = []
    if (control === 'no-closing') f.rules.pop()
    if (control === 'no-TJ') f.runs[0].gaps = []
    if (control === 'bad-glyphs') f.runs[0].literalGlyphs = ['wrong']
    if (control === 'body-gutter')
      f.items.find((i: { text: string }) => i.text === 'XXXXXXXXXX-1.5 (XX-XX, 2025)').rect[0] =
        371.5
    const result = literalOutput(f)
    expect(result.cells.some((c: { text: string }) => c.text === 'CohortXX SourceX')).toBe(true)
    expect(result.cells.some((c: { text: string }) => c.text === 'CohortXX')).toBe(false)
  }
)

it.each(['no-title', 'no-closing', 'wrong-title-width', 'competing-frame', 'off-center-wrap'])(
  'does not rebuild literal version fields without unique complete width and header proof: %s',
  (control) => {
    const f = twoWrappedLiteralRecords()
    if (control === 'no-title') f.captions = []
    if (control === 'no-closing') f.rules.pop()
    if (control === 'wrong-title-width') f.captions[0].rect[2] -= 10
    if (control === 'competing-frame')
      f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1] + 2, r[2] - 3, r[3] + 2]))
    if (control === 'off-center-wrap')
      for (const i of f.items.filter(
        (i: { baseline: number }) => Math.abs(i.baseline - 253.785) < 0.02
      )) {
        i.rect[0] += 5
        i.rect[2] += 5
      }
    const result = literalOutput(f)
    expect(result.cells.some((c: { text: string }) => c.text === 'Vm 3.11.7 + Engine 3.1.4')).toBe(
      false
    )
  }
)

it('counts redundant native prefix paint once while retaining complete literal version records', () => {
  const f = twoWrappedLiteralRecords(),
    original = literalOutput(f)
  f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1], r[2] - 3, r[3]]))
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result).toEqual(original)
  expect(result.grid).toEqual(wrappedLiteralGrid)
  expect(f).toEqual(before)
})

it.each(['no-title', 'no-closing', 'no-TJ', 'bad-glyphs', 'foreign-recipient'])(
  'keeps an existing descriptive donor intact when literal ownership is not unique: %s',
  (control) => {
    const f = joinedExistingDescriptiveFaces(),
      joined = 'Base+Set-AA Base, Set Exampletown, C1 + C2',
      observed = f.runs.find((r: { text: string }) => r.text === joined)
    if (control === 'no-title') f.captions = []
    if (control === 'no-closing') f.rules.pop()
    if (control === 'no-TJ') observed.gaps = []
    if (control === 'bad-glyphs') observed.literalGlyphs = ['wrong']
    if (control === 'foreign-recipient')
      f.items.push({
        text: 'foreign key',
        rect: [136.0365, 591.4893, 196.0365, 601.95],
        baseline: 601.95,
        height: 10.4607,
        horizontal: true
      })
    const result = literalOutput(f)
    expect(result.cells.some((c: { text: string }) => c.text.includes(joined))).toBe(true)
    expect(result.cells.some((c: { text: string }) => c.text === 'Base+Set-AA')).toBe(false)
  }
)

it.each([
  [jointDescriptiveHeader, jointLiteralGrid],
  [twoWrappedLiteralRecords, wrappedLiteralGrid],
  [joinedExistingDescriptiveFaces, existingLiteralGrid]
] as const)(
  'retains source field ownership under translation and reversed native order',
  (factory, grid) => {
    const f = factory(),
      translate = (rect: number[], relative = false): number[] =>
        rect.map((v, n) => v + (relative ? 0 : n % 2 ? 71 : 33))
    f.table.cropRect = translate(f.table.cropRect)
    f.rules = f.rules.map((r: number[]) => translate(r)).reverse()
    for (const c of f.captions) c.rect = translate(c.rect)
    for (const i of [...f.items, ...f.runs]) {
      i.rect = translate(i.rect)
      i.baseline += 71
      if (i.gaps)
        i.gaps = i.gaps.map((g: { left: number; right: number; index: number }) => ({
          ...g,
          left: g.left + 33,
          right: g.right + 33
        }))
    }
    f.items.reverse()
    f.runs.reverse()
    const before = structuredClone(f),
      result = literalOutput(f)
    expect(result.grid).toEqual(grid)
    expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toEqual(
      characters(f.items.map((i: { text: string }) => i.text).join(''))
    )
    expect(f).toEqual(before)
  }
)

// Two finite literal layouts: existing complete body owners constrain any
// repair to the witnessed terminal donor or printed header partition.
const terminalLiteralPeers = (): ReturnType<typeof JSON.parse> =>
  literalSourceFixture({
    name: 'terminalLiteralPeers',
    items: [
      ['XXXXXXX', 204.49200000000002, 598.7469, 253.07195520000002, 612.1965, 13.4496],
      ['XXXXXXX', 298.7064480000001, 598.7469, 341.7855168000001, 612.1965, 13.4496],
      ['XXXXXXXXX XXX.', 359.7272832000002, 598.7469, 435.3409344000002, 612.1965, 13.4496],
      ['XXXX. XXXXXXXX', 453.28270080000016, 598.7469, 534.8814240000002, 612.1965, 13.4496],
      ['XXXX. XXXXXXXX', 552.8097408000001, 598.7469, 638.0129568000001, 612.1965, 13.4496],
      ['XXXX. XXXX', 655.9412735999999, 598.7469, 713.5055616, 612.1965, 13.4496],
      ['X', 204.82799999999997, 621.1944, 212.30597759999998, 634.644, 13.4496],
      ['XXXXXX', 212.97307590000003, 623.88435, 252.55782825, 634.644, 10.75965],
      ['1', 310.29696105, 621.1944, 317.20871049, 634.644, 13.4496],
      [',', 317.20871049, 621.1944, 321.04857129, 634.644, 13.4496],
      ['889', 321.04857129, 621.1944, 341.78381960999997, 634.644, 13.4496],
      ['539', 414.6134036099999, 621.1944, 435.3486519299999, 634.644, 13.4496],
      ['.', 510.3032727299999, 621.1944, 514.1431335299999, 634.644, 13.4496],
      ['195', 514.1431335299999, 621.1944, 534.8783818499999, 634.644, 13.4496],
      ['.', 613.4374954499998, 621.1944, 617.2773562499998, 634.644, 13.4496],
      ['470', 617.2773562499998, 621.1944, 638.0126045699998, 634.644, 13.4496],
      ['.', 685.7990333699997, 621.1944, 689.6388941699997, 634.644, 13.4496],
      ['299', 689.6388941699997, 621.1944, 713.5132791299998, 634.644, 13.4496],
      ['X', 204.82799999999997, 636.1374, 214.53861119999996, 649.587, 13.4496],
      ['XXXXXXXX', 215.21646914999997, 638.82735, 280.45222709999996, 649.587, 10.75965],
      ['3', 310.2968894999999, 636.1374, 317.2086389399999, 649.587, 13.4496],
      [',', 317.2086389399999, 636.1374, 321.0484997399999, 649.587, 13.4496],
      ['327', 321.0484997399999, 636.1374, 341.7837480599999, 649.587, 13.4496],
      ['382', 414.61333205999983, 636.1374, 435.3485803799998, 649.587, 13.4496],
      ['.', 510.3032011799998, 636.1374, 514.1430619799999, 649.587, 13.4496],
      ['225', 514.1430619799999, 636.1374, 534.8783102999998, 649.587, 13.4496],
      ['—', 624.5602430999998, 636.1374, 638.0098430999998, 649.587, 13.4496],
      ['—', 700.0528478999998, 636.1374, 713.5024478999999, 649.587, 13.4496]
    ],
    observed: [
      [0, [], 185],
      [1, [], 185],
      [
        2,
        [
          {
            left: 409.93464000000023,
            right: 413.29704000000027,
            index: 9
          }
        ],
        185
      ],
      [
        3,
        [
          {
            left: 479.21352960000024,
            right: 482.5759296000002,
            index: 5
          }
        ],
        185
      ],
      [
        4,
        [
          {
            left: 582.3450624000002,
            right: 585.7074624000002,
            index: 5
          }
        ],
        185
      ],
      [
        5,
        [
          {
            left: 685.4765951999998,
            right: 688.8389951999999,
            index: 5
          }
        ],
        185
      ],
      [6, [], 197],
      [7, [], 199],
      [8, [], 202],
      [9, [], 205],
      [10, [], 207],
      [11, [], 207],
      [12, [], 209],
      [13, [], 211],
      [14, [], 213],
      [15, [], 215],
      [16, [], 217],
      [17, [], 220],
      [18, [], 223],
      [19, [], 225],
      [20, [], 227],
      [21, [], 229],
      [22, [], 231],
      [23, [], 231],
      [24, [], 233],
      [25, [], 235],
      [26, [], 237],
      [27, [], 237]
    ],
    rules: [
      [195.52499999999998, 596.955, 722.4735168457031, 596.955],
      [195.52499999999998, 619.6274999999999, 722.4735168457031, 619.6274999999999],
      [195.52499999999998, 657.2415, 722.4735168457031, 657.2415]
    ],
    caption: [162, 497.481599999999, 756.0050810999999, 578.1779999999991],
    crop: [192, 593, 724, 666],
    objects: [
      [
        'table column',
        278.73398554325104,
        29.440498769283295,
        378.7599548101425,
        58.66055577993393
      ],
      [
        'table column',
        11.885410964488983,
        28.995877623558044,
        100.63527852296829,
        58.4121013879776
      ],
      ['table row', 11.650545358657837, 29.071931183338165, 513.9145793914795, 43.78048688173294],
      [
        'table column',
        384.3334844112396,
        29.238708168268204,
        468.29568314552307,
        58.358232110738754
      ],
      ['table column', 182.4388017654419, 29.55436807870865, 279.6477155685425, 58.621526062488556],
      ['table row', 11.470149040222168, 44.51869134604931, 514.2702984809875, 58.036751464009285],
      ['table column', 99.99103313684464, 29.44653706252575, 184.94940704107285, 58.3749568015337],
      ['table', 11.673550724983215, 29.457579165697098, 513.9743045568466, 58.18416914343834]
    ]
  })

const uniqueCenteredLiteralHeadings = (): ReturnType<typeof JSON.parse> =>
  literalSourceFixture({
    name: 'uniqueCenteredLiteralHeadings',
    items: [
      ['XXXXXX', 122.26500000000001, 874.5423000000001, 162.47070045, 885.003, 10.4607],
      [
        'XXXXX XXXXXX XXXX (XXXXXX XXXXX) XXXXXXX XXX (XXXXXX XXXXX) XXXX',
        204.55409655,
        874.5423000000001,
        558.0818216099999,
        885.003,
        10.4607
      ],
      ['∆', 562.10919111, 874.5423000000001, 572.09288319, 885.003, 10.4607],
      ['XXXXX XXX', 572.09288319, 874.5423000000001, 641.6900124299999, 885.003, 10.4607],
      ['|', 645.7173819300001, 874.5423000000001, 649.2666974400001, 885.003, 10.4607],
      ['∆', 649.26669744, 874.5423000000001, 659.25038952, 885.003, 10.4607],
      ['XXXXX', 659.2503895200001, 874.5423000000001, 702.6152213700001, 885.003, 10.4607],
      ['|', 702.6152213700002, 874.5423000000001, 706.1645368800002, 885.003, 10.4607],
      ['XXX', 710.3488168800002, 874.5423000000001, 732.3968342700002, 885.003, 10.4607],
      ['|', 736.4242037700002, 874.5423000000001, 739.9735192800002, 885.003, 10.4607],
      ['∆', 739.9735192800001, 874.5423000000001, 749.9572113600001, 885.003, 10.4607],
      ['XXXXX', 749.9572113600002, 874.5423000000001, 792.1807808400002, 885.003, 10.4607],
      ['|', 792.1807808400004, 874.5423000000001, 795.7300963500004, 885.003, 10.4607],
      ['XXXXXXX', 122.26500000000001, 893.9988000000001, 179.15342481, 904.4595, 10.4607],
      ['0.038', 275.37094341, 893.9988000000001, 302.57399376, 904.4595, 10.4607],
      ['0.001', 438.29111556000004, 893.9988000000001, 465.49416591000005, 904.4595, 10.4607],
      ['-0.0000', 554.33689101, 893.9988000000001, 591.52049523, 904.4595, 10.4607],
      ['0.0000', 646.3241025300001, 893.9988000000001, 679.4824293900001, 904.4595, 10.4607],
      ['0.0000', 736.4618622900001, 893.9988000000001, 769.6201891500001, 904.4595, 10.4607],
      ['XXXX', 122.26500000000001, 905.9538000000001, 157.13678952, 916.4145000000001, 10.4607],
      ['0.649', 275.36362091999996, 905.9538000000001, 302.56667127, 916.4145000000001, 10.4607],
      [
        '0.091',
        438.29425376999995,
        905.9538000000001,
        465.49730411999997,
        916.4145000000001,
        10.4607
      ],
      ['-0.0020', 554.34002922, 905.9538000000001, 591.52363344, 916.4145000000001, 10.4607],
      ['0.0464', 646.32724074, 905.9538000000001, 679.4855676, 916.4145000000001, 10.4607],
      [
        '0.0020',
        736.4650005000001,
        905.9538000000001,
        769.6233273600001,
        916.4145000000001,
        10.4607
      ],
      ['XXXXX', 122.26500000000001, 917.9103000000001, 164.34630396, 928.3710000000001, 10.4607],
      ['0.256', 275.36571306, 917.9103000000001, 302.56876341000003, 928.3710000000001, 10.4607],
      ['0.091', 438.29634591, 917.9103000000001, 465.49939626, 928.3710000000001, 10.4607],
      [
        '-0.0016',
        554.3421213600001,
        917.9103000000001,
        591.5257255800001,
        928.3710000000001,
        10.4607
      ],
      ['0.0391', 646.32933288, 917.9103000000001, 679.48765974, 928.3710000000001, 10.4607],
      [
        '0.0020',
        736.4670926400001,
        917.9103000000001,
        769.6254195000001,
        928.3710000000001,
        10.4607
      ],
      ['XXXXXXXXXXX', 122.26500000000001, 929.8653, 200.37086262000003, 940.326, 10.4607],
      ['0.165', 275.36362091999996, 929.8653, 302.56667127, 940.326, 10.4607],
      ['0.000', 438.29425376999995, 929.8653, 465.49730411999997, 940.326, 10.4607],
      ['-0.0000', 554.34002922, 929.8653, 591.52363344, 940.326, 10.4607],
      ['0.0076', 646.32724074, 929.8653, 679.4855676, 940.326, 10.4607],
      ['0.0037', 736.4650005000001, 929.8653, 769.6233273600001, 940.326, 10.4607]
    ],
    observed: [
      [0, [], 395],
      [
        1,
        [
          {
            left: 231.75714689999998,
            right: 235.78451639999997,
            index: 5
          },
          {
            left: 267.07351617,
            right: 271.10088566999997,
            index: 11
          },
          {
            left: 291.06199341,
            right: 295.08936291,
            index: 15
          },
          {
            left: 337.41963152999995,
            right: 341.4470010299999,
            index: 22
          },
          {
            left: 373.38351812999986,
            right: 377.5677981299999,
            index: 28
          },
          {
            left: 414.8162586899998,
            right: 418.8436281899998,
            index: 35
          },
          {
            left: 443.89491254999984,
            right: 447.9222820499998,
            index: 38
          },
          {
            left: 490.2525506699998,
            right: 494.2799201699998,
            index: 45
          },
          {
            left: 526.2164372699999,
            right: 530.4007172699999,
            index: 51
          }
        ],
        395
      ],
      [2, [], 397],
      [
        3,
        [
          {
            left: 615.4577150399999,
            right: 619.64199504,
            index: 5
          }
        ],
        399
      ],
      [4, [], 401],
      [5, [], 403],
      [6, [], 405],
      [7, [], 407],
      [8, [], 409],
      [9, [], 411],
      [10, [], 413],
      [11, [], 415],
      [12, [], 417],
      [13, [], 429],
      [14, [], 429],
      [15, [], 429],
      [16, [], 429],
      [17, [], 429],
      [18, [], 429],
      [19, [], 431],
      [20, [], 431],
      [21, [], 431],
      [22, [], 431],
      [23, [], 431],
      [24, [], 431],
      [25, [], 433],
      [26, [], 433],
      [27, [], 433],
      [28, [], 433],
      [29, [], 433],
      [30, [], 433],
      [31, [], 435],
      [32, [], 435],
      [33, [], 435],
      [34, [], 435],
      [35, [], 435],
      [36, [], 435]
    ],
    rules: [
      [122.26500000000001, 871.8555, 795.733505859375, 871.8555],
      [122.26500000000001, 891.537, 795.733505859375, 891.537],
      [122.26500000000001, 947.082, 795.733505859375, 947.082]
    ],
    caption: [81, 822.3173999999999, 837.0006710399994, 852.2054999999999],
    crop: [111, 867, 803, 955],
    objects: [
      ['table row', 15.608591794967651, 50.22127389907837, 658.3913905620575, 61.68373346328735],
      ['table column', 405.8235104084015, 28.33029556274414, 509.71514344215393, 72.81025314331055],
      ['table column', 267.2886222600937, 28.4499990940094, 400.1533452272415, 73.19662833213806],
      ['table row', 15.503599047660828, 38.94176721572876, 658.4685419797897, 50.852073192596436],
      [
        'table column',
        15.715368449687958,
        28.313794136047363,
        115.55167466402054,
        72.40128421783447
      ],
      ['table row', 15.916186928749084, 28.263906955718994, 658.8675185441971, 39.62193441390991],
      ['table column', 513.5610828399658, 28.1185622215271, 599.1044135093689, 72.66166162490845],
      ['table column', 600.4870758056641, 28.23944330215454, 659.3678994178772, 72.79512071609497],
      ['table row', 15.649240136146545, 60.981261014938354, 658.4435054063797, 72.20965313911438],
      [
        'table column',
        117.14908641576767,
        28.383434772491455,
        259.45880514383316,
        72.61964750289917
      ],
      ['table', 15.858359456062317, 28.22668957710266, 658.6601315736771, 72.44373106956482]
    ]
  })

const terminalLiteralGrid = [
  ['XXXXXXX', 'XXXXXXX', 'XXXXXXXXX XXX.', 'XXXX. XXXXXXXX', 'XXXX. XXXXXXXX', 'XXXX. XXXX'],
  ['XXXXXXX', '1,889', '539', '.195', '.470', '.299'],
  ['XXXXXXXXX', '3,327', '382', '.225', '—', '—']
]

const uniqueCenteredLiteralGrid = [
  [
    'XXXXXX',
    'XXXXX XXXXXX XXXX (XXXXXX XXXXX)',
    'XXXXXXX XXX (XXXXXX XXXXX)',
    'XXXX ∆XXXXX',
    'XXX |∆XXXXX|',
    'XXX |∆XXXXX|'
  ],
  ['XXXXXXX', '0.038', '0.001', '-0.0000', '0.0000', '0.0000'],
  ['XXXX', '0.649', '0.091', '-0.0020', '0.0464', '0.0020'],
  ['XXXXX', '0.256', '0.091', '-0.0016', '0.0391', '0.0020'],
  ['XXXXXXXXXXX', '0.165', '0.000', '-0.0000', '0.0076', '0.0037']
]

const centeredLiteralBodyCells = [
  {
    row: 1,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXXXXX',
    sourceRects: [[122.26500000000001, 893.9988000000001, 179.15342481, 904.4595]],
    textRuns: []
  },
  {
    row: 1,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: '0.038',
    sourceRects: [[275.37094341, 893.9988000000001, 302.57399376, 904.4595]],
    textRuns: []
  },
  {
    row: 1,
    column: 2,
    rowSpan: 1,
    colSpan: 1,
    text: '0.001',
    sourceRects: [[438.29111556000004, 893.9988000000001, 465.49416591000005, 904.4595]],
    textRuns: []
  },
  {
    row: 1,
    column: 3,
    rowSpan: 1,
    colSpan: 1,
    text: '-0.0000',
    sourceRects: [[554.33689101, 893.9988000000001, 591.52049523, 904.4595]],
    textRuns: []
  },
  {
    row: 1,
    column: 4,
    rowSpan: 1,
    colSpan: 1,
    text: '0.0000',
    sourceRects: [[646.3241025300001, 893.9988000000001, 679.4824293900001, 904.4595]],
    textRuns: []
  },
  {
    row: 1,
    column: 5,
    rowSpan: 1,
    colSpan: 1,
    text: '0.0000',
    sourceRects: [[736.4618622900001, 893.9988000000001, 769.6201891500001, 904.4595]],
    textRuns: []
  },
  {
    row: 2,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXX',
    sourceRects: [[122.26500000000001, 905.9538000000001, 157.13678952, 916.4145000000001]],
    textRuns: []
  },
  {
    row: 2,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: '0.649',
    sourceRects: [[275.36362091999996, 905.9538000000001, 302.56667127, 916.4145000000001]],
    textRuns: []
  },
  {
    row: 2,
    column: 2,
    rowSpan: 1,
    colSpan: 1,
    text: '0.091',
    sourceRects: [[438.29425376999995, 905.9538000000001, 465.49730411999997, 916.4145000000001]],
    textRuns: []
  },
  {
    row: 2,
    column: 3,
    rowSpan: 1,
    colSpan: 1,
    text: '-0.0020',
    sourceRects: [[554.34002922, 905.9538000000001, 591.52363344, 916.4145000000001]],
    textRuns: []
  },
  {
    row: 2,
    column: 4,
    rowSpan: 1,
    colSpan: 1,
    text: '0.0464',
    sourceRects: [[646.32724074, 905.9538000000001, 679.4855676, 916.4145000000001]],
    textRuns: []
  },
  {
    row: 2,
    column: 5,
    rowSpan: 1,
    colSpan: 1,
    text: '0.0020',
    sourceRects: [[736.4650005000001, 905.9538000000001, 769.6233273600001, 916.4145000000001]],
    textRuns: []
  },
  {
    row: 3,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXXX',
    sourceRects: [[122.26500000000001, 917.9103000000001, 164.34630396, 928.3710000000001]],
    textRuns: []
  },
  {
    row: 3,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: '0.256',
    sourceRects: [[275.36571306, 917.9103000000001, 302.56876341000003, 928.3710000000001]],
    textRuns: []
  },
  {
    row: 3,
    column: 2,
    rowSpan: 1,
    colSpan: 1,
    text: '0.091',
    sourceRects: [[438.29634591, 917.9103000000001, 465.49939626, 928.3710000000001]],
    textRuns: []
  },
  {
    row: 3,
    column: 3,
    rowSpan: 1,
    colSpan: 1,
    text: '-0.0016',
    sourceRects: [[554.3421213600001, 917.9103000000001, 591.5257255800001, 928.3710000000001]],
    textRuns: []
  },
  {
    row: 3,
    column: 4,
    rowSpan: 1,
    colSpan: 1,
    text: '0.0391',
    sourceRects: [[646.32933288, 917.9103000000001, 679.48765974, 928.3710000000001]],
    textRuns: []
  },
  {
    row: 3,
    column: 5,
    rowSpan: 1,
    colSpan: 1,
    text: '0.0020',
    sourceRects: [[736.4670926400001, 917.9103000000001, 769.6254195000001, 928.3710000000001]],
    textRuns: []
  },
  {
    row: 4,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXXXXXXXXX',
    sourceRects: [[122.26500000000001, 929.8653, 200.37086262000003, 940.326]],
    textRuns: []
  },
  {
    row: 4,
    column: 1,
    rowSpan: 1,
    colSpan: 1,
    text: '0.165',
    sourceRects: [[275.36362091999996, 929.8653, 302.56667127, 940.326]],
    textRuns: []
  },
  {
    row: 4,
    column: 2,
    rowSpan: 1,
    colSpan: 1,
    text: '0.000',
    sourceRects: [[438.29425376999995, 929.8653, 465.49730411999997, 940.326]],
    textRuns: []
  },
  {
    row: 4,
    column: 3,
    rowSpan: 1,
    colSpan: 1,
    text: '-0.0000',
    sourceRects: [[554.34002922, 929.8653, 591.52363344, 940.326]],
    textRuns: []
  },
  {
    row: 4,
    column: 4,
    rowSpan: 1,
    colSpan: 1,
    text: '0.0076',
    sourceRects: [[646.32724074, 929.8653, 679.4855676, 940.326]],
    textRuns: []
  },
  {
    row: 4,
    column: 5,
    rowSpan: 1,
    colSpan: 1,
    text: '0.0037',
    sourceRects: [[736.4650005000001, 929.8653, 769.6233273600001, 940.326]],
    textRuns: []
  }
]

it('splits only an existing terminal donor when six independent headings and both complete literal records agree', () => {
  const f = terminalLiteralPeers(),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(terminalLiteralGrid)
  expect(result.unassigned).toEqual([])
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(f.items.map(literalNativeSignature).sort())
  for (const c of result.cells.filter((c: { column: number }) => c.column < 4)) {
    const native = f.items.filter(
      (i: { baseline: number; rect: number[] }) =>
        Math.abs(i.baseline - [612.1965, 634.644, 649.587][c.row]) < 0.02 &&
        i.rect[0] >= [204.492, 298.706, 359.727, 453.282][c.column] - 0.02 &&
        i.rect[2] < [298.706, 359.727, 453.282, 552.809][c.column]
    )
    expect(c.sourceTokens.map(literalNativeSignature).sort()).toEqual(
      native.map(literalNativeSignature).sort()
    )
  }
  expect(f).toEqual(before)
})

it('recovers only the unique TJ heading partition while retaining every complete literal body cell exactly', () => {
  const f = uniqueCenteredLiteralHeadings(),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(uniqueCenteredLiteralGrid)
  expect(
    result.cells
      .filter((c: { row: number }) => c.row > 0)
      .map((c: ReturnType<typeof JSON.parse>) => ({
        row: c.row,
        column: c.column,
        rowSpan: c.rowSpan,
        colSpan: c.colSpan,
        text: c.text,
        sourceRects: c.sourceRects,
        textRuns: c.textRuns ?? []
      }))
  ).toEqual(centeredLiteralBodyCells)
  expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toEqual(
    characters(f.items.map((i: { text: string }) => i.text).join(''))
  )
  const headings = result.cells.filter((c: { row: number }) => c.row === 0)
  expect(headings.map((c: { rowSpan: number; colSpan: number }) => [c.rowSpan, c.colSpan])).toEqual(
    Array.from({ length: 6 }, () => [1, 1])
  )
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(before)
})

it.each([
  'no-title',
  'no-closing',
  'competing-frame',
  'duplicate-source',
  'native-wall',
  'missing-terminal-field',
  'extra-terminal-source',
  'missing-terminal-heading'
])(
  'refuses terminal donor repartition without complete unique literal ownership: %s',
  (control) => {
    const f = terminalLiteralPeers()
    if (control === 'no-title') f.captions = []
    if (control === 'no-closing') f.rules.pop()
    if (control === 'competing-frame')
      f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1] + 2, r[2] - 3, r[3] + 2]))
    if (control === 'duplicate-source') f.items.push(structuredClone(f.items.at(-1)))
    if (control === 'native-wall') f.rules.push([650, f.rules[0][1], 650, f.rules[2][1]])
    if (control === 'missing-terminal-field') f.items.pop()
    if (control === 'extra-terminal-source')
      f.items.push({
        text: 'extra',
        rect: [680, 621.1944, 690, 634.644],
        height: 13.4496,
        baseline: 634.644,
        horizontal: true
      })
    if (control === 'missing-terminal-heading') f.items.splice(5, 1)
    const before = structuredClone(f),
      result = literalOutput(f)
    if (control !== 'native-wall') expect(result.grid).not.toEqual(terminalLiteralGrid)
    expect(result.repairs).not.toContain('native-terminal-literal-owners-recovered')
    expect(f).toEqual(before)
  }
)

it.each([
  'no-title',
  'no-closing',
  'competing-frame',
  'duplicate-source',
  'native-wall',
  'missing-body-face',
  'no-TJ',
  'bad-glyphs',
  'changed-header-center',
  'duplicate-TJ-boundary'
])(
  'refuses header-only ownership without the unique measured TJ and peer bijection: %s',
  (control) => {
    const f = uniqueCenteredLiteralHeadings(),
      source = f.items[1],
      observed = f.runs.find((r: { text: string }) => r.text === source.text)
    if (control === 'no-title') f.captions = []
    if (control === 'no-closing') f.rules.pop()
    if (control === 'competing-frame')
      f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1] + 2, r[2] - 3, r[3] + 2]))
    if (control === 'duplicate-source') f.items.push(structuredClone(f.items.at(-1)))
    if (control === 'native-wall') f.rules.push([500, f.rules[0][1], 500, f.rules[2][1]])
    if (control === 'missing-body-face') f.items.pop()
    if (control === 'no-TJ')
      f.runs.forEach((r: { gaps: unknown[] }) => {
        r.gaps = []
      })
    if (control === 'bad-glyphs') observed.literalGlyphs = ['wrong']
    if (control === 'duplicate-TJ-boundary')
      observed.gaps.push(
        structuredClone(observed.gaps.find((g: { index: number }) => g.index === 28))
      )
    if (control === 'changed-header-center') {
      source.rect[0] += 1
      source.rect[2] += 1
      observed.rect[0] += 1
      observed.rect[2] += 1
      observed.gaps = observed.gaps.map((g: { left: number; right: number; index: number }) => ({
        ...g,
        left: g.left + 1,
        right: g.right + 1
      }))
    }
    const before = structuredClone(f),
      result = literalOutput(f)
    if (control !== 'native-wall') expect(result.grid).not.toEqual(uniqueCenteredLiteralGrid)
    expect(result.repairs).not.toContain('native-unique-centered-literal-headings-recovered')
    expect(f).toEqual(before)
  }
)

it.each([
  [terminalLiteralPeers, terminalLiteralGrid],
  [uniqueCenteredLiteralHeadings, uniqueCenteredLiteralGrid]
] as const)('keeps the complete literal proof under redundant native paint', (factory, grid) => {
  const f = factory(),
    original = literalOutput(f)
  f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1], r[2] - 3, r[3]]))
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result).toEqual(original)
  expect(result.grid).toEqual(grid)
  expect(f).toEqual(before)
})

it.each([
  [terminalLiteralPeers, terminalLiteralGrid],
  [uniqueCenteredLiteralHeadings, uniqueCenteredLiteralGrid]
] as const)(
  'keeps literal owners under translation and reversed native source order',
  (factory, grid) => {
    const f = factory(),
      translate = (rect: number[]): number[] => rect.map((v, n) => v + (n % 2 ? 31 : 47))
    f.table.cropRect = translate(f.table.cropRect)
    f.rules = f.rules.map((r: number[]) => translate(r)).reverse()
    for (const c of f.captions) c.rect = translate(c.rect)
    for (const i of [...f.items, ...f.runs]) {
      i.rect = translate(i.rect)
      i.baseline += 31
      if (i.gaps)
        i.gaps = i.gaps.map((g: { left: number; right: number; index: number }) => ({
          ...g,
          left: g.left + 47,
          right: g.right + 47
        }))
    }
    f.items.reverse()
    f.runs.reverse()
    const before = structuredClone(f),
      result = literalOutput(f)
    expect(result.grid).toEqual(grid)
    expect(characters(result.cells.map((c: { text: string }) => c.text).join(''))).toEqual(
      characters(f.items.map((i: { text: string }) => i.text).join(''))
    )
    expect(f).toEqual(before)
  }
)

const wrappedLiteralDescriptions = (): ReturnType<typeof JSON.parse> =>
  literalSourceFixture({
    name: 'wrappedLiteralDescriptions',
    items: [
      [
        'XXXXXX / XXXXXXXX',
        81,
        129.6029335979998,
        169.87651090148876,
        139.24205021999978,
        9.639116622
      ],
      [
        'XXXXXXXX',
        178.13723384654278,
        129.6029335979998,
        221.15371959554219,
        139.24205021999978,
        9.639116622
      ],
      [
        'XXXX 312',
        437.1856013278061,
        129.6029335979998,
        475.88858238846046,
        139.24205021999978,
        9.639116622
      ],
      [
        'XXX-XXXXXXXX XXXXXX',
        554.4763002076265,
        129.6029335979998,
        657.7758213106141,
        139.24205021999978,
        9.639116622
      ],
      [
        'XXXXXXXX-XXXXXXXX-0 XXXXXX XXXXXXX',
        671.916405395088,
        129.6029335979998,
        837.0113392500554,
        139.24205021999978,
        9.639116622
      ],
      ['XXXXX', 81, 148.41177511799978, 119.77623834698159, 158.05089173999977, 9.639116622],
      [
        'XX (XX',
        178.1410894931916,
        148.41177511799978,
        216.1095698672496,
        158.05089173999977,
        9.639116622
      ],
      [
        '3',
        216.10769030999998,
        147.0109255529999,
        220.7936914437882,
        153.8960285999999,
        6.885103046999999
      ],
      [
        ') / XXXXXXX (',
        221.48164503,
        148.41177511799978,
        284.33350496375095,
        158.05089173999977,
        9.639116622
      ],
      [
        'X',
        284.3335049637509,
        148.41177511799978,
        289.4113916002205,
        158.05089173999977,
        9.639116622
      ],
      [
        '0.5)',
        295.7539303374965,
        148.41177511799978,
        314.14729267559693,
        158.05089173999977,
        9.639116622
      ],
      [
        '−',
        319.3716938847209,
        148.41177511799978,
        327.9784611165047,
        158.05089173999977,
        9.639116622
      ],
      [
        'XXXXXXXXX (',
        333.21250144225064,
        148.41177511799978,
        385.01311416887864,
        158.05089173999977,
        9.639116622
      ],
      [
        'X',
        385.0131141688787,
        148.41177511799978,
        390.0910008053483,
        158.05089173999977,
        9.639116622
      ],
      [
        '0.875),',
        396.43353954262426,
        148.41177511799978,
        428.91832647042645,
        158.05089173999977,
        9.639116622
      ],
      [
        'XXXX',
        178.13754881999998,
        159.42782941799996,
        203.64457922513637,
        169.06694603999995,
        9.639116622
      ],
      [
        '+0.195 [',
        437.18483424,
        148.41177511799978,
        477.53032077304323,
        158.05089173999977,
        9.639116622
      ],
      [
        '−',
        477.53032077304323,
        148.41177511799978,
        486.13708800482704,
        158.05089173999977,
        9.639116622
      ],
      [
        '1.141, 1.613]',
        486.137088004827,
        148.41177511799978,
        546.2138462631041,
        158.05089173999977,
        9.639116622
      ],
      [
        '−',
        554.4745692081582,
        148.41177511799978,
        563.081336439942,
        158.05089173999977,
        9.639116622
      ],
      [
        '0.010 [',
        563.081336439942,
        148.41177511799978,
        594.9752455188157,
        158.05089173999977,
        9.639116622
      ],
      [
        '−',
        594.9752455188157,
        148.41177511799978,
        603.5820127505995,
        158.05089173999977,
        9.639116622
      ],
      [
        '1.453, 1.565]',
        603.5820127505995,
        148.41177511799978,
        663.6587710088766,
        158.05089173999977,
        9.639116622
      ],
      [
        'XXXXX',
        671.9194939539307,
        148.41177511799978,
        695.9960794523623,
        158.05089173999977,
        9.639116622
      ],
      ['XXXXX', 81, 171.325720938, 119.77623834698159, 180.96483755999998, 9.639116622],
      [
        'XX (XX',
        178.1410894931916,
        171.325720938,
        216.1095698672496,
        180.96483755999998,
        9.639116622
      ],
      [
        '3',
        216.10769030999998,
        169.9248713729999,
        220.7936914437882,
        176.8099744199999,
        6.885103046999999
      ],
      [
        ') / XXXXXXX (',
        221.48164503,
        171.325720938,
        284.33350496375095,
        180.96483755999998,
        9.639116622
      ],
      ['X', 284.3335049637509, 171.325720938, 289.4113916002205, 180.96483755999998, 9.639116622],
      [
        '0.375)',
        295.7539303374965,
        171.325720938,
        325.12239086140613,
        180.96483755999998,
        9.639116622
      ],
      ['−', 330.3564311871521, 171.325720938, 338.9631984189359, 180.96483755999998, 9.639116622],
      [
        'XXXXXXXXX (',
        344.1875996280599,
        171.325720938,
        395.9882123546878,
        180.96483755999998,
        9.639116622
      ],
      ['X', 395.9882123546879, 171.325720938, 401.0660989911575, 180.96483755999998, 9.639116622],
      [
        '0.7),',
        407.4086377284335,
        171.325720938,
        428.9183264704265,
        180.96483755999998,
        9.639116622
      ],
      [
        'XXXX',
        178.13754881999998,
        182.34177523799994,
        203.64457922513637,
        191.98089185999993,
        9.639116622
      ],
      [
        '+0.385 [',
        437.18483424,
        171.325720938,
        477.53032077304323,
        180.96483755999998,
        9.639116622
      ],
      ['−', 477.53032077304323, 171.325720938, 486.13708800482704, 180.96483755999998, 9.639116622],
      [
        '3.418, 4.281]',
        486.137088004827,
        171.325720938,
        546.2138462631041,
        180.96483755999998,
        9.639116622
      ],
      ['−', 554.4745692081582, 171.325720938, 563.081336439942, 180.96483755999998, 9.639116622],
      [
        '0.124 [',
        563.081336439942,
        171.325720938,
        594.9752455188157,
        180.96483755999998,
        9.639116622
      ],
      ['−', 594.9752455188157, 171.325720938, 603.5820127505995, 180.96483755999998, 9.639116622],
      [
        '4.048, 4.090]',
        603.5820127505995,
        171.325720938,
        663.6587710088766,
        180.96483755999998,
        9.639116622
      ],
      [
        'XXXXX',
        671.9194939539307,
        171.325720938,
        695.9960794523623,
        180.96483755999998,
        9.639116622
      ],
      ['XXXXXXXX', 81, 193.3578295379999, 120.2177098882692, 202.99694615999988, 9.639116622],
      [
        'XXXXXXX - XXXX, XXXXX_XXX, XXXX',
        178.13916166986718,
        193.3578295379999,
        364.73125341521876,
        202.99694615999988,
        9.639116622
      ],
      [
        '+0.003 [',
        437.18849306279265,
        193.3578295379999,
        477.52434047921383,
        202.99694615999988,
        9.639116622
      ],
      [
        '−',
        477.5243404792139,
        193.3578295379999,
        486.1311077109977,
        202.99694615999988,
        9.639116622
      ],
      [
        '0.015, 0.022]',
        486.13110771099764,
        193.3578295379999,
        546.2078659692748,
        202.99694615999988,
        9.639116622
      ],
      [
        '−',
        554.478228030951,
        193.3578295379999,
        563.0849952627348,
        202.99694615999988,
        9.639116622
      ],
      [
        '0.009 [',
        563.0849952627347,
        193.3578295379999,
        594.9692652249862,
        202.99694615999988,
        9.639116622
      ],
      [
        '−',
        594.9789043416083,
        193.3578295379999,
        603.5856715733921,
        202.99694615999988,
        9.639116622
      ],
      [
        '0.029, 0.011]',
        603.5760324567701,
        193.3578295379999,
        663.6527907150473,
        202.99694615999988,
        9.639116622
      ],
      [
        'XXXXX',
        671.9231527767233,
        193.3578295379999,
        695.9900991585329,
        202.99694615999988,
        9.639116622
      ],
      ['XXXXXXXX', 81, 204.37388383799995, 120.2177098882692, 214.01300045999994, 9.639116622],
      [
        'XXXXXXX - XXXXX, XXXXX_XXX, XXXXXX',
        178.13916166986718,
        204.37388383799995,
        380.5808528767734,
        214.01300045999994,
        9.639116622
      ],
      [
        '+0.006 [',
        437.1817456811573,
        204.37388383799995,
        477.5272322142005,
        214.01300045999994,
        9.639116622
      ],
      [
        '−',
        477.5272322142005,
        204.37388383799995,
        486.13399944598433,
        214.01300045999994,
        9.639116622
      ],
      [
        '0.019, 0.032]',
        486.1339994459843,
        204.37388383799995,
        546.2107577042614,
        214.01300045999994,
        9.639116622
      ],
      [
        '−',
        554.4714806493155,
        204.37388383799995,
        563.0782478810993,
        214.01300045999994,
        9.639116622
      ],
      [
        '0.007 [',
        563.0782478810993,
        204.37388383799995,
        594.972156959973,
        214.01300045999994,
        9.639116622
      ],
      [
        '−',
        594.972156959973,
        204.37388383799995,
        603.5789241917568,
        214.01300045999994,
        9.639116622
      ],
      [
        '0.023, 0.022]',
        603.5789241917568,
        204.37388383799995,
        663.6556824500339,
        214.01300045999994,
        9.639116622
      ],
      [
        'XXXXX',
        671.916405395088,
        204.37388383799995,
        695.9929908935196,
        214.01300045999994,
        9.639116622
      ]
    ],
    observed: [
      [
        0,
        [
          {
            left: 118.047944736657,
            right: 121.759004636127,
            index: 6
          },
          {
            left: 127.2465537290316,
            right: 130.9479745118796,
            index: 7
          }
        ],
        35
      ],
      [1, [], 35],
      [
        2,
        [
          {
            left: 455.7148752102767,
            right: 459.4259351097467,
            index: 4
          }
        ],
        35
      ],
      [
        3,
        [
          {
            left: 623.9839701688686,
            right: 627.6950300683385,
            index: 12
          }
        ],
        35
      ],
      [
        4,
        [
          {
            left: 761.9872028460428,
            right: 765.6982627455128,
            index: 19
          },
          {
            left: 794.5934426432823,
            right: 798.3045025427523,
            index: 25
          }
        ],
        35
      ],
      [5, [], 47],
      [
        6,
        [
          {
            left: 192.6441043626528,
            right: 197.8685055717768,
            index: 2
          }
        ],
        47
      ],
      [7, [], 51],
      [
        8,
        [
          {
            left: 225.78358277839862,
            right: 231.0079839875226,
            index: 1
          },
          {
            left: 236.4955330804272,
            right: 241.72957340617322,
            index: 2
          },
          {
            left: 274.8071660062284,
            right: 280.0315672153524,
            index: 9
          }
        ],
        54
      ],
      [9, [], 57],
      [10, [], 59],
      [11, [], 62],
      [
        12,
        [
          {
            left: 375.486775211356,
            right: 380.71117642048006,
            index: 9
          }
        ],
        64
      ],
      [13, [], 66],
      [14, [], 68],
      [15, [], 70],
      [
        16,
        [
          {
            left: 470.7029344696806,
            right: 474.4139943691506,
            index: 6
          }
        ],
        72
      ],
      [17, [], 74],
      [
        18,
        [
          {
            left: 514.3199371842305,
            right: 518.0309970837005,
            index: 6
          }
        ],
        76
      ],
      [19, [], 78],
      [
        20,
        [
          {
            left: 588.147859215453,
            right: 591.858919114923,
            index: 5
          }
        ],
        80
      ],
      [21, [], 82],
      [
        22,
        [
          {
            left: 631.764861930003,
            right: 635.475921829473,
            index: 6
          }
        ],
        84
      ],
      [23, [], 84],
      [24, [], 86],
      [
        25,
        [
          {
            left: 192.6441043626528,
            right: 197.8685055717768,
            index: 2
          }
        ],
        86
      ],
      [26, [], 89],
      [
        27,
        [
          {
            left: 225.78358277839862,
            right: 231.0079839875226,
            index: 1
          },
          {
            left: 236.4955330804272,
            right: 241.72957340617322,
            index: 2
          },
          {
            left: 274.8071660062284,
            right: 280.0315672153524,
            index: 9
          }
        ],
        92
      ],
      [28, [], 94],
      [29, [], 96],
      [30, [], 98],
      [
        31,
        [
          {
            left: 386.4618733971653,
            right: 391.6862746062893,
            index: 9
          }
        ],
        100
      ],
      [32, [], 102],
      [33, [], 104],
      [34, [], 106],
      [
        35,
        [
          {
            left: 470.7029344696806,
            right: 474.4139943691506,
            index: 6
          }
        ],
        108
      ],
      [36, [], 110],
      [
        37,
        [
          {
            left: 514.3199371842305,
            right: 518.0309970837005,
            index: 6
          }
        ],
        112
      ],
      [38, [], 114],
      [
        39,
        [
          {
            left: 588.147859215453,
            right: 591.858919114923,
            index: 5
          }
        ],
        116
      ],
      [40, [], 118],
      [
        41,
        [
          {
            left: 631.764861930003,
            right: 635.475921829473,
            index: 6
          }
        ],
        120
      ],
      [42, [], 120],
      [43, [], 122],
      [
        44,
        [
          {
            left: 230.55956959528976,
            right: 234.27062949475973,
            index: 7
          },
          {
            left: 237.97976157090534,
            right: 241.68118235375334,
            index: 8
          },
          {
            left: 276.9304679287451,
            right: 280.6415278282151,
            index: 13
          },
          {
            left: 335.52280222723425,
            right: 339.22422301008226,
            index: 23
          }
        ],
        122
      ],
      [
        45,
        [
          {
            left: 470.70659329247326,
            right: 474.4080140753213,
            index: 6
          }
        ],
        122
      ],
      [46, [], 124],
      [
        47,
        [
          {
            left: 514.3139568904012,
            right: 518.0250167898712,
            index: 6
          }
        ],
        126
      ],
      [48, [], 128],
      [
        49,
        [
          {
            left: 588.1515180382456,
            right: 591.8529388210936,
            index: 5
          }
        ],
        130
      ],
      [50, [], 132],
      [
        51,
        [
          {
            left: 631.7685207527957,
            right: 635.4699415356437,
            index: 6
          }
        ],
        134
      ],
      [52, [], 134],
      [53, [], 136],
      [
        54,
        [
          {
            left: 230.55956959528976,
            right: 234.27062949475973,
            index: 7
          },
          {
            left: 237.97976157090534,
            right: 241.68118235375334,
            index: 8
          },
          {
            left: 283.5737471046275,
            right: 287.28480700409756,
            index: 14
          },
          {
            left: 342.16608140311666,
            right: 345.87714130258667,
            index: 24
          }
        ],
        136
      ],
      [
        55,
        [
          {
            left: 470.6998459108379,
            right: 474.4109058103079,
            index: 6
          }
        ],
        136
      ],
      [56, [], 138],
      [
        57,
        [
          {
            left: 514.3168486253878,
            right: 518.0279085248578,
            index: 6
          }
        ],
        140
      ],
      [58, [], 142],
      [
        59,
        [
          {
            left: 588.1447706566103,
            right: 591.8558305560803,
            index: 5
          }
        ],
        144
      ],
      [60, [], 146],
      [
        61,
        [
          {
            left: 631.7617733711603,
            right: 635.4728332706303,
            index: 6
          }
        ],
        148
      ],
      [62, [], 148]
    ],
    rules: [
      [81, 127.12715487000014, 837.0137242163086, 127.12715487000014],
      [81, 145.26148766999995, 837.0137242163086, 145.26148766999995],
      [81, 220.2397664099999, 837.0137242163086, 220.2397664099999]
    ],
    caption: [81, 77.6348999999999, 837.0006710399994, 107.52299999999985],
    crop: [71, 118, 846, 226],
    objects: [
      ['table row', 13.110505789518356, 65.0258617401123, 743.9486853778362, 82.39522075653076],
      ['table column', 363.4127516299486, 24.61293911933899, 481.6859435290098, 89.75980925559998],
      ['table row', 13.273707777261734, 39.04740357398987, 743.3216996490955, 64.39312648773193],
      [
        'table column',
        13.546619564294815,
        24.810338973999023,
        92.26051345467567,
        89.65433406829834
      ],
      ['table column', 238.0640860646963, 24.46415376663208, 355.91086484491825, 89.72854328155518],
      ['table row', 12.876743078231812, 23.61370575428009, 742.7722960710526, 38.93673026561737],
      ['table column', 480.8456242084503, 24.54389262199402, 596.9885289669037, 89.83306574821472],
      ['table column', 157.61402882635593, 24.545424699783325, 267.893972620368, 89.6564519405365],
      ['table column', 596.3802978396416, 24.610451102256775, 739.4728258252144, 90.013867020607],
      ['table row', 13.15298080444336, 80.21754115819931, 743.8257873058319, 91.30142551660538],
      [
        'table column header',
        13.120021671056747,
        23.574224174022675,
        742.7682541310787,
        38.97448664903641
      ],
      ['table column', 93.09632889926434, 24.76749873161316, 155.6754220277071, 89.74622654914856],
      ['table', 13.080179691314697, 24.652168035507202, 743.5668721795082, 89.97885775566101]
    ]
  })
const wrappedDescriptionGrid = [
  [
    'XXXXXX / XXXXXXXX',
    'XXXXXXXX',
    'XXXX 312',
    'XXX-XXXXXXXX XXXXXX',
    'XXXXXXXX-XXXXXXXX-0 XXXXXX XXXXXXX'
  ],
  [
    'XXXXX',
    'XX (XX3) / XXXXXXX (X 0.5) − XXXXXXXXX (X 0.875), XXXX',
    '+0.195 [−1.141, 1.613]',
    '−0.010 [−1.453, 1.565]',
    'XXXXX'
  ],
  [
    'XXXXX',
    'XX (XX3) / XXXXXXX (X 0.375) − XXXXXXXXX (X 0.7), XXXX',
    '+0.385 [−3.418, 4.281]',
    '−0.124 [−4.048, 4.090]',
    'XXXXX'
  ],
  [
    'XXXXXXXX',
    'XXXXXXX - XXXX, XXXXX_XXX, XXXX',
    '+0.003 [−0.015, 0.022]',
    '−0.009 [−0.029, 0.011]',
    'XXXXX'
  ],
  [
    'XXXXXXXX',
    'XXXXXXX - XXXXX, XXXXX_XXX, XXXXXX',
    '+0.006 [−0.019, 0.032]',
    '−0.007 [−0.023, 0.022]',
    'XXXXX'
  ]
]
const retainedWrappedOrdinaryCells = [
  {
    row: 1,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXXX',
    sourceRects: [[81, 148.41177511799978, 119.77623834698159, 158.05089173999977]],
    textRuns: []
  },
  {
    row: 1,
    column: 2,
    rowSpan: 1,
    colSpan: 1,
    text: '+0.195 [−1.141, 1.613]',
    sourceRects: [
      [437.18483424, 148.41177511799978, 477.53032077304323, 158.05089173999977],
      [477.53032077304323, 148.41177511799978, 486.13708800482704, 158.05089173999977],
      [486.137088004827, 148.41177511799978, 546.2138462631041, 158.05089173999977]
    ],
    textRuns: []
  },
  {
    row: 1,
    column: 3,
    rowSpan: 1,
    colSpan: 1,
    text: '−0.010 [−1.453, 1.565]',
    sourceRects: [
      [554.4745692081582, 148.41177511799978, 563.081336439942, 158.05089173999977],
      [563.081336439942, 148.41177511799978, 594.9752455188157, 158.05089173999977],
      [594.9752455188157, 148.41177511799978, 603.5820127505995, 158.05089173999977],
      [603.5820127505995, 148.41177511799978, 663.6587710088766, 158.05089173999977]
    ],
    textRuns: []
  },
  {
    row: 1,
    column: 4,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXXX',
    sourceRects: [[671.9194939539307, 148.41177511799978, 695.9960794523623, 158.05089173999977]],
    textRuns: []
  },
  {
    row: 2,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXXX',
    sourceRects: [[81, 171.325720938, 119.77623834698159, 180.96483755999998]],
    textRuns: []
  },
  {
    row: 2,
    column: 2,
    rowSpan: 1,
    colSpan: 1,
    text: '+0.385 [−3.418, 4.281]',
    sourceRects: [
      [437.18483424, 171.325720938, 477.53032077304323, 180.96483755999998],
      [477.53032077304323, 171.325720938, 486.13708800482704, 180.96483755999998],
      [486.137088004827, 171.325720938, 546.2138462631041, 180.96483755999998]
    ],
    textRuns: []
  },
  {
    row: 2,
    column: 3,
    rowSpan: 1,
    colSpan: 1,
    text: '−0.124 [−4.048, 4.090]',
    sourceRects: [
      [554.4745692081582, 171.325720938, 563.081336439942, 180.96483755999998],
      [563.081336439942, 171.325720938, 594.9752455188157, 180.96483755999998],
      [594.9752455188157, 171.325720938, 603.5820127505995, 180.96483755999998],
      [603.5820127505995, 171.325720938, 663.6587710088766, 180.96483755999998]
    ],
    textRuns: []
  },
  {
    row: 2,
    column: 4,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXXX',
    sourceRects: [[671.9194939539307, 171.325720938, 695.9960794523623, 180.96483755999998]],
    textRuns: []
  },
  {
    row: 3,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXXXXXX',
    sourceRects: [[81, 193.3578295379999, 120.2177098882692, 202.99694615999988]],
    textRuns: []
  },
  {
    row: 3,
    column: 2,
    rowSpan: 1,
    colSpan: 1,
    text: '+0.003 [−0.015, 0.022]',
    sourceRects: [
      [437.18849306279265, 193.3578295379999, 477.52434047921383, 202.99694615999988],
      [477.5243404792139, 193.3578295379999, 486.1311077109977, 202.99694615999988],
      [486.13110771099764, 193.3578295379999, 546.2078659692748, 202.99694615999988]
    ],
    textRuns: []
  },
  {
    row: 3,
    column: 3,
    rowSpan: 1,
    colSpan: 1,
    text: '−0.009 [−0.029, 0.011]',
    sourceRects: [
      [554.478228030951, 193.3578295379999, 563.0849952627348, 202.99694615999988],
      [563.0849952627347, 193.3578295379999, 594.9692652249862, 202.99694615999988],
      [594.9789043416083, 193.3578295379999, 603.5856715733921, 202.99694615999988],
      [603.5760324567701, 193.3578295379999, 663.6527907150473, 202.99694615999988]
    ],
    textRuns: []
  },
  {
    row: 3,
    column: 4,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXXX',
    sourceRects: [[671.9231527767233, 193.3578295379999, 695.9900991585329, 202.99694615999988]],
    textRuns: []
  },
  {
    row: 4,
    column: 0,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXXXXXX',
    sourceRects: [[81, 204.37388383799995, 120.2177098882692, 214.01300045999994]],
    textRuns: []
  },
  {
    row: 4,
    column: 2,
    rowSpan: 1,
    colSpan: 1,
    text: '+0.006 [−0.019, 0.032]',
    sourceRects: [
      [437.1817456811573, 204.37388383799995, 477.5272322142005, 214.01300045999994],
      [477.5272322142005, 204.37388383799995, 486.13399944598433, 214.01300045999994],
      [486.1339994459843, 204.37388383799995, 546.2107577042614, 214.01300045999994]
    ],
    textRuns: []
  },
  {
    row: 4,
    column: 3,
    rowSpan: 1,
    colSpan: 1,
    text: '−0.007 [−0.023, 0.022]',
    sourceRects: [
      [554.4714806493155, 204.37388383799995, 563.0782478810993, 214.01300045999994],
      [563.0782478810993, 204.37388383799995, 594.972156959973, 214.01300045999994],
      [594.972156959973, 204.37388383799995, 603.5789241917568, 214.01300045999994],
      [603.5789241917568, 204.37388383799995, 663.6556824500339, 214.01300045999994]
    ],
    textRuns: []
  },
  {
    row: 4,
    column: 4,
    rowSpan: 1,
    colSpan: 1,
    text: 'XXXXX',
    sourceRects: [[671.916405395088, 204.37388383799995, 695.9929908935196, 214.01300045999994]],
    textRuns: []
  }
]

it('keeps complete descriptive records inside their unique native ink envelopes and preserves measured scripts', () => {
  const f = wrappedLiteralDescriptions(),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(wrappedDescriptionGrid)
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(f.items.map(literalNativeSignature).sort())
  expect(
    result.cells
      .filter((c: { row: number; column: number }) => c.row > 0 && c.column !== 1)
      .map((c: ReturnType<typeof JSON.parse>) => ({
        row: c.row,
        column: c.column,
        rowSpan: c.rowSpan,
        colSpan: c.colSpan,
        text: c.text,
        sourceRects: c.sourceRects,
        textRuns: c.textRuns ?? []
      }))
  ).toEqual(retainedWrappedOrdinaryCells)
  expect(
    result.cells
      .filter((c: { row: number; column: number }) => c.column === 1 && [1, 2].includes(c.row))
      .map((c: { textRuns: { text: string; position: string }[] }) =>
        c.textRuns.filter((r) => r.position === 'superscript')
      )
  ).toEqual([[{ text: '3', position: 'superscript' }], [{ text: '3', position: 'superscript' }]])
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(before)
})
it.each([
  'no-title',
  'no-closing',
  'competing-frame',
  'duplicate-source',
  'native-wall',
  'missing-key',
  'missing-terminal-face',
  'continuation-crosses-next-script-ink',
  'continuation-off-lane',
  'additional-continuation',
  'orphan-script',
  'ambiguous-script-parent',
  'duplicate-caption'
])(
  'refuses descriptive record repair without complete unique physical source envelopes: %s',
  (control) => {
    const f = wrappedLiteralDescriptions(),
      continuation = f.items.find(
        (i: { baseline: number }) => Math.abs(i.baseline - 169.06694604) < 0.02
      )
    if (control === 'no-title') f.captions = []
    if (control === 'no-closing') f.rules.pop()
    if (control === 'competing-frame')
      f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1] + 2, r[2] - 3, r[3] + 2]))
    if (control === 'duplicate-source') f.items.push(structuredClone(continuation))
    if (control === 'native-wall') f.rules.push([430, f.rules[0][1], 430, f.rules[2][1]])
    if (control === 'missing-key')
      f.items = f.items.filter(
        (i: { rect: number[]; baseline: number }) =>
          !(Math.abs(i.rect[0] - 81) < 0.02 && Math.abs(i.baseline - 158.05089174) < 0.02)
      )
    if (control === 'missing-terminal-face')
      f.items = f.items.filter(
        (i: { rect: number[]; baseline: number }) =>
          !(i.rect[0] > 671 && Math.abs(i.baseline - 158.05089174) < 0.02)
      )
    if (control === 'continuation-crosses-next-script-ink') {
      continuation.rect[1] += 1
      continuation.rect[3] += 1
      continuation.baseline += 1
    }
    if (control === 'continuation-off-lane') {
      continuation.rect[0] += 2
      continuation.rect[2] += 2
    }
    if (control === 'additional-continuation')
      f.items.push({
        ...structuredClone(continuation),
        text: 'extra',
        rect: continuation.rect.map((v: number, n: number) => v + (n % 2 ? 0.4 : 0)),
        baseline: continuation.baseline + 0.4
      })
    if (control === 'orphan-script') {
      const child = f.items.find(
        (i: { text: string; baseline: number }) => i.text === '3' && i.baseline < 160
      )
      child.rect[0] += 4
      child.rect[2] += 4
    }
    if (control === 'ambiguous-script-parent') {
      const parent = f.items.find(
        (i: { rect: number[]; baseline: number; height: number }) =>
          Math.abs(i.rect[0] - 178.14108949) < 0.02 &&
          Math.abs(i.baseline - 158.05089174) < 0.02 &&
          i.height > 9
      )
      f.items.push({ ...structuredClone(parent), text: 'alias' })
    }
    if (control === 'duplicate-caption') f.captions.push(structuredClone(f.captions[0]))
    const before = structuredClone(f),
      result = literalOutput(f)
    if (control !== 'native-wall') expect(result.grid).not.toEqual(wrappedDescriptionGrid)
    expect(result.repairs).not.toContain('native-wrapped-literal-description-owners-recovered')
    expect(f).toEqual(before)
  }
)
it('counts redundant overlapping native paint once for complete descriptive record envelopes', () => {
  const f = wrappedLiteralDescriptions(),
    original = literalOutput(f)
  f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1], r[2] - 3, r[3]]))
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result).toEqual(original)
  expect(result.grid).toEqual(wrappedDescriptionGrid)
  expect(f).toEqual(before)
})
it('retains complete description scripts and literal source owners under translation and reversed order', () => {
  const f = wrappedLiteralDescriptions(),
    translate = (r: number[]): number[] => r.map((v, n) => v + (n % 2 ? 39 : 23))
  f.table.cropRect = translate(f.table.cropRect)
  f.rules = f.rules.map((r: number[]) => translate(r)).reverse()
  for (const c of f.captions) c.rect = translate(c.rect)
  for (const i of [...f.items, ...f.runs]) {
    i.rect = translate(i.rect)
    i.baseline += 39
    if (i.gaps)
      i.gaps = i.gaps.map((g: { left: number; right: number; index: number }) => ({
        ...g,
        left: g.left + 23,
        right: g.right + 23
      }))
  }
  f.items.reverse()
  f.runs.reverse()
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(wrappedDescriptionGrid)
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(f.items.map(literalNativeSignature).sort())
  expect(f).toEqual(before)
})

// Two upper parent owners require independent native partial rules and a
// complete lower/body leaf bijection; all previously correct faces stay exact.
const partialRuleParents = (): ReturnType<typeof JSON.parse> =>
  fixture('partial-rule-parent-owners')
const partialRuleParentGrid = partialRuleParents().expectedGrid
const partialRuleRetainedCells = partialRuleParents().retainedCells
it('repairs only two uniquely ruled upper parent groups while preserving every complete source field', () => {
  const f = partialRuleParents(),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(partialRuleParentGrid)
  expect(result.cells).toHaveLength(37)
  for (const previous of partialRuleRetainedCells)
    expect(
      result.cells.find(
        (c: { row: number; column: number }) =>
          c.row === previous.row && c.column === previous.column
      )
    ).toEqual(previous)
  for (const column of [2, 6]) {
    const parent = result.cells.find(
      (c: { row: number; column: number }) => c.row === 0 && c.column === column
    )
    expect(parent.colSpan).toBe(2)
    expect(parent.rowSpan).toBe(1)
    expect(
      result.cells.some(
        (c: { row: number; column: number }) => c.row === 0 && c.column === column + 1
      )
    ).toBe(false)
  }
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(f.items.map(literalNativeSignature).sort())
  expect(result.unassigned).toEqual([])
  expect(result.cropRect).toEqual(f.table.cropRect)
  expect(f).toEqual(before)
})

it.each([
  'missing-partial-rule',
  'partial-rule-center-shift',
  'competing-partial-tier',
  'missing-child-heading',
  'missing-complete-peer',
  'duplicate-native-item',
  'competing-complete-frame',
  'missing-title',
  'duplicate-title',
  'missing-closing',
  'native-interior-wall'
])(
  'refuses the partial-rule parent projection without unique complete native owners: %s',
  (control) => {
    const f = partialRuleParents(),
      partial = f.rules
        .filter((r: number[]) => r[2] - r[0] < 200)
        .sort((a: number[], b: number[]) => a[0] - b[0]),
      top = Math.min(...f.items.map((i: { baseline: number }) => i.baseline)),
      last = partial.at(-1)
    if (control === 'missing-partial-rule') f.rules = f.rules.filter((r: unknown) => r !== last)
    if (control === 'partial-rule-center-shift') {
      last[0] += 1
      last[2] += 1
    }
    if (control === 'competing-partial-tier')
      f.rules.push([last[0], last[1] + 1, last[2], last[3] + 1])
    if (control === 'missing-child-heading')
      f.items = f.items.filter(
        (i: { rect: number[]; baseline: number }) =>
          !(i.baseline > top && i.baseline < top + 20 && i.rect[0] > 400)
      )
    if (control === 'missing-complete-peer')
      f.items = f.items.filter((i: { text: string }) => i.text !== '0.164')
    if (control === 'duplicate-native-item')
      f.items.push(structuredClone(f.items.find((i: { text: string }) => i.text === '0.164')))
    if (control === 'competing-complete-frame')
      f.rules.push(...f.rules.slice(0, 3).map((r: number[]) => [r[0], r[1] + 2, r[2], r[3] + 2]))
    if (control === 'missing-title') f.captions = []
    if (control === 'duplicate-title') f.captions.push(structuredClone(f.captions[0]))
    if (control === 'missing-closing') f.rules.splice(2, 1)
    if (control === 'native-interior-wall') f.rules.push([350, f.rules[0][1], 350, f.rules[2][1]])
    const before = structuredClone(f),
      result = literalOutput(f)
    expect(result.repairs).not.toContain('native-partial-rule-parent-owners-recovered')
    expect(f).toEqual(before)
  }
)

const partialRuleRunFaults = [
  'missing-observed-TJ',
  'inside-glyph-TJ-gap',
  'duplicate-observed-run',
  'metadata-run-mismatch'
]
const damagePartialRuleRun = (f: ReturnType<typeof JSON.parse>, control: string): void => {
  const observed = f.runs.find((run: { text: string }) => run.text === '97.5XX XXX.')
  if (control === 'missing-observed-TJ') f.runs = f.runs.filter((run: unknown) => run !== observed)
  if (control === 'inside-glyph-TJ-gap')
    observed.gaps = observed.gaps.map((gap: { left: number; right: number; index: number }) => ({
      ...gap,
      left: gap.left + 4,
      right: gap.right + 4
    }))
  if (control === 'duplicate-observed-run') f.runs.push(structuredClone(observed))
  if (control === 'metadata-run-mismatch') observed.height += 0.2
}
it.each(partialRuleRunFaults)(
  'preserves complete partial-rule parent source owners without splitting on %s',
  (control) => {
    const f = partialRuleParents()
    damagePartialRuleRun(f, control)
    const before = structuredClone(f),
      result = literalOutput(f)
    expect(result.grid).toEqual(partialRuleParentGrid)
    const parent = result.cells.find(
      (cell: { row: number; column: number }) => cell.row === 0 && cell.column === 6
    )
    const original = f.items.find((item: { text: string }) => item.text === '97.5XX XXX.')
    expect(parent.sourceTokens).toEqual([original])
    expect(parent.sourceRects).toEqual([original.rect])
    expect(
      result.cells
        .flatMap((cell: { sourceTokens: unknown[] }) => cell.sourceTokens)
        .map(literalNativeSignature)
        .sort()
    ).toEqual(f.items.map(literalNativeSignature).sort())
    expect(result.unassigned).toEqual([])
    expect(f).toEqual(before)
  }
)
const splitPartialRuleOwners = (
  f: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> => {
  // Explicit coarse donors exercise the measured-gap gate even though the
  // public header path now keeps the original fused token intact.
  const table = {
    ...structuredClone(f.table),
    grid: structuredClone(f.expectedGrid),
    cells: structuredClone([...f.retainedCells, ...f.initialFaultyParentCells]),
    notes: []
  }
  for (const cell of table.cells) table.grid[cell.row][cell.column] = cell.text
  return table
}
it('accepts explicitly split partial-rule donors only with their unique measured native gap', () => {
  const f = partialRuleParents(),
    table = splitPartialRuleOwners(f),
    before = structuredClone(table)
  expect(
    lateFencedGroupHelpers.proveNativePartialRuleParentOwners(
      table,
      f.items,
      f.captions,
      f.rules,
      f.runs
    )?.replacements
  ).toHaveLength(2)
  expect(table).toEqual(before)
})
it.each(partialRuleRunFaults)('rejects explicitly split partial-rule donors with %s', (control) => {
  const f = partialRuleParents(),
    table = splitPartialRuleOwners(f)
  damagePartialRuleRun(f, control)
  const before = structuredClone({ f, table })
  expect(
    lateFencedGroupHelpers.proveNativePartialRuleParentOwners(
      table,
      f.items,
      f.captions,
      f.rules,
      f.runs
    )
  ).toBeUndefined()
  expect({ f, table }).toEqual(before)
})

it('counts redundant native paint once for an otherwise uniquely proved parent tier', () => {
  const f = partialRuleParents(),
    original = literalOutput(f)
  f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1], r[2] - 0.1, r[3]]))
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result).toEqual(original)
  expect(result.grid).toEqual(partialRuleParentGrid)
  expect(f).toEqual(before)
})

it('preserves literal parent tiers under translation and reversed native order', () => {
  const f = partialRuleParents(),
    translate = (r: number[]): number[] => r.map((v, n) => v + (n % 2 ? 37 : 19))
  f.table.cropRect = translate(f.table.cropRect)
  f.rules = f.rules.map((r: number[]) => translate(r)).reverse()
  for (const c of f.captions) c.rect = translate(c.rect)
  for (const i of [...f.items, ...f.runs]) {
    i.rect = translate(i.rect)
    i.baseline += 37
    if (i.gaps)
      i.gaps = i.gaps.map((g: { left: number; right: number; index: number }) => ({
        ...g,
        left: g.left + 19,
        right: g.right + 19
      }))
  }
  f.items.reverse()
  f.runs.reverse()
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(partialRuleParentGrid)
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(f.items.map(literalNativeSignature).sort())
  expect(f).toEqual(before)
})

// Complete physical fences prove these labels without inheriting a stub or
// interpreting its unit. Correct body/header faces remain whole and exact.
const fencedMultilineStubs = (): ReturnType<typeof JSON.parse> =>
  fixture('fenced-multiline-stub-owners')
it('repairs only three fenced multiline first-stub owners and retains all literal source fields', () => {
  const f = fencedMultilineStubs(),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.cells).toHaveLength(161)
  for (const previous of f.retainedCells)
    expect(
      result.cells.find(
        (c: { row: number; column: number }) =>
          c.row === previous.row && c.column === previous.column
      )
    ).toEqual(previous)
  for (const group of f.labelGroups.filter(
    (g: { preserveWholeExistingCell: boolean }) => !g.preserveWholeExistingCell
  )) {
    const label = result.cells.find(
      (c: { row: number; column: number }) => c.row === group.row && c.column === 0
    )
    expect(label.rowSpan).toBe(6)
    expect(label.colSpan).toBe(1)
    expect(label.rect).toEqual(group.expectedDonorUnionRect)
    expect(label.sourceTokens.map(literalNativeSignature)).toEqual(
      group.nativeItems.map(literalNativeSignature)
    )
    expect(label.textRuns.filter((r: { position: string }) => r.position !== 'normal')).toEqual(
      group.existingRaisedRichRuns
    )
    expect(
      result.cells.filter(
        (c: { row: number; column: number }) =>
          c.column === 0 && c.row >= group.row && c.row < group.row + 6
      )
    ).toHaveLength(1)
  }
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(f.items.map(literalNativeSignature).sort())
  expect(result.unassigned).toEqual([])
  expect(result.cropRect).toEqual(f.expectedCropRect)
  expect(f.expectedPredecessorIssues).toEqual(['span-conflicts-with-source-rows'])
  expect(result.issues).toEqual([])
  expect(result.reviewCandidate).toBe(true)
  expect(result.repairs).toContain('native-fenced-multiline-stub-owners-recovered')
  expect(f).toEqual(before)
})

it.each([
  'missing-opening',
  'missing-header-divider',
  'missing-group-fence',
  'shortened-group-fence',
  'missing-closing',
  'competing-group-fences',
  'missing-title',
  'duplicate-title',
  'duplicate-label-source',
  'missing-complete-body-field',
  'duplicate-body-source',
  'label-font-box-crosses-group-fence',
  'label-font-box-crosses-body-gutter',
  'script-moved-to-foreign-parent',
  'missing-existing-script-source',
  'foreign-nonhorizontal-intersecting-glyph',
  'empty-label-line',
  'outlier-label-line',
  'native-interior-wall'
])('refuses fenced label ownership without every complete unique source witness: %s', (control) => {
  const f = fencedMultilineStubs(),
    group = f.labelGroups.find((g: { row: number }) => g.row === 7)
  const source = (i: unknown): ReturnType<typeof JSON.parse> =>
    f.items.find((item: unknown) => literalNativeSignature(item) === literalNativeSignature(i))
  const label = source(group.nativeItems[0]),
    continuation = source(group.nativeItems[3]),
    script = source(group.nativeItems[2])
  const body = source(
    f.retainedCells.find((c: { row: number; column: number }) => c.row === 7 && c.column === 4)
      .sourceTokens[0]
  )
  if (control === 'missing-opening') f.rules.shift()
  if (control === 'missing-header-divider') f.rules.splice(1, 1)
  if (control === 'missing-group-fence') f.rules.splice(3, 1)
  if (control === 'shortened-group-fence') f.rules[3][2] -= 5
  if (control === 'missing-closing') f.rules.pop()
  if (control === 'competing-group-fences')
    f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1] + 2, r[2], r[3] + 2]))
  if (control === 'missing-title') f.captions = []
  if (control === 'duplicate-title') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'duplicate-label-source') f.items.push(structuredClone(label))
  if (control === 'missing-complete-body-field')
    f.items = f.items.filter((i: unknown) => i !== body)
  if (control === 'duplicate-body-source') f.items.push(structuredClone(body))
  if (control === 'label-font-box-crosses-group-fence') {
    continuation.rect[3] = f.rules[3][1] + 0.3
    continuation.rect[1] = continuation.rect[3] - continuation.height
    continuation.baseline = continuation.rect[3]
    expect((continuation.rect[1] + continuation.rect[3]) / 2).toBeLessThan(f.rules[3][1])
  }
  if (control === 'label-font-box-crosses-body-gutter') {
    continuation.rect[2] = 257
    expect((continuation.rect[0] + continuation.rect[2]) / 2).toBeLessThan(248)
  }
  if (control === 'script-moved-to-foreign-parent') {
    script.rect[0] += 7
    script.rect[2] += 7
  }
  if (control === 'missing-existing-script-source')
    f.items = f.items.filter((i: unknown) => i !== script)
  if (control === 'foreign-nonhorizontal-intersecting-glyph')
    f.items.push({ ...structuredClone(label), text: 'foreign', horizontal: false })
  if (control === 'empty-label-line') label.text = ''
  if (control === 'outlier-label-line')
    f.items.push({
      ...structuredClone(label),
      text: 'extra printed face',
      rect: [label.rect[0], 326, label.rect[2], 337.509343463],
      baseline: 337.509343463
    })
  if (control === 'native-interior-wall') f.rules.push([248, f.rules[0][1], 248, f.rules.at(-1)[1]])
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.repairs).not.toContain('native-fenced-multiline-stub-owners-recovered')
  expect(f).toEqual(before)
})

it('counts repeated and overlapping native paint once for uniquely fenced multiline stubs', () => {
  const f = fencedMultilineStubs(),
    original = literalOutput(f)
  f.rules.push(
    ...f.rules.map((r: number[]) => [r[0], r[1], r[2] - 0.1, r[3]]),
    ...structuredClone(f.rules)
  )
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result).toEqual(original)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(f).toEqual(before)
})

it('proves a reduced complete fenced layout from physical records rather than original source counts', () => {
  const f = fencedMultilineStubs(),
    bottom = f.rules.at(-2)[1],
    offset = f.table.cropRect[1]
  f.rules.pop()
  f.items = f.items.filter((i: { rect: number[] }) => i.rect[3] <= bottom)
  f.runs = f.runs.filter((i: { rect: number[] }) => i.rect[3] <= bottom)
  f.table.cropRect[3] = bottom + 8
  f.table.rowCount = 25
  f.table.grid = f.table.grid.slice(0, 25)
  f.table.structure.objects = f.table.structure.objects
    .filter(
      (o: { label: string; rect: number[] }) =>
        !['table row', 'table spanning cell'].includes(o.label) ||
        (o.rect[1] + o.rect[3]) / 2 + offset < bottom
    )
    .map((o: { label: string; rect: number[] }) => ({
      ...o,
      rect: o.rect.map((v, n) =>
        n === 3 && ['table', 'table column'].includes(o.label)
          ? Math.min(v, bottom + 8 - offset)
          : v
      )
    }))
  f.table.spans = f.table.spans.filter(
    (o: { rect: number[] }) => (o.rect[1] + o.rect[3]) / 2 + offset < bottom
  )
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid.slice(0, 25))
  expect(result.cells).toHaveLength(130)
  expect(f.items).toHaveLength(143)
  for (const previous of f.retainedCells.filter((c: { row: number }) => c.row < 25))
    expect(
      result.cells.find(
        (c: { row: number; column: number }) =>
          c.row === previous.row && c.column === previous.column
      )
    ).toEqual(previous)
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(f.items.map(literalNativeSignature).sort())
  expect(result.repairs).toContain('native-fenced-multiline-stub-owners-recovered')
  expect(f).toEqual(before)
})

it('preserves literal fences and multiline superscripts under translation and reversed source order', () => {
  const f = fencedMultilineStubs(),
    translate = (rect: number[]): number[] => rect.map((v, n) => v + (n % 2 ? 37 : 19))
  f.table.cropRect = translate(f.table.cropRect)
  f.rules = f.rules.map((r: number[]) => translate(r)).reverse()
  for (const c of f.captions) c.rect = translate(c.rect)
  for (const item of [...f.items, ...f.runs]) {
    item.rect = translate(item.rect)
    item.baseline += 37
    if (item.gaps)
      item.gaps = item.gaps.map((g: { left: number; right: number; index: number }) => ({
        ...g,
        left: g.left + 19,
        right: g.right + 19
      }))
  }
  f.items.reverse()
  f.runs.reverse()
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.cells).toHaveLength(161)
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(f.items.map(literalNativeSignature).sort())
  for (const group of f.labelGroups) {
    const label = result.cells.find(
      (c: { row: number; column: number }) => c.row === group.row && c.column === 0
    )
    expect(label.rowSpan).toBe(6)
    expect(label.textRuns.filter((r: { position: string }) => r.position !== 'normal')).toEqual(
      group.existingRaisedRichRuns
    )
  }
  expect(f).toEqual(before)
})

// Each explicit source group prints two complete records. The second record's
// first stub is genuinely blank; no parent label or mathematical meaning is inferred.
const fencedPairedNativeRecords = (): ReturnType<typeof JSON.parse> =>
  fixture('fenced-paired-native-records')
it('restores complete native record pairs and only reindexes the already correct final records', () => {
  const f = fencedPairedNativeRecords(),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.rows).toEqual(f.expectedInternalRows)
  expect(result.cells).toEqual(f.expectedInternalCells)
  expect(result.cells).toHaveLength(44)
  for (const header of f.originalHeaderCells)
    expect(
      result.cells.find(
        (c: { row: number; column: number }) => c.row === header.row && c.column === header.column
      )
    ).toEqual(header)
  for (const original of f.originalCorrectRecordCells) {
    const row = original.row + 2
    expect(
      result.cells.find(
        (c: { row: number; column: number }) => c.row === row && c.column === original.column
      )
    ).toEqual({ ...original, row })
  }
  for (const row of [3, 5, 7]) {
    const blank = result.cells.find(
      (c: { row: number; column: number }) => c.row === row && c.column === 0
    )
    expect(blank.text).toBe('')
    expect(blank.rowSpan).toBe(1)
    expect(blank.colSpan).toBe(1)
    expect(blank.sourceTokens).toEqual([])
    expect(blank.sourceRects).toEqual([])
  }
  const owned = result.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
  expect(owned.map(literalNativeSignature).sort()).toEqual(
    f.items.map(literalNativeSignature).sort()
  )
  expect(new Set(owned.map(literalNativeSignature)).size).toBe(150)
  for (const cell of result.cells)
    expect(cell.sourceRects).toEqual(
      cell.sourceTokens.map((source: { rect: number[] }) => source.rect)
    )
  expect(Object.keys(result).sort()).toEqual(
    [
      'id',
      'cropRect',
      'grid',
      'cells',
      'rows',
      'unassigned',
      'clipped',
      'excludedCaptionItems',
      'issues',
      'repairs',
      'reviewCandidate',
      'selectedTextItems'
    ].sort()
  )
  expect(result.id).toEqual(f.table.id)
  expect(result.selectedTextItems).toBe(150)
  expect(result.excludedCaptionItems).toEqual([])
  expect(result.unassigned).toEqual([])
  expect(result.clipped).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.reviewCandidate).toBe(true)
  expect(result.repairs).toEqual(f.expectedRepairs)
  expect(result.cropRect).toEqual(f.expectedBeforeCropRect)
  expect(f).toEqual(before)
})

it.each([
  'missing-opening',
  'missing-header-divider',
  'missing-header-underline',
  'missing-group-fence',
  'shortened-group-fence',
  'missing-closing',
  'competing-complete-frame',
  'missing-title',
  'duplicate-title',
  'missing-primary-stub',
  'filled-second-record-stub',
  'missing-second-record-field',
  'wrapped-description-without-complete-record',
  'duplicate-source-owner',
  'font-box-crosses-pair-corridor',
  'font-box-crosses-group-fence',
  'font-box-crosses-leaf-gutter',
  'foreign-nonhorizontal-intersection',
  'native-interior-wall'
])('refuses fenced paired record repair without unique physical evidence: %s', (control) => {
  const f = fencedPairedNativeRecords()
  const fields = f.independentNativeRecordFields
  const source = (i: unknown): ReturnType<typeof JSON.parse> =>
    f.items.find((item: unknown) => literalNativeSignature(item) === literalNativeSignature(i))
  const remove = (items: ReturnType<typeof JSON.parse>[]): void => {
    const signatures = new Set(items.map(literalNativeSignature))
    f.items = f.items.filter((i: unknown) => !signatures.has(literalNativeSignature(i)))
    f.runs = f.runs.filter((i: unknown) => !signatures.has(literalNativeSignature(i)))
  }
  const secondFace = source(fields[1].fields[1].nativeItems[0])
  if (control === 'missing-opening') f.rules.shift()
  if (control === 'missing-header-divider') f.rules.splice(3, 1)
  if (control === 'missing-header-underline') f.rules.splice(1, 1)
  if (control === 'missing-group-fence') f.rules.splice(4, 1)
  if (control === 'shortened-group-fence') f.rules[4][2] -= 5
  if (control === 'missing-closing') f.rules.pop()
  if (control === 'competing-complete-frame')
    f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1] + 2, r[2], r[3] + 2]))
  if (control === 'missing-title') f.captions = []
  if (control === 'duplicate-title') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'missing-primary-stub') remove(fields[0].fields[0].nativeItems)
  if (control === 'filled-second-record-stub') {
    const primary = fields[0].fields[0].nativeItems[0]
    f.items.push({
      ...structuredClone(primary),
      text: 'Printed',
      rect: [primary.rect[0], secondFace.rect[1], primary.rect[2], secondFace.rect[3]],
      baseline: secondFace.baseline
    })
  }
  if (control === 'missing-second-record-field') remove(fields[1].fields[5].nativeItems)
  if (control === 'wrapped-description-without-complete-record')
    remove(
      fields[1].fields
        .filter((field: { column: number }) => field.column >= 2)
        .flatMap((field: { nativeItems: unknown[] }) => field.nativeItems)
    )
  if (control === 'duplicate-source-owner') f.items.push(structuredClone(secondFace))
  if (control === 'font-box-crosses-pair-corridor') {
    secondFace.rect[1] = fields[0].baseline - 0.1
    secondFace.height = secondFace.rect[3] - secondFace.rect[1]
    expect((secondFace.rect[1] + secondFace.rect[3]) / 2).toBeGreaterThan(
      f.independentNativeSplits[0].split
    )
  }
  if (control === 'font-box-crosses-group-fence') {
    secondFace.rect[3] = f.rules[4][1] + 0.1
    secondFace.rect[1] = secondFace.rect[3] - secondFace.height
    secondFace.baseline = secondFace.rect[3]
    expect((secondFace.rect[1] + secondFace.rect[3]) / 2).toBeLessThan(f.rules[4][1])
  }
  if (control === 'font-box-crosses-leaf-gutter') {
    secondFace.rect[2] = fields[1].fields[2].fontBox[0] + 0.1
    expect((secondFace.rect[0] + secondFace.rect[2]) / 2).toBeLessThan(
      fields[1].fields[2].fontBox[0]
    )
  }
  if (control === 'foreign-nonhorizontal-intersection')
    f.items.push({ ...structuredClone(secondFace), text: 'foreign', horizontal: false })
  if (control === 'native-interior-wall') f.rules.push([300, f.rules[0][1], 300, f.rules.at(-1)[1]])
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.repairs).not.toContain('native-fenced-paired-records-recovered')
  expect(f).toEqual(before)
})

it('keeps complete paired native records identical under redundant overlapping paint', () => {
  const f = fencedPairedNativeRecords(),
    original = literalOutput(f)
  f.rules.push(
    ...f.rules.map((r: number[]) => [r[0], r[1], r[2] - 0.1, r[3]]),
    ...structuredClone(f.rules)
  )
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result).toEqual(original)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(f).toEqual(before)
})

it('proves paired native records with different descriptive header and method literals', () => {
  const rename = (text: string): string =>
    text
      .replaceAll('Generator', 'SourceXXX')
      .replaceAll('Verifier', 'CheckerX')
      .replaceAll('Pass@1', 'Score1')
      .replaceAll('Pass@3', 'Score3')
      .replaceAll('Zero-shot', 'Stage-one')
      .replaceAll('Distilled', 'Stage-two')
  const f = JSON.parse(rename(JSON.stringify(fencedPairedNativeRecords())))
  for (const run of f.runs) run.literalGlyphs = [...run.text]
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.rows).toEqual(f.expectedInternalRows)
  expect(result.cells).toEqual(f.expectedInternalCells)
  expect(result.repairs).toEqual(f.expectedRepairs)
  expect(f).toEqual(before)
})

it('preserves paired literal records under translation and reversed native source order', () => {
  const f = fencedPairedNativeRecords()
  const translate = (rect: number[]): number[] => rect.map((v, n) => v + (n % 2 ? 37 : 19))
  f.table.cropRect = translate(f.table.cropRect)
  f.rules = f.rules.map(translate).reverse()
  for (const caption of f.captions) caption.rect = translate(caption.rect)
  for (const item of [...f.items, ...f.runs]) {
    item.rect = translate(item.rect)
    item.baseline += 37
    if (item.gaps)
      item.gaps = item.gaps.map((gap: { left: number; right: number; index: number }) => ({
        ...gap,
        left: gap.left + 19,
        right: gap.right + 19
      }))
  }
  f.items.reverse()
  f.runs.reverse()
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.cells).toHaveLength(44)
  expect(
    result.cells
      .flatMap((cell: { sourceTokens: unknown[] }) => cell.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(f.items.map(literalNativeSignature).sort())
  expect(result.repairs).toEqual(f.expectedRepairs)
  expect(result.issues).toEqual([])
  expect(result.cropRect).toEqual(f.table.cropRect)
  expect(f).toEqual(before)
})

// Native literal programs retain every internal space; only a uniquely calibrated
// original interleaf TJ boundary can split ownership into a printed leaf.
const calibratedTjNativeLeaves = (): ReturnType<typeof JSON.parse> =>
  fixture('calibrated-tj-native-leaves')
it('recovers only independently calibrated TJ leaf boundaries while preserving full literal interval fields', () => {
  const f = calibratedTjNativeLeaves(),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.rows).toEqual(f.expectedInternalRows)
  expect(result.cells).toEqual(f.expectedInternalCells)
  expect(result).toEqual(f.expectedInternalResult)
  expect(result.cells).toHaveLength(35)
  const tokens = result.cells.flatMap((cell: { sourceTokens: unknown[] }) => cell.sourceTokens)
  expect(tokens).toHaveLength(35)
  expect(
    tokens.reduce(
      (sum: number, token: { text: string }) => sum + [...token.text.replace(/\s/gu, '')].length,
      0
    )
  ).toBe(634)
  for (const original of f.items) {
    const descendants = tokens
      .filter(
        (token: ReturnType<typeof JSON.parse>) =>
          literalNativeSignature(token.sourceToken ?? token) === literalNativeSignature(original)
      )
      .sort(
        (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) =>
          a.rect[0] - b.rect[0]
      )
    expect(descendants.length).toBeGreaterThan(0)
    expect(descendants.map((token: { text: string }) => token.text).join(' ')).toBe(original.text)
    if (descendants.length > 1)
      expect(
        descendants.every((token: { nativeLaneSplit: boolean }) => token.nativeLaneSplit)
      ).toBe(true)
  }
  for (const cell of result.cells) {
    expect(cell.rowSpan).toBe(1)
    expect(cell.colSpan).toBe(1)
    expect(cell.sourceRects).toEqual(
      cell.sourceTokens.map((token: { rect: number[] }) => token.rect)
    )
    expect(
      cell.sourceTokens.every(
        (token: { rect: number[] }) =>
          token.rect[0] >= cell.rect[0] &&
          token.rect[1] >= cell.rect[1] &&
          token.rect[2] <= cell.rect[2] &&
          token.rect[3] <= cell.rect[3]
      )
    ).toBe(true)
    expect(cell).not.toHaveProperty('origin')
    expect(cell).not.toHaveProperty('textRuns')
  }
  expect(f.items).toHaveLength(24)
  expect(f.runs).toHaveLength(24)
  expect(result.selectedTextItems).toBe(24)
  expect(result.issues).toEqual([])
  expect(result.reviewCandidate).toBe(true)
  expect(result.repairs).toEqual(f.expectedRepairs)
  expect(
    result.repairs.filter(
      (repair: string) => repair !== 'native-tj-anchor-literal-leaves-recovered'
    )
  ).toEqual(f.expectedBeforeRepairs)
  expect(f.expectedBeforeIssues).toEqual(['overlapping-predicted-columns'])
  expect(result.cropRect).toEqual(f.expectedBeforeCropRect)
  expect(f).toEqual(before)
})

it.each([
  'missing-opening',
  'missing-divider',
  'missing-closing',
  'shortened-frame',
  'competing-frame',
  'missing-title',
  'duplicate-title',
  'missing-header',
  'missing-complete-peer-field',
  'no-original-unsplit-peer',
  'uncalibrated-peer-start',
  'header-font-mismatch',
  'full-font-crosses-gutter',
  'foreign-horizontal-ink',
  'foreign-nonhorizontal-ink',
  'duplicate-native-source',
  'missing-observed-stream',
  'duplicate-observed-stream',
  'multiple-glyph-programs',
  'literal-glyph-mismatch',
  'observed-font-mismatch',
  'observed-baseline-mismatch',
  'missing-tj-boundary',
  'ambiguous-tj-boundary',
  'uncalibrated-tj-endpoint',
  'tj-boundary-not-at-literal-space',
  'internal-space-substituted-for-leaf-boundary',
  'native-interior-wall'
])('refuses calibrated TJ leaves without complete literal source proof: %s', (control) => {
  const f = calibratedTjNativeLeaves()
  const source = (item: unknown): ReturnType<typeof JSON.parse> =>
    f.items.find((i: unknown) => literalNativeSignature(i) === literalNativeSignature(item))
  const observed = (item: unknown): ReturnType<typeof JSON.parse> =>
    f.runs.find((i: unknown) => literalNativeSignature(i) === literalNativeSignature(item))
  const witness = f.selectedSourceBoundaryWitnesses[0],
    original = source(witness.originalNativeItem),
    run = observed(original),
    boundary = witness.selectedTrueLeafGaps[0]
  const gap = run.gaps.find((g: { index: number }) => g.index === boundary.index)
  const peer = f.independentUnmergedPeers[0].originalNativeItems
  if (control === 'missing-opening') f.rules.shift()
  if (control === 'missing-divider') f.rules.splice(1, 1)
  if (control === 'missing-closing') f.rules.pop()
  if (control === 'shortened-frame') f.rules[1][2] -= 5
  if (control === 'competing-frame')
    f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1] + 2, r[2], r[3] + 2]))
  if (control === 'missing-title') f.captions = []
  if (control === 'duplicate-title') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'missing-header') {
    const header = source(f.originalHeaderFaces[2]),
      signature = literalNativeSignature(header)
    f.items = f.items.filter((i: unknown) => literalNativeSignature(i) !== signature)
    f.runs = f.runs.filter((i: unknown) => literalNativeSignature(i) !== signature)
  }
  if (control === 'missing-complete-peer-field') {
    const signature = literalNativeSignature(peer[3])
    f.items = f.items.filter((i: unknown) => literalNativeSignature(i) !== signature)
    f.runs = f.runs.filter((i: unknown) => literalNativeSignature(i) !== signature)
  }
  if (control === 'no-original-unsplit-peer') {
    const left = source(peer[0]),
      right = source(peer[1]),
      leftRun = observed(left),
      rightRun = observed(right)
    const offset = leftRun.literalGlyphs.length,
      joined = {
        ...structuredClone(left),
        text: left.text + ' ' + right.text,
        rect: [left.rect[0], left.rect[1], right.rect[2], right.rect[3]]
      }
    const mergedRun = {
      ...structuredClone(leftRun),
      text: joined.text,
      rect: joined.rect,
      literalGlyphs: [...leftRun.literalGlyphs, ...rightRun.literalGlyphs],
      glyphRuns: Array(leftRun.literalGlyphs.length + rightRun.literalGlyphs.length).fill(
        leftRun.glyphRuns[0]
      ),
      gaps: [
        ...leftRun.gaps,
        { index: offset, left: left.rect[2], right: right.rect[0] },
        ...rightRun.gaps.map((g: { index: number; left: number; right: number }) => ({
          ...g,
          index: g.index + offset
        }))
      ]
    }
    const signatures = new Set([literalNativeSignature(left), literalNativeSignature(right)])
    f.items = [
      ...f.items.filter((i: unknown) => !signatures.has(literalNativeSignature(i))),
      joined
    ]
    f.runs = [
      ...f.runs.filter((i: unknown) => !signatures.has(literalNativeSignature(i))),
      mergedRun
    ]
    expect(
      f.items.filter((i: { baseline: number }) => i.baseline === peer[0].baseline)
    ).toHaveLength(4)
  }
  if (control === 'uncalibrated-peer-start') {
    const item = source(peer[2]),
      stream = observed(item)
    item.rect[0] += 0.5
    stream.rect[0] += 0.5
  }
  if (control === 'header-font-mismatch') {
    const item = source(f.originalHeaderFaces[2]),
      stream = observed(item)
    item.height += 1
    item.rect[1] -= 1
    stream.height += 1
    stream.rect[1] -= 1
  }
  if (control === 'full-font-crosses-gutter') {
    const item = source(peer[1]),
      stream = observed(item)
    item.rect[2] = peer[2].rect[0] + 0.1
    stream.rect[2] = item.rect[2]
    expect((item.rect[0] + item.rect[2]) / 2).toBeLessThan(peer[2].rect[0])
  }
  if (control === 'foreign-horizontal-ink')
    f.items.push({ ...structuredClone(source(peer[0])), text: 'foreign' })
  if (control === 'foreign-nonhorizontal-ink')
    f.items.push({ ...structuredClone(source(peer[0])), text: 'foreign', horizontal: false })
  if (control === 'duplicate-native-source') f.items.push(structuredClone(original))
  if (control === 'missing-observed-stream') f.runs = f.runs.filter((r: unknown) => r !== run)
  if (control === 'duplicate-observed-stream') f.runs.push(structuredClone(run))
  if (control === 'multiple-glyph-programs') run.glyphRuns[1] = run.glyphRuns[0] + 1
  if (control === 'literal-glyph-mismatch') run.literalGlyphs[1] = '?'
  if (control === 'observed-font-mismatch') run.height += 0.5
  if (control === 'observed-baseline-mismatch') run.baseline += 0.5
  if (control === 'missing-tj-boundary') run.gaps = run.gaps.filter((g: unknown) => g !== gap)
  if (control === 'ambiguous-tj-boundary') run.gaps.push(structuredClone(gap))
  if (control === 'uncalibrated-tj-endpoint') gap.right -= 0.5
  if (control === 'tj-boundary-not-at-literal-space') gap.index++
  if (control === 'internal-space-substituted-for-leaf-boundary') {
    const internal = run.gaps.find((g: { index: number }) => g.index < gap.index)
    expect(internal).toBeDefined()
    internal.right = gap.right
    run.gaps = run.gaps.filter((g: unknown) => g !== gap)
  }
  if (control === 'native-interior-wall') f.rules.push([200, f.rules[0][1], 200, f.rules.at(-1)[1]])
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.repairs).not.toContain('native-tj-anchor-literal-leaves-recovered')
  expect(f).toEqual(before)
})

it('preserves calibrated native literal fields under redundant overlapping paint', () => {
  const f = calibratedTjNativeLeaves(),
    original = literalOutput(f)
  f.rules.push(
    ...f.rules.map((r: number[]) => [r[0], r[1], r[2] - 0.1, r[3]]),
    ...structuredClone(f.rules)
  )
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result).toEqual(original)
  expect(result).toEqual(f.expectedInternalResult)
  expect(f).toEqual(before)
})

it('preserves calibrated source-space partitions after translation and reversed source order', () => {
  const f = calibratedTjNativeLeaves(),
    translate = (rect: number[]): number[] => rect.map((v, n) => v + (n % 2 ? 37 : 19))
  f.table.cropRect = translate(f.table.cropRect)
  f.rules = f.rules.map(translate).reverse()
  for (const caption of f.captions) caption.rect = translate(caption.rect)
  for (const item of [...f.items, ...f.runs]) {
    item.rect = translate(item.rect)
    item.baseline += 37
    if (item.gaps)
      item.gaps = item.gaps.map((gap: { left: number; right: number; index: number }) => ({
        ...gap,
        left: gap.left + 19,
        right: gap.right + 19
      }))
  }
  f.items.reverse()
  f.runs.reverse()
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.cells).toHaveLength(35)
  expect(result.rows).toHaveLength(7)
  const tokens = result.cells.flatMap(
    (c: { sourceTokens: ReturnType<typeof JSON.parse>[] }) => c.sourceTokens
  )
  expect(
    tokens.reduce((n: number, t: { text: string }) => n + [...t.text.replace(/\s/gu, '')].length, 0)
  ).toBe(634)
  for (const original of f.items) {
    const descendants = tokens
      .filter(
        (t: ReturnType<typeof JSON.parse>) =>
          literalNativeSignature(t.sourceToken ?? t) === literalNativeSignature(original)
      )
      .sort(
        (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) =>
          a.rect[0] - b.rect[0]
      )
    expect(descendants.map((t: { text: string }) => t.text).join(' ')).toBe(original.text)
  }
  expect(result.repairs).toEqual(f.expectedRepairs)
  expect(result.issues).toEqual([])
  expect(result.cropRect).toEqual(f.table.cropRect)
  expect(f).toEqual(before)
})

it('recovers independent multiplier leaves and complete native-fenced model groups', () => {
  const f = fixture('aligned-multiplier-native-leaves'),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.cells).toHaveLength(f.expectedCellCount)
  for (const label of f.expectedLabelSlots) {
    const cell = result.cells.find(
      (c: { row: number; column: number }) => c.row === label.row && c.column === 0
    )
    expect(cell.text).toBe(label.text)
    expect(cell.rowSpan).toBe(label.rowSpan)
  }
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(
    f.expectedBefore.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  )
  for (const key of [
    'rows',
    'cropRect',
    'unassigned',
    'clipped',
    'excludedCaptionItems',
    'issues',
    'reviewCandidate'
  ])
    expect(result[key]).toEqual(f.expectedBefore[key])
  expect(f).toEqual(before)
})

it('repairs only a same-baseline small-caps native fenced stub without rebuilding rich peers', () => {
  const f = fixture('fenced-smallcaps-stub-owner'),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.cells).toHaveLength(f.expectedCellCount)
  const headerRun = f.runs.find(
    (run: { text: string }) => run.text === 'Model XXXXXXXX-4 XXXXXXXX-3 XXXXXXXXXX'
  )
  // Earlier snapshots divided this header by character counts. Its native TJ
  // gaps supply the actual ink edges; every unrelated rich cell stays exact.
  const expectedCells = structuredClone(f.expectedCells)
  for (const cell of expectedCells) {
    if (cell.row !== 0 || cell.column < 1 || cell.column > 4) continue
    const part = cell.column - 1
    const rect = [
      part ? headerRun.gaps[part - 1].right : headerRun.rect[0],
      headerRun.rect[1],
      part < 3 ? headerRun.gaps[part].left : headerRun.rect[2],
      headerRun.rect[3]
    ]
    cell.sourceRects = [rect]
    cell.sourceTokens[0].rect = rect
  }
  for (const expected of expectedCells)
    expect(
      result.cells.find(
        (c: { row: number; column: number }) =>
          c.row === expected.row && c.column === expected.column
      )
    ).toEqual(expected)
  for (const key of [
    'rows',
    'cropRect',
    'unassigned',
    'clipped',
    'excludedCaptionItems',
    'issues',
    'reviewCandidate',
    'selectedTextItems'
  ])
    expect(result[key]).toEqual(f.expectedBefore[key])
  expect(f).toEqual(before)
})

it('recovers a rowless single complete native record only from its independent header and closed frame', () => {
  const f = fixture('closed-single-native-record'),
    before = structuredClone(f),
    result = literalOutput(f)
  expect(result.grid).toEqual(f.expectedGrid)
  expect(result.cells).toHaveLength(8)
  expect(result.unassigned).toEqual([])
  expect(
    result.cells
      .flatMap((c: { sourceTokens: { text: string }[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(
    f.items
      .filter((i: { baseline: number }) => i.baseline > 135 && i.baseline < 185)
      .map(literalNativeSignature)
      .sort()
  )
  expect(f).toEqual(before)
})
it.each([
  'aligned-multiplier-native-leaves',
  'fenced-smallcaps-stub-owner',
  'closed-single-native-record'
])(
  'keeps complete native literal qualification under equivalent painted edges for %s',
  (kind: string) => {
    const f = fixture(kind),
      expected = literalOutput(f)
    const crop = f.table.cropRect,
      edge = f.rules.find(
        (r: number[]) =>
          r[1] === r[3] &&
          r[1] > crop[1] &&
          r[1] < crop[3] &&
          r[2] - r[0] > (crop[2] - crop[0]) * 0.7
      )
    f.rules.push([edge[0], edge[1], edge[2] - 0.1, edge[3]], [...edge])
    expect(literalOutput(f)).toEqual(expected)
  }
)

it.each([
  'aligned-multiplier-native-leaves',
  'fenced-smallcaps-stub-owner',
  'closed-single-native-record'
])(
  'keeps source-leaf and fenced-owner proofs under translation and reverse source order for %s',
  (kind: string) => {
    const f = fixture(kind),
      translate = (r: number[]): number[] => r.map((v, n) => v + (n % 2 ? 37 : 19))
    f.table.cropRect = translate(f.table.cropRect)
    f.rules = f.rules.map(translate).reverse()
    for (const c of [...f.captions, ...f.notes]) c.rect = translate(c.rect)
    for (const i of [...f.items, ...f.runs]) {
      i.rect = translate(i.rect)
      i.baseline += 37
      if (i.gaps)
        i.gaps = i.gaps.map((g: ReturnType<typeof JSON.parse>) => ({
          ...g,
          left: g.left + 19,
          right: g.right + 19
        }))
    }
    f.items.reverse()
    f.runs.reverse()
    const before = structuredClone(f),
      result = literalOutput(f)
    expect(result.grid).toEqual(f.expectedGrid)
    expect(result.cells).toHaveLength(f.expectedCellCount ?? 8)
    expect(f).toEqual(before)
  }
)

for (const kind of [
  'aligned-multiplier-native-leaves',
  'fenced-smallcaps-stub-owner',
  'closed-single-native-record'
]) {
  it.each([
    'missing-caption',
    'missing-opening',
    'missing-closing',
    'competing-full-frame',
    'nonhorizontal-foreign-font',
    'duplicate-native-font',
    'font-crosses-native-fence'
  ])('refuses %s before projecting ' + kind, (control: string) => {
    const f = fixture(kind),
      crop = f.table.cropRect
    const edges = f.rules
      .filter(
        (r: number[]) =>
          r[1] === r[3] &&
          r[1] > crop[1] &&
          r[1] < crop[3] &&
          r[2] - r[0] > (crop[2] - crop[0]) * 0.7
      )
      .sort((a: number[], b: number[]) => a[1] - b[1])
    const first = edges[0],
      last = edges.at(-1),
      item = f.items.find(
        (i: ReturnType<typeof JSON.parse>) =>
          i.rect[0] > first[0] &&
          i.rect[2] < first[2] &&
          i.rect[1] > edges[1][1] &&
          i.rect[3] < last[1]
      )
    if (control === 'missing-caption') f.captions = []
    if (control === 'missing-opening') f.rules = f.rules.filter((r: number[]) => r[1] !== first[1])
    if (control === 'missing-closing') f.rules = f.rules.filter((r: number[]) => r[1] !== last[1])
    if (control === 'competing-full-frame')
      f.rules.push(...edges.map((r: number[]) => [r[0], r[1] + 0.5, r[2], r[3] + 0.5]))
    if (control === 'nonhorizontal-foreign-font')
      f.items.push({ ...structuredClone(item), text: 'foreign', horizontal: false })
    if (control === 'duplicate-native-font') f.items.push(structuredClone(item))
    if (control === 'font-crosses-native-fence') {
      item.rect[1] = first[1] - 0.5
      item.baseline = first[1] + 0.5
    }
    const before = structuredClone(f),
      result = literalOutput(f)
    expect(result.repairs).not.toContain(
      kind === 'aligned-multiplier-native-leaves'
        ? 'native-aligned-literal-leaf-columns-recovered'
        : kind === 'closed-single-native-record'
          ? 'native-closed-single-literal-record-recovered'
          : 'native-fenced-composite-stub-owners-recovered'
    )
    expect(f).toEqual(before)
  })
}

it.each([
  'missing-header-face',
  'missing-numeric-peer',
  'changed-calibrated-endpoint',
  'overlapping-header-pieces',
  'nonfinite-model-column',
  'competing-program-font',
  'missing-native-program'
])('refuses ambiguous independent multiplier leaf qualification: %s', (control: string) => {
  const f = fixture('aligned-multiplier-native-leaves'),
    opening = Math.min(
      ...f.rules
        .filter((r: number[]) => r[1] === r[3] && r[1] > f.table.cropRect[1] && r[2] - r[0] > 400)
        .map((r: number[]) => r[1])
    ),
    header = f.items.filter(
      (i: ReturnType<typeof JSON.parse>) => i.baseline > opening && i.baseline < opening + 25
    )
  const sign = header.find((i: { text: string }) => i.text === '×'),
    number = f.items.find(
      (i: ReturnType<typeof JSON.parse>) =>
        /^\d+\.\d+$/.test(i.text) && i.baseline > opening + 25 && i.rect[0] > 340 && i.rect[0] < 377
    )
  const item = control === 'overlapping-header-pieces' ? sign : number,
    program = f.runs.find(
      (r: ReturnType<typeof JSON.parse>) =>
        literalNativeSignature(r) === literalNativeSignature(item)
    )
  if (control === 'missing-header-face')
    f.items = f.items.filter(
      (i: unknown) => i !== header.find((i: { text: string }) => i.text === '0.25')
    )
  if (control === 'missing-numeric-peer') f.items = f.items.filter((i: unknown) => i !== number)
  if (control === 'changed-calibrated-endpoint') {
    number.rect[2] -= 1
    program.rect[2] -= 1
  }
  if (control === 'overlapping-header-pieces') {
    sign.rect[0] -= 2
    program.rect[0] -= 2
  }
  if (control === 'nonfinite-model-column')
    f.table.structure.objects.find((o: { label: string }) => o.label === 'table column').rect[0] =
      NaN
  if (control === 'competing-program-font')
    f.runs.push({ ...structuredClone(program), baseline: program.baseline + 1 })
  if (control === 'missing-native-program') f.runs = f.runs.filter((r: unknown) => r !== program)
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.repairs).not.toContain('native-aligned-literal-leaf-columns-recovered')
  expect(f).toEqual(before)
})

it.each([
  'missing-ordinary-header',
  'missing-whole-record-field',
  'shifted-independent-anchor',
  'wrong-program-baseline',
  'duplicate-program-font',
  'extra-wrapped-record'
])('refuses incomplete closed single native record: %s', (control: string) => {
  const f = fixture('closed-single-native-record'),
    item = f.items.find(
      (i: ReturnType<typeof JSON.parse>) =>
        i.baseline > 160 && i.baseline < 180 && i.rect[0] > 300 && i.rect[0] < 400
    ),
    header = f.items.find(
      (i: ReturnType<typeof JSON.parse>) =>
        i.baseline > 135 && i.baseline < 160 && Math.abs(i.rect[0] - item.rect[0]) < 0.02
    ),
    program = f.runs.find(
      (r: ReturnType<typeof JSON.parse>) =>
        literalNativeSignature(r) === literalNativeSignature(item)
    )
  if (control === 'missing-ordinary-header') f.items = f.items.filter((i: unknown) => i !== header)
  if (control === 'missing-whole-record-field') f.items = f.items.filter((i: unknown) => i !== item)
  if (control === 'shifted-independent-anchor') {
    item.rect[0] += 1
    program.rect[0] += 1
  }
  if (control === 'wrong-program-baseline') program.baseline += 1
  if (control === 'duplicate-program-font')
    f.runs.push({ ...structuredClone(program), height: program.height - 1 })
  if (control === 'extra-wrapped-record')
    f.items.push({
      ...structuredClone(item),
      text: 'wrap',
      baseline: item.baseline + 2,
      rect: item.rect.map((v: number, n: number) => v + (n % 2 ? 2 : 0))
    })
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.repairs).not.toContain('native-closed-single-literal-record-recovered')
  expect(f).toEqual(before)
})

const wrappedHeaderCompleteRecords = (): ReturnType<typeof JSON.parse> => {
  const table = {
    id: 'anonymous-wrapped-header-records',
    readingRotation: 0,
    cropRect: [154, 138, 734, 317],
    structure: {
      objects: [
        {
          label: 'table row',
          score: 0.9998010657961618,
          rect: [10.890252590179443, 114.62750433385372, 559.7742080688477, 131.14856912195683]
        },
        {
          label: 'table column',
          score: 0.9999092856439266,
          rect: [384.60587590932846, 25.433196485042572, 445.47091871500015, 147.18052166700363]
        },
        {
          label: 'table column',
          score: 0.9996912490644844,
          rect: [278.26655089855194, 25.245860785245895, 332.93481409549713, 147.29671493172646]
        },
        {
          label: 'table column',
          score: 0.9996798605654057,
          rect: [334.2273172736168, 25.290196776390076, 383.60209852457047, 147.25950598716736]
        },
        {
          label: 'table row',
          score: 0.9990694130306873,
          rect: [11.04879379272461, 66.27867655456066, 559.9954605102539, 82.82204003632069]
        },
        {
          label: 'table row',
          score: 0.9955120695158016,
          rect: [11.099889278411865, 45.67375539243221, 559.9277710914612, 66.1622378975153]
        },
        {
          label: 'table column',
          score: 0.9999094825282647,
          rect: [11.219529807567596, 25.70266392827034, 70.55872589349747, 147.1858402788639]
        },
        {
          label: 'table row',
          score: 0.9997141454601725,
          rect: [10.944597721099854, 98.19461274147034, 559.8662352561951, 114.70100200176239]
        },
        {
          label: 'table column',
          score: 0.99991732659036,
          rect: [197.19737470149994, 25.454839020967484, 277.82802164554596, 147.38459739089012]
        },
        {
          label: 'table row',
          score: 0.973948936425172,
          rect: [10.993325114250183, 25.105816453695297, 559.9865239858627, 45.75910124182701]
        },
        {
          label: 'table column',
          score: 0.9998751310620636,
          rect: [445.8730882406235, 25.64559954404831, 513.4949904680252, 147.19865936040878]
        },
        {
          label: 'table column',
          score: 0.9999157871000888,
          rect: [128.88142257928848, 25.9519345164299, 196.834736764431, 147.32686084508896]
        },
        {
          label: 'table column',
          score: 0.9995976994570696,
          rect: [513.504955470562, 25.37025335431099, 559.9861696362495, 147.3061892092228]
        },
        {
          label: 'table row',
          score: 0.9995364741009184,
          rect: [10.819503664970398, 131.14934530854225, 559.7358864545822, 147.04774841666222]
        },
        {
          label: 'table column header',
          score: 0.9799736273991759,
          rect: [10.958685278892517, 24.83751729130745, 559.9186271429062, 45.59097549319267]
        },
        {
          label: 'table column',
          score: 0.9999502150615414,
          rect: [70.92840760946274, 25.67122170329094, 129.35763388872147, 147.35237631201744]
        },
        {
          label: 'table row',
          score: 0.9998228260568361,
          rect: [10.809547305107117, 81.91324824094772, 559.973594546318, 98.35111969709396]
        },
        {
          label: 'table',
          score: 0.9999872259564183,
          rect: [10.699491500854492, 25.444468528032303, 559.9497580528259, 147.18126317858696]
        }
      ],
      inputSize: [1000, 309],
      preprocessMs: 6,
      inferenceMs: 704,
      memory: {
        rss: 887668736,
        heapTotal: 111243264,
        heapUsed: 48419304,
        external: 144049368,
        arrayBuffers: 133928236
      }
    },
    rowCount: 7,
    columnCount: 9,
    spans: [],
    grid: [
      ['', 'XXXXXX', 'XXXXXXX', 'XXXXXXXXX', 'XXXXX', 'XXX', 'XXXXXX', 'XXXXXXX', ''],
      ['XXXX', '86.0', '48.0', '86.0', '89.0', '78.0', '75.0', '44.0', '72.3'],
      ['XXXXXX', '85.0', '52.0', '90.0', '88.0', '79.0', '72.0', '50.0', '73.7'],
      ['XX', '87.0', '43.0', '86.0', '88.0', '82.0', '74.0', '47.0', '72.4'],
      ['XXX', '87.0', '59.0', '87.0', '91.0', '76.0', '77.0', '47.0', '74.9'],
      ['XXXX', '81.0', '46.0', '87.0', '85.0', '80.0', '62.0', '49.0', '70.0'],
      ['XXXX∗', '85.0', '32.0', '85.0', '87.0', '80.0', '67.0', '52.0', '69.7']
    ],
    unassigned: [
      'Method',
      'Adjust',
      'Pick',
      'Place',
      'Stack',
      'Place',
      'Open',
      'Press',
      'Average',
      'XXXX',
      '95.0',
      '64.0',
      '94.0',
      '93.0',
      '88.0',
      '81.0',
      '54.0',
      '81.3'
    ]
  }
  table.grid = table.grid.map((r: string[]) => r.map((s: string) => s.replace(/\p{L}/gu, 'X')))
  table.unassigned = table.unassigned.map((s: string) => s.replace(/\p{L}/gu, 'X'))
  const h = 13.4496
  const token = (
    text: string,
    x: number,
    y: number,
    width: number,
    height = h
  ): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [x, y - height, x + width, y],
    baseline: y,
    height,
    horizontal: true
  })
  const items = [
    token('Method', 165.7185, 167.9115, 47.54),
    token('Average', 677.2305, 167.9115, 46.22)
  ]
  const left = [233.4345, 293.7225, 361.071, 442.5375, 495.7665, 548.9955, 609.2835]
  for (const [c, x] of left.entries())
    items.push(token('Upper', x, 159.618, 29), token('Leaf' + c, x, 176.0565, 29))
  const baselines = [199.995, 216.4335, 232.872, 249.3105, 265.749, 282.1875, 306.1275]
  const fields = [
    165.7185, 241.5255, 305.343852, 379.7470392, 447.102636, 500.3227032, 557.0934648, 620.9118168,
    687.2565
  ]
  for (const [r, y] of baselines.entries())
    for (const [c, x] of fields.entries())
      items.push(token(c ? '12.34' : 'Stem' + r, x, y, c ? 26.17 : 32.83))
  items.push(token('∗', 198.549, 276.474, 5.7286, 8.9664))
  return {
    table,
    items,
    rules: [
      [93.543, 109.11000000000013, 799.3694923095703, 109.11000000000013],
      [156.75150000000002, 143.33249999999998, 732.4214981689454, 143.33249999999998],
      [224.16899999999998, 148.1100010986329, 224.16899999999998, 180.98700000000008],
      [667.965, 148.1100010986329, 667.965, 180.98700000000008],
      [156.75150000000002, 183.93449999999984, 732.4214981689454, 183.93449999999984],
      [224.16899999999998, 188.4885005493163, 224.16899999999998, 204.9269999999999],
      [667.965, 188.4885005493163, 667.965, 204.9269999999999],
      [224.16899999999998, 204.92700054931652, 224.16899999999998, 221.3655000000001],
      [667.965, 204.92700054931652, 667.965, 221.3655000000001],
      [224.16899999999998, 221.3655005493165, 224.16899999999998, 237.8040000000001],
      [667.965, 221.3655005493165, 667.965, 237.8040000000001],
      [224.16899999999998, 237.80400054931647, 224.16899999999998, 254.24250000000006],
      [667.965, 237.80400054931647, 667.965, 254.24250000000006],
      [224.16899999999998, 254.24250054931645, 224.16899999999998, 270.68100000000004],
      [667.965, 254.24250054931645, 667.965, 270.68100000000004],
      [224.16899999999998, 270.6810005493164, 224.16899999999998, 287.1195],
      [667.965, 270.6810005493164, 667.965, 287.1195],
      [156.75150000000002, 290.06549999999993, 732.4214981689454, 290.06549999999993],
      [224.16899999999998, 294.6195005493164, 224.16899999999998, 311.058],
      [667.965, 294.6195005493164, 667.965, 311.058],
      [156.75150000000002, 314.22900000000004, 732.4214981689454, 314.22900000000004],
      [123.2925285943222, 473.9070756134033, 455.25842203125, 473.9070756134033],
      [123.2925285943222, 452.05379289550785, 455.25842203125, 452.05379289550785],
      [123.2925285943222, 430.2005158083344, 455.25842203125, 430.2005158083344],
      [123.2925285943222, 408.3472387211609, 455.25842203125, 408.3472387211609],
      [123.2925285943222, 386.49395600326545, 455.25842203125, 386.49395600326545],
      [123.2925285943222, 364.64067328536987, 455.25842203125, 364.64067328536987],
      [123.2925285943222, 342.7874018289185, 455.25842203125, 342.7874018289185],
      [123.2925285943222, 338.8538131919861, 123.2925285943222, 491.8267640636444],
      [123.2925285943222, 491.8267640636444, 455.25842203125, 491.8267640636444],
      [123.2925285943222, 394.3611332771302, 455.25842203125, 394.3611332771302],
      [123.2925285943222, 398.2947331755066, 455.25842203125, 398.2947331755066],
      [305.36452452667237, 472.84094062442784, 312.00679452667237, 472.84094062442784],
      [312.00679452667237, 472.84094062442784, 318.64906452667236, 472.84094062442784],
      [305.36452452667237, 482.14012031364445, 312.00679452667237, 482.14012031364445],
      [312.00679452667237, 482.14012031364445, 318.64906452667236, 482.14012031364445],
      [376.51633283569333, 458.6537930651093, 376.51633283569333, 488.06044728652955],
      [506.26886711294173, 476.9901373763466, 791.8808241220092, 476.9901373763466],
      [506.26886711294173, 433.1893512589645, 791.8808241220092, 433.1893512589645],
      [506.26886711294173, 389.3885738669586, 791.8808241220092, 389.3885738669586],
      [506.26886711294173, 345.58779065803526, 791.8808241220092, 345.58779065803526],
      [506.26886711294173, 498.8905289808082, 791.8808241220092, 498.8905289808082],
      [506.26886711294173, 455.0897428634262, 791.8808241220092, 455.0897428634262],
      [506.26886711294173, 411.2889654714203, 791.8808241220092, 411.2889654714203],
      [506.26886711294173, 367.48818226249693, 791.8808241220092, 367.48818226249693],
      [506.26886711294173, 345.58779065803526, 506.26886711294173, 498.8905289808082],
      [506.26886711294173, 498.8905289808082, 791.8808241220092, 498.8905289808082],
      [450.11627771999997, 801.45976176, 795.7227126165453, 801.45976176],
      [541.9594495800001, 806.1366469602214, 541.9594495800001, 823.51674837],
      [450.11627771999997, 826.40217402, 795.7227126165453, 826.40217402],
      [541.9594495800001, 830.8602661302214, 541.9594495800001, 848.24036754],
      [450.11627771999997, 851.1243247799999, 795.7227126165453, 851.1243247799999],
      [541.9594495800001, 855.5824168902213, 541.9594495800001, 872.9625182999999],
      [450.11627771999997, 875.84794395, 795.7227126165453, 875.84794395],
      [541.9594495800001, 880.3060360602213, 541.9594495800001, 897.68613747],
      [450.11627771999997, 900.7888878, 795.7227126165453, 900.7888878],
      [93.543, 1155.0165, 799.3694923095703, 1155.0165]
    ],
    captions: [{ lines: ['Table 1: Literal complete records.'], rect: [155, 110, 731, 127] }],
    runs: []
  }
}
it('reindexes only complete source records and retains a wrapped header and raised literal mark', () => {
  const f = wrappedHeaderCompleteRecords(),
    before = structuredClone(f),
    result = run(f)
  expect(result.grid).toHaveLength(8)
  expect(result.grid.slice(1).map((r: string[]) => r[0])).toEqual([
    'Stem0',
    'Stem1',
    'Stem2',
    'Stem3',
    'Stem4',
    'Stem5∗',
    'Stem6'
  ])
  expect(result.cells).toHaveLength(72)
  expect(result.grid[0]).toEqual([
    'Method',
    ...Array.from({ length: 7 }, (_, c) => 'Upper Leaf' + c),
    'Average'
  ])
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 6 && c.column === 0)
      .textRuns
  ).toContainEqual({ text: '∗', position: 'superscript' })
  expect(f).toEqual(before)
})

it.each([
  'missing-caption',
  'missing-closing',
  'missing-numeric-face',
  'duplicate-source-font',
  'foreign-rotated-font',
  'wrapped-measurement',
  'measurement-crosses-gutter',
  'true-empty-ruled-record',
  'extra-unowned-script'
])('refuses deleting empty predictions without complete native records: %s', (control: string) => {
  const f = wrappedHeaderCompleteRecords(),
    item = f.items.find(
      (i: { text: string; baseline: number }) => i.text === '12.34' && i.baseline === 216.4335
    )
  if (control === 'missing-caption') f.captions = []
  if (control === 'missing-closing')
    f.rules = f.rules.filter((r: number[]) => Math.abs(r[1] - 314.229) > 0.02)
  if (control === 'missing-numeric-face') f.items = f.items.filter((i: unknown) => i !== item)
  if (control === 'duplicate-source-font') f.items.push(structuredClone(item))
  if (control === 'foreign-rotated-font')
    f.items.push({ ...structuredClone(item), text: 'foreign', horizontal: false })
  if (control === 'wrapped-measurement') {
    item.rect[1] += 2
    item.rect[3] += 2
    item.baseline += 2
  }
  if (control === 'measurement-crosses-gutter') item.rect[2] = 307
  if (control === 'true-empty-ruled-record') f.rules.push([156.7515, 288, 732.4214981689454, 288])
  if (control === 'extra-unowned-script')
    f.items.push({
      ...structuredClone(item),
      text: 'x',
      height: 5,
      baseline: 220,
      rect: [item.rect[0], 215, item.rect[0] + 3, 220]
    })
  const before = structuredClone(f),
    result = run(f)
  expect(result.repairs).not.toContain('native-complete-record-row-owners-recovered')
  expect(f).toEqual(before)
})

const closedNativePairedRecords = (): ReturnType<typeof JSON.parse> => {
  const table = {
    id: 'anonymous-fenced-native-pairs',
    cropRect: [156, 381, 758, 546],
    readingRotation: 0,
    rowCount: 0,
    columnCount: 4,
    structure: {
      objects: [
        {
          label: 'table column',
          rect: [14.105472832918167, 34.149446189403534, 125.9817154109478, 137.83262819051743],
          score: 0.9990566209531736
        },
        {
          label: 'table column',
          rect: [298.7356486916542, 33.93135532736778, 459.7504729628563, 135.85784152150154],
          score: 0.9990549106574244
        },
        {
          label: 'table column',
          rect: [461.20215088129044, 34.03680860996246, 584.7215809226036, 137.09583699703217],
          score: 0.9939907366796827
        },
        {
          label: 'table column',
          rect: [124.62301671504974, 33.94953489303589, 299.55252027511597, 135.98265945911407],
          score: 0.9995047833573046
        },
        {
          label: 'table spanning cell',
          rect: [14.063526779413223, 34.32756118476391, 125.26490077376366, 73.21812696754932],
          score: 0.6634302263325509
        },
        {
          label: 'table',
          rect: [13.793721079826355, 34.24982964992523, 585.1051415205002, 137.42384612560272],
          score: 0.9991090992888972
        }
      ]
    },
    spans: [],
    grid: [],
    unassigned: []
  }
  const observed: [string, number, number, number, number][] = [
    ['α', 167.44050000000001, 402.8025, 9.549152099999986, 14.9439],
    ['= 0', 181.20600000000002, 402.8025, 23.222820600000006, 14.9439],
    ['.', 204.45300000000003, 402.8025, 4.139460299999996, 14.9439],
    ['05', 208.60350000000003, 402.8025, 14.943900000000014, 14.9439],
    [', d', 223.54799999999997, 402.8025, 16.886606999999998, 14.9439],
    ['= 1500', 244.60949999999997, 402.8025, 45.63867060000001, 14.9439],
    ['XXXXXXXX (XXXXXXXX XXXXX)', 439.755, 402.8025, 193.2395709000001, 14.9439],
    ['XXXXXX (XXX)', 653.3929944000001, 402.8025, 94.68455040000003, 14.9439],
    ['k', 167.44050000000001, 437.92499999999995, 7.7708279999999945, 14.9439],
    ['= 2', 179.841, 437.92499999999995, 23.222820599999977, 14.9439],
    ['.', 203.088, 437.92499999999995, 4.139460299999996, 14.9439],
    ['5', 207.2385, 437.92499999999995, 7.4719499999999925, 14.9439],
    ['×', 218.031, 437.92499999999995, 11.611410299999989, 14.9439],
    ['10', 232.9755, 437.92499999999995, 14.943899999999985, 14.9439],
    ['6', 247.92000000000002, 432.50249999999994, 5.952138300000001, 10.4607],
    ['XXXXXXXX XXXXXXXXX', 308.20349999999996, 428.95799999999997, 113.61847170000004, 14.9439],
    ['0.9420 (0.160)', 490.29599999999994, 428.95799999999997, 92.14408739999999, 14.9439],
    ['0.006 (0.00209)', 650.928, 428.95799999999997, 99.63098129999992, 14.9439],
    ['XXXXXX XXXXXXX', 311.7675, 446.89200000000005, 106.49023140000003, 14.9439],
    ['0.9890 (0.780)', 490.29600000000005, 446.89200000000005, 92.14408739999999, 14.9439],
    ['0.021 (0.01486)', 650.928, 446.89200000000005, 99.63098129999992, 14.9439],
    ['k', 167.44050000000001, 482.0145, 7.7708279999999945, 14.9439],
    ['= 5', 179.841, 482.0145, 23.222820599999977, 14.9439],
    ['×', 206.409, 482.0145, 11.611410299999989, 14.9439],
    ['10', 221.35200000000003, 482.0145, 14.943899999999985, 14.9439],
    ['6', 236.2965, 476.5905, 5.952138300000001, 10.4607],
    ['XXXXXXXX XXXXXXXXX', 308.20349999999996, 473.0475, 113.61847170000004, 14.9439],
    ['0.9350 (0.300)', 490.29599999999994, 473.0475, 92.14408739999999, 14.9439],
    ['0.004 (0.00126)', 650.928, 473.0475, 99.63098129999992, 14.9439],
    ['XXXXXX XXXXXXX', 311.7675, 490.98, 106.49023140000003, 14.9439],
    ['0.9880 (0.760)', 490.29600000000005, 490.98, 92.14408739999999, 14.9439],
    ['0.011 (0.00736)', 650.928, 490.98, 99.63098129999992, 14.9439],
    ['k', 167.44050000000001, 526.1025, 7.7708279999999945, 14.9439],
    ['= 10', 179.841, 526.1025, 30.6947706, 14.9439],
    ['7', 210.55949999999999, 520.6800000000001, 5.952138300000001, 10.4607],
    ['XXXXXXXX XXXXXXXXX', 308.20349999999996, 517.137, 113.61847170000004, 14.9439],
    ['0.9510 (0.020)', 490.29599999999994, 517.137, 92.14408739999999, 14.9439],
    ['0.003 (0.00086)', 650.928, 517.137, 99.63098129999992, 14.9439],
    ['XXXXXX XXXXXXX', 311.7675, 535.0695, 106.49023140000003, 14.9439],
    ['0.9850 (0.700)', 490.29600000000005, 535.0695, 92.14408739999999, 14.9439],
    ['0.006 (0.00369)', 650.928, 535.0695, 99.63098129999992, 14.9439]
  ]
  const items = observed.map(([text, x, baseline, width, height]) => ({
    text,
    rect: [x, baseline - height, x + width, baseline],
    baseline,
    height,
    horizontal: true
  }))
  return {
    table,
    items,
    rules: [
      [158.47349739074707, 385.25550842285156, 759.5265197753906, 385.25550842285156],
      [158.47349739074707, 411.41249084472656, 759.5265197753906, 411.41249084472656],
      [158.47349739074707, 455.5019989013672, 759.5265197753906, 455.5019989013672],
      [158.47349739074707, 499.5899963378906, 759.5265197753906, 499.5899963378906],
      [158.47349739074707, 543.67950439453125, 759.5265197753906, 543.67950439453125]
    ],
    captions: [
      {
        page: 1,
        lines: ['Table 1: Literal paired records.'],
        rect: [107.99999999999991, 577.8823500000001, 810.0105202499998, 638.8785]
      }
    ],
    runs: []
  }
}
it('restores independently fenced paired records with a genuinely blank method header', () => {
  const f = closedNativePairedRecords(),
    before = structuredClone(f),
    result = run(f)
  expect(result.grid).toHaveLength(7)
  expect(result.grid.every((r: string[]) => r.length === 4)).toBe(true)
  expect(result.cells).toHaveLength(25)
  expect(
    result.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 0).colSpan
  ).toBe(1)
  expect(result.grid[0][1]).toBe('')
  expect(
    result.grid
      .filter((_: string[], row: number) => row > 0 && row % 2 === 0)
      .every((r: string[]) => r[0] === '')
  ).toBe(true)
  expect(
    result.cells
      .filter((c: { column: number; row: number }) => c.column === 0 && c.row > 0)
      .map((c: { rowSpan: number }) => c.rowSpan)
  ).toEqual([2, 2, 2])
  expect(
    result.cells
      .filter((c: { column: number; row: number }) => c.column === 0 && c.row > 0)
      .every((c: ReturnType<typeof JSON.parse>) =>
        c.textRuns?.some((r: { position: string }) => r.position === 'superscript')
      )
  ).toBe(true)
  expect(result.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)).toHaveLength(
    f.items.length
  )
  for (const item of f.items)
    expect(
      result.cells
        .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
        .filter(
          (t: ReturnType<typeof JSON.parse>) =>
            literalNativeSignature(t) === literalNativeSignature(item)
        )
    ).toHaveLength(1)
  expect(result.unassigned).toEqual([])
  expect(f).toEqual(before)
})

it.each([
  'missing-caption',
  'competing-caption',
  'missing-closing',
  'missing-pair-fence',
  'wrong-fence-endpoint',
  'font-crosses-fence',
  'missing-method',
  'missing-measurement',
  'duplicate-native-owner',
  'foreign-rotated-font',
  'measurement-crosses-gutter',
  'uncalibrated-method-offset',
  'wrapped-measurement',
  'unsupported-script',
  'script-without-parent',
  'native-font-outside-original-crop'
])('refuses incomplete fenced paired literal ownership: %s', (control: string) => {
  const f = closedNativePairedRecords(),
    method = f.items.find(
      (i: ReturnType<typeof JSON.parse>) =>
        i.baseline === 428.95799999999997 && i.rect[0] > 300 && i.rect[0] < 450
    ),
    value = f.items.find(
      (i: ReturnType<typeof JSON.parse>) =>
        i.baseline === 428.95799999999997 && i.rect[0] > 480 && i.rect[0] < 600
    ),
    script = f.items.find((i: { height: number }) => i.height < 11)
  if (control === 'missing-caption') f.captions = []
  if (control === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'missing-closing') f.rules.pop()
  if (control === 'missing-pair-fence') f.rules.splice(2, 1)
  if (control === 'wrong-fence-endpoint') f.rules[2][2] += 1
  if (control === 'font-crosses-fence') f.rules[2][1] = f.rules[2][3] = 434
  if (control === 'missing-method') f.items = f.items.filter((i: unknown) => i !== method)
  if (control === 'missing-measurement') f.items = f.items.filter((i: unknown) => i !== value)
  if (control === 'duplicate-native-owner') f.items.push(structuredClone(value))
  if (control === 'foreign-rotated-font')
    f.items.push({ ...structuredClone(value), text: 'foreign', horizontal: false })
  if (control === 'measurement-crosses-gutter') value.rect[2] = 651
  if (control === 'uncalibrated-method-offset') {
    method.baseline += 1
    method.rect[1] += 1
    method.rect[3] += 1
  }
  if (control === 'wrapped-measurement') {
    value.baseline += 2
    value.rect[1] += 2
    value.rect[3] += 2
  }
  if (control === 'unsupported-script') script.text = 'x'
  if (control === 'script-without-parent') {
    script.rect[0] += 20
    script.rect[2] += 20
  }
  if (control === 'native-font-outside-original-crop') {
    const last = f.items.find(
      (i: ReturnType<typeof JSON.parse>) => i.rect[0] > 640 && i.baseline === 428.95799999999997
    )
    last.rect[2] = 759
  }
  const before = structuredClone(f),
    result = run(f)
  expect(result.repairs).not.toContain('native-fenced-paired-literal-records-recovered')
  expect(f).toEqual(before)
})

// Compose the accepted terminal projection and the independent middle source
// oracle from the same anonymous predecessor. No expected cell comes from the
// new proof: the common baselines and empty font gaps are native observations.
const middleOrdinarySourceOracle = (
  f: ReturnType<typeof fixture>
): ReturnType<typeof JSON.parse> => {
  const baseline = structuredClone(f.expectedBefore)
  let emitted = false
  baseline.cells = baseline.cells.flatMap((c: ReturnType<typeof JSON.parse>) => {
    if (c.row !== f.targetRow) return [c]
    if (emitted) return []
    emitted = true
    return structuredClone(f.expectedTargetCells)
  })
  baseline.grid = structuredClone(f.expectedGrid)
  const terminalRow = baseline.rows[f.targetRow],
    firstTerminal = f.expectedTargetCells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === f.targetRow
    ),
    lastTerminal = f.expectedTargetCells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === f.targetRow + 1
    )
  baseline.rows.splice(
    f.targetRow,
    1,
    {
      ...terminalRow,
      rect: [terminalRow.rect[0], firstTerminal.rect[1], terminalRow.rect[2], f.sourceSplit]
    },
    {
      ...terminalRow,
      rect: [terminalRow.rect[0], f.sourceSplit, terminalRow.rect[2], lastTerminal.rect[3]]
    }
  )
  baseline.repairs.push('native-terminal-ordinary-peer-records-recovered')
  const row = 9,
    donors = baseline.cells
      .filter((c: ReturnType<typeof JSON.parse>) => c.row === row)
      .toSorted(
        (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) => a.column - b.column
      ),
    baselines = [
      ...new Set<number>(
        donors[0].sourceTokens.map((t: ReturnType<typeof JSON.parse>) => t.baseline)
      )
    ]
      .filter((y) =>
        donors.every((c: ReturnType<typeof JSON.parse>) =>
          c.sourceTokens.some((t: ReturnType<typeof JSON.parse>) => Math.abs(t.baseline - y) < 0.02)
        )
      )
      .sort((a, b) => a - b),
    ordinary = baselines.map((y) =>
      donors.map((c: ReturnType<typeof JSON.parse>) =>
        c.sourceTokens.filter((t: ReturnType<typeof JSON.parse>) => Math.abs(t.baseline - y) < 0.02)
      )
    ),
    selected = ordinary.flat(2),
    residual = donors.map((c: ReturnType<typeof JSON.parse>) =>
      c.sourceTokens.filter((t: ReturnType<typeof JSON.parse>) => !selected.includes(t))
    ),
    bounds = (fields: ReturnType<typeof JSON.parse>[]): number[] => [
      Math.min(...fields.flat().map((t) => t.rect[1])),
      Math.max(...fields.flat().map((t) => t.rect[3]))
    ],
    bands = ordinary.map(bounds),
    tail = bounds(residual),
    edges = [
      bands[0][0],
      ...bands.slice(1).map((b, n) => (bands[n][1] + b[0]) / 2),
      (bands.at(-1)![1] + tail[0]) / 2,
      Math.max(...donors.map((c: ReturnType<typeof JSON.parse>) => c.rect[3]))
    ],
    texts = [
      ['Sampling, Å per pixel', '1.07', '1.0', '1.04', '1.07', '1.07'],
      ['Defocus range (μm)', ...Array(5).fill('-1.2 av -2.0')],
      ['Symmetry', ...Array(5).fill('J1')],
      [
        'Resolution (Å) (FSC=0.143 criterion) Model refinement',
        '4.18',
        '3.91',
        '4.05',
        '3.69',
        '4.62'
      ]
    ],
    fields = [...ordinary, residual],
    replacements = fields.flatMap((fs, n) =>
      fs.map((sourceTokens: ReturnType<typeof JSON.parse>[], column: number) => ({
        ...donors[column],
        row: row + n,
        rect: [donors[column].rect[0], edges[n], donors[column].rect[2], edges[n + 1]],
        text: texts[n][column],
        sourceTokens,
        sourceRects: sourceTokens.map((t) => t.rect)
      }))
    ),
    expected = structuredClone(baseline)
  expect(baselines).toHaveLength(3)
  expect(selected).toHaveLength(33)
  expect(residual.flat()).toHaveLength(8)
  emitted = false
  expected.cells = baseline.cells.flatMap((c: ReturnType<typeof JSON.parse>) => {
    if (c.row !== row) return [{ ...c, row: c.row > row ? c.row + ordinary.length : c.row }]
    if (emitted) return []
    emitted = true
    return replacements
  })
  expected.rows.splice(
    row,
    1,
    ...fields.map((_, n) => ({
      ...baseline.rows[row],
      rect: [baseline.rows[row].rect[0], edges[n], baseline.rows[row].rect[2], edges[n + 1]]
    }))
  )
  expected.grid.splice(row, 1, ...texts)
  return { baseline, expected, row, ordinary, residual, edges }
}

it('restores complete middle ordinary bands while retaining the whole residual and all correct peers', () => {
  const f = fixture('terminal-complete-ordinary-peer-records'),
    before = structuredClone(f),
    oracle = middleOrdinarySourceOracle(f),
    result = literalOutput(f)
  expect(result).toEqual(oracle.expected)
  expect(result.cells).toHaveLength(163)
  expect(result.grid).toHaveLength(28)
  for (const cell of oracle.baseline.cells.filter(
    (c: ReturnType<typeof JSON.parse>) => c.row !== oracle.row
  ))
    expect(
      result.cells.find(
        (c: ReturnType<typeof JSON.parse>) =>
          c.row === (cell.row > oracle.row ? cell.row + 3 : cell.row) && c.column === cell.column
      )
    ).toEqual({ ...cell, row: cell.row > oracle.row ? cell.row + 3 : cell.row })
  expect(
    result.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(
    oracle.baseline.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  )
  expect(f).toEqual(before)
})

const middleOracleSerializer = (
  oracle: ReturnType<typeof JSON.parse>
): ((field: ReturnType<typeof JSON.parse>[]) => string) => {
  const fields = [...oracle.baseline.cells, ...oracle.expected.cells],
    signature = (tokens: ReturnType<typeof JSON.parse>[]): string =>
      tokens.map(literalNativeSignature).sort().join('|')
  return (tokens) =>
    tokens.length === 1
      ? tokens[0].text
      : (fields.find(
          (c: ReturnType<typeof JSON.parse>) => signature(c.sourceTokens) === signature(tokens)
        )?.text ?? tokens.map((t) => t.text).join(' '))
}

it('requires the existing serializer at the middle-record proof seam and keeps source inputs immutable', async () => {
  const f = fixture('terminal-complete-ordinary-peer-records'),
    oracle = middleOrdinarySourceOracle(f),
    { proveNativeMiddleOrdinaryPeerRecords } = await import(
      pathToFileURL(resolve('resources/literature-pdf-native-leaf-record-repair.mjs')).href
    ),
    before = structuredClone({ table: oracle.baseline, f }),
    serialize = middleOracleSerializer(oracle)
  const proof = proveNativeMiddleOrdinaryPeerRecords(
    oracle.baseline,
    f.items,
    f.captions,
    f.rules,
    f.runs,
    serialize
  )
  expect(proof.groups).toEqual(oracle.ordinary)
  expect(proof.residual).toEqual(oracle.residual)
  expect(proof.edges).toEqual(oracle.edges)
  expect(
    proveNativeMiddleOrdinaryPeerRecords(oracle.baseline, f.items, f.captions, f.rules, f.runs)
  ).toBeUndefined()
  expect({ table: oracle.baseline, f }).toEqual(before)
})

it.each([
  'reading-rotation',
  'crossing-existing-rowspan',
  'previous-wrapped-font',
  'foreign-full-font',
  'nonhorizontal-full-font',
  'ambiguous-donor',
  'missing-header',
  'stale-header',
  'duplicate-source-rect',
  'missing-source-rect',
  'missing-owner',
  'duplicate-native-owner',
  'wrong-observed-baseline',
  'competing-observed-program',
  'missing-closing',
  'competing-title',
  'unknown-rich-script',
  'fence-across-prefix',
  'whole-font-crosses-leaf',
  'same-centroid-expanded-font',
  'donor-top-outside-crop',
  'donor-bottom-outside-crop',
  'missing-independent-peers',
  'whole-header-crosses-leaf',
  'whole-peer-crosses-own-leaf'
])(
  'refuses middle projection when independent record ownership fails: %s',
  async (control: string) => {
    const f = fixture('terminal-complete-ordinary-peer-records'),
      oracle = middleOrdinarySourceOracle(f),
      table = structuredClone(oracle.baseline),
      serialize = middleOracleSerializer(oracle),
      { proveNativeMiddleOrdinaryPeerRecords } = await import(
        pathToFileURL(resolve('resources/literature-pdf-native-leaf-record-repair.mjs')).href
      ),
      donor = table.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === oracle.row && c.column === 1
      ),
      token = donor.sourceTokens[0],
      source = f.items.find(
        (i: ReturnType<typeof JSON.parse>) =>
          literalNativeSignature(i) === literalNativeSignature(token)
      ),
      program = f.runs.find(
        (i: ReturnType<typeof JSON.parse>) =>
          literalNativeSignature(i) === literalNativeSignature(token)
      ),
      syncRect = (rect: number[]): void => {
        token.rect = [...rect]
        source.rect = [...rect]
        program.rect = [...rect]
        donor.sourceRects[0] = [...rect]
      }
    if (control === 'reading-rotation') table.readingRotation = 90
    if (control === 'crossing-existing-rowspan')
      table.cells.find(
        (c: ReturnType<typeof JSON.parse>) => c.row === 8 && c.column === 0
      ).rowSpan = 2
    if (control === 'previous-wrapped-font')
      table.cells
        .find((c: ReturnType<typeof JSON.parse>) => c.row === 8 && c.column === 0)
        .sourceTokens.at(-1).rect[3] = oracle.edges[0] + 1
    if (control === 'foreign-full-font' || control === 'nonhorizontal-full-font')
      f.items.push({
        text: 'x',
        rect: [200, 460, 205, 470],
        baseline: 470,
        height: 10,
        horizontal: control !== 'nonhorizontal-full-font'
      })
    if (control === 'ambiguous-donor') table.cells.push(structuredClone(donor))
    if (control === 'missing-header')
      table.cells.splice(
        table.cells.findIndex((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 2),
        1
      )
    if (control === 'stale-header')
      table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 2).text +=
        ' changed'
    if (control === 'duplicate-source-rect') donor.sourceRects[1] = [...donor.sourceRects[0]]
    if (control === 'missing-source-rect') donor.sourceRects.pop()
    if (control === 'missing-owner') donor.sourceTokens.pop()
    if (control === 'duplicate-native-owner') f.items.push(structuredClone(source))
    if (control === 'wrong-observed-baseline') program.baseline += 1
    if (control === 'competing-observed-program')
      f.runs.push({ ...structuredClone(program), baseline: program.baseline + 1 })
    if (control === 'missing-closing') f.rules = f.rules.filter((r: number[]) => r[1] < 820)
    if (control === 'competing-title') f.captions.push(structuredClone(f.captions[0]))
    if (control === 'unknown-rich-script') donor.textRuns = [{ text: '2', position: 'superscript' }]
    if (control === 'fence-across-prefix') f.rules.push([107, 480, 786, 480])
    if (control === 'whole-font-crosses-leaf') syncRect([donor.rect[0] - 1, ...token.rect.slice(1)])
    if (control === 'same-centroid-expanded-font') {
      const width = (token.rect[0] + token.rect[2]) / 2 - donor.rect[0] + 1
      const center = (token.rect[0] + token.rect[2]) / 2
      syncRect([center - width, token.rect[1], center + width, token.rect[3]])
    }
    if (control === 'donor-top-outside-crop') donor.rect[1] = table.cropRect[1] - 1
    if (control === 'donor-bottom-outside-crop') donor.rect[3] = table.cropRect[3] + 1
    if (control === 'missing-independent-peers')
      for (const cell of table.cells)
        if (cell.row !== oracle.row && cell.row > 0) cell.text += ' changed'
    if (control === 'whole-header-crosses-leaf' || control === 'whole-peer-crosses-own-leaf') {
      const cell = table.cells.find(
          (c: ReturnType<typeof JSON.parse>) =>
            c.row === (control === 'whole-header-crosses-leaf' ? 0 : 1) && c.column === 0
        ),
        font = cell.sourceTokens[0],
        oldSignature = literalNativeSignature(font),
        raw = f.items.find(
          (i: ReturnType<typeof JSON.parse>) => literalNativeSignature(i) === oldSignature
        ),
        observed = f.runs.find(
          (i: ReturnType<typeof JSON.parse>) => literalNativeSignature(i) === oldSignature
        ),
        rect = [...font.rect]
      if (control === 'whole-header-crosses-leaf') rect[2] = cell.rect[2] + 20
      else rect[0] = cell.rect[0] - 20
      font.rect = [...rect]
      raw.rect = [...rect]
      observed.rect = [...rect]
      cell.sourceRects[0] = [...rect]
    }
    const before = structuredClone({ table, f })
    expect(
      proveNativeMiddleOrdinaryPeerRecords(table, f.items, f.captions, f.rules, f.runs, serialize)
    ).toBeUndefined()
    expect({ table, f }).toEqual(before)
  }
)

it.each([
  'missing-title',
  'missing-closing',
  'competing-program',
  'foreign-font',
  'fence-across-records'
])(
  'keeps middle bands held in the actual consumer when source qualification fails: %s',
  (control: string) => {
    const f = fixture('terminal-complete-ordinary-peer-records'),
      oracle = middleOrdinarySourceOracle(f)
    if (control === 'missing-title') f.captions = []
    if (control === 'missing-closing') f.rules = f.rules.filter((r: number[]) => r[1] < 820)
    if (control === 'competing-program')
      f.runs.push(
        structuredClone(
          f.runs.find(
            (r: ReturnType<typeof JSON.parse>) =>
              r.text === '1.0' && Math.abs(r.baseline - 471) < 0.02
          )
        )
      )
    if (control === 'foreign-font')
      f.items.push({
        text: 'x',
        rect: [200, 460, 205, 470],
        height: 10,
        baseline: 470,
        horizontal: false
      })
    if (control === 'fence-across-records') f.rules.push([107, 480, 786, 480])
    const before = structuredClone(f),
      result = literalOutput(f)
    expect(result.grid).not.toEqual(oracle.expected.grid)
    // Earlier source recovery may still own an isolated band without the final
    // closing edge. The complete donor projection remains inadmissible.
    if (control !== 'missing-closing')
      expect(result.grid).not.toContainEqual(oracle.expected.grid[9])
    expect(f).toEqual(before)
  }
)

it('restores only the terminal complete ordinary peer records and preserves every earlier whole cell', () => {
  const f = fixture('terminal-complete-ordinary-peer-records'),
    before = structuredClone(f),
    result = literalOutput(f),
    oracle = middleOrdinarySourceOracle(f)
  expect(result).toEqual(oracle.expected)
  for (const cell of oracle.baseline.cells.filter(
    (c: ReturnType<typeof JSON.parse>) => c.row !== oracle.row
  ))
    expect(
      result.cells.find(
        (c: { row: number; column: number }) =>
          c.row === (cell.row > oracle.row ? cell.row + 3 : cell.row) && c.column === cell.column
      )
    ).toEqual({ ...cell, row: cell.row > oracle.row ? cell.row + 3 : cell.row })
  expect(result.cells.filter((c: { row: number }) => c.row >= f.targetRow + 3)).toEqual(
    f.expectedTargetCells.map((c: ReturnType<typeof JSON.parse>) => ({ ...c, row: c.row + 3 }))
  )
  for (const key of [
    'cropRect',
    'unassigned',
    'clipped',
    'excludedCaptionItems',
    'issues',
    'reviewCandidate',
    'selectedTextItems'
  ])
    expect(result[key]).toEqual(f.expectedBefore[key])
  expect(result.rows).toEqual(oracle.expected.rows)
  expect(result.repairs).toEqual([
    ...f.expectedBefore.repairs,
    'native-terminal-ordinary-peer-records-recovered'
  ])
  expect(
    result.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  ).toEqual(
    f.expectedBefore.cells
      .flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
      .map(literalNativeSignature)
      .sort()
  )
  expect(f).toEqual(before)
})

it.each([
  'missing-title',
  'duplicate-title',
  'missing-closing',
  'competing-closing',
  'missing-field',
  'duplicate-source',
  'competing-program',
  'wrong-program-baseline',
  'nonhorizontal-foreign-font',
  'body-font-crosses-cut',
  'wrapped-literal-face'
])('refuses terminal peer records without complete independent source evidence: %s', (control) => {
  const f = fixture('terminal-complete-ordinary-peer-records'),
    token = f.sourceBands[1][2],
    source = f.items.find(
      (i: ReturnType<typeof JSON.parse>) =>
        literalNativeSignature(i) === literalNativeSignature(token)
    ),
    measured = f.runs.find(
      (i: ReturnType<typeof JSON.parse>) =>
        literalNativeSignature(i) === literalNativeSignature(token)
    ),
    closing = Math.max(...f.rules.map((r: number[]) => r[1]))
  if (control === 'missing-title') f.captions = []
  if (control === 'duplicate-title') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'missing-closing') f.rules = f.rules.filter((r: number[]) => r[1] !== closing)
  if (control === 'competing-closing')
    f.rules.push(
      ...f.rules
        .filter((r: number[]) => r[1] === closing)
        .map((r: number[]) => [r[0], r[1] + 1, r[2], r[3] + 1])
    )
  if (control === 'missing-field') {
    f.items = f.items.filter((i: ReturnType<typeof JSON.parse>) => i !== source)
    f.runs = f.runs.filter((i: ReturnType<typeof JSON.parse>) => i !== measured)
  }
  if (control === 'duplicate-source') f.items.push(structuredClone(source))
  if (control === 'competing-program')
    f.runs.push({ ...structuredClone(measured), baseline: measured.baseline + 1 })
  if (control === 'wrong-program-baseline') measured.baseline += 1
  if (control === 'nonhorizontal-foreign-font')
    f.items.push({
      ...structuredClone(source),
      text: 'x',
      horizontal: false,
      rect: [source.rect[0], f.sourceSplit - 0.5, source.rect[0] + 1, f.sourceSplit + 0.5],
      height: 1,
      baseline: f.sourceSplit + 0.5
    })
  if (control === 'body-font-crosses-cut') {
    source.rect[0] = f.originalTargetCells[2].rect[0] - 1
    measured.rect = [...source.rect]
  }
  if (control === 'wrapped-literal-face') {
    source.text = 'continued literal'
    measured.text = source.text
    measured.literalGlyphs = [...source.text]
  }
  const before = structuredClone(f),
    result = literalOutput(f)
  expect(result.repairs).not.toContain('native-terminal-ordinary-peer-records-recovered')
  expect(f).toEqual(before)
})

it.each([
  'duplicate-owner-rect',
  'missing-owner-rect',
  'stale-owner-text',
  'rich-owner',
  'invalid-row',
  'donor-top-outside-crop',
  'donor-bottom-outside-crop',
  'missing-calibration',
  'malformed-observed-box'
])('rejects malformed final terminal owners without altering source data: %s', async (control) => {
  const f = fixture('terminal-complete-ordinary-peer-records'),
    table = structuredClone(f.expectedBefore),
    { proveNativeTerminalOrdinaryPeerRecords } = await import(
      pathToFileURL(resolve('resources/literature-pdf-native-leaf-record-repair.mjs')).href
    ),
    donor = table.cells.find(
      (c: { row: number; column: number }) => c.row === f.targetRow && c.column === 2
    )
  if (control === 'duplicate-owner-rect') donor.sourceRects[1] = [...donor.sourceRects[0]]
  if (control === 'missing-owner-rect') donor.sourceRects.pop()
  if (control === 'stale-owner-text') donor.text += ' changed'
  if (control === 'rich-owner') donor.textRuns = [{ text: donor.text, position: 'superscript' }]
  if (control === 'invalid-row') table.rows[f.targetRow].rect[2] = Number.NaN
  if (control === 'donor-top-outside-crop') donor.rect[1] = table.cropRect[1] - 1
  if (control === 'donor-bottom-outside-crop') donor.rect[3] = table.cropRect[3] + 1
  if (control === 'missing-calibration')
    for (const cell of table.cells)
      if (cell.row > 0 && cell.row < f.targetRow) cell.text += ' changed'
  if (control === 'malformed-observed-box')
    f.runs.find(
      (r: ReturnType<typeof JSON.parse>) =>
        literalNativeSignature(r) === literalNativeSignature(donor.sourceTokens[0])
    ).rect = undefined
  const before = structuredClone(table)
  expect(
    proveNativeTerminalOrdinaryPeerRecords(table, f.items, f.captions, f.rules, f.runs)
  ).toBeUndefined()
  expect(table).toEqual(before)
})

it('counts redundant painted terminal edges once and preserves the complete literal projection', () => {
  const f = fixture('terminal-complete-ordinary-peer-records'),
    closing = Math.max(...f.rules.map((r: number[]) => r[1]))
  f.rules.push(
    ...f.rules
      .filter((r: number[]) => r[1] === closing)
      .map((r: number[]) => [r[0], r[1], r[2] - 3, r[3]])
  )
  const result = literalOutput(f)
  expect(result).toEqual(middleOrdinarySourceOracle(f).expected)
})

it('preserves fenced-pair fields under translated and reversed native evidence', () => {
  const f = closedNativePairedRecords(),
    original = run(f),
    dx = 19,
    dy = 37
  f.table.cropRect = f.table.cropRect.map((v: number, n: number) => v + (n % 2 ? dy : dx))
  for (const item of f.items) {
    item.rect = item.rect.map((v: number, n: number) => v + (n % 2 ? dy : dx))
    item.baseline += dy
  }
  f.items.reverse()
  f.rules = f.rules
    .map((r: number[]) => r.map((v: number, n: number) => v + (n % 2 ? dy : dx)))
    .reverse()
  f.captions = f.captions.map((c: ReturnType<typeof JSON.parse>) => ({
    ...c,
    rect: c.rect.map((v: number, n: number) => v + (n % 2 ? dy : dx))
  }))
  const before = structuredClone(f),
    result = run(f)
  expect(result.grid).toEqual(original.grid)
  expect(
    result.cells.map((c: ReturnType<typeof JSON.parse>) => [
      c.row,
      c.column,
      c.rowSpan,
      c.colSpan,
      c.text,
      c.textRuns
    ])
  ).toEqual(
    original.cells.map((c: ReturnType<typeof JSON.parse>) => [
      c.row,
      c.column,
      c.rowSpan,
      c.colSpan,
      c.text,
      c.textRuns
    ])
  )
  expect(
    Object.hasOwn(
      result.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 1),
      'textRuns'
    )
  ).toBe(false)
  expect(f).toEqual(before)
})

// One complete closed source family: a two-field parent, two lower children,
// four spanning peers and four independent binary/scalar body records.
const anonymousPairedNativeHeader = (): ReturnType<typeof JSON.parse> => {
  const fontSpecs: ReturnType<typeof JSON.parse>[] = [
    [
      'Table 1:',
      [-38.46350000000001, 33.9461, 10.167238257999998, 48.889999999999986],
      14.9439,
      48.889999999999986,
      false
    ],
    [
      'Finite',
      [14.785799992000022, 33.9461, 382.6255647610001, 48.889999999999986],
      14.9439,
      48.889999999999986,
      false
    ],
    [
      'Finite',
      [387.2592198340001, 33.9461, 556.0027498540002, 48.889999999999986],
      14.9439,
      48.889999999999986,
      false
    ],
    [
      'Finite',
      [-38, 50.309600000000046, 555.9955170039998, 65.25350000000003],
      14.9439,
      65.25350000000003,
      false
    ],
    [
      'Finite',
      [-38, 66.67309999999998, 164.56456449999996, 81.61699999999996],
      14.9439,
      81.61699999999996,
      false
    ],
    [
      'Source Settings',
      [44.63499999999999, 99.3854, 158.31101920000003, 112.83500000000004],
      13.4496,
      112.83500000000004,
      false
    ],
    [
      '|',
      [29.26599999999999, 114.32839999999999, 33.10586079999999, 127.77800000000002],
      13.4496,
      127.77800000000002,
      false
    ],
    [
      'ζ',
      [33.10586079999999, 114.32839999999999, 41.16889599999999, 127.77800000000002],
      13.4496,
      127.77800000000002,
      false
    ],
    [
      'key',
      [41.170000000000016, 120.30709999999999, 56.73656704000001, 129.2735],
      8.9664,
      129.2735,
      false
    ],
    [
      '−',
      [60.55450000000002, 114.32839999999999, 71.30611024000001, 127.77800000000002],
      13.4496,
      127.77800000000002,
      false
    ],
    [
      '321',
      [74.37261904000002, 114.32839999999999, 95.10786736, 127.77800000000002],
      13.4496,
      127.77800000000002,
      false
    ],
    [
      '|',
      [95.10786736, 114.32839999999999, 98.94772816, 127.77800000000002],
      13.4496,
      127.77800000000002,
      false
    ],
    [
      'Quality',
      [112.39732815999997, 114.32839999999999, 173.67370575999996, 127.77800000000002],
      13.4496,
      127.77800000000002,
      false
    ],
    [
      '|',
      [186.2305, 107.23040000000003, 190.0703608, 120.68000000000006],
      13.4496,
      120.68000000000006,
      false
    ],
    [
      'ζ',
      [190.0703608, 107.23040000000003, 198.133396, 120.68000000000006],
      13.4496,
      120.68000000000006,
      false
    ],
    [
      'key',
      [198.13300000000004, 113.20759999999996, 213.69956704000003, 122.17399999999998],
      8.9664,
      122.17399999999998,
      false
    ],
    [
      '−',
      [217.519, 107.23040000000003, 228.27061024, 120.68000000000006],
      13.4496,
      120.68000000000006,
      false
    ],
    [
      '321',
      [231.33711904000006, 107.23040000000003, 252.07236736000004, 120.68000000000006],
      13.4496,
      120.68000000000006,
      false
    ],
    [
      '|',
      [252.07236736000004, 107.23040000000003, 255.91222816000004, 120.68000000000006],
      13.4496,
      120.68000000000006,
      false
    ],
    [
      '(',
      [259.27462816, 107.23040000000003, 263.75334496000005, 120.68000000000006],
      13.4496,
      120.68000000000006,
      false
    ],
    [
      '↓',
      [263.75334496000005, 107.23040000000003, 270.66509440000004, 120.68000000000006],
      13.4496,
      120.68000000000006,
      false
    ],
    [
      ')',
      [270.66509440000004, 107.23040000000003, 275.1438112000001, 120.68000000000006],
      13.4496,
      120.68000000000006,
      false
    ],
    [
      'Quality',
      [287.1005056, 107.23040000000003, 348.37688320000007, 120.68000000000006],
      13.4496,
      120.68000000000006,
      false
    ],
    [
      'Extent',
      [360.3335775999998, 107.23040000000003, 401.43555519999984, 120.68000000000006],
      13.4496,
      120.68000000000006,
      false
    ],
    [
      'Validity Level',
      [413.3922495999998, 107.23040000000003, 488.7369087999998, 120.68000000000006],
      13.4496,
      120.68000000000006,
      false
    ],
    [
      '✓',
      [56.6395, 142.31089999999995, 67.84705167999999, 155.76049999999998],
      13.4496,
      155.76049999999998,
      false
    ],
    [
      '✓',
      [135.09505167999998, 142.31089999999995, 146.30260335999998, 155.76049999999998],
      13.4496,
      155.76049999999998,
      false
    ],
    [
      '1.2500',
      [212.19550000000004, 142.31089999999995, 249.18190000000004, 155.76049999999998],
      13.4496,
      155.76049999999998,
      false
    ],
    [
      '2.5000',
      [295.87891120000006, 142.31089999999995, 339.5901112, 155.76049999999998],
      13.4496,
      155.76049999999998,
      false
    ],
    [
      '17',
      [370.79318320000016, 142.31089999999995, 390.96758320000015, 155.76049999999998],
      13.4496,
      155.76049999999998,
      false
    ],
    [
      '0.8',
      [442.65439600000025, 142.31089999999995, 459.46639600000026, 155.76049999999998],
      13.4496,
      155.76049999999998,
      false
    ],
    [
      '✓',
      [56.86900000000003, 164.7269, 68.07655168000002, 178.17650000000003],
      13.4496,
      178.17650000000003,
      false
    ],
    [
      '×',
      [135.32455168000007, 164.7269, 146.07616192000006, 178.17650000000003],
      13.4496,
      178.17650000000003,
      false
    ],
    [
      '3.7500',
      [212.19550000000004, 164.7269, 249.18190000000004, 178.17650000000003],
      13.4496,
      178.17650000000003,
      false
    ],
    [
      '4.5000',
      [295.87891120000006, 164.7269, 339.5901112, 178.17650000000003],
      13.4496,
      178.17650000000003,
      false
    ],
    [
      '18',
      [370.79318320000016, 164.7269, 390.96758320000015, 178.17650000000003],
      13.4496,
      178.17650000000003,
      false
    ],
    [
      '0.8',
      [442.65439600000025, 164.7269, 459.46639600000026, 178.17650000000003],
      13.4496,
      178.17650000000003,
      false
    ],
    [
      '×',
      [56.86900000000003, 187.14289999999994, 67.62061024000002, 200.59249999999997],
      13.4496,
      200.59249999999997,
      false
    ],
    [
      '✓',
      [134.86861024000007, 187.14289999999994, 146.07616192000006, 200.59249999999997],
      13.4496,
      200.59249999999997,
      false
    ],
    [
      '5.2500',
      [208.83399999999995, 187.14289999999994, 252.54519999999997, 200.59249999999997],
      13.4496,
      200.59249999999997,
      false
    ],
    [
      '6.5000',
      [295.8798112000001, 187.14289999999994, 339.59101120000014, 200.59249999999997],
      13.4496,
      200.59249999999997,
      false
    ],
    [
      '19',
      [370.7940832000003, 187.14289999999994, 390.96848320000026, 200.59249999999997],
      13.4496,
      200.59249999999997,
      false
    ],
    [
      '0.8',
      [442.65529600000025, 187.14289999999994, 459.46729600000026, 200.59249999999997],
      13.4496,
      200.59249999999997,
      false
    ],
    [
      '×',
      [57.09699999999998, 209.5589, 67.84861023999997, 223.00850000000003],
      13.4496,
      223.00850000000003,
      false
    ],
    [
      '×',
      [135.0966102399999, 209.5589, 145.8482204799999, 223.00850000000003],
      13.4496,
      223.00850000000003,
      false
    ],
    [
      '7.7500',
      [208.83399999999995, 209.5589, 252.54519999999997, 223.00850000000003],
      13.4496,
      223.00850000000003,
      false
    ],
    [
      '8.5000',
      [295.8798112000001, 209.5589, 339.59101120000014, 223.00850000000003],
      13.4496,
      223.00850000000003,
      false
    ],
    [
      '20',
      [370.7940832000003, 209.5589, 390.96848320000026, 223.00850000000003],
      13.4496,
      223.00850000000003,
      false
    ],
    [
      '0.8',
      [442.65529600000025, 209.5589, 459.46729600000026, 223.00850000000003],
      13.4496,
      223.00850000000003,
      false
    ]
  ]
  const items: ReturnType<typeof JSON.parse>[] = fontSpecs.map(
    ([text, rect, height, baseline, inlineSymbol]) => ({
      text,
      rect,
      height,
      baseline,
      inlineSymbol,
      horizontal: true
    })
  )
  const runs = items.map((font, index) => ({
    ...structuredClone(font),
    gaps: [],
    literalGlyphs: [...font.text.replace(/\s/gu, '')],
    glyphRuns: [...font.text.replace(/\s/gu, '')].map(() => index + 1)
  }))
  const table = {
    id: 'anonymous-paired-header',
    readingRotation: 0,
    cropRect: [24, 94, 499, 239],
    detection: {
      label: 'table',
      score: 1,
      rect: [34.8910807967186, 104.23617047071457, 488.6340294480324, 228.5508001446724]
    },
    structure: {
      objects: [
        {
          label: 'table row',
          score: 0.9989773106296586,
          rect: [33.987388014793396, 90.01606531441212, 435.44796109199524, 112.82115511596203]
        },
        {
          label: 'table column',
          score: 0.9931392322151178,
          rect: [255.76187558472157, 28.34991365671158, 330.2892994135618, 130.6369051337242]
        },
        {
          label: 'table row',
          score: 0.8804342836136712,
          rect: [33.79783779382706, 58.80984529852867, 435.71214228868484, 81.58663466572762]
        },
        {
          label: 'table column',
          score: 0.9835908939200495,
          rect: [33.27999338507652, 30.755670964717865, 80.92572763562202, 130.2914920449257]
        },
        {
          label: 'table row',
          score: 0.9509391830459512,
          rect: [33.94094184041023, 69.95681554079056, 435.51071509718895, 91.92972391843796]
        },
        {
          label: 'table column',
          score: 0.98211310928454,
          rect: [330.4051388055086, 29.543436616659164, 385.49481742084026, 130.46057298779488]
        },
        {
          label: 'table column',
          score: 0.9836082678033183,
          rect: [157.342778891325, 29.292928725481033, 256.4115487039089, 130.55665358901024]
        },
        {
          label: 'table column',
          score: 0.9850968423903429,
          rect: [386.28297969698906, 30.647278875112534, 436.0665686428547, 130.31537607312202]
        },
        {
          label: 'table row',
          score: 0.9971552437031591,
          rect: [34.00572016835213, 112.79508233070374, 435.4308746755123, 130.87486386299133]
        },
        {
          label: 'table column',
          score: 0.9898752527918663,
          rect: [81.68237842619419, 29.39288556575775, 158.81591252982616, 130.4154884815216]
        },
        {
          label: 'table row',
          score: 0.697165629531378,
          rect: [32.722823321819305, 23.447177782654762, 437.5235006213188, 39.52183745801449]
        },
        {
          label: 'table',
          score: 0.9956844183921144,
          rect: [33.83086398243904, 30.182687640190125, 436.004451662302, 130.44423401355743]
        }
      ]
    },
    rowCount: 5,
    columnCount: 6,
    spans: []
  }
  const captions = [
    {
      lines: ['Table 1: Finite Finite', 'Finite', 'Finite'],
      rect: [-38.46350000000001, 33.9461, 556.0027498540003, 81.61699999999996]
    }
  ]
  const rules = [
    [23.2885, 97.40449999999998, 494.7115194091797, 97.40449999999998],
    [179.9545, 102.37400114440925, 179.9545, 132.26150000000007],
    [23.2885, 135.32600000000002, 494.7115194091797, 135.32600000000002],
    [179.9545, 140.07049963378904, 179.9545, 162.48649999999998],
    [179.9545, 162.4864996337891, 179.9545, 184.90250000000003],
    [179.9545, 184.90249963378903, 179.9545, 207.31849999999997],
    [179.9545, 207.316999633789, 179.9545, 229.73299999999995],
    [23.2885, 233.02099999999996, 494.7115194091797, 233.02099999999996]
  ]
  const expected: ReturnType<typeof JSON.parse>[] = [
    [0, 0, 1, 2, 'Source Settings', null, [5]],
    [
      1,
      0,
      1,
      1,
      '|ζkey − 321|',
      [
        { text: '|ζ', position: 'normal' },
        { text: 'key', position: 'subscript' },
        { text: ' − 321|', position: 'normal' }
      ],
      [6, 7, 8, 9, 10, 11]
    ],
    [1, 1, 1, 1, 'Quality', null, [12]],
    [
      0,
      2,
      2,
      1,
      '|ζkey − 321| (↓)',
      [
        { text: '|ζ', position: 'normal' },
        { text: 'key', position: 'subscript' },
        { text: ' − 321| (↓)', position: 'normal' }
      ],
      [13, 14, 15, 16, 17, 18, 19, 20, 21]
    ],
    [0, 3, 2, 1, 'Quality', null, [22]],
    [0, 4, 2, 1, 'Extent', null, [23]],
    [0, 5, 2, 1, 'Validity Level', null, [24]],
    [2, 0, 1, 1, '✓', null, [25]],
    [2, 1, 1, 1, '✓', null, [26]],
    [2, 2, 1, 1, '1.2500', null, [27]],
    [2, 3, 1, 1, '2.5000', null, [28]],
    [2, 4, 1, 1, '17', null, [29]],
    [2, 5, 1, 1, '0.8', null, [30]],
    [3, 0, 1, 1, '✓', null, [31]],
    [3, 1, 1, 1, '×', null, [32]],
    [3, 2, 1, 1, '3.7500', null, [33]],
    [3, 3, 1, 1, '4.5000', null, [34]],
    [3, 4, 1, 1, '18', null, [35]],
    [3, 5, 1, 1, '0.8', null, [36]],
    [4, 0, 1, 1, '×', null, [37]],
    [4, 1, 1, 1, '✓', null, [38]],
    [4, 2, 1, 1, '5.2500', null, [39]],
    [4, 3, 1, 1, '6.5000', null, [40]],
    [4, 4, 1, 1, '19', null, [41]],
    [4, 5, 1, 1, '0.8', null, [42]],
    [5, 0, 1, 1, '×', null, [43]],
    [5, 1, 1, 1, '×', null, [44]],
    [5, 2, 1, 1, '7.7500', null, [45]],
    [5, 3, 1, 1, '8.5000', null, [46]],
    [5, 4, 1, 1, '20', null, [47]],
    [5, 5, 1, 1, '0.8', null, [48]]
  ]
  const partialSpecs: ReturnType<typeof JSON.parse>[] = [
    [
      0,
      0,
      1,
      1,
      [24, 117.44717778265476, 105.30405303090811, 133.5218374580145],
      'model-grid',
      '|ζkey − 321|',
      [
        { text: '|ζ', position: 'normal' },
        { text: 'key', position: 'subscript' },
        { text: ' − 321|', position: 'normal' }
      ],
      [6, 7, 8, 9, 10, 11]
    ],
    [
      0,
      1,
      1,
      1,
      [105.30405303090811, 117.44717778265476, 182.07934571057558, 133.5218374580145],
      'model-grid',
      'Quality',
      null,
      [12]
    ],
    [
      0,
      2,
      1,
      1,
      [182.07934571057558, 117.44717778265476, 280.08671214431524, 133.5218374580145],
      'model-grid',
      'key',
      null,
      [15]
    ],
    [
      0,
      3,
      1,
      1,
      [280.08671214431524, 117.44717778265476, 354.3472191095352, 133.5218374580145],
      'model-grid',
      '',
      null,
      []
    ],
    [
      0,
      4,
      1,
      1,
      [354.3472191095352, 117.44717778265476, 409.88889855891466, 133.5218374580145],
      'model-grid',
      '',
      null,
      []
    ],
    [
      0,
      5,
      1,
      1,
      [409.88889855891466, 117.44717778265476, 499, 133.5218374580145],
      'model-grid',
      '',
      null,
      []
    ],
    [
      1,
      0,
      1,
      1,
      [24, 142.31089999999995, 105.30405303090811, 155.76049999999998],
      'model-grid',
      '✓',
      null,
      [25]
    ],
    [
      1,
      1,
      1,
      1,
      [105.30405303090811, 142.31089999999995, 182.07934571057558, 155.76049999999998],
      'model-grid',
      '✓',
      null,
      [26]
    ],
    [
      1,
      2,
      1,
      1,
      [182.07934571057558, 142.31089999999995, 280.08671214431524, 155.76049999999998],
      'model-grid',
      '1.2500',
      null,
      [27]
    ],
    [
      1,
      3,
      1,
      1,
      [280.08671214431524, 142.31089999999995, 354.3472191095352, 155.76049999999998],
      'model-grid',
      '2.5000',
      null,
      [28]
    ],
    [
      1,
      4,
      1,
      1,
      [354.3472191095352, 142.31089999999995, 409.88889855891466, 155.76049999999998],
      'model-grid',
      '17',
      null,
      [29]
    ],
    [
      1,
      5,
      1,
      1,
      [409.88889855891466, 142.31089999999995, 499, 155.76049999999998],
      'model-grid',
      '0.8',
      null,
      [30]
    ],
    [
      2,
      0,
      1,
      1,
      [24, 163.95681554079056, 105.30405303090811, 185.92972391843796],
      'model-grid',
      '✓',
      null,
      [31]
    ],
    [
      2,
      1,
      1,
      1,
      [105.30405303090811, 163.95681554079056, 182.07934571057558, 185.92972391843796],
      'model-grid',
      '×',
      null,
      [32]
    ],
    [
      2,
      2,
      1,
      1,
      [182.07934571057558, 163.95681554079056, 280.08671214431524, 185.92972391843796],
      'model-grid',
      '3.7500',
      null,
      [33]
    ],
    [
      2,
      3,
      1,
      1,
      [280.08671214431524, 163.95681554079056, 354.3472191095352, 185.92972391843796],
      'model-grid',
      '4.5000',
      null,
      [34]
    ],
    [
      2,
      4,
      1,
      1,
      [354.3472191095352, 163.95681554079056, 409.88889855891466, 185.92972391843796],
      'model-grid',
      '18',
      null,
      [35]
    ],
    [
      2,
      5,
      1,
      1,
      [409.88889855891466, 163.95681554079056, 499, 185.92972391843796],
      'model-grid',
      '0.8',
      null,
      [36]
    ],
    [
      3,
      0,
      1,
      1,
      [24, 184.01606531441212, 105.30405303090811, 206.82115511596203],
      'model-grid',
      '×',
      null,
      [37]
    ],
    [
      3,
      1,
      1,
      1,
      [105.30405303090811, 184.01606531441212, 182.07934571057558, 206.82115511596203],
      'model-grid',
      '✓',
      null,
      [38]
    ],
    [
      3,
      2,
      1,
      1,
      [182.07934571057558, 184.01606531441212, 280.08671214431524, 206.82115511596203],
      'model-grid',
      '5.2500',
      null,
      [39]
    ],
    [
      3,
      3,
      1,
      1,
      [280.08671214431524, 184.01606531441212, 354.3472191095352, 206.82115511596203],
      'model-grid',
      '6.5000',
      null,
      [40]
    ],
    [
      3,
      4,
      1,
      1,
      [354.3472191095352, 184.01606531441212, 409.88889855891466, 206.82115511596203],
      'model-grid',
      '19',
      null,
      [41]
    ],
    [
      3,
      5,
      1,
      1,
      [409.88889855891466, 184.01606531441212, 499, 206.82115511596203],
      'model-grid',
      '0.8',
      null,
      [42]
    ],
    [
      4,
      0,
      1,
      1,
      [24, 206.79508233070374, 105.30405303090811, 224.87486386299133],
      'model-grid',
      '×',
      null,
      [43]
    ],
    [
      4,
      1,
      1,
      1,
      [105.30405303090811, 206.79508233070374, 182.07934571057558, 224.87486386299133],
      'model-grid',
      '×',
      null,
      [44]
    ],
    [
      4,
      2,
      1,
      1,
      [182.07934571057558, 206.79508233070374, 280.08671214431524, 224.87486386299133],
      'model-grid',
      '7.7500',
      null,
      [45]
    ],
    [
      4,
      3,
      1,
      1,
      [280.08671214431524, 206.79508233070374, 354.3472191095352, 224.87486386299133],
      'model-grid',
      '8.5000',
      null,
      [46]
    ],
    [
      4,
      4,
      1,
      1,
      [354.3472191095352, 206.79508233070374, 409.88889855891466, 224.87486386299133],
      'model-grid',
      '20',
      null,
      [47]
    ],
    [
      4,
      5,
      1,
      1,
      [409.88889855891466, 206.79508233070374, 499, 224.87486386299133],
      'model-grid',
      '0.8',
      null,
      [48]
    ]
  ]
  const partial = {
    id: 'anonymous-paired-header',
    cropRect: [24, 94, 499, 239],
    grid: [
      ['|ζkey − 321|', 'Quality', 'key', '', '', ''],
      ['✓', '✓', '1.2500', '2.5000', '17', '0.8'],
      ['✓', '×', '3.7500', '4.5000', '18', '0.8'],
      ['×', '✓', '5.2500', '6.5000', '19', '0.8'],
      ['×', '×', '7.7500', '8.5000', '20', '0.8']
    ],
    rows: [
      {
        rect: [56.722823321819305, 117.44717778265476, 461.5235006213188, 133.5218374580145],
        origin: 'model'
      },
      { rect: [24, 142.31089999999995, 499, 155.76049999999998], origin: 'source-text' },
      {
        rect: [57.94094184041023, 163.95681554079056, 459.51071509718895, 185.92972391843796],
        origin: 'model'
      },
      {
        rect: [57.987388014793396, 184.01606531441212, 459.44796109199524, 206.82115511596203],
        origin: 'model'
      },
      {
        rect: [58.00572016835213, 206.79508233070374, 459.4308746755123, 224.87486386299133],
        origin: 'model'
      }
    ],
    unassigned: [
      'Source Settings',
      '|',
      'ζ',
      '−',
      '321',
      '|',
      '(',
      '↓',
      ')',
      'Quality',
      'Extent',
      'Validity Level'
    ],
    clipped: [],
    excludedCaptionItems: ['Table 1:', 'Finite', 'Finite', 'Finite', 'Finite'],
    issues: ['unassigned-source-text'],
    repairs: ['duplicate-row-removed', 'text-supported-row-recovered'],
    reviewCandidate: false,
    selectedTextItems: 44
  } as ReturnType<typeof JSON.parse>
  partial.cells = partialSpecs.map(
    ([row, column, rowSpan, colSpan, rect, origin, text, textRuns, indices]) => {
      const sourceTokens: ReturnType<typeof JSON.parse>[] = indices.map((index: number) => {
        const { text, rect, baseline, height } = items[index]
        return { text, rect: [...rect], baseline, height }
      })
      return {
        row,
        column,
        rowSpan,
        colSpan,
        rect,
        origin,
        text,
        ...(textRuns ? { textRuns } : {}),
        sourceTokens,
        sourceRects: sourceTokens.map((token) => token.rect)
      }
    }
  )
  return { table, items, captions, rules, runs, expected, partial }
}

it('recovers the complete paired native header through the actual table consumer', () => {
  const f = anonymousPairedNativeHeader()
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs, undefined)
  expect(result.cells).toHaveLength(31)
  expect(result.grid).toHaveLength(6)
  expect(result.grid.every((row: string[]) => row.length === 6)).toBe(true)
  expect(result.cells.filter((cell: ReturnType<typeof JSON.parse>) => cell.row < 2)).toHaveLength(7)
  const assigned: number[] = []
  for (const [row, column, rowSpan, colSpan, text, textRuns, indices] of f.expected) {
    const cell = result.cells.find(
      (owner: ReturnType<typeof JSON.parse>) => owner.row === row && owner.column === column
    )
    expect(cell).toBeDefined()
    expect([cell.rowSpan, cell.colSpan, cell.text, cell.textRuns ?? null]).toEqual([
      rowSpan,
      colSpan,
      text,
      textRuns
    ])
    const fonts = indices.map((index: number) => {
      const { text, rect, baseline, height } = f.items[index]
      return { text, rect, baseline, height }
    })
    expect(cell.sourceTokens).toEqual(fonts)
    expect(cell.sourceRects).toEqual(fonts.map((font: ReturnType<typeof JSON.parse>) => font.rect))
    assigned.push(...indices)
  }
  expect(assigned).toHaveLength(44)
  expect(new Set(assigned).size).toBe(44)
  for (const old of f.partial.cells.filter((cell: ReturnType<typeof JSON.parse>) => cell.row > 0)) {
    const actual = result.cells.find(
      (cell: ReturnType<typeof JSON.parse>) =>
        cell.row === old.row + 1 && cell.column === old.column
    )
    const { row, ...fields } = old
    expect(actual).toEqual({ ...fields, row: row + 1 })
  }
  for (const old of f.partial.cells.filter(
    (cell: ReturnType<typeof JSON.parse>) => cell.row === 0 && cell.column < 2
  )) {
    const actual = result.cells.find(
      (cell: ReturnType<typeof JSON.parse>) => cell.row === 1 && cell.column === old.column
    )
    const { row, rect, ...fields } = old
    const { row: actualRow, rect: actualRect, ...actualFields } = actual
    expect(actualFields).toEqual(fields)
    expect(actualRow).toBe(row + 1)
    expect(actualRect[1]).toBeLessThan(rect[1])
  }
  expect(result.rows.slice(2)).toEqual(f.partial.rows.slice(1))
  expect(result.unassigned).toEqual([])
  expect(result.issues).toEqual([])
  expect(result.repairs).toEqual([...f.partial.repairs, 'native-isolated-printed-header-recovered'])
  for (const field of [
    'id',
    'cropRect',
    'clipped',
    'excludedCaptionItems',
    'reviewCandidate',
    'selectedTextItems'
  ])
    expect(result[field]).toEqual(f.partial[field])
})

const recoverPairedNativeHeader = (
  f: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativePairedPrintedHeaderOwners(
    f.table,
    f.items,
    f.captions,
    f.rules,
    f.runs,
    f.partial,
    f.notes ?? []
  )

const changePairedSourceFont = (
  f: ReturnType<typeof JSON.parse>,
  font: ReturnType<typeof JSON.parse>,
  change: (font: ReturnType<typeof JSON.parse>) => void
): void => {
  const program = f.runs.find(
    (run: ReturnType<typeof JSON.parse>) =>
      run.text === font.text &&
      run.rect.every((value: number, index: number) => value === font.rect[index])
  )
  change(font)
  Object.assign(program, {
    text: font.text,
    rect: [...font.rect],
    baseline: font.baseline,
    height: font.height,
    literalGlyphs: [...font.text.replace(/\s/gu, '')],
    glyphRuns: [...font.text.replace(/\s/gu, '')].map(() => 100)
  })
}

it('keeps expanded ligature programs and opaque body owners in the paired native header', () => {
  const f = anonymousPairedNativeHeader()
  const parent = f.items.find(
    (font: ReturnType<typeof JSON.parse>) => font.text === 'Source Settings'
  )
  const program = f.runs.find((run: ReturnType<typeof JSON.parse>) => run.text === parent.text)
  parent.text = program.text = 'Office Guidance'
  program.literalGlyphs = ['O', 'ffi', 'c', 'e', ...'Guidance']
  program.glyphRuns = program.literalGlyphs.flatMap((packet: string) => [...packet].map(() => 100))
  f.partial.unassigned[f.partial.unassigned.indexOf('Source Settings')] = parent.text
  const body = f.partial.cells.find(
    (cell: ReturnType<typeof JSON.parse>) => cell.row === 1 && cell.column === 2
  )
  const child = f.partial.cells.find(
    (cell: ReturnType<typeof JSON.parse>) => cell.row === 0 && cell.column === 0
  )
  body.opaqueSource = { preserve: [1, 2] }
  body.sourceTokens[0].opaqueSource = { preserve: [3, 4] }
  child.opaqueSource = { preserve: [5, 6] }
  f.partial.rows[1].opaqueSource = { preserve: [7, 8] }
  const snapshot = structuredClone(f)
  const result = recoverPairedNativeHeader(f)
  expect(result.cells).toHaveLength(31)
  expect(result.cells[0].text).toBe('Office Guidance')
  expect(program.literalGlyphs).toHaveLength(12)
  expect(program.glyphRuns).toHaveLength(14)
  expect(
    result.cells.find((cell: ReturnType<typeof JSON.parse>) => cell.row === 2 && cell.column === 2)
  ).toEqual({ ...body, row: 2 })
  const actualChild = result.cells.find(
    (cell: ReturnType<typeof JSON.parse>) => cell.row === 1 && cell.column === 0
  )
  const { rect, row, ...oldChild } = child
  const { rect: newRect, row: newRow, ...newChild } = actualChild
  expect(newChild).toEqual(oldChild)
  expect(newRow).toBe(row + 1)
  expect(newRect[1]).toBeLessThan(rect[1])
  expect(result.rows[2]).toEqual(f.partial.rows[1])
  expect(f).toEqual(snapshot)
  const correct = { ...f, partial: result }
  expect(recoverPairedNativeHeader(correct)).toBeUndefined()
})

const pairedHeaderRefusals: [string, (f: ReturnType<typeof JSON.parse>) => void][] = [
  [
    'missing closing fence',
    (f) => {
      f.rules.splice(
        f.rules.findIndex((rule: number[]) => rule[1] === rule[3] && rule[1] > 200),
        1
      )
    }
  ],
  [
    'wrong common closing endpoint',
    (f) => {
      f.rules.find((rule: number[]) => rule[1] === rule[3] && rule[1] > 200)[2] -= 1
    }
  ],
  [
    'incomplete independent caption',
    (f) => {
      f.captions[0].lines.push('Unprinted continuation')
    }
  ],
  [
    'whole parent font crosses the opening frame',
    (f) => {
      const parent = f.items.find(
        (font: ReturnType<typeof JSON.parse>) => font.text === 'Source Settings'
      )
      const opening = f.rules.find((rule: number[]) => rule[1] === rule[3])
      changePairedSourceFont(f, parent, (font) => {
        font.rect[1] = opening[1] - 1
        font.height = font.baseline - font.rect[1]
      })
    }
  ],
  [
    'a second complete source parent is adjacent to the script',
    (f) => {
      const indices = f.expected.find(
        (owner: ReturnType<typeof JSON.parse>) => owner[0] === 0 && owner[1] === 2
      )[6]
      const fonts = indices.map((index: number) => f.items[index])
      const letter = fonts.find((font: ReturnType<typeof JSON.parse>) => font.text === 'ζ')
      const bar = fonts.find((font: ReturnType<typeof JSON.parse>) => font.text === '|')
      changePairedSourceFont(f, bar, (font) => {
        font.rect[2] = letter.rect[2]
      })
    }
  ],
  [
    'native program height disagrees with its font',
    (f) => {
      f.runs.find((run: ReturnType<typeof JSON.parse>) => run.text === 'Source Settings').height +=
        1
    }
  ],
  [
    'native program baseline disagrees with its font',
    (f) => {
      f.runs.find(
        (run: ReturnType<typeof JSON.parse>) => run.text === 'Source Settings'
      ).baseline += 1
    }
  ],
  [
    'packet-count ligature counterfeit',
    (f) => {
      const parent = f.items.find(
        (font: ReturnType<typeof JSON.parse>) => font.text === 'Source Settings'
      )
      const program = f.runs.find((run: ReturnType<typeof JSON.parse>) => run.text === parent.text)
      parent.text = program.text = 'Office Guidance'
      program.literalGlyphs = ['O', 'ffi', 'c', 'e', ...'Guidance']
      program.glyphRuns = program.literalGlyphs.map(() => 100)
      f.partial.unassigned[f.partial.unassigned.indexOf('Source Settings')] = parent.text
    }
  ],
  [
    'unknown right-header cell data',
    (f) => {
      f.partial.cells.find(
        (cell: ReturnType<typeof JSON.parse>) => cell.row === 0 && cell.column === 3
      ).opaqueSource = { keep: true }
    }
  ],
  [
    'unknown right-header native token data',
    (f) => {
      f.partial.cells.find(
        (cell: ReturnType<typeof JSON.parse>) => cell.row === 0 && cell.column === 2
      ).sourceTokens[0].opaqueSource = { keep: true }
    }
  ],
  [
    'unknown child rich-run data',
    (f) => {
      f.partial.cells[0].textRuns[0].opaqueSource = { keep: true }
    }
  ],
  [
    'present null input rotation',
    (f) => {
      f.table.readingRotation = null
    }
  ],
  [
    'present null current notes',
    (f) => {
      f.partial.notes = null
    }
  ],
  [
    'present null input parts',
    (f) => {
      f.table.parts = null
    }
  ],
  [
    'current crop outside qualified seed',
    (f) => {
      f.partial.cropRect[0] += 100
    }
  ],
  [
    'current crop unknown coordinates',
    (f) => {
      f.partial.cropRect[0] = NaN
    }
  ],
  [
    'unrelated current diagnostic',
    (f) => {
      f.partial.issues.push('span-conflicts-with-source-columns')
    }
  ],
  [
    'a changed correct body owner',
    (f) => {
      f.partial.cells.find(
        (cell: ReturnType<typeof JSON.parse>) => cell.row === 1 && cell.column === 2
      ).text = '9'
    }
  ],
  [
    'a same-table note paragraph',
    (f) => {
      f.notes = [{ text: 'Independent note paragraph' }]
    }
  ]
]

it.each(pairedHeaderRefusals)(
  'refuses paired native header with %s without changing existing owners',
  (_, change) => {
    const f = anonymousPairedNativeHeader()
    change(f)
    const snapshot = structuredClone(f)
    expect(() => recoverPairedNativeHeader(f)).not.toThrow()
    expect(recoverPairedNativeHeader(f)).toBeUndefined()
    expect(f).toEqual(snapshot)
  }
)

it('fails closed for malformed paired native header inputs', () => {
  const f = anonymousPairedNativeHeader()
  for (const params of [
    [null, f.items, f.captions, f.rules, f.runs, f.partial],
    [f.table, null, f.captions, f.rules, f.runs, f.partial],
    [f.table, f.items, f.captions, f.rules, f.runs, null],
    [f.table, f.items, f.captions, f.rules, f.runs, { ...f.partial, rows: [null] }],
    [f.table, f.items, f.captions, f.rules, f.runs, { ...f.partial, cells: [null] }],
    [f.table, f.items, f.captions, f.rules, f.runs, f.partial, null]
  ]) {
    expect(() =>
      lateFencedGroupHelpers.recoverNativePairedPrintedHeaderOwners(...params)
    ).not.toThrow()
    expect(lateFencedGroupHelpers.recoverNativePairedPrintedHeaderOwners(...params)).toBeUndefined()
  }
})

const anonymousCalibratedTerminalRecords = (): ReturnType<typeof JSON.parse> => {
  const height = 10
  const font = (
    text: string,
    left: number,
    right: number,
    baseline: number,
    inlineSymbol = false
  ): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [left, baseline - height, right, baseline],
    height,
    baseline,
    horizontal: true,
    inlineSymbol
  })
  const cuts = [18, 100, 145, 195, 245, 322]
  const baselines = [70, 88, 106, 124]
  const literals = ['Record A', 'Record B', 'Record C', 'Record D']
  const flags = [
    ['✓', '✗', '✗'],
    ['✓', '✗', '✗'],
    ['✓', '✗', '✗'],
    ['✓', '✓', '✓']
  ]
  const header = [
    [],
    ...[1, 2, 3, 4].map((c) => [
      font('Upper', cuts[c] + 6, cuts[c + 1] - 6, 34),
      font('Lower', cuts[c] + 8, cuts[c + 1] - 8, 46)
    ])
  ]
  const records = baselines.map((b, n) => [
    [font(literals[n], 25, 80, b)],
    [font(flags[n][0], 119, 124, b)],
    [font(flags[n][1], 168, 173, b)],
    [font(flags[n][2], 218, 223, b)],
    [
      font('F', 254, 261, b),
      font('~', 256, 262, b - 3),
      font('(', 264, 269, b),
      font('§', 270, 280, b - 9, true),
      font('a/b', 280, 302, b),
      font(')', 306, 310, b)
    ]
  ])
  const literal = 'F~(§a/b)'
  const caption = {
    page: 2,
    lines: ['Table 2: Bounded literal comparison.'],
    rect: [10, 146, 330, 176]
  }
  const rows = [
    [24, 50],
    [56, 72],
    [74, 90],
    [92, 126]
  ].map(([top, bottom]) => ({ rect: [24, top, 315, bottom], origin: 'model' }))
  const token = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> => ({
    text: f.text,
    rect: [...f.rect],
    baseline: f.baseline,
    height: f.height
  })
  const cell = (
    r: number,
    c: number,
    source: ReturnType<typeof JSON.parse>[],
    text: string
  ): ReturnType<typeof JSON.parse> => {
    const sourceTokens = source.map(token)
    const sourceRects = sourceTokens.map((t) => [...t.rect])
    if (c === 4 && r > 0) {
      // Preserve the independent old sourceRects order, with the overlay first.
      for (let n = 0; n < sourceRects.length; n += 6)
        [sourceRects[n], sourceRects[n + 1]] = [sourceRects[n + 1], sourceRects[n]]
    }
    return {
      row: r,
      column: c,
      rowSpan: 1,
      colSpan: 1,
      rect: [cuts[c], rows[r].rect[1], cuts[c + 1], rows[r].rect[3]],
      origin: 'model-grid',
      text,
      sourceTokens,
      sourceRects
    }
  }
  const cells = header.map((fonts, c) => cell(0, c, fonts, fonts.map((f) => f.text).join(' ')))
  for (const [n, r] of records.slice(0, 2).entries())
    cells.push(...r.map((g, c) => cell(n + 1, c, g, c === 4 ? literal : g[0].text)))
  cells.push(
    ...records[2].map((g, c) =>
      cell(
        3,
        c,
        [...g, ...records[3][c]],
        c === 4 ? `${literal} ${literal}` : `${g[0].text} ${records[3][c][0].text}`
      )
    )
  )
  const table = {
    id: 'anonymous-table',
    cropRect: [18, 18, 322, 128],
    grid: [0, 1, 2, 3].map((r) => cells.filter((c) => c.row === r).map((c) => c.text)),
    rows,
    cells,
    unassigned: [],
    clipped: [],
    issues: [],
    repairs: ['existing'],
    selectedTextItems: 48
  }
  const items = [...header.flat(), ...records.flat(2), font(caption.lines[0], 10, 330, 156)]
  const rules = [
    [20, 20, 320, 20],
    [20, 55, 320, 55],
    [20, 148, 320, 148],
    ...baselines.map((b) => [280, b - 9, 306, b - 9])
  ]
  const paint = new Map(
    rules.map((r) => [r.join(','), [r[0] - 0.2, r[1] - 0.2, r[2] + 0.2, r[3] + 0.2]])
  )
  const seed = { cropRect: [18, 18, 322, 165], readingRotation: 0 }
  const context = { pageNumber: 2, notes: [], rulePaintBounds: paint }
  return { table, items, captions: [caption], rules, seed, context, literal }
}

const calibratedTerminalOutput = (
  f: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativeCalibratedTerminalSymbolicRecords?.(
    f.table,
    f.items,
    f.captions,
    f.context.notes,
    f.rules,
    f.seed,
    f.context.rulePaintBounds
  ) ?? f.table

it('recovers two calibrated terminal records at the existing late table consumer', () => {
  const f = anonymousCalibratedTerminalRecords()
  const snapshot = structuredClone(f)
  f.table.cells[7].opaquePeer = { retained: ['whole'] }
  f.table.cells.at(-1).sourceTokens.at(-1).opaqueProvenance = { retained: 'once' }
  const before = structuredClone(f.table)
  const result = calibratedTerminalOutput(f)
  expect(result.cells).toHaveLength(25)
  expect(result.grid).toHaveLength(5)
  expect(result.cells.slice(0, 15)).toEqual(before.cells.slice(0, 15))
  expect(result.rows.slice(0, 3)).toEqual(before.rows.slice(0, 3))
  expect(result.grid[3]).toEqual(['Record C', '✓', '✗', '✗', f.literal])
  expect(result.grid[4]).toEqual(['Record D', '✓', '✓', '✓', f.literal])
  const tokens = result.cells.flatMap((cell: ReturnType<typeof JSON.parse>) => cell.sourceTokens)
  expect(tokens).toHaveLength(48)
  const key = (value: ReturnType<typeof JSON.parse>): string => JSON.stringify(value)
  expect(tokens.map(key).sort()).toEqual(
    before.cells
      .flatMap((cell: ReturnType<typeof JSON.parse>) => cell.sourceTokens)
      .map(key)
      .sort()
  )
  for (const donor of before.cells.slice(15)) {
    const fields = result.cells.filter(
      (cell: ReturnType<typeof JSON.parse>) => cell.row >= 3 && cell.column === donor.column
    )
    expect(fields).toHaveLength(2)
    expect(fields.flatMap((cell: ReturnType<typeof JSON.parse>) => cell.sourceTokens)).toEqual(
      donor.sourceTokens
    )
    expect(fields.flatMap((cell: ReturnType<typeof JSON.parse>) => cell.sourceRects)).toEqual(
      donor.sourceRects
    )
    expect(fields.every((cell: ReturnType<typeof JSON.parse>) => cell.textRuns === undefined)).toBe(
      true
    )
  }
  const withoutProjection = (
    value: ReturnType<typeof JSON.parse>
  ): ReturnType<typeof JSON.parse> => {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => !['cells', 'rows', 'grid'].includes(key))
    )
  }
  expect(withoutProjection(result)).toEqual(withoutProjection(before))
  expect(f.items).toEqual(snapshot.items)
  expect(f.rules).toEqual(snapshot.rules)
  expect(f.context).toEqual(snapshot.context)
  expect(calibratedTerminalOutput({ ...f, table: result })).toEqual(result)
})

for (const [name, alter] of [
  [
    'unknown split cell identity',
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells.at(-1).identity = 'unsupported'
    }
  ],
  [
    'unknown split row identity',
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.rows.at(-1).identity = 'unsupported'
    }
  ],
  [
    'inconsistent complete literal calibration',
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells.at(-1).text += '?'
      f.table.grid.at(-1)[4] += '?'
    }
  ],
  [
    'incomplete native full font',
    (f: ReturnType<typeof JSON.parse>) => {
      f.items.find(
        (font: ReturnType<typeof JSON.parse>) => font.inlineSymbol && font.baseline === 115
      ).rect[1] += 1
    }
  ],
  [
    'ordinary wrap without a complete second record field',
    (f: ReturnType<typeof JSON.parse>) => {
      const donor = f.table.cells.find(
        (cell: ReturnType<typeof JSON.parse>) => cell.row === 3 && cell.column === 1
      )
      const removed = donor.sourceTokens.pop()
      donor.sourceRects = donor.sourceRects.filter(
        (rect: number[]) => JSON.stringify(rect) !== JSON.stringify(removed.rect)
      )
      donor.text = donor.sourceTokens[0].text
      f.table.grid[3][1] = donor.text
      f.items = f.items.filter(
        (font: ReturnType<typeof JSON.parse>) =>
          JSON.stringify(font.rect) !== JSON.stringify(removed.rect)
      )
      f.table.selectedTextItems--
    }
  ],
  [
    'unproved native symbolic motif',
    (f: ReturnType<typeof JSON.parse>) => {
      f.items.forEach((font: ReturnType<typeof JSON.parse>) => {
        font.inlineSymbol = false
      })
    }
  ],
  [
    'missing native closing paint',
    (f: ReturnType<typeof JSON.parse>) => {
      f.context.rulePaintBounds.delete('20,148,320,148')
    }
  ],
  [
    'ambiguous current caption page',
    (f: ReturnType<typeof JSON.parse>) => {
      f.captions.push({ ...f.captions[0], page: 3 })
    }
  ]
] as const) {
  it('refuses calibrated terminal records with ' + name, () => {
    const f = anonymousCalibratedTerminalRecords()
    alter(f)
    const snapshot = structuredClone(f)
    expect(() => calibratedTerminalOutput(f)).not.toThrow()
    expect(calibratedTerminalOutput(f)).toEqual(f.table)
    expect(f).toEqual(snapshot)
  })
}

const existingRecordRowHelpers = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-leaf-record-repair.mjs')).href
)
function anonymousWholeRecordRowCase(): ReturnType<typeof JSON.parse> {
  const viewport = { width: 918, height: 1188, scale: 1.5 },
    cuts = [20, 95, 170, 245, 320]
  const font = (text: string, column: number, baseline: number): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [cuts[column] + 10, baseline - 10, cuts[column] + 45, baseline],
    height: 10,
    baseline,
    horizontal: true
  })
  const physical = [30, 60, 80, 100, 120].map((baseline, row) =>
    cuts
      .slice(0, 4)
      .map((_, column) => font(row ? 'Value ' + row + column : 'Head ' + column, column, baseline))
  )
  const physicalToModel = [0, 1, 2, 4, 5]
  const rows = [
    [20, 45],
    [50, 62],
    [65, 82],
    [75, 83],
    [85, 103],
    [105, 123]
  ].map(([top, bottom]) => ({ rect: [18, top, 322, bottom], origin: 'model' }))
  const cells = rows.flatMap((r, row) =>
    cuts.slice(0, 4).map((_, column) => {
      const physicalRow = physicalToModel.indexOf(row),
        f = physicalRow < 0 ? undefined : physical[physicalRow][column]
      const sourceTokens = f
        ? [{ text: f.text, rect: [...f.rect], height: f.height, baseline: f.baseline }]
        : []
      return {
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [cuts[column], r.rect[1], cuts[column + 1], r.rect[3]],
        origin: 'model-grid',
        text: f?.text ?? '',
        sourceTokens,
        sourceRects: sourceTokens.map((t) => [...t.rect])
      }
    })
  )
  const caption = {
    page: 2,
    lines: ['Table 2: Complete record comparison.'],
    rect: [18, 1, 322, 11]
  }
  const table = {
    id: 'anonymous-table',
    page: 2,
    sourceViewport: viewport,
    cropRect: [18, 18, 322, 132],
    caption: {
      text: caption.lines[0],
      page: 2,
      lines: [...caption.lines],
      rect: caption.rect.map((v) => v / 1.5)
    },
    grid: rows.map((_, row) => cells.filter((c) => c.row === row).map((c) => c.text)),
    rows,
    cells,
    unassigned: [],
    clipped: [],
    issues: [],
    repairs: ['existing'],
    notes: [],
    selectedTextItems: 20
  }
  const items = physical.flat(),
    runs = items.map((f) => ({
      ...structuredClone(f),
      literalGlyphs: Array.from(f.text),
      glyphRuns: Array.from(f.text, (_, i) => i)
    }))
  const rules = [20, 45, 87, 130].map((y) => [20, y, 320, y]),
    paint = new Map(rules.map((r) => [r.join(','), [r[0], r[1] - 0.2, r[2], r[3] + 0.2]]))
  const quantize = (p: number[]): number[] =>
    p.map((v, k) => {
      const axis = k % 2 ? viewport.height : viewport.width
      return ((k < 2 ? Math.floor((v / axis) * 256) : Math.ceil((v / axis) * 256) + 1) * axis) / 256
    })
  const graphics = [...paint.values()].map((p) => ({ kind: 'path', rect: quantize(p) }))
  return { table, items, captions: [caption], rules, runs, paint, graphics }
}

const recoverAnonymousWholeRecordRows = (
  f: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> =>
  existingRecordRowHelpers.recoverNativeExistingWholeRecordRows(
    f.table,
    f.items,
    f.captions,
    f.rules,
    f.runs,
    f.paint,
    f.graphics
  )
it('removes only source-proved false rows and preserves all existing complete record owners', () => {
  const f = anonymousWholeRecordRowCase(),
    old = structuredClone(f),
    result = recoverAnonymousWholeRecordRows(f)
  expect(result.cells).toHaveLength(20)
  expect(result.grid).toHaveLength(5)
  const map = new Map([
    [0, 0],
    [1, 1],
    [2, 2],
    [4, 3],
    [5, 4]
  ])
  expect(result.cells).toEqual(
    f.table.cells
      .filter((c: ReturnType<typeof JSON.parse>) => c.row !== 3)
      .map((c: ReturnType<typeof JSON.parse>) => ({ ...c, row: map.get(c.row) }))
  )
  expect(result.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)).toHaveLength(
    20
  )
  const metadata = Object.fromEntries(
    Object.entries(result).filter(([key]) => !['cells', 'grid', 'rows'].includes(key))
  )
  const oldMetadata = Object.fromEntries(
    Object.entries(f.table).filter(([key]) => !['cells', 'grid', 'rows'].includes(key))
  )
  expect(metadata).toEqual(oldMetadata)
  expect(f).toEqual(old)
})
it('preserves opaque retained cell row and font properties when only reindexing rows', () => {
  const f = anonymousWholeRecordRowCase()
  f.table.cells[0].identity = 'retained-cell'
  f.table.rows[0].identity = 'retained-row'
  f.table.cells[0].sourceTokens[0].provenance = { value: 'retained-font' }
  const result = recoverAnonymousWholeRecordRows(f)
  expect(result.cells[0]).toEqual(f.table.cells[0])
  expect(result.rows[0]).toEqual(f.table.rows[0])
})
for (const [name, mutate] of [
  [
    'a source-clean spacer',
    (f: ReturnType<typeof JSON.parse>): void => {
      f.table.rows[3].rect = [18, 82, 322, 84]
      for (const c of f.table.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row === 3))
        c.rect = [c.rect[0], 82, c.rect[2], 84]
    }
  ],
  [
    'a true native blank record',
    (f: ReturnType<typeof JSON.parse>): void => {
      f.rules.push([20, 82, 320, 82], [20, 84, 320, 84])
    }
  ],
  [
    'a foreign graphic',
    (f: ReturnType<typeof JSON.parse>): void => {
      f.graphics.push({ kind: 'image', rect: [100, 75, 110, 80] })
    }
  ],
  [
    'an incomplete native program',
    (f: ReturnType<typeof JSON.parse>): void => {
      f.runs[0].glyphRuns.pop()
    }
  ],
  [
    'a crossing source span',
    (f: ReturnType<typeof JSON.parse>): void => {
      f.table.cells[4].rowSpan = 2
    }
  ],
  [
    'a missing painted footer',
    (f: ReturnType<typeof JSON.parse>): void => {
      f.paint.delete('20,130,320,130')
    }
  ],
  [
    'state on a removed empty cell',
    (f: ReturnType<typeof JSON.parse>): void => {
      f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 3).identity = 'lost'
    }
  ],
  [
    'a mismatched caption page',
    (f: ReturnType<typeof JSON.parse>): void => {
      f.table.caption.page = 3
    }
  ]
] as const)
  it('retains the original table for ' + name, () => {
    const f = anonymousWholeRecordRowCase()
    mutate(f)
    const before = structuredClone(f)
    expect(recoverAnonymousWholeRecordRows(f)).toBeUndefined()
    expect(f).toEqual(before)
  })

// An omitted first body domain is proved by complete source headings, font
// owners and solid native paths. No labels are inherited from another page.
const blankFirstNativeLeaf = (): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = [],
    runs: ReturnType<typeof JSON.parse>[] = [],
    fnArray: number[] = [],
    argsArray: ReturnType<typeof JSON.parse>[] = []
  const addFont = (
    text: string,
    x: number,
    baseline: number,
    width: number
  ): ReturnType<typeof JSON.parse> => {
    const token = { text, rect: [x, baseline - 10, x + width, baseline], baseline, height: 10 }
    items.push({ ...structuredClone(token), horizontal: true, inlineSymbol: false })
    return token
  }
  const h0 = addFont('Flow', 30, 50, 24),
    h1 = addFont('Label', 120, 50, 30),
    h2 = addFont('Result', 230, 50, 36),
    a1 = addFont('Alpha', 120, 90, 30),
    b1 = addFont('First', 230, 90, 30),
    b1Tail = addFont('detail', 230, 105, 36),
    a2 = addFont('Beta', 120, 140, 24),
    b2 = addFont('Second', 230, 140, 36),
    b2Tail = addFont('detail', 230, 155, 36)
  const glyphs = (letters: string[]): ReturnType<typeof JSON.parse>[] =>
    letters.map((unicode) => ({ unicode, width: 600, isInFont: true, isSpace: false }))
  const program = (fonts: ReturnType<typeof JSON.parse>[], ligature = false): void => {
    const index = fnArray.length,
      packets = fonts.map((t, k) => (ligature && k === 0 ? ['Fl', 'o', 'w'] : [...t.text]))
    fnArray.push(OPS.showText)
    argsArray.push([packets.flatMap((p, k) => (k ? [-100, ...glyphs(p)] : glyphs(p)))])
    fonts.forEach((t, k) =>
      runs.push({
        ...structuredClone(t),
        gaps: [],
        literalGlyphs: packets[k],
        glyphRuns: [...t.text].map(() => index)
      })
    )
  }
  const rules = [
      [24, 30, 294, 30],
      [24, 60, 294, 60],
      [24, 189, 294, 189]
    ],
    paint: [string, number[]][] = [],
    graphics: ReturnType<typeof JSON.parse>[] = []
  for (const rule of rules) {
    const y = (600 - rule[1]) / 1.5,
      ink = [24, rule[1] - 0.75, 294, rule[1] + 0.75],
      carrier = [23.25, ink[1], 294.75, ink[3]].map(
        (v, k) =>
          ((k < 2
            ? Math.floor((v / (k % 2 ? 600 : 450)) * 256)
            : Math.ceil((v / (k % 2 ? 600 : 450)) * 256) + 1) *
            (k % 2 ? 600 : 450)) /
          256
      )
    fnArray.push(OPS.constructPath)
    argsArray.push([OPS.stroke, [new Float32Array([0, 16, y, 1, 196, y])]])
    paint.push([rule.join(','), ink])
    graphics.push({ kind: 'path', rect: carrier })
  }
  program([h0, h1, h2], true)
  for (const font of [a1, b1, b1Tail, a2, b2, b2Tail]) program([font])
  const cell = (
    row: number,
    column: number,
    fonts: ReturnType<typeof JSON.parse>[],
    y0: number,
    y1: number
  ): ReturnType<typeof JSON.parse> => ({
    row,
    column,
    rowSpan: 1,
    colSpan: 1,
    rect: [column ? 200 : 20, y0, column ? 300 : 200, y1],
    origin: 'model-grid',
    text: fonts.map((t) => t.text).join(' '),
    sourceTokens: structuredClone(fonts),
    sourceRects: fonts.map((t) => [...t.rect])
  })
  const cells = [
    cell(0, 0, [h0, h1], 40, 50),
    cell(0, 1, [h2], 40, 50),
    cell(1, 0, [a1], 75, 110),
    cell(1, 1, [b1, b1Tail], 75, 110),
    cell(2, 0, [a2], 125, 160),
    cell(2, 1, [b2, b2Tail], 125, 160)
  ]
  cells[2].opaque = { retained: [1, 2, 3] }
  cells[3].textRuns = [{ text: cells[3].text, position: 'normal' }]
  const table = {
    id: 'anonymous-table',
    page: 1,
    cropRect: [20, 20, 300, 200],
    cells,
    grid: cells.reduce((grid: string[][], c) => {
      ;(grid[c.row] ??= [])[c.column] = c.text
      return grid
    }, []),
    rows: [
      { rect: [20, 40, 300, 50], origin: 'model-row' },
      { rect: [20, 75, 300, 110], opaque: 'keep row' },
      { rect: [20, 125, 300, 160] }
    ],
    notes: [],
    issues: [],
    unassigned: [],
    clipped: [],
    repairs: ['duplicate-column-removed'],
    reviewCandidate: true,
    selectedTextItems: 9,
    excludedCaptionItems: ['Table 1: Example'],
    caption: {
      page: 1,
      text: 'Table 1: Example',
      lines: ['Table 1: Example'],
      rect: [20, 2, 80, 10]
    },
    sourceViewport: { width: 450, height: 600, scale: 1.5 }
  }
  const expected = structuredClone(table),
    cut = 87
  expected.grid = [
    [h0.text, h1.text, h2.text],
    ['', a1.text, cells[3].text],
    ['', a2.text, cells[5].text]
  ]
  expected.cells = [
    {
      ...structuredClone(cells[0]),
      rect: [20, 40, cut, 50],
      text: h0.text,
      sourceTokens: [structuredClone(h0)],
      sourceRects: [[...h0.rect]]
    },
    {
      ...structuredClone(cells[0]),
      column: 1,
      rect: [cut, 40, 200, 50],
      text: h1.text,
      sourceTokens: [structuredClone(h1)],
      sourceRects: [[...h1.rect]]
    },
    { ...structuredClone(cells[1]), column: 2 },
    {
      row: 1,
      column: 0,
      rowSpan: 1,
      colSpan: 1,
      rect: [20, 75, cut, 110],
      origin: 'model-grid',
      text: '',
      sourceTokens: [],
      sourceRects: []
    },
    { ...structuredClone(cells[2]), column: 1, rect: [cut, 75, 200, 110] },
    { ...structuredClone(cells[3]), column: 2 },
    {
      row: 2,
      column: 0,
      rowSpan: 1,
      colSpan: 1,
      rect: [20, 125, cut, 160],
      origin: 'model-grid',
      text: '',
      sourceTokens: [],
      sourceRects: []
    },
    { ...structuredClone(cells[4]), column: 1, rect: [cut, 125, 200, 160] },
    { ...structuredClone(cells[5]), column: 2 }
  ]
  return {
    table,
    expected,
    items,
    runs,
    rules,
    paint,
    graphics,
    captions: [{ ...structuredClone(table.caption), rect: table.caption.rect.map((v) => v * 1.5) }],
    operatorContext: {
      operators: { fnArray, argsArray },
      viewport: {
        width: 450,
        height: 600,
        scale: 1.5,
        rotation: 0,
        userUnit: 1,
        offsetX: 0,
        offsetY: 0,
        viewBox: [0, 0, 300, 400],
        transform: [1.5, 0, 0, -1.5, 0, 600]
      }
    }
  }
}

const recoverBlankFirstNativeLeaf = (
  f: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativeBlankFirstLeafOwners?.(
    f.table,
    f.items,
    f.captions,
    f.rules,
    f.runs,
    new Map(f.paint),
    f.graphics,
    f.operatorContext
  ) ?? f.table

it('recovers a source-proved blank first leaf without changing whole wrapped body payloads', () => {
  const f = blankFirstNativeLeaf(),
    before = structuredClone(f)
  expect(recoverBlankFirstNativeLeaf(f)).toEqual(f.expected)
  expect(f).toEqual(before)
})

it.each([
  'clip',
  'eoClip',
  'setGState',
  'unknown glyph',
  'zero glyph width',
  'missing paint',
  'foreign paint',
  'missing stream',
  'duplicate stream',
  'header opaque',
  'invalid slot',
  'notes',
  'null table'
])('refuses blank first leaf recovery with %s', (control) => {
  const f = blankFirstNativeLeaf()
  if (['clip', 'eoClip', 'setGState'].includes(control)) {
    f.operatorContext.operators.fnArray.push(OPS[control as keyof typeof OPS])
    f.operatorContext.operators.argsArray.push(
      control === 'setGState' ? [[['Font', ['unknown', 10]]]] : null
    )
  }
  if (control === 'unknown glyph') f.operatorContext.operators.argsArray[3][0][0].isInFont = false
  if (control === 'zero glyph width') {
    f.operatorContext.operators.argsArray[3][0][0].width = 0
    f.operatorContext.operators.argsArray[3][0].splice(1, 0, -600)
  }
  if (control === 'missing paint') f.paint.pop()
  if (control === 'foreign paint')
    f.graphics.push({ ...structuredClone(f.graphics[0]), rect: [30, 80, 50, 100] })
  if (control === 'missing stream') f.runs.pop()
  if (control === 'duplicate stream') f.runs.push(structuredClone(f.runs[0]))
  if (control === 'header opaque') f.table.cells[0].opaque = 'do not drop'
  if (control === 'invalid slot') f.table.cells[2].row = -1
  if (control === 'notes') f.table.notes.push({ text: 'retained note' })
  if (control === 'null table') f.table = null
  const before = structuredClone(f)
  expect(recoverBlankFirstNativeLeaf(f)).toEqual(f.table)
  expect(f).toEqual(before)
})

// Measured ordinary records have four independent fields. One overlong field
// continues on the next native baseline; two terminal records share old donors.
const measuredFourFieldRecords = (): ReturnType<typeof JSON.parse> => {
  const cuts = [20, 90, 180, 270, 420],
    content: ReturnType<typeof JSON.parse> = { items: [], styles: {} },
    operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    viewport = {
      width: 450,
      height: 600,
      scale: 1.5,
      rotation: 0,
      transform: [1.5, 0, 0, -1.5, 0, 600],
      convertToViewportPoint: (x: number, y: number): number[] => [x * 1.5, 600 - y * 1.5]
    },
    emit = (op: number, args: ReturnType<typeof JSON.parse>): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    rules = [
      [24, 40, 420, 40],
      [24, 65, 420, 65],
      [24, 164, 420, 164]
    ],
    paint: [string, number[]][] = [],
    graphics: ReturnType<typeof JSON.parse>[] = []
  for (const rule of rules) {
    emit(OPS.constructPath, [
      OPS.stroke,
      [[0, 16, (600 - rule[1]) / 1.5, 1, 280, (600 - rule[1]) / 1.5]]
    ])
    const ink = [24, rule[1] - 0.75, 420, rule[1] + 0.75]
    paint.push([rule.join(','), ink])
    graphics.push({
      kind: 'path',
      rect: [23.25, ink[1], 420.75, ink[3]].map(
        (v, k) =>
          ((k < 2
            ? Math.floor((v / (k % 2 ? 600 : 450)) * 256)
            : Math.ceil((v / (k % 2 ? 600 : 450)) * 256) + 1) *
            (k % 2 ? 600 : 450)) /
          256
      )
    })
  }
  const specifications: ReturnType<typeof JSON.parse>[] = [],
    add = (text: string, column: number, baseline: number, width = 30): void => {
      const x = cuts[column] + 10,
        packets = text.startsWith('Field') ? ['Fi', ...text.slice(2)] : [...text],
        size = 10 / 1.5
      emit(OPS.beginText, null)
      emit(OPS.setFont, ['ordinary', size])
      emit(OPS.setTextMatrix, [1, 0, 0, 1, x / 1.5, (600 - baseline) / 1.5])
      emit(OPS.showText, [
        packets.map((unicode) => ({
          unicode,
          width: (width * 1000) / (10 * packets.length),
          isInFont: true,
          isSpace: false
        }))
      ])
      emit(OPS.endText, null)
      content.items.push({
        str: text,
        width: width / 1.5,
        height: size,
        dir: 'ltr',
        fontName: 'ordinary',
        transform: [size, 0, 0, size, x / 1.5, (600 - baseline) / 1.5]
      })
      specifications.push({ text, column, baseline })
    }
  for (let column = 0; column < 4; column++) add('Field' + column, column, 60)
  for (const baseline of [80, 92, 116, 128, 140, 152]) {
    for (let column = 0; column < 4; column++)
      add(
        baseline === 92 && column === 2 ? 'LongOwner' : `R${baseline}C${column}`,
        column,
        baseline,
        baseline === 92 && column === 2 ? 70 : 30
      )
    if (baseline === 92) add('tail', 2, 104, 45)
  }
  const runs = measureOrdinaryPrograms(content, operators, viewport)
  expect(runs).toHaveLength(specifications.length)
  const fonts = runs.map((r: ReturnType<typeof JSON.parse>) => ({
      text: r.text,
      rect: r.rect,
      baseline: r.baseline,
      height: r.height
    })),
    items = fonts.map((f: ReturnType<typeof JSON.parse>) => ({
      ...f,
      horizontal: true,
      inlineSymbol: false
    })),
    at = (baseline: number, column: number): ReturnType<typeof JSON.parse>[] =>
      fonts.filter(
        (f: ReturnType<typeof JSON.parse>) =>
          Math.abs(f.baseline - baseline) < 0.001 && f.rect[0] === cuts[column] + 10
      ),
    oldBands = [
      [50, 61],
      [68, 81],
      [82.5, 94],
      [94, 106],
      [104, 118],
      [118, 130],
      [130, 155]
    ],
    cells: ReturnType<typeof JSON.parse>[] = []
  for (let row = 0; row < 7; row++)
    for (let column = 0; column < 4; column++) {
      const sourceTokens =
        row === 3
          ? column === 2
            ? at(104, column)
            : []
          : row === 6
            ? [...at(140, column), ...at(152, column)]
            : at([60, 80, 92, 104, 116, 128][row], column)
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [cuts[column], oldBands[row][0], cuts[column + 1], oldBands[row][1]],
        origin: row === 0 ? 'source-printed-header' : 'model-grid',
        text: sourceTokens.map((f: ReturnType<typeof JSON.parse>) => f.text).join(' '),
        sourceTokens,
        sourceRects: sourceTokens.map((f: ReturnType<typeof JSON.parse>) => f.rect)
      })
    }
  cells[4].opaque = { identity: 'kept' }
  cells[4].textRuns = [{ text: cells[4].text, position: 'normal', original: 'kept' }]
  const table = {
      id: 'ordinary-table',
      page: 1,
      cropRect: [20, 30, 420, 175],
      cells,
      grid: Array.from({ length: 7 }, (_r, row) =>
        cells.filter((c) => c.row === row).map((c) => c.text)
      ),
      rows: oldBands.map((b) => ({ rect: [20, b[0], 420, b[1]], origin: 'model-row' })),
      notes: [],
      parts: [],
      issues: [],
      unassigned: [],
      clipped: [],
      repairs: ['existing'],
      selectedTextItems: fonts.length,
      reviewCandidate: true,
      caption: {
        page: 1,
        text: 'Table 1: Example',
        lines: ['Table 1: Example'],
        rect: [20, 10, 100, 20]
      },
      sourceViewport: { width: 450, height: 600, scale: 1.5 }
    },
    expected = structuredClone(table),
    midpoint = (at(140, 0)[0].rect[3] + at(152, 0)[0].rect[1]) / 2,
    merged = [...at(92, 2), ...at(104, 2)],
    mergeTop = Math.min(cells[10].rect[1], ...merged.map((f) => f.rect[1]))
  expected.cells = cells.flatMap((c) => {
    if (c.row === 3) return []
    if (c.row === 2 && c.column === 2)
      return [
        {
          ...structuredClone(c),
          rect: [180, mergeTop, 270, 106],
          text: 'LongOwner tail',
          sourceTokens: structuredClone(merged),
          sourceRects: merged.map((f) => [...f.rect])
        }
      ]
    if (c.row === 6)
      return [5, 6].map((row) => ({
        ...structuredClone(c),
        row,
        rect: [
          c.rect[0],
          row === 5 ? c.rect[1] : midpoint,
          c.rect[2],
          row === 5 ? midpoint : c.rect[3]
        ],
        text: at(row === 5 ? 140 : 152, c.column)[0].text,
        sourceTokens: structuredClone(at(row === 5 ? 140 : 152, c.column)),
        sourceRects: at(row === 5 ? 140 : 152, c.column).map((f) => [...f.rect])
      }))
    return [{ ...structuredClone(c), row: c.row > 3 ? c.row - 1 : c.row }]
  })
  expected.rows = table.rows.flatMap((r, row) =>
    row === 3
      ? []
      : row === 6
        ? [
            { ...r, rect: [20, r.rect[1], 420, midpoint] },
            { ...r, rect: [20, midpoint, 420, r.rect[3]] }
          ]
        : [{ ...r, rect: row === 2 ? [20, mergeTop, 420, 106] : r.rect }]
  )
  expected.grid = Array.from({ length: 7 }, (_r, row) =>
    expected.cells
      .filter((c) => c.row === row)
      .sort((a, b) => a.column - b.column)
      .map((c) => c.text)
  )
  const { convertToViewportPoint: _method, ...plainViewport } = viewport
  void _method
  return {
    table,
    expected,
    items,
    runs,
    rules,
    paint,
    graphics,
    captions: [{ lines: ['Table 1: Example'], rect: [20, 10, 150, 25] }],
    operatorContext: { operators, viewport: plainViewport }
  }
}

const recoverMeasuredFourFieldRecords = (
  f: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> =>
  panelRefineHelpers.recoverNativeFourFieldOrdinaryRecordOwners?.(
    f.table,
    f.items,
    f.captions,
    f.rules,
    f.runs,
    new Map(f.paint),
    f.graphics,
    f.operatorContext
  )

// Independent printed key/value lines survive an old group-sized model row.
// The middle field is printed only at group starts; its other slots stay blank.
const measuredNumberedRecords = (): ReturnType<typeof JSON.parse> => {
  const operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    content: ReturnType<typeof JSON.parse> = { items: [], styles: {} },
    viewport = {
      width: 450,
      height: 600,
      scale: 1.5,
      rotation: 0,
      transform: [1.5, 0, 0, -1.5, 0, 600],
      convertToViewportPoint: (x: number, y: number): number[] => [x * 1.5, 600 - y * 1.5]
    },
    emit = (op: number, args: ReturnType<typeof JSON.parse>): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    rules = [
      [24, 5, 420, 5],
      [24, 40, 420, 40],
      [24, 65, 420, 65],
      [24, 156, 420, 156]
    ],
    paint: [string, number[]][] = [],
    graphics: ReturnType<typeof JSON.parse>[] = []
  emit(OPS.setStrokeRGBColor, ['#000000'])
  emit(OPS.setLineWidth, [1])
  for (const [n, rule] of rules.entries()) {
    emit(OPS.constructPath, [
      OPS.stroke,
      [[0, 16, (600 - rule[1]) / 1.5, 1, 280, (600 - rule[1]) / 1.5]]
    ])
    const ink = [24, rule[1] - 0.75, 420, rule[1] + 0.75]
    paint.push([rule.join(','), ink])
    if (n)
      graphics.push({
        kind: 'path',
        rect: [23.25, ink[1], 420.75, ink[3]].map(
          (v, k) =>
            ((k < 2
              ? Math.floor((v / (k % 2 ? 600 : 450)) * 256)
              : Math.ceil((v / (k % 2 ? 600 : 450)) * 256) + 1) *
              (k % 2 ? 600 : 450)) /
            256
        )
      })
  }
  const add = (text: string, column: number, baseline: number, width: number): void => {
    const x = [30, 110, 200][column],
      size = 10 / 1.5,
      index = content.items.length
    emit(OPS.beginText, null)
    emit(OPS.setFont, ['ordinary', size])
    emit(OPS.setTextMatrix, [1, 0, 0, 1, x / 1.5, (600 - baseline) / 1.5])
    emit(OPS.showText, [
      [...text].map((unicode) => ({
        unicode,
        width: (width * 1000) / (10 * text.length),
        isInFont: true,
        isSpace: false
      }))
    ])
    emit(OPS.endText, null)
    content.items.push({
      str: text,
      width: width / 1.5,
      height: size,
      dir: 'ltr',
      fontName: 'ordinary',
      transform: [size, 0, 0, size, x / 1.5, (600 - baseline) / 1.5],
      sourceItem: { pageNumber: 1, index, text }
    })
  }
  for (const [n, text] of ['Key', 'Group', 'Value'].entries()) add(text, n, 60, 30)
  for (const [n, baseline] of [78, 90, 102, 120, 132, 144].entries()) {
    add(String(n + 1), 0, baseline, 12)
    if (n === 0 || n === 3) add(n ? 'Beta' : 'Alpha', 1, baseline, 30)
    add(`Value${n}`, 2, baseline, 90)
  }
  const runs = measureOrdinaryPrograms(content, operators, viewport),
    items = runs.map((r: ReturnType<typeof JSON.parse>, index: number) => ({
      text: r.text,
      rect: r.rect,
      baseline: r.baseline,
      height: r.height,
      horizontal: true,
      inlineSymbol: false,
      sourceItem: { pageNumber: 1, index, text: r.text }
    })),
    cells: ReturnType<typeof JSON.parse>[] = [],
    cuts = [20, 90, 180, 420],
    bands = [
      [50, 61],
      [68, 105],
      [110, 149]
    ]
  for (let row = 0; row < 3; row++)
    for (let column = 0; column < 3; column++) {
      const fonts = items.filter(
          (f: ReturnType<typeof JSON.parse>) =>
            f.rect[0] === [30, 110, 200][column] &&
            (row === 0
              ? f.baseline === 60
              : row === 1
                ? f.baseline > 65 && f.baseline < 110
                : f.baseline >= 110)
        ),
        sourceTokens = fonts.map((f: ReturnType<typeof JSON.parse>) => ({
          text: f.text,
          rect: f.rect,
          baseline: f.baseline,
          height: f.height
        }))
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [cuts[column], bands[row][0], cuts[column + 1], bands[row][1]],
        origin: 'model-grid',
        text: fonts.map((f: ReturnType<typeof JSON.parse>) => f.text).join(' '),
        sourceTokens,
        sourceRects: fonts.map((f: ReturnType<typeof JSON.parse>) => f.rect),
        sourceItems: fonts.map((f: ReturnType<typeof JSON.parse>) => f.sourceItem)
      })
    }
  cells[0].opaque = { identity: 'retained header' }
  const caption = {
      page: 1,
      text: 'Table 1: Example',
      lines: ['Table 1: Example'],
      rect: [20, 10, 100, 20]
    },
    table = {
      id: 'numbered-records',
      page: 1,
      cropRect: [20, 35, 420, 158],
      cells,
      rows: bands.map((b) => ({ rect: [20, b[0], 420, b[1]], origin: 'model' })),
      grid: bands.map((_b, row) => cells.filter((c) => c.row === row).map((c) => c.text)),
      notes: [],
      issues: [],
      unassigned: [],
      clipped: [],
      repairs: ['existing'],
      selectedTextItems: items.length,
      caption,
      sourceViewport: { width: 450, height: 600, scale: 1.5 },
      opaque: { identity: 'retained table' }
    }
  const { convertToViewportPoint: _method, ...plainViewport } = viewport
  void _method
  return {
    table,
    items,
    runs,
    rules,
    paint,
    graphics,
    captions: [{ ...caption, rect: caption.rect.map((n) => n * 1.5) }],
    operatorContext: { operators, viewport: plainViewport }
  }
}

// Two physical numeric-peer records end the original page. No closing rule,
// neighboring-page header, or detector column is used to establish owners.
const measuredTwoRuleFirstBody = (): ReturnType<typeof JSON.parse> => {
  const operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    content: ReturnType<typeof JSON.parse> = { items: [], styles: {} },
    viewport = {
      width: 900,
      height: 1200,
      scale: 1.5,
      rotation: 0,
      transform: [1.5, 0, 0, -1.5, 0, 1200],
      convertToViewportPoint: (x: number, y: number): number[] => [x * 1.5, 1200 - y * 1.5]
    },
    emit = (op: number, args: ReturnType<typeof JSON.parse>): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    rules = [
      [80, 1000, 850, 1000],
      [80, 1030, 850, 1030]
    ],
    paint: [string, number[]][] = [],
    graphics: ReturnType<typeof JSON.parse>[] = []
  emit(OPS.setStrokeRGBColor, ['#000000'])
  emit(OPS.setLineWidth, [1])
  for (const rule of rules) {
    emit(OPS.constructPath, [
      OPS.stroke,
      [[0, rule[0] / 1.5, (1200 - rule[1]) / 1.5, 1, rule[2] / 1.5, (1200 - rule[1]) / 1.5]]
    ])
    const ink = [rule[0], rule[1] - 0.75, rule[2], rule[1] + 0.75]
    paint.push([rule.join(','), ink])
    graphics.push({
      kind: 'path',
      rect: [ink[0] - 0.75, ink[1], ink[2] + 0.75, ink[3]].map(
        (v, k) =>
          ((k < 2
            ? Math.floor((v / (k % 2 ? 1200 : 900)) * 256)
            : Math.ceil((v / (k % 2 ? 1200 : 900)) * 256) + 1) *
            (k % 2 ? 1200 : 900)) /
          256
      )
    })
  }
  const add = (text: string, x: number, baseline: number, width: number): void => {
    const size = 16 / 1.5,
      index = content.items.length
    emit(OPS.beginText, null)
    emit(OPS.setFont, ['ordinary', size])
    emit(OPS.setTextMatrix, [1, 0, 0, 1, x / 1.5, (1200 - baseline) / 1.5])
    emit(OPS.showText, [
      [...text].map((unicode) => ({
        unicode,
        width: (width * 1000) / (16 * text.length),
        isInFont: true,
        accent: null,
        isSpace: unicode === ' '
      }))
    ])
    emit(OPS.endText, null)
    content.items.push({
      str: text,
      width: width / 1.5,
      height: size,
      dir: 'ltr',
      fontName: 'ordinary',
      transform: [size, 0, 0, size, x / 1.5, (1200 - baseline) / 1.5],
      sourceItem: { pageNumber: 1, index, text }
    })
  }
  const first = 'Table 1: Example ordinary measurements for two conditions and several'
  emit(OPS.dependency, ['ordinary'])
  add(first, 100, 958, 740)
  add('reported estimates', 80, 980, 120)
  const literal = [
    ['Condition', 'Estimator', 'Mean bias', 'Mean error', 'Coverage'],
    ['Plain case', 'Method A', '0.012', '0.108', '0.945'],
    ['Plain case', 'Method B', '0.286', '0.402', '0.746']
  ]
  literal.forEach((row, r) =>
    row.forEach((text, c) =>
      add(text, [80, 230, 390, 530, 675][c], [1022, 1055, 1077][r], [100, 110, 80, 80, 110][c])
    )
  )
  const runs = measureOrdinaryPrograms(content, operators, viewport),
    items = runs.map((r: ReturnType<typeof JSON.parse>, index: number) => ({
      text: r.text,
      rect: r.rect,
      baseline: r.baseline,
      height: r.height,
      horizontal: true,
      inlineSymbol: false,
      sourceItem: { pageNumber: 1, index, text: r.text }
    })),
    caption = {
      page: 1,
      text: first,
      lines: [first],
      rect: [100, 942, 840, 958].map((n) => n / 1.5)
    },
    table = {
      id: 'two-rule-first-body',
      page: 1,
      cropRect: [70, 999, 860, 1090],
      rows: [],
      cells: [],
      grid: [],
      issues: ['missing-row-or-column', 'overlapping-predicted-columns', 'unassigned-source-text'],
      unassigned: literal.flat(),
      clipped: [],
      repairs: ['existing'],
      notes: [],
      caption,
      sourceViewport: { width: 900, height: 1200, scale: 1.5 },
      opaque: { identity: 'retained empty seed' }
    }
  const { convertToViewportPoint: _method, ...plainViewport } = viewport
  void _method
  return {
    table,
    items,
    runs,
    rules,
    paint,
    graphics,
    literal,
    captions: [{ ...caption, rect: caption.rect.map((n) => n * 1.5) }],
    operatorContext: { operators, viewport: plainViewport }
  }
}

it('recovers two-rule first-body records with complete caption and native origins', () => {
  const f = measuredTwoRuleFirstBody(),
    before = structuredClone(f),
    result = recoverMeasuredFourFieldRecords(f)
  expect(result?.grid).toEqual(f.literal)
  expect(result?.cells).toHaveLength(15)
  expect(result?.caption.lines).toEqual([f.table.caption.lines[0], 'reported estimates'])
  expect(result?.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems)).toEqual(
    f.items.slice(2).map((i: ReturnType<typeof JSON.parse>) => i.sourceItem)
  )
  expect(result?.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceRects)).toEqual(
    f.items.slice(2).map((i: ReturnType<typeof JSON.parse>) => i.rect)
  )
  expect(result?.opaque).toEqual(f.table.opaque)
  expect(result?.issues).toEqual([])
  expect(result?.unassigned).toEqual([])
  expect(result?.repairs).toEqual(['existing', 'native-rowless-two-rule-records'])
  expect(
    result?.cells.every((c: ReturnType<typeof JSON.parse>) => c.rowSpan === 1 && c.colSpan === 1)
  ).toBe(true)
  expect(
    panelRefineHelpers.hasTableEvidence(
      result,
      { ...result.caption, rect: result.caption.rect.map((n: number) => n * 1.5) },
      f.items,
      f.rules,
      f.graphics
    )
  ).toBe(true)
  expect(recoverMeasuredFourFieldRecords({ ...f, table: result })).toBeUndefined()
  expect(f).toEqual(before)
})

it('recovers two-rule first-body from the current refine-generated reconciliation witness', () => {
  const f = measuredTwoRuleFirstBody(),
    seed = {
      id: f.table.id,
      cropRect: f.table.cropRect,
      readingRotation: 0,
      structure: {
        objects: [
          [20, 130],
          [140, 280],
          [290, 390],
          [350, 440],
          [400, 540],
          [550, 680]
        ].map(([a, b]) => ({ label: 'table column', rect: [a, 36, b, 74], score: 0.9 }))
      }
    },
    refined = refineTable(
      seed,
      f.items,
      f.captions,
      [],
      f.rules,
      f.runs,
      undefined,
      new Map(f.paint)
    )
  expect(refined.rows).toEqual([])
  expect(refined.grid).toEqual([])
  expect(refined.cells).toEqual([])
  const descriptor = Object.getOwnPropertyDescriptor(refined.unassigned, 'reconciliationItems')
  expect(descriptor).toMatchObject({ writable: false, enumerable: false, configurable: false })
  expect(descriptor?.value).toEqual(f.items.slice(2))
  f.table = {
    ...refined,
    page: 1,
    caption: f.table.caption,
    sourceViewport: f.table.sourceViewport
  }
  const result = recoverMeasuredFourFieldRecords(f)
  expect(result?.grid).toEqual(f.literal)
  expect(result?.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems)).toEqual(
    f.items.slice(2).map((i: ReturnType<typeof JSON.parse>) => i.sourceItem)
  )
  expect(Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems')).toEqual(
    descriptor
  )
})

it.each([
  'incomplete record',
  'prose peer',
  'duplicate origin',
  'glyph width',
  'TJ advance',
  'raw footer',
  'foreign font',
  'foreign graphic',
  'missing carrier',
  'extra rule',
  'rule width',
  'white caption',
  'alpha state',
  'Type3 glyph',
  'unknown font program',
  'incomplete caption',
  'ambiguous caption',
  'opaque diagnostic',
  'opaque empty row array',
  'opaque source font',
  'opaque caption lines',
  'opaque unassigned array',
  'enumerable reconciliation',
  'mismatched reconciliation',
  'duplicate reconciliation',
  'opaque clone'
])('refuses two-rule first-body projection atomically with %s', (control) => {
  const f = measuredTwoRuleFirstBody(),
    ops = f.operatorContext.operators,
    glyphOp = ops.fnArray.indexOf(OPS.showText)
  if (control === 'incomplete record') {
    const removed = f.items.pop()
    f.table.unassigned.pop()
    f.runs = f.runs.filter(
      (r: ReturnType<typeof JSON.parse>) =>
        r.text !== removed.text || r.baseline !== removed.baseline
    )
  }
  if (control === 'prose peer') {
    f.items.at(-1).text = 'unknown'
    f.items.at(-1).sourceItem.text = 'unknown'
    f.table.unassigned[f.table.unassigned.length - 1] = 'unknown'
  }
  if (control === 'duplicate origin')
    f.items.at(-1).sourceItem.index = f.items.at(-2).sourceItem.index
  if (control === 'glyph width') ops.argsArray[glyphOp][0][0].width += 20
  if (control === 'TJ advance') ops.argsArray[glyphOp][0].unshift(20)
  if (control === 'raw footer') {
    ops.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    ops.argsArray.push(
      null,
      ['ordinary', 16 / 1.5],
      [1, 0, 0, 1, 400 / 1.5, 80 / 1.5],
      [[{ unicode: '9', width: 500, isInFont: true, accent: null }]],
      null
    )
  }
  if (control === 'foreign font')
    f.items.push({
      ...structuredClone(f.items.at(-1)),
      rect: [80, 1130, 140, 1146],
      baseline: 1146
    })
  if (control === 'foreign graphic') f.graphics.push({ kind: 'path', rect: [80, 1120, 850, 1122] })
  if (control === 'missing carrier') f.graphics.pop()
  if (control === 'extra rule') f.rules.push([80, 1100, 850, 1100])
  if (control === 'rule width') ops.argsArray[ops.fnArray.indexOf(OPS.setLineWidth)] = [2]
  if (control === 'white caption') {
    ops.fnArray.unshift(OPS.setFillRGBColor)
    ops.argsArray.unshift(['#ffffff'])
  }
  if (control === 'alpha state') {
    ops.fnArray.push(OPS.setGState)
    ops.argsArray.push([[['ca', 0]]])
  }
  if (control === 'Type3 glyph') ops.argsArray[glyphOp][0][0].operatorListId = 'unknown'
  if (control === 'unknown font program')
    ops.fnArray.forEach((op: number, n: number) => {
      if (op === OPS.setFont) ops.argsArray[n][0] = 'unknown-font-program'
    })
  if (control === 'incomplete caption') f.items.splice(1, 1)
  if (control === 'ambiguous caption') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'opaque diagnostic') f.table.issues[0] = { text: 'missing-row-or-column' }
  if (control === 'opaque empty row array') f.table.rows.opaque = { retained: true }
  if (control === 'opaque source font')
    f.items.at(-1).textRuns = [{ text: 'unknown', position: 'superscript' }]
  if (control === 'opaque caption lines') f.table.caption.lines.opaque = { retained: true }
  if (control === 'opaque unassigned array') f.table.unassigned.opaque = { retained: true }
  if (control === 'enumerable reconciliation')
    Object.defineProperty(f.table.unassigned, 'reconciliationItems', {
      value: f.items.slice(2),
      enumerable: true
    })
  if (control === 'mismatched reconciliation')
    Object.defineProperty(f.table.unassigned, 'reconciliationItems', {
      value: [...f.items.slice(2, 16), f.items[0]],
      enumerable: false
    })
  if (control === 'duplicate reconciliation')
    Object.defineProperty(f.table.unassigned, 'reconciliationItems', {
      value: [...f.items.slice(2, 16), f.items[2]],
      enumerable: false
    })
  if (control === 'opaque clone') f.table.opaque.effect = () => undefined
  const before = {
    table: { ...f.table },
    items: structuredClone(f.items),
    ops: structuredClone(ops)
  }
  expect(recoverMeasuredFourFieldRecords(f)).toBeUndefined()
  expect(f.table).toEqual(before.table)
  expect(f.items).toEqual(before.items)
  expect(ops).toEqual(before.ops)
})

it('recovers numbered whole records while conserving native owners and printed blank fields', () => {
  const f = measuredNumberedRecords(),
    before = structuredClone(f),
    result = recoverMeasuredFourFieldRecords(f)
  expect(result?.grid).toEqual([
    ['Key', 'Group', 'Value'],
    ['1', 'Alpha', 'Value0'],
    ['2', '', 'Value1'],
    ['3', '', 'Value2'],
    ['4', 'Beta', 'Value3'],
    ['5', '', 'Value4'],
    ['6', '', 'Value5']
  ])
  expect(result.cells).toHaveLength(21)
  expect(result.cells.slice(0, 3)).toEqual(f.table.cells.slice(0, 3))
  expect(result.cells.filter((c: ReturnType<typeof JSON.parse>) => !c.text)).toHaveLength(4)
  expect(
    result.cells.every((c: ReturnType<typeof JSON.parse>) => c.rowSpan === 1 && c.colSpan === 1)
  ).toBe(true)
  expect(
    result.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems ?? [])
      .sort(
        (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) => a.index - b.index
      )
  ).toEqual(f.items.map((i: ReturnType<typeof JSON.parse>) => i.sourceItem))
  expect(result.opaque).toEqual(f.table.opaque)
  expect(result.caption).toEqual(f.table.caption)
  expect(result.cropRect).toEqual(f.table.cropRect)
  expect(f).toEqual(before)
  expect(recoverMeasuredFourFieldRecords({ ...f, table: result })).toBeUndefined()
})

it.each([
  'missing font',
  'missing program',
  'incomplete program',
  'wrong glyph width',
  'missing origin',
  'duplicate owner',
  'different baseline',
  'foreign font',
  'missing paint',
  'foreign paint',
  'clip',
  'invisible text',
  'white rule',
  'wrong stroke width',
  'ambiguous caption',
  'opaque donor',
  'linked row',
  'rich donor',
  'noncloneable header'
])('refuses numbered whole-record projection atomically with %s', (control) => {
  const f = measuredNumberedRecords(),
    donor = f.table.cells[3],
    stream = f.runs.find((r: ReturnType<typeof JSON.parse>) => r.text === '1'),
    ops = f.operatorContext.operators
  if (control === 'missing font') f.items.splice(3, 1)
  if (control === 'missing program') f.runs.splice(f.runs.indexOf(stream), 1)
  if (control === 'incomplete program') stream.literalGlyphs[0] = '9'
  if (control === 'wrong glyph width') ops.argsArray[stream.glyphRuns[0]][0][0].width *= 2
  if (control === 'missing origin') donor.sourceItems.pop()
  if (control === 'duplicate owner') {
    donor.sourceTokens.push(donor.sourceTokens[0])
    donor.sourceRects.push(donor.sourceRects[0])
  }
  if (control === 'different baseline') f.items[4].baseline += 1
  if (control === 'foreign font') f.items.push({ ...f.items[3], text: 'foreign' })
  if (control === 'missing paint') f.graphics.pop()
  if (control === 'foreign paint') f.graphics.push({ kind: 'path', rect: [30, 80, 40, 90] })
  if (control === 'clip') {
    ops.fnArray[0] = OPS.clip
    ops.argsArray[0] = null
  }
  if (control === 'invisible text') {
    ops.fnArray[0] = OPS.setTextRenderingMode
    ops.argsArray[0] = [3]
  }
  if (control === 'white rule') ops.argsArray[0] = ['#ffffff']
  if (control === 'wrong stroke width') ops.argsArray[1] = [20]
  if (control === 'ambiguous caption') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'opaque donor') donor.opaque = { retained: true }
  if (control === 'linked row') f.table.rows[1].identity = 'do not duplicate'
  if (control === 'rich donor') donor.textRuns = [{ text: donor.text, position: 'superscript' }]
  if (control === 'noncloneable header') f.table.cells[0].opaque = () => undefined
  const before = control === 'noncloneable header' ? undefined : structuredClone(f)
  expect(recoverMeasuredFourFieldRecords(f)).toBeUndefined()
  if (before) expect(f).toEqual(before)
  else expect(typeof f.table.cells[0].opaque).toBe('function')
})

it('recovers measured four-field continuation and terminal owners with whole peer payloads', () => {
  const f = measuredFourFieldRecords(),
    before = structuredClone(f)
  expect(recoverMeasuredFourFieldRecords(f) ?? f.table).toEqual(f.expected)
  expect(f).toEqual(before)
})

it.each([
  'missing font',
  'missing stream',
  'competing stream',
  'incomplete program',
  'unknown glyph',
  'zero glyph width',
  'clip',
  'eoClip',
  'gState',
  'white text',
  'missing paint',
  'foreign paint',
  'true blank',
  'opaque scaffold',
  'opaque donor',
  'manual donor',
  'rich donor',
  'opaque normal run',
  'crossing span',
  'missing slot',
  'null cell',
  'invalid slot',
  'missing sourceRects',
  'notes',
  'parts',
  'rotation',
  'missing context',
  'missing serializer viewport',
  'ambiguous caption',
  'invalid caption',
  'invalid font',
  'invalid rule',
  'outside donor',
  'linked terminal row'
])('refuses measured four-field recovery with %s', (control) => {
  const f = measuredFourFieldRecords(),
    donor = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 2 && c.column === 2),
    terminal = f.table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 6 && c.column === 2
    ),
    stream = f.runs.find((r: ReturnType<typeof JSON.parse>) => r.text === 'tail'),
    raw = f.operatorContext.operators.argsArray[stream.glyphRuns[0]][0]
  if (control === 'missing font') f.items.pop()
  if (control === 'missing stream') f.runs.pop()
  if (control === 'competing stream')
    f.runs.push({ ...structuredClone(stream), height: stream.height + 1 })
  if (control === 'incomplete program') stream.glyphRuns.pop()
  if (control === 'unknown glyph') raw[0].isInFont = false
  if (control === 'zero glyph width') raw[0].width = 0
  if (['clip', 'eoClip', 'gState'].includes(control)) {
    f.operatorContext.operators.fnArray.push(
      OPS[(control === 'gState' ? 'setGState' : control) as keyof typeof OPS]
    )
    f.operatorContext.operators.argsArray.push(control === 'gState' ? [[['ca', 0]]] : null)
  }
  if (control === 'white text') {
    f.operatorContext.operators.fnArray.unshift(OPS.setFillRGBColor)
    f.operatorContext.operators.argsArray.unshift(['#ffffff'])
    for (const r of f.runs) r.glyphRuns = r.glyphRuns.map((n: number) => n + 1)
  }
  if (control === 'missing paint') f.paint.pop()
  if (control === 'foreign paint') f.graphics.push({ kind: 'path', rect: [100, 90, 120, 95] })
  if (control === 'true blank') {
    terminal.sourceTokens = []
    terminal.sourceRects = []
    terminal.text = ''
    f.table.grid[6][2] = ''
  }
  if (control === 'opaque scaffold')
    f.table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 3 && c.column === 0
    ).identity = 'retain'
  if (control === 'opaque donor') donor.identity = 'retain'
  if (control === 'manual donor') donor.origin = 'manual'
  if (control === 'rich donor') donor.textRuns = [{ text: donor.text, position: 'superscript' }]
  if (control === 'opaque normal run')
    donor.textRuns = [{ text: donor.text, position: 'normal', identity: 'retain' }]
  if (control === 'crossing span') f.table.cells[4].rowSpan = 2
  if (control === 'missing slot') f.table.cells.pop()
  if (control === 'null cell') f.table.cells[0] = null
  if (control === 'invalid slot') f.table.cells[0].column = -1
  if (control === 'missing sourceRects') donor.sourceRects = undefined
  if (control === 'notes') f.table.notes.push({ text: 'original note' })
  if (control === 'parts') f.table.parts.push({})
  if (control === 'rotation') f.table.readingRotation = 90
  if (control === 'missing context') f.operatorContext = undefined
  if (control === 'missing serializer viewport') f.table.sourceViewport = undefined
  if (control === 'ambiguous caption') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'invalid caption') f.captions.push(null)
  if (control === 'invalid font') f.items[0].rect[0] = NaN
  if (control === 'invalid rule') f.rules.push([NaN, 30, 420, 30])
  if (control === 'outside donor') donor.rect[1] = f.table.cropRect[1] - 1
  if (control === 'linked terminal row') f.table.rows[6].identity = 'retain'
  const before = structuredClone(f)
  expect(recoverMeasuredFourFieldRecords(f)).toBeUndefined()
  expect(f).toEqual(before)
})

// Complete horizontal rule triples and explicit native part labels qualify this family.
const anonymousStackedParts = (): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = [],
    runs: ReturnType<typeof JSON.parse>[] = [],
    rules: number[][] = [],
    paint: [string, number[]][] = [],
    graphics: ReturnType<typeof JSON.parse>[] = [],
    operators: { fnArray: number[]; argsArray: ReturnType<typeof JSON.parse>[] } = {
      fnArray: [],
      argsArray: []
    },
    content = {
      items: [] as ReturnType<typeof JSON.parse>[],
      styles: {
        'neutral-font': { fontFamily: 'sans-serif', ascent: 0.7, descent: -0.2, vertical: false }
      }
    }
  const viewport = {
      viewBox: [0, 0, 600, 500],
      scale: 1,
      rotation: 0,
      width: 600,
      height: 500,
      transform: [1, 0, 0, -1, 0, 500]
    },
    op = (f: number, a: ReturnType<typeof JSON.parse>): number => {
      operators.fnArray.push(f)
      operators.argsArray.push(a)
      return operators.fnArray.length - 1
    }
  const font = (
    text: string,
    x: number,
    baseline: number,
    h = 10,
    colorSplit = false
  ): ReturnType<typeof JSON.parse> => {
    const packet = [...text].map((c) =>
      /\s/u.test(c)
        ? -500
        : {
            originalCharCode: c.codePointAt(0),
            fontChar: c,
            unicode: c,
            accent: null,
            width: 400,
            isSpace: false,
            isInFont: true
          }
    )
    const width = packet.reduce(
      (n, g) => n + ((typeof g === 'number' ? -g : g.width) * h) / 1000,
      0
    )
    const t = { text, rect: [x, baseline - h, x + width, baseline], baseline, height: h }
    items.push({ ...t, horizontal: true, inlineSymbol: false })
    content.items.push({
      str: text,
      fontName: 'neutral-font',
      transform: [h, 0, 0, h, x, 500 - baseline],
      width,
      height: h,
      hasEOL: true
    })
    op(OPS.beginText, null)
    op(OPS.setFont, ['neutral-font', h])
    op(OPS.setTextMatrix, [1, 0, 0, 1, x, 500 - baseline])
    if (colorSplit) {
      const cut = Math.floor(packet.length / 3)
      op(OPS.showText, [packet.slice(0, cut)])
      op(OPS.setFillRGBColor, ['#0000ff'])
      op(OPS.showText, [packet.slice(cut, cut * 2)])
      op(OPS.setFillRGBColor, ['#000000'])
      op(OPS.showText, [packet.slice(cut * 2)])
    } else {
      const index = op(OPS.showText, [packet]),
        literalGlyphs = [...text.replace(/\s/gu, '')]
      runs.push({ ...t, gaps: [], literalGlyphs, glyphRuns: literalGlyphs.map(() => index) })
    }
    op(OPS.endText, null)
    return t
  }
  const cell = (
    row: number,
    column: number,
    tokens: ReturnType<typeof JSON.parse>[],
    rect: number[]
  ): ReturnType<typeof JSON.parse> => ({
    row,
    column,
    rowSpan: 1,
    colSpan: 1,
    rect,
    origin: 'model-grid',
    text: tokens.map((t) => t.text).join(' '),
    sourceTokens: tokens,
    sourceRects: tokens.map((t) => t.rect)
  })
  const captionFont = font(
    'Table 6: Samples. (a) Items by category; (b) Records by label.',
    20,
    32,
    10,
    true
  )
  const captions = [{ page: 1, lines: [captionFont.text], rect: captionFont.rect }]
  const ua = font('(a) Items by category', 40, 52),
    ub = font('(b) Records by label', 42, 212)
  const upperHeads = [font('Kind', 40, 66), font('Detail', 180, 66), font('Count', 420, 66)],
    upper = []
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 3; col++) {
      const tokens =
        row === 0
          ? col === 0
            ? [ua, upperHeads[0]]
            : [upperHeads[col]]
          : [
              font(
                col === 0 ? 'P' + row : col === 1 ? 'neutral item' : 20 + row + ' / 5',
                [40, 180, 420][col],
                96 + (row - 1) * 24
              )
            ]
      upper.push(
        cell(row, col, tokens, [
          [30, 150, 400][col],
          row ? 80 + (row - 1) * 24 : 42,
          [150, 400, 570][col],
          row ? 104 + (row - 1) * 24 : 79
        ])
      )
    }
  const lh = [
      font('Label', 42, 232),
      font('Meaning', 170, 232),
      font('Rule', 415, 232),
      font('n', 510, 232)
    ],
    sub = font('t', lh[3].rect[2], 233.5, 7),
    lower = []
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 4; col++) {
      const tokens =
        row === 0
          ? col === 1
            ? [ub, lh[1]]
            : col === 3
              ? [lh[3], sub]
              : [lh[col]]
          : [
              font(
                col === 0
                  ? 'R' + row + (row === 4 ? ' link' : '')
                  : col === 1
                    ? row === 4
                      ? 'entry links'
                      : 'neutral value'
                    : col === 2
                      ? row === 4
                        ? 'none'
                        : 'J' + row
                      : String(20 + row),
                [42, 170, 415, 510][col],
                260 + (row - 1) * 30
              )
            ]
      const c = cell(row, col, tokens, [
        [32, 150, 400, 495][col],
        row ? 244 + (row - 1) * 30 : 201,
        [150, 400, 495, 568][col],
        row ? (row === 4 ? 354 : 274 + (row - 1) * 30) : 239
      ])
      if (row === 0 && col === 3) {
        c.text = 'nt'
        c.textRuns = [
          { text: 'n', position: 'normal' },
          { text: 't', position: 'subscript' }
        ]
      }
      lower.push(c)
    }
  lower.push(
    cell(5, 0, [font('tail', 42, 365)], [32, 355, 150, 368]),
    cell(5, 1, [font('with peer', 170, 365)], [150, 355, 400, 368]),
    cell(5, 2, [], [400, 355, 495, 368]),
    cell(5, 3, [], [495, 355, 568, 368])
  )
  font('Neutral note outside both bodies.', 40, 399, 8)
  font('A second complete source note.', 40, 411, 8)
  font('1', 298, 460, 12)
  for (const [left, right, ys] of [
    [40, 560, [40, 80, 190]],
    [42, 558, [198, 240, 385]]
  ] as [number, number, number[]][])
    for (const y of ys) {
      const rule = [left, y, right, y]
      rules.push(rule)
      paint.push([rule.join(','), [left, y - 0.25, right, y + 0.25]])
      graphics.push({ kind: 'path', rect: [left, y - 0.25, right, y + 0.25] })
      op(OPS.save, null)
      op(OPS.transform, [1, 0, 0, 1, left, 500 - y])
      op(OPS.setDash, [[], 0])
      op(OPS.setLineCap, [0])
      op(OPS.setLineWidth, [0.5])
      op(OPS.constructPath, [
        OPS.stroke,
        [new Float32Array([0, 0, 0, 1, right - left, 0])],
        new Float32Array([0, 0, right - left, 0])
      ])
      op(OPS.restore, null)
    }
  const grid = (cells: ReturnType<typeof JSON.parse>[]): string[][] =>
    Array.from({ length: Math.max(...cells.map((c) => c.row)) + 1 }, (_r, row) =>
      cells.filter((c) => c.row === row).map((c) => c.text)
    )
  const sourceViewport = { width: 600, height: 500, scale: 1 },
    table = {
      id: 'neutral-upper',
      page: 1,
      cropRect: [30, 39, 570, 191],
      cells: upper,
      grid: grid(upper),
      unassigned: [],
      clipped: [],
      issues: [],
      notes: [],
      caption: captions[0],
      sourceViewport
    },
    other = {
      id: 'neutral-lower',
      cropRect: [32, 199, 568, 387],
      cells: lower,
      grid: grid(lower),
      unassigned: [],
      clipped: [],
      issues: ['text-crosses-crop-boundary']
    }
  return {
    table,
    items,
    captions,
    rules,
    runs,
    refined: [table, other],
    context: { operators, content, viewport, paint, graphics, refined: [table, other] },
    expectedWholeUpper: upper.slice(1),
    expectedLowerCells: 20
  }
}

const recoverStackedSharedCaption = (
  f: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> => {
  const context = {
    operators: f.context.operators,
    content: f.context.content,
    viewport: f.context.viewport,
    rulePaintBounds: new Map(f.context.paint),
    nativeEvidenceGraphics: f.context.graphics
  }
  const recover = lateFencedGroupHelpers.recoverNativeStackedSharedCaptionParts
  return recover
    ? recover(f.table, f.items, f.captions, f.rules, f.runs, f.refined, context)
    : panelRefineHelpers.recoverNativeIndependentPanelParts(
        f.table,
        f.items,
        f.captions,
        f.rules,
        f.runs
      )
}
it('retains explicitly named stacked bodies with separate native leaf records', () => {
  const f = anonymousStackedParts(),
    before = structuredClone(f),
    result = recoverStackedSharedCaption(f)
  expect(
    result?.parts?.map((p: ReturnType<typeof JSON.parse>) => [
      p.grid.length,
      p.grid[0].length,
      p.cells.length
    ])
  ).toEqual([
    [5, 3, 15],
    [5, 4, 20]
  ])
  expect(result.parts[0].cells.slice(1)).toEqual(f.table.cells.slice(1))
  expect(result.parts[0].cells[0].text).toBe('Kind')
  expect(result.parts[1].cells[1].text).toBe('Meaning')
  expect(
    result.parts[1].cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 4 && c.column === 0)
      .text
  ).toBe('R4 link tail')
  expect(
    result.parts[1].cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 4 && c.column === 1)
      .text
  ).toBe('entry links with peer')
  expect(result.parts[1].cells[3].textRuns).toEqual(f.refined[1].cells[3].textRuns)
  expect(f).toEqual(before)
})

it('preserves and reassigns native item origins for stacked subtitles and wrapped donors', () => {
  const f = anonymousStackedParts()
  for (const [index, item] of f.items.entries())
    item.sourceItem = { pageNumber: 1, index, text: item.text }
  const origins = (tokens: ReturnType<typeof JSON.parse>[]): ReturnType<typeof JSON.parse>[] =>
    tokens
      .map((t) => {
        const font = f.items.find(
          (i: ReturnType<typeof JSON.parse>) =>
            i.text === t.text && i.rect.every((v: number, n: number) => v === t.rect[n])
        )
        expect(font).toBeDefined()
        return font.sourceItem
      })
      .sort((a, b) => a.index - b.index)
  for (const table of f.refined)
    for (const cell of table.cells)
      if (cell.sourceTokens.length) cell.sourceItems = origins(cell.sourceTokens)
  const before = structuredClone(f)
  const result = recoverStackedSharedCaption(f)
  expect(result?.parts).toHaveLength(2)
  for (const part of result.parts)
    for (const cell of part.cells)
      if (cell.sourceTokens.length) expect(cell.sourceItems).toEqual(origins(cell.sourceTokens))
  expect(result.parts[0].cells.slice(1)).toEqual(f.table.cells.slice(1))
  expect(f).toEqual(before)
})
it.each([
  'conflicting text',
  'duplicate origin',
  'unsorted origins',
  'empty scaffold',
  'unsafe index',
  'blank origin',
  'opaque origin'
])('refuses invalid stacked native item origins: %s', (kind) => {
  const f = anonymousStackedParts()
  for (const [index, item] of f.items.entries())
    item.sourceItem = { pageNumber: 1, index, text: item.text }
  for (const table of f.refined)
    for (const cell of table.cells)
      if (cell.sourceTokens.length)
        cell.sourceItems = cell.sourceTokens
          .map((t: ReturnType<typeof JSON.parse>) => ({
            ...f.items.find(
              (i: ReturnType<typeof JSON.parse>) =>
                i.text === t.text && i.rect.every((v: number, n: number) => v === t.rect[n])
            ).sourceItem
          }))
          .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
  const donor = f.table.cells[0]
  if (kind === 'conflicting text') donor.sourceItems[0].text = 'Other source text'
  if (kind === 'duplicate origin') donor.sourceItems.push({ ...donor.sourceItems[0] })
  if (kind === 'unsorted origins') donor.sourceItems.reverse()
  if (kind === 'empty scaffold') f.refined[1].cells.at(-1).sourceItems = []
  if (kind === 'unsafe index') {
    donor.sourceItems[0].index = Number.MAX_SAFE_INTEGER + 1
    f.items.find(
      (i: ReturnType<typeof JSON.parse>) => i.text === donor.sourceItems[0].text
    ).sourceItem.index = Number.MAX_SAFE_INTEGER + 1
  }
  if (kind === 'blank origin') {
    const text = donor.sourceItems[0].text
    donor.sourceItems[0].text = ' '
    f.items.find((i: ReturnType<typeof JSON.parse>) => i.text === text).sourceItem.text = ' '
  }
  if (kind === 'opaque origin') donor.sourceItems[0].unprovedOpaque = true
  const before = structuredClone(f)
  expect(recoverStackedSharedCaption(f)).toBeUndefined()
  expect(f).toEqual(before)
})
it.each([
  'upper-opaque',
  'lower-opaque',
  'nonempty-notes',
  'missing-caption',
  'missing-paint',
  'hidden-text',
  'glyph-accent',
  'unknown-donor'
])('refuses incomplete stacked source ownership: %s', (kind) => {
  const f = anonymousStackedParts()
  if (kind === 'upper-opaque') f.table.cells[0].unprovedOpaque = true
  if (kind === 'lower-opaque') f.refined[1].cells[1].unprovedOpaque = true
  if (kind === 'nonempty-notes')
    f.table.notes = [{ text: 'Neutral note', rect: [40, 391, 200, 399] }]
  if (kind === 'missing-caption') f.captions = []
  if (kind === 'missing-paint') f.context.paint.pop()
  if (kind === 'hidden-text') {
    f.context.operators.fnArray.push(OPS.setTextRenderingMode)
    f.context.operators.argsArray.push([3])
  }
  if (kind === 'glyph-accent') {
    const index = f.context.operators.fnArray.indexOf(OPS.showText)
    f.context.operators.argsArray[index][0][0].accent = { fontChar: 'x', offset: { x: 0, y: 0 } }
  }
  if (kind === 'unknown-donor') f.refined[1].cells[20].unprovedOpaque = true
  const before = structuredClone(f)
  expect(recoverStackedSharedCaption(f)).toBeUndefined()
  expect(f).toEqual(before)
})

// Three populated group starts and ten complete scalar peers exercise the
// late section plan after the ordinary source header has already been proved.
const anonymousSectionPeerGrid = (): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = [],
    xs = [20, 100, 160, 220, 280, 340, 400],
    header = ['Group', 'Value', 'First', 'Second', 'Third', 'Fourth', 'Fifth']
  const add = (text: string, x: number, y: number): number =>
    items.push({
      text,
      rect: [x, y - 10, x + text.length * 5, y],
      height: 10,
      baseline: y,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: items.length, text }
    })
  header.forEach((s, n) => add(s, xs[n], 34))
  const bodyYs = [56, 76, 96, 116, 136, 166, 186, 206, 226, 246, 276, 296, 316]
  for (let n = 0; n < bodyYs.length; n++) {
    const y = bodyYs[n]
    if ([0, 5, 10].includes(n)) add(['Alpha', 'Bravo', 'Delta'][[0, 5, 10].indexOf(n)], 20, y)
    for (let c = 1; c < 7; c++) add(String(11 + n + c), xs[c], y)
  }
  const cropRect = [10, 19, 450, 332],
    ys = [19, 40, ...bodyYs.map((y) => y + 10)],
    cuts = [10, 80, 145, 205, 265, 325, 385, 450]
  const table = {
    id: 'page-1-table-1',
    cropRect,
    rowCount: 14,
    columnCount: 7,
    structure: {
      objects: [
        ...ys
          .slice(1)
          .map((y, n) => ({ label: 'table row', score: 1, rect: [0, ys[n] - 19, 440, y - 19] })),
        ...cuts.slice(1).map((x, n) => ({
          label: 'table column',
          score: 1,
          rect: [cuts[n] - 10, 0, x - 10, 313]
        })),
        { label: 'table column header', score: 1, rect: [0, 0, 440, 21] }
      ]
    }
  }
  return {
    items,
    table,
    captions: [{ page: 1, rect: [10, 0, 130, 10], lines: ['Table 1: Records.'] }],
    rules: [20, 40, 150, 260, 330].map((y) => [10, y, 450, y]),
    runs: []
  }
}

it('preserves seven physical leaves when a six-field section plan proves seven headers', () => {
  const f = anonymousSectionPeerGrid()
  const result = run(f)
  expect(result.repairs).not.toContain('native-section-scalar-peer-records-recovered')
  expect(result.grid).toHaveLength(14)
  expect(result.grid.every((row: string[]) => row.length === 7)).toBe(true)
  expect(result.grid[1]).toEqual(['Alpha', '12', '13', '14', '15', '16', '17'])
  expect(result.grid[6]).toEqual(['Bravo', '17', '18', '19', '20', '21', '22'])
  expect(result.grid[11]).toEqual(['Delta', '22', '23', '24', '25', '26', '27'])
  expect(
    result.cells
      .filter((c: ReturnType<typeof JSON.parse>) => [1, 6, 11].includes(c.row))
      .every((c: ReturnType<typeof JSON.parse>) => c.colSpan === 1)
  ).toBe(true)
  expect(characters(result.grid.flat().join(''))).toBe(
    characters(f.items.map((i: ReturnType<typeof JSON.parse>) => i.text).join(''))
  )
})

it('keeps the complete six-leaf section recovery at the same producer seam', () => {
  const f = anonymousSectionPeerGrid()
  f.items = f.items.filter(
    (i: ReturnType<typeof JSON.parse>) =>
      i.sourceItem.index !== 0 && !([56, 166, 276].includes(i.baseline) && /^\d/u.test(i.text))
  )
  const result = run(f)
  expect(result.repairs).toContain('native-section-scalar-peer-records-recovered')
  expect(result.grid).toHaveLength(14)
  expect(result.grid.every((row: string[]) => row.length === 6)).toBe(true)
  expect(result.grid[1]).toEqual(['Alpha', '', '', '', '', ''])
  expect(result.grid[2]).toEqual(['13', '14', '15', '16', '17', '18'])
  expect(characters(result.grid.flat().join(''))).toBe(
    characters(f.items.map((i: ReturnType<typeof JSON.parse>) => i.text).join(''))
  )
})

it('refuses the late section plan with an incomplete physical header', () => {
  const f = anonymousSectionPeerGrid()
  f.items = f.items.filter((i: ReturnType<typeof JSON.parse>) => i.sourceItem.index !== 6)
  const result = run(f)
  expect(result.repairs).not.toContain('native-section-scalar-peer-records-recovered')
  expect(result.grid[1]).toEqual(['Alpha', '12', '13', '14', '15', '16', '17'])
  expect(characters(result.grid.flat().join(''))).toBe(
    characters(f.items.map((i: ReturnType<typeof JSON.parse>) => i.text).join(''))
  )
})

it.each([6, 8])('does not admit the mismatched section plan through a %i-column model', (count) => {
  const f = anonymousSectionPeerGrid()
  f.table.columnCount = count
  f.table.structure.objects = f.table.structure.objects.filter(
    (o: ReturnType<typeof JSON.parse>) => o.label !== 'table column'
  )
  for (let c = 0; c < count; c++)
    f.table.structure.objects.push({
      label: 'table column',
      score: 1,
      rect: [(440 * c) / count, 0, (440 * (c + 1)) / count, 313]
    })
  const before = structuredClone(f)
  const result = run(f)
  expect(result.repairs).not.toContain('native-section-scalar-peer-records-recovered')
  expect(f).toEqual(before)
})

// The late producer receives already-complete cells plus the original raw page.
// These unequal scopes have two physical header baselines and whole annotations.
const unequalFirstBaselineGroups = (): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = [],
    cells: ReturnType<typeof JSON.parse>[] = [],
    ops: ReturnType<typeof JSON.parse> = {
      fnArray: [OPS.dependency, OPS.setLineWidth],
      argsArray: [['font'], [0.5]]
    },
    content: ReturnType<typeof JSON.parse> = {
      items: [],
      styles: { font: { ascent: 1, descent: 0, vertical: false } }
    },
    viewport = { width: 500, height: 400, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 400] },
    cuts = [20, 80, 145, 205, 265, 325, 385, 450],
    fences = [20, 48, 110, 190, 288]
  const draw = (text: string, x: number, y: number, h = 10): ReturnType<typeof JSON.parse> => {
    const sourceItem = { pageNumber: 1, index: content.items.length, text },
      token = {
        text,
        rect: [x, y - h, x + (text.length * h) / 2, y],
        height: h,
        baseline: y,
        horizontal: true,
        sourceItem
      }
    items.push(token)
    content.items.push({
      str: text,
      fontName: 'font',
      transform: [h, 0, 0, h, x, 400 - y],
      width: (text.length * h) / 2,
      height: h,
      dir: 'ltr',
      sourceItem
    })
    ops.fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    ops.argsArray.push(
      ['font', h],
      null,
      [new Float32Array([1, 0, 0, 1, x, 400 - y])],
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
    return token
  }
  const cell = (
    row: number,
    column: number,
    tokens: ReturnType<typeof JSON.parse>[],
    rect: number[]
  ): ReturnType<typeof JSON.parse> => {
    const result: ReturnType<typeof JSON.parse> = {
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect,
      text: tokens.map((t) => t.text).join(' '),
      sourceTokens: tokens.map((t) => ({
        text: t.text,
        rect: t.rect,
        baseline: t.baseline,
        height: t.height
      })),
      sourceRects: tokens.map((t) => t.rect),
      origin: 'model-grid'
    }
    if (tokens.length) result.sourceItems = tokens.map((t) => t.sourceItem)
    cells.push(result)
    return result
  }
  const title = draw('Table 1: Records.', 20, 12)
  for (let c = 0; c < 7; c++) {
    const x = [22, 100, 160, 220, 280, 340, 400][c]
    cell(
      0,
      c,
      [draw(c ? 'Field' : 'Group', x, 32), draw('unit', x, 44)],
      [cuts[c], 20, cuts[c + 1], 48]
    )
  }
  let row = 1
  const ys = [
    [64, 82, 100],
    [126, 144, 162, 180],
    [206, 224, 242, 260, 278]
  ]
  for (let g = 0; g < 3; g++)
    for (let local = 0; local < ys[g].length; local++) {
      const y = ys[g][local],
        top = local ? (ys[g][local - 1] + y - 10) / 2 : fences[g + 1],
        bottom = local === ys[g].length - 1 ? fences[g + 2] : (y + ys[g][local + 1] - 10) / 2
      cell(row, 0, local ? [] : [draw(['Alpha', 'Bravo', 'Delta'][g], 22, y)], [
        cuts[0],
        top,
        cuts[1],
        bottom
      ])
      for (let c = 1; c < 7; c++) {
        const base = draw(String(11 + row + c), [22, 100, 160, 220, 280, 340, 400][c], y),
          fonts = [base]
        if (c === 1 && local === 0) fonts.push(draw('*', base.rect[2], y - 3, 7.5))
        const out = cell(row, c, fonts, [cuts[c], top, cuts[c + 1], bottom])
        if (fonts.length > 1) {
          out.text = fonts.map((t) => t.text).join('')
          out.textRuns = [
            { text: base.text, position: 'normal' },
            { text: '*', position: 'superscript' }
          ]
        }
        out.opaquePeer = { preserve: row + c }
      }
      row++
    }
  for (const y of fences) {
    ops.fnArray.push(OPS.constructPath)
    ops.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 20, 400 - y, 1, 450, 400 - y])],
      new Float32Array([20, 400 - y, 450, 400 - y])
    ])
  }
  const rules = fences.map((y) => [20, y, 450, y]),
    paint = new Map(rules.map((r) => [r.join(','), [r[0], r[1] - 0.25, r[2], r[3] + 0.25]])),
    graphics = rules.map((r) => ({
      kind: 'path',
      rect: [r[0] - 0.25, r[1] - 0.25, r[2] + 0.25, r[3] + 0.25].map(
        (v, k) =>
          ((k < 2
            ? Math.floor((v / (k % 2 ? 400 : 500)) * 256)
            : Math.ceil((v / (k % 2 ? 400 : 500)) * 256) + 1) *
            (k % 2 ? 400 : 500)) /
          256
      )
    })),
    caption = { page: 1, rect: title.rect, lines: ['Table 1: Records.'] },
    grid = Array.from({ length: 13 }, () => Array(7).fill(''))
  for (const c of cells) grid[c.row][c.column] = c.text
  const table = {
      id: 'page-1-table-1',
      page: 1,
      cropRect: [20, 20, 450, 288],
      grid,
      cells,
      caption,
      sourceViewport: { width: 500, height: 400, scale: 1 },
      notes: [{ text: 'Keep note.' }],
      unassigned: [],
      clipped: [],
      issues: [],
      opaque: { preserve: true }
    },
    context = {
      operators: ops,
      content,
      sourceContent: content,
      viewport,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: graphics
    }
  return { table, items, captions: [caption], rules, paint, graphics, context }
}
const firstBaselineGroupOutput = (
  f: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativeFencedGroupLabels(
    f.table,
    f.items,
    f.captions,
    f.rules,
    [],
    f.paint,
    f.graphics,
    f.context
  )

// A short centered whole-font title occupies its own closed band. The model
// assigns it to an ordinary leaf; the existing final producer seam must use
// the full native packet rather than the title's words or length.
const closedSectionSource = (): ReturnType<typeof JSON.parse> => {
  const items: ReturnType<typeof JSON.parse>[] = [],
    content: ReturnType<typeof JSON.parse> = {
      items: [],
      styles: { font: { ascent: 1, descent: 0, vertical: false } }
    },
    operators: ReturnType<typeof JSON.parse> = {
      fnArray: [OPS.dependency, OPS.setLineWidth],
      argsArray: [['font'], [0.5]]
    },
    viewport = { width: 250, height: 150, scale: 1, rotation: 0, transform: [1, 0, 0, -1, 0, 150] },
    draw = (text: string, x: number, y: number): void => {
      const sourceItem = { pageNumber: 1, index: content.items.length, text }
      items.push({
        text,
        rect: [x, y - 10, x + text.length * 5, y],
        height: 10,
        baseline: y,
        horizontal: true,
        sourceItem
      })
      content.items.push({
        str: text,
        fontName: 'font',
        transform: [10, 0, 0, 10, x, 150 - y],
        height: 10,
        width: text.length * 5,
        dir: 'ltr',
        sourceItem
      })
      operators.fnArray.push(
        OPS.setFont,
        OPS.beginText,
        OPS.setTextMatrix,
        OPS.showText,
        OPS.endText
      )
      operators.argsArray.push(
        ['font', 10],
        null,
        [new Float32Array([1, 0, 0, 1, x, 150 - y])],
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
    },
    cuts = [20, 80, 140, 200],
    fences = [20, 40, 60, 80, 100]
  draw('Table 1: Values.', 20, 12)
  for (let c = 0; c < 3; c++) draw(['A', 'B', 'C'][c], cuts[c] + 4, 35)
  draw('Gamma', 94, 55)
  for (let row = 0; row < 2; row++)
    for (let c = 0; c < 3; c++) draw(String(11 + row * 3 + c), cuts[c] + 4, 75 + row * 20)
  for (const y of fences) {
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 20, 150 - y, 1, 200, 150 - y])],
      new Float32Array([20, 150 - y, 200, 150 - y])
    ])
  }
  const rules = fences.map((y) => [20, y, 200, y]),
    paint = new Map(rules.map((r) => [r.join(','), [r[0], r[1] - 0.25, r[2], r[3] + 0.25]])),
    graphics = rules.map((r) => ({
      kind: 'path',
      rect: [r[0] - 0.25, r[1] - 0.25, r[2] + 0.25, r[3] + 0.25].map(
        (v, k) =>
          ((k < 2
            ? Math.floor((v / (k % 2 ? 150 : 250)) * 256)
            : Math.ceil((v / (k % 2 ? 150 : 250)) * 256) + 1) *
            (k % 2 ? 150 : 250)) /
          256
      )
    })),
    captions = [{ page: 1, rect: items[0].rect, lines: [items[0].text] }],
    model = {
      id: 'page-1-table-1',
      cropRect: [20, 20, 200, 100],
      readingRotation: 0,
      structure: {
        objects: [
          ...cuts.slice(1).map((right, c) => ({
            label: 'table column',
            rect: [cuts[c] - 20, 0, right - 20, 80],
            score: 0.9
          })),
          ...fences.slice(1).map((bottom, r) => ({
            label: 'table row',
            rect: [0, fences[r] - 20, 180, bottom - 20],
            score: 0.9
          })),
          { label: 'table column header', rect: [0, 0, 180, 20], score: 0.9 }
        ]
      }
    },
    context = {
      operators,
      content,
      sourceContent: content,
      viewport,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: graphics
    }
  const refined = refineTable(model, items, captions, [], rules, [], undefined, paint, context)
  return {
    model,
    items,
    captions,
    rules,
    paint,
    graphics,
    context,
    table: {
      ...refined,
      page: 1,
      caption: captions[0],
      sourceViewport: { width: 250, height: 150, scale: 1 }
    }
  }
}
const closedSectionOutput = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativeFencedGroupLabels(
    f.table,
    f.items,
    f.captions,
    f.rules,
    [],
    f.paint,
    f.graphics,
    f.context
  )

it('repairs a short full-width section at the actual refine to final-group seam', () => {
  const f = closedSectionSource(),
    before = structuredClone(f.table),
    out = closedSectionOutput(f)
  expect(f.table.cells.find((c) => c.text === 'Gamma')?.colSpan).toBe(1)
  expect(out?.cells.find((c) => c.text === 'Gamma')).toMatchObject({
    column: 0,
    colSpan: 3,
    rowSpan: 1
  })
  expect(out?.cells.filter((c) => c.text !== 'Gamma')).toEqual(
    before.cells.filter((c) => c.row !== 1)
  )
  expect(out?.grid[1]).toEqual(['Gamma', '', ''])
  expect(Object.getOwnPropertyDescriptor(out.unassigned, 'reconciliationItems')).toEqual(
    Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems')
  )
  expect({ ...out, cells: before.cells, grid: before.grid }).toEqual(before)
  expect(f.table).toEqual(before)
})

it('refuses incomplete source, split title lanes, foreign donors and opaque blank metadata atomically', () => {
  for (const change of [
    (f: ReturnType<typeof JSON.parse>) => {
      f.context = {}
    },
    (f: ReturnType<typeof JSON.parse>) => {
      const a: ReturnType<typeof JSON.parse> = [...f.table.unassigned]
      Object.defineProperty(a, 'reconciliationItems', { value: [], enumerable: true })
      f.table.unassigned = a
    },
    (f: ReturnType<typeof JSON.parse>) => {
      const a: ReturnType<typeof JSON.parse> = [...f.table.unassigned]
      Object.defineProperty(a, 'reconciliationItems', { value: [structuredClone(f.items[0])] })
      f.table.unassigned = a
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells.find((c) => c.text === 'Gamma').sourceItems = {}
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells.find((c) => c.text === 'Gamma').sourceTokens = {}
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells.find((c) => c.text === 'Gamma').sourceTokens[0].opaque = { preserve: true }
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.context.operators.fnArray[0] = OPS.save
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.rules.push([100, 40, 100, 60])
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells.find((c) => c.text === 'Gamma').sourceItems[0].index++
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells.find((c) => c.row === 1 && c.column === 0).opaque = { preserve: true }
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells.find((c) => c.text === 'Gamma').textRuns = [
        { text: 'Gamma', position: 'normal', opaque: 1 }
      ]
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.captions[0].lines = ['Table 1: Value.']
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells.find((c) => c.row === 2 && c.column === 1).sourceItems[0].index++
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.cells.find((c) => c.row === 1 && c.column === 0).sourceItems = [
        { pageNumber: 1, index: 999, text: 'foreign' }
      ]
    },
    (f: ReturnType<typeof JSON.parse>) => {
      f.table.unassigned.push('Gamma')
    }
  ]) {
    const f = closedSectionSource()
    change(f)
    const before = structuredClone(f.table)
    expect(closedSectionOutput(f)).toBeUndefined()
    expect(f.table).toEqual(before)
  }
})

it('preserves cloneable title metadata and refuses nested accessor payloads without reading them', () => {
  const f = closedSectionSource(),
    donor = f.table.cells.find((c) => c.text === 'Gamma')
  donor.opaque = { preserve: ['literal'] }
  donor.textRuns = [{ text: 'Gamma', position: 'normal' }]
  const before = structuredClone(f.table),
    out = closedSectionOutput(f)
  expect(out?.cells.find((c) => c.text === 'Gamma')?.opaque).toEqual(donor.opaque)
  expect(out?.cells.find((c) => c.text === 'Gamma')?.textRuns).toEqual(donor.textRuns)
  expect(f.table).toEqual(before)
  let reads = 0
  Object.defineProperty(donor.opaque, 'foreign', {
    enumerable: true,
    get: () => {
      reads++
      return 'hidden'
    }
  })
  expect(closedSectionOutput(f)).toBeUndefined()
  expect(reads).toBe(0)
})

it('projects only first-baseline group spans across three unequal closed source scopes', () => {
  const f = unequalFirstBaselineGroups(),
    before = structuredClone(f)
  expect(
    lateFencedGroupHelpers.proveNativeCompleteRuledSourcePacket(
      f.items,
      f.rules,
      f.context,
      f.table.cropRect
    )
  ).toBe(true)
  const result = firstBaselineGroupOutput(f)
  expect(result).toBeDefined()
  expect(
    result.cells
      .filter((c: ReturnType<typeof JSON.parse>) => c.column === 0 && c.row > 0 && c.text)
      .map((c: ReturnType<typeof JSON.parse>) => c.rowSpan)
  ).toEqual([3, 4, 5])
  expect(
    result.cells.filter((c: ReturnType<typeof JSON.parse>) => c.column !== 0 || c.row === 0)
  ).toEqual(
    f.table.cells.filter((c: ReturnType<typeof JSON.parse>) => c.column !== 0 || c.row === 0)
  )
  for (const k of Object.keys(f.table))
    if (!['cells', 'grid'].includes(k)) expect(result[k]).toEqual(f.table[k])
  expect(result.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems ?? [])).toEqual(
    f.table.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems ?? [])
  )
  expect(result.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)).toEqual(
    f.table.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
  )
  expect(f).toEqual(before)
})

it('preserves pure normal label runs and cloneable label metadata during first-baseline grouping', () => {
  const f = unequalFirstBaselineGroups(),
    label = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 0)
  label.textRuns = [{ text: label.text, position: 'normal' }]
  label.opaque = { preserve: ['literal'] }
  const result = firstBaselineGroupOutput(f),
    next = result?.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 0)
  expect(next?.textRuns).toEqual(label.textRuns)
  expect(next?.opaque).toEqual(label.opaque)
})

it.each([
  'missing packet',
  'raw position',
  'foreign paint',
  'missing fence',
  'opaque blank',
  'foreign blank origin',
  'foreign origin',
  'moved label',
  'unknown label run',
  'dagger donor'
])('refuses first-baseline groups without atomic source closure: %s', (variant) => {
  const f = unequalFirstBaselineGroups(),
    ops = f.context.operators,
    label = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 0),
    blank = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 2 && c.column === 0)
  if (variant === 'missing packet') delete f.context.content
  if (variant === 'raw position') ops.argsArray[ops.fnArray.indexOf(OPS.setTextMatrix)][0][4] += 100
  if (variant === 'foreign paint') {
    ops.fnArray.push(OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    ops.argsArray.push(
      null,
      [new Float32Array([1, 0, 0, 1, 100, 300])],
      [
        [
          {
            unicode: 'x',
            fontChar: 'x',
            originalCharCode: 120,
            width: 500,
            isInFont: true,
            operatorListId: null
          }
        ]
      ],
      null
    )
  }
  if (variant === 'missing fence') f.rules.splice(2, 1)
  if (variant === 'opaque blank') blank.opaque = { preserve: true }
  if (variant === 'foreign blank origin')
    blank.sourceItems = [{ pageNumber: 1, index: 0, text: 'Table 1: Records.' }]
  if (variant === 'foreign origin') label.sourceItems[0].index = 0
  if (variant === 'moved label') {
    for (const k of ['text', 'sourceTokens', 'sourceRects', 'sourceItems']) {
      const old = label[k]
      label[k] = blank[k]
      blank[k] = old
    }
    f.table.grid[1][0] = label.text
    f.table.grid[2][0] = blank.text
  }
  if (variant === 'unknown label run')
    label.textRuns = [{ text: label.text, position: 'normal', opaque: { preserve: true } }]
  if (variant === 'dagger donor') {
    const c = f.table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 1
    )
    c.sourceItems[1].index = 0
  }
  const before = structuredClone(f)
  expect(firstBaselineGroupOutput(f)).toBeUndefined()
  expect(f).toEqual(before)
})

it('refuses a first-baseline blank accessor without evaluating or discarding it', () => {
  const f = unequalFirstBaselineGroups(),
    blank = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 2 && c.column === 0)
  let reads = 0
  const getter = (): string => {
    reads++
    return 'preserve me'
  }
  Object.defineProperty(blank, 'opaque', { enumerable: true, configurable: true, get: getter })
  expect(firstBaselineGroupOutput(f)).toBeUndefined()
  expect(reads).toBe(0)
  expect(Object.getOwnPropertyDescriptor(blank, 'opaque')?.get).toBe(getter)
})

const { collectTableRules: collectMiddleRecordRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { tableTextToken: middleRecordToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)

const anonymousMergedMiddleSource = (includeMarginRule = false): ReturnType<typeof JSON.parse> => {
  const viewport = {
      width: 900,
      height: 450,
      scale: 1.5,
      rotation: 0,
      transform: [1.5, 0, 0, -1.5, 0, 450],
      convertToViewportPoint: (x: number, y: number) => [x * 1.5, 450 - y * 1.5]
    },
    source: ReturnType<typeof JSON.parse> = {
      items: [],
      styles: { font: { ascent: 1, descent: 0, vertical: false } }
    },
    ops: ReturnType<typeof JSON.parse> = {
      fnArray: [OPS.dependency, OPS.setFillRGBColor, OPS.setLineWidth],
      argsArray: [['font'], ['#000000'], [0.5]]
    },
    cuts = [20, 110, 200, 290, 380, 470, 560]
  const draw = (str: string, x: number, y: number, h = 10): void => {
    const sourceItem = { pageNumber: 1, index: source.items.length, text: str }
    source.items.push({
      str,
      fontName: 'font',
      transform: [h, 0, 0, h, x, 300 - y],
      height: h,
      width: (str.length * h) / 2,
      dir: 'ltr',
      sourceItem
    })
    ops.fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    ops.argsArray.push(
      ['font', h],
      null,
      [new Float32Array([1, 0, 0, 1, x, 300 - y])],
      [
        [...str].map((unicode) => ({
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
  }
  draw('Table 1: Values.', 20, 30)
  for (let c = 0; c < 6; c++) draw(['Name', 'Setting', 'A', 'B', 'C', 'D'][c], cuts[c] + 4, 54)
  const record = (
    stub: string,
    condition: string,
    y: number,
    n: number,
    split = false,
    stubX = cuts[0] + 4
  ): void => {
    if (stub) draw(stub, stubX, y)
    draw(condition, cuts[1] + 4, y)
    for (let c = 2; c < 5; c++) draw(String(n + c) + '.1', cuts[c] + 4, y)
    if (split) {
      let x = cuts[5] + 4
      for (const text of ['−', '0', '.', '2%']) {
        draw(text, x, y)
        x += text.length * 5
      }
    } else draw(String(n + 5) + '.1', cuts[5] + 4, y)
  }
  record('AlphaX', 'Plain', 72, 1, false, 83.5)
  record('Beta', 'Plain', 90, 2)
  draw('Gamma', cuts[0] + 4, 126)
  record('', 'Plain', 108, 3)
  record('', 'Varied (a)', 126, 4, true)
  record('', 'Varied (b)', 144, 5)
  record('Omega', 'Plain', 162, 6)
  for (const y of includeMarginRule ? [10, 40, 58, 180] : [40, 58, 180]) {
    ops.fnArray.push(OPS.constructPath)
    ops.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 20, 300 - y, 1, 560, 300 - y])],
      new Float32Array([20, 300 - y, 560, 300 - y])
    ])
  }
  const tokens = source.items.map((i: ReturnType<typeof JSON.parse>) =>
      middleRecordToken(i, viewport, 0)
    ),
    paint = new Map(),
    rules = collectMiddleRecordRules(ops, viewport, paint),
    graphics = rules.map((r: number[]) => {
      const p = [...paint.get(r.join(','))],
        radius = (p[3] - p[1]) / 2
      p[0] -= radius
      p[2] += radius
      return {
        kind: 'path',
        rect: p.map(
          (v: number, k: number) =>
            ((k < 2
              ? Math.floor((v / (k % 2 ? 450 : 900)) * 256)
              : Math.ceil((v / (k % 2 ? 450 : 900)) * 256) + 1) *
              (k % 2 ? 450 : 900)) /
            256
        )
      }
    }),
    captions = [{ page: 1, rect: tokens[0].rect, lines: [tokens[0].text] }],
    edges = [58, 81, 97, 151, 180],
    crop = [30, 60, 840, 270],
    model = {
      id: 'page-1-table-1',
      cropRect: crop,
      readingRotation: 0,
      structure: {
        objects: [
          ...cuts.slice(1).map((right, c) => ({
            label: 'table column',
            rect: [cuts[c] * 1.5 - 30, 27, right * 1.5 - 30, 210],
            score: 0.9
          })),
          ...edges.slice(1).map((bottom, r) => ({
            label: 'table row',
            rect: [0, edges[r] * 1.5 - 60, 810, bottom * 1.5 - 60],
            score: 0.9
          }))
        ]
      }
    },
    context = {
      operators: ops,
      content: source,
      sourceContent: source,
      viewport,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: graphics
    },
    runs = measureOrdinaryPrograms(source, ops, viewport)
  const modelColumns = model.structure.objects.filter(
    (o: ReturnType<typeof JSON.parse>) => o.label === 'table column'
  )
  modelColumns[0].rect[2] = 113.75 * 1.5 - 30
  modelColumns[1].rect[0] = 113.75 * 1.5 - 30
  const refined = refineTable(model, tokens, captions, [], rules, runs, undefined, paint, context),
    table = {
      ...refined,
      page: 1,
      caption: { page: 1, rect: captions[0].rect.map((v) => v / 1.5), lines: captions[0].lines },
      sourceViewport: { width: 900, height: 450, scale: 1.5 }
    }
  return { table, tokens, captions, rules, runs, paint, graphics, context, model }
}
const middleRecordResult = (
  f: ReturnType<typeof anonymousMergedMiddleSource>
): ReturnType<typeof JSON.parse> =>
  lateFencedGroupHelpers.recoverNativeFencedGroupLabels(
    f.table,
    f.tokens,
    f.captions,
    f.rules,
    f.runs,
    f.paint,
    f.graphics,
    f.context
  )

it('restores three complete middle records through the actual producer seam', () => {
  const f = anonymousMergedMiddleSource(),
    before = structuredClone(f.table),
    out = middleRecordResult(f)
  expect(f.tokens).toHaveLength(44)
  expect(f.table.grid).toHaveLength(5)
  expect(out).toBeDefined()
  expect(out.grid).toHaveLength(7)
  expect(out.grid.slice(3, 6).map((r: string[]) => r[0])).toEqual(['', 'Gamma', ''])
  expect(
    out.cells.every((c: ReturnType<typeof JSON.parse>) => c.rowSpan === 1 && c.colSpan === 1)
  ).toBe(true)
  expect(f.table).toEqual(before)
  for (const c of f.table.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row !== 3))
    expect(
      out.cells.find(
        (t: ReturnType<typeof JSON.parse>) =>
          t.row === (c.row > 3 ? c.row + 2 : c.row) && t.column === c.column
      )
    ).toEqual({ ...c, row: c.row > 3 ? c.row + 2 : c.row })
  const fonts = (t: ReturnType<typeof JSON.parse>): string[] =>
    t.cells
      .flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceTokens)
      .map((t: ReturnType<typeof JSON.parse>) => JSON.stringify(t))
      .sort()
  expect(fonts(out)).toEqual(fonts(f.table))
  const { cells: oldCells, rows: oldRows, grid: oldGrid, ...oldMetadata } = f.table
  const { cells: newCells, rows: newRows, grid: newGrid, ...newMetadata } = out
  expect(newMetadata).toEqual(oldMetadata)
  expect(oldCells.length + 12).toBe(newCells.length)
  expect(oldRows.length + 2).toBe(newRows.length)
  expect(oldGrid.length + 2).toBe(newGrid.length)
  const witness = Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems'),
    next = Object.getOwnPropertyDescriptor(out.unassigned, 'reconciliationItems')
  expect(next).toEqual(witness)
  expect(next?.value).toBe(witness?.value)
})

it('preserves normal field runs and untouched opaque payloads when projecting middle records', () => {
  const f = anonymousMergedMiddleSource()
  f.table.foreign = { retained: [1, { value: 'safe' }] }
  f.table.rows[4].foreign = { retained: [2] }
  const unaffected = f.table.cells.find(
    (c: ReturnType<typeof JSON.parse>) => c.row === 4 && c.column === 2
  )
  unaffected.foreign = { retained: [3] }
  for (const c of f.table.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row === 3))
    c.textRuns = [{ text: c.text, position: 'normal' }]
  const out = middleRecordResult(f)
  expect(out).toBeDefined()
  expect(out.foreign).toEqual(f.table.foreign)
  expect(out.rows[6]).toEqual(f.table.rows[4])
  expect(
    out.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 6 && c.column === 2)
  ).toEqual({ ...unaffected, row: 6 })
  for (const c of out.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row >= 3 && c.row <= 5))
    expect(c.textRuns).toEqual(c.text ? [{ text: c.text, position: 'normal' }] : [])
  expect(
    out.cells
      .filter((c: ReturnType<typeof JSON.parse>) => c.column === 0 && (c.row === 3 || c.row === 5))
      .every(
        (c: ReturnType<typeof JSON.parse>) =>
          !Object.hasOwn(c, 'sourceItems') && c.sourceTokens.length === 0
      )
  ).toBe(true)
})

it.each([
  'missing packet',
  'white text',
  'unknown cell payload',
  'unknown row payload',
  'missing row rectangle',
  'invalid row rectangle',
  'unknown run payload',
  'foreign origin',
  'partial header alias',
  'body alias',
  'between baselines'
])('refuses middle-record projection with %s', (kind) => {
  const f = anonymousMergedMiddleSource(),
    cell = f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 3 && c.column === 2)
  if (kind === 'missing packet') f.context.operators = undefined
  if (kind === 'white text') f.context.operators.argsArray[1] = ['#ffffff']
  if (kind === 'unknown cell payload') cell.foreign = { scope: 'unknown' }
  if (kind === 'unknown row payload') f.table.rows[3].foreign = { scope: 'unknown' }
  if (kind === 'missing row rectangle') delete f.table.rows[3].rect
  if (kind === 'invalid row rectangle') f.table.rows[3].rect = [0, NaN, 1, 2]
  if (kind === 'unknown run payload')
    cell.textRuns = [{ text: cell.text, position: 'normal', foreign: 1 }]
  if (kind === 'foreign origin') cell.sourceItems[0].index = 9999
  if (kind === 'partial header alias')
    f.table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 0 && c.column === 0
    ).sourceTokens[0].sourceToken.text = 'Partial'
  if (kind === 'body alias')
    cell.sourceTokens[0].sourceToken = structuredClone(cell.sourceTokens[0])
  if (kind === 'between baselines')
    f.table.cells.find(
      (c: ReturnType<typeof JSON.parse>) => c.row === 3 && c.column === 0
    ).sourceTokens[0].baseline += 3
  const snapshot = structuredClone(f.table)
  expect(middleRecordResult(f)).toBeUndefined()
  expect(f.table).toEqual(snapshot)
})

it('rejects opaque accessor payloads without evaluating them for middle records', () => {
  const f = anonymousMergedMiddleSource()
  let reads = 0
  Object.defineProperty(
    f.table.cells.find((c: ReturnType<typeof JSON.parse>) => c.row === 3 && c.column === 2),
    'foreign',
    {
      enumerable: true,
      get() {
        reads++
        return 'unknown'
      }
    }
  )
  expect(middleRecordResult(f)).toBeUndefined()
  expect(reads).toBe(0)
})

it('binds complete original paint while keeping repeated margin graphics filtered for prior branches', () => {
  const f = anonymousMergedMiddleSource(true)
  expect(f.context.nativeEvidenceGraphics).toHaveLength(4)
  f.graphics = f.graphics.slice(1)
  expect(f.graphics).toHaveLength(3)
  expect(f.table.grid).toHaveLength(5)
  const out = middleRecordResult(f)
  expect(out).toBeDefined()
  expect(out.grid).toHaveLength(7)
  expect(out.cropRect).toEqual(f.table.cropRect)
  expect(out.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row === 0)).toEqual(
    f.table.cells.filter((c: ReturnType<typeof JSON.parse>) => c.row === 0)
  )
})

it.each(['missing', 'incomplete', 'contradicting'])(
  'refuses a %s complete original paint context',
  (kind) => {
    const f = anonymousMergedMiddleSource(true)
    f.graphics = f.graphics.slice(1)
    if (kind === 'missing') delete f.context.nativeEvidenceGraphics
    if (kind === 'incomplete') f.context.nativeEvidenceGraphics = f.graphics
    if (kind === 'contradicting') f.context.nativeEvidenceGraphics[0].rect[1] += 1
    const before = structuredClone(f.table)
    expect(middleRecordResult(f)).toBeUndefined()
    expect(f.table).toEqual(before)
  }
)

// Complete native glyph/paint and original owners, across two semantic rows.
const { isDeepStrictEqual: visualExact } = await import('node:util')
const { tableTextToken: visualTableToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
function visualFractionFixture(
  options: Record<string, boolean | number> = {}
): ReturnType<typeof JSON.parse> {
  const viewport = {
      scale: 1,
      rotation: 0,
      width: 220,
      height: 220,
      transform: [1, 0, 0, -1, 0, 220],
      convertToViewportPoint: (x: number, y: number): number[] => [x, 220 - y]
    },
    fnArray: number[] = [],
    argsArray: ReturnType<typeof JSON.parse>[] = [],
    items: ReturnType<typeof JSON.parse>[] = [],
    styles: Record<string, ReturnType<typeof JSON.parse>> = {},
    cells: ReturnType<typeof JSON.parse>[] = [],
    push = (c: number, a: ReturnType<typeof JSON.parse> = null): void => {
      fnArray.push(c)
      argsArray.push(a)
    }
  const deps = ['ordinary', 'script', 'tiny', 'delimiter']
  for (const f of deps)
    styles[f] = { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false }
  push(OPS.dependency, deps)
  const line = (x: number, y: number, end: number): void => {
    const py = 220 - y,
      p = new Float32Array([0, x, py, 1, end, py]),
      box = new Float32Array([x, py, end, py])
    push(OPS.setLineWidth, [0.4])
    push(OPS.constructPath, [OPS.stroke, [p], box])
  }
  line(10, 10, 196)
  line(10, 30, 196)
  line(10, 120, 196)
  if (!options.footerAfterWholeComponent) line(10, 212, 196)
  const specs: [string, number, number, number, string, number | null, number | null, number?][] = [
    ['label', 20, 55, 10, 'ordinary', 0, 0],
    ['value', 100, 55, 10, 'ordinary', 0, 1],
    ['item', 20, (options.ordinaryBaseline as number) ?? 159, 10, 'ordinary', 1, 0],
    ['ordinary', 150, options.ordinaryBaseline ?? 159, 10, 'ordinary', 1, 1, 45],
    ['symbol', 20, 185, 10, 'ordinary', 2, 0],
    ['v', 100, 185, 10, 'ordinary', 2, 1],
    ['[', 108, 165, 10, 'delimiter', 1, 1, 4],
    ['1', 114, 185, 10, 'ordinary', 2, 1, 5],
    ['−', 120, 185, 10, 'ordinary', 2, 1, 5],
    ['(', 129, 170, 10, 'delimiter', 1, 1, 5],
    ['1', 134, 185, 10, 'ordinary', 2, 1, 5],
    ['−', 140, 185, 10, 'ordinary', 2, 1, 5],
    ['u', 154, 177, 6.8, 'script', 2, 1, 4],
    ['−', 158, 177, 6.8, 'script', 2, 1, 4],
    ['u', 162, 177, 6.8, 'script', 2, 1, 4],
    ['i', 166, 178, 4.8, 'tiny', 2, 1, 10],
    ['u', 149, 191, 6.8, 'script', 2, 1, 4],
    ['j', 153, 192, 4.8, 'tiny', 2, 1, 8],
    ['−', 162, 191, 6.8, 'script', 2, 1, 5],
    ['u', 167, 191, 6.8, 'script', 2, 1, 4],
    ['i', 171, 192, 4.8, 'tiny', 2, 1, 8],
    [')', 180, options.mismatchedPair ? 171 : 170, 10, 'delimiter', null, null, 5],
    ['5', 185, (options.exponentBaseline as number) ?? 172, 6.8, 'script', null, null, 3.4],
    [']', 189, 165, 10, 'delimiter', null, null, 4]
  ]
  if (options.foreignFont) specs.push(['x', 191, 80, 10, 'ordinary', null, null, 3])
  if (options.secondPair)
    specs.push(['[', 120, 95, 10, 'delimiter', 0, 1, 4], [']', 145, 95, 10, 'delimiter', 0, 1, 4])
  push(OPS.beginText)
  for (let n = 0; n < specs.length; n++) {
    if (n === 16) {
      push(OPS.endText)
      line(149, 180, 179)
      if (options.secondFraction) line(149, 140, 179)
      if (options.foreignPath) line(185, 80, 194)
      push(OPS.beginText)
    }
    const [text, x, baseline, height, font, row, column, width = text.length * 4] = specs[n],
      index = items.length,
      origin = { pageNumber: 1, index, text },
      raw = {
        str: text,
        dir: 'ltr',
        width,
        height,
        transform: [height, 0, 0, height, x, 220 - baseline],
        fontName: font,
        hasEOL: false,
        sourceItem: origin
      }
    items.push(raw)
    push(OPS.setFont, [font, height])
    push(OPS.setTextMatrix, [1, 0, 0, 1, x, 220 - baseline])
    push(OPS.showText, [
      [...text].map((char) => ({
        unicode: char,
        fontChar: char,
        originalCharCode: char.codePointAt(0),
        width: (width / text.length / height) * 1000,
        isInFont: true,
        accent: null
      }))
    ])
    if (row !== null) {
      let cell = cells.find((c) => c.row === row && c.column === column)
      if (!cell)
        cells.push(
          (cell = {
            row,
            column,
            rowSpan: 1,
            colSpan: 1,
            text: '',
            sourceItems: [],
            sourceRects: []
          })
        )
      cell.text += (cell.text ? ' ' : '') + text
      cell.sourceItems.push(origin)
      cell.sourceRects.push([x, baseline - height, x + width, baseline])
    }
  }
  push(OPS.endText)
  if (options.footerAfterWholeComponent) {
    if (options.interposedFooterPath) line(70, 3, 80)
    if (options.foreignFooterPaint) line(20, 209, 100)
    if (options.interposedFooterFont || options.foreignFooterFont) {
      const baseline = options.foreignFooterFont ? 209 : 3,
        str = 'x',
        sourceItem = { pageNumber: 1, index: items.length, text: str }
      items.push({
        str,
        dir: 'ltr',
        width: 3,
        height: 2,
        transform: [2, 0, 0, 2, 70, 220 - baseline],
        fontName: 'ordinary',
        hasEOL: false,
        sourceItem
      })
      push(OPS.beginText)
      push(OPS.setFont, ['ordinary', 2])
      push(OPS.setTextMatrix, [1, 0, 0, 1, 70, 220 - baseline])
      push(OPS.showText, [
        [
          {
            unicode: 'x',
            fontChar: 'x',
            originalCharCode: 120,
            width: 1500,
            isInFont: true,
            accent: null
          }
        ]
      ])
      push(OPS.endText)
    }
    line(10, 212, 196)
    if (options.secondFooter) line(10, 216, 196)
  }
  const operators = { fnArray, argsArray },
    content = { items, styles },
    paint = new Map(),
    rules = lateRules(operators, viewport, paint),
    fonts = items.map((i) => ({
      ...visualTableToken(i, viewport, 0),
      fontDescent: styles[i.fontName].descent
    })),
    graphics = [...paint.values()].map((b) => ({
      kind: 'path',
      rect: b.map(
        (v, k) =>
          ((k < 2 ? Math.floor((v / 220) * 256) : Math.ceil((v / 220) * 256) + 1) * 220) / 256
      )
    })),
    context = {
      content,
      sourceContent: content,
      operators,
      viewport,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: graphics
    },
    table: ReturnType<typeof JSON.parse> = {
      cropRect: [5, 5, 172, 206],
      cells,
      grid: [
        ['label', 'value'],
        ['item', 'ordinary [ ('],
        ['symbol', 'v 1 − 1 − u−ui uj−ui']
      ],
      unassigned: [],
      opaque: { retained: true }
    },
    candidate = [5, 5, 196.5, 206]
  for (const c of cells) table.grid[c.row][c.column] = c.text
  for (const c of cells)
    c.sourceTokens = c.sourceItems
      .map((o: ReturnType<typeof JSON.parse>) => {
        const f = fonts.find((f) => visualExact(f.sourceItem, o))
        return { text: f.text, rect: f.rect, baseline: f.baseline, height: f.height }
      })
      .reverse()
  if (options.badTokenHeight) cells.at(-1).sourceTokens[0].height += 0.01
  if (options.duplicateToken) cells.at(-1).sourceTokens[0] = cells.at(-1).sourceTokens[1]
  if (options.missingToken) cells.at(-1).sourceTokens.pop()
  if (options.foreignTokenOrigin)
    cells.at(-1).sourceTokens[0].sourceItem = {
      pageNumber: 1,
      index: 999,
      text: cells.at(-1).sourceTokens[0].text
    }
  if (options.unknownToken) cells.at(-1).sourceTokens[0].unknownFontMetric = 1
  if (options.horizontalToken) cells.at(-1).sourceTokens[0].horizontal = false
  if (options.badRow) cells.at(-1).row = -1
  if (options.outOfGridRow) cells.at(-1).row = table.grid.length
  if (options.badColumn) cells.at(-1).column = -1
  if (options.outOfGridColumn) cells.at(-1).column = table.grid[0].length
  if (options.badSpan) cells.at(-1).colSpan = 0
  if (options.outOfGridSpan) cells.at(-1).rowSpan = 2
  if (options.unsafeRow) cells.at(-1).row = Number.MAX_SAFE_INTEGER + 1
  if (options.raggedGrid) table.grid[0].pop()
  if (options.holeGrid) delete table.grid[1][1]
  if (options.gridTextMismatch) table.grid.at(-1)[1] = 'foreign'
  if (options.cropOpaque) table.cropRect.unknownDiagnostic = { preserved: true }
  if (options.cropHidden)
    Object.defineProperty(table.cropRect, 'hiddenDiagnostic', {
      value: { preserved: true },
      enumerable: false
    })
  if (options.candidateOpaque) candidate.unknownDiagnostic = true
  const rc = fonts
    .filter((f) =>
      cells.some((c) =>
        c.sourceItems.some((o: ReturnType<typeof JSON.parse>) => visualExact(o, f.sourceItem))
      )
    )
    .map((f) => ({
      text: f.text,
      sourceItem: f.sourceItem,
      rect: f.rect,
      baseline: f.baseline,
      height: f.height,
      horizontal: f.horizontal,
      inlineSymbol: f.inlineSymbol
    }))
  if (options.missingRecon) rc.pop()
  if (options.duplicateRecon) rc[0] = rc[1]
  if (options.foreignRecon) rc[0].sourceItem = { ...rc[0].sourceItem, index: 999 }
  if (options.metricRecon) rc[0].fontDescent = 1
  if (options.unknownRecon) rc[0].unknownFontMetric = 1
  Object.defineProperty(table.unassigned, 'reconciliationItems', {
    value: rc,
    writable: false,
    enumerable: false,
    configurable: false
  })
  if (options.crossLeaf)
    cells
      .find((c) => c.row === 1 && c.column === 1)
      .sourceItems.forEach((o: ReturnType<typeof JSON.parse>, n: number) => {
        if (o.text === '[') {
          const f = fonts.find((f) => visualExact(f.sourceItem, o))
          cells.find((c) => c.row === 1 && c.column === 0).sourceItems.push(o)
          cells.find((c) => c.row === 1 && c.column === 0).sourceRects.push(f.rect)
          cells.find((c) => c.row === 1 && c.column === 1).sourceItems.splice(n, 1)
          cells.find((c) => c.row === 1 && c.column === 1).sourceRects.splice(n, 1)
        }
      })
  if (options.duplicateSource) {
    cells[0].sourceItems.push(cells[0].sourceItems[0])
    cells[0].sourceRects.push(cells[0].sourceRects[0])
  }
  if (options.foreignOrigin) cells[0].sourceItems[0] = { ...cells[0].sourceItems[0], index: 999 }
  if (options.removeSource) {
    cells[0].sourceItems.splice(0, 1)
    cells[0].sourceRects.splice(0, 1)
  }
  if (options.rawConversion) {
    const terminal = items.find((i) => i.str === '5'),
      opIndex = argsArray.findIndex(
        (a, n) => fnArray[n] === OPS.showText && a[0][0]?.unicode === '5'
      )
    terminal.str = '５'
    terminal.sourceItem.text = '５'
    argsArray[opIndex][0][0].unicode = '5'
  }
  if (options.mask) push(OPS.setGState, [[['ca', 0]]])
  return { table, fonts, rules, context, candidate }
}
const visualCropOutput = (f: ReturnType<typeof JSON.parse>): number[] | undefined =>
  lateFencedGroupHelpers.recoverNativeVisualFractionCrop?.(f.table, f.fonts, f.rules, f.context)

it('completes a uniquely owned native fraction crop without changing semantic owners', () => {
  const f = visualFractionFixture(),
    before = structuredClone(f.table),
    descriptor = Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems'),
    value = structuredClone(descriptor?.value)
  expect(visualCropOutput(f)).toEqual([5, 5, 196.5, 206])
  expect(f.table).toEqual(before)
  expect(Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems')).toEqual(
    descriptor
  )
  expect(descriptor?.value).toEqual(value)
  expect(
    f.table.cells
      .find((c: ReturnType<typeof JSON.parse>) => c.row === 1 && c.column === 1)
      .sourceItems.some((i: ReturnType<typeof JSON.parse>) => i.text === '[')
  ).toBe(true)
  expect(
    f.table.cells
      .find((c: ReturnType<typeof JSON.parse>) => c.row === 2 && c.column === 1)
      .sourceItems.some((i: ReturnType<typeof JSON.parse>) => i.text === 'u')
  ).toBe(true)
})

it.each([
  ['native-second-fraction', { secondFraction: true }],
  ['missing-reconciliation-item', { missingRecon: true }],
  ['duplicate-reconciliation-item', { duplicateRecon: true }],
  ['foreign-reconciliation-origin', { foreignRecon: true }],
  ['supplied-reconciliation-metric-conflict', { metricRecon: true }],
  ['unknown-reconciliation-provider-field', { unknownRecon: true }],
  ['old-crop-opaque-payload', { cropOpaque: true }],
  ['old-crop-hidden-payload', { cropHidden: true }],
  ['negative-row', { badRow: true }],
  ['out-of-grid-row', { outOfGridRow: true }],
  ['negative-column', { badColumn: true }],
  ['out-of-grid-column', { outOfGridColumn: true }],
  ['zero-span', { badSpan: true }],
  ['span-exceeds-grid', { outOfGridSpan: true }],
  ['unsafe-integer-row', { unsafeRow: true }],
  ['ragged-grid', { raggedGrid: true }],
  ['hole-in-grid', { holeGrid: true }],
  ['grid-cell-text-mismatch', { gridTextMismatch: true }],
  ['native-other-record-in-component-band', { ordinaryBaseline: 175 }],
  ['internal-token-wrong-height', { badTokenHeight: true }],
  ['internal-token-duplicate', { duplicateToken: true }],
  ['internal-token-missing', { missingToken: true }],
  ['internal-token-foreign-origin', { foreignTokenOrigin: true }],
  ['internal-token-unknown-field', { unknownToken: true }],
  ['internal-token-horizontal-conflict', { horizontalToken: true }],
  ['native-exponent-far-above', { exponentBaseline: 80 }],
  ['native-exponent-below-component', { exponentBaseline: 202 }],
  ['native-foreign-strip-font', { foreignFont: true }],
  ['native-foreign-strip-path', { foreignPath: true }],
  ['native-second-delimiter-pair', { secondPair: true }],
  ['native-mismatched-delimiter-y', { mismatchedPair: true }],
  ['claimed-opening-other-leaf', { crossLeaf: true }],
  ['duplicate-native-source-claim', { duplicateSource: true }],
  ['foreign-native-source-origin', { foreignOrigin: true }],
  ['missing-native-source-claim', { removeSource: true }],
  ['unknown-width-character-conversion', { rawConversion: true }],
  ['transparent-paint-state', { mask: true }]
] as [string, Record<string, boolean | number>][])(
  'refuses a native fraction visual crop with %s',
  (name, options) => {
    const f = visualFractionFixture(options),
      before = structuredClone(f.table)
    expect(visualCropOutput(f)).toBeUndefined()
    expect(f.table).toEqual(before)
  }
)

it('refuses native crop getters before reading the original rectangle', () => {
  const f = visualFractionFixture(),
    crop = f.table.cropRect
  let reads = 0
  Object.defineProperty(f.table, 'cropRect', {
    get() {
      reads++
      return crop
    },
    configurable: true
  })
  expect(visualCropOutput(f)).toBeUndefined()
  expect(reads).toBe(0)
})

it.each([
  ['grid', false],
  ['grid', true],
  ['cells', false],
  ['cells', true],
  ['unassigned', false],
  ['unassigned', true]
] as [string, boolean][])(
  'refuses native visual table %s accessors without reading them (throw=%s)',
  (field, throws) => {
    const f = visualFractionFixture({ footerAfterWholeComponent: true }),
      value = f.table[field]
    let reads = 0
    Object.defineProperty(f.table, field, {
      get() {
        reads++
        if (throws) throw new Error('native visual table accessor read')
        return value
      },
      configurable: true
    })
    expect(
      lateFencedGroupHelpers.proveNativeCompleteRuledSourcePacket(
        f.fonts,
        f.rules,
        f.context,
        f.candidate
      )
    ).toBe(true)
    expect(visualCropOutput(f)).toBeUndefined()
    expect(reads).toBe(0)
    expect(Object.getOwnPropertyDescriptor(f.table, field)?.get).toBeTypeOf('function')
  }
)

it('completes only the measured closing-rule paint after a whole native visual component', () => {
  const f = visualFractionFixture({ footerAfterWholeComponent: true }),
    before = structuredClone(f.table),
    descriptor = Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems'),
    value = structuredClone(descriptor?.value)
  expect(visualCropOutput(f)).toEqual([5, 5, 196.5, 212.2])
  expect(f.table).toEqual(before)
  expect(Object.getOwnPropertyDescriptor(f.table.unassigned, 'reconciliationItems')).toEqual(
    descriptor
  )
  expect(descriptor?.value).toEqual(value)
})

it.each([
  'secondFooter',
  'foreignFooterPaint',
  'foreignFooterFont',
  'interposedFooterPath',
  'interposedFooterFont'
])('keeps the qualified right-only crop when footer evidence has %s', (kind) => {
  const f = visualFractionFixture({ footerAfterWholeComponent: true, [kind]: true }),
    before = structuredClone(f.table)
  expect(
    lateFencedGroupHelpers.proveNativeCompleteRuledSourcePacket(
      f.fonts,
      f.rules,
      f.context,
      f.candidate
    )
  ).toBe(true)
  expect(visualCropOutput(f)).toEqual([5, 5, 196.5, 206])
  expect(f.table).toEqual(before)
})

function partialStubFaces(): ReturnType<typeof JSON.parse> {
  const items: {
    text: string
    rect: number[]
    baseline: number
    height: number
    horizontal: boolean
  }[] = []
  const cells: object[] = [],
    grid: string[][] = []
  const add = (
    text: string,
    left: number,
    right: number,
    baseline: number,
    row: number,
    column: number,
    rect: number[]
  ): void => {
    const item = {
      text,
      rect: [left, baseline - 10, right, baseline],
      baseline,
      height: 10,
      horizontal: true
    }
    items.push(item)
    cells.push({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect,
      text,
      sourceTokens: [item],
      sourceRects: [item.rect]
    })
    ;(grid[row] ??= [])[column] = text
  }
  const cuts = [0, 60, 110, 160]
  for (let c = 0; c < 3; c++)
    add(['Group', 'Field', 'Value'][c], cuts[c] + 5, cuts[c] + 35, 15, 0, c, [
      cuts[c],
      0,
      cuts[c + 1],
      20
    ])
  const rules = [
    [0, 20, 160, 20],
    [0, 60, 160, 60],
    [0, 100, 160, 100]
  ]
  for (let g = 0; g < 2; g++) {
    const y = 20 + 40 * g
    rules.push([60, y + 3, 60, y + 38], [65, y + 20, 105, y + 20], [115, y + 20, 155, y + 20])
    for (let r = 0; r < 2; r++) {
      const row = 1 + g * 2 + r
      add(['Shared', 'label'][r], 10, 50, y + (r ? 28 : 14), row, 0, [
        0,
        y + r * 20,
        60,
        y + (r + 1) * 20
      ])
      add(`Field ${g * 2 + r}`, 70, 100, y + 15 + r * 20, row, 1, [
        60,
        y + r * 20,
        110,
        y + (r + 1) * 20
      ])
      add(String(10 + g * 2 + r), 120, 145, y + 15 + r * 20, row, 2, [
        110,
        y + r * 20,
        160,
        y + (r + 1) * 20
      ])
    }
  }
  return {
    table: { cropRect: [0, 0, 160, 100], cells, grid, unassigned: [] },
    items,
    rules,
    captions: [{ lines: ['Table 1. Records.'], rect: [0, 110, 150, 120] }]
  }
}

it('joins wrapped stub fragments only inside partial-rule group faces while retaining all peer owners', () => {
  const f = partialStubFaces(),
    before = structuredClone(f)
  const plan = lateFencedGroupHelpers.proveNativeFencedMultilineStubOwners(
    f.table,
    f.items,
    f.captions,
    f.rules
  )
  expect(
    plan.replacements.map(
      (p: { row: number; rowSpan: number; sourceTokens: { text: string }[] }) => [
        p.row,
        p.rowSpan,
        p.sourceTokens.map((i) => i.text)
      ]
    )
  ).toEqual([
    [1, 2, ['Shared', 'label']],
    [3, 2, ['Shared', 'label']]
  ])
  expect(f).toEqual(before)
})

it.each([
  'through stub',
  'missing fence',
  'missing wall',
  'competing wall',
  'missing peer',
  'crossing group',
  'damaged rule',
  'foreign ink'
])('declines partial-rule group faces with %s', (change) => {
  const f = partialStubFaces()
  if (change === 'through stub') f.rules.find((r: number[]) => r[0] === 65 && r[1] === 40)[0] = 0
  if (change === 'missing fence') f.rules = f.rules.filter((r: number[]) => r[1] !== 60)
  if (change === 'missing wall')
    f.rules = f.rules.filter((r: number[]) => !(r[0] === 60 && r[1] === 23))
  if (change === 'competing wall') f.rules.push([61, 23, 61, 58])
  if (change === 'missing peer')
    f.table.cells = f.table.cells.filter(
      (c: { row: number; column: number }) => !(c.row === 2 && c.column === 2)
    )
  if (change === 'crossing group')
    f.items.find((i: { text: string }) => i.text === 'Field 1').rect[3] = 61
  if (change === 'damaged rule') f.rules.push([Number.NaN, 40, 100, 40])
  if (change === 'foreign ink')
    f.items.push({ ...f.items[4], text: 'extra', rect: [111, 25, 118, 35] })
  const before = structuredClone(f)
  expect(
    lateFencedGroupHelpers.proveNativeFencedMultilineStubOwners(
      f.table,
      f.items,
      f.captions,
      f.rules
    )
  ).toBeUndefined()
  expect(f).toEqual(before)
})

function commonLeafGutter(): ReturnType<typeof JSON.parse> {
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
    token('Key', 5, 35, 15),
    token('Left', 70, 95, 15),
    token('Right', 125, 155, 15),
    token('End', 175, 195, 15)
  ]
  const rules = Array.from({ length: 7 }, (_, n) => [0, 20 + n * 20, 210, 20 + n * 20])
  for (let n = 0; n < 6; n++)
    items.push(
      token(`k${n}`, 5, 35, 35 + n * 20),
      token('aa bb cc', 70, 155, 35 + n * 20),
      token(String(n + 1), 180, 190, 35 + n * 20)
    )
  const runs = items.map((i) => ({
    ...i,
    literalGlyphs: [...i.text.replace(/\s/gu, '')],
    glyphRuns: [...i.text.replace(/\s/gu, '')].map(() => 1),
    gaps:
      i.text === 'aa bb cc'
        ? [
            { left: i.baseline === 135 ? 90 : 99, right: i.baseline === 135 ? 94 : 103, index: 2 },
            { left: 112, right: 117, index: 4 }
          ]
        : []
  }))
  const table = {
    cropRect: [0, 0, 210, 142],
    structure: {
      objects: [0, 50, 165].map((x, n) => ({
        label: 'table column',
        rect: [x, 0, [50, 165, 210][n], 142]
      }))
    }
  }
  return {
    table,
    items,
    rules,
    runs,
    captions: [{ lines: ['Table 1. Values.'], rect: [0, 150, 180, 160] }]
  }
}

it('uses every fenced record to prove a unique common measured leaf gutter', () => {
  const f = commonLeafGutter()
  expect(
    lateFencedGroupHelpers.recoverNativeAlignedLiteralLeafColumns(
      f.table,
      f.items,
      f.captions,
      f.rules,
      f.runs
    )?.cuts
  ).toEqual([0, 50, 114.5, 165, 210])
})

it('preserves every literal field through the existing common-gutter token seam', () => {
  const f = commonLeafGutter(),
    original = structuredClone(f)
  const items = lateFencedGroupHelpers.recoverNativePrintedLaneTokens(
    f.table,
    f.items,
    f.captions,
    f.rules,
    f.runs
  )
  expect(items.filter((i: { text: string }) => i.text === 'aa bb')).toHaveLength(6)
  expect(items.filter((i: { text: string }) => i.text === 'cc')).toHaveLength(6)
  expect(
    items
      .filter((i: { sourceToken?: unknown }) => i.sourceToken)
      .every((i: { sourceToken: unknown }) => f.items.includes(i.sourceToken))
  ).toBe(true)
  expect(characters(items.map((i: { text: string }) => i.text).join(''))).toBe(
    characters(f.items.map((i: { text: string }) => i.text).join(''))
  )
  expect(f).toEqual(original)
})

it.each([
  'two gutters',
  'crossing record',
  'missing heading',
  'changed glyph',
  'operator boundary',
  'missing record',
  'missing observed run',
  'nonfinite gap'
])('declines the common measured leaf gutter with %s', (change) => {
  const f = commonLeafGutter()
  const last = f.runs.find(
    (r: { text: string; baseline: number }) => r.text === 'aa bb cc' && r.baseline === 135
  )
  if (change === 'two gutters') last.gaps[0] = { left: 99, right: 103, index: 2 }
  if (change === 'crossing record')
    last.gaps = last.gaps.filter((g: { index: number }) => g.index !== 4)
  if (change === 'missing heading')
    f.items = f.items.filter((i: { text: string }) => i.text !== 'Right')
  if (change === 'changed glyph') last.literalGlyphs[0] = 'z'
  if (change === 'operator boundary') last.glyphRuns = [1, 1, 1, 1, 2, 2]
  if (change === 'missing record')
    f.items = f.items.filter((i: { baseline: number }) => i.baseline !== 135)
  if (change === 'missing observed run')
    f.runs = f.runs.filter(
      (r: { text: string; baseline: number }) => !(r.text === 'aa bb cc' && r.baseline === 135)
    )
  if (change === 'nonfinite gap') last.gaps[1].right = Infinity
  const before = structuredClone(f)
  expect(
    lateFencedGroupHelpers.recoverNativeAlignedLiteralLeafColumns(
      f.table,
      f.items,
      f.captions,
      f.rules,
      f.runs
    )
  ).toBeUndefined()
  expect(
    lateFencedGroupHelpers.recoverNativePrintedLaneTokens(
      f.table,
      f.items,
      f.captions,
      f.rules,
      f.runs
    )
  ).toEqual(f.items)
  expect(f).toEqual(before)
})

it('returns four leaf columns and complete records through common-gutter production refinement', () => {
  const f = commonLeafGutter()
  f.table.structure.objects.push({ label: 'table column header', rect: [0, 0, 210, 20] })
  for (let n = 0; n < 7; n++)
    f.table.structure.objects.push({ label: 'table row', rect: [0, n * 20, 210, (n + 1) * 20] })
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
  expect(result.grid).toEqual([
    ['Key', 'Left', 'Right', 'End'],
    ...Array.from({ length: 6 }, (_, n) => [`k${n}`, 'aa bb', 'cc', String(n + 1)])
  ])
  expect(result.unassigned).toEqual([])
  expect(result.cropRect).toEqual(f.table.cropRect)
})
