import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const {
  hasTableEvidence,
  proveCaptionedNativeClosedTableFrame,
  findCaptionedNativeClosedTableFrames,
  isRecognizedAlgorithmOwnedTable,
  proveNativeAssignedClosedTableFrame,
  isNativeClosedFrameOwnedByTable
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
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
  const f = readPdfFixture(
      resolve(
        'src/main/literature/pdf-structure/fixtures/source-grids/native-assigned-panel-frame.jsonl'
      )
    ),
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
