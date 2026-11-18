import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { resolve } from './paths'

const { strokeOnlyPreviewFixture } = await import(
  pathToFileURL(resolve('test/fixtures/native-stroke-only-preview.mjs')).href
)
const {
  nativeStrokeOnlyTextInkPacket: observe,
  nativeFillStrokeTextInkPacket: oldPurpose,
  nativePageTextPacketInventory: ordinarySource
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { nativeStrokeOnlyGlyphEnvelope: envelope } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-stroked-text.mjs')).href
)
const { matchNativeFigureRenderContext } = await import(
  pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
type Data = ReturnType<typeof JSON.parse>
const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const cases: Array<[string, boolean]> = [
  ['implicit-fill', true],
  ['base', true],
  ['hairline', true],
  ['fill-alpha-zero', true],
  ['empty-space', true],
  ['mode0', true],
  ['mode2', true],
  ['mode3', false],
  ['mode4', false],
  ['mode5', false],
  ['mode6', false],
  ['mode7', false],
  ['stroke-alpha', false],
  ['missing-outline', false],
  ['dual-document', true],
  ['changed-evidence-map', true],
  ['changed-image-inventory', true],
  ['changed-stroke-state', true],
  ['changed-font-outline', true],
  ['changed-source', true],
  ['changed-operator-array', true]
]

// Every native witness is made by actual PDF.js rendering. Mode1 never becomes
// filled-area or Source evidence; the packet alone cannot prove figure membership.
it.each(cases)('keeps the stroke-only preview purpose bounded: %s', async (name, expected) => {
  const f: Data = await strokeOnlyPreviewFixture(name)
  let second: Data
  try {
    const { page } = f
    let { tokens, context } = f
    if (name === 'dual-document') {
      second = await getDocument({
        data: new Uint8Array(f.bytes),
        fontExtraProperties: true,
        useSystemFonts: false,
        isEvalSupported: false,
        verbosity: 0,
        standardFontDataUrl: join(assets, 'standard_fonts') + '/'
      }).promise
      const live = await second.getPage(1),
        content = await live.getTextContent(),
        viewport = live.getViewport({ scale: 1 })
      assert.notEqual(content.items[0].fontName, context.content.items[0].fontName)
      context = matchNativeFigureRenderContext(
        context,
        1,
        content,
        viewport,
        page.graphicsBounds,
        context.sourceSha256
      )
      assert(context)
      tokens = content.items
        .map((r: Data, index: number) => ({
          ...r,
          sourceItem: { pageNumber: 1, index, text: r.str }
        }))
        .filter((r: Data) => r.str.trim())
        .map((r: Data) => tableTextToken(r, viewport, 0))
    }
    if (name === 'missing-outline') context.glyphBounds[0].glyphs = []
    const packet: Data = observe(page, tokens, context, [tokens[0].sourceItem])
    assert.equal(!!packet, expected)
    const oldAccepted = !!oldPurpose(page, tokens, context, [tokens[0].sourceItem]),
      ordinaryAccepted = !!ordinarySource(page, tokens, context, true)
    if (name === 'implicit-fill') {
      assert(oldAccepted)
      assert(ordinaryAccepted)
    } else if (['mode0', 'mode2'].includes(name)) {
      assert(oldAccepted)
      assert.equal(ordinaryAccepted, false)
    } else {
      assert.equal(oldAccepted, false)
      assert.equal(ordinaryAccepted, false)
    }
    if (!packet) return
    assert(packet.current())
    assert.equal(packet.sourceAuthority, false)
    const stroke: Data[] = packet.glyphs.filter((g: Data) => g.strokeOnlyText)
    for (const glyph of stroke) {
      assert.equal(glyph.textPaint.renderingMode, 1)
      assert.equal(Object.hasOwn(glyph.textPaint, 'fillColor'), false)
      assert.equal(Object.hasOwn(glyph.textPaint, 'fillAlpha'), false)
    }
    if (name === 'fill-alpha-zero') {
      assert.equal(stroke.length, 1)
      assert.equal(stroke[0].strokeOnlyText.fillAlpha, 0)
      assert.equal(stroke[0].textPaint.renderingMode, 1)
      assert.equal(stroke[0].textPaint.strokeAlpha, 1)
      assert(stroke[0].ink[0] < stroke[0].ink[2])
      assert(stroke[0].cropVisibleInk)
    }
    if (name === 'empty-space') {
      const spaces: Data[] = packet.glyphs.filter((g: Data) => g.text === ' ')
      assert(spaces.length)
      for (const glyph of spaces) {
        assert.equal(glyph.textPaint.renderingMode, 1)
        assert.equal(glyph.textPaint.strokeAlpha, 1)
        assert.equal(Object.hasOwn(glyph.textPaint, 'fillAlpha'), false)
        assert.equal(glyph.ink[0], glyph.ink[2])
        assert.equal(glyph.ink[1], glyph.ink[3])
        assert.equal(glyph.cropVisibleInk, undefined)
      }
    }
    if (name.startsWith('changed-')) {
      if (name === 'changed-evidence-map') packet.evidence.paths.set(99999, {})
      if (name === 'changed-image-inventory') packet.evidence.images.push({})
      if (name === 'changed-stroke-state') stroke[0].strokeOnlyText.strokeAlpha = 0.5
      if (name === 'changed-font-outline') context.glyphBounds[0].glyphs[0].bounds[0] += 0.000001
      if (name === 'changed-source') context.content.items[0].str += 'x'
      if (name === 'changed-operator-array')
        context.operators.argsArray = [...context.operators.argsArray]
      assert.equal(packet.current(), false)
    } else if (
      ['base', 'hairline', 'fill-alpha-zero', 'empty-space', 'dual-document'].includes(name)
    ) {
      assert.equal(stroke.length, 1)
      // Recompute from original ink/state at this real output scale. Packet
      // bounds initially use4x and are not final PNG completeness evidence.
      const scale = name === 'hairline' ? 2 : 4,
        viewport = f.nativePage.getViewport({ scale }),
        canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const bound = envelope(stroke[0].strokeOnlyText.ink, stroke[0].strokeOnlyText, scale)
      assert(bound)
      await f.nativePage.render({ canvas, canvasContext: canvas.getContext('2d'), viewport })
        .promise
      const { data, width, height } = canvas
        .getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height)
      let minX = width,
        minY = height,
        maxX = -1,
        maxY = -1
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const index = (y * width + x) * 4
          if (data[index + 3] && Math.min(data[index], data[index + 1], data[index + 2]) < 254) {
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
          }
        }
      // The pinned renderer currently has an empty ca=0/CA=1 raster. Retained
      // potential ink remains conservative; this does not assert visibility.
      if (maxX < 0) assert.equal(name, 'fill-alpha-zero')
      else
        assert(
          minX / scale >= bound[0] &&
            minY / scale >= bound[1] &&
            (maxX + 1) / scale <= bound[2] &&
            (maxY + 1) / scale <= bound[3]
        )
      canvas.width = canvas.height = 1
    }
  } finally {
    if (second) await second.destroy()
    await f.cleanup()
  }
})

