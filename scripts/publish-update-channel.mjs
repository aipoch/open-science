/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Called under the mirror workflow's channel-wide concurrency lock. Backfill never mutates channel
// pointers. Promotion checks every pointer because a previous multi-object upload may be incomplete.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

const {
  VERSION: version,
  S3_BUCKET: bucket,
  S3_PREFIX: prefix = '',
  MODE: mode = 'backfill'
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
  .filter((name) => /^(latest(?:-linux)?|.*-mac)\.yml$/.test(name))
  .sort()
const required = [
  'latest.yml',
  'latest-linux.yml',
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
  // Deliberately fail closed on missing, unreadable or malformed current objects. Bootstrap is a
  // separate operation; an authorization/network error must never masquerade as an empty channel.
  const currentVersions = [
    JSON.parse(readRemote('version.json')).version,
    ...required.map((name) => load(readRemote(name))?.version)
  ]
  for (const current of currentVersions) {
    const parts = stable(current)
    const difference = parts.findIndex((part, index) => part !== requested[index])
    if (difference >= 0 && parts[difference] > requested[difference]) promote = false
  }
}

aws(
  's3',
  'sync',
  'dist-assets/',
  `${root}/releases/${version}/`,
  '--exclude',
  'version.json',
  '--cache-control',
  'public, max-age=31536000, immutable',
  '--only-show-errors'
)
upload('version.json', `releases/${version}/version.json`, true, 'application/json')
if (!promote) {
  console.log(`Backfilled ${version}; channel entries unchanged.`)
} else {
  // Feed writes precede the website/manual manifest. This is not an atomic transaction; same-version
  // retry repairs a partial write, and the preflight prevents an older run overwriting any newer feed.
  for (const name of feeds) upload(join('dist-assets', name), name, false, 'text/yaml')
  upload('version.json', 'version.json', false, 'application/json')
  console.log(`Promoted stable channel to ${version}.`)
}
