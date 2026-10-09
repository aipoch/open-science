import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { repairWrappedTableRows } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-row-repair.mjs')).href
)
const {
  recoverNativePrintedLeafPlan,
  recoverNativePrintedLaneTokens,
  recoverNativeIsolatedPrintedHeader,
  recoverNativeCompactLiteralRecords,
  recoverNativeLiteralKeyedPeers,
  proveNativeStubClosingGlyphOwners,
  recoverNativeObservedLiteralHeaderRecords,
  proveNativeDescriptiveRunOwners,
  proveNativeUnprintedSeparatorFaces,
  proveNativePartialRuleParentOwners,
  proveNativeFencedMultilineStubOwners,
  proveNativeFencedSingleLineStubOwners,
  recoverNativePairedLiteralRowBands,
  proveNativeFencedPairedRecordOwners,
  proveNativeTjAnchorLiteralLeaves,
  proveNativeFencedCompositeStubOwners
} = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-leaf-record-repair.mjs'))
    .href
)
const newLiteralOwnerHelpers = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-leaf-record-repair.mjs'))
    .href
)
const completeOwnerFixture = (kind: string): ReturnType<typeof JSON.parse> => {
  const f = readFileSync(
    resolve('src/main/literature/pdf-structure/fixtures/native-complete-records.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((f) => f.kind === kind)
  const cells = structuredClone(f.originalCells ?? f.expectedBeforeCells),
    grid =
      f.expectedBeforeGrid ??
      Array.from({ length: Math.max(...cells.map((c: { row: number }) => c.row)) + 1 }, () =>
        f.expectedGrid[0].map(() => '')
      )
  if (!f.expectedBeforeGrid) for (const c of cells) grid[c.row][c.column] = c.text
  return {
    ...structuredClone(f),
    ownerTable: {
      cropRect: f.table.cropRect,
      cells,
      grid,
      unassigned:
        kind === 'complete-ordinary-native-records'
          ? f.expectedSources
              .filter(
                (i: ReturnType<typeof JSON.parse>) =>
                  !cells.some((c: ReturnType<typeof JSON.parse>) =>
                    c.sourceTokens.some(
                      (t: ReturnType<typeof JSON.parse>) =>
                        t.text === i.text && JSON.stringify(t.rect) === JSON.stringify(i.rect)
                    )
                  )
              )
              .map((i: { text: string }) => i.text)
          : []
    }
  }
}

it.each([
  'missing-closing',
  'competing-caption',
  'missing-field',
  'duplicate-source',
  'foreign-rotated-ink',
  'wrapped-face',
  'crossing-gutter',
  'duplicate-source-rect',
  'rich-existing-owner',
  'true-internal-record-fence'
])('refuses unproved ordinary source record projection: %s', (control: string) => {
  const f = completeOwnerFixture('complete-ordinary-native-records'),
    item = f.items.find(
      (i: ReturnType<typeof JSON.parse>) =>
        i.text === f.expectedGrid[2][2] &&
        i.baseline > f.expectedSources[9].baseline &&
        i.baseline < f.expectedSources[18].baseline + 0.02
    ),
    closing = f.rules.find((r: number[]) => Math.abs(r[1] - 1128.0172581) < 0.02)
  if (control === 'missing-closing') f.rules = f.rules.filter((r: unknown) => r !== closing)
  if (control === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'missing-field') f.items = f.items.filter((i: unknown) => i !== item)
  if (control === 'duplicate-source') f.items.push(structuredClone(item))
  if (control === 'foreign-rotated-ink')
    f.items.push({ ...structuredClone(item), text: 'Rotated', horizontal: false })
  if (control === 'wrapped-face') {
    item.baseline += 4
    item.rect[1] += 4
    item.rect[3] += 4
  }
  if (control === 'crossing-gutter') item.rect[2] = f.expectedSources[21].rect[0] + 1
  if (control === 'duplicate-source-rect') {
    const c = f.ownerTable.cells.find((c: { sourceRects: unknown[] }) => c.sourceRects.length > 1)
    c.sourceRects[1] = structuredClone(c.sourceRects[0])
  }
  if (control === 'rich-existing-owner')
    f.ownerTable.cells[0].textRuns = [{ text: f.ownerTable.cells[0].text, position: 'superscript' }]
  if (control === 'true-internal-record-fence')
    f.rules.push([
      closing[0],
      f.expectedSources[18].rect[1] - 1,
      closing[2],
      f.expectedSources[18].rect[1] - 1
    ])
  const before = structuredClone(f)
  expect(
    newLiteralOwnerHelpers.proveNativeCompleteOrdinaryRecordOwners(
      f.ownerTable,
      f.items,
      f.captions,
      f.rules
    )
  ).toBeUndefined()
  expect(f).toEqual(before)
})

it.each([
  'missing-closing',
  'missing-group-fence',
  'wrong-fence-ends',
  'competing-caption',
  'foreign-rotated-ink',
  'duplicate-source',
  'missing-peer',
  'crossing-group-font',
  'wrong-stub-donor-span',
  'duplicate-source-rect',
  'changed-two-line-font',
  'rich-stub-donor'
])('refuses unproved fenced two-line stub ownership: %s', (control: string) => {
  const f = completeOwnerFixture('fenced-two-line-native-stubs'),
    stub = f.ownerTable.cells.find(
      (c: { row: number; column: number }) => c.row === 2 && c.column === 0
    ),
    token = stub.sourceTokens[0],
    item = f.items.find(
      (i: ReturnType<typeof JSON.parse>) =>
        i.text === token.text && JSON.stringify(i.rect) === JSON.stringify(token.rect)
    ),
    closing = f.rules.find((r: number[]) => Math.abs(r[1] - 908.4255) < 0.02),
    fence = f.rules.find((r: number[]) => Math.abs(r[1] - 553.656) < 0.02)
  if (control === 'missing-closing') f.rules = f.rules.filter((r: unknown) => r !== closing)
  if (control === 'missing-group-fence') f.rules = f.rules.filter((r: unknown) => r !== fence)
  if (control === 'wrong-fence-ends') fence[2] -= 1
  if (control === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'foreign-rotated-ink')
    f.items.push({ ...structuredClone(item), text: 'Rotated', horizontal: false })
  if (control === 'duplicate-source') f.items.push(structuredClone(item))
  if (control === 'missing-peer')
    f.ownerTable.cells = f.ownerTable.cells.filter(
      (c: { row: number; column: number }) => !(c.row === 10 && c.column === 3)
    )
  if (control === 'crossing-group-font') item.rect[3] = fence[1] + 1
  if (control === 'wrong-stub-donor-span') stub.rowSpan--
  if (control === 'duplicate-source-rect') {
    const c = f.ownerTable.cells.find((c: { sourceRects: unknown[] }) => c.sourceRects.length > 1)
    c.sourceRects[1] = structuredClone(c.sourceRects[0])
  }
  if (control === 'changed-two-line-font') item.height -= 1
  if (control === 'rich-stub-donor') stub.textRuns = [{ text: stub.text, position: 'superscript' }]
  const before = structuredClone(f)
  expect(
    newLiteralOwnerHelpers.proveNativeFencedTwoLineStubOwners(
      f.ownerTable,
      f.items,
      f.captions,
      f.rules
    )
  ).toBeUndefined()
  expect(f).toEqual(before)
})
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/source-grids', name + '.jsonl')
  )
const refine = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  refineTable(f.table, f.tokens, f.captions, [], f.rules, f.runs)
const glyphs = (texts: string[]): string => [...texts.join('').replace(/\s/gu, '')].sort().join('')
const plan = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> => {
  const tokens = recoverNativePrintedLaneTokens(f.table, f.tokens, f.captions, f.rules, f.runs)
  return recoverNativePrintedLeafPlan(f.table, tokens, f.captions, f.rules, f.runs)
}

const partialParentOwners = (): ReturnType<typeof JSON.parse> => {
  const f = readFileSync(
    resolve('src/main/literature/pdf-structure/fixtures/native-complete-records.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => record.kind === 'partial-rule-parent-owners')
  const grid = structuredClone(f.expectedGrid),
    cells = [...f.retainedCells, ...f.initialFaultyParentCells]
  for (const cell of f.initialFaultyParentCells) grid[0][cell.column] = cell.text
  return { ...f, table: { cropRect: f.table.cropRect, grid, cells, notes: [] } }
}

const fencedStubOwners = (): ReturnType<typeof JSON.parse> => {
  const f = readFileSync(
    resolve('src/main/literature/pdf-structure/fixtures/native-complete-records.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => record.kind === 'fenced-multiline-stub-owners')
  const grid = structuredClone(f.expectedGrid),
    cells = [...f.retainedCells, ...f.initialFaultyStubCells]
  for (const row of grid.slice(1)) row[0] = ''
  for (const cell of cells.filter(
    (c: { column: number; row: number }) => c.column === 0 && c.row > 0
  ))
    grid[cell.row][0] = cell.text
  return { ...f, table: { cropRect: f.expectedCropRect, grid, cells, notes: [] } }
}

const fencedStubProof = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  proveNativeFencedMultilineStubOwners(f.table, f.items, f.captions, f.rules)

const singleLineFencedStubs = (): ReturnType<typeof JSON.parse> => {
  const f = readFileSync(
    resolve('src/main/literature/pdf-structure/fixtures/native-complete-records.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => record.kind === 'fenced-single-line-stub-owners')
  return { ...f, table: { ...f.expectedBefore, notes: [] } }
}
const singleLineFencedProof = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  proveNativeFencedSingleLineStubOwners(f.table, f.items, f.captions, f.rules)

const pairedLiteralCi = (kind = 'paired-native-ci-marked-records'): ReturnType<typeof JSON.parse> =>
  readFileSync(
    resolve('src/main/literature/pdf-structure/fixtures/native-complete-records.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => record.kind === kind)
const pairedLiteralCiProof = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  recoverNativePairedLiteralRowBands(f.table, f.items, f.captions, f.rules, f.runs)

it('keeps an independent correct header font box that overhangs the old body model cut', () => {
  const f = pairedLiteralCi(),
    before = structuredClone(f),
    columns = f.table.structure.objects
      .filter((o: { label: string }) => o.label === 'table column')
      .sort((a: { rect: number[] }, b: { rect: number[] }) => a.rect[0] - b.rect[0]),
    cut = f.table.cropRect[0] + (columns[1].rect[2] + columns[2].rect[0]) / 2,
    header = f.originalHeaderCells.find((c: { column: number }) => c.column === 1)
  expect(header.sourceRects.some((r: number[]) => r[0] < cut && r[2] > cut)).toBe(true)
  const proof = pairedLiteralCiProof(f)
  expect(proof.rows).toEqual(f.expected.rows.map((r: { rect: number[] }) => r.rect))
  const result = refineTable(f.table, f.items, f.captions, [], f.rules, f.runs)
  for (const original of f.originalHeaderCells)
    expect(
      result.cells.find(
        (c: { row: number; column: number }) =>
          c.row === original.row && c.column === original.column
      )
    ).toEqual(original)
  expect(f).toEqual(before)
})

it('rejects a complete ordinary body font box that overhangs that same model cut', () => {
  const f = pairedLiteralCi(),
    columns = f.table.structure.objects
      .filter((o: { label: string }) => o.label === 'table column')
      .sort((a: { rect: number[] }, b: { rect: number[] }) => a.rect[0] - b.rect[0]),
    cut = f.table.cropRect[0] + (columns[1].rect[2] + columns[2].rect[0]) / 2,
    cell = f.expected.cells.find(
      (c: { row: number; column: number }) => c.row === 1 && c.column === 1
    ),
    token = cell.sourceTokens[0],
    item = f.items.find(
      (i: { text: string; rect: number[] }) =>
        i.text === token.text && JSON.stringify(i.rect) === JSON.stringify(token.rect)
    ),
    run = f.runs.find(
      (r: { text: string; rect: number[] }) =>
        r.text === item.text && JSON.stringify(r.rect) === JSON.stringify(item.rect)
    )
  item.rect[2] = cut + 0.01
  run.rect = [...item.rect]
  const before = structuredClone(f)
  expect(pairedLiteralCiProof(f)).toBeUndefined()
  expect(f).toEqual(before)
})

it.each([
  'default-programs',
  'competing-program-baseline',
  'competing-program-height',
  'unpaired-script',
  'native-walled-face'
])(
  'requires literal programs, existing script parent and ordinary native faces before CI rows: %s',
  (change) => {
    const f = pairedLiteralCi(),
      run = f.runs[0]
    if (change.startsWith('competing-program')) {
      const duplicate = structuredClone(run)
      duplicate[change.endsWith('baseline') ? 'baseline' : 'height'] += 0.01
      f.runs.push(duplicate)
    }
    if (change === 'unpaired-script') {
      const item = f.items.find((i: { text: string }) => i.text === '∗'),
        observed = f.runs.find((r: { text: string }) => r.text === '∗')
      item.rect[0] += 30
      item.rect[2] += 30
      observed.rect = [...item.rect]
    }
    if (change === 'native-walled-face') f.rules.push([675, 180, 675, 450])
    const before = structuredClone(f)
    expect(
      change === 'default-programs'
        ? recoverNativePairedLiteralRowBands(f.table, f.items, f.captions, f.rules)
        : pairedLiteralCiProof(f)
    ).toBeUndefined()
    expect(f).toEqual(before)
  }
)

it('proves only the faulty one-line native fenced stub and returns original owner objects', () => {
  const f = singleLineFencedStubs(),
    before = structuredClone(f),
    proof = singleLineFencedProof(f)
  expect(proof.replacements).toHaveLength(1)
  const group = f.groups.find((g: { correct: boolean }) => !g.correct),
    replacement = proof.replacements[0]
  expect(replacement.row).toBe(group.row)
  expect(replacement.rowSpan).toBe(group.rowSpan)
  expect(replacement.rect).toEqual(group.rect)
  expect(replacement.donors).toEqual(f.initialFaultyStubCells)
  const owner = f.table.cells.find((c: { text: string }) => c.text === group.label.text)
  expect(replacement.sourceTokens).toBe(owner.sourceTokens)
  expect(f).toEqual(before)
})

it.each([
  'missing-fence',
  'short-fence',
  'competing-fence',
  'missing-title',
  'competing-title',
  'missing-peer',
  'duplicate-native',
  'foreign-rotated',
  'crossing-label',
  'unsupported-underline',
  'duplicate-rect',
  'missing-rect',
  'wrong-baseline',
  'mixed-owner',
  'incorrect-rich',
  'wrong-grid',
  'duplicate-cell',
  'crossing-correct-donor',
  'notes',
  'native-vertical-face'
])('refuses one-line stub ownership with %s', (change) => {
  const f = singleLineFencedStubs(),
    faulty = f.groups.find((g: { correct: boolean }) => !g.correct),
    label = f.items.find((i: { text: string }) => i.text === faulty.label.text),
    donor = f.table.cells.find((c: { text: string }) => c.text === label.text),
    fence = f.rules.find(
      (r: number[]) =>
        Math.abs(r[1] - f.groups[1].label.baseline) < 100 &&
        Math.abs(r[1] - faulty.rect[3]) < 10 &&
        r[2] - r[0] > 400
    ),
    peer = f.table.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 2)
  if (change === 'missing-fence') f.rules = f.rules.filter((r: unknown) => r !== fence)
  if (change === 'short-fence') fence[2] -= 3
  if (change === 'competing-fence')
    f.rules.push(fence.map((v: number, n: number) => v + (n % 2 ? 2 : 0)))
  if (change === 'missing-title') f.captions = []
  if (change === 'competing-title') f.captions.push(structuredClone(f.captions[0]))
  if (change === 'missing-peer')
    f.items = f.items.filter(
      (i: { rect: number[] }) => JSON.stringify(i.rect) !== JSON.stringify(peer.sourceRects[0])
    )
  if (change === 'duplicate-native') f.items.push(structuredClone(label))
  if (change === 'foreign-rotated')
    f.items.push({ ...structuredClone(peer.sourceTokens[0]), text: 'foreign', horizontal: false })
  if (change === 'crossing-label') label.rect[1] = f.rules[0][1] - 1
  if (change === 'unsupported-underline') {
    const rule = f.rules.find((r: number[]) => r[0] > 350 && r[2] - r[0] < 40)
    rule[2] -= 2
  }
  if (change === 'duplicate-rect') {
    const header = f.table.cells.find((c: { sourceRects: unknown[] }) => c.sourceRects.length === 2)
    header.sourceRects[1] = [...header.sourceRects[0]]
  }
  if (change === 'missing-rect') donor.sourceRects = []
  if (change === 'wrong-baseline') donor.sourceTokens[0].baseline += 1
  if (change === 'mixed-owner') donor.sourceTokens.push(structuredClone(peer.sourceTokens[0]))
  if (change === 'incorrect-rich') donor.textRuns = [{ text: donor.text, position: 'superscript' }]
  if (change === 'wrong-grid') f.table.grid[donor.row][0] += ' extra'
  if (change === 'duplicate-cell') f.table.cells.push(structuredClone(peer))
  if (change === 'crossing-correct-donor') {
    const group = f.groups.find((g: { correct: boolean }) => g.correct),
      cell = f.table.cells.find(
        (c: { row: number; column: number }) => c.row === group.row && c.column === 0
      )
    cell.rect[2] = group.label.rect[2] - 1
  }
  if (change === 'notes') f.table.notes = ['unowned note']
  if (change === 'native-vertical-face') f.rules.push([400, 350, 400, 380])
  const before = structuredClone(f)
  expect(singleLineFencedProof(f)).toBeUndefined()
  expect(f).toEqual(before)
})

it('derives one-line group ownership with fewer physical groups and equivalent native paint', () => {
  const f = singleLineFencedStubs(),
    closing = f.rules
      .filter((r: number[]) => r[2] - r[0] > 400)
      .sort((a: number[], b: number[]) => a[1] - b[1])[4],
    last = f.groups[2].row + f.groups[2].rowSpan
  f.table.grid = f.table.grid.slice(0, last)
  f.table.cells = f.table.cells.filter((c: { row: number }) => c.row < last)
  f.items = f.items.filter((i: { baseline: number }) => i.baseline < closing[1])
  f.rules = f.rules.filter((r: number[]) => r[1] <= closing[1])
  f.table.cropRect[3] = closing[1] + 1
  f.captions[0].rect = [
    f.captions[0].rect[0],
    closing[1] + 2,
    f.captions[0].rect[2],
    closing[1] + 20
  ]
  const before = structuredClone(f),
    first = singleLineFencedProof(f)
  expect(first.replacements).toHaveLength(1)
  f.rules.push(closing.map((v: number, n: number) => (n === 2 ? v - 3 : v)))
  expect(singleLineFencedProof(f)).toEqual(first)
  expect(before.table.cells).toEqual(f.table.cells)
})

it('preserves native one-line stub proof under translated and reversed physical evidence', () => {
  const f = singleLineFencedStubs(),
    shift = (r: number[]): number[] => r.map((v, n) => v + (n % 2 ? 37 : 19))
  f.table.cropRect = shift(f.table.cropRect)
  f.rules = f.rules.map(shift).reverse()
  for (const title of f.captions) title.rect = shift(title.rect)
  for (const item of f.items) {
    item.rect = shift(item.rect)
    item.baseline += 37
  }
  for (const cell of f.table.cells) {
    cell.rect = shift(cell.rect)
    cell.sourceRects = cell.sourceRects.map(shift)
    for (const token of cell.sourceTokens) {
      token.rect = shift(token.rect)
      token.baseline += 37
    }
  }
  f.items.reverse()
  const before = structuredClone(f),
    proof = singleLineFencedProof(f)
  expect(proof.replacements).toHaveLength(1)
  expect(proof.replacements[0].rect).toEqual(shift(f.groups[0].rect))
  expect(f).toEqual(before)
})

const fencedPairOwners = (): ReturnType<typeof JSON.parse> => {
  const f = readFileSync(
      resolve('src/main/literature/pdf-structure/fixtures/native-complete-records.jsonl'),
      'utf8'
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((record) => record.kind === 'fenced-paired-native-records'),
    rows = structuredClone(f.expectedInternalRows),
    merged = (first: number, last: number): ReturnType<typeof JSON.parse> => ({
      ...rows[first],
      rect: [rows[first].rect[0], rows[first].rect[1], rows[first].rect[2], rows[last].rect[3]]
    })
  return {
    ...f,
    table: {
      cropRect: structuredClone(f.expectedBeforeCropRect),
      grid: structuredClone(f.expectedBeforeGrid),
      cells: structuredClone(f.expectedBeforeCells),
      rows: [rows[0], rows[1], merged(2, 3), merged(4, 5), rows[6], rows[7]],
      notes: [],
      unassigned: []
    }
  }
}
const fencedPairProof = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  proveNativeFencedPairedRecordOwners(f.table, f.items, f.captions, f.rules)

it('proves paired record splits at native empty font gaps and keeps original minimal source objects', () => {
  const f = fencedPairOwners(),
    before = structuredClone(f),
    proof = fencedPairProof(f)
  expect(
    proof?.projections.map((p: { oldRow: number; newRow: number; indices: number[] }) => [
      p.oldRow,
      p.newRow,
      p.indices.length
    ])
  ).toEqual([
    [2, 2, 2],
    [3, 4, 2],
    [4, 6, 1],
    [5, 7, 1]
  ])
  expect(
    proof.projections
      .filter((p: { split?: number }) => p.split !== undefined)
      .map((p: { split: number }) => p.split)
  ).toEqual(f.independentNativeSplits.map((p: { split: number }) => p.split))
  const owned = proof.records.flat(2),
    old = f.table.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens)
  expect(owned).toHaveLength(138)
  expect(owned.every((t: unknown) => old.includes(t))).toBe(true)
  expect(
    proof.records.filter((_: unknown, n: number) => n % 2).every((r: unknown[][]) => !r[0].length)
  ).toBe(true)
  expect(f).toEqual(before)
})

it('calibrates from the first correct pair when the last pair is merged', () => {
  const f = fencedPairOwners(),
    old = f.table.cells,
    mergedLast = Array.from({ length: 6 }, (_, column) => {
      const first = old.find(
          (c: { row: number; column: number }) => c.row === 4 && c.column === column
        ),
        second = old.find(
          (c: { row: number; column: number }) => c.row === 5 && c.column === column
        ),
        sourceTokens = [...first.sourceTokens, ...second.sourceTokens]
      return {
        ...first,
        row: 5,
        rect: [first.rect[0], first.rect[1], first.rect[2], second.rect[3]],
        text: [first.text, second.text].filter(Boolean).join(' '),
        sourceTokens,
        sourceRects: sourceTokens.map((t: { rect: number[] }) => [...t.rect])
      }
    })
  f.table.cells = [
    ...old.filter((c: { row: number }) => c.row < 2),
    ...structuredClone(
      f.expectedInternalCells.filter((c: { row: number }) => c.row === 2 || c.row === 3)
    ),
    ...old
      .filter((c: { row: number }) => c.row === 3)
      .map((c: { row: number }) => ({ ...c, row: 4 })),
    ...mergedLast
  ]
  f.table.grid = [
    ...f.expectedGrid.slice(0, 4),
    ...[4, 5].map((row) =>
      f.table.cells
        .filter((c: { row: number }) => c.row === row)
        .map((c: { text: string }) => c.text)
    )
  ]
  const last = f.table.rows[5]
  f.table.rows = [
    ...structuredClone(f.expectedInternalRows.slice(0, 4)),
    f.table.rows[3],
    {
      ...f.table.rows[4],
      rect: [last.rect[0], f.table.rows[4].rect[1], last.rect[2], last.rect[3]]
    }
  ]
  const before = structuredClone(f),
    proof = fencedPairProof(f)
  expect(proof?.projections.map((p: { indices: number[] }) => p.indices.length)).toEqual([
    1, 1, 2, 2
  ])
  expect(f).toEqual(before)
})

it.each([
  'foreign-token-baseline',
  'missing-owned-glyph',
  'duplicate-owned-glyph',
  'missing-source-rectangle',
  'duplicate-source-rectangle',
  'source-rectangle-mismatch',
  'correct-owner-cuts-glyph',
  'correct-row-metadata-mismatch',
  'existing-rich-script',
  'invalid-header-span',
  'changed-calibration-literal',
  'changed-calibration-offset',
  'same-centroid-changed-calibration-box',
  'no-separated-reference-pair'
])('rejects incomplete predecessor or calibrated paired-record ownership: %s', (control) => {
  const f = fencedPairOwners(),
    cell = (row: number, column: number): ReturnType<typeof JSON.parse> =>
      f.table.cells.find(
        (c: { row: number; column: number }) => c.row === row && c.column === column
      ),
    donor = cell(2, 2),
    key = cell(4, 1),
    native = (t: { text: string; rect: number[] }): ReturnType<typeof JSON.parse> =>
      f.items.find(
        (i: { text: string; rect: number[] }) =>
          i.text === t.text && i.rect.every((v, n) => v === t.rect[n])
      )
  if (control === 'foreign-token-baseline') donor.sourceTokens[0].baseline += 1
  if (control === 'missing-owned-glyph') donor.sourceTokens.pop()
  if (control === 'duplicate-owned-glyph')
    donor.sourceTokens.push(structuredClone(donor.sourceTokens[0]))
  if (control === 'correct-owner-cuts-glyph')
    cell(4, 2).rect[2] = cell(4, 2).sourceTokens.at(-1).rect[2] - 0.1
  if (control === 'correct-row-metadata-mismatch') f.table.rows[4].rect[3] += 0.1
  if (control === 'existing-rich-script')
    cell(4, 2).textRuns = [{ text: cell(4, 2).text, position: 'superscript' }]
  if (control === 'invalid-header-span') cell(0, 0).rowSpan = 1
  if (control === 'changed-calibration-literal') {
    const token = key.sourceTokens[0],
      item = native(token)
    token.text = item.text = 'Other-key'
    key.text = f.table.grid[4][1] = token.text
  }
  if (control === 'same-centroid-changed-calibration-box') {
    const token = key.sourceTokens[0],
      item = native(token)
    token.rect[0] += 0.1
    token.rect[2] -= 0.1
    item.rect = [...token.rect]
  }
  if (control === 'changed-calibration-offset') {
    for (const c of f.table.cells.filter((c: { row: number }) => c.row >= 4)) {
      for (const token of c.sourceTokens) {
        const item = native(token)
        token.baseline += 1
        token.rect[1] += 1
        token.rect[3] += 1
        item.baseline = token.baseline
        item.rect = [...token.rect]
      }
      c.rect[1] += 1
      c.rect[3] += 1
    }
    for (const row of f.table.rows.slice(4)) {
      row.rect[1] += 1
      row.rect[3] += 1
    }
  }
  if (control === 'no-separated-reference-pair') {
    for (let column = 0; column < 6; column++) {
      const first = cell(4, column),
        second = cell(5, column)
      first.rect[3] = second.rect[3]
      first.sourceTokens.push(...second.sourceTokens)
      first.text = [first.text, second.text].filter(Boolean).join(' ')
      f.table.grid[4][column] = first.text
    }
    f.table.cells = f.table.cells.filter((c: { row: number }) => c.row !== 5)
    f.table.rows[4].rect[3] = f.table.rows[5].rect[3]
    f.table.rows.pop()
    f.table.grid.pop()
  }
  for (const c of f.table.cells)
    c.sourceRects = c.sourceTokens.map((t: { rect: number[] }) => [...t.rect])
  if (control === 'missing-source-rectangle') donor.sourceRects.pop()
  if (control === 'duplicate-source-rectangle') donor.sourceRects[1] = [...donor.sourceRects[0]]
  if (control === 'source-rectangle-mismatch') donor.sourceRects[0][0] -= 1
  const before = structuredClone(f)
  expect(fencedPairProof(f)).toBeUndefined()
  expect(f).toEqual(before)
})

it('proves only the three incorrect native-fenced multiline stub partitions', () => {
  const f = fencedStubOwners(),
    before = structuredClone(f),
    proof = fencedStubProof(f)
  expect(
    proof?.replacements.map((p: { row: number; rowSpan: number }) => [p.row, p.rowSpan])
  ).toEqual([
    [7, 6],
    [13, 6],
    [25, 6]
  ])
  expect(f).toEqual(before)
})

it('derives ownership from fenced records when correct and incorrect group positions change', () => {
  const f = fencedStubOwners(),
    cells = f.table.cells,
    first = cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 0),
    second = cells.filter(
      (c: { row: number; column: number }) => c.row >= 7 && c.row < 13 && c.column === 0
    ),
    owner = second.find((c: { sourceTokens: unknown[] }) => c.sourceTokens.length === 4),
    newCorrect = {
      ...owner,
      row: 7,
      rowSpan: 6,
      rect: [
        Math.min(...second.map((c: { rect: number[] }) => c.rect[0])),
        Math.min(...second.map((c: { rect: number[] }) => c.rect[1])),
        Math.max(...second.map((c: { rect: number[] }) => c.rect[2])),
        Math.max(...second.map((c: { rect: number[] }) => c.rect[3]))
      ]
    },
    blank = { ...first, rowSpan: 1, text: '', sourceTokens: [], sourceRects: [] },
    shifted = { ...first, row: 2, rowSpan: 5 }
  delete blank.textRuns
  f.table.cells = cells
    .filter((c: unknown) => c !== first && !second.includes(c))
    .concat(blank, shifted, newCorrect)
  f.table.grid[1][0] = ''
  f.table.grid[2][0] = shifted.text
  for (let row = 7; row < 13; row++) f.table.grid[row][0] = row === 7 ? newCorrect.text : ''
  const before = structuredClone(f),
    proof = fencedStubProof(f)
  expect(proof?.replacements.map((p: { row: number }) => p.row)).toEqual([1, 13, 25])
  expect(
    proof.replacements.every((p: { donors: unknown[] }) => !p.donors.includes(newCorrect))
  ).toBe(true)
  expect(f).toEqual(before)
})

it('uses a smaller fully fenced source without depending on original row or glyph counts', () => {
  const f = fencedStubOwners(),
    closing = f.rules[3][1]
  f.rules = f.rules.slice(0, 4)
  f.items = f.items.filter((i: { rect: number[] }) => i.rect[3] < closing)
  f.table.cells = f.table.cells.filter((c: { row: number }) => c.row < 13)
  f.table.grid = f.table.grid.slice(0, 13)
  f.table.cropRect[3] = closing + 2
  const before = structuredClone(f),
    proof = fencedStubProof(f)
  expect(
    proof?.replacements.map((p: { row: number; rowSpan: number }) => [p.row, p.rowSpan])
  ).toEqual([[7, 6]])
  expect(proof.scriptParents.size).toBe(2)
  expect(f).toEqual(before)
})

it.each([
  'foreign-baseline',
  'duplicate-owner',
  'missing-unit-owner',
  'cross-group-owner',
  'missing-rich-script',
  'wrong-rich-parent',
  'source-rectangle-mismatch',
  'duplicate-source-rectangle',
  'invalid-donor-row-span',
  'correct-donor-cuts-own-glyph',
  'nonhorizontal-intersecting-ink'
])('rejects malformed final native-fenced stub ownership: %s', (control) => {
  const f = fencedStubOwners(),
    owner = f.table.cells.find(
      (c: { row: number; column: number }) => c.row === 8 && c.column === 0
    ),
    next = f.table.cells.find(
      (c: { row: number; column: number }) => c.row === 14 && c.column === 0
    )
  if (control === 'foreign-baseline') owner.sourceTokens[0].baseline += 1
  if (control === 'duplicate-owner') owner.sourceTokens.push(structuredClone(owner.sourceTokens[0]))
  if (control === 'missing-unit-owner') owner.sourceTokens.splice(2, 1)
  if (control === 'cross-group-owner') next.sourceTokens.push(owner.sourceTokens.pop())
  if (control === 'missing-rich-script') delete owner.textRuns
  if (control === 'wrong-rich-parent') {
    owner.sourceTokens.splice(1, 1)
    next.sourceTokens.push(structuredClone(f.labelGroups[1].nativeItems[1]))
  }
  if (control === 'invalid-donor-row-span') owner.rowSpan = 6
  if (control === 'correct-donor-cuts-own-glyph') {
    const correct = f.table.cells.find(
      (c: { row: number; column: number }) => c.row === 19 && c.column === 0
    )
    correct.rect[2] = correct.sourceTokens[1].rect[2] - 1
  }
  if (control === 'nonhorizontal-intersecting-ink')
    f.items.push({
      ...structuredClone(f.items.find((i: { height: number }) => i.height < 10)),
      horizontal: false,
      text: 'rotated ink'
    })
  for (const c of f.table.cells)
    c.sourceRects = c.sourceTokens.map((i: { rect: number[] }) => [...i.rect])
  if (control === 'source-rectangle-mismatch') owner.sourceRects[0] = [0, 0, 1, 1]
  if (control === 'duplicate-source-rectangle') owner.sourceRects[1] = [...owner.sourceRects[0]]
  const before = structuredClone(f)
  expect(fencedStubProof(f)).toBeUndefined()
  expect(f).toEqual(before)
})

it('requires a bijection of predecessor parent donors without replacing the correct parent or blanks', () => {
  const f = partialParentOwners(),
    before = structuredClone(f),
    proof = proveNativePartialRuleParentOwners(f.table, f.items, f.captions, f.rules, f.runs)
  expect(
    proof?.replacements.map((p: { donors: { column: number }[] }) => p.donors[0].column)
  ).toEqual([2, 6])
  expect(f).toEqual(before)
})

it.each([
  'foreign-source-donor',
  'duplicate-upper-owner',
  'missing-percentile-glyph',
  'inside-glyph-cut',
  'cross-parent-owner',
  'metadata-rectangle-mismatch',
  'missing-observed-runs'
])('rejects incomplete or foreign final upper-header ownership: %s', (control) => {
  const f = partialParentOwners(),
    cell = (column: number): ReturnType<typeof JSON.parse> =>
      f.table.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === column)
  if (control === 'foreign-source-donor') cell(6).sourceTokens[0].baseline += 1
  if (control === 'duplicate-upper-owner') {
    cell(7).sourceTokens.push(structuredClone(cell(6).sourceTokens[0]))
    cell(7).text += ' ' + cell(6).text
  }
  if (control === 'missing-percentile-glyph') {
    cell(7).sourceTokens[0].text = 'XX.'
    cell(7).text = 'XX.'
  }
  if (control === 'inside-glyph-cut') {
    cell(6).sourceTokens[0].rect[2] -= 3
    cell(7).sourceTokens[0].rect[0] -= 3
  }
  if (control === 'cross-parent-owner') {
    const tail = cell(7).sourceTokens.pop()
    cell(4).sourceTokens.push(tail)
    cell(4).text += ' ' + tail.text
    cell(7).text = ''
  }
  if (control === 'metadata-rectangle-mismatch') cell(6).sourceRects = [[0, 0, 1, 1]]
  else
    for (const c of f.table.cells)
      c.sourceRects = c.sourceTokens.map((i: { rect: number[] }) => [...i.rect])
  const before = structuredClone(f)
  expect(
    proveNativePartialRuleParentOwners(
      f.table,
      f.items,
      f.captions,
      f.rules,
      control === 'missing-observed-runs' ? undefined : f.runs
    )
  ).toBeUndefined()
  expect(f).toEqual(before)
})

it('recovers the missing paired metric leaf and consumes every printed glyph exactly once', () => {
  const f = fixture('native-printed-paired-leaves'),
    original = structuredClone(f),
    r = refine(f)
  expect(r.grid).toHaveLength(7)
  expect(r.grid.every((row: string[]) => row.length === 13)).toBe(true)
  expect(
    r.cells.filter((c: { row: number; colSpan: number }) => c.row === 0 && c.colSpan === 2)
  ).toHaveLength(6)
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toEqual(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
  expect(f).toEqual(original)
})

it.each(['opening', 'divider', 'footer', 'leaf', 'record', 'gutter', 'glyph-run'])(
  'requires the independent native frame and complete literal records: %s',
  (change) => {
    const f = fixture('native-printed-paired-leaves')
    const horizontal = f.rules.filter((r: number[]) => r[1] === r[3] && r[2] - r[0] > 500)
    if (change === 'opening') f.rules = f.rules.filter((r: number[]) => r !== horizontal[0])
    if (change === 'divider') f.rules = f.rules.filter((r: number[]) => r !== horizontal[1])
    if (change === 'footer') f.rules = f.rules.filter((r: number[]) => r !== horizontal.at(-1))
    if (change === 'leaf')
      f.tokens.splice(
        f.tokens.findIndex((i: { text: string }) => i.text === 'XXX'),
        1
      )
    if (change === 'record')
      f.tokens.splice(
        f.tokens.findLastIndex((i: { text: string }) => /^\d+(?:\.\d+)?$/u.test(i.text)),
        1
      )
    if (change === 'gutter') f.runs = []
    if (change === 'glyph-run')
      f.runs.forEach((r: { glyphRuns: number[] }) => {
        r.glyphRuns = r.glyphRuns.map((n, j) => n + j)
      })
    expect(plan(f)).toBeUndefined()
  }
)

it('recovers marked physical numeric records without changing tuple/thousands spaces or leading digits', () => {
  const f = fixture('native-printed-marked-lanes'),
    r = refine(f)
  expect(r.grid).toHaveLength(23)
  expect(r.grid.every((row: string[]) => row.length === 5)).toBe(true)
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toEqual(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
  const thousands = f.tokens.find((i: { text: string }) => /^\d{3}\s\d{3}/u.test(i.text))
  expect(thousands).toBeDefined()
  expect(
    r.cells.some(
      (c: { text: string }) => c.text === /^(\d{3}\s\d{3}\.\d+)/u.exec(thousands.text)?.[1]
    )
  ).toBe(true)
  const marked = f.tokens.find((i: { text: string }) => /[*⋆∗]/u.test(i.text))
  expect(marked).toBeDefined()
  expect(r.cells.some((c: { text: string }) => /[*⋆∗]/u.test(c.text))).toBe(true)
})

it('moves only repeated plain headers out of the first mathematical record', () => {
  const f = fixture('native-repeated-header-math-records'),
    r = refine(f)
  expect(r.grid[0]).toEqual([
    'Vertex',
    'Coordinates',
    'Vertex',
    'Coordinates',
    'Vertex',
    'Coordinates'
  ])
  expect(r.grid).toHaveLength(7)
  expect(
    r.grid
      .slice(1)
      .flat()
      .some((text: string) => /Vertex|Coordinates/u.test(text))
  ).toBe(false)
  expect(
    r.cells
      .filter((c: { row: number }) => c.row === 0)
      .every((c: { sourceRects: number[][] }) => c.sourceRects.length === 1)
  ).toBe(true)
  expect(
    r.cells.some(
      (c: { row: number; text: string; textRuns?: { position: string }[] }) =>
        c.row > 0 && c.text.includes('√') && c.textRuns?.some((run) => run.position === 'subscript')
    )
  ).toBe(true)
  expect(r.unassigned).toEqual([])
})

it('keeps a final complete record beyond a same-width internal separator', () => {
  const f = fixture('native-terminal-record-after-separator'),
    r = refine(f)
  expect(r.grid).toHaveLength(9)
  expect(r.grid.at(-1).slice(4, 6)).toEqual(['✓', '✓'])
  expect(r.cropRect[3]).toBeCloseTo(f.rules.at(-1)[1], 4)
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toEqual(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})

const token = (
  text: string,
  x: number,
  y: number,
  width = 10,
  height = 10
): ReturnType<typeof JSON.parse> => ({
  text,
  rect: [x, y - height, x + width, y],
  baseline: y,
  height,
  horizontal: true
})

function observedLiteralHeads(wrapped = false): ReturnType<typeof JSON.parse> {
  const heads = wrapped
      ? [
          token('Platform', 0, 32, 20),
          token('Toolchain', 40, 32, 25),
          token('Task A', 80, 32),
          token('Task B', 110, 32),
          token('literal', 80, 44),
          token('literal', 110, 44)
        ]
      : [token('Kind Place', 0, 35, 100), token('Count', 140, 35, 30)],
    tokens = [
      ...heads,
      ...(wrapped ? [65, 85] : [60, 80, 100, 120]).flatMap((y, n) =>
        wrapped
          ? [
              token('System ' + n, 0, y, 20),
              token('Version ' + n + '.2.3', 40, y, 25),
              token('1/1', 80, y),
              token('2/2', 110, y)
            ]
          : [
              token('Record ' + n, 0, y, 20),
              token('Source ' + n, 70, y, 30),
              token('100k', 140, y, 20)
            ]
      )
    ],
    crop = wrapped ? [0, 10, 125, 100] : [-1, 10, 181, 145]
  return {
    table: { cropRect: crop, structure: { objects: [] } },
    tokens,
    rules: (wrapped ? [20, 48, 95] : [20, 40, 135]).map((y) => [0, y, wrapped ? 160 : 180, y]),
    captions: [
      { lines: ['Table 1. Explicit literal records.'], rect: [0, -10, wrapped ? 160 : 180, 10] }
    ],
    runs: wrapped
      ? []
      : [
          {
            ...heads[0],
            literalGlyphs: [...'KindPlace'],
            glyphRuns: Array.from({ length: 9 }, () => 1),
            gaps: [{ left: 20, right: 70, index: 4 }]
          }
        ]
  }
}
const observedHeads = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  recoverNativeObservedLiteralHeaderRecords(f.table, f.tokens, f.captions, f.rules, f.runs)

it('splits only a witnessed joint header gutter backed by complete descriptive peers', () => {
  const f = observedLiteralHeads(),
    original = structuredClone(f),
    p = observedHeads(f)
  expect(p.groups).toHaveLength(5)
  expect(p.cuts).toHaveLength(4)
  expect(p.groups[0].map((i: { text: string }) => i.text)).toEqual(['Kind', 'Place', 'Count'])
  expect(p.groups.slice(1).flat()).toEqual(f.tokens.slice(2))
  expect(p.groups[0][0].sourceToken).toBe(f.tokens[0])
  expect(p.groups[0][1].sourceToken).toBe(f.tokens[0])
  expect(f).toEqual(original)
})

it('requires exact native title width and distinct centers for two-peer wrapped headers', () => {
  const f = observedLiteralHeads(true),
    original = structuredClone(f),
    p = observedHeads(f)
  expect(p.groups).toHaveLength(3)
  expect(p.cuts).toHaveLength(5)
  expect(p.groups.flat()).toHaveLength(f.tokens.length)
  expect(new Set(p.groups.flat()).size).toBe(f.tokens.length)
  expect(p.cropRect[2]).toBe(160.5)
  expect(f).toEqual(original)
})

it('retains equivalent native repeated strokes without treating them as a competing frame', () => {
  const f = observedLiteralHeads(true)
  f.rules.push(...structuredClone(f.rules))
  expect(observedHeads(f)?.cuts).toHaveLength(5)
})

it('counts overlapping shorter paint prefixes once when the title proves only the outer frame', () => {
  const f = observedLiteralHeads(true),
    expected = observedHeads(f)
  f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1], r[2] - 3, r[3]]))
  expect(observedHeads(f)).toEqual(expected)
})

it('refuses a joint header without operator evidence when observed runs are omitted', () => {
  const f = observedLiteralHeads()
  expect(
    recoverNativeObservedLiteralHeaderRecords(f.table, f.tokens, f.captions, f.rules)
  ).toBeUndefined()
})

it.each([
  'title',
  'footer',
  'duplicate',
  'missing-peer',
  'crossing-source',
  'bad-glyph',
  'no-gap',
  'crossing-gutter'
])('refuses an observed joint header without its complete literal proof: %s', (variant) => {
  const f = observedLiteralHeads()
  if (variant === 'title') f.captions = []
  if (variant === 'footer') f.rules.pop()
  if (variant === 'duplicate') f.tokens.push(structuredClone(f.tokens.at(-1)))
  if (variant === 'missing-peer') f.tokens.splice(3, 1)
  if (variant === 'crossing-source') f.tokens[2].rect[0] = -1
  if (variant === 'bad-glyph') f.runs[0].literalGlyphs[0] = '?'
  if (variant === 'no-gap') f.runs[0].gaps = []
  if (variant === 'crossing-gutter') f.tokens[3].rect[0] = 15
  expect(observedHeads(f)).toBeUndefined()
})
it.each([
  'title-width',
  'competing-title',
  'competing-frame',
  'wrapped-center',
  'outside-ink',
  'extra-record'
])('refuses a two-peer wrapped header without its combined native proof: %s', (variant) => {
  const f = observedLiteralHeads(true)
  if (variant === 'title-width') f.captions[0].rect[2] -= 10
  if (variant === 'competing-title') f.captions.push(structuredClone(f.captions[0]))
  if (variant === 'competing-frame')
    f.rules.push([0, 22, 157, 22], [0, 48, 157, 48], [0, 95, 157, 95])
  if (variant === 'wrapped-center') {
    f.tokens[4].rect[0] += 2
    f.tokens[4].rect[2] += 2
  }
  if (variant === 'outside-ink') f.tokens[9].rect[2] = 130
  if (variant === 'extra-record') f.tokens.push(token('foreign', 40, 75, 20))
  expect(observedHeads(f)).toBeUndefined()
})

function descriptiveDonor(): ReturnType<typeof JSON.parse> {
  const starts = [0, 80, 200, 240, 280, 320, 360],
    heads = starts.map((x, n) => token('Head ' + n, x, 35, 20)),
    cells = heads.map((i, column) => ({
      row: 0,
      column,
      rowSpan: 1,
      colSpan: 1,
      text: i.text,
      sourceTokens: [i]
    })),
    tokens = [...heads]
  for (let row = 1; row <= 5; row++) {
    const y = 40 + row * 20
    for (let column = 0; column < 7; column++) {
      const i =
        column === 0 && row === 4
          ? undefined
          : column === 1 && row === 4
            ? token('KeyDD SourceDDD', 0, y, 160)
            : column === 0
              ? token('KeyAA', 0, y, 45)
              : column === 1
                ? token('Source', 80, y, 80)
                : column === 6 && [1, 2, 4].includes(row)
                  ? undefined
                  : token('0.100', starts[column], y, 20)
      if (i) tokens.push(i)
      cells.push({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        text: i?.text ?? '',
        sourceTokens: i ? [i] : []
      })
    }
  }
  const donor = tokens.find((i) => i.text === 'KeyDD SourceDDD')
  return {
    table: { cropRect: [-1, 10, 401, 145] },
    tokens,
    cells,
    captions: [{ lines: ['Table 1. Descriptive source records.'], rect: [0, -10, 400, 10] }],
    rules: [20, 45, 145].map((y) => [0, y, 400, y]),
    runs: [
      {
        ...donor,
        literalGlyphs: [...'KeyDDSourceDDD'],
        glyphRuns: Array.from({ length: 14 }, () => 1),
        gaps: [{ left: 50, right: 80, index: 5 }]
      }
    ]
  }
}
const donorPlan = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  proveNativeDescriptiveRunOwners(f.table, f.tokens, f.captions, f.rules, f.runs, f.cells)

it('proves only two existing descriptive owners from a joint run without filling true terminal blanks', () => {
  const f = descriptiveDonor(),
    original = structuredClone(f),
    p = donorPlan(f)
  expect(p.parts.map((i: { text: string }) => i.text)).toEqual(['KeyDD', 'SourceDDD'])
  expect([p.target.row, p.target.column, p.donor.column]).toEqual([4, 0, 1])
  expect(p.cut).toBe(65)
  expect(f).toEqual(original)
})
it.each([
  'title',
  'footer',
  'occupied-recipient',
  'foreign-donor',
  'duplicate-owner',
  'missing-peers',
  'no-gap',
  'bad-glyph',
  'foreign-body',
  'wrong-baseline'
])('refuses a descriptive donor move without unique exact ownership: %s', (variant) => {
  const f = descriptiveDonor(),
    recipient = f.cells.find((c: { row: number; column: number }) => c.row === 4 && c.column === 0),
    donor = f.cells.find((c: { row: number; column: number }) => c.row === 4 && c.column === 1)
  if (variant === 'title') f.captions = []
  if (variant === 'footer') f.rules.pop()
  if (variant === 'occupied-recipient') recipient.text = 'foreign'
  if (variant === 'foreign-donor') donor.sourceTokens.push(f.tokens[0])
  if (variant === 'duplicate-owner')
    f.cells
      .find((c: { row: number; column: number }) => c.row === 4 && c.column === 2)
      .sourceTokens.push(donor.sourceTokens[0])
  if (variant === 'missing-peers')
    for (const row of [1, 2])
      f.cells.find(
        (c: { row: number; column: number }) => c.row === row && c.column === 0
      ).sourceTokens = []
  if (variant === 'no-gap') f.runs[0].gaps = []
  if (variant === 'bad-glyph') f.runs[0].literalGlyphs[0] = '?'
  if (variant === 'foreign-body') f.tokens.push(token('foreign', 30, 110, 20))
  if (variant === 'wrong-baseline')
    f.cells.find(
      (c: { row: number; column: number }) => c.row === 4 && c.column === 2
    ).sourceTokens[0].baseline += 5
  expect(donorPlan(f)).toBeUndefined()
})
function isolatedPair(): ReturnType<typeof JSON.parse> {
  const tokens = [
    token('A', 25, 35),
    token('B', 125, 35),
    token('C', 225, 35),
    ...[55, 75, 95].flatMap((y) => [10, 60, 110, 160, 210, 260].map((x) => token('1', x, y)))
  ]
  const rules = [20, 40].flatMap((y) => [
    [0, y, 99.7, y],
    [100.3, y, 199.7, y],
    [200.3, y, 300, y]
  ])
  rules.push([0, 105, 300, 105])
  rules.push(...[0, 100, 200, 300].map((x) => [x, 20, x, 40]))
  const rows = [0, 1, 2, 3].map((row) => ({
    rect: [0, row ? 42 + row * 16 : 20, 300, row ? 58 + row * 16 : 40]
  }))
  const cells = Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 6 }, (_, column) => {
      const sourceTokens = row
        ? [tokens[3 + (row - 1) * 6 + column]]
        : column % 2 === 0
          ? [tokens[column / 2]]
          : []
      return {
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 50, rows[row].rect[1], (column + 1) * 50, rows[row].rect[3]],
        text: sourceTokens.map((i: { text: string }) => i.text).join(''),
        sourceTokens,
        sourceRects: sourceTokens.map((i: { rect: number[] }) => i.rect)
      }
    })
  ).flat()
  return { table: { cropRect: [0, 18, 300, 107] }, tokens, rules, rows, cells }
}
it('uses drawn header faces to merge paired labels while leaving body records untouched', () => {
  const f = isolatedPair(),
    original = structuredClone(f)
  const p = recoverNativeIsolatedPrintedHeader(f.table, f.tokens, f.rules, f.cells, f.rows)
  expect(p?.mode).toBe('replace-pairs')
  expect(p?.groups.map((g: { text: string }[]) => g.map((i) => i.text).join(''))).toEqual([
    'A',
    'B',
    'C'
  ])
  expect(p?.columnOwnershipProved).toBe(true)
  expect(f).toEqual(original)
})
it.each(['crossed-ink', 'missing-token', 'duplicate-token', 'duplicate-slot', 'body-span'])(
  'keeps a column-conflict warning unless native body ownership is independently complete: %s',
  (change) => {
    const f = isolatedPair()
    if (change === 'crossed-ink') f.tokens[3].rect[2] = 65
    if (change === 'missing-token') f.cells[6].sourceTokens = []
    if (change === 'duplicate-token') f.cells[7].sourceTokens.push(f.tokens[3])
    if (change === 'duplicate-slot') f.cells.push(structuredClone(f.cells[6]))
    if (change === 'body-span') f.cells[6].colSpan = 2
    const p = recoverNativeIsolatedPrintedHeader(f.table, f.tokens, f.rules, f.cells, f.rows)
    expect(p?.mode).toBe('replace-pairs')
    expect(p?.columnOwnershipProved).toBe(false)
  }
)
it.each(['corner', 'open-face', 'foreign-header', 'body-owned-header'])(
  'does not infer paired header ownership without a complete native face: %s',
  (change) => {
    const f = isolatedPair()
    if (change === 'corner') f.rules = f.rules.filter((r: number[]) => r[0] !== r[2])
    if (change === 'open-face')
      f.rules = f.rules.filter((r: number[]) => !(r[0] === 100 && r[2] === 100))
    if (change === 'foreign-header') f.tokens.push(token('extra', 80, 35, 40))
    if (change === 'body-owned-header') f.cells[0].sourceTokens.push(f.tokens[3])
    expect(
      recoverNativeIsolatedPrintedHeader(f.table, f.tokens, f.rules, f.cells, f.rows)
    ).toBeUndefined()
  }
)

function indexedDirectory(): ReturnType<typeof JSON.parse> {
  const tokens = [
    token('Fig.', 10, 35, 20),
    token('Content', 50, 35, 30),
    token('Method', 120, 35, 35),
    token('Inputs', 220, 35, 35)
  ]
  for (let row = 1; row <= 4; row++)
    tokens.push(
      token(String(row), 10, 35 + row * 20),
      token('Name' + row, 50, 35 + row * 20, 35),
      token('Method' + row, 120, 35 + row * 20, 40),
      token('Inputs' + row, 220, 35 + row * 20, 40)
    )
  const rows = Array.from({ length: 5 }, (_, row) => ({
    rect: [0, 20 + row * 20, 300, 40 + row * 20]
  }))
  const cells = rows.flatMap((r, row) =>
    [0, 1, 2].map((column) => {
      const sourceTokens = tokens.filter(
        (i: { rect: number[]; baseline: number }) =>
          i.baseline > r.rect[1] &&
          i.baseline < r.rect[3] &&
          i.rect[0] >= column * 100 &&
          i.rect[2] <= (column + 1) * 100
      )
      return {
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 100, r.rect[1], (column + 1) * 100, r.rect[3]],
        text: sourceTokens.map((i: { text: string }) => i.text).join(' '),
        sourceTokens,
        sourceRects: sourceTokens.map((i: { rect: number[] }) => i.rect)
      }
    })
  )
  return {
    table: { cropRect: [0, 18, 300, 130] },
    tokens,
    rows,
    cells,
    rules: [
      [0, 20, 300, 20],
      [0, 40, 300, 40],
      [0, 125, 300, 125]
    ]
  }
}
it('restores a separately printed indexed leading leaf without rewriting the wrapped fields', () => {
  const f = indexedDirectory(),
    before = structuredClone(f)
  const p = recoverNativeIsolatedPrintedHeader(f.table, f.tokens, f.rules, f.cells, f.rows)
  expect(p?.mode).toBe('leading-index')
  expect(p?.header.map((i: { text: string }) => i.text)).toEqual(['Fig.', '1', '2', '3', '4'])
  expect(p?.cuts).toEqual([0, 40, 100, 200, 300])
  expect(f).toEqual(before)
})
it.each(['sequence', 'gutter', 'header', 'footer'])(
  'refuses an indexed leaf without complete independent printed evidence: %s',
  (change) => {
    const f = indexedDirectory()
    if (change === 'sequence') f.tokens[12].text = '2'
    if (change === 'gutter') f.tokens[5].rect[0] = 20
    if (change === 'header') f.tokens.splice(1, 1)
    if (change === 'footer') f.rules.pop()
    expect(
      recoverNativeIsolatedPrintedHeader(f.table, f.tokens, f.rules, f.cells, f.rows)
    ).toBeUndefined()
  }
)
function terminalProse(): ReturnType<typeof JSON.parse> {
  const rows = [
    [0, 10, 300, 20],
    [0, 24, 300, 51],
    [0, 54, 300, 81],
    [0, 84, 300, 107],
    [0, 108, 300, 128]
  ].map((rect) => ({ rect }))
  const items = [token('Key', 10, 20), token('Definition', 110, 20, 60), token('Note', 210, 20, 25)]
  for (const [n, y] of [34, 64, 94].entries())
    items.push(
      token('Record' + n, 10, y, 50),
      token('first field', 110, y, 55),
      token('more field', 110, y + 12, 55),
      token('second field', 210, y, 60),
      token('more field', 210, y + 12, 55)
    )
  items.push(token('tail', 110, 118, 20), token('continuation', 210, 118, 55))
  return {
    rows,
    items,
    columnRects: [
      [0, 0, 100, 128],
      [100, 0, 200, 128],
      [200, 0, 300, 128]
    ],
    rules: [[0, 127, 300, 127]],
    right: 300,
    repairs: [],
    captioned: true
  }
}
it('keeps simultaneous final prose wraps in one physical record when the footer and repeated wraps agree', () => {
  const f = terminalProse()
  repairWrappedTableRows(f)
  expect(f.rows).toHaveLength(4)
  expect(f.repairs).toContain('recovered-row-continuation-included')
})
it.each(['stub', 'intervening-rule', 'footer', 'uppercase', 'prior-wrap'])(
  'keeps a terminal fragment separate when continuation ownership is not unique: %s',
  (change) => {
    const f = terminalProse()
    if (change === 'stub') f.items.push(token('NewRecord', 10, 118, 50))
    if (change === 'intervening-rule') f.rules.push([0, 107.5, 300, 107.5])
    if (change === 'footer') f.rules = []
    if (change === 'uppercase') f.items.at(-1).text = 'Continuation'
    if (change === 'prior-wrap')
      f.items = f.items.filter((i: { baseline: number }) => i.baseline !== 46)
    repairWrappedTableRows(f)
    expect(f.repairs).not.toContain('recovered-row-continuation-included')
  }
)

