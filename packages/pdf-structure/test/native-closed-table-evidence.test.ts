import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const numberedContinuation = (): ReturnType<typeof JSON.parse> => {
  const xs = [20, 40, 100, 160, 220]
  const make = (
    pageNumber: number,
    ys: number[],
    first: number | null
  ): ReturnType<typeof JSON.parse> => {
    const page = {
      pageNumber,
      width: 300,
      height: 1000,
      invalidGraphicsBounds: 0,
      graphicsBounds: []
    }
    const tokens: ReturnType<typeof JSON.parse>[] = [],
      rules: number[][] = []
    for (const x of xs) rules.push([x, ys[0], x, ys.at(-1)!])
    for (const y of ys) rules.push([xs[0], y, xs.at(-1)!, y])
    for (let r = 0; r < ys.length - 1; r++)
      for (let c = 0; c < xs.length - 1; c++) {
        const text =
          first === null && r === 0 ? (c ? 'Header' : '') : c ? 'Field' : String((first ?? 0) + r)
        if (!text) continue
        const rect = [xs[c] + 3, ys[r] + 5, xs[c] + 3 + text.length * 4, ys[r] + 13]
        tokens.push({
          text,
          rect,
          height: 8,
          baseline: rect[3],
          horizontal: true,
          sourceItem: { pageNumber, index: tokens.length, text }
        })
      }
    return [page, tokens, rules]
  }
  const current = make(2, [40, 70, 100, 130], 4),
    previous = make(1, [660, 690, 730, 770, 810], null)
  const viewport = {
    width: 300,
    height: 1000,
    rotation: 0,
    scale: 1,
    transform: [1, 0, 0, -1, 0, 1000],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 1000 - y]
  }
  const operators = {
    fnArray: [OPS.setLineWidth],
    argsArray: [[1]] as ReturnType<typeof JSON.parse>[]
  }
  const graphicsBounds = current[2].map((r: number[]) => {
    const operationIndex = operators.fnArray.length
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, r[0], 1000 - r[1], 1, r[2], 1000 - r[3]])]
    ])
    return {
      operationIndex,
      kind: 'path',
      normalizedRect: [
        (r[0] - 0.5) / 300,
        (r[1] - 0.5) / 1000,
        (r[2] + 0.5) / 300,
        (r[3] + 0.5) / 1000
      ]
    }
  })
  current[0].graphicsBounds = graphicsBounds
  const content = {
    items: current[1].map((t: ReturnType<typeof JSON.parse>) => ({
      str: t.text,
      width: t.rect[2] - t.rect[0],
      height: 8,
      transform: [8, 0, 0, 8, t.rect[0], 1000 - t.rect[3]],
      sourceItem: { ...t.sourceItem }
    }))
  }
  return {
    current,
    previous,
    captions: [{ page: 1, lines: ['Table 1. Generic records'], rect: [20, 638, 220, 650] }],
    context: { operators, viewport, graphicsBounds, content }
  }
}

