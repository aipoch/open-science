import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { anonymousNativeFractionCell } = await import(
  pathToFileURL(resolve('test/fixtures/open-native-fraction-cell.mjs')).href
)
const { reviewFinalNativeTableSources } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href
)
const { nativePageTextPacketInventory, nativeWholeCellInkPacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)

it('retains a flattened stacked fraction without changing its original owners or image geometry', () => {
  const f = anonymousNativeFractionCell(),
    before = JSON.stringify(f)
  const checked = reviewFinalNativeTableSources(f.table, f.inventory, f.rules, [], f.context)
  expect(checked.issues).toContain('native-table-structure-ambiguous')
  expect(checked.reviewCandidate).toBe(false)
  expect(checked.cells).toBe(f.table.cells)
  expect(checked.grid).toBe(f.table.grid)
  expect(checked.cropRect).toBe(f.table.cropRect)
  expect(JSON.stringify(f)).toBe(before)
})

it.each([
  'complete exterior ink',
  'overlapping exterior ink',
  'missing outline',
  'different glyph advance',
  'claimed zero advance',
  'empty outline'
])('retains exact foreign zero-advance glyph evidence only with %s', (mode) => {
  const f = anonymousNativeFractionCell(),
    p = f.context.nativeGlyphContext
  for (const content of [p.content, f.context.sourceContent]) content.items[3].width = 0
  for (const ops of [p.operators, f.context.operators])
    for (const args of ops.argsArray) if (args?.[0]?.[0]?.unicode === 'z') args[0][0].width = 0
  f.inventory[3].rect[2] = f.inventory[3].rect[0]
  if (mode === 'overlapping exterior ink')
    p.glyphBounds[0].glyphs.find((g: { fontChar: string }) => g.fontChar === 'z').bounds = [
      -8, 4.5, -7.6, 5.7
    ]
  if (mode === 'missing outline') p.glyphBounds[0].glyphs.pop()
  if (mode === 'different glyph advance')
    for (const args of p.operators.argsArray)
      if (args?.[0]?.[0]?.unicode === 'z') args[0][0].width = 5
  if (mode === 'empty outline')
    p.glyphBounds[0].glyphs.find((g: { fontChar: string }) => g.fontChar === 'z').bounds = [
      0, 0, 0, 0
    ]
  if (mode === 'claimed zero advance') {
    f.table.cells[0].sourceItems.push(p.content.items[3].sourceItem)
    f.table.cells[0].sourceRects.push(f.inventory[3].rect)
    f.table.cells[0].text += ' z'
  }
  const before = JSON.stringify(f),
    context = { ...p, viewport: f.context.viewport },
    packet = nativeWholeCellInkPacket(f.context.sourcePage, f.inventory, context, f.table.cells[0])
  expect(nativePageTextPacketInventory(f.context.sourcePage, f.inventory, context)).toBeUndefined()
  if (mode === 'complete exterior ink' || mode === 'overlapping exterior ink') {
    expect(packet).toBeDefined()
    const record = packet.records.find((r: { index: number }) => r.index === 3)
    expect(record.r.str).toBe('z')
    expect(record.rect[0]).toBe(record.rect[2])
    expect(record.ink[2]).toBeGreaterThan(record.ink[0])
    expect(record.advanceComplete).toBe(true)
    expect(record.part[0].g.textPaint).toEqual({ fillColor: '#000000', fillAlpha: 1 })
    expect(packet.records).toHaveLength(4)
  } else expect(packet).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})

it.each(['explicit slash', 'expressed script relation'])(
  'preserves a cell with an already %s',
  (mode) => {
    const f = anonymousNativeFractionCell(),
      cell = f.table.cells[0]
    if (mode === 'explicit slash') cell.text = '1/n a'
    else
      cell.textRuns = [
        { text: '1 n', position: 'superscript' },
        { text: ' a', position: 'normal' }
      ]
    expect(reviewFinalNativeTableSources(f.table, f.inventory, f.rules, [], f.context)).toBe(
      f.table
    )
  }
)

it.each([
  'foreign ink enters fraction',
  'missing foreign outline',
  'clipped claimed ink',
  'white paint',
  'font alias mismatch',
  'source identity mismatch'
])('does not infer a fraction relation with %s', (mode) => {
  const f = anonymousNativeFractionCell(),
    p = f.context.nativeGlyphContext
  if (mode === 'foreign ink enters fraction')
    p.glyphBounds[0].glyphs.find((g: { fontChar: string }) => g.fontChar === 'z').bounds = [
      -8, 4.5, -7.6, 5.7
    ]
  if (mode === 'missing foreign outline') p.glyphBounds[0].glyphs.pop()
  if (mode === 'clipped claimed ink') p.glyphBounds[0].glyphs[0].bounds = [-100, -10, -99, -9]
  if (mode === 'white paint') {
    p.operators.argsArray[0] = ['#ffffff']
    f.context.operators.argsArray[0] = ['#ffffff']
  }
  if (mode === 'font alias mismatch') f.context.sourceContent.styles.F.ascent += 0.1
  if (mode === 'source identity mismatch') f.context.sourceSha256 = 'b'.repeat(64)
  expect(reviewFinalNativeTableSources(f.table, f.inventory, f.rules, [], f.context)).toBe(f.table)
})

it('keeps the original page packet advance contract strict for exterior coarse sources', () => {
  const f = anonymousNativeFractionCell(),
    p = f.context.nativeGlyphContext
  const context = { ...p, viewport: f.context.viewport }
  expect(nativePageTextPacketInventory(f.context.sourcePage, f.inventory, context)).toBeUndefined()
  expect(
    nativePageTextPacketInventory(
      f.context.sourcePage,
      f.inventory,
      context,
      false,
      new Set([0, 1, 2])
    )
  ).toBeUndefined()
})
