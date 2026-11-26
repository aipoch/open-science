/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { cp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

async function identicalFiles(left, right) {
  const list = (dir) => readdir(dir, { withFileTypes: true })
  const [leftEntries, rightEntries] = await Promise.all([list(left), list(right)])
  if (leftEntries.length !== rightEntries.length) return false
  const byName = new Map(rightEntries.map((entry) => [entry.name, entry]))
  for (const entry of leftEntries) {
    const other = byName.get(entry.name)
    const a = join(left, entry.name)
    const b = join(right, entry.name)
    if (entry.isDirectory() && other?.isDirectory()) {
      if (!(await identicalFiles(a, b))) return false
    } else if (
      !entry.isFile() ||
      !other?.isFile() ||
      !(await readFile(a)).equals(await readFile(b))
    ) {
      return false
    }
  }
  return true
}

export async function shareDesktopPdfLibPako(stage, installed) {
  // Moving to the scope's node_modules also affects sibling lookups. Only share in
  // the audited two-package scope. Bundled JSZip must keep resolving the root pako.
  const scope = join(stage, 'node_modules', '@pdf-lib')
  const fonts = join(scope, 'standard-fonts')
  const upng = join(scope, 'upng')
  const from = join(fonts, 'node_modules', 'pako')
  const duplicate = join(upng, 'node_modules', 'pako')
  const scoped = [...installed.keys()].filter((dir) => dir.startsWith(scope + sep))
  if (
    scoped.length !== 4 ||
    installed.get(fonts) !== '1.0.0' ||
    installed.get(upng) !== '1.0.1' ||
    installed.get(from) !== '1.0.11' ||
    installed.get(duplicate) !== '1.0.11' ||
    !(await identicalFiles(from, duplicate))
  )
    return
  const shared = join(scope, 'node_modules', 'pako')
  await mkdir(dirname(shared), { recursive: true })
  await rename(from, shared)
  await rm(duplicate, { recursive: true })
  installed.delete(from)
  installed.delete(duplicate)
  installed.set(shared, '1.0.11')
}

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
