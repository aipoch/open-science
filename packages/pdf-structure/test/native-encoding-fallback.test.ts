import { describe, expect, it } from 'vitest'
import {
  encodedControlImageOnlyTable,
  nativeOwnedControlGlyphs
} from '../resources/literature-pdf-table-regions.mjs'

type Fixture = {
  glyphs: Array<{
    text: string
    rect: number[]
    height: number
    baseline: number
    horizontal: boolean
    sourceItem?: { pageNumber: number; index: number; text: string }
  }>
  rules: number[][]
  source: {
    items: Array<{
      str: string
      width: number
      height: number
      sourceItem: { pageNumber: number; index: number; text: string }
    }>
  }
  table: {
    id: string
    page: number
    cropRect: number[]
    caption: Record<string, unknown>
    notes: unknown[]
    sourceViewport: Record<string, number>
    grid: string[][]
    cells: Array<{
      row: number
      column: number
      text: string
      sourceRects: number[][]
      [key: string]: unknown
    }>
    issues: string[]
    parts?: unknown[]
  }
}

const fixture = (): Fixture => {
  const glyph = {
    text: '\u0000',
    rect: [110, 70, 115, 80],
    height: 10,
    baseline: 80,
    horizontal: true,
    sourceItem: { pageNumber: 1, index: 3, text: '\u0000' }
  }
  return {
    glyphs: [
      glyph,
      { text: 'Measure', rect: [20, 20, 80, 30], baseline: 30, height: 10, horizontal: true },
      { text: 'Setting', rect: [130, 20, 180, 30], baseline: 30, height: 10, horizontal: true }
    ],
    rules: [
      [10, 15, 212, 15],
      [10, 50, 212, 50],
      [10, 100, 212, 100]
    ],
    source: {
      items: [{ str: '\u0000', width: 5, height: 10, sourceItem: glyph.sourceItem }]
    },
    table: {
      id: 'anonymous-table',
      page: 1,
      cropRect: [10, 10, 210, 110],
      caption: { text: 'Table 1: Measurements', rect: [10, 120, 210, 130] },
      notes: [{ text: 'A note.', rect: [10, 135, 210, 145] }],
      sourceViewport: { width: 300, height: 400, scale: 1.5 },
      grid: [
        ['Measure', 'Setting'],
        ['a', '\u0000']
      ],
      cells: [
        { row: 0, column: 0, text: 'Measure', sourceRects: [[20, 20, 80, 30]] },
        { row: 1, column: 1, text: '\u0000', sourceRects: [glyph.rect] },
        { row: 0, column: 1, text: 'Setting', sourceRects: [[130, 20, 180, 30]] }
      ],
      issues: []
    }
  }
}

describe('native encoding fallback', () => {
  it('refuses only the untrustworthy cell grid while preserving visual metadata', () => {
    const f = fixture(),
      before = structuredClone(f)
    const out = encodedControlImageOnlyTable(f.table, f.glyphs, f.source, f.rules)
    expect(nativeOwnedControlGlyphs(f.table, f.glyphs, f.source, f.rules)).toHaveLength(1)
    expect(out).toMatchObject({
      id: f.table.id,
      page: f.table.page,
      caption: f.table.caption,
      notes: f.table.notes,
      sourceViewport: f.table.sourceViewport,
      cropRect: f.table.cropRect,
      grid: [],
      cells: [],
      unassigned: [],
      issues: ['no-source-cell-grid']
    })
    expect(f).toEqual(before)
  })

  it.each([
    [
      'control in header',
      (f: ReturnType<typeof fixture>) => {
        f.table.cells[1].row = 0
      }
    ],
    [
      'unowned control',
      (f: ReturnType<typeof fixture>) => {
        f.table.cells[1].sourceRects = []
      }
    ],
    [
      'duplicate owner',
      (f: ReturnType<typeof fixture>) => {
        f.table.cells.push(structuredClone(f.table.cells[1]))
      }
    ],
    [
      'missing header boundary',
      (f: ReturnType<typeof fixture>) => {
        f.rules = f.rules.filter((r) => r[1] !== 50)
      }
    ],
    [
      'control on body boundary',
      (f: ReturnType<typeof fixture>) => {
        f.glyphs[0].baseline = 100
      }
    ],
    [
      'glyph barely crossing the header fence',
      (f: ReturnType<typeof fixture>) => {
        f.glyphs[0].rect = [110, 45, 115, 55]
        f.glyphs[0].baseline = 52
        f.table.cells[1].sourceRects = [f.glyphs[0].rect]
      }
    ],
    [
      'wrong page provenance',
      (f: Fixture) => {
        f.glyphs[0].sourceItem!.pageNumber = 2
      }
    ],
    [
      'stale repaired glyph text',
      (f: Fixture) => {
        f.glyphs[0].text = 'x'
      }
    ],
    [
      'no original item',
      (f: Fixture) => {
        f.source.items = []
      }
    ],
    [
      'zero source advance',
      (f: Fixture) => {
        f.source.items[0].width = 0
      }
    ],
    [
      'multipart output',
      (f: Fixture) => {
        f.table.parts = []
      }
    ],
    [
      'legal umlaut',
      (f: Fixture) => {
        f.glyphs[0].text = f.glyphs[0].sourceItem!.text = f.source.items[0].str = 'Ää'
      }
    ],
    [
      'ordinary script',
      (f: Fixture) => {
        f.glyphs[0].text = f.glyphs[0].sourceItem!.text = f.source.items[0].str = 'x²'
      }
    ],
    [
      'supported fraction',
      (f: Fixture) => {
        f.glyphs[0].text = f.glyphs[0].sourceItem!.text = f.source.items[0].str = '1/2'
      }
    ],
    [
      'layout whitespace',
      (f: Fixture) => {
        f.glyphs[0].text = f.glyphs[0].sourceItem!.text = f.source.items[0].str = '\t\n\r'
      }
    ]
  ])('does not downgrade on %s', (_name, mutate) => {
    const f = fixture()
    mutate(f)
    expect(encodedControlImageOnlyTable(f.table, f.glyphs, f.source, f.rules)).toBeUndefined()
  })

  it('accepts native rules that extend slightly beyond the final crop', () => {
    const f = fixture()
    expect(f.rules[0][2]).toBeGreaterThan(f.table.cropRect[2])
    expect(encodedControlImageOnlyTable(f.table, f.glyphs, f.source, f.rules)).toBeDefined()
  })
})
