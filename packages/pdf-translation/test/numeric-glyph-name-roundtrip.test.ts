import { expect, it, onTestFinished } from 'vitest'
import { PDFDocument, PDFName, PDFDict, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { resolve } from './paths.js'
import { readPdfTranslationCases } from './fixtures/read-cases.js'
import { TestCallerRegistry } from './support/callers.js'
import { PdfTranslationWriter } from '../src/writer.js'
import { createSourceFragmentRecovery } from '../resources/source-fragments.mjs'
import { extractPdfTranslationSource } from '../src/reader/extraction.js'
import {
  rememberPdfTranslationExtraction,
  getPdfTranslationLayoutSnapshot,
  restorePdfTranslationExtraction
} from '../src/reader/snapshot.js'
import { pdfTranslationLayoutFragments } from '../src/reader/fragments.js'
import { verifyPdfPreservation } from './support/pdf-translation-preservation.js'

const fixtures = readPdfTranslationCases<{
  name: string
  glyphName: string
  characterCode: number
  readerText: string
  fontProgramHex: string
}>('numeric-glyph-name-roundtrip.jsonl')
const fixture = fixtures[0]

async function encodedPdf({
  glyphName = 'C211',
  characterCode = 2,
  neighbor = false,
  fontProgramHex = fixture.fontProgramHex,
  repeat = 1,
  conflict
}: {
  glyphName?: string
  characterCode?: number
  neighbor?: boolean
  fontProgramHex?: string
  repeat?: number
  conflict?: 'unicode' | 'duplicate' | 'hex' | 'control' | 'partial' | 'cidchar' | 'cidrange'
} = {}): Promise<Uint8Array> {
  // This self-authored CFF contains only .notdef and a rectangular glyph.
  // It carries no publisher font program, document text or identifying metadata.
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([240, 160])
  const fontFile = pdf.context.register(
    pdf.context.flateStream(
      Buffer.from(
        Buffer.from(fontProgramHex, 'hex').toString('latin1').replace('C211', glyphName),
        'latin1'
      ),
      { Subtype: 'Type1C' }
    )
  )
  const descriptor = pdf.context.register(
    pdf.context.obj({
      Type: 'FontDescriptor',
      FontName: 'SyntheticEncoding',
      Flags: 6,
      FontBBox: [0, 0, 791, 550],
      ItalicAngle: 0,
      Ascent: 800,
      Descent: -200,
      CapHeight: 550,
      StemV: 80,
      FontFile3: fontFile
    })
  )
  const font = pdf.context.register(
    pdf.context.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'SyntheticEncoding',
      FontDescriptor: descriptor,
      FirstChar: characterCode,
      LastChar: characterCode,
      Widths: [791],
      Encoding: { Type: 'Encoding', Differences: [characterCode, PDFName.of(glyphName)] }
    })
  )
  const fontDictionary = pdf.context.lookup(font, PDFDict)
  if (conflict === 'unicode' || conflict === 'control')
    fontDictionary.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
            '/CMapName /Conflict def /CMapType 2 def\n' +
            '1 begincodespacerange <00> <FF> endcodespacerange\n' +
            `1 beginbfchar <02> <${conflict === 'control' ? '0003' : '0041'}> endbfchar\n` +
            'endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
  if (['partial', 'cidchar', 'cidrange'].includes(conflict ?? ''))
    fontDictionary.set(
      PDFName.of('ToUnicode'),
      pdf.context.register(
        pdf.context.stream(
          '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n' +
            '/CIDSystemInfo << /Registry (Synthetic) /Ordering (UCS) /Supplement 0 >> def\n' +
            '/CMapName /Partial def /CMapType 2 def\n' +
            '1 begincodespacerange <66> <fe> endcodespacerange\n' +
            '1 beginbfchar <de> <00DE> endbfchar\n' +
            '1 beginbfrange <66> <67> <0066> endbfrange\n' +
            (conflict === 'cidchar'
              ? '1 begincidchar <02> 65 endcidchar\n'
              : conflict === 'cidrange'
                ? '1 begincidrange <02> <02> 65 endcidrange\n'
                : '') +
            'endcmap CMapName currentdict /CMap defineresource pop end end'
        )
      )
    )
  if (conflict === 'hex')
    fontDictionary.set(
      PDFName.of('Encoding'),
      pdf.context.obj({
        Type: 'Encoding',
        Differences: [characterCode, PDFName.of(glyphName), 3, PDFName.of('C2A')]
      })
    )
  const resourceFonts = pdf.context.obj({ F1: font })
  if (conflict === 'duplicate') {
    const other = fontDictionary.clone()
    other.set(
      PDFName.of('Encoding'),
      pdf.context.obj({ Type: 'Encoding', Differences: [characterCode, PDFName.of('C212')] })
    )
    resourceFonts.set(PDFName.of('F2'), pdf.context.register(other))
  }
  page.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: resourceFonts }))
  page.node.set(
    PDFName.of('Contents'),
    pdf.context.register(
      pdf.context.flateStream(
        `BT /F1 10 Tf 40 100 Td <${characterCode.toString(16).padStart(2, '0').repeat(repeat)}> Tj ET`
      )
    )
  )
  if (neighbor) {
    const prose = await pdf.embedFont(StandardFonts.TimesRoman)
    page.drawText('Independent neighbor.', { font: prose, size: 10, x: 40, y: 40 })
  }
  return pdf.save()
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Infer the shared synthetic source fixture.
async function openSource(data: Uint8Array) {
  const loading = getDocument({ data: data.slice(), useSystemFonts: true })
  const registry = new TestCallerRegistry()
  onTestFinished(() => loading.destroy())
  onTestFinished(() => registry.dispose())
  const original = await loading.promise
  const caller = registry.acquire({ leaseId: 'numeric-glyph-name', surface: 'electron' })
  const extraction = await extractPdfTranslationSource({
    document: original,
    resourceRequestKey: 'synthetic-numeric-glyph',
    signal: caller.lease.signal
  })
  rememberPdfTranslationExtraction(extraction)
  const saved = structuredClone(getPdfTranslationLayoutSnapshot(extraction.source)!)
  const { source } = restorePdfTranslationExtraction(saved, 'restored-synthetic')
  const before = JSON.stringify(saved)
  const units = source.units.map((unit) => ({
    ...unit,
    translation: unit.source,
    fragments: pdfTranslationLayoutFragments(unit, source).map((fragment) => ({
      ...fragment,
      rect: { ...fragment.rect },
      items: fragment.items.map((item) => ({ ...item }))
    }))
  }))
  expect(JSON.stringify(saved)).toBe(before)
  const input = {
    id: 'numeric-glyph-name',
    data,
    pages: source.pages,
    preserveUnsupported: true,
    units
  }
  const writer = new PdfTranslationWriter(() => resolve('resources/worker.mjs'))
  return { original, caller, source, input, writer }
}

