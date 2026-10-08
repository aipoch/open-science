import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// App-owned assets only. Recompute so a dev worker/font update cannot reuse an older PDF.
export async function pdfTranslationCacheRevision(
  resources: string,
  appVersion: string
): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(['pdf-translation-cache', appVersion]))
  const require = createRequire(pathToFileURL(join(resources, 'worker.mjs')))
  for (const dependency of ['pdf-lib', 'fontkit', '@embedpdf/pdfium']) {
    let directory = dirname(require.resolve(dependency))
    for (;;) {
      const manifest = await readFile(join(directory, 'package.json'), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        }
      )
      if (manifest && JSON.parse(manifest).name === dependency) {
        hash.update(dependency).update(manifest)
        break
      }
      const parent = dirname(directory)
      if (parent === directory) throw new Error('PDF generator dependency is unavailable.')
      directory = parent
    }
  }
  hash.update(await readFile(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
  for (const name of (await readdir(resources))
    .filter((name) => /\.(?:mjs|otf|ttf|woff2?)$/u.test(name))
    .sort()) {
    hash.update(name).update(await readFile(join(resources, name)))
  }
  return hash.digest('hex')
}
