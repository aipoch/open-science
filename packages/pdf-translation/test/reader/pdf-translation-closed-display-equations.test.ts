import { expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { groupPdfTranslationPages, type PdfLayoutTextItem } from '../../src/reader/layout.js'
import type { PdfTranslationUnit } from '../../src/reader/source.js'

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
  if (kind === 'parallel-rows') {
    parts.splice(
      1,
      5,
      item('A', 134, 300, 7, 'Math', 10, true),
      item('B', 134, 312, 7),
      item('=', 152, 300, 8, 'Body', 10, true),
      item('=', fault === 'shifted-relation' ? 154 : 152, 312, 8, 'Body'),
      ...[300, 312].flatMap((y) => [
        item('p', 170, y, 5),
        item('i', 175, y + 1.5, 5, 'Index', 7),
        item('+', 184, y, 8),
        item('δ', 194, y, 5),
        item('i', 199, y + 1.5, 5, 'Index', 7)
      ]),
      item('(1)', 284, 306, 15, 'Body', 10, true)
    )
  }
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

function derivativeFixture(fault: string): {
  document: PDFDocumentProxy
  ordinary: number
  denominator: number
  differential: number
} {
  const parts: PdfLayoutTextItem[] = []
  const add = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Math',
    hasEOL = false
  ): number => {
    parts.push({
      str,
      width,
      height: 10,
      dir: 'ltr',
      fontName,
      transform: [10, 0, 0, 10, x, y],
      hasEOL
    })
    return parts.length - 1
  }
  add('The preceding prose introduces the two equations.', 60, 700, 240, 'Body', true)
  const dotted = fault.startsWith('dotted')
  const sectionNumerator = dotted ? add('dy', 127, 658, 8, 'Math', true) : -1
  if (!dotted) {
    add('dψ', 120, 658, 11)
    add('(', 131, 658, 3, 'Body')
    add('x', 134, 658, 5)
    add(')', 139, 658, 3, 'Body', true)
  }
  const denominator = add(dotted ? 'dx' : 'dt', fault === 'off-center' ? 140 : 127, 644, 8)
  add(fault === 'no-relation' ? '·' : dotted ? '=' : ':=', dotted ? 144 : 146, 651, 9, 'Body')
  add('u', 158, 651, 5)
  add('=', 166, 651, 8, 'Body')
  add('0', 178, 651, 5, 'Body')
  add(
    fault === 'no-number' ? 'Independent heading' : dotted ? '(3.7)' : '(1)',
    455,
    651,
    dotted ? 26 : 14,
    'Body',
    true
  )
  add('The next differential is defined as follows.', 60, 623, 210, 'Body', true)
  let differential = sectionNumerator
  if (!dotted) {
    add('x', 118, 577, 6)
    add('=', 128, 577, 8, 'Body')
    differential = add('d', 142, 584, 4, 'Math', true)
    add('dt', 140, 570, 8)
    add('μ', 150, 577, 6)
    add('(2)', 455, 577, 14, 'Body', true)
  }
  const ordinary = add(dotted ? 'dx' : 'dt', 75, 450, 10, 'Body', true)
  add('Other prose follows independently.', 75, 419, 220, 'Body', true)
  if (fault === 'ambiguous-fraction') add('overlapping words', 128, 644, 85, 'Body', true)
  const metrics = { ascent: 0.7, descent: -0.2, vertical: false }
  const calls: [number, unknown[]][] = [
    [
      OPS.setGState,
      [
        [
          ['CA', 1],
          ['ca', 1]
        ]
      ]
    ],
    [OPS.setLineWidth, [0.4]],
    ...(
      (fault.endsWith('no-bar')
        ? []
        : dotted
          ? [[127, 135, 654]]
          : [
              [120, 142, 654],
              [140, 148, 580]
            ]) as number[][]
    ).map(([left, right, y]): [number, unknown[]] => [
      OPS.constructPath,
      [OPS.stroke, [new Float32Array([0, left, y, 1, right, y])], null]
    ])
  ]
  if (fault === 'not-opaque')
    calls[0][1] = [
      [
        ['CA', 0.5],
        ['ca', 1]
      ]
    ]
  if (fault === 'duplicate-key')
    calls[0][1] = [
      [
        ['CA', 1],
        ['CA', 1]
      ]
    ]
  if (fault === 'other-key')
    calls[0][1] = [
      [
        ['CA', 1],
        ['BM', 1]
      ]
    ]
  const document = {
    numPages: 1,
    fingerprints: ['anonymous-differential'],
    getPage: async () => ({
      getViewport: () => ({
        width: 600,
        height: 800,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, 800]
      }),
      getTextContent: async () => ({ items: parts, styles: { Body: metrics, Math: metrics } }),
      getOperatorList: async () => ({
        fnArray: calls.map(([op]) => op),
        argsArray: calls.map(([, args]) => args)
      }),
      commonObjs: {
        get: () => ({
          ...metrics,
          missingFile: false,
          isType3Font: false,
          isInvalidPDFjsFont: false,
          systemFontInfo: null
        })
      }
    })
  } as unknown as PDFDocumentProxy
  return { document, ordinary, denominator, differential }
}

