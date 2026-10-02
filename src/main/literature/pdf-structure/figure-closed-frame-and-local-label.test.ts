import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { associateFigures, associateUncaptionedRasterFigure, associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { collectClosedFigureFrames, collectTableRules, excludeRepeatedMarginContent } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-graphics.mjs')).href
)
const { closedCaptionFigureFrame } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-figure-connectivity.mjs')).href
)
const fixture = (name: string): ReturnType<typeof readPdfFixture> =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/${name}.jsonl`))
it('keeps the neighbouring independently captioned plot out of the left plot', () => {
  const x = fixture('separate-captioned-vector-plots-in-parallel-columns')
  expect(associateFigures(x.page, x.captions)[0].rect[2]).toBeLessThan(310)
})
it('excludes the author above its native closing rule while retaining the complete raster', () => {
  const x = fixture('captioned-raster-below-native-author-rule')
  expect(associateFigures(x.page, x.captions)[0].rect[1]).toBeGreaterThan(45)
})
it('keeps the native running-header proof after repeated margin graphics are excluded', () => {
  const x = fixture('captioned-raster-below-native-author-rule'),
    [page] = excludeRepeatedMarginContent([x.page, { ...structuredClone(x.page), pageNumber: 2 }])
  expect(page.graphicsBounds).toHaveLength(x.page.graphicsBounds.length - 1)
  const [figure] = associateFigures(page, x.captions, [], [[48, 37.5, 545.943, 37.5]])
  expect(figure.rect[1]).toBeGreaterThan(45)
  expect(figure.rect[3]).toBeGreaterThan(500)
})
it.each(['missing rule', 'competing rule', 'short rule', 'distant rule', 'overlapping image'])(
  'does not exclude a label without strict native header proof (%s)',
  (reason) => {
    const x = fixture('captioned-raster-below-native-author-rule'),
      [page] = excludeRepeatedMarginContent([x.page, { ...structuredClone(x.page), pageNumber: 2 }])
    const rules = [[48, 37.5, 545.943, 37.5]]
    if (reason === 'missing rule') rules.pop()
    if (reason === 'competing rule') rules.push([48, 38, 545.943, 38])
    if (reason === 'short rule') rules[0][2] = 400
    if (reason === 'distant rule') rules[0][1] = rules[0][3] = 40
    if (reason === 'overlapping image')
      page.graphicsBounds.find((g: { kind: string }) => g.kind === 'image').normalizedRect[1] = 0.03
    expect(associateFigures(page, x.captions, [], rules)[0].rect[1]).toBeLessThanOrEqual(45)
  }
)
it('preserves the native upper branch connectors beside a side caption', () => {
  const x = fixture('side-captioned-diagram-with-upper-branch-connectors')
  expect(associateFigures(x.page, x.captions)[0].rect[1]).toBeLessThan(60)
})
it('does not assign publisher decoration to a separate figure legend list', () => {
  const x = fixture('separate-legend-list-below-publisher-decoration')
  expect(
    associateFigures(x.page, x.captions).filter((f: { rect?: number[] }) => f.rect)
  ).toHaveLength(0)
})
it('retains the complete native closed frame beside its lower side caption', () => {
  const x = readPdfFixture(
    resolve('src/main/literature/pdf-structure/fixtures/side-captioned-closed-diagram-frame.jsonl')
  )
  const [figure] = associateFigures(x.page, x.captions, [], [], x.frames)
  expect(figure.rect[2]).toBeGreaterThan(550)
  expect(figure.rect[3]).toBeGreaterThan(289)
})
it('requires explicit four axis-aligned closed stroke edges', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const polygon = [0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 4]
  const view = { transform: [1, 0, 0, 1, 0, 0] }
  const ops = (
    path: number[],
    paint = OPS.stroke
  ): { fnArray: number[]; argsArray: unknown[][] } => ({
    fnArray: [OPS.constructPath],
    argsArray: [[paint, [path], [10, 20, 110, 120]]]
  })
  expect(collectClosedFigureFrames(ops(polygon), view)).toEqual([[10, 20, 110, 120]])
  expect(collectClosedFigureFrames(ops(polygon.slice(0, -1)), view)).toEqual([])
  expect(collectClosedFigureFrames(ops(polygon, OPS.fill), view)).toEqual([])
  const diagonal = [...polygon]
  diagonal[4] = 100
  expect(collectClosedFigureFrames(ops(diagonal), view)).toEqual([])
})
it('ignores absent or non-array native paths while retaining typed-array closed frames', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const view = { transform: [1, 0, 0, 1, 0, 0] }
  const ops = (path: unknown): { fnArray: number[]; argsArray: unknown[][] } => ({
    fnArray: [OPS.constructPath],
    argsArray: [[OPS.stroke, [path], [10, 20, 110, 120]]]
  })
  for (const path of [null, undefined, {}, '', { length: 13 }, new DataView(new ArrayBuffer(16))])
    expect(collectClosedFigureFrames(ops(path), view)).toEqual([])
  expect(
    collectClosedFigureFrames(
      ops(new Float32Array([0, 10, 20, 1, 110, 20, 1, 110, 120, 1, 10, 120, 4])),
      view
    )
  ).toEqual([[10, 20, 110, 120]])
})
it('preserves continuous monotonic native rule segments without bridging a branch or curve', async () => {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const ops = (path: number[]): { fnArray: number[]; argsArray: unknown[][] } => ({
    fnArray: [OPS.constructPath],
    argsArray: [[OPS.stroke, [path], [0, 0, 423.05, 0]]]
  })
  const path = [0, 0, 0, 1, 183.896, 0, 1, 256.594, 0, 1, 329.291, 0, 1, 423.05, 0]
  const view = { transform: [1, 0, 0, 1, 0, 0] }
  expect(collectTableRules(ops(path), view)).toEqual([
    [0, 0, 183.896, 0],
    [183.896, 0, 256.594, 0],
    [256.594, 0, 329.291, 0],
    [329.291, 0, 423.05, 0]
  ])
  const branch = [...path]
  branch[7] = 100
  expect(collectTableRules(ops(branch), view)).toEqual([])
  const diagonal = [...path]
  diagonal[5] = 5
  expect(collectTableRules(ops(diagonal), view)).toEqual([])
  const duplicate = [...path]
  duplicate[7] = 183.896
  expect(collectTableRules(ops(duplicate), view)).toEqual([])
  expect(collectTableRules(ops([...path, 4]), view)).toEqual([])
  const curve = [...path]
  curve[6] = 2
  expect(collectTableRules(ops(curve), view)).toEqual([])
})
it('does not claim an independent caption or recognized table inside the closed frame', () => {
  const x = fixture('side-captioned-closed-diagram-frame'),
    c = x.captions[0]
  expect(
    closedCaptionFigureFrame(
      x.page,
      c,
      [c, { page: 1, lines: ['Table 2. Independent results.'], rect: [260, 90, 400, 110] }],
      [],
      x.frames
    )
  ).toBeUndefined()
  expect(closedCaptionFigureFrame(x.page, c, [c], [[260, 90, 400, 220]], x.frames)).toBeUndefined()
  expect(
    closedCaptionFigureFrame({ ...x.page, lines: x.page.lines.slice(0, 2) }, c, [c], [], x.frames)
  ).toBeUndefined()
})
it('recovers an isolated uncaptioned embedded plate without inventing a label', () => {
  const x = fixture('uncaptioned-isolated-raster-with-outlined-watermark')
  const [figure] = associateUncaptionedRasterFigure(x.page, [])
  expect(figure.rect).toEqual(
    x.page.graphicsBounds[0].normalizedRect.map(
      (v: number, n: number) => v * (n % 2 ? x.page.height : x.page.width)
    )
  )
  expect(figure.caption).toBeUndefined()
  expect(
    associateUncaptionedRasterFigure(x.page, [
      { page: 1, lines: ['Figure 1. Other.'], rect: [0, 0, 100, 10] }
    ])
  ).toEqual([])
  expect(associateUncaptionedRasterFigure(x.page, [], [[60, 260, 390, 600]])).toEqual([])
  expect(
    associateUncaptionedRasterFigure(
      {
        ...x.page,
        lines: [
          {
            text: 'An ordinary article paragraph beside its illustration.',
            x: 20,
            y: 200,
            width: 400,
            height: 10,
            fontSize: 10
          }
        ]
      },
      []
    )
  ).toEqual([])
  const fullPage = structuredClone(x.page)
  fullPage.graphicsBounds[0].normalizedRect = [0, 0, 1, 1]
  expect(associateUncaptionedRasterFigure(fullPage, [])).toEqual([])
})
it('includes a centered wrapped caption only when its complete native top rule proves the band', () => {
  const x = fixture('centered-two-line-table-caption-above-native-rule')
  expect(findCaptionCandidates([x.page], new Map([[1, x.rules]]))[0].lines).toHaveLength(2)
  expect(findCaptionCandidates([x.page])[0].lines).toHaveLength(1)
  const broken = x.rules.map((r: number[]) => [r[0], r[1], 400, r[3]])
  expect(findCaptionCandidates([x.page], new Map([[1, broken]]))[0].lines).toHaveLength(1)
})
it('recognizes a noun list title while rejecting its finite-verb reference', () => {
  expect(captionKind('Table 1 List of sample measures')).toBe('table')
  expect(captionKind('Table 1 lists the sample measures.')).toBeUndefined()
  expect(captionKind('Table 1 list the sample measures.')).toBeUndefined()
})
it('recognizes native Spanish and decorated German captions without changing source labels', () => {
  for (const text of ['Figura 1 Localización del marcador.', '▶abb. 1 Studienmodell.'])
    expect(captionKind(text)).toBe('figure')
  for (const text of ['Tabla 2 Resultados del estudio.', '▶tab. 1 Vergleich der Gruppen.'])
    expect(captionKind(text)).toBe('table')
})
it('rejects local-language inline figure and table references', () => {
  for (const text of [
    'Figura 1 muestra los resultados.',
    'Tabla 2 presenta los datos.',
    '▶Abb. 1 zeigt die Daten.',
    '▶Tab. 1 enthält Werte.',
    'Figura 1). El resultado',
    '▶Abb. 1). Das Ergebnis'
  ])
    expect(captionKind(text)).toBeUndefined()
})

const continuationMarkerLayout = (): {
  page: {
    pageNumber: number
    width: number
    height: number
    lines: never[]
    graphicsBounds: never[]
  }
  tables: { rect: number[] }[]
  captions: { page: number; lines: string[]; rect: number[] }[]
  rules: number[][]
} => ({
  page: { pageNumber: 1, width: 240, height: 400, lines: [], graphicsBounds: [] },
  tables: [{ rect: [10, 100, 210, 300] }],
  captions: [
    {
      page: 1,
      lines: ['Table 3: Distribution of measured characteristics'],
      rect: [12, 77, 198, 95]
    },
    { page: 1, lines: ['Table 3 (continues)'], rect: [160, 305, 208, 313] }
  ],
  rules: [[12, 101, 208, 101]]
})
it('associates the native-rule-proved full title above its same-number footer continuation marker', () => {
  const x = continuationMarkerLayout()
  expect(associateTableCaptions(x.page, x.tables, x.captions, x.rules)[0].caption).toEqual(
    x.captions[0]
  )
})
it.each([
  'missing rule',
  'competing rule',
  'short rule',
  'distant rule',
  'different number',
  'second complete description',
  'duplicate top title',
  'embedded marker'
])('keeps a caption tie without unique native same-number footer proof (%s)', (reason) => {
  const x = continuationMarkerLayout()
  if (reason === 'missing rule') x.rules = []
  if (reason === 'competing rule') x.rules.push([12, 102, 208, 102])
  if (reason === 'short rule') x.rules[0][2] = 180
  if (reason === 'distant rule') x.rules[0][1] = x.rules[0][3] = 110
  if (reason === 'different number') x.captions[1].lines = ['Table 4 (continues)']
  if (reason === 'second complete description')
    x.captions[1].lines = ['Table 3: Distribution of other measured characteristics']
  if (reason === 'duplicate top title') x.captions.push(structuredClone(x.captions[0]))
  if (reason === 'embedded marker') x.captions[1].rect = [160, 294, 208, 302]
  const result = associateTableCaptions(x.page, x.tables, x.captions, x.rules)[0]
  if (reason === 'embedded marker') expect(result.caption).toEqual(x.captions[0])
  else expect(result.reason).toBe('ambiguous-table-caption')
})
