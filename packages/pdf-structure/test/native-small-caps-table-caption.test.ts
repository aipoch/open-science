import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { smallCapsTableCaption: fixture } = await import(
  pathToFileURL(resolve('test/fixtures/small-caps-table-caption.mjs')).href
)
const { recoverNativeMixedFontCaptionTail: recover } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)

it('closes a centered small-caps table title using its native font and segmented header frame', () => {
  const f = fixture(),
    before = JSON.stringify(f),
    out = recover(f.caption, f.page, f.tokens, f.context)
  expect(out?.lines).toEqual([...f.caption.lines, 'REFERENCE GROUPS'])
  expect(out?.rect).toEqual([f.caption.rect[0], f.caption.rect[1], f.caption.rect[2], 98.2])
  expect(JSON.stringify(f)).toBe(before)
})

it.each([
  ['missing opening', { missingOpening: true }],
  ['missing closing', { missingClosing: true }],
  ['foreign prose', { prose: true }],
  ['foreign point', { tailSize: 7.2 }],
  ['foreign font', { tailFont: 'G' }],
  ['off center', { offset: 5 }],
  ['header below opening', { tailBaseline: 110 }]
])('does not absorb an unproved small-caps row: %s', (_name, options) => {
  const f = fixture(options)
  expect(recover(f.caption, f.page, f.tokens, f.context)).toBeUndefined()
})

it.each([
  'foreign glyph',
  'foreign paint',
  'incomplete inventory',
  'changed source',
  'changed operator',
  'already complete'
])('retains caption boundaries with %s', (fault) => {
  const f = fixture()
  if (fault === 'foreign glyph') {
    f.text('X', 110, 95, 6.4)
    f.tokens = f.refresh()
  }
  if (fault === 'foreign paint') f.fill([110, 93, 115, 94])
  if (fault === 'incomplete inventory') f.context.glyphBounds = []
  if (fault === 'changed source') f.context.content.items[2].sourceItem.index = 0
  if (fault === 'changed operator') f.context.operators.argsArray[3][0][4] += 1
  if (fault === 'already complete') f.caption.lines.push('REFERENCE GROUPS')
  expect(recover(f.caption, f.page, f.tokens, f.context)).toBeUndefined()
})
