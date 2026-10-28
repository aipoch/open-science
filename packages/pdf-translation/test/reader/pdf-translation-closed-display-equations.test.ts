import { expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import type { PdfLayoutTextItem } from '../../src/reader/layout.js'

function fixture(kind = 'script', fault = ''): PDFDocumentProxy {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Math',
    height = 10,
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    dir: 'ltr',
    fontName,
    transform: [height, 0, 0, height, x, 800 - y],
    hasEOL
  })
  const parts = [
    item(
      'The preceding complete paragraph explains ordinary independent observations.',
      60,
      260,
      480,
      'Body',
      10,
      true
    ),
    item('E', 180, 300, 7),
    item('=', 190, 300, 7),
    item('R', 205, 300, 7),
    ...(kind === 'fraction'
      ? [item('c', 220, 293.3, 5), item('2', 220, 306.8, 5)]
      : [item('RMS', 212, 301.5, 15, 'Index', 7)]),
    item('(1)', 500, 300, 15, 'Body', 10, true),
    item(
      'The following complete paragraph remains available for translation.',
      60,
      340,
      480,
      'Body',
      10,
      true
    )
  ]
  const target = 4,
    anchor = parts.length - 2
  if (fault === 'ordinary-prose')
    Object.assign(parts[target], {
      str: 'ordinary explanation',
      height: 10,
      transform: [10, 0, 0, 10, 212, 500]
    })
  if (fault === 'inline-prose')
    parts.splice(anchor, 0, item('is the ordinary result', 245, 300, 130, 'Body'))
  if (fault === 'foreign-overlap')
    parts.push(item('independent ordinary text', 190, 300, 160, 'Body', 10, true))
  if (fault === 'detached-script') parts[target].transform[4] += 30
  if (fault === 'raised-word') parts[target].transform[5] += 5
  if (fault === 'no-relation') parts[2].str = '·'
  if (fault === 'no-label') parts[anchor].str = 'ordinary label'
  if (fault === 'open-label') parts[anchor].str = '(1'
  if (fault === 'label-other-line') parts[anchor].transform[5] -= 30
  const metrics = { ascent: 0.8, descent: -0.2, vertical: false }
  const font = {
    ...metrics,
    missingFile: false,
    isType3Font: false,
    isInvalidPDFjsFont: false,
    systemFontInfo: null
  }
  const fnArray = kind === 'fraction' && fault !== 'missing-rule' ? [OPS.constructPath] : []
  const argsArray: unknown[][] = fnArray.length
    ? [[OPS.stroke, [new Float32Array([0, 219.8, 502.5, 1, 225.2, 502.5])], null]]
    : []
  if (fault === 'white-rule') {
    fnArray.unshift(OPS.setStrokeRGBColor)
    argsArray.unshift(['#ffffff'])
  }
  if (fault === 'clip-state') {
    fnArray.unshift(OPS.clip)
    argsArray.unshift([])
  }
  return {
    numPages: 1,
    fingerprints: ['anonymous-closed-native-display-equation'],
    getPage: async () => ({
      getViewport: () => ({
        width: 600,
        height: 800,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, 800]
      }),
      getTextContent: async () => ({
        items: parts,
        styles: { Body: metrics, Math: metrics, Index: metrics }
      }),
      getOperatorList: async () => ({ fnArray, argsArray }),
      commonObjs: {
        get: (name: string) =>
          fault === 'missing-font' && name === 'Index'
            ? undefined
            : fault === 'wrong-font-metrics' && name === 'Math'
              ? { ...font, ascent: 0.7 }
              : font
      }
    })
  } as unknown as PDFDocumentProxy
}

it.each(['script', 'fraction'])(
  'keeps every whole native owner in a closed numbered display equation original: %s',
  async (kind) => {
    const result = await extractPdfTranslationSource({
      document: fixture(kind),
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const target = result.source.units.find((u) =>
      u.fragments.some((f) => f.items.some((i) => i.index === 4))
    )!
    expect(target.sourceOnly).toBe(true)
    expect(target.preserve).toBe('formula')
    expect(
      result.source.units.find((u) => u.source.startsWith('The following'))?.sourceOnly
    ).not.toBe(true)
    expect(result.coverage.excludedItemCount).toBe(0)
  }
)

it.each([
  'ordinary-prose',
  'inline-prose',
  'foreign-overlap',
  'detached-script',
  'raised-word',
  'no-relation',
  'no-label',
  'open-label',
  'label-other-line',
  'missing-font',
  'wrong-font-metrics'
])(
  'does not extend mathematical ownership without the complete native equation proof: %s',
  async (fault) => {
    const result = await extractPdfTranslationSource({
      document: fixture('script', fault),
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    expect(
      result.source.units.find((u) => u.fragments.some((f) => f.items.some((i) => i.index === 4)))
        ?.sourceOnly
    ).not.toBe(true)
  }
)

it.each(['missing-rule', 'white-rule', 'clip-state'])(
  'requires the actual strict native fraction rule: %s',
  async (fault) => {
    const result = await extractPdfTranslationSource({
      document: fixture('fraction', fault),
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    expect(
      result.source.units.find((u) => u.fragments.some((f) => f.items.some((i) => i.index === 4)))
        ?.sourceOnly
    ).not.toBe(true)
  }
)
