import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

import { PDFDocument, PDFName, StandardFonts, type PDFRef } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'

it.each(['legacy', 'modern'] as const)(
  'PDF.js %s exposes diagnostic missing-Unicode and zero-advance paths without changing font rendering',
  (flavor) => {
    const require = createRequire(import.meta.url)
    const source = ts.createSourceFile(
      'worker.mjs',
      readFileSync(
        require.resolve(`pdfjs-dist/${flavor === 'legacy' ? 'legacy/' : ''}build/pdf.worker.mjs`),
        'utf8'
      ),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    )
    const evaluator = source.statements.find(
      (node): node is ts.ClassDeclaration =>
        ts.isClassDeclaration(node) && node.name?.text === 'PartialEvaluator'
    )!
    const method = evaluator.members.find(
      (node): node is ts.MethodDeclaration =>
        ts.isMethodDeclaration(node) && node.name.getText(source) === 'handleText'
    )!
    const calls: unknown[][] = []
    let throwPath = false
    // Execute the installed worker method, retaining its original branch and
    // error semantics. Anonymous glyphs require no external font/PDF fixture.
    const handle = new Function(
      'PartialEvaluator',
      'TextRenderingMode',
      `return function(chars, state) ${method.body!.getText(source)}`
    )(
      {
        buildFontPaths: (...args: unknown[]) => {
          calls.push(args)
          if (throwPath) throw new Error('invalid outline')
        }
      },
      { ADD_TO_PATH_FLAG: 4 }
    )
    const missing = {
      unicode: '\f',
      originalCharCode: 12,
      fontChar: '\ue00c',
      isInFont: true,
      isSpace: false,
      accent: null
    }
    const normal = { ...missing, unicode: 'A', originalCharCode: 65, fontChar: 'A' }
    const glyphs = [normal, missing]
    const font = {
      data: new Uint8Array([1]),
      disableFontFace: false,
      missingFile: false,
      vertical: false,
      isType3Font: false,
      toUnicode: { _map: {} as Record<number, string> },
      charsToGlyphs: () => glyphs
    }
    const state = {
      font,
      textRenderingMode: 0,
      fillColorSpace: { name: 'DeviceRGB' },
      strokeColorSpace: { name: 'DeviceRGB' }
    }
    const owner = { options: { fontExtraProperties: true, ignoreErrors: false }, handler: {} }
    expect(handle.call(owner, 'encoded', state)).toBe(glyphs)
    expect(calls).toEqual([[font, [missing], owner.handler, owner.options]])
    expect(font.disableFontFace).toBe(false)
    calls.length = 0
    const zeroAdvance = { ...normal, width: 0 }
    font.charsToGlyphs = () => [zeroAdvance]
    handle.call(owner, 'encoded', state)
    expect(calls).toEqual([[font, [zeroAdvance], owner.handler, owner.options]])
    expect(font.disableFontFace).toBe(false)
    calls.length = 0
    for (const override of [{ isInFont: false }, { accent: {} }, { fontChar: '' }]) {
      font.charsToGlyphs = () => [Object.assign({}, zeroAdvance, override)]
      handle.call(owner, 'encoded', state)
      expect(calls).toEqual([])
    }
    font.charsToGlyphs = () => glyphs
    owner.options.fontExtraProperties = false
    handle.call(owner, 'encoded', state)
    expect(calls).toEqual([])
    owner.options.fontExtraProperties = true
    for (const override of [
      { isInFont: false },
      { isSpace: true },
      { accent: {} },
      { fontChar: '' },
      { unicode: 'A' },
      { originalCharCode: -1 },
      { originalCharCode: 1.5 }
    ]) {
      font.charsToGlyphs = () => [Object.assign({}, missing, override) as typeof missing]
      handle.call(owner, 'encoded', state)
      expect(calls).toEqual([])
    }
    font.charsToGlyphs = () => glyphs
    for (const key of ['missingFile', 'vertical', 'isType3Font'] as const) {
      font[key] = true
      handle.call(owner, 'encoded', state)
      expect(calls).toEqual([])
      font[key] = false
    }
    font.toUnicode._map[12] = 'known'
    handle.call(owner, 'encoded', state)
    expect(calls).toEqual([])
    delete font.toUnicode._map[12]
    throwPath = true
    expect(() => handle.call(owner, 'encoded', state)).not.toThrow()
    expect(calls).toHaveLength(1)
    calls.length = 0
    font.disableFontFace = true
    expect(() => handle.call(owner, 'encoded', state)).toThrow('invalid outline')
    expect(calls[0][1]).toBe(glyphs)
  }
)

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

