/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { load } from 'js-yaml'

const { VERSION: version, S3_BUCKET: bucket, S3_PREFIX: prefix = '' } = process.env
const directory = process.env.DIST_DIR ?? 'dist-assets'
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
if (!stable.test(version ?? '') || !bucket)
  throw new Error('Invalid Windows delta repair configuration')

const root = `s3://${bucket}/${prefix.replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, '')
const aws = (...args) =>
  execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const remote = (key) => `${root}/${key}`
const sha256 = (file) => {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}
const feed = load(readFileSync(join(directory, 'latest.yml'), 'utf8'))
if (feed?.version !== version || !Array.isArray(feed.files))
  throw new Error('Invalid Windows update feed')
const file = feed.files.find((entry) => entry.url?.endsWith('-win-x64-setup.exe'))
const delta = file?.windowsDelta
if (
  !file ||
  delta?.format !== 1 ||
  !stable.test(delta.from ?? '') ||
  !Number.isSafeInteger(delta.size) ||
  delta.size <= 0
)
  throw new Error('Windows update feed has no valid delta metadata')
const patch = join(directory, `${basename(file.url)}.from-${delta.from}.wex`)
if (!statSync(patch).isFile() || statSync(patch).size !== delta.size)
  throw new Error('Windows delta artifact does not match the feed')

const patchKey = `releases/${version}/${basename(patch)}`
const localCopy = join(directory, '.existing-windows-delta')
try {
  let existing
  try {
    aws('s3', 'cp', remote(patchKey), localCopy, '--only-show-errors')
    existing = sha256(localCopy)
  } catch (error) {
    if (!String(error.stderr ?? error.message).match(/(?:404|NoSuchKey|NotFound)/)) throw error
  }
  if (existing === undefined) {
    aws(
      's3',
      'cp',
      patch,
      remote(patchKey),
      '--cache-control',
      'public, max-age=31536000, immutable',
      '--content-type',
      'application/octet-stream',
      '--only-show-errors'
    )
  } else if (existing !== sha256(patch)) {
    throw new Error(`Published Windows delta differs: ${patchKey}`)
  }

  const feedPath = join(directory, 'latest.yml')
  aws(
    's3',
    'cp',
    feedPath,
    remote('latest.yml'),
    '--cache-control',
    'no-cache',
    '--content-type',
    'text/yaml',
    '--only-show-errors'
  )
  const readback = join(directory, '.latest-yml-readback')
  try {
    aws('s3', 'cp', remote('latest.yml'), readback, '--only-show-errors')
    if (sha256(readback) !== sha256(feedPath)) throw new Error('Windows delta feed readback failed')
  } finally {
    try {
      execFileSync(
        process.platform === 'win32' ? 'cmd.exe' : 'rm',
        process.platform === 'win32' ? ['/d', '/c', 'del', '/q', readback] : ['-f', readback],
        { stdio: 'ignore' }
      )
    } catch {
      // The temporary readback is best-effort after the remote comparison.
    }
  }
  console.log(`Repaired Windows delta feed for ${version} from ${delta.from}.`)
} finally {
  try {
    execFileSync(
      process.platform === 'win32' ? 'cmd.exe' : 'rm',
      process.platform === 'win32' ? ['/d', '/c', 'del', '/q', localCopy] : ['-f', localCopy],
      { stdio: 'ignore' }
    )
  } catch {
    // The temporary copy is best-effort after the remote comparison.
  }
}
