/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dump, load } from 'js-yaml'
import { validateUpdateFeed } from '../../scripts/release-artifact-validation.mjs'

// Staging on the destination filesystem lets the feed reference only a finished patch.
// The caller provides a directory for the previous official installer and its original feed.
const [oldDir, newDir, worker, hdiff, seven = '7z'] = process.argv.slice(2)
function installer(dir) {
  const feed = load(readFileSync(join(dir, 'latest.yml'), 'utf8'))
  if (typeof feed.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(feed.version))
    throw new Error('Expected a stable Windows release')
  validateUpdateFeed(feed, dir, feed.version)
  const file = feed.files.find((entry) => entry.url.endsWith('-win-x64-setup.exe'))
  if (!file) throw new Error('Missing Windows x64 installer')
  return { feed, file, path: resolve(dir, file.url) }
}
const old = installer(oldDir)
const target = installer(newDir)
const name = target.file.url + '.from-' + old.feed.version + '.wex'
const stage = mkdtempSync(join(newDir, '.windows-delta-'))
try {
  execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      'build/windows-delta/generate.py',
      old.path,
      target.path,
      join(stage, name),
      join(stage, 'meta.json'),
      '--worker',
      worker,
      '--hdiff',
      hdiff,
      '--seven',
      seven
    ],
    { stdio: 'inherit' }
  )
  const meta = JSON.parse(readFileSync(join(stage, 'meta.json'), 'utf8'))
  if (meta.sourceSha512 !== old.file.sha512) throw new Error('Unexpected source digest')
  target.file.windowsDelta = { ...meta, from: old.feed.version }
  writeFileSync(join(stage, 'latest.yml'), dump(target.feed, { lineWidth: -1 }))
  renameSync(join(stage, name), join(newDir, name))
  renameSync(join(stage, 'latest.yml'), join(newDir, 'latest.yml'))
  console.log(name, meta.size)
} catch (error) {
  if (error.status !== 3) throw error
} finally {
  rmSync(stage, { recursive: true, force: true })
}
