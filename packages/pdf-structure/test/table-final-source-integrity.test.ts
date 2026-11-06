/* eslint-disable @typescript-eslint/explicit-function-return-type -- inferred anonymous fixture shapes */
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { tableTextToken: panelTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { collectTableRules: panelRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const {
  nativeTableSourceConflicts,
  reviewNativeTableSources,
  reviewFinalNativeTableSources,
  trimNativeTablePageCounterCrop
} = await import(pathToFileURL(resolve('resources/literature-pdf-table-source-integrity.mjs')).href)
type Font = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
  sourceItem: { pageNumber: number; index: number; text: string }
}
const font = (text: string, x: number, y: number, index: number, width = 20): Font => ({
  text,
  rect: [x, y, x + width, y + 10],
  baseline: y + 10,
  height: 10,
  horizontal: true,
  sourceItem: { pageNumber: 1, index, text }
})
const cell = (row: number, column: number, fonts: Font[]) => ({
  row,
  column,
  rowSpan: 1,
  colSpan: 1,
  text: fonts.map((f) => f.text).join(' '),
  sourceRects: fonts.map((f) => f.rect),
  sourceItems: fonts.map((f) => f.sourceItem)
})
function table(cells: ReturnType<typeof cell>[], unassigned: string[] = []) {
  const grid = Array.from({ length: Math.max(...cells.map((c) => c.row)) + 1 }, () =>
    Array(Math.max(...cells.map((c) => c.column)) + 1).fill('')
  )
  cells.forEach((c) => {
    grid[c.row][c.column] = c.text
  })
  return { cropRect: [0, 0, 300, 190], grid, cells, unassigned, issues: [] }
}

function incompatibleNativeScripts() {
  const fonts = [font('N', 10, 40, 0, 8), font('IR', 19, 39, 1, 8), font('Q', 18, 46, 2, 6)].map(
    (f, index) => ({
      ...f,
      height: index ? 7 : 10,
      rect: [f.rect[0], f.rect[1], f.rect[2], f.rect[1] + (index ? 7 : 10)],
      baseline: f.rect[1] + (index ? 7 : 10),
      fontAscent: 0.8,
      fontDescent: -0.2
    })
  )
  const source = {
    ...table([cell(0, 0, fonts)]),
    page: 1,
    cells: [
      {
        ...cell(0, 0, fonts),
        text: 'NQIR',
        textRuns: [
          { text: 'N', position: 'normal' },
          { text: ' IR', position: 'superscript' },
          { text: ' Q', position: 'subscript' }
        ]
      }
    ]
  }
  source.grid[0][0] = source.cells[0].text
  const context = {
    sourcePage: { pageNumber: 1 },
    viewport: {
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 200],
      convertToViewportPoint: (x: number, y: number) => [x, 200 - y]
    },
    sourceContent: {
      styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } },
      items: fonts.map((f) => ({
        str: f.text,
        sourceItem: f.sourceItem,
        fontName: 'F',
        dir: 'ltr',
        width: f.rect[2] - f.rect[0],
        height: f.height,
        transform: [f.height, 0, 0, f.height, f.rect[0], 200 - f.baseline]
      }))
    }
  }
  return { source, fonts, context }
}

it('retains native math owners and suspends mapping when whole-cell projections disagree', () => {
  const { source, fonts, context } = incompatibleNativeScripts(),
    before = JSON.stringify(source)
  const result = reviewFinalNativeTableSources(source, fonts, [], [], context)
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.cells[0]).not.toHaveProperty('textRuns')
  expect(result.cells[0].text).toBe('NQIR')
  expect(result.cells[0].sourceItems).toBe(source.cells[0].sourceItems)
  expect(result.cells[0].sourceRects).toBe(source.cells[0].sourceRects)
  expect(result.grid).toBe(source.grid)
  expect(result.cropRect).toBe(source.cropRect)
  expect(result.unreliableMathSourceItems).toEqual(fonts.map((f) => f.sourceItem))
  expect(JSON.stringify(source)).toBe(before)
})

it.each(['native text', 'duplicate owner', 'font metrics', 'source rectangle'])(
  'does not suppress formatting without closed native math evidence: %s',
  (reason) => {
    const { source, fonts, context } = incompatibleNativeScripts()
    if (reason === 'native text') context.sourceContent.items[0].str = 'Other'
    if (reason === 'duplicate owner') fonts.push({ ...fonts[0] })
    if (reason === 'font metrics') context.sourceContent.styles.F.ascent = 0.7
    if (reason === 'source rectangle') source.cells[0].sourceRects[0] = [10, 40, 19, 50]
    const result = reviewFinalNativeTableSources(source, fonts, [], [], context)
    expect(result.cells[0].textRuns).toBe(source.cells[0].textRuns)
    expect(result.unreliableMathSourceItems).toBeUndefined()
  }
)

it('keeps a consistent mathematical projection unchanged', () => {
  const { source, fonts, context } = incompatibleNativeScripts()
  source.cells[0].text = source.cells[0].textRuns.map((run) => run.text).join('')
  source.grid[0][0] = source.cells[0].text
  const result = reviewFinalNativeTableSources(source, fonts, [], [], context)
  expect(result.cells).toBe(source.cells)
  expect(result.unreliableMathSourceItems).toBeUndefined()
})

function mathematicalCellWithRepeatedFolio() {
  const fonts = [
    font('x=1', 20, 40, 0),
    font('y=2', 20, 70, 1),
    font('z=3', 20, 100, 2),
    font('1', 148, 178, 3, 4)
  ].map((f) => ({ ...f, fontAscent: 0.8, fontDescent: -0.2 }))
  const source = {
    ...table(fonts.map((f, row) => cell(row, 0, [f]))),
    page: 1,
    cropRect: [0, 0, 300, 200]
  }
  const context = {
    sourcePage: { pageNumber: 1 },
    viewport: {
      rotation: 0,
      width: 300,
      height: 200,
      transform: [1, 0, 0, -1, 0, 200],
      convertToViewportPoint: (x: number, y: number) => [x, 200 - y]
    },
    sourceContent: {
      styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } },
      items: fonts.map((f) => ({
        str: f.text,
        sourceItem: f.sourceItem,
        fontName: 'F',
        dir: 'ltr',
        width: f.rect[2] - f.rect[0],
        height: f.height,
        transform: [f.height, 0, 0, f.height, f.rect[0], 200 - f.baseline]
      }))
    },
    nativeFolioPages: [2, 3].map((pageNumber) => ({
      pageNumber,
      width: 300,
      height: 200,
      lines: [
        { text: 'Independent body', x: 20, y: 40, width: 50, height: 10, fontSize: 10 },
        { text: String(pageNumber), x: 148, y: 178, width: 4, height: 10, fontSize: 10 }
      ]
    }))
  }
  return { source, fonts, context }
}

it('vetoes a native mathematical grid consuming a separately repeated page counter', () => {
  const { source, fonts, context } = mathematicalCellWithRepeatedFolio(),
    before = JSON.stringify(source)
  const result = reviewFinalNativeTableSources(source, fonts, [], [], context)
  expect(result.issues).toEqual(['native-table-structure-ambiguous'])
  expect(result.cells).toBe(source.cells)
  expect(result.grid).toBe(source.grid)
  expect(result.cropRect).toBe(source.cropRect)
  expect(result.unreliableMathSourceItems).toBeUndefined()
  expect(JSON.stringify(source)).toBe(before)
})

