import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
const {
  anonymousNestedRecovery,
  anonymousInertLeadingRecovery,
  anonymousForeignAccentRecovery,
  anonymousSubscriptRecovery
} = await import(pathToFileURL(resolve('test/fixtures/figure-recovery-program.mjs')).href)
const { nativeRecoveryFigureCrop, nativeRecoveryFigurePngSafe } = await import(
  pathToFileURL(resolve('resources/literature-pdf-figure-native-whole-paint-scope.mjs')).href
)
const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { createCanvas } = await import('@napi-rs/canvas')
const { nativeClosedProgramInkPacket, nativeForeignCompoundInkPacket } = await import(
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