it.each([
  ['C211', 2, 'Ó'],
  ['C212', 3, 'Ô'],
  ['c211', 4, 'Ó'],
  ['C065', 2, 'A'],
  ['C138', 4, '\u008a']
] as const)(
  'preserves numeric glyph %s at native code %s as spelling %s',
  async (glyphName, characterCode, readerText) => {
    const { original, caller, source, input, writer } = await openSource(
      await encodedPdf({ glyphName, characterCode })
    )
    expect(source.units).toHaveLength(1)
    expect(source.units[0].source).toBe(readerText)
    const output = await writer.generateDetailed(input, caller.lease)
    expect(output).not.toBeNull()
    expect(output!.layoutFailures).toEqual([])
    const translated = getDocument({ data: output!.data.slice(), useSystemFonts: true })
    onTestFinished(() => translated.destroy())
    const preservation = await verifyPdfPreservation(
      original,
      await translated.promise,
      [],
      [],
      [1]
    )
    expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
    expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
    await expect(
      writer.generateDetailed(
        {
          ...input,
          id: 'wrong-source',
          units: [{ ...input.units[0], source: '?', translation: '?' }]
        },
        caller.lease
      )
    ).rejects.toMatchObject({ failure: { code: 'source-mismatch', pageNumber: 1 } })
  }
)