it.each([
  'proved',
  'dotted',
  'dotted-no-bar',
  'not-opaque',
  'duplicate-key',
  'other-key',
  'off-center',
  'no-bar',
  'no-relation',
  'no-number',
  'ambiguous-fraction'
])('preserves only differentials proved by their native numbered displays: %s', async (fault) => {
  const { document, ordinary, denominator, differential } = derivativeFixture(fault)
  const { source } = await extractPdfTranslationSource({
    document,
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const ownerOf = (index: number): PdfTranslationUnit | undefined =>
    source.units.find((unit) =>
      unit.fragments.some((fragment) => fragment.items.some((item) => item.index === index))
    )
  expect(ownerOf(ordinary)?.sourceOnly).not.toBe(true)
  const proved = fault === 'proved' || fault === 'dotted'
  expect(ownerOf(denominator)?.sourceOnly).toBe(proved ? true : undefined)
  if (proved || fault.startsWith('dotted'))
    expect(ownerOf(differential)?.sourceOnly).toBe(proved ? true : undefined)
})

const braceItem = (
  str: string,
  x: number,
  y: number,
  width: number,
  height = 10,
  fontName = 'Body',
  hasEOL = false
): PdfLayoutTextItem => ({
  str,
  dir: 'ltr',
  width,
  height,
  transform: [height, 0, 0, height, x, y],
  fontName,
  fontAscent: 0.73,
  fontDescent: -0.24,
  fontVertical: false,
  hasEOL
})

it.each([false, true])(
  'protects the paired summation under matching segmented braces (%s)',
  (shifted) => {
    const items = [
      braceItem(
        'The centered expression gives the combined estimate below.',
        49,
        552,
        230,
        10,
        'Body',
        true
      ),
      braceItem('0', 170, 500, 3, 6, 'Body', true),
      braceItem('0', 107, 500, 3, 6, 'Body', true),
      braceItem('r', 162, 500, 2.5, 6, 'Math', true),
      braceItem('r', 99, 500, 2.5, 6, 'Math', true),
      braceItem('p', 204, 510, 4.5, 10.5, 'Math'),
      braceItem('p', 135, 510, 4.5, 10.5, 'Math'),
      braceItem('W', 78, 510, 6.4, 10.5, 'Math'),
      braceItem('Z', 51, 510, 6.4, 10.5, 'Math'),
      braceItem('\uf8fe', 242, 500, 5.2, 10.5, 'Symbol', true),
      braceItem('\uf8fd', 242, 508.1, 5.2, 10.5, 'Symbol', true),
      braceItem('\uf8fc', 242 + (shifted ? 4 : 0), 516.4, 5.2, 10.5, 'Symbol', true),
      braceItem('\uf8f3', 91, 500, 5.2, 10.5, 'Symbol', true),
      braceItem('\uf8f2', 91, 508.1, 5.2, 10.5, 'Symbol', true),
      braceItem('\uf8f1', 91, 516.4, 5.2, 10.5, 'Symbol'),
      braceItem('+', 148, 510, 5.8, 10.5, 'Symbol', false),
      braceItem('=', 69, 510, 5.8, 10.5, 'Symbol', false),
      braceItem('∑', 160, 507.8, 11, 15.7, 'Symbol', false),
      braceItem('∑', 96, 507.8, 11, 15.7, 'Symbol', false),
      braceItem('>', 165.6, 500, 3.7, 6, 'Symbol', true),
      braceItem('≥', 102, 500, 3.7, 6, 'Symbol', true),
      braceItem('(1)', 267, 512, 12, 10, 'Body', true),
      braceItem(
        'Ordinary body text immediately follows the display.',
        49,
        481,
        220,
        10,
        'Body',
        true
      )
    ]

    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 790, rotation: 0, items }]
    })

    const definition = units.find(({ items }) => items.includes('1:8'))
    expect(definition?.preserve).toBe(shifted ? undefined : 'formula')
    expect(units[0].sourceOnly).toBeUndefined()
    expect(units.at(-1)?.sourceOnly).toBeUndefined()
  }
)

