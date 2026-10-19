import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { recoverPriorPageTableCaption } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-group.mjs')).href
)
type Page = {
  pageNumber: number
  width: number
  height: number
  lines: { text: string; x: number; y: number; width: number; height: number }[]
}
function input(): {
  previous: Page
  page: Page
  captions: { page: number; lines: string[]; rect: number[] }[]
  table: { cropRect: number[]; structure: { objects: { label: string }[] } }
  rules: number[][]
  tokens: { text: string; horizontal: boolean; height: number; rect: number[] }[]
} {
  const previous = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text: 'Table 4. Native descriptors.', x: 50, y: 720, width: 220, height: 10 }]
  }
  const page = {
    pageNumber: 2,
    width: 600,
    height: 800,
    lines: [{ text: 'Table 5. Native records.', x: 50, y: 720, width: 200, height: 10 }]
  }
  const captions = [
    { page: 1, lines: [previous.lines[0].text], rect: [50, 720, 270, 730] },
    { page: 2, lines: [page.lines[0].text], rect: [50, 720, 250, 730] }
  ]
  const table = {
    cropRect: [75, 100, 825, 600],
    structure: { objects: Array.from({ length: 3 }, () => ({ label: 'table column' })) }
  }
  const rules = [
    [75, 110, 825, 110],
    [75, 150, 825, 150],
    ...[75, 300, 600, 825].map((x) => [x, 110, x, 150])
  ]
  const tokens = ['Key', 'Descriptor', 'Unit'].map((text, i) => ({
    text,
    horizontal: true,
    height: 15,
    rect: [100 + i * 250, 120, 170 + i * 250, 135]
  }))
  return { previous, page, captions, table, rules, tokens }
}
it('uses the unique terminal title above a next-page native closed header', () => {
  const s = input()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules,
      s.page,
      [s.previous, s.page],
      s.captions,
      s.captions[1]
    )
  ).toBe(s.captions[0])
})
it('rejects a missing native cut, competing prior title, nonterminal prose, or current title above the frame', () => {
  const s = input()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules.slice(0, -1),
      s.page,
      [s.previous, s.page],
      s.captions,
      s.captions[1]
    )
  ).toBeUndefined()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules,
      s.page,
      [s.previous, s.page],
      [...s.captions, { ...s.captions[0], lines: ['Table 6. Another title.'] }],
      s.captions[1]
    )
  ).toBeUndefined()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules,
      s.page,
      [
        {
          ...s.previous,
          lines: [
            ...s.previous.lines,
            { text: 'A separate body paragraph.', x: 50, y: 740, width: 250, height: 10 }
          ]
        },
        s.page
      ],
      s.captions,
      s.captions[1]
    )
  ).toBeUndefined()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules,
      s.page,
      [s.previous, s.page],
      s.captions,
      { ...s.captions[1], rect: [50, 30, 250, 40] }
    )
  ).toBeUndefined()
  expect(
    recoverPriorPageTableCaption(
      s.table,
      s.tokens,
      s.rules,
      s.page,
      [s.previous, s.page],
      [
        ...s.captions,
        { page: 2, lines: ['Table 8. A native header title.'], rect: [50, 35, 250, 45] }
      ],
      undefined
    )
  ).toBeUndefined()
})
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)

