import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { pdfTranslationCacheRevision } from './cache-revision'

let root: string
async function fixture(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'pdf-cache-revision-'))
  for (const name of ['pdf-lib', 'fontkit', '@embedpdf/pdfium']) {
    const directory = join(root, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    await writeFile(join(directory, 'index.js'), '')
  }
  await writeFile(join(root, 'node_modules/@embedpdf/pdfium/pdfium.wasm'), 'wasm')
  const resources = join(root, 'resources/pdf-translation')
  await mkdir(resources, { recursive: true })
  await writeFile(join(resources, 'worker.mjs'), 'worker')
  await writeFile(join(resources, 'layout.mjs'), 'layout')
  await writeFile(join(resources, 'font.otf'), 'font')
  return resources
}
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

it.each(['worker.mjs', 'layout.mjs', 'font.otf'])(
  'invalidates cached PDFs when the bundled %s changes',
  async (file) => {
    const resources = await fixture()
    const previous = await pdfTranslationCacheRevision(resources, '1.0')
    expect(await pdfTranslationCacheRevision(resources, '1.0')).toBe(previous)
    await writeFile(join(resources, file), 'changed')
    expect(await pdfTranslationCacheRevision(resources, '1.0')).not.toBe(previous)
  }
)

it('includes application, dependency and PDFium binary revisions', async () => {
  const resources = await fixture()
  const first = await pdfTranslationCacheRevision(resources, '1.0')
  expect(await pdfTranslationCacheRevision(resources, '1.1')).not.toBe(first)
  await writeFile(
    join(root, 'node_modules/fontkit/package.json'),
    JSON.stringify({ name: 'fontkit', version: '1.1.0' })
  )
  const second = await pdfTranslationCacheRevision(resources, '1.0')
  expect(second).not.toBe(first)
  await writeFile(join(root, 'node_modules/@embedpdf/pdfium/pdfium.wasm'), 'new wasm')
  expect(await pdfTranslationCacheRevision(resources, '1.0')).not.toBe(second)
})

it('does not let declarations invalidate PDFs and refuses missing runtime assets', async () => {
  const resources = await fixture()
  const first = await pdfTranslationCacheRevision(resources, '1.0')
  await writeFile(join(resources, 'layout.d.mts'), 'changed types')
  expect(await pdfTranslationCacheRevision(resources, '1.0')).toBe(first)
  await rm(join(root, 'node_modules/@embedpdf/pdfium/pdfium.wasm'))
  await expect(pdfTranslationCacheRevision(resources, '1.0')).rejects.toThrow()
})