it.each([
  'single peer',
  'peer text',
  'peer position',
  'unknown peer line',
  'native counter',
  'ordinary records',
  'closing rule'
])('does not infer a page-counter contradiction from %s', (reason) => {
  const { source, fonts, context } = mathematicalCellWithRepeatedFolio()
  const rules: number[][] = []
  if (reason === 'single peer') context.nativeFolioPages.pop()
  if (reason === 'peer text') context.nativeFolioPages[0].lines[1].text = 'Other'
  if (reason === 'peer position') context.nativeFolioPages[0].lines[1].y = 170
  if (reason === 'unknown peer line') context.nativeFolioPages[0].lines[0].height = NaN
  if (reason === 'native counter') context.sourceContent.items[3].str = '2'
  if (reason === 'ordinary records') fonts[0].text = 'Measured records'
  if (reason === 'closing rule') rules.push([0, 180, 300, 180])
  const result = reviewFinalNativeTableSources(source, fonts, rules, [], context)
  expect(result).toBe(source)
})
it.each(['left', 'right'])(
  'isolates a complete native owner clipped by the final %s crop edge',
  (edge) => {
    const f = font('Native label', edge === 'left' ? 0 : 100, 30, 0, 40)
    const bad = { ...table([cell(0, 0, [f])]), cropRect: [20, 0, 120, 100] }
    const goodFont = font('Independent value', 70, 60, 1)
    const good = table([cell(0, 0, [goodFont])])
    const input = { cropRect: [0, 0, 300, 190], parts: [bad, good], thumbnail: 'original.png' }
    const before = JSON.stringify(input)
    const result = reviewFinalNativeTableSources(input, [f, goodFont], [])
    expect(result.parts[0].issues).toEqual(['native-table-structure-ambiguous'])
    expect(result.parts[0].cells).toBe(bad.cells)
    expect(result.parts[0].grid).toBe(bad.grid)
    expect(result.parts[0].cropRect).toBe(bad.cropRect)
    expect(result.parts[1]).toBe(good)
    expect(result.thumbnail).toBe(input.thumbnail)
    expect(JSON.stringify(input)).toBe(before)
  }
)
it.each([
  'small overhang',
  'measured segment',
  'wrong rectangle',
  'duplicate native',
  'wrong text'
])('does not infer clipped whole ownership from %s', (reason) => {
  const f = font('Native label', 0, 30, 0, 40)
  const c = cell(0, 0, [f])
  const t = { ...table([c]), cropRect: [20, 0, 120, 100] }
  const inventory = [f]
  if (reason === 'small overhang') t.cropRect[0] = 5
  if (reason === 'measured segment') {
    const measured = {
      ...t,
      cells: [
        {
          ...c,
          text: 'label',
          sourceItems: undefined,
          sourceRects: [[25, 30, 40, 40]],
          sourceSegments: [{ ...f.sourceItem, start: 7, end: 12, rect: [25, 30, 40, 40] }]
        }
      ]
    }
    expect(reviewFinalNativeTableSources(measured, inventory, [])).toBe(measured)
    return
  }
  if (reason === 'wrong rectangle') c.sourceRects = [[20, 30, 40, 40]]
  if (reason === 'duplicate native') inventory.push({ ...f })
  if (reason === 'wrong text') f.text = 'Other text'
  expect(reviewFinalNativeTableSources(t, inventory, [])).toBe(t)
})
it('isolates a final native contradiction to its table part and preserves original sources', () => {
  const fonts = [0, 1, 2, 3].flatMap((r) => [
    font(String(r), 10, 20 + r * 25, r * 2),
    font('value', 70, 20 + r * 25, r * 2 + 1)
  ])
  const collapsed = table([0, 1, 2, 3].map((r) => cell(r, 0, fonts.slice(r * 2, r * 2 + 2))))
  const valid = table(fonts.map((f, i) => cell(Math.floor(i / 2), i % 2, [f])))
  const part = { cells: collapsed.cells, grid: collapsed.grid, issues: collapsed.issues }
  const input = { cropRect: collapsed.cropRect, parts: [part, valid], thumbnail: 'original.png' }
  const checked = reviewFinalNativeTableSources(input, fonts, [[50, 15, 50, 110]])
  expect(checked.parts[0].issues).toEqual(['native-table-structure-ambiguous'])
  expect(checked.parts[0].cells).toBe(part.cells)
  expect(checked.parts[0]).not.toHaveProperty('cropRect')
  expect(checked.parts[1]).toBe(valid)
  expect(checked.thumbnail).toBe(input.thumbnail)
  expect(input.parts[0].issues).toEqual([])
})
it('distinguishes an omitted printed header from an unrelated trailing note', () => {
  const a = font('Name', 10, 10, 0),
    b = font('Value', 100, 10, 1),
    data = [font('A', 10, 40, 2), font('12', 100, 40, 3)],
    tail = font('Note', 10, 90, 4)
  const t = table(
    [cell(0, 0, [a]), cell(0, 1, []), cell(1, 0, [data[0]]), cell(1, 1, [data[1]])],
    ['Value', 'Note']
  )
  expect(nativeTableSourceConflicts(t, [a, b, ...data, tail])).toContain(
    'unassigned-printed-header'
  )
  expect(nativeTableSourceConflicts({ ...t, unassigned: ['Note'] }, [a, ...data, tail])).toEqual([])
  // A title above fully owned headers does not contradict any leaf column.
  const complete = { ...t, cells: [cell(0, 0, [a]), cell(0, 1, [b]), ...t.cells.slice(2)] }
  const title = font('Independent section heading', 10, 0, 5, 200)
  expect(
    nativeTableSourceConflicts({ ...complete, unassigned: [title.text] }, [a, b, ...data, title])
  ).toEqual([])
  // An empty slot alone cannot assign unrelated words to that column.
  const remote = font('Separate heading', 200, 10, 6)
  expect(
    nativeTableSourceConflicts({ ...t, unassigned: [remote.text] }, [a, ...data, remote])
  ).toEqual([])
})
it('does not assign separate pieces of one grouped heading to adjacent leaf columns', () => {
  const a = [font('N', 90, 5, 0, 10), font('Low', 60, 30, 1)],
    b = [font('ABC', 100, 9, 2, 18), font('High', 140, 30, 3)]
  const t = table([cell(0, 0, a), cell(0, 1, b)])
  expect(nativeTableSourceConflicts(t, [...a, ...b])).toContain('header-split-between-columns')
  expect(nativeTableSourceConflicts(t, [...a, ...b, { ...b[0] }])).toEqual([])
})
it('flags an omitted native leaf heading below a grouped header', () => {
  const omitted = font('Name Type', 10, 25, 0, 80),
    first = font('First', 120, 25, 1),
    second = font('Second', 200, 25, 2),
    one = font('A', 10, 55, 3),
    two = font('B', 10, 80, 4)
  const cells = [
    cell(0, 0, []),
    cell(1, 0, []),
    cell(1, 1, [first]),
    cell(1, 2, [second]),
    cell(2, 0, [one]),
    cell(3, 0, [two])
  ]
  const t = table(cells, [omitted.text])
  expect(nativeTableSourceConflicts(t, [omitted, first, second, one, two])).toContain(
    'unassigned-printed-header'
  )
  expect(nativeTableSourceConflicts(t, [omitted, first, one, two])).toEqual([])
})
it('recognizes a wholly omitted header row only with independent aligned body columns', () => {
  const heads = [font('Left', 10, 10, 0, 35), font('Right', 100, 10, 1, 35)],
    values = [
      font('A', 10, 40, 2),
      font('12', 100, 40, 3),
      font('B', 10, 70, 4),
      font('24', 100, 70, 5)
    ]
  const t = table(
    values.map((f, i) => cell(Math.floor(i / 2), i % 2, [f])),
    heads.map((f) => f.text)
  )
  expect(nativeTableSourceConflicts(t, [...heads, ...values])).toContain(
    'unassigned-printed-header'
  )
  expect(nativeTableSourceConflicts(t, [heads[0], ...values])).toEqual([])
  const note = font('Note spans both columns', 10, 10, 7, 125)
  expect(nativeTableSourceConflicts({ ...t, unassigned: [note.text] }, [note, ...values])).toEqual(
    []
  )
})
it('recognizes a repeated separate numeric leaf lane but not a prose suffix', () => {
  const rows = [
    ['Description', '§'],
    ['One', '1'],
    ['Two', '2'],
    ['Three', '3']
  ]
  const fonts = rows.flatMap(([label, n], r) => [
    font(label, 10, r * 30, r * 2, 40),
    font(n, 120, r * 30, r * 2 + 1, 7)
  ])
  const t = table(rows.map((_, r) => cell(r, 0, fonts.slice(r * 2, r * 2 + 2))))
  expect(nativeTableSourceConflicts(t, fonts)).toContain('independent-terminal-column')
  expect(nativeTableSourceConflicts({ ...t, cells: t.cells.slice(0, 2) }, fonts)).toEqual([])
})
it('rejects independent numeric records collapsed across aligned leaf columns', () => {
  const fonts = [0, 1, 2].flatMap((column) => [
    font('12.5', 20 + column * 80, 30, column * 2),
    font('24.1', 20 + column * 80, 50, column * 2 + 1)
  ])
  const cells = [0, 1, 2].map((column) => cell(1, column, fonts.slice(column * 2, column * 2 + 2)))
  const input = table(cells)
  expect(reviewNativeTableSources(input, fonts)).toBe(input)
  expect(nativeTableSourceConflicts(table(cells), fonts)).toContain('collapsed-numeric-records')
  expect(reviewFinalNativeTableSources(table(cells), fonts, []).issues).toContain(
    'native-table-structure-ambiguous'
  )
  // Two multiline values alone do not establish independent records.
  expect(nativeTableSourceConflicts(table(cells.slice(0, 2)), fonts)).toEqual([])
  const prose = fonts.map((f) => ({
    ...f,
    text: 'wrapped text',
    sourceItem: { ...f.sourceItem, text: 'wrapped text' }
  }))
  expect(
    nativeTableSourceConflicts(
      table([0, 1, 2].map((column) => cell(1, column, prose.slice(column * 2, column * 2 + 2)))),
      prose
    )
  ).toEqual([])
  const staggered = fonts.map((f, i) => ({ ...f, baseline: f.baseline + Math.floor(i / 2) * 5 }))
  expect(nativeTableSourceConflicts(table(cells), staggered)).toEqual([])
})
it('joins only adjacent same-baseline native fragments when checking collapsed numeric records', () => {
  const fonts = [0, 1, 2].flatMap((column) => [
    font('−', 10 + column * 80, 30, column * 4, 5),
    font('2.5', 15 + column * 80, 30, column * 4 + 1, 15),
    font('4', 15 + column * 80, 50, column * 4 + 2, 5),
    font('.1', 20 + column * 80, 50, column * 4 + 3, 10)
  ])
  const cells = [0, 1, 2].map((column) => cell(1, column, fonts.slice(column * 4, column * 4 + 4)))
  expect(nativeTableSourceConflicts(table(cells), fonts)).toContain('collapsed-numeric-records')
  expect(nativeTableSourceConflicts(table(cells), [...fonts, { ...fonts[0] }])).toEqual([])
  const scripted = fonts.map((f, i) => (i % 4 === 3 ? { ...f, height: 4 } : f))
  expect(nativeTableSourceConflicts(table(cells), scripted)).toEqual([])
})
it('flags repeated tail lines that precede the next top-aligned record', () => {
  const fonts: Font[] = [],
    cells: ReturnType<typeof cell>[] = []
  for (let r = 0; r < 4; r++) {
    const stub = font('Row', 10, r * 40, fonts.length)
    fonts.push(stub)
    cells.push(cell(r, 0, [stub]))
    const value = font('Body', 100, r * 40, fonts.length)
    fonts.push(value)
    const owned = [value]
    if (r > 1) {
      const tail = font('tail)', 100, r * 40 - 17, fonts.length)
      fonts.push(tail)
      owned.unshift(tail)
    }
    cells.push(cell(r, 1, owned))
  }
  expect(nativeTableSourceConflicts(table(cells), fonts)).toContain(
    'body-line-crosses-record-start'
  )
  expect(nativeTableSourceConflicts(table(cells.slice(0, 6)), fonts)).toEqual([])
})
it('retains a wide native heading as uncertain when the adjacent heading is only a marker', () => {
  const fonts = [
    font('First Second', 10, 5, 0, 130),
    font('†', 145, 5, 1, 5),
    font('10', 20, 40, 2),
    font('20', 100, 40, 3),
    font('30', 20, 70, 4),
    font('40', 100, 70, 5)
  ]
  const t = table(fonts.map((f, n) => cell(Math.floor(n / 2), n % 2, [f])))
  expect(nativeTableSourceConflicts(t, fonts)).toContain('header-crosses-independent-column')
})
it('trims only a proven page counter below a closing rule, retaining the final table row', () => {
  const last = [font('Final', 10, 154, 0), font('42', 250, 154, 1)],
    folio = font('1/3', 270, 169, 2)
  const t = table([cell(0, 0, [last[0]]), cell(0, 1, [last[1]])]),
    rules = [[5, 170, 295, 170]],
    context = { pageNumber: 1, pageCount: 3, height: 200 }
  const result = trimNativeTablePageCounterCrop(t, [...last, folio], rules, context)
  expect(result.cropRect[3]).toBe(170.5)
  expect(result.cells).toEqual(t.cells)
  const record = font('Another row', 10, 175, 3)
  expect(trimNativeTablePageCounterCrop(t, [...last, folio, record], rules, context)).toBe(t)
})

it.each([
  [
    ['Package.alpha', 'Package.beta'],
    ['initial record meaning', 'another record meaning']
  ],
  [
    ['First record', 'Second record'],
    ['p(S)', 'q(S)'],
    ['|S|≥1', '|S|≥2']
  ]
])('withdraws mappings for repeated native records inside one model row: %j', (...columns) => {
  const fonts = columns.flatMap((values, column) =>
    values.map((text, row) => font(text, 10 + column * 110, 20 + row * 15, column * 2 + row))
  )
  const cells = columns.map((_, column) => cell(1, column, fonts.slice(column * 2, column * 2 + 2)))
  const input = table(cells)
  expect(nativeTableSourceConflicts(input, fonts)).toContain('collapsed-native-records')
  const result = reviewNativeTableSources(input, fonts)
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.grid).toBe(input.grid)
  expect(result.cells).toBe(input.cells)
  const partial = {
    ...input,
    cells: input.cells.map((c, i) => (i ? c : { ...c, sourceRects: c.sourceRects.slice(1) }))
  }
  expect(nativeTableSourceConflicts(partial, fonts)).not.toContain('collapsed-native-records')
})
it.each(['continued label', 'Package.name_', 'plain words'])(
  'does not infer independent records from wrapped or incomplete identifiers: %s',
  (text) => {
    const fonts = [
      font(text, 10, 20, 0),
      font('Package.part', 10, 35, 1),
      font('initial record meaning', 120, 20, 2),
      font('another record meaning', 120, 35, 3)
    ]
    const input = table([cell(1, 0, fonts.slice(0, 2)), cell(1, 1, fonts.slice(2))])
    expect(nativeTableSourceConflicts(input, fonts)).not.toContain('collapsed-native-records')
  }
)

