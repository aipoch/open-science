/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Supplemental stable Release publication. Existing assets are immutable; retry is safe.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectPackages, digest } from './linux-cli-packages.mjs'

export function publicationFiles(reports) {
  assert.equal(reports.length, 4)
  return [
    ...reports.map((report) => report.filename),
    'CLI-PACKAGE-SHA256SUMS.txt',
    'CLI-PACKAGE-PROVENANCE.json'
  ]
}
export async function publishPackages(directory, tag, repository, publish = false) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/)
  assert.match(repository, /^[\w-]+\/[\w.-]+$/)
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  const release = JSON.parse(
    gh(['release', 'view', tag, '--repo', repository, '--json', 'isDraft,isPrerelease,assets,url'])
  )
  assert.equal(release.isDraft, false)
  assert.equal(release.isPrerelease, false)
  const sourceSha = gh(['api', `repos/${repository}/commits/${tag}`, '--jq', '.sha']).trim()
  const reports = await collectPackages(directory, tag.slice(1), sourceSha)
  const files = publicationFiles(reports)
  const temporary = await mkdtemp(join(tmpdir(), 'cli-release-compare-'))
  try {
    const pending = []
    // Check the complete batch before any external write. Never use --clobber.
    for (const filename of files) {
      if (!release.assets.some((asset) => asset.name === filename)) pending.push(filename)
      else {
        gh([
          'release',
          'download',
          tag,
          '--repo',
          repository,
          '--dir',
          temporary,
          '--pattern',
          filename
        ])
        assert.equal(
          await digest(join(temporary, filename)),
          await digest(join(directory, filename)),
          `Published bytes are immutable: ${filename}`
        )
      }
    }
    console.log(JSON.stringify({ release: release.url, sourceSha, pending, publish }, null, 2))
    if (publish && pending.length)
      gh([
        'release',
        'upload',
        tag,
        '--repo',
        repository,
        ...pending.map((filename) => join(directory, filename))
      ])
    return { files, pending, url: release.url }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, tag, repository, mode] = process.argv.slice(2)
  assert.ok(mode === undefined || mode === '--publish')
  await publishPackages(resolve(directory), tag, repository, mode === '--publish')
}