it.each([false, true])(
  'protects a complete equation enclosed by native tall braces (%s)',
  (shifted) => {
    const items = [
      braceItem(
        'The expression gives the combined estimate used below.',
        310,
        320,
        232,
        10,
        'Body',
        true
      ),
      braceItem('(', 381, 278.5, 4.6, 14.1, 'Symbol'),
      braceItem(')', 419, 278.5, 4.6, 14.1, 'Symbol'),
      braceItem('(', 454, 278.5, 4.6, 14.1, 'Symbol'),
      braceItem(')', 500, 278.5, 4.6, 14.1, 'Symbol'),
      braceItem('{', 346, 278.5, 6.6, 22.3, 'Symbol'),
      braceItem('}', 509, 278.5 + (shifted ? 4 : 0), 6.6, 22.3, 'Symbol'),
      braceItem('x', 504, 278.4, 3, 10.7, 'Math'),
      braceItem('R', 406, 278.4, 6.5, 10.7, 'Math'),
      braceItem('nR', 386, 278.4, 14.3, 10.7, 'Math'),
      braceItem('R', 350, 278.4, 6.5, 10.7, 'Math'),
      braceItem('R', 315, 278.4, 6.5, 10.7, 'Math'),
      braceItem('j', 321, 275.8, 1.7, 6.2, 'Math'),
      braceItem('3', 493, 275.8, 3.1, 6.2, 'Body'),
      braceItem('2', 467, 275.8, 3.1, 6.2, 'Body', true),
      braceItem('3', 428, 280.8, 3.1, 6.2, 'Body', true),
      braceItem('1', 424, 285.6, 3.1, 6.2, 'Body', true),
      braceItem('3', 413, 275.8, 3.1, 6.2, 'Body'),
      braceItem('2', 401, 275.8, 3.1, 6.2, 'Body'),
      braceItem('0', 357, 275.8, 3.1, 6.2, 'Body'),
      braceItem('sin', 436, 278.4, 14.2, 10.7, 'Body'),
      braceItem('3', 375, 278.4, 5.3, 10.7, 'Body'),
      braceItem('θ', 483, 278.4, 7.3, 10.7, 'Greek'),
      braceItem('θ', 457, 278.4, 7.3, 10.7, 'Greek'),
      braceItem('β', 337, 278.4, 6.4, 10.7, 'Greek'),
      braceItem('−', 474, 278.4, 5.9, 10.7, 'Symbol'),
      braceItem('+', 365, 278.4, 5.9, 10.7, 'Symbol'),
      braceItem('=', 328, 278.4, 5.9, 10.7, 'Symbol'),
      braceItem(',', 514, 279.1, 2.5),
      braceItem('(2)', 528, 279.1, 11.7, 10, 'Body', true),
      braceItem(
        'Ordinary body text immediately follows the display.',
        310,
        254,
        220,
        10,
        'Body',
        true
      )
    ]

    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 790, rotation: 0, items }]
    })

    const equation = units.find(({ items }) => items.includes('1:29'))
    expect(equation?.preserve).toBe(shifted ? undefined : 'formula')
    expect(units[0].sourceOnly).toBeUndefined()
    expect(units.at(-1)?.sourceOnly).toBeUndefined()
  }
)

it.each(['closed display', 'ordinary metrics', 'detached closing fence'])(
  'preserves encoded delimiters and their infimum only in a complete display (%s)',
  (shape) => {
    const row = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      hasEOL = false,
      height = 10
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      fontAscent: fontName === 'Fence' && shape !== 'ordinary metrics' ? 0.04 : 0.7,
      fontDescent: fontName === 'Fence' && shape !== 'ordinary metrics' ? -0.6 : -0.2,
      fontVertical: false,
      hasEOL,
      transform: [height, 0, 0, height, x, y]
    })
    const items = [
      row('We can express the measured bound as follows.', 90, 528, 240, 'Body', true),
      row('∥', 193.3, 500, 5, 'Math'),
      row('u', 198.3, 500, 4.9, 'Math'),
      row('∥', 204.23, 500, 4.98, 'Math'),
      row('ℓ', 209.21, 497.7, 3.33, 'Subscript', false, 7),
      row('s', 212.54, 499.7, 3.28, 'Superscript', false, 5),
      row('(', 216, 499.7, 2.7, 'Index', false, 5),
      row('·', 218.7, 499.7, 2.28, 'Index', false, 5),
      row(')', 220.98, 499.7, 2.7, 'Index', false, 5),
      row('(', 224.18, 497.7, 3.11, 'Subscript', false, 7),
      row('L', 227.29, 497.7, 5.46, 'Subscript', false, 7),
      row('r', 232.75, 499.7, 3.69, 'Superscript', false, 5),
      row('(', 236.44, 499.7, 2.7, 'Index', false, 5),
      row('·', 239.14, 499.7, 2.28, 'Index', false, 5),
      row(')', 241.42, 499.7, 2.7, 'Index', false, 5),
      row(')', 244.62, 497.7, 3.11, 'Subscript', false, 7),
      row('= inf', 251, 500, 21.87),
      row('n', 275.3, 511, 6.67, 'Fence'),
      row('α >', 281.97, 500, 16.52, 'Math'),
      row('0', 301.23, 500, 5),
      row('ϱ', 313, 500, 6, 'Math'),
      row('(', 319, 500, 4),
      row('β', 323, 500, 6, 'Math'),
      row(')', 329, 500, 4),
      row('≤', 336, 500, 7, 'Math'),
      row('1', 346, 500, 5),
      row('o', 351, shape === 'detached closing fence' ? 518 : 511, 6.67, 'Fence'),
      row('(3.1)', 90, 500, 20, 'Body', true),
      row('This gives the required estimate.', 90, 470, 190, 'Body', true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    for (const index of [16, 17, 26]) {
      const owner = units.find((unit) => unit.items.includes(`1:${index}`))
      expect(owner?.source).toBe(items[index].str)
      expect(Boolean(owner?.sourceOnly && owner.preserve === 'formula')).toBe(
        shape === 'closed display'
      )
    }
    expect(units.find((unit) => unit.items.includes('1:28'))?.sourceOnly).toBeUndefined()
    expect(units.flatMap((unit) => unit.items).toSorted()).toEqual(
      items.map((_, index) => `1:${index}`).toSorted()
    )
  }
)

