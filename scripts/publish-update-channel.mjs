/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Called under the mirror workflow's channel-wide concurrency lock. Backfill never mutates channel
// pointers. Promotion checks every pointer because a previous multi-object upload may be incomplete.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { validateMacBlockmap } from './release-artifact-validation.mjs'
import { load } from 'js-yaml'

const {
  VERSION: version,
  S3_BUCKET: bucket,
  S3_PREFIX: prefix = '',
  MODE: mode = 'backfill',
  BOOTSTRAP_LINUX_ARM64: bootstrapLinuxArm64 = 'false'
} = process.env
const stable = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Expected a canonical stable version')
  }
  return value.split('.').map(BigInt)
}
const requested = stable(version)
if (!bucket || !['backfill', 'promote'].includes(mode))
  throw new Error('Invalid mirror destination or mode')
if (
  !['true', 'false'].includes(bootstrapLinuxArm64) ||
  (bootstrapLinuxArm64 === 'true' && mode !== 'promote')
)
  throw new Error('ARM64 bootstrap requires explicit promotion')
const root = `s3://${bucket}/${prefix.replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, '')
const aws = (...args) =>
  execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const readRemote = (name) => aws('s3', 'cp', `${root}/${name}`, '-', '--only-show-errors')
const upload = (source, target, immutable, type) =>
  aws(
    's3',
    'cp',
    source,
    `${root}/${target}`,
    '--cache-control',
    immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    '--content-type',
    type,
    '--only-show-errors'
  )
const manifest = JSON.parse(readFileSync('version.json', 'utf8'))
if (manifest.version !== version) throw new Error('Manifest does not match the requested version')
const feeds = readdirSync('dist-assets')
  .filter((name) => /^(latest(?:-linux(?:-arm64)?)?|.*-mac)\.yml$/.test(name))
  .sort()
const required = [
  'latest.yml',
  'latest-linux.yml',
  'latest-linux-arm64.yml',
  'latest-mac.yml',
  'arm64-mac.yml',
  'x64-mac.yml'
]
let promote = mode === 'promote'
if (promote) {
  if (required.some((name) => !feeds.includes(name)))
    throw new Error('Promotion requires every platform feed')
  for (const name of feeds) {
    const feed = load(readFileSync(join('dist-assets', name), 'utf8'))
    if (feed?.version !== version || !Array.isArray(feed.files) || feed.files.length === 0) {
      throw new Error(`Invalid promotion feed: ${name}`)
    }
  }
  // Only the explicitly opted-in new platform may be absent. Confirm absence with HEAD; an
  // authorization/network error must never masquerade as a missing channel. Existing feeds still
  // participate in monotonic promotion, including ARM64 on a retry after a partial upload.
  const currentFeedVersions = required.flatMap((name) => {
    if (name === 'latest-linux-arm64.yml' && bootstrapLinuxArm64 === 'true') {
      try {
        aws(
          's3api',
          'head-object',
          '--bucket',
          bucket,
          '--key',
          `${prefix.replace(/^\/+|\/+$/g, '')}/${name}`.replace(/^\//, '')
        )
      } catch (error) {
        if (/\((?:404|NoSuchKey|NotFound)\)/.test(String(error.stderr))) return []
        throw error
      }
    }
    return [load(readRemote(name))?.version]
  })
  const currentVersions = [JSON.parse(readRemote('version.json')).version, ...currentFeedVersions]
  for (const current of currentVersions) {
    const parts = stable(current)
    const difference = parts.findIndex((part, index) => part !== requested[index])
    if (difference >= 0 && parts[difference] > requested[difference]) promote = false
  }
}

// The immutable uploader preflights the entire version, including its manifest, before any writes.
execFileSync(
  process.execPath,
  ['scripts/publish-release-assets.mjs', 'release', 'dist-assets', 'version.json'],
  { stdio: 'pipe' }
)
if (!promote) {
  console.log(`Backfilled ${version}; channel entries unchanged.`)
} else {
  const previous = process.env.PREVIOUS_STABLE
  stable(previous)
  const macFeed = load(readFileSync('dist-assets/latest-mac.yml', 'utf8'))
  for (const arch of ['arm64', 'x64']) {
    for (const release of [version, previous]) {
      const zip = `aipoch-open-science-${release}-mac-${arch}.zip`
      const path = `releases/${release}/${zip}`
      if (release === version && !macFeed.files.some((file) => file.url === path)) {
        throw new Error(`Missing macOS feed entry: ${path}`)
      }
      const url = new URL(`${prefix}/${path}.blockmap`, process.env.CDN_BASE_URL + '/')
      const bytes = execFileSync(
        'curl',
        ['--fail', '--silent', '--show-error', '--retry', '2', '--max-time', '30', url.href],
        { maxBuffer: 16 * 1024 * 1024 }
      )
      validateMacBlockmap(bytes, url.href)
      if (
        release === version &&
        !bytes.equals(readFileSync(join('dist-assets', zip + '.blockmap')))
      ) {
        throw new Error(`CDN blockmap differs from release asset: ${url}`)
      }
    }
  }
  // Feed writes precede the website/manual manifest. This is not an atomic transaction; same-version
  // retry repairs a partial write, and the preflight prevents an older run overwriting any newer feed.
  for (const name of feeds) upload(join('dist-assets', name), name, false, 'text/yaml')
  upload('version.json', 'version.json', false, 'application/json')
  // Metadata is small; compare actual readback bytes before reporting a completed promotion.
  for (const [file, name] of [
    ...feeds.map((name) => [join('dist-assets', name), name]),
    ['version.json', 'version.json']
  ]) {
    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
    if (digest(readRemote(name)) !== digest(readFileSync(file))) {
      throw new Error(`Publication readback failed: ${name}`)
    }
  }
  console.log(`Promoted stable channel to ${version}.`)
}
