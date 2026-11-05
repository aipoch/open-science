import { describe, expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'

const { isSearchableScan, recoverRuledScanElements, reconcileScanCaptions } = await import(
  pathToFileURL(resolve('resources/literature-pdf-scanned-page.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Preserve inferred fixture types.
const fixture = () => {
  const canvas = createCanvas(600, 800)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 600, 800)
  ctx.fillStyle = 'black'
  ctx.fillRect(50, 40, 500, 1)
  ctx.fillRect(50, 300, 240, 1)
  ctx.fillRect(50, 350, 240, 1)
  ctx.fillRect(70, 100, 200, 170)
  const lines = [
    { text: 'FIGURE 1 A complete chart.', x: 50, y: 305, width: 210, height: 10 },
    { text: 'A continuation with different OCR metrics.', x: 50, y: 320, width: 235, height: 12 },
    {
      text: 'A nearby paragraph in another column must stay outside the caption.',
      x: 315,
      y: 320,
      width: 230,
      height: 12
    }
  ]
  return {
    page: {
      pageNumber: 1,
      width: 600,
      height: 800,
      lines,
      rotation: 0,
      renderRotation: 0,
      graphicsBounds: [{ kind: 'image', normalizedRect: [0, 0, 1, 1] }]
    },
    captions: [{ page: 1, lines: [lines[0].text], rect: [50, 305, 260, 315] }],
    raster: ctx.getImageData(0, 0, 600, 800)
  }
}

describe('searchable scan extraction', () => {
  it('distinguishes invisible OCR from native text painted over a background', () => {
    const { page } = fixture()
    const ops = {
      fnArray: [OPS.save, OPS.setTextRenderingMode, OPS.showText, OPS.restore],
      argsArray: [null, [3], [[]], null]
    }
    expect(isSearchableScan(page, ops)).toBe(true)
    expect(
      isSearchableScan(page, {
        fnArray: [...ops.fnArray, OPS.showText],
        argsArray: [...ops.argsArray, [[]]]
      })
    ).toBe(false)
    expect(
      isSearchableScan(
        { ...page, graphicsBounds: [{ kind: 'image', normalizedRect: [0.1, 0.1, 0.8, 0.8] }] },
        ops
      )
    ).toBe(false)
  })

  it('recovers a bounded chart and its full caption without the adjacent prose', () => {
    const { page, captions, raster } = fixture()
    const result = recoverRuledScanElements(page, captions, raster)
    expect(result).toHaveLength(1)
    expect(result[0].rect).toEqual([68, 98, 272, 272])
    expect(result[0].caption.lines).toEqual(page.lines.slice(0, 2).map((l) => l.text))
    expect(recoverRuledScanElements(page, [], raster)).toEqual([])
  })

  it('declines an unbounded caption instead of publishing the entire scan', () => {
    const { page, captions, raster } = fixture()
    for (let y = 350; y <= 351; y++)
      for (let x = 0; x < 600; x++) raster.data.fill(255, (y * 600 + x) * 4, (y * 600 + x + 1) * 4)
    expect(recoverRuledScanElements(page, captions, raster)).toEqual([])
  })
})

it('keeps a graphical table and its marked footnote without claiming a cell grid', () => {
  const canvas = createCanvas(600, 800)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 600, 800)
  ctx.fillStyle = 'black'
  ctx.fillRect(50, 100, 500, 1)
  ctx.fillRect(50, 160, 500, 1)
  ctx.fillRect(50, 300, 500, 1)
  ctx.fillRect(50, 500, 500, 1)
  ctx.fillRect(70, 150, 180, 100)
  ctx.fillRect(50, 308, 220, 8)
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      { text: 'TABLE 1 Chemical structures', x: 50, y: 80, width: 230, height: 10 },
      { text: '* Conditions apply.', x: 50, y: 308, width: 220, height: 8 },
      {
        text: 'Body prose in a narrower column must prevent merging a page footer into this table.',
        x: 50,
        y: 380,
        width: 240,
        height: 10
      }
    ]
  }
  const elements = recoverRuledScanElements(
    page,
    [{ page: 1, lines: [page.lines[0].text], rect: [50, 80, 280, 90] }],
    ctx.getImageData(0, 0, 600, 800)
  )
  expect(elements).toHaveLength(1)
  expect(elements[0]).toMatchObject({ kind: 'table', rect: [48, 99, 552, 318] })
  expect(elements[0]).not.toHaveProperty('cells')
})

it('keeps same-height captions in their own columns and rejects unreliable OCR', () => {
  const elements = [50, 320].map((x, i) => ({
    kind: 'figure',
    rect: [x, 40, x + 220, 290],
    caption: { page: 1, rect: [x, 300, x + 220, 330], lines: [`FIGURE ${i + 1} Old text`] }
  }))
  const recovered = elements.map((e, i) => ({
    ...e,
    rect: [0, 0, 600, 800],
    caption: { ...e.caption, lines: [`FIGURE ${i + 1} Recognized text`] }
  }))
  const words = elements.map((e) => ({ text: 'Recognized', confidence: 90, rect: e.caption.rect }))
  const result = reconcileScanCaptions(elements, recovered, words)
  expect(result.map((e) => e.caption.lines)).toEqual(recovered.map((e) => e.caption.lines))
  expect(result.map((e) => e.rect)).toEqual(elements.map((e) => e.rect))
  const complete = elements.map((e) => ({
    ...e,
    caption: { ...e.caption, lines: [...e.caption.lines, 'Continuation line.'] }
  }))
  expect(reconcileScanCaptions(complete, recovered, words)).toEqual(complete)

  expect(
    reconcileScanCaptions(
      elements,
      recovered,
      words.map((w) => ({ ...w, confidence: 20 }))
    )
  ).toEqual(elements)
})