it.each(['paired aggregates', 'lowered limit', 'different operands'])(
  'retains indexed repeated aggregate displays (%s)',
  (shape) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height = 10
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName: height === 10 ? 'Body' : 'Index',
      fontAscent: 0.75,
      fontDescent: -0.25,
      fontVertical: false,
      hasEOL: str.endsWith('.'),
      transform: [height, 0, 0, height, x, y]
    })
    const items = [
      item('We evaluate the aggregate with the following expression.', 75, 522, 230),
      item('Total', 172, 500, 20),
      item('j', 192, 498.9, 3, 6.7),
      item('=', 198, 500, 7),
      item('Mean', 208, 500, 22),
      item('( max', 230, 500, 24),
      item('k', 233, shape === 'lowered limit' ? 491 : 493.8, 5, 6.7),
      item('∈', 238, 493.8, 6, 6.7),
      item('K', 244, 493.8, 7, 6.7),
      item('Value', 256, 500, 22),
      item('j,k', 278, 498.9, 11, 6.7),
      item(') +', 289, 500, 13),
      item('Mean', 306, 500, 22),
      item('( max', 328, 500, 24),
      item('k', 331, 493.8, 5, 6.7),
      item('∈', 336, 493.8, 6, 6.7),
      item('K', 342, 493.8, 7, 6.7),
      item(shape === 'different operands' ? 'Count' : 'Value', 354, 500, 22),
      item('j,blind,k', 376, 498.9, 24, 6.7),
      item(')', 400, 500, 4),
      item('.', 404, 500, 3),
      item('The following sentence describes how we interpret the result.', 74, 478, 258)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    for (const index of [1, 6, 12, 14, 18]) {
      const owner = units.find((unit) => unit.items.includes(`1:${index}`))
      expect(owner).toBeDefined()
      expect(Boolean(owner?.sourceOnly && owner.preserve === 'formula')).toBe(
        shape === 'paired aggregates'
      )
    }
    expect(units.find((unit) => unit.items.includes('1:0'))?.sourceOnly).toBeUndefined()
    expect(units.find((unit) => unit.items.includes('1:21'))?.sourceOnly).toBeUndefined()
  }
)

const setBuilderFollowingParagraph = 'We direct readers to the appendix for further guidance.'

function setBuilderDisplay(fault: string): PdfLayoutTextItem[] {
  const glyph = (
    str: string,
    x: number,
    width: number,
    fontName = 'Body',
    y = 190.32,
    height = 10,
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    dir: 'ltr',
    fontName,
    fontFamily: 'sans-serif',
    fontAscent: fontName === 'Delimiter' ? 0.04 : fontName === 'Double' ? 0.685 : 0.75,
    fontDescent:
      fontName === 'Delimiter'
        ? -1.759
        : fontName === 'Double'
          ? -0.019
          : fontName === 'Body'
            ? -0.251
            : -0.25,
    fontVertical: false,
    transform: [height, 0, 0, height, x, y],
    hasEOL
  })
  return [
    glyph('M', 155.03, 7.84, 'Italic'),
    glyph('(', 163.87, 3.8),
    glyph('G, ε', 167.68, 15.37, 'Italic'),
    glyph(') = min', 183.44, 33.23),
    glyph('{', 218.47, 5.83, 'Delimiter', 198.35),
    glyph('M', 224.29, 7.84, 'Italic'),
    glyph('∈', 235.94, 6.66, 'Math'),
    glyph('N', 245.37, 7.22, 'Double'),
    glyph(fault === 'no separator' ? ',' : ':', 255.91, 2.71),
    glyph('{', 264.24, 5, 'Math'),
    glyph('V', 269.26, 6.65, 'Italic'),
    glyph('k', 275.88, 2.86, 'Index', 188.81, 6.67),
    glyph('}', 279.5, 5, 'Math'),
    glyph('M', 284.52, 5.62, 'Index', 194.43, 6.67, true),
    glyph('k', 284.52, 2.86, 'Index', 187.81, 6.67),
    glyph('=1', 287.83, 9.06, 'Numeral', 187.81, 6.67),
    glyph('is a', 300.48, 14.73),
    glyph('ε', 318.54, 4.33, 'Italic'),
    glyph('-net for', 323.26, 36.41),
    glyph('G', 362.91, 6.33, 'Italic'),
    glyph('}', 370.64, 5.83, 'Delimiter', fault === 'shifted delimiter' ? 199.35 : 198.35),
    glyph('.', 378.17, 2.71, 'Italic'),
    glyph(setBuilderFollowingParagraph, 83.17, 278.54, 'Body', 173.65)
  ]
}

it.each(['closed display', 'shifted delimiter', 'no separator'])(
  'keeps a split predicate in its native set-builder display (%s)',
  (fault) => {
    const items = setBuilderDisplay(fault)
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 536, height: 700, rotation: 0, items }]
    })
    const predicate = units.find((unit) => unit.source.includes('-net for'))
    const sentence = units.find((unit) => unit.source.includes(setBuilderFollowingParagraph))

    expect(units.flatMap((unit) => unit.items).sort()).toEqual(
      items.map((_, index) => `1:${index}`).sort()
    )
    if (fault === 'closed display') {
      expect(predicate).toMatchObject({
        source: '{ V k } M k =1 is a ε-net for G',
        preserve: 'formula',
        sourceOnly: true
      })
      expect(units.find((unit) => unit.source === '∈ N :')?.sourceOnly).toBe(true)
      expect(sentence?.source).toBe(setBuilderFollowingParagraph)
      expect(sentence?.sourceOnly).toBeUndefined()
      expect(sentence?.fragments[0].rect.x).toBe(83.17)
    } else {
      expect(predicate).toBe(sentence)
      expect(predicate?.sourceOnly).toBeUndefined()
    }
  }
)

