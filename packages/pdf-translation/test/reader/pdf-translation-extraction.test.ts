import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'
import { readPdfTranslationCases } from '../fixtures/read-cases'
/* eslint-disable @typescript-eslint/explicit-function-return-type -- retain inferred mock fixture types */
import { describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'
import { bindPdfTranslation } from '../../src/reader/source.js'
import { pdfTranslationLayoutFragments } from '../../src/reader/fragments.js'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { pdfTranslationLayoutSnapshotSchema } from '../../src/snapshot.js'
import {
  rememberPdfTranslationExtraction,
  getPdfTranslationLayoutSnapshot,
  restorePdfTranslationExtraction
} from '../../src/reader/snapshot.js'

const text = (str: string, x = 40, y = 100) => ({
  str,
  transform: [10, 0, 0, 10, x, 800 - y],
  width: 150,
  height: 10,
  dir: 'ltr',
  fontName: 'body',
  hasEOL: true
})
const nativeGlyphs = (str: string) =>
  [...str].map((unicode) => ({
    unicode,
    originalCharCode: unicode === '\u00a5' ? 165 : 2000 + unicode.codePointAt(0)!,
    isInFont: true
  }))
const setup = (items = [text('An intact source paragraph.')]) => {
  const page = {
    rotate: 0,
    getViewport: vi.fn(() => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] })),
    getTextContent: vi.fn().mockResolvedValue({ items }),
    cleanup: vi.fn()
  }
  const document = {
    numPages: 1,
    fingerprints: ['source'],
    getPage: vi.fn().mockResolvedValue(page),
    destroy: vi.fn()
  }
  const controller = new AbortController()
  const context = {
    document: document as unknown as PDFDocumentProxy,
    resourceRequestKey: 'current',
    signal: controller.signal
  }
  return { page, document, controller, context }
}

