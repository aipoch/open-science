import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

const { populateTableCellText } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-text.mjs')).href
)

const fixture = (): ReturnType<typeof JSON.parse> => {
  const x = readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-nested-script-owner-change.jsonl'
    )
  )
  return { ...x, pageItems: x.items, issues: new Set(), repairs: [] }
}

it('preserves a nested script when its intermediate anchor changes cell ownership', () => {
  const x = fixture(),
    before = JSON.stringify(x.items)
  expect(populateTableCellText(x)).toEqual([])
  expect(x.cells.map((cell: { text: string }) => cell.text.replace(/\s/g, ''))).toEqual([
    'ga−b',
    '3'
  ])
  expect(x.issues.has('ambiguous-script-anchor')).toBe(true)
  expect(x.cells.flatMap((cell: { sourceRects: number[][] }) => cell.sourceRects).sort()).toEqual(
    x.items.map((item: { rect: number[] }) => item.rect).sort()
  )
  expect(JSON.stringify(x.items)).toBe(before)
})

it('retains script positioning when the complete chain belongs to one cell', () => {
  const x = fixture()
  x.cells = [{ ...x.cells[0], rect: [0.863, 0, 77.211, 50], items: [] }]
  x.rows = [{ rect: [0.863, 0, 77.211, 50] }]
  expect(populateTableCellText(x)).toEqual([])
  expect(x.cells[0].text.replace(/\s/g, '')).toBe('ga−b3')
  expect(x.cells[0].textRuns.at(-1)).toEqual({ text: '3', position: 'superscript' })
  expect(x.issues.has('ambiguous-script-anchor')).toBe(false)
})

it.each([32.01, 33.5])(
  'keeps a right parenthesized superscript at x=%s after its mathematical base',
  (left) => {
    const x = fixture()
    x.items = [
      { text: 'B', rect: [20, 20, 32, 36], baseline: 36, height: 16, horizontal: true },
      {
        text: '(4)',
        rect: [left, 15.6, left + 16, 27.6],
        baseline: 27.6,
        height: 12,
        horizontal: true
      },
      { text: 'q', rect: [32.01, 26.1, 38, 38.1], baseline: 38.1, height: 12, horizontal: true }
    ]
    x.pageItems = x.items
    x.cells = [{ ...x.cells[0], rect: [0, 0, 80, 50], items: [] }]
    x.rows = [{ rect: [0, 0, 80, 50] }]
    expect(populateTableCellText(x)).toEqual([])
    expect(x.cells[0].textRuns[0]).toEqual({ text: 'B', position: 'normal' })
    expect(x.cells[0].textRuns).toHaveLength(3)
    expect(x.cells[0].textRuns).toEqual(
      expect.arrayContaining([
        { text: 'B', position: 'normal' },
        { text: '(4)', position: 'superscript' },
        { text: 'q', position: 'subscript' }
      ])
    )
  }
)

it('keeps detached parenthesized text as an independent line', () => {
  const x = fixture()
  x.items = [
    { text: 'B', rect: [20, 20, 32, 36], baseline: 36, height: 16, horizontal: true },
    { text: '(4)', rect: [42, 15.6, 58, 27.6], baseline: 27.6, height: 12, horizontal: true }
  ]
  x.pageItems = x.items
  x.cells = [{ ...x.cells[0], rect: [0, 0, 80, 50], items: [] }]
  x.rows = [{ rect: [0, 0, 80, 50] }]
  populateTableCellText(x)
  expect(x.cells[0].text).toBe('(4) B')
  expect(x.cells[0].textRuns).toBeUndefined()
})