it.each(['aligned', 'shifted-relation'])(
  'retains both left operands of a numbered display serialized by column: %s',
  async (shape) => {
    const { source } = await extractPdfTranslationSource({
      document: fixture('parallel-rows', shape),
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    for (const value of ['A', 'B']) {
      const operand = source.units.find((unit) => unit.source === value)
      expect(operand).toBeDefined()
      expect(operand?.preserve).toBe(shape === 'aligned' ? 'formula' : undefined)
    }
    expect(
      source.units.find((unit) => unit.source.startsWith('The following'))?.sourceOnly
    ).toBeUndefined()
  }
)

it.each([0, 11])('retains the complete tail of a centered native extremum: %s', (offset) => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Formula',
    height = 10,
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    dir: 'ltr',
    transform: [height, 0, 0, height, x, y],
    width,
    height,
    fontName,
    fontVertical: false,
    fontAscent: 0.75,
    fontDescent: -0.25,
    hasEOL
  })
  const runs: [string, number, string?][] = [
    ['max', 18, 'Body'],
    ['{', 5, 'Symbol'],
    ['g', 6],
    ['(', 4],
    ['uv', 10],
    ['′', 2.5, 'Prime'],
    ['w', 5.5],
    [')', 4],
    [',', 3],
    ['5 +', 14],
    ['g', 6],
    ['(', 4],
    ['v', 5],
    ['′', 2.5, 'Prime'],
    ['wx', 12.5],
    [')', 4],
    [',', 3],
    ['8 +', 14],
    ['g', 6],
    ['(', 4],
    ['xyz', 15],
    [')', 4],
    ['}', 5, 'Symbol'],
    ['.', 3]
  ]
  const gap = (index: number): number => {
    if ([9, 17].includes(index)) return 4
    if ([10, 18].includes(index)) return 2
    return 0
  }
  const width = 612
  const total = runs.reduce((sum, [, advance], index) => sum + advance + gap(index), 0)
  let x = (width - total) / 2 + offset
  const formula = runs.map(([str, advance, font], index) => {
    x += gap(index)
    const prime = font === 'Prime'
    const run = item(str, x, prime ? 484 : 480, advance, font, prime ? 7 : 10)
    x += advance
    return run
  })
  const prose = 'The following explanatory sentence stays available for translation.'
  const items = [
    item(
      'The preceding ordinary prose introduces another complete expression.',
      92,
      500,
      320,
      'Body',
      10,
      true
    ),
    ...formula,
    item(prose, 92, 460, 320, 'Body', 10, true)
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width, height: 792, rotation: 0, items }]
  })
  const tail = units.find((unit) => unit.source === 'xyz)}.')
  expect(tail?.preserve).toBe(offset === 0 ? 'formula' : undefined)
  expect(tail?.sourceOnly).toBe(offset === 0 ? true : undefined)
  expect(units.find((unit) => unit.source === prose)?.sourceOnly).toBeUndefined()
  expect(units.flatMap((unit) => unit.items).sort()).toEqual(items.map((_, n) => `1:${n}`).sort())
})

it.each([false, true])(
  'groups native proof-case prefixes in a consecutive sequence: %s',
  (fault) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName: string,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      dir: 'ltr',
      transform: [10, 0, 0, 10, x, y],
      width,
      height: 10,
      fontName,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false,
      hasEOL
    })
    const marks = ['D', 'E', fault ? 'G' : 'F']
    const items = marks.flatMap((letter, index) => {
      const y = 600 - index * 61
      return [
        item(
          'The preceding condition establishes the initial estimate.',
          126,
          y + 14.4,
          266,
          'Body',
          true
        ),
        item('(', 105, y, 3, 'Body'),
        item(letter, 108, y, 7, 'Variable'),
        item(') For a type-', 115.5, y, 57, 'Body'),
        item(letter, 172.5, y, 7, 'Variable'),
        item(
          ' group abc, choose a representative with the stated property.',
          181,
          y,
          340,
          'Body',
          true
        ),
        item(
          'The relevant inequality follows from this estimate.',
          126,
          y - 14.4,
          245,
          'Body',
          true
        )
      ]
    })
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    for (const letter of marks) {
      expect(units.some((unit) => unit.source.startsWith(`(${letter}) For a type-${letter}`))).toBe(
        !fault
      )
      expect(units.some((unit) => unit.source === `(${letter}`)).toBe(fault)
    }
    expect(units.flatMap((unit) => unit.items).sort()).toEqual(items.map((_, i) => `1:${i}`).sort())
  }
)