it.each([
  'native',
  'prior-overflow-untouched',
  'prior-gap',
  'wrong-column',
  'missing-header',
  'multiple-captions',
  'unrelated-boxed-legend',
  'nonadjacent-page',
  'missing-border',
  'partial-edge',
  'crossing-prose',
  'duplicate-source',
  'plural-carrier',
  'missing-field',
  'invalid-graphics',
  'current-gap',
  'missing-raw-source',
  'missing-paint',
  'unknown-operator',
  'unknown-clip',
  'translucent-rule',
  'foreign-paint',
  'empty-end-path'
])(
  'excludes a closed numbered continuation from a neighboring figure only with whole native proof: %s',
  async (variant) => {
    const { recoverNativeNumberedContinuationRect } = await import(
      pathToFileURL(resolve('resources/literature-pdf-native-numbered-continuation.mjs')).href
    )
    const f = numberedContinuation()
    const changeText = (items: ReturnType<typeof JSON.parse>[], from: string, to: string): void => {
      const t = items.find((t) => t.text === from)
      t.text = t.sourceItem.text = to
    }
    if (variant === 'prior-overflow-untouched')
      f.previous[1].push({
        text: 'tail',
        rect: [110, 805, 126, 815],
        height: 10,
        baseline: 815,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: 80, text: 'tail' }
      })
    if (variant === 'prior-gap') changeText(f.previous[1], '2', '9')
    if (variant === 'wrong-column')
      for (const r of f.previous[2]) if (r[0] === 100 && r[2] === 100) r[0] = r[2] = 102
    if (variant === 'missing-header') f.previous[1].splice(0, 1)
    if (variant === 'multiple-captions') f.captions.push(structuredClone(f.captions[0]))
    if (variant === 'unrelated-boxed-legend') f.captions = []
    if (variant === 'nonadjacent-page') f.current[0].pageNumber = 3
    if (variant === 'missing-border') f.current[2][0][3] -= 12
    if (variant === 'partial-edge') f.current[2].splice(6, 1, [20, 70, 55, 70])
    if (variant === 'crossing-prose')
      f.current[1].push({
        text: 'Outside',
        rect: [10, 50, 25, 58],
        height: 8,
        baseline: 58,
        horizontal: true,
        sourceItem: { pageNumber: 2, index: 80, text: 'Outside' }
      })
    if (variant === 'duplicate-source') f.current[1].push(structuredClone(f.current[1][0]))
    if (variant === 'plural-carrier')
      f.current[1][0].sourceItems = [structuredClone(f.current[1][0].sourceItem)]
    if (variant === 'missing-field') f.current[1].splice(2, 1)
    if (variant === 'invalid-graphics') f.current[0].invalidGraphicsBounds = 1
    if (variant === 'current-gap') changeText(f.current[1], '5', '7')
    if (variant === 'missing-raw-source') f.context.content.items.splice(0, 1)
    if (variant === 'missing-paint') f.context.graphicsBounds.splice(0, 1)
    if (variant === 'unknown-operator') {
      f.context.operators.fnArray.push(-1)
      f.context.operators.argsArray.push([])
    }
    if (variant === 'unknown-clip') {
      f.context.operators.fnArray[0] = OPS.constructPath
      f.context.operators.argsArray[0] = [OPS.clip, []]
    }
    if (variant === 'translucent-rule') {
      f.context.operators.fnArray[0] = OPS.setGState
      f.context.operators.argsArray[0] = [[['CA', 0.5]]]
    }
    if (variant === 'foreign-paint') {
      const operationIndex = f.context.operators.fnArray.length
      f.context.operators.fnArray.push(OPS.constructPath)
      f.context.operators.argsArray.push([
        OPS.fill,
        [new Float32Array([0, 50, 950, 1, 60, 950, 1, 60, 940, 1, 50, 940, 4])]
      ])
      f.context.graphicsBounds.push({
        operationIndex,
        kind: 'path',
        normalizedRect: [50 / 300, 0.05, 60 / 300, 0.06]
      })
    }
    if (variant === 'empty-end-path') {
      f.context.operators.fnArray.push(OPS.constructPath)
      f.context.operators.argsArray.push([OPS.endPath, []])
    }
    const before = JSON.stringify(f)
    const rect = recoverNativeNumberedContinuationRect(f.current, f.previous, f.captions, f.context)
    if (['native', 'prior-overflow-untouched', 'empty-end-path'].includes(variant))
      expect(rect).toEqual([19.5, 39.5, 220.5, 130.5])
    else expect(rect).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
  }
)

const {
  hasTableEvidence,
  proveCaptionedNativeClosedTableFrame,
  findCaptionedNativeClosedTableFrames,
  isRecognizedAlgorithmOwnedTable,
  proveNativeAssignedClosedTableFrame,
  isNativeClosedFrameOwnedByTable
} = await import(pathToFileURL(resolve('resources/literature-pdf-table-evidence.mjs')).href)
const token = (
  text: string,
  rect: number[],
  height = 10
): { text: string; rect: number[]; height: number; baseline: number; horizontal: boolean } => ({
  text,
  rect,
  height,
  baseline: rect[3],
  horizontal: true
})
const caption = { lines: ['Table 1: Anonymous literal frame.'], rect: [0, 0, 200, 20] }
const frame = (): ReturnType<typeof JSON.parse> => ({
  table: { cropRect: [0, 30, 200, 110] },
  rules: [
    [0, 30, 200, 30],
    [0, 50, 200, 50],
    [0, 110, 200, 110]
  ],
  items: [
    token('Field', [10, 32, 50, 42]),
    token('Literal wording', [110, 32, 190, 42]),
    ...[60, 72, 84, 96].flatMap((y, n) => [
      token(`Entry ${n}`, [10, y, 60, y + 10]),
      token('A native quotation', [110, y, 195, y + 10])
    ])
  ]
})

