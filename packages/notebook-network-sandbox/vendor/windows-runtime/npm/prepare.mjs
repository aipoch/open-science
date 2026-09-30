/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const npmRepair = 'npm-appcontainer-shared-prefix-v1'
const originalDigest = '54fb13b5b30d62115123b24e7b09b28d1ea6fa5363a81aae9ecd337de323662f'
const repairedDigest = '79bf68fd9fe09ebf7fa6c1656e2afb815462c5332aa302d7076c3b4386f1eb87'
const digest = (text) => createHash('sha256').update(text).digest('hex')
const replacement = `// The Notebook host validates this physical directory before granting it.
// Seed only that boundary; links below it retain the normal resolution checks.
module.exports = async (path, rpcache, stcache, depth = 0) => {
  const prefix = process.env.OPEN_SCIENCE_CANONICAL_NPM_PREFIX
  if (process.platform === 'win32' && prefix && !rpcache.has(prefix)) {
    const state = await lstatCached(prefix, stcache)
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error('Notebook npm prefix is not a physical directory')
    }
    rpcache.set(prefix, prefix)
  }
  return realpathCached(path, rpcache, stcache, depth)
}`

// npm is JavaScript copied alongside Node. This staging repair does not change either compiled
// executable or their compiler cache inputs. Refuse unknown npm sources rather than patching a
// different version or silently preserving an unverified manual edit.
export function prepareWindowsNotebookNpm(
  runtime = resolve(dirname(fileURLToPath(import.meta.url)), '../x64')
) {
  const path = join(runtime, 'node/node_modules/npm/node_modules/@npmcli/arborist/lib/realpath.js')
  const source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n')
  const hash = digest(source)
  if (![originalDigest, repairedDigest].includes(hash)) {
    throw new Error('Bundled npm source does not match the pinned shared-prefix repair.')
  }
  const markerPath = join(runtime, 'build.json')
  const marker = JSON.parse(readFileSync(markerPath, 'utf8').replace(/^\uFEFF/, ''))
  if (hash === originalDigest) {
    const repaired = source.replace('module.exports = realpathCached', replacement)
    if (digest(repaired) !== repairedDigest)
      throw new Error('Bundled npm repair checksum mismatch.')
    writeFileSync(`${path}.preparing`, repaired)
    renameSync(`${path}.preparing`, path)
  }
  marker.patches = [...new Set([...(marker.patches ?? []), npmRepair])]
  writeFileSync(markerPath, JSON.stringify(marker, null, 2) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareWindowsNotebookNpm(process.argv[2])
}