it.each(['attached', 'shifted'])(
  'protects a decimal attached to a native uncertainty stack (%s)',
  (shape) => {
    const ink = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      height = 12,
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      fontVertical: false,
      fontAscent: 0.82,
      fontDescent: -0.25,
      transform: [height, 0, 0, height, x, y],
      hasEOL
    })
    const measurement = (
      whole: string,
      fraction: string,
      x: number,
      y: number
    ): PdfLayoutTextItem[] => [
      ink(whole, x, y, 36),
      ink('.', x + 36, y, 3, 'Punctuation'),
      ink(fraction, x + 39, y, 12),
      ink('+0', x + 51, y + 5, 10, 'Script', 8),
      ink('.', x + 61, y + 5, 2, 'Script', 8),
      ink('12', x + 63, y + 5, 8, 'Script', 8),
      ink('−', x + 51 + (shape === 'shifted' ? 3 : 0), y - 3, 6, 'Sign', 8),
      ink('0', x + 57, y - 3, 4, 'Script', 8),
      ink('.', x + 61, y - 3, 2, 'Script', 8),
      ink('11', x + 63, y - 3, 8, 'Script', 8),
      ink(',', x + 74, y, 3, 'Body', 12, true)
    ]
    const news = ink(
        'The uncertainty for the response is reported below.',
        48,
        557,
        272,
        'Body',
        12,
        true
      ),
      finish = ink(
        'We compare the independent measurements in the next part.',
        48,
        483,
        320,
        'Body',
        12,
        true
      )
    const items = [
      news,
      ink('•', 66, 531, 6),
      ink('P', 76, 531, 7, 'Math'),
      ...measurement('(days) = 7', '45', 84, 531),
      finish
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }],
      pageCount: 1
    })
    const owner = units.find((unit) => unit.items.includes('1:3'))
    expect(owner?.preserve).toBe(shape === 'attached' ? 'formula' : undefined)
    expect(owner?.sourceOnly).toBe(shape === 'attached' ? true : undefined)
    expect(owner).toBeDefined()
  }
)

it.each([0, 15])('keeps a native differential before an aligned equation number (%s)', (shift) => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName: string,
    height = 10,
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    fontName,
    hasEOL,
    dir: 'ltr',
    fontVertical: false,
    fontAscent: 0.75,
    fontDescent: -0.25,
    transform: [height, 0, 0, height, x, y]
  })
  const result = groupPdfTranslationPages({
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          item('We compute the combined rate by integrating.', 36, 300, 198, 'Roman', 10, true),
          item('J', 36, 242, 6, 'Italic'),
          item('=', 55, 242, 8, 'Symbol'),
          item('∫', 66, 255.6, 5.5, 'Large'),
          item('T', 71.5, 232.9, 4.5, 'Small', 7),
          item('\u0012', 78, 256.1, 7.3, 'Large'),
          item('rq', 86, 242, 14, 'Italic'),
          item('−', 119, 242, 8, 'Symbol'),
          item('rB', 130, 248.7, 12, 'Italic'),
          item('4π', 141, 235.2, 11, 'Italic'),
          item('\u0013', 164, 256.1, 7.3, 'Large'),
          item('d', 173, 242, 5.2, 'Italic'),
          item('T', 178.2, 242, 7, 'Bold'),
          item(',', 185.5, 242, 2.8, 'Italic'),
          item('(2)', 279, 242 + shift, 13, 'Roman', 10, true),
          item(
            'The next paragraph remains available for translation.',
            36,
            218,
            235,
            'Roman',
            10,
            true
          )
        ]
      }
    ]
  })
  const differential = result.units.find((unit) => unit.source === 'dT,')
  expect(differential).toBeDefined()
  expect(differential?.sourceOnly).toBe(shift === 0 ? true : undefined)
  expect(differential?.preserve).toBe(shift === 0 ? 'formula' : undefined)
})

it.each([0, 15])('retains the native glyphs of a numbered double integral (%s)', (shift) => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Body',
    height = 10,
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    fontName,
    hasEOL,
    dir: 'ltr',
    fontVertical: false,
    fontAscent: fontName === 'Large' ? 0.04 : 0.75,
    fontDescent: fontName === 'Large' ? -0.6 : -0.25,
    transform: [height, 0, 0, height, x, y]
  })
  const { units } = groupPdfTranslationPages({
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        rotation: 0,
        items: [
          item(
            'Integrating the response gives the following identity.',
            36,
            330,
            273,
            'Body',
            10,
            true
          ),
          item('J', 100, 300, 8, 'Italic'),
          item('T', 108, 298, 4, 'Body', 8),
          item('=', 115, 300, 8, 'Operator'),
          item('2', 130, 307, 5, 'Body', 10, true),
          item('6', 127, 293, 5),
          item('π', 132, 293, 6, 'Greek'),
          item('ZZ', 142, 313, 11, 'Large', 9),
          item('D', 153, 292, 6, 'Limit', 8),
          item('d', 161, 300, 6),
          item('u', 167, 300, 5, 'Italic'),
          item('d', 172, 300, 6),
          item('v', 178, 300, 5, 'Italic'),
          item('η', 185, 300, 7, 'Greek'),
          item('.', 192, 300, 3),
          item('(3)', 269, 300 + shift, 15, 'Body', 10, true),
          item(
            'The next paragraph describes the boundary conditions.',
            36,
            273,
            273,
            'Body',
            10,
            true
          )
        ]
      }
    ]
  })
  for (const source of ['ZZ', 'D', 'dudv η.']) {
    const owner = units.find((unit) => unit.source === source)
    expect(owner).toBeDefined()
    expect(owner?.sourceOnly).toBe(shift === 0 ? true : undefined)
    expect(owner?.preserve).toBe(shift === 0 ? 'formula' : undefined)
  }
  expect(
    units.filter((unit) => unit.source.includes('paragraph')).map((unit) => unit.sourceOnly)
  ).toEqual([undefined])
})

