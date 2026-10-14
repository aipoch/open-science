import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const regions = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-regions.mjs')).href
)
type Token = { text: string; rect: number[]; baseline: number; height: number; horizontal: boolean }
const token = (text: string, x: number, y: number, width = 10, height = 10): Token => ({
  text,
  rect: [x, y, x + width, y + height],
  baseline: y + height,
  height,
  horizontal: true
})
const caption = { page: 1, lines: ['Table 1: Symbolic records.'], rect: [10, 160, 240, 170] }
const source = (): Token[] => [
  token('Appendix', 10, 5, 100, 14),
  ...[0, 1, 2, 3].flatMap((n) => [
    token(String(n), 30, 40 + n * 25),
    token(':', 42, 40 + n * 25, 3),
    token('|s⟩', 70, 40 + n * 25, 40),
    token('a = b', 70, 52 + n * 25, 40),
    token('c = d', 135, 52 + n * 25, 40),
    token('e → f', 200, 52 + n * 25, 40)
  ]),
  token('Next section', 10, 200, 100, 14)
]
const recover = (
  items = source(),
  existing: object[] = [],
  captions = [caption]
): Array<{ cropRect: number[]; caption: typeof caption }> =>
  regions.recoverCaptionedBorderlessMathTables(items, [], captions, 1, existing)

it('keeps every aligned symbolic record in one image without inventing cells', () => {
  const result = recover()
  expect(result).toHaveLength(1)
  expect(result[0].cropRect).toEqual([28, 38, 242, 139])
  expect(result[0].caption).toEqual(caption)
  expect(result[0]).not.toHaveProperty('structure')
})

it('rejects missing boundary, broken sequence, prose in a gutter and an existing detector crop', () => {
  expect(recover(source().filter((i) => i.text !== 'Appendix'))).toEqual([])
  expect(recover(source().map((i) => (i.text === '2' ? { ...i, text: '7' } : i)))).toEqual([])
  expect(recover([...source(), token('body prose', 45, 85, 185)])).toEqual([])
  expect(recover(source(), [{ cropRect: [25, 35, 245, 140] }])).toEqual([])
  expect(recover(source(), [], [{ ...caption, page: 2 }])).toEqual([])
  for (const x of [-50, 260]) {
    const extraColumn = [0, 1, 2, 3].map((n) => token('g → h', x, 52 + n * 25, 40))
    expect(recover([...source(), ...extraColumn])).toEqual([])
  }
})

it('declines vector ink crossing the proposed image boundary', () => {
  const recoverWithInk = (rect: number[]): unknown =>
    regions.recoverCaptionedBorderlessMathTables(
      source(),
      [],
      [caption],
      1,
      [],
      [{ kind: 'path', rect }]
    )
  expect(recoverWithInk([65, 45, 120, 46])).toHaveLength(1)
  expect(recoverWithInk([20, 45, 120, 46])).toEqual([])
  expect(recoverWithInk([65, 45, 120, 180])).toEqual([])
  expect(recoverWithInk([260, 45, 300, 46])).toEqual([])
  for (const y of [34, 144]) {
    expect(recoverWithInk([30, y - 0.5, 240, y + 0.5])).toEqual([])
    expect(
      regions.recoverCaptionedBorderlessMathTables(source(), [[30, y, 240, y]], [caption], 1)
    ).toEqual([])
  }
})
