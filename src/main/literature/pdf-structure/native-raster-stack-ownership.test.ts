import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { nativeCaptionedRasterFrameBands, nativeCaptionedRasterMapStack } = await import(
  pathToFileURL(
    resolve('resources/pdf-structure/literature-pdf-figure-native-captioned-illustration.mjs')
  ).href
)
const { associateFigures, associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (name: string): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))

it('retains both framed upper panels and the lower raster-backed framework without mutation', () => {
  const input = fixture('raster-backed-paired-framework')
  const before = structuredClone(input)
  const found = nativeCaptionedRasterFrameBands(input.page, input.captions[0], input.captions, [])
  expect(found?.rect[1]).toBeLessThan(73)
  expect(found?.rect[3]).toBeGreaterThan(237)
  expect(associateFigures(input.page, input.captions)[0].rect).toEqual(found.rect)
  expect(input).toEqual(before)
})

it.each(['raster', 'frame', 'caption', 'table', 'prose', 'misaligned'])(
  'declines a paired framework with missing or conflicting %s evidence',
  (failure) => {
    const { page, captions } = fixture('raster-backed-paired-framework')
    const tables: number[][] = []
    if (failure === 'raster') for (const g of page.graphicsBounds) delete g.imageHash
    if (failure === 'frame')
      page.graphicsBounds = page.graphicsBounds.filter(
        (g: ReturnType<typeof JSON.parse>) => g.kind !== 'path'
      )
    if (failure === 'caption')
      captions.push({
        page: 1,
        rect: [125, 155, 490, 167],
        lines: ['Figure 2. Independent plate.']
      })
    if (failure === 'table') tables.push([300, 75, 485, 150])
    if (failure === 'prose')
      page.lines.push({
        text: 'A separately typeset paragraph explains the previous results and continues with an independent discussion of the method.',
        fontSize: 9,
        x: 125,
        y: 152,
        width: 360,
        height: 10
      })
    if (failure === 'misaligned') page.graphicsBounds[0].paintedNormalizedRect[0] += 0.05
    expect(nativeCaptionedRasterFrameBands(page, captions[0], captions, tables)).toBeUndefined()
  }
)

it('retains all three raster maps, color keys and axis labels without changing source evidence', () => {
  const input = fixture('aligned-raster-map-stack')
  const before = structuredClone(input)
  const found = nativeCaptionedRasterMapStack(input.page, input.captions[0], input.captions, [])
  expect(found?.graphicsCount).toBe(6)
  expect(found?.rect[1]).toBeLessThan(65)
  expect(found?.rect[3]).toBeGreaterThan(670)
  expect(associateFigures(input.page, input.captions)[0].rect).toEqual(found.rect)
  expect(input).toEqual(before)
})

it.each(['key', 'raster', 'misalignment', 'spacing', 'caption', 'table', 'prose'])(
  'declines raster maps with %s ambiguity',
  (failure) => {
    const { page, captions } = fixture('aligned-raster-map-stack')
    const tables: number[][] = []
    if (failure === 'key') page.graphicsBounds.splice(1, 1)
    if (failure === 'raster') for (const g of page.graphicsBounds) delete g.imageHash
    if (failure === 'misalignment') page.graphicsBounds[0].normalizedRect[0] += 0.08
    if (failure === 'spacing')
      page.graphicsBounds[0].normalizedRect = page.graphicsBounds[0].normalizedRect.map(
        (v: number, i: number) => v - (i % 2 ? 0.07 : 0)
      )
    if (failure === 'caption')
      captions.push({ page: 1, rect: [100, 280, 500, 295], lines: ['Figure 2. Independent map.'] })
    if (failure === 'table') tables.push([100, 290, 400, 400])
    if (failure === 'prose')
      page.lines.push({
        text: 'An independent paragraph discusses the preceding experiment.',
        fontSize: 8,
        x: 100,
        y: 260,
        width: 370,
        height: 8
      })
    expect(nativeCaptionedRasterMapStack(page, captions[0], captions, tables)).toBeUndefined()
  }
)

it('pairs independently ruled tables across separate columns and reverse detector order', () => {
  const input = fixture('separate-ruled-table-caption-lanes')
  const before = structuredClone(input)
  const associated = associateTableCaptions(input.page, input.tables, input.captions, input.rules)
  expect(associated.map((a: ReturnType<typeof JSON.parse>) => a.caption?.lines[0])).toEqual([
    'TABLE III',
    'TABLE II',
    'TABLE I'
  ])
  expect(input).toEqual(before)
  const reversed = associateTableCaptions(
    input.page,
    input.tables.toReversed(),
    input.captions,
    input.rules
  )
  expect(reversed.map((a: ReturnType<typeof JSON.parse>) => a.caption?.lines[0])).toEqual([
    'TABLE I',
    'TABLE II',
    'TABLE III'
  ])
})

