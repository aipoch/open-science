import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths'

const { interiorPairFixture } = await import(
  pathToFileURL(resolve('test/fixtures/native-interior-paired-rows.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeInteriorPairedRows } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-bounded-text-record-grid.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
type Fixture = ReturnType<typeof JSON.parse>
const refine = (f: Fixture): Fixture =>
  refineTable(
    f.table,
    f.tokens,
    f.captions,
    [],
    f.rules,
    [],
    undefined,
    f.paint,
    f.context,
    f.witness
  )

// Detector bands are explicit test input; genuine PDF.js rendering supplies all native evidence.
it.each(['base', 'gap', 'aggregate-next', 'multi-show', 'gray-rails'])(
  'retains each complete interior pair using current whole native sources: %s',
  async (mode) => {
    const f = await interiorPairFixture(mode)
    try {
      const crop = [...f.table.cropRect]
      const result = refine(f)
      const target = f.tokens.filter(
        (t: Fixture) => t.text === 'Entry B' || t.text === 'Author B 2002[2]'
      )
      const cells = target.map((t: Fixture) =>
        result.cells.filter((c: Fixture) =>
          c.sourceItems?.some((s: Fixture) => s.index === t.sourceItem.index)
        )
      )
      expect(cells.map((owners: Fixture[]) => owners.length)).toEqual([1, 1])
      expect(cells[0][0].row).toBe(cells[1][0].row)
      expect(cells.map((owners: Fixture[]) => owners[0].column)).toEqual([0, 1])
      expect(cells.map((owners: Fixture[]) => owners[0].text)).toEqual(
        target.map((t: Fixture) => t.text)
      )
      expect(cells.every((owners: Fixture[]) => !owners[0].sourceSegments)).toBe(true)
      const claims = result.cells.flatMap((c: Fixture) => c.sourceItems ?? [])
      expect(new Set(claims.map((s: Fixture) => `${s.pageNumber}:${s.index}`)).size).toBe(
        claims.length
      )
      expect(result.unassigned).toEqual([])
      expect(f.table.cropRect).toEqual(crop)
    } finally {
      await f.dispose()
    }
  }
)

it.each([
  'no-rails',
  'white-rails',
  'white-source',
  'foreign-leading',
  'foreign-zero',
  'column-major',
  'plain-prose',
  'notes',
  'caption',
  'span',
  'header',
  'stale-native-ink',
  'unknown-native-ink',
  'raw-source-glyph',
  'raw-used-rail',
  'alias-outside-crop'
])('refuses optional paired-row recovery without complete native proof: %s', async (mode) => {
  const f = await interiorPairFixture(mode)
  try {
    const notes = []
    if (mode === 'notes') notes.push({ text: 'Note', rect: [90, 152, 600, 166] })
    if (mode === 'caption') {
      f.captions.push({ page: 1, lines: ['Table 2: Other'], rect: [90, 152, 600, 166] })
    }
    if (mode === 'span' || mode === 'header') {
      f.table.structure.objects.push({
        label: mode === 'span' ? 'table spanning cell' : 'table column header',
        score: 1,
        rect: [0, 40, 750, 70]
      })
    }
    if (mode === 'stale-native-ink') {
      f.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds[0] += 0.001
    }
    if (mode === 'unknown-native-ink') {
      f.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds = undefined
    }
    if (mode === 'raw-source-glyph') {
      const list = f.context.operators
      const index = list.fnArray.findIndex(
        (op: number, i: number) =>
          op === OPS.showText &&
          list.argsArray[i][0]
            .filter((g: Fixture) => typeof g === 'object')
            .map((g: Fixture) => g.unicode)
            .join('') === 'Entry B'
      )
      expect(index).toBeGreaterThanOrEqual(0)
      const glyph = list.argsArray[index][0].find((g: Fixture) => typeof g === 'object')
      const before = glyph.width
      glyph.width += 0.001
      expect(glyph.width).not.toBe(before)
    }
    if (mode === 'raw-used-rail') {
      const list = f.context.operators
      const index = list.fnArray.findIndex(
        (op: number, i: number) => op === OPS.constructPath && list.argsArray[i][0] === OPS.stroke
      )
      expect(index).toBeGreaterThanOrEqual(0)
      const path = list.argsArray[index][1][0]
      const before = path[1]
      path[1] += 0.01
      expect(path[1]).not.toBe(before)
    }
    if (mode === 'alias-outside-crop') {
      const token = f.tokens.find((t: Fixture) => t.text === 'Entry B')
      f.tokens.push({
        ...token,
        rect: token.rect.map((n: number, i: number) => (i % 2 ? n : n + 1000))
      })
    }
    const result = refineTable(
      f.table,
      f.tokens,
      f.captions,
      notes,
      f.rules,
      [],
      undefined,
      f.paint,
      f.context,
      f.witness
    )
    expect(result.repairs).not.toContain('native-interior-paired-record-recovered')
  } finally {
    await f.dispose()
  }
})

it('declines missing, non-map and accessor-bearing context without invoking getters', async () => {
  let calls = 0
  const getter = (): never => {
    calls++
    throw new Error('Proof preparation must not invoke accessors')
  }
  const f = await interiorPairFixture()
  try {
    const contextGetter = Object.defineProperty({}, 'sourcePage', { get: getter })
    const nativeGetter = Object.defineProperty({}, 'viewport', { get: getter })
    const fakeMap = { [Symbol.iterator]: getter }
    for (const context of [
      undefined,
      {},
      contextGetter,
      { ...f.context, nativeGlyphContext: nativeGetter },
      { ...f.context, rulePaintBounds: undefined },
      { ...f.context, rulePaintBounds: fakeMap },
      { ...f.context, rulePaintBounds: new Proxy(new Map(), {}) }
    ]) {
      expect(() => recoverNativeInteriorPairedRows({ context })).not.toThrow()
    }
    expect(calls).toBe(0)
  } finally {
    await f.dispose()
  }
})

it('retains an existing ambiguity diagnostic after local native pair recovery', async () => {
  const f = await interiorPairFixture()
  try {
    // Omit only this optional helper's witness to obtain ordinary assigned cells.
    // The separate genuine witness below is rebuilt by the normal fixture constructors.
    const result = refineTable(
      f.table,
      f.tokens,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      f.paint,
      f.context,
      undefined
    )
    expect(result.unassigned).toContain('Entry B')
    // populateTableCellText can keep a preferred owner in assignments and also
    // ambiguousAssignments. A unique public Source owner is not an origin proof.
    const issues = new Set([...result.issues, 'ambiguous-cell-assignment'])
    const baseCells = result.rows.flatMap((row: Fixture, rowIndex: number) =>
      [
        [75, 105, 375, 195],
        [375, 105, 825, 195]
      ].map((rect, column) => ({
        row: rowIndex,
        column,
        rowSpan: 1,
        colSpan: 1,
        origin: 'model-grid',
        rect: [rect[0], row.rect[1], rect[2], row.rect[3]]
      }))
    )
    const groups = [...new Set(f.tokens.map((t: Fixture) => t.baseline))]
      .sort((a: number, b: number) => a - b)
      .map((baseline) => f.tokens.filter((t: Fixture) => t.baseline === baseline))
    const repairs = [...result.repairs]
    recoverNativeInteriorPairedRows({
      table: f.table,
      rows: result.rows,
      groups,
      items: f.tokens,
      inventory: f.tokens,
      columnRects: [
        [75, 105, 375, 195],
        [375, 105, 825, 195]
      ],
      objects: f.table.structure.objects.map((o: Fixture) => ({
        ...o,
        rect: o.rect.map((n: number, i: number) => n + f.table.cropRect[i % 2])
      })),
      captions: f.captions,
      rules: f.rules,
      context: f.context,
      witness: f.witness,
      repairs,
      cells: result.cells,
      baseCells,
      unassigned: result.unassigned,
      issues,
      headerRows: [0],
      notes: []
    })
    expect(repairs).toContain('native-interior-paired-record-recovered')
    expect(result.unassigned).toEqual([])
    expect(issues.has('ambiguous-cell-assignment')).toBe(true)
    expect(baseCells).toHaveLength(result.rows.length * 2)
    expect(
      baseCells.every(
        (cell: Fixture) =>
          cell.row >= 0 &&
          cell.row < result.rows.length &&
          cell.rect[1] === result.rows[cell.row].rect[1] &&
          cell.rect[3] === result.rows[cell.row].rect[3]
      )
    ).toBe(true)
  } finally {
    await f.dispose()
  }
})