it('deduplicates a complete native frame by glyph ownership despite different printed captions and fence margins', () => {
  const f = frame()
  const table = {
    cropRect: f.table.cropRect,
    caption: { lines: ['Table 2: The independently printed lower label.'] },
    grid: Array.from({ length: 5 }, (_, row) =>
      f.items.slice(row * 2, row * 2 + 2).map((i: { text: string }) => i.text)
    ),
    cells: f.items.map((i: { text: string; rect: number[] }, n: number) => ({
      row: Math.floor(n / 2),
      column: n % 2,
      text: i.text,
      sourceRects: [i.rect]
    }))
  }
  const proof = {
    cropRect: [-4, 28, 205, 114],
    caption,
    sourceTokens: f.items
  }
  const before = structuredClone({ table, proof })
  expect(isNativeClosedFrameOwnedByTable(table, proof)).toBe(true)
  expect({ table, proof }).toEqual(before)
  for (const missing of ['glyph', 'duplicate', 'extra', 'clipped', 'invalid', 'visual-only']) {
    const sample = structuredClone({ table, proof })
    if (missing === 'glyph') sample.table.cells[0].sourceRects = []
    if (missing === 'duplicate')
      sample.table.cells[1].sourceRects = sample.table.cells[0].sourceRects
    if (missing === 'extra')
      sample.table.cells.push({ ...sample.table.cells[0], sourceRects: [[1, 20, 2, 22]] })
    if (missing === 'clipped') sample.table.cropRect[2] = 189
    if (missing === 'invalid') sample.proof.sourceTokens[0].rect = [0, 0, 0, 10]
    if (missing === 'visual-only') sample.table.grid = []
    expect(isNativeClosedFrameOwnedByTable(sample.table, sample.proof), missing).toBe(false)
  }
})

it('preserves a genuine closed narrative frame without inventing grouped cell semantics', () => {
  const f = frame(),
    before = structuredClone(f),
    proof = proveCaptionedNativeClosedTableFrame(f.table, caption, f.items, f.rules)
  expect(proof.kind).toBe('native-closed-table-visual')
  expect(proof.cropRect).toEqual([0, 30, 200, 110])
  expect(proof.sourceTokens).toHaveLength(10)
  expect(proof.headerCells).toBeUndefined()
  expect(f).toEqual(before)
  f.rules.pop()
  expect(proveCaptionedNativeClosedTableFrame(f.table, caption, f.items, f.rules)).toBeUndefined()
})

it('retains a complete captioned native frame when ambiguous inline scripts cannot prove body row semantics', () => {
  const f = frame()
  f.items.push(token('x', [150, 65, 153, 68], 3), token('y', [154, 65, 157, 68], 3))
  const before = structuredClone(f),
    proof = proveCaptionedNativeClosedTableFrame(f.table, caption, f.items, f.rules)
  expect(proof?.kind).toBe('native-closed-table-visual')
  expect(proof?.sourceTokens).toHaveLength(f.items.length)
  expect(proof?.headerCells).toBeUndefined()
  expect(f).toEqual(before)
})

it('uses the independently closed source frame for a complete panel grid without borrowing neighboring ink', () => {
  const f = readPdfFixture(resolve('test/fixtures/source-grids/native-assigned-panel-frame.jsonl')),
    before = structuredClone(f),
    proof = proveNativeAssignedClosedTableFrame(f.table, f.items, f.rules)
  expect(proof.cropRect).toEqual(f.expectedCrop)
  expect(proof.sourceTokens).toHaveLength(59)
  expect(f).toEqual(before)
  // The foreign neighboring header remains literal native content; only the
  // proved crop excludes it. No cell or caption is rewritten by the proof.
  expect(proof.sourceTokens).not.toContain(f.items.at(-1))
  const noClosing = f.rules.slice(0, -1)
  expect(proveNativeAssignedClosedTableFrame(f.table, f.items, noClosing)).toBeUndefined()
  const missingSource = structuredClone(f.table)
  missingSource.cells
    .find((c: { sourceRects: number[][] }) => c.sourceRects.length)
    .sourceRects.pop()
  expect(proveNativeAssignedClosedTableFrame(missingSource, f.items, f.rules)).toBeUndefined()
  const foreignInterior = token('Unowned native ink', [450, 354, 460, 357], 3)
  expect(
    proveNativeAssignedClosedTableFrame(f.table, [...f.items, foreignInterior], f.rules)
  ).toBeUndefined()
  const wrongOwnership = structuredClone(f.table)
  wrongOwnership.cells
    .find((c: { sourceRects: number[][] }) => c.sourceRects.length)
    .sourceRects.push(f.items.at(-1).rect)
  expect(proveNativeAssignedClosedTableFrame(wrongOwnership, f.items, f.rules)).toBeUndefined()
  const duplicateSource = structuredClone(f.table)
  const owned = duplicateSource.cells.find((c: { sourceRects: number[][] }) => c.sourceRects.length)
  owned.sourceRects.push(owned.sourceRects[0])
  expect(proveNativeAssignedClosedTableFrame(duplicateSource, f.items, f.rules)).toBeUndefined()
  expect(
    proveNativeAssignedClosedTableFrame(
      { ...f.table, grid: [...f.table.grid, []] },
      f.items,
      f.rules
    )
  ).toBeUndefined()
  expect(
    proveNativeAssignedClosedTableFrame(
      { ...f.table, cells: f.table.cells.filter((c: { row: number }) => c.row !== 2) },
      f.items,
      f.rules
    )
  ).toBeUndefined()
})

