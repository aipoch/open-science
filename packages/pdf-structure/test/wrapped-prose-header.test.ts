import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { anonymousWrappedProseHeader } = await import(
  pathToFileURL(resolve('test/fixtures/wrapped-prose-header.mjs')).href
)
const { recoverNativeWrappedProseHeaderGrid, reconcileNativeWrappedProseTerminalSources } =
  await import(
    pathToFileURL(resolve('resources/literature-pdf-native-wrapped-prose-header.mjs')).href
  )
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)

it('keeps all original fonts in complete prose records under four wrapped headings', async () => {
  const f = await anonymousWrappedProseHeader()
  try {
    const before = JSON.stringify(f.items),
      plan = recoverNativeWrappedProseHeaderGrid(f.table, f.items, f.captions, f.rules, f.context)
    expect(plan).toBeDefined()
    expect(plan.rows).toHaveLength(4)
    expect(plan.columns).toHaveLength(4)
    expect(plan.cropRect).toEqual(f.table.cropRect)
    expect([...plan.ownedTokens]).toHaveLength(23)
    expect([...plan.ownedTokens].filter((i: { text: string }) => i.text === 'Tail.')).toHaveLength(
      3
    )
    expect(JSON.stringify(f.items)).toBe(before)
  } finally {
    await f.cleanup()
  }
})

it.each([
  'peer-segment',
  'peer-runs',
  'token-carrier',
  'stale-unassigned',
  'old-text',
  'duplicate-owner'
])('rejects incompatible late Source carriers: %s', async (mode) => {
  const f = await anonymousWrappedProseHeader()
  try {
    const crop = f.table.cropRect,
      object = (label: string, rect: number[]): object => ({
        label,
        rect: rect.map((x, n) => x - crop[n % 2])
      })
    f.table.id = 'page-1-table-1'
    f.table.structure.objects = [
      ...[
        [58, 138],
        [138, 215],
        [215, 296],
        [296, 392]
      ].map(([a, b]) => object('table column', [a, 148, b, 344])),
      ...[
        [148, 198],
        [198, 247],
        [247, 292],
        [292, 344]
      ].map(([a, b]) => object('table row', [58, a, 392, b])),
      object('table column header', [58, 148, 392, 198])
    ]
    const result = refineTable(
        f.table,
        f.items,
        f.captions,
        [],
        f.rules,
        [],
        undefined,
        undefined,
        f.context
      ),
      target = result.cells.find(
        (c: { row: number; column: number }) => c.row === 2 && c.column === 3
      ),
      peer = result.cells[0],
      missing = target.sourceItems.pop()
    target.sourceRects.pop()
    target.sourceTokens.pop()
    target.text = target.text.replace(/ Tail\.$/u, '')
    result.grid[2][3] = target.text
    result.unassigned = ['Tail.']
    result.issues = ['unassigned-source-text']
    expect(
      reconcileNativeWrappedProseTerminalSources(result, f.items, f.captions, f.rules, f.context)
    ).toBeDefined()
    if (mode === 'peer-segment') peer.sourceSegments = [{ sourceItem: missing }]
    if (mode === 'peer-runs') peer.textRuns = [{ text: 'Tail.', sourceItems: [missing] }]
    if (mode === 'token-carrier') peer.sourceTokens[0].sourceToken = missing
    if (mode === 'stale-unassigned') result.unassigned.push('Foreign')
    if (mode === 'old-text') {
      peer.text += ' Foreign'
      result.grid[0][0] = peer.text
    }
    if (mode === 'duplicate-owner') {
      peer.sourceItems.push(target.sourceItems[0])
      peer.sourceRects.push(target.sourceRects[0])
      peer.sourceTokens.push(target.sourceTokens[0])
    }
    expect(
      reconcileNativeWrappedProseTerminalSources(result, f.items, f.captions, f.rules, f.context)
    ).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})

it('retains terminal Sources through refine with raw caption padding and incomplete model rows', async () => {
  const f = await anonymousWrappedProseHeader()
  try {
    f.table.id = 'page-1-table-1'
    f.table.cropRect[1] = 134.8
    const crop = f.table.cropRect
    const object = (label: string, rect: number[]): object => ({
      label,
      score: 1,
      rect: rect.map((x, n) => x - crop[n % 2])
    })
    f.table.structure.objects = [
      ...[
        [58, 138],
        [138, 215],
        [215, 296],
        [296, 392]
      ].map(([a, b]) => object('table column', [a, 148, b, 344])),
      ...[
        [148, 198],
        [198, 247],
        [247, 262],
        [288, 344]
      ].map(([a, b]) => object('table row', [58, a, 392, b])),
      object('table column header', [58, 148, 392, 198])
    ]
    const result = refineTable(
      f.table,
      f.items,
      f.captions,
      [],
      f.rules,
      [],
      undefined,
      undefined,
      f.context
    )
    expect(result.grid).toHaveLength(4)
    expect(result.cells).toHaveLength(16)
    expect(
      result.cells.flatMap((c: { sourceItems?: unknown[] }) => c.sourceItems ?? [])
    ).toHaveLength(23)
    expect(result.unassigned).toEqual([])
    expect(
      result.cells
        .filter((c: { column: number }) => c.column === 3)
        .slice(1)
        .every((c: { text: string }) => c.text.endsWith('Tail.'))
    ).toBe(true)
  } finally {
    await f.cleanup()
  }
})

it.each([
  'opening',
  'divider',
  'closing',
  'white-rail',
  'foreign-paint',
  'foreign-glyph',
  'citation',
  'missing-field',
  'cross-gutter',
  'cross-record',
  'fake-source',
  'alias',
  'token',
  'font',
  'caption'
])('rejects incomplete native prose ownership: %s', async (mode) => {
  const f = await anonymousWrappedProseHeader(mode)
  try {
    const t = f.items.find((i: { text: string }) => i.text === 'Record')
    if (mode === 'fake-source') t.sourceItem.text = 'Fake'
    if (mode === 'alias') f.items.push({ ...t })
    if (mode === 'token') t.sourceToken = { sourceItem: t.sourceItem }
    if (mode === 'font') f.context.nativeGlyphContext.content.styles = {}
    if (mode === 'caption') f.captions[0].lines = ['Table 1: Foreign records.']
    expect(
      recoverNativeWrappedProseHeaderGrid(f.table, f.items, f.captions, f.rules, f.context)
    ).toBeUndefined()
  } finally {
    await f.cleanup()
  }
})
