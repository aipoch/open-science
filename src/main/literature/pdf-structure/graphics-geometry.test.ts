import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { expect, it } from 'vitest'

const { collectTableRules, collectGraphicsBounds, excludeRepeatedMarginContent } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
)
const { getDocument, OPS } = await import(
  pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)

it('preserves separate straight rules in a compound stroke without bridging their gaps', () => {
  const path = new Float32Array([0, 10, 20, 1, 80, 20, 0, 20, 40, 1, 40, 40, 0, 50, 40, 1, 80, 40])
  expect(
    collectTableRules(
      { fnArray: [OPS.constructPath], argsArray: [[OPS.stroke, [path], [10, 20, 80, 40]]] },
      { transform: [1.5, 0, 0, 1.5, 0, 0] }
    )
  ).toEqual([
    [15, 30, 120, 30],
    [30, 60, 60, 60],
    [75, 60, 120, 60]
  ])
})

it('excludes repeated running headers near an image but keeps labels inside its bounds', () => {
  const header = { text: 'A. Author et al.', x: 36, y: 34, width: 72, height: 8 }
  const journal = { text: 'Journal 146 (2025)', x: 420, y: 34, width: 144, height: 8 }
  const label = { text: 'Sample A', x: 120, y: 52, width: 60, height: 8 }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [header, journal, label],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [0.1, 0.06, 0.9, 0.5] },
      { kind: 'path', normalizedRect: [0, 0, 1, 1] }
    ]
  }
  const [clean] = excludeRepeatedMarginContent([page, { ...page, pageNumber: 2 }])
  expect(clean.lines).toEqual([label])
  expect(
    associateFigures(clean, [{ page: 1, lines: ['Fig. 1. Results'], rect: [60, 410, 540, 440] }])[0]
      .rect
  ).toEqual([60, 48, 540, 400])
  expect(excludeRepeatedMarginContent([page])[0].lines).toEqual(page.lines)
})

it.each([
  [420, 578],
  [640, 578],
  [640, 9]
])(
  'keeps repeated vertical publication notices out of a figure ending at %s with margin x=%s',
  (bottom, marginX) => {
    const line = (
      text: string,
      x: number,
      y: number,
      height: number
    ): {
      text: string
      x: number
      y: number
      width: number
      height: number
      fontSize: number
    } => ({
      text,
      x,
      y,
      width: 9,
      height,
      fontSize: 9
    })
    const notices = [
      line('First published online. Downloaded from', marginX, 32, 345),
      line('https://journal.example/', marginX, 380, 74),
      line('Protected by copyright.', marginX, 457, 305)
    ]
    const axis = line('Cell viability', 550, 100, 85)
    const sample = {
      pageNumber: 8,
      width: 595,
      height: 794,
      invalidGraphicsBounds: 0,
      lines: [...notices, axis],
      graphicsBounds: [
        { kind: 'path', normalizedRect: [0.07, 0.024, 0.934, 0.054] },
        { kind: 'image', normalizedRect: [0.07, 0.059, 0.934, bottom / 794] }
      ]
    }
    const [filtered] = excludeRepeatedMarginContent([sample, { ...sample, pageNumber: 9 }])
    const [figure] = associateFigures(filtered, [
      { page: 8, lines: ['Figure 1. Results'], rect: [42, bottom + 4, 555, bottom + 40] }
    ])
    expect(figure.rect).toEqual([595 * 0.07, 794 * 0.059, 559, bottom])
    expect(filtered.lines).toEqual([axis])
    expect(sample.lines).toHaveLength(4)
    // Repetition, publication wording and an external page margin are all required.
    expect(excludeRepeatedMarginContent([sample])[0].lines).toEqual(sample.lines)
    expect(
      excludeRepeatedMarginContent([
        sample,
        {
          ...sample,
          pageNumber: 9,
          lines: notices.map((entry) => ({ ...entry, y: entry.y + 20 }))
        }
      ])[0].lines
    ).toEqual(sample.lines)
    for (const changes of [{ x: 200 }, { text: 'Fluorescence intensity (a.u.)' }]) {
      const adjusted = { ...sample, lines: notices.map((entry) => ({ ...entry, ...changes })) }
      expect(
        excludeRepeatedMarginContent([adjusted, { ...adjusted, pageNumber: 9 }])[0].lines
      ).toEqual(adjusted.lines)
    }
    const fullWidth = {
      ...sample,
      graphicsBounds: [{ kind: 'image', normalizedRect: [0, 0.03, 1, 0.97] }]
    }
    expect(
      excludeRepeatedMarginContent([fullWidth, { ...fullWidth, pageNumber: 9 }])[0].lines
    ).toEqual(fullWidth.lines)
  }
)

