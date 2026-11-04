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

function pairedFixture(fault = ''): {
  document: PDFDocumentProxy
  first: number[]
  second: number[]
} {
  const parts: PdfLayoutTextItem[] = [],
    add = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Math',
      height = 10,
      hasEOL = false
    ): number => {
      parts.push({
        str,
        width,
        height,
        dir: 'ltr',
        fontName,
        transform: [height, 0, 0, height, x, 800 - y],
        hasEOL
      })
      return parts.length - 1
    }
  add(
    'The complete ordinary paragraph introduces the first equation.',
    60,
    100,
    430,
    'Body',
    10,
    true
  )
  const firstStart = parts.length
  add('E', 160, 150, 7)
  add('R', 210, 150, 7)
  add('mod', 217, 151.5, 13, 'Index', 6.7)
  add('=', 240, 150, 7)
  const radical = add('√', 260, 146, 7)
  add('3', 267, 150, 6)
  add('n', 285, 139, 4, 'Index', 6.7)
  const script = add('elec', 289, 140.1, 10, 'Index', 5)
  add('∑', 280, 155, 14)
  add('i', 280, 162, 4, 'Index', 6.7)
  add('=1', 284, 162, 8, 'Index', 6.7)
  add('x', 310, 150, 6)
  add('2', 316, 144, 4, 'Index', 6.7)
  add('+', 330, 150, 7)
  add('y', 342, 150, 6)
  add('3', 348, 152, 4, 'Index', 6.7)
  add('(1)', 500, 150, 15, 'Body', 10, true)
  const first = Array.from({ length: parts.length - firstStart }, (_, i) => firstStart + i)
  const connector = add('The result has the following form', 60, 200, 200, 'Body', 10, true)
  const secondStart = parts.length
  add('H', 160, 240, 7)
  add('mod', 167, 241.5, 13, 'Index', 6.7)
  add('=', 190, 240, 7)
  add('(', 205, 240, 4)
  add('a', 215, 240, 6)
  add('+', 225, 240, 7)
  add('b', 235, 240, 6)
  add(')', 245, 240, 4)
  add('∑', 265, 245, 14)
  add('i', 265, 252, 4, 'Index', 6.7)
  add('=1', 269, 252, 8, 'Index', 6.7)
  add('+', 190, 280, 7)
  add('R', 210, 280, 7)
  add('soc', 217, 281.5, 13, 'Index', 6.7)
  add('x', 245, 280, 6)
  add('1', 251, 284, 3, 'Index', 5)
  add('.', 420, 260, 3)
  const anchor = add('(2)', 500, 260, 15, 'Body', 10, true)
  const second = Array.from({ length: parts.length - secondStart }, (_, i) => secondStart + i)
  add('The following independent paragraph stays ordinary prose.', 60, 330, 420, 'Body', 10, true)
  if (fault === 'ordinary-word') parts[script].str = 'ordinary explanation'
  if (fault === 'detached-script') parts[script].transform[4] += 5
  if (fault === 'missing-connector') parts[connector].str = 'Result'
  if (fault === 'detached-number') parts[anchor].transform[4] += 5
  if (fault === 'nonconsecutive-number') parts[anchor].str = '(4)'
  if (fault === 'radicand-gap') parts[radical + 1].transform[4] += 2
  if (fault === 'foreign-prose')
    add('Independent ordinary annotation.', 180, 245, 180, 'Body', 10, true)
  const metrics = { ascent: 0.8, descent: -0.2, vertical: false },
    font = {
      ...metrics,
      missingFile: false,
      isType3Font: false,
      isInvalidPDFjsFont: false,
      systemFontInfo: null
    },
    fnArray = fault === 'missing-rule' ? [] : [OPS.constructPath],
    argsArray: unknown[][] = fnArray.length
      ? [[OPS.stroke, [new Float32Array([0, 267, 659, 1, 273, 659])], null]]
      : []
  if (fault === 'white-rule') {
    fnArray.unshift(OPS.setStrokeRGBColor)
    argsArray.unshift(['#ffffff'])
  }
  if (fault === 'foreign-rule') {
    fnArray.push(OPS.constructPath)
    argsArray.push([OPS.stroke, [new Float32Array([0, 205, 556, 1, 235, 556])], null])
  }
  if (fault === 'clip-state') {
    fnArray.unshift(OPS.clip)
    argsArray.unshift([])
  }
  const document = {
    numPages: 1,
    fingerprints: ['anonymous-paired-native-displays'],
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
        has: () => true,
        get: (name: string) => (fault === 'missing-font' && name === 'Index' ? undefined : font)
      }
    })
  } as unknown as PDFDocumentProxy
  return { document, first, second }
}

