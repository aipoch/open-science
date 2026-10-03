/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readPdfFixture } from './read-fixture'

const { hasClearTwoColumnLayout, normalizePageLineOrder } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-reading-order.mjs')).href
)

const fixture = () =>
  readPdfFixture('src/main/literature/pdf-structure/fixtures/reading-order-two-columns.jsonl')

it('normalizes interleaved two-column lines to column-major reading order', () => {
  const page = fixture()
  expect(hasClearTwoColumnLayout(page)).toBe(true)
  expect(normalizePageLineOrder(page).map((line: { text: string }) => line.text)).toEqual([
    'Left A',
    'Left B',
    'Left C',
    'Left D',
    'Right A',
    'Right B',
    'Right C',
    'Right D'
  ])
  expect(page.lines.map((line: { text: string }) => line.text)).toEqual([
    'Right A',
    'Left A',
    'Right B',
    'Left B',
    'Right C',
    'Left C',
    'Right D',
    'Left D'
  ])
})

it('preserves pages without clear two-column evidence', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: Array.from({ length: 8 }, (_, index) => ({
      text: `Line ${index + 1}`,
      x: 50,
      y: 40 + index * 14,
      width: 300,
      height: 10
    }))
  }
  expect(hasClearTwoColumnLayout(page)).toBe(false)
  expect(normalizePageLineOrder(page)).toEqual(page.lines)
})

it('does not treat overlapping indented paragraphs as two columns', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      { text: 'Intro', x: 50, y: 40, width: 260, height: 10 },
      { text: 'Indented one', x: 190, y: 54, width: 250, height: 10 },
      { text: 'Continuation', x: 50, y: 68, width: 260, height: 10 },
      { text: 'Indented two', x: 190, y: 82, width: 250, height: 10 },
      { text: 'Continuation', x: 50, y: 96, width: 260, height: 10 },
      { text: 'Indented three', x: 190, y: 110, width: 250, height: 10 },
      { text: 'Continuation', x: 50, y: 124, width: 260, height: 10 },
      { text: 'Indented four', x: 190, y: 138, width: 250, height: 10 }
    ]
  }
  expect(hasClearTwoColumnLayout(page)).toBe(false)
  expect(normalizePageLineOrder(page)).toEqual(page.lines)
})

it('keeps a full-width heading ahead of reordered columns', () => {
  const page = fixture()
  page.lines.unshift({ text: 'Section heading', x: 50, y: 20, width: 500, height: 12 })
  expect(normalizePageLineOrder(page).map((line: { text: string }) => line.text)).toEqual([
    'Section heading',
    'Left A',
    'Left B',
    'Left C',
    'Left D',
    'Right A',
    'Right B',
    'Right C',
    'Right D'
  ])
})