async function numberedPagesPdf(label: string, count: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= count; number++) {
    const page = pdf.addPage([240, 180])
    page.drawText(`${label} page ${number}`, { font, size: 12, x: 20, y: 100 })
  }
  return pdf.save()
}

const isolatedDocumentMappingProbe = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DOMMatrix, Path2D, ImageData } from '@napi-rs/canvas';
Object.assign(globalThis, { DOMMatrix, Path2D, ImageData });
const require = createRequire(process.cwd() + '/package.json');
const { flavor, wide, short } = JSON.parse(readFileSync(0, 'utf8'));
const entry = flavor === 'legacy' ? 'legacy/build' : 'build';
if (flavor === 'modern') await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
const worker = pathToFileURL(require.resolve('pdfjs-dist/' + entry + '/pdf.worker.mjs')).href;
globalThis.pdfjsWorker = await import(worker);
const { getDocument, GlobalWorkerOptions } = await import(pathToFileURL(require.resolve('pdfjs-dist/' + entry + '/pdf.mjs')).href);
GlobalWorkerOptions.workerSrc = worker;
const load = data => getDocument({ data: Uint8Array.from(Buffer.from(data, 'base64')), useSystemFonts: true, verbosity: 0 });
const text = async (pdf, n) => (await (await pdf.getPage(n)).getTextContent()).items.filter(i => 'str' in i).map(i => i.str).join('');
const results = [];
for (const reverse of [false, true]) {
 const tasks = [];
 let reopened;
 try {
  // Resolve each opening in a controlled order while keeping both documents
  // alive. This makes the old shared-state failure deterministic.
  for (const data of reverse ? [short, wide] : [wide, short]) {
   const task = load(data);
   tasks.push(task);
   await task.promise;
  }
  const docs = await Promise.all(tasks.map(t => t.promise));
  const [a, b] = reverse ? docs.toReversed() : docs;
  assert.equal(a.numPages, 3);
  assert.equal(b.numPages, 1);
  // This public read fails under the previous singleton when the shorter
  // document replaces the larger document's page-count/mapping state.
  assert.equal(await text(a, 3), 'Wide page 3');
  assert.equal(await text(b, 1), 'Short page 1');
  assert.notEqual(a.pagesMapper, b.pagesMapper);
  const aPages = await Promise.all([1, 2, 3].map(n => a.getPage(n)));
  let aEvents = 0, bEvents = 0;
  a.pagesMapper.addListener(() => aEvents++);
  b.pagesMapper.addListener(() => bEvents++);
  a.pagesMapper.movePages(new Set([3]), [3], 0);
  assert.deepEqual([...a.pagesMapper.getMapping()], [3, 1, 2]);
  assert.equal(b.pagesMapper.pagesNumber, 1);
  assert.equal(await text(b, 1), 'Short page 1');
  assert.equal(aEvents, 1);
  assert.equal(bEvents, 0);
  assert.equal(await a.getPage(1), aPages[2]);
  assert.equal(await a.getPageIndex(aPages[2].ref), 0);
  assert.equal(a.cachedPageNumber(aPages[2].ref), 1);
  // PDFViewer updates reused proxies after its page-edit notification.
  for (let n = 1; n <= a.numPages; n++) (await a.getPage(n)).pageNumber = n;
  await assert.rejects(b.getPage(2), /Invalid page request/);
  await (reverse ? tasks[0] : tasks[1]).destroy();
  assert.equal(await text(a, 1), 'Wide page 3');
  reopened = load(short);
  const fresh = await reopened.promise;
  assert.equal(await text(fresh, 1), 'Short page 1');
  assert.deepEqual([...a.pagesMapper.getMapping()], [3, 1, 2]);
  await (reverse ? tasks[1] : tasks[0]).destroy();
  assert.equal(await text(fresh, 1), 'Short page 1');
  results.push({ reverse, passed: true });
 } finally {
  await Promise.all([...tasks, ...(reopened ? [reopened] : [])].map(t => t.destroy()));
 }
}
console.log(JSON.stringify({ results }));
`

it.each(['legacy', 'modern'] as const)(
  'PDF.js %s keeps page reads, mappings and lifetimes local to each document',
  async (flavor) => {
    const [wide, short] = await Promise.all([
      numberedPagesPdf('Wide', 3),
      numberedPagesPdf('Short', 1)
    ])
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', isolatedDocumentMappingProbe],
      {
        input: JSON.stringify({
          flavor,
          wide: Buffer.from(wide).toString('base64'),
          short: Buffer.from(short).toString('base64')
        }),
        encoding: 'utf8'
      }
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toEqual({
      results: [
        { reverse: false, passed: true },
        { reverse: true, passed: true }
      ]
    })
  }
)
