/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captureAnonymousHeader } from './single-parent-math-header.mjs'
export async function anonymousDeclaredStubOwners(mode = '') {
  const text = (s, x, y, size = 10) => `BT /F ${size} Tf ${x} ${400 - y} Td (${s}) Tj ET`
  const gap = mode === 'double-fence' ? 2 : 0
  const rails = [100, 125, 180, ...(gap ? [182] : []), 235 + gap]
  const stream = [
    text('Table', 40, 75),
    text('1:', 68, 75),
    text('Anonymous', 80, 75),
    text('groups.', 140, 75),
    '0.5 w',
    ...rails
      .filter((y) => !(mode === 'missing-fence' && y === 180))
      .map((y) => `40 ${400 - y} m 270 ${400 - y} l S`),
    text('Group', 45, 115),
    text('Index', 125, 115),
    text('Value', 185, 115),
    text('Error', 235, 115),
    text(mode === 'quantity' ? '1' : 'Able', 45, 157),
    text('Beta', 45, 212 + gap),
    ...[145, 165, 200 + gap, 220 + gap].flatMap((y, n) => [
      text(`r${n + 1}`, 125, y),
      text(String(n + 2), 185, y),
      text(String(n + 6), 235, y)
    ]),
    ...(mode === 'foreign-glyph' ? [text('X', 90, 155)] : []),
    ...(mode === 'foreign-path' ? ['90 240 m 110 240 l S'] : [])
  ].join('\n')
  const f = await captureAnonymousHeader(stream, [59, 149, 406, (236 + gap) * 1.5])
  const source = f.items.filter(
    (t) => t.baseline > 150 && t.baseline <= (235 + gap) * 1.5 && t.text !== 'X'
  )
  const grid = [
    ['Group', 'Index', 'Value', 'Error'],
    ['', 'r1', '2', '6'],
    [mode === 'quantity' ? '1' : 'Able', 'r2', '3', '7'],
    ['', 'r3', '4', '8'],
    ['Beta', 'r4', '5', '9']
  ]
  const cells = []
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 4; c++) {
      const value = grid[r][c],
        token = source.find((t) => t.text === value)
      const rect = [60 + c * 80, r ? 180 + r * 25 : 151, 135 + c * 80, r ? 205 + r * 25 : 186]
      cells.push({
        row: r,
        column: c,
        rowSpan: 1,
        colSpan: 1,
        rect,
        origin: 'model-grid',
        text: value,
        ...(token ? { sourceItems: [token.sourceItem] } : {}),
        sourceRects: token ? [token.rect] : [],
        sourceTokens: token
          ? [Object.fromEntries(['text', 'rect', 'baseline', 'height'].map((k) => [k, token[k]]))]
          : []
      })
    }
  // Keep an already-declared rich header intact instead of rebuilding it.
  cells[0].textRuns = [{ text: 'Group', position: 'normal' }]
  f.table = {
    grid,
    cells,
    cropRect: f.table.cropRect,
    rows: grid.map((_, n) => ({
      rect: [59, 150 + n * 30, 406, 180 + n * 30],
      origin: 'model-grid'
    })),
    unassigned: [],
    clipped: [],
    issues: [],
    notes: [],
    repairs: [],
    reviewCandidate: true
  }
  return { ...f, tokens: f.items }
}
