/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { anonymousStrokeMarkerPairedPanels } from './fixtures/stroke-marker-paired-panels.mjs'
import { resolve } from './paths'

const resource = (name: string) => import(pathToFileURL(resolve(`resources/${name}.mjs`)).href)
const labels = await resource('literature-pdf-figure-native-plot-labels')
const group = await resource('literature-pdf-figure-native-group')
const { tableTextToken } = await resource('literature-pdf-orientation')
const { matchNativeFigureRenderContext } = await resource('literature-pdf-render-bounds')
const { renderPdfCrop } = await resource('literature-pdf-crop')
type Data = ReturnType<typeof JSON.parse>

async function inspect(fault = '', expectedStage = 'ok') {
  const f = await anonymousStrokeMarkerPairedPanels(fault)
  const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const alternate = getDocument({
    data: new Uint8Array(f.bytes),
    fontExtraProperties: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
    standardFontDataUrl: join(assets, 'standard_fonts') + '/'
  })
  try {
    const nativePage = await (await alternate.promise).getPage(1),
      pageContent = await nativePage.getTextContent(),
      operators = await nativePage.getOperatorList(),
      viewport = nativePage.getViewport({ scale: 1 }),
      context = matchNativeFigureRenderContext(
        f.context,
        1,
        pageContent,
        viewport,
        f.page.graphicsBounds,
        f.context.sourceSha256
      )
    expect(context).toBeTruthy()
    expect(pageContent.items[0].fontName).not.toBe(context.content.items[0].fontName)
    expect(
      context.operators.fnArray.filter((op: number) => op === OPS.paintImageXObject)
    ).toHaveLength(fault === 'third-image' ? 3 : 2)
    expect(
      context.operators.fnArray.filter(
        (op: number, i: number) =>
          op === OPS.setTextRenderingMode && context.operators.argsArray[i][0] === 1
      )
    ).toHaveLength(fault === 'invisible-marker' ? 0 : 2)
    expect(context.content.items.filter((r: { str: string }) => r.str === '*')).toHaveLength(
      fault === 'missing-fill' ? 3 : 5
    )
    const tokens = pageContent.items
        .map((item, index) => ({
          ...item,
          sourceItem: { pageNumber: 1, index, text: 'str' in item ? item.str : '' }
        }))
        .filter((item) => item.str?.trim())
        .map((item) => tableTextToken(item, viewport, 0)),
      selected = tokens
        .filter((t: { text: string }) => t.text.startsWith('"'))
        .map((t: { sourceItem: unknown }) => t.sourceItem)
    expect(selected).toHaveLength(fault === 'narrative-task' ? 1 : 2)
    expect(labels.nativePageTextPacketInventory(f.page, tokens, context, true)).toBeUndefined()
    expect(labels.nativeFillStrokeTextInkPacket(f.page, tokens, context, selected)).toBeUndefined()
    const oldRect = f.figure.rect,
      live: Data = { nativePage, pageContent, operators },
      tables: Data[] = [],
      peers: Data[] = []
    let getterCalls = 0,
      display: Data
    const renderScales: number[] = [],
      render = nativePage.render
    Object.defineProperty(nativePage, 'render', {
      configurable: true,
      value: (options: Data) => {
        renderScales.push(options.viewport.scale)
        const task: Data = render.call(nativePage, options),
          promise = task.promise.then((value: Data) => {
            display = task._internalRenderTask.operatorList
            const path = display.fnArray.findIndex(
              (op: number, i: number) =>
                op === OPS.constructPath &&
                (fault === 'compiled-shape'
                  ? display.argsArray[i][2] !== null
                  : display.argsArray[i][0] === OPS.endPath && display.argsArray[i][2] === null)
            )
            if (fault.startsWith('compiled-')) expect(path).toBeGreaterThanOrEqual(0)
            if (fault === 'compiled-shape' || fault === 'compiled-empty')
              display.argsArray[path][1][0].lineTo(99, 99)
            if (fault === 'compiled-fill') {
              const actual = display.argsArray[path][1][0]
              actual.setFillType(actual.getFillType() === 0 ? 1 : 0)
            }
            if (fault === 'compiled-minmax') display.argsArray[path][2] = [0, 0, 1, 1]
            if (fault === 'compiled-op') display.argsArray[path][0] = OPS.stroke
            if (fault === 'append-clip') {
              display.fnArray.push(OPS.clip)
              display.argsArray.push([])
            }
            if (fault === 'image-dimensions') {
              const i = display.fnArray.indexOf(OPS.paintImageXObject)
              nativePage.objs.get(display.argsArray[i][0]).width += 1
            }
            const imageIndex = display.fnArray.indexOf(OPS.paintImageXObject),
              image: Data = nativePage.objs.get(display.argsArray[imageIndex][0])
            if (fault === 'metadata-child-after-seal') image.extra = { count: 1 }
            if (fault === 'bitmap-image') image.bitmap = {}
            if (fault === 'resizable-image' || fault === 'shared-image') {
              const buffer =
                  fault === 'resizable-image'
                    ? new ArrayBuffer(image.data.byteLength, {
                        maxByteLength: image.data.byteLength + 4
                      })
                    : new SharedArrayBuffer(image.data.byteLength),
                view = new Uint8ClampedArray(buffer)
              view.set(image.data)
              image.data = view
            }
            if (fault === 'image-data-getter')
              Object.defineProperty(image, 'data', {
                configurable: true,
                get() {
                  getterCalls++
                  throw Error('Image data getter')
                }
              })
            if (fault === 'view-length-getter')
              Object.defineProperty(image.data, 'byteLength', {
                configurable: true,
                get() {
                  getterCalls++
                  throw Error('Image view getter')
                }
              })
            return value
          })
        return { promise, _internalRenderTask: task._internalRenderTask }
      }
    })
    if (fault === 'table' || fault === 'algorithm') tables.push(oldRect)
    if (fault === 'peer') peers.push({ rect: oldRect })
    if (fault === 'caption-getter' || fault === 'rect-getter') {
      const key = fault === 'caption-getter' ? 'caption' : 'rect',
        value = f.figure[key]
      Object.defineProperty(f.figure, key, {
        configurable: true,
        get() {
          getterCalls++
          return value
        }
      })
    }
    const plan = group.nativeStrokeTaskRasterPairPixelCrop?.(
        f.page,
        f.figure,
        f.captions,
        tables,
        tokens,
        context,
        peers,
        fault === 'rect-getter' ? undefined : oldRect,
        live
      ),
      rect = plan?.rect ?? oldRect
    expect(getterCalls).toBe(0)
    if (expectedStage === 'crop') {
      expect(plan).toBeUndefined()
      return
    }
    // The existing production caller falls back to its published image crop
    // when no supported preview proof succeeds; that omits both annotations.
    const scale =
      fault === 'oversize-page' ? 4 : ['large-page', 'byte-retry'].includes(fault) ? 2 : 1
    expect(rect[1]).toBeLessThan(250 * scale - 19)
    expect(rect[3]).toBeGreaterThan(400 * scale + 33)
    expect(plan).toBeTruthy()
    if (!fault) {
      const unsealed = await renderPdfCrop(nativePage, rect, 0)
      expect(group.nativeStrokeTaskRasterPairPixelPngSafe(plan, unsealed, rect, f.page)).toBe(false)
    }
    if (fault === 'late-scope-getter')
      Object.defineProperty(live, 'nativePage', {
        configurable: true,
        get() {
          getterCalls++
          throw Error('Unconsumed scope getter')
        }
      })
    const png = await group.renderNativeStrokeTaskPairPng(plan, nativePage, rect, 0)
    expect(getterCalls).toBe(0)
    if (expectedStage === 'render') {
      if (fault === 'bitmap-image') {
        const i = display.fnArray.indexOf(OPS.paintImageXObject)
        delete nativePage.objs.get(display.argsArray[i][0]).bitmap
      }
      expect(png).toBeUndefined()
      return
    }
    expect(png).toBeTruthy()
    expect(group.nativeStrokeTaskRasterPairPixelPngSafe(plan, png, rect, f.page)).toBe(true)
    expect(plan.sourceItems).toBeUndefined()
    expect(plan.nativeBody).toBeUndefined()
    if (fault === 'large-page') expect(png.readUInt32BE(16)).toBe(2400)
    if (fault === 'byte-retry') {
      expect(renderScales.length).toBeGreaterThan(1)
      expect(renderScales.at(-1)).toBeLessThan(renderScales[0])
    }
    if (fault === 'canonical') {
      const changed = Buffer.from(png)
      changed[changed.length - 1] ^= 1
      expect(group.nativeStrokeTaskRasterPairPixelPngSafe(plan, changed, rect, f.page)).toBe(false)
    }
    if (fault === 'alpha-after-seal') {
      const i = display.fnArray.indexOf(OPS.paintImageXObject),
        image = nativePage.objs.get(display.argsArray[i][0])
      expect(image.kind).toBe(3)
      image.data[3] = 254
      expect(group.nativeStrokeTaskRasterPairPixelPngSafe(plan, png, rect, f.page)).toBe(false)
    }
    if (fault === 'cache-slot-after-seal') {
      const i = display.fnArray.findIndex(
        (op: number, index: number) =>
          op === OPS.constructPath && display.argsArray[index][2] === null
      )
      expect(i).toBeGreaterThanOrEqual(0)
      display.argsArray[i][1] = [...display.argsArray[i][1]]
      expect(group.nativeStrokeTaskRasterPairPixelPngSafe(plan, png, rect, f.page)).toBe(false)
    }
    if (
      [
        'view-after-seal',
        'metadata-after-seal',
        'metadata-child-after-seal',
        'prototype-after-seal',
        'view-prototype-after-seal',
        'detached-after-seal'
      ].includes(fault)
    ) {
      const i = display.fnArray.indexOf(OPS.paintImageXObject),
        image: Data = nativePage.objs.get(display.argsArray[i][0])
      if (fault === 'view-after-seal') image.data = image.data.subarray(1)
      if (fault === 'metadata-after-seal')
        Object.defineProperty(image, 'width', { writable: false })
      if (fault === 'metadata-child-after-seal') image.extra.count++
      if (fault === 'prototype-after-seal') Object.setPrototypeOf(image, null)
      if (fault === 'view-prototype-after-seal')
        Object.setPrototypeOf(
          image.data,
          Object.getPrototypeOf(image.data) === Uint8Array.prototype
            ? Uint8ClampedArray.prototype
            : Uint8Array.prototype
        )
      if (fault === 'detached-after-seal')
        structuredClone(image.data.buffer, { transfer: [image.data.buffer] })
      expect(group.nativeStrokeTaskRasterPairPixelPngSafe(plan, png, rect, f.page)).toBe(false)
    }
  } finally {
    await alternate.destroy()
    await f.cleanup()
  }
}
it.each([
  '',
  'inactive-fill',
  'rgba',
  'viewport-clip',
  'large-page',
  'byte-retry',
  'canonical',
  'alpha-after-seal',
  'cache-slot-after-seal',
  'view-after-seal',
  'metadata-after-seal',
  'metadata-child-after-seal',
  'prototype-after-seal',
  'view-prototype-after-seal',
  'detached-after-seal'
])(
  'includes complete paired annotations with a sealed actual native PNG: %s',
  async (fault) => {
    await inspect(fault)
  },
  20_000
)
it.each([
  'narrative-task',
  'off-center-task',
  'reordered-key',
  'missing-fill',
  'missing-key',
  'distant-legend',
  'foreign-caption-gap',
  'foreign-path',
  'third-image',
  'invisible-marker',
  'rotated-task',
  'table',
  'algorithm',
  'peer',
  'caption-getter',
  'rect-getter'
])('refuses incomplete or competing native scene membership: %s', async (fault) => {
  await inspect(fault, 'crop')
})
it.each([
  'rgba-transparent',
  'oversize-page',
  'compiled-shape',
  'compiled-empty',
  'compiled-fill',
  'compiled-minmax',
  'compiled-op',
  'append-clip',
  'image-dimensions',
  'late-scope-getter',
  'bitmap-image',
  'resizable-image',
  'shared-image',
  'image-data-getter',
  'view-length-getter'
])(
  'declines changed final render evidence without publishing a pending crop: %s',
  async (fault) => {
    await inspect(fault, 'render')
  },
  20_000
)
