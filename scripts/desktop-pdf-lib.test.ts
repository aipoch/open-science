import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { stageDesktopPdfLib } from './desktop-pdf-lib.mjs'

it('keeps unknown versions and other dependencies on the ordinary copy path', async () => {
  for (const manifest of [
    { name: 'pdf-lib', version: '1.17.2' },
    { name: 'other', version: '1.17.1' }
  ])
    expect(await stageDesktopPdfLib(manifest, 'missing-source', 'unused-target')).toBe(false)
})

it('consolidates the real package while preserving native ESM/CJS identity and PDF behavior', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-pdf-lib-'))
  const require = createRequire(import.meta.url)
  const source = dirname(require.resolve('pdf-lib/package.json'))
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const target = join(root, 'node_modules/pdf-lib')
  try {
    const copied = new Set<string>()
    const copyDependency = async (name: string, from: string): Promise<void> => {
      if (copied.has(name)) return
      copied.add(name)
      let directory = dirname(createRequire(join(from, 'package.json')).resolve(name))
      while (
        (await readFile(join(directory, 'package.json'), 'utf8')
          .then((text) => JSON.parse(text).name)
          .catch(() => undefined)) !== name
      ) {
        const parent = dirname(directory)
        if (parent === directory) throw new Error(`Missing package root: ${name}`)
        directory = parent
      }
      await cp(directory, join(root, 'node_modules', name), { recursive: true })
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      for (const dependency of Object.keys(pkg.dependencies ?? {}))
        await copyDependency(dependency, directory)
    }
    for (const name of Object.keys(manifest.dependencies)) await copyDependency(name, source)
    expect(await stageDesktopPdfLib(manifest, source, target)).toBe(true)
    expect((await readdir(target)).sort()).toEqual([
      'LICENSE.md',
      'README.md',
      'cjs',
      'package.json'
    ])
    expect((await readdir(join(target, 'cjs'))).sort()).toEqual(['index.js', 'index.js.map'])
    for (const file of ['package.json', 'LICENSE.md', 'README.md'])
      expect(await readFile(join(target, file), 'utf8')).toBe(
        await readFile(join(source, file), 'utf8')
      )
    await cp(source, join(root, 'baseline'), { recursive: true })
    await mkdir(join(root, 'node_modules/consumer'), { recursive: true })
    await writeFile(
      join(root, 'node_modules/consumer/index.js'),
      "module.exports = require('pdf-lib')"
    )
    await writeFile(
      join(root, 'check.mjs'),
      `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
      const require = createRequire(import.meta.url);
      const candidate = require('pdf-lib'), baseline = require('./baseline');
      assert.equal(PDFDocument, candidate.PDFDocument);
      assert.equal(PDFName, require('consumer').PDFName);
      assert.deepEqual(Object.keys(candidate).sort(), Object.keys(baseline).sort());
      async function document(lib) {
        const pdf = await lib.PDFDocument.create();
        pdf.setCreationDate(new Date('2020-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2020-01-01T00:00:00Z'));
        const page = pdf.addPage([400, 300]);
        const font = await pdf.embedFont(lib.StandardFonts.Helvetica);
        page.drawText('Install package roundtrip', { font, x: 30, y: 200 });
        const png = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', 'base64'));
        page.drawImage(png, { x: 20, y: 20, width: 10, height: 10 });
        const field = pdf.getForm().createTextField('name');
        field.setText('Ada'); field.addToPage(page, { x: 30, y: 80, width: 100, height: 20 });
        return pdf.save();
      }
      const before = await document(baseline), after = await document(candidate);
      assert.deepEqual(after, before);
      for (const lib of [baseline, candidate]) {
        const loaded = await lib.PDFDocument.load(after);
        assert.equal(loaded.getPageCount(), 1);
        assert.equal(loaded.getForm().getTextField('name').getText(), 'Ada');
        const copy = await lib.PDFDocument.create();
        copy.addPage((await copy.copyPages(loaded, [0]))[0]);
        assert.equal((await lib.PDFDocument.load(await copy.save())).getPageCount(), 1);
      }
      console.log('PDF exports, shared identity, fonts, PNG, forms and cross-load roundtrip passed');
    `
    )
    expect(
      execFileSync(process.execPath, [join(root, 'check.mjs')], { encoding: 'utf8' })
    ).toContain('roundtrip passed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
