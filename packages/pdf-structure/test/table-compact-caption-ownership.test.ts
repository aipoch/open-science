/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)

function fixture(twoRows = false) {
  const line = (text: string, x: number, y: number, width: number, height = 8) => ({
      text,
      x,
      y,
      width,
      height,
      fontSize: 8
    }),
    captions = [
      { page: 1, rect: [50, 50, 450, 60], lines: ['Table A1: Initial observations.'] },
      {
        page: 1,
        rect: [50, 158, 450, 176],
        lines: ['Table A2: Independent observations.', 'These measurements share their criterion.']
      }
    ],
    tables = [{ rect: [160, 79, 340, 151] }, { rect: [160, 187, 340, 248] }],
    rules = [
      [160, 80, 340, 80],
      [160, 100, 340, 100],
      [160, 150, 340, 150],
      [160, 188, 340, 188],
      [160, 212, 340, 212],
      [160, 244, 340, 244]
    ],
    page = {
      pageNumber: 1,
      width: 500,
      height: 600,
      lines: [
        line(captions[0].lines[0], 50, 50, 400, 10),
        line('Item Rate Count', 160, 79.5, 180),
        line('A 1 2', 160, 105, 180),
        line('B 3 4', 160, 119, 180),
        line('C 5 6', 160, 133, 180),
        line(captions[1].lines[0], 50, 158, 400),
        line(captions[1].lines[1], 50, 168, 400),
        line('Shared criterion', 250, 190, 80),
        line('Interval First Second', 160, 201, 180),
        ...(twoRows
          ? [line('x < 0.5 12 3', 160, 216, 180), line('x >= 0.5 4 9', 160, 228, 180)]
          : [
              line('A 1 2', 160, 214, 180),
              line('B 3 4', 160, 224, 180),
              line('C 5 6', 160, 234, 180)
            ])
      ]
    }
  return { page, tables, captions, rules }
}

it('keeps an independent above-caption despite a preceding header font crossing its opening rail', () => {
  const f = fixture(),
    before = structuredClone(f),
    result = associateTableCaptions(f.page, f.tables, f.captions, f.rules)
  expect(result.map((a: { caption: unknown }) => a.caption)).toEqual(f.captions)
  expect(f).toEqual(before)
})

it('owns a two-record table only through its complete independent stacked native layout', () => {
  const f = fixture(true),
    before = structuredClone(f),
    result = associateTableCaptions(f.page, f.tables, f.captions, f.rules)
  expect(result.map((a: { caption: unknown }) => a.caption)).toEqual(f.captions)
  expect(f).toEqual(before)
})

it.each([
  'opening',
  'divider',
  'closing',
  'header-crossing',
  'body-crossing',
  'terminal-crossing',
  'notes',
  'missing-parent',
  'series',
  'ordinal',
  'duplicate-title',
  'narrow-divider',
  'missing-font',
  'numeric-count',
  'record-extent'
])('retains conservative caption ambiguity after %s changes', (mode) => {
  const f = fixture(true),
    lines = f.page.lines
  if (mode === 'opening') f.rules.splice(3, 1)
  if (mode === 'divider') f.rules.splice(4, 1)
  if (mode === 'closing') f.rules.splice(5, 1)
  if (mode === 'header-crossing') lines[7].y = 186
  if (mode === 'body-crossing') lines[9].y = 210
  if (mode === 'terminal-crossing') lines[10].y = 242
  if (mode === 'notes')
    lines.push({ text: 'Unrelated notes.', x: 160, y: 224, width: 180, height: 8, fontSize: 8 })
  if (mode === 'missing-parent') lines.splice(7, 1)
  if (mode === 'series') f.captions[1].lines[0] = 'Table B2: Independent observations.'
  if (mode === 'ordinal') f.captions[1].lines[0] = 'Table A3: Independent observations.'
  if (mode === 'duplicate-title') f.captions.push(structuredClone(f.captions[1]))
  if (mode === 'narrow-divider') f.rules[4][0] += 5
  if (mode === 'missing-font') lines[9].fontSize = 0
  if (mode === 'numeric-count') lines[9].text = 'Group A 12 3'
  if (mode === 'record-extent') lines[9].width -= 10
  const result = associateTableCaptions(f.page, f.tables, f.captions, f.rules)
  expect(result[0].caption).toEqual(f.captions[0])
  expect(result[1].caption).toBeUndefined()
})
