import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { associateTableNotes, tableNoteOwnershipRect: recoveredNoteContext } = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_NOTES_REPLAY_MODULE ??
        'resources/pdf-structure/literature-pdf-table-notes.mjs'
    )
  ).href
)
const noteContext = recoveredNoteContext ?? ((_table: unknown, rect: number[]) => rect)
const line = (text: string, y: number, x = 44, width = 270, size = 8): Record<string, unknown> => ({
  text,
  x,
  y,
  width,
  height: size,
  fontSize: size
})
const fixture = (): ReturnType<typeof JSON.parse> => ({
  page: {
    width: 400,
    height: 600,
    lines: [
      line('AX (%) BX (%) CX Score (+) Score (–) Estimate CI M (SD)', 70, 44, 300),
      line('12 19 27 34 41 58', 188, 44, 280)
    ]
  },
  tables: [{ rect: [40, 60, 350, 198] }],
  rules: [[44, 203, 346, 203]]
})
const notes = (x: ReturnType<typeof fixture>): string =>
  associateTableNotes(x.page, x.tables, x.rules)[0]
    .map((n: { text: string }) => n.text)
    .join(' ')

it.each([
  ['parenthesized keys', 'AX (%): alpha quantity percentage; BX (%): beta quantity percentage.'],
  ['direction', 'Higher scores are associated with higher response levels.'],
  ['missing percentage', 'There was 3 to 4% missing data for some variables'],
  [
    'valid percentage',
    'Valid percentages (%) reported. Percentages may not add up to 100% due to rounding'
  ],
  [
    'effect definition',
    'Effect sizes were calculated for group differences in score at follow-up sessions, adjusted for baseline level of score. Bold numbers indicate medium effect sizes'
  ]
])('recovers the ruled external %s definition', (_name, text) => {
  const x = fixture()
  x.page.lines.push(line(text, 207))
  expect(notes(x)).toContain(text)
})

it('retains a two-line scale polarity note and its separate raised percentage note', () => {
  const x = fixture()
  x.page.lines.push(
    line(
      '(+)Indicates scales where higher scores = better functioning and (–) indicates scales',
      207
    ),
    line('where higher scores = poorer functioning or more symptoms', 217, 44, 190),
    line('a', 228, 44, 3, 5),
    line('23% Missing data for this variable', 229, 48, 130),
    line('b', 240, 44, 3, 5),
    line('Reference entries were grouped', 241, 48, 140)
  )
  expect(notes(x)).toContain('where higher scores = poorer functioning or more symptoms')
  expect(notes(x)).toContain('a 23% Missing data for this variable')
})

it('retains the terminal single equation and a separately bounded method paragraph', () => {
  const x = fixture()
  x.page.lines.push(
    line('AX = alpha quantity; BX = 7-item beta quantity. CX = combined quantity; M = mean;', 207),
    line('SD = standard deviation.', 217, 44, 90),
    line('The parameter estimates were calculated using a linear model', 227),
    line('and maximum likelihood estimation. Values reported in the table', 237),
    line('are estimates for the original transformed outcomes.', 247),
    line('The linear term refers to changes since the', 257),
    line('baseline assessment.', 267, 44, 80)
  )
  expect(notes(x)).toContain('SD = standard deviation.')
  expect(notes(x)).toContain('maximum likelihood estimation')
  expect(notes(x)).toContain('baseline assessment.')
})

it('retains cited numeric glossary keys with a wrapped expansion and typography note', () => {
  const x = fixture()
  x.page.lines[0].text = 'AX T4 T8 N (%)'
  x.page.lines.push(
    line('AX alpha quantity, T4 before measurement, T8 after the', 207),
    line('final measurement', 217, 44, 85),
    line('Percentages are in italics', 229, 44, 90)
  )
  expect(notes(x)).toContain('final measurement')
  expect(notes(x)).toContain('Percentages are in italics')
})

it.each([
  'no closing',
  'prose between',
  'large font',
  'outside column',
  'uncited keys',
  'competing owner'
])('rejects footer recovery with %s', (variant) => {
  const x = fixture()
  x.page.lines.push(
    line('AX (%): alpha quantity percentage; BX (%): beta quantity percentage.', 207)
  )
  if (variant === 'no closing') x.rules = []
  if (variant === 'prose between')
    x.page.lines.push(line('An ordinary paragraph starts here.', 199))
  if (variant === 'large font') x.page.lines.at(-1).fontSize = x.page.lines.at(-1).height = 12
  if (variant === 'outside column') x.page.lines.at(-1).x = 360
  if (variant === 'uncited keys') x.page.lines[0].text = 'Weight Height Estimate CI'
  if (variant === 'competing owner') x.tables.push(structuredClone(x.tables[0]))
  expect(notes(x)).not.toContain('alpha quantity percentage')
})