it('recognizes alternating publisher lettering while preserving real margin images and paths', () => {
  const footer = Array.from({ length: 8 }, (_, i) => ({
    kind: 'path',
    normalizedRect: [0.08 + i / 128, 0.95, 0.09 + i / 128, 0.965]
  }))
  const facing = footer.map((g) => ({
    ...g,
    normalizedRect: g.normalizedRect.map((v, i) => v + (i % 2 ? 0 : 0.7 + 1 / 512))
  }))
  facing[3].normalizedRect[2] += 1 / 512
  const body = { kind: 'image', normalizedRect: [0.1, 0.2, 0.9, 0.7] }
  const strip = { kind: 'image', normalizedRect: [0.1, 0.94, 0.9, 0.96] }
  const pages = [
    { pageNumber: 1, graphicsBounds: [...footer, body, strip] },
    { pageNumber: 2, graphicsBounds: [...facing, body, strip] }
  ]
  expect(
    excludeRepeatedMarginContent(pages).map((p: { graphicsBounds: unknown[] }) => p.graphicsBounds)
  ).toEqual([
    [body, strip],
    [body, strip]
  ])
  expect(excludeRepeatedMarginContent([pages[0]])[0].graphicsBounds).toEqual(
    pages[0].graphicsBounds
  )
  expect(pages[0].graphicsBounds).toHaveLength(10)
  const paths = pages.map((page) => ({ ...page, graphicsBounds: [{ ...strip, kind: 'path' }] }))
  expect(excludeRepeatedMarginContent(paths)).toEqual(paths)
  const different = structuredClone(pages)
  different[1].graphicsBounds[0].normalizedRect[3] = 0.956
  expect(excludeRepeatedMarginContent(different)).toEqual(different)
})
it('uses the same optimized instruction stream as the recorded image bounds', async () => {
  const content =
    Array.from({ length: 5 }, (_, i) => `q 20 0 0 20 ${20 + i * 30} 100 cm /Im Do Q`).join('\n') +
    '\n0 0 1 rg 30 20 80 40 re f\nq 20 0 0 5 20 190 cm /Im Do Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n00ff00>\nendstream'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const task = getDocument({
    data: new Uint8Array(Buffer.from(pdf)),
    verbosity: 0,
    isEvalSupported: false
  })
  const canvas = createCanvas(300, 300)
  try {
    const page = await (await task.promise).getPage(1)
    await page.getOperatorList()
    const render = page.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport: page.getViewport({ scale: 1.5 }),
      recordOperations: true
    })
    await render.promise
    const result = collectGraphicsBounds(render, page.recordedBBoxes)
    expect(result.graphicsBounds.filter((g: { imageHash?: string }) => g.imageHash)).toHaveLength(3)
    const images = result.graphicsBounds.filter(
      (g: { kind: string; normalizedRect: number[] }) =>
        g.kind === 'image' && g.normalizedRect[3] > 0.07
    )
    expect(images.length).toBeGreaterThan(0)
    const rects = images.map((image: { normalizedRect: number[] }) => image.normalizedRect)
    const bounds = [
      Math.min(...rects.map((r: number[]) => r[0])),
      Math.min(...rects.map((r: number[]) => r[1])),
      Math.max(...rects.map((r: number[]) => r[2])),
      Math.max(...rects.map((r: number[]) => r[3]))
    ]
    const paths = result.graphicsBounds.filter((g: { kind: string }) => g.kind === 'path')
    expect(
      paths.some((g: { normalizedRect: number[] }) =>
        [0.15, 0.7, 0.55, 0.9].every((value, i) => Math.abs(g.normalizedRect[i] - value) < 0.01)
      )
    ).toBe(true)
    for (const [i, value] of [0.1, 0.4, 0.8, 0.5].entries())
      expect(Math.abs(bounds[i] - value)).toBeLessThan(0.01)
  } finally {
    canvas.width = canvas.height = 1
    await task.destroy()
  }
})

