import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const {
  anonymousNestedRecovery,
  anonymousInertLeadingRecovery,
  anonymousForeignAccentRecovery,
  anonymousSubscriptRecovery
} = await import(pathToFileURL(resolve('test/fixtures/figure-recovery-program.mjs')).href)
const {
  nativeRecoveryFigureCrop,
  nativeRecoveryFigurePngSafe,
  nativeSharedFramePixelCrop,
  nativeSharedFramePixelPngSafe,
  nativeBarChartPixelCrop,
  nativeBarChartPixelPngSafe
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { createCanvas } = await import('@napi-rs/canvas')
const {
  nativeClosedProgramInkPacket,
  nativeForeignCompoundInkPacket,
  nativeClosedPrintedFaceInkPacket
} = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-plot-labels.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { createNativeFigureRecoveryProfile } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-figure-recovery-profile.mjs')).href
)
const { nativeIsolatedFormFigureCrop, nativeIsolatedFormPngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-isolated-form.mjs')).href
)
const { captureNativeFigureRenderContext, matchNativeFigureRenderContext } = await import(
  pathToFileURL(resolve('resources/literature-pdf-render-bounds.mjs')).href
)
it('recovers the whole ordinary nested picture and its complete native labels without borrowing the running header', () => {
  const f = anonymousNestedRecovery(),
    out = nativeRecoveryFigureCrop(...f.args)
  expect(out).toBeDefined()
  expect(out.sourceItems.map((s: { text: string }) => s.text)).toEqual(['Axis', 'Value'])
  expect(out.rect).toEqual([60, 70, 340, 260])
})
it('declines a nested root unrelated to the detected figure', () => {
  const f = anonymousNestedRecovery()
  f.args[1].rect = [40, 270, 360, 295]
  expect(nativeRecoveryFigureCrop(...f.args)).toBeUndefined()
})
it.each(['paint', 'glyph', 'table', 'caption'])(
  'preserves a complete nested companion in the body-to-caption lane: %s',
  (mode) => {
    const f = anonymousNestedRecovery()
    if (mode === 'paint')
      f.add(OPS.constructPath, [
        OPS.fill,
        [[0, 60, 120, 1, 100, 120, 1, 100, 130, 1, 60, 130, 4]],
        [60, 120, 100, 130]
      ])
    if (mode === 'glyph') f.text('panel', 80, 280)
    if (mode === 'table') f.args[3].push([60, 270, 100, 280])
    if (mode === 'caption')
      f.args[2].push({ page: 1, lines: ['Figure 2: Companion.'], rect: [60, 270, 160, 282] })
    expect(nativeRecoveryFigureCrop(...f.args)).toBeUndefined()
  }
)
it('keeps unrelated adjacent-column prose outside the complete nested caption lane', () => {
  const f = anonymousNestedRecovery()
  f.text('prose', 370, 280)
  expect(nativeRecoveryFigureCrop(...f.args)?.rect).toEqual([60, 70, 340, 260])
})
it('admits only inert leading and terminal text-line transitions while preserving the complete picture', () => {
  const f = anonymousInertLeadingRecovery(),
    [page, , , , tokens, c] = f.args
  expect(nativeClosedProgramInkPacket(page, tokens, c, [tokens[1].sourceItem])).toBeUndefined()
  const out = nativeRecoveryFigureCrop(...f.args)
  expect(out?.sourceItems.map((s: { text: string }) => s.text)).toEqual(['Axis', 'Value'])
})
it('retains a complete foreign compound accent without changing the claimed picture literals', () => {
  const f = anonymousForeignAccentRecovery(),
    out = nativeRecoveryFigureCrop(...f.args)
  expect(out?.sourceItems.map((s: { text: string }) => s.text)).toEqual(['Axis', 'Value'])
  expect(f.args[5].content.items[0].str).toBe('ä')
})
it('owns a complete merged native subscript item through both physical glyph advances', () => {
  const f = anonymousSubscriptRecovery(),
    [page, , , , tokens, c] = f.args
  expect(nativeClosedProgramInkPacket(page, tokens, c, [tokens[1].sourceItem])).toBeUndefined()
  const out = nativeRecoveryFigureCrop(...f.args)
  expect(out?.sourceItems.map((s: { text: string }) => s.text)).toEqual(['nq', 'Value'])
})
it('uses the actual text-matrix scale when a subscript retains the same setFont size', () => {
  const f = anonymousSubscriptRecovery(),
    c = f.args[5],
    at = c.operators.argsArray.findIndex(
      (a: unknown[], i: number) => c.operators.fnArray[i] === OPS.setFont && a[1] === 6
    )
  c.operators.argsArray[at][1] = 10
  c.operators.argsArray[at + 1][0][0] = 0.6
  c.operators.argsArray[at + 1][0][3] = 0.6
  expect(
    nativeRecoveryFigureCrop(...f.args)?.sourceItems.map((s: { text: string }) => s.text)
  ).toEqual(['nq', 'Value'])
})
it('exposes a foreign-only packet which still refuses every owned compound accent', () => {
  const f = anonymousForeignAccentRecovery(),
    [page, , , , tokens, c] = f.args
  expect(nativeForeignCompoundInkPacket(page, tokens, c, [tokens[1].sourceItem])).toBeDefined()
  expect(nativeForeignCompoundInkPacket(page, tokens, c, [tokens[0].sourceItem])).toBeUndefined()
  expect(nativeClosedProgramInkPacket(page, tokens, c, [tokens[1].sourceItem])).toBeUndefined()
})
it.each(['complete', 'remeasure', 'extra-budget'])(
  'captures accents in the same loaded-font task without displacing ordinary glyph evidence: %s',
  (mode) => {
    const f = anonymousForeignAccentRecovery(),
      [page, , , , , c] = f.args,
      glyph = c.operators.argsArray[c.operators.fnArray.indexOf(OPS.showText)][0][0],
      accentBounds = [0, 0.6, 0.4, 0.8],
      font = {
        loadedName: 'F',
        missingFile: false,
        disableFontFace: true,
        remeasure: mode === 'remeasure',
        isType3Font: false,
        fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        getPathGenerator: (_objects: unknown, character: string) => ({
          getBounds: () =>
            character === glyph.accent.fontChar
              ? accentBounds
              : c.glyphBounds[0].glyphs.find((g: { fontChar: string }) => g.fontChar === character)
                  ?.bounds
        })
      },
      objects = { get: () => font },
      viewport = { ...c.viewport },
      render = {
        _internalRenderTask: {
          operatorList: c.operators,
          params: {
            viewport: {
              width: 600,
              height: 600,
              rotation: 0,
              scale: 1.5,
              transform: [1.5, 0, 0, -1.5, 0, 600]
            }
          }
        }
      }
    if (mode === 'extra-budget') glyph.accent.fontChar = 'x'.repeat(33000)
    const captured = captureNativeFigureRenderContext(
      render,
      1,
      c.content,
      viewport,
      c.graphicsBounds,
      c.sourceSha256,
      objects
    )
    expect(captured?.glyphBounds).toBeDefined()
    expect(
      captured.glyphBounds[0].glyphs.some(
        (g: { fontChar: string }) => g.fontChar === glyph.accent.fontChar
      )
    ).toBe(false)
    if (mode === 'complete') {
      expect(captured.foreignCompoundGlyphs).toEqual(c.foreignCompoundGlyphs)
      expect(
        matchNativeFigureRenderContext(
          captured,
          1,
          c.content,
          viewport,
          c.graphicsBounds,
          c.sourceSha256
        ).foreignCompoundGlyphs
      ).toEqual(c.foreignCompoundGlyphs)
    } else expect(captured.foreignCompoundGlyphs).toBeUndefined()
    expect(page.width).toBe(400)
  }
)
it.each([
  'missing',
  'outline',
  'remeasure',
  'missing-file',
  'font-face',
  'type3',
  'matrix',
  'nan-offset',
  'outside-offset',
  'not-in-font',
  'space',
  'empty-unicode'
])('declines incomplete foreign accent evidence: %s', (mode) => {
  const f = anonymousForeignAccentRecovery(),
    [page, , , , tokens, c] = f.args,
    font = c.foreignCompoundGlyphs[0],
    glyph = c.operators.argsArray[c.operators.fnArray.indexOf(OPS.showText)][0][0]
  if (mode === 'missing') delete c.foreignCompoundGlyphs
  if (mode === 'outline') font.glyphs = []
  if (mode === 'remeasure') font.remeasure = true
  if (mode === 'missing-file') font.missingFile = true
  if (mode === 'font-face') font.disableFontFace = false
  if (mode === 'type3') font.isType3Font = true
  if (mode === 'matrix') font.fontMatrix[0] = 0.002
  if (mode === 'nan-offset') glyph.accent.offset.x = NaN
  if (mode === 'outside-offset') glyph.accent.offset.y = 1e9
  if (mode === 'not-in-font') glyph.isInFont = false
  if (mode === 'space') glyph.isSpace = true
  if (mode === 'empty-unicode') glyph.unicode = ''
  expect(nativeForeignCompoundInkPacket(page, tokens, c, [tokens[1].sourceItem])).toBeUndefined()
})
it.each([
  'width',
  'baseline',
  'cross-font',
  'third-glyph',
  'reverse-baseline',
  'negative-width',
  'negative-height',
  'negative-transform',
  'source-index'
])('requires the complete signed subscript/source program: %s', (mode) => {
  const f = anonymousSubscriptRecovery(),
    [, , , , tokens, c] = f.args,
    r = c.content.items[1],
    at = c.operators.argsArray.findIndex(
      (a: unknown[], i: number) => c.operators.fnArray[i] === OPS.setFont && a[1] === 6
    )
  if (mode === 'width') r.width += 1
  if (mode === 'baseline') r.transform[5] += 1
  if (mode === 'cross-font') {
    c.operators.argsArray[at][0] = 'G'
    c.content.styles.G = { ...c.content.styles.F }
    c.glyphBounds.push({ fontName: 'G', glyphs: [{ fontChar: 'q', bounds: [0, -0.1, 0.5, 0.7] }] })
  }
  if (mode === 'third-glyph') {
    r.str = 'nqr'
    r.width = 11
    r.sourceItem.text = r.str
    c.operators.argsArray[at + 2][0].push({
      unicode: 'r',
      fontChar: 'r',
      width: 500,
      isInFont: true
    })
    c.glyphBounds[0].glyphs.push({ fontChar: 'r', bounds: [0, -0.1, 0.5, 0.7] })
  }
  if (mode === 'reverse-baseline') c.operators.argsArray[at + 1][0][5] = 315
  if (mode === 'negative-width') r.width = -r.width
  if (mode === 'negative-height') r.height = -r.height
  if (mode === 'negative-transform') r.transform[0] = -r.transform[0]
  if (mode === 'source-index') r.sourceItem.index = 0
  tokens[1] = tableTextToken(r, c.viewport, 0)
  expect(nativeRecoveryFigureCrop(...f.args)).toBeUndefined()
})
it.each([
  'nonfinite',
  'following-paint',
  'quote',
  'double-quote',
  'leading-move',
  'new-BT-consumer'
])('declines a text line transition whose leading may affect paint: %s', (mode) => {
  const f = anonymousInertLeadingRecovery(),
    [page, , , , tokens, c] = f.args,
    o = c.operators,
    at = o.fnArray.indexOf(OPS.nextLine)
  if (mode === 'nonfinite') o.argsArray[o.fnArray.indexOf(OPS.setLeading)] = [NaN]
  if (mode === 'following-paint') o.fnArray[at + 1] = OPS.showText
  if (mode === 'quote') o.fnArray[at] = OPS.nextLineShowText
  if (mode === 'double-quote') o.fnArray[at] = OPS.nextLineSetSpacingShowText
  if (mode === 'leading-move') o.fnArray[at] = OPS.setLeadingMoveText
  if (mode === 'new-BT-consumer') {
    o.fnArray.push(OPS.save, OPS.beginText, OPS.nextLine, OPS.showText, OPS.endText, OPS.restore)
    o.argsArray.push(null, null, null, [[{ unicode: 'X' }]], null, null)
  }
  expect(createNativeFigureRecoveryProfile(page, tokens, c)).toBeUndefined()
  expect(nativeRecoveryFigureCrop(...f.args)).toBeUndefined()
})
it('keeps the explicit legacy crop seam bound to its recovery witness after await', () => {
  const f = anonymousInertLeadingRecovery(),
    [page, , , , tokens, c] = f.args,
    profile = createNativeFigureRecoveryProfile(page, tokens, c),
    out = nativeIsolatedFormFigureCrop(...f.args, profile)
  expect(out).toBeDefined()
  const rect = out.rect.map((x: number, i: number) => x + (i < 2 ? -2 : 2)),
    png = createCanvas(
      Math.ceil((rect[2] - rect[0]) * 4),
      Math.ceil((rect[3] - rect[1]) * 4)
    ).toBuffer('image/png')
  expect(nativeIsolatedFormPngSafe(png, rect, page, out)).toBe(true)
  c.content.items = [...c.content.items]
  expect(nativeIsolatedFormPngSafe(png, rect, page, out)).toBe(false)
})
it('refuses one physical compound glyph split across two otherwise matching foreign source records', () => {
  const f = anonymousForeignAccentRecovery(),
    [page, , , , , c] = f.args,
    base = c.content.items[0],
    accent = structuredClone(base)
  base.str = 'a'
  accent.str = '\u0308'
  c.content.items.splice(0, 1, base, accent)
  c.content.items.forEach((r: { sourceItem: unknown; str: string }, index: number) => {
    r.sourceItem = { pageNumber: 1, index, text: r.str }
  })
  const tokens = c.content.items.map((r: unknown) => tableTextToken(r, c.viewport, 0))
  expect(nativeForeignCompoundInkPacket(page, tokens, c, [tokens[2].sourceItem])).toBeUndefined()
})
it.each([
  'mask',
  'knockout',
  'nonisolated',
  'matrix',
  'multiply',
  'pattern',
  'image-hash',
  'owned-metric',
  'missing-source',
  'empty-unicode',
  'painted-space',
  'table',
  'caption-tail'
])('declines an unclosed nested picture: %s', (mode) => {
  const f = anonymousNestedRecovery(),
    [, figure, captions, tables, tokens, c] = f.args,
    o = c.operators,
    group = o.argsArray[o.fnArray.indexOf(OPS.beginGroup)][0]
  if (mode === 'mask') group.smask = { subtype: 'Alpha' }
  if (mode === 'knockout') group.knockout = true
  if (mode === 'nonisolated') group.isolated = false
  if (mode === 'matrix') group.matrix = [1, 0, 0, 1, 0, 0]
  if (mode === 'multiply') o.argsArray[o.fnArray.indexOf(OPS.setGState)] = [[['BM', 'multiply']]]
  if (mode === 'pattern') o.fnArray[0] = OPS.setFillColorN
  if (mode === 'image-hash') delete c.graphicsBounds[0].imageHash
  if (mode === 'owned-metric') c.content.styles.F.ascent = 0
  if (mode === 'missing-source') tokens.splice(1, 1)
  if (mode === 'table') tables.push([70, 80, 100, 100])
  if (mode === 'caption-tail') {
    captions[0].lines[0] = 'Figure 1: Incomplete'
    figure.caption = captions[0]
  }
  if (mode === 'empty-unicode' || mode === 'painted-space') {
    const at = o.fnArray.findIndex(
      (op: number, i: number) => op === OPS.showText && o.argsArray[i][0][0].unicode === 'Axis'
    )
    o.argsArray[at][0].push({
      unicode: mode === 'empty-unicode' ? '' : ' ',
      fontChar: 'extra',
      width: 0,
      isInFont: true,
      isSpace: false
    })
    c.glyphBounds[0].glyphs.push({ fontChar: 'extra', bounds: [0, 0, 0.1, 0.1] })
  }
  expect(nativeRecoveryFigureCrop(...f.args)).toBeUndefined()
})
it('keeps the default packet strict and binds every actual input across the asynchronous crop', () => {
  const f = anonymousNestedRecovery(),
    [page, , , , tokens, c] = f.args
  expect(nativeClosedProgramInkPacket(page, tokens, c, [tokens[1].sourceItem])).toBeUndefined()
  const out = nativeRecoveryFigureCrop(...f.args),
    rect = out.rect.map((x: number, i: number) => x + (i < 2 ? -2 : 2)),
    png = createCanvas(
      Math.ceil((rect[2] - rect[0]) * 4),
      Math.ceil((rect[3] - rect[1]) * 4)
    ).toBuffer('image/png')
  expect(nativeRecoveryFigurePngSafe(png, rect, page, { ...out })).toBe(true)
  expect(nativeRecoveryFigurePngSafe(png, rect, { ...page }, out)).toBe(false)
  c.content.items = [...c.content.items]
  expect(nativeRecoveryFigurePngSafe(png, rect, page, out)).toBe(false)
})
it.each(['claims-root', 'claims-item', 'rect-root', 'raster-root', 'raster-foreign'])(
  'rejects a changing output accessor without reading it: %s',
  (mode) => {
    const f = anonymousNestedRecovery(),
      [page] = f.args,
      out = nativeRecoveryFigureCrop(...f.args),
      candidate = { ...out },
      old = out.sourceItems,
      rect = out.rect.map((x: number, i: number) => x + (i < 2 ? -2 : 2)),
      png = createCanvas(
        Math.ceil((rect[2] - rect[0]) * 4),
        Math.ceil((rect[3] - rect[1]) * 4)
      ).toBuffer('image/png')
    let reads = 0
    if (mode === 'claims-root')
      Object.defineProperty(candidate, 'sourceItems', {
        get: () =>
          ++reads === 1 ? old : [{ pageNumber: 1, index: 999, text: 'Unrelated ordinary prose.' }],
        enumerable: true,
        configurable: true
      })
    if (mode === 'claims-item')
      Object.defineProperty(old, '0', {
        get: () =>
          ++reads === 1
            ? f.args[5].content.items[1].sourceItem
            : { pageNumber: 1, index: 999, text: 'Unrelated ordinary prose.' },
        enumerable: true,
        configurable: true
      })
    if (mode === 'rect-root')
      Object.defineProperty(candidate, 'rect', {
        get: () => {
          reads++
          return out.rect
        },
        enumerable: true,
        configurable: true
      })
    if (mode === 'raster-root')
      Object.defineProperty(candidate, 'formCropRaster', {
        get: () => {
          reads++
          return out.formCropRaster
        },
        enumerable: true,
        configurable: true
      })
    if (mode === 'raster-foreign') {
      const foreign = out.formCropRaster.foreignPaints
      Object.defineProperty(out.formCropRaster, 'foreignPaints', {
        get: () => {
          reads++
          return foreign
        },
        enumerable: true,
        configurable: true
      })
    }
    expect(nativeRecoveryFigurePngSafe(png, rect, page, candidate)).toBe(false)
    expect(reads).toBe(0)
  }
)
it.each(['inherited-viewport', 'own-viewport-getter', 'inherited-font-glyphs'])(
  'declines noncanonical native metadata without evaluating inherited evidence: %s',
  (mode) => {
    const f = anonymousNestedRecovery(),
      c = f.args[5]
    if (mode === 'inherited-viewport') {
      const width = c.viewport.width
      delete c.viewport.width
      Object.setPrototypeOf(c.viewport, {
        get width() {
          return width
        }
      })
    }
    if (mode === 'own-viewport-getter') {
      const width = c.viewport.width
      Object.defineProperty(c.viewport, 'width', { get: () => width, configurable: true })
    }
    if (mode === 'inherited-font-glyphs') {
      const font = c.glyphBounds[0],
        glyphs = font.glyphs
      delete font.glyphs
      Object.setPrototypeOf(font, {
        get glyphs() {
          return glyphs
        }
      })
    }
    expect(nativeRecoveryFigureCrop(...f.args)).toBeUndefined()
  }
)
it('rejects a native typed-path prototype change even when all bytes and visible bounds stay equal', () => {
  const f = anonymousNestedRecovery(),
    [page, , , , , c] = f.args,
    at = c.operators.fnArray.indexOf(OPS.constructPath),
    view = new Float32Array(c.operators.argsArray[at][1][0])
  c.operators.argsArray[at][1][0] = view
  const out = nativeRecoveryFigureCrop(...f.args)
  expect(out).toBeDefined()
  const rect = out.rect.map((x: number, i: number) => x + (i < 2 ? -2 : 2)),
    png = createCanvas(
      Math.ceil((rect[2] - rect[0]) * 4),
      Math.ceil((rect[3] - rect[1]) * 4)
    ).toBuffer('image/png')
  expect(nativeRecoveryFigurePngSafe(png, rect, page, out)).toBe(true)
  Object.setPrototypeOf(view, Object.create(Object.getPrototypeOf(view)))
  expect(nativeRecoveryFigurePngSafe(png, rect, page, out)).toBe(false)
})
it.each([true, undefined])(
  'requires an explicit horizontal-font proof for foreign punctuation: %s',
  (vertical) => {
    const f = anonymousNestedRecovery(),
      c = f.args[5]
    c.content.items[0].fontName = 'H'
    c.content.styles.H = { ascent: 0, descent: -0.2, vertical }
    c.operators.argsArray[c.operators.fnArray.indexOf(OPS.setFont)][0] = 'H'
    c.glyphBounds.push({ fontName: 'H', glyphs: [c.glyphBounds[0].glyphs[0]] })
    f.args[4][0] = tableTextToken(c.content.items[0], c.viewport, 0)
    expect(nativeRecoveryFigureCrop(...f.args)).toBeUndefined()
  }
)
it.each([true, undefined])(
  'keeps foreign compound packets within explicit horizontal font semantics: %s',
  (vertical) => {
    const f = anonymousForeignAccentRecovery(),
      [page, , , , tokens, c] = f.args
    c.content.styles.F.vertical = vertical
    expect(nativeForeignCompoundInkPacket(page, tokens, c, [tokens[1].sourceItem])).toBeUndefined()
  }
)