it('keeps an independently framed narrow panel captionless under a spanning caption', () => {
  const f = frame(),
    shared = { ...caption, rect: [0, 0, 550, 20] }
  const proofs = findCaptionedNativeClosedTableFrames(shared, f.items, f.rules)
  expect(proofs).toHaveLength(1)
  expect(proofs[0].caption).toBeUndefined()
  expect(proofs[0].cropRect).toEqual([0, 30, 200, 110])
})

it('retains closed boxed parts while refusing a caption or prose between them', () => {
  const first = [0, 30, 200, 130],
    second = [0, 145, 200, 225]
  const rules = [first, second].flatMap(([left, top, right, bottom]) => [
    [left, top, right, top],
    [left, bottom, right, bottom],
    [left, top, left, bottom],
    [90, top, 90, bottom],
    [right, top, right, bottom]
  ])
  const items = [40, 60, 80, 100, 150, 165, 180, 195].flatMap((y, n) => [
    token(`Parameter ${n}`, [10, y, 80, y + 10]),
    token('Literal value', [100, y, 180, y + 10])
  ])
  const result = findCaptionedNativeClosedTableFrames(caption, items, rules)
  expect(result).toHaveLength(2)
  expect(result[0].caption).toEqual(caption)
  expect(result[1].caption).toBeUndefined()
  expect(result[1].cropRect).toEqual(second)
  for (const text of ['Table 2: Other content.', 'Ordinary intervening prose']) {
    const extra = token(text, [10, 132, 190, 142])
    expect(findCaptionedNativeClosedTableFrames(caption, [...items, extra], rules)).toHaveLength(1)
  }
  expect(
    findCaptionedNativeClosedTableFrames(
      caption,
      items,
      rules.filter((r) => r[0] !== 90 || r[2] !== 90)
    )
  ).toEqual([])
})

it('accepts ownership only from already recognized procedures and complete finite source geometry', () => {
  const algorithms = [{ rect: [0, 0, 100, 100] }],
    table = {
      rows: [{}, {}],
      cells: [
        {
          sourceRects: [
            [15, 15, 30, 30],
            [40, 40, 55, 55],
            [151, 15, 152, 16]
          ]
        }
      ]
    }
  expect(isRecognizedAlgorithmOwnedTable(table, undefined, algorithms)).toBe(true)
  expect(isRecognizedAlgorithmOwnedTable(table, caption, algorithms)).toBe(false)
  expect(isRecognizedAlgorithmOwnedTable(table, undefined, [], 1.5)).toBe(false)
  expect(isRecognizedAlgorithmOwnedTable(table, undefined, algorithms, Infinity)).toBe(false)
  expect(
    isRecognizedAlgorithmOwnedTable(
      {
        ...table,
        cells: [
          {
            sourceRects: [
              [15, 15, 30, 30],
              [151, 15, 181, 30]
            ]
          }
        ]
      },
      undefined,
      algorithms
    )
  ).toBe(false)
  expect(
    isRecognizedAlgorithmOwnedTable(
      { ...table, cells: [{ sourceRects: [[15, 15, 30]] }] },
      undefined,
      algorithms
    )
  ).toBe(false)
  expect(isRecognizedAlgorithmOwnedTable(table, undefined, [{ rect: [100, 100, 0, 0] }])).toBe(
    false
  )
})

it('does not treat a raised footnote ordinal beside cropped native paragraph tails as a measurement', () => {
  const prose = [
      token('A paragraph continues across this printed line', [106, 1122, 434, 1139], 16.36),
      token('The paragraph continues on another printed line', [106, 1143, 436, 1159], 16.36)
    ],
    marker = token('5', [478, 1129, 483, 1139], 8.96),
    footnote = token('An adjacent explanatory footnote', [484, 1131, 786, 1144], 13.45)
  const table = {
    cropRect: [200, 1093, 509, 1204],
    grid: [
      [prose[0].text, '5'],
      [prose[1].text, '<']
    ],
    cells: [
      { text: prose[0].text, rect: [200, 1122, 447, 1144], sourceRects: [prose[0].rect] },
      { text: '5', rect: [447, 1122, 509, 1144], sourceRects: [marker.rect] },
      { text: prose[1].text, rect: [200, 1143, 447, 1162], sourceRects: [prose[1].rect] }
    ],
    unassigned: [],
    issues: []
  }
  const items = [...prose, marker, footnote],
    rules = [[459, 1128, 549, 1128]]
  expect(hasTableEvidence(table, undefined, items, rules)).toBe(false)
  // A real caption or ordinary full-size scalar refuses this narrow source
  // proof rather than lending footnote semantics to a genuine data table.
  expect(hasTableEvidence(table, caption, items, rules)).toBe(true)
  marker.height = 16.36
  expect(hasTableEvidence(table, undefined, items, rules)).toBe(true)
})
