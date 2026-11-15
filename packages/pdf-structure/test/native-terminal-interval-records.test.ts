import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths'

const { terminalIntervalFixture } = await import(
  pathToFileURL(resolve('test/fixtures/native-terminal-interval-records.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { proveNativeIntervalTerminalRecord } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-row-repair.mjs')).href
)
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

it('retains a complete numbered terminal record proved by native segmented dividers', async () => {
  const f = await terminalIntervalFixture()
  try {
    expect(f.rules).toHaveLength(17)
    const result = refine(f)
    expect(result.grid).toHaveLength(4)
    expect(result.grid.at(-1)).toEqual(['3. Case C', 'R n', '(R n , +)', 'S n', 'Neutral action C'])
    expect(result.unassigned).toEqual([])
    const last = result.cells.filter((c: Fixture) => c.row === 3)
    expect(last).toHaveLength(5)
    expect(
      last.every((c: Fixture) => c.rowSpan === 1 && c.colSpan === 1 && !c.sourceSegments)
    ).toBe(true)
    const expected = f.tokens
      .filter((t: Fixture) => t.baseline >= 128.8 * 1.5 && t.baseline <= 140.7 * 1.5)
      .map((t: Fixture) => t.sourceItem.index)
      .sort((a: number, b: number) => a - b)
    expect(
      last
        .flatMap((c: Fixture) => c.sourceItems.map((s: Fixture) => s.index))
        .sort((a: number, b: number) => a - b)
    ).toEqual(expected)
  } finally {
    await f.dispose()
  }
})

it.each(['detected', 'footer'])('retains the existing complete-row path: %s', async (mode) => {
  const f = await terminalIntervalFixture(mode)
  try {
    const result = refine(f)
    expect(result.grid).toHaveLength(4)
    expect(result.grid.at(-1)[0]).toBe('3. Case C')
    expect(result.unassigned).toEqual([])
  } finally {
    await f.dispose()
  }
})

it.each([
  'missing-divider',
  'shifted-divider',
  'unequal-ends',
  'extra-divider',
  'overlap-baseline',
  'white-dividers',
  'white-text',
  'crossing-token',
  'extra-token',
  'continuation',
  'ordinal-gap',
  'competing-caption',
  'alias-outside-crop',
  'spanning-cell',
  'stale-context',
  'foreign-zero-inside'
])(
  'does not mint terminal row ownership without complete independent native evidence: %s',
  async (mode) => {
    const f = await terminalIntervalFixture(mode)
    try {
      const result = refine(f)
      expect(result.repairs).not.toContain('final-record-recovered')
      expect(result.grid).toHaveLength(3)
    } finally {
      await f.dispose()
    }
  }
)

it('retains an unclaimed zero-advance glyph outside the terminal face', async () => {
  const f = await terminalIntervalFixture('foreign-zero-outside')
  try {
    const zero = f.tokens.find((t: Fixture) => t.text === 'X')
    expect(zero.rect[0]).toBe(zero.rect[2])
    const result = refine(f)
    expect(result.grid).toHaveLength(4)
    expect(
      result.cells
        .flatMap((c: Fixture) => c.sourceItems ?? [])
        .some((s: Fixture) => s.index === zero.sourceItem.index)
    ).toBe(false)
  } finally {
    await f.dispose()
  }
})

it.each(['external-source', 'external-operators', 'work-viewport', 'missing-native-ink'])(
  'refuses mismatched current native inputs: %s',
  async (mode) => {
    const f = await terminalIntervalFixture('foreign-zero-outside')
    try {
      if (mode === 'external-source') {
        f.context.sourceContent = structuredClone(f.context.sourceContent)
        f.context.content = f.context.sourceContent
        f.context.sourceContent.items.find((r: Fixture) => r.str === '3. Case C').width += 0.000001
      } else if (mode === 'external-operators') {
        const list = f.context.operators
        const index = list.fnArray.findIndex(
          (op: number, i: number) =>
            op &&
            Array.isArray(list.argsArray[i]) &&
            list.argsArray[i][0] === f.context.sourceContent.items[0].fontName
        )
        expect(index).toBeGreaterThanOrEqual(0)
        list.argsArray[index][1] += 0.000001
      } else if (mode === 'work-viewport') f.context.viewport.transform[4] += 0.000001
      else {
        const zero = f.nativeGlyphContext.content.items.find((r: Fixture) => r.str === 'X')
        f.nativeGlyphContext.glyphBounds.find((g: Fixture) => g.fontName === zero.fontName).glyphs =
          []
      }
      const result = refine(f)
      expect(result.repairs).not.toContain('final-record-recovered')
      expect(result.grid).toHaveLength(3)
    } finally {
      await f.dispose()
    }
  }
)

it('cannot promote a zero-advance source to a claimed terminal record', async () => {
  const f = await terminalIntervalFixture('claimed-zero')
  try {
    const zero = f.tokens.find((t: Fixture) => t.text === 'X')
    expect(zero.rect[0]).toBe(zero.rect[2])
    const groups = [114, 126.2, 138.4].map((baseline) =>
      f.tokens.filter(
        (t: Fixture) =>
          t.baseline >= (baseline - 3.61) * 1.5 && t.baseline <= (baseline + 0.01) * 1.5
      )
    )
    expect(groups[2]).toContain(zero)
    expect(
      proveNativeIntervalTerminalRecord({
        table: f.table,
        group: groups[2],
        groups,
        inventory: f.tokens,
        rows: [
          [104.4, 116.3],
          [116.6, 128.5]
        ].map(([top, bottom]) => ({ rect: [75, top * 1.5, 825, bottom * 1.5] })),
        columns: [50, 140, 235, 330, 420].map((left, col) => [
          left * 1.5,
          120,
          [140, 235, 330, 420, 550][col] * 1.5,
          221.1
        ]),
        objects: [],
        captions: f.captions,
        rules: f.rules,
        context: f.context,
        rulePaintBounds: f.paint
      })
    ).toBe(false)
  } finally {
    await f.dispose()
  }
})
