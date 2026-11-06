import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { anonymousCaptionLane } = await import(
  pathToFileURL(resolve('test/fixtures/native-caption-lane.mjs')).href
)
const { recoverNativeCaptionLane } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { recoverNativeTaggedRasterCaption } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-caption-lane.mjs')).href
)

function taggedRasterCaption(): ReturnType<typeof JSON.parse> {
  const width = 600,
    height = 800,
    lines = [
      'Figure 1. Summary of the separate panels in the preceding raster plate.',
      'The groups use the same observations and are shown with their uncertainty.',
      'The upper panels describe the inputs and the lower panels show the outputs.',
      'Panel a presents the observed values and panel b presents their contrasts.',
      'The remaining panels describe the same samples using independent summaries.',
      'Their labels and uncertainty retain the native order of the source text.',
      'The plotted values are accompanied by their corresponding native legends.',
      'The final comparison uses the same observations and a common reference.',
      'Intervals show uncertainty.'
    ].map((text, i) => ({
      text,
      fontSize: 9,
      x: 60,
      y: 60 + i * 15,
      width: i === 8 ? 180 : 450,
      height: 9
    })),
    style = { fontFamily: 'sans-serif', ascent: 1, descent: 0, vertical: false },
    tree = (page: number, figure: boolean): ReturnType<typeof JSON.parse> => ({
      role: 'Root',
      children: [
        {
          role: 'Document',
          children: [
            { role: 'P', children: [{ type: 'content', id: `p${page}R_mc0` }] },
            { role: figure ? 'Figure' : 'P', children: [{ type: 'content', id: `p${page}R_mc1` }] }
          ]
        }
      ]
    }),
    frame = (number: number, prior: boolean): ReturnType<typeof JSON.parse> => {
      const footer = {
          text: prior ? '2' : '3',
          x: 520,
          y: 755,
          width: 5,
          height: 10,
          fontSize: 10
        },
        rows = prior ? [footer] : [...lines, footer],
        item = (line: (typeof rows)[number]): ReturnType<typeof JSON.parse> => ({
          str: line.text,
          width: line.width,
          height: line.height,
          fontName: 'f',
          dir: 'ltr',
          hasEOL: true,
          transform: [line.height, 0, 0, line.height, line.x, height - line.y - line.height]
        }),
        items = [item(footer), ...(!prior ? lines.map(item) : [])],
        nativeContent = { items, styles: { f: style } },
        marked = {
          styles: nativeContent.styles,
          items: [
            { type: 'beginMarkedContentProps', tag: 'Artifact', id: null },
            items[0],
            { type: 'endMarkedContent' },
            { type: 'beginMarkedContentProps', tag: 'Span', id: `p${number}R_mc0` },
            ...items.slice(1),
            { type: 'endMarkedContent' },
            { type: 'beginMarkedContentProps', tag: prior ? 'P' : 'Span', id: `p${number}R_mc1` },
            { type: 'endMarkedContent' }
          ]
        },
        structureTree = tree(number, prior),
        graphicsBounds = prior
          ? [{ kind: 'image', operationIndex: 1, normalizedRect: [0.15, 0.075, 0.85, 0.94] }]
          : [],
        pageGeometry = {
          pageNumber: number,
          width,
          height,
          rotation: 0,
          invalidGraphicsBounds: 0,
          lines: rows,
          graphicsBounds
        },
        operators = { fnArray: [] as number[], argsArray: [] as unknown[] },
        glyphs: { fontChar: string; bounds: number[] }[] = [],
        add = (op: number, args: unknown): void => {
          operators.fnArray.push(op)
          operators.argsArray.push(args)
        },
        text = (record: ReturnType<typeof JSON.parse>): void => {
          record.sourceItem = { pageNumber: number, index: items.indexOf(record), text: record.str }
          add(OPS.beginText, null)
          add(OPS.setFont, ['f', record.height])
          add(OPS.setTextMatrix, [[1, 0, 0, 1, record.transform[4], record.transform[5]]])
          add(OPS.showText, [
            [
              {
                unicode: record.str,
                fontChar: record.str,
                width: (record.width / record.height) * 1000,
                isInFont: true
              }
            ]
          ])
          add(OPS.endText, null)
          glyphs.push({ fontChar: record.str, bounds: [0, 0, record.width / record.height, 1] })
        },
        context = {
          pageNumber: number,
          sourceSha256: 'a'.repeat(64),
          content: nativeContent,
          graphicsBounds,
          viewport: {
            width,
            height,
            scale: 1,
            rotation: 0,
            transform: [1, 0, 0, -1, 0, height],
            convertToViewportPoint: (x: number, y: number): number[] => [x, height - y]
          },
          operators,
          glyphBounds: [{ fontName: 'f', glyphs }]
        },
        nativePage = {
          pageNumber: number,
          getStructTree: async () => structureTree,
          getTextContent: async () => marked
        }
      add(OPS.setFillRGBColor, ['#000000'])
      add(OPS.beginMarkedContentProps, ['Artifact', null])
      text(items[0])
      add(OPS.endMarkedContent, null)
      add(OPS.beginMarkedContentProps, ['Span', 0])
      for (const record of items.slice(1)) text(record)
      add(OPS.endMarkedContent, null)
      add(OPS.beginMarkedContentProps, [prior ? 'P' : 'Span', 1])
      if (prior) {
        add(OPS.save, null)
        add(OPS.transform, [420, 0, 0, 692, 90, 48])
        graphicsBounds[0].operationIndex = operators.fnArray.length
        add(OPS.paintImageXObject, ['image', 100, 100])
        add(OPS.restore, null)
      }
      add(OPS.endMarkedContent, null)
      return { pageGeometry, context, nativeContent, nativePage, marked, structureTree }
    },
    current = frame(22, false),
    previous = frame(21, true),
    candidate = {
      kind: 'figure',
      page: 22,
      lines: lines.slice(0, 4).map((l) => l.text),
      rect: [60, 60, 510, 114]
    }
  return { candidate, current, previous, otherCaptions: [candidate], lines }
}