it('preserves the source note strip enclosed by two thin native paths', () => {
  const x = fixture()
  x.rules = []
  x.page.graphicsBounds = [
    { kind: 'path', normalizedRect: [0.11, 0.338, 0.865, 0.342] },
    { kind: 'path', normalizedRect: [0.11, 0.366, 0.865, 0.37] }
  ]
  x.page.lines.push(
    line('Values are expressed as percentages or means ± SD.', 207, 48, 170),
    line('1', 206, 219, 3, 5),
    line('All entries use a common reference.', 207, 223, 110)
  )
  expect(notes(x)).toContain('Values are expressed as percentages')
  expect(notes(x)).toContain('¹ All entries use a common reference.')
  x.page.graphicsBounds.pop()
  expect(notes(x)).not.toContain('All entries use a common reference')
})

const inkContextFixture = (): ReturnType<typeof JSON.parse> => {
  const x = fixture()
  x.rules = []
  x.tables[0].rect[3] = 205
  x.page.graphicsBounds = [
    { kind: 'path', normalizedRect: [0.11, 0.338, 0.865, 0.342] },
    { kind: 'path', normalizedRect: [0.11, 0.366, 0.865, 0.37] }
  ]
  x.page.lines.push(
    line('Values are expressed as percentages or means ± SD.', 207, 48, 170),
    line('1', 206, 219, 3, 5),
    line('All entries use a common reference.', 207, 223, 110)
  )
  const scale = 1.5,
    items = x.page.lines
      .slice(0, 2)
      .map((l: { text: string; x: number; y: number; width: number; height: number }) => ({
        text: l.text,
        horizontal: true,
        rect: [l.x, l.y, l.x + l.width, l.y + l.height].map((v) => v * scale)
      })),
    table = {
      cropRect: x.tables[0].rect.map((v: number) => v * scale),
      cells: items.map((i: { rect: number[] }) => ({ sourceRects: [i.rect] })),
      unassigned: []
    }
  return { ...x, table, items, scale }
}

it('uses uniquely owned ink only for note context when the last row reaches a coarse closing path', () => {
  const x = inkContextFixture(),
    original = structuredClone(x),
    rect = noteContext(x.table, x.tables[0].rect, x.scale, x.items)
  expect(rect).toEqual([40, 60, 350, 196])
  const text = associateTableNotes(x.page, [{ rect }], x.rules)[0]
    .map((n: { text: string }) => n.text)
    .join(' ')
  expect(text).toContain('Values are expressed as percentages')
  expect(text).toContain('¹ All entries use a common reference.')
  expect(x).toEqual(original)
})

it.each([
  'unassigned ink',
  'duplicate ownership',
  'missing ownership',
  'foreign ownership',
  'outside crop',
  'invalid scale',
  'missing native items',
  'missing paired path',
  'intervening prose'
])('preserves note gates with %s', (kind) => {
  const x = inkContextFixture()
  if (kind === 'unassigned ink') x.table.unassigned.push({ rect: x.items[0].rect })
  if (kind === 'duplicate ownership') x.table.cells.push(x.table.cells[0])
  if (kind === 'missing ownership') x.table.cells.pop()
  if (kind === 'foreign ownership') x.table.cells[0].sourceRects[0] = [70, 90, 100, 105]
  if (kind === 'outside crop') x.table.cropRect[3] = 290
  if (kind === 'invalid scale') x.scale = 0
  if (kind === 'missing native items') x.items = []
  if (kind === 'missing paired path') x.page.graphicsBounds.pop()
  if (kind === 'intervening prose')
    x.page.lines.push(line('An ordinary paragraph starts here.', 198))
  const rect = noteContext(x.table, x.tables[0].rect, x.scale, x.items)
  if (!['missing paired path', 'intervening prose'].includes(kind))
    expect(rect).toEqual(x.tables[0].rect)
  const text = associateTableNotes(x.page, [{ rect }], x.rules)[0]
    .map((n: { text: string }) => n.text)
    .join(' ')
  expect(text).not.toContain('All entries use a common reference')
})

it('does not append ordinary prose or a standalone uncited equation to a glossary', () => {
  const x = fixture()
  x.page.lines.push(
    line('AX (%): alpha quantity percentage; BX (%): beta quantity percentage;', 207),
    line('The investigators reviewed every response.', 217),
    line('ZX = isolated quantity.', 227)
  )
  expect(notes(x)).not.toContain('investigators')
  expect(notes(x)).not.toContain('isolated quantity')
})
