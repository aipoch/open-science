import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { proveNativeClosedMathOrder, recoverNativeClosedMathRuns } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-native-closed-math-order.mjs')).href
)
const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
type Token = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-closed-delimiter-and-raised-letter.jsonl'
    )
  )
const prove = (x: ReturnType<typeof JSON.parse>): ReturnType<typeof JSON.parse> =>
  proveNativeClosedMathOrder(x.table, x.items, x.captions, x.rules, x.observedRuns)

it('renders native interleaved delimiters and a uniquely raised right letter without changing owners', () => {
  const x = fixture(),
    before = JSON.stringify(x),
    p = prove(x),
    r = refineTable(x.table, x.items, x.captions, [], x.rules, x.observedRuns)
  expect(p.delimiters).toHaveLength(1)
  expect(p.scriptPairs).toHaveLength(1)
  expect(r.grid[1][0]).toBe('f (x)')
  const cell = r.cells.find((c: { row: number; column: number }) => c.row === 2 && c.column === 2)
  expect(cell.text).toBe('2z')
  expect(cell.textRuns).toEqual([
    { text: '2', position: 'normal' },
    { text: 'z', position: 'superscript' }
  ])
  expect(r.cells.flatMap((c: { sourceRects: number[][] }) => c.sourceRects).sort()).toEqual(
    x.items.map((i: Token) => i.rect).sort()
  )
  expect(r.unassigned).toEqual([])
  expect(JSON.stringify(x)).toBe(before)
})
it.each([
  'missing closing',
  'real whitespace glyph',
  'competing inner',
  'inner crosses native cut',
  'inner on another physical row'
])('refuses an unproved delimiter: %s', (variant) => {
  const x = fixture()
  if (variant === 'missing closing')
    x.rules = x.rules.filter((r: number[]) => !(r[1] === 170 && r[3] === 170))
  if (variant === 'real whitespace glyph') x.observedRuns[0].literalGlyphs = ['(', ' ', ')']
  const inner = x.items.find((i: Token) => i.text === 'x')
  if (variant === 'competing inner') x.items.push({ ...inner, text: 'q' })
  if (variant === 'inner crosses native cut') inner.rect = [77, 45, 84, 55]
  if (variant === 'inner on another physical row') {
    inner.rect = [32, 90, 37, 100]
    inner.baseline = 100
  }
  expect(prove(x)?.delimiters ?? []).toHaveLength(0)
})
it.each([
  'missing proof',
  'competing context',
  'unowned token',
  'foreign gap ink',
  'preposed script',
  'excess script gap'
])('keeps generic rendering without exact private context: %s', (variant) => {
  const x = fixture(),
    p = prove(x),
    descriptor = p.delimiters[0],
    pair = p.scriptPairs[0]
  let items = [...descriptor.tokens],
    runs = [{ text: 'f( )x', position: 'normal' }],
    proof = p
  if (variant === 'missing proof') proof = undefined
  if (variant === 'competing context') p.delimiters.push(descriptor)
  if (variant === 'unowned token') p.ownedTokens.delete(descriptor.inner)
  if (variant === 'foreign gap ink') {
    const token = { ...descriptor.inner, text: 'q' }
    items.push(token)
    descriptor.tokens.add(token)
    p.ownedTokens.add(token)
  }
  if (variant === 'preposed script' || variant === 'excess script gap') {
    items = [...pair.tokens]
    runs = [{ text: 'z 2', position: 'normal' }]
    pair.script.rect = variant === 'preposed script' ? [243, 94.5, 246, 101] : [260, 94.5, 263, 101]
  }
  expect(recoverNativeClosedMathRuns(items, runs, proof)).toBeUndefined()
})

it.each(['nan baseline', 'infinite height', 'nan rect', 'infinite gap'])(
  'refuses non-finite private source geometry: %s',
  (variant) => {
    const x = fixture(),
      p = prove(x),
      pair = p.scriptPairs[0]
    if (variant === 'nan baseline') pair.script.baseline = NaN
    if (variant === 'infinite height') pair.script.height = Infinity
    if (variant === 'nan rect') pair.script.rect[0] = NaN
    if (variant === 'infinite gap') {
      x.observedRuns[0].gaps[0].right = Infinity
      p.delimiters[0].gap.right = Infinity
      expect(prove(x)?.delimiters ?? []).toHaveLength(0)
      expect(
        recoverNativeClosedMathRuns(
          [...p.delimiters[0].tokens],
          [{ text: 'f( )x', position: 'normal' }],
          p
        )
      ).toBeUndefined()
    } else {
      expect(prove(x)).toBeUndefined()
      expect(
        recoverNativeClosedMathRuns([...pair.tokens], [{ text: '2 z', position: 'normal' }], p)
      ).toBeUndefined()
    }
  }
)
