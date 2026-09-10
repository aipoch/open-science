/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Called only after local validation, under the owning workflow's publication lock. Existing
// versioned objects are compared by bytes, including objects predating this publisher.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { artifactHash } from './release-artifact-validation.mjs'

const bucket = process.env.S3_BUCKET
const prefix = process.env.S3_PREFIX
if (!bucket || !prefix) throw new Error('S3_BUCKET and S3_PREFIX are required')
const temp = mkdtempSync(join(tmpdir(), 'release-publish-'))
const aws = (args) => spawnSync('aws', args, { encoding: 'utf8', timeout: 600_000 })
const checked = (args) => {
  const result = aws(args)
  if (result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr ?? 'AWS operation failed')
  return result.stdout
}
const remote = (key) => `s3://${bucket}/${key}`
let sequence = 0
function readObject(key) {
  const head = aws(['s3api', 'head-object', '--bucket', bucket, '--key', key])
  if (head.status !== 0) {
    if (!head.error && /\((?:404|NoSuchKey|NotFound)\)/.test(head.stderr)) return undefined
    throw new Error(`Cannot inspect publication object: ${head.error?.message ?? head.stderr}`)
  }
  const file = join(temp, String(sequence++))
  checked(['s3', 'cp', remote(key), file, '--only-show-errors'])
  return file
}
function copy(file, key, immutable) {
  checked([
    's3',
    'cp',
    file,
    remote(key),
    '--cache-control',
    immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    '--only-show-errors'
  ])
}
function publishImmutable(entries) {
  const pending = []
  // Check the complete batch before writing, so a changed final manifest cannot authorize any
  // different pack/installer bytes. An interrupted first upload can resume its missing objects.
  for (const [file, key] of entries) {
    if (!statSync(file).isFile() || statSync(file).size <= 0)
      throw new Error(`Invalid publication file: ${file}`)
    const existing = readObject(key)
    if (!existing) pending.push([file, key])
    else {
      const equal = artifactHash(file, 'sha256') === artifactHash(existing, 'sha256')
      rmSync(existing)
      if (!equal)
        throw new Error(`Published bytes are immutable; use a new version: ${basename(file)}`)
    }
  }
  for (const [file, key] of pending) copy(file, key, true)
}
function stableVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Invalid stable version: ${version}`)
  }
  return version.split('.').map(BigInt)
}

try {
  const [mode, dir, argument] = process.argv.slice(2)
  if (mode === 'runtime') {
    if (
      !/^[1-9]\d*$/.test(process.env.VERSION ?? '') ||
      !/^(osx-arm64|osx-64|linux-64|win-64)$/.test(argument)
    ) {
      throw new Error('Invalid runtime version or subdir')
    }
    const base = `${prefix.split('/')[0]}/runtime-bundle/${process.env.VERSION}/${argument}`
    const files = readdirSync(dir).filter((name) => name.endsWith('.tar.zst'))
    if (files.length === 0) throw new Error('No runtime archives')
    publishImmutable(
      [...files, 'manifest.json'].map((name) => [join(dir, name), `${base}/${name}`])
    )
  } else if (mode === 'release') {
    stableVersion(process.env.VERSION)
    const base = `${prefix}/releases/${process.env.VERSION}`
    publishImmutable(
      readdirSync(dir)
        .filter((name) => name !== 'version.json')
        .map((name) => [join(dir, name), `${base}/${name}`])
        .concat(argument ? [[argument, `${base}/version.json`]] : [])
    )
  } else if (mode === 'blockmaps') {
    const entries = []
    for (const version of readdirSync(dir)) {
      stableVersion(version)
      for (const name of readdirSync(join(dir, version))) {
        if (!name.endsWith('-win-x64-setup.exe.blockmap'))
          throw new Error('Unexpected blockmap file')
        entries.push([join(dir, version, name), `${prefix}/releases/${version}/${name}`])
      }
    }
    publishImmutable(entries)
  } else throw new Error(`Unknown publication mode: ${mode}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
