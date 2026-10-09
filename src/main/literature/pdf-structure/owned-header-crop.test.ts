import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { recoverOwnedTableCrop, tableCaptionCropTop, completeRepeatedHorizontalRuleCarrierCrop } =
  await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-geometry.mjs')).href
  )

const repeatedRuleTail = (footerOverlap = 0): ReturnType<typeof JSON.parse> => {
  const lanes = [
    [40, 100],
    [100.5, 175]
  ]
  const rows = [
    ['Left', 'Right'],
    ['First', 'Second'],
    ['Third', 'Fourth']
  ]
  const rules: number[][] = []
  const paint = new Map<string, number[]>()
  const graphics: { kind: string; rect: number[] }[] = []
  for (let row = 0; row <= rows.length; row++) {
    const y = 50 + row * 25
    for (let column = 0; column < lanes.length; column++) {
      const [left, right] = lanes[column]
      const start = left - (row === rows.length ? footerOverlap : 0)
      const rule = [start, y, right, y]
      rules.push(rule)
      paint.set(rule.join(','), [start, y - 0.3, right, y + 0.3])
      graphics.push({
        kind: 'path',
        rect: [start - 0.5, y - 0.9, right + (column ? 1.2 : 0.35), y + 0.9]
      })
    }
  }
  const fonts: {
    text: string
    rect: number[]
    height: number
    baseline: number
    fontDescent: number
    horizontal: boolean
  }[] = []
  const cells = rows.flatMap((row, rowIndex) =>
    row.map((text, column) => {
      const baseline = 65 + rowIndex * 25
      const x = column ? 132 : 54
      const font = {
        text,
        rect: [x, baseline - 10, x + 30, baseline],
        height: 10,
        baseline,
        fontDescent: -0.2,
        horizontal: true
      }
      fonts.push(font)
      return {
        row: rowIndex,
        column,
        rowSpan: 1,
        colSpan: 1,
        text,
        rect: [lanes[column][0], 50 + rowIndex * 25, lanes[column][1], 75 + rowIndex * 25],
        sourceRects: [[...font.rect]],
        sourceTokens: [{ text, rect: [...font.rect], height: 10, baseline }]
      }
    })
  )
  const items = fonts.map((font) => ({ ...font, rect: [...font.rect] }))
  return {
    table: {
      cropRect: [36, 44, 168, 130],
      grid: rows,
      cells,
      unassigned: [],
      issues: [],
      clipped: [],
      readingRotation: 0
    },
    rules,
    paint,
    graphics,
    fonts,
    items,
    pageSize: [240, 200]
  }
}

const completeTail = (f: ReturnType<typeof JSON.parse>): number[] | undefined =>
  completeRepeatedHorizontalRuleCarrierCrop(
    f.table,
    f.rules,
    f.pageSize,
    f.items,
    f.paint,
    f.graphics,
    f.fonts
  )

it('completes repeated horizontal rule carriers after all literal fonts already fit', () => {
  const f = repeatedRuleTail()
  const before = structuredClone(f)
  const crop = recoverOwnedTableCrop(
    f.table,
    f.rules,
    f.pageSize,
    f.items,
    f.paint,
    f.graphics,
    f.fonts
  )
  expect(crop).toEqual([36, 44, 176.2, 130])
  expect(f).toEqual(before)
  expect(tableCaptionCropTop({ ...f.table, cropRect: crop }, 35, f.rules)).toBe(
    tableCaptionCropTop(f.table, 35, f.rules)
  )
})

it('completes repeated horizontal rule carriers within the measured footer seam', () => {
  const f = repeatedRuleTail(1)
  expect(
    recoverOwnedTableCrop(f.table, f.rules, f.pageSize, f.items, f.paint, f.graphics, f.fonts)
  ).toEqual([36, 44, 176.2, 130])
  expect(recoverOwnedTableCrop(f.table, f.rules, f.pageSize, f.items, f.paint)).toEqual(
    f.table.cropRect
  )
})

