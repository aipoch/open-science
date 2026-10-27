import { expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import type { PdfLayoutTextItem } from '../../src/reader/layout.js'

function algorithmDocument(fault = ''): PDFDocumentProxy {
  const text = (
    str: string,
    x: number,
    y: number,
    width: number,
    height = 10,
    fontName = 'Body',
    hasEOL = true
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    dir: 'ltr',
    transform: [height, 0, 0, height, x, y],
    fontName,
    hasEOL
  })
  const rows = [
    [
      ['A', 'Math'],
      ['←', 'Math'],
      ['set()', 'Body']
    ],
    [
      ['if', 'Bold'],
      ['A is empty', 'Body'],
      ['then', 'Bold']
    ],
    [
      ['B', 'Math'],
      ['←', 'Math'],
      ['pick(A)', 'Body']
    ],
    [
      ['for', 'Bold'],
      ['a in A', 'Body'],
      ['do', 'Bold']
    ],
    [
      ['B', 'Math'],
      ['←', 'Math'],
      ['B + a', 'Body']
    ],
    [
      ['if', 'Bold'],
      ['B is valid', 'Body'],
      ['then', 'Bold']
    ],
    [['else', 'Bold']],
    [
      ['return', 'Bold'],
      ['no admissible base exists', 'Body']
    ]
  ]
  const items = [text('Algorithm 1 Select(A)', 60, 740, 180, 12, 'Bold')]
  for (const [n, parts] of rows.entries()) {
    items.push(text(`${n + 1}:`, 66, 704 - n * 20, 10, 8, 'Body', false))
    let x = 90
    for (const [index, [str, fontName]] of parts.entries()) {
      const width = str.length * 5
      items.push(text(str, x, 704 - n * 20, width, 10, fontName, index === parts.length - 1))
      x += width + 4
    }
  }
  if (fault === 'gutter-shift')
    for (const item of items) if (item.str === '8:') item.transform[4] += 2
  if (fault === 'wrapped-then') {
    const item = items.find((item) => item.str === 'then')!
    item.transform[4] = 95
    item.transform[5] = 674
  }
  if (fault === 'wide-gutter')
    for (const item of items) if (item.str === '8:') item.transform[4] += 4
  if (fault === 'ordered-foreign-body')
    items.splice(
      items.findIndex((item) => item.str === '5:'),
      0,
      text('An independent ordinary explanation.', 120, 634, 230)
    )
  if (fault === 'wrapped-comment') {
    const at = items.findIndex((item) => item.str === '5:')
    for (const item of items.slice(at)) item.transform[5] -= 30
    items.splice(
      at,
      0,
      text('// Complete native comment', 90, 624, 160),
      text('with one closed continuation', 106, 609, 160)
    )
  }
  items.push(
    text(
      'The independent ordinary explanation remains eligible after this algorithm.',
      60,
      fault === 'wrapped-comment' ? 480 : 510,
      430
    )
  )
  const fnArray: number[] = [],
    argsArray: unknown[][] = []
  for (const y of [750, 730, fault === 'wrapped-comment' ? 510 : 540]) {
    fnArray.push(OPS.save, OPS.setLineWidth, OPS.constructPath, OPS.restore)
    argsArray.push([], [0.5], [OPS.stroke, [new Float32Array([0, 60, y, 1, 500, y])]], [])
  }
  if (fault === 'unsupported-cap') {
    fnArray.unshift(OPS.setLineCap)
    argsArray.unshift([1])
  }
  if (fault === 'missing-number') items.find((item) => item.str === '5:')!.str = '15:'
  if (fault === 'ordinary-list')
    for (const item of items)
      if (item.str === '←' || /^(?:if|then|for|do|else|return)$/.test(item.str))
        item.str = 'ordinary'
  if (fault === 'foreign-body') items.push(text('A separate ordinary explanation.', 180, 630, 240))
  if (fault === 'no-bottom-rule') {
    fnArray.splice(-4)
    argsArray.splice(-4)
  }
  return {
    numPages: 1,
    fingerprints: ['anonymous-native-numbered-algorithm'],
    getPage: async () => ({
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items,
        styles: Object.fromEntries(
          ['Body', 'Bold', 'Math'].map((name) => [
            name,
            { ascent: 0.8, descent: -0.2, vertical: false }
          ])
        )
      }),
      getOperatorList: async () => ({ fnArray, argsArray }),
      commonObjs: {
        get: () => ({
          missingFile: fault === 'missing-font',
          isType3Font: false,
          isInvalidPDFjsFont: false,
          systemFontInfo: null,
          vertical: false,
          ascent: 0.8,
          descent: -0.2
        })
      }
    })
  } as unknown as PDFDocumentProxy
}

