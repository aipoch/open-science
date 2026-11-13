import fs from 'node:fs'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { it, expect } from 'vitest'
import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFDict,
  PDFRawStream,
  decodePDFRawStream,
  StandardFonts
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFRef } from 'pdf-lib'
import { createSourceFragmentRecovery } from '../resources/source-fragments.mjs'
import { engine } from '../resources/pdfium.mjs'
async function fixture(): Promise<Uint8Array> {
  const f = JSON.parse(
    fs
      .readFileSync(
        new URL('./fixtures/numeric-glyph-name-roundtrip.jsonl', import.meta.url),
        'utf8'
      )
      .split('\n')[0]
  )
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([240, 180]),
    body = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('A short anonymous sentence.', { x: 30, y: 80, size: 10, font: body })
  const register = (name: string, unicode: string, width: number): PDFRef => {
    const data = Buffer.from(
      Buffer.from(f.fontProgramHex, 'hex').toString('latin1').replace('SyntheticEncoding', name),
      'latin1'
    )
    const file = pdf.context.register(pdf.context.flateStream(data, { Subtype: 'Type1C' }))
    const descriptor = pdf.context.register(
      pdf.context.obj({
        Type: 'FontDescriptor',
        FontName: name,
        Flags: 6,
        FontBBox: [0, 0, 791, 550],
        ItalicAngle: 0,
        Ascent: 800,
        Descent: -200,
        CapHeight: 550,
        StemV: 80,
        FontFile3: file
      })
    )
    const to = pdf.context.register(
      pdf.context.stream(
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Anonymous def /CMapType 2 def\n1 begincodespacerange <00> <FF> endcodespacerange\n1 beginbfchar <02> <' +
          unicode +
          '> endbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end'
      )
    )
    return pdf.context.register(
      pdf.context.obj({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: name,
        FontDescriptor: descriptor,
        FirstChar: 2,
        LastChar: 2,
        Widths: [width],
        Encoding: { Type: 'Encoding', Differences: [2, PDFName.of('C211')] },
        ToUnicode: to
      })
    )
  }
  page.node
    .Resources()
    .lookup(PDFName.of('Font'), PDFDict)
    .set(PDFName.of('A'), register('AnonymousFixtureA', '0041', 791.3))
  page.node
    .Resources()
    .lookup(PDFName.of('Font'), PDFDict)
    .set(PDFName.of('B'), register('AnonymousFixtureB', '0042', 791))
  page.node.addContentStream(
    pdf.context.register(
      pdf.context.stream('BT /A 10 Tf 1 0 0 1 30 150 Tm <02> Tj /B 10 Tf <02> Tj ET')
    )
  )
  return pdf.save()
}
async function read(
  data: Uint8Array
): Promise<{ index: number; str: string; transform: number[]; width: number; height: number }[]> {
  const d = await getDocument({ data: data.slice(), fontExtraProperties: true }).promise
  try {
    const p = await d.getPage(1),
      c = await p.getTextContent()
    return c.items.flatMap((x, index) => ('str' in x ? [{ index, ...x }] : []))
  } finally {
    await d.destroy()
  }
}
it('preserves the original single native glyph after a fractional font advance and real body replacement', async () => {
  const source = await fixture(),
    native = await read(source),
    bi = native.find((x) => x.str === 'B')!,
    prose = native.find((x) => x.str === 'A short anonymous sentence.')!
  const rect = (
    x: Awaited<ReturnType<typeof read>>[number]
  ): { x: number; y: number; width: number; height: number } => ({
    x: x.transform[4] / 240,
    y: (180 - x.transform[5] - x.height * 0.85) / 180,
    width: x.width / 240,
    height: (x.height * 1.1) / 180
  })
  const req = {
    id: 'single-glyph-origin',
    data: source,
    pages: [{ width: 240, height: 180 }],
    preserveUnsupported: true,
    preserveUnmatched: true,
    units: [
      {
        source: prose.str,
        translation: '这是一段匿名句子。',
        fragments: [
          {
            pageNumber: 1,
            rect: { ...rect(prose), height: 20 / 180 },
            items: [{ index: prose.index, text: prose.str }]
          }
        ]
      },
      {
        source: 'B',
        translation: 'B',
        fragments: [{ pageNumber: 1, rect: rect(bi), items: [{ index: bi.index, text: bi.str }] }]
      }
    ]
  }
  const r = await new Promise<{ data: Uint8Array; layoutFailures: unknown[] }>(
    (resolve, reject) => {
      const w = new Worker(new URL('../resources/worker.mjs', import.meta.url), { workerData: req })
      w.once('message', (m) => {
        void w.terminate()
        resolve(m)
      })
      w.once('error', reject)
    }
  )
  expect(r.layoutFailures).toEqual([])
  const after = await read(r.data),
    glyph = after.find((x) => x.str === 'B')!
  expect(Math.abs(glyph.transform[4] - bi.transform[4])).toBeLessThan(0.001)
  expect(Math.abs(glyph.transform[5] - bi.transform[5])).toBeLessThan(0.001)
  expect(after.map((x) => x.str).join('')).toContain('这是一段匿名句子。AB')
})
const cases: [string, string | null, boolean][] = [
  ['complete', null, true],
  ['gstate-font', '/GS1 gs <02> Tj', false],
  ['multi-glyph', '<0202> Tj', false],
  ['char-spacing', '0.3 Tc <02> Tj', false],
  ['word-spacing', '0.3 Tw <02> Tj', false],
  ['leading-TJ', '[50 <02>] TJ', false],
  ['trailing-TJ', '[<02> 50] TJ', false],
  ['horizontal-scale', '80 Tz <02> Tj', false],
  ['text-rise', '1 Ts <02> Tj', false],
  ['merged-shows', '<02> Tj <02> Tj', false],
  ['native-literal-mismatch', null, false],
  ['duplicate-native', null, false],
  ['changed-font-program', null, false]
]
it.each(cases)('certifies only a complete native glyph: %s', async (name, replace, expected) => {
  const original = await fixture(),
    e = await engine()
  const meta = await PDFDocument.load(original, { updateMetadata: false })
  if (replace) {
    const page = meta.getPages()[0],
      c = page.node.lookup(PDFName.of('Contents')),
      refs = c instanceof PDFArray ? c.asArray() : [page.node.get(PDFName.of('Contents'))]
    const fresh = refs.map((ref) => {
      const s = meta.context.lookup(ref),
        raw = Buffer.from(decodePDFRawStream(s as PDFRawStream).decode()).toString('latin1')
      return raw.includes('/B 10 Tf <02> Tj')
        ? meta.context.register(
            meta.context.flateStream(
              Buffer.from(raw.replace('/B 10 Tf <02> Tj', '/B 10 Tf ' + replace), 'latin1')
            )
          )
        : ref
    })
    page.node.set(PDFName.of('Contents'), meta.context.obj(fresh))
  }
  if (name === 'gstate-font') {
    const r = meta.getPages()[0].node.Resources()
    r.set(
      PDFName.of('ExtGState'),
      meta.context.obj({
        GS1: {
          Type: 'ExtGState',
          Font: [r.lookup(PDFName.of('Font'), PDFDict).get(PDFName.of('B')), 10]
        }
      })
    )
  }
  if (name === 'changed-font-program') {
    const f = meta
        .getPages()[0]
        .node.Resources()
        .lookup(PDFName.of('Font'), PDFDict)
        .lookup(PDFName.of('B'), PDFDict),
      desc = f.lookup(PDFName.of('FontDescriptor'), PDFDict),
      stream = desc.lookup(PDFName.of('FontFile3')) as PDFRawStream
    const data = Buffer.from(
      Buffer.from(decodePDFRawStream(stream).decode())
        .toString('latin1')
        .replace('AnonymousFixtureB', 'AnonymousFixtureC'),
      'latin1'
    )
    desc.set(
      PDFName.of('FontFile3'),
      meta.context.register(meta.context.flateStream(data, { Subtype: 'Type1C' }))
    )
  }
  const data = replace || name === 'changed-font-program' ? await meta.save() : original
  const native = e.open(name === 'changed-font-program' ? original : data),
    page = e.p.FPDF_LoadPage(native.doc, 0)
  let objects = e.objects(page)
  if (name === 'native-literal-mismatch') {
    const obj = objects.find((x) => x.text === 'B')
    const bytes = e.bytes(Buffer.from('BB\0', 'utf16le'))
    try {
      assert(e.p.FPDFText_SetText(obj.obj, bytes))
    } finally {
      e.free(bytes)
    }
    objects = e.objects(page)
  }
  if (name === 'duplicate-native') objects = [...objects, objects.find((x) => x.text === 'B')]
  const source = await PDFDocument.load(data, { updateMetadata: false }),
    recovery = createSourceFragmentRecovery(data, [{ width: 240, height: 180 }])
  const proof = await recovery.originalTextOrigins(
    e,
    page,
    objects,
    1,
    source.getPages()[0].node.Resources()
  )
  const admitted = [...(proof?.values() ?? [])].some((x) => x.text === 'B')
  assert.equal(admitted, expected, name)
  await recovery.close()
  await recovery.close()
  e.p.FPDF_ClosePage(page)
  native.close()
})
