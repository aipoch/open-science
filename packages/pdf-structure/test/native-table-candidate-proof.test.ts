import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { recoverNativeInteriorFenceTables, finalizeNativeInteriorFenceTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-interior-fence-table.mjs')).href
)
const { collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const {
  recoverPriorCohortContinuation,
  recoverNativeCountContinuationCaption,
  isNativeAuthorAffiliationRegion,
  recoverAdjacentStatisticalSections,
  groupNativeStatisticalSections
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-table-candidates.mjs')).href
)
const { refineTable, recoverRuledTable, hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverWrappedCountTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-wrapped-count-grid.mjs')).href
)
const { groupTableParts } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-group.mjs')).href
)
const { groupRuledComparisonSections } = await import(
  pathToFileURL(resolve('resources/literature-pdf-ruled-narrative-grid.mjs')).href
)
const load = (name: string): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(resolve(`test/fixtures/${name}.jsonl`))
const continuation = (): ReturnType<typeof readPdfFixture> =>
  load('ruled-two-cohort-continuation-before-independent-caption')
const recover = (f: ReturnType<typeof readPdfFixture>): ReturnType<typeof JSON.parse> =>
  recoverPriorCohortContinuation(
    f.tokens,
    f.rules,
    f.pageNumber,
    f.previousPage,
    f.captions,
    f.detected
  )
it('recovers a source-proved intermediate cohort continuation without swallowing the next caption', () => {
  const f = continuation()
  expect(recoverRuledTable(f.tokens, f.rules, f.pageNumber)).toBeUndefined()
  expect(recoverWrappedCountTable(f.tokens, f.rules, f.pageNumber)).toBeUndefined()
  const proof = recover(f)
  expect(proof.caption.page).toBe(18)
  expect(proof.caption.lines[0]).toMatch(/^TABLE 1:/)
  expect(proof.table.cropRect[3]).toBeLessThan(f.captions[1].rect[1] * 1.5)
  const result = refineTable(proof.table, f.tokens, [], [], f.rules)
  expect(result.grid[0]).toEqual(['xx', '1 (2%)', '3 (19%)', ''])
  expect(result.grid.find((r: string[]) => r[1] === '23 (48%)')).toEqual([
    'xx',
    '23 (48%)',
    '10 (63%)',
    ''
  ])
  expect(result.grid.every((r: string[]) => r.length === 4)).toBe(true)
  expect(result.unassigned).toEqual([])
  expect(hasTableEvidence(result, undefined, f.tokens)).toBe(true)
})
const statistics = (): ReturnType<typeof readPdfFixture> =>
  load('overlapping-statistical-sections-with-changing-leaf-count')
const split = (f: ReturnType<typeof readPdfFixture>): ReturnType<typeof JSON.parse> =>
  recoverAdjacentStatisticalSections(f.tables, f.tokens, f.captions, f.rules, f.pageNumber)