it('reads single straight stroked table borders with nested PDF transforms', () => {
  const stroke = [
    OPS.stroke,
    [new Float32Array([0, 0, 0, 1, 0, 20])],
    new Float32Array([0, 0, 0, 20])
  ]
  const operators = {
    fnArray: [
      OPS.save,
      OPS.transform,
      OPS.constructPath,
      OPS.save,
      OPS.transform,
      OPS.constructPath,
      OPS.restore,
      OPS.constructPath,
      OPS.restore,
      OPS.constructPath,
      OPS.constructPath,
      OPS.constructPath
    ],
    argsArray: [
      null,
      [1, 0, 0, 1, 100, 200],
      stroke,
      null,
      [2, 0, 0, 2, 10, 0],
      stroke,
      null,
      stroke,
      null,
      stroke,
      [OPS.fill, stroke[1], stroke[2]],
      [OPS.stroke, [new Float32Array([0, 0, 0, 1, 0, 5, 0, 0, 15, 1, 0, 20])], stroke[2]]
    ]
  }
  expect(collectTableRules(operators, { transform: [1.5, 0, 0, -1.5, 0, 1200] })).toEqual([
    [150, 870, 150, 900],
    [165, 840, 165, 900],
    [150, 870, 150, 900],
    [0, 1170, 0, 1200],
    [0, 1192.5, 0, 1200],
    [0, 1170, 0, 1177.5]
  ])
})

it('uses thin rectangular fills as rules while rejecting shading, slanted edges and compound paths', () => {
  const rectangle = (height: number): number[] => [
    0,
    10,
    20,
    1,
    110,
    20,
    1,
    110,
    20 + height,
    1,
    10,
    20 + height,
    4
  ]
  const thin = rectangle(0.5)
  const operators = {
    fnArray: Array(6).fill(OPS.constructPath),
    argsArray: [
      [OPS.eoFillStroke, [thin], [10, 20, 110, 20.5]],
      [OPS.fill, [rectangle(10)], [10, 20, 110, 30]],
      [OPS.fill, [[0, 10, 20, 1, 110, 20, 1, 109, 20.5, 1, 10, 20.5, 4]], [10, 20, 110, 20.5]],
      [OPS.fill, [thin, thin], [10, 20, 110, 20.5]],
      [OPS.fill, [rectangle(0)], [10, 20, 110, 20]],
      [OPS.fill, [[0, 10, 20, 2, 110, 20, 110, 20.5, 10, 20.5]], [10, 20, 110, 20.5]]
    ]
  }
  expect(collectTableRules(operators, { transform: [1.5, 0, 0, 1.5, 0, 0] })).toEqual([
    [15, 30.375, 165, 30.375]
  ])
})

it.each([1, 1.5, 3])('keeps one-point filled rules at render scale %s', (scale) => {
  const path = [0, 10, 20, 1, 110, 20, 1, 110, 21.02, 1, 10, 21.02, 4]
  const rules = collectTableRules(
    { fnArray: [OPS.constructPath], argsArray: [[OPS.fill, [path], [10, 20, 110, 21.02]]] },
    { transform: [scale, 0, 0, scale, 0, 0] }
  )
  expect(rules).toHaveLength(1)
  expect(rules[0][1]).toBeCloseTo(20.51 * scale)
})