it.each([0, 15])(
  'preserves a word-bearing statistical expression with a native equation rail (%s)',
  (shift) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      hasEOL = false
    ): PdfLayoutTextItem => ({
      str,
      width,
      height: 10,
      fontName,
      hasEOL,
      dir: 'ltr',
      fontVertical: false,
      fontAscent: 0.75,
      fontDescent: -0.25,
      transform: [10, 0, 0, 10, x, y]
    })
    const formula = 'mean ± T × IQR'
    const { units } = groupPdfTranslationPages({
      pages: [
        {
          page: 1,
          width: 600,
          height: 800,
          rotation: 0,
          items: [
            item(
              'The observations are sorted into samples of equal size.',
              300,
              511,
              240,
              'Body',
              true
            ),
            item('Each sample produces the following interval:', 300, 500, 175),
            item('mean', 300, 467, 24, 'Italic'),
            item('±', 327, 467, 7, 'Operator'),
            item('T', 337, 467, 7, 'Italic'),
            item('×', 347, 467, 7, 'Operator'),
            item('IQR', 357, 467, 20, 'Italic'),
            item('(4)', 528 + shift, 467, 12, 'Body', true),
            item(
              'Where T controls the response used for every sample.',
              315,
              445,
              225,
              'Body',
              true
            ),
            item('The response is then read on the same fixed scale.', 300, 434, 240, 'Body', true)
          ]
        }
      ]
    })
    const owner = units.find((unit) => unit.source === formula)
    expect(owner).toBeDefined()
    expect(owner?.sourceOnly).toBe(shift === 0 ? true : undefined)
    expect(owner?.preserve).toBe(shift === 0 ? 'formula' : undefined)
    expect(
      units.find((unit) => unit.source.includes('controls the response'))?.sourceOnly
    ).toBeUndefined()
  }
)

it.each([0, 14])('retains a numbered tensor-space suffix (tag offset %s)', (tagOffset) => {
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Math',
    h = 10,
    hasEOL = false
  ): PdfLayoutTextItem => ({
    str,
    width,
    height: str ? h : 0,
    dir: 'ltr',
    transform: [h, 0, 0, h, x, y],
    fontName,
    fontAscent: fontName === 'Delimiter' ? 0.06 : 0.8,
    fontDescent: fontName === 'Delimiter' ? -0.86 : -0.2,
    fontVertical: false,
    hasEOL
  })
  const introduction = 'The features form the following array in the constructed representation'
  const items = [
    item(introduction, 48, 151, 245, 'Body'),
    item('', 111, 140, 0, 'Delimiter', 10, true),
    item('\u0002', 111, 140, 4, 'Delimiter'),
    item('A', 115, 132, 7),
    item('(2)', 123, 136, 10, 'Script', 7),
    item(',', 134, 132, 3),
    item('B', 139, 132, 6),
    item('(', 146, 132, 4, 'Body'),
    item('u, v', 150, 132, 15),
    item(')', 165, 132, 4, 'Body'),
    item('\u0003', 169, 140, 4, 'Delimiter'),
    item('∈', 176, 132, 7, 'Symbol'),
    item('R', 186, 132, 7, 'Field'),
    item('6', 193, 136, 4, 'Script', 7),
    item('×', 197, 136, 6, 'Script', 7),
    item('Q', 203, 136, 7, 'Script', 7),
    item('×', 210, 136, 6, 'Script', 7),
    item('P', 216, 136, 7, 'Script', 7),
    item('.', 225, 132, 3),
    item('(4)', 283, 132 + tagOffset, 12, 'Body')
  ]
  const { units } = groupPdfTranslationPages({
    pages: [{ page: 1, width: 612, height: 790, rotation: 0, items }]
  })
  const owner = units.find((unit) => unit.items.includes('1:11'))
  expect(owner?.items).toEqual(Array.from({ length: 8 }, (_, index) => `1:${index + 11}`))
  expect(owner?.sourceOnly).toBe(tagOffset ? undefined : true)
  expect(owner?.preserve).toBe(tagOffset ? undefined : 'formula')
  expect(units.find((unit) => unit.source === introduction)?.sourceOnly).toBeUndefined()
})

