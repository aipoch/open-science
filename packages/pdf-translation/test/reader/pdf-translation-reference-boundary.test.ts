/* eslint-disable @typescript-eslint/explicit-function-return-type -- retain inferred native fixture types */
import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PDFDocument,
  PDFName,
  rectangle,
  fill,
  type PDFPage,
  type PDFFont,
  PDFOperator,
  PDFOperatorNames,
  pushGraphicsState,
  popGraphicsState,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText
} from 'pdf-lib'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import * as terminalBoundary from '../../src/reader/appendix-overview-boundary.js'
import {
  nativeTerminalPlotCaptionInk,
  nativeTerminalPlotScope,
  carryNativeTerminalPlotScope
} from '../../src/reader/native-source-geometry.js'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'
import {
  getPdfTranslationLayoutSnapshot,
  rememberPdfTranslationExtraction,
  restorePdfTranslationExtraction
} from '../../src/reader/snapshot.js'
import { pdfTranslationLayoutSnapshotSchema } from '../../src/snapshot.js'

const fontkit = createRequire(import.meta.url)('fontkit') as Parameters<
  PDFDocument['registerFontkit']
>[0]

const text = (str: string, x: number, y: number, width: number, font = 10, fontName = 'Body') => ({
  str,
  dir: 'ltr',
  width,
  height: font,
  transform: [font, 0, 0, font, x, 800 - y],
  fontName,
  hasEOL: true
})
const body =
  'An independent ordinary paragraph explains the complete construction and all supplementary controls in this section.'
const document = (pages: ReturnType<typeof text>[][]) =>
  ({
    numPages: pages.length,
    fingerprints: ['anonymous-native'],
    getPage: async (number: number) => ({
      rotate: 0,
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items: pages[number - 1],
        styles: Object.fromEntries(
          ['Body', 'Heading', 'Citation'].map((name) => [
            name,
            { vertical: false, ascent: 0.8, descent: -0.2 }
          ])
        )
      })
    })
  }) as unknown as PDFDocumentProxy
const referencePage = () => [
  text('References', 60, 100, 120, 14, 'Heading'),
  text(
    '[1] A. Example. A complete native bibliographic citation in a journal.',
    60,
    135,
    480,
    10,
    'Citation'
  ),
  text(
    '[2] B. Author. Another independent citation with complete publication data.',
    60,
    153,
    480,
    10,
    'Citation'
  )
]

