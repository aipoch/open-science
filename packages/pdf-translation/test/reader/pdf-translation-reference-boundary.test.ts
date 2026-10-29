/* eslint-disable @typescript-eslint/explicit-function-return-type -- retain inferred native fixture types */
import { describe, expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'
import {
  getPdfTranslationLayoutSnapshot,
  rememberPdfTranslationExtraction,
  restorePdfTranslationExtraction
} from '../../src/reader/snapshot.js'
import { pdfTranslationLayoutSnapshotSchema } from '../../src/snapshot.js'

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