function nativePanelFields(upperColumns = 5): ReturnType<typeof JSON.parse> {
  const width = 260,
    height = 250,
    items: ReturnType<typeof JSON.parse>[] = [],
    cells: ReturnType<typeof JSON.parse>[] = [],
    operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    graphics: ReturnType<typeof JSON.parse>[] = [],
    grid: string[][] = []
  const viewport = {
    width,
    height,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
  }
  const draw = (str: string, x: number, y: number): ReturnType<typeof JSON.parse> => {
    const item = {
      str,
      fontName: 'F',
      dir: 'ltr',
      width: str.length * 5,
      height: 10,
      transform: [10, 0, 0, 10, x, height - y],
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    }
    items.push(item)
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', 10],
      [[1, 0, 0, 1, x, height - y]],
      [Array.from(str, (c) => ({ unicode: c, fontChar: c, width: 500, isInFont: true }))],
      null
    )
    return item
  }
  const claim = (row: number, column: number, fonts: ReturnType<typeof JSON.parse>[]): void => {
    const text = fonts.map((i) => i.str).join(' ')
    if (!grid[row]) grid[row] = ['', '', '']
    grid[row][column] = text
    cells.push({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text,
      sourceItems: fonts.map((i) => i.sourceItem),
      sourceRects: fonts.map((i) => [
        i.transform[4],
        height - i.transform[5] - 10,
        i.transform[4] + i.width,
        height - i.transform[5]
      ])
    })
  }
  for (let c = 0; c < upperColumns; c++)
    draw(String.fromCharCode(65 + c), 30 + (c * 160) / (upperColumns - 1), 65)
  for (let row = 0; row < 2; row++) {
    const fonts = Array.from({ length: upperColumns }, (_, c) =>
      draw(String(11 + row * 10 + c), 30 + (c * 160) / (upperColumns - 1), 95 + row * 20)
    )
    claim(row, 0, [fonts[0]])
    claim(row, 1, fonts.slice(1, -1))
    claim(row, 2, [fonts.at(-1)])
  }
  for (let row = 0; row < 3; row++)
    for (let c = 0; c < 3; c++)
      claim(row + 2, c, [
        draw(
          row === 0 ? ['Kind', 'Rate', 'Flag'][c] : String(31 + row * 10 + c),
          30 + c * 80,
          165 + row * 25
        )
      ])
  for (const y of [40, 75, 125, 150, 175, 225]) {
    const op = operators.fnArray.length,
      rect = [20, y - 0.2, 220, y + 0.2]
    operators.fnArray.push(
      OPS.setStrokeRGBColor,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.constructPath
    )
    operators.argsArray.push(
      ['#000000'],
      [0.4],
      [0],
      [OPS.stroke, [[0, 20, height - y, 1, 220, height - y]], [20, height - y, 220, height - y]]
    )
    graphics.push({ kind: 'path', operationIndex: op + 3, rect })
  }
  const content = { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } },
    bounds = graphics.map((g) => ({
      kind: g.kind,
      operationIndex: g.operationIndex,
      normalizedRect: g.rect.map((n: number, i: number) => n / (i % 2 ? height : width))
    })),
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds: bounds },
    context = {
      sourcePage: page,
      content,
      sourceContent: content,
      viewport,
      nativeGlyphContext: {
        content: structuredClone(content),
        viewport,
        pageNumber: 1,
        sourceSha256: 'f'.repeat(64),
        operators,
        graphicsBounds: bounds,
        skippedSpaceGlyphs: [],
        glyphBounds: [
          {
            fontName: 'F',
            glyphs: [...new Set(items.flatMap((i) => Array.from(i.str)))].map((c) => ({
              fontChar: c,
              bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7]
            }))
          }
        ]
      }
    },
    fonts = items.map((i) => ({
      ...panelTextToken(i, viewport, 0),
      fontAscent: 0.8,
      fontDescent: -0.2
    })),
    rules = panelRules(operators, viewport),
    source = {
      id: 'table',
      page: 1,
      sourceViewport: { width, height, scale: 1 },
      cropRect: [15, 85, 225, 230],
      grid,
      cells,
      issues: [],
      unassigned: [],
      notes: [],
      reviewCandidate: true
    }
  return { table: source, inventory: fonts, rules, context }
}
it('warns for repeated whole fields fused across distinct printed panel schemas without changing owners', () => {
  const f = nativePanelFields(),
    before = structuredClone(f.table),
    r = reviewFinalNativeTableSources(f.table, f.inventory, f.rules, [], f.context)
  expect(r.issues).toEqual(['native-table-structure-ambiguous'])
  expect(r.cells).toBe(f.table.cells)
  expect(r.grid).toBe(f.table.grid)
  expect(r.cropRect).toBe(f.table.cropRect)
  expect(r.reviewCandidate).toBe(false)
  expect(f.table).toEqual(before)
})
it('keeps correctly separated equal-column native panels usable', () => {
  const f = nativePanelFields(3),
    r = reviewFinalNativeTableSources(f.table, f.inventory, f.rules, [], f.context)
  expect(r).toBe(f.table)
})
it('declines panel inference when an original source claim is stale', () => {
  const f = nativePanelFields()
  f.context.sourceContent.items[1].sourceItem.index = 999
  const r = reviewFinalNativeTableSources(f.table, f.inventory, f.rules, [], f.context)
  expect(r.issues).not.toContain('native-table-structure-ambiguous')
})

it('declines a peer panel whose supplied rules differ from the complete native paint', () => {
  const f = nativePanelFields()
  for (const r of f.rules.filter((r: number[]) => r[1] >= 150)) {
    r[0] -= 5
    r[2] += 5
  }
  const reviewed = reviewFinalNativeTableSources(f.table, f.inventory, f.rules, [], f.context)
  expect(reviewed.issues).not.toContain('native-table-structure-ambiguous')
})

// Small native provenance examples: no document text, IDs or recorded outputs.
function finalOwnershipFixture(kind: 'interval' | 'decimal' | 'prose' | 'script') {
  const viewport = {
    width: 400,
    height: 300,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 300],
    convertToViewportPoint: (x: number, y: number) => [x, 300 - y]
  }
  const content = {
    items: [] as Array<{
      str: string
      dir: string
      fontName: string
      width: number
      height: number
      transform: number[]
      sourceItem?: { pageNumber: number; index: number; text: string }
    }>,
    styles: {
      F: { ascent: 0.8, descent: -0.2, vertical: false },
      G: { ascent: 0.7, descent: -0.2, vertical: false }
    }
  }
  const fonts: Font[] = [],
    add = (text: string, x: number, baseline: number, width: number, size = 10, face = 'F') => {
      const index = content.items.length,
        item = {
          str: text,
          dir: 'ltr',
          fontName: face,
          width,
          height: text.trim() ? size : 0,
          transform: [size, 0, 0, size, x, 300 - baseline],
          ...(text.trim() ? { sourceItem: { pageNumber: 1, index, text } } : {})
        }
      content.items.push(item)
      if (!text.trim()) return undefined as unknown as Font
      const f = panelTextToken(item, viewport, 0) as Font
      fonts.push(f)
      return f
    },
    cells: ReturnType<typeof cell>[] = [],
    rules: number[][] = []
  if (kind === 'interval') {
    for (let row = 0; row < 4; row++) {
      const baseline = 25 + row * 20
      cells.push(
        cell(row, 0, [add(row ? `Type ${row}` : 'Family', 20, baseline, 40)]),
        cell(row, 1, [add(row ? `${row}` : 'Bound', 200, baseline, 30)])
      )
    }
    const label = add('Range across', 20, 110, 60)
    add(' ', 80, 110, 4)
    const start = add('[0', 84, 110, 10, 10, 'G'),
      comma = add(',', 94, 110, 3)
    add(' ', 97, 110, 2)
    const end = add('1]', 99, 110, 10, 10, 'G')
    add(' ', 109, 110, 91)
    const relation = add('≤', 200, 110, 8),
      value = add('Ce', 210, 110, 10)
    cells.push(cell(4, 0, [label, start, comma]), cell(4, 1, [end, relation, value]))
  } else if (kind === 'decimal') {
    for (let row = 0; row < 3; row++)
      for (let column = 0; column < 5; column++)
        cells.push(
          cell(row, column, [
            add(row ? `${row + column}` : `H${column}`, 20 + column * 50, 25 + row * 20, 15)
          ])
        )
    const label = add('Shared value:', 20, 100, 70),
      accent = add('^', 94, 100, 4),
      base = add('c', 94, 100, 5),
      sign = add('=', 104, 100, 6),
      integer = add('6', 112, 100, 5),
      dot = add('.', 117, 100, 3, 10, 'G'),
      digits = add('125', 120, 100, 15)
    cells.push(
      cell(3, 0, [label]),
      cell(3, 1, [accent, base, sign, integer, dot]),
      cell(3, 2, [digits]),
      cell(3, 3, []),
      cell(3, 4, [])
    )
    rules.push([10, 85, 290, 85], [10, 115, 290, 115])
  } else if (kind === 'prose') {
    const first = add('An earlier sentence.', 20, 50, 60)
    add(' ', 80, 50, 3)
    const middle = add('A further explanation follows', 83, 50, 130),
      end = add('on the next line', 20, 62, 80),
      number = add('(1.1)', 20, 85, 20),
      formula = add('R = Q', 110, 85, 35)
    cells.push(
      cell(0, 0, [first, end]),
      cell(0, 1, [middle]),
      cell(1, 0, [number]),
      cell(1, 1, [formula])
    )
  } else {
    const base = add('E', 20, 50, 8),
      upper = add('2', 28.4, 45.9, 3.5, 7),
      lower = add('i,j', 28, 52.5, 8, 7),
      relation = add('= −2', 39, 50, 25),
      prose = add('a direct consequence', 20, 67, 120),
      second = add('P = −q', 150, 50, 40),
      third = add('A = 1', 230, 50, 35),
      number = add('(1.2)', 20, 95, 20),
      equation = add('Q = −a', 100, 95, 40),
      sum = add('Σb', 160, 95, 15),
      tail = add('−c', 210, 95, 15)
    cells.push(
      cell(0, 0, [base]),
      cell(0, 1, [upper, lower, relation, prose]),
      cell(0, 2, [second]),
      cell(0, 3, [third]),
      cell(1, 0, [number]),
      cell(1, 1, [equation]),
      cell(1, 2, [sum]),
      cell(1, 3, [tail])
    )
  }
  const source = {
      ...table(cells),
      page: 1,
      sourceViewport: { width: 400, height: 300, scale: 1 }
    },
    context = {
      sourcePage: { pageNumber: 1, width: 400, height: 300, invalidGraphicsBounds: 0 },
      viewport,
      content,
      sourceContent: content,
      nativeGlyphContext: { viewport, content }
    }
  return { source, fonts, content, context, rules }
}

it.each(['interval', 'decimal', 'prose', 'script'] as const)(
  'retains whole native payload while pausing a contradicted model partition: %s',
  (kind) => {
    const f = finalOwnershipFixture(kind),
      before = JSON.stringify(f.source),
      result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).toContain('native-table-structure-ambiguous')
    expect(result.reviewCandidate).toBe(false)
    for (const property of ['cells', 'grid', 'cropRect'])
      expect(result[property]).toBe(f.source[property as 'cells'])
    expect(JSON.stringify(f.source)).toBe(before)
    expect(result.unreliableMathSourceItems).toBeUndefined()
  }
)