it('replaces four overlapping detector proposals with two complete native statistical sections', () => {
  const f = statistics(),
    proof = split(f)
  expect(proof.replaced).toHaveLength(4)
  expect(proof.tables).toHaveLength(2)
  expect(proof.tables[0].cropRect[3]).toBe(proof.tables[1].cropRect[1])
  const sections = proof.tables.map((t: ReturnType<typeof JSON.parse>, n: number) => ({
    ...refineTable(t, f.tokens, f.captions, [], f.rules),
    page: f.pageNumber,
    caption: n ? undefined : proof.caption,
    sourceViewport: { width: 918, height: 1188, scale: 1.5 }
  }))
  expect(sections[0].grid).toHaveLength(5)
  expect(sections[1].grid).toHaveLength(9)
  expect(sections[1].grid[8][0]).toBe('7')
  expect(sections[1].grid[4][4]).toBe('<0.2223')
  expect(sections[0].cells[0].colSpan).toBe(4)
  expect(sections[1].cells[0].colSpan).toBe(5)
  expect(
    sections.every((s: ReturnType<typeof JSON.parse>) => !s.unassigned.length && !s.issues.length)
  ).toBe(true)
  // The ordinary source-row pass must precede converting these sections to
  // multipart transport, whose top-level object has no rows or grid.
  const page = {
    lines: f.tokens.map((i: ReturnType<typeof JSON.parse>) => ({
      ...i,
      x: i.x / 1.5,
      y: i.y / 1.5,
      width: i.width / 1.5,
      height: i.height / 1.5
    }))
  }
  const grouped = groupRuledComparisonSections(
    groupNativeStatisticalSections(groupTableParts(sections, page))
  )
  expect(grouped).toHaveLength(1)
  expect(grouped[0].parts).toHaveLength(2)
  expect(grouped[0].parts.map((p: ReturnType<typeof JSON.parse>) => p.title)).toEqual([
    'Repeated measures analyses on normalized measurements',
    'Regression model: relation of measured value and score'
  ])
  expect(grouped[0].parts.map((p: ReturnType<typeof JSON.parse>) => p.grid[0].length)).toEqual([
    4, 5
  ])
})
it('requires both complete native frames, all probabilities, and uninterrupted ordinal records', () => {
  for (const mutation of ['rule', 'leaf-rule', 'value', 'ordinal', 'caption']) {
    const f = statistics()
    if (mutation === 'rule') f.rules.splice(1, 1)
    if (mutation === 'leaf-rule') f.rules.splice(3, 1)
    if (mutation === 'value')
      f.tokens.find((i: { text: string }) => i.text === '0.968').text = 'missing'
    if (mutation === 'ordinal') f.tokens.find((i: { text: string }) => i.text === '6').text = '8'
    if (mutation === 'caption') f.captions = []
    expect(split(f)).toBeUndefined()
  }
})
it('rejects source ink that is not fully and uniquely owned by either native section', () => {
  const f = statistics(),
    proof = split(f),
    [left, , , divider] = proof.tables[0].cropRect
  f.tokens.push({
    text: 'Independent source text',
    rect: [left + 10, divider - 4, left + 100, divider + 4],
    baseline: divider + 4,
    height: 8,
    horizontal: true
  })
  expect(split(f)).toBeUndefined()
})
it('does not discard a detector proposal crossing an independently occupied source region', () => {
  const f = statistics()
  f.tables.push({ cropRect: [400, 900, 800, 1200] })
  expect(split(f)).toBeUndefined()
  const ordinary = statistics()
  ordinary.tables = ordinary.tables.slice(0, 2)
  expect(split(ordinary)).toBeUndefined()
})
it('requires the immediately preceding unique caption and repeated native cohort anchors', () => {
  for (const mutation of ['page', 'caption', 'header', 'anchors']) {
    const f = continuation()
    if (mutation === 'page') f.previousPage.pageNumber -= 1
    if (mutation === 'caption')
      f.captions = f.captions.filter((c: { page: number }) => c.page !== 18)
    if (mutation === 'header') f.previousPage.lines[0].text = 'Measures Cohort A Cohort B'
    if (mutation === 'anchors') f.previousPage.lines[1].x += 10
    expect(recover(f)).toBeUndefined()
  }
})
it('rejects open native bands, incomplete paired records, overlap, and a new caption inside the band', () => {
  for (const mutation of ['rule', 'record', 'overlap', 'caption']) {
    const f = continuation()
    if (mutation === 'rule') f.rules.pop()
    if (mutation === 'record')
      f.tokens = f.tokens.filter((i: { text: string }) => i.text !== '(31%)')
    if (mutation === 'overlap') f.detected = [{ cropRect: [90, 100, 690, 420] }]
    if (mutation === 'caption') f.captions[1].rect[1] = 200
    expect(recover(f)).toBeUndefined()
  }
})
const affiliations = (): ReturnType<typeof readPdfFixture> =>
  load('native-contact-email-above-superscript-institution-list')
