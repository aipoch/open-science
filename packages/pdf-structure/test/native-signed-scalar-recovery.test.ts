import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths'

const { signedNativeRecords } = await import(
  pathToFileURL(resolve('test/fixtures/signed-native-records.mjs')).href
)
const { recoverCaptionedRuledTables } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
type Fixture = ReturnType<typeof JSON.parse>
const recover = (f: Fixture): Fixture[] =>
  recoverCaptionedRuledTables(f.items, f.rules, f.captions, 1, [], [], f.paint, f.evidence).filter(
    (t: Fixture) => t.id.startsWith('p1-native-compact-table-')
  )

it('recovers complete signed records with independent explicit symbol and numeric fonts', () => {
  const f = signedNativeRecords(),
    before = JSON.stringify(f),
    tables = recover(f)
  expect(tables).toHaveLength(1)
  expect(tables[0].structure.objects.filter((o: Fixture) => o.label === 'table row')).toHaveLength(
    7
  )
  expect(
    tables[0].structure.objects.filter((o: Fixture) => o.label === 'table column')
  ).toHaveLength(8)
  expect(JSON.stringify(f)).toBe(before)
})

it.each([
  'renderer',
  'symbol font',
  'glyph',
  'source order',
  'sign scale',
  'missing leaf',
  'crossing header',
  'closing paint',
  'source alias',
  'intervening caption',
  'unsigned',
  'missing value',
  'uncertainty lane',
  'unclaimed ink'
])('declines incomplete signed-source proof: %s', (mode) => {
  const f = signedNativeRecords(mode),
    c = f.evidence.context,
    sign = f.items.find((t: Fixture) => t.text === '−')
  if (mode === 'renderer') delete f.evidence
  if (mode === 'symbol font') delete c.content.styles.S
  if (mode === 'glyph') c.glyphBounds.find((g: Fixture) => g.fontName === 'S').glyphs = []
  if (mode === 'source order') sign.sourceItem.index += 1000
  if (mode === 'sign scale') c.content.items[sign.sourceItem.index].transform[0] += 1
  if (mode === 'missing leaf') f.items.splice(3, 2)
  if (mode === 'crossing header') f.items[3].rect[0] -= 90
  if (mode === 'closing paint') f.paint.delete(f.rules[2].join(','))
  if (mode === 'source alias') f.items.push({ ...f.items[0], rect: [610, 57, 650, 72] })
  if (mode === 'intervening caption')
    f.captions.push({ page: 1, lines: ['Table 2: Independent table'], rect: [0, 160, 600, 175] })
  expect(recover(f)).toEqual([])
})

