import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { associateFigures, associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)

it.each(['Figure S1. Supplement', 'Supplementary Fig. 2: Details', '图 1：结果', '圖2. 結果'])(
  'recognizes figure caption format %s',
  (text) => expect(captionKind(text)).toBe('figure')
)
it.each(['Table S2. Results', 'Supplemental Table 3: Results', '表 2：结果'])(
  'recognizes table caption format %s',
  (text) => expect(captionKind(text)).toBe('table')
)
it('does not truncate a continuous long legend or absorb the next caption', () => {
  const lines = Array.from({ length: 25 }, (_, i) => ({
    text: i ? `Legend line ${i}` : 'Figure S1. Results',
    x: 10,
    y: i * 14,
    width: 180,
    height: 10,
    fontSize: 10
  }))
  lines.push({ ...lines[0], text: 'Table S2. Results', y: 350 })
  const result = findCaptionCandidates([{ pageNumber: 1, rotation: 0, lines }])
  expect(result[0].lines).toHaveLength(25)
  expect(result[0].lines.at(-1)).toBe('Legend line 24')
  expect(result).toHaveLength(2)
})

const page = {
  pageNumber: 1,
  width: 600,
  height: 800,
  invalidGraphicsBounds: 0,
  lines: [],
  graphicsBounds: [{ normalizedRect: [0.1, 0.25, 0.8, 0.5] }]
}
it.each([
  [60, 150, 480, 180],
  [60, 420, 480, 450]
])('associates a caption above or below the graphic', (...rect) => {
  const result = associateFigures(page, [{ page: 1, lines: ['Figure S1. Results'], rect }])
  expect(result[0].rect).toEqual([60, 200, 480, 400])
})
it('leaves equidistant captions unresolved and refuses to cross intervening prose', () => {
  const candidates = [
    { page: 1, lines: ['Figure 1. Above'], rect: [60, 150, 480, 180] },
    { page: 1, lines: ['Figure 2. Below'], rect: [60, 420, 480, 450] }
  ]
  expect(associateFigures(page, candidates).every((c: { rect?: number[] }) => !c.rect)).toBe(true)
  const blocked = {
    ...page,
    lines: [{ text: 'Body prose '.repeat(10), x: 60, y: 185, width: 420, height: 10 }]
  }
  expect(associateFigures(blocked, [candidates[0]])[0].rect).toBeUndefined()
})

const noteLine = (
  text: string,
  x: number,
  y: number,
  width = 170,
  fontSize = 9
): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
  text,
  x,
  y,
  width,
  height: fontSize,
  fontSize
})
it('keeps table notes with their source rectangle without taking neighboring column prose', () => {
  const notes = associateTableNotes(
    {
      ...page,
      lines: [
        noteLine('* Reported', 60, 510, 80),
        noteLine('23', 141, 508, 8, 7),
        noteLine('results.', 151, 510, 60),
        noteLine('Main text in the other column.', 340, 514, 200, 10),
        noteLine('Continuation of the note.', 60, 523),
        noteLine('New body paragraph.', 60, 550, 200, 11)
      ]
    },
    [{ rect: [60, 100, 300, 500] }]
  )
  expect(notes[0]).toEqual([
    { text: '* Reported 23 results. Continuation of the note.', rect: [60, 508, 230, 532] }
  ])
})
it('preserves separate footnotes even when the last note is farther from the table', () => {
  const result = associateTableNotes(
    {
      ...page,
      lines: [
        noteLine('* First note.', 60, 510),
        noteLine('First continuation.', 60, 523),
        noteLine('† Second note.', 60, 536),
        noteLine('Second continuation.', 60, 549),
        noteLine('‡ Third note.', 60, 562)
      ]
    },
    [{ rect: [60, 100, 300, 500] }]
  )
  expect(result[0].map((note: { text: string }) => note.text)).toEqual([
    '* First note. First continuation.',
    '† Second note. Second continuation.',
    '‡ Third note.'
  ])
  expect(result[0][2].rect).toEqual([60, 562, 230, 571])
})
it('does not assign a note to tied tables or cross the next table', () => {
  const lines = [noteLine('* A note.', 60, 510), noteLine('Another table row.', 60, 523)]
  expect(
    associateTableNotes({ ...page, lines }, [
      { rect: [60, 100, 300, 500] },
      { rect: [60, 100, 300, 500] }
    ])
  ).toEqual([[], []])
  expect(
    associateTableNotes({ ...page, lines }, [
      { rect: [60, 100, 300, 500] },
      { rect: [60, 520, 300, 600] }
    ])[0][0].text
  ).toBe('* A note.')
})

it('does not union graphics on opposite sides of one caption and silently crop one side', () => {
  const bothSides = {
    ...page,
    width: 200,
    height: 200,
    graphicsBounds: [
      { normalizedRect: [0.2, 0.2, 0.8, 0.4] },
      { normalizedRect: [0.2, 0.65, 0.8, 0.85] }
    ]
  }
  expect(
    associateFigures(bothSides, [
      { page: 1, lines: ['Figure 1. Results'], rect: [40, 100, 160, 110] }
    ])[0]
  ).toMatchObject({ reason: 'ambiguous-graphic-direction' })
})
it('never treats a marked cell of the next table as a preceding table note', () => {
  const result = associateTableNotes(
    { ...page, lines: [noteLine('* Second table cell', 60, 515)] },
    [{ rect: [60, 100, 300, 500] }, { rect: [60, 510, 300, 600] }]
  )
  expect(result).toEqual([[], []])
})
