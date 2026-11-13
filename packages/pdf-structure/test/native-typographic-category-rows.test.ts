import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths'

const { categoryFixture } = await import(
  pathToFileURL(resolve('test/fixtures/native-typographic-category-rows.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeTypographicCategoryRows } = await import(
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
const tokenGeometry = ({ text, rect, baseline, height }: Fixture): Fixture => ({
  text,
  rect,
  baseline,
  height
})

// All detector bands are explicit test data. Real PDF.js rendering creates the
// native font/paint context; no serialized object supplies proof authority.
it.each(['base', 'mixed', 'gray-rails', 'section-links'])(
  'owns repeated native category rows once as complete spans: %s',
  async (mode) => {
    const f = await categoryFixture(mode)
    try {
      const crop = [...f.table.cropRect]
      const result = refine(f)
      const headings = f.tokens.filter((t: Fixture) =>
        ['INDEPENDENT CATEGORIES', 'DIFFERENT CATEGORIES'].includes(t.text)
      )
      expect(headings).toHaveLength(2)
      for (const heading of headings) {
        const owners = result.cells.filter((c: Fixture) =>
          c.sourceItems?.some((s: Fixture) => s.index === heading.sourceItem.index)
        )
        expect(owners).toHaveLength(1)
        const cell = owners[0]
        expect([cell.column, cell.rowSpan, cell.colSpan]).toEqual([0, 1, 6])
        const originals = cell.sourceItems.map((source: Fixture) =>
          f.tokens.find((t: Fixture) => t.sourceItem.index === source.index)
        )
        expect(cell.sourceRects).toEqual(originals.map((t: Fixture) => t.rect))
        expect(cell.sourceTokens.map(tokenGeometry)).toEqual(originals.map(tokenGeometry))
        expect(cell.sourceSegments).toBeUndefined()
      }
      for (const label of ['A', 'B', 'C', 'D']) {
        expect(result.grid).toContainEqual([
          `Item ${label}`,
          ...Array.from({ length: 5 }, (_, i) => `Field ${i + 1} ${label}`)
        ])
      }
      const sources = result.cells.flatMap((c: Fixture) => c.sourceItems ?? [])
      expect(new Set(sources.map((s: Fixture) => `${s.pageNumber}:${s.index}`)).size).toBe(
        sources.length
      )
      expect(result.unassigned).toEqual([])
      expect(result.cropRect).toEqual(crop)
    } finally {
      await f.dispose()
    }
  }
)

it.each([
  'foreign-paint',
  'single-role',
  'shifted-role',
  'missing-rail',
  'white-rails',
  'white-category',
  'foreign-field',
  'notes',
  'caption',
  'raw-heading-glyph',
  'raw-rail',
  'stale-native-ink',
  'unknown-native-ink',
  'source-alias'
])(
  'declines native category recovery without complete row and paint evidence: %s',
  async (mode) => {
    const f = await categoryFixture(mode)
    try {
      const notes = []
      if (mode === 'notes') notes.push({ text: 'Note', rect: [90, 141, 600, 159] })
      if (mode === 'caption') {
        f.captions.push({ page: 1, lines: ['Table 2: Other'], rect: [90, 141, 600, 159] })
      }
      if (mode === 'raw-heading-glyph') {
        const list = f.context.operators
        const index = list.fnArray.findIndex(
          (op: number, i: number) =>
            op === OPS.showText &&
            list.argsArray[i][0]
              .filter((g: Fixture) => typeof g === 'object')
              .map((g: Fixture) => g.unicode)
              .join('') === 'INDEPENDENT CATEGORIES'
        )
        expect(index).toBeGreaterThanOrEqual(0)
        const glyph = list.argsArray[index][0].find((g: Fixture) => typeof g === 'object')
        const before = glyph.width
        glyph.width += 0.001
        expect(glyph.width).not.toBe(before)
      }
      if (mode === 'raw-rail') {
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
      if (mode === 'stale-native-ink')
        f.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds[0] += 0.001
      if (mode === 'unknown-native-ink')
        f.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds = undefined
      if (mode === 'source-alias') {
        const token = f.tokens.find((t: Fixture) => t.text === 'INDEPENDENT CATEGORIES')
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
      expect(result.repairs).not.toContain('native-typographic-category-row-recovered')
    } finally {
      await f.dispose()
    }
  }
)

// The layout seam takes ordinary detector rows and empty cells. Native proof
// objects below always come from the actual fixture render, never JSON data.
const emptyLayout = (f: Fixture): Fixture => {
  const crop = f.table.cropRect
  const rows = f.table.structure.objects
    .filter((o: Fixture) => o.label === 'table row')
    .map((o: Fixture) => ({
      ...o,
      origin: 'model',
      rect: o.rect.map((n: number, i: number) => n + crop[i % 2])
    }))
    .sort((a: Fixture, b: Fixture) => a.rect[1] - b.rect[1])
  const columnRects = f.table.structure.objects
    .filter((o: Fixture) => o.label === 'table column')
    .map((o: Fixture) => [o.rect[0] + crop[0], crop[1], o.rect[2] + crop[0], crop[3]])
    .sort((a: number[], b: number[]) => a[0] - b[0])
  const baseCells = rows.flatMap((row: Fixture, index: number) =>
    columnRects.map((c: number[], column: number) => ({
      row: index,
      column,
      rowSpan: 1,
      colSpan: 1,
      origin: 'model-grid',
      rect: [c[0], row.rect[1], c[2], row.rect[3]]
    }))
  )
  return {
    table: f.table,
    items: f.tokens,
    inventory: f.tokens,
    rows,
    cells: baseCells.map((c: Fixture) => ({ ...c, items: [] })),
    baseCells,
    columnRects,
    headerRows: [0],
    captions: f.captions,
    rules: f.rules,
    context: f.context,
    witness: f.witness,
    repairs: [],
    notes: []
  }
}

it.each([
  'base',
  'frozen-output',
  'cross-row-spans',
  'populated-cell',
  'outer-carrier',
  'map-add',
  'map-replace'
])('commits only a complete current native layout and keeps refusals atomic: %s', async (mode) => {
  const f = await categoryFixture()
  try {
    const input = emptyLayout(f)
    if (mode === 'frozen-output') Object.freeze(input.cells)
    if (mode === 'populated-cell') input.cells[0].text = 'Already assigned'
    if (mode === 'cross-row-spans') {
      for (const row of [1, 4]) {
        const cell = input.cells.find((c: Fixture) => c.row === row && c.column === 0)
        cell.rowSpan = 2
        cell.rect = [...cell.rect.slice(0, 3), input.rows[row + 1].rect[3]]
      }
    }
    let changed = 0
    if (['outer-carrier', 'map-add', 'map-replace'].includes(mode)) {
      const original = f.context.viewport.convertToViewportPoint.bind(f.context.viewport)
      f.context.viewport.convertToViewportPoint = (x: number, y: number): number[] => {
        if (!changed++) {
          if (mode === 'outer-carrier') f.context.sourceContent = { ...f.context.sourceContent }
          else if (mode === 'map-add') f.paint.set('extra-unrelated-key', [0, 0, 1, 1])
          else {
            const key = f.paint.keys().next().value
            f.paint.set(key, [...f.paint.get(key)])
          }
        }
        return original(x, y)
      }
    }
    const before = JSON.stringify([
      input.rows,
      input.cells,
      input.baseCells,
      input.headerRows,
      input.repairs
    ])
    recoverNativeTypographicCategoryRows(input)
    if (mode === 'base') {
      expect(input.repairs).toHaveLength(2)
      expect(input.cells.filter((c: Fixture) => c.colSpan === 6)).toHaveLength(2)
    } else {
      if (['outer-carrier', 'map-add', 'map-replace'].includes(mode))
        expect(changed).toBeGreaterThan(0)
      expect(input.repairs).toEqual([])
      expect(
        JSON.stringify([input.rows, input.cells, input.baseCells, input.headerRows, input.repairs])
      ).toBe(before)
    }
  } finally {
    await f.dispose()
  }
})

it('rejects missing context and accessors without executing a getter or fake Map iterator', async () => {
  const f = await categoryFixture()
  try {
    let calls = 0
    const getter = (): never => {
      calls++
      throw new Error('Native preparation must not invoke getters')
    }
    for (const context of [
      undefined,
      Object.defineProperty({}, 'sourcePage', { get: getter }),
      { ...f.context, nativeGlyphContext: Object.defineProperty({}, 'viewport', { get: getter }) },
      { ...f.context, rulePaintBounds: { [Symbol.iterator]: getter } },
      { ...f.context, rulePaintBounds: new Proxy(new Map(), {}) }
    ]) {
      expect(() =>
        recoverNativeTypographicCategoryRows({ ...emptyLayout(f), context })
      ).not.toThrow()
    }
    expect(calls).toBe(0)
  } finally {
    await f.dispose()
  }
})

it('declines an early work viewport transform accessor without reading it or changing layout', async () => {
  const f = await categoryFixture()
  try {
    const input = emptyLayout(f)
    const before = JSON.stringify([
      input.rows,
      input.cells,
      input.baseCells,
      input.headerRows,
      input.repairs
    ])
    let calls = 0
    Object.defineProperty(f.context.viewport, 'transform', {
      configurable: true,
      get: () => {
        calls++
        throw new Error('Viewport accessors must remain unexecuted')
      }
    })
    expect(() => recoverNativeTypographicCategoryRows(input)).not.toThrow()
    expect(calls).toBe(0)
    expect(
      JSON.stringify([input.rows, input.cells, input.baseCells, input.headerRows, input.repairs])
    ).toBe(before)
  } finally {
    await f.dispose()
  }
})