it.each([
  'native alias',
  'missing style',
  'partial source',
  'interrupted interval',
  'independent right field',
  'separating rule'
] as const)(
  'declines an interval conflict without complete independent source/lane evidence: %s',
  (reason) => {
    const f = finalOwnershipFixture('interval'),
      tail = f.source.cells.filter((c) => c.row === 4),
      origin = tail[1].sourceItems![0],
      raw = f.content.items[origin.index]
    if (reason === 'native alias')
      f.fonts.push({ ...f.fonts.find((x) => x.sourceItem.index === origin.index)! })
    if (reason === 'missing style') delete (f.content.styles as Record<string, unknown>).G
    if (reason === 'partial source')
      Object.assign(tail[1], { sourceSegments: [{ ...origin, start: 0, end: 1 }] })
    if (reason === 'interrupted interval') f.content.items[origin.index - 1].str = 'unrelated'
    if (reason === 'independent right field') raw.fontName = 'F'
    if (reason === 'separating rule') f.rules.push([98, 90, 98, 125])
    const result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it('keeps a genuine ruled multiline table distinct from prose-flow ambiguity', () => {
  const f = finalOwnershipFixture('prose')
  f.rules.push([82, 35, 82, 75])
  const result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(result.issues).not.toContain('native-table-structure-ambiguous')
})

it('keeps a decimal already owned by one cell unchanged', () => {
  const f = finalOwnershipFixture('decimal'),
    left = f.source.cells.find((c) => c.row === 3 && c.column === 1)!,
    right = f.source.cells.find((c) => c.row === 3 && c.column === 2)!
  left.text += right.text
  left.sourceItems!.push(...right.sourceItems!)
  left.sourceRects.push(...right.sourceRects)
  right.text = ''
  right.sourceItems = []
  right.sourceRects = []
  f.source.grid[3][1] = left.text
  f.source.grid[3][2] = ''
  const result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(result.issues).not.toContain('native-table-structure-ambiguous')
})

it.each([
  'page identity',
  'explicit vertical mode',
  'canonical metrics',
  'unknown foreign geometry',
  'native line metadata',
  'font handle alias'
] as const)(
  'declines whole-source ownership evidence when its native binding changes: %s',
  (reason) => {
    const f = finalOwnershipFixture('interval')
    if (reason === 'page identity') f.source.page = 2
    if (reason === 'explicit vertical mode')
      delete (f.content.styles.G as { vertical?: boolean }).vertical
    if (reason === 'canonical metrics') f.fonts[0].baseline += 1
    if (reason === 'unknown foreign geometry')
      f.fonts.push({ ...font('Other', 310, 220, 999), rect: [NaN, 220, 330, 230] })
    if (reason === 'native line metadata')
      f.context.nativeGlyphContext.content = {
        ...f.content,
        items: f.content.items.map((i) => ({ ...i, hasEOL: true }))
      }
    if (reason === 'font handle alias') {
      f.content.styles.G = { ...f.content.styles.F }
      f.context.nativeGlyphContext.content = {
        ...f.content,
        items: f.content.items.map((i) => ({ ...i, fontName: 'F' }))
      }
    }
    const result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it('binds distinct native font handles without changing any source identity', () => {
  const f = finalOwnershipFixture('interval'),
    before = JSON.stringify(f.source)
  f.context.nativeGlyphContext.content = {
    items: f.content.items.map((i) => ({ ...i, fontName: 'Native' + i.fontName })),
    styles: { NativeF: f.content.styles.F, NativeG: f.content.styles.G }
  } as unknown as typeof f.content
  const result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.cells).toBe(f.source.cells)
  expect(JSON.stringify(f.source)).toBe(before)
})

// Inline, anonymous native records with real text/paint programs, not replayed output.
function finalNativeFlowFixture(
  kind:
    | 'records'
    | 'math'
    | 'collapsed'
    | 'divided'
    | 'folio'
    | 'header'
    | 'omitted'
    | 'relation'
    | 'brackets'
    | 'row-groups'
    | 'header-groups',
  separated = false,
  zeroAdvance: 'none' | 'remote' | 'overlap' | 'alias' = 'none',
  zeroMetric: 'none' | 'remote' | 'selected' | 'overlap' = 'none',
  headerPaint: 'remote' | 'inside' | 'second-frame' = 'remote',
  structureControl:
    | 'none'
    | 'plain-header'
    | 'no-prose'
    | 'no-script'
    | 'no-relation'
    | 'touching-lanes'
    | 'crossing-missing'
    | 'no-boundary'
    | 'remote-frame'
    | 'native-divider'
    | 'intervening-rule'
    | 'unclosed-group'
    | 'outside-header-frame'
    | 'header-no-script'
    | 'header-divider' = 'none'
) {
  const width = 340,
    height = 220,
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    items: ReturnType<typeof JSON.parse>[] = [],
    cells: ReturnType<typeof JSON.parse>[] = [],
    operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    graphics: ReturnType<typeof JSON.parse>[] = [],
    styles: ReturnType<typeof JSON.parse> = {
      F: { ascent: 0.8, descent: -0.2, vertical: false },
      B: { ascent: 0.85, descent: -0.2, vertical: false },
      T: { ascent: 0.04, descent: -0.6, vertical: false },
      Z: { ascent: 0.8, descent: -0.2, vertical: false }
    },
    grid: string[][] = []
  const draw = (
    str: string,
    x: number,
    baseline: number,
    size = 10,
    face = 'F',
    spaceWidth?: number
  ) => {
    const item = {
      str,
      fontName: face,
      dir: 'ltr',
      width: spaceWidth ?? (str.length * size) / 2,
      height: str.trim() ? size : 0,
      hasEOL: false,
      transform: [size, 0, 0, size, x, height - baseline],
      ...(str.trim() ? { sourceItem: { pageNumber: 1, index: items.length, text: str } } : {})
    }
    items.push(item)
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      [face, size],
      [[1, 0, 0, 1, x, height - baseline]],
      [
        Array.from(str, (c) => ({
          unicode: c,
          fontChar: c,
          width: spaceWidth === undefined ? 500 : (spaceWidth / size) * 1000,
          isInFont: true,
          accent: null
        }))
      ],
      null
    )
    return item
  }
  const claim = (row: number, column: number, sources: ReturnType<typeof JSON.parse>[]) => {
    if (!grid[row]) grid[row] = ['', '', '']
    const text = sources.map((i) => i.str).join(' ')
    grid[row][column] = text
    cells.push({
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      text,
      sourceItems: sources.map((i) => i.sourceItem),
      sourceRects: sources.map((i) => panelTextToken(i, viewport, 0).rect)
    })
  }
  const rail = (y: number) => {
    const operationIndex = operators.fnArray.length + 3,
      left = 20.00000000000003,
      rect = [left, y - 0.2, 325, y + 0.2]
    operators.fnArray.push(
      OPS.setStrokeRGBColor,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.constructPath
    )
    operators.argsArray.push(
      ['#000000'],
      [0.4],
      [0],
      [OPS.stroke, [[0, left, height - y, 1, 325, height - y]], [left, height - y, 325, height - y]]
    )
    graphics.push({
      kind: 'path',
      operationIndex,
      normalizedRect: rect.map((n, i) => n / (i % 2 ? height : width))
    })
  }
  const vertical = (lo: number, hi: number, color = '#000000', x = 90) => {
    const operationIndex = operators.fnArray.length + 3,
      paint = [x - 0.2, lo, x + 0.2, hi]
    operators.fnArray.push(
      OPS.setStrokeRGBColor,
      OPS.setLineWidth,
      OPS.setLineCap,
      OPS.constructPath
    )
    operators.argsArray.push(
      [color],
      [0.4],
      [0],
      [OPS.stroke, [[0, x, height - hi, 1, x, height - lo]], [x, height - hi, x, height - lo]]
    )
    graphics.push({
      kind: 'path',
      operationIndex,
      normalizedRect: paint.map((x, i) => x / (i % 2 ? height : width))
    })
  }
  if (kind === 'row-groups') {
    for (let col = 0; col < 3; col++)
      claim(0, col, [draw(['Key', 'Bound', 'Range'][col], 25 + col * 100, 30)])
    claim(1, 0, [draw('a', 25, 60)])
    if (!separated) claim(2, 0, [])
    for (let col = 1; col < 3; col++) {
      const x = 25 + col * 100,
        upper = [draw('{', x, 60), draw('u', x + 6, 60), draw(',', x + 11, 60)],
        lower = [
          draw('v', x, 80),
          draw('i', x + 5, 82, 7),
          draw(structureControl === 'unclosed-group' ? ')' : '}', x + 10, 80)
        ]
      claim(1, col, separated ? [...upper, ...lower] : upper)
      if (!separated) claim(2, col, lower)
    }
    for (let col = 0; col < 3; col++)
      claim(separated ? 2 : 3, col, [draw(String(col + 1), 25 + col * 100, 125)])
    for (const y of [15, 40, 100, 155]) rail(y)
    if (structureControl === 'intervening-rule') {
      // A real short separator preserves the four full-width frame rails.
      rail(70)
      const args = operators.argsArray.at(-1)
      args[1][0][1] = 105
      args[2][0] = 105
      graphics.at(-1).normalizedRect[0] = 105 / width
    }
  } else if (kind === 'header-groups') {
    claim(0, 0, [draw('Comparison', 25, 30)])
    cells.at(-1).colSpan = 5
    const expressions = [75, 205].map((x) => {
      const a = draw('u', x, 50)
      draw(' ', x + 5, 50, 10, 'F', 3)
      const equals = draw('=', x + 8, 50)
      draw(' ', x + 13, 50, 10, 'F', 3)
      const b = draw('v', x + 16, 50),
        script = draw('i', x + 21, 53, structureControl === 'header-no-script' ? 10 : 7)
      return [a, equals, b, script]
    })
    const key = draw('Key', 25, 70),
      labels = [75, 115, 205, 245].map((x, i) => draw(i % 2 ? 'Y' : 'X', x, 70))
    if (separated) {
      claim(1, 0, [])
      claim(1, 1, expressions[0])
      cells.at(-1).colSpan = 2
      claim(1, 3, expressions[1])
      cells.at(-1).colSpan = 2
      claim(2, 0, [key])
      for (let col = 1; col < 5; col++) claim(2, col, [labels[col - 1]])
    } else {
      claim(1, 0, [key])
      for (let n = 0; n < 2; n++) {
        claim(1, 1 + n * 2, [...expressions[n].slice(0, 3), labels[n * 2]])
        claim(1, 2 + n * 2, [expressions[n][3], labels[n * 2 + 1]])
      }
    }
    for (let n = 0; n < 2; n++)
      for (let col = 0; col < 5; col++)
        claim((separated ? 3 : 2) + n, col, [
          draw(String(n + col + 1), [25, 75, 115, 205, 245][col], 105 + n * 20)
        ])
    for (const row of grid) row.length = 5
    if (structureControl === 'header-divider') vertical(38, 56, '#000000', 95.5)
    for (const y of structureControl === 'outside-header-frame' ? [90, 115, 150] : [15, 85, 150])
      rail(y)
  } else if (kind === 'omitted') {
    const headers = [
      'Key',
      structureControl === 'touching-lanes' ? 'A'.repeat(42) : 'Metric',
      'Value'
    ]
    for (let c = 0; c < 3; c++) claim(0, c, [draw(headers[c], 25 + c * 100, 30, 10, 'B')])
    const rows = [55, 75, 95, 135].map((y, n) => [
      draw(String.fromCharCode(97 + n), 25, y),
      draw(
        structureControl === 'crossing-missing' && n === 1 ? '1234567890123456' : String(10 + n),
        structureControl === 'crossing-missing' && n === 1 ? 180 : 125 + (n === 1 ? 0.01 : 0),
        y
      ),
      draw(String(20 + n), 225, y)
    ])
    for (let c = 0; c < 3; c++) {
      claim(1, c, separated ? rows.slice(0, 3).map((r) => r[c]) : [rows[0][c]])
      claim(2, c, [rows[3][c]])
    }
    rail(15)
    rail(40)
    if (structureControl !== 'no-boundary') rail(115)
    rail(155)
  } else if (kind === 'relation') {
    const expression = (x: number, y: number) => {
      const scriptSize = structureControl === 'no-script' ? 10 : 7,
        scriptY = structureControl === 'no-script' ? y : y + 2,
        a = [
          draw('u', x, y),
          draw('i', x + 5, scriptY, scriptSize),
          draw('(', x + 10, y),
          draw('x', x + 15, y),
          draw(')', x + 20, y)
        ]
      draw(' ', x + 25, y, 10, 'F', 3)
      const b = [draw(structureControl === 'no-relation' ? '+' : '>', x + 28, y)]
      draw(' ', x + 33, y, 10, 'F', 3)
      b.push(draw('v', x + 36, y), draw('j', x + 41, scriptY, scriptSize))
      return [a, b]
    }
    if (structureControl === 'plain-header') {
      claim(0, 0, [draw('Input', 25, 35)])
      claim(0, 1, [draw('Output', 175, 35)])
    } else {
      claim(0, 0, expression(25, 35).flat())
      claim(0, 1, expression(175, 35).flat())
    }
    claim(1, 0, [draw('Complete explanatory prose line', 25, 75)])
    if (structureControl !== 'no-prose') cells.at(-1).colSpan = 2
    const [a, b] = expression(25, 110)
    if (separated) {
      claim(2, 0, [...a, ...b])
      cells.at(-1).colSpan = 2
    } else {
      claim(2, 0, a)
      claim(2, 1, b)
    }
    for (const row of grid) row.length = 2
  } else if (kind === 'brackets') {
    claim(0, 0, [draw('S', 25, 30)])
    claim(0, 1, [draw('X', 95, 30)])
    const group = [draw('{', 150, 30), draw('y', 156, 30), draw('}', 162, 30)]
    claim(0, 2, separated ? group : group.slice(0, 2))
    claim(0, 3, separated ? [] : group.slice(2))
    claim(0, 4, [draw('Z', 230, 30)])
    const label = [
      draw('u', 25, 70),
      draw('i', 30, 72, 7),
      draw('(', 35, 70),
      draw('q', 40, 70),
      draw(')', 45, 70)
    ]
    draw(' ', 50, 70, 10, 'F', 45)
    const zero = draw('0', 95, 70)
    claim(1, 0, separated ? label : label.slice(0, 4))
    claim(1, 1, separated ? [zero] : [label[4], zero])
    claim(1, 2, [])
    claim(1, 3, [draw('2', 155, 70)])
    claim(1, 4, [draw('3', 230, 70)])
    for (const y of structureControl === 'remote-frame' ? [115, 135, 155] : [15, 45, 90]) rail(y)
    if (structureControl === 'native-divider') vertical(20, 40, '#000000', 161.5)
  } else if (kind === 'header') {
    const shortRail = (y: number) => {
      const left = 25,
        right = 60,
        operationIndex = operators.fnArray.length + 3,
        paint = [left, y - 0.2, right, y + 0.2]
      operators.fnArray.push(
        OPS.setStrokeRGBColor,
        OPS.setLineWidth,
        OPS.setLineCap,
        OPS.constructPath
      )
      operators.argsArray.push(
        ['#000000'],
        [0.4],
        [0],
        [
          OPS.stroke,
          [[0, left, height - y, 1, right, height - y]],
          [left, height - y, right, height - y]
        ]
      )
      graphics.push({
        kind: 'path',
        operationIndex,
        normalizedRect: paint.map((z, i) => z / (i % 2 ? height : width))
      })
    }
    const headers = [draw('Alpha', 125, 30), draw('Beta', 230, 30)],
      first = [draw('First', 25, 55), draw('1.0', 125, 55), draw('2.0', 230, 55)],
      second = [draw('Second', 25, 75), draw('3.0', 125, 75), draw('4.0', 230, 75)]
    if (separated) {
      claim(0, 0, [])
      claim(0, 1, [headers[0]])
      claim(0, 2, [headers[1]])
      for (let col = 0; col < 3; col++) {
        claim(1, col, [first[col]])
        claim(2, col, [second[col]])
      }
    } else {
      claim(0, 0, [first[0]])
      claim(0, 1, [headers[0], first[1]])
      claim(0, 2, [headers[1], first[2]])
      for (let col = 0; col < 3; col++) claim(1, col, [second[col]])
    }
    rail(15)
    rail(40)
    rail(90)
    for (const y of [headerPaint === 'inside' ? 65 : 180, 190, 200]) shortRail(y)
    if (headerPaint === 'second-frame') for (const y of [105, 125, 145]) rail(y)
  } else if (kind === 'folio') {
    draw('Independent original prose', 20, 40)
    draw('More original text', 20, 65)
    const counter = draw('1', (width - 5) / 2, 205)
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 3; col++) claim(row, col, row === 2 && col === 1 ? [counter] : [])
  } else if (kind === 'divided') {
    claim(0, 0, [draw('Label', 25, 30), draw('Metric A', 105, 30)])
    claim(0, 1, [draw('Metric B', 230, 30)])
    for (let row = 1; row <= 3; row++) {
      claim(row, 0, [
        draw(['A', 'B', 'C'][row - 1], 25, 35 + row * 25),
        draw(String(row), 105, 35 + row * 25),
        draw('±', 112, 35 + row * 25)
      ])
      claim(row, 1, [
        draw('0.1', 125, 35 + row * 25),
        draw(String(row + 1), 230, 35 + row * 25),
        draw('±', 240, 35 + row * 25),
        draw('0.2', 250, 35 + row * 25)
      ])
    }
    rail(15)
    rail(40)
    rail(155)
    vertical(20, 40 + 0.2)
    if (!separated) vertical(40.4, 154.5)
  } else if (kind === 'collapsed') {
    for (let c = 0; c < 4; c++)
      claim(0, c, [draw(['Group', 'Left', 'Middle', 'Value'][c], 20 + c * 75, 30, 10, 'B')])
    const key = draw('Group A', 25, 55),
      left = [draw('A', 95, 55), draw('B', 95, 75), draw('Summary', 95, 105)],
      middle = [draw('x', 170, 55), draw('y', 170, 75)],
      right = [draw('1', 245, 55), draw('2', 245, 75), draw('3', 245, 105)]
    if (separated) {
      for (let k = 0; k < 3; k++) {
        claim(k + 1, 0, k ? [] : [key])
        claim(k + 1, 1, [left[k]])
        claim(k + 1, 2, k < 2 ? [middle[k]] : [])
        claim(k + 1, 3, [right[k]])
      }
    } else {
      claim(1, 0, [key])
      claim(1, 1, left)
      claim(1, 2, middle)
      claim(1, 3, right)
      for (let c = 0; c < 4; c++) claim(2, c, [draw(['Other', 'C', 'z', '4'][c], 20 + c * 75, 145)])
    }
    rail(15)
    rail(40)
    rail(90)
    rail(155)
  } else if (kind === 'records') {
    for (let c = 0; c < 3; c++)
      claim(0, c, [draw(['Key', 'Evidence', 'Limit'][c], 20 + c * 100, 30, 10, 'B')])
    let row = 1
    for (let n = 0; n < 3; n++) {
      const baseline = 55 + n * 35,
        marker = draw(`${n + 1}.1`, 20, baseline, 10, 'B')
      draw(' ', 35, baseline, 10, 'B', 5)
      const lead = draw(['Alpha', 'Beta', 'Gamma'][n], 40, baseline),
        tail = n ? draw('continuation', 20, baseline + 12) : null,
        middle = [
          draw('Evidence starts', 120, baseline),
          draw('and continues', 120, baseline + 12)
        ],
        right = [
          draw('Limitation starts', 220, baseline),
          draw('and continues', 220, baseline + 12)
        ]
      if (n && !separated) {
        claim(row, 0, [marker, lead])
        claim(row + 1, 0, [tail!])
        claim(row, 1, [middle[0]])
        claim(row + 1, 1, [middle[1]])
        claim(row, 2, [right[0]])
        claim(row + 1, 2, [right[1]])
        row += 2
      } else {
        claim(row, 0, [marker, lead, ...(tail ? [tail] : [])])
        claim(row, 1, middle)
        claim(row, 2, right)
        row++
      }
    }
    rail(15)
    rail(40)
    rail(155)
  } else {
    const label = draw('The expression', 20, 45),
      number = draw('(2.3)', 20, 90)
    draw(' ', 45, 90, 10, 'F', 65)
    const first = draw('A :=', 110, 90),
      limit = draw('k', 150, 66, 7),
      operator = draw('Y', 150, 74, 10, 'T'),
      operand = draw('a', 170, 90),
      script = draw('i', 175, 92, 7),
      bracket = draw(']', 190, 62, 10, 'T'),
      last = draw('b', 210, 90),
      lastScript = draw('j', 215, 92, 7)
    claim(0, 0, [label])
    claim(0, 1, [limit, operator])
    claim(0, 2, [bracket])
    claim(1, 0, [number])
    claim(1, 1, [first, operand, script])
    claim(1, 2, [last, lastScript])
    if (separated) {
      // A single spanning math owner does not cross any claimed row boundary.
      cells.find((c) => c.row === 0 && c.column === 2).rowSpan = 2
      const lower = cells.find((c) => c.row === 1 && c.column === 2)
      cells.splice(cells.indexOf(lower), 1)
      grid[1][2] = ''
    }
  }
  if (zeroAdvance !== 'none') {
    draw('z', 50, zeroAdvance === 'overlap' ? 90 : 205, 10, 'Z', 0)
    if (zeroAdvance === 'alias') draw('z', 50, 205, 10, 'Z', 0)
  }
  if (zeroMetric !== 'none') {
    if (zeroMetric === 'selected') styles.F = { ascent: 0, descent: 0, vertical: false }
    else {
      styles.Z = { ascent: 0, descent: 0, vertical: false }
      draw('z', 50, zeroMetric === 'overlap' ? 90 : 205, 10, 'Z')
    }
  }
  const content = { items, styles },
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds: graphics },
    native = {
      content: structuredClone(content),
      viewport,
      pageNumber: 1,
      sourceSha256: 'e'.repeat(64),
      operators,
      graphicsBounds: graphics,
      skippedSpaceGlyphs: [],
      glyphBounds: Object.keys(styles).map((fontName) => ({
        fontName,
        glyphs: [
          ...new Set(items.filter((i) => i.fontName === fontName).flatMap((i) => Array.from(i.str)))
        ].map((c) => ({
          fontChar: c,
          bounds:
            c === ' '
              ? [0, 0, 0, 0]
              : fontName === 'T'
                ? c === ']'
                  ? [0, -3, 0.5, 0]
                  : [0, -1.7, 0.5, 0]
                : [0, 0, 0.5, 0.7]
        }))
      }))
    },
    fonts = items
      .filter((i) => i.str.trim())
      .map((i) => ({
        ...panelTextToken(i, viewport, 0),
        fontAscent: styles[i.fontName].ascent,
        fontDescent: styles[i.fontName].descent
      })),
    source = {
      id: 'flow',
      page: 1,
      ...(kind === 'records' ? { caption: { text: 'Summary records', page: 1 } } : {}),
      sourceViewport: { width, height, scale: 1 },
      cropRect: [15, 15, 325, 160],
      grid,
      cells,
      issues: [],
      notes: [],
      unassigned: [] as string[],
      reviewCandidate: true
    },
    context = {
      sourcePage: page,
      viewport,
      content,
      sourceContent: content,
      nativeGlyphContext: native
    },
    rules = panelRules(operators, viewport)
  if (kind === 'folio') {
    source.cropRect = [15, 180, 325, 215]
    Object.assign(source, { caption: { text: 'Table 1: Summary', page: 1 } })
    Object.assign(context, {
      nativeFolioPages: [2, 3].map((pageNumber) => ({
        pageNumber,
        width,
        height,
        lines: [
          {
            text: String(pageNumber),
            x: (width - 5) / 2,
            y: 195,
            width: 5,
            height: 10,
            fontSize: 10
          }
        ]
      }))
    })
  }
  if (kind === 'header') source.cropRect = [15, 10, 330, 160]
  if (kind === 'omitted') {
    const claimed = new Set(cells.flatMap((c) => c.sourceItems).map((o) => o.index))
    source.unassigned = items
      .filter((i) => i.str.trim() && !claimed.has(i.sourceItem.index))
      .map((i) => i.str)
  }
  return { source, fonts, context, rules }
}

