/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// Keep a single physical package for CJS callers and native ESM translation workers.
// Only the audited version's package-local code is bundled; shared dependencies stay external.
export async function stageDesktopPdfLib(manifest, source, destination) {
  if (manifest.name !== 'pdf-lib' || manifest.version !== '1.17.1') return false
  const { build } = await import('esbuild')
  await mkdir(destination, { recursive: true })
  // The ESM source gives esbuild explicit exports for Node's CJS named-export detection.
  // Bundling cjs/index.js instead silently breaks native ESM named imports.
  await build({
    absWorkingDir: source,
    entryPoints: ['es/index.js'],
    outfile: join(destination, 'cjs/index.js'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true
  })
  for (const file of ['package.json', 'LICENSE.md', 'README.md'])
    await cp(join(source, file), join(destination, file))
  return true
}
