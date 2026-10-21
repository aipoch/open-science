import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pdfTableSourceItemsSchema } from '../src/result.js'
import { readWorkerResult } from '../src/worker-result.js'
const { nativeBraceFigureLabel } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-brace-label.mjs')).href
)

function diagram(): ReturnType<typeof JSON.parse> {
  const nodes = [
    [100, 100, 200, 120],
    [100, 140, 200, 160],
    [100, 180, 200, 200]
  ]
  const rectangle = ([l, t, r, b]: number[]): number[] => [0, l, t, 1, r, t, 1, r, b, 1, l, b, 4]
  const brace = [
    0, 215, 200, 2, 218, 198, 220, 195, 220, 190, 1, 220, 160, 2, 220, 155, 222, 152, 225, 150, 2,
    222, 148, 220, 145, 220, 140, 1, 220, 110, 2, 220, 105, 218, 102, 215, 100
  ]
  const tokens = [
    ...nodes.map((r, i) => ({ text: 'Node ' + i, rect: [110, r[1] + 5, 180, r[1] + 15] })),
    { text: 'Group annotation', rect: [233, 145, 290, 155] }
  ].map((t, index) => ({
    ...t,
    sourceItem: { pageNumber: 1, index, text: t.text },
    horizontal: true,
    height: 10,
    baseline: t.rect[3]
  }))
  const graphicsBounds = [...nodes, [214, 99, 226, 201]].map((r, operationIndex) => ({
    kind: 'path',
    operationIndex,
    normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
  }))
  const caption = { page: 1, rect: [100, 220, 290, 230] }
  return {
    page: {
      width: 600,
      height: 800,
      pageNumber: 1,
      rotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds
    },
    figure: {
      rect: [95, 95, 226, 205],
      caption,
      sourceItems: tokens.slice(0, 3).map((t) => t.sourceItem)
    },
    captions: [caption],
    tables: [],
    tokens,
    context: {
      viewport: { transform: [1, 0, 0, 1, 0, 0], width: 600, height: 800, scale: 1 },
      content: { items: tokens.map((t) => ({ str: t.text, fontName: 'native' })) },
      operators: {
        fnArray: [OPS.constructPath, OPS.constructPath, OPS.constructPath, OPS.constructPath],
        argsArray: [
          ...nodes.map((r) => [OPS.stroke, [rectangle(r)], r]),
          [OPS.stroke, [brace], [215, 100, 225, 200]]
        ]
      }
    }
  }
}
function complete(d: ReturnType<typeof diagram>): ReturnType<typeof JSON.parse> {
  return nativeBraceFigureLabel(d.page, d.figure, d.captions, d.tables, d.tokens, d.context)
}
it('binds a complete mirrored brace to owned node endpoints and its native cusp label', () => {
  const d = diagram(),
    result = complete(d)
  expect(result.rect).toEqual([95, 95, 290, 205])
  expect(result.sourceItems).toEqual(d.tokens.map((t: { sourceItem: unknown }) => t.sourceItem))
  expect(d.figure.rect).toEqual([95, 95, 226, 205])
})
it.each([
  'path topology',
  'malformed path',
  'oscillating curve',
  'endpoint',
  'label alignment',
  'missing node owner',
  'unowned node text',
  'missing native text',
  'source alias',
  'clip',
  'transparency',
  'foreign prose',
  'foreign graphic',
  'caption',
  'table'
])('rejects incomplete brace ownership: %s', (reason) => {
  const d = diagram()
  if (reason === 'path topology') d.context.operators.argsArray[3][1][0][3] = 1
  if (reason === 'malformed path') d.context.operators.argsArray[3][1][0] = null
  if (reason === 'oscillating curve') {
    const path = d.context.operators.argsArray[3][1][0]
    path[4] = path[path.length - 4] = 224
  }
  if (reason === 'endpoint') d.context.operators.argsArray[3][1][0][2] += 2
  if (reason === 'label alignment') d.tokens[3].rect = [233, 164, 290, 174]
  if (reason === 'missing node owner') d.figure.sourceItems.pop()
  if (reason === 'unowned node text') {
    d.tokens.push({
      ...d.tokens[0],
      text: 'Unowned',
      rect: [181, 105, 198, 115],
      sourceItem: { pageNumber: 1, index: 4, text: 'Unowned' }
    })
    d.context.content.items.push({ str: 'Unowned', fontName: 'native' })
  }
  if (reason === 'missing native text') d.context.content.items[3].str = 'Different text'
  if (reason === 'source alias') d.tokens.push(structuredClone(d.tokens[3]))
  if (reason === 'clip') d.context.viewport.width = 224
  if (reason === 'transparency') {
    d.context.operators.fnArray.push(OPS.setGState)
    d.context.operators.argsArray.push([[['SMask', true]]])
  }
  if (reason === 'foreign prose') {
    d.tokens.push({
      ...d.tokens[3],
      text: 'Body prose',
      rect: [240, 180, 280, 190],
      sourceItem: { pageNumber: 1, index: 4, text: 'Body prose' }
    })
    d.context.content.items.push({ str: 'Body prose', fontName: 'native' })
  }
  if (reason === 'foreign graphic')
    d.page.graphicsBounds.push({
      kind: 'path',
      operationIndex: 99,
      normalizedRect: [240 / 600, 180 / 800, 280 / 600, 190 / 800]
    })
  if (reason === 'caption') d.captions.push({ page: 1, rect: [240, 180, 280, 190] })
  if (reason === 'table') d.tables.push([240, 180, 280, 190])
  expect(complete(d)).toBeUndefined()
})

