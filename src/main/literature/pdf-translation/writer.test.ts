import { FileMatcher } from 'app-builder-lib/out/fileMatcher'
import { load } from 'js-yaml'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { type PdfTranslationPdfRequest } from '../../../shared/pdf-translation'
import { ApplicationCallerLeaseRegistry } from '../../caller-lifecycle'
import { PdfTranslationWriter } from './writer'

async function fixture(): Promise<PdfTranslationPdfRequest> {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < 2; i++) {
    const page = pdf.addPage([612, 792])
    page.drawText('Cell growth is measured.', { font, x: 40, y: 700, size: 12 })
    page.drawText('p = 0.05; n = 128', { font, x: 40, y: 600, size: 10 })
    page.drawRectangle({ x: 40, y: 200, width: 180, height: 180, borderWidth: 1 })
  }
  return {
    id: 'render',
    data: await pdf.save(),
    pages: [
      { width: 612, height: 792 },
      { width: 612, height: 792 }
    ],
    units: [1, 2].map((pageNumber) => ({
      source: 'Cell growth is measured.',
      translation: '测量细胞生长。',
      fragments: [
        { pageNumber, rect: { x: 40 / 612, y: 70 / 792, width: 220 / 612, height: 35 / 792 } }
      ]
    }))
  }
}
const lease = (): ReturnType<ApplicationCallerLeaseRegistry['acquire']> =>
  new ApplicationCallerLeaseRegistry().acquire({ leaseId: 'reader', surface: 'electron' })

it('ships the existing Noto font license and explicit physical worker dependencies', async () => {
  const license = await readFile('packages/pdf-translation/resources/OFL.txt', 'utf8')
  expect(license).toContain('SIL OPEN FONT LICENSE')
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  for (const name of ['@aipoch/pdf-translation', '@embedpdf/pdfium', 'fontkit', 'pdf-lib'])
    expect(manifest.dependencies[name]).toEqual(expect.stringMatching(/\S/))
})

it.each(['installed', '安装 package'])(
  'generates a readable translated PDF from the configured physical backend boundary (%s)',
  async (installationDirectory) => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-translation-backend-')),
      source = join(root, 'out/desktop-backend'),
      resources = join(root, installationDirectory, 'resources'),
      backend = join(resources, 'backend'),
      copied = new Set<string>(),
      caller = lease()
    let document: ReturnType<typeof getDocument> | undefined
    try {
      const config = load(await readFile('electron-builder.yml', 'utf8')) as {
        extraResources: Array<{ from: string; to: string; filter?: string[] }>
      }
      const copyPackage = async (
        name: string,
        from: ReturnType<typeof createRequire>
      ): Promise<void> => {
        let directory = dirname(from.resolve(name))
        let metadata: { name: string; dependencies?: Record<string, string> }
        for (;;) {
          metadata = await readFile(join(directory, 'package.json'), 'utf8')
            .then((text) => JSON.parse(text))
            .catch(() => ({ name: '' }))
          if (metadata.name === name) break
          const parent = dirname(directory)
          if (parent === directory) throw new Error(`Missing package root: ${name}`)
          directory = parent
        }
        // Preserve nested dependency versions at their installed relative location.
        const parts = directory.split(sep)
        const moduleRoot = parts.indexOf('node_modules')
        if (moduleRoot < 0) throw new Error(`Package is outside an installed module tree: ${name}`)
        const location = parts.slice(moduleRoot + 1).join(sep)
        expect(isAbsolute(location) || location.startsWith('..')).toBe(false)
        if (copied.has(directory)) return
        copied.add(directory)
        const target = join(source, 'node_modules', location)
        await mkdir(dirname(target), { recursive: true })
        await cp(directory, target, { recursive: true })
        for (const dependency of Object.keys(metadata.dependencies ?? {}))
          await copyPackage(dependency, createRequire(join(directory, 'package.json')))
      }
      await mkdir(join(source, 'resources'), { recursive: true })
      // An ancestor's module type must not substitute for the backend manifest.
      await writeFile(join(root, 'package.json'), '{"type":"module"}')
      await writeFile(join(source, 'package.json'), '{"type":"commonjs"}')
      await cp(
        'packages/pdf-translation/resources',
        join(source, 'node_modules', '@aipoch', 'pdf-translation', 'resources'),
        {
          recursive: true
        }
      )
      const require = createRequire(resolve('package.json'))
      for (const name of ['@embedpdf/pdfium', 'fontkit', 'pdf-lib'])
        await copyPackage(name, require)
      // electron-builder exports this runtime helper without a declaration.
      const { copyFiles } = require('app-builder-lib/out/fileMatcher') as {
        copyFiles(matchers: FileMatcher[]): Promise<void>
      }
      await copyFiles(
        config.extraResources
          .filter((entry) => entry.to === 'backend' || entry.to.startsWith('backend/'))
          .map(
            (entry) =>
              new FileMatcher(
                join(root, entry.from),
                join(resources, entry.to),
                (value) => value,
                entry.filter
              )
          )
      )
      // Execute only the installed copy; dependencies must not fall back to staging.
      await rm(source, { recursive: true, force: true })
      const workerResources = join(
        backend,
        'node_modules',
        '@aipoch',
        'pdf-translation',
        'resources'
      )
      for (const file of [
        'worker.mjs',
        'form-labels.mjs',
        'link-labels.mjs',
        'scientific-scripts.mjs',
        'NotoSansSC-Regular.otf',
        'OFL.txt'
      ])
        expect((await readFile(join(workerResources, file))).length).toBeGreaterThan(0)
      expect(JSON.parse(await readFile(join(backend, 'package.json'), 'utf8')).type).toBe(
        'commonjs'
      )
      const writer = new PdfTranslationWriter(() => join(workerResources, 'worker.mjs'))
      const output = await writer.generate(await fixture(), caller.lease)
      expect(output).toBeInstanceOf(Uint8Array)
      document = getDocument({ data: output!, useSystemFonts: true })
      const pdf = await document.promise
      expect(pdf.numPages).toBe(2)
      for (let number = 1; number <= 2; number++) {
        const page = await pdf.getPage(number)
        const text = (await page.getTextContent()).items
          .flatMap((item) => ('str' in item ? [item.str] : []))
          .join('')
        expect(text).toContain('测量细胞生长。')
        expect(text).toContain('p = 0.05; n = 128')
      }
    } finally {
      await document?.destroy()
      caller.release()
      await rm(root, { recursive: true, force: true })
    }
  },
  60000
)