it.each([
  'rotation',
  'invalid rotation',
  'clipped',
  'invalid clipped',
  'parts',
  'invalid parts',
  'notes',
  'invalid notes'
])('refuses horizontal carrier completion for product context: %s', (guard) => {
  const f = repeatedRuleTail()
  if (guard === 'rotation') f.table.readingRotation = 90
  if (guard === 'invalid rotation') f.table.readingRotation = NaN
  if (guard === 'clipped') f.table.clipped = ['Cut font']
  if (guard === 'invalid clipped') f.table.clipped = null
  if (guard === 'parts') f.table.parts = [{}]
  if (guard === 'invalid parts') f.table.parts = { length: 0 }
  if (guard === 'notes') f.table.notes = ['Existing note']
  if (guard === 'invalid notes') f.table.notes = null
  expect(completeTail(f)).toBeUndefined()
  expect(
    recoverOwnedTableCrop(f.table, f.rules, f.pageSize, f.items, f.paint, f.graphics, f.fonts)
  ).toEqual(f.table.cropRect)
})

it.each([
  'missing fonts',
  'missing graphics',
  'foreign font',
  'crossing font',
  'unknown paint',
  'foreign paint',
  'missing rule',
  'missing paint',
  'wrong footer',
  'wrong endpoint',
  'duplicate owner',
  'unassigned',
  'span',
  'incomplete leaf',
  'extra rules'
])('refuses horizontal carrier completion without complete source ownership: %s', (guard) => {
  const f = repeatedRuleTail()
  if (guard === 'missing fonts') f.fonts = []
  if (guard === 'missing graphics') f.graphics = []
  if (guard === 'foreign font' || guard === 'crossing font')
    f.fonts.push({
      text: 'Adjacent',
      rect: [guard === 'crossing font' ? 165 : 169, 81, 176, 91],
      height: 10,
      baseline: 91,
      fontDescent: -0.2,
      horizontal: true
    })
  if (guard === 'unknown paint') f.graphics[0].kind = 'image'
  if (guard === 'foreign paint') f.graphics.push({ kind: 'path', rect: [170, 80, 176, 85] })
  if (guard === 'missing rule') f.rules.pop()
  if (guard === 'missing paint') f.paint.delete(f.rules[0].join(','))
  if (guard === 'wrong footer' || guard === 'wrong endpoint') {
    const r = f.rules.at(-1),
      p = f.paint.get(r.join(','))
    f.paint.delete(r.join(','))
    if (guard === 'wrong footer') r[0] -= 3
    else r[2] += 3
    f.paint.set(r.join(','), p)
  }
  if (guard === 'duplicate owner')
    f.table.cells[1].sourceTokens[0] = structuredClone(f.table.cells[0].sourceTokens[0])
  if (guard === 'unassigned') f.table.unassigned.push('Foreign')
  if (guard === 'span') f.table.cells[1].colSpan = 2
  if (guard === 'incomplete leaf') f.table.cells[1].text = ''
  if (guard === 'extra rules') while (f.rules.length <= 81) f.rules.push([...f.rules[0]])
  expect(completeTail(f)).toBeUndefined()
  expect(
    recoverOwnedTableCrop(f.table, f.rules, f.pageSize, f.items, f.paint, f.graphics, f.fonts)
  ).toEqual(f.table.cropRect)
})

it.each([
  'null rule',
  'null row',
  'null cell',
  'missing token rect',
  'nonfinite token rect',
  'null item',
  'nested graphic',
  'null font',
  'invalid paint'
])('safely refuses malformed horizontal carrier qualification: %s', (guard) => {
  const f = repeatedRuleTail()
  if (guard === 'null rule') f.rules[0] = null
  if (guard === 'null row') f.table.grid[0] = null
  if (guard === 'null cell') f.table.cells[0] = null
  if (guard === 'missing token rect') delete f.table.cells[0].sourceTokens[0].rect
  if (guard === 'nonfinite token rect') f.table.cells[0].sourceTokens[0].rect[0] = NaN
  if (guard === 'null item') f.items[0] = null
  if (guard === 'nested graphic') f.graphics[0].rect[0] = []
  if (guard === 'null font') f.fonts[0] = null
  if (guard === 'invalid paint') f.paint.set(f.rules[0].join(','), [null, 0, 1, 2])
  expect(() => completeTail(f)).not.toThrow()
  expect(completeTail(f)).toBeUndefined()
})
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/owned-headers-outside-detector-crop.jsonl'
    )
  )