describe('extractPdfTranslationSource', () => {
  it.each([0, -0.9])('preserves a raised tensor power with script offset %s', async (offset) => {
    const run = (str: string, x: number, width: number, baseline = 500, height = 10) => ({
      ...text(str, x),
      transform: [height, 0, 0, height, x, baseline],
      width,
      height,
      hasEOL: false
    })
    const fixture = setup([
      run('The group acts on', 190, 100),
      run('⊗', 290, 11, 507.5),
      run('3', 301, 4, 505 + offset, 7),
      run('(', 305.5, 4),
      run('F', 309.5, 6),
      run(') by cyclic rotation.', 316, 90)
    ])
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    const power = source.units.find((unit) => unit.source === '⊗3')
    expect(power?.sourceOnly).toBe(offset === 0 ? true : undefined)
    expect(power?.preserve).toBe(offset === 0 ? 'literal' : undefined)
    expect(power?.fragments[0].items).toEqual([
      { index: 1, text: '⊗' },
      { index: 2, text: '3' }
    ])
    expect(source.units.filter((u) => !u.sourceOnly && u !== power).map((u) => u.source)).toEqual([
      'The group acts on',
      ') by cyclic rotation.'
    ])
    expect(coverage).toMatchObject({ includedItemCount: 6, excludedItemCount: 0 })
  })

  it.each([
    { drift: 0, witness: 'geometric', spelling: 'geometrical' },
    { drift: 0, witness: 'geo-metrical', spelling: 'geo-metrical' },
    { drift: 0, witness: 'curved', spelling: undefined },
    { drift: 2, witness: 'geometric', spelling: undefined }
  ])(
    'joins an attested word across the native prose margin ($witness, $drift)',
    async ({ drift, witness, spelling }) => {
      const run = (
        source: string,
        x: number,
        width: number,
        fontName = 'body',
        baseline = 500,
        hasEOL = false
      ) => ({
        ...text(source, x),
        transform: [10, 0, 0, 10, x, baseline],
        width,
        height: source.trim() ? 10 : 0,
        fontName,
        hasEOL
      })
      const lead = 'is the stored result computed from a geo-'
      const tail = 'metrical correction and the fixed boundary'
      const items = [
        run(
          `The ${witness} model captures the shape of the entire region.`,
          130,
          200,
          'body',
          650,
          true
        ),
        run('where', 120, 25.54),
        run(' ', 145.54, 3.38),
        run('Q', 148.92, 6.11, 'italic'),
        run('(', 155.64, 3.87),
        run('s', 159.48, 3.6, 'italic'),
        run(') = Tr', 163.08, 27.9),
        run('(', 190.92, 4.56, 'delimiter', 508),
        run('θ', 195.6, 5.15, 'italic'),
        run('(', 200.76, 3.87),
        run('s', 204.6, 3.6, 'italic'),
        run(') ln', 208.2, 13.81),
        run(' ', 222.01, 1.67),
        run('θ', 223.68, 5.15, 'italic'),
        run('(', 228.84, 3.87),
        run('s', 232.68, 3.6, 'italic'),
        run(')', 236.28, 3.87),
        run(')', 240.12, 4.56, 'delimiter', 508),
        run(' ', 244.68, 3.48, 'delimiter', 508),
        run(lead, 248.16, 209, 'body', 500, true),
        run(tail, 120 + drift, 207, 'body', 488)
      ]
      const fixture = setup(items)
      const font = { ascent: 0.75, descent: -0.25, vertical: false }
      fixture.page.getTextContent.mockResolvedValue({
        items,
        styles: {
          body: font,
          italic: font,
          delimiter: { ...font, ascent: 0.04, descent: -1.759 }
        }
      })
      const { source, coverage } = await extractPdfTranslationSource(fixture.context)
      const math = source.units.find((unit) => unit.source === 'θ(s) ln θ(s)')
      expect(math).toMatchObject({ sourceOnly: true, preserve: 'formula' })
      expect(
        math?.fragments.flatMap((fragment) => fragment.items.map(({ index }) => index))
      ).toEqual([8, 9, 10, 11, 13, 14, 15, 16])
      const expected = spelling
        ? [`is the stored result computed from a ${spelling} correction and the fixed boundary`]
        : [lead, tail]
      const prose = source.units.filter(({ source }) => expected.includes(source))
      expect(prose.map(({ source }) => source)).toEqual(expected)
      expect(prose.flatMap(({ fragments }) => fragments.map(({ items }) => items))).toEqual([
        [{ index: 19, text: lead }],
        [{ index: 20, text: tail }]
      ])
      expect(coverage).toMatchObject({
        textItemCount: 18,
        includedItemCount: 18,
        excludedItemCount: 0
      })
    }
  )

  it('keeps only an isolated native square out of translation', async () => {
    const inputs = ['□', '◻', 'A □ marks an empty cell.', 'Translate the neighboring sentence.']
    const items = inputs.map((source, index) => text(source, 40, 80 + index * 55))
    const fixture = setup(items)
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    const square = source.units.find((unit) => unit.source === '□')
    expect(square).toMatchObject({ sourceOnly: true, preserve: 'literal' })
    expect(square?.fragments.flatMap((fragment) => fragment.items)).toEqual([
      { index: 0, text: '□' }
    ])
    expect(source.units.filter((unit) => !unit.sourceOnly).map((unit) => unit.source)).toEqual(
      inputs.slice(1)
    )
    expect(coverage).toMatchObject({ includedItemCount: 4, excludedItemCount: 0 })
  })

  it.each([0, 9])(
    'preserves whole bundled scientific rows when column drift is %s',
    async (drift) => {
      const values = Array.from({ length: 9 }, (_, index) => `${index + 1}.25·10 ¹`)
      const sentence = 'The upper bound was 2.25·10 ¹ during calibration.'
      const items = values.map((value, index) => {
        const row = Math.floor(index / 3)
        return {
          ...text(value, 65 + 70 * (index % 3) + drift * row, 180 + 20 * row),
          width: 38,
          fontName: 'numeric',
          hasEOL: index % 3 === 2
        }
      })
      items.push({ ...text(sentence, 40, 340), width: 250 })
      const fixture = setup(items)
      fixture.page.getTextContent.mockResolvedValue({
        items,
        styles: {
          numeric: { ascent: 0.8, descent: -0.2 },
          body: { vertical: false, ascent: 0.8, descent: -0.2 }
        }
      })
      const { source, coverage } = await extractPdfTranslationSource(fixture.context)
      for (let row = 0; row < 3; row++) {
        const cells = values.slice(3 * row, 3 * row + 3)
        const owner = source.units.find((unit) => unit.source === cells.join(' '))
        expect(owner?.fragments.flatMap((fragment) => fragment.items)).toEqual(
          cells.map((text, column) => ({ index: 3 * row + column, text }))
        )
        expect(owner?.sourceOnly).toBe(drift === 0 ? true : undefined)
      }
      expect(source.units.find((unit) => unit.source === sentence)).toMatchObject({
        source: sentence
      })
      expect(source.units.find((unit) => unit.source === sentence)?.sourceOnly).toBeUndefined()
      expect(coverage).toMatchObject({ includedItemCount: items.length, excludedItemCount: 0 })
    }
  )

  it('rejects stripped native clip provenance after restore while preserving the existing page-edge tolerance', async () => {
    for (const overflow of [0, 1e-7]) {
      const item = { ...text('A complete native sentence.', 590, 40), width: 10 + overflow * 600 }
      const fixture = setup([item])
      fixture.page.getTextContent.mockResolvedValue({
        items: [item],
        styles: { body: { vertical: false, ascent: 0.8, descent: -0.2 } }
      })
      const extraction = await extractPdfTranslationSource(fixture.context)
      const unit = extraction.source.units[0]
      expect(unit.sourceOnly).toBeUndefined()
      expect(
        await bindPdfTranslation(
          extraction.source,
          {
            source: extraction.source,
            units: [{ id: unit.id, translationSource: unit.source, translation: 'Translated' }]
          },
          fixture.context.document,
          'current',
          fixture.controller.signal
        )
      ).not.toBeNull()
    }
    const items = [
      { ...text('Native prefix', 590, 40), width: 30 },
      text('An intact ordinary sentence.', 40, 100)
    ]
    const fixture = setup(items)
    fixture.page.getTextContent.mockResolvedValue({
      items,
      styles: { body: { vertical: false, ascent: 0.8, descent: -0.2 } }
    })
    const original = await extractPdfTranslationSource(fixture.context)
    const extraction = { ...original, source: applyPdfContentFirstPolicy(original.source) }
    rememberPdfTranslationExtraction(extraction)
    const snapshot = getPdfTranslationLayoutSnapshot(extraction.source)!
    const restored = restorePdfTranslationExtraction(
      pdfTranslationLayoutSnapshotSchema.parse(snapshot),
      'current'
    )
    const ordinary = restored.source.units.find((u) => !u.sourceOnly)!
    expect(
      await bindPdfTranslation(
        restored.source,
        {
          source: restored.source,
          units: [
            { id: ordinary.id, translationSource: ordinary.source, translation: 'Translated' }
          ]
        },
        fixture.context.document,
        'current',
        fixture.controller.signal
      )
    ).not.toBeNull()
    for (const rename of [false, true]) {
      const stripped = structuredClone(snapshot)
      const unit = stripped.units.find((u) => u.fragments.some((f) => f.unclippedRect))!
      stripped.coverage.warnings = stripped.coverage.warnings.filter((w) => w.unitId !== unit.id)
      delete unit.fragments[0].unclippedRect
      delete unit.sourceOnly
      if (rename) unit.id = 'ordinary-restored-owner'
      const candidate = restorePdfTranslationExtraction(
        pdfTranslationLayoutSnapshotSchema.parse(stripped),
        'current'
      )
      expect(
        await bindPdfTranslation(
          candidate.source,
          {
            source: candidate.source,
            units: [{ id: unit.id, translationSource: unit.source, translation: 'Translated' }]
          },
          fixture.context.document,
          'current',
          fixture.controller.signal
        )
      ).toBeNull()
    }
  })
  it.each(['complete', 'missing-font', 'nonuniform', 'sheared', 'no-intersection'])(
    'retains only proved partial native navigation and its complete provenance: %s',
    async (proof) => {
      const item = { ...text('Native prefix', 590, 40), width: 30 }
      if (proof === 'missing-font') item.fontName = ''
      if (proof === 'nonuniform') item.transform[0] = 20
      if (proof === 'sheared') item.transform[2] = 1
      if (proof === 'no-intersection') item.transform[4] = 610
      const fixture = setup([item])
      fixture.page.getTextContent.mockResolvedValue({
        items: [item],
        styles: { body: { vertical: false, ascent: 0.8, descent: -0.2 } }
      })
      const extraction = await extractPdfTranslationSource(fixture.context)
      if (proof !== 'complete') {
        expect(extraction.source.units).toEqual([])
        expect(extraction.coverage.excludedItemCount).toBe(1)
        return
      }
      expect(extraction.source.units).toEqual([
        {
          id: 'clipped-p1-i0',
          source: item.str,
          sourceOnly: true,
          fragments: [
            {
              pageNumber: 1,
              rect: {
                x: 590 / 600,
                y: 32 / 800,
                width: 1 - 590 / 600,
                height: 32 / 800 + 10 / 800 - 32 / 800
              },
              unclippedRect: { x: 590 / 600, y: 32 / 800, width: 30 / 600, height: 10 / 800 },
              items: [{ index: 0, text: item.str }]
            }
          ]
        }
      ])
      expect(extraction.coverage.warnings).toContainEqual({
        unitId: 'clipped-p1-i0',
        reasons: ['partially-outside-page']
      })
      const prepared = { ...extraction, source: applyPdfContentFirstPolicy(extraction.source) }
      expect(prepared.source.units).toEqual(extraction.source.units)
      expect(prepared.source.originalRegions).toEqual([])
      rememberPdfTranslationExtraction(prepared)
      const snapshot = getPdfTranslationLayoutSnapshot(prepared.source)!
      expect(pdfTranslationLayoutSnapshotSchema.safeParse(snapshot).success).toBe(true)
      const restored = restorePdfTranslationExtraction(snapshot, 'current')!
      expect(restored.source.units).toEqual(extraction.source.units)
      expect(pdfTranslationLayoutFragments(restored.source.units[0], restored.source)).toEqual(
        restored.source.units[0].fragments
      )
      for (const mutate of [
        (s: typeof snapshot) => {
          delete s.units[0].sourceOnly
        },
        (s: typeof snapshot) => {
          s.coverage.warnings = []
        },
        (s: typeof snapshot) => {
          s.units[0].fragments[0].rect.width /= 2
        }
      ]) {
        const invalid = structuredClone(snapshot)
        mutate(invalid)
        expect(pdfTranslationLayoutSnapshotSchema.safeParse(invalid).success).toBe(false)
      }
    }
  )
  it.each(['inside', 'missing-font', 'invalid-geometry', 'outside'])(
    'keeps only a proved page-in peer from an excluded group: %s',
    async (proof) => {
      const items = [
        { ...text('Label', 10, 40), width: 30, hasEOL: false },
        { ...text('Peer', 45, 40), width: 570, hasEOL: false }
      ]
      items[1].transform[0] = 20
      if (proof === 'missing-font') items[0].fontName = ''
      if (proof === 'invalid-geometry') items[0].width = Number.NaN
      if (proof === 'outside') {
        items[0].transform[4] = -1
        items[0].transform[0] = 20
      }
      const fixture = setup(items)
      fixture.page.getTextContent.mockResolvedValue({
        items,
        styles: { body: { vertical: false, ascent: 0.8, descent: -0.2 } }
      })
      const { source, coverage } = await extractPdfTranslationSource(fixture.context)
      expect(source.units).toEqual(
        proof === 'inside'
          ? [
              {
                id: 'inpage-p1-i0',
                source: 'Label',
                sourceOnly: true,
                fragments: [
                  {
                    pageNumber: 1,
                    rect: { x: 10 / 600, y: 32 / 800, width: 30 / 600, height: 10 / 800 },
                    items: [{ index: 0, text: 'Label' }]
                  }
                ]
              }
            ]
          : []
      )
      expect(coverage.exclusions.flatMap((entry) => entry.items)).toEqual(
        items.flatMap((item, index) =>
          proof === 'inside' && index === 0 ? [] : [{ pageNumber: 1, index, text: item.str }]
        )
      )
      expect(coverage.includedItemCount + coverage.excludedItemCount).toBe(2)
    }
  )
  const simpleControl = (str = '\u0001') => {
    const items = [text(str)]
    const fixture = setup(items)
    const font = {
      name: 'EmbeddedMath',
      composite: false,
      missingFile: false,
      vertical: false,
      isType3Font: false,
      toUnicode: { _map: {} as Record<number, string | undefined> }
    }
    const glyph = { unicode: str, originalCharCode: str.charCodeAt(0), isInFont: true }
    const operators = {
      fnArray: [OPS.setFont, OPS.showText],
      argsArray: [['body', 10], [[glyph]]]
    }
    Object.assign(fixture.page, {
      commonObjs: { has: () => true, get: () => font },
      getOperatorList: vi.fn().mockResolvedValue(operators)
    })
    return { ...fixture, items, font, glyph, operators }
  }

  it('marks an owned missing simple-font control without changing text or eligibility', async () => {
    const fixture = simpleControl()
    const before = await extractPdfTranslationSource(setup(fixture.items).context)
    const actual = await extractPdfTranslationSource(fixture.context)
    expect(actual.source).toEqual(before.source)
    expect(actual.coverage).toEqual({
      ...before.coverage,
      warnings: before.coverage.warnings.map((warning) => ({
        ...warning,
        reasons: [...warning.reasons, 'unreliable-font-unicode']
      }))
    })
    expect(actual.coverage.warnings.flatMap((warning) => warning.reasons)).toContain(
      'unreliable-font-unicode'
    )
  })

  const missingControl = (str: string, mapped = false, width = 150) => {
    const fixture = setup([{ ...text(str), width }])
    const glyphs = [...str].map((unicode) => ({
      unicode,
      originalCharCode: unicode.charCodeAt(0),
      isInFont: true
    }))
    const map = Object.fromEntries(
      glyphs
        .filter((glyph) => mapped || glyph.originalCharCode >= 32)
        .map((glyph) => [glyph.originalCharCode, glyph.unicode])
    )
    Object.assign(fixture.page, {
      commonObjs: { has: () => true, get: () => ({ composite: true, toUnicode: { _map: map } }) },
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['body', 10], [glyphs]]
      })
    })
    return fixture
  }

  it.each([
    { str: '\u0000\u001c\u0011', opaque: true },
    { str: 'Keep the visible \u0000 label.', opaque: false }
  ])(
    'retains only an opaque NUL-bearing run without a translation request',
    async ({ str, opaque }) => {
      const { source, coverage } = await extractPdfTranslationSource(setup([text(str)]).context)
      expect(source.units).toHaveLength(1)
      const [unit] = source.units
      expect(unit.source).toBe(str)
      expect(unit.sourceOnly).toBe(opaque ? true : undefined)
      expect(unit.fragments[0].items).toEqual([{ index: 0, text: str }])
      const warnings = coverage.warnings.flatMap(({ reasons }) => reasons)
      expect(warnings.includes('unreliable-font-unicode')).toBe(opaque)
    }
  )

  it('retains a proven missing-Unicode small owner only as original', async () => {
    const str = '\u0012 X',
      fixture = missingControl(str)
    const before = await extractPdfTranslationSource(setup([text(str)]).context)
    const actual = await extractPdfTranslationSource(fixture.context)
    expect(actual.coverage).toEqual({
      ...before.coverage,
      warnings: [{ unitId: before.source.units[0].id, reasons: ['unreliable-font-unicode'] }]
    })
    expect(before.source.units).toHaveLength(1)
    expect(before.source.units[0].sourceOnly).toBeUndefined()
    expect(actual.source.units).toEqual([{ ...before.source.units[0], sourceOnly: true }])
    expect(applyPdfContentFirstPolicy(actual.source).units).toEqual(actual.source.units)
  })

  it.each([
    'An ordinary unchanged \u0001 sentence retains translation eligibility.',
    '\u0003 oi',
    '\t X',
    '\n X',
    '\r X'
  ])('keeps ordinary, mixed-word and legal-whitespace admission unchanged (%s)', async (str) => {
    const fixture = missingControl(str)
    const before = await extractPdfTranslationSource(setup([text(str)]).context)
    const actual = await extractPdfTranslationSource(fixture.context)
    expect(actual.source).toEqual(before.source)
    expect(actual.coverage.excludedItemCount).toBe(before.coverage.excludedItemCount)
  })

  it.each(['mapped', 'unavailable', 'zero advance'])(
    'does not infer missing-Unicode small-owner admission from %s',
    async (variant) => {
      const str = '\u0012 X',
        width = variant === 'zero advance' ? 0 : 150
      const fixture =
        variant === 'unavailable'
          ? setup([text(str)])
          : missingControl(str, variant === 'mapped', width)
      const before = await extractPdfTranslationSource(setup([{ ...text(str), width }]).context)
      const actual = await extractPdfTranslationSource(fixture.context)
      expect(actual.source).toEqual(before.source)
      if (variant !== 'zero advance')
        expect(actual.coverage.warnings).toEqual(before.coverage.warnings)
    }
  )

  const symbolicFallback = () => {
    const fixture = simpleControl('&')
    const font = Object.assign(fixture.font, {
      type: 'TrueType',
      isSymbolicFont: true,
      toFontChar: { 38: 0xe004 } as Record<number, number | undefined>
    })
    const glyph = Object.assign(fixture.glyph, { fontChar: '\ue004' })
    return { ...fixture, font, glyph }
  }

  it.each([
    'native',
    'named-glyph',
    'inherited-name',
    'mapped',
    'different-slot',
    'incomplete-stream'
  ])('warns only for a complete unmapped numeric Type1 glyph name: %s', async (variant) => {
    const fixture = symbolicFallback()
    fixture.font.type = 'Type1'
    const font = Object.assign(fixture.font, {
      differences: Object.assign([] as string[], { 38: 'gid00017' })
    })
    if (variant === 'named-glyph') font.differences[38] = 'ampersand'
    if (variant === 'inherited-name') font.differences = Object.create(font.differences)
    if (variant === 'mapped') font.toUnicode._map[38] = '&'
    if (variant === 'different-slot') fixture.glyph.fontChar = '\ue005'
    if (variant === 'incomplete-stream') fixture.items[0].str += 'A'
    const indexes: number[] = []
    const actual = await getPdfTranslationTextContent(
      fixture.page as unknown as PDFPageProxy,
      (flagged) => indexes.push(...flagged)
    )
    expect(indexes).toEqual(variant === 'native' ? [0] : [])
    expect(actual.items).toEqual(fixture.items)
  })

  it('marks an embedded symbolic render slot with no Unicode mapping while retaining its native source', async () => {
    const fixture = symbolicFallback()
    const before = await extractPdfTranslationSource(setup(fixture.items).context)
    const actual = await extractPdfTranslationSource(fixture.context)
    expect(actual.source).toEqual(before.source)
    expect(actual.coverage.warnings.flatMap((warning) => warning.reasons)).toContain(
      'unreliable-font-unicode'
    )
    const indexes: number[] = []
    const native = await getPdfTranslationTextContent(
      fixture.page as unknown as PDFPageProxy,
      (flagged) => indexes.push(...flagged)
    )
    expect(indexes).toEqual([0])
    expect(native.items).toEqual(fixture.items)
  })

  it('distinguishes equal printable Unicode from an unmapped slot in the same font stream', async () => {
    const fixture = symbolicFallback()
    fixture.items.push(text('&', 200, 100))
    fixture.font.toUnicode._map[99] = '&'
    fixture.font.toFontChar[99] = 0xe005
    Object.assign(fixture.operators, {
      fnArray: [OPS.setFont, OPS.showText, OPS.showText],
      argsArray: [
        ['body', 10],
        [[fixture.glyph]],
        [[{ unicode: '&', originalCharCode: 99, fontChar: '\ue005', isInFont: true }]]
      ]
    })
    const indexes: number[] = []
    const actual = await getPdfTranslationTextContent(
      fixture.page as unknown as PDFPageProxy,
      (flagged) => indexes.push(...flagged)
    )
    expect(indexes).toEqual([0])
    expect(actual.items).toEqual(fixture.items)
  })

  it.each([
    'ordinary font',
    'unknown symbolic status',
    'different font type',
    'missing embedded font',
    'known Unicode mapping',
    'own undefined mapping',
    'unavailable Unicode map',
    'ordinary render slot',
    'different render slot',
    'inherited render slot',
    'multicharacter render slot',
    'unavailable render map',
    'different source code',
    'incomplete native stream'
  ])('does not flag a printable simple-font fallback from %s', async (variant) => {
    const fixture = symbolicFallback()
    if (variant === 'ordinary font') fixture.font.isSymbolicFont = false
    if (variant === 'unknown symbolic status')
      Reflect.deleteProperty(fixture.font, 'isSymbolicFont')
    if (variant === 'different font type') fixture.font.type = 'Type1'
    if (variant === 'missing embedded font') fixture.font.missingFile = true
    if (variant === 'known Unicode mapping') fixture.font.toUnicode._map[38] = '&'
    if (variant === 'own undefined mapping') fixture.font.toUnicode._map[38] = undefined
    if (variant === 'unavailable Unicode map') Reflect.deleteProperty(fixture.font, 'toUnicode')
    if (variant === 'ordinary render slot') {
      fixture.font.toFontChar[38] = 38
      fixture.glyph.fontChar = '&'
    }
    if (variant === 'different render slot') fixture.glyph.fontChar = '\ue005'
    if (variant === 'inherited render slot') fixture.font.toFontChar = Object.create({ 38: 0xe004 })
    if (variant === 'multicharacter render slot') fixture.glyph.fontChar += 'A'
    if (variant === 'unavailable render map') Reflect.deleteProperty(fixture.font, 'toFontChar')
    if (variant === 'different source code') fixture.glyph.originalCharCode = 39
    if (variant === 'incomplete native stream') fixture.items[0].str += 'A'
    const indexes: number[] = []
    const actual = await getPdfTranslationTextContent(
      fixture.page as unknown as PDFPageProxy,
      (flagged) => indexes.push(...flagged)
    )
    expect(indexes).toEqual([])
    expect(actual.items).toEqual(fixture.items)
  })

  it.each([
    'mapped',
    'own undefined map entry',
    'missing font',
    'unavailable font',
    'vertical',
    'Type3',
    'accent',
    'space glyph',
    'unknown loading',
    'not in font',
    'different code',
    'incomplete stream',
    'tab',
    'line feed',
    'carriage return',
    'form feed',
    'ordinary character'
  ])('does not infer a simple-font decoding failure from %s', async (variant) => {
    const str =
      (
        {
          tab: '\t',
          'line feed': '\n',
          'carriage return': '\r',
          'form feed': '\f',
          'ordinary character': 'A'
        } as Record<string, string>
      )[variant] ?? '\u0001'
    const fixture = simpleControl(str)
    if (variant === 'mapped') fixture.font.toUnicode._map[1] = '\u0001'
    if (variant === 'own undefined map entry') fixture.font.toUnicode._map[1] = undefined
    if (variant === 'missing font') fixture.font.missingFile = true
    if (variant === 'unavailable font')
      Object.assign(fixture.page, { commonObjs: { has: () => false } })
    if (variant === 'vertical') fixture.font.vertical = true
    if (variant === 'Type3') fixture.font.isType3Font = true
    if (variant === 'accent') Object.assign(fixture.glyph, { accent: { fontChar: 'x' } })
    if (variant === 'space glyph') Object.assign(fixture.glyph, { isSpace: true })
    if (variant === 'unknown loading') Reflect.deleteProperty(fixture.font, 'missingFile')
    if (variant === 'not in font') fixture.glyph.isInFont = false
    if (variant === 'different code') fixture.glyph.originalCharCode = 2
    if (variant === 'incomplete stream') fixture.glyph.unicode += 'A'
    const flagged: number[] = []
    const result = await getPdfTranslationTextContent(
      fixture.page as unknown as PDFPageProxy,
      (indexes) => flagged.push(...indexes)
    )
    expect(flagged).toEqual([])
    expect(result.items).toEqual(fixture.items)
  })

  it.each([true, false])(
    'suppresses only an actually repaired native multiplication slot (repair=%s)',
    async (repair) => {
      const fixture = simpleControl('\u0002')
      fixture.font.name = 'txsys'
      fixture.items[0].width = repair ? 6.36 : 7
      const flagged: number[] = []
      const result = await getPdfTranslationTextContent(
        fixture.page as unknown as PDFPageProxy,
        (indexes) => flagged.push(...indexes)
      )
      expect(flagged).toEqual(repair ? [] : [0])
      expect(result.items).toEqual([{ ...fixture.items[0], str: repair ? '×' : '\u0002' }])
    }
  )

  const unownedGlyph = () => {
    const fixture = setup()
    const font = {
      missingFile: false,
      vertical: false,
      loadedName: 'unrepresented',
      toUnicode: { _map: {} as Record<number, string> }
    }
    const outline = { path: [0, 0.05, -0.08, 1, 0.72, -0.08, 1, 0.72, 0.58, 4] }
    const glyph = { unicode: '\f', originalCharCode: 12, fontChar: '\ue00c', isInFont: true }
    const operators = {
      fnArray: [OPS.beginText, OPS.setFont, OPS.moveText, OPS.showText, OPS.endText],
      argsArray: [[], ['unrepresented', 10], [200, 400], [[glyph]], []] as unknown[][]
    }
    Object.assign(fixture.page, {
      view: [0, 0, 600, 800],
      commonObjs: {
        has: () => true,
        get: (key: string) => (key.includes('_path_') ? outline : font)
      },
      getOperatorList: vi.fn().mockResolvedValue(operators)
    })
    return { ...fixture, font, glyph, operators, outline }
  }

  it('reports an unowned painted glyph at page scope without changing source or eligibility', async () => {
    const fixture = unownedGlyph()
    const previous = await extractPdfTranslationSource(setup().context)
    const actual = await extractPdfTranslationSource(fixture.context)
    expect(actual.source).toEqual(previous.source)
    expect(actual.coverage).toEqual({
      ...previous.coverage,
      pageDiagnostics: [{ pageNumber: 1, reason: 'unreliable-font-unicode' }]
    })
  })

  it.each([
    'mapped',
    'missing font',
    'empty outline',
    'zero-area outline',
    'unknown outline command',
    'truncated outline',
    'native owner',
    'invisible',
    'transparent',
    'clip',
    'soft mask',
    'unknown state',
    'outside page',
    'nonfirst glyph'
  ])('does not invent an unowned page diagnostic for %s', async (variant) => {
    const fixture = unownedGlyph()
    if (variant === 'mapped') fixture.font.toUnicode._map[12] = 'symbol'
    if (variant === 'missing font') fixture.font.missingFile = true
    if (variant === 'empty outline') fixture.outline.path = [0, 0, 0]
    if (variant === 'zero-area outline') fixture.outline.path = [0, 0, 0, 1, 1, 1, 4]
    if (variant === 'unknown outline command') fixture.outline.path.push(99)
    if (variant === 'truncated outline') fixture.outline.path.push(2, 1)
    if (variant === 'native owner')
      fixture.page.getTextContent.mockResolvedValue({
        items: [{ ...text('known'), fontName: 'unrepresented' }]
      })
    if (variant === 'outside page') fixture.operators.argsArray[2] = [-100, 400]
    if (variant === 'nonfirst glyph') {
      fixture.operators.fnArray.splice(3, 0, OPS.showText)
      fixture.operators.argsArray.splice(3, 0, [[{ ...fixture.glyph, unicode: 'a' }]])
    }
    const state: Record<string, [number, unknown[]]> = {
      invisible: [OPS.setTextRenderingMode, [3]],
      transparent: [OPS.setGState, [[['ca', 0]]]],
      clip: [OPS.clip, []],
      'soft mask': [OPS.setGState, [[['SMask', {}]]]],
      'unknown state': [OPS.setGState, [[['Unknown', 1]]]]
    }
    if (state[variant]) {
      fixture.operators.fnArray.splice(3, 0, state[variant][0])
      fixture.operators.argsArray.splice(3, 0, state[variant][1])
    }
    expect(
      (await extractPdfTranslationSource(fixture.context)).coverage.pageDiagnostics
    ).toBeUndefined()
  })

  it.each(['contained', 'clipped', 'unknown clip', 'restored state'])(
    'requires a proved Form clip and restores saved paint state: %s',
    async (variant) => {
      const f = unownedGlyph()
      f.operators.fnArray.unshift(OPS.paintFormXObjectBegin)
      f.operators.argsArray.unshift([
        null,
        variant === 'clipped'
          ? [0, 0, 50, 50]
          : variant === 'unknown clip'
            ? null
            : [0, 0, 500, 700]
      ])
      f.operators.fnArray.push(OPS.paintFormXObjectEnd)
      f.operators.argsArray.push([])
      if (variant === 'restored state') {
        f.operators.fnArray.splice(1, 0, OPS.save, OPS.setGState, OPS.clip, OPS.restore)
        f.operators.argsArray.splice(
          1,
          0,
          [],
          [
            [
              ['ca', 0],
              ['SMask', {}],
              ['Font', ['other', 9]]
            ]
          ],
          [],
          []
        )
      }
      const actual = await extractPdfTranslationSource(f.context)
      expect(actual.coverage.pageDiagnostics).toEqual(
        ['contained', 'restored state'].includes(variant)
          ? [{ pageNumber: 1, reason: 'unreliable-font-unicode' }]
          : undefined
      )
    }
  )

  it('deduplicates page evidence and preserves it through a saved snapshot roundtrip', async () => {
    const f = unownedGlyph()
    f.operators.fnArray.push(...f.operators.fnArray)
    f.operators.argsArray.push(...f.operators.argsArray)
    const actual = await extractPdfTranslationSource(f.context)
    expect(actual.coverage.pageDiagnostics).toHaveLength(1)
    rememberPdfTranslationExtraction(actual)
    const stored = pdfTranslationLayoutSnapshotSchema.parse(
      JSON.parse(JSON.stringify(getPdfTranslationLayoutSnapshot(actual.source)))
    )
    const restored = restorePdfTranslationExtraction(stored, 'current')
    expect(restored).toEqual(actual)
  })

  it('validates optional page diagnostics while retaining the old snapshot shape', async () => {
    const actual = await extractPdfTranslationSource(setup().context)
    const snapshot = {
      version: 1,
      parserVersion: 'test',
      fingerprint: 'source',
      pages: actual.source.pages,
      units: actual.source.units,
      coverage: actual.coverage
    }
    expect(pdfTranslationLayoutSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    const withDiagnostics = (diagnostics: unknown) => ({
      ...snapshot,
      coverage: { ...snapshot.coverage, pageDiagnostics: diagnostics }
    })
    const diagnostic = { pageNumber: 1, reason: 'unreliable-font-unicode' }
    expect(pdfTranslationLayoutSnapshotSchema.parse(withDiagnostics([diagnostic]))).toEqual(
      withDiagnostics([diagnostic])
    )
    for (const invalid of [
      [{ ...diagnostic, pageNumber: 2 }],
      [diagnostic, diagnostic],
      [{ ...diagnostic, reason: 'guessed' }],
      [{ ...diagnostic, unitId: 'unrelated' }]
    ])
      expect(pdfTranslationLayoutSnapshotSchema.safeParse(withDiagnostics(invalid)).success).toBe(
        false
      )
  })

  it.each([
    'different text',
    'extra glyph',
    'missing glyph',
    'normalized ligature',
    'unknown glyph'
  ])(
    'does not assign Unicode occurrences from an incomplete font stream with %s',
    async (variant) => {
      const fixture = setup([text('\u00a5A')])
      const glyphs: unknown[] = nativeGlyphs('\u00a5A')
      if (variant === 'different text') glyphs[1] = nativeGlyphs('B')[0]
      if (variant === 'extra glyph') glyphs.push(...nativeGlyphs('B'))
      if (variant === 'missing glyph') glyphs.pop()
      if (variant === 'normalized ligature') {
        fixture.page.getTextContent.mockResolvedValue({ items: [text('\u00a5fi')] })
        glyphs[1] = nativeGlyphs('\ufb01')[0]
      }
      if (variant === 'unknown glyph') glyphs.push({ originalCharCode: 999 })
      Object.assign(fixture.page, {
        commonObjs: { has: () => true, get: () => ({ composite: true, toUnicode: { _map: {} } }) },
        getOperatorList: vi.fn().mockResolvedValue({
          fnArray: [OPS.setFont, OPS.showText],
          argsArray: [['body', 10], [glyphs]]
        })
      })
      const { coverage } = await extractPdfTranslationSource(fixture.context)
      expect(coverage.warnings.flatMap((warning) => warning.reasons)).not.toContain(
        'unreliable-font-unicode'
      )
    }
  )

  it('aligns literal UTF16 offsets after whitespace without confusing a repeated mapped character', async () => {
    const items = [text(' 😀 \u00a5 ', 40, 100), text('\u00a5', 40, 300)]
    const fixture = setup(items)
    Object.assign(fixture.page, {
      commonObjs: {
        has: () => true,
        get: () => ({ composite: true, toUnicode: { _map: { 999: '\u00a5' } } })
      },
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [
          ['body', 10],
          [
            [
              ...nativeGlyphs('😀\t\u00a5\n'),
              { originalCharCode: 999, unicode: '\u00a5', isInFont: true }
            ]
          ]
        ]
      })
    })
    const flagged: number[] = []
    const content = await getPdfTranslationTextContent(
      fixture.page as unknown as PDFPageProxy,
      (indexes) => flagged.push(...indexes)
    )
    expect(flagged).toEqual([0])
    expect(content.items).toEqual(items)
  })

  it.each([
    [OPS.save, OPS.restore],
    [OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd],
    [OPS.beginGroup, OPS.endGroup]
  ])('restores font ownership around native graphics scope %i/%i', async (begin, end) => {
    const fixture = setup([
      text('\u00a5', 40, 100),
      { ...text('A', 40, 200), fontName: 'mapped' },
      text('\u00a5', 40, 300)
    ])
    Object.assign(fixture.page, {
      commonObjs: { has: () => true, get: () => ({ composite: true, toUnicode: { _map: {} } }) },
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [OPS.setFont, OPS.showText, begin, OPS.setGState, OPS.showText, end, OPS.showText],
        argsArray: [
          ['body', 10],
          [nativeGlyphs('\u00a5')],
          [],
          [[['Font', ['mapped', 10]]]],
          [nativeGlyphs('A')],
          [],
          [nativeGlyphs('\u00a5')]
        ]
      })
    })
    const flagged: number[] = []
    await getPdfTranslationTextContent(fixture.page as unknown as PDFPageProxy, (indexes) =>
      flagged.push(...indexes)
    )
    expect(flagged).toEqual([0, 2])
  })

  it('warns only the unmapped CID occurrence when the same font maps another CID to the same Unicode', async () => {
    const fixture = setup([text('\u00a5', 40, 100), text('\u00a5', 40, 300)])
    Object.assign(fixture.page, {
      commonObjs: {
        has: () => true,
        get: () => ({ composite: true, toUnicode: { _map: { 999: '\u00a5' } } })
      },
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [OPS.setFont, OPS.showText, OPS.showText],
        argsArray: [
          ['body', 10],
          [[{ originalCharCode: 165, unicode: '\u00a5', isInFont: true }]],
          [[{ originalCharCode: 999, unicode: '\u00a5', isInFont: true }]]
        ]
      })
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    const warnings = coverage.warnings.filter((warning) =>
      warning.reasons.includes('unreliable-font-unicode')
    )
    expect(warnings).toHaveLength(1)
    expect(source.units.find((unit) => unit.id === warnings[0].unitId)?.fragments[0].items).toEqual(
      [{ index: 0, text: '\u00a5' }]
    )
    expect(
      source.units.flatMap((unit) => unit.fragments.flatMap((fragment) => fragment.items))
    ).toEqual([
      { index: 0, text: '\u00a5' },
      { index: 1, text: '\u00a5' }
    ])
  })

  it('retains the Unicode warning on an independently recovered rotated source unit', async () => {
    const fixture = setup([{ ...text('\u00a5'), transform: [0, 10, -10, 0, 200, 200] }])
    Object.assign(fixture.page, {
      commonObjs: { has: () => true, get: () => ({ composite: true, toUnicode: { _map: {} } }) },
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['body', 10], [[{ originalCharCode: 165, unicode: '\u00a5', isInFont: true }]]]
      })
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units[0]).toMatchObject({ id: 'rot-p1-i0', source: '\u00a5', sourceOnly: true })
    expect(coverage.warnings).toContainEqual({
      unitId: 'rot-p1-i0',
      reasons: ['unreliable-font-unicode']
    })
  })

  it.each([
    ['mapped currency', { composite: true, toUnicode: { _map: { 165: '\u00a5' } } }, true],
    ['simple font', { composite: false, toUnicode: { _map: {} } }, true],
    ['absent metadata', { composite: true }, true],
    [
      'identity Unicode map',
      { composite: true, toUnicode: { firstChar: 0, lastChar: 65535 } },
      true
    ],
    [
      'missing embedded font',
      { composite: true, missingFile: true, toUnicode: { _map: {} } },
      true
    ],
    ['unpainted missing glyph', { composite: true, toUnicode: { _map: {} } }, false]
  ])('does not infer decoding failure from %s', async (_name, font, isInFont) => {
    const fixture = setup([text('\u00a5')])
    Object.assign(fixture.page, {
      commonObjs: { has: () => true, get: () => font },
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['body', 10], [[{ originalCharCode: 165, unicode: '\u00a5', isInFont }]]]
      })
    })
    const { coverage } = await extractPdfTranslationSource(fixture.context)
    expect(coverage.warnings.flatMap((warning) => warning.reasons)).not.toContain(
      'unreliable-font-unicode'
    )
  })

  it('tracks font changes through graphics state without warning unrelated fonts', async () => {
    const fixture = setup([
      text('An unchanged \u00a5 label.'),
      { ...text('Another \u00a5 label.', 40, 200), fontName: 'mapped' }
    ])
    Object.assign(fixture.page, {
      commonObjs: {
        has: () => true,
        get: (name: string) => ({
          composite: true,
          toUnicode: { _map: name === 'body' ? {} : { 165: '\u00a5' } }
        })
      },
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [OPS.setFont, OPS.save, OPS.setGState, OPS.showText, OPS.restore, OPS.showText],
        argsArray: [
          ['body', 10],
          [],
          [[['Font', ['mapped', 10]]]],
          [nativeGlyphs('Another \u00a5 label.')],
          [],
          [nativeGlyphs('An unchanged \u00a5 label.')]
        ]
      })
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    const warned = coverage.warnings.filter((warning) =>
      warning.reasons.includes('unreliable-font-unicode')
    )
    expect(warned).toHaveLength(1)
    expect(source.units.find((unit) => unit.id === warned[0].unitId)?.source).toBe(
      'An unchanged \u00a5 label.'
    )
  })

  it('preserves extraction when optional font diagnostics are unavailable', async () => {
    const fixture = setup()
    Object.assign(fixture.page, {
      commonObjs: { has: () => true },
      getOperatorList: vi.fn().mockRejectedValue(new Error('Unavailable operator metadata'))
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units[0].source).toBe('An intact source paragraph.')
    expect(coverage.excludedItemCount).toBe(0)
    expect(coverage.warnings).toEqual([])
  })

  it('retains text and flags units using a painted CID with no Unicode mapping', async () => {
    const fixture = setup([text('An unchanged \u00a5 label.')])
    const font = { composite: true, toUnicode: { _map: { 65: 'A' } } }
    Object.assign(fixture.page, {
      commonObjs: { has: () => true, get: () => font },
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [OPS.setFont, OPS.showText],
        argsArray: [['body', 10], [nativeGlyphs('An unchanged \u00a5 label.')]]
      })
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units[0].source).toBe('An unchanged \u00a5 label.')
    expect(source.units[0].sourceOnly).toBeUndefined()
    expect(coverage.excludedItemCount).toBe(0)
    expect(coverage.warnings).toContainEqual({
      unitId: source.units[0].id,
      reasons: ['unreliable-font-unicode']
    })
  })

  it.each(
    (
      [
        ['CMEX10', 'P', 80, 1055.6],
        ['txex', 'Z', 90, 640]
      ] as const
    ).flatMap(([face, symbol, slot, advance]) =>
      ['unmapped', 'mapped', 'body font'].map((kind) => ({ face, symbol, slot, advance, kind }))
    )
  )(
    'keeps the native $face operator outline and its extracted spelling ($kind)',
    async ({ face, symbol, slot, advance, kind }) => {
      const paragraph = 'An independent sentence about the measurements.'
      const mark = { ...text(symbol, 300, 180), width: advance / 100, fontName: 'math' }
      const fixture = setup([text(paragraph), mark])
      const font = {
        name: kind === 'body font' ? 'Body' : 'ABCDEF+' + face,
        type: 'Type1',
        composite: false,
        missingFile: false,
        isInvalidPDFjsFont: false,
        systemFontInfo: null,
        defaultEncoding: { [slot]: symbol },
        widths: { [slot]: advance },
        toFontChar: { [slot]: 0xe100 },
        toUnicode: { _map: kind === 'mapped' ? { [slot]: symbol } : {} }
      }
      const glyph = {
        unicode: symbol,
        originalCharCode: slot,
        fontChar: '\ue100',
        width: advance,
        isInFont: true
      }
      Object.assign(fixture.page, {
        commonObjs: { has: () => true, get: (name: string) => (name === 'math' ? font : {}) },
        getOperatorList: vi.fn().mockResolvedValue({
          fnArray: [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
          argsArray: [['body', 10], [nativeGlyphs(paragraph)], ['math', 10], [[glyph]]]
        })
      })
      const { source, coverage } = await extractPdfTranslationSource(fixture.context)
      const owner = source.units.find((unit) => unit.source === symbol)
      expect(owner?.fragments.flatMap((fragment) => fragment.items)).toEqual([
        { index: 1, text: symbol }
      ])
      expect(owner?.preserve).toBe(kind === 'unmapped' ? 'formula' : undefined)
      expect(owner?.sourceOnly).toBe(kind === 'unmapped' ? true : undefined)
      expect(source.units.find((unit) => unit.source === paragraph)?.sourceOnly).toBeUndefined()
      expect(
        coverage.warnings.some(
          ({ unitId, reasons }) =>
            unitId === owner?.id && reasons.includes('unreliable-font-unicode')
        )
      ).toBe(kind === 'unmapped')
    }
  )

  it.each([
    ['ÿ', 184, 1110.8, 'product', true],
    ['ź', 185, 1277.5, 'pi', true],
    ['ÿ', 184, 1050, 'product', false]
  ] as const)(
    'keeps known extension-font operators on the native page (%s, %i, %f)',
    async (symbol, slot, advance, encoding, retained) => {
      const paragraph = 'An independent sentence about the comparison.'
      const fixture = setup([
        text(paragraph),
        { ...text(symbol, 300, 180), width: advance / 100, fontName: 'math' }
      ])
      const font = {
        name: 'ABCDEF+TeX-mathx10',
        type: 'Type1',
        composite: false,
        missingFile: false,
        isInvalidPDFjsFont: false,
        systemFontInfo: null,
        defaultEncoding: { [slot]: encoding },
        widths: { [slot]: advance },
        toFontChar: { [slot]: 0xe100 },
        toUnicode: { _map: { [slot]: symbol } }
      }
      const glyph = {
        unicode: symbol,
        originalCharCode: slot,
        fontChar: '\ue100',
        width: advance,
        isInFont: true
      }
      Object.assign(fixture.page, {
        commonObjs: { has: () => true, get: (name: string) => (name === 'math' ? font : {}) },
        getOperatorList: vi.fn().mockResolvedValue({
          fnArray: [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
          argsArray: [['body', 10], [nativeGlyphs(paragraph)], ['math', 10], [[glyph]]]
        })
      })
      const { source } = await extractPdfTranslationSource(fixture.context)
      const owner = source.units.find((unit) => unit.source === symbol)
      expect(owner?.fragments.flatMap((fragment) => fragment.items)).toEqual([
        { index: 1, text: symbol }
      ])
      expect(owner?.preserve).toBe(retained ? 'formula' : undefined)
      expect(owner?.sourceOnly).toBe(retained ? true : undefined)
      expect(source.units.find((unit) => unit.source === paragraph)?.sourceOnly).toBeUndefined()
    }
  )
  it.each(['reordered', 'mapped peer', 'another face'])(
    'preserves only standalone native math runs with proved unmapped glyphs (%s)',
    async (shape) => {
      const math = ['\u0be1', '\u0bde']
      const prose = 'This sentence provides independent context.'
      const runs = math.map((symbol, i) => ({
        ...text(symbol, 351, 130 + i * 30),
        width: 8,
        fontName: 'math'
      }))
      const items = [text(prose), ...runs]
      if (shape === 'mapped peer') items.push({ ...runs[0], transform: [10, 0, 0, 10, 351, 610] })
      const fixture = setup(items)
      const missing = math.map((unicode, i) => ({
        originalCharCode: unicode.charCodeAt(0),
        unicode,
        fontChar: String.fromCharCode(0xe100 + i),
        isInFont: true
      }))
      const mapped = { ...missing[0], originalCharCode: 880, fontChar: '\ue102' }
      const font = {
        name: shape === 'another face' ? 'Body' : 'ABCDEF+CambriaMath',
        type: 'CIDFontType2',
        composite: true,
        missingFile: false,
        toUnicode: { _map: shape === 'mapped peer' ? { 880: math[0] } : {} },
        toFontChar: Object.fromEntries(
          [...missing, mapped].map((g) => [g.originalCharCode, g.fontChar.charCodeAt(0)])
        )
      }
      Object.assign(fixture.page, {
        commonObjs: { has: () => true, get: (name: string) => (name === 'math' ? font : {}) },
        getOperatorList: vi.fn().mockResolvedValue({
          fnArray: [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
          argsArray: [
            ['body', 10],
            [nativeGlyphs(prose)],
            ['math', 10],
            [shape === 'mapped peer' ? [missing[1], mapped, missing[0]] : [...missing].reverse()]
          ]
        })
      })
      const { source } = await extractPdfTranslationSource(fixture.context)
      expect(source.units.find((unit) => unit.source === prose)?.sourceOnly).toBeUndefined()
      const marks = source.units.filter((unit) => math.includes(unit.source))
      expect(marks).toHaveLength(shape === 'mapped peer' ? 3 : 2)
      for (const mark of marks) {
        const proved = shape === 'reordered' || (shape === 'mapped peer' && mark.source === math[1])
        expect(mark.sourceOnly).toBe(proved ? true : undefined)
        expect(mark.preserve).toBe(proved ? 'formula' : undefined)
      }
    }
  )

  it.each([
    ['uses a', true],
    ['uses the', undefined]
  ] as const)(
    'keeps only matching unfinished math tails in the source (%s)',
    async (second, kept) => {
      const invalid = ['\u0bea', '\u0beb', '\u0bec']
      const run = (
        str: string,
        x: number,
        baseline: number,
        width: number,
        height: number,
        fontName: string,
        hasEOL = false
      ) => ({
        ...text(str, x, 800 - baseline),
        width,
        height,
        fontName,
        transform: [height, 0, 0, height, x, baseline],
        hasEOL
      })
      const items = [
        run(invalid[2], 499, 395, 4, 6, 'math'),
        run('', 0, 0, 0, 0, 'math', true),
        run(invalid[0], 495, 389, 5, 7.5, 'math'),
        run('uses', 510, 393, 17, 11, 'body'),
        run('a', 533, 393, 11, 11, 'body', true),
        run(invalid[1], 494, 380, 10, 8, 'math'),
        run(')', 504, 377, 5, 11, 'math'),
        run(second, 513, 377, 31, 11, 'body', true)
      ]
      const fixture = setup(items)
      fixture.page.getTextContent.mockResolvedValue({
        items,
        styles: {
          math: { ascent: 0.78, descent: -0.22, vertical: false },
          body: { ascent: 0.89, descent: -0.22, vertical: false }
        }
      })
      const malformed = invalid.map((unicode, index) => ({
        originalCharCode: unicode.charCodeAt(0),
        unicode,
        fontChar: String.fromCharCode(0xe110 + index),
        isInFont: true
      }))
      const math = {
        name: 'ABCDEF+CambriaMath',
        type: 'CIDFontType2',
        composite: true,
        missingFile: false,
        toUnicode: { _map: { 41: ')' } },
        toFontChar: Object.fromEntries(
          malformed.map((glyph) => [glyph.originalCharCode, glyph.fontChar.charCodeAt(0)])
        )
      }
      Object.assign(fixture.page, {
        commonObjs: { has: () => true, get: (name: string) => (name === 'math' ? math : {}) },
        getOperatorList: vi.fn().mockResolvedValue({
          fnArray: [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
          argsArray: [
            ['math', 10],
            [
              [
                malformed[2],
                malformed[0],
                malformed[1],
                { unicode: ')', originalCharCode: 41, isInFont: true }
              ]
            ],
            ['body', 10],
            [nativeGlyphs('uses a' + second)]
          ]
        })
      })
      const { source, coverage } = await extractPdfTranslationSource(fixture.context)
      const owner = source.units.find(
        (unit) => unit.source.includes('uses a') && unit.source.includes(second)
      )!
      expect(owner.source).toBe(`${invalid[0]} uses a ${invalid[1]}) ${second}`)
      expect(owner.sourceOnly).toBe(kept)
      expect(owner.preserve).toBeUndefined()
      expect(owner.fragments.map(({ items: row }) => row.map(({ index }) => index))).toEqual([
        [2, 3, 4],
        [5, 6, 7]
      ])
      expect(coverage.excludedItemCount).toBe(0)
      expect(coverage.warnings).toContainEqual({
        unitId: owner.id,
        reasons: ['unreliable-font-unicode']
      })
    }
  )

  it('uses existing line regions when a merged caption box would enclose a neighboring column', async () => {
    const items = [
      { ...text('Table 1. Characteristics of trial participants', 40, 100), width: 480 },
      { ...text('Category', 40, 112), width: 80 },
      { ...text('Control', 300, 112), width: 80 }
    ]
    const fixture = setup(items)
    const previous = groupPdfTranslationPages({
      pages: [{ page: 1, width: 600, height: 800, rotation: 0, items }]
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units.map((u) => ({ id: u.id, source: u.source }))).toEqual(
      previous.units.map((u) => ({ id: u.id, source: u.source }))
    )
    const merged = source.units.find((u) => u.source.includes('Characteristics'))!
    expect(merged.fragments).toHaveLength(2)
    expect(merged.fragments.map((f) => f.items.map((i) => i.index))).toEqual([[0], [1]])
    expect(merged.fragments[1].rect.x + merged.fragments[1].rect.width).toBeLessThan(300 / 600)
    expect(coverage.includedItemCount).toBe(3)
    expect(coverage.excludedItemCount).toBe(0)
  })

  it.each([
    [0, 10, -10, 0],
    [0, -10, 10, 0],
    [-10, 0, 0, -10]
  ])('retains orthogonal rotated source independently (%s,%s,%s,%s)', async (a, b, c, d) => {
    const fixture = setup([
      text('Original prose.'),
      { ...text('−56⋅6'), width: 40, transform: [a, b, c, d, 300, 400] }
    ])
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(coverage).toMatchObject({ includedItemCount: 2, excludedItemCount: 0 })
    expect(source.units[0].sourceOnly).toBeUndefined()
    expect(source.units[1]).toMatchObject({ id: 'rot-p1-i1', source: '−56⋅6', sourceOnly: true })
    expect(source.units[1].fragments[0].items).toEqual([{ index: 1, text: '−56⋅6' }])
    const r = source.units[1].fragments[0].rect
    expect(r.width * 600 * r.height * 800).toBeCloseTo(400)
    expect(Object.isFrozen(source.units[1])).toBe(true)
    const record = (u: (typeof source.units)[number]) => ({
      id: u.id,
      translationSource: u.source,
      translation: 'Diagnostic'
    })
    expect(
      (
        await bindPdfTranslation(
          source,
          { source, units: [record(source.units[0])] },
          fixture.context.document,
          'current',
          fixture.context.signal
        )
      )?.units
    ).toHaveLength(1)
    expect(
      await bindPdfTranslation(
        source,
        { source, units: source.units.map(record) },
        fixture.context.document,
        'current',
        fixture.context.signal
      )
    ).toBeNull()
  })
  it.each([11, -37, 137])(
    'retains a proved slanted native label independently at %s degrees',
    async (angle) => {
      const radians = (angle * Math.PI) / 180,
        a = 10 * Math.cos(radians),
        b = 10 * Math.sin(radians)
      const items = [
        text('Original prose.'),
        { ...text('Graph label'), width: 40, transform: [a, b, -b, a, 300, 400] }
      ]
      const fixture = setup(items)
      fixture.page.getTextContent.mockResolvedValue({
        items,
        styles: { body: { vertical: false, ascent: 0.8, descent: -0.2 } }
      })
      const { source, coverage } = await extractPdfTranslationSource(fixture.context)
      expect(coverage).toMatchObject({ includedItemCount: 2, excludedItemCount: 0 })
      expect(source.units[0].sourceOnly).toBeUndefined()
      expect(source.units[1]).toMatchObject({
        id: 'rot-p1-i1',
        source: 'Graph label',
        sourceOnly: true
      })
      expect(source.units[1].fragments[0].items).toEqual([{ index: 1, text: 'Graph label' }])
      const r = source.units[1].fragments[0].rect
      expect([r.x, r.y, r.width, r.height].every(Number.isFinite)).toBe(true)
      expect(r.x + r.width).toBeLessThan(1)
      expect(r.y + r.height).toBeLessThan(1)
    }
  )
  it.each([
    'missing-style',
    'missing-ascent',
    'missing-descent',
    'unknown-vertical',
    'vertical',
    'shear',
    'reflection',
    'outside-page'
  ])('does not recover a slanted label without complete navigation evidence: %s', async (fault) => {
    const items = [{ ...text('Graph label'), width: 40, transform: [8, 6, -6, 8, 300, 400] }]
    const fixture = setup(items),
      style: { vertical?: boolean; ascent?: number; descent?: number } = {
        vertical: false,
        ascent: 0.8,
        descent: -0.2
      }
    if (fault === 'missing-ascent') delete style.ascent
    if (fault === 'missing-descent') delete style.descent
    if (fault === 'unknown-vertical') delete style.vertical
    if (fault === 'vertical') style.vertical = true
    if (fault === 'shear') items[0].transform[2] = -5
    if (fault === 'reflection') {
      items[0].transform[2] = 6
      items[0].transform[3] = -8
    }
    if (fault === 'outside-page') items[0].transform[4] = 599
    fixture.page.getTextContent.mockResolvedValue({
      items,
      styles: fault === 'missing-style' ? {} : { body: style }
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units).toHaveLength(0)
    expect(coverage.excludedItemCount).toBe(1)
  })
  it('keeps individual table symbols with zero font metrics and does not merge rows', async () => {
    const fixture = setup(
      ['56', '⋅', '6', '−'].map((str, index) => ({
        ...text(str),
        width: 5,
        transform: [0, 10, -10, 0, 200, 300 + index * 5]
      }))
    )
    fixture.page.getTextContent.mockResolvedValue({
      items: ['56', '⋅', '6', '−'].map((str, index) => ({
        ...text(str),
        width: 5,
        transform: [0, 10, -10, 0, 200, 300 + index * 5]
      })),
      styles: { body: { ascent: 0, descent: 0 } }
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units.map((u) => u.source)).toEqual(['56', '⋅', '6', '−'])
    expect(source.units.every((u) => u.sourceOnly && u.fragments[0].rect.width > 0)).toBe(true)
    expect(coverage.excludedItemCount).toBe(0)
  })
  it('maps rotated text through CropBox and UserUnit before retaining its source anchor', async () => {
    const fixture = setup([{ ...text('Rotated'), transform: [0, 10, -10, 0, 500, 300] }])
    fixture.page.getViewport.mockReturnValue({
      width: 1200,
      height: 1600,
      transform: [2, 0, 0, -2, -20, 1600]
    })
    const { source } = await extractPdfTranslationSource(fixture.context)
    expect(source.units[0].fragments[0].rect).toEqual({
      x: 964 / 1200,
      y: 700 / 1600,
      width: 20 / 1200,
      height: 300 / 1600
    })
  })
  it('retains upside-down text in a rotated default viewport as source-only', async () => {
    const fixture = setup([{ ...text('Page-rotated'), transform: [0, -10, 10, 0, 200, 200] }])
    fixture.page.rotate = 90
    fixture.page.getViewport.mockReturnValue({
      width: 800,
      height: 600,
      transform: [0, 1, 1, 0, 0, 0]
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units[0]).toMatchObject({ source: 'Page-rotated', sourceOnly: true })
    expect(coverage.excludedItemCount).toBe(0)
  })
  it('groups upright prose after the default viewport rotation has already been applied', async () => {
    const fixture = setup([{ ...text('Readable prose.'), transform: [0, 10, -10, 0, 200, 200] }])
    fixture.page.rotate = 90
    fixture.page.getViewport.mockReturnValue({
      width: 800,
      height: 600,
      transform: [0, 1, 1, 0, 0, 0]
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units).toHaveLength(1)
    expect(source.units[0].source).toBe('Readable prose.')
    expect(source.units[0].sourceOnly).toBeUndefined()
    expect(coverage.excludedItemCount).toBe(0)
  })
  it.each(['skew', 'mirror', 'rtl', 'vertical', 'outside', 'invalid-style'] as const)(
    'does not recover %s text',
    async (kind) => {
      const item = { ...text('Unsupported'), transform: [0, 10, -10, 0, 500, 300] }
      if (kind === 'skew') item.transform = [2, 10, -10, 0, 500, 300]
      if (kind === 'mirror') item.transform = [0, 10, 10, 0, 500, 300]
      if (kind === 'rtl') item.dir = 'rtl'
      if (kind === 'outside') item.transform = [0, 10, -10, 0, -100, 300]
      const fixture = setup([item])
      fixture.page.getTextContent.mockResolvedValue({
        items: [item],
        styles: {
          body:
            kind === 'vertical'
              ? { vertical: true }
              : kind === 'invalid-style'
                ? { ascent: Infinity }
                : {}
        }
      })
      const result = await extractPdfTranslationSource(fixture.context)
      expect(result.source.units).toEqual([])
      expect(result.coverage.excludedItemCount).toBe(1)
    }
  )

  it('reports completed page reads in order and stops progress after cancellation', async () => {
    const fixture = setup()
    fixture.document.numPages = 3
    const onProgress = vi.fn((pages: number) => {
      if (pages === 2) fixture.controller.abort()
    })
    await expect(
      extractPdfTranslationSource({ ...fixture.context, onProgress })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(onProgress.mock.calls).toEqual([[1], [2]])
    expect(fixture.document.getPage.mock.calls).toEqual([[1], [2]])
  })
  it('uses the viewport CropBox offset and UserUnit scale for source rectangles', async () => {
    const fixture = setup()
    fixture.page.getViewport.mockReturnValue({
      width: 1200,
      height: 1600,
      transform: [2, 0, 0, -2, -20, 1600]
    })
    const { source } = await extractPdfTranslationSource(fixture.context)
    expect(source.units[0].fragments[0].rect).toEqual({
      x: 60 / 1200,
      y: 183 / 1600,
      width: 300 / 1200,
      height: 22 / 1600
    })
  })

  it('preserves native end-of-line markers carried by empty items', async () => {
    const fixture = setup([
      { ...text('Ethical'), width: 30, hasEOL: false },
      text(''),
      { ...text('clearance', 90), width: 40, hasEOL: false },
      { ...text('number', 165), width: 30 }
    ])
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units.map((unit) => unit.source)).toEqual(['Ethical', 'clearance number'])
    expect(coverage.textItemCount).toBe(3)
    expect(source.units[1].fragments[0].items.map((item) => item.index)).toEqual([2, 3])
  })

  it.each(['viewport', 'invalid-width'])(
    'keeps native justified caption boundaries without admitting whitespace as a source: %s',
    async (variant) => {
      const item = (
        str: string,
        x: number,
        y: number,
        width: number,
        size = 10,
        fontName = 'body',
        hasEOL = true
      ) => ({
        ...text(str),
        width,
        height: size,
        transform: [size, 0, 0, size, x, y],
        fontName,
        hasEOL
      })
      const items = [
        item(
          'The preceding ordinary explanation establishes the surrounding discussion.',
          60,
          400,
          480
        ),
        item('Across these independent conditions', 60, 388, 200, 10, 'body', false),
        item(' ', 260, 388, 12, 10, 'body', false),
        item('the discussion continues with', 272, 388, 268),
        item('Figure 1:', 60, 220, 45, 10, 'body', false),
        item(
          'Observed values from the complete independent comparison.',
          110,
          220,
          430,
          8,
          'caption'
        ),
        item(
          'an ordinary continuation that remains separate from the completed caption.',
          60,
          212,
          480
        ),
        item('The following ordinary sentence preserves the remaining body context.', 60, 200, 480)
      ]
      if (variant === 'invalid-width') items[2].width = NaN
      const original = structuredClone(items),
        fixture = setup(items)
      fixture.page.getTextContent.mockResolvedValue({
        items,
        styles: {
          body: { ascent: 0.8, descent: -0.2, vertical: false },
          caption: { ascent: 0.8, descent: -0.2, vertical: false }
        }
      })
      if (variant === 'viewport')
        fixture.page.getViewport.mockReturnValue({
          width: 1200,
          height: 1600,
          transform: [2, 0, 0, -2, -20, 1580]
        })
      const result = await extractPdfTranslationSource(fixture.context)
      const indices = (unit: (typeof result.source.units)[number]): number[] =>
        unit.fragments.flatMap((f) => f.items.map((i) => i.index))
      const caption = result.source.units.find((u) => indices(u).includes(4))!
      expect(indices(caption).includes(6)).toBe(variant === 'invalid-width')
      expect(result.source.units.every((u) => !u.sourceOnly)).toBe(true)
      expect(result.source.units.flatMap(indices)).toEqual([0, 1, 3, 4, 5, 6, 7])
      expect(result.coverage).toMatchObject({
        textItemCount: 7,
        includedItemCount: 7,
        excludedItemCount: 0,
        exclusions: []
      })
      expect(items).toEqual(original)
      const bound = await bindPdfTranslation(
        result.source,
        {
          source: result.source,
          units: [
            { id: caption.id, translationSource: caption.source, translation: '完整的图注。' }
          ]
        },
        fixture.context.document,
        'current',
        fixture.context.signal
      )
      expect(bound?.units.find((u) => u.id === caption.id)?.translation).toBe('完整的图注。')
    }
  )

  it('creates a bindable immutable snapshot with original item indexes and no cleanup', async () => {
    const fixture = setup([text(''), text('An intact source paragraph.')])
    const result = await extractPdfTranslationSource(fixture.context)
    expect(result.coverage).toMatchObject({
      pageCount: 1,
      textItemCount: 1,
      includedItemCount: 1,
      excludedItemCount: 0,
      pagesWithoutText: [],
      exclusions: []
    })
    const unit = result.source.units[0]
    expect(unit.fragments[0].items).toEqual([{ index: 1, text: 'An intact source paragraph.' }])
    const bound = await bindPdfTranslation(
      result.source,
      {
        source: result.source,
        units: [{ id: unit.id, translationSource: unit.source, translation: '完整的原文段落。' }]
      },
      fixture.context.document,
      'current',
      fixture.context.signal
    )
    expect(bound?.units[0].translation).toBe('完整的原文段落。')
    expect(Object.isFrozen(result.coverage)).toBe(true)
    expect(Object.isFrozen(result.source.units)).toBe(true)
    expect(fixture.page.cleanup).not.toHaveBeenCalled()
    expect(fixture.document.destroy).not.toHaveBeenCalled()
  })

  it('accounts for invalid geometry, unsupported orientation and out-of-page text without clamping', async () => {
    const fixture = setup([
      text('Valid original text.'),
      { ...text('Non-finite transform'), transform: [10, 0, 0, 10, NaN, 400] },
      { ...text('Vertical source'), dir: 'ttb', transform: [0, 10, -10, 0, 500, 300] },
      text('Outside the crop box', -100, 500)
    ])
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units).toHaveLength(1)
    expect(coverage.textItemCount).toBe(4)
    expect(coverage.includedItemCount).toBe(1)
    expect(coverage.excludedItemCount).toBe(3)
    expect(coverage.exclusions.map((e) => e.reason).sort()).toEqual([
      'invalid-geometry',
      'outside-page',
      'unsupported-orientation'
    ])
    expect(
      coverage.exclusions
        .flatMap((e) => e.items)
        .map((i) => i.index)
        .sort()
    ).toEqual([1, 2, 3])
    expect(Object.isFrozen(coverage.exclusions[0].items[0])).toBe(true)
  })

  it('reports empty extracted text without guessing that the page is scanned', async () => {
    const fixture = setup([text('   ')])
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units).toEqual([])
    expect(coverage.pagesWithoutText).toEqual([1])
    expect(coverage.textItemCount).toBe(0)
    expect(coverage.exclusions).toEqual([])
  })

  it('retains ambiguous scientific hyphens with an advisory warning', async () => {
    const fixture = setup([
      text('The participant-', 40, 100),
      text('completed questionnaire.', 40, 112)
    ])
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(source.units[0].source).toBe('The participant-completed questionnaire.')
    expect(coverage.warnings[0].reasons).toContain('ambiguous-line-hyphen')
  })

  it.each(['before', 'page', 'text'] as const)(
    'rejects cancellation at %s without reading later pages',
    async (stage) => {
      const fixture = setup()
      fixture.document.numPages = 2
      let resume!: (value: unknown) => void
      if (stage === 'page')
        fixture.document.getPage.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resume = resolve
            })
        )
      if (stage === 'text')
        fixture.page.getTextContent.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resume = resolve
            })
        )
      if (stage === 'before') fixture.controller.abort()
      const pending = extractPdfTranslationSource(fixture.context)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      if (stage !== 'before') {
        await vi.waitFor(() => expect(resume).toBeTypeOf('function'))
        fixture.controller.abort()
        resume(stage === 'page' ? fixture.page : { items: [text('A delayed result.')] })
      }
      await rejected
      expect(fixture.document.getPage).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1)
      expect(fixture.page.cleanup).not.toHaveBeenCalled()
      expect(fixture.document.destroy).not.toHaveBeenCalled()
    }
  )

  it('rejects a failed page instead of reporting partial extraction as complete', async () => {
    const fixture = setup()
    fixture.document.numPages = 2
    fixture.document.getPage
      .mockResolvedValueOnce(fixture.page)
      .mockRejectedValueOnce(new Error('Damaged page'))
    await expect(extractPdfTranslationSource(fixture.context)).rejects.toThrow('Damaged page')
    expect(fixture.page.cleanup).not.toHaveBeenCalled()
  })

  it('rejects invalid source identity and page geometry before publication', async () => {
    const fixture = setup()
    fixture.document.fingerprints = []
    await expect(extractPdfTranslationSource(fixture.context)).rejects.toThrow(
      'Invalid PDF source identity'
    )
    expect(fixture.document.getPage).not.toHaveBeenCalled()
    fixture.document.fingerprints = ['source']
    fixture.page.getViewport.mockReturnValue({
      width: Infinity,
      height: 800,
      transform: [1, 0, 0, -1, 0, 800]
    })
    await expect(extractPdfTranslationSource(fixture.context)).rejects.toThrow(
      'Invalid PDF page geometry'
    )
    expect(fixture.page.getTextContent).not.toHaveBeenCalled()
  })
})

