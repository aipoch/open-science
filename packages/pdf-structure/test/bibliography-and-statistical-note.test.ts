import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-evidence.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-notes.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`test/fixtures/source-grids/${name}.jsonl`))

const ruledQualitativeTable = (): ReturnType<typeof JSON.parse> => {
  const grid = [
    ['Category', 'Sign', 'Upper group', 'Lower group'],
    ['Item A', '+', 'warm, bright', 'quiet, steady'],
    ['Item B', '−', 'calm, patient', 'quick, lively'],
    ['Item C', '+', 'clear, direct', 'soft, gentle']
  ]
  const tokens = grid.flatMap((row, rowIndex) =>
    row.map((text, column) => {
      const x = [60, 160, 220, 370][column],
        y = [110, 140, 170, 190][rowIndex],
        width = [70, 25, 100, 130][column]
      return {
        text,
        rect: [x, y, x + width, y + 10],
        baseline: y + 10,
        height: 10,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: rowIndex * 4 + column, text }
      }
    })
  )
  const note = {
    text: 'An independent explanation below the closing rule.',
    rect: [60, 212, 530, 222],
    baseline: 222,
    height: 10,
    horizontal: true
  }
  const external = ['7', '9', '11', 'Related prose (2001), (2004), and (2008).'].map(
    (text, index) => ({
      text,
      rect: [60, 300 + index * 20, 400, 310 + index * 20],
      baseline: 310 + index * 20,
      height: 10,
      horizontal: true
    })
  )
  const cuts = [50, 145, 205, 350, 520]
  return {
    table: {
      grid,
      cropRect: [45, 95, 525, 225],
      sourceViewport: { width: 600, height: 800, scale: 1.5 },
      rows: grid.map((_, row) => ({
        rect: [45, [110, 140, 170, 190][row], 525, [120, 150, 180, 200][row]]
      })),
      cells: tokens.map((token, index) => ({
        row: Math.floor(index / 4),
        column: index % 4,
        rowSpan: 1,
        colSpan: 1,
        text: token.text,
        rect: [cuts[index % 4], token.rect[1], cuts[(index % 4) + 1], token.rect[3]],
        sourceRects: [token.rect],
        sourceItems: [token.sourceItem]
      })),
      unassigned: [],
      clipped: [note],
      repairs: [],
      issues: ['text-crosses-crop-boundary']
    },
    tokens: [...tokens, note, ...external],
    rules: [100, 130, 210].map((y) => [50, y, 520, y])
  }
}

it('retains a completely owned ruled qualitative grid beside foreign citation prose', () => {
  const x = ruledQualitativeTable()
  expect(hasTableEvidence(x.table, undefined, x.tokens, x.rules)).toBe(true)
  expect(x.table.grid[1]).toEqual(['Item A', '+', 'warm, bright', 'quiet, steady'])
  expect(x.table.issues).toContain('text-crosses-crop-boundary')
})

it.each([
  'missing closing rule',
  'unowned frame text',
  'crossing note',
  'partial source box',
  'changed literal',
  'crossing column',
  'interleaved row owner',
  'unknown source owner',
  'unassigned source'
])('keeps bibliography rejection when native ownership has %s', (variant) => {
  const x = ruledQualitativeTable()
  if (variant === 'missing closing rule') x.rules.pop()
  if (variant === 'unowned frame text')
    x.tokens.push({
      text: 'stray',
      rect: [190, 155, 210, 165],
      height: 10,
      baseline: 165,
      horizontal: true
    })
  if (variant === 'crossing note') x.table.clipped[0].rect[1] = 205
  if (variant === 'partial source box') x.table.cells[4].sourceRects[0] = [60, 140, 95, 150]
  if (variant === 'changed literal') x.table.cells[4].text = 'Different item'
  if (variant === 'crossing column') x.table.cells[4].rect[2] = 100
  if (variant === 'interleaved row owner') {
    const first = x.table.cells[4],
      second = x.table.cells[8]
    ;[first.sourceRects, second.sourceRects] = [second.sourceRects, first.sourceRects]
    ;[first.text, second.text] = [second.text, first.text]
    ;[x.table.grid[1][0], x.table.grid[2][0]] = [x.table.grid[2][0], x.table.grid[1][0]]
  }
  if (variant === 'unknown source owner') delete x.tokens[4].sourceItem
  if (variant === 'unassigned source') x.table.unassigned.push('unowned')
  expect(hasTableEvidence(x.table, undefined, x.tokens, x.rules)).toBe(false)
})

it('rejects uncaptioned author-year reference columns without requiring clipped text', () => {
  const x = fixture('author-year-bibliography-columns')
  expect(hasTableEvidence(x.table, undefined, x.tokens)).toBe(false)
  expect(hasTableEvidence(x.table, { lines: ['Table 1. Study summaries.'] }, x.tokens)).toBe(true)
  x.table.grid.push(['24', '32'])
  expect(hasTableEvidence(x.table, undefined, x.tokens)).toBe(true)
})

it('retains a median/interquartile definition and its wrapped treatment glossary', () => {
  const x = fixture('median-interquartile-definition-note')
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toMatch(/^Data are expressed as median \(interquartile range\)/)
  expect(notes[0].text).toContain('CC: participants receiving active treatment.')
})

it.each(['inside', 'distant', 'prose'])(
  'does not collect a statistical note with %s evidence',
  (kind) => {
    const x = fixture('median-interquartile-definition-note')
    if (kind === 'inside') x.tables[0].rect[3] += 30
    if (kind === 'distant') x.page.lines.forEach((l: { y: number }) => (l.y += 100))
    if (kind === 'prose')
      x.page.lines.find((l: { text: string }) => l.text.startsWith('Data')).text =
        'Data are expressed differently in the discussion of median changes.'
    expect(associateTableNotes(x.page, x.tables, x.rules)[0]).toEqual([])
  }
)

it.each([
  [0, 4, 'ELSI', '‡'],
  [1, 3, 'SoFAS,', 'a Means'],
  [2, 4, 'Cr,', '***Comparing'],
  [3, 3, '*Dose', 'Abbreviations:'],
  [4, 2, 'ECOG PS,', '⁎ Log rank.']
])('preserves all notes in the ruled or inset glossary block %s', (index, count, first, last) => {
  const x = fixture('ruled-and-inset-glossary-blocks').cases[index]
  const notes = associateTableNotes(x.page, x.tables, x.rules)[0]
  expect(notes).toHaveLength(count)
  expect(notes[0].text.startsWith(first)).toBe(true)
  expect(notes.at(-1).text.startsWith(last)).toBe(true)
})

it.each(['no rule', 'no following footnote', 'distant footnote'])(
  'does not attach an isolated unlabelled definition with %s',
  (variant) => {
    const x = fixture('ruled-and-inset-glossary-blocks').cases[1]
    if (variant === 'no rule') x.rules = []
    if (variant === 'no following footnote')
      x.page.lines = x.page.lines.filter((l: { text: string }) => !l.text.startsWith('*'))
    if (variant === 'distant footnote')
      x.page.lines.find((l: { text: string }) => l.text.startsWith('*')).y += 80
    expect(
      associateTableNotes(x.page, x.tables, x.rules)[0].some((n: { text: string }) =>
        n.text.startsWith('SoFAS')
      )
    ).toBe(false)
  }
)