it('excludes repeated publisher rules below running headers while retaining standalone plot borders', () => {
  const rule = { kind: 'path', normalizedRect: [0.06640625, 0.12109375, 0.9375, 0.1328125] }
  const panel = { kind: 'path', normalizedRect: [0.2, 0.17, 0.8, 0.7] }
  const page = {
    width: 600,
    height: 800,
    lines: [{ text: 'Articles', x: 40, y: 30, width: 50, height: 18 }],
    graphicsBounds: [rule, panel]
  }
  const clean = excludeRepeatedMarginContent([page, { ...page }])
  expect(clean[0].graphicsBounds).toEqual([panel])
  const facing = { ...page, lines: [{ ...page.lines[0], x: 500 }] }
  expect(excludeRepeatedMarginContent([page, facing, { ...page }])[1].graphicsBounds).toEqual([
    panel
  ])
  expect(excludeRepeatedMarginContent([page])[0].graphicsBounds).toEqual([rule, panel])
  expect(
    excludeRepeatedMarginContent([
      { ...page, lines: [] },
      { ...page, lines: [] }
    ])[0].graphicsBounds
  ).toEqual([rule, panel])
})

it('excludes only repeated, pixel-identical raster logos separated from figure content', () => {
  const logo = {
    kind: 'image',
    imageHash: 'decoded-pixels',
    normalizedRect: [0.06, 0.02, 0.19, 0.06]
  }
  const figure = { kind: 'image', normalizedRect: [0.06, 0.08, 0.94, 0.6] }
  const first = { pageNumber: 1, graphicsBounds: [logo, figure] }
  const second = { pageNumber: 3, graphicsBounds: [{ ...logo }, figure] }
  expect(excludeRepeatedMarginContent([first, second])[0].graphicsBounds).toEqual([figure])
  for (const other of [
    { ...logo, imageHash: 'different-pixels' },
    { ...logo, imageHash: undefined },
    { ...logo, normalizedRect: [0.06, 0.04, 0.19, 0.08] }
  ]) {
    expect(
      excludeRepeatedMarginContent([first, { ...second, graphicsBounds: [other] }])[0]
        .graphicsBounds
    ).toContain(logo)
  }
  expect(excludeRepeatedMarginContent([first])[0].graphicsBounds).toContain(logo)
  const overlapping = { ...figure, normalizedRect: [0.06, 0.05, 0.94, 0.6] }
  expect(
    excludeRepeatedMarginContent([{ ...first, graphicsBounds: [logo, overlapping] }, second])[0]
      .graphicsBounds
  ).toContain(logo)
})

it('recovers a missed captioned numeric table region without guessing its cell structure', async () => {
  const { findCaptionedNumericTableRegions } = await import(
    pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
  )
  const item = (
    text: string,
    x: number,
    y: number,
    width = 30
  ): {
    text: string
    x: number
    baseline: number
    width: number
    height: number
    horizontal: boolean
  } => ({
    text,
    x,
    baseline: y + 10,
    width,
    height: 10,
    horizontal: true
  })
  const source = [
    item('Table 1. Dose reductions', 70, 10, 150),
    item('Starting dose', 10, 35, 65),
    ...[1, 2, 3].map((n, c) => item(`Level ${n}`, 110 + c * 65, 35)),
    item('175 over 3 hours', 10, 55, 80),
    ...['150', '125', '105'].map((s, c) => item(s, 110 + c * 65, 55)),
    item('80 over 1 hour', 10, 75, 80),
    ...['70', '60', '50'].map((s, c) => item(s, 110 + c * 65, 75))
  ]
  const rules = [
    [0, 0, 300, 0],
    [0, 95, 300, 95]
  ]
  expect(findCaptionedNumericTableRegions(source, rules, [])).toEqual([[0, 26, 300, 95]])
  const continued = [
    ...source,
    item('40 over 1 hour', 10, 95, 80),
    ...['30', '20', '10'].map((s, c) => item(s, 110 + c * 65, 95))
  ]
  expect(findCaptionedNumericTableRegions(continued, [...rules, [0, 115, 300, 115]], [])).toEqual([
    [0, 26, 300, 115]
  ])
  expect(findCaptionedNumericTableRegions(source, rules, [[0, 25, 300, 95]])).toEqual([])
  expect(findCaptionedNumericTableRegions(source.slice(1), rules, [])).toEqual([])
  expect(findCaptionedNumericTableRegions(source, rules.slice(0, 1), [])).toEqual([])
  expect(
    findCaptionedNumericTableRegions(
      source.filter((i) => i.text !== '60'),
      rules,
      []
    )
  ).toEqual([])
  expect(
    findCaptionedNumericTableRegions(
      source.map((i) => (i.text === '60' ? { ...i, x: 200 } : i)),
      rules,
      []
    )
  ).toEqual([])
  expect(
    findCaptionedNumericTableRegions(
      source.filter((i) => !i.text.startsWith('Level')),
      rules,
      []
    )
  ).toEqual([])
})