it('retains unresolved ink while translating a neighboring unit, including a repeated generation', async () => {
  const { original, caller, input, writer } = await openSource(await encodedPdf({ neighbor: true }))
  expect(input.units.map((unit) => unit.source)).toEqual(['Ó', 'Independent neighbor.'])
  input.units[0].translation = 'Changed symbol'
  input.units[1].translation = 'Adjacent prose.'
  await expect(
    writer.generateDetailed({ ...input, preserveUnsupported: false }, caller.lease)
  ).rejects.toMatchObject({ failure: { code: 'unsupported-layout' } })
  // Repeat with a fresh request ID: no checkpoint rewriting or in-memory proof cache is needed.
  for (const id of ['first-generation', 'retry-generation']) {
    const output = await writer.generateDetailed({ ...input, id }, caller.lease)
    expect(output!.layoutFailures).toEqual([
      {
        unitIndex: 0,
        code: 'unsupported-layout',
        phase: 'planning',
        pageNumbers: [1],
        fragmentCount: 1
      }
    ])
    const loading = getDocument({ data: output!.data.slice(), useSystemFonts: true })
    onTestFinished(() => loading.destroy())
    const target = await loading.promise
    const text = (await (await target.getPage(1)).getTextContent()).items
      .filter((item) => 'str' in item)
      .map((item) => item.str)
      .join('')
    expect(text).toContain('Ó')
    expect(text).toContain('Adjacent prose.')
    expect(text).not.toContain('Changed symbol')
    expect(text).not.toContain('Independent neighbor.')
    const preservation = await verifyPdfPreservation(
      original,
      target,
      input.units,
      output!.layoutFailures,
      [1]
    )
    expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
    expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
  }
})

it.each(['unicode', 'duplicate', 'hex', 'cidchar', 'cidrange'] as const)(
  'rejects numeric aliases with %s ambiguity',
  async (conflict) => {
    const { caller, input, writer } = await openSource(await encodedPdf({ conflict }))
    input.units[0].source = 'Ó'
    input.units[0].translation = 'Ó'
    await expect(writer.generateDetailed(input, caller.lease)).rejects.toMatchObject({
      failure: { code: 'source-mismatch', pageNumber: 1 }
    })
  }
)

it('rejects a correct glyph spelling outside the owned fragment', async () => {
  const { caller, input, writer } = await openSource(await encodedPdf())
  input.units[0].fragments[0].rect.x = 0.6
  await expect(writer.generateDetailed(input, caller.lease)).rejects.toBeDefined()
})

async function interleavedPdf(): Promise<Uint8Array> {
  const bytes = await encodedPdf({ conflict: 'control' })
  const pdf = await PDFDocument.load(bytes)
  const page = pdf.getPage(0)
  page.node.delete(PDFName.of('Contents'))
  const font = await pdf.embedFont(StandardFonts.TimesRoman)
  page.drawText('s', { font, size: 7.9702, x: 37, y: 100 })
  page.node.addContentStream(
    pdf.context.register(
      pdf.context.flateStream('BT /F1 5.9774 Tf 1 0 0 0.88879 40 103.5149 Tm <02> Tj ET')
    )
  )
  page.node.setFontDictionary(PDFName.of('Prose'), font.ref)
  page.node.addContentStream(
    pdf.context.register(
      pdf.context.flateStream('BT /Prose 5.9774 Tf 44.5906 103.5149 Td (1) Tj ET')
    )
  )
  return pdf.save()
}

it('keeps interleaved unknown control ink outside independently owned prose fragments', async () => {
  const { original, source, input, writer, caller } = await openSource(await interleavedPdf())
  const eligible = input.units.filter((_, index) => !source.units[index].sourceOnly)
  expect(eligible).toHaveLength(1)
  expect(eligible[0].source).toBe('s 1')
  const output = await writer.generateDetailed({ ...input, units: eligible }, caller.lease)
  expect(output).not.toBeNull()
  const loading = getDocument({ data: output!.data.slice(), useSystemFonts: true })
  onTestFinished(() => loading.destroy())
  const preservation = await verifyPdfPreservation(original, await loading.promise, [], [], [1])
  expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
  expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
})

it('proves a numeric slot below a partial ToUnicode code space without changing its ink', async () => {
  const { original, caller, input, writer } = await openSource(
    await encodedPdf({ glyphName: 'C138', characterCode: 4, conflict: 'partial' })
  )
  expect(input.units[0].source).toBe('\u008a')
  const output = await writer.generateDetailed(input, caller.lease)
  expect(output!.layoutFailures).toEqual([])
  const loading = getDocument({ data: output!.data.slice(), useSystemFonts: true })
  onTestFinished(() => loading.destroy())
  const preservation = await verifyPdfPreservation(original, await loading.promise, [], [], [1])
  expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
  expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
})