const countCaption = (): ReturnType<typeof readPdfFixture> =>
  load('native-three-cohort-continuation-with-matching-prior-samples')
const inheritedCaption = (f: ReturnType<typeof readPdfFixture>): ReturnType<typeof JSON.parse> =>
  recoverNativeCountContinuationCaption(
    f.table,
    f.tokens,
    f.rules,
    f.pageNumber,
    f.previousPage,
    f.captions,
    f.previousRules
  )
it('inherits the original native caption only for a closed matching three-cohort continuation', () => {
  const f = countCaption()
  expect(inheritedCaption(f)).toBe(f.captions[0])
  expect(inheritedCaption(f).rect).toEqual(f.captions[0].rect)
  expect(inheritedCaption(f).page).toBe(1)
  expect(inheritedCaption(f).lines).toEqual(['Table 2. Cohort sample measurements.'])
  expect(refineTable(f.table, f.tokens, [], [], f.rules).unassigned).toEqual([])
})
it('requires adjacent unique captions, native frames, matching samples and complete cohort records', () => {
  for (const mutation of [
    'gap',
    'prior-caption',
    'current-caption',
    'samples',
    'probability-lane',
    'cohort-lane',
    'prior-frame',
    'current-frame',
    'record',
    'prose'
  ]) {
    const f = countCaption()
    if (mutation === 'gap') f.previousPage.pageNumber = 0
    if (mutation === 'prior-caption')
      f.captions.push({ ...f.captions[0], lines: ['Table 3. Other measured samples.'] })
    if (mutation === 'current-caption')
      f.captions.push({ ...f.captions[0], page: 2, lines: ['Table 3. New measurements.'] })
    if (mutation === 'samples')
      f.previousPage.lines.find((l: { text: string }) => /n=16/.test(l.text)).text = 'Cohort'
    if (mutation === 'probability-lane')
      f.previousPage.lines.find((l: { text: string }) => l.text === 'p-value').x -= 100
    if (mutation === 'cohort-lane')
      f.previousPage.lines
        .filter((l: { x: number }) => l.x > 440)
        .forEach((l: { x: number }) => {
          l.x += 5
        })
    if (mutation === 'prior-frame') f.previousRules = []
    if (mutation === 'current-frame') f.rules.pop()
    if (mutation === 'record')
      f.tokens.find((t: { text: string }) => t.text === '19 (40%)').text = '19 missing'
    if (mutation === 'prose') f.table.structure.objects = []
    expect(inheritedCaption(f), mutation).toBeUndefined()
  }
})
it('rejects a first-page native contact block followed by four serial superscript institutions', () => {
  const f = affiliations()
  expect(isNativeAuthorAffiliationRegion(f.table, f.tokens, 1, undefined, f.rules)).toBe(true)
})
it('preserves ordinary numbered tables, captioned institutions, and independently enclosed grids', () => {
  for (const mutation of ['email', 'font', 'serial', 'rule', 'closed']) {
    const f = affiliations()
    if (mutation === 'email')
      f.tokens = f.tokens.filter((i: { text: string }) => !i.text.includes('@'))
    if (mutation === 'font')
      f.tokens
        .filter((i: { text: string }) => /^\d$/.test(i.text))
        .forEach((i: { height: number }) => (i.height = 12.75))
    if (mutation === 'serial') f.tokens.find((i: { text: string }) => i.text === '3').text = '5'
    if (mutation === 'rule') f.rules = []
    if (mutation === 'closed') f.rules.push([64, 1078, 431, 1078])
    expect(isNativeAuthorAffiliationRegion(f.table, f.tokens, 1, undefined, f.rules)).toBe(false)
  }
  const f = affiliations()
  expect(isNativeAuthorAffiliationRegion(f.table, f.tokens, 2, undefined, f.rules)).toBe(false)
  expect(
    isNativeAuthorAffiliationRegion(
      f.table,
      f.tokens,
      1,
      { lines: ['Table 1. Institutions'] },
      f.rules
    )
  ).toBe(false)
})

