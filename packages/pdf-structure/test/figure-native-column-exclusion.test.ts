/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { anonymousNonisolatedColumnExclusion } from './fixtures/nonisolated-column-exclusion.mjs'
import { anonymousExteriorZeroOutline } from './fixtures/exterior-zero-outline.mjs'
import { resolve } from './paths'

const resource = (name: string) => import(pathToFileURL(resolve(`resources/${name}.mjs`)).href)
const group = await resource('literature-pdf-figure-native-group')
const profile = await resource('literature-pdf-native-figure-recovery-profile')
const { associateFigures } = await resource('literature-pdf-association')
const { collectTableRules } = await resource('literature-pdf-graphics')
const { tableTextToken } = await resource('literature-pdf-orientation')
const { matchNativeFigureRenderContext } = await resource('literature-pdf-render-bounds')
const { renderPdfCrop } = await resource('literature-pdf-crop')

async function inspect(fault = '', accepted = true) {
  const f = fault.startsWith('zero-outline')
    ? await anonymousExteriorZeroOutline(
        fault === 'zero-outline-crossing' ? 'crossing-outline' : ''
      )
    : await anonymousNonisolatedColumnExclusion(fault)
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
    const document = await alternate.promise
    const nativePage = await document.getPage(1)
    const pageContent = await nativePage.getTextContent()
    const operators = await nativePage.getOperatorList()
    const viewport = nativePage.getViewport({ scale: 1 })
    const context = matchNativeFigureRenderContext(
      f.context,
      1,
      pageContent,
      viewport,
      f.page.graphicsBounds,
      f.context.sourceSha256
    )
    expect(context).toBeTruthy()
    expect(pageContent.items[0].fontName).not.toBe(context.content.items[0].fontName)
    const tokens = pageContent.items
      .map((item, index) => ({
        ...item,
        sourceItem: { pageNumber: 1, index, text: 'str' in item ? item.str : '' }
      }))
      .filter((item) => item.str?.trim())
      .map((item) => tableTextToken(item, viewport, 0))
    const rules = collectTableRules(operators, viewport)
    const figures = associateFigures(f.page, f.captions, [], rules, [], tokens, context)
    expect(figures).toHaveLength(1)
    const figure = figures[0]
    if (fault !== 'empty-canvas') expect(figure.rect[0]).toBeLessThan(300)
    const narrative = tokens.find((t: { text: string }) => t.text.startsWith('Ordinary narrative'))
    expect(narrative).toBeTruthy()
    if (fault === 'source-width') context.content.items[0].width += 0.1
    if (fault === 'zero-advance') context.content.items[0].width = 0
    if (fault === 'missing-outline') context.glyphBounds[0].glyphs = []
    if (fault.startsWith('zero-outline')) {
      const record = context.content.items.find((r: { str: string }) => r.str === '\u0338')
      expect(record.width).toBe(0)
      const glyphOperation = context.operators.fnArray.findIndex(
        (op: number, i: number) =>
          op === OPS.showText &&
          context.operators.argsArray[i][0].some(
            (g: { unicode?: string }) => g?.unicode === '\u0338'
          )
      )
      const glyph = context.operators.argsArray[glyphOperation][0].find(
        (g: { unicode?: string }) => g?.unicode === '\u0338'
      )
      expect(glyph.width).toBe(0)
      const font = context.glyphBounds.find(
        (r: { fontName: string }) => r.fontName === record.fontName
      )
      const outline = font.glyphs.find((g: { fontChar: string }) => g.fontChar === glyph.fontChar)
      expect(outline.bounds[2]).toBeGreaterThan(outline.bounds[0])
      if (fault === 'zero-outline-missing') font.glyphs = []
      if (fault === 'zero-outline-nonzero-glyph') glyph.width = 1
    }
    if (fault === 'live-path') {
      const index = operators.fnArray.indexOf(OPS.constructPath)
      operators.argsArray[index][1][0][1] += 1
    }
    if (fault === 'live-font')
      operators.argsArray[operators.fnArray.indexOf(OPS.setFont)][0] = 'unbound-font'
    if (fault === 'live-font-size')
      operators.argsArray[operators.fnArray.indexOf(OPS.setFont)][1] += 0.1
    if (fault === 'live-glyph') {
      const index = operators.fnArray.indexOf(OPS.showText)
      operators.argsArray[index][0].find(
        (g: { unicode?: string }) => g && typeof g.unicode === 'string'
      ).unicode = 'Changed'
    }
    if (fault === 'unused-opaque-witness' || fault === 'stale-opaque-witness') {
      context.runningHeadWitness = { witnessViewport: nativePage.getViewport({ scale: 1 }) }
    }
    const originalProfile = profile.createNativeNonisolatedGroupCropProfile(f.page, tokens, context)
    expect(originalProfile).toBeUndefined()
    const exclusion = profile.createNativeNonisolatedExclusionCropProfile?.(f.page, tokens, context)
    if (fault === 'stale-opaque-witness') context.runningHeadWitness = {}
    const plan = group.nativeNonisolatedGroupPixelCrop(
      f.page,
      figure,
      f.captions,
      [],
      tokens,
      context,
      figure.rect,
      { nativePage, pageContent, operators },
      originalProfile,
      exclusion
    )
    if (!accepted) {
      expect(plan).toBeUndefined()
      return
    }
    expect(plan).toBeTruthy()
    expect(plan.rect[0]).toBeGreaterThan(300)
    expect(plan.rect[1]).toBeLessThan(240)
    expect(plan.rect[2]).toBeGreaterThan(560)
    expect(plan.rect[3]).toBeGreaterThan(400)
    const png = await renderPdfCrop(nativePage, plan.rect, 0)
    expect(group.nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    const oldPng = await renderPdfCrop(nativePage, figure.rect, 0)
    expect(group.nativeRenderedGroupPixelPngSafe(plan, oldPng, figure.rect, f.page)).toBe(false)
    expect(plan.sourceItems).toBeUndefined()
    expect(plan.nativeBody).toBeUndefined()
  } finally {
    await alternate.destroy()
    await f.cleanup()
  }
}
it.each([
  '',
  'unused-opaque-witness',
  'outlined-only',
  'post-caption-body',
  'shared-body',
  'zero-outline',
  'inline-italic',
  'section-roman',
  'section-child',
  'equation-pair',
  'inline-emphasis',
  'inline-parenthetical',
  'citation-list',
  'citation-range',
  'citation-line-end',
  'definition-complete',
  'argument-complete',
  'math-citation-complete',
  'wrapped-citation-complete'
])(
  'excludes exterior narrative through actual two-document native crop proof: %s',
  async (fault) => {
    await inspect(fault)
  }
)
it.each([
  'three-line-legend',
  'Task',
  'Legend',
  'Prediction',
  'Target',
  'Panel',
  'external-marker',
  'crossing-path',
  'wide-path',
  'source-width',
  'zero-advance',
  'missing-outline',
  'live-path',
  'live-font',
  'live-font-size',
  'live-glyph',
  'stale-opaque-witness',
  'empty-canvas',
  'between-group-caption',
  'ambiguous-row',
  'gutter-annotation',
  'zero-outline-crossing',
  'zero-outline-missing',
  'zero-outline-nonzero-glyph',
  'shared-no-font',
  'shared-no-position',
  'shared-nonbody',
  'italic-task',
  'split-task',
  'split-legend',
  'section-orphan-roman',
  'section-orphan-child',
  'section-panel',
  'equation-no-relation',
  'equation-misaligned',
  'equation-orphan',
  'equation-letter',
  'isolated-emphasis',
  'standalone-parenthetical',
  'citation-letter',
  'citation-standalone',
  'definition-missing',
  'definition-reordered',
  'definition-no-relation',
  'definition-unbracketed',
  'definition-annotation',
  'argument-standalone',
  'argument-wide-gap',
  'argument-no-relation',
  'math-citation-standalone',
  'math-citation-no-relation',
  'math-citation-annotation',
  'wrapped-citation-no-relation'
])(
  'retains the original crop when the complete native exclusion is unproved: %s',
  async (fault) => {
    await inspect(fault, false)
  }
)
