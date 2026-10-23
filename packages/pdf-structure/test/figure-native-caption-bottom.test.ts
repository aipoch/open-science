import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths'

const geometry = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-crop-geometry.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const proof = (...args: ReturnType<typeof JSON.parse>[]): ReturnType<typeof JSON.parse> =>
  geometry.nativeGroupedRasterCaptionBottom?.(...args)

const nativeRasterCaption = (): ReturnType<typeof JSON.parse> => {
  const width = 300,
    height = 240,
    text = 'Fig 2: Native plate.',
    fnArray = [],
    argsArray = [],
    group = {
      matrix: null,
      bbox: [0, 0, width, height],
      smask: null,
      isolated: false,
      knockout: false
    }
  const add = (op: number, args: ReturnType<typeof JSON.parse>): void => {
    fnArray.push(op)
    argsArray.push(args)
  }
  add(OPS.save, null)
  add(OPS.beginGroup, [group])
  add(OPS.paintFormXObjectBegin, [null, null])
  add(OPS.beginText, null)
  add(OPS.setFont, ['Unused', 10])
  add(OPS.setLeading, [14])
  add(OPS.endText, null)
  add(OPS.save, null)
  add(OPS.transform, [220, 0, 0, 120, 40, 80])
  add(OPS.dependency, ['nativeRaster'])
  const imageIndex = fnArray.length
  add(OPS.paintImageXObject, ['nativeRaster', 220, 120])
  add(OPS.restore, null)
  add(OPS.paintFormXObjectEnd, [])
  add(OPS.endGroup, [{ ...group, bbox: [...group.bbox] }])
  add(OPS.restore, null)
  add(OPS.beginText, null)
  add(OPS.setFont, ['Body', 10])
  add(OPS.setTextMatrix, [[1, 0, 0, 1, 40, 72]])
  add(OPS.showText, [
    [...text].map((c) => ({
      unicode: c,
      fontChar: c,
      width: 500,
      isInFont: true,
      isSpace: c === ' ',
      accent: null
    }))
  ])
  add(OPS.endText, null)
  const viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x, y) => [x, height - y]
    },
    sourceItem = { pageNumber: 1, index: 0, text },
    item = {
      str: text,
      width: text.length * 5,
      height: 10,
      transform: [10, 0, 0, 10, 40, 72],
      fontName: 'Body',
      dir: 'ltr',
      sourceItem
    },
    token = tableTextToken(item, viewport, 0),
    graphicsBounds = [
      {
        kind: 'image',
        operationIndex: imageIndex,
        normalizedRect: [38 / width, 38 / height, 262 / width, 163 / height]
      }
    ],
    page = { pageNumber: 1, width, height, graphicsBounds, invalidGraphicsBounds: 0 },
    figure = {
      rect: [38, 38, 262, 163],
      caption: { page: 1, rect: token.rect, lines: [text] },
      graphicsCount: 1
    },
    context = {
      operators: { fnArray, argsArray },
      viewport,
      graphicsBounds,
      content: { items: [item], styles: { Body: { ascent: 0.5, descent: -0.2, vertical: false } } },
      glyphBounds: [
        {
          fontName: 'Body',
          glyphs: [...new Set(text)].map((c) => ({
            fontChar: c,
            bounds: c === ' ' ? [0, 0, 0, 0] : [0, -0.2, 0.5, 0.5]
          }))
        }
      ],
      opaqueRasterImages: [
        { operationIndex: imageIndex, imageId: 'nativeRaster', kind: 2, width: 220, height: 120 }
      ]
    }
  return { page, figure, context, imageIndex }
}

it('separates caption glyph ink from a complete grouped raster without clipping the image', () => {
  const f = nativeRasterCaption(),
    before = JSON.stringify(f),
    result = proof(f.page, f.figure, f.context)
  expect(result).toEqual({ bottom: 161.5, captionInkTop: 163, imageRect: [40, 40, 260, 160] })
  expect(result.bottom).toBeGreaterThan(f.figure.caption.rect[1])
  expect(JSON.stringify(f)).toBe(before)
  expect(geometry.nativeFigureCaptionBottomLimit(f.page, f.figure, f.context)).toBe(f.page.height)
})