const narrowRecords = (narrative = false): ReturnType<typeof JSON.parse> => {
  const viewport = {
    width: 600,
    height: 800,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 800],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
  }
  const items: object[] = [],
    operators = {
      fnArray: [OPS.dependency, OPS.setLineWidth] as number[],
      argsArray: [['font'], [0.5]] as unknown[]
    }
  const grid = [
    ['Label', 'Count'],
    ['Item A', narrative ? 'one' : '1'],
    ['Item B', narrative ? 'two' : '2'],
    ['Item C', narrative ? 'six' : '3']
  ]
  for (const [row, values] of grid.entries())
    for (const [column, str] of values.entries()) {
      const x = column ? 365 : 210,
        baseline = 44 + row * 24
      items.push({
        str,
        dir: 'ltr',
        fontName: 'font',
        transform: [10, 0, 0, 10, x, 800 - baseline],
        width: str.length * 5,
        height: 10,
        sourceItem: { pageNumber: 2, index: items.length, text: str }
      })
      operators.fnArray.push(
        OPS.setFont,
        OPS.beginText,
        OPS.setTextMatrix,
        OPS.showText,
        OPS.endText
      )
      operators.argsArray.push(
        ['font', 10],
        null,
        [new Float32Array([1, 0, 0, 1, x, 800 - baseline])],
        [
          [...str].map((unicode) => ({
            unicode,
            fontChar: unicode,
            originalCharCode: unicode.charCodeAt(0),
            width: 500,
            isInFont: true,
            operatorListId: null
          }))
        ],
        null
      )
    }
  const lines = [30, 50, 126].map((y) => [210, y, 390, y])
  for (const [x, y, right] of lines) {
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, x, 800 - y, 1, right, 800 - y])],
      new Float32Array([x, 800 - y, right, 800 - y])
    ])
  }
  const tokens = items.map((i) => tableTextToken(i, viewport, 0)),
    paint = new Map(),
    rules = collectTableRules(operators, viewport, paint)
  const cells = tokens.map((t: ReturnType<typeof JSON.parse>, i: number) => ({
    row: Math.floor(i / 2),
    column: i % 2,
    rowSpan: 1,
    colSpan: 1,
    text: t.text,
    sourceItems: [t.sourceItem],
    sourceRects: [t.rect]
  }))
  const table = {
    cropRect: [209, 29, 391, 127],
    grid,
    cells,
    unassigned: [],
    clipped: [],
    notes: [],
    issues: []
  }
  const content = { items, styles: { font: { ascent: 0.8, descent: -0.2, vertical: false } } }
  const nativeContext = {
    viewport,
    content,
    sourceContent: content,
    operators,
    rulePaintBounds: paint,
    nativeEvidenceGraphics: lines.map((r) => ({
      kind: 'path',
      rect: [r[0] - 0.25, r[1] - 0.25, r[2] + 0.25, r[3] + 0.25].map((v, k) => {
        const span = k % 2 ? 800 : 600
        return (
          ((k < 2 ? Math.floor((v / span) * 256) : Math.ceil((v / span) * 256) + 1) * span) / 256
        )
      })
    }))
  }
  const caption = { page: 1, lines: ['Table 2. Sample counts'], rect: [80, 650, 230, 662] },
    previous = {
      pageNumber: 1,
      width: 600,
      height: 800,
      lines: [{ text: caption.lines[0], x: 80, y: 650, width: 150, height: 12 }]
    },
    page = { pageNumber: 2, rotation: 0, renderRotation: 0, width: 600, height: 800, lines: [] }
  return {
    table,
    tokens,
    rules,
    page,
    previous,
    captions: [caption],
    context: { tables: [table], nativeContext }
  }
}
const recoverNarrow = (s: ReturnType<typeof JSON.parse>): unknown =>
  recoverPriorPageTableCaption(
    s.table,
    s.tokens,
    s.rules,
    s.page,
    [s.previous, s.page],
    s.captions,
    s.currentCaption,
    s.context
  )
it('associates a terminal prior title with a complete narrow native count table without changing cells', () => {
  const s = narrowRecords(),
    before = structuredClone(s.table)
  expect(recoverNarrow(s)).toBe(s.captions[0])
  expect(s.table).toEqual(before)
})
it.each([
  'no-context',
  'peer',
  'unknown-peer',
  'null-cell',
  'source',
  'partial-cell',
  'duplicate-cell',
  'span',
  'source-alias',
  'foreign-font',
  'paint',
  'rule',
  'local-caption',
  'nonterminal',
  'two-titles',
  'sparse-record',
  'narrative',
  'overlap',
  'unknown-font',
  'wrong-page',
  'wrong-page-size',
  'wrong-rotation',
  'preceding-prose'
])('requires complete narrow-table association evidence: %s', (variant) => {
  const s = narrowRecords(variant === 'narrative')
  if (variant === 'no-context') s.context = undefined
  if (variant === 'peer') s.context.tables.push({ cropRect: [400, 29, 580, 127] })
  if (variant === 'unknown-peer') s.context.tables.push(null)
  if (variant === 'null-cell') s.table.cells[0] = null
  if (variant === 'source') s.table.cells[0].sourceItems[0].text = 'Unknown'
  if (variant === 'partial-cell') s.table.cells.pop()
  if (variant === 'duplicate-cell') s.table.cells.push(s.table.cells[0])
  if (variant === 'span') s.table.cells[0].colSpan = 2
  if (variant === 'source-alias') s.tokens.push({ ...s.tokens[0], rect: [1, 200, 30, 210] })
  if (variant === 'foreign-font')
    s.context.nativeContext.sourceContent.items.push({
      ...s.context.nativeContext.sourceContent.items[0],
      str: 'Extra',
      sourceItem: { pageNumber: 2, index: 100, text: 'Extra' }
    })
  if (variant === 'paint') {
    s.context.nativeContext.operators.fnArray.push(OPS.paintImageXObject)
    s.context.nativeContext.operators.argsArray.push(['image', 10, 10])
  }
  if (variant === 'rule') s.rules.splice(1, 1)
  if (variant === 'local-caption')
    s.currentCaption = { page: 2, lines: ['Table 3. Local'], rect: [80, 5, 230, 17] }
  if (variant === 'nonterminal')
    s.previous.lines.push({ text: 'Further prose', x: 80, y: 690, width: 150, height: 12 })
  if (variant === 'two-titles') s.captions.push({ ...s.captions[0], lines: ['Table 3. Another'] })
  if (variant === 'sparse-record') {
    s.table.grid[1][1] = ''
    s.table.cells[3].text = ''
  }

  if (variant === 'overlap') s.table.cells[3].row = 2
  if (variant === 'unknown-font') s.context.nativeContext.content.styles.font.vertical = true
  if (variant === 'wrong-page') s.page.pageNumber = 3
  if (variant === 'wrong-page-size') s.page.width = 610
  if (variant === 'wrong-rotation') s.page.rotation = 90
  if (variant === 'preceding-prose')
    s.page.lines.push({ text: 'Ordinary prose', x: 80, y: 5, width: 150, height: 12 })
  expect(recoverNarrow(s)).toBeUndefined()
})