// Closed group clips preserve opaque drawing programs without interpreting
// their internal text. Only the outside labels and captions require glyph proof.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function pairedClippedGroups() {
  const width = 600,
    height = 500,
    operators = { fnArray: [] as number[], argsArray: [] as ReturnType<typeof JSON.parse>[] },
    items = [] as ReturnType<typeof JSON.parse>[],
    tokens = [] as ReturnType<typeof JSON.parse>[],
    graphicsBounds = [] as ReturnType<typeof JSON.parse>[],
    glyphs = [] as ReturnType<typeof JSON.parse>[],
    groups = [] as ReturnType<typeof JSON.parse>[],
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    add = (op: number, args: unknown): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    text = (str: string, x: number, baseline: number, opaque = false): void => {
      const fontName = opaque ? 'Opaque' : 'F'
      add(OPS.beginText, null)
      add(OPS.setFont, [fontName, 10])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
      add(OPS.showText, [
        [{ unicode: opaque ? '?' : str, fontChar: str, width: 500 * str.length, isInFont: true }]
      ])
      add(OPS.endText, null)
      const r = {
        str,
        dir: 'ltr',
        width: str.length * 5,
        height: 10,
        transform: [10, 0, 0, 10, x, height - baseline],
        fontName,
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(r)
      tokens.push(tableTextToken(r, viewport, 0))
      if (!opaque) glyphs.push({ fontChar: str, bounds: [0, -0.2, str.length * 0.5, 0.7] })
    },
    group = (left: number, top: number, right: number, bottom: number): void => {
      const arg = {
        matrix: null,
        bbox: [0, 0, right - left, bottom - top],
        smask: null,
        isolated: false,
        knockout: false
      }
      add(OPS.save, null)
      add(OPS.transform, [1, 0, 0, 1, left, height - bottom])
      const begin = operators.fnArray.length
      add(OPS.beginGroup, [arg])
      add(OPS.paintFormXObjectBegin, [null, null])
      for (let n = 0; n < 8; n++) {
        const x = 5 + n * 5,
          i = operators.fnArray.length
        add(OPS.constructPath, [
          OPS.fill,
          [[0, x, 5, 1, x + 3, 5, 1, x + 3, 8, 1, x, 8, 4]],
          [x, 5, x + 3, 8]
        ])
        graphicsBounds.push({
          operationIndex: i,
          kind: 'path',
          normalizedRect: [
            (left + x) / width,
            (bottom - 8) / height,
            (left + x + 3) / width,
            (bottom - 5) / height
          ]
        })
      }
      // This font and its Unicode interpretation are deliberately unavailable.
      text('opaque', 15, height - (bottom - top - 30), true)
      const native = items.at(-1)
      native.transform[4] += left
      native.transform[5] += height - bottom
      tokens[tokens.length - 1] = tableTextToken(native, viewport, 0)
      add(OPS.paintFormXObjectEnd, null)
      const end = operators.fnArray.length
      add(OPS.endGroup, [arg])
      add(OPS.restore, null)
      groups.push({ arg, begin, end })
    }
  group(100, 20, 300, 100)
  const foreignCaption = 'Figure 1: A separate native drawing.'
  text(foreignCaption, 100, 140)
  group(60, 220, 240, 360)
  text('(a) Alpha', 127.5, 375)
  group(320, 230, 500, 360)
  text('(b) Beta', 390, 375)
  const title = 'Figure 2: Paired native diagrams.',
    x = 280 - title.length * 2.5,
    caption = { page: 1, lines: [title], rect: [x, 390, x + title.length * 5, 400] }
  text(title, x, 400)
  const figure = { rect: [70, 225, 380, 375], caption, reason: 'no-unambiguous-adjacent-graphics' },
    page = { pageNumber: 1, width, height, rotation: 0, invalidGraphicsBounds: 0, graphicsBounds },
    context = {
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      operators,
      viewport,
      graphicsBounds,
      content: { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } },
      glyphBounds: [{ fontName: 'F', glyphs }]
    }
  return {
    page,
    figure,
    context,
    groups,
    tokens,
    captions: [caption],
    tables: [] as number[][],
    foreignCaption
  }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const clippedPair = (f: ReturnType<typeof pairedClippedGroups>) =>
  nativeRecoveryFigureCrop(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)

