/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeTargets, currentRuntimeTarget } from '../packages/open-science/runtime-package.mjs'
import { verifyRuntimeSignatures } from './verify-runtime-signatures.mjs'

// Git Bash may put GNU tar ahead of Windows bsdtar; only bsdtar can write zip.
export const archiveTar =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'

export const archiveStem = (version, target) => {
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.ok(
    runtimeTargets.some((item) => item.id === target.id),
    'Unsupported archive target'
  )
  return `open-science-${version}-${target.id}`
}
export const archiveFilename = (version, target) =>
  `${archiveStem(version, target)}.${target.os === 'win32' ? 'zip' : 'tar.gz'}`
export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export function archiveLauncher(platform) {
  if (platform === 'win32')
    return '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%~dp0node-runtime\\node.exe" "%~dp0backend\\cli.mjs" %*\r\nexit /b %errorlevel%\r\n'
  // Resolve symlinks too, so a user can link this launcher into their own bin directory.
  return `#!/bin/sh
set -eu
launcher=$0
while [ -L "$launcher" ]; do
  directory=$(CDPATH= cd -- "$(dirname -- "$launcher")" && pwd)
  launcher=$(readlink "$launcher")
  case "$launcher" in /*) ;; *) launcher="$directory/$launcher" ;; esac
done
directory=$(CDPATH= cd -- "$(dirname -- "$launcher")" && pwd)
exec "$directory/node-runtime/node" "$directory/backend/cli.mjs" "$@"
`
}
export async function packRuntimeArchive({
  root,
  source,
  nodeSource,
  output,
  target,
  sourceSha,
  verifySignatures = false
}) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const stem = archiveStem(version, target)
  assert.match(sourceSha, /^[a-f0-9]{40}$/)
  const backend = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  assert.equal(backend.version, version, 'Stale backend version')
  assert.deepEqual(backend.os, [target.os], 'Wrong backend platform')
  assert.deepEqual(backend.cpu, [target.cpu], 'Wrong backend architecture')
  const node = JSON.parse(await readFile(join(nodeSource, 'version.json'), 'utf8'))
  const pinned = JSON.parse(await readFile(join(root, 'build/node-runtime.json'), 'utf8'))
  assert.equal(node.version, pinned.version, 'Stale bundled Node version')
  assert.equal(node.platform, target.os, 'Wrong Node platform')
  assert.equal(node.arch, target.cpu, 'Wrong Node architecture')
  for (const file of ['cli.mjs', 'out/backend/index.cjs', 'out/web/index.html', 'LICENSE'])
    await access(join(source, file))
  for (const file of [target.os === 'win32' ? 'node.exe' : 'node', 'LICENSE'])
    await access(join(nodeSource, file))
  await mkdir(output, { recursive: true })
  const temporary = await mkdtemp(join(output, '.archive-'))
  const destination = join(temporary, stem)
  try {
    await cp(source, join(destination, 'backend'), { recursive: true })
    await cp(nodeSource, join(destination, 'node-runtime'), { recursive: true })
    const launcher = join(destination, target.os === 'win32' ? 'open-science.cmd' : 'open-science')
    await writeFile(launcher, archiveLauncher(target.os))
    await chmod(launcher, 0o755)
    const metadata = { version, target: target.id, sourceSha, nodeVersion: node.version }
    await writeFile(join(destination, 'release.json'), JSON.stringify(metadata, null, 2) + '\n')
    await writeFile(
      join(destination, 'README.txt'),
      `Open-Science ${version} — ${target.id}\n\nExtract the entire directory. No installed Node, npm or Electron is needed.\nRun ${target.os === 'win32' ? '.\\open-science.cmd' : './open-science'} start --no-open\nThen use status, url, run --help, or stop.\nAdd this directory to PATH if desired. Keep backend and node-runtime beside the launcher.\nStop this profile before upgrading; extract a new version into a separate directory.\nProfiles and credentials remain in the normal OS data/vault locations. Do not delete them to uninstall.\nLinux requires glibc and an OS secret service; Python/R and sandbox prerequisites are separate.\nSee https://github.com/aipoch/open-science/blob/v${version}/docs/standalone-runtime.md\nApplication and Node licenses: backend/LICENSE and node-runtime/LICENSE.\n`
    )
    if (verifySignatures) await verifyRuntimeSignatures(destination)
    const filename = archiveFilename(version, target)
    // Use the native tar implementation: bsdtar on Windows writes zip with -a.
    execFileSync(
      archiveTar,
      target.os === 'win32'
        ? ['-a', '-cf', join(output, filename), '-C', temporary, stem]
        : ['-czf', join(output, filename), '-C', temporary, stem],
      { stdio: 'inherit' }
    )
    const report = { ...metadata, filename, sha256: await sha256(join(output, filename)) }
    await writeFile(join(output, `${target.id}.json`), JSON.stringify(report, null, 2) + '\n')
    return report
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
export async function collectRuntimeArchives(directory, version, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/)
  const reports = []
  for (const target of runtimeTargets) {
    const filename = archiveFilename(version, target)
    const report = JSON.parse(await readFile(join(directory, `${target.id}.json`), 'utf8'))
    assert.equal(report.target, target.id)
    assert.equal(report.version, version)
    assert.equal(report.sourceSha, sourceSha, 'Archive source commit mismatch')
    assert.equal(report.filename, filename)
    const path = join(directory, filename)
    assert.equal(await sha256(path), report.sha256, 'Archive checksum mismatch')
    const entry = `${archiveStem(version, target)}/release.json`
    const metadata = JSON.parse(
      execFileSync(
        target.os === 'win32' && process.platform !== 'win32' ? 'unzip' : archiveTar,
        target.os === 'win32' && process.platform !== 'win32'
          ? ['-p', path, entry]
          : ['-xOf', path, entry],
        { encoding: 'utf8' }
      )
    )
    assert.deepEqual(
      metadata,
      { version, target: target.id, sourceSha, nodeVersion: report.nodeVersion },
      'Archive metadata mismatch'
    )
    if (reports.length)
      assert.equal(report.nodeVersion, reports[0].nodeVersion, 'Mixed Node versions')
    reports.push(report)
  }
  return reports
}
async function main() {
  const root = resolve(import.meta.dirname, '..')
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  if (process.env.GITHUB_SHA) assert.equal(sourceSha, process.env.GITHUB_SHA)
  if (process.env.GITHUB_REF?.startsWith('refs/tags/'))
    assert.equal(process.env.GITHUB_REF_NAME, `v${version}`)
  if (process.argv[2] === 'verify') {
    const directory = resolve(process.argv[3])
    const reports = await collectRuntimeArchives(directory, version, sourceSha)
    await writeFile(
      join(directory, 'CLI-SHA256SUMS.txt'),
      reports.map((r) => `${r.sha256}  ${r.filename}\n`).join('')
    )
    console.log(`Verified all ${reports.length} CLI archives for ${version} at ${sourceSha}`)
  } else {
    const target = currentRuntimeTarget()
    console.log(
      await packRuntimeArchive({
        root,
        target,
        sourceSha,
        source: process.env.OPEN_SCIENCE_RUNTIME_SOURCE ?? join(root, 'out/standalone'),
        nodeSource:
          process.env.OPEN_SCIENCE_NODE_SOURCE ??
          join(root, 'out/node-runtime', `${target.os}-${target.cpu}`),
        output: join(root, 'out/cli-artifacts'),
        verifySignatures: process.env.OPEN_SCIENCE_RUNTIME_VERIFY_SIGNATURES === '1'
      })
    )
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