it.each(
  readPdfTranslationCases<{ name: string; font: string; source: string; expected: string }>(
    'legacy-dingbats-text-encoding.jsonl'
  )
)('$name', async ({ font, source, expected }) => {
  const items = [{ ...text(source), fontName: 'symbol' }, text('3'), text('7')]
  const content = { items }
  let loaded = false
  const page = {
    getTextContent: vi.fn().mockResolvedValue(content),
    commonObjs: {
      has: (name: string) => name === 'body' || loaded,
      get: (name: string) => ({ name: name === 'symbol' ? font : 'Times-Roman' })
    },
    getOperatorList: vi.fn(async () => {
      loaded = true
    })
  }
  const result = await getPdfTranslationTextContent(page as unknown as PDFPageProxy)
  expect(result.items.map((item) => ('str' in item ? item.str : ''))).toEqual([expected, '3', '7'])
  expect(content.items[0].str).toBe(source)
})

it.each([
  ['subset txsys multiplication', 'XQRHLV+txsys', 0.636, '\u0002', '×'],
  ['unsubset txsys multiplication', 'txsys', 0.636, '\u0002', '×'],
  ['different math font', 'AdvMacMthSyN', 0.636, '\u0002', '\u0002'],
  ['similar font name', 'other-txsys', 0.636, '\u0002', '\u0002'],
  ['different advance', 'txsys', 0.5, '\u0002', '\u0002'],
  ['different control slot', 'txsys', 0.636, '\u0003', '\u0003'],
  ['mixed run', 'txsys', 0.636, '2\u0002', '2\u0002'],
  ['ordinary digit', 'txsys', 0.636, '2', '2'],
  ['subset CMEX10 display integral', 'ABCDEF+CMEX10', 0.5556, 'Z', '∫'],
  ['ordinary letter Z', 'Body', 0.5556, 'Z', 'Z'],
  ['different CMEX10 advance', 'CMEX10', 0.6, 'Z', 'Z'],
  ['subset CMEX10 display summation', 'ABCDEF+CMEX10', 1.4444, 'X', '∑'],
  ['ordinary letter X', 'Body', 1.4444, 'X', 'X'],
  ['different summation advance', 'CMEX10', 1.4, 'X', 'X'],
  ['subset CMEX10 display product', 'ABCDEF+CMEX10', 1.2778, 'Y', '∏'],
  ['ordinary letter Y', 'Body', 1.2778, 'Y', 'Y'],
  ['different product advance', 'CMEX10', 1.25, 'Y', 'Y']
])('decodes only a proven legacy symbol: %s', async (_name, font, advance, str, expected) => {
  const item = { ...text(String(str)), fontName: 'symbol', width: Number(advance) * 10 }
  const content = { items: [item, text('Ordinary prose.')] }
  let loaded = false
  const page = {
    getTextContent: vi.fn().mockResolvedValue(content),
    commonObjs: {
      has: () => loaded,
      get: () => ({ name: font, type: 'Type1', missingFile: false })
    },
    getOperatorList: vi.fn(async () => {
      loaded = true
    })
  }
  const result = await getPdfTranslationTextContent(page as unknown as PDFPageProxy)
  expect(result.items[0]).toEqual({ ...item, str: expected })
  expect(result.items[1]).toBe(content.items[1])
  expect(content.items[0].str).toBe(str)
})