function groupedNumericPeers(): ReturnType<typeof JSON.parse> {
  const text = '12 1 - 11 1 280 298.235',
    combined = token(text, 10, 40, 155)
  return {
    table: {
      cropRect: [0, 0, 300, 100],
      structure: {
        objects: [0, 100, 200].map((x) => ({ label: 'table column', rect: [x, 0, x + 100, 100] }))
      }
    },
    tokens: [
      token('Identifier', 10, 20, 50),
      token('Frequency', 110, 20, 55),
      token('Value', 220, 20, 35),
      combined,
      token('1.91', 220, 40, 25),
      ...[60, 80].flatMap((y) => [
        token('12 2 - 11 2', 10, y, 75),
        token('280 310.000', 110, y, 55),
        token('1.93', 220, y, 25)
      ])
    ],
    rules: [
      [0, 5, 300, 5],
      [0, 25, 300, 25],
      [0, 95, 300, 95]
    ],
    captions: [{ lines: ['Table 1. Anonymous measured lanes.'], rect: [0, -20, 300, -10] }],
    runs: [
      {
        ...combined,
        literalGlyphs: [...text.replace(/\s/gu, '')],
        glyphRuns: Array(text.replace(/\s/gu, '').length).fill(3),
        gaps: [{ left: 85, right: 110, index: 7 }]
      }
    ]
  }
}
it('uses complete thousands-grouped numeric peers to recover a single exact transition/frequency gutter', () => {
  const f = groupedNumericPeers()
  const split = recoverNativePrintedLaneTokens(f.table, f.tokens, f.captions, f.rules, f.runs)
  expect(
    split
      .filter((i: { nativeLaneSplit?: boolean }) => i.nativeLaneSplit)
      .map((i: { text: string }) => i.text)
  ).toEqual(['12 1 - 11 1', '280 298.235'])
  expect(glyphs(split.map((i: { text: string }) => i.text))).toEqual(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})
it.each(['one-peer', 'tuple-peer', 'unobserved-gap'])(
  'does not treat arbitrary internal spaces as numeric lane proof: %s',
  (change) => {
    const f = groupedNumericPeers()
    if (change === 'one-peer') f.tokens.splice(8, 3)
    if (change === 'tuple-peer') f.tokens[6].text = f.tokens[9].text = '28 31 000'
    if (change === 'unobserved-gap') f.runs[0].gaps = []
    expect(recoverNativePrintedLaneTokens(f.table, f.tokens, f.captions, f.rules, f.runs)).toBe(
      f.tokens
    )
  }
)

function unownedScientificFirstRecord(): ReturnType<typeof JSON.parse> {
  const tokens = [
    token('Species', 10, 20, 40),
    token('No. of', 120, 20, 30),
    token('N', 215, 20),
    token('T', 320, 20),
    token('lines', 120, 40, 25),
    token('[cm]', 215, 40, 30),
    token('[K]', 320, 40, 20)
  ]
  for (const [n, y] of [60, 82, 104, 126, 148, 170].entries()) {
    if (n !== 1 && n !== 4)
      tokens.push(
        token('AB', 10, y, 15),
        token('2', 25, y + 2, 4, 7),
        token('CN', 30, y, 13),
        token('v', 50, y, 5),
        token('=', 63, y, 6),
        token('0', 78, y, 5),
        token(String(n + 6), 120, y, 5)
      )
    tokens.push(
      token(n ? 'c' : 'b', 215, y - 4, 4, 7),
      token('3.1', 223, y, 15),
      token('+', 240, y - 4, 4, 7),
      token('0', 245, y - 4, 4, 7),
      token('.', 249, y - 4, 2, 7),
      token('4', 251, y - 4, 4, 7),
      token('−', 240, y + 4, 4, 7),
      token('0', 245, y + 4, 4, 7),
      token('.', 249, y + 4, 2, 7),
      token('5', 251, y + 4, 4, 7),
      token('×', 260, y, 7),
      token('10', 270, y, 10),
      token('14', 280, y - 4, 8, 7),
      token(n ? '[150]' : '–', 320, y, n ? 28 : 5)
    )
  }
  const objects = [0, 100, 200, 300].map((x) => ({
    label: 'table column',
    score: 1,
    rect: [x, 0, x + 100, 190]
  }))
  objects.push(
    ...[
      [9, 26],
      [30, 48],
      [42, 86],
      [61, 86],
      [87, 108],
      [109, 130],
      [131, 152],
      [153, 178]
    ].map(([top, bottom], n) => ({
      label: 'table row',
      score: n === 2 ? 0.56 : 0.8,
      rect: [0, top, 400, bottom]
    })),
    { label: 'table column header', score: 1, rect: [0, 9, 400, 48] }
  )
  return {
    table: { id: 'anonymous-table', cropRect: [0, 0, 400, 190], structure: { objects } },
    tokens,
    captions: [
      { lines: ['Table 1. Anonymous scientific measurements.'], rect: [0, -20, 400, -10] }
    ],
    rules: [
      [0, 5, 400, 5],
      [0, 8, 400, 8],
      [0, 45, 400, 45],
      [0, 183, 400, 183]
    ],
    runs: []
  }
}
it('restores only a wholly unowned first physical record and preserves printed blank continuations', () => {
  const f = unownedScientificFirstRecord(),
    original = structuredClone(f),
    r = refine(f)
  expect(r.grid).toHaveLength(8)
  expect(r.grid[2].slice(0, 2)).toEqual(['AB2 CN v = 0', '6'])
  expect(r.grid[3].slice(0, 2)).toEqual(['', ''])
  expect(r.grid[6].slice(0, 2)).toEqual(['', ''])
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toEqual(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
  const first = r.cells.filter((c: { row: number }) => c.row === 2)
  expect(first.flatMap((c: { sourceRects: number[][] }) => c.sourceRects)).toHaveLength(21)
  expect(r.repairs).toContain('native-unowned-first-record-recovered')
  expect(f).toEqual(original)
})
it.each([
  'open-frame',
  'competing-frame',
  'crossed-leaf',
  'tied-glyph',
  'missing-anchor',
  'foreign-gap',
  'partial-record',
  'partial-owner',
  'missing-peers',
  'unlabelled-leaf',
  'caption',
  'competing-caption',
  'intervening-rule',
  'duplicate-source'
])(
  'does not invent a first scientific record when native ownership is incomplete: %s',
  (change) => {
    const f = unownedScientificFirstRecord()
    if (change === 'open-frame') f.rules.pop()
    if (change === 'competing-frame') f.rules.push([10, 181, 390, 181])
    if (change === 'crossed-leaf') f.tokens[7].rect[2] = 110
    if (change === 'tied-glyph') {
      f.tokens[8].baseline = 71
      f.tokens[8].rect[1] = 64
      f.tokens[8].rect[3] = 71
    }
    if (change === 'missing-anchor') {
      f.tokens[13].height = 7
      f.tokens[13].rect[1] = 53
    }
    if (change === 'foreign-gap') f.tokens.push(token('foreign', 75, 68, 15, 2))
    if (change === 'partial-record') f.tokens.splice(27, 1)
    if (change === 'partial-owner')
      f.table.structure.objects.push({ label: 'table row', score: 1, rect: [0, 49, 400, 61] })
    if (change === 'missing-peers')
      f.tokens = f.tokens.filter(
        (i: { baseline: number; rect: number[] }) =>
          !(i.rect[0] === 120 && [104, 126].includes(i.baseline))
      )
    if (change === 'unlabelled-leaf')
      f.tokens = f.tokens.filter((i: { text: string }) => !['No. of', 'lines'].includes(i.text))
    if (change === 'caption') f.captions = []
    if (change === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
    if (change === 'intervening-rule') f.rules.push([0, 66, 400, 66])
    if (change === 'duplicate-source') f.tokens.push(structuredClone(f.tokens[7]))
    const r = refine(f)
    expect(r.repairs).not.toContain('native-unowned-first-record-recovered')
  }
)

function rowlessNativeFrame(
  leaves: number,
  records: number,
  modelLeaves = leaves
): ReturnType<typeof JSON.parse> {
  const right = leaves * 100,
    footer = 142 + records * 20,
    tokens = Array.from({ length: leaves }, (_, c) =>
      c ? token(`Field ${c}`, c * 100 + 12, 123, 45) : undefined
    ).filter(Boolean)
  for (let r = 0; r < records; r++)
    for (let c = 0; c < leaves; c++)
      if (!(modelLeaves === 1 && r === records - 1 && c === 1))
        tokens.push(
          token(
            c === 0 ? `Group ${r}` : c === 1 ? `Config ${r}` : `${r + c}.2`,
            c * 100 + 12,
            148 + r * 20,
            c < 2 ? 60 : 30
          )
        )
  return {
    table: {
      id: 'anonymous-rowless-table',
      cropRect: [0, 100, right, footer + 4],
      structure: {
        objects: [
          ...Array.from({ length: modelLeaves }, (_, c) => ({
            label: 'table column',
            score: 0.98,
            rect: [(c * right) / modelLeaves, 35, ((c + 1) * right) / modelLeaves, footer - 100]
          })),
          { label: 'table', score: 0.98, rect: [0, 35, right, footer - 100] }
        ]
      }
    },
    tokens,
    captions: [
      {
        lines: ['Table 1. Anonymous closed comparison.'],
        rect: [modelLeaves === 1 ? right * 0.4 : 0, 80, modelLeaves === 1 ? right * 0.6 : right, 95]
      }
    ],
    rules: [105, 130, footer].map((y) => [0, y, right, y]),
    runs: []
  }
}

it.each([
  [5, 2, 5],
  [9, 8, 9],
  [5, 2, 1]
])(
  'recovers only independently closed native records when model rows are absent: %i leaves, %i records, %i model columns',
  (leaves, records, modelLeaves) => {
    const f = rowlessNativeFrame(leaves, records, modelLeaves),
      original = structuredClone(f),
      r = refine(f)
    expect(r.repairs).toContain('native-rowless-closed-records-recovered')
    expect(r.grid).toHaveLength(records + 1)
    expect(r.grid.every((row: string[]) => row.length === leaves)).toBe(true)
    expect(r.grid[0][0]).toBe('')
    if (modelLeaves === 1) expect(r.grid.at(-1)[1]).toBe('')
    expect(r.unassigned).toEqual([])
    expect(r.issues).not.toContain('missing-row-or-column')
    expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toEqual(
      glyphs(f.tokens.map((i: { text: string }) => i.text))
    )
    expect(f).toEqual(original)
  }
)

it.each([
  'opening',
  'divider',
  'footer',
  'caption',
  'competing-caption',
  'record',
  'foreign-gap',
  'crossed-gutter',
  'duplicate-source',
  'model-row'
])(
  'rejects rowless repair without its complete native frame and unique literal ownership: %s',
  (change) => {
    const f = rowlessNativeFrame(5, 2)
    if (change === 'opening') f.rules.shift()
    if (change === 'divider') f.rules.splice(1, 1)
    if (change === 'footer') f.rules.pop()
    if (change === 'caption') f.captions = []
    if (change === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
    if (change === 'record') f.tokens.pop()
    if (change === 'foreign-gap') f.tokens.push(token('foreign prose', 82, 140, 45))
    if (change === 'crossed-gutter') f.tokens.at(-1).rect[0] = 330
    if (change === 'duplicate-source') f.tokens.push(structuredClone(f.tokens.at(-1)))
    if (change === 'model-row')
      f.table.structure.objects.push({ label: 'table row', score: 0.9, rect: [0, 40, 500, 60] })
    expect(refine(f).repairs).not.toContain('native-rowless-closed-records-recovered')
  }
)

function closedMultilineHeader(): ReturnType<typeof JSON.parse> {
  const header = [
    [token('Design', 5, 35, 30), token('parameter', 5, 45, 45)],
    [token('Primary influence', 105, 35, 85)],
    [token('Spatial range', 205, 35, 70)],
    [token('Obser', 305, 35, 25), token('vation', 330, 35, 25), token('context', 360, 35, 35)]
  ]
  const rows = [20, 80, 110].map((top, n) => ({ rect: [0, top, 400, n ? top + 28 : 78] }))
  const cells = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 4 }, (_, column) => {
      const body = token(`Value ${row}`, column * 100 + 5, row ? rows[row].rect[1] + 15 : 65, 55)
      const sourceTokens = row ? [body] : [...header[column], body]
      return {
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [column * 100, rows[row].rect[1], (column + 1) * 100, rows[row].rect[3]],
        sourceTokens,
        sourceRects: sourceTokens.map((i) => i.rect),
        text: row
          ? body.text
          : [
              column === 3 ? 'Observation context' : header[column].map((i) => i.text).join(' '),
              body.text
            ].join(' ')
      }
    })
  ).flat()
  const rules = [20, 50, 78, 108, 140].flatMap((y) =>
    Array.from({ length: 4 }, (_, c) => [c * 100 + 0.3, y, (c + 1) * 100 - 0.3, y])
  )
  rules.push(...[0, 100, 200, 300, 400].map((x) => [x, 20, x, 140]))
  return {
    table: { cropRect: [0, 18, 400, 143] },
    tokens: cells.flatMap((c) => c.sourceTokens),
    rules,
    rows,
    cells
  }
}

it('isolates only the native closed multiline header from the first narrative record', () => {
  const f = closedMultilineHeader(),
    original = structuredClone(f)
  const header = recoverNativeIsolatedPrintedHeader(f.table, f.tokens, f.rules, f.cells, f.rows)
  expect(header?.mode).toBe('insert')
  expect(header?.groups.map((g: { text: string }[]) => glyphs(g.map((i) => i.text)))).toEqual([
    glyphs(['Design parameter']),
    glyphs(['Primary influence']),
    glyphs(['Spatial range']),
    glyphs(['Observation context'])
  ])
  expect(f).toEqual(original)
})
it.each(['wall', 'divider', 'prefix', 'foreign', 'crossed-face', 'spanning-body'])(
  'does not detach a narrative header without complete closed-face ownership: %s',
  (change) => {
    const f = closedMultilineHeader()
    if (change === 'wall') f.rules = f.rules.filter((r: number[]) => r[0] !== 200 || r[2] !== 200)
    if (change === 'divider') f.rules = f.rules.filter((r: number[]) => r[1] !== 50 || r[3] !== 50)
    if (change === 'prefix') f.cells[0].text = 'Unrelated ' + f.cells[0].text
    if (change === 'foreign') f.tokens.push(token('foreign', 305, 45, 30))
    if (change === 'crossed-face') f.cells[4].sourceTokens[0].rect[2] = 120
    if (change === 'spanning-body') f.cells[4].rowSpan = 2
    expect(
      recoverNativeIsolatedPrintedHeader(f.table, f.tokens, f.rules, f.cells, f.rows)
    ).toBeUndefined()
  }
)

function nativeSignedExponent(): ReturnType<typeof JSON.parse> {
  const tokens = [token('Setting', 10, 35, 50), token('Value', 170, 35, 35)]
  for (const [n, y] of [65, 90, 110, 130].entries()) {
    tokens.push(token(`Field ${n}`, 10, y, 60))
    if (n) tokens.push(token('0.5', 170, y, 20))
    else
      tokens.push(
        token('10', 170, y, 10),
        token('−', 180, y - 3.6, 6.2, 7),
        token('4', 186.2, y - 3.6, 4, 7)
      )
  }
  return {
    table: {
      id: 'anonymous-raised-signed-value',
      cropRect: [0, 18, 240, 144],
      structure: {
        objects: [
          ...[
            [0, 140],
            [140, 240]
          ].map(([left, right]) => ({ label: 'table column', rect: [left, 2, right, 122] })),
          ...[
            [20, 45],
            [45, 80],
            [80, 100],
            [100, 120],
            [120, 140]
          ].map(([top, bottom]) => ({ label: 'table row', rect: [0, top - 18, 240, bottom - 18] })),
          { label: 'table column header', rect: [0, 2, 240, 27] }
        ]
      }
    },
    tokens,
    captions: [{ lines: ['Table 1. Literal scalar settings.'], rect: [0, 0, 240, 15] }],
    rules: [20, 45, 140].map((y) => [0, y, 240, y]),
    runs: []
  }
}
it('keeps the touching native digit on the already proved raised sign baseline', () => {
  const f = nativeSignedExponent(),
    r = refine(f)
  expect(r.repairs).toContain('native-closed-leaf-complete-records-recovered')
  const cell = r.cells.find((c: { text: string }) => c.text === '10−4')
  expect(cell?.textRuns).toEqual([
    { text: '10', position: 'normal' },
    { text: '−4', position: 'superscript' }
  ])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})
it.each(['gap', 'baseline', 'ordinary-height', 'non-sign', 'punctuation'])(
  'does not continue a raised signed scalar without matching native glyph evidence: %s',
  (change) => {
    const f = nativeSignedExponent(),
      sign = f.tokens.find((i: { text: string }) => i.text === '−'),
      digit = f.tokens.find((i: { text: string }) => i.text === '4')
    if (change === 'gap') {
      digit.rect[0] += 0.5
      digit.rect[2] += 0.5
    }
    if (change === 'baseline') {
      digit.baseline += 0.5
      digit.rect[1] += 0.5
      digit.rect[3] += 0.5
    }
    if (change === 'ordinary-height') {
      digit.height = 10
      digit.rect[1] = digit.baseline - 10
    }
    if (change === 'non-sign') sign.text = 'x'
    if (change === 'punctuation') digit.text = ','
    const runs = refine(f).cells.flatMap(
      (c: { textRuns?: { text: string; position: string }[] }) => c.textRuns ?? []
    )
    expect(
      runs.some(
        (r: { text: string; position: string }) =>
          r.position === 'superscript' && r.text.includes(change === 'punctuation' ? ',' : '4')
      )
    ).toBe(false)
  }
)

function nativeJoinedMetricHeader(count = 5): ReturnType<typeof JSON.parse> {
  const right = count * 100,
    names = Array.from({ length: count - 1 }, (_, c) => `Leaf${c}`),
    text = names.join(' '),
    header = token(text, 110, 55, (count - 2) * 100 + 35)
  const gaps = names.slice(1).map((_, n) => ({
    left: 145 + n * 100,
    right: 210 + n * 100,
    index: names.slice(0, n + 1).join('').length
  }))
  const tokens = [
    token('Model', 10, 40, 40),
    header,
    token('Upper A', 115, 35, 120),
    token('Upper B', 305, 35, 120),
    token('Neutral group', right / 2 - 40, 75, 80)
  ]
  for (const [n, y] of [90, 115, 140].entries())
    for (let c = 0; c < count; c++)
      tokens.push(token(c ? `${n + c}.0` : `Method ${n}`, c * 100 + 10, y, c ? 30 : 60))
  return {
    table: {
      id: 'anonymous-native-header-fields',
      cropRect: [0, 18, right, 164],
      structure: {
        objects: [
          ...Array.from({ length: count }, (_, c) => ({
            label: 'table column',
            rect: [c * 100, 2, (c + 1) * 100, 146]
          })),
          ...[
            [20, 65],
            [65, 105],
            [105, 130],
            [130, 160]
          ].map(([a, b]) => ({ label: 'table row', rect: [0, a - 18, right, b - 18] }))
        ]
      }
    },
    tokens,
    captions: [{ lines: ['Table 1. Native grouped metric leaves.'], rect: [0, 0, right, 15] }],
    rules: [
      [0, 20, right, 20],
      [0, 65, right, 65],
      [0, 160, right, 160],
      [100, 42, 290, 42],
      [300, 42, 490, 42]
    ],
    runs: [
      {
        text,
        rect: header.rect,
        height: 10,
        baseline: 55,
        gaps,
        glyphRuns: Array.from(text.replace(/\s/gu, ''), () => 1),
        literalGlyphs: [...text.replace(/\s/gu, '')]
      }
    ]
  }
}
it('proves every joined lower header leaf and retains a separately printed full-width section', () => {
  const f = nativeJoinedMetricHeader(),
    r = refine(f)
  expect(r.repairs).toContain('native-printed-leaf-records-recovered')
  expect(r.grid).toHaveLength(6)
  expect(r.grid.every((row: string[]) => row.length === 5)).toBe(true)
  expect(r.cells.find((c: { text: string }) => c.text === 'Neutral group')?.colSpan).toBe(5)
  expect(r.cells.filter((c: { text: string }) => /^Leaf\d$/u.test(c.text))).toHaveLength(4)
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})
function nativeWallOverModelCut(): ReturnType<typeof JSON.parse> {
  const f = nativeJoinedMetricHeader()
  const columns = f.table.structure.objects.filter(
    (o: { label: string }) => o.label === 'table column'
  )
  columns[2].rect[2] = 250
  columns[3].rect[0] = 250
  for (const i of f.tokens.filter(
    (i: ReturnType<typeof token>) => i.baseline >= 90 && i.rect[0] === 210
  ))
    i.rect[2] = 294
  const a = f.tokens.find((i: ReturnType<typeof token>) => i.baseline === 140 && i.rect[0] === 210),
    b = f.tokens.find((i: ReturnType<typeof token>) => i.baseline === 140 && i.rect[0] === 310)
  a.text += ' ' + b.text
  a.rect[2] = b.rect[2]
  f.tokens.splice(f.tokens.indexOf(b), 1)
  f.runs.push({
    text: a.text,
    rect: a.rect,
    baseline: 140,
    height: 10,
    gaps: [{ left: 294, right: 310, index: 3 }],
    glyphRuns: Array.from(a.text.replace(/\s/gu, ''), () => 1),
    literalGlyphs: [...a.text.replace(/\s/gu, '')]
  })
  f.rules.push([300, 20, 300, 160])
  return f
}
it('prefers a complete native body wall with an exact TJ boundary over a model cut inside a literal numeric field', () => {
  const f = nativeWallOverModelCut(),
    r = refine(f)
  expect(r.repairs).toContain('native-printed-leaf-records-recovered')
  expect(r.grid.at(-1)).toEqual(['Method 2', '3.0', '4.0', '5.0', '6.0'])
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})
it.each(['wall', 'partial-wall', 'operator-gap', 'crossed-glyph'])(
  'does not replace a model cut without a complete native divider and literal gutter: %s',
  (change) => {
    const f = nativeWallOverModelCut()
    if (change === 'wall') f.rules.pop()
    if (change === 'partial-wall') f.rules.at(-1)[3] = 100
    if (change === 'operator-gap') f.runs.pop()
    if (change === 'crossed-glyph') f.tokens.push(token('crossing', 290, 115, 25))
    expect(plan(f)).toBeUndefined()
  }
)
it.each([
  'operator',
  'glyph-order',
  'incomplete-peer',
  'crossed-leaf',
  'off-center-section',
  'section-fence',
  'foreign'
])('requires independent native leaves and a separately witnessed section: %s', (change) => {
  const f = nativeJoinedMetricHeader()
  if (change === 'operator') f.runs = []
  if (change === 'glyph-order') f.runs[0].literalGlyphs.reverse()
  if (change === 'incomplete-peer') f.tokens.pop()
  if (change === 'crossed-leaf') f.tokens.at(-1).rect[0] -= 60
  if (change === 'off-center-section') {
    f.tokens[4].rect[0] -= 80
    f.tokens[4].rect[2] -= 80
  }
  if (change === 'section-fence') f.rules = f.rules.filter((r: number[]) => r[1] !== 65)
  if (change === 'foreign') f.tokens.push(token('ordinary prose tail', 20, 150, 160))
  expect(plan(f)).toBeUndefined()
})
it('proves seventeen native leaf headings without increasing the model column limit', () => {
  const f = nativeJoinedMetricHeader(17),
    r = refine(f)
  expect(r.repairs).toContain('native-printed-leaf-records-recovered')
  expect(r.grid.every((row: string[]) => row.length === 17)).toBe(true)
  expect(r.unassigned).toEqual([])
  expect(r.cells.filter((c: { text: string }) => /^Leaf\d+$/u.test(c.text))).toHaveLength(16)
})

function nativeWrappedMetricStub(): ReturnType<typeof JSON.parse> {
  const f = nativeJoinedMetricHeader(9)
  f.tokens = [
    token('Method', 10, 40, 40),
    token('Parent A', 220, 35, 80),
    token('Parent B', 520, 35, 80),
    ...Array.from({ length: 6 }, (_, c) => token(`Leaf${c}`, c * 100 + 110, 55, 35)),
    token('Intent-', 710, 35, 35),
    token('Driven', 710, 47.5, 35),
    token('Total', 810, 40, 35)
  ]
  for (const [n, y] of [90, 115, 140].entries())
    for (let c = 0; c < 9; c++)
      f.tokens.push(token(c ? `${n + c}.0` : `Method ${n}`, c * 100 + 10, y, c ? 30 : 60))
  f.rules = [
    [0, 20, 900, 20],
    [0, 65, 900, 65],
    [0, 160, 900, 160],
    [100, 42, 390, 42],
    [400, 42, 690, 42],
    [700, 20, 700, 160],
    [800, 20, 800, 160]
  ]
  f.runs = []
  return f
}

it('keeps native wrapped and centered stub headers within two ruled metric tiers', () => {
  const f = nativeWrappedMetricStub(),
    r = refine(f)
  expect(plan(f)?.headerRows).toBe(2)
  expect(r.grid).toHaveLength(5)
  for (const name of ['Method', 'Total']) {
    const stub = r.cells.find((c: { text: string; row: number }) => c.row < 2 && c.text === name)
    expect(stub?.row).toBe(0)
    expect(stub?.rowSpan).toBe(2)
  }
  const wrapped = r.cells.filter((c: { text: string }) => /Intent-|Driven/u.test(c.text))
  expect(wrapped).toHaveLength(1)
  expect(wrapped[0].rowSpan).toBe(2)
  expect(wrapped[0].text.replace(/\s/gu, '')).toBe('Intent-Driven')
  expect(wrapped[0].sourceRects).toHaveLength(2)
  expect(r.grid.slice(2)).toEqual(
    [0, 1, 2].map((n) => Array.from({ length: 9 }, (_, c) => (c ? `${n + c}.0` : `Method ${n}`)))
  )
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})

it.each(['independent-label', 'foreign-stub', 'stub-divider'])(
  'does not merge competing native stub headings: %s',
  (change) => {
    const f = nativeWrappedMetricStub()
    if (change === 'independent-label')
      f.tokens.find((i: { text: string }) => i.text === 'Intent-').text = 'Intent'
    if (change === 'foreign-stub') f.tokens.push(token('Other', 765, 47.5, 25))
    if (change === 'stub-divider') f.rules.push([700, 42, 800, 42])
    const r = plan(f)
    expect(
      r?.spans.some(
        (s: { items: { text: string }[]; rowSpan: number }) =>
          s.rowSpan > 1 &&
          s.items.some((i) => i.text === 'Intent-') &&
          s.items.some((i) => i.text === 'Driven')
      )
    ).not.toBe(true)
  }
)

function nativeUnequalIntermediateParents(): ReturnType<typeof JSON.parse> {
  const f = nativeJoinedMetricHeader(8)
  f.tokens = [
    token('Method', 10, 40, 40),
    token('Parent A', 200, 35, 120),
    token('Parent B', 600, 35, 100),
    ...Array.from({ length: 7 }, (_, c) => token(`Leaf${c}`, c * 100 + 110, 60, 35)),
    token('Lead', 110, 55, 35),
    token('Next phrase', 210, 55, 140),
    token('Total', 410, 55, 35),
    token('Lead', 510, 55, 35),
    token('Next phrase', 610, 55, 140)
  ]
  for (const [n, y] of [120, 145, 170].entries())
    for (let c = 0; c < 8; c++)
      f.tokens.push(token(c ? `${n + c}.0` : `Method ${n}`, c * 100 + 10, y, c ? 30 : 60))
  f.rules = [
    [0, 20, 800, 20],
    [0, 68, 800, 68],
    [0, 190, 800, 190],
    [100, 42, 490, 42],
    [500, 42, 790, 42],
    [500, 45, 500, 190]
  ]
  f.table.cropRect[3] = 194
  f.runs = []
  return f
}

it('partitions an intermediate parent tier only within two independently underlined native domains', () => {
  const f = nativeUnequalIntermediateParents(),
    r = plan(f)
  expect(r?.headerRows).toBe(3)
  expect(
    r?.spans
      .filter((s: { row: number }) => s.row === 1)
      .map((s: { column: number; colSpan: number }) => [s.column, s.colSpan])
  ).toEqual([
    [1, 1],
    [2, 2],
    [4, 1],
    [5, 1],
    [6, 2]
  ])
})

it.each(['missing-peer', 'domain-underline', 'cross-domain', 'overlapping-peers'])(
  'requires a complete printed intermediate parent partition: %s',
  (change) => {
    const f = nativeUnequalIntermediateParents()
    if (change === 'missing-peer')
      f.tokens.splice(
        f.tokens.findIndex((i: { text: string }) => i.text === 'Lead'),
        1
      )
    if (change === 'domain-underline')
      f.rules = f.rules.filter((r: number[]) => !(r[1] === 42 && r[0] === 100))
    if (change === 'cross-domain')
      f.tokens.find((i: { text: string }) => i.text === 'Next phrase').rect[2] += 200
    if (change === 'overlapping-peers')
      f.tokens.find((i: { text: string }) => i.text === 'Next phrase').rect[2] += 120
    expect(plan(f)).toBeUndefined()
  }
)

it('retains an explicit left section label in a full native horizontal face without copying it into records', () => {
  const f = nativeJoinedMetricHeader()
  f.tokens[4] = token('Cohort-4B', 5, 75, 70)
  f.rules.push([0, 80, 500, 80])
  const r = plan(f),
    s = r?.spans.find((s: { items: { text: string }[] }) =>
      s.items.some((i) => i.text === 'Cohort-4B')
    )
  expect(s?.colSpan).toBe(5)
  expect(r?.groups.flat().filter((i: { text: string }) => i.text === 'Cohort-4B')).toHaveLength(1)
})

function nativeExplicitBlankStub(): ReturnType<typeof JSON.parse> {
  const f = nativeJoinedMetricHeader()
  f.tokens = f.tokens.filter(
    (i: ReturnType<typeof token>) => !(i.baseline === 115 && i.rect[0] === 10)
  )
  for (const i of f.tokens as ReturnType<typeof token>[])
    if ([90, 115, 140].includes(i.baseline) && i.rect[0] === 110) i.text = `Config ${i.baseline}`
  return f
}
it('keeps a fully measured literal record with an explicitly blank leading stub without filling a group label', () => {
  const f = nativeExplicitBlankStub(),
    r = plan(f)
  expect(r).toBeDefined()
  expect(
    r.groups.filter((g: { baseline: number }[]) => g.some((i) => i.baseline === 115))
  ).toHaveLength(1)
  const result = refine(f)
  expect(result.grid.find((g: string[]) => g[1] === 'Config 115')?.[0]).toBe('')
  expect(result.unassigned).toEqual([])
})
it.each(['missing-measure', 'missing-key', 'foreign-stub'])(
  'requires complete literal peers for a native empty leading face: %s',
  (change) => {
    const f = nativeExplicitBlankStub()
    if (change === 'missing-measure')
      f.tokens.splice(
        f.tokens.findIndex(
          (i: ReturnType<typeof token>) => i.baseline === 115 && i.rect[0] === 410
        ),
        1
      )
    if (change === 'missing-key')
      f.tokens.splice(
        f.tokens.findIndex(
          (i: ReturnType<typeof token>) => i.baseline === 115 && i.rect[0] === 110
        ),
        1
      )
    if (change === 'foreign-stub') f.tokens.push(token('Other', 10, 102.5, 60))
    expect(plan(f)).toBeUndefined()
  }
)

function nativeCenteredLiteralStub(): ReturnType<typeof JSON.parse> {
  const f = nativeJoinedMetricHeader()
  f.tokens = f.tokens.filter(
    (i: ReturnType<typeof token>) =>
      !(i.rect[0] === 10 && (i.baseline === 90 || i.baseline === 115))
  )
  for (const i of f.tokens.filter((i: ReturnType<typeof token>) => i.baseline === 115)) {
    i.baseline = 105
    i.rect[1] = 95
    i.rect[3] = 105
  }
  f.tokens.push(token('Explicit paired label', 10, 97.5, 70))
  f.rules.push([0, 112, 500, 112])
  return f
}
it('preserves one explicitly printed centered stub as a finite two-record span inside native fences', () => {
  const f = nativeCenteredLiteralStub(),
    r = refine(f)
  expect(r.repairs).toContain('native-printed-leaf-records-recovered')
  expect(r.grid).toHaveLength(6)
  const stub = r.cells.find((c: { text: string }) => c.text === 'Explicit paired label')
  expect(stub?.rowSpan).toBe(2)
  expect(stub?.colSpan).toBe(1)
  expect(r.grid[3][0]).toBe('Explicit paired label')
  expect(r.grid[4][0]).toBe('')
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})
it.each(['off-center', 'extra-label', 'incomplete-peer', 'missing-fence'])(
  'does not infer centered stub coverage without finite independent peer and rule evidence: %s',
  (variant) => {
    const f = nativeCenteredLiteralStub()
    if (variant === 'off-center') {
      f.tokens.at(-1)!.baseline += 4
      f.tokens.at(-1)!.rect[1] += 4
      f.tokens.at(-1)!.rect[3] += 4
    }
    if (variant === 'extra-label') f.tokens.push(token('other', 10, 100, 50))
    if (variant === 'incomplete-peer')
      f.tokens = f.tokens.filter(
        (i: ReturnType<typeof token>) => i.baseline !== 105 || i.rect[0] !== 410
      )
    if (variant === 'missing-fence') f.rules.pop()
    expect(plan(f)).toBeUndefined()
  }
)
it('accepts only actually painted repeated dashes as a finite centered-stub fence', () => {
  const f = nativeCenteredLiteralStub()
  f.rules.pop()
  for (let x = 0; x < 500; x += 20) f.rules.push([x, 112, x + 12, 112])
  expect(plan(f)?.spans.find((s: { rowSpan: number }) => s.rowSpan === 2)).toBeTruthy()
  f.rules.splice(
    f.rules.findIndex((r: number[]) => r[0] === 240 && r[1] === 112),
    1
  )
  expect(plan(f)).toBeUndefined()
})
it('retains independently numbered seed leaves only with their separately printed parent underlines', () => {
  const f = nativeJoinedMetricHeader()
  const nativeHeader = f.tokens[1],
    old = nativeHeader.text,
    names = ['41', '42', '43', '44']
  nativeHeader.text = names.join(' ')
  f.runs[0].text = nativeHeader.text
  f.runs[0].literalGlyphs = [...nativeHeader.text.replace(/\s/gu, '')]
  f.runs[0].glyphRuns = f.runs[0].literalGlyphs.map(() => 1)
  f.runs[0].gaps.forEach((g: { index: number }, n: number) => (g.index = 2 * (n + 1)))
  const r = refine(f)
  expect(r.repairs).toContain('native-printed-leaf-records-recovered')
  expect(r.cells.filter((c: { text: string }) => names.includes(c.text))).toHaveLength(4)
  expect(r.unassigned).toEqual([])
  expect(old).toContain('Leaf')
  f.rules = f.rules.filter((r: number[]) => r[1] !== 42)
  expect(plan(f)).toBeUndefined()
})

function nativeCompactStatistics(): ReturnType<typeof JSON.parse> {
  const tokens = [
    token('Key', 10, 35, 35),
    token('Mean', 110, 35, 35),
    token('Range', 210, 35, 45),
    token('Bound cm', 310, 35, 40),
    token('3', 350, 32, 4, 7),
    token('and unit', 356, 35, 40)
  ]
  for (const [n, y] of [65, 85, 105, 125].entries())
    tokens.push(
      token(`Field ${n}`, 10, y, 60),
      token('−0.12', 110, y, 35),
      token('[−0.14, −0.10], p_H 0.004', 210, y, 85),
      token('−0.08', 310, y, 35)
    )
  return {
    table: {
      id: 'anonymous-literal-statistics',
      cropRect: [0, 18, 450, 144],
      structure: {
        objects: [
          ...Array.from({ length: 5 }, (_, c) => ({
            label: 'table column',
            rect: [c * 90, 2, (c + 1) * 90, 122]
          })),
          { label: 'table row', rect: [0, 2, 450, 122] }
        ]
      }
    },
    tokens,
    captions: [{ lines: ['Table 1. Printed literal statistics.'], rect: [0, 0, 450, 15] }],
    rules: [20, 45, 140].map((y) => [0, y, 450, y]),
    runs: []
  }
}

function nativeLiteralKeyedRecords(): ReturnType<typeof JSON.parse> {
  const f = nativeCompactStatistics()
  f.table.cropRect = [0, 18, 450, 244]
  f.table.structure.objects = [
    ...Array.from({ length: 3 }, (_, c) => ({
      label: 'table column',
      rect: [c * 150, 2, (c + 1) * 150, 222]
    })),
    { label: 'table row', rect: [0, 2, 450, 222] }
  ]
  f.rules = [20, 45, 240].map((y) => [0, y, 450, y])
  f.tokens = [
    token('Key', 10, 35, 35),
    token('Criterion', 160, 35, 60),
    token('Verdict', 310, 35, 60)
  ]
  for (const [n, y] of [65, 115, 165, 215].entries()) {
    f.tokens.push(
      token(`K${n + 1} literal`, 10, y, 90),
      token('literal criterion', 160, y, 100),
      token('literal verdict', 310, y, 100)
    )
    if (n < 3)
      f.tokens.push(
        token('continued key', 10, y + 15, 90),
        token('continued criterion', 160, y + 15, 100),
        token('continued verdict', 310, y + 15, 100)
      )
  }
  return f
}
it('recovers uniquely printed sequential key records while retaining all wrapped literal field content', () => {
  const f = nativeLiteralKeyedRecords(),
    r = refine(f)
  expect(r.grid).toHaveLength(5)
  expect(r.grid.slice(1).map((row: string[]) => row[0])).toEqual([
    'K1 literal continued key',
    'K2 literal continued key',
    'K3 literal continued key',
    'K4 literal'
  ])
  expect(r.grid.slice(1, 4).map((row: string[]) => row[2])).toEqual(
    Array(3).fill('literal verdict continued verdict')
  )
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})
function nativeLiteralCompletePeers(): ReturnType<typeof JSON.parse> {
  const f = nativeCompactStatistics()
  f.tokens = Array.from({ length: 5 }, (_, c) => token(`Leaf ${c}`, c * 90 + 10, 35, 50))
  for (const [n, y] of [65, 85, 105, 125].entries())
    for (let c = 0; c < 5; c++)
      f.tokens.push(token(c ? `literal ${n}/${c}` : `record ${n}`, c * 90 + 10, y, 60))
  return f
}
it('recovers complete ordinary literal peers from five independently printed header and body faces', () => {
  const f = nativeLiteralCompletePeers(),
    r = refine(f)
  expect(r.grid).toHaveLength(5)
  expect(r.grid[0]).toEqual(['Leaf 0', 'Leaf 1', 'Leaf 2', 'Leaf 3', 'Leaf 4'])
  expect(r.grid.slice(1)).toEqual(
    Array.from({ length: 4 }, (_, n) => [
      'record ' + n,
      ...Array.from({ length: 4 }, (_, c) => `literal ${n}/${c + 1}`)
    ])
  )
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})
it('does not split multiple ordinary baselines inside independently ruled literal record faces', () => {
  const f = nativeLiteralCompletePeers()
  f.rules.push([0, 95, 450, 95])
  expect(recoverNativeLiteralKeyedPeers(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
it('retains complete literal peers when native record fences separate each witnessed baseline', () => {
  const f = nativeLiteralCompletePeers()
  f.rules.push(...[75, 95, 115].map((y) => [0, y, 450, y]))
  expect(
    recoverNativeLiteralKeyedPeers(f.table, f.tokens, f.captions, f.rules)?.groups.slice(1)
  ).toHaveLength(4)
})
it.each([
  'caption',
  'competing-caption',
  'footer',
  'missing-first-line',
  'duplicate-key',
  'key-gap',
  'crossed-face',
  'foreign-source',
  'ambiguous-script',
  'header-tier',
  'duplicate-source'
])('requires the full literal native keyed record witness: %s', (change) => {
  const f = nativeLiteralKeyedRecords()
  if (change === 'caption') f.captions = []
  if (change === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
  if (change === 'footer') f.rules.pop()
  if (change === 'missing-first-line')
    f.tokens = f.tokens.filter(
      (i: ReturnType<typeof token>) => i.baseline !== 115 || i.rect[0] !== 310
    )
  if (change === 'duplicate-key')
    f.tokens.find((i: ReturnType<typeof token>) => i.text === 'K2 literal').text = 'K1 literal'
  if (change === 'key-gap')
    f.tokens.find((i: ReturnType<typeof token>) => i.text === 'K2 literal').text = 'K8 literal'
  if (change === 'crossed-face') f.tokens.at(-1).rect[0] = 280
  if (change === 'foreign-source') f.tokens.push(token('foreign', -1, 100, 15))
  if (change === 'ambiguous-script')
    f.tokens.push(token('3', 260, 60, 5, 7), token('other parent', 200, 65, 60))
  if (change === 'header-tier') f.tokens[1].baseline += 10
  if (change === 'duplicate-source') f.tokens.push(structuredClone(f.tokens.at(-1)))
  expect(recoverNativeLiteralKeyedPeers(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
it.each([
  'missing-face',
  'missing-header',
  'continuation',
  'same-face-independent-record',
  'crossed-gutter'
])('does not reinterpret incomplete ordinary literal peers: %s', (change) => {
  const f = nativeLiteralCompletePeers()
  if (change === 'missing-face') f.tokens.pop()
  if (change === 'missing-header') f.tokens.splice(1, 1)
  if (change === 'continuation') f.tokens.push(token('unkeyed continuation', 10, 136, 70))
  if (change === 'same-face-independent-record')
    f.tokens.push(token('another independent literal', 15, 135, 70))
  if (change === 'crossed-gutter') f.tokens.at(-1).rect[0] = 350
  expect(recoverNativeLiteralKeyedPeers(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
})
it('retains same-leaf unique raised glyph ownership inside a literal keyed continuation', () => {
  const f = nativeLiteralKeyedRecords(),
    i = f.tokens.find((i: ReturnType<typeof token>) => i.text === 'continued criterion')
  i.text = 'literal unit'
  i.rect[2] = 245
  f.tokens.push(token('3', 245, 76, 4, 7))
  const r = refine(f),
    c = r.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 1)
  expect(r.grid).toHaveLength(5)
  expect(
    c.textRuns.some(
      (run: { text: string; position: string }) =>
        run.text === '3' && run.position === 'superscript'
    )
  ).toBe(true)
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})
function nativeClosingStubOwner(): ReturnType<typeof JSON.parse> {
  const f = nativeLiteralKeyedRecords()
  f.table.cropRect = [0, 18, 450, 144]
  f.rules = [20, 45, 140].map((y) => [0, y, 450, y])
  f.tokens = [
    token('Parameter', 10, 35, 70),
    token('First value', 160, 35, 70),
    token('Second value', 310, 35, 80)
  ]
  f.cells = f.tokens.map((i: ReturnType<typeof token>, n: number) => ({
    row: 0,
    column: n,
    rowSpan: 1,
    colSpan: 1,
    text: i.text,
    rect: [n * 150, 20, (n + 1) * 150, 45],
    sourceTokens: [i],
    sourceRects: [i.rect]
  }))
  for (const [n, y] of [65, 85, 105, 125].entries()) {
    const label = token('literal (unit', 10, y, 100),
      close = token(')', 110, y, 5),
      a = token('0.25', 190, y, 30),
      b = token('0.30', 350, y, 30)
    f.tokens.push(label, close, a, b)
    for (const [c, g] of [
      [0, [label]],
      [1, [close, a]],
      [2, [b]]
    ] as const)
      f.cells.push({
        row: n + 1,
        column: c,
        rowSpan: 1,
        colSpan: 1,
        text: g.map((i) => i.text).join(' '),
        rect: [c * 150, y - 10, (c + 1) * 150, y],
        sourceTokens: g,
        sourceRects: g.map((i) => i.rect)
      })
  }
  return f
}
it('moves only an already owned ordinary closing stub glyph across a proved native gutter', () => {
  const f = nativeClosingStubOwner(),
    before = structuredClone(f),
    p = proveNativeStubClosingGlyphOwners(f.table, f.tokens, f.captions, f.rules, f.cells)
  expect(p.moves).toHaveLength(4)
  expect(
    p.moves.every(
      (m: {
        glyph: ReturnType<typeof token>
        target: { column: number }
        donor: { column: number }
      }) => m.glyph.text === ')' && m.target.column === 0 && m.donor.column === 1
    )
  ).toBe(true)
  expect(p.cuts[1]).toBeGreaterThan(115)
  expect(p.cuts[1]).toBeLessThan(160)
  expect(f).toEqual(before)
})
it('retains exact native origins across the indexed leading leaf projection', () => {
  const f = indexedDirectory()
  const crop = f.table.cropRect
  const cuts = [0, 100, 200, 300]
  const rows = f.rows.map((r: { rect: number[] }) => r.rect)
  const relative = (rect: number[]): number[] => rect.map((v, n) => v - crop[n % 2])
  f.table.id = 'p1-table-neutral-source-owner'
  f.table.structure = {
    objects: [
      ...rows.map((rect: number[]) => ({ label: 'table row', score: 1, rect: relative(rect) })),
      ...cuts.slice(0, -1).map((left, n) => ({
        label: 'table column',
        score: 1,
        rect: [left - crop[0], 0, cuts[n + 1] - crop[0], crop[3] - crop[1]]
      })),
      { label: 'table column header', score: 1, rect: relative(rows[0]) }
    ]
  }
  const baseline = refine(f)
  for (const [index, token] of f.tokens.entries())
    token.sourceItem = { pageNumber: 1, index, text: token.text }
  const before = structuredClone(f)
  const result = refine(f)
  expect(result.repairs).toContain('native-isolated-printed-header-recovered')
  for (const cell of result.cells) {
    if (!cell.sourceTokens.length) {
      expect(cell.sourceItems).toBeUndefined()
      continue
    }
    const origins = cell.sourceTokens.map((token: ReturnType<typeof JSON.parse>) => {
      const matches = f.tokens.filter(
        (font: ReturnType<typeof JSON.parse>) =>
          font.text === token.text &&
          font.rect.every((v: number, n: number) => Math.abs(v - token.rect[n]) < 0.02)
      )
      expect(matches).toHaveLength(1)
      return matches[0].sourceItem
    })
    expect(cell.sourceItems).toEqual(
      [
        ...new Map(
          origins.map((origin: ReturnType<typeof JSON.parse>) => [origin.index, origin])
        ).values()
      ].sort(
        (a: ReturnType<typeof JSON.parse>, b: ReturnType<typeof JSON.parse>) => a.index - b.index
      )
    )
  }
  const withoutOrigins = (value: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
    JSON.parse(JSON.stringify(value, (key, data) => (key === 'sourceItems' ? undefined : data)))
  expect(withoutOrigins(result)).toEqual(withoutOrigins(baseline))
  expect(f).toEqual(before)
})

it.each(['complete', 'conflicting', 'duplicate', 'opaque'])(
  'checks native origins before transferring a closing glyph: %s',
  (kind) => {
    const f = nativeClosingStubOwner()
    for (const [index, font] of f.tokens.entries())
      font.sourceItem = { pageNumber: 1, index, text: font.text }
    for (const cell of f.cells)
      cell.sourceItems = cell.sourceTokens
        .map(
          (item: ReturnType<typeof JSON.parse>) =>
            f.tokens.find(
              (font: ReturnType<typeof JSON.parse>) =>
                font.text === item.text &&
                font.rect.every((v: number, n: number) => v === item.rect[n])
            ).sourceItem
        )
        .sort((a: { index: number }, b: { index: number }) => a.index - b.index)
    const target = f.cells.find(
      (cell: { row: number; column: number }) => cell.row === 1 && cell.column === 0
    )
    if (kind === 'conflicting')
      target.sourceItems[0] = { ...target.sourceItems[0], text: 'Another original item' }
    if (kind === 'duplicate') target.sourceItems.push({ ...target.sourceItems[0] })
    if (kind === 'opaque')
      target.sourceItems[0] = { ...target.sourceItems[0], unprovedOpaque: true }
    const before = structuredClone(f)
    const result = proveNativeStubClosingGlyphOwners(
      f.table,
      f.tokens,
      f.captions,
      f.rules,
      f.cells
    )
    if (kind === 'complete') expect(result?.moves).toHaveLength(4)
    else expect(result).toBeUndefined()
    expect(f).toEqual(before)
  }
)

it.each([
  'scalar-parenthesis',
  'different-baseline',
  'ambiguous-stub',
  'missing-stub',
  'crossed-gutter',
  'caption',
  'closing-frame',
  'source-loss'
])('retains closing glyph ownership without the complete same-row native proof: %s', (change) => {
  const f = nativeClosingStubOwner()
  for (const i of f.tokens.filter((i: ReturnType<typeof token>) => i.text === ')')) {
    if (change === 'scalar-parenthesis') {
      i.rect[0] = 180
      i.rect[2] = 185
    }
    if (change === 'different-baseline') {
      i.baseline += 5
      i.rect[1] += 5
      i.rect[3] += 5
    }
    if (change === 'crossed-gutter') i.rect[2] = 195
  }
  if (change === 'ambiguous-stub') f.cells.push(structuredClone(f.cells[3]))
  if (change === 'missing-stub')
    for (const c of f.cells.filter(
      (c: { row: number; column: number }) => c.row > 0 && c.column === 0
    ))
      c.sourceTokens = []
  if (change === 'caption') f.captions = []
  if (change === 'closing-frame') f.rules.pop()
  if (change === 'source-loss') f.cells.at(-1).sourceTokens = []
  expect(
    proveNativeStubClosingGlyphOwners(f.table, f.tokens, f.captions, f.rules, f.cells)
  ).toBeUndefined()
})
it('retains complete native statistic records and compound leaf headings when model rows collapse', () => {
  const f = nativeCompactStatistics(),
    r = refine(f)
  expect(r.repairs).toContain('native-compact-literal-records-recovered')
  expect(r.grid).toHaveLength(5)
  expect(r.grid.every((row: string[]) => row.length === 4)).toBe(true)
  expect(r.grid.slice(1).map((row: string[]) => row[0])).toEqual([
    'Field 0',
    'Field 1',
    'Field 2',
    'Field 3'
  ])
  expect(
    r.cells.find((c: { text: string }) => c.text === 'Bound cm3 and unit')?.textRuns
  ).toContainEqual({ text: '3', position: 'superscript' })
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})
it.each([
  'caption',
  'competing-caption',
  'footer',
  'missing-field',
  'wrapped-prose',
  'crossed-face',
  'duplicate',
  'unknown-blank',
  'header-tiers'
])(
  'does not reconstruct compact literal records without complete native peer ownership: %s',
  (change) => {
    const f = nativeCompactStatistics()
    if (change === 'caption') f.captions = []
    if (change === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
    if (change === 'footer') f.rules.pop()
    if (change === 'missing-field') f.tokens.pop()
    if (change === 'wrapped-prose') f.tokens.push(token('continuation prose', 210, 135, 85))
    if (change === 'crossed-face') f.tokens.at(-1).rect[0] -= 50
    if (change === 'duplicate') f.tokens.push(structuredClone(f.tokens.at(-1)))
    if (change === 'unknown-blank')
      f.tokens = f.tokens.filter(
        (i: { baseline: number; rect: number[] }) => i.baseline !== 85 || i.rect[0] !== 110
      )
    if (change === 'header-tiers') {
      f.tokens[1].baseline -= 6
      f.tokens[1].rect[1] -= 6
      f.tokens[1].rect[3] -= 6
    }
    expect(
      recoverNativeCompactLiteralRecords(f.table, f.tokens, f.captions, f.rules)
    ).toBeUndefined()
  }
)

function nativeMixedLiteralFields(): ReturnType<typeof JSON.parse> {
  const f = nativeCompactStatistics()
  f.tokens = [
    token('Key', 10, 35, 35),
    token('Mean', 110, 35, 35),
    token('Selected method', 210, 35, 80),
    token('Range', 310, 35, 50)
  ]
  for (const [n, y] of [65, 85, 105, 125].entries())
    f.tokens.push(
      token(`Field ${n}`, 10, y, 60),
      token('−0.12', 110, y, 35),
      token('literal method (L5)', 210, y, 80),
      token('[−0.14,', 310, y, 35),
      token('−0.10]', 354, y, 35)
    )
  return f
}
it('keeps interspersed descriptive leaves and wide intra-field gaps inside fully witnessed native header faces', () => {
  const f = nativeMixedLiteralFields(),
    r = refine(f)
  expect(r.repairs).toContain('native-compact-literal-records-recovered')
  expect(r.grid).toHaveLength(5)
  expect(r.grid.slice(1)).toEqual(
    Array.from({ length: 4 }, (_, n) => [
      `Field ${n}`,
      '−0.12',
      'literal method (L5)',
      '[−0.14, −0.10]'
    ])
  )
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
})
it('preserves exact TJ spaces inside a literal interval rather than splitting at a broad heading gutter', () => {
  const f = nativeCompactStatistics()
  for (const i of f.tokens.filter(
    (i: ReturnType<typeof token>) => i.baseline > 45 && i.rect[0] === 110
  )) {
    i.text = '0.5 [0.3, 0.7]'
    i.rect[2] = 197
    const literal = i.text.replace(/\s/gu, '')
    f.runs.push({
      text: i.text,
      rect: i.rect,
      baseline: i.baseline,
      height: 10,
      gaps: [{ left: 159, right: 172, index: 8 }],
      glyphRuns: [...literal].map(() => 1),
      literalGlyphs: [...literal]
    } as never)
  }
  const r = refine(f)
  expect(r.repairs).toContain('native-compact-literal-records-recovered')
  expect(r.grid.slice(1).map((row: string[]) => row[1])).toEqual(Array(4).fill('0.5 [0.3, 0.7]'))
  expect(r.unassigned).toEqual([])
})
it('retains one interior literal explanatory record with independently printed trailing blanks', () => {
  const f = nativeCompactStatistics()
  f.tokens = f.tokens.filter((i: ReturnType<typeof token>) => i.baseline !== 85 || i.rect[0] === 10)
  f.tokens.push(token('literal omission reason', 110, 85, 60))
  const r = refine(f)
  expect(r.repairs).toContain('native-compact-literal-records-recovered')
  expect(r.grid[2]).toEqual(['Field 1', 'literal omission reason', '', ''])
  expect(r.grid).toHaveLength(5)
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(f.tokens.map((i: { text: string }) => i.text))
  )
  const before = structuredClone(f)
  for (const i of f.tokens.filter((i: ReturnType<typeof token>) => i.baseline === 85)) {
    i.baseline = 135
    i.rect[1] += 50
    i.rect[3] += 50
  }
  expect(recoverNativeCompactLiteralRecords(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  before.tokens.at(-1)!.rect[2] = 240
  expect(
    recoverNativeCompactLiteralRecords(before.table, before.tokens, before.captions, before.rules)
  ).toBeUndefined()
})

function nativeClippedDenseFrame(): ReturnType<typeof JSON.parse> {
  const width = 1300,
    tokens = []
  const names = [
    'Key',
    'Config',
    ...Array.from({ length: 8 }, (_, n) => `Measure ${n}`),
    'Choice',
    'Primary',
    'Flag'
  ]
  names.forEach((s, c) => tokens.push(token(s, c * 100 + 10, 35, 60)))
  for (let r = 0; r < 10; r++) {
    const y = 65 + r * 25
    tokens.push(token(`Key ${r}`, 10, y, 60), token(`Config ${r}`, 110, y, 60))
    for (let c = 2; c < 10; c++) tokens.push(token(`${r + c}.0`, c * 100 + 10, y, 30))
    tokens.push(token('literal choice', 1010, y, 70))
    if (r === 2 || r === 7) tokens.push(token('yes', 1110, y, 20))
    if (r === 9) tokens.push(token('literal trailing annotation', 1210, y, 80))
  }
  const caption = 'Table 1. Complete native literal fields.'
  tokens.push(token(caption, 0, 15, width))
  return {
    table: {
      id: 'anonymous-clipped-dense-frame',
      cropRect: [0, 18, 1160, 314],
      structure: {
        objects: [
          ...Array.from({ length: 13 }, (_, c) => ({
            label: 'table column',
            rect: [c * 89, 2, (c + 1) * 89, 296]
          })),
          { label: 'table row', rect: [0, 2, 1160, 296] }
        ]
      }
    },
    tokens,
    captions: [{ lines: [caption], rect: [0, 5, width, 15] }],
    rules: [20, 45, 310].map((y) => [0, y, width, y]),
    runs: []
  }
}
it('recovers a complete caption-width native frame with independent literal record anchors and separate optional trailing leaves', () => {
  const f = nativeClippedDenseFrame(),
    r = refine(f)
  expect(r.repairs).toContain('native-caption-width-literal-records-recovered')
  expect(r.grid).toHaveLength(11)
  expect(r.grid.every((row: string[]) => row.length === 13)).toBe(true)
  expect(r.grid[3].slice(-2)).toEqual(['yes', ''])
  expect(r.grid[10].slice(-2)).toEqual(['', 'literal trailing annotation'])
  expect(r.cropRect[2]).toBeGreaterThan(1300)
  expect(r.unassigned).toEqual([])
  expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
    glyphs(
      f.tokens
        .filter((i: { baseline: number }) => i.baseline > 20)
        .map((i: { text: string }) => i.text)
    )
  )
})
it.each([
  'caption-width',
  'caption-literal',
  'competing-frame',
  'record-key',
  'metric-field',
  'crossed-leaf',
  'foreign-source',
  'unwitnessed-optional-leaf'
])(
  'rejects native frame growth without independent exact literal record and leaf evidence: %s',
  (variant) => {
    const f = nativeClippedDenseFrame()
    if (variant === 'caption-width') f.captions[0].rect[2] -= 30
    if (variant === 'caption-literal') f.tokens.at(-1).text = 'ordinary source prose'
    if (variant === 'competing-frame') f.rules.push([0, 19, 1300, 19])
    if (variant === 'record-key')
      f.tokens = f.tokens.filter(
        (i: { baseline: number; rect: number[] }) => i.baseline !== 115 || i.rect[0] !== 110
      )
    if (variant === 'metric-field')
      f.tokens = f.tokens.filter(
        (i: { baseline: number; rect: number[] }) => i.baseline !== 115 || i.rect[0] !== 710
      )
    if (variant === 'crossed-leaf')
      f.tokens.find(
        (i: { baseline: number; rect: number[] }) => i.baseline === 115 && i.rect[0] === 710
      ).rect[2] = 830
    if (variant === 'foreign-source') f.tokens.push(token('foreign', 1200, 105, 50))
    if (variant === 'unwitnessed-optional-leaf')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== 'literal trailing annotation')
    expect(
      recoverNativeCompactLiteralRecords(f.table, f.tokens, f.captions, f.rules)
    ).toBeUndefined()
  }
)
it.each([
  'merged-heading',
  'crossed-gutter',
  'incomplete-record',
  'wrapped-description',
  'one-measured-leaf'
])(
  'does not infer native mixed leaves without complete independent header and record faces: %s',
  (variant) => {
    const f = nativeMixedLiteralFields()
    if (variant === 'merged-heading') f.tokens[2].rect[0] = 140
    if (variant === 'crossed-gutter') f.tokens.at(-1)!.rect[0] = 255
    if (variant === 'incomplete-record') f.tokens.splice(6, 1)
    if (variant === 'wrapped-description')
      f.tokens.push(token('description continuation', 210, 135, 80))
    if (variant === 'one-measured-leaf')
      for (const i of f.tokens) if (i.rect[0] === 110 && i.baseline > 45) i.text = 'literal'
    expect(
      recoverNativeCompactLiteralRecords(f.table, f.tokens, f.captions, f.rules)
    ).toBeUndefined()
  }
)

// Two detector gaps have no printed field; three complete native faces own all ink.
const unprintedSeparatorColumns = (): ReturnType<typeof JSON.parse> => {
  const source: [string, number[], number, number][] = [
    [
      'Xxxxxx xxxxx',
      [243.36960105499998, 27.46273986800003, 314.0347312780784, 37.80115428500005],
      37.80115428500005,
      10.338414417
    ],
    [
      'Xxxx xxxxx',
      [357.92130047824344, 27.46273986800003, 411.7813380664884, 37.80115428500005],
      37.80115428500005,
      10.338414417
    ],
    [
      '†',
      [411.78503738000006, 25.960261590500124, 416.7083521364302, 33.34486449500014],
      33.34486449500014,
      7.3846029044999995
    ],
    [
      'xxxxx XXXXX',
      [66.47149999999999, 46.69179338299995, 139.56512376963167, 57.03020779999997],
      57.03020779999997,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [229.37492981011087, 46.69179338299995, 328.01787712847454, 57.03020779999997],
      57.03020779999997,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [338.3562915454746, 46.69179338299995, 436.9992388638386, 57.03020779999997],
      57.03020779999997,
      10.338414417
    ],
    [
      'xxxxx XXXXX',
      [66.47149999999999, 58.50703943299999, 138.43720275673695, 68.84545385000001],
      68.84545385000001,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [229.3738959686691, 58.50703943299999, 328.0168432870329, 68.84545385000001],
      68.84545385000001,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [338.35525770403297, 58.50703943299999, 436.99820502239686, 68.84545385000001],
      68.84545385000001,
      10.338414417
    ],
    [
      'xxxxx XXXXX, xxxxxxxx',
      [66.47149999999999, 70.32228548300003, 187.6728675762579, 80.66069990000005],
      80.66069990000005,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [229.37803133443583, 70.32228548300003, 328.0209786527996, 80.66069990000005],
      80.66069990000005,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [338.3593930697997, 70.32228548300003, 437.0023403881636, 80.66069990000005],
      80.66069990000005,
      10.338414417
    ],
    [
      'Xxxx',
      [66.47149999999999, 82.13753153300013, 89.20360562009961, 92.4759459500001],
      92.4759459500001,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [229.38216670020256, 82.13753153300013, 328.02511401856634, 92.4759459500001],
      92.4759459500001,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [338.3635284355663, 82.13753153300013, 437.0064757539302, 92.4759459500001],
      92.4759459500001,
      10.338414417
    ],
    [
      'xxxxx XXXX, xxxxxxxx',
      [66.47149999999999, 93.95277758300017, 177.75212510170468, 104.29119200000014],
      104.29119200000014,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [229.3821667002028, 93.95277758300017, 328.02511401856657, 104.29119200000014],
      104.29119200000014,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [338.3635284355664, 93.95277758300017, 437.00647575393043, 104.29119200000014],
      104.29119200000014,
      10.338414417
    ],
    [
      'xxxxxx xxxxxxxxxxx',
      [66.47149999999999, 105.76950609800019, 151.94227350966412, 116.10792051500016],
      116.10792051500016,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [229.37699749299418, 105.76950609800019, 328.01994481135796, 116.10792051500016],
      116.10792051500016,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [338.35835922835804, 105.76950609800019, 437.00130654672205, 116.10792051500016],
      116.10792051500016,
      10.338414417
    ],
    [
      'xxxxxx xxxx xxxxxxx',
      [66.47149999999999, 124.998559613, 167.2410591639408, 135.33697402999996],
      135.33697402999996,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [229.37492981011087, 124.998559613, 328.01787712847454, 135.33697402999996],
      135.33697402999996,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [338.3562915454746, 124.998559613, 436.9992388638386, 135.33697402999996],
      135.33697402999996,
      10.338414417
    ],
    [
      'xx xxxxx xxxxxx xxxx xxxxxx',
      [78.24375456499996, 136.81380566300004, 219.0426205101229, 147.15222008],
      147.15222008,
      10.338414417
    ],
    [
      '–',
      [275.75916200178494, 136.81380566300004, 281.64482132938303, 147.15222008],
      147.15222008,
      10.338414417
    ],
    [
      '2.222 [2.222, 2.222]',
      [338.3613628210451, 136.81380566300004, 437.004310139409, 147.15222008],
      147.15222008,
      10.338414417
    ]
  ]
  const columnObjects: [number[], number][] = [
    [
      [199.4452394247055, 26.97806990146637, 275.2674466371536, 128.37644469738007],
      0.9875087297108718
    ],
    [
      [13.523003101348877, 26.84296977519989, 151.4224452972412, 128.22968137264252],
      0.9997926235059788
    ],
    [
      [274.3774829506874, 26.861894965171814, 309.46570724248886, 128.43415129184723],
      0.9469541684191215
    ],
    [
      [308.32971119880676, 26.9813369512558, 375.620121717453, 128.25092566013336],
      0.9890867837932485
    ],
    [
      [152.21530038118362, 27.299298763275146, 202.10302370786667, 128.51580214500427],
      0.9881688475701175
    ]
  ]
  const rowObjects: [number[], number][] = [
    [
      [13.388221263885498, 99.33738902211189, 375.5026617050171, 116.34013602137566],
      0.7859205374656018
    ],
    [
      [13.28536570072174, 61.50809043645859, 375.65084540843964, 73.20869916677475],
      0.9768199744497377
    ],
    [
      [13.440695524215698, 49.81853339076042, 375.58344292640686, 61.64291337132454],
      0.9493244366634226
    ],
    [
      [13.417326092720032, 37.97134754061699, 375.52008759975433, 49.95796278119087],
      0.9278035790024262
    ],
    [
      [13.270125269889832, 84.72133827209473, 375.68158066272736, 100.63593339920044],
      0.8870358055645139
    ],
    [
      [13.454455852508545, 26.97542706131935, 375.5573329925537, 38.11018022894859],
      0.9844954098778583
    ],
    [
      [13.370853185653687, 116.75500690937042, 375.60823464393616, 128.2389577627182],
      0.6606085188774595
    ],
    [
      [13.181654453277588, 73.59605193138123, 375.78975534439087, 85.7009961605072],
      0.8647022511611046
    ]
  ]
  const tokens = source.map(([text, rect, baseline, height]) => ({
    text,
    rect,
    baseline,
    height,
    horizontal: true,
    inlineSymbol: false
  }))
  return {
    table: {
      id: 'anonymous-table',
      readingRotation: 0,
      cropRect: [57, 20, 445, 162],
      structure: {
        objects: [
          ...columnObjects.map(([rect, score]) => ({ label: 'table column', rect, score })),
          ...rowObjects.map(([rect, score]) => ({ label: 'table row', rect, score }))
        ]
      },
      spans: [],
      rowCount: 8,
      columnCount: 5,
      grid: [
        ['xxxxx XXXXX', '', '2.222 [2.222, 2.222]', '', '2.222 [2.222, 2.222]'],
        ['xxxxx XXXXX', '', '2.222 [2.222, 2.222]', '', '2.222 [2.222, 2.222]'],
        ['xxxxx XXXXX, xxxxxxxx', '', '2.222 [2.222, 2.222]', '', '2.222 [2.222, 2.222]'],
        ['Xxxx', '', '2.222 [2.222, 2.222]', '', '2.222 [2.222, 2.222]'],
        ['xxxxx XXXX, xxxxxxxx', '', '2.222 [2.222, 2.222]', '', '2.222 [2.222, 2.222]'],
        ['xxxxxx xxxxxxxxxxx', '', '2.222 [2.222, 2.222]', '', '2.222 [2.222, 2.222]'],
        ['xxxxxx xxxx xxxxxxx', '', '2.222 [2.222, 2.222]', '', '2.222 [2.222, 2.222]'],
        ['xx xxxxx xxxxxx xxxx xxxxxx', '', '–', '', '2.222 [2.222, 2.222]']
      ],
      unassigned: ['Xxxxxx xxxxx', 'Xxxx xxxxx', '†']
    },
    tokens,
    captions: [
      {
        page: 1,
        lines: ['Table 1. Anonymized scalar shares.'],
        rect: [66.47149999999999, -89.17660000000018, 437.0052900799999, 6.463999999999658]
      }
    ],
    rules: [
      [66.47149999999999, 23.49240210500011, 437.0017690206146, 23.49240210500011],
      [66.47149999999999, 44.25877182500005, 437.0017690206146, 44.25877182500005],
      [66.47149999999999, 122.56405558999995, 437.0017690206146, 122.56405558999995],
      [66.47149999999999, 153.82924244000003, 437.0017690206146, 153.82924244000003]
    ],
    runs: []
  }
}

it('replaces only unprinted detector gaps with complete native faces while retaining every record and rich mark', () => {
  const f = unprintedSeparatorColumns(),
    original = structuredClone(f),
    r = refine(f)
  expect(r.grid).toHaveLength(9)
  expect(r.grid.every((row: string[]) => row.length === 3)).toBe(true)
  expect(r.grid[0]).toEqual(['', 'Xxxxxx xxxxx', 'Xxxx xxxxx†'])
  expect(r.cells).toHaveLength(27)
  expect(
    r.cells.every((c: { rowSpan: number; colSpan: number }) => c.rowSpan === 1 && c.colSpan === 1)
  ).toBe(true)
  expect(r.unassigned).toEqual([])
  expect(r.clipped).toEqual([])
  expect(r.cropRect).toEqual([64.47149999999999, 20, 439.0017690206146, 162])
  const header = r.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 2)
  expect(header.textRuns).toEqual([
    { text: 'Xxxx xxxxx', position: 'normal' },
    { text: '†', position: 'superscript' }
  ])
  expect(
    r.cells.find((c: { row: number; column: number }) => c.row === 8 && c.column === 1).text
  ).toBe('–')
  const source = (s: { text: string; rect: number[]; baseline: number; height: number }): string =>
    JSON.stringify([s.text, s.rect, s.baseline, s.height])
  expect(
    r.cells
      .flatMap((c: { sourceTokens: ReturnType<typeof JSON.parse>[] }) => c.sourceTokens.map(source))
      .sort()
  ).toEqual(f.tokens.map(source).sort())
  for (const c of r.cells) {
    expect(c.sourceRects).toEqual(c.sourceTokens.map((s: { rect: number[] }) => s.rect))
    expect(
      c.sourceRects.every((rect: number[]) => rect[0] >= c.rect[0] && rect[2] <= c.rect[2])
    ).toBe(true)
  }
  expect(f).toEqual(original)
})

it.each(['no-mark', 'reversed-source', 'translated', 'redundant-paint'])(
  'retains the same complete native separator proof under %s',
  (change) => {
    const f = unprintedSeparatorColumns()
    if (change === 'no-mark') f.tokens = f.tokens.filter((s: { text: string }) => s.text !== '†')
    if (change === 'reversed-source') f.tokens.reverse()
    if (change === 'redundant-paint') f.rules.push(...structuredClone(f.rules))
    if (change === 'translated') {
      const shift = (r: number[]): number[] => [r[0] + 50, r[1] + 80, r[2] + 50, r[3] + 80]
      f.table.cropRect = shift(f.table.cropRect)
      f.tokens.forEach((s: { rect: number[]; baseline: number }) => {
        s.rect = shift(s.rect)
        s.baseline += 80
      })
      f.captions.forEach((c: { rect: number[] }) => {
        c.rect = shift(c.rect)
      })
      f.rules = f.rules.map(shift)
    }
    const r = refine(f)
    expect(r.grid).toHaveLength(9)
    expect(r.grid.every((row: string[]) => row.length === 3)).toBe(true)
    expect(r.repairs).toContain('native-unprinted-separator-faces-recovered')
    expect(glyphs(r.cells.map((c: { text: string }) => c.text))).toBe(
      glyphs(f.tokens.map((s: { text: string }) => s.text))
    )
  }
)

it.each([
  'opening',
  'divider',
  'footer',
  'competing-frame',
  'native-wall',
  'duplicate-caption',
  'new-heading',
  'section-record',
  'footer-note',
  'crossing-glyph',
  'shifted-baseline',
  'prose-field',
  'unowned-mark',
  'missing-field',
  'duplicate-source',
  'two-peers'
])(
  'does not project unprinted separator lanes without the independent source witness: %s',
  (change) => {
    const f = unprintedSeparatorColumns(),
      height = f.tokens[0].height
    const first = f.tokens.find(
      (s: { baseline: number; height: number }) => s.baseline > 40 && s.height === height
    )
    const measurement = f.tokens.find(
      (s: { baseline: number; text: string }) =>
        s.baseline === first.baseline && /^\d/u.test(s.text)
    )
    if (change === 'opening') f.rules.splice(0, 1)
    if (change === 'divider') f.rules.splice(1, 1)
    if (change === 'footer') f.rules.pop()
    if (change === 'competing-frame')
      f.rules.push(...f.rules.map((r: number[]) => [r[0], r[1] + 2, r[2], r[3] + 2]))
    if (change === 'native-wall') f.rules.push([225, f.rules[0][1], 225, f.rules.at(-1)[1]])
    if (change === 'duplicate-caption') f.captions.push(structuredClone(f.captions[0]))
    if (change === 'new-heading')
      f.tokens.push({
        text: 'Extra',
        rect: [212, 27.46, 235, 37.8],
        baseline: 37.8,
        height,
        horizontal: true
      })
    if (change === 'section-record' || change === 'missing-field')
      f.tokens.splice(f.tokens.indexOf(measurement), 1)
    if (change === 'section-record')
      f.tokens = f.tokens.filter(
        (s: { baseline: number; text: string }) =>
          s.baseline !== first.baseline || /\p{L}/u.test(s.text)
      )
    if (change === 'footer-note')
      f.tokens.push({
        text: 'Note',
        rect: [100, 156, 120, 161],
        baseline: 161,
        height: 5,
        horizontal: true
      })
    if (change === 'crossing-glyph') first.rect[2] = measurement.rect[0] + 5
    if (change === 'shifted-baseline') {
      measurement.baseline += 4
      measurement.rect[1] += 4
      measurement.rect[3] += 4
    }
    if (change === 'prose-field') measurement.text = 'Ordinary wrapped description'
    if (change === 'unowned-mark')
      f.tokens.push({
        text: '†',
        rect: [220, 55, 224, 60],
        baseline: 60,
        height: 5,
        horizontal: true
      })
    if (change === 'duplicate-source') f.tokens.push(structuredClone(first))
    if (change === 'two-peers')
      f.tokens = f.tokens.filter((s: { baseline: number }) => s.baseline < 70)
    const original = structuredClone(f),
      r = refine(f)
    expect(r.repairs).not.toContain('native-unprinted-separator-faces-recovered')
    expect(f).toEqual(original)
    if (change === 'native-wall') expect(r.grid[0]).toHaveLength(5)
  }
)

const separatorFinalPartition = (): ReturnType<typeof JSON.parse> => {
  const f = unprintedSeparatorColumns(),
    r = refine(f)
  const grid = r.grid.map((row: string[]) => [row[0], '', row[1], '', row[2]])
  const cells = grid.flatMap((row: string[], y: number) =>
    row.map((_, column: number) => {
      if (column % 2 === 0)
        return {
          ...structuredClone(
            r.cells.find(
              (c: { row: number; column: number }) => c.row === y && c.column === column / 2
            )
          ),
          column
        }
      const peer = r.cells.find((c: { row: number }) => c.row === y)
      return {
        row: y,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [...peer.rect],
        text: '',
        sourceRects: [],
        sourceTokens: []
      }
    })
  )
  return { ...f, table: { cropRect: r.cropRect, grid, cells }, sourceTable: f.table }
}

it.each([
  'owned-empty-slot',
  'row-span',
  'column-span',
  'duplicate-owner',
  'source-rect-mismatch',
  'mixed-baseline',
  'notes',
  'reading-rotation',
  'native-walled-empty-face'
])('preserves existing complete ownership when separator projection is unsafe: %s', (change) => {
  const f = separatorFinalPartition(),
    cell = f.table.cells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 0)
  if (change === 'owned-empty-slot') {
    const slot = f.table.cells.find(
      (c: { row: number; column: number }) => c.row === 0 && c.column === 1
    )
    slot.sourceRects = [[215, 25, 218, 35]]
  }
  if (change === 'row-span') cell.rowSpan = 2
  if (change === 'column-span') cell.colSpan = 2
  if (change === 'duplicate-owner') {
    const peer = f.table.cells.find(
      (c: { row: number; column: number }) => c.row === 1 && c.column === 2
    )
    peer.sourceTokens.push(structuredClone(cell.sourceTokens[0]))
    peer.sourceRects.push([...cell.sourceTokens[0].rect])
  }
  if (change === 'source-rect-mismatch') cell.sourceRects[0] = [0, 0, 1, 1]
  if (change === 'mixed-baseline') {
    const peer = f.table.cells.find(
      (c: { row: number; column: number }) => c.row === 2 && c.column === 0
    )
    cell.sourceTokens.push(...peer.sourceTokens)
    cell.sourceRects.push(...peer.sourceRects)
    peer.sourceTokens = []
    peer.sourceRects = []
  }
  if (change === 'notes') f.table.notes = [{ text: 'Unparsed note' }]
  if (change === 'reading-rotation') f.table.readingRotation = 90
  if (change === 'native-walled-empty-face') {
    // This genuinely empty walled face contains no source ink. It is a field.
    f.rules.push(
      [225, f.rules[0][1], 225, f.rules.at(-1)[1]],
      [240, f.rules[0][1], 240, f.rules.at(-1)[1]]
    )
    for (const c of f.table.cells.filter((c: { column: number }) => c.column === 2))
      for (const s of c.sourceTokens) {
        const prior = f.tokens.find(
          (v: { text: string; rect: number[] }) =>
            v.text === s.text && JSON.stringify(v.rect) === JSON.stringify(s.rect)
        )
        s.rect = [250, s.rect[1], 330, s.rect[3]]
        prior.rect = [...s.rect]
        c.sourceRects = c.sourceTokens.map((v: { rect: number[] }) => v.rect)
      }
    expect(f.tokens.every((s: { rect: number[] }) => s.rect[2] <= 225 || s.rect[0] >= 240)).toBe(
      true
    )
  }
  const original = structuredClone(f)
  expect(proveNativeUnprintedSeparatorFaces(f.table, f.tokens, f.captions, f.rules)).toBeUndefined()
  expect(f).toEqual(original)
})

it('keeps an already correct blank-stub three-column partition exact', () => {
  const f = unprintedSeparatorColumns(),
    r = refine(f),
    original = structuredClone(r)
  expect(proveNativeUnprintedSeparatorFaces(r, f.tokens, f.captions, f.rules)).toBeUndefined()
  expect(r).toEqual(original)
})

const calibratedTjOwners = (): ReturnType<typeof JSON.parse> => {
  const f = readFileSync(
    resolve('src/main/literature/pdf-structure/fixtures/native-complete-records.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((record) => record.kind === 'calibrated-tj-native-leaves')
  return {
    ...f,
    table: {
      cropRect: f.expectedBeforeCropRect,
      grid: f.expectedBeforeGrid,
      cells: f.expectedBeforeCells,
      rows: f.expectedBeforeRows,
      notes: [],
      unassigned: []
    }
  }
}

const calibratedTjProof = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  proveNativeTjAnchorLiteralLeaves(f.table, f.items, f.captions, f.rules, f.runs)

it('calibrates literal TJ boundaries without rewriting independent original owners or internal spaces', () => {
  const f = calibratedTjOwners(),
    original = structuredClone(f),
    proof = calibratedTjProof(f),
    owners = f.table.cells.flatMap((c: { sourceTokens: unknown[] }) => c.sourceTokens),
    source = proof.groups.flat()
  expect(proof.groups.map((g: { text: string }[]) => g.map((t) => t.text))).toEqual(f.expectedGrid)
  expect(proof.rowRects).toEqual(f.expectedInternalRows.map((r: { rect: number[] }) => r.rect))
  expect(proof.cuts).toEqual([
    ...f.expectedInternalCells
      .filter((c: { row: number }) => c.row === 0)
      .map((c: { rect: number[] }) => c.rect[0]),
    f.table.cropRect[2]
  ])
  for (const token of source) {
    expect(owners).toContain(token.sourceToken ?? token)
    if (token.nativeLaneSplit) {
      expect(token).toEqual({
        ...token.sourceToken,
        text: token.text,
        rect: token.rect,
        sourceToken: token.sourceToken,
        nativeLaneSplit: true
      })
    }
  }
  expect(glyphs(source.map((t: { text: string }) => t.text))).toEqual(
    glyphs(f.items.map((i: { text: string }) => i.text))
  )
  expect(f).toEqual(original)
})

it('derives calibrated TJ topology from a shorter complete body with a real independent peer', () => {
  const f = calibratedTjOwners(),
    kept = f.expectedBeforeCells.filter((c: { row: number }) => c.row < 4),
    originals = kept.flatMap(
      (c: { sourceTokens: { text: string; rect: number[] }[] }) => c.sourceTokens
    ),
    hasOwner = (s: { text: string; rect: number[] }): boolean =>
      originals.some(
        (t: { text: string; rect: number[] }) =>
          t.text === s.text && JSON.stringify(t.rect) === JSON.stringify(s.rect)
      )
  f.table.cells = kept
  f.table.grid = f.table.grid.slice(0, 4)
  f.table.rows = f.table.rows.slice(0, 4)
  f.items = f.items.filter(hasOwner)
  f.runs = f.runs.filter(hasOwner)
  const original = structuredClone(f),
    proof = calibratedTjProof(f)
  expect(proof.groups.map((g: { text: string }[]) => g.map((t) => t.text))).toEqual(
    f.expectedGrid.slice(0, 4)
  )
  expect(proof.rowRects).toEqual(
    f.expectedInternalRows.slice(0, 4).map((r: { rect: number[] }) => r.rect)
  )
  expect(f).toEqual(original)
})

it.each([
  'token-baseline-mismatch',
  'token-height-mismatch',
  'source-rect-mismatch',
  'duplicate-old-owner',
  'missing-old-owner',
  'duplicate-source-rect',
  'owner-on-another-record',
  'overlapping-grid-coverage',
  'missing-grid-coverage',
  'source-text-mismatch',
  'grid-text-mismatch',
  'rich-script-owner',
  'already-split-owner',
  'row-span-owner'
])('refuses calibrated TJ reassignment with faulty original ownership: %s', (change) => {
  const f = calibratedTjOwners(),
    cell = f.table.cells.find(
      (c: { row: number; sourceTokens: unknown[] }) => c.row === 1 && c.sourceTokens.length
    ),
    token = cell.sourceTokens[0]
  if (change === 'token-baseline-mismatch') token.baseline += 0.01
  if (change === 'token-height-mismatch') token.height += 0.01
  if (change === 'source-rect-mismatch') cell.sourceRects[0][2] -= 0.01
  if (change === 'duplicate-old-owner') {
    const other = f.table.cells.find((c: { row: number }) => c.row === 1 && c !== cell)
    other.sourceTokens = [structuredClone(token)]
    other.sourceRects = [[...token.rect]]
    other.text = token.text
    f.table.grid[other.row][other.column] = token.text
  }
  if (change === 'missing-old-owner') {
    cell.sourceTokens = []
    cell.sourceRects = []
    cell.text = ''
    f.table.grid[cell.row][cell.column] = ''
  }
  if (change === 'duplicate-source-rect') cell.sourceRects.push([...token.rect])
  if (change === 'owner-on-another-record') {
    const other = f.table.cells.find(
      (c: { row: number; column: number }) => c.row === 2 && c.column === 0
    )
    for (const key of ['text', 'sourceTokens', 'sourceRects'])
      [cell[key], other[key]] = [other[key], cell[key]]
    f.table.grid[cell.row][cell.column] = cell.text
    f.table.grid[other.row][other.column] = other.text
  }
  if (change === 'overlapping-grid-coverage') cell.colSpan++
  if (change === 'missing-grid-coverage')
    f.table.cells = f.table.cells.filter((c: unknown) => c !== cell)
  if (change === 'source-text-mismatch') cell.text += ' extra'
  if (change === 'grid-text-mismatch') f.table.grid[cell.row][cell.column] += ' extra'
  if (change === 'rich-script-owner') cell.textRuns = [{ text: cell.text, script: 'superscript' }]
  if (change === 'already-split-owner') {
    token.sourceToken = structuredClone(token)
    token.nativeLaneSplit = true
  }
  if (change === 'row-span-owner') cell.rowSpan = 2
  const original = structuredClone(f)
  expect(calibratedTjProof(f)).toBeUndefined()
  expect(f).toEqual(original)
})

it('requires observed native programs instead of inferring TJ boundaries from text alone', () => {
  const f = calibratedTjOwners(),
    original = structuredClone(f)
  expect(proveNativeTjAnchorLiteralLeaves(f.table, f.items, f.captions, f.rules)).toBeUndefined()
  expect(f).toEqual(original)
})

it.each(['baseline', 'height'])(
  'rejects a competing same-text same-rectangle program with mismatched %s',
  (field) => {
    const f = calibratedTjOwners(),
      duplicate = structuredClone(f.runs[0])
    duplicate[field] += 0.01
    f.runs.push(duplicate)
    const original = structuredClone(f)
    expect(calibratedTjProof(f)).toBeUndefined()
    expect(f).toEqual(original)
  }
)
const compositeStubOwners = (): ReturnType<typeof JSON.parse> => {
  const f = readFileSync(
    resolve('src/main/literature/pdf-structure/fixtures/native-complete-records.jsonl'),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((v) => v.kind === 'fenced-smallcaps-stub-owner')
  f.oldCells = [
    ...f.expectedCells.filter(
      (c: { row: number; column: number }) => !(c.row === 1 && c.column === 0)
    ),
    ...f.initialFaultyStubCells
  ]
  return f
}
const compositeStubProof = (f: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  proveNativeFencedCompositeStubOwners(
    { ...f.table, ...f.expectedBefore, cells: f.oldCells },
    f.items,
    f.captions,
    f.rules
  )

it('projects only the incorrect same-baseline native small-caps label donor partition', () => {
  const f = compositeStubOwners(),
    before = structuredClone(f),
    p = compositeStubProof(f)
  expect(p.replacements).toHaveLength(1)
  expect(p.replacements[0].row).toBe(1)
  expect(p.replacements[0].rowSpan).toBe(5)
  expect({
    ...p.replacements[0].original,
    row: 1,
    rowSpan: 5,
    rect: p.replacements[0].rect
  }).toEqual(
    f.expectedCells.find((c: { row: number; column: number }) => c.row === 1 && c.column === 0)
  )
  expect(f).toEqual(before)
})

it.each(['wrong-calibration-literal', 'unproven-calibration-rich-position'])(
  'requires complete literal calibration beyond an existing correct rowSpan: %s',
  (control: string) => {
    const f = compositeStubOwners(),
      calibration = f.oldCells.find(
        (c: { row: number; column: number }) => c.row === 11 && c.column === 0
      )
    if (control === 'wrong-calibration-literal') calibration.text = calibration.text.slice(1)
    if (control === 'unproven-calibration-rich-position')
      calibration.textRuns = [{ text: calibration.text, position: 'superscript' }]
    const before = structuredClone(f)
    expect(compositeStubProof(f)).toBeUndefined()
    expect(f).toEqual(before)
  }
)

it.each([
  'duplicate-label-source-rectangle',
  'missing-label-source-rectangle',
  'wrong-old-owner-baseline',
  'foreign-record-source-owner',
  'missing-complete-body-leaf',
  'label-font-outside-donor-union',
  'correct-rich-label-font-outside-own-union',
  'donor-crosses-body-gutter',
  'source-record-crosses-native-fence',
  'wrong-smallcaps-baseline',
  'wrong-smallcaps-height'
])('rejects malformed existing fenced owner metadata: %s', (control: string) => {
  const f = compositeStubOwners(),
    label = f.oldCells.find(
      (c: ReturnType<typeof JSON.parse>) =>
        c.column === 0 && c.row > 0 && c.row < 6 && c.sourceTokens.length === 2
    ),
    piece = label.sourceTokens[1]
  if (control === 'duplicate-label-source-rectangle')
    label.sourceRects = [label.sourceRects[0], label.sourceRects[0]]
  if (control === 'missing-label-source-rectangle') label.sourceRects.pop()
  if (control === 'wrong-old-owner-baseline') label.sourceTokens[0].baseline += 1
  if (control === 'foreign-record-source-owner') {
    const donor = f.oldCells.find(
        (c: { row: number; column: number }) => c.row === 1 && c.column === 1
      ),
      foreign = f.oldCells.find(
        (c: { row: number; column: number }) => c.row === 2 && c.column === 1
      )
    donor.sourceTokens = structuredClone(foreign.sourceTokens)
    donor.sourceRects = structuredClone(foreign.sourceRects)
  }
  if (control === 'missing-complete-body-leaf')
    f.oldCells = f.oldCells.filter(
      (c: { row: number; column: number }) => !(c.row === 1 && c.column === 7)
    )
  if (control === 'label-font-outside-donor-union')
    for (const d of f.oldCells.filter(
      (c: { row: number; column: number }) => c.row > 0 && c.row < 6 && c.column === 0
    ))
      d.rect[2] = piece.rect[2] - 1
  if (control === 'correct-rich-label-font-outside-own-union') {
    const rich = f.oldCells.find(
      (c: ReturnType<typeof JSON.parse>) =>
        c.column === 0 && c.textRuns?.some((r: { position: string }) => r.position !== 'normal')
    )
    rich.rect[2] = Math.max(...rich.sourceTokens.map((t: { rect: number[] }) => t.rect[2])) - 1
  }
  if (control === 'donor-crosses-body-gutter') label.rect[2] = 320
  if (control === 'source-record-crosses-native-fence') {
    const i = f.items.find(
      (i: ReturnType<typeof JSON.parse>) =>
        literalNativeSignatureForComposite(i) === literalNativeSignatureForComposite(piece)
    )
    i.rect[1] = 140
    piece.rect[1] = 140
    label.sourceRects[1][1] = 140
  }
  if (control === 'wrong-smallcaps-baseline') {
    const i = f.items.find(
      (i: ReturnType<typeof JSON.parse>) =>
        literalNativeSignatureForComposite(i) === literalNativeSignatureForComposite(piece)
    )
    i.baseline += 1
    piece.baseline += 1
  }
  if (control === 'wrong-smallcaps-height') {
    const i = f.items.find(
      (i: ReturnType<typeof JSON.parse>) =>
        literalNativeSignatureForComposite(i) === literalNativeSignatureForComposite(piece)
    )
    i.height -= 1
    piece.height -= 1
  }
  const before = structuredClone(f)
  expect(compositeStubProof(f)).toBeUndefined()
  expect(f).toEqual(before)
})
function literalNativeSignatureForComposite(i: ReturnType<typeof JSON.parse>): string {
  return JSON.stringify([i.text, i.rect, i.baseline, i.height])
}

function noteCalibratedHeader(): ReturnType<typeof JSON.parse> {
  const height = 13.4496,
    cropRect = [79, 99, 701, 201],
    cuts = [80, 180, 280, 380, 480, 580, 700],
    ys = [102, 140, 173, 200],
    item = (
      text: string,
      x: number,
      baseline: number,
      width: number
    ): ReturnType<typeof JSON.parse> => ({
      text,
      rect: [x, baseline - height, x + width, baseline],
      height,
      baseline,
      horizontal: true,
      inlineSymbol: false
    }),
    items: ReturnType<typeof JSON.parse>[] = []
  for (let c = 0; c < 5; c++) items.push(item(`Field ${c + 1}`, 95 + c * 100, 128.4496, 45))
  items.push(item('Ref.', 635, 128.4496, 26), item('a', 661, 122.7361, 6))
  for (let r = 1; r < 3; r++)
    for (let c = 0; c < 6; c++)
      items.push(
        item(
          c ? `${r}.${c}` : `Entry ${r}`,
          95 + c * 100 + (c === 5 ? 35 : 0),
          r === 1 ? 161 : 185,
          c ? 20 : 45
        )
      )
  const footer = [
      item('References: (1) Writer (2020).', 110, 222.1631, 500),
      item('(2) Reader (2021).', 110, 240.1631, 220),
      item('(3) Author (2022).', 110, 258.1631, 220)
    ],
    notes = [{ text: 'a ' + footer.map((i) => i.text).join(' '), rect: [100, 203, 610, 258.1631] }]
  items.push(item('a', 100, 216.4496, 8), ...footer)
  const objects = [
      ...cuts.slice(1).map((right, c) => ({
        label: 'table column',
        score: 1,
        rect: [cuts[c] - 79, 1, right - 79, 101]
      })),
      ...ys.slice(1).map((bottom, r) => ({
        label: 'table row',
        score: 1,
        rect: [1, ys[r] - 99, 621, bottom - 99]
      })),
      { label: 'table column header', score: 1, rect: [1, 3, 621, 41] }
    ],
    table = {
      id: 'anonymous-reference-marker',
      readingRotation: 0,
      cropRect,
      detection: { label: 'table', score: 1, rect: [80, 100, 700, 200] },
      structure: { rowCount: 3, columnCount: 6, objects }
    }
  return {
    table,
    items,
    captions: [{ lines: ['Table 1: Literal measurements.'], rect: [80, 80, 700, 90] }],
    notes,
    rules: [100, 102, 140, 200].map((y) => [80, y, 700, y])
  }
}

it('uses the complete same-page References note to serialize only its calibrated header marker', () => {
  const f = noteCalibratedHeader(),
    immutable = structuredClone(f),
    before = refineTable(f.table, f.items, f.captions, [], f.rules, [], null),
    actual = refineTable(f.table, f.items, f.captions, f.notes, f.rules, [], null),
    expected = structuredClone(before),
    donor = expected.cells.find(
      (c: { row: number; column: number }) => c.row === 0 && c.column === 5
    )
  expect(donor.text).toBe('a Ref.')
  donor.text = 'Ref.a'
  donor.textRuns = [
    { text: 'Ref.', position: 'normal' },
    { text: 'a', position: 'superscript' }
  ]
  expected.grid[0][5] = 'Ref.a'
  expect(actual).toEqual(expected)
  expect(f).toEqual(immutable)
})

it.each([
  'missing-note',
  'wrong-letter',
  'clipped-note',
  'missing-closing',
  'competing-caption',
  'duplicate-native-marker',
  'duplicate-source-rect',
  'missing-source-token',
  'foreign-rotated-font',
  'neighbor-glyph-cut',
  'spanning-header',
  'existing-rich-header',
  'duplicate-cell-owner',
  'ordinary-marker-baseline',
  'mismatched-calibration-offset',
  'missing-reference-prefix',
  'nonsequential-citations',
  'truncated-last-citation',
  'clipped-header-marker',
  'second-reference-font',
  'missing-note-rect',
  'nonfinite-note-rect',
  'reversed-note-rect',
  'missing-native-font-rect',
  'nonfinite-native-font-rect',
  'reversed-native-font-rect',
  'nonfinite-footer-baseline',
  'nonfinite-footer-height'
])('refuses incomplete same-page reference calibration: %s', (control: string) => {
  const f = noteCalibratedHeader(),
    table = refineTable(f.table, f.items, f.captions, [], f.rules, [], null),
    donor = table.cells.find((c: { row: number; column: number }) => c.row === 0 && c.column === 5),
    marker = f.items.find((i: ReturnType<typeof JSON.parse>) => i.text === 'a' && i.rect[0] === 661)
  if (control === 'missing-note') f.notes = []
  if (control === 'wrong-letter') f.notes[0].text = 'b' + f.notes[0].text.slice(1)
  if (control === 'clipped-note') f.notes[0].rect[3] -= 1
  if (control === 'missing-closing') f.rules.pop()
  if (control === 'competing-caption') f.captions.push(structuredClone(f.captions[0]))
  if (control === 'duplicate-native-marker') f.items.push(structuredClone(marker))
  if (control === 'duplicate-source-rect')
    donor.sourceRects[1] = structuredClone(donor.sourceRects[0])
  if (control === 'missing-source-token') donor.sourceTokens.pop()
  if (control === 'foreign-rotated-font')
    f.items.push({ ...structuredClone(marker), text: 'x', horizontal: false })
  if (control === 'neighbor-glyph-cut') donor.rect[0] = 539
  if (control === 'spanning-header') donor.colSpan = 2
  if (control === 'existing-rich-header')
    donor.textRuns = [{ text: donor.text, position: 'normal' }]
  if (control === 'duplicate-cell-owner')
    table.cells
      .find((c: { row: number; column: number }) => c.row === 1 && c.column === 5)
      .sourceTokens.push(structuredClone(donor.sourceTokens[0]))
  if (control === 'ordinary-marker-baseline' || control === 'mismatched-calibration-offset') {
    const t = donor.sourceTokens.find((t: { text: string }) => t.text === 'a'),
      delta = control === 'ordinary-marker-baseline' ? 5.7135 : 1,
      oldRect = [...t.rect]
    for (const i of [t, marker]) {
      i.baseline += delta
      i.rect[1] += delta
      i.rect[3] += delta
    }
    const index = donor.sourceRects.findIndex(
      (r: number[]) => JSON.stringify(r) === JSON.stringify(oldRect)
    )
    donor.sourceRects[index] = [...t.rect]
  }
  if (control === 'missing-reference-prefix')
    f.items.find((i: { text: string }) => i.text.startsWith('References:')).text =
      'Details: (1) Writer (2020).'
  if (control === 'nonsequential-citations') {
    f.notes[0].text = f.notes[0].text.replace('(2)', '(3)')
    const i = f.items.find((i: { text: string }) => i.text.startsWith('(2)'))
    i.text = i.text.replace('(2)', '(3)')
  }
  if (control === 'truncated-last-citation') {
    f.notes[0].text = f.notes[0].text.slice(0, -1)
    const i = f.items.find((i: { text: string }) => i.text.startsWith('(3)'))
    i.text = i.text.slice(0, -1)
  }
  if (control === 'clipped-header-marker') donor.rect[2] = 666
  if (control === 'second-reference-font')
    f.items.push({
      ...structuredClone(marker),
      text: 'Ref.',
      rect: [670, 115, 690, 128.4496],
      baseline: 128.4496
    })
  if (control === 'missing-note-rect') f.notes[0].rect = undefined
  if (control === 'nonfinite-note-rect') f.notes[0].rect[1] = NaN
  if (control === 'reversed-note-rect') f.notes[0].rect[1] = f.notes[0].rect[3] + 1
  if (control.endsWith('native-font-rect')) {
    const rect = control === 'missing-native-font-rect' ? undefined : [100, 210, 110, 220]
    if (control === 'nonfinite-native-font-rect') rect![1] = NaN
    if (control === 'reversed-native-font-rect') rect![1] = 221
    f.items.push({ text: 'Additional', rect, height: 10, baseline: 220, horizontal: true })
  }
  if (control === 'nonfinite-footer-baseline')
    f.items.find((i: { text: string }) => i.text.startsWith('(2)')).baseline = NaN
  if (control === 'nonfinite-footer-height')
    f.items.find((i: { text: string }) => i.text.startsWith('(2)')).height = NaN
  const immutable = structuredClone({ f, table })
  expect(
    newLiteralOwnerHelpers.proveNativeNoteCalibratedHeaderMarker(
      table,
      f.items,
      f.captions,
      f.rules,
      f.notes
    )
  ).toBeUndefined()
  expect({ f, table }).toEqual(immutable)
})

it('does not infer a reference header from note coordinates on a different page', () => {
  const f = noteCalibratedHeader(),
    before = refineTable(f.table, f.items, f.captions, [], f.rules, [], null)
  for (const n of f.notes) {
    n.rect[1] += 1000
    n.rect[3] += 1000
  }
  expect(refineTable(f.table, f.items, f.captions, f.notes, f.rules, [], null)).toEqual(before)
})