describe('stroke-only geometric state guards', () => {
  let fixture: Data, state: Data
  beforeAll(async () => {
    fixture = await strokeOnlyPreviewFixture()
    const packet = observe(fixture.page, fixture.tokens, fixture.context, [
      fixture.tokens[0].sourceItem
    ])
    assert(packet?.current())
    state = packet.glyphs.find((g: Data) => g.strokeOnlyText).strokeOnlyText
  })
  afterAll(async () => {
    await fixture?.cleanup()
  })
  it.each<[string, unknown]>([
    ['lineWidth', Number.NaN],
    ['lineCap', 3],
    ['strokeAlpha', 0.5],
    ['clip', [0, 0, 0, 0]],
    ['matrix', [0, 0, 0, 0, 0, 0]]
  ])('refuses unsupported numeric/paint state: %s %s', (key, value) => {
    assert.equal(envelope(state.ink, { ...state, [key]: value }, 4), undefined)
  })
  it.each([0, Number.NaN])('refuses an invalid raster scale: %s', (scale) => {
    assert.equal(envelope(state.ink, state, scale), undefined)
  })
  it('does not use unused fill state as stroke authority', () => {
    assert.deepEqual(
      envelope(state.ink, { ...state, fillColor: 'unused', fillAlpha: Number.NaN }, 4),
      envelope(state.ink, state, 4)
    )
  })
})
