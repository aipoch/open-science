import { spawnSync } from 'node:child_process'

import { PDFDocument, PDFName, type PDFRef } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

// Equal Tf names/sizes deliberately select different fonts in the parent and
// Form. Code 31 is a real fi ligature in one encoding and NBSP in the other.
async function scopedFontPdf(
  kind: 'different-local-font' | 'inherited-resources' | 'inherited-font' | 'real-ligature'
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const context = pdf.context
  const font = (ligature: boolean): PDFRef =>
    context.register(
      context.obj({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'Helvetica',
        Encoding: {
          Type: 'Encoding',
          BaseEncoding: 'WinAnsiEncoding',
          Differences: [31, PDFName.of(ligature ? 'f_i' : 'uni00A0')]
        },
        ToUnicode: context.register(
          context.flateStream(
            `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /ScopedFont def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
1 beginbfchar <1F> <${ligature ? '00660069' : '00A0'}> endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`
          )
        )
      })
    )
  const parent = font(true)
  const child = font(kind === 'real-ligature')
  const form = context.register(
    context.flateStream(
      `BT ${kind === 'inherited-font' ? '' : '/F1 1 Tf'}
8 0 0 8 20 80 Tm (First\x1fLast) Tj ET`,
      {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 200, 200],
        ...(kind === 'inherited-resources' ? {} : { Resources: { Font: { F1: child } } })
      }
    )
  )
  const page = pdf.addPage([200, 200])
  page.node.set(
    PDFName.of('Resources'),
    context.obj({ Font: { F1: parent }, XObject: { Fm: form } })
  )
  page.node.set(
    PDFName.of('Contents'),
    context.register(
      context.flateStream(
        'BT /F1 1 Tf 12 0 0 12 20 150 Tm (Before\x1fText) Tj ET\n' +
          'q /Fm Do Q\n' +
          'BT /F1 1 Tf 12 0 0 12 20 30 Tm (After\x1fText) Tj ET'
      )
    )
  )
  return pdf.save()
}

const isolatedWorkerProbe = `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DOMMatrix, Path2D, ImageData } from '@napi-rs/canvas';
Object.assign(globalThis, { DOMMatrix, Path2D, ImageData });
const require = createRequire(process.cwd() + '/package.json');
const { flavor, fixtures } = JSON.parse(readFileSync(0, 'utf8'));
const entry = flavor === 'legacy' ? 'legacy/build' : 'build';
const workerPath = require.resolve('pdfjs-dist/' + entry + '/pdf.worker.mjs');
// The browser build expects newer TypedArray methods than our Node runtime.
// Import only the legacy display polyfills; the selected worker remains modern.
if (flavor === 'modern') await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
// Each variant has its own process and explicitly selected installed worker.
globalThis.pdfjsWorker = await import(pathToFileURL(workerPath).href);
const { getDocument, GlobalWorkerOptions } = await import(pathToFileURL(require.resolve('pdfjs-dist/' + entry + '/pdf.mjs')).href);
GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
const results = {};
for (const [kind, data] of Object.entries(fixtures)) {
 const task = getDocument({ data: Uint8Array.from(Buffer.from(data, 'base64')), useSystemFonts: true });
 try {
  const pdf = await task.promise;
  const content = await (await pdf.getPage(1)).getTextContent();
  results[kind] = content.items.filter(item => item.str?.trim()).map(item => item.str);
 } finally { await task.destroy(); }
}
console.log(JSON.stringify({ workerPath, results }));
`

describe.each(['legacy', 'modern'] as const)('PDF.js %s worker Form resource scope', (flavor) => {
  let results: Record<Parameters<typeof scopedFontPdf>[0], string[]>
  beforeAll(async () => {
    const fixtures = Object.fromEntries(
      await Promise.all(
        (
          [
            'different-local-font',
            'inherited-resources',
            'inherited-font',
            'real-ligature'
          ] as const
        ).map(async (kind) => [kind, Buffer.from(await scopedFontPdf(kind)).toString('base64')])
      )
    )
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', isolatedWorkerProbe], {
      input: JSON.stringify({ flavor, fixtures }),
      encoding: 'utf8'
    })
    expect(result.status, result.stderr).toBe(0)
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
    expect(output.workerPath.replaceAll('\\', '/')).toContain(
      flavor === 'legacy' ? '/legacy/build/pdf.worker.mjs' : '/pdfjs-dist/build/pdf.worker.mjs'
    )
    results = output.results
  })
  function text(kind: Parameters<typeof scopedFontPdf>[0]): string[] {
    return results[kind]
  }

  it('reloads an equal font name and size against different local resources', () => {
    expect(text('different-local-font')).toEqual(['BeforefiText', 'First Last', 'AfterfiText'])
  })

  it('keeps inherited resources when the Form has no local resources', () => {
    expect(text('inherited-resources')).toEqual(['BeforefiText', 'FirstfiLast', 'AfterfiText'])
  })

  it('keeps the inherited font until the Form explicitly selects Tf', () => {
    expect(text('inherited-font')).toEqual(['BeforefiText', 'FirstfiLast', 'AfterfiText'])
  })

  it('does not erase genuine ligature text in another local font', () => {
    expect(text('real-ligature')).toEqual(['BeforefiText', 'FirstfiLast', 'AfterfiText'])
  })
})