it('uses the native opening before a separator when predictions contain only body rows', () => {
  const { page, tables, captions, rules } = fixture('body-only-ruled-table-caption-stack')
  expect(
    associateTableCaptions(page, tables, captions, rules).map(
      (a: ReturnType<typeof JSON.parse>) => a.caption?.lines[0]
    )
  ).toEqual([
    'Table 2: Anonymous experimental metrics.',
    'Table 3: Anonymous experimental metrics.',
    'Table 1: Anonymous experimental metrics.'
  ])
})

it('does not let an upper vector form borrow the next captioned raster pair', () => {
  const captions = [
    { page: 1, lines: ['Figure 1. Vector form.'], rect: [40, 202, 285, 250] },
    { page: 1, lines: ['Figure 2. Raster maps.'], rect: [40, 605, 285, 650] }
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: captions.map((c) => ({
      text: c.lines[0],
      fontSize: 8,
      x: c.rect[0],
      y: c.rect[1],
      width: 230,
      height: 8
    })),
    graphicsBounds: [
      {
        kind: 'image',
        normalizedRect: [0.07, 0.07, 0.48, 0.25],
        paintedNormalizedRect: [0.075, 0.075, 0.475, 0.245]
      },
      { kind: 'image', normalizedRect: [0.07, 0.39, 0.48, 0.52], imageHash: 'first-map' },
      { kind: 'image', normalizedRect: [0.07, 0.6, 0.48, 0.73], imageHash: 'second-map' }
    ]
  }
  const matches = associateFigures(page, captions)
  expect(matches[0].rect?.[3] ?? 0).toBeLessThanOrEqual(captions[0].rect[1])
  expect(matches[1].rect?.[1]).toBeGreaterThan(captions[0].rect[3])
})

it('keeps a compact table title away from an oversized preceding fragment', () => {
  const input = fixture('compact-table-caption-with-competing-fragment')
  const before = structuredClone(input)
  const matches = associateTableCaptions(input.page, input.tables, input.captions, input.rules)
  expect(matches.map((m: ReturnType<typeof JSON.parse>) => m.caption?.lines[0])).toEqual([
    undefined,
    'Table 3: Anonymous experimental results.',
    'Table 1: Anonymous experimental results.',
    'Table 2: Anonymous experimental results.'
  ])
  expect(input).toEqual(before)
})

it('keeps native below-frame captions with their preceding complete tables', () => {
  const input = fixture('ruled-tables-below-caption-stack')
  const before = structuredClone(input)
  const matches = associateTableCaptions(input.page, input.tables, input.captions, input.rules)
  expect(matches.map((m: ReturnType<typeof JSON.parse>) => m.caption?.lines[0])).toEqual([
    'Table 2: Anonymous experimental results.',
    'Table 1: Anonymous experimental results.',
    'Table 3: Anonymous experimental results.'
  ])
  expect(input).toEqual(before)
})

it('keeps above and below caption orientations independent on the same page', () => {
  const below = fixture('ruled-tables-below-caption-stack')
  const above = fixture('body-only-ruled-table-caption-stack')
  const offset = 700
  const shiftedRect = (rect: number[]): number[] =>
    rect.map((value, index) => value + (index % 2 ? offset : 0))
  const tables = [
    ...below.tables,
    ...above.tables.map((table: { rect: number[] }) => ({
      ...table,
      rect: shiftedRect(table.rect)
    }))
  ]
  const captions = [
    ...below.captions,
    ...above.captions.map((caption: { rect: number[] }) => ({
      ...caption,
      rect: shiftedRect(caption.rect)
    }))
  ]
  const page = {
    ...below.page,
    height: 2000,
    lines: [
      ...below.page.lines,
      ...above.page.lines.map((line: { y: number }) => ({ ...line, y: line.y + offset }))
    ]
  }
  const rules = [...below.rules, ...above.rules.map(shiftedRect)]
  expect(
    associateTableCaptions(page, tables, captions, rules).map(
      (match: ReturnType<typeof JSON.parse>) => match.caption?.lines[0]
    )
  ).toEqual([
    'Table 2: Anonymous experimental results.',
    'Table 1: Anonymous experimental results.',
    'Table 3: Anonymous experimental results.',
    'Table 2: Anonymous experimental metrics.',
    'Table 3: Anonymous experimental metrics.',
    'Table 1: Anonymous experimental metrics.'
  ])
})

it.each(['closing-rule', 'prose', 'overlapping-owner'])(
  'does not override shared compact-caption ambiguity without %s proof',
  (failure) => {
    const { page, tables, captions, rules } = fixture(
      'compact-table-caption-with-competing-fragment'
    )
    if (failure === 'closing-rule') {
      const last = rules.findIndex((r: number[]) => Math.abs(r[1] - 578.22845831) < 0.01)
      rules.splice(last, 1)
    }
    if (failure === 'prose')
      page.lines.push({
        text: 'An independent source paragraph separates this title from the later table.',
        x: 110,
        y: 481,
        width: 370,
        height: 10,
        fontSize: 10
      })
    if (failure === 'overlapping-owner') tables.push(structuredClone(tables[3]))
    expect(associateTableCaptions(page, tables, captions, rules)[3].caption).toBeUndefined()
  }
)