it('completes only the exact tagged caption paragraph following an isolated raster page', async () => {
  const f = taggedRasterCaption(),
    recovered = await recoverNativeTaggedRasterCaption(f)
  expect(recovered?.lines).toEqual(f.lines.map((l: { text: string }) => l.text))
  expect(recovered?.rect).toEqual([60, 60, 510, 189])
  expect(f.candidate.lines).toHaveLength(4)
  expect(f.current.nativeContent.items).toHaveLength(10)
})

it('binds independent PDF.js font aliases without changing the observed glyph context', async () => {
  const f = taggedRasterCaption()
  for (const frame of [f.current, f.previous]) {
    const content = structuredClone(frame.nativeContent)
    content.styles = { live: content.styles.f }
    for (const item of content.items) item.fontName = 'live'
    frame.nativeContent = content
    frame.marked.styles = content.styles
    let index = 0
    frame.marked.items = frame.marked.items.map((item: { str?: string }) =>
      typeof item.str === 'string' ? content.items[index++] : item
    )
  }
  expect((await recoverNativeTaggedRasterCaption(f))?.lines).toHaveLength(9)
  expect(f.current.context.content.items[0].fontName).toBe('f')
})

it.each([
  'tree',
  'role',
  'orphan',
  'source',
  'paragraph',
  'footer',
  'raster',
  'auxiliary',
  'prefix',
  'concurrent',
  'context-reference',
  'page-reference',
  'native-page-reference',
  'paint',
  'opacity',
  'white',
  'mode',
  'clip',
  'marked-operator'
])('retains the original caption when tagged paragraph evidence fails: %s', async (mode) => {
  const f = taggedRasterCaption()
  if (mode === 'tree') f.current.nativePage.getStructTree = async () => null
  if (mode === 'role') f.current.structureTree.children[0].children[0].role = 'Figure'
  if (mode === 'orphan') f.current.marked.items[3].id = 'unbound'
  if (mode === 'source')
    f.current.marked.items[4] = { ...f.current.marked.items[4], str: 'different text' }
  if (mode === 'paragraph')
    f.current.structureTree.children[0].children.push({
      role: 'P',
      children: [{ type: 'content', id: 'extra' }]
    })
  if (mode === 'footer') f.current.pageGeometry.lines.at(-1).y = 400
  if (mode === 'raster') {
    const index = f.previous.context.operators.argsArray.findIndex(
      (args: unknown[]) => args?.[0] === 'P' && args?.[1] === 1
    )
    f.previous.context.operators.argsArray[index][1] = 2
  }
  if (mode === 'auxiliary') f.previous = undefined
  if (mode === 'prefix') f.candidate.lines[1] += ' extra'
  if (mode === 'concurrent')
    f.current.nativePage.getStructTree = async () => {
      f.current.context.content = { ...f.current.context.content }
      return f.current.structureTree
    }
  if (mode === 'context-reference')
    f.current.nativePage.getStructTree = async () => {
      f.current.context = { ...f.current.context, sourceSha256: 'b'.repeat(64) }
      return f.current.structureTree
    }
  if (mode === 'page-reference')
    f.current.nativePage.getStructTree = async () => {
      f.current.pageGeometry = { ...f.current.pageGeometry, rotation: 90 }
      return f.current.structureTree
    }
  if (mode === 'native-page-reference')
    f.current.nativePage.getStructTree = async () => {
      f.current.nativePage = { ...f.current.nativePage, pageNumber: 99 }
      return f.current.structureTree
    }
  if (mode === 'paint') {
    f.current.context.operators.fnArray.push(OPS.shadingFill)
    f.current.context.operators.argsArray.push(['paint'])
  }
  if (mode === 'opacity' || mode === 'white' || mode === 'mode') {
    f.current.context.operators.fnArray.splice(
      1,
      0,
      mode === 'opacity'
        ? OPS.setGState
        : mode === 'white'
          ? OPS.setFillRGBColor
          : OPS.setTextRenderingMode
    )
    f.current.context.operators.argsArray.splice(
      1,
      0,
      mode === 'opacity' ? [[['ca', 0]]] : mode === 'white' ? ['#ffffff'] : [3]
    )
  }
  if (mode === 'clip') {
    f.current.context.operators.fnArray.splice(1, 0, OPS.clip, OPS.constructPath)
    f.current.context.operators.argsArray.splice(
      1,
      0,
      [],
      [
        OPS.endPath,
        [new Float32Array([0, 0, 799, 1, 1, 799, 1, 1, 800, 1, 0, 800, 4])],
        new Float32Array([0, 799, 1, 800])
      ]
    )
  }
  if (mode === 'marked-operator') {
    f.current.context.operators.fnArray.push(OPS.beginMarkedContentProps, OPS.endMarkedContent)
    f.current.context.operators.argsArray.push(['Span', 0], null)
  }
  expect(await recoverNativeTaggedRasterCaption(f)).toBeUndefined()
  expect(f.candidate.lines).toHaveLength(4)
})
it('completes a whole native caption lane only after its actual raster closes', async () => {
  const f = anonymousCaptionLane()
  const out = await recoverNativeCaptionLane(f.args)
  expect(out?.lines).toEqual(f.args.page.lines.map((l: { text: string }) => l.text))
  expect(out?.rect).toEqual([60, 290, 260, 329])
  expect(f.args.candidate.lines).toHaveLength(2)
})
it.each([
  'font',
  'source',
  'duplicate-source',
  'competing-caption',
  'competing-anchor',
  'unclosed',
  'continuation',
  'sha',
  'size',
  'foreign-owner'
])('refuses an incomplete caption certificate: %s', async (mode) => {
  const f = anonymousCaptionLane(),
    a = f.args
  if (mode === 'font') a.context.glyphBounds = []
  if (mode === 'source') a.tokens[0].text += 'x'
  if (mode === 'duplicate-source') a.tokens.push({ ...a.tokens[0] })
  if (mode === 'competing-caption') a.otherCaptions.push({ ...a.candidate })
  if (mode === 'competing-anchor') a.anchors.push({ ...a.anchors[0] })
  if (mode === 'unclosed') a.page.lines[2].text = 'unfinished caption'
  if (mode === 'continuation')
    a.page.lines.push({ ...a.page.lines[2], y: 332, text: 'continued prose', width: 90 })
  if (mode === 'sha') a.raster.sha256 = 'b'.repeat(64)
  if (mode === 'size') a.raster.width--
  if (mode === 'foreign-owner') a.anchors[0].sourceItems = [a.tokens[0].sourceItem]
  expect(await recoverNativeCaptionLane(a)).toBeUndefined()
})
it.each([
  'content',
  'glyphs',
  'operators',
  'transform',
  'converter',
  'caption',
  'anchor',
  'raster',
  'png'
])('rejects equal-value reference replacement or mutation during PNG loading: %s', async (mode) => {
  const f = anonymousCaptionLane(),
    a = f.args,
    load = a.loadPng
  a.loadPng = async (): Promise<Uint8Array> => {
    if (mode === 'content') a.context.content = { ...a.context.content }
    if (mode === 'glyphs') a.context.glyphBounds = [...a.context.glyphBounds]
    if (mode === 'operators') a.context.operators = { ...a.context.operators }
    if (mode === 'transform') a.context.viewport.transform = [...a.context.viewport.transform]
    if (mode === 'converter')
      a.context.viewport.convertToViewportPoint = (x: number, y: number): number[] => [x, 400 - y]
    if (mode === 'caption') a.candidate.lines = [...a.candidate.lines]
    if (mode === 'anchor') a.anchors[0].rect = [...a.anchors[0].rect]
    if (mode === 'raster') a.raster.width--
    if (mode === 'png') f.png[100] ^= 1
    return load()
  }
  expect(await recoverNativeCaptionLane(a)).toBeUndefined()
})
const { anonymousThreeRailTable } = await import(
  pathToFileURL(resolve('test/fixtures/native-caption-lane.mjs')).href
)
const { recoverNativeClosedTableBorder } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-caption-lane.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { nativeClosedProgramInkPacket } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
it('separates adjacent native caption baselines bridged by complete subscript and superscript sources', async () => {
  const rows: (string | number)[][] = [
    ['Figure 1: A complete native picture with', 60, 300],
    ['mixed font styles in the description and', 60, 314]
  ]
  for (let i = 0; i < 35; i++)
    rows.push(i === 17 ? ['H', 60 + i * 5, 330.5, 7.6] : ['a', 60 + i * 5, 328])
  for (let i = 0; i < 35; i++)
    rows.push(i === 14 ? ['2', 60 + i * 5, 338, 7.6] : ['a', 60 + i * 5, 342])
  rows.push(['.', 235, 342])
  const f = anonymousCaptionLane(rows)
  expect(
    nativeClosedProgramInkPacket(
      f.args.page,
      f.args.tokens,
      f.args.context,
      f.args.tokens.map((t: { sourceItem: unknown }) => t.sourceItem)
    )
  ).toBeUndefined()
  const out = await recoverNativeCaptionLane(f.args)
  expect(out?.lines).toHaveLength(4)
  expect(out?.lines[2].replace(/\s/gu, '')).toBe('a'.repeat(17) + 'H' + 'a'.repeat(17))
  expect(out?.lines[3].replace(/\s/gu, '')).toBe('a'.repeat(14) + '2' + 'a'.repeat(20) + '.')
})
it('retains the model frame and whole cell sources when completing visible three-rail stroke ink', async () => {
  const f = anonymousThreeRailTable(),
    before = JSON.stringify(f.args.table)
  const out = await recoverNativeClosedTableBorder(f.args)
  expect(out?.region).toEqual(f.rect.map((n: number) => n / 400))
  expect(out?.png).toEqual(f.png)
  expect(JSON.stringify(f.args.table)).toBe(before)
})
it.each(['edge', 'cap', 'alpha', 'source', 'foreign-paint', 'color', 'await-reference', 'png'])(
  'refuses an unclosed stroke crop: %s',
  async (mode) => {
    const f = anonymousThreeRailTable(),
      a = f.args,
      o = a.context.operators,
      at = o.fnArray.indexOf(OPS.constructPath)
    if (mode === 'edge') {
      o.fnArray.push(o.fnArray[at])
      o.argsArray.push(structuredClone(o.argsArray[at]))
    }
    if (mode === 'cap') {
      o.fnArray.splice(at, 0, OPS.setLineCap)
      o.argsArray.splice(at, 0, [1])
    }
    if (mode === 'alpha') {
      o.fnArray.splice(at, 0, OPS.setGState)
      o.argsArray.splice(at, 0, [[['CA', 0.5]]])
    }
    if (mode === 'source') a.table.cells[0].sourceItems = []
    if (mode === 'foreign-paint') {
      o.fnArray.push(OPS.constructPath)
      o.argsArray.push([
        OPS.fill,
        [new Float32Array([0, 100, 200, 1, 110, 200, 1, 110, 210, 1, 100, 210, 4])],
        new Float32Array([100, 200, 110, 210])
      ])
    }
    if (mode === 'color') {
      o.fnArray.splice(at, 0, OPS.setStrokeRGBColor)
      o.argsArray.splice(at, 0, ['#ffffff'])
    }
    if (mode === 'await-reference')
      a.renderCrop = async (): Promise<Uint8Array> => {
        a.table.cells = [...a.table.cells]
        return f.png
      }
    if (mode === 'png') a.renderCrop = async (): Promise<Uint8Array> => new Uint8Array()
    expect(await recoverNativeClosedTableBorder(a)).toBeUndefined()
  }
)
it('keeps a previously complete wrapped caption separate from following prose', async () => {
  const f = anonymousCaptionLane()
  f.args.candidate.lines[1] += '.'
  expect(await recoverNativeCaptionLane(f.args)).toBeUndefined()
})
it('retains the owned-compound and unknown-font refusals', async () => {
  const f = anonymousCaptionLane()
  const at = f.args.context.operators.fnArray.indexOf(OPS.showText)
  f.args.context.operators.argsArray[at][0][0].accent = {
    fontChar: 'accent',
    offset: { x: 0, y: 0 }
  }
  expect(await recoverNativeCaptionLane(f.args)).toBeUndefined()
})
it('refuses a geometry caption row whose characters agree but native word order differs', async () => {
  const f = anonymousCaptionLane()
  f.args.page.lines[2].text = 'caption a closed.'
  expect(await recoverNativeCaptionLane(f.args)).toBeUndefined()
})
it('refuses two complete native sources with the same ambiguous row start', async () => {
  const f = anonymousCaptionLane()
  f.text('a.', 60, 328)
  f.args.page.lines[2].text += 'a.'
  expect(await recoverNativeCaptionLane(f.args)).toBeUndefined()
})
const { nativeCaptionLaneAnchors } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-caption-lane.mjs')).href
)
it('retains a single native model frame and its original owner without changing table data', () => {
  const f = anonymousThreeRailTable(),
    table = f.args.table,
    before = JSON.stringify(table)
  const anchors = nativeCaptionLaneAnchors(f.args.page, [table], [], [])
  expect(anchors).toHaveLength(1)
  expect(anchors[0].rect).toEqual(table.cropRect.map((n: number) => n / table.sourceViewport.scale))
  expect(anchors[0].sourceItems).toEqual(
    table.cells.flatMap((c: { sourceItems: unknown[] }) => c.sourceItems)
  )
  expect(anchors[0].sourceOwner).toBe(table)
  expect(JSON.stringify(table)).toBe(before)
})
it.each([
  'multipart-no-crop',
  'multipart-with-crop',
  'image-only',
  'empty-crop',
  'short-crop',
  'nan-crop',
  'reversed-crop',
  'zero-scale',
  'infinite-scale',
  'wrong-frame',
  'invalid-cells'
])('abstains from an unsupported caption body anchor while retaining its data: %s', (mode) => {
  const f = anonymousThreeRailTable(),
    table = f.args.table
  if (mode === 'multipart-no-crop') {
    table.cropRects = [
      [30, 60, 100, 150],
      [100, 60, 300, 150]
    ]
    delete table.cropRect
  }
  if (mode === 'multipart-with-crop') table.parts = [{ cropRect: [30, 60, 100, 150] }]
  if (mode === 'image-only') {
    delete table.cropRect
    table.region = [0.1, 0.1, 0.5, 0.5]
  }
  if (mode === 'empty-crop') table.cropRect = []
  if (mode === 'short-crop') table.cropRect = [1, 2, 3]
  if (mode === 'nan-crop') table.cropRect[0] = NaN
  if (mode === 'reversed-crop') table.cropRect = [300, 150, 30, 60]
  if (mode === 'zero-scale') table.sourceViewport.scale = 0
  if (mode === 'infinite-scale') table.sourceViewport.scale = Infinity
  if (mode === 'wrong-frame') table.sourceViewport.width--
  if (mode === 'invalid-cells') table.cells = {}
  const before = JSON.stringify(table)
  expect(nativeCaptionLaneAnchors(f.args.page, [table], [], [])).toEqual([])
  expect(JSON.stringify(table)).toBe(before)
})
it('binds the original figure owner through caption PNG loading', async () => {
  const f = anonymousCaptionLane(),
    body = f.args.anchors[0],
    figure = {
      page: 1,
      caption: body.caption,
      region: body.rect.map((n: number) => n / 400)
    }
  f.args.anchors = nativeCaptionLaneAnchors(f.args.page, [], [figure], [])
  const load = f.args.loadPng
  f.args.loadPng = async (): Promise<Uint8Array> => {
    figure.region = [...figure.region]
    return load()
  }
  expect(await recoverNativeCaptionLane(f.args)).toBeUndefined()
})