it('completes both clipped native groups and outside subcaptions without claiming internal text', () => {
  const f = pairedClippedGroups(),
    before = JSON.stringify(f),
    out = clippedPair(f)
  expect(out?.rect).toEqual([60, 220, 500, 377])
  expect(out?.sourceItems).toBeUndefined()
  expect(out?.issue).toBe(f.figure.reason)
  expect(JSON.stringify(f)).toBe(before)
})
it.each(['caption', 'outline', 'white', 'mask', 'lifecycle', 'table'])(
  'refuses incomplete clipped-group evidence: %s',
  (mode) => {
    const f = pairedClippedGroups(),
      o = f.context.operators
    if (mode === 'caption') f.captions.push({ ...f.figure.caption })
    if (mode === 'outline')
      f.context.glyphBounds[0].glyphs.find((g) => g.fontChar === f.foreignCaption).bounds[1] = -20
    if (mode === 'white') {
      const i = o.fnArray.lastIndexOf(OPS.beginText)
      o.fnArray.splice(i, 0, OPS.setFillRGBColor)
      o.argsArray.splice(i, 0, ['#ffffff'])
    }
    if (mode === 'mask') f.groups[1].arg.smask = {}
    if (mode === 'lifecycle') o.fnArray[f.groups[1].end - 1] = OPS.restore
    if (mode === 'table') f.tables.push([100, 250, 200, 270])
    expect(clippedPair(f)).toBeUndefined()
  }
)
it.each(['native-reference', 'owned-bound'])(
  'rebinds clipped-group evidence to the final PNG: %s',
  (mode) => {
    const f = pairedClippedGroups(),
      out = clippedPair(f)
    expect(out).toBeDefined()
    const rect = out.rect.map((x: number, i: number) => x + (i < 2 ? -4 / 3 : 4 / 3)),
      png = createCanvas(
        Math.ceil((rect[2] - rect[0]) * 4),
        Math.ceil((rect[3] - rect[1]) * 4)
      ).toBuffer('image/png')
    expect(nativeRecoveryFigurePngSafe(png, rect, f.page, out)).toBe(true)
    if (mode === 'native-reference') f.groups[1].arg.bbox = [...f.groups[1].arg.bbox]
    else out.formCropRaster.ownedRects[0][0] += 1
    expect(nativeRecoveryFigurePngSafe(png, rect, f.page, out)).toBe(false)
  }
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function largeSavePaintFixture(captionBefore = false, small = false) {
  const width = 400,
    height = 400,
    operators = { fnArray: [] as number[], argsArray: [] as ReturnType<typeof JSON.parse>[] },
    items = [] as ReturnType<typeof JSON.parse>[],
    tokens = [] as ReturnType<typeof JSON.parse>[],
    graphicsBounds = [] as ReturnType<typeof JSON.parse>[],
    viewport = {
      width,
      height,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, height],
      convertToViewportPoint: (x: number, y: number) => [x, height - y]
    },
    add = (op: number, args: unknown): void => {
      operators.fnArray.push(op)
      operators.argsArray.push(args)
    },
    text = (str: string, x: number, baseline: number, zero = false): void => {
      add(OPS.beginText, null)
      add(OPS.setFont, ['F', 10])
      add(OPS.setTextMatrix, [[1, 0, 0, 1, x, height - baseline]])
      add(OPS.showText, [
        [
          {
            unicode: str,
            fontChar: zero ? 'slash' : str === 'A' ? 'letter' : 'title',
            width: zero ? 0 : str.length * 500,
            isInFont: true
          }
        ]
      ])
      add(OPS.endText, null)
      const r = {
        str,
        dir: 'ltr',
        width: zero ? 0 : str.length * 5,
        height: 10,
        transform: [10, 0, 0, 10, x, height - baseline],
        fontName: 'F',
        hasEOL: true,
        sourceItem: { pageNumber: 1, index: items.length, text: str }
      }
      items.push(r)
      tokens.push(tableTextToken(r, viewport, 0))
    },
    shape = (x: number, y: number, w: number, h: number, paint = OPS.fill): void => {
      const b = height - y - h,
        i = operators.fnArray.length
      add(OPS.constructPath, [
        paint,
        [[0, x, b, 1, x + w, b, 1, x + w, b + h, 1, x, b + h, 4]],
        [x, b, x + w, b + h]
      ])
      graphicsBounds.push({
        operationIndex: i,
        kind: 'path',
        normalizedRect: [x / width, y / height, (x + w) / width, (y + h) / height]
      })
    }
  // One generator crosses the pre-existing 64 text-owner cap; this family
  // restores pixels without raising that cap or creating text-source owners.
  const title = 'Figure 1: Native drawing.',
    dy = captionBefore ? 50 : 0,
    caption = {
      page: 1,
      lines: [title],
      rect: [120, captionBefore ? 80 : 290, 120 + title.length * 5, captionBefore ? 90 : 300]
    }
  if (captionBefore) {
    add(OPS.save, null)
    add(OPS.setFillRGBColor, ['#f3f3f3'])
    add(OPS.setGState, [
      [
        ['ca', 1],
        ['BM', 'source-over']
      ]
    ])
    shape(0, 0, width, height)
    add(OPS.restore, null)
  }
  text('A', 70, 40)
  if (captionBefore) text(title, 120, 90)
  const start = operators.fnArray.length
  add(OPS.save, null)
  if (captionBefore) {
    add(OPS.eoClip, null)
    shape(70, 120, 260, 190, OPS.endPath)
  }
  shape(70, 70 + dy, 50, 30)
  shape(280, 80 + dy, 50, 30)
  shape(120, 240 + dy, 160, 20)
  for (let n = 0; n < (captionBefore || small ? 4 : 65); n++)
    text('A', 100 + (n % 10) * 18, 115 + Math.floor(n / 10) * 18 + dy)
  if (!captionBefore && !small) text('\u0338', 180, 225, true)
  const end = operators.fnArray.length
  add(OPS.restore, null)
  if (!captionBefore) text(title, 120, 300)
  const page = {
      pageNumber: 1,
      width,
      height,
      rotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds
    },
    figure = {
      rect: [80, 150 + dy, 300, 250 + dy],
      caption,
      reason: 'no-unambiguous-adjacent-graphics'
    },
    context = {
      pageNumber: 1,
      sourceSha256: 'a'.repeat(64),
      operators,
      viewport,
      graphicsBounds,
      content: { items, styles: { F: { ascent: 0.8, descent: -0.2, vertical: false } } },
      glyphBounds: [
        {
          fontName: 'F',
          glyphs: [
            { fontChar: 'letter', bounds: [0, -0.2, 0.5, 0.7] },
            { fontChar: 'title', bounds: [0, -0.2, title.length * 0.5, 0.7] },
            { fontChar: 'slash', bounds: [0, -0.2, 0.4, 0.7] }
          ]
        }
      ]
    }
  return {
    page,
    figure,
    context,
    tokens,
    captions: [caption],
    tables: [] as number[][],
    start,
    end,
    text
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const largeSavePixels = (f: ReturnType<typeof largeSavePaintFixture>) =>
  nativeRecoveryFigureCrop(f.page, f.figure, f.captions, f.tables, f.tokens, f.context)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function smallPixelSaveFixture(kind: 'normalized' | 'mixed-form') {
  const f = largeSavePaintFixture(false, true),
    o = f.context.operators
  if (kind === 'normalized') {
    const item = f.context.content.items[1],
      show = o.fnArray.findIndex((op, i) => i > f.start && op === OPS.showText)
    item.str = item.sourceItem.text = 'μ'
    f.tokens[1] = tableTextToken(item, f.context.viewport, 0)
    Object.assign(o.argsArray[show][0][0], { unicode: 'µ', fontChar: 'micro' })
    f.context.glyphBounds[0].glyphs.push({ fontChar: 'micro', bounds: [0, -0.2, 0.5, 0.7] })
    // A complete foreign font may omit ascent metrics. Keep its actual ink
    // and native advances; it never supplies a drawing-owned metric.
    f.context.content.items[0].fontName = 'Foreign'
    o.argsArray[o.fnArray.indexOf(OPS.setFont)][0] = 'Foreign'
    Object.assign(f.context.content.styles, {
      Foreign: { ascent: 0, descent: 0, vertical: false }
    })
    f.context.glyphBounds.push({
      fontName: 'Foreign',
      glyphs: [{ fontChar: 'letter', bounds: [0, -0.2, 0.5, 0.7] }]
    })
  } else {
    const insert = (i: number, ops: number[], args: unknown[]): void => {
      o.fnArray.splice(i, 0, ...ops)
      o.argsArray.splice(i, 0, ...args)
      for (const g of f.page.graphicsBounds)
        if (g.operationIndex >= i) g.operationIndex += ops.length
    }
    insert(f.end, [OPS.paintFormXObjectEnd], [null])
    insert(
      f.start + 1,
      [OPS.paintFormXObjectBegin, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
      [[null, [60, 130, 340, 340]], null, [50, 0, 0, 30, 70, 300], ['panel', 100, 60], null]
    )
    f.page.graphicsBounds.push({
      operationIndex: f.start + 4,
      kind: 'image',
      normalizedRect: [70 / 400, 70 / 400, 120 / 400, 100 / 400],
      imageHash: 'b'.repeat(64)
    })
  }
  return f
}

it.each(['normalized', 'mixed-form'] as const)(
  'recovers a small closed pixel drawing through the existing native evidence: %s',
  (kind) => {
    const f = smallPixelSaveFixture(kind),
      before = JSON.stringify(f),
      out = largeSavePixels(f)
    expect(out?.rect).toEqual([70, 70, 330, 260])
    expect(out?.sourceItems).toBeUndefined()
    expect(JSON.stringify(f)).toBe(before)
    const rect = [70 - 4 / 3, 70 - 4 / 3, 330 + 4 / 3, 260 + 4 / 3],
      png = createCanvas(
        Math.ceil((rect[2] - rect[0]) * 4),
        Math.ceil((rect[3] - rect[1]) * 4)
      ).toBuffer('image/png')
    expect(nativeRecoveryFigurePngSafe(png, rect, f.page, out)).toBe(true)
    f.context.glyphBounds[0].glyphs[0].bounds[2] += 0.01
    expect(nativeRecoveryFigurePngSafe(png, rect, f.page, out)).toBe(false)
  }
)

it.each(['normalization', 'owned-font', 'foreign-outline', 'table', 'foreign', 'complete'])(
  'refuses an unproved small normalized drawing: %s',
  (mode) => {
    const f = smallPixelSaveFixture('normalized')
    if (mode === 'normalization') f.context.content.items[1].str = 'x'
    if (mode === 'owned-font') f.context.content.styles.F.ascent = 0
    if (mode === 'foreign-outline') f.context.glyphBounds[1].glyphs = []
    if (mode === 'table') f.tables.push([100, 100, 200, 200])
    if (mode === 'foreign') f.text('A', 180, 220)
    if (mode === 'complete') f.figure.rect = [70, 70, 330, 260]
    expect(largeSavePixels(f)).toBeUndefined()
  }
)

it.each(['form-box', 'form-end', 'image-hash', 'opacity', 'table', 'foreign', 'complete'])(
  'refuses an unproved small mixed Form drawing: %s',
  (mode) => {
    const f = smallPixelSaveFixture('mixed-form'),
      o = f.context.operators
    if (mode === 'form-box') o.argsArray[o.fnArray.indexOf(OPS.paintFormXObjectBegin)][1] = null
    if (mode === 'form-end') o.fnArray[o.fnArray.indexOf(OPS.paintFormXObjectEnd)] = OPS.restore
    if (mode === 'image-hash') f.page.graphicsBounds.at(-1).imageHash = undefined
    if (mode === 'opacity') {
      o.fnArray.splice(f.start, 0, OPS.setGState)
      o.argsArray.splice(f.start, 0, [[['ca', 0.5]]])
    }
    if (mode === 'table') f.tables.push([100, 100, 200, 200])
    if (mode === 'foreign') f.text('A', 180, 220)
    if (mode === 'complete') f.figure.rect = [70, 70, 330, 260]
    expect(largeSavePixels(f)).toBeUndefined()
  }
)

// Reuse the tiny drawing; two additional closed roots repeat its whole frame.
// A redundant final line-to makes the inner clip unsupported by the ordinary
// packet. It still cannot enlarge the already established outer frame.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function sharedFrameFixture() {
  const f = largeSavePaintFixture(true),
    o = f.context.operators,
    frame = o.argsArray[f.start + 2],
    starts: number[] = [],
    add = (op: number, args: unknown): void => {
      o.fnArray.push(op)
      o.argsArray.push(args)
    }
  for (let n = 0; n < 2; n++) {
    starts.push(o.fnArray.length)
    add(OPS.save, null)
    add(OPS.eoClip, null)
    add(OPS.constructPath, frame)
    add(OPS.eoClip, null)
    const p = frame[1][0]
    add(OPS.constructPath, [OPS.endPath, [[...p.slice(0, 12), 1, p[1], p[2], 4]], frame[2]])
    f.text('A', 110 + n * 20, 170 + n * 10)
    add(OPS.restore, null)
  }
  return { ...f, starts }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const sharedPixels = (f: ReturnType<typeof sharedFrameFixture>, publishedRect = f.figure.rect) =>
  nativeSharedFramePixelCrop(
    f.page,
    f.figure,
    f.captions,
    f.tables,
    f.tokens,
    f.context,
    publishedRect
  )
it('preserves shared-frame pixels without promoting unsupported inner clips to Source authority', () => {
  const f = sharedFrameFixture(),
    before = JSON.stringify(f),
    plan = sharedPixels(f)
  expect(
    nativeClosedPrintedFaceInkPacket(
      f.page,
      f.tokens,
      f.context,
      f.tokens.map((t) => t.sourceItem),
      [0, 0, 400, 400]
    )
  ).toBeUndefined()
  expect(plan?.rect).toEqual([70 - 4 / 3, 120 - 4 / 3, 330 + 4 / 3, 310 + 4 / 3])
  expect(Object.keys(plan)).toEqual(['rect'])
  expect(JSON.stringify(f)).toBe(before)
  const png = createCanvas(
    Math.ceil((plan.rect[2] - plan.rect[0]) * 4),
    Math.ceil((plan.rect[3] - plan.rect[1]) * 4)
  ).toBuffer('image/png')
  expect(nativeSharedFramePixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
  expect(nativeSharedFramePixelPngSafe(structuredClone(plan), png, plan.rect, f.page)).toBe(false)
  expect(nativeSharedFramePixelPngSafe(plan, png, plan.rect, { ...f.page })).toBe(false)
})
it('retains an already complete published shared-frame crop', () => {
  const f = sharedFrameFixture()
  expect(sharedPixels(f, [65, 115, 335, 315])).toBeUndefined()
})
it.each([
  'foreign',
  'table',
  'caption',
  'lifecycle',
  'early-paint',
  'missing-font',
  'missing-source'
])('declines incomplete shared-frame evidence: %s', (mode) => {
  const f = sharedFrameFixture(),
    o = f.context.operators
  if (mode === 'foreign') f.text('A', 170, 200)
  if (mode === 'table') f.tables.push([100, 150, 150, 200])
  if (mode === 'caption') f.captions.push({ ...f.captions[0] })
  if (mode === 'lifecycle') o.fnArray.pop()
  if (mode === 'early-paint') {
    const i = f.starts[0] + 1
    o.fnArray.splice(i, 0, OPS.constructPath)
    o.argsArray.splice(i, 0, [
      OPS.fill,
      [[0, 80, 180, 1, 90, 180, 1, 90, 190, 1, 80, 190, 4]],
      [80, 180, 90, 190]
    ])
  }
  if (mode === 'missing-font') f.context.glyphBounds[0].glyphs = []
  if (mode === 'missing-source') f.context.content.items[2].sourceItem.text += ' absent'
  expect(sharedPixels(f)).toBeUndefined()
})
it.each(['typed-bytes', 'slot-reference', 'optional-slot', 'published', 'output', 'low-scale'])(
  'rechecks shared-frame inputs and actual PNG protection: %s',
  (mode) => {
    const f = sharedFrameFixture(),
      p = f.context.operators.argsArray[f.start + 2]
    p[1][0] = new Float32Array(p[1][0])
    const plan = sharedPixels(f),
      rect = [...plan.rect],
      png = createCanvas(
        Math.ceil((rect[2] - rect[0]) * 4),
        Math.ceil((rect[3] - rect[1]) * 4)
      ).toBuffer('image/png')
    expect(nativeSharedFramePixelPngSafe(plan, png, rect, f.page)).toBe(true)
    if (mode === 'typed-bytes') p[1][0][1] += 1
    if (mode === 'slot-reference') f.context.content = { ...f.context.content }
    if (mode === 'optional-slot') Object.assign(f.context, { skippedSpaceGlyphs: [] })
    if (mode === 'published') f.figure.rect[0] -= 1
    if (mode === 'output') plan.rect[0] -= 1
    const actual =
      mode === 'low-scale'
        ? createCanvas(
            Math.ceil((rect[2] - rect[0]) * 0.5),
            Math.ceil((rect[3] - rect[1]) * 0.5)
          ).toBuffer('image/png')
        : png
    expect(nativeSharedFramePixelPngSafe(plan, actual, rect, f.page)).toBe(false)
  }
)
// Three bars and three native ticks are sufficient to distinguish the mixed
// rejected table capture; no paper text, identifiers, or binary fixtures.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function barChartFixture() {
  const f = largeSavePaintFixture(true),
    o = f.context.operators
  o.fnArray.length =
    o.argsArray.length =
    f.context.content.items.length =
    f.tokens.length =
    f.page.graphicsBounds.length =
      0
  const add = (op: number, args: unknown): void => {
      o.fnArray.push(op)
      o.argsArray.push(args)
    },
    shape = (rect: number[], paint = OPS.fill): void => {
      const [x, y, r, bottom] = rect,
        b = 400 - bottom,
        t = 400 - y,
        i = o.fnArray.length
      add(OPS.constructPath, [paint, [[0, x, b, 1, r, b, 1, r, t, 1, x, t, 4]], [x, b, r, t]])
      f.page.graphicsBounds.push({
        operationIndex: i,
        kind: 'path',
        normalizedRect: rect.map((n) => n / 400)
      })
    },
    text = (s: string, x: number, y: number): void => {
      f.text(s, x, y)
      const show = o.argsArray[o.argsArray.length - 2][0][0]
      show.fontChar = s
      if (!f.context.glyphBounds[0].glyphs.some((g) => g.fontChar === s))
        f.context.glyphBounds[0].glyphs.push({
          fontChar: s,
          bounds: [0, -0.2, s.length * 0.5, 0.7]
        })
    }
  add(OPS.save, null)
  add(OPS.setFillRGBColor, ['#f3f3f3'])
  shape([0, 0, 400, 400])
  add(OPS.restore, null)
  text('Outside prose.', 40, 60)
  f.figure.caption.rect = [100, 80, 100 + f.figure.caption.lines[0].length * 5, 90]
  text(f.figure.caption.lines[0], 100, 90)
  add(OPS.save, null)
  add(OPS.eoClip, null)
  shape([40, 120, 360, 310], OPS.endPath)
  for (const x of [160, 220, 280]) {
    const i = o.fnArray.length
    add(OPS.constructPath, [OPS.stroke, [[0, x, 130, 1, x, 270]], [x, 130, x, 270]])
    f.page.graphicsBounds.push({
      operationIndex: i,
      kind: 'path',
      normalizedRect: [x / 400, 130 / 400, x / 400, 270 / 400]
    })
  }
  for (const [n, width] of [60, 100, 40].entries()) {
    const y = 145 + n * 40
    shape([160, y, 160 + width, y + 12])
    text(String.fromCharCode(65 + n) + ' group', 60, y + 9)
    text(['10', '17', '7'][n], 164 + width, y + 9)
  }
  for (const [n, x] of [160, 220, 280].entries())
    text(String(n * 10), x - String(n * 10).length * 2.5, 290)
  add(OPS.restore, null)
  f.figure.rect = [170, 130, 300, 300]
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const table = (rect: number[], indices: number[], blocked: boolean) => ({
      page: 1,
      cropRect: rect.map((n) => n * 1.5),
      region: rect.map((n) => n / 400),
      sourceViewport: { width: 600, height: 600, scale: 1.5 },
      issues: blocked ? ['span-conflicts-with-source-columns'] : [],
      captionIssue: 'no-adjacent-table-caption',
      cells: indices.map((index) => ({
        text: f.context.content.items[index].str,
        sourceItems: [f.context.content.items[index].sourceItem],
        sourceRects: [f.tokens[index].rect.map((n: number) => n * 1.5)]
      }))
    }),
    tables = [
      table([30, 45, 350, 245], [0, 1, 2, 3, 4, 5, 6, 7], true),
      table([30, 40, 350, 75], [0], false)
    ],
    options = {
      page: f.page,
      figure: f.figure,
      captions: f.captions,
      tables,
      tokens: f.tokens,
      context: f.context,
      publishedRect: [168 + 2 / 3, 128 + 2 / 3, 301 + 1 / 3, 301 + 1 / 3],
      competingRects: [] as number[][],
      recognizedTableRects: tables.map((t) => t.region.map((n) => n * 400))
    }
  return { f, options, text }
}
it('restores a native bar chart while retaining the rejected mixed table and every source', () => {
  const { options } = barChartFixture(),
    before = JSON.stringify(options),
    plan = nativeBarChartPixelCrop(options)
  expect(plan?.rect).toEqual([40 - 4 / 3, 120 - 4 / 3, 360 + 4 / 3, 310 + 4 / 3])
  expect(Object.keys(plan)).toEqual(['rect'])
  expect(JSON.stringify(options)).toBe(before)
  const rect = plan.rect,
    png = createCanvas(
      Math.ceil((rect[2] - rect[0]) * 4),
      Math.ceil((rect[3] - rect[1]) * 4)
    ).toBuffer('image/png')
  expect(nativeBarChartPixelPngSafe(plan, png, rect, options.page)).toBe(true)
  expect(nativeBarChartPixelPngSafe(structuredClone(plan), png, rect, options.page)).toBe(false)
})
it.each([
  'reliable-table',
  'source-text',
  'source-rect',
  'unknown-recognized',
  'ambiguous-recognized',
  'external-competitor',
  'unmatched-table',
  'tick',
  'complete-published'
])('retains the physical-table veto unless every native bar role closes: %s', (mode) => {
  const { options } = barChartFixture()
  if (mode === 'reliable-table') options.tables[0].issues = []
  if (mode === 'source-text')
    options.tables[0].cells[0].sourceItems = [{ pageNumber: 1, index: 0, text: 'Other prose.' }]
  if (mode === 'source-rect') options.tables[0].cells[0].sourceRects[0][0] += 1
  if (mode === 'unknown-recognized') options.recognizedTableRects.push([150, 150, 300, 280])
  if (mode === 'ambiguous-recognized') options.tables.push({ ...options.tables[0] })
  if (mode === 'external-competitor')
    options.competingRects.push([...options.recognizedTableRects[0]])
  if (mode === 'unmatched-table')
    options.tables.push({ ...options.tables[1], region: [0.3, 0.3, 0.8, 0.8] })
  if (mode === 'tick') options.context.content.items.at(-1).sourceItem.text = 'Other tick'
  if (mode === 'complete-published') options.publishedRect = [35, 115, 365, 315]
  expect(nativeBarChartPixelCrop(options)).toBeUndefined()
})
it.each(['final-issues', 'cell-rect', 'source-slot', 'recognized-slot', 'png-rect', 'low-scale'])(
  'rechecks final tables and the exact native bar plan after rendering: %s',
  (mode) => {
    const { options } = barChartFixture(),
      plan = nativeBarChartPixelCrop(options),
      rect = [...plan.rect],
      png = createCanvas(
        Math.ceil((rect[2] - rect[0]) * 4),
        Math.ceil((rect[3] - rect[1]) * 4)
      ).toBuffer('image/png')
    expect(nativeBarChartPixelPngSafe(plan, png, rect, options.page)).toBe(true)
    if (mode === 'final-issues') options.tables[0].issues = []
    if (mode === 'cell-rect') options.tables[0].cells[0].sourceRects[0][0] += 0.1
    if (mode === 'source-slot') options.context.content = { ...options.context.content }
    if (mode === 'recognized-slot')
      options.recognizedTableRects = options.recognizedTableRects.map((r) => [...r])
    if (mode === 'png-rect') rect[3] += 0.01
    const actual =
      mode === 'low-scale'
        ? createCanvas(
            Math.ceil((rect[2] - rect[0]) * 0.5),
            Math.ceil((rect[3] - rect[1]) * 0.5)
          ).toBuffer('image/png')
        : png
    expect(nativeBarChartPixelPngSafe(plan, actual, rect, options.page)).toBe(false)
  }
)
it('restores fragmented closed drawing pixels without raising the literal-owner limit', () => {
  const f = largeSavePaintFixture(),
    before = JSON.stringify(f),
    out = largeSavePixels(f)
  expect(out?.rect).toEqual([70, 70, 330, 260])
  expect(out?.sourceItems).toBeUndefined()
  expect(f.context.content.items.find((r) => r.str === '\u0338')?.width).toBe(0)
  expect(
    nativeClosedProgramInkPacket(
      f.page,
      f.tokens,
      f.context,
      f.tokens.slice(1, 66).map((t) => t.sourceItem)
    )
  ).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it('keeps ancillary page furniture outside the native drawing proof', () => {
  const f = largeSavePaintFixture()
  Object.assign(f.context, {
    runningHeadWitness: {
      witnessViewport: new (class {
        width = 400
      })()
    }
  })
  expect(largeSavePixels(f)?.rect).toEqual([70, 70, 330, 260])
  f.context.glyphBounds[0].glyphs = []
  expect(largeSavePixels(f)).toBeUndefined()
})
it.each(['padding', 'descent'])(
  'retains a complete published crop when only drawing envelopes are wider: %s',
  (mode) => {
    const f = largeSavePaintFixture()
    f.figure.rect = [70, 70, 330, mode === 'descent' ? 223 : 259]
    if (mode === 'descent') {
      f.context.content.styles.F.descent = -0.5
      f.context.glyphBounds[0].glyphs[0].bounds[1] = -0.5
      for (const token of f.tokens) token.fontDescent = -0.5
    }
    expect(largeSavePixels(f)).toBeUndefined()
  }
)
it.each(['caption', 'font', 'white', 'lifecycle', 'table', 'foreign', 'zero-advance'])(
  'refuses incomplete large save pixel evidence: %s',
  (mode) => {
    const f = largeSavePaintFixture(),
      o = f.context.operators
    if (mode === 'caption') f.captions.push({ ...f.figure.caption })
    if (mode === 'font') f.context.content.styles.F.ascent = 0
    if (mode === 'white') {
      const i = o.fnArray.findIndex((op, n) => n > f.start && op === OPS.beginText)
      o.fnArray.splice(i, 0, OPS.setFillRGBColor)
      o.argsArray.splice(i, 0, ['#ffffff'])
    }
    if (mode === 'lifecycle') o.fnArray.splice(f.end, 1)
    if (mode === 'table') f.tables.push([100, 150, 150, 170])
    if (mode === 'foreign') f.text('A', 180, 220)
    if (mode === 'zero-advance') f.context.content.items.find((r) => r.str === '\u0338').width = 1
    expect(largeSavePixels(f)).toBeUndefined()
  }
)
it.each([
  'native-reference',
  'read-slot-reference',
  'optional-slot-absence',
  'slot-descriptor',
  'output-bound'
])('rebinds large save pixels at the final PNG: %s', (mode) => {
  const f = largeSavePaintFixture(),
    out = largeSavePixels(f)
  expect(out).toBeDefined()
  const rect = out.rect.map((v: number, i: number) => v + (i < 2 ? -4 / 3 : 4 / 3)),
    png = createCanvas(
      Math.ceil((rect[2] - rect[0]) * 4),
      Math.ceil((rect[3] - rect[1]) * 4)
    ).toBuffer('image/png')
  expect(nativeRecoveryFigurePngSafe(png, rect, f.page, out)).toBe(true)
  if (mode === 'native-reference')
    f.context.glyphBounds[0].glyphs[0].bounds = [...f.context.glyphBounds[0].glyphs[0].bounds]
  if (mode === 'read-slot-reference') f.context.content = { ...f.context.content }
  if (mode === 'optional-slot-absence') Object.assign(f.context, { partialFontGlyphBounds: [] })
  if (mode === 'slot-descriptor')
    Object.defineProperty(f.context, 'glyphBounds', {
      ...Object.getOwnPropertyDescriptor(f.context, 'glyphBounds'),
      writable: false
    })
  if (mode === 'output-bound') out.formCropRaster.ownedRects[0][0] -= 1
  expect(nativeRecoveryFigurePngSafe(png, rect, f.page, out)).toBe(false)
})

it('keeps a complete chart after its caption while treating only the first opaque page fill as backdrop', () => {
  const f = largeSavePaintFixture(true),
    before = JSON.stringify(f),
    out = largeSavePixels(f)
  expect(out?.rect).toEqual([70, 120, 330, 310])
  expect(out?.sourceItems).toBeUndefined()
  expect(f.tokens.length).toBeLessThan(64)
  expect(JSON.stringify(f)).toBe(before)
})
it('retains a complete original crop when only the declared chart frame is wider', () => {
  const f = largeSavePaintFixture(true),
    o = f.context.operators,
    rectangles = [
      [80, 130, 120, 160],
      [270, 140, 320, 170],
      [120, 280, 280, 300]
    ],
    bounds = f.context.graphicsBounds.filter((g) => g.operationIndex > f.start + 2)
  for (const [n, g] of bounds.entries()) {
    const [x0, y0, x1, y1] = rectangles[n],
      b = f.page.height - y1,
      t = f.page.height - y0
    o.argsArray[g.operationIndex] = [
      OPS.fill,
      [[0, x0, b, 1, x1, b, 1, x1, t, 1, x0, t, 4]],
      [x0, b, x1, t]
    ]
    g.normalizedRect = [x0 / 400, y0 / 400, x1 / 400, y1 / 400]
  }
  f.figure.rect = [78, 128, 322, 302]
  expect(largeSavePixels(f)).toBeUndefined()
})
it.each([
  'background-shape',
  'background-opacity',
  'background-stroke',
  'frame',
  'caption',
  'font',
  'table'
])('refuses incomplete caption-before-chart evidence: %s', (mode) => {
  const f = largeSavePaintFixture(true),
    o = f.context.operators,
    background = o.argsArray.find((a, i) => o.fnArray[i] === OPS.constructPath && a[0] === OPS.fill)
  if (mode === 'background-shape') background[1][0][12] = 1
  if (mode === 'background-opacity') o.argsArray[o.fnArray.indexOf(OPS.setGState)][0][0][1] = 0.5
  if (mode === 'background-stroke') background[0] = OPS.stroke
  if (mode === 'frame') o.fnArray[f.start + 1] = OPS.dependency
  if (mode === 'caption') f.captions.push({ ...f.figure.caption })
  if (mode === 'font') f.context.glyphBounds[0].glyphs = []
  if (mode === 'table') f.tables.push([100, 200, 120, 220])
  expect(largeSavePixels(f)).toBeUndefined()
})
it.each(['backdrop', 'frame'])(
  'rechecks caption-before-chart native geometry at final publication: %s',
  (mode) => {
    const f = largeSavePaintFixture(true),
      out = largeSavePixels(f)
    expect(out).toBeDefined()
    const rect = out.rect.map((v: number, i: number) => v + (i < 2 ? -4 / 3 : 4 / 3)),
      png = createCanvas(
        Math.ceil((rect[2] - rect[0]) * 4),
        Math.ceil((rect[3] - rect[1]) * 4)
      ).toBuffer('image/png')
    expect(nativeRecoveryFigurePngSafe(png, rect, f.page, out)).toBe(true)
    const i =
      mode === 'frame' ? f.start + 2 : f.context.operators.fnArray.indexOf(OPS.constructPath)
    f.context.operators.argsArray[i][1][0] = [...f.context.operators.argsArray[i][1][0]]
    expect(nativeRecoveryFigurePngSafe(png, rect, f.page, out)).toBe(false)
  }
)

// Complete generated cross-page sentence evidence; no real paper text or identity.
const { anonymousCertifiedPicture: crossSentencePicture } = await import(
  pathToFileURL(resolve('test/fixtures/figure-recovery-program.mjs')).href
)
const crossSentenceApi = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function crossPageSentenceFixture(mode = '') {
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const make = (number: number) => {
    const f = crossSentencePicture([], undefined, false, false, [])
    for (const a of [
      f.context.operators.fnArray,
      f.context.operators.argsArray,
      f.context.content.items,
      f.context.glyphBounds[0].glyphs,
      f.page.graphicsBounds,
      f.tokens
    ])
      a.length = 0
    f.page.pageNumber = number
    f.context.pageNumber = number
    const line = (text: string, x: number, y: number, justified = true): void => {
      f.text(text, x, y)
      const raw = f.context.content.items.at(-1)
      raw.sourceItem.pageNumber = number
      if (justified) {
        raw.width = 300
        f.context.operators.argsArray.at(-2)[0][0].width = 30000
        f.context.glyphBounds[0].glyphs.at(-1).bounds[2] = 30
      }
    }
    const finish = (): void => {
      f.page.lines = f.context.content.items.map((r: ReturnType<typeof JSON.parse>) => ({
        text: r.str,
        x: r.transform[4],
        y: 400 - r.transform[5] - r.height,
        width: r.width,
        height: r.height,
        fontSize: r.height
      }))
      f.tokens = f.context.content.items.map((r: ReturnType<typeof JSON.parse>) =>
        tableTextToken(r, f.context.viewport, 0)
      )
    }
    return { ...f, line, finish }
  }
  const prior = make(1)
  prior.line('The ordinary measured response is discussed in the text', 40, 335)
  prior.line(
    mode === 'closed-prior'
      ? 'The complete measured result is shown here.'
      : 'and the complete measured result is shown in',
    40,
    349
  )
  if (mode === 'later-body')
    prior.line('A separate complete ordinary record remains below', 40, 370)
  prior.finish()
  const f = make(2)
  f.shape(40, 55, 300, 125)
  const title = 'Figure 8. A separate complete native response.'
  f.line(title, 40, 220)
  if (mode === 'intervening-body')
    f.line('A separate complete ordinary sentence precedes this reference.', 40, 245)
  const lines = [
    'figure 7. The complete measured response is stable,',
    'all native observations remain in their original order,',
    'and this complete physical record closes here.'
  ]
  lines.forEach((s, i) => f.line(s, 40, 270 + i * 14))
  f.line('A separate ordinary paragraph follows with full evidence.', 50, 330, false)
  if (mode === 'foreign-ink') f.line('Foreign note', 60, 268, false)
  if (mode === 'extra-graphic') f.shape(35, 51, 3, 20)
  f.finish()
  const caption = { page: 2, lines, rect: [40, 260, 340, 298] }
  const genuineCaption = { page: 2, lines: [title], rect: [40, 210, 340, 220] }
  const figure = {
    id: 'ordinary-reference',
    page: 2,
    caption,
    region: [35, 50, 345, 185].map((n) => n / 400),
    thumbnail: 'thumbnails/ordinary-reference.png'
  }
  const genuine = {
    id: 'genuine-view',
    page: 2,
    caption: genuineCaption,
    region: [40, 55, 340, 180].map((n) => n / 400),
    thumbnail: 'thumbnails/genuine-view.png',
    graphicsCount: 1
  }
  const outline = new Map(
    [...prior.context.glyphBounds[0].glyphs, ...f.context.glyphBounds[0].glyphs].map(
      (g: ReturnType<typeof JSON.parse>) => [g.fontChar, g.bounds]
    )
  )
  const face = {
    loadedName: 'F',
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    ascent: 0.7,
    descent: -0.1,
    missingFile: false,
    isType3Font: false,
    isInvalidPDFjsFont: false,
    vertical: false,
    disableFontFace: true,
    getPathGenerator: (_common: unknown, c: string) => ({ getBounds: () => outline.get(c) })
  }
  if (mode === 'getter-matrix')
    Object.defineProperty(face, 'fontMatrix', {
      configurable: true,
      enumerable: true,
      get: () => [0.001, 0, 0, 0.001, 0, 0]
    })
  const common: { get: (name: string) => typeof face } = { get: () => face },
    nativePage = { commonObjs: common }
  const previous = {
    pageGeometry: prior.page,
    context: prior.context,
    nativeContent: prior.context.content,
    nativePage
  }
  const currentFrame = {
    pageGeometry: f.page,
    context: f.context,
    nativeContent: f.context.content,
    nativePage
  }
  if (mode === 'different-native-font') {
    const a = { ...face, loadedName: 'actual-prior' },
      b = { ...face, loadedName: 'actual-current' }
    common.get = (name: string) => (name === 'actual-prior' ? a : b)
    previous.nativeContent = {
      ...prior.context.content,
      items: prior.context.content.items.map((r: ReturnType<typeof JSON.parse>) => ({
        ...r,
        fontName: 'actual-prior'
      })),
      styles: { 'actual-prior': prior.context.content.styles.F }
    }
    currentFrame.nativeContent = {
      ...f.context.content,
      items: f.context.content.items.map((r: ReturnType<typeof JSON.parse>) => ({
        ...r,
        fontName: 'actual-current'
      })),
      styles: { 'actual-current': f.context.content.styles.F }
    }
  }
  if (mode === 'wrong-pdf') prior.context.sourceSha256 = 'b'.repeat(64)
  if (mode === 'unknown-font') delete prior.context.content.styles.F.ascent
  const args = [
    figure,
    f.page,
    [genuineCaption, caption],
    [genuine, figure],
    f.context,
    previous,
    currentFrame
  ]
  return { prior, f, figure, genuine, previous, args }
}
it('declines the complete cross-page sentence in old APIs and proves only optional metadata in its dedicated purpose', () => {
  const f = crossPageSentenceFixture(),
    before = JSON.stringify(f)
  expect(
    crossSentenceApi.nativeDuplicateOrdinaryReferenceMetadata(...f.args.slice(0, 5))
  ).toBeUndefined()
  expect(crossSentenceApi.nativeCrossPageOrdinaryBodyReferenceMetadata(...f.args)).toBeUndefined()
  const out = crossSentenceApi.nativeCrossPageSentenceReferenceMetadata?.(...f.args)
  expect(out).toBeDefined()
  expect(out.current()).toBe(true)
  expect(out.caption).toBe(f.figure.caption)
  expect(out.withdrawThumbnail).toBe(f.figure.thumbnail)
  expect(out.sourceItems).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
it.each([
  'closed-prior',
  'later-body',
  'wrong-pdf',
  'unknown-font',
  'foreign-ink',
  'extra-graphic',
  'intervening-body',
  'different-native-font'
])('keeps an unproved cross-page reference with %s', (mode) => {
  const f = crossPageSentenceFixture(mode)
  expect(crossSentenceApi.nativeCrossPageSentenceReferenceMetadata?.(...f.args)).toBeUndefined()
})
it('rechecks both sentence frames and their original glyphs at metadata publication', () => {
  const f = crossPageSentenceFixture(),
    out = crossSentenceApi.nativeCrossPageSentenceReferenceMetadata?.(...f.args)
  expect(out?.current()).toBe(true)
  const context = f.previous.context
  f.previous.context = { ...context }
  expect(out.current()).toBe(false)
  f.previous.context = context
  expect(out.current()).toBe(true)
  const nativeContent = f.previous.nativeContent
  f.previous.nativeContent = { ...nativeContent }
  expect(out.current()).toBe(false)
  f.previous.nativeContent = nativeContent
  const nativePage = f.previous.nativePage
  f.previous.nativePage = { ...nativePage }
  expect(out.current()).toBe(false)
  f.previous.nativePage = nativePage
  const common = nativePage.commonObjs,
    get = common.get
  common.get = (name: string) => get(name)
  expect(out.current()).toBe(false)
  common.get = get
  expect(out.current()).toBe(true)
  const face = f.previous.nativePage.commonObjs.get('F')
  const matrixDescriptor = Object.getOwnPropertyDescriptor(face, 'fontMatrix')!
  Object.defineProperty(face, 'fontMatrix', { ...matrixDescriptor, value: [...face.fontMatrix] })
  expect(out.current()).toBe(false)
  Object.defineProperty(face, 'fontMatrix', matrixDescriptor)
  expect(out.current()).toBe(true)
  context.glyphBounds[0].glyphs[0].bounds[2] += 1
  expect(out.current()).toBe(false)
})

it('keeps the pinned computed matrix getter by value while rejecting a changed getter descriptor', () => {
  const f = crossPageSentenceFixture('getter-matrix'),
    out = crossSentenceApi.nativeCrossPageSentenceReferenceMetadata(...f.args)
  expect(out?.current()).toBe(true)
  const face = f.previous.nativePage.commonObjs.get('F'),
    descriptor = Object.getOwnPropertyDescriptor(face, 'fontMatrix')!
  expect(face.fontMatrix).not.toBe(face.fontMatrix)
  Object.defineProperty(face, 'fontMatrix', {
    ...descriptor,
    get: () => [0.001, 0, 0, 0.001, 0, 0]
  })
  expect(out.current()).toBe(false)
})