it.each(['records', 'math'] as const)(
  'pauses a fully bound native flow cut into incompatible row owners: %s',
  (kind) => {
    const f = finalNativeFlowFixture(kind),
      before = structuredClone(f.source),
      result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).toContain('native-table-structure-ambiguous')
    expect(result.reviewCandidate).toBe(false)
    expect(result.cells).toBe(f.source.cells)
    expect(result.grid).toBe(f.source.grid)
    expect(result.cropRect).toBe(f.source.cropRect)
    expect(result.unreliableMathSourceItems).toBeUndefined()
    expect(f.source).toEqual(before)
  }
)

it.each(['records', 'math'] as const)(
  'keeps native records without a contradictory row cut usable: %s',
  (kind) => {
    const f = finalNativeFlowFixture(kind, true),
      result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it.each(['missing native', 'unknown geometry', 'mismatched transform', 'missing style'] as const)(
  'declines native-flow fallback when evidence is incomplete: %s',
  (reason) => {
    const f = finalNativeFlowFixture('records')
    if (reason === 'missing native')
      delete (f.context as { nativeGlyphContext?: unknown }).nativeGlyphContext
    if (reason === 'unknown geometry')
      f.fonts.push({ ...f.fonts[0], text: 'Foreign', rect: [NaN, 0, 10, 10] })
    if (reason === 'mismatched transform')
      f.context.nativeGlyphContext.content.items[0].transform[4] += 1
    if (reason === 'missing style') delete f.context.nativeGlyphContext.content.styles.B
    const result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it('uses a fully bound remote zero-advance glyph only for a negative row witness', () => {
  const f = finalNativeFlowFixture('math', false, 'remote'),
    before = structuredClone(f.source),
    result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.reviewCandidate).toBe(false)
  expect(result.cells).toBe(f.source.cells)
  expect(result.grid).toBe(f.source.grid)
  expect(result.cropRect).toBe(f.source.cropRect)
  expect(f.source).toEqual(before)
  expect(f.fonts.at(-1)!.rect[0]).toBe(f.fonts.at(-1)!.rect[2])
  expect(result.unreliableMathSourceItems).toBeUndefined()
})

it.each(['overlap', 'alias', 'unknown'] as const)(
  'rejects an unclosed remote native-paint witness: %s',
  (reason) => {
    const f = finalNativeFlowFixture('math', false, reason === 'unknown' ? 'remote' : reason)
    if (reason === 'unknown')
      f.fonts.push({ ...font('Unknown', 310, 180, 999), rect: [NaN, 180, 330, 190] })
    const result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it('pauses one logical row which crosses a complete independent native row separator', () => {
  const f = finalNativeFlowFixture('collapsed'),
    before = structuredClone(f.source),
    r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(r.issues).toContain('native-table-structure-ambiguous')
  expect(r.reviewCandidate).toBe(false)
  expect(r.cells).toBe(f.source.cells)
  expect(r.grid).toBe(f.source.grid)
  expect(r.unreliableMathSourceItems).toBeUndefined()
  expect(f.source).toEqual(before)
})
it('keeps the same native records with separate logical row owners unchanged', () => {
  const f = finalNativeFlowFixture('collapsed', true),
    r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(r.issues).not.toContain('native-table-structure-ambiguous')
})
it.each(['native', 'rail', 'foreign'] as const)(
  'declines a collapsed-row conflict without complete %s evidence',
  (fault) => {
    const f = finalNativeFlowFixture('collapsed')
    if (fault === 'native')
      delete (f.context as { nativeGlyphContext?: unknown }).nativeGlyphContext
    if (fault === 'rail') f.rules = f.rules.filter((r) => r[1] !== 90)
    if (fault === 'foreign')
      f.fonts.push({
        ...f.fonts[0],
        sourceItem: { pageNumber: 1, index: 999, text: 'Unknown' },
        text: 'Unknown',
        rect: [NaN, 0, 1, 1]
      })
    const r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(r.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it('does not infer separate logical records from an invisible white separator', () => {
  const f = finalNativeFlowFixture('collapsed'),
    ops = f.context.nativeGlyphContext.operators,
    index = ops.fnArray.findIndex(
      (op: number, i: number) => op === OPS.constructPath && ops.argsArray[i][1][0][2] === 130
    )
  expect(index).toBeGreaterThan(3)
  expect(ops.fnArray[index - 3]).toBe(OPS.setStrokeRGBColor)
  ops.argsArray[index - 3] = ['#ffffff']
  const r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(r.issues).not.toContain('native-table-structure-ambiguous')
})

it('retains a complete remote zero-metric glyph only as a negative witness', () => {
  const f = finalNativeFlowFixture('collapsed', false, 'none', 'remote'),
    before = structuredClone(f.source),
    r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(r.issues).toContain('native-table-structure-ambiguous')
  expect(r.reviewCandidate).toBe(false)
  expect(f.source).toEqual(before)
  expect(f.context.content.styles.Z).toEqual({ ascent: 0, descent: 0, vertical: false })
})
it.each(['selected', 'overlap'] as const)(
  'rejects zero-metric evidence with %s ownership',
  (fault) => {
    const f = finalNativeFlowFixture('collapsed', false, 'none', fault),
      r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(r.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it.each(['divided', 'folio'] as const)(
  'preserves native content while pausing a closed %s contradiction',
  (kind) => {
    const f = finalNativeFlowFixture(kind),
      before = structuredClone(f.source),
      r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(r.issues).toContain('native-table-structure-ambiguous')
    expect(r.reviewCandidate).toBe(false)
    expect(r.cells).toBe(f.source.cells)
    expect(r.grid).toBe(f.source.grid)
    expect(r.cropRect).toBe(f.source.cropRect)
    expect(f.source).toEqual(before)
  }
)
it('declines a column contradiction without independent visible body dividers', () => {
  const f = finalNativeFlowFixture('divided', true),
    r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(r.issues).not.toContain('native-table-structure-ambiguous')
})
it('retains a sparse native value without independent repeated-folio evidence', () => {
  const f = finalNativeFlowFixture('folio')
  Object.assign(f.context, { nativeFolioPages: [] })
  const r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(r.issues).not.toContain('native-table-structure-ambiguous')
})

it('pauses first-row owners spanning a complete native header divider', () => {
  const f = finalNativeFlowFixture('header'),
    before = structuredClone(f.source),
    r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(r.issues).toContain('native-table-structure-ambiguous')
  expect(r.reviewCandidate).toBe(false)
  expect(r.cells).toBe(f.source.cells)
  expect(f.source).toEqual(before)
})
it('keeps separately owned native header and data rows usable', () => {
  const f = finalNativeFlowFixture('header', true),
    r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(r.issues).not.toContain('native-table-structure-ambiguous')
})
it('declines a first-row contradiction without a visible header divider', () => {
  const f = finalNativeFlowFixture('header'),
    ops = f.context.nativeGlyphContext.operators,
    paths = ops.fnArray.flatMap((op: number, i: number) => (op === OPS.constructPath ? [i] : []))
  ops.argsArray[paths[1] - 3] = ['#ffffff']
  const r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(r.issues).not.toContain('native-table-structure-ambiguous')
})

it.each(['inside', 'second-frame'] as const)(
  'declines a first-row witness with %s foreign native rules',
  (fault) => {
    const f = finalNativeFlowFixture('header', false, 'none', 'none', fault),
      r = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(r.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it.each(['omitted', 'relation', 'brackets'] as const)(
  'retains original cells and requests conservative fallback for a closed native contradiction: %s',
  (kind) => {
    const f = finalNativeFlowFixture(kind),
      before = structuredClone(f.source),
      result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).toContain('native-table-structure-ambiguous')
    expect(result.reviewCandidate).toBe(false)
    expect(result.cells).toBe(f.source.cells)
    expect(result.grid).toBe(f.source.grid)
    expect(result.cropRect).toBe(f.source.cropRect)
    expect(result.unreliableMathSourceItems).toBeUndefined()
    expect(f.source).toEqual(before)
  }
)

it.each(['omitted', 'relation', 'brackets'] as const)(
  'keeps complete multiline or spanning native owners usable: %s',
  (kind) => {
    const f = finalNativeFlowFixture(kind, true),
      result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it.each(['caption', 'rules', 'plain-header', 'no-prose', 'no-script', 'no-relation'] as const)(
  'does not infer an unreliable relation flow without the complete native witness: %s',
  (reason) => {
    const f = finalNativeFlowFixture(
      'relation',
      false,
      'none',
      'none',
      'remote',
      ['caption', 'rules'].includes(reason)
        ? 'none'
        : (reason as 'plain-header' | 'no-prose' | 'no-script' | 'no-relation')
    )
    if (reason === 'caption')
      Object.assign(f.source, { caption: { text: 'Measurement summary', page: 1 } })
    const result = reviewFinalNativeTableSources(
      f.source,
      f.fonts,
      reason === 'rules' ? [[20, 15, 325, 15]] : f.rules,
      [],
      f.context
    )
    expect(result.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it.each(['touching-lanes', 'crossing-missing', 'no-boundary'] as const)(
  'declines an omitted-record witness without independent complete field lanes: %s',
  (reason) => {
    const f = finalNativeFlowFixture('omitted', false, 'none', 'none', 'remote', reason),
      result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it('does not turn remote zero font metrics into positive authority for selected native math', () => {
  const remote = finalNativeFlowFixture('relation', false, 'none', 'remote'),
    selected = finalNativeFlowFixture('relation', false, 'none', 'selected'),
    overlap = finalNativeFlowFixture('relation', false, 'none', 'overlap')
  expect(
    reviewFinalNativeTableSources(remote.source, remote.fonts, remote.rules, [], remote.context)
      .issues
  ).toContain('native-table-structure-ambiguous')
  for (const f of [selected, overlap])
    expect(
      reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context).issues
    ).not.toContain('native-table-structure-ambiguous')
})

it.each(['remote-frame', 'native-divider'] as const)(
  'declines a split delimiter witness explained by native frame or divider paint: %s',
  (reason) => {
    const f = finalNativeFlowFixture('brackets', false, 'none', 'none', 'remote', reason),
      result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it.each(['row-groups', 'header-groups'] as const)(
  'pauses only the independently closed native partition contradiction: %s',
  (kind) => {
    const f = finalNativeFlowFixture(kind),
      before = structuredClone(f.source),
      result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).toContain('native-table-structure-ambiguous')
    expect(result.reviewCandidate).toBe(false)
    expect(result.cells).toBe(f.source.cells)
    expect(result.grid).toBe(f.source.grid)
    expect(result.cropRect).toBe(f.source.cropRect)
    expect(result.unreliableMathSourceItems).toBeUndefined()
    expect(f.source).toEqual(before)
  }
)

it.each(['row-groups', 'header-groups'] as const)(
  'keeps complete multiline cells or true spanning header owners: %s',
  (kind) => {
    const f = finalNativeFlowFixture(kind, true),
      result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
    expect(result.issues).not.toContain('native-table-structure-ambiguous')
  }
)

it.each([
  ['row-groups', 'intervening-rule'],
  ['row-groups', 'unclosed-group'],
  ['header-groups', 'outside-header-frame'],
  ['header-groups', 'header-no-script'],
  ['header-groups', 'header-divider']
] as const)('declines an incomplete native partition witness: %s / %s', (kind, control) => {
  const f = finalNativeFlowFixture(kind, false, 'none', 'none', 'remote', control),
    result = reviewFinalNativeTableSources(f.source, f.fonts, f.rules, [], f.context)
  expect(result.issues).not.toContain('native-table-structure-ambiguous')
})

// Anonymous complete native glossary owners; no paper text or external fixture.
function collapsedGlossaryRecords() {
  const headers = [
    font('Symbol', 10, 5, 0),
    font('Meaning', 100, 5, 1),
    font('Defined in', 230, 5, 2)
  ]
  const fields = [
    [font('q', 10, 30, 3), font('r', 10, 45, 4)],
    [font('first complete definition', 100, 30, 5), font('second complete definition', 100, 45, 6)],
    [font('App. B', 230, 30, 7), font('Lem. B.2', 230, 45, 8)]
  ]
  const fonts = [...headers, ...fields.flat()]
  const input = table([
    ...headers.map((f, column) => cell(0, column, [f])),
    ...fields.map((f, column) => cell(1, column, f))
  ])
  return { fonts, fields, input }
}

it('pauses collapsed complete glossary records while retaining every original claim and crop', () => {
  const { fonts, input } = collapsedGlossaryRecords(),
    before = structuredClone(input)
  expect(nativeTableSourceConflicts(input, fonts)).toContain('collapsed-native-records')
  const result = reviewNativeTableSources(input, fonts)
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.cells).toBe(input.cells)
  expect(result.grid).toBe(input.grid)
  expect(result.cropRect).toBe(input.cropRect)
  expect(input).toEqual(before)
})

it.each([
  'meaning-wrap',
  'same-baseline-symbols',
  'single-symbol-many-references',
  'partial-source',
  'not-glossary',
  'misaligned-meaning'
] as const)(
  'keeps a glossary candidate without complete repeated entry restarts unchanged: %s',
  (kind) => {
    const { fonts, fields, input } = collapsedGlossaryRecords()
    if (kind === 'meaning-wrap' || kind === 'single-symbol-many-references') {
      input.cells[3] = cell(1, 0, [fields[0][0]])
      if (kind === 'meaning-wrap') input.cells[5] = cell(1, 2, [fields[2][0]])
    } else if (kind === 'same-baseline-symbols') {
      const f = fields[0][1]
      f.rect = [40, 30, 60, 40]
      f.baseline = 40
      input.cells[3] = cell(1, 0, fields[0])
    } else if (kind === 'partial-source') {
      input.cells[4].sourceRects = input.cells[4].sourceRects.slice(1)
    } else if (kind === 'not-glossary') {
      input.cells[0].text = 'General'
      input.grid[0][0] = 'General'
    } else {
      const f = fields[1][1]
      f.rect = [100, 50, 120, 60]
      f.baseline = 60
      input.cells[4] = cell(1, 1, fields[1])
    }
    input.cells.forEach((c) => {
      input.grid[c.row][c.column] = c.text
    })
    expect(nativeTableSourceConflicts(input, fonts)).not.toContain('collapsed-native-records')
    expect(reviewNativeTableSources(input, fonts)).toBe(input)
  }
)

// Anonymous whole native fields: a complete wrapped peer and two split records.
function splitWrappedStubFixture() {
  let index = 0
  const native = (text: string, x: number, y: number, width = 20) =>
    Object.assign(font(text, x, y, index++, width), { fontAscent: 0.8, fontDescent: -0.2 })
  const headers = [
    native('Category', 10, 5),
    native('Variant', 70, 5),
    native('Estimate A', 120, 5),
    native('CI', 200, 5),
    native('Estimate B', 220, 5)
  ]
  const peer = [native('Harbor', 10, 30), native('Route', 10, 42)]
  const first = [native('Harbor', 10, 60), native('Route', 10, 72)]
  const second = [native('Harbor', 10, 90), native('Route', 10, 102)]
  const fields = [42, 72, 102].map((y, i) => [
    native(['Alpha', 'Beta', 'Gamma'][i], 70, y),
    native('12.3 [10.1, 14.5]', 120, y, 70),
    native('23.4 [21.2, 25.6]', 220, y, 70)
  ])
  const input = table([
    ...headers.map((f, c) => cell(0, c, [f])),
    cell(1, 0, peer),
    ...fields[0].map((f, c) => cell(1, [1, 2, 4][c], [f])),
    cell(2, 0, [first[0]]),
    cell(3, 0, [first[1]]),
    ...fields[1].map((f, c) => cell(3, [1, 2, 4][c], [f])),
    cell(4, 0, [second[0]]),
    cell(5, 0, [second[1]]),
    ...fields[2].map((f, c) => cell(5, [1, 2, 4][c], [f]))
  ])
  return {
    input,
    fonts: [...headers, ...peer, ...first, ...second, ...fields.flat()],
    peer,
    first,
    second
  }
}

it('pauses split wrapped native records only after a complete compound peer proves the conflict', () => {
  const { input, fonts } = splitWrappedStubFixture(),
    before = structuredClone(input),
    result = reviewNativeTableSources(input, fonts)
  expect(nativeTableSourceConflicts(input, fonts)).toContain('split-wrapped-native-records')
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.reviewCandidate).toBe(false)
  expect(result.cells).toBe(input.cells)
  expect(result.grid).toBe(input.grid)
  expect(result.cropRect).toBe(input.cropRect)
  expect(input).toEqual(before)
})

it.each([
  'complete-wrap',
  'no-complete-peer',
  'different-stub-lane',
  'partial-native-source'
] as const)(
  'keeps wrapped-field candidates without the complete split-record proof unchanged: %s',
  (control) => {
    const { input, fonts, peer, first, second } = splitWrappedStubFixture()
    if (control === 'complete-wrap') {
      input.cells = input.cells.filter((c) => ![2, 4].includes(c.row))
      for (const [row, pair] of [
        [3, first],
        [5, second]
      ] as const) {
        const i = input.cells.findIndex((c) => c.row === row && c.column === 0)
        input.cells[i] = cell(row, 0, pair)
      }
    } else if (control === 'no-complete-peer') {
      const i = input.cells.findIndex((c) => c.row === 1 && c.column === 0)
      input.cells[i] = cell(1, 0, [peer[1]])
    } else if (control === 'different-stub-lane') {
      for (const f of [first[0], second[0]]) f.rect = [45, f.rect[1], 65, f.rect[3]]
      for (const row of [2, 4]) {
        const i = input.cells.findIndex((c) => c.row === row && c.column === 0)
        input.cells[i] = cell(row, 0, [row === 2 ? first[0] : second[0]])
      }
    } else {
      const c = input.cells.find((c) => c.row === 2 && c.column === 0)!
      c.sourceRects = []
    }
    input.cells.forEach((c) => {
      input.grid[c.row][c.column] = c.text
    })
    expect(nativeTableSourceConflicts(input, fonts)).not.toContain('split-wrapped-native-records')
    expect(reviewNativeTableSources(input, fonts)).toBe(input)
  }
)

it('does not combine wrapped native fields from different source pages', () => {
  const { input, fonts, first, second } = splitWrappedStubFixture()
  for (const f of [...first, ...second]) f.sourceItem.pageNumber = 2
  expect(nativeTableSourceConflicts(input, fonts)).not.toContain('split-wrapped-native-records')
  expect(reviewNativeTableSources(input, fonts)).toBe(input)
})

// Anonymous whole source halves and independent scalar record anchors.
function crossedNativeIntervalsFixture() {
  let index = 0
  const native = (text: string, x: number, y: number, width = 20) =>
    Object.assign(font(text, x, y, index++, width), { fontAscent: 0.8, fontDescent: -0.2 })
  const headers = [
    native('Setting', 10, 5),
    native('Contrast', 60, 5),
    native('Difference', 130, 5),
    native('Adjusted p', 190, 5),
    native('95% CI', 240, 5)
  ]
  const fields = [40, 64].map((y, i) => [
    native(i ? '2000' : '2500', 10, y),
    native(i ? 'Method Beta' : 'Method Alpha', 60, y, 50),
    native(i ? '+5.2' : '+5.1', 130, y, 30),
    native(i ? '.02' : '.01', 190, y)
  ])
  const halves = [
    native('[+1.2,', 240, 28, 30),
    native('+2.3]', 240, 40, 30),
    native('[+3.4,', 240, 52, 30),
    native('+4.5]', 240, 64, 30)
  ]
  const input = table(
    [
      ...headers.map((f, c) => cell(0, c, [f])),
      ...fields.flatMap((row, r) => row.map((f, c) => cell(r + 1, c, [f]))),
      cell(1, 4, [halves[1], halves[2]]),
      cell(2, 4, [halves[3]])
    ],
    [halves[0].text]
  )
  return { input, fonts: [...headers, ...fields.flat(), ...halves], fields, halves }
}

it('pauses cross-record interval halves only with complete independent native scalar anchors', () => {
  const { input, fonts } = crossedNativeIntervalsFixture(),
    before = structuredClone(input),
    result = reviewNativeTableSources(input, fonts)
  expect(nativeTableSourceConflicts(input, fonts)).toContain('crossed-native-interval-records')
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.cells).toBe(input.cells)
  expect(result.grid).toBe(input.grid)
  expect(result.cropRect).toBe(input.cropRect)
  expect(result.unassigned).toBe(input.unassigned)
  expect(input).toEqual(before)
})

it.each([
  'complete-intervals',
  'different-source-page',
  'literal-mismatch',
  'unknown-font-metrics',
  'misaligned-record-anchor'
] as const)('declines an incomplete cross-record native interval witness: %s', (control) => {
  const { input, fonts, fields, halves } = crossedNativeIntervalsFixture()
  if (control === 'complete-intervals') {
    input.cells = input.cells.filter((c) => c.row === 0 || c.column !== 4)
    input.cells.push(cell(1, 4, [halves[0], halves[1]]), cell(2, 4, [halves[2], halves[3]]))
    input.unassigned = []
  } else if (control === 'different-source-page') {
    halves[0].sourceItem.pageNumber = 2
  } else if (control === 'literal-mismatch') {
    const c = input.cells.find((c) => c.row === 1 && c.column === 4)!
    c.sourceItems = c.sourceItems.map((s, i) => (i ? s : { ...s, text: '+9.9]' }))
  } else if (control === 'unknown-font-metrics') {
    halves[0].fontAscent = 0
  } else {
    const anchor = fields[1][3]
    anchor.baseline += 3
    anchor.rect = anchor.rect.map((v, i) => (i % 2 ? v + 3 : v))
    const c = input.cells.find((c) => c.row === 2 && c.column === 3)!
    c.sourceRects = [anchor.rect]
  }
  input.cells.forEach((c) => {
    input.grid[c.row][c.column] = c.text
  })
  expect(nativeTableSourceConflicts(input, fonts)).not.toContain('crossed-native-interval-records')
  expect(reviewNativeTableSources(input, fonts)).toBe(input)
})

function completeCrossedRecordFixture(control = 'none') {
  const width = 420,
    height = 180,
    items: ReturnType<typeof JSON.parse>[] = [],
    operators: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    styles = {
      F: { ascent: 0.8, descent: -0.2, vertical: false },
      G: { ascent: 0.8, descent: -0.2, vertical: false }
    }
  const draw = (str: string, x: number, y: number, face = 'F') => {
    const item = {
      str,
      fontName: face,
      dir: 'ltr',
      width: str.length * 5,
      height: 10,
      hasEOL: false,
      transform: [10, 0, 0, 10, x, height - y],
      sourceItem: { pageNumber: 1, index: items.length, text: str }
    }
    items.push(item)
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      [face, 10],
      [[1, 0, 0, 1, x, height - y]],
      [
        Array.from(str, (c) => ({
          unicode: c,
          fontChar: c,
          width: 500,
          isInFont: true,
          isSpace: c === ' ',
          accent: null
        }))
      ],
      null
    )
    return item
  }
  const cells: ReturnType<typeof JSON.parse>[] = [],
    grid = Array.from({ length: 6 }, () => Array(4).fill(''))
  const claim = (r: number, col: number, sources: ReturnType<typeof JSON.parse>[]) => {
    const fonts = sources.map((i) => panelTextToken(i, viewport, 0))
    const c = {
      row: r,
      column: col,
      rowSpan: 1,
      colSpan: 1,
      text: sources.map((i) => i.str).join(' '),
      sourceItems: sources.map((i) => i.sourceItem),
      sourceRects: fonts.map((f) => f.rect)
    }
    cells.push(c)
    grid[r][col] = c.text
    return c
  }
  for (let col = 0; col < 4; col++)
    claim(0, col, [draw(['Entry', 'First', 'Next', 'Last'][col], col ? col * 100 + 20 : 20, 25)])
  const stubs = [
    draw('Elm', 20, 56),
    draw('Ash', 20, control === 'stub-location' ? 70 : 80),
    draw('Oak', 20, 104)
  ]
  stubs.forEach((s, i) => claim(i + 1, 0, [s]))
  const mixed: ReturnType<typeof JSON.parse>[] = []
  for (let col = 1; col < 4; col++) {
    const center = col * 100 + 40,
      point = (s: string, y: number, face = 'F') => draw(s, center - s.length * 2.5, y, face),
      p = point('.1', 50),
      a = point('[.0, .2]', 62),
      b = point('.3', 74, control === 'fontface' && col === 1 ? 'G' : 'F'),
      c = point('[.2, .4]', 86),
      d = point('.5', 98)
    claim(1, col, [p])
    mixed.push(claim(2, col, [a, b]))
    claim(3, col, [c, d])
  }
  claim(4, 0, [draw('Pine', 20, 134)]).rowSpan = 2
  for (let col = 1; col < 4; col++) {
    claim(4, col, [draw('.6', col * 100 + 35, 128)])
    claim(5, col, [draw('.7', col * 100 + 35, 140)])
  }
  if (control === 'one-boundary')
    for (const c of cells.filter((c) => c.row === 3 && c.column > 0)) c.rowSpan = 2
  if (control === 'cross-page')
    mixed[0].sourceItems[0] = { ...mixed[0].sourceItems[0], pageNumber: 2 }
  if (control === 'literal')
    mixed[0].sourceItems[0] = { ...mixed[0].sourceItems[0], text: '[.9, 1.0]' }
  const content = { items, styles },
    native = {
      content: structuredClone(content),
      viewport,
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      operators,
      graphicsBounds: [],
      skippedSpaceGlyphs: [],
      glyphBounds: Object.keys(styles).map((fontName) => ({
        fontName,
        glyphs: [
          ...new Set(items.filter((i) => i.fontName === fontName).flatMap((i) => Array.from(i.str)))
        ].map((c) => ({ fontChar: c, bounds: c === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.7] }))
      }))
    },
    fonts = items.map((i) => ({
      ...panelTextToken(i, viewport, 0),
      fontAscent: 0.8,
      fontDescent: -0.2
    })),
    input = {
      id: 'records',
      page: 1,
      cropRect: [10, 10, 410, 150],
      grid,
      cells,
      issues: [],
      unassigned: [],
      notes: [],
      reviewCandidate: true,
      caption: { text: 'Summary', page: 1 },
      sourceViewport: { width, height, scale: 1 }
    },
    context = {
      sourcePage: { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds: [] },
      sourceContent: content,
      content,
      viewport,
      nativeGlyphContext: native,
      rulePaintBounds: new Map()
    }
  return { input, fonts, context }
}

it('pauses complete crossed native records without rewriting cells or images', () => {
  const f = completeCrossedRecordFixture(),
    before = structuredClone(f.input),
    result = reviewFinalNativeTableSources(f.input, f.fonts, [], [], f.context)
  expect(result.issues).toContain('native-table-structure-ambiguous')
  expect(result.reviewCandidate).toBe(false)
  expect(result.cells).toBe(f.input.cells)
  expect(result.grid).toBe(f.input.grid)
  expect(result.cropRect).toBe(f.input.cropRect)
  expect(f.input).toEqual(before)
})

it.each(['one-boundary', 'cross-page', 'literal', 'fontface', 'stub-location'])(
  'declines incomplete crossed native records: %s',
  (control) => {
    const f = completeCrossedRecordFixture(control),
      result = reviewFinalNativeTableSources(f.input, f.fonts, [], [], f.context)
    expect(result.issues).not.toContain('native-table-structure-ambiguous')
  }
)

function anonymousTypedFraction(control = 'none'): ReturnType<typeof JSON.parse> {
  const width = 240,
    height = 180,
    items: ReturnType<typeof JSON.parse>[] = [],
    ops: ReturnType<typeof JSON.parse> = { fnArray: [], argsArray: [] },
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    outlines: ReturnType<typeof JSON.parse>[] = [],
    program = {
      operatorListId: 'mark',
      unicode: 'q',
      width: 500,
      kind: 'filled-path',
      bounds: [0, 0, 500, 700],
      clip: [0, 0, 500, 700],
      paint: OPS.fill,
      occurrences: [] as ReturnType<typeof JSON.parse>[]
    }
  const add = (op: number, args: ReturnType<typeof JSON.parse>) => {
    ops.fnArray.push(op)
    ops.argsArray.push(args)
  }
  const draw = (text: string, x: number, y: number, size: number, face = 'F') => {
    add(OPS.beginText, null)
    add(OPS.setFont, [face, size])
    add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - y]])
    const glyphs = Array.from(text, (c) => ({
      unicode: c,
      fontChar: face === 'T' ? '' : c,
      width: face === 'T' ? 500 : 600,
      isInFont: true,
      isSpace: c === ' ',
      accent: null,
      ...(face === 'T' ? { operatorListId: 'mark' } : {})
    }))
    if (face === 'T')
      program.occurrences.push({ operationIndex: ops.fnArray.length, glyphIndex: 0 })
    else
      for (const c of text)
        if (!outlines.some((g) => g.fontChar === c))
          outlines.push({ fontChar: c, bounds: [0, 0, 0.6, 0.7] })
    add(OPS.showText, [glyphs])
    add(OPS.endText, null)
    const raw = {
      str: text,
      fontName: face,
      dir: 'ltr',
      width: text.length * size * (face === 'T' ? 0.5 : 0.6),
      height: size,
      hasEOL: false,
      transform: [size, 0, 0, size, x, height - y],
      sourceItem: { pageNumber: 1, index: items.length, text }
    }
    items.push(raw)
    return raw
  }
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setLineWidth, [0.4])
  add(OPS.setMiterLimit, [1])
  if (control === 'numeral-white') add(OPS.setFillRGBColor, ['#ffffff'])
  if (control === 'numeral-alpha')
    add(OPS.setGState, [
      [
        ['ca', 0],
        ['CA', 1]
      ]
    ])
  const a = draw('2', 40, 45, 7),
    b = draw('5', 40, 53, 7)
  add(OPS.setFillRGBColor, ['#000000'])
  add(OPS.setGState, [
    [
      ['ca', 1],
      ['CA', 1]
    ]
  ])
  const base = draw('level', 46, 49, 10, 'G')
  draw('q', control === 'foreign' ? 40 : 180, control === 'foreign' ? 49 : 140, 7, 'T')
  const line = (y: number) =>
    add(OPS.constructPath, [
      OPS.stroke,
      [[0, 40, height - y, 1, 44.2, height - y]],
      [40, height - y, 44.2, height - y]
    ])
  if (control === 'bar-white') add(OPS.setStrokeRGBColor, ['#ffffff'])
  if (control === 'bar-alpha')
    add(OPS.setGState, [
      [
        ['CA', 0.5],
        ['ca', 1]
      ]
    ])
  if (control !== 'multiline') line(47)
  if (control === 'double-bar') line(47.3)
  add(OPS.setStrokeRGBColor, ['#000000'])
  add(OPS.setGState, [
    [
      ['ca', 1],
      ['CA', 1]
    ]
  ])
  if (control === 'type3-gap') program.occurrences[0].glyphIndex = 1
  add(OPS.save, null)
  add(OPS.setFillRGBColor, ['#ffffff'])
  add(OPS.setGState, [
    [
      ['ca', 0],
      ['CA', 0]
    ]
  ])
  const extraOperation = ops.fnArray.length,
    extraRect = control === 'nonbar' ? [40, 44, 44.2, 54] : [160, 80, 170, 90]
  add(OPS.constructPath, [
    OPS.fill,
    [
      [
        0,
        extraRect[0],
        height - extraRect[1],
        1,
        extraRect[2],
        height - extraRect[1],
        1,
        extraRect[0],
        height - extraRect[3],
        4
      ]
    ],
    [extraRect[0], height - extraRect[3], extraRect[2], height - extraRect[1]]
  ])
  add(OPS.restore, null)
  const content = {
      items,
      styles: {
        F: { ascent: 0.7, descent: -0.3, vertical: false },
        G: { ascent: 0, descent: 0, vertical: false },
        T: { ascent: 0.7, descent: -0.3, vertical: false }
      }
    },
    fonts = items.map((i) => {
      const f = {
        ...panelTextToken(i, viewport, 0),
        fontAscent: content.styles[i.fontName as 'F'].ascent,
        fontDescent: content.styles[i.fontName as 'F'].descent
      }
      return {
        ...f,
        nativeLabelRect: [
          f.rect[0],
          f.baseline - f.fontAscent * f.height,
          f.rect[2],
          f.baseline - f.fontAscent * f.height + f.height
        ]
      }
    }),
    input = {
      id: 'values',
      page: 1,
      cropRect: [20, 20, 120, 80],
      grid: [['2 5 level']],
      cells: [
        {
          row: 0,
          column: 0,
          rowSpan: 1,
          colSpan: 1,
          text: '2 5 level',
          sourceItems: [a.sourceItem, b.sourceItem, base.sourceItem],
          sourceRects: fonts.slice(0, 3).map((f) => f.rect)
        }
      ],
      issues: [],
      unassigned: [],
      reviewCandidate: true,
      thumbnail: 'thumbnails/page-1-table-0.png'
    },
    paint = new Map(),
    rules = panelRules(ops, viewport, paint),
    graphicsBounds = [...paint]
      .map(([, r], i) => ({
        operationIndex: ops.fnArray.flatMap((op: number, j: number) =>
          op === OPS.constructPath ? [j] : []
        )[i],
        kind: 'path',
        normalizedRect: r.map((n: number, k: number) => n / (k % 2 ? height : width))
      }))
      .concat([
        {
          operationIndex: extraOperation,
          kind: 'path',
          normalizedRect: extraRect.map((n: number, k: number) => n / (k % 2 ? height : width))
        }
      ]),
    page = { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds },
    native = {
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      viewport,
      content: structuredClone(content),
      operators: ops,
      graphicsBounds,
      partialFontGlyphBounds: ['F', 'G'].map((fontName) => ({
        fontName,
        glyphs: structuredClone(outlines)
      })),
      type3GlyphPrograms: [
        {
          fontName: 'T',
          fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          sourceIndices: [3],
          glyphs: [program]
        }
      ]
    },
    context = {
      sourcePage: page,
      sourceContent: content,
      content,
      sourceSha256: 'a'.repeat(64),
      viewport,
      operators: ops,
      nativeGlyphContext: native,
      nativeEvidenceGraphics: graphicsBounds.map((g) => ({
        kind: g.kind,
        rect: g.normalizedRect.map((n: number, k: number) => n * (k % 2 ? height : width))
      })),
      nativePaintIdentityGraphics: graphicsBounds.map((g: ReturnType<typeof JSON.parse>) => ({
        kind: 'path',
        operationIndex: g.operationIndex,
        rect: g.normalizedRect.map((n: number, k: number) => n * (k % 2 ? height : width))
      })),
      rulePaintBounds: paint
    }
  if (control === 'numeral-font') fonts[0].fontAscent = 0
  return { input, fonts, rules, context }
}

const {
  nativeWholeCellInkPacket: unchangedWholeCellPacket,
  nativeFractionInkPacket: unchangedFractionPacket
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
it('withdraws a flattened numeric fraction with complete Type3 foreign paint without changing text or cells', () => {
  const f = anonymousTypedFraction(),
    before = structuredClone(f.input),
    r = reviewFinalNativeTableSources(f.input, f.fonts, f.rules, [], f.context)
  expect(r.issues).toContain('native-table-structure-ambiguous')
  expect(r.unreliableMathSourceItems).toEqual(f.input.cells[0].sourceItems.slice(0, 2))
  expect(r.reviewCandidate).toBe(false)
  for (const field of ['cells', 'grid', 'cropRect', 'thumbnail'])
    expect(r[field]).toBe(f.input[field])
  expect(f.input).toEqual(before)
  const native = f.context.nativeGlyphContext,
    tokens = native.content.items.map((item: ReturnType<typeof JSON.parse>) =>
      panelTextToken(item, native.viewport, 0)
    )
  expect(
    unchangedWholeCellPacket(f.context.sourcePage, tokens, native, f.input.cells[0])
  ).toBeUndefined()
  expect(
    unchangedFractionPacket(
      f.context.sourcePage,
      tokens,
      native,
      f.input.cells[0].sourceItems.slice(0, 2)
    )
  ).toBeUndefined()
  native.sourceSha256 = 'b'.repeat(64)
  expect(
    reviewFinalNativeTableSources(f.input, f.fonts, f.rules, [], f.context)
      .unreliableMathSourceItems
  ).toBeUndefined()
})
it.each(['multiline', 'double-bar', 'foreign', 'type3-gap', 'numeral-font'])(
  'declines an incomplete typed fraction relation: %s',
  (control) => {
    const f = anonymousTypedFraction(control),
      r = reviewFinalNativeTableSources(f.input, f.fonts, f.rules, [], f.context)
    expect(r.unreliableMathSourceItems).toBeUndefined()
    expect(r.issues).not.toContain('native-table-structure-ambiguous')
    if (control === 'foreign') {
      const path = anonymousTypedFraction('nonbar'),
        blocked = reviewFinalNativeTableSources(
          path.input,
          path.fonts,
          path.rules,
          [],
          path.context
        )
      expect(blocked.unreliableMathSourceItems).toBeUndefined()
      expect(blocked.issues).not.toContain('native-table-structure-ambiguous')
    }
    if (control === 'numeral-font')
      for (const mode of ['bar-white', 'bar-alpha', 'numeral-white', 'numeral-alpha']) {
        const p = anonymousTypedFraction(mode),
          out = reviewFinalNativeTableSources(p.input, p.fonts, p.rules, [], p.context)
        expect(out.unreliableMathSourceItems).toBeUndefined()
        expect(out.issues).not.toContain('native-table-structure-ambiguous')
      }
  }
)