// One anonymous native program covers the mechanism, including real open
// stroke gaps and empty cells. No exterior frame or caption is supplied.
function interiorFenceExample(columns = 17, factor = 1): ReturnType<typeof JSON.parse> {
  const cuts = [
    10,
    ...Array.from({ length: columns - 1 }, (_, i) => 60 + i * 12),
    60 + (columns - 1) * 12
  ].map((n) => n * factor)
  const bands = Array.from({ length: 4 }, (_, r) => [
    (20 + r * 10) * factor,
    (29.6 + r * 10) * factor
  ])
  const rules: number[][] = []
  for (const x of cuts.slice(1, -1))
    for (const [top, bottom] of bands) rules.push([x, top, x, bottom])
  for (let row = 0; row < 3; row++)
    rules.push([
      cuts[0],
      (bands[row][1] + bands[row + 1][0]) / 2,
      cuts.at(-1)!,
      (bands[row][1] + bands[row + 1][0]) / 2
    ])
  const blanks = new Set([5, 6, 7, 9, 11, 12]),
    tokens: ReturnType<typeof JSON.parse>[] = []
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < columns; column++) {
      if (row === 3 && blanks.has(column)) continue
      const text =
        column === 0 ? ['Profile', 'Count', 'Rank', 'Ready'][row] : row === 3 ? '✓' : String(column)
      const baseline = (26 + row * 10) * factor,
        x = cuts[column] + 2 * factor
      tokens.push({
        text,
        rect: [x, baseline - 4 * factor, x + text.length * 2 * factor, baseline],
        baseline,
        height: 4 * factor,
        horizontal: true,
        sourceItem: { pageNumber: 1, index: tokens.length, text }
      })
    }
  const width = 300 * factor,
    height = 100 * factor
  const viewport = {
    width,
    height,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, height],
    convertToViewportPoint: (x: number, y: number) => [x, height - y]
  }
  const content = {
    items: tokens.map((t) => ({
      str: t.text,
      width: t.text.length * 2 * factor,
      height: 4 * factor,
      dir: 'ltr',
      fontName: 'F',
      transform: [4 * factor, 0, 0, 4 * factor, t.rect[0], height - t.baseline],
      sourceItem: { ...t.sourceItem }
    })),
    styles: { F: { ascent: 0, descent: 0, vertical: false } }
  }
  const operators = { fnArray: [] as number[], argsArray: [] as ReturnType<typeof JSON.parse>[] }
  for (const item of content.items) {
    operators.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      null,
      ['F', 4 * factor],
      [new Float32Array([1, 0, 0, 1, item.transform[4], item.transform[5]])],
      [
        Array.from(item.str as string, (c) => ({
          unicode: c,
          fontChar: c,
          width: 500,
          isInFont: true
        }))
      ],
      null
    )
  }
  operators.fnArray.push(OPS.setLineWidth, OPS.setLineCap)
  operators.argsArray.push([0.398 * factor], [0])
  const graphicsBounds = rules.map((r) => {
    const operationIndex = operators.fnArray.length
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, r[0], height - r[1], 1, r[2], height - r[3]])],
      new Float32Array([r[0], height - r[3], r[2], height - r[1]])
    ])
    return {
      kind: 'path',
      operationIndex,
      normalizedRect: r.map((n, i) => n / (i % 2 ? height : width))
    }
  })
  const context = {
    content,
    viewport,
    operators,
    graphicsBounds,
    glyphBounds: [
      {
        fontName: 'F',
        glyphs: [...new Set(content.items.flatMap((t) => Array.from(t.str as string)))].map(
          (c) => ({ fontChar: c, bounds: [0, 0, 0.5, 0.7] })
        )
      }
    ]
  }
  return {
    tokens,
    rules,
    cuts,
    bands,
    page: { pageNumber: 1, width, height, invalidGraphicsBounds: 0, graphicsBounds },
    context
  }
}
const recoverInteriorFence = (
  f: ReturnType<typeof interiorFenceExample>
): ReturnType<typeof JSON.parse> => recoverNativeInteriorFenceTables(f.page, f.tokens, f.context)
function prependInteriorPaint(
  f: ReturnType<typeof interiorFenceExample>,
  operations: [number, ReturnType<typeof JSON.parse>][]
): void {
  f.context.operators.fnArray.unshift(...operations.map(([op]) => op))
  f.context.operators.argsArray.unshift(...operations.map(([, args]) => args))
  for (const graphic of f.page.graphicsBounds) graphic.operationIndex += operations.length
}
function refineInteriorFence(
  f: ReturnType<typeof interiorFenceExample>
): ReturnType<typeof JSON.parse> {
  const proof = recoverInteriorFence(f)[0]
  const work = {
    ...f.context.viewport,
    scale: 1.5,
    width: f.page.width * 1.5,
    height: f.page.height * 1.5,
    transform: [1.5, 0, 0, -1.5, 0, f.page.height * 1.5],
    convertToViewportPoint: (x: number, y: number) => [x * 1.5, f.page.height * 1.5 - y * 1.5]
  }
  const tokens = f.context.content.items.map((t: ReturnType<typeof JSON.parse>) =>
    tableTextToken(t, work, 0)
  )
  const rules = collectTableRules(f.context.operators, f.context.viewport).map((r: number[]) =>
    r.map((n) => n * 1.5)
  )
  return {
    proof,
    table: { ...refineTable(proof.table, tokens, [], [], rules), page: 1, notes: [] }
  }
}
it('recovers native sparse slots without inventing a caption or joining disconnected fences', () => {
  const f = interiorFenceExample(),
    before = JSON.stringify(f)
  expect(
    recoverRuledTable(
      f.tokens.map((t: ReturnType<typeof JSON.parse>) => ({
        ...t,
        rect: t.rect.map((n: number) => n * 1.5),
        height: t.height * 1.5,
        baseline: t.baseline * 1.5
      })),
      f.rules.map((r: number[]) => r.map((n) => n * 1.5)),
      1
    )
  ).toBeUndefined()
  const { proof, table } = refineInteriorFence(f)
  expect(proof.grid).toHaveLength(4)
  expect(proof.grid.every((r: string[]) => r.length === 17)).toBe(true)
  expect(
    proof.sources.filter((c: ReturnType<typeof JSON.parse>) => !c.sourceItems.length)
  ).toHaveLength(6)
  expect(table.grid).toEqual(proof.grid)
  expect(
    table.cells.flatMap((c: ReturnType<typeof JSON.parse>) => c.sourceItems ?? [])
  ).toHaveLength(62)
  expect(table.issues).toEqual([])
  const final = finalizeNativeInteriorFenceTable(table, proof, f.page, f.tokens, f.context, [], [])
  expect(final.cropRects).toEqual([proof.table.cropRect])
  expect(final.grid).toEqual(table.grid)
  expect(final.cells).toEqual(table.cells)
  expect(final.caption).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it('uses the same proof with fewer columns rather than changing the generic column limit', () => {
  const f = interiorFenceExample(7)
  expect(recoverInteriorFence(f)[0].grid.every((r: string[]) => r.length === 7)).toBe(true)
})
it.each(['transparent', 'translucent', 'white-fill', 'white-stroke', 'unknown-color'])(
  'requires visible opaque native sparse-table paint: %s',
  (guard) => {
    const f = interiorFenceExample()
    const operation: [number, ReturnType<typeof JSON.parse>] =
      guard === 'transparent' || guard === 'translucent'
        ? [OPS.setGState, [[['ca', guard === 'transparent' ? 0 : 0.5]]]]
        : guard === 'white-stroke'
          ? [OPS.setStrokeRGBColor, ['#ffffff']]
          : [OPS.setFillRGBColor, [guard === 'white-fill' ? '#ffffff' : undefined]]
    prependInteriorPaint(f, [operation])
    expect(recoverInteriorFence(f)).toEqual([])
  }
)
it('restores the native opaque text state and accepts ordinary nonwhite colors', () => {
  for (const operations of [
    [
      [OPS.save, null],
      [OPS.setGState, [[['ca', 0]]]],
      [OPS.setFillRGBColor, ['#ffffff']],
      [OPS.restore, null]
    ],
    [
      [OPS.setFillRGBColor, ['#336699']],
      [OPS.setStrokeRGBColor, ['#223344']]
    ]
  ] as [number, ReturnType<typeof JSON.parse>][][]) {
    const f = interiorFenceExample()
    prependInteriorPaint(f, operations)
    expect(recoverInteriorFence(f)).toHaveLength(1)
  }
})
it('rejects shared rule endpoints that omit an aligned native terminal lane', () => {
  const f = interiorFenceExample()
  for (const graphic of f.page.graphicsBounds.slice(-3)) {
    f.context.operators.argsArray[graphic.operationIndex][1][0][4] = 237
    f.context.operators.argsArray[graphic.operationIndex][2][2] = 237
    graphic.normalizedRect[2] = 237 / 300
  }
  expect(recoverInteriorFence(f)).toEqual([])
})
it.each([0.005, 0.5])(
  'checks foreign fill against the actual raster footprint and AA pixel: %s',
  (gap) => {
    const f = interiorFenceExample(),
      top = recoverInteriorFence(f)[0].nativeCrop[3] + gap
    const bottom = top + 0.1,
      operationIndex = f.context.operators.fnArray.length
    f.context.operators.fnArray.push(OPS.constructPath)
    f.context.operators.argsArray.push([
      OPS.fill,
      [
        new Float32Array([
          0,
          80,
          100 - top,
          1,
          150,
          100 - top,
          1,
          150,
          100 - bottom,
          1,
          80,
          100 - bottom,
          4
        ])
      ],
      new Float32Array([80, 100 - bottom, 150, 100 - top])
    ])
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex,
      normalizedRect: [80 / 300, top / 100, 150 / 300, bottom / 100]
    })
    expect(recoverInteriorFence(f)).toHaveLength(gap === 0.005 ? 0 : 1)
  }
)
it('declines a geometrically equivalent table above the conservative initial PNG pixel budget', () => {
  expect(recoverInteriorFence(interiorFenceExample())).toHaveLength(1)
  expect(recoverInteriorFence(interiorFenceExample(17, 10))).toEqual([])
})
it('binds source rectangles through the original work transform without round-trip tolerance', () => {
  const f = interiorFenceExample()
  f.tokens[1].rect[0] = 62.001
  f.tokens[1].rect[2] = 64.001
  f.context.content.items[1].transform[4] = 62.001
  f.context.operators.argsArray[7][0][4] = 62.001
  const { proof, table } = refineInteriorFence(f)
  const source = proof.sources.find(
    (c: { row: number; column: number }) => c.row === 0 && c.column === 1
  )
  expect(source.sourceRects[0][2]).toBe(62.001 * 1.5 + 3)
  expect(source.sourceRects[0][2]).not.toBe(64.001 * 1.5)
  expect(
    finalizeNativeInteriorFenceTable(table, proof, f.page, f.tokens, f.context, [], [])
  ).toBeDefined()
})
it.each(['table', 'figure', 'caption'])('rejects a competing native %s owner', (kind) => {
  const f = interiorFenceExample(),
    crop = recoverInteriorFence(f)[0].nativeCrop
  expect(
    recoverNativeInteriorFenceTables(
      f.page,
      f.tokens,
      f.context,
      kind === 'caption' ? [] : [crop],
      kind === 'caption' ? [{ rect: crop }] : []
    )
  ).toEqual([])
})
it.each([
  'outline',
  'packet',
  'source-id',
  'source-rect',
  'duplicate-source',
  'one-fence',
  'row-fence',
  'horizontal-end',
  'glyph-column',
  'glyph-row',
  'empty-letter',
  'line-cap',
  'foreign-paint',
  'unknown-paint'
])('requires complete native sparse-slot evidence: %s', (guard) => {
  const f = interiorFenceExample(),
    o = f.context.operators
  if (guard === 'outline') f.context.glyphBounds[0].glyphs.pop()
  if (guard === 'packet') o.fnArray[o.fnArray.indexOf(OPS.endText)] = OPS.dependency
  if (guard === 'source-id') f.tokens[0].sourceItem.index++
  if (guard === 'source-rect') f.tokens[0].rect[0]++
  if (guard === 'duplicate-source') f.tokens.push(structuredClone(f.tokens[0]))
  if (guard === 'one-fence') o.argsArray[f.page.graphicsBounds[0].operationIndex][0] = OPS.endPath
  if (guard === 'row-fence') o.argsArray[f.page.graphicsBounds[0].operationIndex][1][0][2]--
  if (guard === 'horizontal-end')
    o.argsArray[f.page.graphicsBounds.at(-1).operationIndex][1][0][4]--
  if (guard === 'glyph-column')
    f.context.glyphBounds[0].glyphs.find(
      (g: { fontChar: string }) => g.fontChar === '1'
    ).bounds[2] = 3
  if (guard === 'glyph-row')
    f.context.glyphBounds[0].glyphs.find(
      (g: { fontChar: string }) => g.fontChar === '1'
    ).bounds[3] = 3
  if (guard === 'empty-letter')
    f.context.glyphBounds[0].glyphs.find((g: { fontChar: string }) => g.fontChar === 'P').bounds = [
      0, 0, 0, 0
    ]
  if (guard === 'line-cap') o.argsArray[o.fnArray.indexOf(OPS.setLineCap)] = [1]
  if (guard === 'unknown-paint') {
    o.fnArray.push(OPS.fill)
    o.argsArray.push(null)
  }
  if (guard === 'foreign-paint') {
    const operationIndex = o.fnArray.length
    o.fnArray.push(OPS.constructPath)
    o.argsArray.push([
      OPS.fill,
      [new Float32Array([0, 111, 45, 1, 114, 45, 1, 114, 47])],
      new Float32Array([111, 45, 114, 47])
    ])
    f.page.graphicsBounds.push({
      kind: 'path',
      operationIndex,
      normalizedRect: [111 / 300, 53 / 100, 114 / 300, 55 / 100]
    })
  }
  expect(recoverInteriorFence(f)).toEqual([])
})
it.each([
  'grid',
  'cell-text',
  'source-rect',
  'duplicate-cell',
  'source-segment',
  'caption',
  'note',
  'new-competitor'
])('rechecks a recovered sparse table after ordinary passes: %s', (guard) => {
  const f = interiorFenceExample(),
    { proof, table } = refineInteriorFence(f)
  if (guard === 'grid') table.grid[0][1] = 'changed'
  if (guard === 'cell-text') table.cells[0].text += '?'
  if (guard === 'source-rect') table.cells[0].sourceRects[0][0]++
  if (guard === 'duplicate-cell') table.cells.push(structuredClone(table.cells[0]))
  if (guard === 'source-segment') table.cells[0].sourceSegments = [{ index: 0 }]
  if (guard === 'caption') table.caption = { lines: ['A competing caption'] }
  if (guard === 'note') table.notes.push({ lines: ['A separate note'] })
  expect(
    finalizeNativeInteriorFenceTable(
      table,
      proof,
      f.page,
      f.tokens,
      f.context,
      guard === 'new-competitor' ? [proof.nativeCrop] : [],
      []
    )
  ).toBeUndefined()
})