it.each([OPS.paintImageXObject, OPS.constructPath])(
  'ignores mask strips and duplicates of operation %s while retaining separate figures',
  (existingOperation) => {
    const rects = [
      [0.1, 0.1, 0.9, 0.5],
      [0.1, 0.1, 0.9, 0.501],
      [0.3, 0.05, 0.33, 0.95],
      [0.1, 0.6, 0.5, 0.9]
    ]
    const result = collectGraphicsBounds(
      {
        _internalRenderTask: {
          operatorList: {
            fnArray: [
              existingOperation,
              OPS.paintImageMaskXObject,
              OPS.paintImageMaskXObject,
              OPS.paintImageMaskXObject
            ],
            argsArray: [[], [], [], []]
          }
        }
      },
      {
        isEmpty: (): boolean => false,
        minX: (i: number): number => rects[i][0],
        minY: (i: number): number => rects[i][1],
        maxX: (i: number): number => rects[i][2],
        maxY: (i: number): number => rects[i][3]
      }
    )
    expect(result.graphicsBounds.map((g: { operationIndex: number }) => g.operationIndex)).toEqual([
      0, 3
    ])
  }
)

it('collects a monochrome image-mask figure from the rendered PDF stream', async () => {
  const content = 'q 100 0 0 100 20 60 cm /Im Do Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1 /Filter /ASCIIHexDecode /Length 17 >>\nstream\nAA55AA55AA55AA55>\nendstream'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const offset = pdf.length
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const task = getDocument({
    data: new Uint8Array(Buffer.from(pdf)),
    verbosity: 0,
    isEvalSupported: false
  })
  const canvas = createCanvas(300, 300)
  try {
    const page = await (await task.promise).getPage(1)
    const render = page.render({
      canvas,
      canvasContext: canvas.getContext('2d'),
      viewport: page.getViewport({ scale: 1.5 }),
      recordOperations: true
    })
    await render.promise
    const images = collectGraphicsBounds(render, page.recordedBBoxes).graphicsBounds.filter(
      (g: { kind: string }) => g.kind === 'image'
    )
    expect(images).toHaveLength(1)
    for (const [i, value] of [0.1, 0.2, 0.6, 0.7].entries())
      expect(Math.abs(images[0].normalizedRect[i] - value)).toBeLessThan(0.01)
  } finally {
    canvas.width = canvas.height = 1
    await task.destroy()
  }
})

it('recognizes an author running header despite its changing printed page number', () => {
  const page = (n: number): object => ({
    pageNumber: n,
    width: 600,
    height: 800,
    lines: [{ text: `${n} Green et al.`, x: 54, y: 55, width: 90, height: 9 }],
    graphicsBounds: [{ kind: 'image', normalizedRect: [0.09, 0.094, 0.5, 0.54] }]
  })
  expect(
    excludeRepeatedMarginContent([page(18), page(20)]).map((p: { lines: unknown[] }) => p.lines)
  ).toEqual([[], []])
  expect(excludeRepeatedMarginContent([page(18)])[0].lines).toHaveLength(1)
})

it('preserves repeated continuation captions while removing ordinary running titles', () => {
  const line = (text: string, y: number): object => ({
    text,
    x: 36,
    y,
    width: 238,
    height: 8,
    fontSize: 8
  })
  const caption = line('TABLE A1. Toxicity management guidelines (continued)', 40)
  const title = line('Journal of Clinical Results', 18)
  const page = { width: 600, height: 800, graphicsBounds: [], lines: [caption, title] }
  const result = excludeRepeatedMarginContent([
    { ...page, pageNumber: 18 },
    { ...page, pageNumber: 19 }
  ])
  expect(result.map((p: { lines: unknown[] }) => p.lines)).toEqual([[caption], [caption]])
})