it('preserves source order through the worker when a brace label occurs between node text items', async () => {
  const d = diagram()
  for (const [i, t] of d.tokens.entries()) t.sourceItem.index = [0, 2, 3, 1][i]
  d.context.content.items = [d.tokens[0], d.tokens[3], d.tokens[1], d.tokens[2]].map((t) => ({
    str: t.text,
    fontName: 'native'
  }))
  const previous = structuredClone(d.figure.sourceItems),
    result = complete(d)
  expect(result).toBeDefined()
  expect(() => pdfTableSourceItemsSchema.parse(result.sourceItems)).not.toThrow()
  expect(result.sourceItems.map((s: { index: number }) => s.index)).toEqual([0, 1, 2, 3])
  expect(d.figure.sourceItems).toEqual(previous)
  const root = await mkdtemp(join(tmpdir(), 'pdf-brace-worker-'))
  try {
    await mkdir(join(root, 'thumbnails'))
    await writeFile(
      join(root, 'thumbnails/figure.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
        'base64'
      )
    )
    const identity = {
      extractionId: 'anonymous-brace',
      engineFingerprint: 'b'.repeat(64),
      sourceChecksum: 'c'.repeat(64),
      sourceSizeBytes: 100,
      requestedPages: [1]
    }
    await writeFile(
      join(root, 'structure.json'),
      JSON.stringify({
        sourceSha256: identity.sourceChecksum,
        pageCount: 1,
        requestedPages: [1],
        processedPages: [1],
        pages: [{ page: 1, width: 600, height: 800, rotation: 0 }],
        figures: [
          {
            id: 'figure',
            page: 1,
            region: result.rect.map((v: number, i: number) => v / (i % 2 ? 800 : 600)),
            sourceItems: result.sourceItems,
            thumbnail: 'thumbnails/figure.png',
            caption: { text: 'Figure 1. Diagram.', rect: [100, 220, 290, 230] }
          }
        ],
        tables: [],
        navigation: { entries: [] }
      })
    )
    const decoded = await readWorkerResult(root, identity, new Map())
    expect(decoded.elements[0].sourceItems).toEqual(result.sourceItems)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