it.each(['matrix', 'mask', 'knockout', 'end-group', 'nested-group'])(
  'keeps an unproved %s group unchanged',
  (kind) => {
    const f = nativeRasterCaption(),
      o = f.context.operators,
      group = o.argsArray[1][0]
    if (kind === 'matrix') group.matrix = [1, 0, 0, 1, 1, 0]
    if (kind === 'mask') group.smask = {}
    if (kind === 'knockout') group.knockout = true
    if (kind === 'end-group') o.argsArray[13][0].bbox[2] -= 1
    if (kind === 'nested-group') o.fnArray[5] = OPS.beginGroup
    expect(proof(f.page, f.figure, f.context)).toBeUndefined()
  }
)

it.each(['font-ink', 'source', 'image-identity', 'caption-text'])(
  'requires complete %s evidence',
  (kind) => {
    const f = nativeRasterCaption()
    if (kind === 'font-ink') delete f.context.glyphBounds
    if (kind === 'source') f.context.content.items[0].sourceItem.index = 1
    if (kind === 'image-identity') f.context.opaqueRasterImages[0].imageId = 'anotherRaster'
    if (kind === 'caption-text') f.figure.caption.lines = ['Fig 2: Different plate.']
    expect(proof(f.page, f.figure, f.context)).toBeUndefined()
  }
)

it('does not normalize leading in a text block that paints any glyph', () => {
  const f = nativeRasterCaption(),
    o = f.context.operators
  o.fnArray.splice(18, 0, OPS.setLeading)
  o.argsArray.splice(18, 0, [14])
  expect(proof(f.page, f.figure, f.context)).toBeUndefined()
})

it('refuses a caption whose actual glyph overhang touches the image', () => {
  const f = nativeRasterCaption()
  f.context.glyphBounds[0].glyphs.find((g) => g.fontChar === 'F').bounds[3] = 0.9
  expect(proof(f.page, f.figure, f.context)).toBeUndefined()
})

it('preserves a complete foreign source whose glyph ink crosses the removed strip', () => {
  const f = nativeRasterCaption(),
    o = f.context.operators
  const item = {
    ...f.context.content.items[0],
    str: 'Z',
    width: 5,
    transform: [10, 0, 0, 10, 200, 76],
    sourceItem: { pageNumber: 1, index: 1, text: 'Z' }
  }
  f.context.content.items.push(item)
  f.context.glyphBounds[0].glyphs.push({ fontChar: 'Z', bounds: [0, -0.2, 0.5, 0.5] })
  o.fnArray.push(OPS.beginText, OPS.setFont, OPS.setTextMatrix, OPS.showText, OPS.endText)
  o.argsArray.push(
    null,
    ['Body', 10],
    [[1, 0, 0, 1, 200, 76]],
    [[{ unicode: 'Z', fontChar: 'Z', width: 500, isInFont: true, isSpace: false, accent: null }]],
    null
  )
  expect(proof(f.page, f.figure, f.context)).toBeUndefined()
})

it('accepts only an actual PNG with room for both native image ink and caption antialiasing', () => {
  const evidence = { bottom: 161.5, captionInkTop: 163, imageRect: [40, 40, 260, 160] },
    rect = [38, 38, 262, 161.5],
    bounds = { width: 300, height: 240 },
    png = (scale: number): Uint8Array => {
      const bytes = new Uint8Array(33),
        h = new DataView(bytes.buffer)
      bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
      h.setUint32(8, 13)
      h.setUint32(12, 0x49484452)
      h.setUint32(16, Math.ceil((rect[2] - rect[0]) * scale))
      h.setUint32(20, Math.ceil((rect[3] - rect[1]) * scale))
      return bytes
    }
  expect(geometry.nativeGroupedRasterCaptionPngSafe?.(evidence, png(4), rect, bounds)).toBe(true)
  expect(
    geometry.nativeGroupedRasterCaptionPngSafe?.(evidence, png(0.5), rect, bounds) ?? false
  ).toBe(false)
  expect(
    geometry.nativeGroupedRasterCaptionPngSafe?.(evidence, new Uint8Array(), rect, bounds) ?? false
  ).toBe(false)
})