it('keeps both complete numbered displays original while admitting their ordinary connector', async () => {
  const f = pairedFixture(),
    result = await extractPdfTranslationSource({
      document: f.document,
      resourceRequestKey: 'anonymous-pair',
      signal: new AbortController().signal
    })
  for (const index of [...f.first, ...f.second]) {
    const owner = result.source.units.find((u) =>
      u.fragments.some((f) => f.items.some((i) => i.index === index))
    )!
    expect(owner.sourceOnly).toBe(true)
  }
  expect(
    result.source.units.find((u) => u.source === 'The result has the following form')?.sourceOnly
  ).not.toBe(true)
  expect(result.coverage.excludedItemCount).toBe(0)
})

it.each([
  'ordinary-word',
  'detached-script',
  'missing-connector',
  'detached-number',
  'nonconsecutive-number',
  'radicand-gap',
  'foreign-prose',
  'missing-rule',
  'white-rule',
  'foreign-rule',
  'clip-state',
  'missing-font'
])('requires the entire native paired display proof: %s', async (fault) => {
  const f = pairedFixture(fault),
    result = await extractPdfTranslationSource({
      document: f.document,
      resourceRequestKey: 'anonymous-pair',
      signal: new AbortController().signal
    })
  expect(
    result.source.units.find((u) => u.fragments.some((f) => f.items.some((i) => i.index === 8)))
      ?.sourceOnly
  ).not.toBe(true)
})