it('retains the complete native control-flow tail inside its closed algorithm frame', async () => {
  const result = await extractPdfTranslationSource({
    document: algorithmDocument(),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const tail = result.source.units.find((unit) => unit.source.includes('no admissible base exists'))
  expect(tail?.sourceOnly).toBe(true)
  expect(tail?.preserve).toBe('code')
  expect(
    result.source.units.find((unit) => unit.source.includes('independent ordinary explanation'))
      ?.sourceOnly
  ).toBeUndefined()
  expect(result.coverage.excludedItemCount).toBe(0)
})

it.each(['gutter-shift', 'wrapped-comment', 'wrapped-then'])(
  'retains independently closed native algorithm %s flow',
  async (fault) => {
    const result = await extractPdfTranslationSource({
      document: algorithmDocument(fault),
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    expect(
      result.source.units.find((unit) => unit.source.includes('no admissible base exists'))
        ?.preserve
    ).toBe('code')
  }
)

it.each([
  'missing-number',
  'ordinary-list',
  'foreign-body',
  'ordered-foreign-body',
  'no-bottom-rule',
  'missing-font',
  'wide-gutter',
  'unsupported-cap'
])('refuses a numbered algorithm without its independent %s evidence', async (fault) => {
  const result = await extractPdfTranslationSource({
    document: algorithmDocument(fault),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  expect(
    result.source.units.find((unit) => unit.source.includes('no admissible base exists'))?.preserve
  ).not.toBe('code')
})

it('preserves every legacy readonly algorithm owner and all source locations', async () => {
  async function extract(
    document: PDFDocumentProxy
  ): Promise<Awaited<ReturnType<typeof extractPdfTranslationSource>>> {
    return extractPdfTranslationSource({
      document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
  }
  const before = await extract(algorithmDocument('no-bottom-rule')),
    after = await extract(algorithmDocument())
  expect(
    after.source.units.map((unit) => ({ source: unit.source, fragments: unit.fragments }))
  ).toEqual(before.source.units.map((unit) => ({ source: unit.source, fragments: unit.fragments })))
  for (const unit of before.source.units.filter((unit) => unit.sourceOnly || unit.preserve))
    expect(after.source.units.find((next) => next.id === unit.id)).toEqual(unit)
})

function bibliographyDocument(fault = ''): PDFDocumentProxy {
  const items: PdfLayoutTextItem[] = []
  const add = (str: string, x: number, y: number, width: number, height: number): void => {
    items.push({
      str,
      width,
      height,
      dir: 'ltr',
      transform: [height, 0, 0, height, x, y],
      fontName: 'Reference',
      hasEOL: height === 8
    })
  }
  add('The independent ordinary explanation precedes this bibliography.', 60, 700, 420, 10)
  for (let n = 1; n <= 3; n++) {
    add(String(n), 60, 600 - n * 30 + 2.9, 3, 6)
    add(
      `A. Writer, Native source methods, Journal of Examples 1, 10–12 (${2000 + n}).`,
      63.5,
      600 - n * 30,
      380,
      8
    )
  }
  if (fault === 'missing-marker') items[3].str = '8'
  if (fault === 'ordinary-body')
    for (const item of items)
      if (item.height === 8) item.str = 'We should follow this ordinary procedure in (2024).'
  if (fault === 'partial-entry') items.at(-1)!.str = 'A. Writer, Native source methods continue'
  if (fault === 'reference-example') items[0].str = 'Reference examples for the ordinary exercise.'
  if (fault === 'foreign-body') add('An independent foreign explanation.', 120, 545, 230, 8)
  if (fault === 'mixed-owner') {
    items[0].str = 'An independent ordinary introductory statement without a terminal stop'
    items[0].height = 8
    items[0].width = 380
    items[0].transform = [8, 0, 0, 8, 63.5, 580]
  }
  if (fault === 'hyphenated-initial')
    for (const item of items) item.str = item.str.replace('A. Writer', 'J.-L. Writer')
  if (fault === 'fragmented-author')
    for (let at = items.length - 1; at >= 0; at--) {
      const item = items[at]
      if (item.height !== 8) continue
      const rest = {
        ...item,
        str: item.str.replace(/^A\. /, ''),
        width: item.width - 12,
        transform: [...item.transform]
      }
      rest.transform[4] += 12
      item.str = 'A.'
      item.width = 8
      item.hasEOL = false
      items.splice(at + 1, 0, rest)
    }
  return {
    numPages: 1,
    fingerprints: ['anonymous-native-superscript-bibliography'],
    getPage: async () => ({
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items,
        styles: { Reference: { ascent: 0.8, descent: -0.2, vertical: false } }
      }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: {
        has: () => true,
        get: () => ({
          missingFile: fault === 'missing-font',
          isType3Font: false,
          isInvalidPDFjsFont: false,
          systemFontInfo: null,
          vertical: false,
          ascent: 0.8,
          descent: -0.2
        })
      }
    })
  } as unknown as PDFDocumentProxy
}

it('retains a complete independently numbered superscript bibliography without its preceding prose', async () => {
  const result = await extractPdfTranslationSource({
    document: bibliographyDocument(),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const references = result.source.units.filter((unit) => unit.source.includes('A. Writer'))
  expect(references).toHaveLength(3)
  expect(references.every((unit) => unit.sourceOnly && unit.preserve === 'reference')).toBe(true)
  expect(
    result.source.units.find((unit) => unit.source.includes('independent ordinary'))?.sourceOnly
  ).toBeUndefined()
})

it.each(['hyphenated-initial', 'fragmented-author'])(
  'retains complete native %s bibliography author rows',
  async (fault) => {
    const result = await extractPdfTranslationSource({
      document: bibliographyDocument(fault),
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const refs = result.source.units.filter((unit) => unit.source.includes('Writer'))
    expect(refs).toHaveLength(3)
    expect(refs.every((unit) => unit.preserve === 'reference')).toBe(true)
  }
)

it.each([
  'missing-marker',
  'ordinary-body',
  'partial-entry',
  'reference-example',
  'foreign-body',
  'mixed-owner',
  'missing-font'
])('refuses a superscript bibliography without its independent %s boundary', async (fault) => {
  const result = await extractPdfTranslationSource({
    document: bibliographyDocument(fault),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  expect(result.source.units.some((unit) => unit.preserve === 'reference')).toBe(false)
})

function supplementDocument(fault = ''): PDFDocumentProxy {
  const text = (
    str: string,
    y: number,
    width: number,
    height = 10,
    fontName = 'Body'
  ): PdfLayoutTextItem => ({
    str,
    width,
    height,
    dir: 'ltr',
    transform: [height, 0, 0, height, 60, y],
    fontName,
    hasEOL: true
  })
  const pages = [
    [
      text('References', 730, 100, 14, 'Heading'),
      text('(1) A. Writer, Native source methods, Journal of Examples 1, 10 (2001).', 680, 460)
    ],
    [
      text('S1 Independent native source and complete geometry', 730, 440, 14, 'Heading'),
      text(
        'Figure S1: The independently captured examples describe the complete native source.',
        600,
        470
      ),
      text('S1.1 Independent examples', 540, 220, 12, 'Heading'),
      text(
        'Figure S2: The second complete example retains its original source and native position.',
        400,
        470
      )
    ]
  ]
  if (fault === 'missing-subsection') pages[1][2].str = 'An independent ordinary heading'
  if (fault === 'incomplete-last-reference')
    pages[0][1].str = '(1) A. Writer, Native source methods continue'
  if (fault === 'wrong-caption-sequence') pages[1][3].str = pages[1][3].str.replace('S2:', 'S4:')
  if (fault === 'foreign-owner')
    pages[1].push(text('An independent ordinary foreign sentence.', 450, 430))
  return {
    numPages: 2,
    fingerprints: ['anonymous-native-supplement-caption-boundary'],
    getPage: async (pageNumber: number) => ({
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items: pages[pageNumber - 1],
        styles: {
          Body: { ascent: 0.8, descent: -0.2, vertical: false },
          Heading: { ascent: 0.8, descent: -0.2, vertical: false }
        }
      }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: {
        has: () => true,
        get: () => ({
          missingFile: fault === 'missing-font',
          isType3Font: false,
          isInvalidPDFjsFont: false,
          systemFontInfo: null,
          vertical: false,
          ascent: 0.8,
          descent: -0.2
        })
      }
    })
  } as unknown as PDFDocumentProxy
}

it('releases a complete supplementary title, subsection and caption page from the preceding bibliography', async () => {
  const result = await extractPdfTranslationSource({
    document: supplementDocument(),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const supplement = result.source.units.filter((unit) =>
    unit.fragments.every((fragment) => fragment.pageNumber === 2)
  )
  expect(supplement).toHaveLength(4)
  expect(supplement.every((unit) => !unit.sourceOnly && !unit.preserve)).toBe(true)
  expect(result.source.units.find((unit) => unit.source.startsWith('(1)'))?.preserve).toBe(
    'reference'
  )
})

it.each([
  'missing-subsection',
  'incomplete-last-reference',
  'wrong-caption-sequence',
  'foreign-owner',
  'missing-font'
])('retains the bibliography guard without the supplement %s evidence', async (fault) => {
  const result = await extractPdfTranslationSource({
    document: supplementDocument(fault),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  expect(
    result.source.units.find((unit) => unit.source.startsWith('S1 Independent'))?.preserve
  ).toBe('reference')
})
