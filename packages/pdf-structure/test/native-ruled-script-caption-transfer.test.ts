import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { applyRuledCaptionRecovery } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)

function input(): ReturnType<typeof JSON.parse> {
  const line = (
    text: string,
    x: number,
    y: number,
    width: number,
    em = 10
  ): ReturnType<typeof JSON.parse> => ({
    text,
    x,
    y,
    width,
    height: em,
    fontSize: em
  })
  const page = {
    pageNumber: 1,
    width: 612,
    height: 792,
    rotation: 0,
    invalidGraphicsBounds: 0,
    graphicsBounds: [],
    lines: [
      line('Table 1 Row budgets B', 374, 469, 102.4),
      line('B', 477, 468.4, 6, 7),
      line('q', 476.5, 474.4, 3.6, 7),
      line('and B', 487, 469, 27),
      line('R', 514.5, 468.4, 6, 7),
      line('q', 514, 474.4, 3.6, 7),
      line('per', 524.5, 469, 14.1),
      line('query operator.', 423, 481, 67),
      line('Operator Group', 400, 504, 109),
      ...[525, 545, 565].map((y) => line('Group 1 2', 400, y, 109))
    ]
  }
  return {
    page,
    rules: [
      [396, 501, 513, 501],
      [396, 518, 513, 518],
      [396, 583, 513, 583]
    ],
    old: {
      page: 1,
      lines: ['Table 1 Row budgets B B and B R per'],
      rect: [374, 468.4, 538.6, 479]
    },
    full: {
      page: 1,
      lines: ['Table 1 Row budgets B B q and B R q per', 'query operator.'],
      rect: [374, 468.4, 538.6, 491]
    }
  }
}
it('transfers only the complete same-native-row scripted title and its terminal line', () => {
  const f = input(),
    captions = [f.old]
  applyRuledCaptionRecovery(captions, [f.full], f.page, f.rules)
  expect(captions[0]).toEqual(f.full)
})
it.each([
  'unclosed-frame',
  'source-change',
  'foreign-script',
  'competing-candidate',
  'different-head',
  'foreign-tail'
])('does not transfer with %s', (reason) => {
  const f = input(),
    before = structuredClone(f.old)
  if (reason === 'unclosed-frame') f.rules.pop()
  if (reason === 'source-change') f.page.lines[0].text = 'Table 1 Different budgets B'
  if (reason === 'foreign-script') f.page.lines.push({ ...f.page.lines[2], x: 490, text: 'z' })
  if (reason === 'different-head') f.full.lines[0] = 'Table 1 Changed budgets B B q and B R q per'
  if (reason === 'foreign-tail') f.full.lines[1] = 'A fabricated terminal line.'
  applyRuledCaptionRecovery(
    [f.old],
    reason === 'competing-candidate' ? [f.full, structuredClone(f.full)] : [f.full],
    f.page,
    f.rules
  )
  expect(f.old).toEqual(before)
})
