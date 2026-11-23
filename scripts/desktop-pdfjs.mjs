/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The generic dependency copy retains licenses and the audited runtime entries.
// Preserve pdf.mjs as the entry for every backend consumer, including native ESM workers.
export async function packDesktopPdfJs(source, destination) {
  const maps = join(source, 'cmaps')
  const names = (await readdir(maps)).filter((name) => name.endsWith('.bcmap')).sort()
  if (!names.length) throw new Error('PDF.js has no binary character maps to pack')
  const chunks = []
  const ranges = []
  let offset = 0
  for (const name of names) {
    const bytes = await readFile(join(maps, name))
    ranges.push([name.slice(0, -'.bcmap'.length), [offset, bytes.length]])
    chunks.push(bytes)
    offset += bytes.length
  }
  await writeFile(join(destination, 'cmaps', 'character-maps.bin'), Buffer.concat(chunks))
  const entry = join(destination, 'legacy/build/pdf.mjs')
  await rename(entry, join(destination, 'legacy/build/pdf-upstream.mjs'))
  const { build } = await import('esbuild')
  await build({
    stdin: {
      resolveDir: import.meta.dirname,
      contents: `import { withDesktopCMaps } from './desktop-pdfjs-reader.mjs'
        import { getDocument as upstream } from './pdf-upstream.mjs'
        export * from './pdf-upstream.mjs'
        export const getDocument = withDesktopCMaps(upstream, new Map(${JSON.stringify(ranges)}), import.meta.url)`
    },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['./pdf-upstream.mjs'],
    outfile: entry
  })
}