it.each([0, 12])(
  'retains the native indexed exponent in a numbered display (tag offset %s)',
  (offset) => {
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
      transform: [height, 0, 0, height, x, y],
      fontName,
      fontAscent: fontName === 'Body' ? 0.678 : 0.694,
      fontDescent: fontName === 'Body' ? -0.216 : -0.194,
      fontVertical: false,
      hasEOL
    })
    const intro = 'The value is computed as follows:'
    const after = 'The next'
    const items = [
      item(intro, 163, 352.4, 114.89, 'Body'),
      item('A', 63.65, 321.32, 8.25),
      item('= 1', 74.95, 321.32, 15.49, 'Operator'),
      item('−', 92.66, 321.32, 7.75, 'Symbol'),
      item('F', 102.62, 321.32, 6.78),
      item('K', 109.4, 325.43, 5.07, 'Script', 7),
      item('s', 114.47, 324.38, 3.68, 'SmallScript', 5),
      item('', 0, 0, 0, '', 0, true),
      item('base', 109.4, 318.86, 18.03, 'Subscript', 7),
      item(',', 127.93, 321.32, 2.77),
      item('T', 152.28, 321.32, 4.38),
      item('s', 156.66, 319.82, 4.15, 'Script', 7),
      item('=', 164.07, 321.32, 7.75, 'Operator'),
      item('T', 174.59, 321.32, 4.38),
      item('min', 178.97, 319.82, 13.2, 'Subscript', 7),
      item('+', 194.88, 321.32, 7.75, 'Operator'),
      item('A', 204.84, 321.32, 8.25),
      item('(', 213.37, 321.32, 3.87, 'Operator'),
      item('T', 217.24, 321.32, 4.38),
      item('max', 221.62, 319.82, 14.7, 'Subscript', 7),
      item('−', 239.04, 321.32, 7.75, 'Symbol'),
      item('T', 249, 321.32, 4.38),
      item('min', 253.38, 319.82, 13.2, 'Subscript', 7),
      item(')', 267.08, 321.32, 3.87, 'Operator'),
      item('.', 270.95, 321.32, 2.77),
      item('(1)', 288.4, 321.32, 11.6, 'Body', 10, true),
      item(after, 48.96, 302.28, 27.18, 'Body'),
      item('(2)', 288.4 + offset, 278.01, 11.6, 'Body', 10, true)
    ]
    const { units } = groupPdfTranslationPages({
      pages: [{ page: 1, width: 612, height: 792, rotation: 0, items }]
    })
    const owner = units.find(
      (unit) => unit.source.startsWith('A = 1') && unit.source.endsWith('(1)')
    )
    expect(owner).toBeDefined()
    expect(owner?.sourceOnly).toBe(offset ? undefined : true)
    expect(owner?.preserve).toBe(offset ? undefined : 'formula')
    for (const prose of [intro, after]) {
      const owner = units.find((unit) => unit.source === prose)
      expect(owner).toBeDefined()
      expect(owner?.sourceOnly).toBeUndefined()
    }
  }
)

it.each([
  ['adjacent', 359, true],
  ['detached', 367, undefined]
] as const)(
  'preserves a stacked fraction differential only when %s',
  async (_, x, protectedTail) => {
    type Row = [
      text: string,
      x: number,
      y: number,
      width: number,
      font?: string,
      height?: number,
      eol?: boolean
    ]
    const after = 'The next ordinary paragraph describes the result and must remain translatable.'
    const rows: Row[] = [
      ['The source establishes the equation for the next model', 134, 372, 344, 'body', 10, true],
      ['SDE', 134, 360, 20],
      ['', 240, 348, 0, 'math', 0, true],
      ['dz', 240, 348, 11, 'math'],
      ['i', 251, 346.5, 3, 'subscript', 7],
      ['=', 257, 348, 8],
      ['dW', 268, 348, 13, 'math'],
      ['i', 281, 346.5, 3, 'subscript', 7],
      ['+', 286, 348, 8],
      ['X', 300, 357.5, 14, 'sum'],
      ['', 296, 336, 0, 'subscript', 0, true],
      ['β', 296, 336, 5, 'subscript', 7],
      ['∈', 301, 336, 5.5, 'symbol', 7],
      ['A', 307, 336, 6, 'subscript', 7],
      ['+', 313, 335, 5, 'symbol', 5],
      ['', 320, 348, 0, 'math', 0, true],
      ['k', 320, 348, 5, 'math'],
      ['β', 325, 346.5, 5, 'subscript', 7],
      ['', 339, 355, 0, 'math', 0, true],
      ['β', 339, 355, 6, 'math'],
      ['i', 345, 353.5, 3, 'subscript', 7],
      ['', 332, 341, 0, 'fence', 0, true],
      ['⟨', 332, 341, 4, 'fence'],
      ['z, β', 336, 341, 16.5, 'math'],
      ['⟩', 352.5, 341, 4, 'fence'],
      ['ds,', x, 348, 11.5, 'math'],
      ['', 134, 320, 0, 'body', 0, true],
      [after, 134, 320, 344, 'body', 10, true]
    ]
    const items = rows.map(
      ([str, x, y, width, fontName = 'body', height = 10, hasEOL = false]) => ({
        str,
        width,
        height,
        dir: 'ltr',
        fontName,
        hasEOL,
        transform: [height, 0, 0, height, x, y]
      })
    )
    const metrics = { fontFamily: 'serif', ascent: 0.79, descent: -0.21, vertical: false }
    const font = {
      ...metrics,
      missingFile: false,
      isType3Font: false,
      isInvalidPDFjsFont: false,
      systemFontInfo: null
    }
    const styles = Object.fromEntries(items.map(({ fontName }) => [fontName, metrics]))
    const document = {
      numPages: 1,
      fingerprints: ['anonymous-fraction-differential'],
      getPage: async () => ({
        getViewport: () => ({
          width: 612,
          height: 792,
          rotation: 0,
          transform: [1, 0, 0, -1, 0, 792]
        }),
        getTextContent: async () => ({ items, styles }),
        getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
        commonObjs: { get: () => font, has: () => true }
      })
    } as unknown as PDFDocumentProxy

    const { source, coverage } = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const owner = source.units.find((unit) => unit.source === 'ds,')
    expect(owner?.fragments[0].items).toEqual([{ index: 25, text: 'ds,' }])
    expect(owner?.sourceOnly).toBe(protectedTail)
    expect(owner?.preserve).toBe(protectedTail ? 'formula' : undefined)
    expect(source.units.find((unit) => unit.source === after)?.sourceOnly).toBeUndefined()
    expect(coverage.excludedItemCount).toBe(0)
    expect(coverage.includedItemCount).toBe(coverage.textItemCount)
  }
)
