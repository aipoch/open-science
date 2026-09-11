/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const packageDir = join('node_modules', '@shadcn', 'react')
const packageJson = join(packageDir, 'package.json')
if (!existsSync(packageJson)) process.exit(0)
if (JSON.parse(readFileSync(packageJson, 'utf8')).version !== '0.3.0') process.exit(0)

const entry = join(packageDir, 'dist', 'message-scroller', 'index.js')
// patch-package can retain CR characters from a Windows patch checkout, including at EOF.
const installed = readFileSync(entry, 'utf8').replaceAll('\r\n', '\n').replace(/\r$/, '')
const digest = (source) => createHash('sha256').update(source).digest('hex')
// Released cumulative patches, in Git history order. Never overwrite unknown local edits.
const knownPatchedHashes = new Set([
  '6306bf6bd406eb6ecb55ea050c0f1954008fe4e8b77d01c684f33d5dd3d37063', // 81d2bb78
  '6cef30c198329500dd3dc0ff24762cf2335a5f363ab00de33e8e5af4231be756', // cc73bb73
  '4c620c8214a19ea267e9b465e61382699dbb5273ea8d4470fb1be40153db3a97', // 3c6b201e
  '2bf6d13e12fb7f161bd74ddd0c7848a5224ef84dbe3c04acf430bb7d0fb669fc' // 2d0f34d1
])
if (!knownPatchedHashes.has(digest(installed))) process.exit(0)

// This patch contains the complete two-line file. Reuse its original instead of vendoring a copy.
// The checksum fails closed if its format or upstream baseline ever changes.
const lines = readFileSync(join('patches', '@shadcn+react+0.3.0.patch'), 'utf8')
  .replaceAll('\r\n', '\n')
  .split('\n')
const side = (prefix) =>
  lines
    .filter(
      (line) =>
        line.startsWith(' ') || (line.startsWith(prefix) && !line.startsWith(prefix.repeat(3)))
    )
    .map((line) => line.slice(1))
    .join('\n')
if (installed === side('+')) process.exit(0)
const original = side('-')
if (digest(original) !== '75458e9313c0c712b2bcff80b9f4a7cfdc881a30e834fc85fe114b0993c82e41') {
  throw new Error(
    'Unexpected @shadcn/react patch baseline; refusing to replace the installed file.'
  )
}

writeFileSync(entry, original)
console.log('Restored the original @shadcn/react@0.3.0 scroller before applying the current patch.')