describe('native reference boundary through content-first preparation', () => {
  it.each(['proved', 'legacy', 'protected'] as const)(
    'honors a native boundary before legacy reference-heading recognition: %s',
    (mode) => {
      const source = createPdfTranslationSource({
        resourceRequestKey: 'native-boundary',
        fingerprint: 'native-boundary',
        pages: [
          { width: 600, height: 800 },
          { width: 600, height: 800 }
        ],
        units: ['References', body, 'References', 'Writer, A. A complete publication.'].map(
          (source, index) => ({
            id: `native-${index}`,
            source,
            ...(index === 0 && mode !== 'legacy' ? { referenceBoundary: true as const } : {}),
            ...(index >= 2 || (index === 0 && mode === 'protected')
              ? { sourceOnly: true as const }
              : {}),
            ...(index >= 2 ? { preserve: 'reference' as const } : {}),
            fragments: [
              {
                pageNumber: index < 2 ? 1 : 2,
                rect: { x: 0.1, y: 0.1 + (index % 2) * 0.1, width: 0.7, height: 0.04 },
                items: [{ index, text: source }]
              }
            ]
          })
        )
      })
      const prepared = applyPdfContentFirstPolicy(source)
      expect(!!prepared.units[1].sourceOnly).toBe(mode !== 'proved')
      expect(
        prepared.units.slice(2).every((unit) => unit.preserve === 'reference' && unit.sourceOnly)
      ).toBe(true)
      expect(prepared.units.map((unit) => [unit.id, unit.source, unit.fragments])).toEqual(
        source.units.map((unit) => [unit.id, unit.source, unit.fragments])
      )
    }
  )
  it.each(['complete', 'entry font', 'missing earlier section', 'number gap', 'open body'])(
    'releases a numbered post-reference section only with native section and body proof: %s',
    async (fault) => {
      const heading = '3. Notation',
        pages = [
          [
            text('2. Earlier Results', 60, 70, 160, 14, 'Heading'),
            text(body, 60, 110, 480),
            ...referencePage()
          ],
          [
            text(heading, 60, 70, 120, 14, fault === 'entry font' ? 'Citation' : 'Heading'),
            text(
              body + ' Further complete details independently justify the native section boundary.',
              60,
              105,
              480
            )
          ]
        ]
      // Put the bibliography below the earlier ordinary section on its own page.
      pages[0].splice(2)
      pages.splice(1, 0, referencePage())
      if (fault === 'missing earlier section') pages[0].shift()
      if (fault === 'number gap') pages[2][0].str = '9. Notation'
      if (fault === 'open body') pages[2][1].str = pages[2][1].str.slice(0, -1)
      const extraction = await extractPdfTranslationSource({
        document: document(pages),
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const prepared = applyPdfContentFirstPolicy(extraction.source),
        found = prepared.units.find((u) => u.source === pages[2][0].str)!
      expect(found.referenceBoundary === true).toBe(fault === 'complete')
      expect(!!found.sourceOnly).toBe(fault !== 'complete')
      expect(
        prepared.units
          .filter((u) => /^\[\d\]/u.test(u.source))
          .every((u) => u.preserve === 'reference')
      ).toBe(true)
      expect(prepared.units.map((u) => [u.id, u.source, u.fragments])).toEqual(
        extraction.source.units.map((u) => [u.id, u.source, u.fragments])
      )
    }
  )
  it.each([
    ['A Proofs of Section 4', 164],
    ['Supporting Information', 169],
    ['A Proofs', 65],
    ['A SUPPLEMENTARY APPENDIX (ONLINE APPENDIX)', 288],
    ['Appendix', 68]
  ] as const)(
    'retains an already proved section boundary after snapshot restore: %s',
    async (heading, width) => {
      const extraction = await extractPdfTranslationSource({
        document: document([
          referencePage(),
          [
            text(heading, 60, 70, width, 14, 'Heading'),
            text(body, 60, 110, 480),
            text(
              'A further complete sentence discusses the same construction and its details.',
              60,
              125,
              480
            )
          ]
        ]),
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      expect(
        extraction.source.units.find((unit) => unit.source === heading)?.referenceBoundary
      ).toBe(true)
      rememberPdfTranslationExtraction(extraction)
      const snapshot = pdfTranslationLayoutSnapshotSchema.parse(
        getPdfTranslationLayoutSnapshot(extraction.source)
      )
      const restored = restorePdfTranslationExtraction(snapshot, 'anonymous')
      const prepared = applyPdfContentFirstPolicy(restored.source)
      expect(prepared.units.find((unit) => unit.source === heading)?.sourceOnly).toBeUndefined()
      expect(
        prepared.units.find((unit) => unit.source.startsWith(body))?.sourceOnly
      ).toBeUndefined()
      expect(
        prepared.units.filter((unit) => /^\[\d\]/u.test(unit.source)).map((unit) => unit.preserve)
      ).toEqual(['reference', 'reference'])
      expect(prepared.units.map((unit) => [unit.id, unit.source, unit.fragments])).toEqual(
        extraction.source.units.map((unit) => [unit.id, unit.source, unit.fragments])
      )
    }
  )

  it('keeps a body-sized bibliographic book title inside the native reference section', async () => {
    const extraction = await extractPdfTranslationSource({
      document: document([
        referencePage(),
        [
          text('A Book Title in an Existing Bibliography', 60, 70, 260, 10, 'Citation'),
          text(
            '[3] Another complete bibliographic citation follows this title.',
            60,
            100,
            480,
            10,
            'Citation'
          )
        ]
      ]),
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const prepared = applyPdfContentFirstPolicy(extraction.source)
    expect(prepared.units.find((unit) => unit.source.startsWith('A Book Title'))).toMatchObject({
      sourceOnly: true,
      preserve: 'reference'
    })
    expect(extraction.source.units.some((unit) => unit.referenceBoundary)).toBe(false)
  })

  it.each([false, true])(
    'retains legacy fallback and same-page column order with explicit reference markers: %s',
    (marked) => {
      const sources = [
        ['References', 1, 0.56, 0.12, marked],
        ['A complete left column paragraph remains ordinary.', 1, 0.1, 0.3, false],
        ['[1] A complete bibliography citation.', 1, 0.56, 0.3, marked],
        ['A Book Title in This Bibliography', 2, 0.56, 0.1, true],
        ['Appendix  :', 3, 0.1, 0.1, false],
        [body, 3, 0.1, 0.3, false]
      ] as const
      const source = createPdfTranslationSource({
        resourceRequestKey: 'anonymous',
        fingerprint: 'native',
        pages: [
          { width: 600, height: 800 },
          { width: 600, height: 800 },
          { width: 600, height: 800 }
        ],
        units: sources.map(([source, pageNumber, x, y, originalOnly], index) => ({
          id: String(index),
          source,
          ...(originalOnly ? { sourceOnly: true as const, preserve: 'reference' as const } : {}),
          fragments: [
            {
              pageNumber,
              rect: { x, y, width: 0.35, height: 0.02 },
              items: [{ index, text: source }]
            }
          ]
        }))
      })
      const prepared = applyPdfContentFirstPolicy(source)
      expect(prepared.units.map((unit) => !!unit.sourceOnly)).toEqual([
        true,
        false,
        true,
        true,
        false,
        false
      ])
      expect(prepared.units[3].preserve).toBe('reference')
    }
  )
})

import { restoreNativeOrdinaryAppendixProse } from '../../src/reader/wrapped-section-prose.js'
import {
  rememberNativeCaptionEligibility,
  hasNativeCaptionEligibility,
  hasNativeOrdinaryProseEligibility,
  carryNativeCaptionEligibility
} from '../../src/reader/caption-eligibility.js'
import { pdfReflowContentKinds } from '../../src/reader/reflow-content.js'

// These generated pages exercise the native publisher, not a serialized role flag.
const nativeProseFixture = () => {
  const font = (id: string) => ({
    loadedName: id,
    data: new Uint8Array([1, 2, 3, 4]),
    missingFile: false,
    isType3Font: false,
    isInvalidPDFjsFont: false,
    systemFontInfo: null,
    vertical: false,
    ascent: 0.8,
    descent: -0.2,
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0]
  })
  const fonts = new Map(['Body', 'Heading', 'Citation'].map((n) => [n, font(n)]))
  const styles = Object.fromEntries(
    [...fonts].map(([n, f]) => [n, { ascent: f.ascent, descent: f.descent, vertical: false }])
  )
  const item = (
    str: string,
    x: number,
    y: number,
    width: number,
    height = 10,
    fontName = 'Body'
  ) => ({
    str,
    dir: 'ltr',
    width,
    height,
    transform: [height, 0, 0, height, x, 800 - y],
    fontName,
    hasEOL: true
  })
  const content = [
    [item('References', 250, 80, 100, 12, 'Heading')],
    [
      item(
        'Writer, Ada (2001). In: Journal of Generated Trials, pp. 11–15.',
        70,
        100,
        400,
        8,
        'Citation'
      ),
      item(
        'Writer, Bea (2002). In: Journal of Generated Trials, pp. 21–25.',
        70,
        120,
        400,
        8,
        'Citation'
      ),
      item(
        'Writer, Cee (2003). In: Journal of Generated Trials, pp. 31–35.',
        70,
        140,
        400,
        8,
        'Citation'
      )
    ],
    [
      item('A. Appendix', 250, 80, 100, 12, 'Heading'),
      item(
        'For the generated proof let X ∈ R and retain every original source coordinate.',
        70,
        110,
        460
      ),
      item('A.1. Generated methods', 70, 150, 180, 12, 'Heading')
    ],
    [
      item(
        'This generated ordinary paragraph contains a complete explanation of the method and retains',
        70,
        100,
        460
      ),
      item('all independently closed source words for the final verification.', 70, 114, 320),
      item(
        'A separate unproved explanatory paragraph stays inside the legacy reference inference and must not acquire local authority.',
        70,
        160,
        460
      ),
      item('0.4', 70, 190, 20)
    ],
    [
      item(
        'Figure 1. An unrelated generated caption remains independently certified.',
        70,
        100,
        440
      )
    ]
  ].map((items) => ({ items, styles }))
  const operators = content.map(() => ({ fnArray: [] as number[], argsArray: [] as unknown[] }))
  const identity = { sourceChecksum: 'a'.repeat(64), sourceSizeBytes: 42 }
  const pages = content.map((c, n) => ({
    ref: { num: n + 1, gen: 0 },
    view: [0, 0, 600, 800],
    rotate: 0,
    userUnit: 1,
    commonObjs: { get: (id: string) => fonts.get(id), has: (id: string) => fonts.has(id) },
    getTextContent: async () => c,
    getOperatorList: async () => operators[n],
    getViewport: () => ({
      width: 600,
      height: 800,
      scale: 1,
      rotation: 0,
      transform: [1, 0, 0, -1, 0, 800],
      convertToViewportPoint: (x: number, y: number): [number, number] => [x, 800 - y]
    }),
    cleanup: () => true
  }))
  const document = {
    numPages: 5,
    fingerprints: ['generated-native-frame'],
    getPage: async (n: number) => pages[n - 1]
  }
  const fragment = (page: number, indexes: number[]) => {
    const raw = indexes.map((i) => content[page - 1].items[i]),
      x = Math.min(...raw.map((i) => i.transform[4])),
      right = Math.max(...raw.map((i) => i.transform[4] + i.width)),
      y = Math.min(...raw.map((i) => 800 - i.transform[5] - 0.8 * i.height)),
      bottom = Math.max(...raw.map((i) => 800 - i.transform[5] + 0.2 * i.height))
    return {
      pageNumber: page,
      rect: { x: x / 600, y: y / 800, width: (right - x) / 600, height: (bottom - y) / 800 },
      items: indexes.map((index) => ({ index, text: content[page - 1].items[index].str }))
    }
  }
  const owner = (
    id: string,
    page: number,
    indexes: number[],
    flags: { sourceOnly?: true; preserve?: 'reference' } = {}
  ) => ({
    id,
    source: indexes.map((i) => content[page - 1].items[i].str).join(' '),
    fragments: [fragment(page, indexes)],
    ...flags
  })
  const protectedOwner = (id: string, page: number, indexes: number[]) =>
    owner(id, page, indexes, { sourceOnly: true, preserve: 'reference' })
  const source = createPdfTranslationSource({
    resourceRequestKey: 'generated-native-prose',
    fingerprint: 'generated-native-frame',
    pages: content.map(() => ({ width: 600, height: 800 })),
    units: [
      protectedOwner('reference-heading', 1, [0]),
      ...Array.from({ length: 3 }, (_, i) => protectedOwner('bib-' + i, 2, [i])),
      protectedOwner('appendix', 3, [0]),
      protectedOwner('intro', 3, [1]),
      protectedOwner('subsection', 3, [2]),
      protectedOwner('ordinary', 4, [0, 1]),
      protectedOwner('unproved', 4, [2]),
      owner('navigation', 4, [3], { sourceOnly: true }),
      owner('external-caption', 5, [0])
    ]
  })
  const extraction = {
    source,
    coverage: {
      pageCount: 5,
      textItemCount: 12,
      includedItemCount: 12,
      excludedItemCount: 0,
      pagesWithoutText: [] as number[],
      exclusions: [],
      warnings: []
    }
  }
  const input = {
    extraction,
    document: document as unknown as PDFDocumentProxy,
    sourceIdentity: identity,
    signal: new AbortController().signal
  }
  return { input, source, content, fonts, pages, identity, document }
}

describe('native ordinary appendix prose authority', () => {
  it('restores one complete generated owner without clearing the legacy anchor or recasting caption proof', async () => {
    const f = nativeProseFixture()
    rememberNativeCaptionEligibility(f.source, new Set(['external-caption']))
    const before = pdfReflowContentKinds(f.source)
    const result = await restoreNativeOrdinaryAppendixProse(f.input)
    const ordinary = result.source.units.find((u) => u.id === 'ordinary')!
    expect(ordinary.sourceOnly).toBeUndefined()
    expect(ordinary.preserve).toBeUndefined()
    expect(hasNativeOrdinaryProseEligibility(result.source, ordinary)).toBe(true)
    expect(hasNativeCaptionEligibility(result.source, ordinary)).toBe(false)
    expect(
      hasNativeCaptionEligibility(
        result.source,
        result.source.units.find((u) => u.id === 'external-caption')!
      )
    ).toBe(true)
    for (const old of f.source.units)
      if (old.id !== 'ordinary') {
        expect(result.source.units.find((u) => u.id === old.id)).toEqual(old)
        expect(pdfReflowContentKinds(result.source).get(old.id)).toBe(before.get(old.id))
      }
    expect(result.coverage).toBe(f.input.extraction.coverage)
  })

  const failures: [string, (f: ReturnType<typeof nativeProseFixture>) => void][] = [
    [
      'an accessor in an otherwise valid native source lease',
      (f) => {
        Object.defineProperty(f.identity, 'opaqueContext', {
          enumerable: true,
          get: () => 'retained context'
        })
      }
    ],
    [
      'the unchanged native reference budget',
      (f) => {
        Object.assign(f.identity, { opaqueContext: Array.from({ length: 100001 }, () => ({})) })
      }
    ],
    [
      'a used font ascent outside the existing guard',
      (f) => {
        f.fonts.get('Body')!.ascent = 1.01
        f.content[3].styles.Body.ascent = 1.01
      }
    ],
    [
      'an unproved zero-metric foreign font',
      (f) => {
        f.fonts.set('Foreign', {
          ...f.fonts.get('Body')!,
          loadedName: 'Foreign',
          ascent: 0,
          descent: 0
        })
        f.content[3].styles.Foreign = { ascent: 0, descent: 0, vertical: false }
        f.content[3].items.push({
          ...f.content[3].items[2],
          fontName: 'Foreign',
          str: 'foreign',
          transform: [10, 0, 0, 10, 70, 200]
        })
      }
    ],
    [
      'an incomplete bibliography endpoint',
      (f) => {
        f.content[1].items[2].str =
          'Writer, Cee (2003). In: Journal of Generated Trials, incomplete'
      }
    ],
    [
      'an overlapping foreign native item',
      (f) => {
        f.content[3].items.push({
          ...f.content[3].items[0],
          str: 'foreign overlap',
          width: 10,
          transform: [10, 0, 0, 10, 80, 700]
        })
      }
    ],
    [
      'a foreign zero-advance item without an outline proof',
      (f) => {
        f.content[3].items.push({
          ...f.content[3].items[0],
          str: 'foreign zero',
          width: 0,
          transform: [10, 0, 0, 10, 80, 400]
        })
      }
    ],
    [
      'a missing native EOL',
      (f) => {
        f.content[3].items[1].hasEOL = false
      }
    ],
    [
      'a mismatched literal',
      (f) => {
        f.content[3].items[0].str += ' changed'
      }
    ],
    [
      'a sheared native owner',
      (f) => {
        f.content[3].items[0].transform[2] = 1
      }
    ],
    [
      'a page method replaced during an await',
      (f) => {
        const old = f.pages[3].getTextContent,
          viewport = f.pages[3].getViewport
        f.pages[3].getTextContent = async () => {
          const content = await old()
          f.pages[3].getViewport = () => viewport()
          return content
        }
      }
    ],
    [
      'a substituted page during verification',
      (f) => {
        const get = f.document.getPage
        let calls = 0
        f.document.getPage = async (n) => {
          const page = await get(n)
          return n === 4 && ++calls > 1 ? { ...page } : page
        }
      }
    ],
    [
      'font bytes changed during cleanup',
      (f) => {
        f.pages[3].cleanup = () => {
          f.fonts.get('Body')!.data[0]++
          return true
        }
      }
    ],
    [
      'a source lease changed during cleanup',
      (f) => {
        f.pages[3].cleanup = () => {
          f.identity.sourceSizeBytes++
          return true
        }
      }
    ]
  ]
  it.each(failures)('declines %s without changing the extraction', async (_name, mutate) => {
    const f = nativeProseFixture()
    mutate(f)
    expect(await restoreNativeOrdinaryAppendixProse(f.input)).toBe(f.input.extraction)
  })

  it('does not inherit ordinary proof from JSON, reordered or foreign native owners', async () => {
    const f = nativeProseFixture(),
      result = await restoreNativeOrdinaryAppendixProse(f.input)
    const json = createPdfTranslationSource(JSON.parse(JSON.stringify(result.source)))
    expect(
      hasNativeOrdinaryProseEligibility(
        json,
        json.units.find((u) => u.id === 'ordinary')!
      )
    ).toBe(false)
    const changed = carryNativeCaptionEligibility(
      result.source,
      createPdfTranslationSource({
        ...result.source,
        units: result.source.units.map((u) =>
          u.id === 'unproved' ? { ...u, id: 'different-native-owner' } : u
        )
      })
    )
    expect(
      hasNativeOrdinaryProseEligibility(
        changed,
        changed.units.find((u) => u.id === 'ordinary')!
      )
    ).toBe(false)
  })
})

const bracketedReferenceDocument = (fault: string) => {
  const item = (str: string, x: number, y: number, width: number, name = 'Body') =>
    text(str, x, y, width, 10, name)
  const marker = (n: number, y: number) => ({ ...item(`[${n}]`, 60, y, 15), hasEOL: false })
  const author = (name: string, y: number) =>
    item(
      `${name}. Writer, "Generated native records and complete bibliography boundaries,"`,
      82,
      y,
      430
    )
  const ending = (year: number, y: number) =>
    item(`Journal of Examples 9, 10-20 (${year}).`, 82, y, 240)
  const pages = [
    [
      item(body, 60, 50, 480),
      item('Reference', 60, 100, 60, fault === 'title font' ? 'Body' : 'Heading'),
      marker(1, 130),
      author('A', 130),
      ending(2021, 146),
      marker(2, 720),
      author('B', 720)
    ],
    [
      ending(2022, 70),
      marker(fault === 'ordinal gap' ? 4 : 3, 110),
      author('C', 110),
      ending(2023, 126)
    ]
  ]
  if (fault === 'literal hyphen') {
    pages[0][3].str = 'A. Writer, "Generated native cross-'
    pages[0][4].str =
      'boundary records in a generated journal," Journal of Examples 9, 10-20 (2021).'
  }
  if (fault === 'missing source') pages[1].at(-1)!.width = 0
  if (fault === 'open terminal') pages[1].at(-1)!.str = 'Journal of Examples, unfinished citation'
  if (fault === 'following ordinary') pages[1].push(item(body, 60, 170, 480))
  if (fault === 'foreign font')
    pages[0].unshift(item('Unrelated native label', 60, 25, 120, 'Foreign'))
  if (fault === 'split terminal') {
    pages[1].pop()
    pages[1].push(
      { ...item('Journal of Examples 9, 10-20 ', 82, 126, 170), hasEOL: false },
      { ...item('(', 252, 126, 3), hasEOL: false },
      { ...item('2023', 255, 126, 20), hasEOL: false },
      item(').', 275, 126, 5)
    )
  }
  const font = (name: string) => ({
    loadedName: name,
    ascent: name === 'Foreign' ? 1.01 : 0.8,
    descent: -0.2,
    vertical: false,
    missingFile: false,
    isType3Font: false,
    isInvalidPDFjsFont: false,
    systemFontInfo: null
  })
  const styles = Object.fromEntries(
    ['Body', 'Heading', 'Foreign'].map((name) => [
      name,
      {
        fontFamily: 'serif',
        ascent: name === 'Foreign' ? 1.01 : 0.8,
        descent: -0.2,
        vertical: false
      }
    ])
  )
  return {
    nativePages: pages,
    document: {
      numPages: 2,
      fingerprints: ['anonymous-bracketed-reference'],
      getPage: async (number: number) => ({
        rotate: 0,
        getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
        getTextContent: async () => ({ items: pages[number - 1], styles }),
        getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
        commonObjs: { get: font, has: () => true },
        cleanup: () => {}
      })
    } as unknown as PDFDocumentProxy
  }
}

describe('complete native bracketed bibliography with a singular title', () => {
  it.each([
    'complete',
    'split terminal',
    'literal hyphen',
    'missing source',
    'title font',
    'ordinal gap',
    'open terminal',
    'following ordinary',
    'foreign font'
  ])('changes only closed native reference roles: %s', async (fault) => {
    const fixture = bracketedReferenceDocument(fault),
      result = await extractPdfTranslationSource({
        document: fixture.document,
        resourceRequestKey: 'anonymous-bracketed-reference',
        signal: new AbortController().signal
      }),
      header = fixture.nativePages[0].findIndex((i) => i.str === 'Reference'),
      packet = result.source.units.filter((u) =>
        u.fragments.every((f) => f.pageNumber > 1 || f.items.every((i) => i.index >= header))
      ),
      accepted = fault === 'complete' || fault === 'split terminal' || fault === 'literal hyphen'
    if (fault === 'literal hyphen')
      expect(
        result.coverage.warnings.some((w) => w.reasons.includes('ambiguous-line-hyphen'))
      ).toBe(true)
    if (fault === 'missing source') expect(result.coverage.exclusions.length).toBeGreaterThan(0)
    expect(packet.length).toBeGreaterThan(3)
    expect(packet.every((u) => u.sourceOnly && u.preserve === 'reference')).toBe(accepted)
    expect(result.source.units.find((u) => u.source === body)?.sourceOnly).toBeUndefined()
    expect(
      result.source.units.flatMap((u) =>
        u.fragments.flatMap((f) => f.items.map((i) => [f.pageNumber, i.index, i.text]))
      )
    ).toEqual(
      expect.arrayContaining(
        fixture.nativePages.flatMap((items, p) =>
          items.flatMap((i, index) => (i.width > 0 ? [[p + 1, index, i.str]] : []))
        )
      )
    )
  })
})

// The literal References row is a contents destination, not a section anchor.
// Use a real anonymous PDF and the same page, text, fonts and operators as extraction.
describe('native contents anchor', () => {
  const paragraph =
    'A generated paragraph explains ordinary source text with complete surrounding context and stable native ownership.'
  const fixture = async (
    fault: 'none' | 'missing-source' | 'font' | 'page-number' | 'page-identity'
  ) => {
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const fonts =
      path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')) +
      '/standard_fonts/'
    const font = await pdf.embedFont(await readFile(fonts + 'LiberationSans-Regular.ttf'))
    const contents = pdf.addPage([600, 800])
    const fontKey = contents.node.newFontDictionary(font.name, font.ref)
    const line = (value: string, x: number, y: number, size: number) =>
      contents.pushOperators(
        pushGraphicsState(),
        beginText(),
        setFontAndSize(fontKey, size),
        setTextMatrix(1, 0, 0, 1, x, y),
        showText(font.encodeText(value)),
        endText(),
        popGraphicsState()
      )
    line('Contents', 50, 750, 16)
    line('Overview', 50, 700, 10)
    line('1', 500, 700, 10)
    line('References', 50, 680, 10)
    line('3', 500, 680, 10)
    pdf
      .addPage([600, 800])
      .drawText(paragraph, { x: 50, y: 700, size: 10, maxWidth: 500, lineHeight: 14, font })
    const citations = pdf.addPage([600, 800])
    citations.drawText('References', { x: 50, y: 750, size: 14, font })
    citations.drawText('[1] A. Writer. A complete generated publication (2001).', {
      x: 50,
      y: 715,
      size: 10,
      font
    })
    citations.drawText('[2] B. Author. Another complete generated publication (2002).', {
      x: 50,
      y: 695,
      size: 10,
      font
    })
    const loading = getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl:
        path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')) +
        '/standard_fonts/'
    })
    const actual = await loading.promise,
      pages = new Map<number, Awaited<ReturnType<typeof actual.getPage>>>()
    const getPage = async (number: number) => {
      if (pages.has(number)) return pages.get(number)!
      const original = await actual.getPage(number)
      const page =
        number !== 1 || fault === 'none'
          ? original
          : new Proxy(original, {
              get(target, key) {
                if (key === 'pageNumber' && fault === 'page-identity') return 99
                if (key === 'getTextContent')
                  return async (...args: Parameters<typeof original.getTextContent>) => {
                    const content = await original.getTextContent(...args)
                    if (fault === 'missing-source')
                      content.items = content.items.filter(
                        (i) => !('str' in i) || i.str !== 'Overview'
                      )
                    if (fault === 'font')
                      for (const style of Object.values(content.styles)) style.ascent = 0
                    if (fault === 'page-number')
                      for (const item of content.items)
                        if ('str' in item && item.str === '3') item.str = '9'
                    return content
                  }
                const value = Reflect.get(target, key, target)
                return typeof value === 'function' ? value.bind(target) : value
              }
            })
      pages.set(number, page)
      return page
    }
    return {
      loading,
      document: new Proxy(actual, {
        get(target, key) {
          if (key === 'getPage') return getPage
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
  it.each(['none', 'missing-source', 'font', 'page-number', 'page-identity'] as const)(
    'keeps the real later bibliography and requires complete native evidence: %s',
    async (fault) => {
      const f = await fixture(fault)
      try {
        const extraction = await extractPdfTranslationSource({
          document: f.document,
          resourceRequestKey: 'generated-contents',
          signal: new AbortController().signal
        })
        const row = extraction.source.units.find(
          (u) => u.source === 'References' && u.fragments[0].pageNumber === 1
        )!
        const prepared = applyPdfContentFirstPolicy(extraction.source)
        const normal = prepared.units.find((u) => u.source === paragraph)!
        expect(Boolean(row.referenceBoundary)).toBe(fault === 'none')
        expect(Boolean(normal.sourceOnly)).toBe(fault !== 'none')
        const real = prepared.units.find(
          (u) => u.source === 'References' && u.fragments[0].pageNumber === 3
        )!
        expect(real.sourceOnly).toBe(true)
        expect(real.preserve).toBe('reference')
        expect(extraction.source.units.map((u) => u.source)).toEqual(
          prepared.units.map((u) => u.source)
        )
        expect(extraction.source.units.map((u) => u.id)).toEqual(prepared.units.map((u) => u.id))
      } finally {
        await f.loading.destroy()
      }
    }
  )
})

describe('native wrapped algorithm continuation', () => {
  const fixture = async (
    fault: 'none' | 'missing-prefix' | 'font' | 'standalone' | 'colon-intro' | 'control-body'
  ) => {
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const fonts =
      path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')) +
      '/standard_fonts/'
    const font = await pdf.embedFont(await readFile(fonts + 'LiberationSans-Regular.ttf'))
    const bold = await pdf.embedFont(await readFile(fonts + 'LiberationSans-Bold.ttf'))
    const page = pdf.addPage([600, 800]),
      regularKey = page.node.newFontDictionary(font.name, font.ref),
      boldKey = page.node.newFontDictionary(bold.name, bold.ref)
    const line = (value: string, x: number, y: number, heading = false) =>
      page.pushOperators(
        pushGraphicsState(),
        beginText(),
        setFontAndSize(heading ? boldKey : regularKey, heading ? 12 : 10),
        setTextMatrix(1, 0, 0, 1, x, y),
        PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [
          pdf.context.obj(
            value
              .split(' ')
              .flatMap((word, i) =>
                i
                  ? [
                      (-(heading ? bold : font).widthOfTextAtSize(' ', heading ? 12 : 10) /
                        (heading ? 12 : 10)) *
                        1000,
                      (heading ? bold : font).encodeText(word)
                    ]
                  : [(heading ? bold : font).encodeText(word)]
              )
          )
        ]),
        endText(),
        popGraphicsState()
      )
    if (fault !== 'missing-prefix')
      line(
        fault === 'colon-intro'
          ? 'The generated procedure is described below:'
          : fault === 'standalone'
            ? 'An independent earlier paragraph ends here.'
            : 'The complete explanation compares two generated constructions, and',
        60,
        720
      )
    line('Algorithm 7 continues the ordinary account of these constructions.', 50, 706)
    line('Several ordinary values are examined for each comparison,', 50, 692)
    line('The complete explanation stays within one paragraph while values remain exact.', 60, 678)
    line('A final ordinary conclusion describes the verified result.', 60, 664)
    if (fault === 'control-body') line('return generatedResult', 60, 650)
    line('1.2 Further discussion', 50, 630, true)
    line('The next complete section remains ordinary body prose.', 60, 610)
    const loading = getDocument({
        data: await pdf.save(),
        fontExtraProperties: true,
        useSystemFonts: false,
        isEvalSupported: false,
        standardFontDataUrl: fonts
      }),
      actual = await loading.promise
    const original = await actual.getPage(1)
    const pageProxy =
      fault !== 'font'
        ? original
        : new Proxy(original, {
            get(t, k) {
              if (k === 'getTextContent')
                return async () => {
                  const c = await t.getTextContent()
                  for (const f of Object.values(c.styles)) f.ascent = 0
                  return c
                }
              const v = Reflect.get(t, k, t)
              return typeof v === 'function' ? v.bind(t) : v
            }
          })
    const getPage = async () => pageProxy
    return {
      loading,
      document: new Proxy(actual, {
        get(t, k) {
          if (k === 'getPage') return getPage
          const v = Reflect.get(t, k, t)
          return typeof v === 'function' ? v.bind(t) : v
        }
      })
    }
  }
  it.each(['none', 'missing-prefix', 'font', 'standalone', 'colon-intro', 'control-body'] as const)(
    'requires a complete native ordinary continuation: %s',
    async (fault) => {
      const f = await fixture(fault)
      try {
        const e = await extractPdfTranslationSource({
          document: f.document,
          resourceRequestKey: 'generated-wrapped-prose',
          signal: new AbortController().signal
        })
        const target = e.source.units.find((u) => u.source.includes('A final ordinary conclusion'))!
        expect(Boolean(target.sourceOnly)).toBe(fault !== 'none')
        expect(target.preserve).toBe(fault === 'none' ? undefined : 'code')
      } finally {
        await f.loading.destroy()
      }
    }
  )
})

import { applyCachedPdfFigureSources } from '../../src/reader/figure-source.js'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'

describe('complete terminal figure pages after a bibliography', () => {
  const line = (
    page: PDFPage,
    font: PDFFont,
    value: string,
    x: number,
    y: number,
    size = 10,
    finish = true
  ) => {
    const key = page.node.newFontDictionary(font.name, font.ref)
    page.pushOperators(
      pushGraphicsState(),
      beginText(),
      setFontAndSize(key, size),
      setTextMatrix(1, 0, 0, 1, x, y),
      PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [
        page.doc.context.obj(
          value
            .split(' ')
            .flatMap((word, n) =>
              n
                ? [(-font.widthOfTextAtSize(' ', size) / size) * 1000, font.encodeText(word)]
                : [font.encodeText(word)]
            )
        )
      ]),
      ...(finish ? [endText(), popGraphicsState()] : [])
    )
  }
  it.each([
    'complete',
    'pattern',
    'pattern-transparent',
    'pattern-cross',
    'number-gap',
    'open-record',
    'foreign-prose',
    'overlap',
    'later-prose',
    'book-source-mismatch',
    'late-font-change',
    'pattern-text',
    'pattern-resource',
    'missing-form-clip',
    'missing-path-envelope',
    'unclosed-clip',
    'pattern-outside',
    'one-figure',
    'late-evidence-clone',
    'late-suffix-evidence',
    'late-window-replace',
    'late-page-identity',
    'moved-caption',
    'matrix-overflow',
    'cancelled',
    'late-unreliable',
    'late-unreliable-values',
    'constructor-rect',
    'constructor-key',
    'constructor-fingerprint',
    'constructor-page-size',
    'constructor-clone',
    'constructor-reorder',
    'constructor-reuse',
    'snapshot-depth',
    'split-marker',
    'split-marker-canonical-space',
    'split-marker-space-width',
    'split-marker-space-baseline',
    'split-marker-space-reference',
    'split-marker-baseline',
    'split-marker-font',
    'split-marker-no-space',
    'split-marker-oversized',
    'whole-marker-oversized',
    'two-form-boundary',
    'two-form-open-end',
    'two-form-shared-end',
    'figure-roundtrip',
    'post-layout-stale',
    'raw-book-edit'
  ] as const)(
    'requires whole native bibliography, float, outside Source and live evidence: %s',
    async (fault) => {
      const pdf = await PDFDocument.create()
      const require = createRequire(import.meta.url),
        assets = path.dirname(require.resolve('pdfjs-dist/package.json')) + '/standard_fonts/'
      const fontkit = require('fontkit')
      pdf.registerFontkit(fontkit)
      const font = await pdf.embedFont(await readFile(assets + 'LiberationSans-Regular.ttf'))
      const bold = await pdf.embedFont(await readFile(assets + 'LiberationSans-Bold.ttf'))
      if (fault === 'figure-roundtrip') {
        const page = pdf.addPage([600, 800])
        line(page, font, 'Generated axis label', 60, 600)
        line(page, font, 'Figure 1. An independent chart.', 60, 540)
        line(page, font, '1', 296, 45)
      }
      if (fault === 'late-window-replace')
        line(
          pdf.addPage([600, 800]),
          font,
          'A complete earlier ordinary paragraph precedes the independently numbered bibliography and all following drawings.',
          60,
          700
        )
      const bookPageNumber = pdf.getPageCount() + 1
      const bibliography = pdf.addPage([600, 800])
      line(bibliography, bold, 'References', 60, 740, 14)
      for (let n = 1; n <= 4; n++) {
        line(
          bibliography,
          font,
          `[${fault === 'number-gap' && n === 4 ? 5 : n}] A. Writer. A generated independent publication.`,
          60,
          690 - n * 40
        )
        line(
          bibliography,
          font,
          `Journal of Anonymous Examples 10, 11-20 (200${n})${fault === 'open-record' && n === 4 ? '' : '.'}`,
          80,
          676 - n * 40
        )
      }
      line(bibliography, font, String(bookPageNumber), 296, 45)
      const captions: string[] = []
      const drawingDocument = await PDFDocument.create()
      drawingDocument.registerFontkit(fontkit)
      const drawingFont = await drawingDocument.embedFont(
          await readFile(assets + 'LiberationSans-Regular.ttf')
        ),
        drawing = drawingDocument.addPage([480, 300])
      drawing.drawLine({ start: { x: 20, y: 20 }, end: { x: 440, y: 20 } })
      drawing.drawLine({ start: { x: 20, y: 20 }, end: { x: 20, y: 280 } })
      drawing.drawLine({ start: { x: 25, y: 25 }, end: { x: 420, y: 250 } })
      line(drawing, drawingFont, '0 1 2 3', 40, 5)
      line(drawing, drawingFont, 'Observed value', 200, 35)
      if (fault.startsWith('pattern')) {
        const extra =
          fault === 'pattern-text'
            ? ' BT /F1 8 Tf 1 0 0 1 1 1 Tm (Hidden) Tj ET'
            : fault === 'pattern-resource'
              ? ' q /GS1 gs Q'
              : ''
        const resources =
          fault === 'pattern-text'
            ? { Font: { F1: drawingFont.ref } }
            : fault === 'pattern-resource'
              ? { ExtGState: { GS1: drawingDocument.context.obj({ Type: 'ExtGState', ca: 0.5 }) } }
              : {}
        const pattern = drawingDocument.context.register(
          drawingDocument.context.flateStream(
            (fault === 'pattern-transparent'
              ? '0 0 0 RG 0 0 0 rg 1 w '
              : '0 0 0 RG 0.5 0.5 0.5 rg 0 0 10 10 re f 0 0 0 rg 1 w ') +
              '-5 5 m 5 15 l 0 0 m 10 10 l 5 -5 m 15 5 l ' +
              (fault === 'pattern-cross' ? '-5 5 m 5 -5 l 0 10 m 10 0 l 5 15 m 15 5 l ' : '') +
              (fault === 'pattern' ? 'S' : 'B') +
              extra,
            {
              Type: 'Pattern',
              PatternType: 1,
              PaintType: 1,
              TilingType: 1,
              BBox: [0, 0, 10, 10],
              XStep: 10,
              YStep: 10,
              Resources: resources
            }
          )
        )
        drawing.node
          .Resources()!
          .set(PDFName.of('Pattern'), drawingDocument.context.obj({ GeneratedHatch: pattern }))
        drawing.pushOperators(
          pushGraphicsState(),
          PDFOperator.of(PDFOperatorNames.NonStrokingColorspace, [PDFName.of('Pattern')]),
          PDFOperator.of(PDFOperatorNames.NonStrokingColorN, [PDFName.of('GeneratedHatch')]),
          rectangle(100, 100, 100, 80),
          fill(),
          popGraphicsState()
        )
      }
      const [form] = await pdf.embedPdf(await drawingDocument.save())
      let pairedPage: PDFPage | undefined
      for (let n = 1; n <= (fault === 'one-figure' ? 1 : 2); n++) {
        const label = fault.endsWith('marker-oversized') ? '9007199254740992' : String(n)
        const paired = fault.startsWith('two-form'),
          page = paired ? (pairedPage ??= pdf.addPage([600, 1200])) : pdf.addPage([600, 800])
        page.drawPage(form, {
          x: 60,
          y: paired ? (n === 1 ? 830 : 400) : 390,
          width: 480,
          height: 300
        })
        captions.push(
          `Fig. ${label} Complete generated observations show a stable measured trend across independent samples. The additional explanation preserves complete native context for every independent observation in the drawing.`
        )
        let y = paired ? (n === 1 ? 815 : 385) : fault === 'overlap' ? 400 : 375,
          current = ''
        const captionLine = (value: string, baseline: number) => {
          if (
            fault.startsWith('two-form-') &&
            fault !== 'two-form-boundary' &&
            n === 1 &&
            value.endsWith('drawing.')
          ) {
            line(page, font, value, 60, baseline, 10, false)
            if (fault === 'two-form-shared-end') {
              const key = page.node.newFontDictionary(bold.name, bold.ref)
              page.pushOperators(
                setFontAndSize(key, 10),
                setTextMatrix(1, 0, 0, 1, 60 + font.widthOfTextAtSize(value, 10) + 6, baseline),
                PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [
                  page.doc.context.obj([bold.encodeText('X')])
                ]),
                endText(),
                popGraphicsState()
              )
            }
            return
          }
          if (
            !fault.startsWith('split-marker') ||
            (n !== 2 && fault !== 'split-marker-oversized') ||
            !value.startsWith('Fig. ')
          ) {
            line(page, font, value, 60, baseline)
            return
          }
          const markerWidth = font.widthOfTextAtSize('Fig.', 10),
            number = label,
            numberFont = fault === 'split-marker-font' ? bold : font,
            numberX = 60 + markerWidth + (fault === 'split-marker-no-space' ? 0 : 6),
            titleX = numberX + numberFont.widthOfTextAtSize(number, 10) + 6
          line(page, font, 'Fig.', 60, baseline)
          line(
            page,
            numberFont,
            number,
            numberX,
            baseline + (fault === 'split-marker-baseline' ? 0.05 : 0)
          )
          line(page, font, value.slice(('Fig. ' + number + ' ').length), titleX, baseline)
        }
        for (const word of captions.at(-1)!.split(' ')) {
          const next = current ? current + ' ' + word : word
          if (font.widthOfTextAtSize(next, 10) > 480 && current) {
            captionLine(current, y)
            y -= 14
            current = word
          } else current = next
        }
        if (current) captionLine(current, y)
        if (fault === 'foreign-prose' && n === 2)
          line(
            page,
            font,
            'An independent body paragraph follows with a separate original source boundary.',
            60,
            100
          )
        if (!paired || n === 2) line(page, font, String((paired ? 1 : n) + bookPageNumber), 296, 45)
      }
      if (fault === 'later-prose')
        line(
          pdf.addPage([600, 800]),
          font,
          'A later ordinary section remains outside the figure pages and cannot be silently reclassified.',
          60,
          700
        )
      const data = await pdf.save()
      const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'),
        canvas = require('@napi-rs/canvas')
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: { createElement: () => canvas.createCanvas(1, 1) }
      })
      const loading = getDocument({
        data: data.slice(),
        fontExtraProperties: true,
        disableFontFace: true,
        useSystemFonts: false,
        isEvalSupported: false,
        standardFontDataUrl: assets
      })
      let restoreSpy = () => {}
      try {
        const actual = await loading.promise,
          proxies = new Map<number, PDFPageProxy>(),
          visits = new Map<number, number>()
        const controller = new AbortController(),
          factory = terminalBoundary.createNativeTerminalCaptionReader
        type RawPage = Parameters<ReturnType<typeof factory>['observe']>[0]['rawPage']
        const rawPages = new Map<number, RawPage>()
        const observedContexts = new Map<
          number,
          Parameters<ReturnType<typeof factory>['observe']>[0]
        >()
        let rawWindow: RawPage[] | undefined
        const spy = vi
          .spyOn(terminalBoundary, 'createNativeTerminalCaptionReader')
          .mockImplementation((options) => {
            const reader = factory(options)
            return {
              observe(input) {
                if (
                  [
                    'split-marker-canonical-space',
                    'split-marker-space-width',
                    'split-marker-space-baseline',
                    'split-marker-space-reference'
                  ].includes(fault) &&
                  input.rawPage.page === bookPageNumber + 2
                ) {
                  const space = input.rawPage.items.find((item) => item.str === ' ')
                  expect(space).toBeDefined()
                  if (fault === 'split-marker-space-width') space!.width += 0.001
                  if (fault === 'split-marker-space-baseline') space!.transform[5] += 0.001
                  if (fault === 'split-marker-canonical-space')
                    for (const item of input.rawPage.items)
                      if (!item.str.trim())
                        Object.assign(item, {
                          str: '',
                          width: 0,
                          height: 0,
                          dir: 'ltr',
                          transform: [0, 0, 0, 0, 0, 0]
                        })
                }
                if (fault === 'raw-book-edit' && input.rawPage.page === bookPageNumber) {
                  const item = input.rawPage.items.find((item) => item.str.includes('generated'))
                  if (item) item.str = item.str.replace('generated', 'fabricated')
                }
                observedContexts.set(input.rawPage.page, input)
                rawPages.set(input.rawPage.page, input.rawPage)
                reader.observe(input)
              },
              prepare(pages) {
                rawWindow = pages
                return reader.prepare(pages)
              }
            }
          })
        const bind = terminalBoundary.bindNativeTerminalCaptionLayout
        const constructorSpy = vi
          .spyOn(terminalBoundary, 'bindNativeTerminalCaptionLayout')
          .mockImplementation((layout, pages, identity) => {
            if (fault === 'snapshot-depth') {
              const chain: Record<string, unknown> = {}
              let tail = chain
              for (let depth = 0; depth < 40; depth++) {
                const next: Record<string, unknown> = {}
                tail.next = next
                tail = next
              }
              Reflect.set(layout.pages[bookPageNumber], 'anonymousSnapshotChain', chain)
            }
            const token = bind(layout, pages, identity)
            if (!token) return token
            return {
              observe(unit, data) {
                if (fault === 'constructor-rect' && data.source.startsWith('Fig.'))
                  Object.assign(data.fragments[0].rect, { x: data.fragments[0].rect.x + 0.001 })
                token.observe(unit, data)
              },
              create(input) {
                if (fault === 'split-marker-space-reference') {
                  const items = rawPages.get(bookPageNumber + 2)!.items,
                    index = items.findIndex((item) => item.str === ' ')
                  expect(index).toBeGreaterThanOrEqual(0)
                  items[index] = { ...items[index] }
                }
                if (fault === 'post-layout-stale')
                  rawPages.get(bookPageNumber)!.nativeReferenceEvidence = structuredClone(
                    rawPages.get(bookPageNumber)!.nativeReferenceEvidence
                  )
                if (fault === 'constructor-key')
                  return token.create({
                    ...input,
                    resourceRequestKey: 'a-different-anonymous-resource'
                  })
                if (fault === 'constructor-fingerprint')
                  return token.create({
                    ...input,
                    fingerprint: 'a-different-anonymous-fingerprint'
                  })
                if (fault === 'constructor-page-size')
                  return token.create({
                    ...input,
                    pages: input.pages.map((page) => ({ ...page, width: page.width + 1 }))
                  })
                if (fault === 'constructor-clone')
                  return token.create({ ...input, units: structuredClone(input.units) })
                if (fault === 'constructor-reorder')
                  return token.create({ ...input, units: [...input.units].reverse() })
                if (fault === 'constructor-reuse') token.create(input)
                return token.create(input)
              }
            }
          })
        restoreSpy = () => {
          constructorSpy.mockRestore()
          spy.mockRestore()
        }
        const getPage = async (number: number) => {
          const original = await actual.getPage(number)
          visits.set(number, (visits.get(number) ?? 0) + 1)
          if (
            fault === 'late-font-change' &&
            number === actual.numPages &&
            visits.get(number)! > 1
          ) {
            const first = await actual.getPage(bookPageNumber),
              content = await first.getTextContent(),
              item = content.items.find((item) => 'str' in item && item.str.trim())!
            if ('str' in item) first.commonObjs.get(item.fontName).data[0] ^= 1
          }
          if (number === actual.numPages && visits.get(number)! > 1) {
            if (fault === 'late-evidence-clone')
              rawPages.get(bookPageNumber)!.nativeReferenceEvidence = structuredClone(
                rawPages.get(bookPageNumber)!.nativeReferenceEvidence
              )
            if (fault === 'late-suffix-evidence')
              rawPages.get(bookPageNumber + 1)!.nativeSectionFontEvidence = { complete: false }
            if (fault === 'late-window-replace' && rawWindow) rawWindow[0] = { ...rawWindow[0] }
            if (fault === 'late-page-identity') return new Proxy(original, {})
            if (fault === 'cancelled') controller.abort(new Error('Generated cancellation'))
            if (fault === 'late-unreliable')
              observedContexts.get(bookPageNumber + 1)!.unreliable = new Set([0])
            if (fault === 'late-unreliable-values')
              (observedContexts.get(bookPageNumber + 1)!.unreliable as Set<number>).add(0)
          }
          if (proxies.has(number)) return proxies.get(number)!
          if (
            ![
              'book-source-mismatch',
              'missing-form-clip',
              'missing-path-envelope',
              'unclosed-clip',
              'pattern-outside',
              'moved-caption',
              'matrix-overflow'
            ].includes(fault)
          )
            return original
          const methods = new Map<PropertyKey, unknown>()
          const page = new Proxy(original, {
            get(target, key) {
              if (methods.has(key)) return methods.get(key)
              if (key === 'getOperatorList') {
                const readOperators = async () => {
                  const operators = await target.getOperatorList()
                  if (fault === 'book-source-mismatch' && number === bookPageNumber) {
                    const copy = structuredClone(operators),
                      at = copy.fnArray.findIndex((op) => op === OPS.showText)
                    copy.argsArray[at][0].find((g: unknown) => typeof g !== 'number').unicode = 'X'
                    return copy
                  }
                  if (
                    number > bookPageNumber &&
                    [
                      'missing-form-clip',
                      'missing-path-envelope',
                      'unclosed-clip',
                      'pattern-outside',
                      'moved-caption',
                      'matrix-overflow'
                    ].includes(fault)
                  ) {
                    const copy = structuredClone(operators),
                      begin = copy.fnArray.indexOf(OPS.paintFormXObjectBegin),
                      end = copy.fnArray.lastIndexOf(OPS.paintFormXObjectEnd)
                    if (fault === 'missing-form-clip') copy.argsArray[begin][1] = null
                    if (fault === 'missing-path-envelope')
                      copy.argsArray[copy.fnArray.indexOf(OPS.constructPath, begin)][2] = null
                    if (fault === 'unclosed-clip') {
                      copy.fnArray.splice(end, 0, OPS.clip)
                      copy.argsArray.splice(end, 0, [])
                    }
                    if (fault === 'pattern-outside') {
                      const at = copy.fnArray.indexOf(OPS.setFillColorN),
                        [op] = copy.fnArray.splice(at, 1),
                        [args] = copy.argsArray.splice(at, 1)
                      copy.fnArray.splice(end, 0, op)
                      copy.argsArray.splice(end, 0, args)
                    }
                    if (fault === 'matrix-overflow') {
                      copy.fnArray.splice(begin + 1, 0, OPS.transform, OPS.transform)
                      copy.argsArray.splice(
                        begin + 1,
                        0,
                        [Number.MAX_VALUE, 0, 0, Number.MAX_VALUE, 0, 0],
                        [Number.MAX_VALUE, 0, 0, Number.MAX_VALUE, 0, 0]
                      )
                    }
                    if (fault === 'moved-caption') {
                      const from = copy.fnArray.indexOf(OPS.beginText, end),
                        to = copy.fnArray.indexOf(OPS.endText, from)
                      const functions = copy.fnArray.splice(from, to - from + 1),
                        args = copy.argsArray.splice(from, to - from + 1)
                      copy.fnArray.splice(end, 0, ...functions)
                      copy.argsArray.splice(end, 0, ...args)
                    }
                    return copy
                  }
                  return operators
                }
                methods.set(key, readOperators)
                return readOperators
              }
              const value = Reflect.get(target, key, target)
              if (typeof value === 'function') {
                const bound = value.bind(target)
                methods.set(key, bound)
                return bound
              }
              return value
            }
          })
          proxies.set(number, page)
          return page
        }
        const document = new Proxy(actual, {
          get(target, key) {
            if (key === 'getPage') return getPage
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          }
        }) as PDFDocumentProxy
        if (fault.startsWith('two-form-')) {
          const page = await actual.getPage(bookPageNumber + 1),
            content = await page.getTextContent(),
            operators = await page.getOperatorList(),
            selected = new Set(
              content.items.flatMap((item, index) =>
                'str' in item && /^Fig\./u.test(item.str) ? [index] : []
              )
            ),
            regions = await nativeTerminalPlotCaptionInk(
              page,
              content,
              page.getViewport({ scale: 1 }),
              bookPageNumber + 1,
              selected,
              operators
            )
          if (fault === 'two-form-open-end') {
            expect(regions).toBeUndefined()
            return
          }
          expect(regions).toBeDefined()
          const scope = nativeTerminalPlotScope(regions!)!,
            last = content.items.findIndex((item) => 'str' in item && item.str.endsWith('drawing.'))
          expect(last).toBeGreaterThanOrEqual(0)
          if (fault === 'two-form-shared-end') {
            const unrelated = content.items.findIndex((item) => 'str' in item && item.str === 'X')
            expect(unrelated).toBeGreaterThan(last)
            expect(scope.membership.get(last)).toBeNull()
            expect(scope.membership.get(unrelated)).toBeNull()
            expect(scope.sourceTextEnds.has(last)).toBe(false)
            expect(operators.fnArray[scope.sourceTextEnds.get(unrelated)!]).toBe(OPS.endText)
            return
          }
          const end = content.items[last]
          expect('hasEOL' in end && end.hasEOL).toBe(false)
          expect(operators.fnArray[scope.sourceTextEnds.get(last)!]).toBe(OPS.endText)
          expect(scope.sourceTextEnds.get(last)).toBeGreaterThan(scope.forms[0].end!)
          expect(scope.sourceTextEnds.get(last)).toBeLessThan(scope.forms[1].begin)
        }
        const extractionPromise = extractPdfTranslationSource({
          document,
          resourceRequestKey: 'anonymous-terminal-figures',
          signal: controller.signal,
          sourceIdentity: {
            sourceChecksum: createHash('sha256').update(data).digest('hex'),
            sourceSizeBytes: data.length
          },
          nativeDocumentFactory: (options) => {
            if (
              !options ||
              typeof options === 'string' ||
              options instanceof URL ||
              options instanceof ArrayBuffer ||
              ArrayBuffer.isView(options)
            )
              return getDocument(options)
            return getDocument({ ...options, standardFontDataUrl: assets })
          }
        })
        if (fault === 'cancelled') {
          await expect(extractionPromise).rejects.toThrow('Generated cancellation')
          return
        }
        const extraction = await extractionPromise
        const prepared = applyPdfContentFirstPolicy(extraction.source)
        for (const source of [extraction.source, prepared]) {
          const selected = source.units.filter((u) =>
            fault.startsWith('split-marker')
              ? /^Fig\./u.test(u.source)
              : captions.includes(u.source)
          )
          expect(selected).toHaveLength(fault === 'one-figure' ? 1 : 2)
          const complete =
            fault === 'complete' ||
            fault === 'two-form-boundary' ||
            fault === 'figure-roundtrip' ||
            fault === 'split-marker' ||
            fault === 'split-marker-canonical-space' ||
            fault === 'pattern' ||
            fault === 'pattern-transparent' ||
            fault === 'pattern-cross'
          expect(selected.every((u) => !u.sourceOnly && !u.preserve)).toBe(complete)
          expect(selected.every((u) => hasNativeCaptionEligibility(source, u))).toBe(complete)
          expect(
            source.units
              .filter((u) => u.fragments.some((f) => f.pageNumber === bookPageNumber))
              .every((u) => u.sourceOnly && u.preserve === 'reference')
          ).toBe(true)
        }
        expect(prepared.units.map((u) => [u.id, u.source, u.fragments])).toEqual(
          extraction.source.units.map((u) => [u.id, u.source, u.fragments])
        )
        const serialized = createPdfTranslationSource(JSON.parse(JSON.stringify(extraction.source)))
        expect(serialized.units.some((u) => hasNativeCaptionEligibility(serialized, u))).toBe(false)
        if (fault === 'figure-roundtrip') {
          const source = extraction.source,
            owner = source.units.find((u) => u.source === 'Generated axis label')!,
            caption = source.units.find((u) => u.source === 'Figure 1. An independent chart.')!,
            box = owner.fragments[0].rect,
            region = {
              page: 1,
              x: box.x - 0.01,
              y: box.y - 0.01,
              width: box.width + 0.02,
              height: box.height + 0.02
            },
            identity = {
              sourceChecksum: createHash('sha256').update(data).digest('hex'),
              sourceSizeBytes: data.length
            },
            cached: PdfStructureResult = {
              schemaVersion: 1,
              extractionId: 'generated-native-structure',
              engineFingerprint: 'b'.repeat(64),
              ...identity,
              pageCount: actual.numPages,
              requestedPages: [1],
              processedPages: [1],
              pages: [{ page: 1, width: 600, height: 800, rotation: 0 }],
              elements: [
                {
                  id: 'generated-chart',
                  kind: 'figure',
                  issues: [],
                  regions: [region],
                  caption: {
                    text: caption.source,
                    regions: [{ page: 1, ...caption.fragments[0].rect }]
                  },
                  sourceItems: owner.fragments.flatMap((f) =>
                    f.items.map((i) => ({ pageNumber: f.pageNumber, ...i }))
                  )
                }
              ],
              thumbnails: [],
              navigation: [],
              issues: []
            }
          expect(owner.sourceOnly).toBeUndefined()
          const applied = await applyCachedPdfFigureSources({
            extraction,
            document: actual,
            sourceId: source.resourceRequestKey,
            sourceIdentity: identity,
            signal: controller.signal,
            readCached: async ({ page }) => (page === 1 ? cached : undefined)
          })
          expect(applied.source).not.toBe(source)
          expect(applied.source.units.find((u) => u.id === owner.id)?.sourceOnly).toBe(true)
          const nativeIds = source.units
            .filter((u) => hasNativeCaptionEligibility(source, u))
            .map((u) => u.id)
          expect(nativeIds).toHaveLength(2)
          expect(
            applied.source.units
              .filter((u) => hasNativeCaptionEligibility(applied.source, u))
              .map((u) => u.id)
          ).toEqual(nativeIds)
          for (const change of ['source', 'geometry'] as const) {
            const changed = createPdfTranslationSource({
                ...source,
                units: source.units.map((u) =>
                  u.id !== nativeIds[0]
                    ? u
                    : change === 'source'
                      ? { ...u, source: u.source + ' Altered.' }
                      : {
                          ...u,
                          fragments: u.fragments.map((f) => ({
                            ...f,
                            rect: { ...f.rect, x: f.rect.x + 0.001 }
                          }))
                        }
                )
              }),
              carried = carryNativeCaptionEligibility(source, changed)
            expect(carried.units.some((u) => hasNativeCaptionEligibility(carried, u))).toBe(false)
          }
        }
        if (fault === 'complete') {
          const page = await actual.getPage(bookPageNumber + 1),
            content = await page.getTextContent(),
            operators = await page.getOperatorList(),
            viewport = page.getViewport({ scale: 1 }),
            selected = new Set(
              content.items.flatMap((item, index) =>
                'str' in item && /^Fig\./u.test(item.str) ? [index] : []
              )
            ),
            sourceKey = JSON.stringify(content),
            operatorKey = JSON.stringify(operators)
          const regions = await nativeTerminalPlotCaptionInk(
            page,
            content,
            viewport,
            bookPageNumber + 1,
            selected,
            operators
          )
          expect(regions).toBeDefined()
          const scope = nativeTerminalPlotScope(regions!)!,
            members = [...scope.membership],
            ends = [...scope.sourceTextEnds]
          expect(Object.isFrozen(scope.forms)).toBe(true)
          expect(Reflect.set(scope.forms[0].bounds, '0', -1)).toBe(false)
          ;(scope.membership as Map<number, number | null>).clear()
          expect([...nativeTerminalPlotScope(regions!)!.membership]).toEqual(members)
          ;(scope.sourceTextEnds as Map<number, number>).clear()
          expect([...nativeTerminalPlotScope(regions!)!.sourceTextEnds]).toEqual(ends)
          const copied = new Map(
            [...regions!].map(([index, region]) => [index, Object.freeze({ ...region })])
          )
          expect(nativeTerminalPlotScope(copied)).toBeUndefined()
          carryNativeTerminalPlotScope(regions!, copied)
          const copiedScope = nativeTerminalPlotScope(copied)!
          ;(copiedScope.membership as Map<number, number | null>).clear()
          expect([...nativeTerminalPlotScope(copied)!.membership]).toEqual(members)
          expect([...nativeTerminalPlotScope(regions!)!.membership]).toEqual(members)
          ;(copiedScope.sourceTextEnds as Map<number, number>).clear()
          expect([...nativeTerminalPlotScope(copied)!.sourceTextEnds]).toEqual(ends)
          expect([...nativeTerminalPlotScope(regions!)!.sourceTextEnds]).toEqual(ends)
          expect(JSON.stringify(content)).toBe(sourceKey)
          expect(JSON.stringify(operators)).toBe(operatorKey)
          const begin = operators.fnArray.indexOf(OPS.paintFormXObjectBegin),
            overflow = structuredClone(operators)
          overflow.fnArray.splice(begin + 1, 0, OPS.transform, OPS.transform)
          overflow.argsArray.splice(
            begin + 1,
            0,
            [Number.MAX_VALUE, 0, 0, Number.MAX_VALUE, 0, 0],
            [Number.MAX_VALUE, 0, 0, Number.MAX_VALUE, 0, 0]
          )
          expect(
            await nativeTerminalPlotCaptionInk(
              page,
              content,
              viewport,
              bookPageNumber + 1,
              selected,
              overflow
            )
          ).toBeUndefined()
          let oversizedAllocations = 0
          const originalArrayFrom = Array.from,
            allocationSpy = vi.spyOn(Array, 'from')
          allocationSpy.mockImplementation(((
            value: Iterable<unknown> | ArrayLike<unknown>,
            ...args: unknown[]
          ) => {
            if (typeof value === 'string' && value.length > 64000) oversizedAllocations++
            return Reflect.apply(originalArrayFrom, Array, [value, ...args])
          }) as typeof Array.from)
          try {
            const tooManyGlyphs = structuredClone(operators),
              show = tooManyGlyphs.fnArray.indexOf(OPS.showText, begin),
              glyph = tooManyGlyphs.argsArray[show][0].find(
                (value: unknown) => value && typeof value === 'object' && 'unicode' in value
              )
            glyph.unicode = 'x'.repeat(64001)
            expect(
              await nativeTerminalPlotCaptionInk(
                page,
                content,
                viewport,
                bookPageNumber + 1,
                selected,
                tooManyGlyphs
              )
            ).toBeUndefined()
            const tooManySourceChars = structuredClone(content),
              item = tooManySourceChars.items.find((item) => 'str' in item && !!item.str.trim())!
            if ('str' in item) item.str = 'x'.repeat(64001)
            expect(
              await nativeTerminalPlotCaptionInk(
                page,
                tooManySourceChars,
                viewport,
                bookPageNumber + 1,
                selected,
                operators
              )
            ).toBeUndefined()
          } finally {
            allocationSpy.mockRestore()
          }
          expect(oversizedAllocations).toBe(0)
        }
      } finally {
        restoreSpy()
        await loading.destroy()
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
        else Reflect.deleteProperty(globalThis, 'document')
      }
    }
  )
})