const {
  proveNativeMathematicalCaptionAssociation: proveMathematicalCaption,
  commitNativeMathematicalCaptionAssociation: commitMathematicalCaption
} = await import(pathToFileURL(resolve('resources/literature-pdf-native-caption-lane.mjs')).href)

function anonymousMathematicalCaption(): ReturnType<typeof JSON.parse> {
  type Evidence = ReturnType<typeof JSON.parse>
  const f = anonymousCaptionLane([
      ['Previous.', 80, 70],
      ['Table 1.', 80, 110],
      ['Result', 125, 110],
      ['a', 170, 110],
      ['1', 190, 106, 7],
      ['2', 190, 114, 7],
      ['and', 210, 110],
      ['all', 240, 110],
      ['numbers.', 280, 110],
      ['Name', 75, 140],
      ['Value', 200, 140],
      ['Alpha', 75, 160],
      ['10', 200, 160],
      ['Beta', 75, 180],
      ['20', 200, 180],
      ['Next.', 80, 230]
    ]),
    n = f.args.context,
    graphics: Evidence[] = []
  f.add(OPS.setLineWidth, [0.4])
  f.add(OPS.setStrokeRGBColor, ['#000000'])
  for (const [x, y, right] of [
    [190, 107, 193.5],
    [60, 128, 340],
    [60, 148, 340],
    [60, 190, 340]
  ]) {
    const operationIndex = n.operators.fnArray.length
    f.add(OPS.constructPath, [
      OPS.stroke,
      [Float32Array.from([0, x, 400 - y, 1, right, 400 - y])],
      [x, 400 - y, right, 400 - y]
    ])
    graphics.push({
      kind: 'path',
      operationIndex,
      normalizedRect: [x / 400, (y - 0.2) / 400, right / 400, (y + 0.2) / 400]
    })
  }
  n.graphicsBounds = f.args.page.graphicsBounds = graphics
  const paths = new Map<string, Info>(),
    compiled = new Map<string, Evidence>()
  class Info {
    #buffer = new ArrayBuffer(4)
    get path(): Float32Array {
      return new Float32Array(this.#buffer)
    }
  }
  class Font {
    get fontMatrix(): number[] {
      return [0.001, 0, 0, 0.001, 0, 0]
    }
  }
  const font = Object.assign(new Font(), {
    loadedName: 'F',
    missingFile: false,
    isType3Font: false,
    isInvalidPDFjsFont: false,
    disableFontFace: true,
    vertical: false,
    getPathGenerator(_objects: unknown, character: string): Evidence {
      return compiled.get(character)
    }
  })
  for (const glyph of n.glyphBounds[0].glyphs) {
    const bounds = [...glyph.bounds]
    paths.set('F_path_' + glyph.fontChar, new Info())
    compiled.set(glyph.fontChar, { getBounds: (): number[] => [...bounds] })
  }
  const rect = (r: Evidence): number[] => [
      r.transform[4],
      400 - r.transform[5] - r.height,
      r.transform[4] + r.width,
      400 - r.transform[5]
    ],
    table = {
      page: 1,
      cropRect: [59, 127, 341, 191],
      sourceViewport: { width: 400, height: 400, scale: 1 },
      captionIssue: 'no-adjacent-table-caption',
      cells: n.content.items.slice(9, 15).map((r: Evidence, i: number) => ({
        row: Math.floor(i / 2),
        column: i % 2,
        text: r.str,
        sourceItems: [r.sourceItem],
        sourceRects: [rect(r)]
      })),
      grid: [
        ['Name', 'Value'],
        ['Alpha', '10'],
        ['Beta', '20']
      ],
      unassigned: [],
      selectedTextItems: 6,
      issues: []
    },
    scope = {
      table,
      sourceSha256: n.sourceSha256,
      page: f.args.page,
      context: {
        sourcePage: f.args.page,
        nativeGlyphContext: n,
        viewport: n.viewport,
        sourceContent: n.content,
        content: n.content,
        operators: structuredClone(n.operators),
        rulePaintBounds: new Map()
      },
      nativePage: {
        commonObjs: { get: (key: string): Evidence => (key === 'F' ? font : paths.get(key)) }
      },
      nativeContent: structuredClone(n.content),
      tables: [table],
      captions: [{ page: 1, lines: ['Table 1. Result'], rect: [80, 100, 155, 110] }],
      competingRects: []
    }
  return scope
}

it('associates a complete native mathematical caption using only its literal label', () => {
  const scope = anonymousMathematicalCaption(),
    before = structuredClone(scope.table),
    proof = proveMathematicalCaption(scope),
    result = commitMathematicalCaption(proof, scope.table)
  expect(result?.caption.text).toBe('Table 1.')
  expect(result?.caption.rect).toEqual([80, 99, 320, 114.7])
  expect(result?.captionIssue).toBe('partial-table-caption')
  expect(result?.cells).toBe(scope.table.cells)
  expect(result?.grid).toBe(scope.table.grid)
  expect(scope.table).toEqual(before)
  expect(commitMathematicalCaption(proof, { ...scope.table })).toBeUndefined()
})
it.each(['another table', 'unbound glyph', 'competing figure', 'changed prefix'])(
  'refuses incomplete mathematical caption ownership: %s',
  (fault) => {
    const scope = anonymousMathematicalCaption()
    if (fault === 'another table') scope.tables.push(structuredClone(scope.table))
    if (fault === 'unbound glyph')
      scope.context.nativeGlyphContext.glyphBounds[0].glyphs[0].bounds[0]++
    if (fault === 'competing figure') scope.competingRects.push([70, 95, 330, 190])
    if (fault === 'changed prefix') scope.captions[0].lines[0] += ' altered'
    expect(proveMathematicalCaption(scope)).toBeUndefined()
  }
)
it.each(['source text', 'source page'])(
  'rejects mathematical caption %s replaced after the last await',
  async (field) => {
    const scope = anonymousMathematicalCaption(),
      proof = proveMathematicalCaption(scope)
    expect(proof).toBeDefined()
    await Promise.resolve()
    if (field === 'source text') scope.context.sourceContent = { ...scope.context.sourceContent }
    else scope.context.sourcePage = { ...scope.context.sourcePage }
    expect(commitMathematicalCaption(proof, scope.table)).toBeUndefined()
  }
)

const {
  associateTableCaptions: associateNativeFooter,
  getNativeTableFooterNotes,
  nativeTableFooterAssociationCurrent
} = await import(pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href)

function anonymousTerminalTableFooter(): ReturnType<typeof JSON.parse> {
  const title = 'Table 1: Result.',
    fixture = anonymousCaptionLane([
      ['Name', 60, 70],
      ['Value', 240, 70],
      ['Alpha', 60, 85],
      ['10', 240, 85],
      ['Beta', 60, 100],
      ['20', 240, 100],
      ['Gamma', 60, 115],
      ['30', 240, 115],
      ['Notes: Native ranges remain complete.', 60, 220],
      ['The same values describe every group.', 60, 234],
      [title, (400 - title.length * 5) / 2, 274]
    ]),
    { page, context, tokens } = fixture.args,
    line = page.lines.at(-1),
    captions = [
      {
        page: 1,
        lines: [line.text],
        rect: [line.x, line.y, line.x + line.width, line.y + line.height]
      }
    ],
    tables = [{ rect: [40, 60, 360, 130] }],
    rules = [60, 80, 130].map((y) => [40, y, 360, y]),
    native = { context, tokens, sourceSha256: context.sourceSha256 }
  fixture.add(OPS.setStrokeRGBColor, ['#000000'])
  fixture.add(OPS.setLineWidth, [0.5])
  for (const y of [60, 80, 130])
    fixture.add(OPS.constructPath, [
      OPS.stroke,
      [new Float32Array([0, 40, 400 - y, 1, 360, 400 - y])],
      new Float32Array([40, 400 - y, 360, 400 - y])
    ])
  return { fixture, page, context, captions, tables, rules, native }
}

function terminalFooterAssociation(
  scope: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> {
  return associateNativeFooter(
    scope.page,
    scope.tables,
    scope.captions,
    scope.rules,
    [scope.page],
    scope.native
  )[0]
}

it('associates a terminal native Notes footer without widening ordinary distance rules', () => {
  const scope = anonymousTerminalTableFooter()
  expect(
    associateNativeFooter(scope.page, scope.tables, scope.captions, scope.rules, [scope.page])[0]
      .caption
  ).toBeUndefined()
  const original = structuredClone(scope.context.content),
    association = terminalFooterAssociation(scope)
  expect(association.caption).toEqual(scope.captions[0])
  expect(getNativeTableFooterNotes(association)).toEqual([
    {
      text: 'Notes: Native ranges remain complete. The same values describe every group.',
      rect: [60, 210, 245, 234]
    }
  ])
  expect(scope.context.content).toEqual(original)
  expect(nativeTableFooterAssociationCurrent(association)).toBe(true)
})

it.each([
  'wrong PDF',
  'wrong page',
  'wrong font',
  'wrong source',
  'unclaimed continuation',
  'two parents'
])('refuses a native terminal footer with %s', (field) => {
  const scope = anonymousTerminalTableFooter()
  if (field === 'wrong PDF') scope.native.sourceSha256 = 'b'.repeat(64)
  else if (field === 'wrong page') scope.context.pageNumber = 2
  else if (field === 'wrong font') scope.context.content.items[8].fontName = 'unknown'
  else if (field === 'wrong source') scope.context.content.items[8].sourceItem.index = 7
  else if (field === 'two parents') scope.tables.push({ rect: [40, 140, 360, 180] })
  else scope.fixture.text('A further centered caption line.', 120, 288)
  expect(terminalFooterAssociation(scope).caption).toBeUndefined()
})

it.each([
  'Source identity',
  'descriptor',
  'non-enumerable field',
  'symbol',
  'typed bytes',
  'Notes identity'
])('keeps native footer evidence private and invalidates changed %s', (field) => {
  const scope = anonymousTerminalTableFooter(),
    association = terminalFooterAssociation(scope),
    copy = JSON.parse(JSON.stringify(association))
  expect(nativeTableFooterAssociationCurrent(copy)).toBeUndefined()
  expect(getNativeTableFooterNotes(copy)).toBeUndefined()
  scope.captions.push({ page: 2, lines: ['Table 2: Other.'], rect: [1, 1, 30, 10] })
  expect(nativeTableFooterAssociationCurrent(association)).toBe(true)
  if (field === 'Source identity')
    scope.context.content.items[8] = { ...scope.context.content.items[8] }
  else if (field === 'descriptor')
    Object.defineProperty(scope.context.content.items[8], 'str', { enumerable: false })
  else if (field === 'non-enumerable field')
    Object.defineProperty(scope.context, 'hidden', { value: 1 })
  else if (field === 'symbol') scope.context[Symbol('extra')] = 1
  else if (field === 'typed bytes') scope.context.operators.argsArray.at(-1)[1][0][1] += 1
  else
    getNativeTableFooterNotes(association)[0].rect = [
      ...getNativeTableFooterNotes(association)[0].rect
    ]
  expect(nativeTableFooterAssociationCurrent(association)).toBe(false)
  expect(getNativeTableFooterNotes(association)).toBeUndefined()
})

it.each(['context accessor', 'glyph accessor', 'proxy context'])(
  'declines a terminal native footer with %s without invoking it',
  (field) => {
    const scope = anonymousTerminalTableFooter()
    let calls = 0
    const forbidden = (): never => {
      calls++
      throw new Error('must not execute')
    }
    if (field === 'context accessor')
      Object.defineProperty(scope.native, 'context', { get: forbidden })
    else if (field === 'glyph accessor')
      Object.defineProperty(scope.context.glyphBounds[0].glyphs[0], 'bounds', { get: forbidden })
    else scope.native.context = new Proxy(scope.context, { get: forbidden })
    expect(terminalFooterAssociation(scope).caption).toBeUndefined()
    expect(calls).toBe(0)
  }
)

function anonymousClosedAboveTitle(): ReturnType<typeof JSON.parse> {
  const upper = 'Table 1: Upper records.',
    lower = 'Table 2: Separate instructions.'
  const f = anonymousCaptionLane([
    [upper, (54 + 294 - upper.length * 5) / 2, 40],
    ['A complete original annotation record.', 54, 70],
    ['The positive class retains its complete source.', 54, 100],
    ['The negative class remains an independent row.', 54, 130],
    ['Output preserves the original classification.', 54, 175],
    [lower, 54, 202]
  ])
  f.add(OPS.setStrokeRGBColor, ['#000000'])
  f.add(OPS.setLineWidth, [0.5])
  for (const y of [55, 182])
    f.add(OPS.constructPath, [
      OPS.stroke,
      [new Float32Array([0, 54, 400 - y, 1, 294, 400 - y])],
      new Float32Array([54, 400 - y, 294, 400 - y])
    ])
  const { page, context, tokens } = f.args,
    captions = [page.lines[0], page.lines.at(-1)].map((l) => ({
      page: 1,
      lines: [l.text],
      rect: [l.x, l.y, l.x + l.width, l.y + l.height]
    }))
  return {
    f,
    page,
    context,
    captions,
    tables: [{ rect: [50, 80, 308, 180] }],
    rules: [
      [54, 55, 294, 55],
      [54, 182, 294, 182]
    ],
    native: { context, tokens, sourceSha256: context.sourceSha256 }
  }
}

it('reserves a complete native above-title when predicted rows omit the opening text', () => {
  const s = anonymousClosedAboveTitle(),
    before = structuredClone(s.context.content)
  const legacy = associateNativeFooter(s.page, s.tables, s.captions, s.rules)[0]
  expect(legacy.caption).toBe(s.captions[1])
  const result = terminalFooterAssociation(s)
  expect(result.caption).toBe(s.captions[0])
  expect(nativeTableFooterAssociationCurrent(result)).toBe(true)
  expect(getNativeTableFooterNotes(result)).toBeUndefined()
  expect(s.context.content).toEqual(before)
})

it.each([
  'missing opening',
  'missing closing',
  'foreign peer',
  'foreign caption',
  'incomplete column',
  'caption literal',
  'missing font',
  'source literal'
])('keeps legacy caption association when the closed above-owner lacks %s', (fault) => {
  const s = anonymousClosedAboveTitle()
  if (fault === 'missing opening') s.rules.shift()
  if (fault === 'missing closing') s.rules.pop()
  if (fault === 'foreign peer') s.tables.push({ rect: [80, 90, 200, 110] })
  if (fault === 'foreign caption')
    s.captions.push({ page: 1, lines: ['Table 9: Foreign owner.'], rect: [80, 43, 190, 51] })
  if (fault === 'incomplete column') s.tables[0].rect[2] = 270
  if (fault === 'caption literal') s.captions[0].lines[0] += ' altered'
  if (fault === 'missing font') delete s.context.content.styles.F
  if (fault === 'source literal') s.context.content.items[1].str += ' altered'
  const legacy = associateNativeFooter(s.page, s.tables, s.captions, s.rules)[0]
  const result = terminalFooterAssociation(s)
  expect(result).toEqual(legacy)
  expect(nativeTableFooterAssociationCurrent(result)).toBeUndefined()
})

it.each(['source literal', 'equal source replacement', 'equal caption replacement', 'font metric'])(
  'revokes the native above-owner after late %s changes',
  (fault) => {
    const s = anonymousClosedAboveTitle(),
      result = terminalFooterAssociation(s)
    expect(nativeTableFooterAssociationCurrent(result)).toBe(true)
    if (fault === 'source literal') s.context.content.items[1].str += ' altered'
    if (fault === 'equal source replacement')
      s.context.content.items[1] = { ...s.context.content.items[1] }
    if (fault === 'equal caption replacement') result.caption.rect = [...result.caption.rect]
    if (fault === 'font metric') s.context.content.styles.F.ascent = 0
    expect(nativeTableFooterAssociationCurrent(result)).toBe(false)
  }
)

function anonymousWrappedAboveTitle(variant = 'base'): ReturnType<typeof JSON.parse> {
  const rows = [
    ['Table 1 Complete measured records', 60, 40],
    [
      variant === 'unclosed caption'
        ? 'and their independent comparisons'
        : 'and their independent comparisons.',
      variant === 'caption indent' ? 64 : 60,
      variant === 'caption gap' ? 60 : variant === 'overlapping caption' ? 45 : 54
    ],
    ['Field', 65, 80],
    ['Value', 190, variant === 'crossing text' ? 95 : 80],
    ['Alpha', 65, 105],
    ['1.25', 190, 105],
    ['Beta', 65, 130],
    ['2.50', 190, 130],
    ['Table 2 Independent following records.', 60, 160]
  ]
  if (variant === 'split caption')
    rows.splice(0, 1, ['Table 1', 60, 40], ['Complete measured records', 100, 40])
  const f = anonymousCaptionLane(rows)
  f.add(OPS.setStrokeRGBColor, ['#000000'])
  f.add(OPS.setLineWidth, [0.5])
  const rules = [65, 90, 140].map((y) => [
    variant === 'partial separator' && y === 90 ? 70 : 60,
    y,
    225,
    y
  ])
  for (const [x, y, right] of rules)
    f.add(OPS.constructPath, [
      OPS.stroke,
      [new Float32Array([0, x, 400 - y, 1, right, 400 - y])],
      new Float32Array([x, 400 - y, right, 400 - y])
    ])
  const { page, context, tokens } = f.args
  if (variant === 'split caption')
    page.lines.splice(0, 2, {
      ...page.lines[0],
      text: 'Table 1 Complete measured records',
      width: 165
    })
  const captions = [
    {
      page: 1,
      lines: page.lines.slice(0, 2).map((l) => l.text),
      rect: [
        60,
        30,
        Math.max(...page.lines.slice(0, 2).map((l) => l.x + l.width)),
        page.lines[1].y + page.lines[1].height
      ]
    },
    { page: 1, lines: [page.lines.at(-1).text], rect: [60, 150, 245, 160] }
  ]
  return {
    f,
    page,
    context,
    captions,
    rules,
    tables: [{ rect: [60, 68, 225, 138] }],
    native: { context, tokens, sourceSha256: context.sourceSha256 }
  }
}

it('reserves a complete wrapped native above-caption across an independent header separator', () => {
  const s = anonymousWrappedAboveTitle()
  const legacy = associateNativeFooter(s.page, s.tables, s.captions, s.rules)[0]
  expect(legacy.caption).toBe(s.captions[1])
  const result = terminalFooterAssociation(s)
  expect(result.caption).toBe(s.captions[0])
  expect(nativeTableFooterAssociationCurrent(result)).toBe(true)
})

it('reserves the same caption when one native line has separate complete source runs', () => {
  const s = anonymousWrappedAboveTitle('split caption')
  const result = terminalFooterAssociation(s)
  expect(result.caption).toBe(s.captions[0])
  expect(nativeTableFooterAssociationCurrent(result)).toBe(true)
})

it.each([
  'unclosed caption',
  'caption gap',
  'caption indent',
  'overlapping caption',
  'crossing text',
  'partial separator'
])('declines a wrapped above-owner with %s', (variant) => {
  const s = anonymousWrappedAboveTitle(variant)
  const legacy = associateNativeFooter(s.page, s.tables, s.captions, s.rules)[0]
  const result = terminalFooterAssociation(s)
  expect(result).toEqual(legacy)
  expect(nativeTableFooterAssociationCurrent(result)).toBeUndefined()
})

it.each([
  'caption literal',
  'omitted continuation',
  'reversed rows',
  'caption envelope',
  'glyph crossing separator'
])('requires complete literal and geometric ownership for a wrapped title: %s', (variant) => {
  const s = anonymousWrappedAboveTitle()
  if (variant === 'caption literal') s.captions[0].lines[1] += ' changed'
  if (variant === 'omitted continuation') s.captions[0].lines.pop()
  if (variant === 'reversed rows') s.captions[0].lines.reverse()
  if (variant === 'caption envelope') s.captions[0].rect[2] -= 1
  if (variant === 'glyph crossing separator') {
    s.context.glyphBounds[0].glyphs.find((g) => g.fontChar === 'Value').bounds[1] = -1.1
  }
  const legacy = associateNativeFooter(s.page, s.tables, s.captions, s.rules)[0]
  const result = terminalFooterAssociation(s)
  expect(result).toEqual(legacy)
  expect(nativeTableFooterAssociationCurrent(result)).toBeUndefined()
})

it.each(['caption identity', 'source identity', 'separator paint'])(
  'revokes a wrapped caption proof after changed %s',
  (variant) => {
    const s = anonymousWrappedAboveTitle(),
      result = terminalFooterAssociation(s)
    expect(nativeTableFooterAssociationCurrent(result)).toBe(true)
    if (variant === 'caption identity') s.captions[0].lines = [...s.captions[0].lines]
    if (variant === 'source identity')
      s.context.content.items[1] = { ...s.context.content.items[1] }
    if (variant === 'separator paint') s.context.operators.argsArray.at(-2)[1][0][1] += 1
    expect(nativeTableFooterAssociationCurrent(result)).toBe(false)
  }
)

it('keeps a native opening coincident with the recovered first row boundary', () => {
  const s = anonymousWrappedAboveTitle()
  s.tables[0].rect[1] = 65
  const result = terminalFooterAssociation(s)
  expect(result.caption).toBe(s.captions[0])
  expect(nativeTableFooterAssociationCurrent(result)).toBe(true)
})

it('declines an opening below the recovered first row boundary', () => {
  const s = anonymousWrappedAboveTitle()
  s.tables[0].rect[1] = 64
  const result = terminalFooterAssociation(s)
  expect(nativeTableFooterAssociationCurrent(result)).toBeUndefined()
})