// A closed unnumbered owner may contain an index whose flattened spelling is a pronoun.
function indexedDisplayFixture(fault = ''): {
  document: PDFDocumentProxy
  focal: number
  operators: number[]
} {
  const metrics = { ascent: 0.8, descent: -0.2, vertical: false }
  const nativeFont = {
    ...metrics,
    missingFile: false,
    isType3Font: false,
    isInvalidPDFjsFont: false,
    systemFontInfo: null
  }
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
    fontName,
    dir: 'ltr',
    transform: [height, 0, 0, height, x, 800 - y],
    hasEOL
  })
  const parts: PdfLayoutTextItem[] = [
    item(
      'Several independent observations motivate the following mathematical comparison.',
      60,
      260,
      480,
      'Body',
      10,
      true
    )
  ]
  const operators: number[] = []
  if (fault.startsWith('prefix')) {
    if (fault === 'prefix-prose')
      parts[0] = item(
        'An ordinary explanation mentions inf and lim inf in passing.',
        60,
        260,
        480,
        'Body',
        10,
        true
      )
    if (fault === 'prefix-inline') parts.push(item('The prose phrase', 65, 300, 45, 'Body'))
    operators.push(parts.length)
    parts.push(item('lim inf', 112, 300, 30), item('', 117.75, 306, 0, 'Index', 7, true))
    const shift = fault === 'prefix-mismatch' ? 5 : 0
    parts.push(
      item('k', 117.75 + shift, 306, 3.5, 'Index', 7),
      item('→∞', 121.25 + shift, 306, 15, 'Index', 7)
    )
    operators.push(parts.length)
    parts.push(item('inf', 160, 300, 12), item('', 156, 307.2, 0, 'Index', 7, true))
    for (const [at, str] of ['∥', 'v', '∥', '≤', '3'].entries())
      parts.push(item(str, 156 + 4 * at, 307.2, 4, 'Index', 7))
  }
  const termStart = parts.length
  const terms = fault.startsWith('function')
    ? [
        '(',
        'Q',
        '(',
        'L',
        'r',
        'v',
        '))(',
        'θ',
        ') = (',
        'Q',
        'r',
        ')(',
        'θ',
        ') (',
        'Q',
        'v',
        ')(',
        'θ',
        ')'
      ]
    : ['R', 'δ', '(', 'H', '(', 'z', ')', '∈', 'I', 't', '|', 'W', 'm', ')', '≥', '2', '−', 's.']
  let x = 190
  for (const [at, str] of terms.entries()) {
    const lowered = fault.startsWith('function')
      ? at === 4 && fault !== 'function-no-script'
      : [1, 9, 12].includes(at) && !(fault === 'ordinary-it' && at === 9)
    const height = lowered ? 7 : 10,
      width = str.length * (lowered ? 3.5 : 5)
    parts.push(item(str, x, 300 + (lowered ? 1.5 : 0), width, lowered ? 'Index' : 'Math', height))
    x += width + (lowered ? 1 : 0)
  }
  const focal = termStart + (fault.startsWith('function') ? 3 : 8)
  if (fault === 'inline' || fault === 'function-inline')
    parts.splice(1, 0, item('It describes several ordinary values such as', 60, 300, 129, 'Body'))
  if (fault === 'foreign') parts.push(item('unrelated material', 225, 300, 85, 'Body', 10, true))
  parts.push(item('', 0, 0, 0, 'Body', 10, true))
  parts.push(
    item(
      'A separate ordinary paragraph explains the observations after this display.',
      60,
      340,
      480,
      'Body',
      10,
      true
    )
  )
  const page = {
    getViewport: () => ({ width: 600, height: 800, rotation: 0, transform: [1, 0, 0, -1, 0, 800] }),
    getTextContent: async () => ({
      items: parts,
      styles: { Body: metrics, Math: metrics, Index: metrics }
    }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    commonObjs: {
      has: () => true,
      get: (name: string) => (fault === 'missing-font' && name === 'Index' ? undefined : nativeFont)
    }
  }
  return {
    document: {
      numPages: 1,
      fingerprints: ['anonymous-indexed-display'],
      getPage: async () => page
    } as unknown as PDFDocumentProxy,
    focal: fault === 'inline' || fault === 'function-inline' ? focal + 1 : focal,
    operators
  }
}
it.each([
  '',
  'ordinary-it',
  'inline',
  'missing-font',
  'foreign',
  'prefix',
  'prefix-prose',
  'prefix-inline',
  'prefix-mismatch',
  'function',
  'function-inline',
  'function-no-script'
])('requires a complete native indexed unnumbered display owner: %s', async (fault) => {
  const f = indexedDisplayFixture(fault),
    result = await extractPdfTranslationSource({
      document: f.document,
      resourceRequestKey: 'anonymous-indexed-display',
      signal: new AbortController().signal
    })
  const target = result.source.units.find((u) =>
    u.fragments.some((fragment) => fragment.items.some((i) => i.index === f.focal))
  )!
  if (fault.startsWith('prefix')) {
    const opOwners = f.operators.map((index) =>
      result.source.units.find((u) =>
        u.fragments.some((fragment) => fragment.items.some((i) => i.index === index))
      )!
    )
    if (fault === 'prefix' || fault === 'prefix-prose') {
      expect(opOwners.every((u) => u.sourceOnly === true && u.preserve === 'formula')).toBe(true)
      if (fault === 'prefix-prose')
        expect(
          result.source.units.find((u) => u.source.startsWith('An ordinary explanation'))
            ?.sourceOnly
        ).not.toBe(true)
    } else expect(opOwners[0].sourceOnly).not.toBe(true)
  } else
    expect(target.sourceOnly === true && target.preserve === 'formula').toBe(
      fault === '' || fault === 'function'
    )
  expect(
    result.source.units.find((u) => u.source.startsWith('Several independent'))?.sourceOnly
  ).not.toBe(true)
  expect(
    result.source.units.find((u) => u.source.startsWith('A separate ordinary'))?.sourceOnly
  ).not.toBe(true)
  expect(result.coverage.excludedItemCount).toBe(0)
})