it.each([0, 1])('includes recovered header glyphs and the native border: %s', (index) => {
  const { table, rules } = fixture().cases[index]
  const original = structuredClone(table)
  const crop = recoverOwnedTableCrop(table, rules)
  const source = table.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects)
  expect(crop[1]).toBeLessThan(Math.min(...source.map((r: number[]) => r[1])))
  expect(crop[2]).toBeGreaterThan(Math.max(...source.map((r: number[]) => r[2])))
  const top = tableCaptionCropTop({ ...table, cropRect: crop }, crop[1] - 10, rules)
  expect(top).toBeLessThan(Math.min(...source.map((r: number[]) => r[1])))
  expect(table).toEqual(original)
  expect(recoverOwnedTableCrop({ ...table, cropRect: crop }, rules)).toEqual(crop)
})

it.each(['unassigned', 'missing rule', 'short rule', 'distant rule', 'distant text'])(
  'keeps uncertain crop bounds: %s',
  (guard) => {
    const { table, rules } = fixture().cases[0]
    let evidence = rules
    if (guard === 'unassigned') table.unassigned = ['Uncertain']
    if (guard === 'missing rule') evidence = []
    if (guard === 'short rule') evidence = rules.map((r: number[]) => [r[0], r[1], r[0] + 40, r[3]])
    if (guard === 'distant rule')
      evidence = rules.map((r: number[]) => [r[0], r[1] + 100, r[2], r[3] + 100])
    if (guard === 'distant text') table.cells[2].sourceRects[0][2] += 200
    expect(recoverOwnedTableCrop(table, evidence)).toEqual(table.cropRect)
  }
)

it('keeps padding and rounded native borders within the source page', () => {
  const { table, rules } = fixture().cases[0]
  table.cropRect[1] -= 79
  table.cropRect[3] -= 79
  for (const cell of table.cells)
    for (const r of cell.sourceRects) {
      r[1] -= 79
      r[3] -= 79
    }
  for (const r of rules) {
    r[1] -= 79
    r[3] -= 79
  }
  const crop = recoverOwnedTableCrop(table, rules, [820, 1000])
  expect(crop[1]).toBe(0)
  expect(crop[2]).toBe(820)
})

const framedFixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/segmented-outer-frame-outside-detector-crop.jsonl'
    )
  )

it('includes both segmented native side borders when all table glyphs already fit', () => {
  const { table, rules, items } = framedFixture()
  const original = structuredClone(table)
  const crop = recoverOwnedTableCrop(table, rules, [400, 400], items)
  expect(crop).toEqual([39.5, 96, 280.5, 174])
  expect(table).toEqual(original)
  expect(recoverOwnedTableCrop({ ...table, cropRect: crop }, rules, [400, 400], items)).toEqual(
    crop
  )
})

it('keeps recovered side paint inside the source page', () => {
  const { table, rules, items } = framedFixture()
  expect(recoverOwnedTableCrop(table, rules, [280, 400], items)).toEqual([39.5, 96, 280, 174])
})

it.each(['open side', 'missing opening', 'foreign text', 'missing source', 'ambiguous source'])(
  'keeps side bounds without a uniquely owned closed native frame: %s',
  (guard) => {
    const { table, rules, items } = framedFixture()
    let evidence = rules
    if (guard === 'open side')
      evidence = rules.filter((r: number[]) => r.join(',') !== '40,120.4,40,139.6')
    if (guard === 'missing opening') evidence = rules.filter((r: number[]) => r[1] !== 100)
    if (guard === 'foreign text') items.push({ text: 'Adjacent', rect: [274, 126, 279, 136] })
    if (guard === 'missing source') items.shift()
    if (guard === 'ambiguous source') items.push(structuredClone(items[0]))
    expect(recoverOwnedTableCrop(table, evidence, [400, 400], items)).toEqual(table.cropRect)
  }
)
