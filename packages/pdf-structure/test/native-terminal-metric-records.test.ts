import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousTerminalMetricRecords } = await import(
  pathToFileURL(resolve('test/fixtures/terminal-metric-records.mjs')).href
)
const { recoverNativeTerminalMetricRecords: recover } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-terminal-metric-records.mjs')).href
)

it.each(['', 'short-model-hint'])(
  'splits only the two complete already-owned terminal metric cycles of a real native PDF: %s',
  async (mode) => {
    const f = await anonymousTerminalMetricRecords()
    try {
      if (mode === 'short-model-hint') {
        const bottom = Math.max(...f.result.cells.at(-1).sourceRects.map((r: number[]) => r[3])) - 1
        f.result.rows.at(-1).rect[3] = bottom
        f.result.cells.slice(-5).forEach((c: { rect: number[] }) => (c.rect[3] = bottom))
      }
      expect(f.result.grid).toHaveLength(5)
      expect(f.result.grid.at(-1)[0]).toBe('Beta Gamma')
      const before = JSON.stringify(f.result),
        fixed = recover(f.result, f.items, f.captions, f.rules, f.recordText, f.context)
      expect(fixed).toBeDefined()
      expect(fixed.grid).toHaveLength(6)
      expect(fixed.grid.slice(-2).map((r: string[]) => r[0])).toEqual(['Beta', 'Gamma'])
      expect(fixed.grid.slice(-2).map((r: string[]) => r[1])).toEqual(['0.3 ± 1e-3', '0.4 ± 1e-3'])
      expect(fixed.cells).toHaveLength(f.result.cells.length + 5)
      expect(JSON.stringify(f.result)).toBe(before)
      expect(fixed.cells.slice(0, -10)).toEqual(f.result.cells.slice(0, -5))
      for (let n = 0; n < fixed.cells.length - 10; n++)
        expect(fixed.cells[n]).toBe(f.result.cells[n])
      for (const name of ['cropRect', 'notes', 'issues', 'unassigned', 'repairs'])
        expect(fixed[name]).toBe(f.result[name])
      expect(fixed.rows.slice(0, -2)).toEqual(f.result.rows.slice(0, -1))
      fixed.rows.slice(0, -2).forEach((r: object, n: number) => expect(r).toBe(f.result.rows[n]))
      expect(fixed.rows.at(-2).rect[1]).toBe(f.result.rows.at(-1).rect[1])
      expect(fixed.rows.at(-1).rect[3]).toBe(f.result.rows.at(-1).rect[3])
      const origins = (cells: { sourceItems: { index: number }[] }[]): { index: number }[] =>
        cells.flatMap((c) => c.sourceItems).sort((a, b) => a.index - b.index)
      expect(origins(fixed.cells)).toEqual(origins(f.result.cells))
      origins(fixed.cells).forEach((s: object, n: number) =>
        expect(s).toBe(origins(f.result.cells)[n])
      )
      expect(
        fixed.cells
          .slice(-10)
          .every((c: { sourceTokens: object[] }) =>
            c.sourceTokens.every(
              (t) => Object.keys(t).sort().join(',') === 'baseline,height,rect,text'
            )
          )
      ).toBe(true)
      for (const key of ['sourceRects', 'sourceTokens']) {
        const before = f.result.cells.flatMap((c: Record<string, object[]>) => c[key])
        const after = fixed.cells.flatMap((c: Record<string, object[]>) => c[key])
        expect(after).toHaveLength(before.length)
        for (const value of after) expect(before.includes(value)).toBe(true)
      }
      expect(
        fixed.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 0)
          .textRuns
      ).toBe(
        f.result.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 0)
          .textRuns
      )
      expect(recover(fixed, f.items, f.captions, f.rules, f.recordText, f.context)).toBeUndefined()
    } finally {
      await f.cleanup()
    }
  }
)

it.each([
  'wrapped-label',
  'sparse',
  'metric-script',
  'missing-underline',
  'foreign-paint',
  'foreign-glyph',
  'ink-beyond-closing'
])('refuses actual native %s without inventing another record or Source owner', async (mode) => {
  const f = await anonymousTerminalMetricRecords(mode)
  try {
    const before = JSON.stringify(f.result)
    expect(recover(f.result, f.items, f.captions, f.rules, f.recordText, f.context)).toBeUndefined()
    expect(JSON.stringify(f.result)).toBe(before)
  } finally {
    await f.cleanup()
  }
})

it.each(['direct', 'nested-clone', 'shared-origin-array', 'shared-wrapper', 'peer-third-owner'])(
  'refuses undeclared recursive Source carriers through %s, including original-object aliases',
  async (mode) => {
    const f = await anonymousTerminalMetricRecords()
    try {
      const donor = f.result.cells.at(-5),
        origin = donor.sourceItems.at(-1)
      if (mode === 'direct') donor.sourceItem = origin
      if (mode === 'nested-clone') donor.privateEvidence = { child: { sourceItem: { ...origin } } }
      if (mode === 'shared-origin-array') donor.privateEvidence = { owners: donor.sourceItems }
      if (mode === 'shared-wrapper') {
        const shared = { child: origin }
        donor.privateEvidence = shared
        f.result.cells[0].privateEvidence = shared
      }
      if (mode === 'peer-third-owner')
        f.result.cells[0].privateEvidence = { child: { owner: origin } }
      const before = JSON.stringify(f.result)
      expect(
        recover(f.result, f.items, f.captions, f.rules, f.recordText, f.context)
      ).toBeUndefined()
      expect(JSON.stringify(f.result)).toBe(before)
    } finally {
      await f.cleanup()
    }
  }
)

