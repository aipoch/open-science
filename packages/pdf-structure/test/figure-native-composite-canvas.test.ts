/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { anonymousNonisolatedCompositeCanvas } from './fixtures/nonisolated-composite-canvas.mjs'
import { resolve } from './paths'

const resource = (name: string) => import(pathToFileURL(resolve(`resources/${name}.mjs`)).href)
const group = await resource('literature-pdf-figure-native-group')
const profile = await resource('literature-pdf-native-figure-recovery-profile')
const { tableTextToken } = await resource('literature-pdf-orientation')
const { matchNativeFigureRenderContext } = await resource('literature-pdf-render-bounds')
const { renderPdfCrop } = await resource('literature-pdf-crop')

async function inspectComposite(fault = '', accepted = true) {
  const f = await anonymousNonisolatedCompositeCanvas(
    fault === 'mixed-source-claim' ? 'mixed-node' : fault
  )
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
    const groups = context.operators.fnArray.flatMap((op: number, index: number) =>
      op === OPS.beginGroup ? [context.operators.argsArray[index][0]] : []
    )
    if (!['excess-children', 'four-children', 'soft-mask'].includes(fault))
      expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({ isolated: false, knockout: false, smask: null, matrix: null })
    if (fault !== 'nonisolated-child')
      expect(groups.slice(1).every((value: { isolated: boolean }) => value.isolated)).toBe(true)
    const tokens = pageContent.items
      .map((item, index) => ({
        ...item,
        sourceItem: { pageNumber: 1, index, text: 'str' in item ? item.str : '' }
      }))
      .filter((item) => item.str?.trim())
      .map((item) => tableTextToken(item, viewport, 0))
    const originalProfile = profile.createNativeNonisolatedGroupCropProfile(f.page, tokens, context)
    expect(originalProfile).toBeUndefined()
    let composite = profile.createNativeCompositeGroupCropProfile?.(f.page, tokens, context)
    if (fault === 'mixed-source-claim') {
      const first = pageContent.items.findIndex((item) => 'str' in item && item.str === '2'),
        second = pageContent.items.findIndex((item) => 'str' in item && item.str === '0')
      expect(first).toBeGreaterThanOrEqual(0)
      expect(second).toBe(first + 1)
      pageContent.items[first].str = '20'
      pageContent.items.splice(second, 1)
    }
    if (fault === 'stale-operators') {
      const i = context.operators.fnArray.indexOf(OPS.setLineWidth)
      expect(i).toBeGreaterThanOrEqual(0)
      context.operators.argsArray[i][0] += 0.000001
    }
    if (fault === 'stale-caption') f.figure.caption.lines[0] += ' altered'
    if (fault === 'missing-profile') composite = undefined
    if (fault === 'forged-profile') composite = {}
    if (fault === 'wrong-family') f.figure.reason = 'unsupported-family'
    if (fault === 'missing-family') delete f.figure.reason
    const plan = group.nativeNonisolatedGroupPixelCrop(
      f.page,
      f.figure,
      f.captions,
      fault === 'competing-table' ? [f.figure.rect] : [],
      tokens,
      context,
      f.figure.rect,
      { nativePage, pageContent, operators },
      originalProfile,
      undefined,
      composite
    )
    if (!accepted) {
      expect(plan).toBeUndefined()
      return
    }
    expect(plan).toBeDefined()
    expect(plan.rect[0]).toBeLessThan(60)
    expect(plan.rect[1]).toBeLessThan(80)
    expect(plan.rect[2]).toBeGreaterThan(540)
    expect(plan.rect[3]).toBeGreaterThan(600)
    const png = await renderPdfCrop(nativePage, plan.rect, 0)
    expect(group.nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, f.page)).toBe(true)
    if (fault === 'changed-output') {
      plan.rect[0] += 0.000001
      expect(group.nativeRenderedGroupPixelPngSafe(plan, png, plan.rect, f.page)).toBe(false)
    }
    expect(plan.sourceItems).toBeUndefined()
    expect(plan.nativeBody).toBeUndefined()
  } finally {
    await alternate.destroy()
    await f.cleanup()
  }
}
it.each([
  '',
  'overlap',
  'four-children',
  'outline-only',
  'normal-alpha',
  'root-numeric',
  'changed-output'
])(
  'preserves complete isolated panels through the actual two-document canvas proof: %s',
  async (fault) => {
    await inspectComposite(fault)
  }
)
it.each([
  'nonisolated-child',
  'knockout-child',
  'sheared-child',
  'foreign-glyph',
  'blend',
  'soft-mask',
  'excess-children',
  'stale-operators',
  'stale-caption',
  'missing-profile',
  'forged-profile',
  'wrong-family',
  'missing-family',
  'competing-table',
  'root-prose',
  'root-nonnumeric',
  'mixed-source-claim'
])('refuses a composite preview without the complete bounded native proof: %s', async (fault) => {
  await inspectComposite(fault, false)
})
