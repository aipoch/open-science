import { resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import {
  PDFDocument,
  StandardFonts,
  PDFName,
  PDFDict,
  PDFString,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  scale,
  type PDFPage
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import { PdfTranslationWriter } from './writer'
import { extractPdfTranslationSource } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-extraction'
import { pdfTranslationLayoutFragments } from '../../../renderer/src/pages/workspace/previews/renderers/pdf-translation-fragments'
import { readPdfTranslationCases } from '../../../../test/fixtures/pdf-translation/read-cases'
import { verifyPdfUnits } from '../../../../test/pdf-translation-native-verification'
import { verifyPdfPreservation } from '../../../../test/pdf-translation-preservation'

type Run =
  | string
  | {
      text: string
      italic?: true
      bold?: true
      symbol?: true
      mono?: true
      size?: number
      rise?: number
    }
type Fixture = {
  name: string
  kind:
    | 'styled-name'
    | 'floating-page'
    | 'leading-greek'
    | 'paired-definition'
    | 'column-punctuation'
    | 'negative-powers'
    | 'shared-power'
    | 'inline-identifier'
    | 'wide-numbered-heading'
    | 'caption-column'
    | 'prose-tail'
    | 'side-floating-page'
  rows: Run[][]
  translation: string
  expectedCode?: 'annotations'
  linkedNumber?: string
  mathAlphabet?: true
  scriptLabels?: string[]
}

it.each([
  ...readPdfTranslationCases<Fixture>('styled-name-floating-page-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('leading-greek-body-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('paired-definition-native-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('baseline-comma-definition-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('column-terminal-punctuation-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('unicode-negative-power-native-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('shared-prose-negative-power-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('wrapped-inline-identifier-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('wide-numbered-heading-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('wrapped-citation-float-column-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('inline-sequence-numbered-tail-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('wrapped-chained-parameter-roundtrip.jsonl'),
  ...readPdfTranslationCases<Fixture>('side-float-page-native-roundtrip.jsonl')
])(
  'proves complete native backfill without consuming figures, formulas or neighbors: $name',
  async ({
    name,
    kind,
    rows,
    translation,
    expectedCode,
    linkedNumber,
    mathAlphabet,
    scriptLabels
  }) => {
    const twoPages = kind === 'floating-page' || kind === 'side-floating-page'
    const pdf = await PDFDocument.create(),
      roman = await pdf.embedFont(StandardFonts.TimesRoman),
      italic = await pdf.embedFont(StandardFonts.TimesRomanItalic),
      bold = await pdf.embedFont(StandardFonts.TimesRomanBold),
      mono = await pdf.embedFont(StandardFonts.Courier),
      symbol = await pdf.embedFont(StandardFonts.Symbol),
      first = pdf.addPage([600, 800])
    const drawRow = (
      page: PDFPage,
      runs: Run[],
      y: number,
      full = true,
      width = 500,
      left = 40
    ): void => {
      const parts = runs.map((run) => ({
        text: typeof run === 'string' ? run : run.text,
        font:
          typeof run === 'string'
            ? roman
            : run.symbol
              ? symbol
              : run.italic
                ? italic
                : run.bold
                  ? bold
                  : run.mono
                    ? mono
                    : roman,
        size: typeof run === 'string' ? 10 : (run.size ?? 10),
        rise: typeof run === 'string' ? 0 : (run.rise ?? 0)
      }))
      const factor = full
        ? width / parts.reduce((sum, part) => sum + part.font.widthOfTextAtSize(part.text, 10), 0)
        : 1
      page.pushOperators(pushGraphicsState(), scale(factor, 1))
      let x = left / factor
      for (const part of parts) {
        page.drawText(part.text, { x, y: y + part.rise, font: part.font, size: part.size })
        const citation = linkedNumber ? part.text.indexOf(`[${linkedNumber}]`) : -1
        if (citation >= 0) {
          const left =
            (x + part.font.widthOfTextAtSize(part.text.slice(0, citation + 1), part.size)) * factor
          page.node.set(
            PDFName.of('Annots'),
            pdf.context.obj([
              pdf.context.register(
                pdf.context.obj({
                  Type: 'Annot',
                  Subtype: 'Link',
                  Rect: [
                    left,
                    y - 2,
                    left + part.font.widthOfTextAtSize(linkedNumber!, part.size) * factor,
                    y + 8
                  ],
                  Border: [0, 0, 0],
                  A: {
                    S: 'URI',
                    URI: PDFString.of(`https://example.org/reference-${linkedNumber}`)
                  }
                })
              )
            ])
          )
        }
        x += part.font.widthOfTextAtSize(part.text, part.size)
      }
      page.pushOperators(popGraphicsState())
    }
    const neighbor = 'Independent neighboring paragraph stays untouched.'
    if (kind === 'caption-column') {
      first.drawText('2 Background', { x: 40, y: 195, font: bold, size: 10.9 })
      rows.slice(0, 3).forEach((row, index) => drawRow(first, row, 178 - index * 12, true, 230))
      first.drawText('Independent legal notice stays unchanged.', {
        x: 40,
        y: 115,
        font: roman,
        size: 8
      })
      first.drawText('Independent plotted series labels', { x: 330, y: 590, font: roman, size: 8 })
      drawRow(first, ['Figure 6. A separate plot describes another input.'], 480, true, 230, 320)
      drawRow(first, ['The displayed series remains unchanged.'], 468, true, 230, 320)
      rows
        .slice(3)
        .forEach((row, index) => drawRow(first, row, 439 - index * 12, index === 0, 230, 320))
      first.drawText(neighbor, { x: 333, y: 405, font: roman, size: 10 })
    } else if (kind === 'column-punctuation') {
      drawRow(first, ['Figure 7: Independent wide caption above the body columns.'], 650)
      rows.forEach((row, index) => drawRow(first, row, 500 - index * 12, false))
      first.drawText('Neighboring right column remains untouched.', {
        x: 285,
        y: 500,
        font: roman,
        size: 10
      })
      first.drawText('Its second row uses independent native objects.', {
        x: 285,
        y: 488,
        font: roman,
        size: 10
      })
      first.drawText('b = q + 1', { x: 285, y: 425, font: roman, size: 10 })
      first.drawText(neighbor, { x: 285, y: 395, font: roman, size: 10 })
    } else if (kind === 'side-floating-page') {
      first.drawText('Figure 9: A separate plotted view remains unchanged.', {
        x: 325,
        y: 58,
        font: roman,
        size: 10
      })
      rows.slice(0, 4).forEach((row, index) => drawRow(first, row, 100 - index * 12, true, 270))
      first.drawText('1', { x: 298, y: 40, font: roman, size: 10 })
      const last = pdf.addPage([600, 800])
      drawRow(last, ['Figure 10: An independent wide plotted view remains unchanged.'], 510)
      rows.slice(4).forEach((row, index) => drawRow(last, row, 480 - index * 12, index < 2))
      last.drawText('b = q + 1', { x: 270, y: 435, font: roman, size: 10 })
      last.drawText(neighbor, { x: 40, y: 410, font: roman, size: 10 })
    } else if (kind !== 'floating-page') {
      if (kind === 'wide-numbered-heading')
        drawRow(
          first,
          [
            { text: '4.2', bold: true },
            { text: ' Independent Token Conversion', bold: true }
          ],
          518,
          true,
          310
        )
      rows.forEach((row, index) =>
        drawRow(
          first,
          row,
          500 - index * 11,
          (kind === 'prose-tail' ? index < rows.length - 1 : index < 4) &&
            kind !== 'paired-definition' &&
            kind !== 'negative-powers' &&
            kind !== 'shared-power'
        )
      )
      first.drawText('b = q + 1', { x: 270, y: 425, font: roman, size: 10 })
      first.drawText(neighbor, { x: 40, y: 395, font: roman, size: 10 })
    } else {
      rows.slice(0, 3).forEach((row, index) => drawRow(first, row, 100 - index * 12))
      first.drawText('1', { x: 297, y: 40, font: roman, size: 10 })
      const last = pdf.addPage([600, 800])
      for (const [index, y] of [680, 430].entries()) {
        last.drawText(`Plot series ${index + 1}`, { x: 90, y, font: roman, size: 8 })
        last.drawText('Axis-Metric', {
          x: 80,
          y: y - 40,
          font: roman,
          size: 8,
          rotate: degrees(90)
        })
        drawRow(
          last,
          [`Figure ${index + 8}: Independent plot and complete caption remain intact.`],
          index === 0 ? 590 : 315
        )
      }
      rows.slice(3).forEach((row, index) => drawRow(last, row, 280 - index * 12))
      last.drawText('b = q + 1', { x: 270, y: 230, font: roman, size: 10 })
      last.drawText(neighbor, { x: 40, y: 205, font: roman, size: 10 })
    }
    if (mathAlphabet) {
      await pdf.flush()
      const font = pdf.context.lookup(italic.ref)
      if (!(font instanceof PDFDict)) throw new Error('Missing synthetic font')
      font.set(
        PDFName.of('ToUnicode'),
        pdf.context.register(
          pdf.context.flateStream(
            '/CIDInit /ProcSet findresource begin 12 dict begin begincmap ' +
              '/CIDSystemInfo << /Registry (Fixture) /Ordering (Math) /Supplement 0 >> def ' +
              '/CMapName /FixtureMath def /CMapType 2 def ' +
              '1 begincodespacerange <00> <FF> endcodespacerange ' +
              '2 beginbfchar <78> <D835DC65> <6E> <D835DC5B> endbfchar ' +
              'endcmap CMapName currentdict /CMap defineresource pop end end'
          )
        )
      )
    }
    const bytes = new Uint8Array(await pdf.save()),
      loading = getDocument({ data: bytes.slice(), useSystemFonts: true }),
      registry = new ApplicationCallerLeaseRegistry()
    onTestFinished(() => loading.destroy())
    onTestFinished(() => registry.dispose())
    const original = await loading.promise,
      caller = registry.acquire({ leaseId: name, surface: 'electron' }),
      { source } = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: name,
        signal: caller.lease.signal
      })
    const paragraph = source.units.find((unit) => unit.source.startsWith(rows[0][0] as string))!
    expect(paragraph).toBeDefined()
    const lastText = rows
      .at(-1)!
      .map((run) => (typeof run === 'string' ? run : run.text))
      .join('')
    const lastSource = kind === 'shared-power' ? lastText.replace(/10−3/gu, '10⁻³') : lastText
    expect(paragraph.source.replace(/\s+/gu, '')).toContain(lastSource.replace(/\s+/gu, ''))
    expect(paragraph.sourceOnly).toBeUndefined()
    if (kind === 'wide-numbered-heading') {
      const heading = source.units.find(
        (unit) => unit.source === '4.2 Independent Token Conversion'
      )
      expect(heading).toBeDefined()
      expect(heading).not.toBe(paragraph)
    }
    if (kind === 'caption-column') {
      expect(source.units.find((unit) => unit.source === '2 Background')).toBeDefined()
      expect(paragraph.source).toContain('System [12, 27] and Method [8]')
    }
    if (kind === 'column-punctuation') {
      expect(paragraph.source).toContain('setup3, and confirms')
      expect(
        paragraph.fragments.flatMap((fragment) => fragment.items).some((item) => item.text === ',')
      ).toBe(true)
    }
    expect(paragraph.fragments).toHaveLength(twoPages || kind === 'caption-column' ? 2 : 1)
    const requiredNeighbors = [
      neighbor,
      ...(kind === 'caption-column' ? ['Independent legal notice'] : ['b = q + 1']),
      ...(kind === 'caption-column' ? ['Figure 6.'] : []),
      ...(kind === 'column-punctuation'
        ? ['Figure 7:', 'Neighboring right', 'Its second row']
        : []),
      ...(kind === 'side-floating-page' ? ['Figure 9:', 'Figure 10:'] : []),
      ...(kind === 'floating-page' ? ['Figure 8:', 'Figure 9:'] : [])
    ]
    for (const text of requiredNeighbors) {
      const owner = source.units.find((unit) => unit.source.includes(text))
      expect(owner, text).toBeDefined()
      expect(owner, text).not.toBe(paragraph)
    }
    for (const unit of source.units.filter((unit) =>
      /Figure \d[.:]|b = q \+ 1|Independent neighboring|Neighboring right|Its second row|Independent legal notice/u.test(
        unit.source
      )
    ))
      expect(unit).not.toBe(paragraph)
    const unit = {
        ...paragraph,
        fragments: pdfTranslationLayoutFragments(paragraph, source),
        translation
      },
      writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs')),
      input = {
        id: name,
        data: bytes,
        pages: source.pages,
        preserveUnsupported: true,
        units: [unit]
      },
      output = await writer.generateDetailed(input, caller.lease)
    expect(output!.layoutFailures).toEqual(
      expectedCode
        ? [
            {
              code: expectedCode,
              phase: 'planning',
              pageNumbers: [1],
              fragmentCount: 1,
              unitIndex: 0
            }
          ]
        : []
    )
    const translated = getDocument({ data: output!.data.slice(), useSystemFonts: true })
    onTestFinished(() => translated.destroy())
    const target = await translated.promise,
      placement = await verifyPdfUnits(
        target,
        [{ ...unit, sourceIndex: 0 }],
        output!.layoutFailures,
        original
      ),
      preservation = await verifyPdfPreservation(original, target, [unit], output!.layoutFailures, [
        1,
        ...(twoPages ? [2] : [])
      ])
    if (expectedCode) {
      expect(placement[0]).toMatchObject({ retained: true })
      expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
      expect(preservation.pages.every((page) => page.pixels!.changedPixels === 0)).toBe(true)
      return
    }
    expect(placement[0]).toMatchObject({ translationFound: true, retained: false })
    if (scriptLabels) {
      const content = await (await target.getPage(1)).getTextContent(),
        items = content.items.filter((item) => 'str' in item)
      for (const label of scriptLabels) {
        const indices = items.filter((item) => item.str === label)
        expect(indices).toHaveLength(1)
        const index = indices[0],
          bases = items.filter(
            (item) =>
              item.str.endsWith('d') &&
              index.transform[4] - item.transform[4] - item.width > -item.height * 0.1 &&
              index.transform[4] - item.transform[4] - item.width < item.height * 0.5
          )
        expect(bases).toHaveLength(1)
        expect(index.height / bases[0].height).toBeGreaterThan(0.6)
        expect(index.height / bases[0].height).toBeLessThan(0.85)
        const lower = (bases[0].transform[5] - index.transform[5]) / bases[0].height
        expect(lower).toBeGreaterThan(0.08)
        expect(lower).toBeLessThan(0.4)
      }
    }
    if (mathAlphabet) {
      const content = await (await target.getPage(1)).getTextContent(),
        items = content.items.filter((item) => 'str' in item),
        indices = items.filter((item) => item.str === '𝑛')
      expect(indices).toHaveLength(1)
      for (const index of indices) {
        const bases = items.filter(
          (item) =>
            item.str.endsWith('𝑥') &&
            index.transform[4] - item.transform[4] - item.width > -item.height * 0.1 &&
            index.transform[4] - item.transform[4] - item.width < item.height * 0.5
        )
        expect(bases).toHaveLength(1)
        expect(index.height / bases[0].height).toBeGreaterThan(0.6)
        expect(index.height / bases[0].height).toBeLessThan(0.85)
        const lower = (bases[0].transform[5] - index.transform[5]) / bases[0].height
        expect(lower).toBeGreaterThan(0.08)
        expect(lower).toBeLessThan(0.4)
      }
    }
    if (kind === 'shared-power') {
      const content = await (await target.getPage(1)).getTextContent(),
        items = content.items.filter((item) => 'str' in item),
        signs = items.filter((item) => item.str === '−'),
        powers = [...translation.matchAll(/10⁻³/gu)]
      expect(signs).toHaveLength(powers.length)
      for (const sign of signs) {
        const base = items.filter(
            (item) =>
              item.str.endsWith('10') &&
              Math.abs(item.transform[4] + item.width - sign.transform[4]) < 2
          ),
          digits = items.filter(
            (item) =>
              item.str === '3' &&
              Math.abs(item.transform[5] - sign.transform[5]) < 0.01 &&
              Math.abs(item.transform[4] - sign.transform[4] - sign.width) < 2
          )
        expect(base).toHaveLength(1)
        expect(digits).toHaveLength(1)
        expect(sign.transform[5] - base[0].transform[5]).toBeCloseTo(3.5, 2)
        expect(sign.transform[0]).toBeCloseTo(7, 2)
        expect(digits[0].transform[0]).toBeCloseTo(7, 2)
      }
    }
    expect(preservation.pages.flatMap((page) => page.failures)).toEqual([])
    expect(preservation.pages.every((page) => page.pixels!.changedPixels === 0)).toBe(true)
    await expect(
      writer.generateDetailed(
        { ...input, units: [{ ...unit, source: unit.source.replace(/^\S+/u, 'invented') }] },
        caller.lease
      )
    ).rejects.toThrow('source-mismatch')
    const expanded = {
        ...unit,
        translation: translation + '额外的普通正文继续说明结果。'.repeat(100)
      },
      retained = await writer.generateDetailed({ ...input, units: [expanded] }, caller.lease)
    expect(retained!.layoutFailures).toEqual([
      {
        code: 'overflow',
        phase: 'planning',
        pageNumbers: twoPages ? [1, 2] : [1],
        fragmentCount: twoPages || kind === 'caption-column' ? 2 : 1,
        unitIndex: 0
      }
    ])
    const fallback = getDocument({ data: retained!.data.slice(), useSystemFonts: true })
    onTestFinished(() => fallback.destroy())
    const protectedResult = await verifyPdfPreservation(
      original,
      await fallback.promise,
      [expanded],
      retained!.layoutFailures,
      twoPages ? [1, 2] : [1]
    )
    expect(protectedResult.pages.flatMap((page) => page.failures)).toEqual([])
    expect(protectedResult.pages.every((page) => page.pixels!.changedPixels === 0)).toBe(true)
  }
)
