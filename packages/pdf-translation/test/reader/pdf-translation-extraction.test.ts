import { getPdfTranslationTextContent } from '../../src/reader/text-content.js'
import { readPdfTranslationCases } from '../fixtures/read-cases'
/* eslint-disable @typescript-eslint/explicit-function-return-type -- retain inferred mock fixture types */
import { describe, expect, it, vi } from 'vitest'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import { bindPdfTranslation } from '../../src/reader/source.js'
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
  ['ordinary digit', 'txsys', 0.636, '2', '2']
])('decodes only a proven legacy symbol: %s', async (_name, font, advance, str, expected) => {
  const item = { ...text(String(str)), fontName: 'symbol', width: Number(advance) * 10 }
  const content = { items: [item, text('Ordinary prose.')] }
  let loaded = false
  const page = {
    getTextContent: vi.fn().mockResolvedValue(content),
    commonObjs: {
      has: () => loaded,
      get: () => ({ name: font })
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