it.each([
  ['embedded operator', 'ABCDEF+txexs', 8.08, { 205: 'Õ' }, '∑'],
  ['body accent', 'Times-Roman', 8.08, { 205: 'Õ' }, 'Õ'],
  ['different advance', 'txexs', 6, { 205: 'Õ' }, 'Õ'],
  ['ambiguous mapping', 'txexs', 8.08, { 205: 'Õ', 206: 'Õ' }, 'Õ']
] as const)(
  'decodes the small summation without consuming the adjacent prose (%s)',
  async (_kind, name, width, map, expected) => {
    const paragraph = 'Independent prose explains the following calculation.'
    const item = { ...text('Õ', 120, 185), fontName: 'operator', width }
    const fixture = setup([text(paragraph), item])
    const font = {
      name,
      type: 'Type1',
      composite: false,
      missingFile: false,
      isInvalidPDFjsFont: false,
      systemFontInfo: null,
      defaultEncoding: { 205: 'Otilde' },
      widths: { 205: 808 },
      toFontChar: { 205: 0xe015 },
      toUnicode: { _map: map }
    }
    Object.assign(fixture.page, {
      commonObjs: { has: () => true, get: (key: string) => (key === 'operator' ? font : {}) },
      getOperatorList: vi.fn().mockResolvedValue({
        fnArray: [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
        argsArray: [
          ['body', 10],
          [nativeGlyphs(paragraph)],
          ['operator', 10],
          [
            [
              {
                originalCharCode: 205,
                unicode: 'Õ',
                fontChar: '\ue015',
                isInFont: true,
                width: 808
              }
            ]
          ]
        ]
      })
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    const owner = source.units.find((unit) => unit.source === expected)
    expect(owner?.sourceOnly).toBe(expected === '∑' ? true : undefined)
    expect(owner?.fragments.flatMap((fragment) => fragment.items)).toEqual([
      { index: 1, text: expected }
    ])
    const prose = source.units.find((unit) => unit.source === paragraph)
    expect(prose?.fragments[0].items).toEqual([{ index: 0, text: paragraph }])
    expect(prose?.sourceOnly).toBeUndefined()
    expect(coverage).toMatchObject({ includedItemCount: 2, excludedItemCount: 0, warnings: [] })
    expect(item.str).toBe('Õ')
  }
)

it('keeps the synthetic abstract intact after legacy multiplication decoding', async () => {
  const [fixture] = readPdfTranslationCases<{ page: { items: ReturnType<typeof text>[] } }>(
    'txsys-multiplication-native-abstract.jsonl'
  )
  const { page, context } = setup(fixture.page.items)
  Object.assign(page, {
    commonObjs: {
      has: () => true,
      get: (font: string) => ({ name: font === 'g_d0_f4' ? 'XQRHLV+txsys' : 'Times-Roman' })
    }
  })
  const { source, coverage } = await extractPdfTranslationSource(context)
  expect(source.units).toHaveLength(1)
  expect(source.units[0].source).toContain('3× signals on JOB-2')
  expect(source.units[0].source).toContain('2.4× signals on case-group curve')
  expect(source.units[0].source).toContain('Item-256 (tag. length 64K, 63.1% accuracy).')
  expect(source.units[0].sourceOnly).toBeUndefined()
  expect(coverage.excludedItemCount).toBe(0)
})

it('extracts the native clinical dose paragraph as one checked body region', async () => {
  const { source: expected, page: native } = readPdfTranslationCases<{
    source: string
    page: PdfLayoutPage
  }>('wrapped-dose-native-body.jsonl')[0]
  const fixture = setup()
  fixture.page.getViewport.mockReturnValue({
    width: native.width,
    height: native.height,
    transform: [1, 0, 0, -1, 0, native.height]
  })
  fixture.page.getTextContent.mockResolvedValue({
    items: native.items,
    styles: Object.fromEntries(
      native.items.map((item) => [
        item.fontName,
        {
          ascent: item.fontAscent,
          descent: item.fontDescent
        }
      ])
    )
  })
  const { source, coverage } = await extractPdfTranslationSource(fixture.context)
  expect(source.units.map((unit) => unit.source)).toEqual(['Structured', expected])
  expect(source.units[1].sourceOnly).toBeUndefined()
  expect(source.units[1].fragments).toHaveLength(1)
  expect(source.units[1].fragments[0].items.map((item) => item.index)).toEqual(
    native.items.flatMap((item, index) => (index > 1 && item.str.trim() ? [index] : []))
  )
  expect(coverage.excludedItemCount).toBe(0)
})

it.each(
  readPdfTranslationCases<{
    name: string
    page: PdfLayoutPage
  }>('observed-time-and-numeric-tail.jsonl')
)('$name extracts one region without changing native ownership', async ({ page: native }) => {
  const fixture = setup()
  fixture.page.getViewport.mockReturnValue({
    width: native.width,
    height: native.height,
    transform: [1, 0, 0, -1, 0, native.height]
  })
  fixture.page.getTextContent.mockResolvedValue({
    items: native.items,
    styles: Object.fromEntries(
      native.items.map((item) => [
        item.fontName,
        { ascent: item.fontAscent, descent: item.fontDescent }
      ])
    )
  })
  const { source, coverage } = await extractPdfTranslationSource(fixture.context)
  expect(source.units).toHaveLength(1)
  expect(source.units[0].sourceOnly).toBeUndefined()
  expect(source.units[0].fragments).toHaveLength(1)
  expect(source.units[0].fragments[0].items.map((item) => item.index)).toEqual(
    native.items.flatMap((item, index) => (item.str.trim() ? [index] : []))
  )
  expect(coverage.excludedItemCount).toBe(0)
})

it('keeps the verified reference/model-script paragraph in one region, apart from its footnote', async () => {
  const { source: expected, page: native } = readPdfTranslationCases<{
    source: string
    page: PdfLayoutPage
  }>('reference-script-native-seam.jsonl')[0]
  const fixture = setup()
  fixture.page.getViewport.mockReturnValue({
    width: native.width,
    height: native.height,
    transform: [1, 0, 0, -1, 0, native.height]
  })
  fixture.page.getTextContent.mockResolvedValue({
    items: native.items,
    styles: Object.fromEntries(
      native.items.map((item) => [
        item.fontName,
        { ascent: item.fontAscent, descent: item.fontDescent }
      ])
    )
  })
  const { source, coverage } = await extractPdfTranslationSource(fixture.context)
  const body = source.units.find((unit) => unit.source === expected)!
  expect(body.sourceOnly).toBeUndefined()
  expect(body.fragments).toHaveLength(1)
  expect(body.fragments[0].items.map((item) => item.index)).toEqual([
    0, 1, 3, 4, 5, 6, 8, 9, 11, 12, 13
  ])
  expect(
    source.units.find((unit) => unit.source.startsWith('5https://'))?.fragments[0].items[0].index
  ).toBe(33)
  expect(coverage.excludedItemCount).toBe(0)
})

it('keeps short wrapped prose in separate physical rows outside its protected formula', async () => {
  const { page: native } = readPdfTranslationCases<{
    page: PdfLayoutPage
  }>('short-formula-prose-native.jsonl')[0]
  const fixture = setup()
  fixture.page.getViewport.mockReturnValue({
    width: native.width,
    height: native.height,
    transform: [1, 0, 0, -1, 0, native.height]
  })
  fixture.page.getTextContent.mockResolvedValue({
    items: native.items,
    styles: Object.fromEntries(
      native.items.map((item) => [
        item.fontName,
        { ascent: item.fontAscent, descent: item.fontDescent }
      ])
    )
  })
  const { source, coverage } = await extractPdfTranslationSource(fixture.context)
  expect(source.units).toHaveLength(2)
  const formula = source.units.find((unit) => unit.sourceOnly)!
  const prose = source.units.find((unit) => !unit.sourceOnly)!
  expect(formula.source).toBe('β2 = 0.98')
  expect(formula.fragments.flatMap((f) => f.items.map((item) => item.index))).toEqual([
    0, 1, 3, 4, 5
  ])
  expect(prose.source).toBe('to minimum measureme when training with large local masks.')
  expect(prose.fragments.map((f) => f.items.map((item) => item.index))).toEqual([[7], [8]])
  expect(prose.fragments[0].rect.x).toBeGreaterThan(
    formula.fragments[0].rect.x + formula.fragments[0].rect.width
  )
  expect(prose.fragments[1].rect.y).toBeGreaterThan(
    formula.fragments[0].rect.y + formula.fragments[0].rect.height
  )
  expect(coverage.excludedItemCount).toBe(0)
  expect(coverage.includedItemCount).toBe(7)
})

it.each([true, false])(
  'separates labelled correspondence from the adjacent abstract (%s)',
  async (matches) => {
    const item = (
      s: string,
      x: number,
      y: number,
      width: number,
      size: number,
      fontName = 'body',
      hasEOL = true
    ) => ({
      ...text(s, x, y),
      transform: [size, 0, 0, size, x, 800 - y],
      width,
      height: size,
      fontName,
      hasEOL
    })
    const address =
        'Department of Earth Sciences at Northern Valley College and Research Center, United States.',
      caption = matches ? '*Corresponding author:' : '*Conference liaison:',
      email = 'author@example.org',
      prose = [
        'Observers examined survey coverage along the northern line',
        'under the available observing conditions. The first set',
        'provided three examples along the central boundary.'
      ]
    const contents = [
      item('A Study of Seasonal Survey Coverage', 50, 144, 480, 22, 'display'),
      item('JORDAN EXAMPLE *', 50, 184, 208, 12, 'byline'),
      item('1', 50, 207.5, 3, 6, 'front', false),
      item(address, 54, 210, 349, 8.5, 'front'),
      item(caption, 50, 230.8, 90, 8.5, 'front', false),
      item(email, 143, 230.8, 87, 8.5, 'front'),
      ...prose.map((value, i) => item(value, 50, 245.9 + i * 11.1, i === 2 ? 218 : 242, 9.45)),
      item('The separate right column begins with its own brief text.', 311, 245.9, 240, 9.45),
      item('This remains a separate source paragraph in either case.', 311, 257, 242, 9.45)
    ]
    const fixture = setup(contents)
    fixture.page.getTextContent.mockResolvedValue({
      items: contents,
      styles: Object.fromEntries(
        ['display', 'byline', 'front', 'body'].map((font) => [
          font,
          { vertical: false, ascent: 0.8, descent: -0.2 }
        ])
      )
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    const sub = source.units.find((unit) => unit.source.includes(prose[0]))
    expect(sub?.source).toContain(prose[2])
    expect(sub?.source.includes(email)).toBe(!matches)
    expect(coverage.includedItemCount).toBe(contents.length)
    const other = source.units.find((unit) => unit.source.startsWith('The separate right column'))!
    expect(other.fragments.flatMap(({ items }) => items.map(({ index }) => index))).toEqual([9, 10])
    expect(other.fragments.every(({ rect }) => rect.x === 311 / 600)).toBe(true)
    if (matches) {
      expect(sub?.fragments.map(({ items }) => items.map(({ index }) => index))).toEqual([
        [6],
        [7],
        [8]
      ])
      expect(
        source.units.find((unit) => unit.source === `${caption} ${email}`)?.fragments[0]?.items
      ).toHaveLength(2)
      expect(source.units.some((unit) => unit.source === `1 ${address}`)).toBe(true)
    }
  }
)

it.each([true, false])('keeps independent first-page author fields (%s)', async (matches) => {
  const values = [
    'Keywords:',
    'Principal Author:',
    'Name: Ellen Field',
    'Institution: Hilltown Institute',
    'E-mail: person@example.org',
    matches ? 'Co-authors: (names and institutions)' : 'Liaisons: (names and institutions)',
    'Avery Green (Woodland Institute)',
    'River Bloom (Harbor College)',
    'Abstract (optional):'
  ]
  const contents = [
    { ...text('A study of local history'), transform: [25, 0, 0, 25, 72, 710], height: 25 },
    ...values.map((value, index) => ({
      ...text(value),
      transform: [12, 0, 0, 12, 72, 573 - index * 14.45],
      width: value.length * 6,
      height: 12,
      fontName: [0, 1, 5, 8].includes(index) ? 'heading' : 'body'
    })),
    {
      ...text('The survey compares archived records of the northern sector.'),
      transform: [12, 0, 0, 12, 72, 573 - values.length * 14.45],
      width: 435,
      height: 12
    }
  ]
  const fixture = setup(contents)
  const { source, coverage } = await extractPdfTranslationSource(fixture.context)
  expect(coverage.includedItemCount).toBe(contents.length)
  expect(coverage.excludedItemCount).toBe(0)
  const cover = source.units.slice(1, -1)
  expect(
    cover.flatMap((unit) =>
      unit.fragments.flatMap((fragment) => fragment.items.map(({ index }) => index))
    )
  ).toEqual(values.map((_, index) => index + 1))
  if (matches) {
    expect(cover.filter((unit) => unit.sourceOnly).map((unit) => unit.source)).toEqual([
      values.slice(2, 5).join(' '),
      values.slice(6, 8).join(' ')
    ])
    expect(
      cover
        .filter((unit) => !unit.sourceOnly)
        .map((unit) => [unit.source, unit.fragments.length, unit.fragments[0].items.length])
    ).toEqual([0, 1, 5, 8].map((index) => [values[index], 1, 1]))
  } else {
    expect(cover.map((unit) => unit.source)).toEqual([values.join(' ')])
  }
})

it('anchors the end of a protected relation to its original row', async () => {
  const row = (str: string, x: number, width: number, fontName = 'body', y = 278, height = 11) => ({
    ...text(str, x, y),
    transform: [height, 0, 0, height, x, 800 - y],
    width,
    height,
    fontName,
    hasEOL: false
  })
  const closing =
      '= 2) and later Rivera [6] obtained a general upper bound on the measured offsets',
    items = [
      row('f', 72.003, 5.335, 'math'),
      row('(', 78.603, 4.233),
      row('|', 82.803, 3.022, 'symbol'),
      row('H', 85.803, 9.065, 'math'),
      row('|', 95.763, 3.022, 'symbol'),
      row(') is not explicit in [3], but', 98.763, 127.113),
      row(') =', 250.683, 16.396),
      row('4', 299.763, 4.232, 'script', 274, 8),
      row(') follows from a separate calculation. Par', 304.563, 194.695),
      { ...row('ker [4]', 493.804, 60.622), hasEOL: true },
      row('(for', 72.003, 17.225, 'body', 291.56),
      row('k', 92.883, 5.673, 'math', 291.56),
      row(closing, 101.883, 452.455, 'body', 291.56),
      { ...row('', 0, 0, 'body', 800, 0), hasEOL: true }
    ]
  const fixture = setup(items)
  const style = { vertical: false, ascent: 0.75, descent: -0.25 }
  fixture.page.getTextContent.mockResolvedValue({
    items,
    styles: {
      body: style,
      math: style,
      symbol: { ...style, ascent: 0.772 },
      script: { ...style, ascent: 0.675 }
    }
  })
  const { source, coverage } = await extractPdfTranslationSource(fixture.context)
  const [opening, body, prefix, tail] = source.units
  expect(opening.preserve).toBe('formula')
  expect(prefix).toMatchObject({ source: '(for k', sourceOnly: true, preserve: 'formula' })
  expect(body.fragments.map(({ items }) => items.map(({ index }) => index))).toEqual([
    [5, 6, 7, 8, 9]
  ])
  expect(tail.source).toBe(closing)
  expect(tail.fragments.map(({ items }) => items.map(({ index }) => index))).toEqual([[12]])
  expect(coverage.includedItemCount).toBe(13)
})

it.each([
  'paired',
  'serialized',
  'empty line marker',
  'displaced line marker',
  'different marker font',
  'nonzero advance',
  'different position',
  'different font'
])('decodes a legacy slash only over its native equality (%s)', async (shape) => {
  const slash = {
    ...text('6', 80),
    width: shape === 'nonzero advance' ? 5 : 0,
    fontName: 'mark',
    hasEOL: false
  }
  const x = shape === 'different position' ? 80.002 : shape === 'serialized' ? 80.00012 : 80
  const y = shape === 'serialized' ? 100.00003 : 100
  const equal = { ...text('=', x, y), width: 7.77 }
  const lineMarker = shape.includes('marker')
  const gap = lineMarker
    ? {
        ...text('', shape === 'displaced line marker' ? 81 : 80),
        fontName: shape === 'different marker font' ? slash.fontName : equal.fontName,
        width: 0,
        height: 0,
        hasEOL: true
      }
    : { ...text(' ', 80), height: 0, hasEOL: false }
  const items = [slash, gap, equal]
  const page = {
    getTextContent: vi.fn().mockResolvedValue({ items }),
    commonObjs: {
      has: () => true,
      get: (name: string) => ({
        name: name === 'mark' && shape !== 'different font' ? 'ABCDEF+CMSY10' : 'CMR10'
      })
    }
  }
  const actual = await getPdfTranslationTextContent(page as unknown as PDFPageProxy)
  expect(actual.items[0]).toEqual({
    ...slash,
    str: ['paired', 'serialized', 'empty line marker'].includes(shape) ? '\u0338' : '6'
  })
  expect(actual.items[1]).toBe(gap)
  expect(actual.items[2]).toBe(equal)
})

it.each([true, false])(
  'retains a fragmented negative condition around a native fraction (%s)',
  async (negative) => {
    const row = (
      str: string,
      x: number,
      width: number,
      fontName = 'body',
      y = 300,
      height = 10,
      hasEOL = false
    ) => ({
      ...text(str, x, y),
      transform: [height, 0, 0, height, x, 800 - y],
      width,
      height,
      fontName,
      hasEOL
    })
    const items = [
      row('op', 458.16, 11.88, 'operator'),
      row('(', 470.04, 3.87),
      row('A', 473.88, 7.83, 'math'),
      row('). This', 481.68, 31.04, 'body', 300, 10, true),
      row(
        negative
          ? 'limit does not remain valid if we change the constant'
          : 'limit continues to apply if we change the constant',
        99.24,
        235.345,
        'body',
        312
      ),
      row('3', 340.92, 3.97, 'number', 308.2, 7),
      row('q', 338.76, 4.23, 'lowered', 315.5, 7),
      row('2', 343.08, 3.39, 'script', 313.4, 5),
      row('−', 350.16, 7.74, 'symbol', 312),
      row('5', 363.12, 3.97, 'number', 308.2, 7),
      row('q', 360.96, 4.23, 'lowered', 315.5, 7),
      row('3', 365.28, 3.39, 'script', 313.4, 5),
      row('by any number larger than', 373.56, 122.53, 'body', 312),
      row('6', 502.68, 3.97, 'number', 308.2, 7),
      row('q', 500.52, 4.23, 'lowered', 315.5, 7),
      row('4', 504.84, 3.39, 'script', 313.4, 5),
      row('.', 510, 2.76, 'body', 312, 10, true)
    ]
    const style = { vertical: false, ascent: 0.75, descent: -0.25 }
    const fixture = setup(items)
    fixture.page.getTextContent.mockResolvedValue({
      items,
      styles: {
        body: style,
        math: style,
        symbol: style,
        operator: { ...style, ascent: 0.716, descent: -0.022 },
        number: { ...style, ascent: 0.664, descent: -0.02 },
        lowered: { ...style, ascent: 0.694, descent: -0.01 },
        script: { ...style, ascent: 0.666, descent: -0.022 }
      }
    })
    const { source, coverage } = await extractPdfTranslationSource(fixture.context)
    expect(
      source.units
        .filter((unit) => unit.preserve === 'literal')
        .map((unit) => unit.fragments[0].items[0].index)
    ).toEqual(negative ? [3, 4, 12] : [])
    expect(coverage.includedItemCount).toBe(items.length)
  }
)

it.each([false, true])(
  'keeps repeated affiliation addresses with their own columns (%s)',
  async (shifted) => {
    const institution = 'Westbridge University'
    const address = 'Fairhaven, NY, 01234'
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      height: number,
      hasEOL = false
    ) => ({
      ...text(str, x),
      width,
      height: str.trim() ? height : 0,
      hasEOL,
      transform: [height, 0, 0, height, x, y],
      fontName: /^[∗†‡]$/u.test(str) ? 'marks' : 'body'
    })
    const items = [
      item('A Survey of Local Systems:', 231, 660, 150, 20.66, true),
      item('Measuring Ordinary Variation', 178, 635, 256, 20.66),
      item('', 103, 592, 0, 14.35, true),
      item('Ann Blair Reed', 103, 592, 112, 14.35),
      item('∗', 215, 597, 5, 9.96),
      item(' ', 220, 597, 37, 9.96),
      item('Owen Dale Moore', 257, 592, 124, 14.35),
      item('†', 381, 597, 4, 9.96),
      item(' ', 385, 597, 20, 9.96),
      item('Adele Flynn Moss', 405, 592, 122, 14.35),
      item('‡', 527, 597, 4, 9.96),
      item('', 85, 574, 0, 10.91, true),
      item('Northfield Institute of Science', 85, 574, 148, 10.91),
      item(' ', 233, 574, 44, 10.91),
      item(institution, 278, 574, 84, 10.91),
      item(' ', 362, 574, 62, 10.91),
      item(institution, 424, 574, 84, 10.91, true),
      item('Eastford, WA, 12345', 112, 556, 94, 10.91),
      item(' ', 206, 556, 62, 10.91),
      item(address, 268, 556, 104, 10.91),
      item(' ', 372, 556, 42, 10.91),
      item(address, shifted ? 415 : 414, 556, 104, 10.91),
      item('', 249, 528, 0, 14.35, true),
      item('January 21, 2021', 249, 528, 114, 14.35),
      item(
        'The observations were repeated under controlled conditions across independent locations.',
        90,
        483,
        450,
        12,
        true
      ),
      item(
        'We then averaged the results and compared them with our initial estimates.',
        72,
        469,
        468,
        12,
        true
      )
    ]
    const { page, context } = setup(items)
    page.getViewport.mockReturnValue({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] })
    const { source } = await extractPdfTranslationSource(context)
    const columns = source.units.filter((unit) => unit.source.startsWith(institution))
    expect(columns).toHaveLength(2)
    if (!shifted) {
      expect(columns.map((unit) => unit.source)).toEqual(Array(2).fill(`${institution} ${address}`))
      expect(
        columns.map((unit) => unit.fragments.flatMap((f) => f.items.map(({ index }) => index)))
      ).toEqual([
        [14, 19],
        [16, 21]
      ])
    } else {
      expect(columns.map((unit) => unit.source)).toEqual([
        `${institution} ${address} ${address}`,
        institution
      ])
    }
  }
)