// Generated native operations only: no external paper text, names or IDs.
const { OPS: segmentedOps } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { collectTableRules: segmentedRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const { tableTextToken: segmentedToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { nativePageTextPacketInventory: strictSegmentedPacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)

function segmentedMixedFixture(): Fixture {
  const height = 600,
    viewport = {
      width: 500,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
    },
    work = {
      ...viewport,
      scale: 1.5,
      width: 750,
      height: 900,
      transform: [1.5, 0, 0, -1.5, 0, 900],
      convertToViewportPoint: (x: number, y: number): number[] => [x * 1.5, (height - y) * 1.5]
    },
    operators = { fnArray: [] as number[], argsArray: [] as unknown[] },
    raw: Fixture[] = [],
    glyphs = new Map<string, Fixture>(),
    add = (op: number, args: unknown): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    text = (str: string, x: number, baseline: number): void => {
      const sourceItem = { pageNumber: 1, index: raw.length, text: str }
      raw.push({
        str,
        dir: 'ltr',
        width: str.length * 4,
        height: 8,
        transform: [8, 0, 0, 8, x, height - baseline],
        fontName: 'F',
        hasEOL: false,
        sourceItem
      })
      add(segmentedOps.beginText, null)
      add(segmentedOps.setFont, ['F', 8])
      add(segmentedOps.moveText, [x, height - baseline])
      add(segmentedOps.showText, [
        Array.from(str, (unicode) => {
          const glyph = {
            unicode,
            fontChar: unicode,
            width: 500,
            isSpace: unicode === ' ',
            originalCharCode: unicode.charCodeAt(0),
            accent: null,
            isInFont: true
          }
          glyphs.set(unicode, {
            fontChar: unicode,
            bounds: unicode === ' ' ? [0, 0, 0, 0] : [0, 0, 0.5, 0.5]
          })
          return glyph
        })
      ])
      add(segmentedOps.endText, null)
    },
    line = (x0: number, y0: number, x1: number, y1: number): void => {
      add(segmentedOps.constructPath, [
        segmentedOps.stroke,
        [[0, x0, height - y0, 1, x1, height - y1]],
        [Math.min(x0, x1), height - Math.max(y0, y1), Math.max(x0, x1), height - Math.min(y0, y1)]
      ])
    }
  // This unrelated original group must keep rejecting the ordinary page packet.
  add(segmentedOps.beginGroup, [
    { matrix: null, bbox: [0, 500, 20, 520], smask: null, isolated: false, knockout: false }
  ])
  add(segmentedOps.endGroup, null)
  add(segmentedOps.setStrokeRGBColor, ['#000000'])
  add(segmentedOps.setLineWidth, [0.4])
  add(segmentedOps.setLineCap, [0])
  text('Table 1: Mixed records', 174, 86)
  text('Z', 10, 20)
  raw.at(-1)!.transform = [0, 8, -8, 0, 10, height - 20]
  operators.fnArray.splice(
    operators.fnArray.length - 3,
    1,
    segmentedOps.setTextMatrix,
    segmentedOps.moveText
  )
  operators.argsArray.splice(
    operators.argsArray.length - 3,
    1,
    [new Float32Array([0, 1, -1, 0, 10, height - 20])],
    [0, 0]
  )
  const rows = [
    ['Configuration', 'Score', 'Seed', 'Enabled', 'Disabled'],
    ['[12,6,k=2]', '3.5', 'Alpha', '1,2,3', '7,8,9'],
    ['[24,8,k=2]', '3', 'Beta', '2,3,4', '8,9,10'],
    ['[48,24,k=4]', '2', 'Alpha', '3,4,5', '9,10,11'],
    ['[96,48,k=4]', '2.5', 'Beta', '4,5,6', '10,11,12']
  ]
  for (let row = 0; row <= 5; row++) line(30, 100 + row * 10, 430, 100 + row * 10)
  for (let row = 0; row < 5; row++) {
    // The real corner gaps stay open; each segment spans the complete row ink.
    for (let col = 0; col <= 5; col++)
      line(30 + col * 80, 100 + row * 10 + 0.201, 30 + col * 80, 110 + row * 10 - 0.201)
    for (let col = 0; col < 5; col++) {
      text(rows[row][col], 40 + col * 80, 106 + row * 10)
      if (col < 4) {
        const prior = raw.at(-1)!,
          x = prior.transform[4] + prior.width
        raw.push({
          ...prior,
          str: ' ',
          width: 40 + (col + 1) * 80 - x,
          height: 0,
          transform: [8, 0, 0, 8, x, height - 106 - row * 10],
          sourceItem: { pageNumber: 1, index: raw.length, text: ' ' }
        })
      }
    }
  }
  text('Neighbor 42', 50, 196)
  text('Neighbor 84', 50, 206)
  const content = { items: raw, styles: { F: { ascent: 0.7, descent: -0.2, vertical: false } } },
    tokens = raw
      .filter((r) => r.str.trim())
      .map((r) => ({
        ...segmentedToken(r, viewport, 0),
        fontAscent: 0.7,
        fontDescent: -0.2,
        nativeLabelRect: segmentedToken(r, viewport, 0).rect
      })),
    items = raw.filter((r) => r.str.trim()).map((r) => segmentedToken(r, work, 0)),
    paint = new Map(),
    rules = segmentedRules(operators, work, paint),
    page = { pageNumber: 1, width: 500, height, invalidGraphicsBounds: 0, graphicsBounds: [] },
    context = {
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      operators,
      viewport,
      content,
      graphicsBounds: page.graphicsBounds,
      glyphBounds: [{ fontName: 'F', glyphs: [...glyphs.values()] }]
    },
    existing = [
      {
        id: 'page-1-table-2',
        cropRect: [30, 270, 645, 330],
        structure: {
          objects: [
            { label: 'table row', rect: [0, 0, 615, 30] },
            { label: 'table row', rect: [0, 30, 615, 60] },
            { label: 'table column', rect: [0, 0, 300, 60] },
            { label: 'table column', rect: [300, 0, 615, 60] }
          ]
        }
      }
    ]
  return {
    items,
    rules,
    paint,
    existing,
    evidence: { page, context, tokens },
    captions: [{ page: 1, lines: ['Table 1: Mixed records'], rect: [255, 112.5, 405, 135] }]
  }
}

const recoverSegmented = (f: Fixture): Fixture[] =>
  recoverCaptionedRuledTables(
    f.items,
    f.rules,
    f.captions,
    1,
    f.existing,
    [],
    f.paint,
    f.evidence
  ).filter((t: Fixture) => t.caption === f.captions[0])

it('recovers a captioned segmented mixed grid without treating its neighbor as complete', () => {
  const f = segmentedMixedFixture(),
    before = JSON.stringify(f),
    tables = recoverSegmented(f)
  expect(tables).toHaveLength(1)
  expect(tables[0].id).toBe('page-1-table-3')
  expect(tables[0].structure.objects.filter((o: Fixture) => o.label === 'table row')).toHaveLength(
    5
  )
  expect(
    tables[0].structure.objects.filter((o: Fixture) => o.label === 'table column')
  ).toHaveLength(5)
  expect(f.evidence.context.content.items.filter((r: Fixture) => r.height === 0)).toHaveLength(20)
  expect(JSON.stringify(f)).toBe(before)
  expect(
    strictSegmentedPacket(f.evidence.page, f.evidence.tokens, f.evidence.context)
  ).toBeUndefined()
})

it.each([
  'caption',
  'rail',
  'glyph',
  'literal',
  'source transform',
  'source alias',
  'clip',
  'render mode',
  'foreign ink',
  'matrix shape'
])('declines an incomplete captioned segmented proof: %s', (mode) => {
  const f = segmentedMixedFixture(),
    c = f.evidence.context
  if (mode === 'caption') f.captions = []
  if (mode === 'rail') f.rules.splice(0, 1)
  if (mode === 'glyph') c.glyphBounds[0].glyphs = []
  if (mode === 'literal') c.content.items.find((r: Fixture) => r.str === 'Alpha').str = 'Omega'
  if (mode === 'source transform')
    c.content.items.find((r: Fixture) => r.str === 'Alpha').transform[4] += 1
  if (mode === 'matrix shape') {
    const op = c.operators.fnArray.indexOf(segmentedOps.setTextMatrix)
    c.operators.argsArray[op] = [new Float32Array([0, 1, -1, 0, 10])]
  }
  if (mode === 'source alias') f.items.push({ ...f.items[0], rect: [700, 700, 750, 710] })
  if (mode === 'clip') {
    const op = c.operators.fnArray.indexOf(segmentedOps.beginText)
    c.operators.fnArray.splice(
      op,
      0,
      segmentedOps.constructPath,
      segmentedOps.clip,
      segmentedOps.endPath
    )
    c.operators.argsArray.splice(
      op,
      0,
      [
        segmentedOps.endPath,
        [[0, 30, 495, 1, 430, 495, 1, 430, 490, 1, 30, 490, 4]],
        [30, 490, 430, 495]
      ],
      null,
      null
    )
  }
  if (mode === 'render mode') {
    const op = c.operators.fnArray.indexOf(segmentedOps.beginText)
    c.operators.fnArray.splice(op + 1, 0, segmentedOps.setTextRenderingMode)
    c.operators.argsArray.splice(op + 1, 0, [3])
  }
  if (mode === 'foreign ink') {
    // The raw item remains outside, but its true font outline reaches the body.
    const glyph = c.glyphBounds[0].glyphs.find((g: Fixture) => g.fontChar === 'N')
    glyph.bounds = [0, 0, 0.5, 12]
  }
  expect(recoverSegmented(f)).toEqual([])
})

it('allocates the next exact page-table ordinal across sparse existing IDs', () => {
  const f = segmentedMixedFixture()
  f.existing.push(
    { ...f.existing[0], id: 'page-1-table-7', cropRect: [700, 700, 730, 720] },
    { ...f.existing[0], id: 'page-2-table-99', cropRect: [700, 740, 730, 760] },
    { ...f.existing[0], id: 'page-1-table-40-extra', cropRect: [700, 780, 730, 800] }
  )
  expect(recoverSegmented(f).map((t: Fixture) => t.id)).toEqual(['page-1-table-8'])
})

it('keeps the generated table thumbnail inside the existing owned scratch lifecycle', async () => {
  const { mkdtemp, mkdir, writeFile, realpath, rm, lstat } = await import('node:fs/promises')
  const { join, dirname, basename, resolve: absolute } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { createCanvas } = await import('@napi-rs/canvas')
  const { inspectScratch } = await import(pathToFileURL(resolve('resources/scratch.mjs')).href)
  const base = await realpath(tmpdir()),
    root = await mkdtemp(join(base, 'pdf-segmented-scratch-'))
  try {
    const [table] = recoverSegmented(segmentedMixedFixture())
    expect(table).toBeDefined()
    const png = await createCanvas(1, 1).encode('png')
    await mkdir(join(root, 'thumbnails'))
    await writeFile(join(root, 'thumbnails', table.id + '.png'), png)
    expect(await inspectScratch(root, false)).toBe(png.length)
    expect(await inspectScratch(root, true)).toBe(png.length)
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    // Only this newly created test directory can be removed on either verdict.
    expect(dirname(absolute(root))).toBe(absolute(base))
    expect(basename(root).startsWith('pdf-segmented-scratch-')).toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})

const { recoverUnclaimedTightTableCaption } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const tightCaptionFixture = (): Fixture => {
  const caption = { page: 1, lines: ['Table 2: Summary'], rect: [70, 80, 170, 95] },
    association = { reason: 'ambiguous-table-caption' },
    rect = [50, 100, 200, 150]
  return { caption, association, rect, captions: [caption], associations: [association] }
}
it('clears only the stale ambiguity after the original unique above-caption recovery', () => {
  const f = tightCaptionFixture(),
    before = JSON.stringify(f.association),
    result = recoverUnclaimedTightTableCaption(
      f.association,
      f.rect,
      f.captions,
      f.associations,
      0,
      1
    )
  expect(result.caption).toBe(f.caption)
  expect(result.reason).toBeUndefined()
  expect(JSON.stringify(f.association)).toBe(before)
  const owned = { caption: f.caption, reason: 'retained-private-footer' }
  expect(recoverUnclaimedTightTableCaption(owned, f.rect, f.captions, [owned], 0, 1)).toBe(owned)
})
it('retains ambiguity when the recovered caption lies inside the table band', () => {
  const f = tightCaptionFixture()
  f.caption.rect = [70, 95, 170, 110]
  const result = recoverUnclaimedTightTableCaption(
    f.association,
    f.rect,
    f.captions,
    f.associations,
    0,
    1
  )
  expect(result.caption).toBe(f.caption)
  expect(result.reason).toBe('ambiguous-table-caption')
})
it('does not take a tight caption already owned by another table', () => {
  const f = tightCaptionFixture()
  f.associations.push({ caption: f.caption })
  expect(
    recoverUnclaimedTightTableCaption(f.association, f.rect, f.captions, f.associations, 0, 1)
  ).toBe(f.association)
  expect(f.association.caption).toBeUndefined()
})
it('keeps other reasons when the original tight fallback recovers a caption', () => {
  const f = tightCaptionFixture()
  f.association.reason = 'unproven-table-description'
  const result = recoverUnclaimedTightTableCaption(
    f.association,
    f.rect,
    f.captions,
    f.associations,
    0,
    1
  )
  expect(result.caption).toBe(f.caption)
  expect(result.reason).toBe('unproven-table-description')
})