it('retains unknown Source-free metadata and harmless shared objects in replacement cells', async () => {
  const f = await anonymousTerminalMetricRecords()
  try {
    const donor = f.result.cells.at(-5),
      shared = { label: 'ordinary metadata', values: [1, 2] },
      evidence = { summary: shared, alias: shared }
    donor.privateEvidence = evidence
    const fixed = recover(f.result, f.items, f.captions, f.rules, f.recordText, f.context)
    expect(fixed).toBeDefined()
    expect(fixed.cells.at(-10).privateEvidence).toBe(evidence)
    expect(fixed.cells.at(-5).privateEvidence).toBe(evidence)
  } finally {
    await f.cleanup()
  }
})

it.each(['accessor', 'symbol', 'nonenumerable', 'cycle', 'depth'])(
  'declines unsafe recursive evidence via %s without invoking accessors',
  async (mode) => {
    const f = await anonymousTerminalMetricRecords()
    try {
      const donor = f.result.cells.at(-5),
        origin = donor.sourceItems.at(-1),
        metadata: Record<PropertyKey, unknown> = {}
      let getterCalled = false
      if (mode === 'accessor')
        Object.defineProperty(metadata, 'ordinary', {
          enumerable: true,
          get: () => {
            getterCalled = true
            return origin
          }
        })
      if (mode === 'symbol') metadata[Symbol('owner')] = origin
      if (mode === 'nonenumerable') Object.defineProperty(metadata, 'ordinary', { value: origin })
      if (mode === 'cycle') metadata.self = metadata
      if (mode === 'depth') {
        let cursor = metadata
        for (let n = 0; n < 17; n++) {
          const child = {}
          cursor.child = child
          cursor = child
        }
      }
      donor.privateEvidence = metadata
      expect(
        recover(f.result, f.items, f.captions, f.rules, f.recordText, f.context)
      ).toBeUndefined()
      expect(getterCalled).toBe(false)
      expect(donor.privateEvidence).toBe(metadata)
    } finally {
      await f.cleanup()
    }
  }
)

it.each([
  'third-owner',
  'peer-segment',
  'target-richtext',
  'source-token-carrier',
  'wrong-rect',
  'wrong-literal',
  'undeclared-underline',
  'fabricated-underline',
  'missing-source-context',
  'missing-native-font',
  'column-gap',
  'wrong-grid',
  'ink-beyond-crop',
  'adjacent-owner'
])(
  'preserves the old result when %s prevents a complete existing ownership proof',
  async (mode) => {
    const f = await anonymousTerminalMetricRecords(
      mode === 'fabricated-underline' ? 'missing-underline' : ''
    )
    try {
      const donor = f.result.cells.at(-5),
        first = f.result.cells[0]
      if (mode === 'third-owner') {
        first.sourceItems.push(donor.sourceItems[0])
        first.sourceRects.push(donor.sourceRects[0])
        first.sourceTokens.push(donor.sourceTokens[0])
        first.text += ' ' + donor.sourceTokens[0].text
        f.result.grid[0][0] = first.text
      }
      if (mode === 'peer-segment')
        first.sourceSegments = [
          { ...first.sourceItems[0], start: 0, end: 2, rect: first.sourceRects[0] }
        ]
      if (mode === 'target-richtext') donor.textRuns = [{ text: donor.text, position: 'normal' }]
      if (mode === 'source-token-carrier') first.sourceTokens[0].sourceItem = first.sourceItems[0]
      if (mode === 'wrong-rect')
        donor.sourceRects[0] = donor.sourceRects[0].map(
          (x: number, n: number) => x + (n === 0 ? 0.01 : 0)
        )
      if (mode === 'wrong-literal')
        donor.sourceItems[0] = { ...donor.sourceItems[0], text: 'Other' }
      if (mode === 'undeclared-underline') f.rules = f.rules.filter((r: number[]) => r[1] !== 183)
      if (mode === 'fabricated-underline') f.rules.push([120, 183, 435, 183])
      if (mode === 'missing-source-context') f.context.nativeGlyphContext = undefined
      if (mode === 'missing-native-font')
        f.items = f.items.filter(
          (i: { sourceItem: { index: number } }) =>
            i.sourceItem.index !== donor.sourceItems[0].index
        )
      if (mode === 'column-gap')
        donor.rect = donor.rect.map((x: number, n: number) => x + (n === 2 ? -0.1 : 0))
      if (mode === 'wrong-grid') f.result.grid.at(-1)[0] = 'Other'
      if (mode === 'ink-beyond-crop')
        f.result.cropRect[3] =
          Math.max(...f.result.cells.at(-1).sourceRects.map((r: number[]) => r[3])) - 0.1
      if (mode === 'adjacent-owner')
        f.result.cells.find(
          (c: { row: number; column: number }) => c.row === 3 && c.column === 0
        ).rect[3] = 280
      const before = JSON.stringify(f.result)
      expect(
        recover(f.result, f.items, f.captions, f.rules, f.recordText, f.context)
      ).toBeUndefined()
      expect(JSON.stringify(f.result)).toBe(before)
    } finally {
      await f.cleanup()
    }
  }
)
