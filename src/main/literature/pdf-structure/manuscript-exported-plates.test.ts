import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const { excludePdfLineNumbers, groupPageLines, captionKind } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { matchFigureSequence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-sequence.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/manuscript-legends-and-native-exported-plates.jsonl'
    )
  )
const pages = (): ReturnType<typeof JSON.parse> =>
  fixture().pages.map((p: ReturnType<typeof JSON.parse>) => ({
    ...p,
    lines: groupPageLines({
      lines: excludePdfLineNumbers(
        { items: p.items },
        {
          width: p.width,
          convertToViewportPoint: (x: number, y: number): number[] => [x, p.height - y]
        }
      )
        .items.filter((i: ReturnType<typeof JSON.parse>) => i.str?.trim())
        .map((i: ReturnType<typeof JSON.parse>) => ({
          text: i.str,
          x: i.transform[4],
          y: p.height - i.transform[5] - i.height,
          width: i.width,
          height: i.height,
          fontSize: i.height
        }))
    })
  }))
it('matches an exact native plate sequence and removes only consecutive margin line numbers', () => {
  const source = pages()
  const result = matchFigureSequence(source)
  expect([...result.keys()]).toEqual([24, 25, 26, 27])
  expect(result.get(24).lines.join(' ')).toContain('standardized breakfast meal.')
  expect(result.get(27).lines.at(-1)).toBe('area under the curve')
  expect(source[0].lines.map((l: { text: string }) => l.text).join(' ')).not.toMatch(
    /81[0-9]|82[0-4]/
  )
  expect(source[3].lines.some((l: { text: string }) => /\b80\b/.test(l.text))).toBe(true)
})
it.each(['missing-plate', 'same-page-box', 'no-graphics', 'body-prose'])(
  'declines an ambiguous sequence: %s',
  (mode) => {
    const source = pages()
    if (mode === 'missing-plate') source.pop()
    if (mode === 'same-page-box')
      Object.assign(source[1], { width: source[0].width, height: source[0].height })
    if (mode === 'no-graphics') source[1].graphicCount = 0
    if (mode === 'body-prose')
      source[1].lines.push({ text: 'A paragraph of ordinary body prose. '.repeat(5) })
    expect(matchFigureSequence(source).size).toBe(0)
  }
)
it('does not classify an inline chart reference as a caption', () => {
  expect(captionKind('Chart 1 shows the distribution of subjects.')).toBeUndefined()
  expect(captionKind('Chart 1. Distribution of subjects')).toBe('figure')
})

const indexedNativeTable = (): ReturnType<typeof JSON.parse> => ({
  items: Array.from({ length: 8 }, (_, n) => [
    { str: String(n + 1), height: 8, width: 4, transform: [8, 0, 0, 8, 42, 690 - n * 10] },
    {
      str: 'An anonymized descriptive table record.',
      height: 8,
      width: 210,
      transform: [8, 0, 0, 8, 60, 690 - n * 10]
    }
  ]).flat()
})
const indexViewport = {
  width: 595,
  convertToViewportPoint: (x: number, y: number): number[] => [x, 800 - y]
}
const indexedTableProof = (): ReturnType<typeof JSON.parse> => ({
  tableRects: [[36, 94, 286, 185]],
  captions: [{ lines: ['Table 1', 'Descriptive records.'], rect: [42, 80, 210, 92] }],
  rules: [
    [42, 100, 280, 100],
    [42, 182, 280, 182]
  ]
})

it('preserves numbered records inside a uniquely captioned native table frame', () => {
  const content = indexedNativeTable()
  expect(excludePdfLineNumbers(content, indexViewport, indexedTableProof()).items).toEqual(
    content.items
  )
  expect(excludePdfLineNumbers(content, indexViewport).items).toHaveLength(8)
})

it('keeps ruled indexed records when the unique caption slightly overhangs both native borders', () => {
  const content = indexedNativeTable(),
    proof = indexedTableProof()
  proof.captions[0].rect = [33, 80, 291, 92]
  expect(excludePdfLineNumbers(content, indexViewport, proof).items).toEqual(content.items)
})

it.each(['wide-caption', 'neighbor-caption'])(
  'keeps manuscript filtering for an unowned overhanging caption: %s',
  (mode) => {
    const content = indexedNativeTable(),
      proof = indexedTableProof()
    proof.captions[0].rect = mode === 'wide-caption' ? [20, 80, 305, 92] : [282, 80, 340, 92]
    expect(excludePdfLineNumbers(content, indexViewport, proof).items).toHaveLength(8)
  }
)

it.each(['opening', 'footer', 'caption', 'model', 'competing-caption', 'outside-body'])(
  'does not exempt a margin sequence without complete table proof: %s',
  (mode) => {
    const proof = indexedTableProof(),
      content = indexedNativeTable()
    if (mode === 'opening') proof.rules.shift()
    if (mode === 'footer') proof.rules.pop()
    if (mode === 'caption') proof.captions = []
    if (mode === 'model') proof.tableRects = []
    if (mode === 'competing-caption') proof.captions.push(structuredClone(proof.captions[0]))
    if (mode === 'outside-body')
      content.items.find((i: { str: string; width: number }) => i.str.length > 20).width = 300
    expect(excludePdfLineNumbers(content, indexViewport, proof).items).toHaveLength(8)
  }
)