it('preserves complete tall numeric-control runs extending below their source font box', async () => {
  const { original, caller, input, writer } = await openSource(
    await encodedPdf({ glyphName: 'C019', repeat: 2, fontProgramHex: fixtures[1].fontProgramHex })
  )
  expect(input.units).toHaveLength(1)
  expect(input.units[0].source).toBe('\u0013\u0013')
  const output = await writer.generateDetailed(input, caller.lease)
  expect(output!.layoutFailures).toEqual([])
  const loading = getDocument({ data: output!.data.slice(), useSystemFonts: true })
  onTestFinished(() => loading.destroy())
  const preservation = await verifyPdfPreservation(original, await loading.promise, [], [], [1])
  expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
  expect(preservation.pages[0].pixels!.changedPixels).toBe(0)
})

it.each(['identity', 'duplicate', 'text', 'position', 'user-unit', 'rotation'] as const)(
  'rejects unproven item recovery with changed %s',
  async (change) => {
    let data = await interleavedPdf()
    const { source, input } = await openSource(data)
    const unit = structuredClone(input.units.find((_, index) => !source.units[index].sourceOnly)!)
    if (change === 'identity') unit.fragments[0].items[0].index = 999
    if (change === 'duplicate') unit.fragments[0].items[1].index = unit.fragments[0].items[0].index
    if (change === 'text') unit.fragments[0].items[0].text = 'forged'
    if (change === 'position') unit.fragments[0].rect.x = 0.6
    if (change === 'user-unit' || change === 'rotation') {
      const pdf = await PDFDocument.load(data)
      pdf
        .getPage(0)
        .node.set(
          PDFName.of(change === 'user-unit' ? 'UserUnit' : 'Rotate'),
          pdf.context.obj(change === 'user-unit' ? 2 : 90)
        )
      data = await pdf.save()
    }
    const recovery = createSourceFragmentRecovery(
      data,
      change === 'user-unit' ? [{ width: 480, height: 320 }] : input.pages
    )
    try {
      expect(await recovery.recover(unit)).toBeUndefined()
    } finally {
      await recovery.close()
    }
  }
)

it.each(['resource-limit', 'unreadable-font'] as const)(
  'declines optional numeric proof with %s while translating unrelated prose',
  async (kind) => {
    const pdf = await PDFDocument.load(await encodedPdf({ neighbor: true }))
    const resources = pdf.getPage(0).node.Resources()!
    if (kind === 'resource-limit') {
      const forms = pdf.context.obj({})
      for (let index = 0; index < 128; index++)
        forms.set(
          PDFName.of(`Form${index}`),
          pdf.context.register(
            pdf.context.flateStream('', {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: [0, 0, 1, 1],
              Resources: {}
            })
          )
        )
      resources.set(PDFName.of('XObject'), forms)
    } else {
      const fonts = resources.lookup(PDFName.of('Font'), PDFDict)
      const broken = pdf.context.register(
        pdf.context.stream('invalid compressed stream', {
          Subtype: 'Type1C',
          Filter: 'FlateDecode'
        })
      )
      fonts.set(
        PDFName.of('Unused'),
        pdf.context.obj({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Unreadable',
          FontDescriptor: { FontFile3: broken }
        })
      )
    }
    const { caller, input, writer } = await openSource(await pdf.save())
    const prose = input.units.find((unit) => unit.source === 'Independent neighbor.')!
    const output = await writer.generateDetailed(
      { ...input, units: [{ ...prose, translation: 'Adjacent prose.' }] },
      caller.lease
    )
    expect(output!.layoutFailures).toEqual([])
    const loading = getDocument({ data: output!.data.slice(), useSystemFonts: true })
    onTestFinished(() => loading.destroy())
    const content = await (await (await loading.promise).getPage(1)).getTextContent()
    expect(
      content.items
        .filter((item) => 'str' in item)
        .map((item) => item.str)
        .join('')
    ).toContain('Adjacent prose.')
  }
)
