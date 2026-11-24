import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { createDesktopDependencyFilter } from './backend-dependencies.mjs'
import { packDesktopPdfJs } from './desktop-pdfjs.mjs'

it('packs only the audited desktop maps and forwards other PDF.js reader options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-pdfjs-'))
  try {
    const source = join(root, 'source')
    const target = join(root, 'target')
    const maps = join(target, 'cmaps')
    const entry = join(target, 'legacy/build/pdf.mjs')
    await mkdir(join(source, 'cmaps'), { recursive: true })
    await mkdir(maps, { recursive: true })
    await mkdir(join(target, 'legacy/build'), { recursive: true })
    const manifest = { name: 'pdfjs-dist', version: '5.4.624' }
    const filter = createDesktopDependencyFilter(manifest)
    for (const file of [
      'cmaps/A.bcmap',
      'legacy/web/images/icon.svg',
      'legacy/build/pdf.min.mjs'
    ]) {
      expect(filter(file, false)).toBe(false)
      expect(createDesktopDependencyFilter({ ...manifest, version: 'other' })(file, false)).toBe(
        true
      )
    }
    for (const file of ['cmaps/LICENSE', 'legacy/web/LICENSE', 'legacy/build/pdf.worker.mjs'])
      expect(filter(file, false)).toBe(true)

    await writeFile(join(source, 'cmaps/B.bcmap'), Buffer.from([4, 5]))
    await writeFile(join(source, 'cmaps/A.bcmap'), Buffer.from([1, 2, 3]))
    await writeFile(
      entry,
      'export const getDocument = options => options; export const version = "fixture"'
    )
    await packDesktopPdfJs(source, target)
    const pdf = await import(pathToFileURL(entry).href)
    expect(pdf.version).toBe('fixture')
    const equivalentFileUrl = new URL('./cmaps/./', pathToFileURL(join(maps, '..') + sep)).href
    for (const cMapUrl of [maps + '/', pathToFileURL(maps).href + '/', equivalentFileUrl]) {
      const options = pdf.getDocument({ cMapUrl })
      const reader = new options.CMapReaderFactory()
      expect(await reader.fetch({ name: 'A' })).toEqual({
        cMapData: Uint8Array.of(1, 2, 3),
        isCompressed: true
      })
      expect(await reader.fetch({ name: 'B' })).toEqual({
        cMapData: Uint8Array.of(4, 5),
        isCompressed: true
      })
      await expect(reader.fetch({ name: 'unknown' })).rejects.toThrow()
    }
    for (const options of [
      { cMapUrl: 'https://example.com/maps/' },
      { cMapUrl: maps + '/', CMapReaderFactory: class {} },
      { cMapUrl: maps + '/', cMapPacked: false },
      { cMapUrl: maps + '/', useWorkerFetch: true }
    ])
      expect(pdf.getDocument(options)).toBe(options)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
