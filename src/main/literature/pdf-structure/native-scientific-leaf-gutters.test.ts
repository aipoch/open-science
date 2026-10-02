import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { proveNativeScientificLeafGutters, recoverNativeScientificLeafRecordGrid } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-native-scientific-leaf-gutters.mjs')
  ).href
)
const { nativeWhitespaceGaps, splitPdfNumericRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-symbol-text.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-repeated-leaf-gutters-with-joined-header.jsonl'
    )
  )
it('proves repeated larger native header spaces and adopts only complete source records', () => {
  const x = fixture(),
    before = JSON.stringify(x),
    proof = proveNativeScientificLeafGutters(x.table, x.items, x.captions, x.rules, x.nativeRuns)
  expect(proof?.gutterBands.slice(-3)).toEqual([
    [404.99, 410.01],
    [484.99, 490.01],
    [564.99, 570.01]
  ])
  expect(
    recoverNativeScientificLeafRecordGrid(x.table, x.items, x.captions, x.rules, proof)
  ).toBeUndefined()
  const joined = x.items[4]
  x.items.splice(
    4,
    1,
    ...['Gate One', 'Gate Two', 'Gate Three', 'Gate Four'].map((text, c) => ({
      ...joined,
      text,
      rect: [350 + c * 80, 45, 395 + c * 80, 55]
    }))
  )
  const post = proveNativeScientificLeafGutters(x.table, x.items, x.captions, x.rules),
    grid = recoverNativeScientificLeafRecordGrid(x.table, x.items, x.captions, x.rules, post)
  expect(grid?.rows).toHaveLength(11)
  expect(grid?.columns).toHaveLength(8)
  expect(grid?.ownedTokens.size).toBe(x.items.length)
  expect(grid?.cropRect).toEqual(x.table.cropRect)
  const result = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(result.grid).toHaveLength(11)
  expect(result.grid[0].slice(4)).toEqual(['Gate One', 'Gate Two', 'Gate Three', 'Gate Four'])
  expect(result.grid[1][3]).toBe('1.0+0.2−0.3')
  expect(result.unassigned).toEqual([])
  expect(
    result.cells
      .flatMap((c: { sourceRects: number[][] }) => c.sourceRects ?? [])
      .map((r: number[]) => JSON.stringify(r))
      .sort()
  ).toEqual(x.items.map((i: { rect: number[] }) => JSON.stringify(i.rect)).sort())
  expect(JSON.stringify(fixture())).toBe(before)
})
it.each([
  'no caption',
  'competing caption',
  'no closing',
  'unequal rule ends',
  'too few anchors',
  'irregular leading',
  'missing status',
  'foreign prose',
  'crossing foreign ink',
  'competing header gap',
  'unmeasured header',
  'incorrect header extent',
  'different header gap'
])('rejects incomplete scientific lane evidence: %s', (variant) => {
  const x = fixture()
  if (variant === 'no caption') x.captions = []
  if (variant === 'competing caption') x.captions.push(structuredClone(x.captions[0]))
  if (variant === 'no closing') x.rules.pop()
  if (variant === 'unequal rule ends') x.rules[2][2] -= 2
  if (variant === 'too few anchors')
    x.items = x.items.filter((i: { text: string }) => !['100008', '100009'].includes(i.text))
  if (variant === 'irregular leading')
    x.items.find((i: { text: string }) => i.text === '100003').baseline += 3
  if (variant === 'missing status')
    x.items.splice(
      x.items.findIndex((i: { text: string }) => i.text === 'On'),
      1
    )
  if (variant === 'foreign prose')
    x.items.push({
      text: 'Unrelated prose',
      rect: [200, 123.75, 400, 133.75],
      baseline: 133.75,
      height: 10,
      horizontal: true
    })
  if (variant === 'crossing foreign ink')
    x.items.push({
      text: 'Outside',
      rect: [10, 100, 50, 110],
      baseline: 110,
      height: 10,
      horizontal: true
    })
  if (variant === 'competing header gap')
    x.nativeRuns[0].gaps.push({ left: 420, right: 424.9, index: 9 })
  if (variant === 'unmeasured header') x.nativeRuns = []
  if (variant === 'incorrect header extent') x.nativeRuns[0].rect[2] += 1
  if (variant === 'different header gap') x.nativeRuns[0].gaps[3].right += 0.3
  expect(
    proveNativeScientificLeafGutters(x.table, x.items, x.captions, x.rules, x.nativeRuns)
  ).toBeUndefined()
})
const stream = (): ReturnType<typeof JSON.parse> => {
  const glyph = (unicode: string): { unicode: string; width: number } => ({ unicode, width: 500 })
  return {
    content: {
      items: [
        {
          str: 'Alpha Beta',
          dir: 'ltr',
          fontName: 'AnonFont',
          transform: [10, 0, 0, 10, 20, 100],
          width: 50,
          height: 10
        }
      ]
    },
    operators: {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [
        ['AnonFont', 10],
        [
          [...'Alpha']
            .map(glyph)
            .concat([-500] as never)
            .concat([...'Beta'].map(glyph))
        ]
      ]
    },
    viewport: { rotation: 0, scale: 1, convertToViewportPoint: (x: number, y: number) => [x, y] }
  }
}
it('observes original whitespace from measured TJ advances without changing source content', () => {
  const x = stream(),
    before = JSON.stringify(x.content),
    runs = nativeWhitespaceGaps(x.content, x.operators, x.viewport)
  expect(runs[0].gaps).toEqual([{ left: 45, right: 50, index: 5 }])
  expect(JSON.stringify(x.content)).toBe(before)
  const split = splitPdfNumericRuns(x.content, x.operators, {
    viewport: x.viewport,
    provenFrames: [{ rect: [0, 80, 100, 120], cuts: [47.5], gutterBands: [[44.99, 50.01]] }]
  })
  expect(split.items.map((i: { str: string }) => i.str)).toEqual(['Alpha', 'Beta'])
})
it('counts astral source glyphs once and preserves ordinary word spacing', () => {
  const x = stream()
  x.content.items[0].str = '🧪Alpha Beta'
  x.content.items[0].width += 5
  x.operators.argsArray[1][0].unshift({ unicode: '🧪', width: 500 })
  expect(nativeWhitespaceGaps(x.content, x.operators, x.viewport)[0].gaps).toEqual([
    { left: 50, right: 55, index: 6 }
  ])
  x.operators.argsArray[1][0][6] = -250
  x.content.items[0].width -= 2.5
  expect(nativeWhitespaceGaps(x.content, x.operators, x.viewport)[0].gaps).toEqual([
    { left: 50, right: 52.5, index: 6 }
  ])
})
it.each([
  'no source whitespace',
  'wrong native stream',
  'wrong extent',
  'rotated viewport',
  'rotated source',
  'ambiguous local stream'
])('declines unproven native whitespace: %s', (variant) => {
  const x = stream()
  if (variant === 'no source whitespace') x.content.items[0].str = 'AlphaBeta'
  if (variant === 'wrong native stream') x.operators.argsArray[1][0][0].unicode = 'Z'
  if (variant === 'wrong extent') x.content.items[0].width += 1
  if (variant === 'rotated viewport') x.viewport.rotation = 90
  if (variant === 'rotated source') x.content.items[0].transform = [0, 10, -10, 0, 20, 100]
  if (variant === 'ambiguous local stream')
    x.operators.argsArray[1][0].push(...x.operators.argsArray[1][0])
  expect(
    nativeWhitespaceGaps(x.content, x.operators, x.viewport).flatMap(
      (r: { gaps: unknown[] }) => r.gaps
    )
  ).toEqual([])
})
